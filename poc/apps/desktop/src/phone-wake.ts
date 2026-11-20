// 폰 깨우기(ADR-053 결정 2). main 전용. 폰 앱이 뒤에 있어 세션이 없을 때 내용 없는 알림으로 "앱을 열어 보라"고만 알린다.
// - 깨우기는 덤이다: 실패해도 게이트·진행 흐름을 막지 않고 던지지 않는다. 승인은 늘 세션이 붙은 뒤 gate.request로 한다(ADR-052).
// - 보내는 것은 폰 deviceId와 종류(approve·update)뿐이다. 거래처·금액·실행 번호는 이 경로에 없다.
// - 서버가 그 폰에 토큰이 없다고 답하면(push.token_not_found) 1시간 동안 그 폰을 다시 부르지 않는다. 한도(429)와 그 밖 오류는 조용히 넘긴다.
// - 로그는 결과 코드만(기기 ID 없음).

export type WakeKind = 'approve' | 'update';

/** 토큰이 없다는 답을 받은 폰을 다시 부르지 않는 시간 */
export const WAKE_NO_TOKEN_MS = 60 * 60_000;
/** 승인 게이트를 연 뒤 세션이 안 붙으면 한 번 더 깨우는 때(게이트당 최대 2번) */
export const WAKE_APPROVE_AGAIN_MS = 60_000;
/** 승인 요청을 보낸 세션이 답 없이 닫힌 뒤 깨우기까지 기다리는 때(바로 다시 붙는 경우를 거른다) */
export const WAKE_DETACHED_MS = 5_000;

interface PhoneWakerPorts {
  /** 연결 기록의 그 폰 서버 deviceId. 끊은 폰이면 null. */
  deviceOf: (pairId: string) => string | null;
  /** POST /v1/wake(기기 토큰 wake 범위). 서버 오류는 code를 가진 Error로 던진다. 클라우드 연결이 없으면 null을 넘긴다. */
  call: ((deviceId: string, kind: WakeKind) => Promise<{ sent: boolean }>) | null;
  now?: () => number;
  log?: (name: string, data: Record<string, string | number | boolean>) => void;
}

const codeOf = (e: unknown): string => {
  const c = (e as { code?: unknown } | null)?.code;
  return typeof c === 'string' ? c : 'error';
};

export class PhoneWaker {
  readonly #o: PhoneWakerPorts;
  /** deviceId → 이때까지 부르지 않는다 */
  readonly #quiet = new Map<string, number>();
  constructor(o: PhoneWakerPorts) {
    this.#o = o;
  }
  #now(): number {
    return (this.#o.now ?? Date.now)();
  }
  #log(kind: WakeKind, result: string): void {
    this.#o.log?.('main.phone_wake', { kind, result });
  }

  /** 기다리지 않아도 된다(돌려주는 약속은 시험용). 결과: sent·not_sent·no_token·quiet·limited·no_phone·no_cloud·error 코드 */
  wake(pairId: string, kind: WakeKind): Promise<string> {
    return this.#wake(pairId, kind).then(
      (r) => (this.#log(kind, r), r),
      () => (this.#log(kind, 'error'), 'error'),
    );
  }

  async #wake(pairId: string, kind: WakeKind): Promise<string> {
    const call = this.#o.call;
    if (!call) return 'no_cloud';
    const dev = this.#o.deviceOf(pairId);
    if (!dev) return 'no_phone';
    const until = this.#quiet.get(dev);
    if (until !== undefined) {
      if (this.#now() < until) return 'quiet';
      this.#quiet.delete(dev);
    }
    try {
      return (await call(dev, kind)).sent ? 'sent' : 'not_sent';
    } catch (e) {
      const c = codeOf(e);
      if (c === 'push.token_not_found' || c === 'push.target_not_found') {
        this.#quiet.set(dev, this.#now() + WAKE_NO_TOKEN_MS);
        return 'no_token';
      }
      if (c === 'policy.rate_limited') return 'limited';
      return /^[a-z_]+\.[a-z_]+$/.test(c) ? c : 'error';
    }
  }

  /** 폰이 새 토큰을 올렸을 수 있다(세션이 붙었다): 조용히 하던 것을 푼다. */
  forget(pairId: string): void {
    const dev = this.#o.deviceOf(pairId);
    if (dev) this.#quiet.delete(dev);
  }
}
