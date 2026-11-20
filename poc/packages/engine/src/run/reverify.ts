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

const REVERIFY_MAX_ROWS = 5;
const REVERIFY_BUDGET_MS = 60_000;
const LOGIN_PROBE = { target: 'hometax.header.loginLink', pattern: 'login.loggedIn' } as const;

const SKIPS = ['excluded', 'package', 'no_baseline', 'sibling', 'inputs', 'later'] as const;
type Skip = (typeof SKIPS)[number];

/** checked: 이번에 조회한 행, unknown = checked − committed, skipped: 후보였지만 조회하지 않은 행. */
export type ReverifyCounts = { checked: number; committed: number; unknown: number; skipped: number };
export type ReverifyResult = ({ ok: true } & ReverifyCounts) | ({ ok: false; code: string } & ReverifyCounts);

interface ReverifyInput {
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
  exclude: string | null;
  inputsOf(runId: string): (RunInputsSummary & { startedAt: string }) | null;
  counterpartyBizNo(counterpartyId: string): string | null;
  bizNoHmac(bizNo: string): string;
  admit(): void;
}

interface Want {
  step: StepOf<'verify'>;
  match: Record<string, string>;
}

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
    if (j.result === 'failed') return done(enforcer.halted ?? 'reverify.lookup_failed', { lookup: j.code });
    i.ledger.markReverified(row, today);
    if (j.result === 'unknown') continue;
    try {
      i.ledger.resolve(row.intentId, row.stepId, 'committed', 'reverify', j.ref);
    } catch (e) {
      if (e instanceof LedgerError) continue;
      throw e;
    }
    taken.add(j.ref);
    i.journal.append(row.runId, 'ledger.committed', { reason: 'reverify', stepId: row.stepId });
    n.committed++;
  }
  return done();
}
