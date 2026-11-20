export class GestureClock {
  private last = Number.NEGATIVE_INFINITY;

  note(now: number): void {
    this.last = now;
  }

  within(now: number, ms: number): boolean {
    return now >= this.last && now - this.last <= ms;
  }
}

export class RateWindow {
  private readonly max: number;
  private readonly windowMs: number;
  private readonly hits: number[] = [];

  constructor(max: number, windowMs: number) {
    this.max = max;
    this.windowMs = windowMs;
  }

  take(now: number): boolean {
    while (this.hits.length && now - this.hits[0]! >= this.windowMs) this.hits.shift();
    if (this.hits.length >= this.max) return false;
    this.hits.push(now);
    return true;
  }

  waitMs(now: number): number {
    const live = this.hits.filter((t) => now - t < this.windowMs);
    return live.length < this.max ? 0 : Math.max(0, this.windowMs - (now - live[0]!));
  }
}

export function isTypingKey(i: { type: string }): boolean {
  return i.type === 'keyDown';
}

export function isGestureKey(i: { type: string; key: string; alt?: boolean; control?: boolean; meta?: boolean; shift?: boolean }): boolean {
  return i.type === 'keyDown' && (i.key === 'Enter' || i.key === ' ') && !i.alt && !i.control && !i.meta && !i.shift;
}
