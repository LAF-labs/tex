import { performance } from 'node:perf_hooks';
import type { ElementHandle, Locator, Page } from 'playwright-core';
import { readbackHash } from '../gate.ts';
import { H01, normalizeField, type Cond, type Phase, type Step } from './playbook.ts';
import { failureMatches, READBACK_FIELDS, SELECTOR_KEYS, type LookupDef, type PortalConfig, type ReadbackKey, type SelectorKey } from '../portal.ts';
import { ariaValue } from '../driver/aria-tree.ts';
import { RunEnd, type RunnerPolicy, type RunStatus } from '../run-end.ts';

// H-01 발급 구간 실행기(D03 §5). 페이지에 닿는 동작은 모두 여기 있고, 게이트·원장·토큰은 hooks(RunService)가 한다.
// 클릭·입력 직전마다 동일성 검사(R-A1)와 커밋 그림자 검사(R-A2)를 하고, 동작은 모두 요청률 정책(policy, D03 §7)을 먼저 지난다.

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
  /** 정지 요청이 있으면 RunEnd를 던진다(커밋 구간 밖에서만 부른다). */
  checkStop(): void;
  /** 게이트: 요청을 내고 승인(토큰 소비 + 원장 armed)까지 기다린다. 중지·만료면 RunEnd. */
  gate(rb: Readback): Promise<{ readbackHash: string }>;
  /** 비가역 스텝 진입(R-G7): 토큰 검증 → 원장 armed + 토큰 소비(한 트랜잭션). 정지·만료·재사용이면 RunEnd. */
  arm(): void;
  dispatched(): void;
  resolve(state: 'committed' | 'not_committed' | 'in_doubt', reason: 'pre_dispatch_mismatch' | 'identity_mismatch' | 'signal' | 'verify' | null, ref: string | null): void;
}

/**
 * 요청률 정책(D03 §5.2 Actuator의 policy, §7). 페이지에 닿는 동작은 모두 act()를 먼저 지난다.
 * 차단 신호가 걸쇠에 걸렸으면 어느 메서드든 RunEnd를 던진다.
 */
/** verify 조회가 이만큼 연속 실패하면 더 조회하지 않는다(결과는 unknown). */
const VERIFY_FAILS_IN_A_ROW = 3;

/** 스텝 지연을 두는 스텝(페이지에 닿는 것). 읽기만 하는 스텝(wait·assert·readback)과 end는 두지 않는다. */
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
/** 정확 허용 목록(PoC-3 실측으로 확정). 부분 일치로 '전송실패'가 '보냈음'이 되지 않게 부정 우선으로 본다. */
const MAIL_SENT = new Set(['전송완료', '발송완료']);

/** 메일발송목록 상태 문구 판정(N-58): NFKC·공백 제거 뒤 부정 문구 → not_sent, 허용 목록 → sent, 그 밖 unknown. */
export function mailStatusVerdict(status: string): 'sent' | 'not_sent' | 'unknown' {
  const s = status.normalize('NFKC').replace(/\s+/g, '');
  if (MAIL_NOT_SENT.test(s)) return 'not_sent';
  return MAIL_SENT.has(s) ? 'sent' : 'unknown';
}

/** 클릭 가능성 사전 확인 시간. 가려지거나 움직이는 버튼을 Playwright 기본 30초 동안 기다리지 않는다. */
const CLICK_TIMEOUT_MS = 1_500;

/**
 * 입력 없이 지금 누를 수 있는지 본다: 연결됨·비활성 아님·크기 있음·가운데 점의 맨 위 요소가 이 버튼(또는 그 안).
 * Playwright `click({trial})`은 쓰지 않는다: 실제 마우스 입력을 보내고 Playwright 리스너로 막을 뿐이라, 페이지가 먼저 건
 * 캡처 리스너에는 click이 간다(2026-11-03 재현). 화면 밖이면 가운데로 굴린다(스크롤은 입력이 아니다).
 */
function clickableNow(el: Element): boolean {
  if (!el.isConnected || (el as HTMLButtonElement).disabled || el.getAttribute('aria-disabled') === 'true') return false;
  el.scrollIntoView({ block: 'center', inline: 'center' });
  const r = el.getBoundingClientRect();
  if (r.width <= 0 || r.height <= 0) return false;
  // shadow DOM 안이면 그 루트에서 본다(문서에서 보면 host가 나온다).
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
  /** 커밋 클릭 시각(단조 시계). verify 상한·최소 경과를 벽시계 역행과 무관하게 센다. */
  private dispatchedAt = 0;
  /** 클릭 직전 보이던 실패 신호(셀렉터·정규화 문구). 클릭 뒤 새로 보인 것만 명시적 실패 신호로 센다. */
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
      // 게이트 승인 뒤(커밋 구간·verify)에는 정지를 받지 않는다.
      if (!this.approvedHash) this.hooks.checkStop();
      if (step !== H01.steps[0] && PAGE_STEPS.has(step.type)) await this.policy.beforeStep();
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
        await this.openIssueForm();
        return fallthrough();
      case 'checkpoint': {
        // reentry: reload. 도착 조건이 거짓이면 url로 새로 읽고 한 번 더 본다(D03 §5.5).
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
        // 정책(화면 확인·상한)을 먼저 지나고, 동일성·커밋 그림자 검사는 동작 바로 앞에 둔다(R-A1).
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
        // verify 기준선 조회(B-07): 게이트 진입 직전, 새 탭. 실패하면 게이트를 열지 않는다(아직 커밋 전).
        try {
          this.baseline = await this.invoiceNumbers(this.rb);
        } catch (e) {
          if (e instanceof RunEnd) throw e; // 차단 신호·[중지]
          throw new RunEnd('handoff', 'verify.baseline_missing');
        }
        // 기준선 조회는 오래 걸릴 수 있다. 그 사이 온 [중지]·차단 신호를 게이트를 열기 전에 받는다.
        // beforeGate 뒤 게이트가 열릴 때까지는 await가 없어 그 사이에 걸쇠가 걸려도 게이트 대기에서 닫힌다(runs.ts latched).
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

  /**
   * 커밋 구간(R-G7): 토큰 검증 → armed + 소비 → 동일성 검사 → readback 재계산·비교 → 클릭 → dispatched.
   * 동일성을 확인한 그 요소를 누른다(셀렉터를 다시 찾지 않는다). 재계산과 클릭 사이에 디스크 I/O가 없다.
   */
  private async submit(target: SelectorKey, verify: string): Promise<string> {
    await this.policy.beforeCommit();
    this.hooks.arm();
    let button: NonNullable<Awaited<ReturnType<Locator['elementHandle']>>>;
    try {
      // 핸들을 얻지 못했으면 누르지 않았다(not_committed). armed 뒤라 그냥 빠져나가면 in_doubt가 된다.
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
    // 무장 뒤 재계산하는 동안 걸린 신호: 누르지 않는다(요청이 나가지 않았으므로 not_committed). 메모리만 본다.
    const halt = this.policy.halted();
    if (halt) {
      await button.dispose();
      this.hooks.resolve('not_committed', 'signal', null);
      throw halt;
    }
    this.dispatchedAt = performance.now();
    // 누를 수 없는 버튼(덮개·이동 중)은 1.5초 안에 드러난다: 요청이 나가지 않았으므로 not_committed.
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

  /** B₁ \ B₀가 정확히 1건이면 committed(승인번호 bind). 부재 증거가 모두 있을 때만 not_committed, 나머지는 unknown(D02 §4.4). */
  private async verifyInvoice(on: { committed: string; not_committed: string; unknown: string }): Promise<string> {
    const { minElapsedMs, lookups, intervalMs, maxMs } = this.portal.verify;
    // 반영 지연만으로 '모름'이 남지 않게 상한(maxMs)까지 조회한다. 간격은 두 배씩(홈택스 40초, 가짜 페이지 1초 상한).
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
        if (e instanceof RunEnd) throw e; // 차단 신호: 더 조회하지 않는다(발급됐는지 모름)
        zeroInARow = 0; // 조회 실패는 부재 증거가 아니다
        // 조회 화면이 계속 열리지 않으면(사전에 없는 차단 화면일 수 있다) 더 두드리지 않고 '모름'으로 둔다(D03 §7).
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
          // 클릭 뒤 새로 보이고 문구까지 맞는 실패 신호만 센다(숨김 오류 상자·클릭 전부터 있던 문구·성공 안내는 증거가 아니다).
          // 없으면 상한까지 계속 조회한다(반영이 늦을 수 있다).
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

  /**
   * 메일발송목록에서 승인번호 행 확인(D02 §8 s33). 승인한 받는 이메일(바에 보인 readback 값)이 없으면 건너뛴다(s32b).
   * 초안 입력이 아니라 승인한 값으로 정한다(s15 뒤 포털이 칸을 다시 채웠어도 승인한 것과 같은 판단을 하게).
   */
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

  /** 지금 보이고 문구 패턴에 맞는 실패 신호 요소의 키(셀렉터 + 정규화 문구). */
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

  /**
   * 조회 하위 흐름: 허용 origin 팝업(금고가 새 탭 만들기를 막는다)에서 읽고 닫는다. 원래 탭은 건드리지 않는다(D03 §5.6).
   * 결과 준비 신호(data-count)가 없거나 행 수가 맞지 않으면 조회 실패다(부재 증거가 아니다).
   * 잔여: noopener 팝업은 금고 중계가 노출하지 않아(실측) 조회 탭이 opener로 발급 탭에 닿을 수 있다. 클릭 직전 재계산이 값 변경을 잡는다.
   */
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

  /** 발급 화면으로 간다(네비게이션: 분당 상한 → goto → 안정 대기·차단 신호 확인). */
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

  /**
   * readback(B-06): DOM 값과 접근성 값을 둘 다 읽어 정규화한 뒤 일치해야 한다. 하나라도 다르면 step.readback_mismatch.
   * 한계(PoC): 접근성 값은 Playwright aria 스냅숏이다. 입력 칸은 그 값도 요소의 .value에서 오므로 독립 증거가 아니고,
   * 표시 요소(status)만 보이는 텍스트와 textContent의 차이를 잡는다. 브라우저 AX 트리(Accessibility.getPartialAXTree)는
   * 금고 중계가 엔진에 page 세션 CDP를 따로 열어 주지 않아 쓰지 못했다. readbackOf(별도 표시 요소) 세 값 대조는 PoC-3에서.
   */
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
