import { Redactor, type RedactorOptions } from './apply.ts';

export const CHAT_MAP_IDLE_MS = 15 * 60 * 1000;

interface Entry {
  redactor: Redactor;
  profileId: string;
  lastActive: number;
}

export class ChatTokenMaps {
  private readonly items = new Map<string, Entry>();
  private readonly now: () => number;
  readonly discarded: { idle: number; profile_switch: number; ended: number } = { idle: 0, profile_switch: 0, ended: 0 };

  constructor(now: () => number = Date.now) {
    this.now = now;
  }

  get(chatSessionId: string, profileId: string, opts: RedactorOptions = {}): Redactor {
    const t = this.now();
    const cur = this.items.get(chatSessionId);
    if (cur) {
      const reason = cur.profileId !== profileId ? 'profile_switch' : t - cur.lastActive > CHAT_MAP_IDLE_MS ? 'idle' : null;
      if (!reason) {
        cur.lastActive = t;
        return cur.redactor;
      }
      cur.redactor.map.clear();
      this.discarded[reason]++;
    }
    const redactor = new Redactor({ chatSessionId }, opts);
    this.items.set(chatSessionId, { redactor, profileId, lastActive: t });
    return redactor;
  }

  end(chatSessionId: string): void {
    const cur = this.items.get(chatSessionId);
    if (!cur) return;
    cur.redactor.map.clear();
    this.items.delete(chatSessionId);
    this.discarded.ended++;
  }

  sweep(): void {
    const t = this.now();
    for (const [id, e] of this.items) if (t - e.lastActive > CHAT_MAP_IDLE_MS) {
      e.redactor.map.clear();
      this.items.delete(id);
      this.discarded.idle++;
    }
  }

  get size(): number {
    return this.items.size;
  }
}
