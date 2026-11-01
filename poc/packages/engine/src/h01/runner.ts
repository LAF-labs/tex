import type { Locator, Page } from 'playwright-core';
import { readbackHash } from '../gate.ts';
import { H01, normalizeField, type Cond, type Phase, type Step } from './playbook.ts';
import { READBACK_FIELDS, SELECTOR_KEYS, type LookupDef, type PortalConfig, type ReadbackKey, type SelectorKey } from './portal.ts';

// H-01 발급 구간 실행기(D03 §5). 페이지에 닿는 동작은 모두 여기 있고, 게이트·원장·토큰은 hooks(RunService)가 한다.
// 클릭·입력 직전마다 동일성 검사(R-A1)와 커밋 그림자 검사(R-A2)를 한다.

export interface RunInputs {
  counterpart: { id: string; bizNo: string; name: string };
  amounts: { supply: string; tax: string; total: string };
  items: Array<{ name: string }>;
  issueDate: string;
  email: string | null;
}

export type Readback = Record<ReadbackKey, string>;

export type RunStatus = 'success' | 'completed_with_issues' | 'failed' | 'handoff' | 'stopped' | 'expired' | 'in_doubt';

/** 실행이 끝났다(정상 종료가 아닌 경우도). code는 사용자 문구를 고르는 키다(값 없음). */
export class RunEnd extends Error {
  readonly status: RunStatus;
  readonly code: string;
  constructor(status: RunStatus, code: string) {
    super(code);
    this.status = status;
    this.code = code;
  }
}

export interface RunnerHooks {
  phase(p: Phase, state: 'now' | 'done' | 'attention', code?: string): void;
  /** 정지 요청이 있으면 RunEnd를 던진다(커밋 구간 밖에서만 부른다). */
  checkStop(): void;
  /** 게이트: 요청을 내고 승인(토큰 소비 + 원장 armed)까지 기다린다. 중지·만료면 RunEnd. */
  gate(rb: Readback): Promise<{ readbackHash: string }>;
  /** 커밋 클릭 직전: 게이트 토큰을 한 번 쓴다(만료·재사용이면 RunEnd). 디스크 I/O 없음. */
  useToken(): void;
  dispatched(): void;
  resolve(state: 'committed' | 'not_committed' | 'in_doubt', reason: 'pre_dispatch_mismatch' | 'identity_mismatch' | 'verify' | null, ref: string | null): void;
}

export interface RunResult {
  status: RunStatus;
  code?: string;
  approvalNo?: string;
  mailConfirmed?: boolean;
}

const fail = (code: string) => new RunEnd('failed', code);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** aria 스냅숏 첫 줄 `- role "name": value`의 값. combobox는 [selected] 항목 이름. */
export function ariaValue(snapshot: string, role: string): string {
  const unq = (v: string) => {
    const t = v.trim();
    if (t.startsWith('"')) return JSON.parse(t) as string;
    if (t.startsWith("'")) return t.slice(1, -1).replace(/''/g, "'");
    return t;
  };
  const lines = snapshot.split('\n');
  if (role === 'combobox') {
    const sel = lines.map((l) => /^\s*- option "((?:[^"\\]|\\.)*)".*\[selected\]/.exec(l)).find(Boolean);
    return sel ? (JSON.parse(`"${sel[1]}"`) as string) : '';
  }
  const m = /^- [a-z]+(?: "(?:[^"\\]|\\.)*")?(?: \[[^\]]*\])*(?::(.*))?$/.exec(lines[0] ?? '');
  return m?.[1] !== undefined ? unq(m[1]) : '';
}

export class H01Runner {
  private readonly page: Page;
  private readonly portal: PortalConfig;
  private readonly inputs: RunInputs;
  private readonly profile: { bizNo: string };
  private readonly hooks: RunnerHooks;
  private readonly vars: Record<string, string> = {};
  private baseline: Set<string> | null = null;
  private approvedHash: string | null = null;
  private rb: Readback | null = null;
  private dispatchedAt = 0;

  constructor(page: Page, portal: PortalConfig, inputs: RunInputs, profile: { bizNo: string }, hooks: RunnerHooks) {
    this.page = page;
    this.portal = portal;
    this.inputs = inputs;
    this.profile = profile;
    this.hooks = hooks;
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
      // 게이트 승인 뒤(커밋 구간·verify)에는 정지를 받지 않는다.
      if (!this.approvedHash) this.hooks.checkStop();
      const next = await this.exec(step);
      if (typeof next !== 'string') return next;
      step = byId.get(next);
      if (!step) throw fail('ir.bad_edge');
    }
    throw fail('ir.no_end');
  }

  /** 다음 스텝 id 또는 종료 결과. */
  private async exec(s: Step): Promise<string | RunResult> {
    const fallthrough = () => H01.steps[H01.steps.findIndex((x) => x.id === s.id) + 1]!.id;
    switch (s.type) {
      case 'goto':
        await this.page.goto(new URL(this.portal.issueForm, this.portal.origin).toString(), { waitUntil: 'domcontentloaded' });
        return fallthrough();
      case 'checkpoint': {
        // reentry: reload. 도착 조건이 거짓이면 url로 새로 읽고 한 번 더 본다(D03 §5.5).
        if (!(await this.exists(s.expect))) {
          await this.page.goto(new URL(this.portal.issueForm, this.portal.origin).toString(), { waitUntil: 'domcontentloaded' });
          if (!(await this.exists(s.expect))) throw fail('checkpoint.expect_failed');
        }
        return fallthrough();
      }
      case 'fill': {
        const v = this.ref(s.value);
        if (v === null && s.ifAbsent !== 'clear') throw fail('input.missing');
        const loc = await this.identify(s.target);
        await this.noCommitShadow(s.target, loc);
        await loc.fill(v ?? '');
        const key = this.portal.selectors[s.target].fieldKey;
        const got = await loc.inputValue();
        if (key ? normalizeField(key, got) !== normalizeField(key, v ?? '') : got !== (v ?? '')) throw fail('step.fill_mismatch');
        return fallthrough();
      }
      case 'click': {
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
        // verify 기준선 조회(B-07): 게이트 진입 직전, 새 탭. 실패하면 게이트를 열지 않는다(아직 커밋 전).
        try {
          this.baseline = await this.invoiceNumbers(this.rb);
        } catch {
          throw new RunEnd('handoff', 'verify.baseline_missing');
        }
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

  /** 커밋 구간(R-G7): readback 재계산 → 비교 → 동일성 검사 → 클릭 → dispatched. 재계산과 클릭 사이에 디스크 I/O가 없다. */
  private async submit(target: SelectorKey, verify: string): Promise<string> {
    let rb2: Readback;
    try {
      rb2 = await this.readAll();
    } catch {
      this.hooks.resolve('not_committed', 'pre_dispatch_mismatch', null);
      throw fail('pre_dispatch_mismatch');
    }
    if (readbackHash(rb2) !== this.approvedHash) {
      this.hooks.resolve('not_committed', 'pre_dispatch_mismatch', null);
      throw fail('pre_dispatch_mismatch');
    }
    let loc: Locator;
    try {
      loc = await this.identify(target);
    } catch {
      this.hooks.resolve('not_committed', 'identity_mismatch', null);
      throw fail('step.identity_mismatch');
    }
    try {
      this.hooks.useToken();
    } catch (e) {
      this.hooks.resolve('not_committed', 'pre_dispatch_mismatch', null);
      throw e;
    }
    this.dispatchedAt = Date.now();
    try {
      await loc.click();
    } catch {
      // 요청이 나갔는지 알 수 없다. dispatched로 두고 verify가 정한다.
    }
    this.hooks.dispatched();
    await this.page.waitForLoadState('domcontentloaded').catch(() => {});
    return verify;
  }

  /** B₁ \ B₀가 정확히 1건이면 committed(승인번호 bind). 부재 증거가 모두 있을 때만 not_committed, 나머지는 unknown(D02 §4.4). */
  private async verifyInvoice(on: { committed: string; not_committed: string; unknown: string }): Promise<string> {
    const { minElapsedMs, lookups, intervalMs } = this.portal.verify;
    let zeroInARow = 0;
    for (let attempt = 0; attempt < lookups + 20; attempt++) {
      let b1: Set<string> | null = null;
      try {
        b1 = await this.invoiceNumbers(this.rb!);
      } catch {
        zeroInARow = 0; // 조회 실패는 부재 증거가 아니다
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
        if (zeroInARow >= lookups && Date.now() - this.dispatchedAt >= minElapsedMs) {
          if (await this.page.locator(this.portal.failureSignal).count().catch(() => 0)) {
            this.hooks.resolve('not_committed', 'verify', null);
            return on.not_committed;
          }
          break;
        }
      }
      await sleep(intervalMs);
    }
    this.hooks.resolve('in_doubt', null, null);
    return on.unknown;
  }

  /** 메일발송목록에서 승인번호 행 확인(D02 §8 s33). 이메일 입력이 없으면 건너뛴다(s32b). */
  private async verifyMail(on: { committed: string; not_committed: string; unknown: string }): Promise<string> {
    if (!this.inputs.email) return on.committed;
    const { lookups, intervalMs } = this.portal.verify;
    for (let i = 0; i < lookups + 3; i++) {
      const rows = await this.lookup(this.portal.mailLookup, { approvalNo: this.vars.approvalNo! }).catch(() => null);
      if (rows?.some((r) => r.approvalNo === this.vars.approvalNo && /전송|완료/.test(r.status ?? ''))) {
        this.vars.mailConfirmed = 'true';
        return on.committed;
      }
      await sleep(intervalMs);
    }
    return on.unknown;
  }

  private async invoiceNumbers(rb: Readback): Promise<Set<string>> {
    const rows = await this.lookup(this.portal.invoiceLookup, rb);
    const match = (['counterpartBizNo', 'issueDate', 'supplyAmount', 'taxAmount'] as const).map((k) => [k, rb[k]] as const);
    return new Set(rows.filter((r) => match.every(([k, v]) => normalizeField(k, r[k] ?? '') === v)).map((r) => r.approvalNo ?? '').filter(Boolean));
  }

  /** 조회 하위 흐름: 허용 origin 팝업(금고가 새 탭 만들기를 막는다)에서 읽고 닫는다. 원래 탭은 건드리지 않는다(D03 §5.6). */
  private async lookup(def: LookupDef, params: Partial<Record<string, string>>): Promise<Array<Record<string, string>>> {
    const url = new URL(def.path, this.portal.origin);
    for (const [k, q] of Object.entries(def.query)) url.searchParams.set(q!, params[k] ?? '');
    const [popup] = await Promise.all([
      this.page.waitForEvent('popup', { timeout: 10_000 }),
      this.page.evaluate((u) => {
        window.open(u, '_blank');
      }, url.toString()),
    ]);
    try {
      await popup.waitForLoadState('domcontentloaded');
      return await popup.locator(def.rows).evaluateAll((trs) => trs.map((tr) => Object.fromEntries([...tr.querySelectorAll('[data-k]')].map((td) => [td.getAttribute('data-k') ?? '', td.textContent ?? '']))));
    } finally {
      await popup.close().catch(() => {});
    }
  }

  private ref(r: string): string | null {
    const i = this.inputs;
    const table: Record<string, string | null> = {
      '$inputs.counterpart.bizNo': i.counterpart.bizNo,
      '$inputs.email': i.email,
      '$inputs.items[0].name': i.items[0]?.name ?? null,
      '$inputs.amounts.supply': i.amounts.supply,
      '$inputs.amounts.tax': i.amounts.tax,
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

  /**
   * R-A1: 후보 셀렉터가 가리키는 요소가 사전의 역할·접근성 이름(앵커 패턴)과 맞고, 같은 랜드마크 안에서
   * 그 역할·이름에 맞는 요소가 정확히 하나이며 둘이 같은 요소일 때만 쓴다.
   */
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

  /** R-A2: 비커밋 동작의 대상이 같은 랜드마크의 커밋 항목과 같은 요소면 누르지 않는다. */
  private async noCommitShadow(key: SelectorKey, loc: Locator): Promise<void> {
    const lm = this.portal.selectors[key].landmark;
    for (const k of SELECTOR_KEYS) {
      const e = this.portal.selectors[k];
      if (!e.commits || e.landmark !== lm || k === key) continue;
      const c = this.scope(k).locator(e.css);
      if ((await c.count()) !== 1) continue; // 해석 실패한 커밋 항목은 비교에서 뺀다
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

  /** readback(B-06): DOM 값과 접근성 값을 둘 다 읽어 정규화한 뒤 일치해야 한다. 하나라도 다르면 step.readback_mismatch. */
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
