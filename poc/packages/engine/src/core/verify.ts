import { FORCED_STOPS } from './interp.ts';
import { normalizeName } from './constants.ts';
import type { VerifyResult } from './machine.ts';
import type { Clock, PageReader } from './page.ts';
import { compileRe2 } from './re2.ts';
import { normalizeFor } from './readback.ts';
import { readRef, scalar, type RunScope } from './scope.ts';
import type { Handler } from './steps.ts';
import type { FailSignal, Lookup, PlaybookIR, Policy, SelectorDict, Step, StepOf, Strings } from './types.ts';
import { flatten } from './cfg.ts';

/** 조회 행: 열 이름(fieldKey·approvalNo) → 화면 문구. */
export type LookupRow = Readonly<Record<string, string>>;

export interface LookupRequest {
  stepId: string;
  playbook: string;
  match: Readonly<Record<string, string>>;
  window: Lookup['window'];
  purpose: 'baseline' | 'verify' | 'reverify';
}

export type LookupResult = { ok: true; rows: readonly LookupRow[] } | { ok: false; code: string };

export interface LookupPort {
  run(req: LookupRequest): Promise<LookupResult>;
}

/** 승인번호 열(B 집합의 원소, bind의 원천). */
export const VERIFY_ID_COLUMN = 'approvalNo';
/** 조회가 이만큼 연속 실패하면 더 조회하지 않는다(H01Runner VERIFY_FAILS_IN_A_ROW). */
export const VERIFY_FAILS_IN_A_ROW = 3;
/** 다시 조회하는 간격: 첫 간격부터 두 배씩, 상한(D03 §5.6 10·20·40초). */
export const VERIFY_INTERVALS = Object.freeze({ firstMs: 10_000, capMs: 40_000 });
/**
 * 사후 부수효과 확인(baseline:none, 골든 s33 메일 발송)은 첫 조회 전과 조회 사이를 첫 간격의 이 배수로 둔다(운영 10초 → 30초).
 * 홈택스 메일 발송 결과는 발급 뒤 수십 초 걸려 생긴다(실화면 2026-11-17: 공급받는자 메일 도착 뒤 공급자 메일 41초). 곧바로·10초마다 조회하면
 * 조회 창만 여러 번 열린다(대표 실기기 피드백 2026-11-18 "발급 뒤 확인이 5~10번"). 상한(maxMs)과 판정 규칙은 그대로다.
 */
export const POST_EFFECT_SPACING = 3;

export interface VerifyJudgement {
  result: VerifyResult;
  ref?: string;
}

/** 실행 하나의 verify 기록: 기준선·클릭 시각·클릭 전 실패 신호·판정 근거. */
export class VerifyBook {
  private readonly baselines = new Map<string, ReadonlySet<string>>();
  private readonly dispatches = new Map<string, { at: number; failBefore: ReadonlySet<string> }>();
  private readonly refs = new Map<string, string>();

  setBaseline(verifyId: string, ids: ReadonlySet<string>): void {
    this.baselines.set(verifyId, ids);
  }
  baseline(verifyId: string): ReadonlySet<string> | undefined {
    return this.baselines.get(verifyId);
  }
  markDispatched(verifyId: string, at: number, failBefore: ReadonlySet<string>): void {
    this.dispatches.set(verifyId, { at, failBefore });
  }
  dispatch(verifyId: string): { at: number; failBefore: ReadonlySet<string> } | undefined {
    return this.dispatches.get(verifyId);
  }
  setRef(verifyId: string, ref: string): void {
    this.refs.set(verifyId, ref);
  }
  ref(verifyId: string): string | undefined {
    return this.refs.get(verifyId);
  }
}

export interface VerifyDeps {
  lookup: LookupPort;
  book: VerifyBook;
  page: PageReader;
  clock: Clock;
  dict: SelectorDict;
  strings: Strings;
  scope: RunScope;
  policy: () => Policy['verify'];
  intervals?: { firstMs: number; capMs: number };
}

/** 지금 보이고 문구 패턴(^…$)에 맞는 실패 신호 요소의 키(css + 정규화 문구). 문구 없는 항목은 V-03j″가 막는다. */
export async function failSignalKeys(page: PageReader, signals: readonly FailSignal[]): Promise<Set<string>> {
  const out = new Set<string>();
  for (const f of signals) {
    let re: RegExp;
    try {
      re = compileRe2(f.text);
    } catch {
      continue;
    }
    for (const el of await page.query({ kind: 'css', value: f.css }, 'main', null)) {
      if (!(await page.info(el)).visible) continue;
      const text = normalizeName(await page.text(el));
      if (re.test(text)) out.add(`${f.css}\u0000${text}`);
    }
  }
  return out;
}

/** match 참조를 해석한다. 하나라도 없으면 null(조회하지 않는다, fail-closed). */
export function resolveMatch(scope: RunScope, match: Lookup['match']): Record<string, string> | null {
  const out: Record<string, string> = {};
  for (const [k, ref] of Object.entries(match)) {
    const v = scalar(readRef(scope, ref));
    if (v === null || v.trim() === '') return null;
    out[k] = v;
  }
  return out;
}

/** match에 맞는 행을 승인번호별로(fieldKey 정규화 규칙으로 비교, 승인번호 없는 행은 뺀다). */
export function matchingRows(dict: SelectorDict, rows: readonly LookupRow[], want: Readonly<Record<string, string>>): Map<string, LookupRow[]> {
  const keys = Object.entries(want).map(([k, v]) => [k, normalizeFor(dict, k, v)] as const);
  const out = new Map<string, LookupRow[]>();
  for (const r of rows) {
    if (!keys.every(([k, v]) => normalizeFor(dict, k, r[k] ?? '') === v)) continue;
    const id = normalizeName(r[VERIFY_ID_COLUMN] ?? '');
    if (id) out.set(id, [...(out.get(id) ?? []), r]);
  }
  return out;
}

/** match에 맞는 행의 승인번호 집합. */
export function matchingIds(dict: SelectorDict, rows: readonly LookupRow[], want: Readonly<Record<string, string>>): Set<string> {
  return new Set(matchingRows(dict, rows, want).keys());
}

export type RowVerdict = 'sent' | 'not_sent' | 'unknown';

/**
 * 한 승인번호의 행들의 상태 문구 판정(rowVerdict): 하나라도 notSent면 not_sent(부정 우선), 아니면 하나라도 sent면 sent, 그 밖 unknown.
 * 문구는 NFKC·공백 제거 뒤 패턴에 건다. 패턴이 없거나 컴파일되지 않으면 unknown(V-01이 로드 때 막는다).
 */
export function rowVerdictOf(strings: Strings, rv: NonNullable<Lookup['rowVerdict']>, rows: readonly LookupRow[]): RowVerdict {
  const pat = (k: string): RegExp | null => {
    const p = strings[k];
    if (typeof p !== 'string') return null;
    try {
      return compileRe2(p);
    } catch {
      return null;
    }
  };
  const sent = pat(rv.sent);
  const notSent = pat(rv.notSent);
  if (!sent || !notSent) return 'unknown';
  const texts = rows.map((r) => (r[rv.column] ?? '').normalize('NFKC').replace(/\s+/g, ''));
  if (texts.some((t) => notSent.test(t))) return 'not_sent';
  return texts.some((t) => sent.test(t)) ? 'sent' : 'unknown';
}

type Ids = { ok: true; ids: Set<string>; rows: Map<string, LookupRow[]> } | { ok: false; code: string };

async function lookupIds(d: VerifyDeps, s: StepOf<'verify'>, purpose: LookupRequest['purpose']): Promise<Ids> {
  const want = resolveMatch(d.scope, s.lookup.match);
  if (!want) return { ok: false, code: 'step.ref_unresolved' };
  const r = await d.lookup.run({ stepId: s.id, playbook: s.lookup.playbook, match: want, window: s.lookup.window, purpose }).catch(() => ({ ok: false as const, code: 'verify.lookup_failed' }));
  if (!r.ok) return { ok: false, code: r.code };
  const rows = matchingRows(d.dict, r.rows, want);
  return { ok: true, ids: new Set(rows.keys()), rows };
}

const stopsPolling = (code: string) => FORCED_STOPS.get(code) === 'abort';

/**
 * 게이트 진입 전 기준선(B-07). 이 게이트가 허가하는 주 비가역 X의 verify가 pre_gate_snapshot일 때만 조회한다.
 * 실패하면 게이트를 열지 않는다: 차단 신호는 그 코드, 그 밖은 verify.baseline_missing(핸드오프).
 */
export async function takeBaseline(d: VerifyDeps, ir: PlaybookIR, g: StepOf<'gate'>): Promise<{ ok: true } | { ok: false; code: string }> {
  const v = verifyOfIrreversible(ir, g.authorizes[0] ?? '');
  if (!v || v.lookup.baseline !== 'pre_gate_snapshot') return { ok: true };
  const r = await lookupIds(d, v, 'baseline');
  if (!r.ok) return { ok: false, code: stopsPolling(r.code) ? r.code : 'verify.baseline_missing' };
  d.book.setBaseline(v.id, r.ids);
  return { ok: true };
}

/** 비가역 스텝 X의 verify 스텝. */
export function verifyOfIrreversible(ir: PlaybookIR, x: string): StepOf<'verify'> | null {
  const info = flatten(ir.steps).info;
  const xs = info.get(x)?.step as (Step & { verify?: unknown }) | undefined;
  const vid = xs && typeof xs.verify === 'string' ? xs.verify : null;
  const v = vid ? info.get(vid)?.step : undefined;
  return v?.type === 'verify' ? v : null;
}

/**
 * D02 §4.4 판정. committed면 bind로 $vars에 묶고 book에 verify_ref를 적는다.
 * 클릭 기록(markDispatched)이 없으면 경과 시간은 이 판정을 시작한 때부터 재고, 클릭 뒤 새로 보인 실패 신호를 셀 수 없으므로 not_committed는 나오지 않는다.
 */
export async function judgeVerify(d: VerifyDeps, s: StepOf<'verify'>): Promise<VerifyJudgement> {
  const pol = d.policy();
  const minElapsedMs = Math.max(s.lookup.notCommittedPolicy.minElapsedMs, pol.minElapsedMs);
  const lookups = Math.max(s.lookup.notCommittedPolicy.lookups, pol.lookups);
  const maxMs = s.lookup.baseline === 'none' && s.lookup.maxMs !== undefined ? s.lookup.maxMs : (pol.maxMs ?? 300_000);
  const iv = d.intervals ?? VERIFY_INTERVALS;
  const b0 = s.lookup.baseline === 'none' ? new Set<string>() : d.book.baseline(s.id);
  if (!b0) return { result: 'unknown' };
  const dispatch = d.book.dispatch(s.id);
  const t0 = dispatch?.at ?? d.clock.now();
  const postEffect = s.lookup.baseline === 'none';
  let wait = postEffect ? Math.min(iv.firstMs * POST_EFFECT_SPACING, Math.floor(maxMs / 3)) : iv.firstMs;
  let zeros = 0;
  let fails = 0;
  if (postEffect) await d.clock.sleep(Math.min(wait, maxMs));
  while (d.clock.now() - t0 < maxMs) {
    const r = await lookupIds(d, s, 'verify');
    if (!r.ok) {
      if (stopsPolling(r.code) || r.code === 'step.ref_unresolved') break;
      zeros = 0;
      if (++fails >= VERIFY_FAILS_IN_A_ROW) break;
    } else {
      fails = 0;
      const fresh = [...r.ids].filter((n) => !b0.has(n));
      const rv = s.lookup.rowVerdict;
      const verdict = fresh.length === 1 && rv ? rowVerdictOf(d.strings, rv, r.rows.get(fresh[0]!) ?? []) : null;
      if (verdict === 'not_sent') return { result: 'not_committed' };
      if (verdict === 'unknown') {
        zeros = 0;
      } else if (fresh.length === 1) {
        const ref = fresh[0]!;
        const bind = s.lookup.bind?.approvalNo;
        if (bind) d.scope.vars.set(bind, ref);
        d.book.setRef(s.id, ref);
        return { result: 'committed', ref };
      } else if (fresh.length > 1) break;
      else zeros++;
      if (dispatch && zeros >= lookups && d.clock.now() - t0 >= minElapsedMs) {
        const now = await failSignalKeys(d.page, s.failSignals ?? []).catch(() => new Set<string>());
        if ([...now].some((k) => !dispatch.failBefore.has(k))) return { result: 'not_committed' };
      }
    }
    await d.clock.sleep(wait);
    if (!postEffect) wait = Math.min(wait * 2, iv.capMs);
  }
  return { result: 'unknown' };
}

export interface ReverifyDeps {
  lookup: LookupPort;
  clock: Clock;
  dict: SelectorDict;
  strings: Strings;
  lookups: number;
  intervalMs: number;
  deadline: number;
}

/** 재확인이 원장에 적을 수 있는 것은 committed뿐이다. */
export type ReverifyJudgement = { result: 'committed'; ref: string } | { result: 'unknown' } | { result: 'failed'; code: string };

/**
 * 재시작 뒤 재확인(run.reverify). judgeVerify처럼 B₁ \ B₀를 센다. B₀는 무장할 때 원장 행에 적어 둔 기준선이고,
 * 이 PC의 다른 committed 행이 가진 승인번호도 함께 뺀다(exclude).
 * - 남은 것이 정확히 1건이고 rowVerdict가 없거나 sent면 committed. not_sent·결론 없음은 unknown이다.
 *   재확인은 not_committed를 적지 않는다. 적으면 같은 발급 키의 새 발급이 열린다.
 * - 2건 이상은 어느 건인지 모른다(unknown). 0건은 부재 증거가 아니다(목록 기간 밖·반영 지연, 상한·마감에서 unknown).
 * - 조회 실패는 failed(그 코드). 부른 쪽이 이번 호출을 멈추고 원장을 바꾸지 않는다.
 */
export async function judgeReverify(d: ReverifyDeps, s: StepOf<'verify'>, want: Readonly<Record<string, string>>, exclude: ReadonlySet<string>): Promise<ReverifyJudgement> {
  for (let i = 0; i < d.lookups && d.clock.now() < d.deadline; i++) {
    if (i) await d.clock.sleep(d.intervalMs);
    const r = await d.lookup.run({ stepId: s.id, playbook: s.lookup.playbook, match: want, window: s.lookup.window, purpose: 'reverify' }).catch((): LookupResult => ({ ok: false, code: 'verify.lookup_failed' }));
    if (!r.ok) return { result: 'failed', code: r.code };
    const rows = matchingRows(d.dict, r.rows, want);
    const fresh = [...rows.keys()].filter((n) => !exclude.has(n));
    if (fresh.length > 1) return { result: 'unknown' };
    if (fresh.length === 0) continue;
    const ref = fresh[0]!;
    const rv = s.lookup.rowVerdict;
    const verdict = rv ? rowVerdictOf(d.strings, rv, rows.get(ref) ?? []) : 'sent';
    if (verdict === 'sent') return { result: 'committed', ref };
    if (verdict === 'not_sent') return { result: 'unknown' };
  }
  return { result: 'unknown' };
}

/** 실행 조율기 밖(커밋 구간이 아닌 verify)에서 쓰는 핸들러: 판정 → on[결과]. 커밋 구간은 RunController가 상태 머신에 결과를 넣는다. */
export function verifyHandler(d: VerifyDeps): Handler<'verify'> {
  return async (s) => {
    const j = await judgeVerify(d, s).catch((): VerifyJudgement => ({ result: 'unknown' }));
    return { t: 'jump', to: s.on[j.result] };
  };
}
