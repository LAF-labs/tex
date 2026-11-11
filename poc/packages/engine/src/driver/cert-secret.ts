// 공동인증서 비밀번호 차례(B1 로그인 s4 sign cert → human:secret, B2 발급 서명 s21 signFlow cert → human:secret). 제품 IR의 HumanPort.secret이다.
// 값은 엔진·main에 오지 않는다(ADR-020 결정 2, D05 §3.5). 엔진은 "끝났는지"와 끝 모양(코드)만 안다.
//
// 두 가지 길:
// 1. 비밀 창(window): 인증서 비밀번호 칸이 포털 화면(DOM)에 있으면 금고 비밀 창으로 연다(VaultSecretPort, secretWindow.openForHuman).
//    사용자는 전용 Chrome의 그 칸에 직접 친다. 금고가 그동안 엔진 CDP를 막고, 칸을 벗어나 값이 멈추면 닫는다. 창을 열기 전에 실행 탭을 앞으로 가져온다
//    (홈택스 Chrome이 앱 창 뒤에 가려지지 않게, CDP Page.bringToFront는 금고 중계 허용 목록에 있다).
//    칸 찾기: 스텝의 target(human kind=secret) → 없으면 사전에서 secretKind cert_password 항목이 정확히 하나일 때 그것.
// 2. 사람 직접 입력(manual): 칸이 사전에 없거나(인증서 창이 별도 프로그램이면 DOM이 아니다) 금고가 그 칸을 찾지 못하면, 사람이 인증서 창에서
//    직접 끝내고 앱에서 [다 했어요]를 누를 때까지 기다린다(main → RunService.secretDone). 엔진은 그 창에 아무것도 넣지 않는다.
//
// 끝 모양(조율기가 사람 말로 옮길 수 있는 코드로 바꾼다):
// - 'done': 입력이 끝났다(창이 닫힘 또는 [다 했어요]). 그 뒤 몇 초 동안 화면에 "비밀번호가 틀렸다" 안내가 보이면 { code: 'sign.password_wrong' }.
// - 'ttl': TTL(기본 120초) 안에 끝나지 않았다(조율기 human.ttl_expired: 쉼, 재개하면 마지막 체크포인트부터 → 창을 다시 연다).
// - { code: 'sign.password_wrong' }: 틀린 비밀번호(포털 응답). 쉼과 같은 길로 재개할 수 있다. 인증서 잠김을 막으려고 엔진은 다시 치지 않는다.
// - { code: 'sign.password_retry_limit' }: 이 실행에서 틀린 비밀번호가 MAX_WRONG번이면 더 열지 않는다(홈택스에서 직접 확인).
// - [중지]: signal이 끊기면 창 닫기를 요청하고 'ttl'로 돌려준다(조율기는 pending abort를 먼저 본다).
import type { HumanPort } from '../run/controller.ts';
import type { SelectorDict } from '../core/types.ts';
import { VaultSecretPort, type SecretVault } from './secret.ts';

export type SecretOutcome = 'done' | 'ttl' | { code: string };

/** main에 알리는 사람 차례(값 없음). mode window = 브라우저 칸에 직접, manual = 인증서 창에서 끝낸 뒤 [다 했어요]. */
export type SecretTurnEvent =
  | { state: 'open'; stepId: string; mode: 'window' | 'manual'; ttlMs: number }
  | { state: 'closed'; stepId: string; mode: 'window' | 'manual'; why: 'done' | 'ttl' | 'aborted' | 'password_wrong' | 'retry_limit' };

export interface CertSecretInput {
  vault: SecretVault;
  targetId(): string;
  dict: SelectorDict;
  strings: Readonly<Record<string, string>>;
  page: {
    /** 실행 탭을 앞으로(창 열기 전). 실패해도 계속한다. */
    bringToFront(): Promise<void>;
    /** 지금 화면 글자(틀린 비밀번호 안내 확인). 저널·로그에 쓰지 않는다. */
    text(): Promise<string>;
  };
  journal(type: string, payload?: Record<string, string | number | boolean>): void;
  event?(e: SecretTurnEvent): void;
  /** 사람 직접 입력 대기: [다 했어요](resolve 'done'). TTL·[중지]는 이 포트가 따로 본다. */
  manualDone(): Promise<void>;
  /** [중지]. */
  signal?: AbortSignal;
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
const defaultTimer = (fn: () => void, ms: number) => {
  const t = setTimeout(fn, ms);
  return () => clearTimeout(t);
};
const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class CertSecretPort implements Pick<HumanPort, 'secret'> {
  private readonly i: CertSecretInput;
  private readonly vaultPort: VaultSecretPort;
  private wrong = 0;

  constructor(i: CertSecretInput) {
    this.i = i;
    this.vaultPort = new VaultSecretPort({
      vault: i.vault, targetId: i.targetId, dict: i.dict, journal: i.journal,
      // 금고가 창을 연 때(그 전에는 알리지 않는다: 열지 못하면 사람 직접 입력으로 바뀐다)
      announce: (x) => i.event?.({ state: 'open', stepId: x.stepId, mode: 'window', ttlMs: x.ttlMs }),
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
    const key = this.targetKey(r.target);
    let mode: 'window' | 'manual' = 'manual';
    let out: 'done' | 'ttl' | 'aborted' | null = null;
    if (key) {
      await this.i.page.bringToFront().catch(() => {});
      const o = await this.vaultPort.open({ ...r, target: key, ...(this.i.signal ? { signal: this.i.signal } : {}) });
      if (typeof o === 'string') {
        mode = 'window';
        out = o;
      } else this.i.journal('human.secret_manual', { stepId: r.stepId, reason: o.refused });
    } else this.i.journal('human.secret_manual', { stepId: r.stepId, reason: 'no_field' });
    if (out === null) {
      await this.i.page.bringToFront().catch(() => {});
      this.i.event?.({ state: 'open', stepId: r.stepId, mode, ttlMs: r.ttlMs });
      out = await this.waitManual(r.ttlMs);
      this.i.journal(`human.manual_${out}`, { stepId: r.stepId });
    }
    if (out !== 'done') {
      this.i.event?.({ state: 'closed', stepId: r.stepId, mode, why: out });
      return 'ttl';
    }
    if (await this.passwordWrong()) {
      this.wrong++;
      this.i.journal('human.secret_password_wrong', { stepId: r.stepId, wrong: this.wrong });
      const limit = this.wrong >= MAX_WRONG;
      this.i.event?.({ state: 'closed', stepId: r.stepId, mode, why: limit ? 'retry_limit' : 'password_wrong' });
      return { code: limit ? 'sign.password_retry_limit' : 'sign.password_wrong' };
    }
    this.i.event?.({ state: 'closed', stepId: r.stepId, mode, why: 'done' });
    return 'done';
  }

  private waitManual(ttlMs: number): Promise<'done' | 'ttl' | 'aborted'> {
    return new Promise((resolve) => {
      let settled = false;
      const finish = (v: 'done' | 'ttl' | 'aborted') => {
        if (settled) return;
        settled = true;
        cancel();
        this.i.signal?.removeEventListener('abort', onAbort);
        resolve(v);
      };
      const cancel = (this.i.setTimer ?? defaultTimer)(() => finish('ttl'), ttlMs);
      const onAbort = () => finish('aborted');
      if (this.i.signal?.aborted) return finish('aborted');
      this.i.signal?.addEventListener('abort', onAbort, { once: true });
      this.i.manualDone().then(() => finish('done'), () => finish('ttl'));
    });
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
