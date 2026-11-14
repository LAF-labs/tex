// 발급 서명 보안카드 차례(대표 지시 2026-11-14). 제품 IR의 HumanPort.card다.
// 홈택스 보안카드 창(UTXPPABA08, 실화면 정적 파일 기준)은 실행 탭이 window.open으로 여는 새 창이고, 1~30번 가운데 두 칸의 앞·뒤 2자리를 묻는다.
// 1. 그 창(주소 정규식)을 찾고, 창의 알림(alert)을 이때부터 듣는다(듣지 않으면 Playwright가 알림을 그냥 닫는다).
// 2. 요청 글자에 칸 번호가 들어오면 금고에 typist.fillCard를 부른다. 금고가 글자를 읽고 저장값을 친다. 엔진은 칸 번호·값을 모른다.
// 3. 창의 [확인하기]를 누르고 알림 글로 끝을 판정한다: 성공 'done', 틀림·폐기·정보 없음은 사람 차례({ code }).
//    틀림이면 금고에 typist.authFailed(보안카드 suspect)를 알린다: 같은 값으로 다시 치지 않는다(5회 오류면 카드 폐기).
import type { Dialog, Page } from 'playwright-core';
import type { SecretVault } from './secret.ts';

export interface CardSecretInput {
  vault: SecretVault;
  targetId(): string;
  /** 실행 탭(새 창을 찾을 브라우저 문맥). */
  page: Page;
  strings: Readonly<Record<string, string>>;
  journal(type: string, payload?: Record<string, string | number | boolean>): void;
  scope?: string;
  signal?: AbortSignal;
}

const OUTCOME_WAIT_MS = 15_000;
const ASK_WAIT_MS = 15_000;
/** 포털이 strings를 주지 않을 때의 내장 판정(UTXPPABA08 MTXPP0155·0156·0153·0073). */
const DEFAULTS = { ok: '인증에\\s*성공', wrong: '인증에\\s*실패', locked: '폐기되었|폐지\\s*처리|보안카드\\s*정보가\\s*없' } as const;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

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

  async card(r: { runId: string; stepId: string; ttlMs: number; window: string; fields: Array<{ element: string; label: string }>; confirm: string }): Promise<'done' | { code: string }> {
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
    const failed = async (kind: 'wrong' | 'locked') => {
      await this.i.vault.rpc('typist.authFailed', { runId: r.runId, kind: 'security_card', scope }).catch(() => {});
      return { code: kind === 'wrong' ? 'sign.card_wrong' : 'sign.card_locked' };
    };
    try {
      // 창이 열리자마자 폐기·정보 없음 알림이 올 수 있다. 요청 칸 번호가 들어올 때까지 기다린다(자리 표시 [00]은 아직).
      const askReady = async () => {
        for (const f of r.fields) {
          const t = await win.locator(f.label).first().textContent({ timeout: 500 }).catch(() => null);
          if (!t || !/\[\s*[1-9]\d?\s*\]/.test(t)) return false;
        }
        return true;
      };
      const askUntil = Math.min(until, Date.now() + ASK_WAIT_MS);
      while (!(await askReady())) {
        const early = seen.map((m) => this.outcome(m)).find((x) => x === 'locked');
        if (early) return failed('locked');
        if (Date.now() > askUntil || win.isClosed() || this.i.signal?.aborted) return { code: 'sign.card_ask_missing' };
        await sleep(200);
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
      await win.locator(r.confirm).first().click({ timeout: 5_000 });
      await Promise.race([outcomeP, sleep(Math.min(OUTCOME_WAIT_MS, Math.max(0, until - Date.now())))]);
      const msg = seen.slice(before).find((m) => this.outcome(m) !== null);
      const end = msg ? this.outcome(msg) : null;
      this.i.journal('signflow.card_outcome', { stepId: r.stepId, outcome: end ?? 'none' });
      if (end === 'ok') return 'done';
      if (end === 'wrong' || end === 'locked') return failed(end);
      return { code: 'sign.card_no_outcome' };
    } catch {
      return { code: 'sign.card_window_error' };
    } finally {
      win.off('dialog', onDialog);
    }
  }
}
