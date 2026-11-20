import { decodeEnvelope, encodeEnvelope, makeEnvelope, type Bodies, type Envelope, type KnownType, type Role } from './envelope.ts';
import type { Transport } from './frame.ts';
import { attachQueue, nextFrame, type Link } from './relay.ts';

/** 시계 차이 허용(앞으로). */
export const CLOCK_SKEW_MS = 5 * 60_000;
const SEEN_MAX = 4096;

export interface ChannelOptions {
  pairId?: string;
  me: Role;
  now?: () => number;
}

export class Channel {
  #pairId: string | null;
  readonly me: Role;
  readonly peer: Role;
  #link: Link;
  #tx: Transport;
  #seq = 0;
  #seen = new Set<string>();
  #now: () => number;
  dropped = 0;

  constructor(link: Link, tx: Transport, o: ChannelOptions) {
    this.#link = link;
    this.#tx = tx;
    this.#pairId = o.pairId ?? null;
    this.me = o.me;
    this.peer = o.me === 'desktop' ? 'mobile' : 'desktop';
    this.#now = o.now ?? Date.now;
    attachQueue(link);
  }

  get pairId(): string {
    if (!this.#pairId) throw new Error('channel: pairId not set yet');
    return this.#pairId;
  }

  get closed(): boolean {
    return this.#link.closed;
  }

  send<T extends KnownType>(type: T, body: Bodies[T], opts: { ttl?: number; replyTo?: string } = {}): Envelope<T> {
    const e = makeEnvelope(type, body, { pairId: this.pairId, from: this.me, seq: this.#seq++, now: this.#now(), ...opts });
    this.#link.send(this.#tx.seal(encodeEnvelope(e)));
    return e;
  }

  sendRaw(e: Envelope): void {
    this.#link.send(this.#tx.seal(encodeEnvelope(e)));
  }

  async recv(timeoutMs: number): Promise<Envelope | null> {
    const deadline = this.#now() + timeoutMs;
    for (;;) {
      const left = deadline - this.#now();
      if (left <= 0) return null;
      const f = await nextFrame(this.#link, left);
      if (!f) return null;
      const e = this.accept(f);
      if (e) return e;
    }
  }

  accept(frame: Uint8Array): Envelope | null {
    const inner = this.#tx.open(frame);
    const e = inner ? decodeEnvelope(inner) : null;
    const now = this.#now();
    if (
      !e ||
      (this.#pairId !== null && e.pairId !== this.#pairId) ||
      e.from !== this.peer ||
      e.to !== this.me ||
      e.ts + e.ttl * 1000 < now ||
      e.ts > now + CLOCK_SKEW_MS ||
      this.#seen.has(e.id)
    ) {
      this.dropped++;
      return null;
    }
    if (this.#pairId === null) this.#pairId = e.pairId;
    this.#seen.add(e.id);
    if (this.#seen.size > SEEN_MAX) this.#seen.delete(this.#seen.values().next().value!);
    return e;
  }

  close(): void {
    try {
      if (!this.#link.closed) this.send('close', {});
    } catch {
      // 닫는 중 실패는 무시한다
    }
    this.#tx.destroy();
    this.#link.close();
  }
}
