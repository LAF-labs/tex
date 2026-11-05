// D08 §4.2 QR 페이로드(바이너리, URL 아님): SAXP | v1 | intent | 릴레이 호스트 | room_id(16B) | Sd(32B) | ps(32B) | exp.
// QR에는 이 바이트열의 base64url 텍스트를 싣는다(스캐너가 문자열로 돌려주므로). 딥링크·URL 스킴은 쓰지 않는다.

import { b64url, concat, fromB64url, fromUtf8, readU64be, u64be, utf8 } from './bytes.ts';

const MAGIC = utf8('SAXP');
export const QR_VERSION = 1;
export const QR_TTL_SEC = 120;
export type PairIntent = 'pair' | 'recover';
const INTENT_CODE: Record<PairIntent, number> = { pair: 1, recover: 2 };

export interface QrPayload {
  intent: PairIntent;
  relayHost: string;
  roomId: Uint8Array;
  desktopStatic: Uint8Array;
  psk: Uint8Array;
  /** 만료(유닉스 초) */
  exp: number;
}

const HOST_RE = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*(:\d{1,5})?$/;

export function encodeQr(p: QrPayload): string {
  if (!HOST_RE.test(p.relayHost)) throw new Error('qr: bad relay host');
  if (p.roomId.length !== 16 || p.desktopStatic.length !== 32 || p.psk.length !== 32) throw new Error('qr: bad lengths');
  const host = utf8(p.relayHost);
  const bin = concat(MAGIC, Uint8Array.of(QR_VERSION, INTENT_CODE[p.intent], host.length), host, p.roomId, p.desktopStatic, p.psk, u64be(p.exp));
  return b64url(bin);
}

export function decodeQr(text: string): QrPayload | null {
  try {
    if (text.length > 600) return null;
    const b = fromB64url(text.trim());
    if (b.length < 7 || fromUtf8(b.subarray(0, 4)) !== 'SAXP' || b[4] !== QR_VERSION) return null;
    const intent = b[5] === 1 ? 'pair' : b[5] === 2 ? 'recover' : null;
    if (!intent) return null;
    const hl = b[6]!;
    const want = 7 + hl + 16 + 32 + 32 + 8;
    if (b.length !== want) return null;
    let o = 7;
    const relayHost = fromUtf8(b.subarray(o, (o += hl)));
    if (!HOST_RE.test(relayHost)) return null;
    const roomId = b.slice(o, (o += 16));
    const desktopStatic = b.slice(o, (o += 32));
    const psk = b.slice(o, (o += 32));
    const exp = Number(readU64be(b, o));
    return { intent, relayHost, roomId, desktopStatic, psk, exp };
  } catch {
    return null;
  }
}
