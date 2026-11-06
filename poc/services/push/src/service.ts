// 푸시 디스패처: device_id → 봉인된 푸시 토큰(PUSH_TOKEN_KEY, AES-256-GCM, aad = 기기·플랫폼). 우편함 ID는 이 경로에 없다(D08 §8.1).
import { fail, openAead, sealAead, type Sql } from '@sax/svc-shared';
import type { Platform, PushSender } from './senders.ts';

export const PUSH = {
  wakePerMinute: 3,
  wakePerHour: 20,
} as const;

export interface PushDeps {
  db: Sql;
  tokenKey: Buffer;
  sender: PushSender;
  now: () => number;
  onEvent?: (e: string) => void;
}

const aad = (deviceId: string, platform: string) => `SAX-push-v1|${deviceId}|${platform}`;

export class PushService {
  readonly now: () => number;
  private readonly d: PushDeps;
  constructor(d: PushDeps) {
    this.d = d;
    this.now = d.now;
  }

  async register(deviceId: string, platform: Platform, token: string): Promise<void> {
    const sealed = sealAead(this.d.tokenKey, aad(deviceId, platform), Buffer.from(token, 'utf8'));
    await this.d.db.run('INSERT INTO push_tokens (device_id, platform, sealed_token) VALUES ($1, $2, $3) ON CONFLICT (device_id) DO UPDATE SET platform = excluded.platform, sealed_token = excluded.sealed_token', [deviceId, platform, sealed]);
  }

  /** 기기 폐기·긴급 정지·앱의 해제: 즉시 삭제(D08 §8.1) */
  async remove(deviceId: string): Promise<boolean> {
    return (await this.d.db.run('DELETE FROM push_tokens WHERE device_id = $1', [deviceId])) > 0;
  }

  /** 내용 없는 깨우기. 공급사가 토큰 무효를 알리면 저장 토큰을 지운다. */
  async wake(deviceId: string): Promise<{ sent: boolean }> {
    const r = await this.d.db.one<{ platform: Platform; sealed_token: Buffer }>('SELECT platform, sealed_token FROM push_tokens WHERE device_id = $1', [deviceId]);
    if (!r) return fail('push.token_not_found');
    const tok = openAead(this.d.tokenKey, aad(deviceId, r.platform), r.sealed_token);
    if (!tok) {
      this.d.onEvent?.('push_token_unseal_failed');
      await this.remove(deviceId);
      return fail('push.token_not_found');
    }
    const res = await this.d.sender.send(r.platform, tok.toString('utf8'));
    this.d.onEvent?.(`wake_${res}`);
    if (res === 'invalid') {
      await this.remove(deviceId);
      return fail('push.token_not_found');
    }
    return { sent: res === 'ok' };
  }
}
