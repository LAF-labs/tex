// 계정·릴레이 클라우드 포트(데스크톱 main 전용, 팀장 결정 2026-11-06 (가)). 포트 정본은 remote-ports.ts(#143), 서버 정본은
// services/account/API.md·services/relay/API.md. 송신은 @sax/net Egress.cloud()·openCloudSocket()으로만 한다(D01 §3).
// 이 모듈은 아무것도 저장하지 않는다: 계정 세션·기기 토큰은 호출자(main 메모리)가 넘기고, 응답의 토큰은 그대로 돌려줄 뿐 파일·로그에 두지 않는다.
// 오류는 Error.code에 서버 코드(`<영역>.<코드>`) 또는 `net.<egress 코드>`만 담는다. 메시지에 본문·URL·토큰·이메일을 넣지 않는다.
import { CLOUD_ORIGIN, CLOUD_WS_HOST, EgressError, type CloudMethod, type Egress } from '@sax/net';
import type { AccountClient, AccountLogin, CloudPorts, DeviceAuth, RelayHttpClient } from './remote-ports.ts';
import {
  b64url,
  relayOrigin,
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
      const b = await call('GET', `${accountOrigin}/v1/device-list`, [200], { headers: bearer(session) });
      if (!isObj(b) || !(b.aikPub === null || str(b.aikPub, 64)) || !(b.deviceList === null || isObj(b.deviceList))) shape();
      const r = b as { aikPub: string | null; deviceList: DeviceListJson | null };
      return { aikPub: r.aikPub, deviceList: r.deviceList };
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
    insecureLocal: dev,
    openSocket(url, headers) {
      try {
        return o.egress.openCloudSocket(url, headers) as unknown as WebSocketLike;
      } catch (e) {
        throw new CloudPortError(e instanceof EgressError ? `net.${e.code}` : 'net.network');
      }
    },
  };
}
