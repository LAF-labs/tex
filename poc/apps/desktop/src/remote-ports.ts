// 데스크톱 계정·기기·페어링 배선의 바깥 포트(D08 §4.2, D09 §2, 팀장 결정 2026-11-06 (가)). 인터페이스만 둔다.
// - 계정 클라이언트·릴레이 HTTP·소켓(packages/net egress 경유): 클라우드 세션이 구현한다.
// - DesktopKeys(금고 crypto.publicKeys·noiseDH·signVd·signAik): 금고 세션이 구현한다(@sax/remote keys.ts 그대로).
// - 데스크톱(이 트랙)은 이 포트 위에 로그인 화면·기기 등록·토큰 보관·페어링 화면·main 배선(DesktopPairing → pair.ok acctClaim)을 만든다.
// 규칙:
// - 오류는 Error.code에 서버 코드(`<영역>.<코드>`, 예: account.aik_already_pinned, relay.room_used, policy.rate_limited)만 싣는다.
//   응답 본문·URL·토큰·이메일은 오류·로그에 넣지 않는다. 네트워크 실패는 code 'net.<이유>'(egress 코드 그대로).
// - 계정 세션 문자열과 기기 토큰은 main 메모리에만 있다. 렌더러·로그·파일로 나가지 않는다. 기기 토큰은 DeviceTokenCache(15분, 영속 없음).
// - 기기 범위 호출의 인증 헤더는 데스크톱이 만들어 넘긴다(DeviceAuth). 클라이언트는 그 헤더를 그대로 붙인다.
import type { DeviceListJson, DesktopKeys, DeviceToken, DpopSigner, SignedAcctClaim, SignedCert, WebSocketLike } from '@sax/remote';

/** 기기 범위 토큰 헤더(Authorization: DPoP <token> + DPoP 증명). htu는 요청 URL 전체(쿼리 없음). 데스크톱이 deviceAuthHeaders로 만든다. */
export type DeviceAuth = (htm: 'GET' | 'POST' | 'PUT' | 'DELETE', htu: string) => Promise<Record<string, string>>;

/** 계정 서비스(services/account) 클라이언트. 클라우드 세션 구현. origin은 구현이 고정한다(egress 허용 목록). */
export interface AccountClient {
  /** POST /v1/auth/code {email} → 메일로 6자리. */
  startEmailCode(email: string): Promise<{ loginId: string; expiresInSec: number }>;
  /** POST /v1/auth/code/verify {loginId, code} → 계정 세션(Bearer). */
  verifyEmailCode(loginId: string, code: string): Promise<{ session: string; expiresInSec: number }>;
  /** POST /v1/auth/logout. 기기 고정이 끝나면 데스크톱이 부르고 세션을 버린다. */
  logout(session: string): Promise<void>;
  /** GET /v1/device-list(세션). aikPub가 이미 있으면 첫 PC가 아니다(두 번째 PC 추가는 이 범위 밖: account.aik_already_pinned로 안내). */
  deviceList(session: string): Promise<{ aikPub: string | null; deviceList: DeviceListJson | null }>;
  /** POST /v1/aik(세션): 첫 PC의 AIK 고정 + AIK 서명 목록(이 PC 한 줄). */
  pinFirstDesktop(session: string, b: { aikPub: string; deviceList: DeviceListJson; platform: 'windows' | 'macos'; name: string }): Promise<{ deviceId: string }>;
  /** POST /v1/device-tokens: AIK 인증서 + DPoP(Vd) → 15분 토큰. @sax/remote requestDeviceToken과 같다. */
  deviceToken(cert: SignedCert, dpop: DpopSigner): Promise<DeviceToken>;
  /** GET /v1/acct-claim(기기 토큰, 데스크톱만). 응답 JSON 그대로(SignedAcctClaim). pair.ok 운반 형식(b64 JCS)은 데스크톱이 만든다. */
  acctClaim(auth: DeviceAuth): Promise<SignedAcctClaim>;
  /** POST /v1/devices/enroll(기기 토큰): 폰 대리 등록. roomId는 이 PC가 연 페어링 룸(16B base64url). 같은 키 재등록 200도 성공. */
  enrollPhone(auth: DeviceAuth, b: { deviceId: string; role: 'mobile'; platform: 'ios' | 'android'; name: string; Sx: string; Vx: string; roomId: string }): Promise<void>;
  /** PUT /v1/device-list(기기 토큰): AIK 서명 새 목록. */
  putDeviceList(auth: DeviceAuth, list: DeviceListJson): Promise<void>;
}

/** 릴레이(services/relay) HTTP 클라이언트. 클라우드 세션 구현. 바이트 값은 base64url로 보낸다(서버 API.md). */
export interface RelayHttpClient {
  /** POST /v1/rooms {roomId}(기기 토큰, 데스크톱만) → 룸 만료 시각(ms). QR을 보이기 전에 연다. */
  createRoom(auth: DeviceAuth, roomId: Uint8Array): Promise<{ expiresAt: number }>;
  /** POST /v1/mailboxes(기기 토큰): 우편함 등록(서버는 토큰 해시만). */
  registerMailbox(auth: DeviceAuth, mbxId: Uint8Array, tokRead: Uint8Array, tokWrite: Uint8Array): Promise<void>;
  /** DELETE /v1/mailboxes/:id(쓰기 토큰): 우편함을 만든 뒤 페어링이 실패하면 지운다. */
  deleteMailbox(auth: DeviceAuth, mbxId: Uint8Array, tokWrite: Uint8Array): Promise<void>;
}

/** 클라우드 세션이 넘기는 묶음. 릴레이 WebSocket도 egress 경유(@sax/remote wsRelayClient의 open). */
export interface CloudPorts {
  account: AccountClient;
  relay: RelayHttpClient;
  /** 릴레이 호스트(pairPrologue·QR에 들어간다, WSS는 이 호스트로). 운영 relayHost = rooms.tax.laf-co.com(QR 호스트·WSS), HTTPS 큐는 tax.laf-co.com. 개발 스택 localhost:<port>. */
  relayHost: string;
  /** 개발 스택(ws://localhost)이면 참. 제품 빌드는 늘 거짓. */
  insecureLocal: boolean;
  /** 릴레이 소켓 열기(wss, 개발 스택은 ws://localhost). headers는 우편함 라이브에만. */
  openSocket(url: string, headers?: Record<string, string>): WebSocketLike;
}

/**
 * 금고 세션이 넘기는 키 연산. @sax/remote DesktopKeys(noise=Sd·crypto.noiseDH, vd=Vd·crypto.signVd, aik=AIK·crypto.signAik, kvPublic)
 * 그대로다. 공개키는 crypto.publicKeys에서 한 번 읽어 둔다. DPoP는 vd로 서명한다(VdPurpose에 SAX-dpop-v1이 있다).
 */
export type VaultKeysFactory = (control: (method: string, params?: Record<string, unknown>) => Promise<unknown>) => Promise<DesktopKeys>;
