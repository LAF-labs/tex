// 공동인증서 비밀번호 차례(B1 로그인 s4 sign cert → human:secret, B2 발급 서명 s21 signFlow cert → human:secret). 제품 IR의 HumanPort.secret이다.
// 값은 엔진·main에 오지 않는다(ADR-020 결정 2, D05 §3.5). 엔진은 "끝났는지"와 끝 모양(코드)만 안다.
//
// 두 가지 길(D05 §6.1):
// 1. 비밀 창(window): 인증서 비밀번호 칸이 포털 화면(main 프레임 DOM)에 있으면 실행 탭을 앞으로 가져온 뒤 금고 비밀 창으로 연다
//    (VaultSecretPort, secretWindow.openForHuman). 칸 찾기: 스텝 target → 없으면 사전에서 secretKind cert_password 항목이 정확히 하나일 때 그것.
// 2. 사람 직접 입력(manual): 홈택스 인증서 선택창(MagicLine4 iframe#dscert, 다른 출처라 엔진·금고가 안을 못 읽고 못 채운다)이 떠 있거나,
//    칸이 사전에 없거나, 금고가 칸을 찾지 못하면 곧바로 { code: 'human.cert_waiting' }을 돌려준다. 엔진은 그 창에 아무것도 넣지 않는다.
//    기다림은 B3 사람 대기다: 로그인이면 Paused → handoff {phase:'login', code:'human.cert_waiting'} → [다 했어요](run.resume)면 마지막 체크포인트부터,
//    발급 서명(signFlow)이면 서명 차례(handoff phase 'sign', sign.waiting) → [다 했어요]·[중지]·상한 모두 버튼을 누르지 않고 verify.
//
// 끝 모양(조율기가 사람 말로 옮길 수 있는 코드):
// - 'done': 비밀 창이 닫혔다. 그 뒤 몇 초 동안 화면에 "비밀번호가 틀렸다" 안내가 보이면 { code: 'sign.password_wrong' }.
// - 'ttl': TTL(기본 120초) 안에 창이 닫히지 않았다(창 닫기 요청, 조율기 human.ttl_expired → 재개하면 창을 다시 연다).
// - { code: 'human.cert_waiting' }: 사람이 홈택스 인증서 창에서 직접 넣는다(위 2).
// - { code: 'sign.password_wrong' }: 틀린 비밀번호(포털 응답). 쉼, 재개하면 창을 다시 연다. 인증서 잠김을 막으려고 엔진은 다시 치지 않는다.
// - { code: 'sign.password_retry_limit' }: 이 실행에서 틀린 비밀번호가 MAX_WRONG번이면 더 열지 않는다(홈택스에서 직접 확인).
// - [중지]: signal이 끊기면 창 닫기를 요청하고 'ttl'로 돌려준다(조율기는 pending abort를 먼저 본다).
import type { HumanPort } from '../run/controller.ts';
import type { SelectorDict } from '../core/types.ts';
import { VaultSecretPort, type SecretVault } from './secret.ts';

export type SecretOutcome = 'done' | 'ttl' | { code: string };

/** 사람이 홈택스 인증서 창에서 직접 넣는다(B3 사람 대기로 기다린다). */
export const CERT_WAITING = 'human.cert_waiting';
/** 홈택스 인증서 선택창(DreamSecurity MagicLine4, 2026-11-11 실화면): 다른 출처 iframe. 떠 있으면 금고 창으로 채울 수 없다. */
export const CERT_FRAME_CSS = 'iframe#dscert[src*="/ML4Web/"]';

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
    /** 실행 탭을 앞으로(창 열기 전). 실패해도 계속한다. */
    bringToFront(): Promise<void>;
    /** 지금 화면 글자(틀린 비밀번호 안내 확인): 본 프레임과 홈택스 인증서 창(iframe#dscert) 안. 저널·로그에 쓰지 않는다. */
    text(): Promise<string>;
    /** 홈택스 인증서 선택창(CERT_FRAME_CSS)이 보이는가. iframe 안은 읽지 않는다. */
    certFrame(): Promise<boolean>;
  };
  journal(type: string, payload?: Record<string, string | number | boolean>): void;
  event?(e: SecretTurnEvent): void;
  /** [중지]. */
  signal?: AbortSignal;
  /** 기억한 인증서 비밀번호의 프로필(금고 slot). 없으면 business(Phase 1 데스크톱). */
  scope?: string;
  setTimer?: (fn: () => void, ms: number) => () => void;
  sleep?: (ms: number) => Promise<void>;
  /** 입력 뒤 틀린 비밀번호 안내를 기다리는 시간(기본 3초). */
  settleMs?: number;
}

/** 이 실행에서 틀린 비밀번호를 이만큼 보면 창을 더 열지 않는다(인증서 비밀번호 오류 누적 잠김을 피한다). */
export const MAX_WRONG = 3;
/** 포털이 strings `cert.passwordWrong`(RE2 부분집합 패턴)을 주지 않을 때의 앱 내장 안내 문구 모양. 캡처 전이라 넓게 잡지 않는다. */
const WRONG_DEFAULT = /(인증서\s*)?(비밀번호|암호)가\s*(틀렸|틀립|일치하지\s*않|올바르지\s*않|맞지\s*않)/;
const STRING_KEY = 'cert.passwordWrong';
const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class CertSecretPort implements Pick<HumanPort, 'secret'> {
  private readonly i: CertSecretInput;
  private readonly vaultPort: VaultSecretPort;
  private wrong = 0;
  /** 금고가 비밀번호를 넣고 창을 닫은 뒤 로그인 확인을 기다리는 중(실행 id). 다음 기다림(wait) 스텝 결과로 금고에 알린다. */
  private confirming: string | null = null;
  /** 이 실행에서 로그인 확인을 이미 알렸다. 그 뒤(발급 서명)의 비밀번호 차례는 다시 재지 않는다: 같은 인증서 비밀번호이고, 서명 뒤 다른 실패로 맞는 기억값을 지우지 않게. */
  private checked = false;

  constructor(i: CertSecretInput) {
    this.i = i;
    this.vaultPort = new VaultSecretPort({
      vault: i.vault, targetId: i.targetId, dict: i.dict, journal: i.journal,
      // 금고가 창을 연 때(그 전에는 알리지 않는다: 열지 못하면 사람 직접 입력으로 바뀐다)
      announce: (x) => i.event?.({ state: 'open', stepId: x.stepId, ttlMs: x.ttlMs }),
      ...(i.setTimer ? { setTimer: i.setTimer } : {}),
    });
  }

  /** 비밀번호 칸 셀렉터 키: 스텝 target → 사전의 cert_password 항목(정확히 하나). */
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
    await this.i.page.bringToFront().catch(() => {});
    const manual = (reason: string): SecretOutcome => {
      this.i.journal('human.secret_manual', { stepId: r.stepId, reason });
      return { code: CERT_WAITING };
    };
    const key = this.targetKey(r.target);
    if (!key) return manual('no_field');
    // 홈택스 인증서 창(iframe#dscert)이 떠 있어도, 사전 칸이 그 iframe을 가리키면(frame = iframe 선택자) 금고가 그 칸을 맡는다(대표 지시 2026-11-13).
    // 금고는 기억한 비밀번호가 있으면 사람 창 없이 넣고, 없으면 사람이 넣은 값을 기억한다. 칸이 본 프레임에 있다고 적힌 옛 패키지면 예전처럼 사람 직접 입력.
    if (this.i.dict.entries[key]?.frame === 'main' && (await this.i.page.certFrame().catch(() => false))) return manual('cert_frame');
    // 틀림 안내를 보면 기억한 값을 다시 쓰지 않게 금고에 알리고(typist.authFailed → 버리고 지움) 곧바로 sign.password_wrong을 돌려준다.
    // 같은 차례에서 몰래 다시 받지 않는다: 틀린 입력은 인증서 연속 오류 횟수에 쌓이니 다시 넣는 것은 사람이 [이어서]로 정한다(부장 지시 2026-11-14).
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

  /**
   * 스텝이 끝날 때(service-ir stepEvent). 비밀번호를 넣은 뒤 첫 기다림(wait) 스텝이 통과하면 로그인 확인(typist.authOk → 금고가 그때 기억),
   * 실패하면(H-01 s5 시간 초과 = 틀린 비밀번호 포함) typist.authFailed(금고가 확인 대기 값을 버리고 기억값도 지운다, 연속 오류 잠금 방지).
   * 그 사이 다른 스텝이 실패하면(로그인 [확인] 못 누름 등) 비밀번호 탓이 아니니 알리지 않고 그만 기다린다(금고는 실행 끝에 버린다).
   */
  async stepFinished(type: string, failed: boolean, stepId = ''): Promise<void> {
    const runId = this.confirming;
    if (!runId) return;
    if (type !== 'wait') {
      if (failed) {
        this.confirming = null;
        return;
      }
      // 금고가 넣은 뒤 [확인]을 누르는 것은 다음 클릭 스텝이다(H-01 s4h). 틀림 안내(인증서 창 iframe 안)는 그 뒤에 뜨므로 여기서 본다.
      // 다음 기다림 스텝(s5)과 함께 돈다(늦추지 않는다). 보이면 바로 금고에 알린다(s5 시간 초과를 기다리지 않는다).
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

  /** 틀린 비밀번호를 봤다: 세고, 금고에 알리고(typist.authFailed → 확인 대기 값 버림·기억값 삭제), 이 실행의 로그인 확인을 끝낸다. */
  private async markWrong(runId: string, stepId: string): Promise<void> {
    this.wrong++;
    this.confirming = null;
    this.checked = true;
    this.i.journal('human.secret_password_wrong', { stepId, wrong: this.wrong });
    await this.i.vault.rpc('typist.authFailed', { runId, kind: 'cert_password', scope: this.i.scope ?? 'business' }).catch(() => {});
  }

  /** 입력 뒤 settleMs 동안 화면에 틀린 비밀번호 안내가 보이는가(포털 패턴 strings cert.passwordWrong, 없으면 내장 모양). */
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
