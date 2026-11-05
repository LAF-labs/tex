// PC 연결(D08 §5): 우편함 라이브 연결 → Noise_IK 세션 → hello → 보관함 비우기. PC가 꺼져 있거나 이 폰을 거부하면
// 구분 없이 'offline'이다(PC는 무응답으로 거부한다). 보낸 뒤에는 연결을 닫는다(Phase 1은 폰 → PC 전송만).
import {
  CAP, flushOutbox, fromB64, monotonicClock, openMobileSession, softNoiseStatic, wsRelayClient,
  type FlushResult, type Link, type WebSocketLike,
} from '@sax/remote';
import { APP_VERSION, DEV_LOCAL, DEV_RELAY_HOST } from '../config';
import type { DeviceKeys } from '../keyring';
import type { FileOutbox } from '../storage/outbox';
import type { AppData } from '../storage/state';

export type PcStatus = 'unpaired' | 'connecting' | 'online' | 'offline';

export interface SyncDeps {
  keys: DeviceKeys;
  data: () => AppData;
  update: (f: (d: AppData) => AppData) => Promise<void>;
  outbox: FileOutbox;
}

export interface SyncResult {
  status: PcStatus;
  flushed?: FlushResult;
}

const PEER_WAIT_MS = 3000;

export function relayFor(host: string) {
  return wsRelayClient({
    host,
    insecureLocal: DEV_LOCAL && host === DEV_RELAY_HOST,
    open: (url) => new WebSocket(url) as unknown as WebSocketLike,
  });
}

function waitPeer(link: Link, ms: number): Promise<boolean> {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(false), ms);
    link.onPeer(() => {
      clearTimeout(t);
      resolve(true);
    });
    link.onClose(() => {
      clearTimeout(t);
      resolve(false);
    });
  });
}

/** 한 번 연결해 보관함을 비운다. 동시에 두 번 돌지 않게 호출하는 쪽이 막는다. */
export async function syncWithPc(d: SyncDeps): Promise<SyncResult> {
  const pair = d.data().pair;
  if (!pair) return { status: 'unpaired' };
  let link: Link | null = null;
  const noise = softNoiseStatic(d.keys.sm);
  try {
    link = await relayFor(pair.relayHost).joinMailbox(fromB64(pair.mbxId), fromB64(pair.tokWrite), 'mobile');
    if (!(await waitPeer(link, PEER_WAIT_MS))) return { status: 'offline' };
    const clock = monotonicClock(d.data().ikTs);
    let used = 0;
    const s = await openMobileSession(link, {
      pairId: pair.pairId,
      noise,
      desktopStatic: fromB64(pair.desktopStatic),
      hello: { appVersion: APP_VERSION, deviceListVersion: d.data().seenListVersion, capabilities: [CAP.receipt, CAP.cash] },
      nextTimestamp: () => (used = clock()),
      responseTimeoutMs: 8000,
    });
    if (used) await d.update((x) => ({ ...x, ikTs: Math.max(x.ikTs, used) }));
    if (!s) return { status: 'offline' };
    await d.update((x) => ({ ...x, lastSeenPc: Date.now() }));
    const flushed = await flushOutbox(s.channel, d.outbox);
    if (flushed.sent.length) {
      const sent = new Set(flushed.sent);
      await d.update((x) => ({ ...x, cash: x.cash.map((c) => (sent.has(c.msgId) ? { ...c, state: 'sent' as const } : c)) }));
    }
    s.channel.close();
    return { status: 'online', flushed };
  } catch {
    return { status: 'offline' };
  } finally {
    noise.destroy();
    link?.close();
  }
}
