// D08 §5 상시 세션: Noise_IK(개시자 폰), prologue = "SAX-session-v1" ‖ pair_id, msg1 페이로드 = 단조 타임스탬프 8B.
// PC는 Sm 미폐기·타임스탬프 단조성을 확인하고 아니면 무응답으로 버린다(오라클 방지). 최고값은 pair별로 영속한다.

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
/** Phase 1 폰 기능 표시(hello.capabilities). */
export const CAP = { receipt: 'receipt.v1', cash: 'cash.v1' } as const;
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
  /** deviceListVersion이 다르면 비가역 승인·비밀 요청을 보류하고 devlist.push를 주고받는다(C-20). */
  deviceListMismatch: boolean;
  /** registryHeadHash가 다르면 경고(C-26). */
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
  // hello가 없으면 전송 키와 우편함 자리를 놓는다(다시 시도할 때 자리가 비어 있게).
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

// ---- 폰 ----

export interface MobileSessionOptions {
  pairId: string;
  noise: NoiseStatic;
  desktopStatic: Uint8Array;
  hello: HelloInfo;
  /** 단조 타임스탬프. 기본은 ms 시각이며 직전 값 이하이면 +1 한다(앱이 영속). */
  nextTimestamp: () => number;
  now?: () => number;
  minProtocol?: number;
  /** PC 응답 대기(기본 15초). 없으면 꺼져 있는 것으로 본다. */
  responseTimeoutMs?: number;
  /** IK 뒤 hello 대기(기본 10초). */
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

// ---- PC ----

export interface PairRecord {
  pairId: string;
  phoneStatic: Uint8Array;
  revoked: boolean;
  /** remote_pair_state.ik_ts_max */
  ikTsMax: number;
}

export interface DesktopSessionOptions {
  noise: NoiseStatic;
  /** 우편함이 정하는 pair(우편함은 pair마다 하나). */
  pair: PairRecord;
  hello: HelloInfo;
  /** ik_ts_max 영속(통과한 뒤에만 부른다). */
  persistTs: (pairId: string, ts: number) => Promise<void>;
  now?: () => number;
  minProtocol?: number;
  /** IK 뒤 hello 대기(기본 10초). */
  helloTimeoutMs?: number;
}

/** 폰의 msg1을 받아 검사한다. 거부는 무응답(null). */
export async function acceptDesktopSession(link: Link, o: DesktopSessionOptions): Promise<SessionInfo | null> {
  attachQueue(link);
  try {
    const f = await nextFrame(link, 30_000);
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
