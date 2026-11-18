// 계정 열쇠 맡기기(ADR-050): 쓰던 PC 없이 로그인한 새 PC가 이메일 인증만으로 계정 열쇠(RK)를 받는다.
// - 맡기기: 로그인된 PC의 금고가 RK를 계정 서비스의 보관 키로 HPKE 봉인해 올린다(info = CTX.rkEscrow, aad = escrowStoreAad).
// - 받기: 계정 서비스가 그것을 열어 새 PC의 넘겨받기 키(Hx)로 다시 봉인해 준다(info = CTX.rkEscrow, aad = escrowClaimAad).
//   새 PC 금고는 연 RK의 AIK 공개키가 계정의 AIK와 같을 때만 받는다(crypto.rkImport).
// 계정 서비스는 RK를 열 수 있다. 이 길은 "서버는 계정 열쇠를 갖지 않는다"(ADR-029 결정 1)를 대표 결정(2026-11-18)으로 바꾼 것이다.
// 금고 안 자료(공동인증서·홈택스 비밀번호)는 RK와 무관하고 PC 밖으로 나가지 않는다.
import { concat, utf8 } from './bytes.ts';
import { CTX } from './contexts.ts';
import { sha256Hash } from './crypto.ts';

/** 맡길 때의 aad(32B): 봉인문을 계정의 AIK에 묶는다(다른 계정의 줄에 끼워 넣지 못한다). */
export const escrowStoreAad = (aikPub: Uint8Array): Uint8Array => sha256Hash(concat(utf8(CTX.rkEscrowStore), aikPub));

/** 받을 때의 aad(32B): 봉인문을 계정의 AIK·새 PC의 기기 ID·넘겨받기 키에 묶는다. */
export const escrowClaimAad = (aikPub: Uint8Array, deviceId: string, linkPub: Uint8Array): Uint8Array =>
  sha256Hash(concat(utf8(CTX.rkEscrowClaim), aikPub, utf8(deviceId), linkPub));
