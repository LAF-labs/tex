// verify(M2-3, D02 §4.4, D03 §5.6): 조회 하위 플레이북으로 제출 여부를 결정적으로 판정한다. 기준은 H01Runner verifyInvoice다.
// - 기준선 B₀: 게이트 진입 전(W 밖) 같은 조회로 match에 맞는 행의 승인번호 집합. 조회가 실패하면 게이트를 열지 않는다(verify.baseline_missing).
// - 판정: B₁ \ B₀가 정확히 1건이면 committed(bind, 원장 verify_ref). 2건 이상이면 unknown.
//   0건이면서 minElapsedMs가 지났고 lookups회 연속 0건이며, 클릭 뒤 새로 보이고 문구까지 맞는 실패 신호가 있을 때만 not_committed.
//   그 밖은 maxMs(앱 하한 300초)까지 지수 간격으로 다시 조회하고, 상한에서 unknown.
// - 조회 실패는 부재 증거가 아니다(연속 0건을 끊는다). 3회 연속 실패하거나 차단 신호면 더 두드리지 않고 unknown(D03 §7).
// - 조회는 포트가 새 탭에서 하고 닫는다. 원래 탭은 실패 신호를 읽기만 한다. 값은 저널·로그에 남기지 않는다(⑦).
import { FORCED_STOPS } from './interp.ts';
import { normalizeName } from './constants.ts';
import type { VerifyResult } from './machine.ts';
import type { Clock, PageReader } from './page.ts';
import { compileRe2 } from './re2.ts';
import { normalizeFor } from './readback.ts';
import { readRef, scalar, type RunScope } from './scope.ts';
import type { Handler } from './steps.ts';
import type { FailSignal, Lookup, PlaybookIR, Policy, SelectorDict, Step, StepOf } from './types.ts';
import { flatten } from './cfg.ts';

/** 조회 행: 열 이름(fieldKey·approvalNo) → 화면 문구. */
export type LookupRow = Readonly<Record<string, string>>;

export interface LookupRequest {
  /** 이 조회를 부른 verify 스텝. */
  stepId: string;
  playbook: string;
  /** match를 해석한 값(fieldKey → 값). 조회 하위 플레이북의 검색 조건. */
  match: Readonly<Record<string, string>>;
  window: Lookup['window'];
  purpose: 'baseline' | 'verify';
}

export type LookupResult = { ok: true; rows: readonly LookupRow[] } | { ok: false; code: string };

export interface LookupPort {
  /**
   * 조회 하위 플레이북(manifest.lookupsUsed, V-22)을 새 탭에서 실행하고 닫는다(D03 §5.6). 원래 탭은 건드리지 않는다.
   * 결과가 다 오지 않았거나(행 수 불일치) 어떤 이유로든 실패하면 ok:false다. 차단 신호면 그 코드(portal.blocked 등).
   */
  run(req: LookupRequest): Promise<LookupResult>;
}

/** 승인번호 열(B 집합의 원소, bind의 원천). */
export const VERIFY_ID_COLUMN = 'approvalNo';
/** 조회가 이만큼 연속 실패하면 더 조회하지 않는다(H01Runner VERIFY_FAILS_IN_A_ROW). */
export const VERIFY_FAILS_IN_A_ROW = 3;
/** 다시 조회하는 간격: 첫 간격부터 두 배씩, 상한(D03 §5.6 10·20·40초). */
export const VERIFY_INTERVALS = Object.freeze({ firstMs: 10_000, capMs: 40_000 });

export interface VerifyJudgement {
  result: VerifyResult;
  /** committed일 때 B₁ \ B₀의 한 건(원장 verify_ref, bind 유무와 관계없이). */
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
  /** 기준선 B₀($dup.portalExisting은 여기서 이 PC 원장 verify_ref를 뺀다, ADR-024). */
  baseline(verifyId: string): ReadonlySet<string> | undefined {
    return this.baselines.get(verifyId);
  }
  /** submit이 클릭을 보낸 직후 부른다(그 직전에 읽은 실패 신호와 함께). */
  markDispatched(verifyId: string, at: number, failBefore: ReadonlySet<string>): void {
    this.dispatches.set(verifyId, { at, failBefore });
  }
  dispatch(verifyId: string): { at: number; failBefore: ReadonlySet<string> } | undefined {
    return this.dispatches.get(verifyId);
  }
  setRef(verifyId: string, ref: string): void {
    this.refs.set(verifyId, ref);
  }
  /** committed로 판정한 한 건(원장 verify_ref). */
  ref(verifyId: string): string | undefined {
    return this.refs.get(verifyId);
  }
}

export interface VerifyDeps {
  lookup: LookupPort;
  book: VerifyBook;
  /** 원래 탭(실패 신호를 읽기만 한다). */
  page: PageReader;
  clock: Clock;
  dict: SelectorDict;
  scope: RunScope;
  /** 정책 policy.verify(클램프 뒤 값, maxMs 채워짐). */
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

/** match에 맞는 행의 승인번호 집합(fieldKey 정규화 규칙으로 비교, 승인번호 없는 행은 뺀다). */
export function matchingIds(dict: SelectorDict, rows: readonly LookupRow[], want: Readonly<Record<string, string>>): Set<string> {
  const keys = Object.entries(want).map(([k, v]) => [k, normalizeFor(dict, k, v)] as const);
  const out = new Set<string>();
  for (const r of rows) {
    if (!keys.every(([k, v]) => normalizeFor(dict, k, r[k] ?? '') === v)) continue;
    const id = normalizeName(r[VERIFY_ID_COLUMN] ?? '');
    if (id) out.add(id);
  }
  return out;
}

type Ids = { ok: true; ids: Set<string> } | { ok: false; code: string };

async function lookupIds(d: VerifyDeps, s: StepOf<'verify'>, purpose: LookupRequest['purpose']): Promise<Ids> {
  const want = resolveMatch(d.scope, s.lookup.match);
  if (!want) return { ok: false, code: 'step.ref_unresolved' };
  const r = await d.lookup.run({ stepId: s.id, playbook: s.lookup.playbook, match: want, window: s.lookup.window, purpose }).catch(() => ({ ok: false as const, code: 'verify.lookup_failed' }));
  return r.ok ? { ok: true, ids: matchingIds(d.dict, r.rows, want) } : { ok: false, code: r.code };
}

/** 차단 신호처럼 다시 조회해도 안 되는 실패(FORCED_STOPS abort). */
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
  const maxMs = pol.maxMs ?? 300_000;
  const iv = d.intervals ?? VERIFY_INTERVALS;
  const b0 = s.lookup.baseline === 'none' ? new Set<string>() : d.book.baseline(s.id);
  // 기준선 없이는 새 건을 셀 수 없다(재시작 뒤 등): 판정하지 않는다.
  if (!b0) return { result: 'unknown' };
  const dispatch = d.book.dispatch(s.id);
  const t0 = dispatch?.at ?? d.clock.now();
  let wait = iv.firstMs;
  let zeros = 0;
  let fails = 0;
  while (d.clock.now() - t0 < maxMs) {
    const r = await lookupIds(d, s, 'verify');
    if (!r.ok) {
      if (stopsPolling(r.code) || r.code === 'step.ref_unresolved') break;
      zeros = 0; // 조회 실패는 부재 증거가 아니다
      if (++fails >= VERIFY_FAILS_IN_A_ROW) break;
    } else {
      fails = 0;
      const fresh = [...r.ids].filter((n) => !b0.has(n));
      if (fresh.length === 1) {
        const ref = fresh[0]!;
        const bind = s.lookup.bind?.approvalNo;
        if (bind) d.scope.vars.set(bind, ref);
        d.book.setRef(s.id, ref);
        return { result: 'committed', ref };
      }
      if (fresh.length > 1) break;
      zeros++;
      if (dispatch && zeros >= lookups && d.clock.now() - t0 >= minElapsedMs) {
        const now = await failSignalKeys(d.page, s.failSignals ?? []).catch(() => new Set<string>());
        if ([...now].some((k) => !dispatch.failBefore.has(k))) return { result: 'not_committed' };
      }
    }
    await d.clock.sleep(wait);
    wait = Math.min(wait * 2, iv.capMs);
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
