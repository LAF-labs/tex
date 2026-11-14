// run.reverify: 재시작 뒤 원장 in_doubt 행을 새 프로세스에서 발급목록 조회로만 확정한다.
// - 조회 match는 그 실행의 봉인된 입력 요약(거래처 id·공급가·세액)과 시작 시각(작성일자, KST)에서 되살린다.
//   거래처 사업자번호는 원장 행의 HMAC과 같을 때만 쓴다(그 뒤 장부에서 번호를 고쳤으면 되살리지 않는다).
// - 같은 match를 가진 in_doubt 행이 둘 이상이면 어느 실행의 발급인지 모른다. 조회하지 않고 unknown이다.
// - 작성일자가 오늘(KST)이 아닌 행은 조회하지 않고 unknown이다. 조회 패키지(hometax.invoice.lookup 1.2.0)는 목록 화면의 기본 기간(오늘)만 본다.
//   그 밖의 날짜는 목록에 나올 수 없어 요청만 쓰고 아무것도 증명하지 못한다.
// - 판정은 judgeReverify(core/verify.ts). committed·not_committed만 원장을 바꾼다(사유 reverify). unknown·조회 실패는 손대지 않는다.
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

/** 후보 한도: 최근 7일에 무장한 행, 한 번에 5건(최근 순). */
export const REVERIFY_WINDOW_MS = 7 * 86_400_000;
export const REVERIFY_MAX_ROWS = 5;
/** 실행 탭 머리말로 로그인을 본다(H-01 s2와 같은 대상·문구). 대상을 못 찾으면 판단하지 않고 조회에 맡긴다. */
const LOGIN_PROBE = { target: 'hometax.header.loginLink', pattern: 'login.loggedIn' } as const;

export type ReverifyCounts = { checked: number; committed: number; notCommitted: number; unknown: number };
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
  inputsOf(runId: string): (RunInputsSummary & { startedAt: string }) | null;
  counterpartyBizNo(counterpartyId: string): string | null;
  bizNoHmac(bizNo: string): string;
  /** 요청률 입장(쿨다운·하루 실행 수). 조회할 행이 있을 때만 부른다. 넘으면 RunEnd를 던진다. */
  admit(): void;
}

interface Want {
  step: StepOf<'verify'>;
  match: Record<string, string>;
  key: string;
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
  if (!match) return null;
  return { step, match, key: JSON.stringify([step.lookup.playbook, ...Object.entries(match).sort()]) };
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

export async function reverifyInDoubt(i: ReverifyInput): Promise<ReverifyResult> {
  const files = i.ir.pkg.files;
  const rows = i.ledger.inDoubt(files.manifest.id, new Date(i.now - REVERIFY_WINDOW_MS).toISOString());
  const wants = new Map(rows.map((r) => [r, wantOf(i, r)] as const));
  const seen = new Map<string, number>();
  for (const w of wants.values()) if (w) seen.set(w.key, (seen.get(w.key) ?? 0) + 1);
  const batch = rows.slice(0, REVERIFY_MAX_ROWS).map((row) => {
    const w = wants.get(row) ?? null;
    return { row, want: w && seen.get(w.key) === 1 ? w : null };
  });
  const n: ReverifyCounts = { checked: batch.length, committed: 0, notCommitted: 0, unknown: 0 };
  const done = (code?: string, extra: Record<string, string> = {}): ReverifyResult => {
    n.unknown = n.checked - n.committed - n.notCommitted;
    if (n.checked) i.log.event('run.reverify', { ...n, ...(code ? { stop: code } : {}), ...extra });
    return code ? { ok: false, code, ...n } : { ok: true, ...n };
  };
  if (!batch.some((b) => b.want)) return done();
  if (!i.ir.lookupPackages) return done('reverify.no_lookup');
  try {
    i.admit();
  } catch (e) {
    return done((e as { code?: string }).code ?? 'policy.refused');
  }
  if ((await loggedIn(i.page, files.selectors, files.strings)) === false) return done('reverify.not_logged_in');

  const enforcer = new RunEnforcer({
    guard: i.rate, clock: systemClock, mono: () => performance.now(), dict: i.signals, profileId: i.profileId,
    journal: (type, payload) => i.log.event('run.reverify_policy', { type, ...payload }),
  });
  const lookup = new IrLookupPort({
    page: i.page, packages: i.ir.lookupPackages, policy: enforcer, clock: systemClock, fixtureGrant: i.ir.fixtureGrant ?? null,
    events: { security: (code, key) => i.log.event('run.reverify_security', { code, key }), journal: (type, payload) => i.log.event('run.reverify_lookup', { type, ...payload }) },
  });
  const deps = { lookup, clock: systemClock, dict: files.selectors, strings: files.strings, lookups: i.portal.verify.lookups, intervalMs: i.portal.verify.intervalMs };
  const taken = i.ledger.committedRefs();
  for (const { row, want } of batch) {
    if (!want) continue;
    const j = await judgeReverify(deps, want.step, want.match, taken);
    if (j.result === 'failed') return done(enforcer.halted ?? 'reverify.lookup_failed', { lookup: j.code });
    if (j.result === 'unknown') continue;
    try {
      i.ledger.resolve(row.intentId, row.stepId, j.result, 'reverify', j.ref ?? null);
    } catch (e) {
      // 조회하는 사이 다른 길로 종결됐다(그 판정이 먼저다)
      if (e instanceof LedgerError) continue;
      throw e;
    }
    if (j.ref) taken.add(j.ref);
    i.journal.append(row.runId, `ledger.${j.result}`, { reason: 'reverify', stepId: row.stepId });
    if (j.result === 'committed') n.committed++;
    else n.notCommitted++;
  }
  return done();
}
