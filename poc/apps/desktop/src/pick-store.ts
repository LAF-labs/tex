// 암호 걸린 PDF를 다시 고르지 않게 고른 파일 바이트를 잠시 든다(ADR-026 결정 8, N-31). Electron 없이 시험한다.
// 만료는 첫 선택 시각 기준(재시도로 늘지 않음), 틀린 암호 5회면 닫는다. 지울 때 바이트를 0으로 덮는다. 경로는 들지 않는다.
import { randomUUID } from 'node:crypto';

export const MAX_TRIES = 5;
export const PICK_TTL_MS = 300_000;
export const MAX_PICKS = 2;

interface Pick {
  bytes: Uint8Array;
  at: number;
  wrong: number;
}

export class PickStore {
  private readonly picks = new Map<string, Pick>();

  private drop(id: string): void {
    const p = this.picks.get(id);
    if (!p) return;
    p.bytes.fill(0);
    this.picks.delete(id);
  }

  private sweep(now: number): void {
    for (const [k, v] of this.picks) if (now - v.at > PICK_TTL_MS) this.drop(k);
  }

  /** 새로 고른 파일. 가장 오래된 것부터 밀어낸다(최대 MAX_PICKS건). */
  keep(bytes: Uint8Array, now: number): string {
    this.sweep(now);
    while (this.picks.size >= MAX_PICKS) this.drop(this.picks.keys().next().value!);
    const id = randomUUID();
    this.picks.set(id, { bytes, at: now, wrong: 0 });
    return id;
  }

  /** 다시 시도할 바이트. 항목은 남긴다(만료는 첫 선택 기준). 없거나 지났으면 pick_expired. */
  retry(id: string, now: number): Uint8Array {
    this.sweep(now);
    const p = this.picks.get(id);
    if (!p) throw new Error('pick_expired');
    return p.bytes;
  }

  /** 틀린 암호 한 번. MAX_TRIES번째면 닫고 false. */
  wrong(id: string): boolean {
    const p = this.picks.get(id);
    if (!p) return false;
    p.wrong++;
    if (p.wrong < MAX_TRIES) return true;
    this.drop(id);
    return false;
  }

  /** 끝났거나(가져옴·다른 오류) 사용자가 그만둠. */
  cancel(id: unknown): void {
    if (typeof id === 'string') this.drop(id);
  }

  get size(): number {
    return this.picks.size;
  }
}
