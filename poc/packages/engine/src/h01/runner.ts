import { performance } from 'node:perf_hooks';
import type { ElementHandle, Locator, Page } from 'playwright-core';
import { readbackHash } from '../gate.ts';
import { H01, normalizeField, type Cond, type Phase, type Step } from './playbook.ts';
import { failureMatches, READBACK_FIELDS, SELECTOR_KEYS, type LookupDef, type PortalConfig, type ReadbackKey, type SelectorKey } from '../portal.ts';
import { ariaValue } from '../driver/aria-tree.ts';
import { RunEnd, type RunnerPolicy, type RunStatus } from '../run-end.ts';


export interface RunInputs {
  counterpart: { id: string; bizNo: string; name: string };
  amounts: { supply: string; tax: string; total: string };
  items: Array<{ name: string }>;
  issueDate: string;
  email: string | null;
}

export type Readback = Record<ReadbackKey, string>;

export interface RunnerHooks {
  phase(p: Phase, state: 'now' | 'done' | 'attention', code?: string): void;
  checkStop(): void;
  gate(rb: Readback): Promise<{ readbackHash: string }>;
  arm(): void;
  dispatched(): void;
  resolve(state: 'committed' | 'not_committed' | 'in_doubt', reason: 'pre_dispatch_mismatch' | 'identity_mismatch' | 'signal' | 'verify' | null, ref: string | null): void;
  step?(stepId: string, type: Step['type']): void;
}

const VERIFY_FAILS_IN_A_ROW = 3;

const PAGE_STEPS = new Set<Step['type']>(['goto', 'checkpoint', 'fill', 'click', 'gate', 'submit', 'verify']);

export interface RunResult {
  status: RunStatus;
  code?: string;
  approvalNo?: string;
  mailConfirmed?: boolean;
}

const fail = (code: string) => new RunEnd('failed', code);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const MAIL_NOT_SENT = /실패|미전송|대기|오류|중$/;
const MAIL_SENT = new Set(['전송완료', '발송완료']);

/** 메일발송목록 상태 문구 판정(N-58): NFKC·공백 제거 뒤 부정 문구 → not_sent, 허용 목록 → sent, 그 밖 unknown. */
export function mailStatusVerdict(status: string): 'sent' | 'not_sent' | 'unknown' {
  const s = status.normalize('NFKC').replace(/\s+/g, '');
  if (MAIL_NOT_SENT.test(s)) return 'not_sent';
  return MAIL_SENT.has(s) ? 'sent' : 'unknown';
}

const CLICK_TIMEOUT_MS = 1_500;

function clickableNow(el: Element): boolean {
  if (!el.isConnected || (el as HTMLButtonElement).disabled || el.getAttribute('aria-disabled') === 'true') return false;
  el.scrollIntoView({ block: 'center', inline: 'center' });
  const r = el.getBoundingClientRect();
  if (r.width <= 0 || r.height <= 0) return false;
  const root = el.getRootNode() as Document | ShadowRoot;
  const top = root.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
  return !!top && (top === el || el.contains(top));
}

/**
 * 커밋 클릭(N-21): 먼저 입력 없이 누를 수 있는지만 본다. 아니면 입력을 보내지 않았으므로 'blocked'(not_committed).
 * 이어 실제 클릭의 예외는 요청이 나갔는지 알 수 없어 'sent'로 본다(verify가 정한다).
 */
export async function dispatchClick(button: Pick<ElementHandle, 'click' | 'evaluate'>): Promise<'blocked' | 'sent'> {
  const ready = await button.evaluate(clickableNow).catch(() => false);
  if (!ready) return 'blocked';
  try {
    await button.click({ timeout: CLICK_TIMEOUT_MS });
  } catch {
    // 요청이 나갔는지 알 수 없다
  }
  return 'sent';
}

export class H01Runner {
  private readonly page: Page;
  private readonly portal: PortalConfig;
  private readonly inputs: RunInputs;
  private readonly profile: { bizNo: string };
  private readonly hooks: RunnerHooks;
  private readonly policy: RunnerPolicy;
  private readonly vars: Record<string, string> = {};
  private baseline: Set<string> | null = null;
  private approvedHash: string | null = null;
  private rb: Readback | null = null;
  private dispatchedAt = 0;
  private failSignalsBefore = new Set<string>();

  constructor(page: Page, portal: PortalConfig, inputs: RunInputs, profile: { bizNo: string }, hooks: RunnerHooks, policy: RunnerPolicy) {
    this.page = page;
    this.portal = portal;
    this.inputs = inputs;
    this.profile = profile;
    this.hooks = hooks;
    this.policy = policy;
  }

  async run(): Promise<RunResult> {
    const byId = new Map(H01.steps.map((s) => [s.id, s]));
    let step: Step | undefined = H01.steps[0];
    let phase: Phase | null = null;
    while (step) {
      if (step.phase !== phase) {
        if (phase) this.hooks.phase(phase, 'done');
        phase = step.phase;
        this.hooks.phase(phase, 'now');
      }
      if (!this.approvedHash) this.hooks.checkStop();
      if (step !== H01.steps[0] && PAGE_STEPS.has(step.type)) await this.policy.beforeStep();
      this.hooks.step?.(step.id, step.type);
      const next = await this.exec(step);
      if (typeof next !== 'string') return next;
      step = byId.get(next);
      if (!step) throw fail('ir.bad_edge');
    }
    throw fail('ir.no_end');
  }

  private async exec(s: Step): Promise<string | RunResult> {
    const fallthrough = () => H01.steps[H01.steps.findIndex((x) => x.id === s.id) + 1]!.id;
    switch (s.type) {
      case 'goto':
        await this.openIssueForm();
        return fallthrough();
      case 'checkpoint': {
        if (!(await this.exists(s.expect))) {
          await this.openIssueForm();
          if (!(await this.exists(s.expect))) throw fail('checkpoint.expect_failed');
        }
        this.policy.reached();
        return fallthrough();
      }
      case 'fill': {
        const v = this.ref(s.value);
        if (v === null && s.ifAbsent !== 'clear') throw fail('input.missing');
        await this.policy.act('fill');
        const loc = await this.identify(s.target);
        await this.noCommitShadow(s.target, loc);
        await loc.fill(v ?? '');
        const key = this.portal.selectors[s.target].fieldKey;
        const got = await loc.inputValue();
        if (key ? normalizeField(key, got) !== normalizeField(key, v ?? '') : got !== (v ?? '')) throw fail('step.fill_mismatch');
        return fallthrough();
      }
      case 'click': {
        await this.policy.act('click');
        const loc = await this.identify(s.target);
        await this.noCommitShadow(s.target, loc);
        await loc.click();
        return fallthrough();
      }
      case 'wait': {
        const loc = await this.identify(s.target);
        const until = Date.now() + s.timeoutMs;
        while (!(await loc.inputValue()).trim()) {
          if (Date.now() > until) throw fail('wait.timeout');
          await sleep(100);
        }
        return fallthrough();
      }
      case 'assert':
        if (!(await this.cond(s.cond))) throw fail(s.code);
        return fallthrough();
      case 'readback':
        this.rb = await this.readAll();
        return fallthrough();
      case 'gate': {
        if (!this.rb) throw fail('ir.gate_without_readback');
        try {
          this.baseline = await this.invoiceNumbers(this.rb);
        } catch (e) {
          if (e instanceof RunEnd) throw e;
          throw new RunEnd('handoff', 'verify.baseline_missing');
        }
        await this.policy.beforeGate();
        this.hooks.checkStop();
        const g = await this.hooks.gate(this.rb);
        this.approvedHash = g.readbackHash;
        return fallthrough();
      }
      case 'submit':
        return this.submit(s.target, s.verify);
      case 'verify':
        return s.lookup === 'invoice' ? this.verifyInvoice(s.on) : this.verifyMail(s.on);
      case 'end':
        return { status: s.status, code: s.code, approvalNo: this.vars.approvalNo, mailConfirmed: this.vars.mailConfirmed === 'true' };
    }
  }

  private async submit(target: SelectorKey, verify: string): Promise<string> {
    await this.policy.beforeCommit();
    this.hooks.arm();
    let button: NonNullable<Awaited<ReturnType<Locator['elementHandle']>>>;
    try {
      const h = await (await this.identify(target)).elementHandle();
      if (!h) throw new Error('no_handle');
      button = h;
    } catch {
      this.hooks.resolve('not_committed', 'identity_mismatch', null);
      throw fail('step.identity_mismatch');
    }
    let rb2: Readback | null = null;
    try {
      rb2 = await this.readAll();
      this.failSignalsBefore = await this.failSignalKeys();
    } catch {
      // 다시 읽지 못했으면 값이 같다고 볼 수 없다
    }
    if (!rb2 || readbackHash(rb2) !== this.approvedHash) {
      await button.dispose();
      this.hooks.resolve('not_committed', 'pre_dispatch_mismatch', null);
      throw fail('pre_dispatch_mismatch');
    }
    const halt = this.policy.halted();
    if (halt) {
      await button.dispose();
      this.hooks.resolve('not_committed', 'signal', null);
      throw halt;
    }
    this.dispatchedAt = performance.now();
    const sent = await dispatchClick(button);
    await button.dispose().catch(() => {});
    if (sent === 'blocked') {
      this.hooks.resolve('not_committed', 'identity_mismatch', null);
      throw fail('step.identity_mismatch');
    }
    this.hooks.dispatched();
    await this.page.waitForLoadState('domcontentloaded').catch(() => {});
    await this.policy.settled(this.page);
    return verify;
  }

  private async verifyInvoice(on: { committed: string; not_committed: string; unknown: string }): Promise<string> {
    const { minElapsedMs, lookups, intervalMs, maxMs } = this.portal.verify;
    const intervalCap = this.portal.kind === 'fixture' ? 1_000 : 40_000;
    let wait = intervalMs;
    let zeroInARow = 0;
    let failedInARow = 0;
    while (performance.now() - this.dispatchedAt < maxMs) {
      let b1: Set<string> | null = null;
      try {
        b1 = await this.invoiceNumbers(this.rb!);
        failedInARow = 0;
      } catch (e) {
        if (e instanceof RunEnd) throw e;
        zeroInARow = 0;
        if (++failedInARow >= VERIFY_FAILS_IN_A_ROW) break;
      }
      if (b1) {
        const fresh = [...b1].filter((n) => !this.baseline!.has(n));
        if (fresh.length === 1) {
          this.vars.approvalNo = fresh[0]!;
          this.hooks.resolve('committed', null, fresh[0]!);
          return on.committed;
        }
        if (fresh.length > 1) break;
        zeroInARow++;
        if (zeroInARow >= lookups && performance.now() - this.dispatchedAt >= minElapsedMs) {
          const now = await this.failSignalKeys().catch(() => new Set<string>());
          if ([...now].some((k) => !this.failSignalsBefore.has(k))) {
            this.hooks.resolve('not_committed', 'verify', null);
            return on.not_committed;
          }
        }
      }
      await sleep(wait);
      wait = Math.min(wait * 2, intervalCap);
    }
    this.hooks.resolve('in_doubt', null, null);
    return on.unknown;
  }

  private async verifyMail(on: { committed: string; not_committed: string; unknown: string }): Promise<string> {
    if (!this.rb?.counterpartEmail) return on.committed;
    const { lookups, intervalMs } = this.portal.verify;
    for (let i = 0; i < lookups + 3; i++) {
      const rows = await this.lookup(this.portal.mailLookup, { approvalNo: this.vars.approvalNo! }).catch((e: unknown) => {
        if (e instanceof RunEnd) throw e;
        return null;
      });
      const verdicts = (rows ?? []).filter((r) => r.approvalNo === this.vars.approvalNo).map((r) => mailStatusVerdict(r.status ?? ''));
      if (verdicts.includes('not_sent')) return on.not_committed;
      if (verdicts.includes('sent')) {
        this.vars.mailConfirmed = 'true';
        return on.committed;
      }
      await sleep(intervalMs);
    }
    return on.unknown;
  }

  private async failSignalKeys(): Promise<Set<string>> {
    const out = new Set<string>();
    for (const entry of this.portal.failureSignal) {
      for (const l of await this.page.locator(entry.css).all()) {
        if (!(await l.isVisible())) continue;
        const text = await l.innerText();
        if (failureMatches(entry, text)) out.add(`${entry.css}\u0000${text.normalize('NFKC').replace(/\s+/g, ' ').trim()}`);
      }
    }
    return out;
  }

  private async invoiceNumbers(rb: Readback): Promise<Set<string>> {
    const rows = await this.lookup(this.portal.invoiceLookup, rb);
    const match = (['counterpartBizNo', 'issueDate', 'supplyAmount', 'taxAmount'] as const).map((k) => [k, rb[k]] as const);
    return new Set(rows.filter((r) => match.every(([k, v]) => normalizeField(k, r[k] ?? '') === v)).map((r) => r.approvalNo ?? '').filter(Boolean));
  }

  private async lookup(def: LookupDef, params: Partial<Record<string, string>>): Promise<Array<Record<string, string>>> {
    const url = new URL(def.path, this.portal.origin);
    for (const [k, q] of Object.entries(def.query)) url.searchParams.set(q!, params[k] ?? '');
    await this.policy.act('navigate');
    const [popup] = await Promise.all([
      this.page.waitForEvent('popup', { timeout: 10_000 }),
      this.page.evaluate((u) => {
        window.open(u, '_blank');
      }, url.toString()),
    ]);
    try {
      await popup.waitForLoadState('domcontentloaded');
      await this.policy.settled(popup);
      const ready = popup.locator(def.ready);
      await ready.first().waitFor({ state: 'attached', timeout: 10_000 });
      if ((await ready.count()) !== 1) throw new Error('lookup_ready_ambiguous');
      const count = Number(await ready.getAttribute('data-count'));
      const rows = await popup.locator(def.rows).evaluateAll((trs) => trs.map((tr) => Object.fromEntries([...tr.querySelectorAll('[data-k]')].map((td) => [td.getAttribute('data-k') ?? '', td.textContent ?? '']))));
      if (!Number.isSafeInteger(count) || count !== rows.length) throw new Error('lookup_incomplete');
      return rows;
    } finally {
      await popup.close().catch(() => {});
    }
  }

  private async openIssueForm(): Promise<void> {
    await this.policy.act('navigate');
    await this.page.goto(new URL(this.portal.issueForm, this.portal.origin).toString(), { waitUntil: 'domcontentloaded' });
    await this.policy.settled(this.page);
  }

  private ref(r: string): string | null {
    const i = this.inputs;
    const table: Record<string, string | null> = {
      '$inputs.counterpart.bizNo': i.counterpart.bizNo,
      '$inputs.email': i.email,
      '$inputs.items[0].name': i.items[0]?.name ?? null,
      '$inputs.amounts.supply': i.amounts.supply,
      '$inputs.amounts.tax': i.amounts.tax,
      '$inputs.issueDate': i.issueDate,
      '$profile.bizNo': this.profile.bizNo,
    };
    if (!(r in table)) throw fail('ir.bad_ref');
    const v = table[r];
    return v === undefined || v === null || v === '' ? null : v;
  }

  private async cond(c: Cond): Promise<boolean> {
    if ('fieldsFilled' in c) {
      for (const k of c.fieldsFilled) if (!(await this.readDom(this.keyOf(k))).trim()) return false;
      return true;
    }
    if ('sumEquals' in c) {
      if (!this.rb) return false;
      const [a, b] = c.sumEquals.parts.map((k) => this.rb![k]);
      const t = this.rb[c.sumEquals.total];
      return [a, b, t].every((v) => /^\d+$/.test(v ?? '')) && BigInt(a!) + BigInt(b!) === BigInt(t);
    }
    const want = this.ref(c.readbackEquals.ref);
    return !!this.rb && want !== null && this.rb[c.readbackEquals.fieldKey] === normalizeField(c.readbackEquals.fieldKey, want);
  }

  private keyOf(f: ReadbackKey): SelectorKey {
    return SELECTOR_KEYS.find((k) => this.portal.selectors[k].fieldKey === f)!;
  }

  private scope(key: SelectorKey): Page | Locator {
    const lm = this.portal.selectors[key].landmark;
    return lm ? this.page.locator(this.portal.selectors[lm].css) : this.page;
  }

  private async exists(key: SelectorKey): Promise<boolean> {
    try {
      await this.identify(key);
      return true;
    } catch {
      return false;
    }
  }

  private async identify(key: SelectorKey): Promise<Locator> {
    const e = this.portal.selectors[key];
    const scope = this.scope(key);
    const cand = scope.locator(e.css);
    if ((await cand.count()) !== 1) throw new RunEnd('failed', 'step.target_not_found');
    const byRole = scope.getByRole(e.role as Parameters<Page['getByRole']>[0], { name: new RegExp(e.name) });
    if ((await byRole.count()) !== 1) throw new RunEnd('failed', 'step.identity_mismatch');
    const h = await byRole.elementHandle();
    const same = await cand.evaluate((a, b) => a === b, h);
    await h?.dispose();
    if (!same) throw new RunEnd('failed', 'step.identity_mismatch');
    return cand;
  }

  private async noCommitShadow(key: SelectorKey, loc: Locator): Promise<void> {
    const lm = this.portal.selectors[key].landmark;
    for (const k of SELECTOR_KEYS) {
      const e = this.portal.selectors[k];
      if (!e.commits || e.landmark !== lm || k === key) continue;
      const c = this.scope(k).locator(e.css);
      if ((await c.count()) !== 1) continue;
      const h = await c.elementHandle();
      const same = await loc.evaluate((a, b) => a === b, h);
      await h?.dispose();
      if (same) throw new RunEnd('failed', 'step.commit_shadow');
    }
  }

  private async readDom(key: SelectorKey): Promise<string> {
    const loc = await this.identify(key);
    const role = this.portal.selectors[key].role;
    return role === 'textbox' || role === 'combobox' ? loc.inputValue() : ((await loc.textContent()) ?? '');
  }

  private async readAll(): Promise<Readback> {
    const out = {} as Readback;
    for (const f of READBACK_FIELDS) {
      const key = this.keyOf(f);
      const loc = await this.identify(key);
      const dom = await this.readDom(key);
      const a11y = ariaValue(await loc.ariaSnapshot(), this.portal.selectors[key].role);
      const v = normalizeField(f, dom);
      if (v !== normalizeField(f, a11y)) throw fail('step.readback_mismatch');
      out[f] = v;
    }
    return out;
  }
}
