import { concat, utf8 } from './bytes.ts';
import { CTX } from './contexts.ts';
import { sha256Hash } from './crypto.ts';

/** 맡길 때의 aad(32B): 봉인문을 계정의 AIK에 묶는다(다른 계정의 줄에 끼워 넣지 못한다). */
export const escrowStoreAad = (aikPub: Uint8Array): Uint8Array => sha256Hash(concat(utf8(CTX.rkEscrowStore), aikPub));

/** 받을 때의 aad(32B): 봉인문을 계정의 AIK·새 PC의 기기 ID·넘겨받기 키에 묶는다. */
export const escrowClaimAad = (aikPub: Uint8Array, deviceId: string, linkPub: Uint8Array): Uint8Array =>
  sha256Hash(concat(utf8(CTX.rkEscrowClaim), aikPub, utf8(deviceId), linkPub));
