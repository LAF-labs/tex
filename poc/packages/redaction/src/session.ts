// D06 §8 대화 세션 토큰 맵 범위(B-19): chatSessionId별 Redactor. 프로필을 전환하거나 15분 무활동이면 맵을 폐기한다.
// 개인·사업자 프로필 사이에 토큰이 이어지지 않는다. 대화에서 실행으로 넘어갈 때는 레코드 ID만 넘기고 맵은 넘기지 않는다.
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
  /** 폐기 사유 카운트만(본문 없음). */
  readonly discarded: { idle: number; profile_switch: number; ended: number } = { idle: 0, profile_switch: 0, ended: 0 };

  constructor(now: () => number = Date.now) {
    this.now = now;
  }

  /** 세션의 Redactor. 무활동 15분이 지났거나 프로필이 바뀌었으면 맵을 비우고 새로 만든다. */
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

  /** 주기 정리: 무활동 맵 폐기. */
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
