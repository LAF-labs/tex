// 발급 잠금(ADR-048 결정 7): 계정에 PC가 2대 이상이면 계정의 발급 잠금을 잡은 PC만 홈택스 발급에 들어간다.
// 엔진은 main auth 포트로 묻기만 한다. 기기 토큰·잠금 값은 엔진에 오지 않는다(main issue-lock-host.ts가 계정 서비스를 부른다).
// - 보내는 것: {t:'lock.acquire', id}(게이트 앞, 기준선 조회 전), {t:'lock.renew', id}(커밋 직전), {t:'lock.release'}(쉬거나 끝날 때).
// - 받는 것: {t:'lock.result', id, ok:true, held} 또는 {t:'lock.result', id, ok:false, code}.
// - 실패(다른 PC가 잡고 있음·서버에 못 닿음·모양 틀림·시간 초과)는 모두 "열지 않는다·누르지 않는다"다(fail closed).
//   잠금이 필요 없는 PC(PC 한 대 계정)는 main이 서버를 부르지 않고 ok(held:false)로 답한다.
import type { PortLike } from '@sax/platform';
import type { ActResult } from './core/page.ts';

/** main 응답 상한. main은 계정 서비스 한 번(401이면 토큰을 다시 받아 한 번 더)을 부른다. */
const ISSUE_LOCK_TIMEOUT_MS = 20_000;
/** 다른 PC가 잡고 있을 때 다시 잡아 보는 간격과 상한(ADR-048 결정 7: 10분까지 스스로 다시 잡아 본다). */
export const ISSUE_LOCK_RETRY_MS = 5_000;
export const ISSUE_LOCK_WAIT_MS = 600_000;

/** 다른 PC가 발급 중이다(끝나면 이어서 한다). */
export const ISSUE_LOCKED_ELSEWHERE = 'issue.locked_elsewhere';
/** 다른 PC와 겹치는지 확인하지 못했다(잠금 서버·main에 닿지 못함). */
const ISSUE_LOCK_UNAVAILABLE = 'issue.lock_unavailable';
/** 커밋 직전에 잠금이 없다(만료됐거나 다른 PC로 넘어갔다). 누르지 않았다. */
export const ISSUE_LOCK_LOST = 'issue.lock_lost';
const CODES: ReadonlySet<string> = new Set([ISSUE_LOCKED_ELSEWHERE, ISSUE_LOCK_UNAVAILABLE, ISSUE_LOCK_LOST]);

const ID_MAX = 2 ** 31 - 1;

export interface IssueLockPort {
  /** 게이트 앞에서 한 번 잡아 본다. ok면 잡았거나 필요 없다. */
  acquire(): Promise<ActResult>;
  /** 커밋 직전. ok가 아니면 누르지 않는다. */
  renew(): Promise<ActResult>;
  /** 쉬거나 끝날 때. 답을 기다리지 않는다. */
  release(): void;
  /** 기다리는 요청을 모두 실패로 끝낸다(포트가 닫힐 때). */
  close(): void;
}

export function portIssueLock(port: PortLike, o: { timeoutMs?: number } = {}): IssueLockPort {
  const timeoutMs = o.timeoutMs ?? ISSUE_LOCK_TIMEOUT_MS;
  const pending = new Map<number, { done: (r: ActResult) => void; timer: ReturnType<typeof setTimeout> }>();
  let next = 1;
  let closed = false;
  const unavailable: ActResult = { ok: false, code: ISSUE_LOCK_UNAVAILABLE };
  port.onMessage((raw) => {
    const m = raw as { t?: unknown; id?: unknown; ok?: unknown; held?: unknown; code?: unknown } | null;
    if (!m || typeof m !== 'object' || m.t !== 'lock.result' || typeof m.id !== 'number') return;
    const p = pending.get(m.id);
    if (!p) return; // 늦은 답(시간 초과 뒤)·모르는 id는 버린다
    pending.delete(m.id);
    clearTimeout(p.timer);
    if (m.ok === true && typeof m.held === 'boolean') p.done({ ok: true });
    else if (m.ok === false && typeof m.code === 'string' && CODES.has(m.code)) p.done({ ok: false, code: m.code });
    else p.done(unavailable);
  });
  const ask = (t: 'lock.acquire' | 'lock.renew'): Promise<ActResult> => {
    if (closed) return Promise.resolve(unavailable);
    const id = next;
    next = next >= ID_MAX ? 1 : next + 1;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        resolve(unavailable);
      }, timeoutMs);
      timer.unref?.();
      pending.set(id, { done: resolve, timer });
      port.postMessage({ t, id });
    });
  };
  return {
    acquire: () => ask('lock.acquire'),
    renew: () => ask('lock.renew'),
    release() {
      if (!closed) port.postMessage({ t: 'lock.release' });
    },
    close() {
      closed = true;
      for (const p of pending.values()) {
        clearTimeout(p.timer);
        p.done(unavailable);
      }
      pending.clear();
    },
  };
}
