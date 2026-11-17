// 계정·릴레이 클라우드 포트(데스크톱 main 전용, 팀장 결정 2026-11-06 (가)). 포트 정본은 remote-ports.ts(#143), 서버 정본은
// services/account/API.md·services/relay/API.md. 송신은 @sax/net Egress.cloud()·openCloudSocket()으로만 한다(D01 §3).
// 이 모듈은 아무것도 저장하지 않는다: 계정 세션·기기 토큰은 호출자(main 메모리)가 넘기고, 응답의 토큰은 그대로 돌려줄 뿐 파일·로그에 두지 않는다.
// 오류는 Error.code에 서버 코드(`<영역>.<코드>`) 또는 `net.<egress 코드>`만 담는다. 메시지에 본문·URL·토큰·이메일을 넣지 않는다.
import { CLOUD_ORIGIN, CLOUD_WS_HOST, EgressError, type CloudMethod, type Egress } from '@sax/net';
import type { AccountClient, AccountLogin, CloudPorts, DeviceAuth, PcLinkRequest, RelayHttpClient, ServerDevice } from './remote-ports.ts';
import {
  b64url,
  relayOrigin,
  relayQueue,
  requestDeviceToken,
  type DeviceListJson,
  type HttpJson,
  type SignedAcctClaim,
  type WebSocketLike,
} from '@sax/remote';

// 포트 정본은 remote-ports.ts(#143). 여기서는 그 타입을 구현한다.
export type { AccountClient, CloudPorts, DeviceAuth, RelayHttpClient } from './remote-ports.ts';

export interface CloudPortsOptions {
  egress: Egress;
  env: 'prod' | 'dev';
  /** env = 'dev'일 때만: 개발 스택 앞단(apps/mobile/dev/stack.ts, 예: http://localhost:8787 · localhost:8787). Egress도 cloudDevLocal을 켜야 열린다 */
  dev?: { accountOrigin: string; relayHost: string };
}

// ---- 구현 ----

/** 코드만 담는 오류(메시지 = 코드) */
export class CloudPortError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(code);
    this.name = 'CloudPortError';
    this.code = code;
  }
}

const CODE = /^[a-z_]+\.[a-z_]+$/;
const serverCode = (body: unknown): string => {
  const e = (body as { error?: unknown } | null)?.error;
  return typeof e === 'string' && CODE.test(e) ? e : 'server.unknown';
};
const shape = (): never => {
  throw new CloudPortError('response.shape');
};
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown, max = 4096): v is string => typeof v === 'string' && v.length > 0 && v.length <= max;
const int = (v: unknown): v is number => Number.isSafeInteger(v);
const UUID4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** 갱신 토큰 모양(금고 account.refresh와 같다). 다른 모양은 받지도 보내지도 않는다. */
export const REFRESH_TOKEN = /^sxa1\.[A-Za-z0-9_-]{43}$/;
const refreshOk = (v: unknown): v is string => typeof v === 'string' && REFRESH_TOKEN.test(v);

/** 로그인 응답 모양 검사. 갱신 토큰은 있으면 모양까지 맞아야 한다. */
function login(b: unknown): AccountLogin {
  if (!isObj(b) || !str(b.session, 512) || !int(b.expiresInSec)) shape();
  const r = b as { session: string; expiresInSec: number; refreshToken?: unknown; refreshExpiresInSec?: unknown };
  if (r.refreshToken === undefined) return { session: r.session, expiresInSec: r.expiresInSec };
  if (!refreshOk(r.refreshToken) || !int(r.refreshExpiresInSec)) shape();
  return { session: r.session, expiresInSec: r.expiresInSec, refreshToken: r.refreshToken as string, refreshExpiresInSec: r.refreshExpiresInSec as number };
}
/** remember는 참일 때만 본문에 싣는다. */
const rem = (remember?: boolean) => (remember ? { remember: true } : {});

/** 발급 잠금 값(서버 randomToken, base64url). 모양만 본다 */
const ISSUE_LOCK_ID = /^[A-Za-z0-9_-]{22,64}$/;
const DEV_ORIGIN = /^http:\/\/(localhost|127\.0\.0\.1):[0-9]{1,5}$/;
const DEV_HOST = /^(localhost|127\.0\.0\.1):[0-9]{1,5}$/;

export function cloudPorts(o: CloudPortsOptions): CloudPorts {
  const dev = o.env === 'dev';
  if (dev && (!o.dev || !DEV_ORIGIN.test(o.dev.accountOrigin) || !DEV_HOST.test(o.dev.relayHost))) throw new CloudPortError('config.cloud_dev');
  if (!dev && o.dev) throw new CloudPortError('config.cloud_dev');
  const accountOrigin = dev ? o.dev!.accountOrigin : CLOUD_ORIGIN;
  // 운영: 릴레이 HTTPS(우편함·룸 발급)는 계정과 같은 공개 origin, WSS만 룸 호스트. 개발: 스택 앞단 하나
  const relayHttpOrigin = dev ? relayOrigin(o.dev!.relayHost, true) : CLOUD_ORIGIN;
  const relayHost = dev ? o.dev!.relayHost : CLOUD_WS_HOST;

  async function call(method: CloudMethod, url: string, ok: readonly number[], x: { headers?: Record<string, string>; body?: unknown } = {}): Promise<unknown> {
    let r;
    try {
      r = await o.egress.cloud({ method, url, headers: x.headers, body: x.body === undefined ? undefined : JSON.stringify(x.body) });
    } catch (e) {
      throw new CloudPortError(e instanceof EgressError ? `net.${e.code}` : 'net.network');
    }
    if (!ok.includes(r.status)) throw new CloudPortError(serverCode(r.json));
    return r.json;
  }
  const bearer = (session: string) => {
    if (!str(session, 512)) throw new CloudPortError('account.unauthorized');
    return { authorization: `Bearer ${session}` };
  };
  // 데스크톱이 만든 헤더를 그대로 붙인다. 이름 검사·소문자화는 egress(cloudHeaders: authorization·dpop·x-mbx-*만)
  const authed = async (auth: DeviceAuth, method: CloudMethod, url: string): Promise<Record<string, string>> => ({ ...(await auth(method, url)) });
  const bytes = (b: Uint8Array, n: number) => {
    if (!(b instanceof Uint8Array) || b.length !== n) throw new CloudPortError('request.param_rejected');
    return b64url(b);
  };

  /** @sax/remote requestDeviceToken이 쓰는 HTTP(JSON). content-type은 egress가 붙인다 */
  const httpJson: HttpJson = async (req) => {
    const headers = Object.fromEntries(Object.entries(req.headers).filter(([k]) => k.toLowerCase() !== 'content-type'));
    try {
      const r = await o.egress.cloud({ method: req.method as CloudMethod, url: req.url, headers, body: req.body });
      return { status: r.status, body: r.json };
    } catch (e) {
      throw new CloudPortError(e instanceof EgressError ? `net.${e.code}` : 'net.network');
    }
  };

  const pinnedList = (b: unknown): { aikPub: string | null; deviceList: DeviceListJson | null } => {
    if (!isObj(b) || !(b.aikPub === null || str(b.aikPub, 64)) || !(b.deviceList === null || isObj(b.deviceList))) shape();
    const r = b as { aikPub: string | null; deviceList: DeviceListJson | null };
    return { aikPub: r.aikPub, deviceList: r.deviceList };
  };
  const serverDevices = (b: unknown): ServerDevice[] => {
    if (!isObj(b) || !Array.isArray(b.devices) || b.devices.length > 64) shape();
    return ((b as { devices: unknown[] }).devices).map((d): ServerDevice => {
      if (!isObj(d) || !str(d.deviceId, 36) || !str(d.name, 40) || !str(d.Sx, 64) || !str(d.Vx, 64) || !int(d.registeredAt)) shape();
      const x = d as Record<string, unknown>;
      if (x.role !== 'desktop' && x.role !== 'mobile') shape();
      if (!['windows', 'macos', 'ios', 'android'].includes(x.platform as string) || !['pending', 'active', 'suspended', 'revoked'].includes(x.state as string)) shape();
      if (!(x.deleteAfter === null || x.deleteAfter === undefined || int(x.deleteAfter))) shape();
      return { deviceId: x.deviceId as string, role: x.role as ServerDevice['role'], platform: x.platform as ServerDevice['platform'], name: x.name as string, state: x.state as ServerDevice['state'], registeredAt: x.registeredAt as number, Sx: x.Sx as string, Vx: x.Vx as string, deleteAfter: (x.deleteAfter as number | null | undefined) ?? null };
    });
  };
  /** 새 PC 연결 우편함 경로. 기기 ID는 UUIDv4만(egress 허용 경로와 같은 모양) */
  const linkUrl = (deviceId: string) => {
    if (typeof deviceId !== 'string' || !UUID4.test(deviceId)) throw new CloudPortError('request.param_rejected');
    return `${accountOrigin}/v1/pc-links/${deviceId}`;
  };

  const account: AccountClient = {
    async startEmailCode(email) {
      const b = await call('POST', `${accountOrigin}/v1/auth/code`, [200], { body: { email } });
      if (!isObj(b) || !str(b.loginId, 256) || !int(b.expiresInSec)) shape();
      const r = b as { loginId: string; expiresInSec: number };
      return { loginId: r.loginId, expiresInSec: r.expiresInSec };
    },
    async verifyEmailCode(loginId, code, remember) {
      return login(await call('POST', `${accountOrigin}/v1/auth/code/verify`, [200], { body: { loginId, code, ...rem(remember) } }));
    },
    async passwordLogin(email, password, remember) {
      return login(await call('POST', `${accountOrigin}/v1/auth/password`, [200], { body: { email, password, ...rem(remember) } }));
    },
    async me(session) {
      const b = await call('GET', `${accountOrigin}/v1/me`, [200], { headers: bearer(session) });
      if (!isObj(b) || !str(b.email, 254) || typeof b.hasPassword !== 'boolean' || !(b.reauthUntil === null || int(b.reauthUntil)) || !str(b.authMethod, 32)) shape();
      const r = b as { email: string; hasPassword: boolean; reauthUntil: number | null; authMethod: string };
      return { email: r.email, hasPassword: r.hasPassword, reauthUntil: r.reauthUntil, authMethod: r.authMethod };
    },
    async setPassword(session, password, currentPassword) {
      const b = await call('PUT', `${accountOrigin}/v1/password`, [200, 204], { headers: bearer(session), body: currentPassword === undefined ? { password } : { password, currentPassword } });
      if (b === null) return {};
      if (!isObj(b) || !refreshOk(b.refreshToken) || !int(b.refreshExpiresInSec)) shape();
      const r = b as { refreshToken: string; refreshExpiresInSec: number };
      return { refreshToken: r.refreshToken, refreshExpiresInSec: r.refreshExpiresInSec };
    },
    async deletePassword(session) {
      await call('DELETE', `${accountOrigin}/v1/password`, [204], { headers: bearer(session) });
    },
    async startReauth(session) {
      const b = await call('POST', `${accountOrigin}/v1/auth/reauth`, [200], { headers: bearer(session), body: {} });
      if (!isObj(b) || !str(b.reauthId, 256) || !int(b.expiresInSec)) shape();
      const r = b as { reauthId: string; expiresInSec: number };
      return { reauthId: r.reauthId, expiresInSec: r.expiresInSec };
    },
    async verifyReauth(session, reauthId, code) {
      const b = await call('POST', `${accountOrigin}/v1/auth/reauth/verify`, [200], { headers: bearer(session), body: { reauthId, code } });
      if (!isObj(b) || !int(b.authAt) || !int(b.reauthMaxAgeSec)) shape();
      const r = b as { authAt: number; reauthMaxAgeSec: number };
      return { authAt: r.authAt, reauthMaxAgeSec: r.reauthMaxAgeSec };
    },
    async startPasswordReset(email) {
      const b = await call('POST', `${accountOrigin}/v1/auth/password/reset`, [200], { body: { email } });
      if (!isObj(b) || !str(b.resetId, 256) || !int(b.expiresInSec)) shape();
      const r = b as { resetId: string; expiresInSec: number };
      return { resetId: r.resetId, expiresInSec: r.expiresInSec };
    },
    async verifyPasswordReset(resetId, code, password, remember) {
      return login(await call('POST', `${accountOrigin}/v1/auth/password/reset/verify`, [200], { body: { resetId, code, password, ...rem(remember) } }));
    },
    async refresh(refreshToken) {
      if (!refreshOk(refreshToken)) throw new CloudPortError('account.unauthorized');
      const r = login(await call('POST', `${accountOrigin}/v1/auth/refresh`, [200], { body: { refreshToken } }));
      if (r.refreshToken === undefined) shape();
      return r as Required<AccountLogin>;
    },
    async revokeRefresh(refreshToken) {
      if (!refreshOk(refreshToken)) return;
      await call('POST', `${accountOrigin}/v1/auth/refresh/revoke`, [204], { body: { refreshToken } });
    },
    async logoutAll(session) {
      await call('POST', `${accountOrigin}/v1/auth/logout-all`, [204], { headers: bearer(session), body: {} });
    },
    async logout(session) {
      await call('POST', `${accountOrigin}/v1/auth/logout`, [200, 204], { headers: bearer(session), body: {} });
    },
    async deviceList(session) {
      return pinnedList(await call('GET', `${accountOrigin}/v1/device-list`, [200], { headers: bearer(session) }));
    },
    async deviceListByDevice(auth) {
      const url = `${accountOrigin}/v1/device-list`;
      return pinnedList(await call('GET', url, [200], { headers: await authed(auth, 'GET', url) }));
    },
    async pinFirstDesktop(session, x) {
      const b = await call('POST', `${accountOrigin}/v1/aik`, [201], { headers: bearer(session), body: { aikPub: x.aikPub, deviceList: x.deviceList, platform: x.platform, name: x.name } });
      if (!isObj(b) || !str(b.deviceId, 64)) shape();
      return { deviceId: (b as { deviceId: string }).deviceId };
    },
    async deviceToken(cert, dpop, scopes) {
      try {
        // @sax/remote requestDeviceToken은 본문이 {cert}뿐이다. 범위를 줄일 때만 본문에 scopes를 더한다(DPoP는 인증서에 묶여 본문과 무관).
        const http: HttpJson = scopes ? (req) => httpJson({ ...req, body: JSON.stringify({ ...(JSON.parse(req.body!) as object), scopes: [...scopes] }) }) : httpJson;
        return await requestDeviceToken(http, accountOrigin, cert, dpop);
      } catch (e) {
        const code = (e as { code?: unknown }).code;
        throw new CloudPortError(typeof code === 'string' && (CODE.test(code) || code === 'response.shape') ? code : 'server.unknown');
      }
    },
    async billing(auth) {
      const su = `${accountOrigin}/v1/billing/subscription`;
      const sr = await call('GET', su, [200], { headers: await authed(auth, 'GET', su) });
      const s = (isObj(sr) ? sr : {}) as Record<string, unknown>;
      const e = (isObj(s.entitlement) ? s.entitlement : {}) as Record<string, unknown>;
      if (!['trial', 'paid', 'none'].includes(e.state as string) || !(e.until === null || int(e.until))) shape();
      if (!(s.subscription === null || isObj(s.subscription))) shape();
      const sub = s.subscription as Record<string, unknown> | null;
      if (sub && (!['pending', 'active', 'past_due', 'canceled'].includes(sub.status as string) || !(sub.renewAt === null || int(sub.renewAt)) || !int(sub.amountKrw))) shape();
      const rf = sub && isObj(sub.refund) ? (sub.refund as Record<string, unknown>) : null;
      if (rf && (!int(rf.refundableUntil) || !int(rf.amountKrw))) shape();
      return {
        entitlement: { state: e.state as 'trial' | 'paid' | 'none', until: e.until as number | null },
        subscription: sub ? { status: sub.status as 'pending' | 'active' | 'past_due' | 'canceled', renewAt: sub.renewAt as number | null, amountKrw: sub.amountKrw as number, refund: rf ? { refundableUntil: rf.refundableUntil as number, amountKrw: rf.amountKrw as number } : null } : null,
      };
    },
    async billingCheckout(auth) {
      const url = `${accountOrigin}/v1/billing/checkout`;
      const b = (await call('POST', url, [200], { headers: await authed(auth, 'POST', url) })) as Record<string, unknown> | null;
      // 결제 창은 우리 계정 origin의 카드 등록 창만(서버가 다른 주소를 주면 열지 않는다)
      if (!isObj(b) || !str(b.checkoutUrl, 512) || !(b.checkoutUrl as string).startsWith(`${accountOrigin}/v1/billing/card?ref=`)) shape();
      return { checkoutUrl: (b as Record<string, unknown>).checkoutUrl as string };
    },
    async billingCancel(auth) {
      const url = `${accountOrigin}/v1/billing/cancel`;
      await call('POST', url, [204], { headers: await authed(auth, 'POST', url) });
    },
    async billingRefund(auth) {
      const url = `${accountOrigin}/v1/billing/refund`;
      const b = (await call('POST', url, [200], { headers: await authed(auth, 'POST', url) })) as Record<string, unknown> | null;
      if (!isObj(b) || !int(b.amountKrw)) shape();
      return { amountKrw: (b as Record<string, unknown>).amountKrw as number };
    },
    async acctClaim(auth) {
      const url = `${accountOrigin}/v1/acct-claim`;
      const b = await call('GET', url, [200], { headers: await authed(auth, 'GET', url) });
      if (!isObj(b) || !isObj(b.claim) || !str(b.sig, 128)) shape();
      const c = (b as { claim: Record<string, unknown> }).claim;
      if (!str(c.account_id, 128) || !str(c.email, 254) || !str(c.aik_pub, 64) || !int(c.iat) || !int(c.exp)) shape();
      return b as unknown as SignedAcctClaim; // 응답 JSON 그대로(서명 검증은 폰이 고정 공개키로)
    },
    async enrollPhone(auth, x) {
      const url = `${accountOrigin}/v1/devices/enroll`;
      await call('POST', url, [200, 201], { headers: await authed(auth, 'POST', url), body: { deviceId: x.deviceId, role: x.role, platform: x.platform, name: x.name, Sx: x.Sx, Vx: x.Vx, roomId: x.roomId } });
    },
    async putDeviceList(auth, list) {
      const url = `${accountOrigin}/v1/device-list`;
      await call('PUT', url, [200], { headers: await authed(auth, 'PUT', url), body: { deviceList: list } });
    },
    async devices(auth) {
      const url = `${accountOrigin}/v1/devices`;
      return serverDevices(await call('GET', url, [200], { headers: await authed(auth, 'GET', url) }));
    },
    async devicesBySession(session) {
      return serverDevices(await call('GET', `${accountOrigin}/v1/devices`, [200], { headers: bearer(session) }));
    },
    async enrollDesktop(session, x) {
      await call('POST', `${accountOrigin}/v1/devices/enroll`, [201], { headers: bearer(session), body: { deviceId: x.deviceId, role: 'desktop', platform: x.platform, name: x.name, Sx: x.Sx, Vx: x.Vx } });
    },
    async pcLinkHello(session, deviceId, hello) {
      await call('PUT', linkUrl(deviceId), [204], { headers: bearer(session), body: { hello } });
    },
    async pcLinkAnswer(session, deviceId) {
      const b = await call('GET', linkUrl(deviceId), [200], { headers: bearer(session) });
      if (!isObj(b) || !('challenge' in b) || !('grant' in b)) shape();
      const r = b as { challenge: unknown; grant: unknown };
      return { challenge: r.challenge ?? null, grant: r.grant ?? null };
    },
    async pcLinkReveal(session, deviceId, reveal) {
      await call('POST', `${linkUrl(deviceId)}/reveal`, [204], { headers: bearer(session), body: { reveal } });
    },
    async pcLinkCancel(session, deviceId) {
      await call('DELETE', linkUrl(deviceId), [204], { headers: bearer(session) });
    },
    async pcLinks(auth) {
      const url = `${accountOrigin}/v1/pc-links`;
      const b = await call('GET', url, [200], { headers: await authed(auth, 'GET', url) });
      if (!isObj(b) || !Array.isArray(b.links) || b.links.length > 16) shape();
      return ((b as { links: unknown[] }).links).map((l): PcLinkRequest => {
        if (!isObj(l) || !str(l.deviceId, 36) || !UUID4.test(l.deviceId) || !str(l.name, 40) || !int(l.createdAt) || !isObj(l.hello)) shape();
        const x = l as Record<string, unknown>;
        if (x.platform !== 'windows' && x.platform !== 'macos') shape();
        if (!(x.challengedBy === null || (str(x.challengedBy, 36) && UUID4.test(x.challengedBy)))) shape();
        return { deviceId: x.deviceId as string, name: x.name as string, platform: x.platform as PcLinkRequest['platform'], createdAt: x.createdAt as number, hello: x.hello, challengedBy: x.challengedBy as string | null, reveal: x.reveal ?? null };
      });
    },
    async pcLinkChallenge(auth, deviceId, challenge) {
      const url = `${linkUrl(deviceId)}/challenge`;
      await call('POST', url, [204], { headers: await authed(auth, 'POST', url), body: { challenge } });
    },
    async pcLinkGrant(auth, deviceId, grant) {
      const url = `${linkUrl(deviceId)}/grant`;
      await call('POST', url, [204], { headers: await authed(auth, 'POST', url), body: { grant } });
    },
    async pcLinkDrop(auth, deviceId) {
      const url = linkUrl(deviceId);
      await call('DELETE', url, [204], { headers: await authed(auth, 'DELETE', url) });
    },
    async issueLock(auth) {
      const url = `${accountOrigin}/v1/issue-lock`;
      const b = await call('GET', url, [200], { headers: await authed(auth, 'GET', url) });
      if (!isObj(b) || typeof b.held !== 'boolean' || typeof b.mine !== 'boolean' || !(b.deviceId === null || typeof b.deviceId === 'string') || !(b.expiresAt === null || int(b.expiresAt))) shape();
      const r = b as { held: boolean; deviceId: string | null; expiresAt: number | null; mine: boolean };
      return { held: r.held, deviceId: r.deviceId, expiresAt: r.expiresAt, mine: r.mine };
    },
    async acquireIssueLock(auth) {
      const url = `${accountOrigin}/v1/issue-lock/acquire`;
      const b = await call('POST', url, [200], { headers: await authed(auth, 'POST', url), body: {} });
      if (!isObj(b) || typeof b.lockId !== 'string' || !ISSUE_LOCK_ID.test(b.lockId) || !int(b.expiresAt)) shape();
      const r = b as { lockId: string; expiresAt: number };
      return { lockId: r.lockId, expiresAt: r.expiresAt };
    },
    async renewIssueLock(auth, lockId) {
      const url = `${accountOrigin}/v1/issue-lock/renew`;
      const b = await call('POST', url, [200], { headers: await authed(auth, 'POST', url), body: { lockId } });
      if (!isObj(b) || !int(b.expiresAt)) shape();
      return { expiresAt: (b as { expiresAt: number }).expiresAt };
    },
    async releaseIssueLock(auth, lockId) {
      const url = `${accountOrigin}/v1/issue-lock/release`;
      await call('POST', url, [204], { headers: await authed(auth, 'POST', url), body: { lockId } });
    },
    async leaveDevice(auth) {
      const url = `${accountOrigin}/v1/devices/self/leave`;
      await call('POST', url, [204], { headers: await authed(auth, 'POST', url), body: {} });
    },
    async accountDeletion(auth) {
      const url = `${accountOrigin}/v1/account/deletion`;
      const b = await call('GET', url, [200], { headers: await authed(auth, 'GET', url) });
      if (!isObj(b) || !(b.deleteAfter === null || int(b.deleteAfter))) shape();
      return { deleteAfter: (b as { deleteAfter: number | null }).deleteAfter };
    },
    async requestAccountDelete(auth) {
      const url = `${accountOrigin}/v1/account/delete-request`;
      const b = await call('POST', url, [202], { headers: await authed(auth, 'POST', url), body: {} });
      if (!isObj(b) || !int(b.deleteAfter)) shape();
      return { deleteAfter: (b as { deleteAfter: number }).deleteAfter };
    },
    async cancelAccountDelete(auth) {
      const url = `${accountOrigin}/v1/account/delete-cancel`;
      await call('POST', url, [204], { headers: await authed(auth, 'POST', url), body: {} });
    },
  };

  const relay: RelayHttpClient = {
    async createRoom(auth, roomId) {
      const url = `${relayHttpOrigin}/v1/rooms`;
      const id = bytes(roomId, 16);
      const b = await call('POST', url, [201], { headers: await authed(auth, 'POST', url), body: { roomId: id } });
      if (!isObj(b) || !int(b.expiresAt)) shape();
      return { expiresAt: (b as { expiresAt: number }).expiresAt };
    },
    async registerMailbox(auth, mbxId, tokRead, tokWrite) {
      const url = `${relayHttpOrigin}/v1/mailboxes`;
      const body = { mbxId: bytes(mbxId, 32), tokRead: bytes(tokRead, 32), tokWrite: bytes(tokWrite, 32) };
      await call('POST', url, [201], { headers: await authed(auth, 'POST', url), body });
    },
    async deleteMailbox(auth, mbxId, tokWrite) {
      const url = `${relayHttpOrigin}/v1/mailboxes/${bytes(mbxId, 32)}`;
      await call('DELETE', url, [204], { headers: { ...(await authed(auth, 'DELETE', url)), 'x-mbx-write': bytes(tokWrite, 32) } });
    },
  };

  return {
    account,
    relay,
    relayHost,
    accountOrigin,
    insecureLocal: dev,
    mailboxQueue(mbxId, tok, auth) {
      return relayQueue({ http: httpJson, origin: relayHttpOrigin, mbxId, tok, deviceAuth: (htm, htu) => auth(htm, htu) });
    },
    openSocket(url, headers) {
      try {
        return o.egress.openCloudSocket(url, headers) as unknown as WebSocketLike;
      } catch (e) {
        throw new CloudPortError(e instanceof EgressError ? `net.${e.code}` : 'net.network');
      }
    },
  };
}
