// 발급 서명 보안카드 차례(대표 지시 2026-11-14). 제품 IR의 HumanPort.card다.
// 홈택스 보안카드 창(UTXPPABA08, 실화면 정적 파일 기준)은 실행 탭이 window.open으로 여는 새 창이고, 1~30번 가운데 두 칸의 앞·뒤 2자리를 묻는다.
// 1. 그 창(주소 정규식)을 찾고, 창의 알림(alert)을 이때부터 듣는다(듣지 않으면 Playwright가 알림을 그냥 닫는다).
// 2. 요청 글자에 칸 번호가 들어오면 금고에 typist.fillCard를 부른다. 금고가 글자를 읽고 저장값을 친다. 엔진은 칸 번호·값을 모른다.
// 3. 창의 [확인하기]를 누르고 알림 글로 끝을 판정한다: 성공 'done', 틀림·폐기·정보 없음은 사람 차례({ code }).
//    틀림이면 금고에 typist.authFailed(보안카드 suspect)를 알린다: 같은 값으로 다시 치지 않는다(5회 오류면 카드 폐기).
import type { Dialog, Page } from 'playwright-core';
import type { SecretVault } from './secret.ts';
import type { ActResult, Actuator, PageReader } from '../core/page.ts';
import type { SelectorDict } from '../core/types.ts';
import { resolveTarget } from '../core/resolve.ts';

export interface CardSecretInput {
  vault: SecretVault;
  targetId(): string;
  /** 실행 탭(새 창을 찾을 브라우저 문맥). */
  page: Page;
  strings: Readonly<Record<string, string>>;
  journal(type: string, payload?: Record<string, string | number | boolean>): void;
  scope?: string;
  signal?: AbortSignal;
  dict: SelectorDict;
  /** 보안카드 창의 GuardedActuator(실행 탭과 같은 무장 판정·정책)와 읽기. */
  actuatorFor(win: Page): { act: Pick<Actuator, 'click'>; reader: PageReader };
}

const OUTCOME_WAIT_MS = 15_000;
/** [확인하기] 클릭이 예외로 끝났을 때 창의 알림을 기다리는 시간. */
const CLICK_FAIL_WAIT_MS = 5_000;
const ASK_WAIT_MS = 15_000;
/** 포털이 strings를 주지 않을 때의 내장 판정(UTXPPABA08 MTXPP0155·0156·0153·0073). */
const DEFAULTS = { ok: '인증에\\s*성공', wrong: '인증에\\s*실패', locked: '폐기되었|폐지\\s*처리|보안카드\\s*정보가\\s*없' } as const;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
/** 요청 글자에 칸 번호가 들어왔는가: "[7]"·"[07]"·"[30]"(1~35). 자리 표시 "[00]"은 아직이다(금고 parseCardAsk와 같은 범위). */
const ASK_ROW = /\[\s*(0?[1-9]|[12]\d|3[0-5])\s*\]/;

/** 조율기가 [확인하기] 누르기를 허락하는 문(기한 안·이 무장에서 한 번). 'clicked'가 아니면 누르지 않았다. */
export type CardPress = (click: () => Promise<ActResult>) => Promise<'clicked' | 'expired' | 'once' | 'failed'>;

export class CardSecretPort {
  private readonly i: CardSecretInput;

  constructor(i: CardSecretInput) {
    this.i = i;
  }

  private re(key: keyof typeof DEFAULTS): RegExp {
    try {
      return new RegExp(this.i.strings[`card.${key}`] ?? DEFAULTS[key]);
    } catch {
      return new RegExp(DEFAULTS[key]);
    }
  }

  /** 알림 글 → 끝. 성공을 먼저, 그다음 틀림(틀림 글에도 "폐기됩니다"가 있다), 그다음 폐기·정보 없음. */
  private outcome(msg: string): 'ok' | 'wrong' | 'locked' | null {
    if (this.re('ok').test(msg)) return 'ok';
    if (this.re('wrong').test(msg)) return 'wrong';
    if (this.re('locked').test(msg)) return 'locked';
    return null;
  }

  private async findWindow(re: RegExp, until: number): Promise<Page | null> {
    while (Date.now() < until && !this.i.signal?.aborted) {
      const p = this.i.page.context().pages().find((x) => x !== this.i.page && !x.isClosed() && re.test(x.url()));
      if (p) return p;
      await sleep(200);
    }
    return null;
  }

  /**
   * r.confirmKey: 그 창의 [확인하기] 사전 키. r.press: 조율기가 기한·한 번만을 확인하고 누르기를 허락한다(누르기 자체는 이 창의 GuardedActuator).
   */
  async card(r: { runId: string; stepId: string; ttlMs: number; window: string; fields: Array<{ element: string; label: string }>; confirmKey: string; press: CardPress }): Promise<'done' | { code: string }> {
    const until = Date.now() + Math.max(0, r.ttlMs);
    let re: RegExp;
    try {
      re = new RegExp(r.window);
    } catch {
      return { code: 'sign.card_bad_window' };
    }
    const win = await this.findWindow(re, Math.min(until, Date.now() + 30_000));
    if (!win) return { code: 'sign.card_window_missing' };
    this.i.journal('signflow.card_window', { stepId: r.stepId });
    const seen: string[] = [];
    let wake: () => void = () => {};
    const onDialog = (d: Dialog) => {
      seen.push(d.message());
      wake();
      // 확인 대화(취소하시겠습니까)는 닫고, 알림은 받는다
      void (d.type() === 'confirm' ? d.dismiss() : d.accept()).catch(() => {});
    };
    win.on('dialog', onDialog);
    const scope = this.i.scope ?? 'business';
    // 틀림·폐기를 본 뒤에는 금고에 반드시 알린다(suspect: 다음 실행이 같은 값을 다시 치지 않게, 카드 5회 오류 폐기). 실패하면 다시 시도하고, 끝내 못 하면 그 사실을 코드로 남긴다.
    const failed = async (kind: 'wrong' | 'locked'): Promise<{ code: string }> => {
      for (let n = 0; n < 3; n++) {
        const ok = await this.i.vault.rpc('typist.authFailed', { runId: r.runId, kind: 'security_card', scope }).then(() => true, () => false);
        if (ok) return { code: kind === 'wrong' ? 'sign.card_wrong' : 'sign.card_locked' };
        await sleep(300);
      }
      this.i.journal('signflow.card_suspect_unsaved', { stepId: r.stepId });
      return { code: 'sign.card_suspect_unsaved' };
    };
    // 지금까지 본 알림 가운데 틀림·폐기가 있으면 그 끝(어느 길로 끝나든 먼저 본다)
    const badSeen = (): 'wrong' | 'locked' | null => {
      const o = seen.map((m) => this.outcome(m));
      return o.includes('locked') ? 'locked' : o.includes('wrong') ? 'wrong' : null;
    };
    try {
      // 창이 열리자마자 폐기·정보 없음 알림이 올 수 있다. 요청 칸 번호가 들어올 때까지 기다린다(자리 표시 [00]은 아직, [05]처럼 0을 채운 번호는 받는다).
      const askReady = async () => {
        for (const f of r.fields) {
          const t = await win.locator(f.label).first().textContent({ timeout: 500 }).catch(() => null);
          if (!t || !ASK_ROW.test(t)) return false;
        }
        return true;
      };
      const askUntil = Math.min(until, Date.now() + ASK_WAIT_MS);
      while (!(await askReady())) {
        const bad = badSeen();
        if (bad) return await failed(bad);
        if (Date.now() > askUntil || win.isClosed() || this.i.signal?.aborted) return { code: 'sign.card_ask_missing' };
        await sleep(200);
      }
      // [확인하기]를 치기 전에 먼저 찾아 둔다: 못 찾으면 값을 치지 않는다. 칸을 친 뒤 금고가 이 창을 오염 상태로 두면
      // 엔진의 새 스크립트 주입이 막히므로(R-A1 접근성 읽기), 읽기 도구도 이때 이 창에 들어간다.
      const ga = this.i.actuatorFor(win);
      const pre = await resolveTarget(ga.reader, this.i.dict, r.confirmKey);
      if (!pre.ok) {
        this.i.journal('signflow.card_confirm_unresolved', { stepId: r.stepId, code: pre.code, when: 'before_fill' });
        return { code: 'sign.card_confirm_missing' };
      }
      const fill = await this.i.vault
        .rpc<{ ok?: unknown; reason?: unknown }>('typist.fillCard', { runId: r.runId, targetId: this.i.targetId(), window: r.window, fields: r.fields, scope })
        .catch(() => ({ ok: false, reason: 'port_error' }));
      if (fill?.ok !== true) {
        const why = typeof fill?.reason === 'string' && /^[a-z_]{1,40}$/.test(fill.reason) ? fill.reason : 'other';
        return { code: `sign.card_${why}` };
      }
      this.i.journal('signflow.card_filled', { stepId: r.stepId });
      const before = seen.length;
      const outcomeP = new Promise<void>((res) => (wake = res));
      // [확인하기]는 commits 항목: 이 창의 GuardedActuator(무장·R-A1)로, 조율기가 기한·한 번만을 허락할 때만 누른다
      const t = await resolveTarget(ga.reader, this.i.dict, r.confirmKey);
      if (!t.ok) {
        this.i.journal('signflow.card_confirm_unresolved', { stepId: r.stepId, code: t.code, when: 'after_fill' });
        return { code: 'sign.card_confirm_missing' };
      }
      const pressed = await r.press(() => ga.act.click(t.t));
      // 누르지 않았으면(기한·한 번) 그대로 끝. 누르다 실패했으면(클릭 예외) 창이 이미 알림을 띄우고 닫혔을 수 있으니 결과를 잠깐 기다려 본다
      if (pressed === 'expired' || pressed === 'once') return { code: `sign.card_confirm_${pressed}` };
      if (pressed === 'failed') {
        await Promise.race([outcomeP, sleep(Math.min(CLICK_FAIL_WAIT_MS, Math.max(0, until - Date.now())))]);
        const ok = seen.slice(before).some((m) => this.outcome(m) === 'ok');
        const bad = badSeen();
        this.i.journal('signflow.card_outcome', { stepId: r.stepId, outcome: ok ? 'ok' : (bad ?? 'none'), after: 'click_failed' });
        if (bad) return await failed(bad);
        return ok ? 'done' : { code: 'sign.card_confirm_failed' };
      }
      await Promise.race([outcomeP, sleep(Math.min(OUTCOME_WAIT_MS, Math.max(0, until - Date.now())))]);
      const msg = seen.slice(before).find((m) => this.outcome(m) !== null);
      const end = msg ? this.outcome(msg) : badSeen();
      this.i.journal('signflow.card_outcome', { stepId: r.stepId, outcome: end ?? 'none' });
      if (end === 'ok') return 'done';
      if (end === 'wrong' || end === 'locked') return await failed(end);
      return { code: 'sign.card_no_outcome' };
    } catch {
      const bad = badSeen();
      return bad ? await failed(bad) : { code: 'sign.card_window_error' };
    } finally {
      win.off('dialog', onDialog);
    }
  }
}
