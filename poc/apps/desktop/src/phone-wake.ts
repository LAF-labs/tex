
export type WakeKind = 'approve' | 'update';

export const WAKE_NO_TOKEN_MS = 60 * 60_000;
export const WAKE_APPROVE_AGAIN_MS = 60_000;
export const WAKE_DETACHED_MS = 5_000;

interface PhoneWakerPorts {
  deviceOf: (pairId: string) => string | null;
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

  forget(pairId: string): void {
    const dev = this.#o.deviceOf(pairId);
    if (dev) this.#quiet.delete(dev);
  }
}
