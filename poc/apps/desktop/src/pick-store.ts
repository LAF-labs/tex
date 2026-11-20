import { randomUUID } from 'node:crypto';

export const MAX_TRIES = 5;
export const PICK_TTL_MS = 300_000;
const MAX_PICKS = 2;

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

  keep(bytes: Uint8Array, now: number): string {
    this.sweep(now);
    while (this.picks.size >= MAX_PICKS) this.drop(this.picks.keys().next().value!);
    const id = randomUUID();
    this.picks.set(id, { bytes, at: now, wrong: 0 });
    return id;
  }

  retry(id: string, now: number): Uint8Array {
    this.sweep(now);
    const p = this.picks.get(id);
    if (!p) throw new Error('pick_expired');
    return Uint8Array.from(p.bytes);
  }

  wrong(id: string): boolean {
    const p = this.picks.get(id);
    if (!p) return false;
    p.wrong++;
    if (p.wrong < MAX_TRIES) return true;
    this.drop(id);
    return false;
  }

  cancel(id: unknown): void {
    if (typeof id === 'string') this.drop(id);
  }

  get size(): number {
    return this.picks.size;
  }
}
