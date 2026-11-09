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

/**
 * 로그인 응답(코드·비밀번호·재설정). remember가 참이면 서버가 갱신 토큰(sxa1.)을 더 준다(ADR-038 (f)).
 * 세션·갱신 토큰은 main 메모리에만 두고, 갱신 토큰은 금고(account.refresh)로만 옮긴다.
 */
export interface AccountLogin {
  session: string;
  expiresInSec: number;
  refreshToken?: string;
  refreshExpiresInSec?: number;
}

/** GET /v1/me에서 데스크톱이 쓰는 칸. reauthUntil은 이 세션의 최근 인증이 끝나는 시각(ms, 갱신 세션이면 null). */
export interface AccountMe {
  email: string;
  hasPassword: boolean;
  reauthUntil: number | null;
  authMethod: string;
}

/** 계정 서비스(services/account) 클라이언트. 클라우드 세션 구현. origin은 구현이 고정한다(egress 허용 목록). */
export interface AccountClient {
  /** POST /v1/auth/code {email} → 메일로 6자리. */
  startEmailCode(email: string): Promise<{ loginId: string; expiresInSec: number }>;
  /** POST /v1/auth/code/verify {loginId, code, remember?} → 계정 세션(Bearer). 첫 검증 때 계정이 생긴다. */
  verifyEmailCode(loginId: string, code: string, remember?: boolean): Promise<AccountLogin>;
  /**
   * POST /v1/auth/password {email, password} → 계정 세션(ADR-038 (a)). 비밀번호는 이 호출의 본문으로만 나간다(로그·저장 없음).
   * 틀림·없는 계정·잠금은 모두 account.credentials_invalid(같은 응답). 서버에서 비밀번호가 꺼져 있으면 request.not_found.
   */
  passwordLogin(email: string, password: string, remember?: boolean): Promise<AccountLogin>;
  /** GET /v1/me(세션). */
  me(session: string): Promise<AccountMe>;
  /**
   * PUT /v1/password(세션). 만들기(currentPassword 없음)는 최근 10분 인증이 필요하다(아니면 account.reauth_required).
   * 바꾸기는 currentPassword가 필수이고, 이 기기용 새 갱신 토큰을 돌려준다(옛 계보는 서버가 폐기).
   */
  setPassword(session: string, password: string, currentPassword?: string): Promise<{ refreshToken?: string; refreshExpiresInSec?: number }>;
  /** DELETE /v1/password(세션, 최근 10분 인증). */
  deletePassword(session: string): Promise<void>;
  /** POST /v1/auth/reauth(세션) → 계정 주소로 본인 확인 코드. */
  startReauth(session: string): Promise<{ reauthId: string; expiresInSec: number }>;
  /** POST /v1/auth/reauth/verify(코드를 요청한 그 세션) → 이 세션의 인증 시각이 지금이 된다(새 세션 없음). */
  verifyReauth(session: string, reauthId: string, code: string): Promise<{ authAt: number; reauthMaxAgeSec: number }>;
  /** POST /v1/auth/password/reset {email} → 계정이 없어도 같은 응답. */
  startPasswordReset(email: string): Promise<{ resetId: string; expiresInSec: number }>;
  /** POST /v1/auth/password/reset/verify. 성공하면 서버가 그 계정의 다른 세션·갱신 토큰을 모두 폐기한다. */
  verifyPasswordReset(resetId: string, code: string, password: string, remember?: boolean): Promise<AccountLogin>;
  /** POST /v1/auth/refresh {refreshToken} → 새 세션 + 회전된 갱신 토큰. 실패는 account.unauthorized 하나. */
  refresh(refreshToken: string): Promise<Required<AccountLogin>>;
  /** POST /v1/auth/refresh/revoke {refreshToken} → 그 계보 전체 폐기(없는 토큰도 204). */
  revokeRefresh(refreshToken: string): Promise<void>;
  /** POST /v1/auth/logout-all(세션) → 이 세션 포함 계정 세션·갱신 토큰 전부 폐기. 기기 범위 토큰·기기 등록은 그대로. */
  logoutAll(session: string): Promise<void>;
  /** POST /v1/auth/logout. 기기 고정이 끝나면 데스크톱이 부르고 세션을 버린다. */
  logout(session: string): Promise<void>;
  /** GET /v1/device-list(세션). aikPub가 이미 있으면 첫 PC가 아니다(두 번째 PC 추가는 이 범위 밖: account.aik_already_pinned로 안내). */
  deviceList(session: string): Promise<{ aikPub: string | null; deviceList: DeviceListJson | null }>;
  /** POST /v1/aik(세션): 첫 PC의 AIK 고정 + AIK 서명 목록(이 PC 한 줄). */
  pinFirstDesktop(session: string, b: { aikPub: string; deviceList: DeviceListJson; platform: 'windows' | 'macos'; name: string }): Promise<{ deviceId: string }>;
  /**
   * POST /v1/device-tokens: AIK 인증서 + DPoP(Vd) → 15분 토큰. @sax/remote requestDeviceToken과 같다.
   * scopes가 있으면 본문에 실어 그 범위만 달라고 한다(게이트웨이 전용 토큰, ADR-040 예정). 실제로 준 범위는 응답 scopes다.
   */
  deviceToken(cert: SignedCert, dpop: DpopSigner, scopes?: readonly string[]): Promise<DeviceToken>;
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
