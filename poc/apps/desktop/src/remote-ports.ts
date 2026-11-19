// 데스크톱 계정·기기·페어링 배선의 바깥 포트(D08 §4.2, D09 §2, 팀장 결정 2026-11-06 (가)). 인터페이스만 둔다.
// - 계정 클라이언트·릴레이 HTTP·소켓(packages/net egress 경유): 클라우드 세션이 구현한다.
// - DesktopKeys(금고 crypto.publicKeys·noiseDH·signVd·signAik): 금고 세션이 구현한다(@sax/remote keys.ts 그대로).
// - 데스크톱(이 트랙)은 이 포트 위에 로그인 화면·기기 등록·토큰 보관·페어링 화면·main 배선(DesktopPairing → pair.ok acctClaim)을 만든다.
// 규칙:
// - 오류는 Error.code에 서버 코드(`<영역>.<코드>`, 예: account.aik_already_pinned, relay.room_used, policy.rate_limited)만 싣는다.
//   응답 본문·URL·토큰·이메일은 오류·로그에 넣지 않는다. 네트워크 실패는 code 'net.<이유>'(egress 코드 그대로).
// - 계정 세션 문자열과 기기 토큰은 main 메모리에만 있다. 렌더러·로그·파일로 나가지 않는다. 기기 토큰은 DeviceTokenCache(15분, 영속 없음).
// - 기기 범위 호출의 인증 헤더는 데스크톱이 만들어 넘긴다(DeviceAuth). 클라이언트는 그 헤더를 그대로 붙인다.
import type { DeviceListJson, DesktopKeys, DeviceToken, DpopSigner, MailboxTokens, PcLinkChallenge, PcLinkGrant, PcLinkHello, PcLinkReveal, RelayQueue, ShareKind, ShareRowWire, SignedAcctClaim, SignedCert, WebSocketLike } from '@sax/remote';

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

/** 구독 상태(GET /v1/billing/subscription + /v1/billing/entitlement). 금액은 원(부가세 포함), 시각은 ms. */
export interface BillingView {
  /** 유료 기능 권리: trial(가입 뒤 1달) | paid(낸 기간) | none */
  entitlement: { state: 'trial' | 'paid' | 'none'; until: number | null };
  subscription: { status: 'pending' | 'active' | 'past_due' | 'canceled'; renewAt: number | null; amountKrw: number; refund: { refundableUntil: number; amountKrw: number } | null } | null;
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
  pinFirstDesktop(session: string, b: { aikPub: string; deviceList: DeviceListJson; platform: 'windows' | 'macos'; name: string; escrow?: { enc: string; ct: string } }): Promise<{ deviceId: string }>;
  /**
   * POST /v1/device-tokens: AIK 인증서 + DPoP(Vd) → 15분 토큰. @sax/remote requestDeviceToken과 같다.
   * scopes가 있으면 본문에 실어 그 범위만 달라고 한다(게이트웨이 전용 토큰, ADR-040 예정). 실제로 준 범위는 응답 scopes다.
   */
  deviceToken(cert: SignedCert, dpop: DpopSigner, scopes?: readonly string[], model?: string): Promise<DeviceToken>;
  /** 구독 상태(기기 토큰, 데스크톱만). */
  billing(auth: DeviceAuth): Promise<BillingView>;
  /** POST /v1/billing/checkout(기기 토큰) → 결제 창 주소(계정 origin의 /v1/billing/card?ref=…만 받는다). main이 기본 브라우저로 연다. */
  billingCheckout(auth: DeviceAuth): Promise<{ checkoutUrl: string }>;
  /** POST /v1/billing/cancel(기기 토큰): 다음 결제 없음, 낸 기간까지 사용. */
  billingCancel(auth: DeviceAuth): Promise<void>;
  /** POST /v1/billing/refund(기기 토큰): 청약철회(결제 후 7일). 환불 금액. */
  billingRefund(auth: DeviceAuth): Promise<{ amountKrw: number }>;
  /** GET /v1/acct-claim(기기 토큰, 데스크톱만). 응답 JSON 그대로(SignedAcctClaim). pair.ok 운반 형식(b64 JCS)은 데스크톱이 만든다. */
  acctClaim(auth: DeviceAuth): Promise<SignedAcctClaim>;
  /** POST /v1/devices/enroll(기기 토큰): 폰 대리 등록. roomId는 이 PC가 연 페어링 룸(16B base64url). 같은 키 재등록 200도 성공. */
  enrollPhone(auth: DeviceAuth, b: { deviceId: string; role: 'mobile'; platform: 'ios' | 'android'; name: string; Sx: string; Vx: string; roomId: string }): Promise<void>;
  /** PUT /v1/device-list(기기 토큰): AIK 서명 새 목록. */
  putDeviceList(auth: DeviceAuth, list: DeviceListJson): Promise<void>;
  /**
   * GET /v1/device-list(기기 토큰): 계정의 최신 AIK 서명 목록. PC가 여러 대면 다른 PC가 목록을 바꾼다(폰 연결·끊기·새 PC 승인).
   * 받은 목록은 호출자가 자기 AIK로 검증하고 list_version이 더 높을 때만 받아들인다.
   */
  deviceListByDevice(auth: DeviceAuth): Promise<{ aikPub: string | null; deviceList: DeviceListJson | null }>;
  /** GET /v1/devices(기기 토큰): 서버가 아는 기기 상태(ADR-048 결정 6). 역할·키는 호출자가 AIK 서명 목록과 맞춰 본다. */
  devices(auth: DeviceAuth): Promise<ServerDevice[]>;
  /** POST /v1/devices/self/leave(기기 토큰): 이 PC가 계정에서 나간다(바로 폐기). 마지막 활성 PC면 account.last_desktop. */
  leaveDevice(auth: DeviceAuth): Promise<void>;
  // ---- 새 PC 연결(ADR-048 결정 3, D08 §4.3, services/account/API.md 새 PC 연결 우편함) ----
  // 새 PC는 아직 기기 토큰이 없어 계정 세션으로, 쓰던 PC는 기기 토큰으로 부른다. 받은 메시지는 믿지 않는다(호출자가 @sax/remote로 본다).
  /** GET /v1/devices(세션): 새 PC가 자기 신청 기록(같은 Sx·Vx)을 찾는다. */
  devicesBySession(session: string): Promise<ServerDevice[]>;
  /** POST /v1/devices/enroll(세션): 두 번째·세 번째 PC 신청(pending). PC 3대를 넘으면 account.device_limit. */
  enrollDesktop(session: string, b: { deviceId: string; platform: 'windows' | 'macos'; name: string; Sx: string; Vx: string }): Promise<void>;
  /** PUT /v1/pc-links/:id(세션): m1. 다시 올리면 앞 단계를 지우고 새로 시작한다. */
  pcLinkHello(session: string, deviceId: string, hello: PcLinkHello): Promise<void>;
  /** GET /v1/pc-links/:id(세션): 쓰던 PC의 답(m2·m4). 없으면 null. 신청이 사라졌으면 account.link_not_found. */
  pcLinkAnswer(session: string, deviceId: string): Promise<{ challenge: unknown; grant: unknown }>;
  /** POST /v1/pc-links/:id/reveal(세션): m3. */
  pcLinkReveal(session: string, deviceId: string, reveal: PcLinkReveal): Promise<void>;
  /** DELETE /v1/pc-links/:id(세션): 받아 갔거나 그만둔다(우편함만 비운다). */
  pcLinkCancel(session: string, deviceId: string): Promise<void>;
  /** GET /v1/pc-links(기기 토큰): 기다리는 신청들. hello·reveal은 서버가 준 그대로다. */
  pcLinks(auth: DeviceAuth): Promise<PcLinkRequest[]>;
  /** POST /v1/pc-links/:id/challenge(기기 토큰): m2. 다른 PC가 먼저 답했으면 account.link_state. */
  pcLinkChallenge(auth: DeviceAuth, deviceId: string, challenge: PcLinkChallenge): Promise<void>;
  /** POST /v1/pc-links/:id/grant(기기 토큰): m4. 새 목록을 올린 뒤에 부른다. */
  pcLinkGrant(auth: DeviceAuth, deviceId: string, grant: PcLinkGrant): Promise<void>;
  /** DELETE /v1/pc-links/:id(기기 토큰): 거절. 아직 활성화되지 않은 그 PC의 신청 기록도 지워진다. */
  pcLinkDrop(auth: DeviceAuth, deviceId: string): Promise<void>;
  // ---- 계정 열쇠 맡기기(ADR-050, services/account/API.md 계정 열쇠 보관) ----
  // 로그인된 PC는 기기 토큰으로 맡기고, 쓰던 PC 없이 로그인한 새 PC는 계정 세션으로 받아 스스로 기기 목록에 들어간다.
  // 서버에 이 기능이 꺼져 있으면 넷 다 request.not_found다(새 PC는 쓰던 PC의 승인으로 넘어간다).
  /** GET /v1/key-escrow(기기 토큰): 보관 키의 공개키(base64 32B)와 이 계정의 열쇠가 맡겨져 있는지. */
  keyEscrowState(auth: DeviceAuth): Promise<{ pub: string; stored: boolean }>;
  /** PUT /v1/key-escrow(기기 토큰): 금고가 보관 키로 봉인한 계정 열쇠를 맡긴다. */
  putKeyEscrow(auth: DeviceAuth, sealed: { enc: string; ct: string }): Promise<void>;
  /** POST /v1/key-escrow/claim(세션): 맡긴 열쇠를 이 PC의 넘겨받기 키(Hx)로 봉인해 받는다. 맡긴 것이 없으면 account.escrow_missing. */
  claimKeyEscrow(session: string, b: { deviceId: string; Hx: string }): Promise<{ aikPub: string; enc: string; ct: string }>;
  /** POST /v1/key-escrow/join(세션): 열쇠를 받은 이 PC가 자기를 더한 AIK 서명 목록을 올린다(서버가 이 PC를 활성화한다). */
  joinByKeyEscrow(session: string, deviceId: string, list: DeviceListJson): Promise<void>;
  /** GET /v1/key-escrow/pub(세션): 보관 키의 공개키. 서버에 기능이 없으면 request.not_found. */
  keyEscrowPub(session: string): Promise<{ pub: string }>;
  /** POST /v1/key-escrow/reset(세션): 맡긴 열쇠가 없는 계정에 이 PC의 열쇠를 새 계정 열쇠로 건다. 맡긴 열쇠가 있으면 account.aik_already_pinned. */
  resetByKeyEscrow(session: string, b: { deviceId: string; aikPub: string; deviceList: DeviceListJson; enc: string; ct: string }): Promise<void>;
  /**
   * 발급 잠금(기기 토큰, 데스크톱만. ADR-048 결정 7, API.md 발급 잠금). 계정에 하나이고 잡은 PC만 홈택스 발급에 들어간다.
   * - issueLock: 지금 누가 잡고 있나(잠금 값은 오지 않는다).
   * - acquireIssueLock: 다른 PC가 잡고 있으면 account.issue_locked. 다시 잡으면 새 값이다(앞 값은 죽는다). 만료 90초.
   * - renewIssueLock: 만료됐거나 넘어갔으면 account.issue_lock_lost.
   * - releaseIssueLock: 내 값이 아니어도 조용히 끝난다.
   */
  issueLock(auth: DeviceAuth): Promise<{ held: boolean; deviceId: string | null; expiresAt: number | null; mine: boolean }>;
  acquireIssueLock(auth: DeviceAuth): Promise<{ lockId: string; expiresAt: number }>;
  renewIssueLock(auth: DeviceAuth, lockId: string): Promise<{ expiresAt: number }>;
  releaseIssueLock(auth: DeviceAuth, lockId: string): Promise<void>;
  /**
   * POST /v1/wake(기기 토큰 wake 범위, 데스크톱만. ADR-053 결정 2, services/push/API.md): 같은 계정의 그 폰에 내용 없는 알림.
   * kind는 알림 글의 종류(approve·update)뿐이다. sent:false는 공급사 일시 장애. 토큰이 없으면 push.token_not_found, 한도면 policy.rate_limited.
   */
  wakePhone(auth: DeviceAuth, deviceId: string, kind: 'approve' | 'update'): Promise<{ sent: boolean }>;
  // ---- 계정 공유 기록(기기 토큰 share 범위. ADR-048 결정 5, D07 §10, API.md 계정 공유 기록) ----
  // 줄은 암호문이다. 받은 줄은 믿지 않는다(호출자가 @sax/remote openShareRow로 열고 서명을 본다).
  /** PUT /v1/share/rows/:rowId. 같은 줄을 같은 내용으로 다시 올리면 처음 순번, 다른 내용이면 account.share_row_conflict. */
  putShareRow(auth: DeviceAuth, row: ShareRowWire & { taskId?: string }): Promise<{ seq: number }>;
  /** GET /v1/share/rows(after 0) 또는 /v1/share/rows/after/:seq. 한 번에 200줄까지, 더 있으면 more. */
  shareRows(auth: DeviceAuth, after: number): Promise<SharePage>;
  /** GET /v1/share/tasks: 맡긴 일의 상태(내용은 줄에 있다). */
  shareTasks(auth: DeviceAuth): Promise<ShareTaskState[]>;
  /** POST /v1/share/tasks/:id/claim: 한 번에 한 PC만. 다른 PC가 맡고 있으면 account.task_claimed, 끝났으면 account.task_closed. */
  claimShareTask(auth: DeviceAuth, taskId: string): Promise<{ claimExpiresAt: number }>;
  /** POST /v1/share/tasks/:id/release: 내가 맡은 일을 다시 연다. */
  releaseShareTask(auth: DeviceAuth, taskId: string): Promise<void>;
  /** POST /v1/share/tasks/:id/cancel. */
  cancelShareTask(auth: DeviceAuth, taskId: string): Promise<void>;
  /** 탈퇴(기기 토큰, 데스크톱만): GET /v1/account/deletion, POST delete-request(7일 유예·구독 해지), POST delete-cancel. */
  accountDeletion(auth: DeviceAuth): Promise<{ deleteAfter: number | null }>;
  requestAccountDelete(auth: DeviceAuth): Promise<{ deleteAfter: number }>;
  cancelAccountDelete(auth: DeviceAuth): Promise<void>;
}

/** 계정 서비스가 아는 기기 한 대(GET /v1/devices). 이름·플랫폼·상태는 서버 값이다. */
export interface ServerDevice {
  deviceId: string;
  role: 'desktop' | 'mobile';
  platform: 'windows' | 'macos' | 'ios' | 'android';
  name: string;
  state: 'pending' | 'active' | 'suspended' | 'revoked';
  registeredAt: number;
  Sx: string;
  Vx: string;
  /** 삭제 유예 끝(ms). 없으면 null */
  deleteAfter: number | null;
  /** 마지막으로 기기 토큰을 받은 시각(ms). 서버가 아직 모르면 null */
  lastSeenAt: number | null;
}

/** 서버가 준 공유 기록 줄 하나. deviceId·at(서버가 받은 시각)은 서버 값이고 줄 안의 dev·at과 다를 수 있다(믿는 것은 줄 안의 값). */
export interface ShareServerRow extends ShareRowWire {
  seq: number;
  deviceId: string;
  at: number;
}
export interface SharePage {
  rows: ShareServerRow[];
  /** 계정의 마지막 순번(없으면 0). 이미 받은 순번보다 낮으면 서버가 되감은 것이다 */
  head: number;
  /** 서버가 지금까지 본 가장 높은 세대(참고 값. 세대는 기기 목록에서 정한다) */
  epoch: number;
  more: boolean;
}
export interface ShareTaskState {
  taskId: string;
  state: 'open' | 'claimed' | 'done' | 'cancelled' | 'expired';
  createdBy: string;
  claimedBy: string | null;
  claimExpiresAt: number | null;
  createdAt: number;
  updatedAt: number;
}
export type { ShareKind };

/**
 * 금고의 계정 공유 기록 키 연산(crypto.shareKey·signShare, D05 §5.1). RK와 서명 키 Ws는 금고 밖으로 나오지 않는다.
 * key(e)가 주는 K_share(e)는 호출자가 쓰고 지운다(fill(0)).
 */
export interface ShareVault {
  key(epoch: number): Promise<{ key: Uint8Array; signPub: Uint8Array }>;
  /** Ws로 "SAX-share-v1" ‖ msg를 서명한다(@sax/remote ShareSign) */
  sign(msg: Uint8Array): Promise<Uint8Array>;
}

/** 쓰던 PC가 보는 새 PC 신청 한 건(GET /v1/pc-links). 이름·플랫폼은 새 PC가 신청 때 적은 값이다(서버 값, 믿지 않는다). */
export interface PcLinkRequest {
  deviceId: string;
  name: string;
  platform: 'windows' | 'macos';
  createdAt: number;
  hello: unknown;
  /** 먼저 답한 PC의 기기 ID. 없으면 null */
  challengedBy: string | null;
  reveal: unknown;
}

/**
 * 금고의 계정 열쇠 넘기기(crypto.linkKey·rkSeal·rkImport, D05 §5.1). RK 평문은 어느 쪽에서도 금고 밖으로 나오지 않는다.
 * importRk 뒤에는 AIK가 바뀌므로 호출자가 키 객체(DesktopKeys)를 새로 만든다.
 */
export interface PcLinkVault {
  /** [새 PC] 넘겨받기 키(Hx) 공개키. 부를 때마다 새 키다 */
  key(): Promise<Uint8Array>;
  /** [쓰던 PC] RK를 recipient로 봉인한다. 24시간에 3번까지 */
  sealRk(recipient: Uint8Array, info: Uint8Array, aad: Uint8Array): Promise<{ enc: Uint8Array; ct: Uint8Array }>;
  /** [새 PC] 연 RK의 AIK가 aikPub와 같을 때만 받는다. 새 AIK 공개키를 돌려준다 */
  importRk(g: { enc: Uint8Array; ct: Uint8Array; info: Uint8Array; aad: Uint8Array; aikPub: Uint8Array }): Promise<Uint8Array>;
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
  /** 계정 서비스 origin(구독 결제 창 주소 검사). 없으면 운영 origin. */
  accountOrigin?: string;
  /** 개발 스택(ws://localhost)이면 참. 제품 빌드는 늘 거짓. */
  insecureLocal: boolean;
  /** 릴레이 소켓 열기(wss, 개발 스택은 ws://localhost). headers는 우편함 라이브에만. */
  openSocket(url: string, headers?: Record<string, string>): WebSocketLike;
  /**
   * 우편함 HTTPS 큐(GET·ACK 봉투, PUT 번들, services/relay/API.md). @sax/remote relayQueue를 egress HTTP와 릴레이 HTTPS origin에 묶는다.
   * 연결된 폰 수신(phone-link.ts)이 쓴다. 없으면(시험 대역) 큐로 받지 않는다.
   */
  mailboxQueue?(mbxId: Uint8Array, tok: MailboxTokens, auth: DeviceAuth): RelayQueue;
}

/**
 * 금고 세션이 넘기는 키 연산. @sax/remote DesktopKeys(noise=Sd·crypto.noiseDH, vd=Vd·crypto.signVd, aik=AIK·crypto.signAik, kvPublic)
 * 그대로다. 공개키는 crypto.publicKeys에서 한 번 읽어 둔다. DPoP는 vd로 서명한다(VdPurpose에 SAX-dpop-v1이 있다).
 */
export type VaultKeysFactory = (control: (method: string, params?: Record<string, unknown>) => Promise<unknown>) => Promise<DesktopKeys>;
