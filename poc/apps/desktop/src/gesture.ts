// 사용자 동작 결속(ADR-027 결정 8, N-27). main이 메인 창에서 직접 본 실제 입력 시각으로 렌더러 명령을 거른다. Electron 없이 시험한다.

/** 마지막 실제 입력(mouseUp, 수식키 없는 Enter·Space) 시각. 시각은 단조 시계(performance.now) 값이다. */
export class GestureClock {
  private last = Number.NEGATIVE_INFINITY;

  note(now: number): void {
    this.last = now;
  }

  /** 마지막 입력이 ms 안에 있었는가. */
  within(now: number, ms: number): boolean {
    return now >= this.last && now - this.last <= ms;
  }
}

/** windowMs 동안 max번까지만 허용한다(사람 속도 상한). */
export class RateWindow {
  private readonly max: number;
  private readonly windowMs: number;
  private readonly hits: number[] = [];

  constructor(max: number, windowMs: number) {
    this.max = max;
    this.windowMs = windowMs;
  }

  /** 허용하면 세고 true. 넘치면 세지 않고 false. */
  take(now: number): boolean {
    while (this.hits.length && now - this.hits[0]! >= this.windowMs) this.hits.shift();
    if (this.hits.length >= this.max) return false;
    this.hits.push(now);
    return true;
  }
}

/** 실제 입력으로 칠 키: 수식키 없는 Enter·Space의 keyDown. */
export function isGestureKey(i: { type: string; key: string; alt?: boolean; control?: boolean; meta?: boolean; shift?: boolean }): boolean {
  return i.type === 'keyDown' && (i.key === 'Enter' || i.key === ' ') && !i.alt && !i.control && !i.meta && !i.shift;
}
