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
  private held = false;
  strict = false;
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

  private settle(): OpenVerdict {
    const v = this.evaluate();
    if (this.wasOpen && !v.open) this.onLock(v.reason);
    this.wasOpen = v.open;
    return v;
  }

  private evaluate(): OpenVerdict {
    const t = this.now();
    if (this.held) return { open: false, reason: 'startup', helloCanOpen: false };
    if (!this.sessionOpen) return { open: false, reason: 'session_locked', helloCanOpen: false };
    if (!this.idle || t - this.idle.at > this.idleStaleMs) return { open: false, reason: 'idle_unknown', helloCanOpen: false };
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
        this.sessionOpen = true;
        this.silent = true;
        this.openedAt = this.now();
        this.idle = { sec: 0, at: this.now() };
        break;
      case 'resume':
        break;
    }
    return this.settle();
  }

  reportIdle(idleSec: number): OpenVerdict {
    if (!Number.isFinite(idleSec) || idleSec < 0) return this.settle();
    if (this.idle && this.idle.sec + (this.now() - this.idle.at) / 1000 >= this.idleLockSec) {
      this.silent = false;
      this.helloUntil = 0;
      this.lastReason = 'idle';
    } else if (this.idle && this.now() - this.idle.at > this.idleStaleMs) {
      this.silent = false;
      this.helloUntil = 0;
      this.lastReason = 'idle_unknown';
    }
    this.idle = { sec: idleSec, at: this.now() };
    return this.settle();
  }

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

  runEnded(): void {
    if (this.strict) this.helloUntil = 0;
    this.settle();
  }

  hold(): void {
    this.held = true;
    this.settle();
  }

  release(): void {
    this.held = false;
    this.settle();
  }

  setStrict(on: boolean): void {
    this.strict = on;
    this.helloUntil = 0;
    this.settle();
  }
}
