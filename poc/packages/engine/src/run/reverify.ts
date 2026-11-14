// run.reverify: 재시작 뒤 원장 in_doubt 행을 새 프로세스에서 발급목록 조회로만 확정한다. 적는 것은 committed뿐이다.
// - 조회 match는 그 실행의 봉인된 입력 요약(거래처 id·공급가·세액)과 시작 시각(작성일자, KST)에서 되살린다.
//   거래처 사업자번호는 원장 행의 HMAC과 같을 때만 쓴다(그 뒤 장부에서 번호를 고쳤으면 되살리지 않는다).
// - 새 건은 B₁ \ B₀다. B₀는 무장할 때 원장 행에 적은 게이트 전 기준선(baseline_refs)이다. B₀가 없는 행은 조회하지 않는다.
//   그 전에 홈택스 웹·다른 PC·[직접 발급함]으로 같은 거래처·금액을 발급했어도(B₀ 안) 이 실행의 발급으로 잡지 않는다.
// - 조회하지 않는 행: 오늘(KST) 무장하지 않음, 방금 끝난 실행(exclude, 그 실행은 300초 B₀ 판정을 이미 받았다), 지금 패키지와 digest가 다름,
//   B₀ 없음, 오늘 같은 거래처(HMAC)에 승인번호 없는 다른 원장 행이 있음(상태·플레이북 무관, 어느 시도의 발급인지 모른다), 오늘 이미 조회함.
//   조회 패키지(hometax.invoice.lookup 1.2.0)는 목록 화면의 기본 기간(오늘)만 본다. 그 밖의 날짜는 목록에 나올 수 없다.
// - 판정은 judgeReverify(core/verify.ts). committed만 원장을 바꾼다(사유 reverify). unknown·조회 실패는 손대지 않는다.
// - 같은 행은 하루 한 번만 조회한다(조회 직전에 reverify_day를 적는다). 한 호출은 REVERIFY_BUDGET_MS 안에 끝낸다.
// - 이 경로에는 클릭·제출이 없다. 조회 팝업(GuardedActuator, commitArmed 늘 거짓)만 연다. 원장에 새 시도를 만들지 않는다.
// 값은 저널·로그에 남기지 않는다(⑦). 엔진 로그에는 건수와 코드만.
import { LedgerError, type Ledger, type LedgerRow, type RunJournal } from '@sax/db';
import type { EventLog } from '@sax/platform';
import type { Page } from 'playwright-core';
import { stringPattern } from '../core/conds.ts';
import { normalizeName } from '../core/constants.ts';
import { systemClock } from '../core/page.ts';
import { domValue } from '../core/readback.ts';
import { resolveTarget } from '../core/resolve.ts';
import { newScope } from '../core/scope.ts';
import type { SelectorDict, StepOf, Strings } from '../core/types.ts';
import { judgeReverify, resolveMatch, verifyOfIrreversible } from '../core/verify.ts';
import { IrLookupPort } from '../driver/lookup-ir.ts';
import { PlaywrightPageReader } from '../driver/reader.ts';
import { RunEnforcer } from '../enforcer.ts';
import { kstDay, type RateGuard } from '../policy.ts';
import type { PortalConfig } from '../portal.ts';
import type { RunInputsSummary } from '../run-history.ts';
import type { SignalDict } from '../signals.ts';
import type { IrPackage } from './service-ir.ts';

/** 한 번에 조회하는 행 수(최근 순)와 한 호출의 시간 상한. */
export const REVERIFY_MAX_ROWS = 5;
export const REVERIFY_BUDGET_MS = 60_000;
/** 실행 탭 머리말로 로그인을 본다(H-01 s2와 같은 대상·문구). 대상을 못 찾으면 판단하지 않고 조회에 맡긴다. */
const LOGIN_PROBE = { target: 'hometax.header.loginLink', pattern: 'login.loggedIn' } as const;

/** 조회하지 않은 이유(위 머리말 순서). */
const SKIPS = ['excluded', 'package', 'no_baseline', 'sibling', 'inputs', 'later'] as const;
type Skip = (typeof SKIPS)[number];

/** checked: 이번에 조회한 행, unknown = checked − committed, skipped: 후보였지만 조회하지 않은 행. */
export type ReverifyCounts = { checked: number; committed: number; unknown: number; skipped: number };
export type ReverifyResult = ({ ok: true } & ReverifyCounts) | ({ ok: false; code: string } & ReverifyCounts);

export interface ReverifyInput {
  /** 지금 열린 실행 탭(로그인된 앱 안 브라우저). 조회 팝업을 여기서 연다. */
  page: Page;
  ir: IrPackage;
  portal: PortalConfig;
  ledger: Ledger;
  journal: RunJournal;
  rate: RateGuard;
  signals: SignalDict;
  profileId: string;
  log: EventLog;
  now: number;
  /** 조회하지 않을 실행(방금 끝난 실행). */
  exclude: string | null;
  inputsOf(runId: string): (RunInputsSummary & { startedAt: string }) | null;
  counterpartyBizNo(counterpartyId: string): string | null;
  bizNoHmac(bizNo: string): string;
  /** 요청률 입장(쿨다운·하루 실행 수). 조회할 행이 있고 로그인을 확인한 뒤에만 부른다. 넘으면 RunEnd를 던진다. */
  admit(): void;
}

interface Want {
  step: StepOf<'verify'>;
  match: Record<string, string>;
}

/** 그 행의 verify 스텝과 실행 입력에서 되살린 match. 하나라도 모자라면 null(조회하지 않는다). */
function wantOf(i: ReverifyInput, row: LedgerRow): Want | null {
  const step = verifyOfIrreversible(i.ir.pkg.files.playbook, row.stepId);
  const inp = step ? i.inputsOf(row.runId) : null;
  const bizNo = inp ? i.counterpartyBizNo(inp.counterpartyId) : null;
  const started = inp ? Date.parse(inp.startedAt) : NaN;
  if (!step || !inp || !bizNo || i.bizNoHmac(bizNo) !== row.cpBizNoHmac || !Number.isFinite(started)) return null;
  const amounts = { supply: String(inp.supply), tax: String(inp.tax), total: String(inp.supply + inp.tax) };
  const issueDate = kstDay(started);
  if (issueDate !== kstDay(i.now)) return null;
  const scope = newScope({ inputs: { counterpart: { bizNo }, amounts, issueDate } });
  for (const [k, v] of Object.entries({ counterpartBizNo: bizNo, supplyAmount: amounts.supply, taxAmount: amounts.tax, totalAmount: amounts.total, issueDate })) scope.readback.set(k, v);
  const match = resolveMatch(scope, step.lookup.match);
  return match ? { step, match } : null;
}

/** 실행 탭이 로그인 상태인가. 머리말 대상을 못 찾거나 읽지 못하면 null(모름). */
async function loggedIn(page: Page, dict: SelectorDict, strings: Strings): Promise<boolean | null> {
  const re = stringPattern(strings, LOGIN_PROBE.pattern);
  const entry = dict.entries[LOGIN_PROBE.target];
  if (!re || !entry || page.isClosed()) return null;
  const reader = new PlaywrightPageReader(page);
  try {
    const r = await resolveTarget(reader, dict, LOGIN_PROBE.target);
    return r.ok ? re.test(normalizeName(await domValue(reader, entry, r.t.el))) : null;
  } catch {
    return null;
  } finally {
    await reader.release().catch(() => {});
  }
}

/** 조회하지 않을 이유. 없으면 null. */
function skipOf(i: ReverifyInput, row: LedgerRow, since: string): Skip | null {
  if (row.runId === i.exclude) return 'excluded';
  if (row.packageDigest !== i.ir.pkg.manifestDigest) return 'package';
  if (!row.baselineRefs) return 'no_baseline';
  if (i.ledger.unboundSibling(row, since)) return 'sibling';
  return null;
}

export async function reverifyInDoubt(i: ReverifyInput): Promise<ReverifyResult> {
  const files = i.ir.pkg.files;
  const today = kstDay(i.now);
  const since = new Date(Date.parse(`${today}T00:00:00+09:00`)).toISOString();
  const skipped = Object.fromEntries(SKIPS.map((k) => [k, 0])) as Record<Skip, number>;
  const batch: Array<{ row: LedgerRow; want: Want; b0: ReadonlySet<string> }> = [];
  for (const row of i.ledger.inDoubt(files.manifest.id, since, today)) {
    const why = skipOf(i, row, since);
    const want = why ? null : wantOf(i, row);
    if (why || !want) skipped[why ?? 'inputs']++;
    else if (batch.length >= REVERIFY_MAX_ROWS) skipped.later++;
    else batch.push({ row, want, b0: new Set(row.baselineRefs) });
  }
  const n: ReverifyCounts = { checked: 0, committed: 0, unknown: 0, skipped: Object.values(skipped).reduce((a, b) => a + b, 0) };
  const done = (code?: string, extra: Record<string, string> = {}): ReverifyResult => {
    n.unknown = n.checked - n.committed;
    const why = Object.fromEntries(SKIPS.filter((k) => skipped[k]).map((k) => [`skip_${k}`, skipped[k]]));
    if (n.checked || n.skipped || code) i.log.event('run.reverify', { ...n, ...why, ...(code ? { stop: code } : {}), ...extra });
    return code ? { ok: false, code, ...n } : { ok: true, ...n };
  };
  if (!batch.length) return done();
  if (!i.ir.lookupPackages) return done('reverify.no_lookup');
  if ((await loggedIn(i.page, files.selectors, files.strings)) === false) return done('reverify.not_logged_in');
  try {
    i.admit();
  } catch (e) {
    return done((e as { code?: string }).code ?? 'policy.refused');
  }

  const enforcer = new RunEnforcer({
    guard: i.rate, clock: systemClock, mono: () => performance.now(), dict: i.signals, profileId: i.profileId,
    journal: (type, payload) => i.log.event('run.reverify_policy', { type, ...payload }),
  });
  const lookup = new IrLookupPort({
    page: i.page, packages: i.ir.lookupPackages, policy: enforcer, clock: systemClock, fixtureGrant: i.ir.fixtureGrant ?? null,
    events: { security: (code, key) => i.log.event('run.reverify_security', { code, key }), journal: (type, payload) => i.log.event('run.reverify_lookup', { type, ...payload }) },
  });
  const deadline = systemClock.now() + REVERIFY_BUDGET_MS;
  const deps = { lookup, clock: systemClock, dict: files.selectors, strings: files.strings, lookups: i.portal.verify.lookups, intervalMs: i.portal.verify.intervalMs, deadline };
  const taken = i.ledger.committedRefs();
  for (const { row, want, b0 } of batch) {
    if (systemClock.now() >= deadline) return done('reverify.time_cap');
    n.checked++;
    const j = await judgeReverify(deps, want.step, want.match, new Set([...b0, ...taken]));
    // 조회가 실패하면(팝업·점검·차단) 오늘 본 것으로 적지 않는다: 다음 실행 끝에 다시 본다. 판정이 나왔을 때만 하루 한 번 표시.
    if (j.result === 'failed') return done(enforcer.halted ?? 'reverify.lookup_failed', { lookup: j.code });
    i.ledger.markReverified(row, today);
    if (j.result === 'unknown') continue;
    try {
      i.ledger.resolve(row.intentId, row.stepId, 'committed', 'reverify', j.ref);
    } catch (e) {
      // 조회하는 사이 다른 길로 종결됐다(그 판정이 먼저다)
      if (e instanceof LedgerError) continue;
      throw e;
    }
    taken.add(j.ref);
    i.journal.append(row.runId, 'ledger.committed', { reason: 'reverify', stepId: row.stepId });
    n.committed++;
  }
  return done();
}
