// Windows 세션을 따르는 금고 잠금(ADR-026 결정 3·4, D05 §2).
// 금고 열림 = 세션 열림 ∧ 유휴 < vault.idleLockSec ∧ 열린 지 < vault.unlockMaxSec (엄격 모드는 ∧ Hello 확인 후 < vault.unlockTtlSec).
// utilityProcess에는 powerMonitor가 없으므로 이벤트·유휴 시간은 main이 control 포트로 넘긴다. 유휴 보고가 끊기면 잠근다(fail-closed).
import { SESSION_IDLE_STALE_MS, type SessionEventKind, type VaultLockReason } from '../protocol.ts';

export const VAULT_IDLE_LOCK_SEC = 900;
export const VAULT_UNLOCK_MAX_SEC = 28_800;
export const VAULT_UNLOCK_TTL_SEC = 300;

export interface SessionLockOptions {
  now?: () => number;
  idleLockSec?: number;
  unlockMaxSec?: number;
  unlockTtlSec?: number;
  idleStaleMs?: number;
}

export type OpenVerdict = { open: true } | { open: false; reason: VaultLockReason; helloCanOpen: boolean };

/**
 * 상태(단조로운 몇 개의 값):
 * - sessionOpen: 마지막 세션 이벤트가 잠금 계열이 아니다.
 * - silent: 프롬프트 없이 기기 결박 사본(TPM·DPAPI)을 써도 된다. 기동·unlock-screen·Hello 확인으로 켜지고, 유휴·최대 시간으로 꺼진다.
 * - openedAt: silent가 켜진 시각(최대 열림 시간 기준).
 * - helloUntil: 엄격 모드에서 Hello 확인으로 열린 시간 끝.
 */
export class SessionLock {
  private readonly now: () => number;
  private readonly idleLockSec: number;
  private readonly unlockMaxSec: number;
  private readonly unlockTtlSec: number;
  private readonly idleStaleMs: number;
  private sessionOpen = true;
  private silent = true;
  private openedAt: number;
  private helloUntil = 0;
  private idle: { sec: number; at: number } | null = null;
  private lastReason: VaultLockReason = 'startup';
  strict = false;
  /** 잠기는 순간(열림 → 닫힘)마다 부른다. 금고는 메모리의 슬롯 KEK를 지운다. */
  onLock: (reason: VaultLockReason) => void = () => {};

  constructor(opts: SessionLockOptions = {}) {
    this.now = opts.now ?? Date.now;
    this.idleLockSec = opts.idleLockSec ?? VAULT_IDLE_LOCK_SEC;
    this.unlockMaxSec = opts.unlockMaxSec ?? VAULT_UNLOCK_MAX_SEC;
    this.unlockTtlSec = opts.unlockTtlSec ?? VAULT_UNLOCK_TTL_SEC;
    this.idleStaleMs = opts.idleStaleMs ?? SESSION_IDLE_STALE_MS;
    this.openedAt = this.now();
  }

  private wasOpen = false;

  /** 상태가 바뀔 수 있는 모든 입력 뒤에 부른다. 열림 → 닫힘이면 onLock. */
  private settle(): OpenVerdict {
    const v = this.evaluate();
    if (this.wasOpen && !v.open) this.onLock(v.reason);
    this.wasOpen = v.open;
    return v;
  }

  private evaluate(): OpenVerdict {
    const t = this.now();
    if (!this.sessionOpen) return { open: false, reason: 'session_locked', helloCanOpen: false };
    if (!this.idle || t - this.idle.at > this.idleStaleMs) return { open: false, reason: 'idle_unknown', helloCanOpen: false };
    // 보고 이후 흐른 시간도 유휴로 친다(보고 사이에 15분을 넘기면 다음 보고를 기다리지 않는다).
    const idleNow = this.idle.sec + (t - this.idle.at) / 1000;
    if (idleNow >= this.idleLockSec) {
      this.silent = false;
      this.helloUntil = 0;
      this.lastReason = 'idle';
      return { open: false, reason: 'idle', helloCanOpen: false };
    }
    if (this.strict) {
      if (this.helloUntil > t) return { open: true };
      return { open: false, reason: 'strict', helloCanOpen: true };
    }
    if (this.silent && t - this.openedAt >= this.unlockMaxSec * 1000) {
      this.silent = false;
      this.lastReason = 'max_open';
    }
    if (this.silent) return { open: true };
    return { open: false, reason: this.lastReason, helloCanOpen: true };
  }

  check(): OpenVerdict {
    return this.settle();
  }

  sessionEvent(kind: SessionEventKind): OpenVerdict {
    switch (kind) {
      case 'lock-screen':
      case 'suspend':
      case 'session-switch':
      case 'remote-switch':
        this.sessionOpen = false;
        this.silent = false;
        this.helloUntil = 0;
        this.lastReason = 'session_locked';
        break;
      case 'unlock-screen':
        // Windows 잠금 해제 = 사람 확인. 프롬프트 없이 다시 연다(유휴 잠금 뒤 포함). 엄격 모드는 여전히 발급마다 Hello.
        this.sessionOpen = true;
        this.silent = true;
        this.openedAt = this.now();
        // 잠금 해제 직후 유휴는 0이다(main의 다음 보고 전까지 오래된 보고로 다시 잠기지 않게).
        this.idle = { sec: 0, at: this.now() };
        break;
      case 'resume':
        // 절전에서 깨어나도 Windows 잠금 화면을 거치면 unlock-screen이 따로 온다. 여기서는 열지 않는다.
        break;
    }
    return this.settle();
  }

  reportIdle(idleSec: number): OpenVerdict {
    if (!Number.isFinite(idleSec) || idleSec < 0) return this.settle();
    // 보고가 끊긴 사이에 유휴 상한을 넘겼을 수 있다. 앞 보고에서 이어 센 유휴가 상한 이상이면 유휴 잠금으로 본다
    // (그사이 사용자가 있었는지 모르므로 fail-closed: 새 보고가 0이어도 프롬프트 없이 다시 열지 않는다).
    if (this.idle && this.idle.sec + (this.now() - this.idle.at) / 1000 >= this.idleLockSec) {
      this.silent = false;
      this.helloUntil = 0;
      this.lastReason = 'idle';
    }
    this.idle = { sec: idleSec, at: this.now() };
    return this.settle();
  }

  /** Hello 확인 성공(유휴 잠금 뒤·최대 시간 뒤·엄격 모드). 세션이 잠겼거나 유휴 중이면 열지 않는다. */
  helloConfirmed(): OpenVerdict {
    const v = this.evaluate();
    if (v.open || !v.helloCanOpen) return this.settle();
    if (this.strict) this.helloUntil = this.now() + this.unlockTtlSec * 1000;
    else {
      this.silent = true;
      this.openedAt = this.now();
    }
    return this.settle();
  }

  /** 엄격 모드: 실행이 끝나면 즉시 잠근다. */
  runEnded(): void {
    if (this.strict) this.helloUntil = 0;
    this.settle();
  }

  setStrict(on: boolean): void {
    this.strict = on;
    this.helloUntil = 0;
    this.settle();
  }
}
