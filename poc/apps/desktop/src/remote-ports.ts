import type { DeviceListJson, DesktopKeys, DeviceToken, DpopSigner, MailboxTokens, PcLinkChallenge, PcLinkGrant, PcLinkHello, PcLinkReveal, RelayQueue, ShareKind, ShareRowWire, SignedAcctClaim, SignedCert, WebSocketLike } from '@sax/remote';

export type DeviceAuth = (htm: 'GET' | 'POST' | 'PUT' | 'DELETE', htu: string) => Promise<Record<string, string>>;

export interface AccountLogin {
  session: string;
  expiresInSec: number;
  refreshToken?: string;
  refreshExpiresInSec?: number;
}

export interface AccountMe {
  email: string;
  hasPassword: boolean;
  reauthUntil: number | null;
  authMethod: string;
}

export interface BillingView {
  entitlement: { state: 'trial' | 'paid' | 'none'; until: number | null };
  subscription: { status: 'pending' | 'active' | 'past_due' | 'canceled'; renewAt: number | null; amountKrw: number; refund: { refundableUntil: number; amountKrw: number } | null } | null;
}

export interface AccountClient {
  startEmailCode(email: string): Promise<{ loginId: string; expiresInSec: number }>;
  verifyEmailCode(loginId: string, code: string, remember?: boolean): Promise<AccountLogin>;
  passwordLogin(email: string, password: string, remember?: boolean): Promise<AccountLogin>;
  me(session: string): Promise<AccountMe>;
  setPassword(session: string, password: string, currentPassword?: string): Promise<{ refreshToken?: string; refreshExpiresInSec?: number }>;
  deletePassword(session: string): Promise<void>;
  startReauth(session: string): Promise<{ reauthId: string; expiresInSec: number }>;
  verifyReauth(session: string, reauthId: string, code: string): Promise<{ authAt: number; reauthMaxAgeSec: number }>;
  startPasswordReset(email: string): Promise<{ resetId: string; expiresInSec: number }>;
  verifyPasswordReset(resetId: string, code: string, password: string, remember?: boolean): Promise<AccountLogin>;
  refresh(refreshToken: string): Promise<Required<AccountLogin>>;
  revokeRefresh(refreshToken: string): Promise<void>;
  logoutAll(session: string): Promise<void>;
  logout(session: string): Promise<void>;
  deviceList(session: string): Promise<{ aikPub: string | null; deviceList: DeviceListJson | null }>;
  pinFirstDesktop(session: string, b: { aikPub: string; deviceList: DeviceListJson; platform: 'windows' | 'macos'; name: string; escrow?: { enc: string; ct: string } }): Promise<{ deviceId: string }>;
  deviceToken(cert: SignedCert, dpop: DpopSigner, scopes?: readonly string[], model?: string): Promise<DeviceToken>;
  billing(auth: DeviceAuth): Promise<BillingView>;
  billingCheckout(auth: DeviceAuth): Promise<{ checkoutUrl: string }>;
  billingCancel(auth: DeviceAuth): Promise<void>;
  billingRefund(auth: DeviceAuth): Promise<{ amountKrw: number }>;
  acctClaim(auth: DeviceAuth): Promise<SignedAcctClaim>;
  enrollPhone(auth: DeviceAuth, b: { deviceId: string; role: 'mobile'; platform: 'ios' | 'android'; name: string; Sx: string; Vx: string; roomId: string }): Promise<void>;
  putDeviceList(auth: DeviceAuth, list: DeviceListJson): Promise<void>;
  deviceListByDevice(auth: DeviceAuth): Promise<{ aikPub: string | null; deviceList: DeviceListJson | null }>;
  devices(auth: DeviceAuth): Promise<ServerDevice[]>;
  leaveDevice(auth: DeviceAuth): Promise<void>;
  devicesBySession(session: string): Promise<ServerDevice[]>;
  enrollDesktop(session: string, b: { deviceId: string; platform: 'windows' | 'macos'; name: string; Sx: string; Vx: string }): Promise<void>;
  pcLinkHello(session: string, deviceId: string, hello: PcLinkHello): Promise<void>;
  pcLinkAnswer(session: string, deviceId: string): Promise<{ challenge: unknown; grant: unknown }>;
  pcLinkReveal(session: string, deviceId: string, reveal: PcLinkReveal): Promise<void>;
  pcLinkCancel(session: string, deviceId: string): Promise<void>;
  pcLinks(auth: DeviceAuth): Promise<PcLinkRequest[]>;
  pcLinkChallenge(auth: DeviceAuth, deviceId: string, challenge: PcLinkChallenge): Promise<void>;
  pcLinkGrant(auth: DeviceAuth, deviceId: string, grant: PcLinkGrant): Promise<void>;
  pcLinkDrop(auth: DeviceAuth, deviceId: string): Promise<void>;
  keyEscrowState(auth: DeviceAuth): Promise<{ pub: string; stored: boolean }>;
  putKeyEscrow(auth: DeviceAuth, sealed: { enc: string; ct: string }): Promise<void>;
  claimKeyEscrow(session: string, b: { deviceId: string; Hx: string }): Promise<{ aikPub: string; enc: string; ct: string }>;
  joinByKeyEscrow(session: string, deviceId: string, list: DeviceListJson): Promise<void>;
  keyEscrowPub(session: string): Promise<{ pub: string }>;
  resetByKeyEscrow(session: string, b: { deviceId: string; aikPub: string; deviceList: DeviceListJson; enc: string; ct: string }): Promise<void>;
  issueLock(auth: DeviceAuth): Promise<{ held: boolean; deviceId: string | null; expiresAt: number | null; mine: boolean }>;
  acquireIssueLock(auth: DeviceAuth): Promise<{ lockId: string; expiresAt: number }>;
  renewIssueLock(auth: DeviceAuth, lockId: string): Promise<{ expiresAt: number }>;
  releaseIssueLock(auth: DeviceAuth, lockId: string): Promise<void>;
  wakePhone(auth: DeviceAuth, deviceId: string, kind: 'approve' | 'update'): Promise<{ sent: boolean }>;
  putShareRow(auth: DeviceAuth, row: ShareRowWire & { taskId?: string }): Promise<{ seq: number }>;
  shareRows(auth: DeviceAuth, after: number): Promise<SharePage>;
  shareTasks(auth: DeviceAuth): Promise<ShareTaskState[]>;
  claimShareTask(auth: DeviceAuth, taskId: string): Promise<{ claimExpiresAt: number }>;
  releaseShareTask(auth: DeviceAuth, taskId: string): Promise<void>;
  cancelShareTask(auth: DeviceAuth, taskId: string): Promise<void>;
  accountDeletion(auth: DeviceAuth): Promise<{ deleteAfter: number | null }>;
  requestAccountDelete(auth: DeviceAuth): Promise<{ deleteAfter: number }>;
  cancelAccountDelete(auth: DeviceAuth): Promise<void>;
}

export interface ServerDevice {
  deviceId: string;
  role: 'desktop' | 'mobile';
  platform: 'windows' | 'macos' | 'ios' | 'android';
  name: string;
  state: 'pending' | 'active' | 'suspended' | 'revoked';
  registeredAt: number;
  Sx: string;
  Vx: string;
  deleteAfter: number | null;
  lastSeenAt: number | null;
}

export interface ShareServerRow extends ShareRowWire {
  seq: number;
  deviceId: string;
  at: number;
}
export interface SharePage {
  rows: ShareServerRow[];
  head: number;
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

export interface ShareVault {
  key(epoch: number): Promise<{ key: Uint8Array; signPub: Uint8Array }>;
  sign(msg: Uint8Array): Promise<Uint8Array>;
}

export interface PcLinkRequest {
  deviceId: string;
  name: string;
  platform: 'windows' | 'macos';
  createdAt: number;
  hello: unknown;
  challengedBy: string | null;
  reveal: unknown;
}

export interface PcLinkVault {
  key(): Promise<Uint8Array>;
  sealRk(recipient: Uint8Array, info: Uint8Array, aad: Uint8Array): Promise<{ enc: Uint8Array; ct: Uint8Array }>;
  importRk(g: { enc: Uint8Array; ct: Uint8Array; info: Uint8Array; aad: Uint8Array; aikPub: Uint8Array }): Promise<Uint8Array>;
}

export interface RelayHttpClient {
  createRoom(auth: DeviceAuth, roomId: Uint8Array): Promise<{ expiresAt: number }>;
  registerMailbox(auth: DeviceAuth, mbxId: Uint8Array, tokRead: Uint8Array, tokWrite: Uint8Array, peer?: string): Promise<void>;
  deleteMailbox(auth: DeviceAuth, mbxId: Uint8Array, tokWrite: Uint8Array, peer?: string): Promise<void>;
}

export interface CloudPorts {
  account: AccountClient;
  relay: RelayHttpClient;
  relayHost: string;
  accountOrigin?: string;
  insecureLocal: boolean;
  openSocket(url: string, headers?: Record<string, string>): WebSocketLike;
  mailboxQueue?(mbxId: Uint8Array, tok: MailboxTokens, auth: DeviceAuth): RelayQueue;
}

export type VaultKeysFactory = (control: (method: string, params?: Record<string, unknown>) => Promise<unknown>) => Promise<DesktopKeys>;
