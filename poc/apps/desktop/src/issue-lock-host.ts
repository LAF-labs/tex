// 발급 잠금(ADR-048 결정 7): 계정에 PC가 2대 이상이면 홈택스 발급에는 계정의 발급 잠금을 잡은 PC만 들어간다.
// main이 엔진 auth 포트의 요청에 답한다. 기기 토큰과 잠금 값은 엔진에 가지 않는다.
// - 엔진이 보내는 것: {t:'lock.acquire', id}(게이트 앞, 기준선 조회 전), {t:'lock.renew', id}(커밋 직전), {t:'lock.release'}(쉬거나 끝날 때. 답 없음).
// - main이 답하는 것: {t:'lock.result', id, ok:true, held} 또는 {t:'lock.result', id, ok:false, code}.
//   held가 false면 잠금이 필요 없는 PC다(이 PC의 기기 목록에 PC가 한 대뿐이거나 계정 연결이 없다).
// - 코드: issue.locked_elsewhere(다른 PC가 잡고 있다), issue.lock_unavailable(서버에 닿지 못했다), issue.lock_lost(커밋 직전에 잠금이 없다).
//   어느 것이든 엔진은 승인 카드를 열지 않거나 누르지 않는다(fail closed). PC 한 대 계정은 서버를 부르지 않는다.
// - 잡고 있는 동안 30초마다 갱신한다. 20분이 넘으면 더 갱신하지 않는다(멈춘 실행이 다른 PC를 계속 막지 않게. 서버 잠금은 90초 뒤 풀린다).
//   커밋 직전의 갱신은 늘 서버에 묻는다: 만료됐거나 넘어갔으면 실패하고 엔진은 누르지 않는다.
// - 잠금 값·토큰은 기록하지 않는다. 이벤트는 이름과 결과 코드만.
import type { DeviceListJson } from '@sax/remote';
import type { AccountClient, DeviceAuth } from './remote-ports.ts';

export type IssueLockRequest = { t: 'lock.acquire'; id: number } | { t: 'lock.renew'; id: number } | { t: 'lock.release' };
export type IssueLockCode = 'issue.locked_elsewhere' | 'issue.lock_unavailable' | 'issue.lock_lost';
export type IssueLockResult = { t: 'lock.result'; id: number; ok: true; held: boolean } | { t: 'lock.result'; id: number; ok: false; code: IssueLockCode };

/** 잡고 있는 동안의 갱신 간격(서버 만료 90초). */
export const ISSUE_LOCK_RENEW_MS = 30_000;
/** 이보다 오래 잡고 있으면 더 갱신하지 않는다(승인 대기 10분 + 커밋·확인 5분 + 여유). */
export const ISSUE_LOCK_MAX_HOLD_MS = 20 * 60_000;

const ID_MAX = 2 ** 31;

/** DeviceSession 중 이 모듈이 쓰는 부분. */
export interface IssueLockDevice {
  readonly deviceId: string;
  readonly deviceList: DeviceListJson;
  auth: DeviceAuth;
  clearToken(): void;
}

export interface IssueLockTimers {
  every(ms: number, fn: () => void): () => void;
}
const systemTimers: IssueLockTimers = {
  every(ms, fn) {
    const t = setInterval(fn, ms);
    t.unref?.();
    return () => clearInterval(t);
  },
};

export interface IssueLockHostOptions {
  /** 계정 클라이언트. 없으면(클라우드 연결 없는 실행) 잠금이 필요 없다. */
  client: Pick<AccountClient, 'acquireIssueLock' | 'renewIssueLock' | 'releaseIssueLock'> | null;
  /** 로그인(기기 등록)을 마쳤으면 기기 세션, 아니면 null(잠금이 필요 없다). 던지면 issue.lock_unavailable. */
  device: () => IssueLockDevice | null | Promise<IssueLockDevice | null>;
  log?: (name: string, data: Record<string, string | number | boolean>) => void;
  now?: () => number;
  timers?: IssueLockTimers;
  /** 다른 PC가 잡고 있어 기다리기 시작했거나(true) 끝났을 때(false). 화면 안내용 */
  onBlocked?: (blocked: boolean) => void;
}

/** 이 PC의 기기 목록에 폐기되지 않은 PC가 2대 이상인가(ADR-048 결정 7 "부르는 PC"). 목록의 항목은 폐기되지 않은 기기뿐이다. */
export function issueLockNeeded(list: DeviceListJson): boolean {
  return list.entries.filter((e) => e.entry.role === 'desktop').length >= 2;
}

const codeOf = (e: unknown): string | null => {
  const c = (e as { code?: unknown } | null)?.code;
  return typeof c === 'string' ? c : null;
};

export class IssueLockHost {
  readonly #o: IssueLockHostOptions;
  readonly #now: () => number;
  readonly #timers: IssueLockTimers;
  #lockId: string | null = null;
  #heldAt = 0;
  #stopRenew: (() => void) | null = null;
  #blocked = false;
  /** 요청을 받은 순서대로 하나씩(잡기와 놓기가 겹치지 않게). */
  #chain: Promise<unknown> = Promise.resolve();

  constructor(o: IssueLockHostOptions) {
    this.#o = o;
    this.#now = o.now ?? Date.now;
    this.#timers = o.timers ?? systemTimers;
  }

  /** 지금 이 PC가 잠금을 잡고 있나(화면·시험용). */
  get held(): boolean {
    return this.#lockId !== null;
  }

  /** 포트 메시지 하나를 처리한다. 답할 것이 없으면 null(release·모르는 메시지). */
  handle(raw: unknown): Promise<IssueLockResult | null> {
    const p = this.#chain.then(() => this.#one(raw));
    this.#chain = p.catch(() => {});
    return p;
  }

  /** 엔진이 끝났을 때 main이 부른다(엔진이 release를 못 보냈을 수 있다). */
  release(): Promise<void> {
    const p = this.#chain.then(() => this.#release());
    this.#chain = p.catch(() => {});
    return p;
  }

  async #one(raw: unknown): Promise<IssueLockResult | null> {
    const m = raw as Partial<{ t: unknown; id: unknown }> | null;
    if (!m || typeof m !== 'object') return null;
    if (m.t === 'lock.release') {
      await this.#release();
      return null;
    }
    if (m.t !== 'lock.acquire' && m.t !== 'lock.renew') return null;
    const id = m.id;
    if (typeof id !== 'number' || !Number.isSafeInteger(id) || id < 0 || id >= ID_MAX) return null;
    const r = m.t === 'lock.acquire' ? await this.#acquire() : await this.#renewForCommit();
    this.#o.log?.('main.issue_lock', { op: m.t === 'lock.acquire' ? 'acquire' : 'renew', result: r === true ? 'held' : r === false ? 'not_needed' : r });
    return typeof r === 'boolean' ? { t: 'lock.result', id, ok: true, held: r } : { t: 'lock.result', id, ok: false, code: r };
  }

  /** null이면 잠금이 필요 없는 PC다. */
  async #need(): Promise<{ client: NonNullable<IssueLockHostOptions['client']>; dev: IssueLockDevice } | null | 'unavailable'> {
    const client = this.#o.client;
    if (!client) return null;
    let dev: IssueLockDevice | null;
    try {
      dev = await this.#o.device();
    } catch {
      return 'unavailable';
    }
    if (!dev || !issueLockNeeded(dev.deviceList)) return null;
    return { client, dev };
  }

  async #call<T>(dev: IssueLockDevice, f: (auth: DeviceAuth) => Promise<T>): Promise<T> {
    try {
      return await f(dev.auth);
    } catch (e) {
      if (codeOf(e) !== 'account.unauthorized') throw e;
      dev.clearToken();
      return f(dev.auth);
    }
  }

  async #acquire(): Promise<boolean | IssueLockCode> {
    const n = await this.#need();
    if (n === 'unavailable') return 'issue.lock_unavailable';
    if (!n) {
      // PC가 한 대로 줄었다(다른 PC를 끊었다): 들고 있던 잠금은 놓는다
      await this.#release();
      return false;
    }
    try {
      // 이미 잡고 있어도 다시 잡는다(서버가 새 값을 주고 앞 값은 죽는다). 20분 상한도 여기서 새로 센다
      const r = await this.#call(n.dev, (auth) => n.client.acquireIssueLock(auth));
      this.#lockId = r.lockId;
      this.#heldAt = this.#now();
      this.#setBlocked(false);
      this.#startRenew();
      return true;
    } catch (e) {
      if (codeOf(e) === 'account.issue_locked') {
        this.#forget();
        this.#setBlocked(true);
        return 'issue.locked_elsewhere';
      }
      // 앞서 잡은 값이 있으면 그대로 둔다(서버에 살아 있을 수 있다. 커밋 직전 갱신이 가린다)
      return 'issue.lock_unavailable';
    }
  }

  /** 커밋 직전: 서버가 갱신을 받아 줘야 true. 잠금이 필요 없는 PC는 false(held 아님)로 통과한다. */
  async #renewForCommit(): Promise<boolean | IssueLockCode> {
    const n = await this.#need();
    if (n === 'unavailable') return 'issue.lock_unavailable';
    if (!n) return false;
    // 게이트 앞에서는 PC가 한 대였는데 승인을 기다리는 사이 두 대가 됐으면 잠금 없이 왔다: 누르지 않는다(다시 게이트 앞부터)
    const lockId = this.#lockId;
    if (!lockId) return 'issue.lock_lost';
    try {
      await this.#call(n.dev, (auth) => n.client.renewIssueLock(auth, lockId));
      return true;
    } catch (e) {
      if (codeOf(e) === 'account.issue_lock_lost') {
        this.#forget();
        return 'issue.lock_lost';
      }
      return 'issue.lock_unavailable';
    }
  }

  #startRenew(): void {
    this.#stopRenew?.();
    this.#stopRenew = this.#timers.every(ISSUE_LOCK_RENEW_MS, () => void this.#tick());
  }

  /** 30초마다. 놓기·잡기와 줄을 서지 않는다(값이 그 사이 바뀌었으면 결과를 버린다). */
  async #tick(): Promise<void> {
    const lockId = this.#lockId;
    if (!lockId) return;
    if (this.#now() - this.#heldAt > ISSUE_LOCK_MAX_HOLD_MS) {
      // 더 갱신하지 않는다. 서버 잠금은 90초 안에 풀리고, 커밋 직전 갱신이 그것을 본다
      this.#stopRenew?.();
      this.#stopRenew = null;
      this.#o.log?.('main.issue_lock', { op: 'hold', result: 'max_hold' });
      return;
    }
    try {
      const n = await this.#need();
      if (!n || n === 'unavailable') return;
      await this.#call(n.dev, (auth) => n.client.renewIssueLock(auth, lockId));
    } catch (e) {
      if (codeOf(e) === 'account.issue_lock_lost' && this.#lockId === lockId) {
        this.#forget();
        this.#o.log?.('main.issue_lock', { op: 'hold', result: 'issue.lock_lost' });
      }
    }
  }

  #forget(): void {
    this.#lockId = null;
    this.#stopRenew?.();
    this.#stopRenew = null;
  }

  #setBlocked(b: boolean): void {
    if (this.#blocked === b) return;
    this.#blocked = b;
    this.#o.onBlocked?.(b);
  }

  async #release(): Promise<void> {
    this.#setBlocked(false);
    const lockId = this.#lockId;
    this.#forget();
    if (!lockId || !this.#o.client) return;
    const client = this.#o.client;
    try {
      const dev = await this.#o.device();
      if (dev) await this.#call(dev, (auth) => client.releaseIssueLock(auth, lockId));
      this.#o.log?.('main.issue_lock', { op: 'release', result: dev ? 'ok' : 'signed_out' });
    } catch {
      // 못 놓아도 서버 잠금은 90초 뒤 풀린다
      this.#o.log?.('main.issue_lock', { op: 'release', result: 'failed' });
    }
  }
}

/**
 * auth 포트의 lock.* 메시지를 받는 쪽(EngineHost가 쓴다). 답하는 쪽이 아직 없으면 잠금을 확인할 수 없으니 issue.lock_unavailable.
 * gw.auth 줄과 따로 선다(잠금 호출이 게이트웨이 인증을 막지 않게).
 */
export function issueLockResponder(handler: () => ((m: unknown) => Promise<IssueLockResult | null>) | null, post: (r: IssueLockResult) => void): (m: unknown) => void {
  return (m) => {
    const req = m as { t?: unknown; id?: unknown } | null;
    const id = (req?.t === 'lock.acquire' || req?.t === 'lock.renew') && typeof req.id === 'number' && Number.isSafeInteger(req.id) ? req.id : null;
    const h = handler();
    const fail = (): void => {
      if (id !== null) post({ t: 'lock.result', id, ok: false, code: 'issue.lock_unavailable' });
    };
    if (!h) return fail();
    h(m).then((r) => void (r && post(r)), fail);
  };
}

/** auth 포트 메시지가 발급 잠금 것인가. */
export const isIssueLockMessage = (m: unknown): boolean => {
  const t = (m as { t?: unknown } | null)?.t;
  return t === 'lock.acquire' || t === 'lock.renew' || t === 'lock.release';
};
