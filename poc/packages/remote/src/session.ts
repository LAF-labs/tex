
import { concat, equal, readU64be, u64be, utf8 } from './bytes.ts';
import { Channel } from './channel.ts';
import { CTX } from './contexts.ts';
import type { HelloBody } from './envelope.ts';
import { encodeHs, KIND, parseFrame, Transport } from './frame.ts';
import type { NoiseStatic } from './keys.ts';
import { Handshake } from './noise.ts';
import { attachQueue, nextFrame, type Link } from './relay.ts';

export const PROTOCOL_VERSION = 1;
export const SUITES: HelloBody['suites'] = ['noise-25519-chachapoly-blake2b'];
/** v1.11: sync = run.event.rev와 gate.resolved(폰과 PC 연결 끊김에 강하게)를 받는다(폰) / 보낸다(PC). */
export const CAP = { receipt: 'receipt.v1', receiptV2: 'receipt.v2', cash: 'cash.v1', issue: 'issue.v1', copy: 'copy.v1', share: 'share.v1', approve: 'approve.v1', sync: 'sync.v1', issued: 'issued.v1' } as const;
const ZERO_HASH = '0'.repeat(64);

export const sessionPrologue = (pairId: string): Uint8Array => concat(utf8(CTX.session), utf8(pairId));

export interface HelloInfo {
  appVersion: string;
  deviceListVersion: number;
  asyncSeqMax?: number;
  registryHeadHash?: string;
  capabilities: string[];
}

export interface SessionInfo {
  channel: Channel;
  peerHello: HelloBody;
  deviceListMismatch: boolean;
  registryMismatch: boolean;
}

function helloBody(h: HelloInfo): HelloBody {
  return {
    appVersion: h.appVersion,
    protocol: PROTOCOL_VERSION,
    suites: SUITES,
    deviceListVersion: h.deviceListVersion,
    asyncSeqMax: h.asyncSeqMax ?? 0,
    registryHeadHash: h.registryHeadHash ?? ZERO_HASH,
    capabilities: h.capabilities,
  };
}

async function exchangeHello(ch: Channel, mine: HelloInfo, minProtocol: number, first: 'send' | 'recv', timeoutMs = 10_000): Promise<SessionInfo | null> {
  if (first === 'send') ch.send('hello', helloBody(mine));
  const e = await ch.recv(timeoutMs);
  if (!e || e.type !== 'hello') {
    ch.close();
    return null;
  }
  const peer = e.body as HelloBody;
  if (first === 'recv') ch.send('hello', helloBody(mine));
  if (peer.protocol < minProtocol) {
    ch.close();
    return null;
  }
  return {
    channel: ch,
    peerHello: peer,
    deviceListMismatch: peer.deviceListVersion !== mine.deviceListVersion,
    registryMismatch: peer.registryHeadHash !== (mine.registryHeadHash ?? ZERO_HASH),
  };
}

export interface MobileSessionOptions {
  pairId: string;
  noise: NoiseStatic;
  desktopStatic: Uint8Array;
  hello: HelloInfo;
  nextTimestamp: () => number;
  now?: () => number;
  minProtocol?: number;
  responseTimeoutMs?: number;
  helloTimeoutMs?: number;
}

/** 우편함 링크 위에서 IK 세션을 연다. PC가 응답하지 않으면 null(꺼져 있거나 거부, 구분하지 않는다). */
export async function openMobileSession(link: Link, o: MobileSessionOptions): Promise<SessionInfo | null> {
  attachQueue(link);
  try {
    const hs = new Handshake({ pattern: 'IK', initiator: true, ctx: CTX.session, s: o.noise, rs: o.desktopStatic, prologue: sessionPrologue(o.pairId) });
    link.send(encodeHs(await hs.writeMessage(u64be(o.nextTimestamp()))));
    const f = await nextFrame(link, o.responseTimeoutMs ?? 15_000);
    const p = f ? parseFrame(f) : null;
    if (!p || p.kind !== KIND.HS) return null;
    await hs.readMessage(p.body);
    const ch = new Channel(link, new Transport(hs.split()), { pairId: o.pairId, me: 'mobile', now: o.now });
    return await exchangeHello(ch, o.hello, o.minProtocol ?? PROTOCOL_VERSION, 'send', o.helloTimeoutMs);
  } catch {
    return null;
  }
}

export interface PairRecord {
  pairId: string;
  phoneStatic: Uint8Array;
  revoked: boolean;
  ikTsMax: number;
}

export interface DesktopSessionOptions {
  noise: NoiseStatic;
  pair: PairRecord;
  hello: HelloInfo;
  persistTs: (pairId: string, ts: number) => Promise<void>;
  now?: () => number;
  minProtocol?: number;
  helloTimeoutMs?: number;
  first?: Uint8Array;
}

/** 폰의 msg1을 받아 검사한다. 거부는 무응답(null). */
export async function acceptDesktopSession(link: Link, o: DesktopSessionOptions): Promise<SessionInfo | null> {
  attachQueue(link);
  try {
    const f = o.first ?? (await nextFrame(link, 30_000));
    const p = f ? parseFrame(f) : null;
    if (!p || p.kind !== KIND.HS) return null;
    const hs = new Handshake({ pattern: 'IK', initiator: false, ctx: CTX.session, s: o.noise, prologue: sessionPrologue(o.pair.pairId) });
    const payload = await hs.readMessage(p.body);
    const rs = hs.remoteStatic;
    if (o.pair.revoked || !rs || !equal(rs, o.pair.phoneStatic) || payload.length !== 8) return null;
    const ts = Number(readU64be(payload, 0));
    if (!(ts > o.pair.ikTsMax)) return null;
    await o.persistTs(o.pair.pairId, ts);
    o.pair.ikTsMax = ts;
    link.send(encodeHs(await hs.writeMessage()));
    const ch = new Channel(link, new Transport(hs.split()), { pairId: o.pair.pairId, me: 'desktop', now: o.now });
    return await exchangeHello(ch, o.hello, o.minProtocol ?? PROTOCOL_VERSION, 'recv', o.helloTimeoutMs);
  } catch {
    return null;
  }
}

/** 단조 타임스탬프 생성기(영속 값에서 시작). */
export function monotonicClock(last: number, now: () => number = Date.now): () => number {
  let prev = last;
  return () => {
    const t = Math.max(now(), prev + 1);
    prev = t;
    return t;
  };
}
