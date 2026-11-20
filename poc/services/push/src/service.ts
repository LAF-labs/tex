import { fail, openAead, sealAead, type Sql } from '@sax/svc-shared';
import type { Platform, PushSender, WakeKind } from './senders.ts';

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

  async remove(deviceId: string): Promise<boolean> {
    return (await this.d.db.run('DELETE FROM push_tokens WHERE device_id = $1', [deviceId])) > 0;
  }

  async wake(deviceId: string, kind: WakeKind = 'update'): Promise<{ sent: boolean }> {
    const r = await this.d.db.one<{ platform: Platform; sealed_token: Buffer }>('SELECT platform, sealed_token FROM push_tokens WHERE device_id = $1', [deviceId]);
    if (!r) return fail('push.token_not_found');
    const tok = openAead(this.d.tokenKey, aad(deviceId, r.platform), r.sealed_token);
    if (!tok) {
      this.d.onEvent?.('push_token_unseal_failed');
      await this.remove(deviceId);
      return fail('push.token_not_found');
    }
    const res = await this.d.sender.send(r.platform, tok.toString('utf8'), kind);
    this.d.onEvent?.(`wake_${res}`);
    if (res === 'invalid') {
      await this.remove(deviceId);
      return fail('push.token_not_found');
    }
    return { sent: res === 'ok' };
  }
}
