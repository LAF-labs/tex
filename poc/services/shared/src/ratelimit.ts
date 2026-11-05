// 고정 창 메모리 카운터. 키는 이미 HMAC된 값만 넣는다(평문 IP·이메일 금지). 인스턴스 단위 한도다.
export class RateLimiter {
  private readonly windows = new Map<string, { start: number; n: number }>();
  private readonly now: () => number;
  private sweepAt = 0;
  constructor(now: () => number) {
    this.now = now;
  }

  /** 허용되면 카운트를 올리고 true. 넘으면 올리지 않고 false. */
  hit(key: string, limit: number, windowMs: number): boolean {
    const now = this.now();
    if (now >= this.sweepAt) this.sweep(now);
    const k = `${windowMs}|${key}`;
    const w = this.windows.get(k);
    if (!w || now - w.start >= windowMs) {
      this.windows.set(k, { start: now, n: 1 });
      return limit >= 1;
    }
    if (w.n >= limit) return false;
    w.n++;
    return true;
  }

  /** 남은 창 시간(초, 올림). Retry-After용. */
  retryAfter(key: string, windowMs: number): number {
    const w = this.windows.get(`${windowMs}|${key}`);
    return w ? Math.max(1, Math.ceil((w.start + windowMs - this.now()) / 1000)) : 1;
  }

  private sweep(now: number): void {
    for (const [k, w] of this.windows) {
      const ms = Number(k.slice(0, k.indexOf('|')));
      if (now - w.start >= ms) this.windows.delete(k);
    }
    this.sweepAt = now + 60_000;
  }
}
