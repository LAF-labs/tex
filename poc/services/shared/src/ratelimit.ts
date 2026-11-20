export class RateLimiter {
  private readonly windows = new Map<string, { start: number; n: number }>();
  private readonly now: () => number;
  private sweepAt = 0;
  constructor(now: () => number) {
    this.now = now;
  }

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
