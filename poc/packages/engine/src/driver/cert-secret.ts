import type { HumanPort } from '../run/controller.ts';
import type { SelectorDict } from '../core/types.ts';
import { VaultSecretPort, type SecretVault } from './secret.ts';

export type SecretOutcome = 'done' | 'ttl' | { code: string };

/** 사람이 홈택스 인증서 창에서 직접 넣는다(B3 사람 대기로 기다린다). */
export const CERT_WAITING = 'human.cert_waiting';
/** 홈택스 인증서 선택창(DreamSecurity MagicLine4, 2026-11-11 실화면): 다른 출처 iframe. 떠 있으면 금고 창으로 채울 수 없다. */
export const CERT_FRAME_CSS = 'iframe#dscert[src*="/ML4Web/"]';
/** 인증서 창(ML4Web) 경고 창의 [확인](실화면 정적 사본 ML4Web_Main·Popup과 가짜가 같은 id). 틀린 비밀번호 안내를 닫는다. */
export const CERT_ALERT_OK_CSS = '#btn_alert_confirm';

/** main에 알리는 금고 비밀 창 차례(값 없음, "홈택스 창의 칸에 직접 입력" 안내). 사람 직접 입력은 이 이벤트가 아니라 B3 handoff로 보인다. */
export type SecretTurnEvent =
  | { state: 'open'; stepId: string; ttlMs: number }
  | { state: 'closed'; stepId: string; why: 'done' | 'ttl' | 'aborted' | 'password_wrong' | 'retry_limit' };

export interface CertSecretInput {
  vault: SecretVault;
  targetId(): string;
  dict: SelectorDict;
  strings: Readonly<Record<string, string>>;
  page: {
    text(): Promise<string>;
    certFrame(): Promise<boolean>;
    dismissAlert?(): Promise<void>;
  };
  journal(type: string, payload?: Record<string, string | number | boolean>): void;
  event?(e: SecretTurnEvent): void;
  signal?: AbortSignal;
  scope?: string;
  setTimer?: (fn: () => void, ms: number) => () => void;
  sleep?: (ms: number) => Promise<void>;
  settleMs?: number;
}

/** 이 실행에서 틀린 비밀번호를 이만큼 보면 창을 더 열지 않는다(인증서 비밀번호 오류 누적 잠김을 피한다). */
export const MAX_WRONG = 3;
const WRONG_DEFAULT = /(인증서\s*)?(비밀번호|암호)가\s*(틀렸|틀립|일치하지\s*않|올바르지\s*않|맞지\s*않)/;
const STRING_KEY = 'cert.passwordWrong';
const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class CertSecretPort implements Pick<HumanPort, 'secret'> {
  private readonly i: CertSecretInput;
  private readonly vaultPort: VaultSecretPort;
  private wrong = 0;
  private confirming: string | null = null;
  private checked = false;
  private signRetried = false;

  constructor(i: CertSecretInput) {
    this.i = i;
    this.vaultPort = new VaultSecretPort({
      vault: i.vault, targetId: i.targetId, dict: i.dict, journal: i.journal,
      announce: (x) => i.event?.({ state: 'open', stepId: x.stepId, ttlMs: x.ttlMs }),
      ...(i.setTimer ? { setTimer: i.setTimer } : {}),
    });
  }

  targetKey(target?: string): string | null {
    if (target) return target;
    const ks = Object.keys(this.i.dict.entries).filter((k) => this.i.dict.entries[k]!.secretKind === 'cert_password');
    return ks.length === 1 ? ks[0]! : null;
  }

  async secret(r: { runId: string; stepId: string; target?: string; prompt?: string; ttlMs: number }): Promise<SecretOutcome> {
    if (this.wrong >= MAX_WRONG) {
      this.i.journal('human.secret_retry_limit', { stepId: r.stepId, wrong: this.wrong });
      return { code: 'sign.password_retry_limit' };
    }
    const manual = (reason: string): SecretOutcome => {
      this.i.journal('human.secret_manual', { stepId: r.stepId, reason });
      return { code: CERT_WAITING };
    };
    const key = this.targetKey(r.target);
    if (!key) return manual('no_field');
    if (this.i.dict.entries[key]?.frame === 'main' && (await this.i.page.certFrame().catch(() => false))) return manual('cert_frame');
    const out = await this.vaultPort.open({ ...r, target: key, ...(this.i.signal ? { signal: this.i.signal } : {}) });
    if (typeof out !== 'string') return manual(out.refused);
    if (out !== 'done') {
      this.i.event?.({ state: 'closed', stepId: r.stepId, why: out });
      return 'ttl';
    }
    if (await this.passwordWrong()) {
      await this.markWrong(r.runId, r.stepId);
      const limit = this.wrong >= MAX_WRONG;
      this.i.event?.({ state: 'closed', stepId: r.stepId, why: limit ? 'retry_limit' : 'password_wrong' });
      return { code: limit ? 'sign.password_retry_limit' : 'sign.password_wrong' };
    }
    this.i.event?.({ state: 'closed', stepId: r.stepId, why: 'done' });
    if (!this.checked) this.confirming = r.runId;
    return 'done';
  }

  async stepFinished(type: string, failed: boolean, stepId = ''): Promise<void> {
    const runId = this.confirming;
    if (!runId) return;
    if (type !== 'wait') {
      if (failed) {
        this.confirming = null;
        return;
      }
      if (type === 'click' && (await this.passwordWrong()) && this.confirming === runId) await this.markWrong(runId, stepId);
      return;
    }
    this.confirming = null;
    this.checked = true;
    const scope = this.i.scope ?? 'business';
    if (failed) {
      this.i.journal('human.secret_login_unconfirmed', {});
      await this.i.vault.rpc('typist.authFailed', { runId, kind: 'cert_password', scope }).catch(() => {});
      return;
    }
    this.i.journal('human.secret_login_confirmed', {});
    await this.i.vault.rpc('typist.authOk', { runId, kind: 'cert_password', scope }).catch(() => {});
  }

  async afterSignConfirm(r: { runId: string; stepId: string }): Promise<'ok' | 'wrong'> {
    if (await this.passwordWrong()) {
      await this.markWrong(r.runId, r.stepId);
      return 'wrong';
    }
    if (this.signRetried) {
      this.signRetried = false;
      await this.i.vault.rpc('typist.authOk', { runId: r.runId, kind: 'cert_password', scope: this.i.scope ?? 'business' }).catch(() => {});
      this.i.journal('human.secret_sign_confirmed', { stepId: r.stepId });
    }
    return 'ok';
  }

  private async markWrong(runId: string, stepId: string): Promise<void> {
    this.wrong++;
    this.signRetried = true;
    this.confirming = null;
    this.checked = true;
    this.i.journal('human.secret_password_wrong', { stepId, wrong: this.wrong });
    await this.i.vault.rpc('typist.authFailed', { runId, kind: 'cert_password', scope: this.i.scope ?? 'business' }).catch(() => {});
    await this.i.page.dismissAlert?.().catch(() => {});
  }

  private async passwordWrong(): Promise<boolean> {
    let re = WRONG_DEFAULT;
    const p = this.i.strings[STRING_KEY];
    if (p) {
      try {
        re = new RegExp(p);
      } catch {
        // 패턴이 틀리면 내장 모양(로더 V-01이 먼저 거른다)
      }
    }
    const until = Date.now() + (this.i.settleMs ?? 3_000);
    const sleep = this.i.sleep ?? defaultSleep;
    do {
      const t = await this.i.page.text().catch(() => '');
      if (re.test(t.normalize('NFKC'))) return true;
      if (this.i.signal?.aborted) return false;
      await sleep(250);
    } while (Date.now() < until);
    return false;
  }
}
