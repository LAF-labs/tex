import { p256 } from '@noble/curves/nist.js';
import { concat, fromHex, toHex, utf8 } from './bytes.ts';
import { encodeCbor } from './cbor.ts';
import { CTX } from './contexts.ts';
import { ed25519Verify, sha256Hash } from './crypto.ts';
import type { PxHw } from './envelope.ts';

export const PX_HW: readonly PxHw[] = ['ios_se', 'android_strongbox', 'android_tee'];
export const PX_PUB_LEN = 65;
export const APPROVE_SIG_LEN = 64;
export const CHALLENGE_LEN = 32;

/** SEC1 비압축(0x04 ‖ X ‖ Y)이고 곡선 위의 점인지. */
export function validPxPub(pub: Uint8Array): boolean {
  if (!(pub instanceof Uint8Array) || pub.length !== PX_PUB_LEN || pub[0] !== 0x04) return false;
  try {
    p256.Point.fromBytes(pub).assertValidity();
    return true;
  } catch {
    return false;
  }
}

/** 키 표시용 id: SHA-256(pxPub) 앞 8바이트(hex 16자). 비밀이 아니다. */
export const pxIdOf = (pub: Uint8Array): string => toHex(sha256Hash(pub).subarray(0, 8));

/** 등록 알림의 서명 대상(컨텍스트 제외). */
export function pxEnrollMessage(pairId: string, deviceId: string, pxPub: Uint8Array, hw: PxHw): Uint8Array {
  return encodeCbor([pairId, deviceId, pxPub, hw]);
}

/** 폰 Vm이 서명한 등록 알림인지(PC). */
export function verifyPxEnroll(vmPub: Uint8Array, pairId: string, deviceId: string, pxPub: Uint8Array, hw: PxHw, sig: Uint8Array): boolean {
  if (!validPxPub(pxPub) || !PX_HW.includes(hw)) return false;
  return ed25519Verify(vmPub, CTX.pxEnroll, pxEnrollMessage(pairId, deviceId, pxPub, hw), sig);
}

export interface ApproveInput {
  pairId: string;
  reqId: string;
  challenge: Uint8Array;
  actionHash: string;
  decision: 'approve' | 'deny';
}

/** gate.response 서명 대상(컨텍스트 제외). 모양이 틀리면 던진다. */
export function approveMessage(i: ApproveInput): Uint8Array {
  if (i.challenge.length !== CHALLENGE_LEN) throw new Error('approve: bad challenge');
  if (!/^[0-9a-f]{64}$/.test(i.actionHash)) throw new Error('approve: bad actionHash');
  if (i.decision !== 'approve' && i.decision !== 'deny') throw new Error('approve: bad decision');
  return encodeCbor([i.pairId, i.reqId, i.challenge, fromHex(i.actionHash), i.decision]);
}

/** 하드웨어 키에 넘길 바이트 전체(컨텍스트 ‖ 메시지). 키는 이것을 SHA-256으로 해시해 서명한다. */
export const approveSignBytes = (i: ApproveInput): Uint8Array => concat(utf8(CTX.approve), approveMessage(i));

/** PC: 등록된 Px 공개키로 gate.response 서명을 확인한다. 어떤 오류도 false. */
export function verifyApprove(pxPub: Uint8Array, i: ApproveInput, sig: Uint8Array): boolean {
  try {
    if (!validPxPub(pxPub) || !(sig instanceof Uint8Array) || sig.length !== APPROVE_SIG_LEN) return false;
    return p256.verify(sig, sha256Hash(approveSignBytes(i)), pxPub, { prehash: false, lowS: false });
  } catch {
    return false;
  }
}

/**
 * 네이티브 서명(X9.62 DER: SEQUENCE{INTEGER r, INTEGER s}) → r‖s 64바이트. 모양이 틀리면 null.
 * iOS SecKeyCreateSignature·Android Signature가 DER을 준다. 폰이 보내기 전에 바꾼다.
 */
export function ecdsaDerToRaw(der: Uint8Array): Uint8Array | null {
  let p = 0;
  const byte = () => (p < der.length ? der[p++]! : -1);
  const len = () => {
    const b = byte();
    if (b < 0) return -1;
    if (b < 0x80) return b;
    if (b !== 0x81) return -1;
    const l = byte();
    return l >= 0x80 ? l : -1;
  };
  const int = (): Uint8Array | null => {
    if (byte() !== 0x02) return null;
    const l = len();
    if (l < 1 || l > 33 || p + l > der.length) return null;
    let v = der.subarray(p, p + l);
    p += l;
    if (v[0]! & 0x80) return null;
    if (v.length > 1 && v[0] === 0 && !(v[1]! & 0x80)) return null;
    if (v[0] === 0) v = v.subarray(1);
    if (v.length > 32) return null;
    const out = new Uint8Array(32);
    out.set(v, 32 - v.length);
    return out;
  };
  if (byte() !== 0x30) return null;
  const total = len();
  if (total < 0 || p + total !== der.length) return null;
  const r = int();
  const s = r && int();
  if (!r || !s || p !== der.length) return null;
  return concat(r, s);
}
