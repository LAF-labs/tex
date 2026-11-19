// 계정·구독 API 라우트(services/account/API.md가 계약 문서). 요청은 모두 스키마로 검증하고 스키마 밖 필드는 400.
import {
  DailySalt,
  DeviceAuth,
  Router,
  S,
  fail,
  json,
  memoryLimits,
  randomToken,
  validator,
  ALL_SCOPES,
  type Ctx,
  type Scope,
  type InternalCheck,
  type DeviceDirectory,
  type TokenVerifier,
  type Limits,
} from '@sax/svc-shared';
import { deviceListSchema, signedCertSchema, signedOpSchema, type AcctOp, type DeviceList, type SignedCert } from './aik.ts';
import { ACCOUNT, DEVICE, ISSUE_LOCK, MS, PASSWORD, KEY_ESCROW, PC_LINK, SHARE } from './constants.ts';
import { pageHeaders } from './pg-toss.ts';
import { withFloor } from './password.ts';
import type { AccountService, AuthMethod, BillingCaller, Session, ShareKind } from './service.ts';

const obj = (properties: Record<string, unknown>, required: string[] = Object.keys(properties)) => ({ type: 'object', additionalProperties: false, required, properties });
const b64u = (min: number, max: number) => ({ type: 'string', pattern: `^[A-Za-z0-9_-]{${min},${max}}$` });

/** 봉인한 계정 열쇠(32바이트 + 태그 16바이트, base64 64자) */
const SEALED_KEY = { type: 'string', pattern: '^[A-Za-z0-9+/]{64}$' } as const;
const EMAIL = { type: 'string', minLength: 3, maxLength: 254 } as const;
/** 요청 상한만(정규화 전). 길이 정책 10~128자(NFKC 코드 포인트)는 서버 정책 검사가 판정한다 */
const PASSWORD_IN = { type: 'string', minLength: 1, maxLength: 1024 } as const;
const REMEMBER = { type: 'boolean' } as const;
/** 계정 공유 기록의 줄 id: 무작위 16B의 base64url */
const SHARE_ROW_ID = { type: 'string', pattern: '^[A-Za-z0-9_-]{22}$' } as const;
const REFRESH_TOKEN = { type: 'string', pattern: '^sxa1\\.[A-Za-z0-9_-]{43}$' } as const;

const V = {
  codeStart: validator<{ email: string }>(obj({ email: EMAIL })),
  codeVerify: validator<{ loginId: string; code: string; remember?: boolean }>(obj({ loginId: S.token, code: { type: 'string', pattern: '^[0-9]{6}$' }, remember: REMEMBER }, ['loginId', 'code'])),
  passwordLogin: validator<{ email: string; password: string; remember?: boolean }>(obj({ email: EMAIL, password: PASSWORD_IN, remember: REMEMBER }, ['email', 'password'])),
  passwordSet: validator<{ password: string; currentPassword?: string }>(obj({ password: PASSWORD_IN, currentPassword: PASSWORD_IN }, ['password'])),
  reauthVerify: validator<{ reauthId: string; code: string }>(obj({ reauthId: S.token, code: { type: 'string', pattern: '^[0-9]{6}$' } })),
  resetStart: validator<{ email: string }>(obj({ email: EMAIL })),
  resetVerify: validator<{ resetId: string; code: string; password: string; remember?: boolean }>(
    obj({ resetId: S.token, code: { type: 'string', pattern: '^[0-9]{6}$' }, password: PASSWORD_IN, remember: REMEMBER }, ['resetId', 'code', 'password']),
  ),
  refresh: validator<{ refreshToken: string }>(obj({ refreshToken: REFRESH_TOKEN })),
  authorize: validator<{ client_id: string; redirect_uri: string; code_challenge: string; code_challenge_method: string; state: string }>(
    obj({ client_id: { type: 'string', maxLength: 64 }, redirect_uri: { type: 'string', maxLength: 200 }, code_challenge: b64u(43, 43), code_challenge_method: { const: 'S256' }, state: b64u(16, 128) }),
  ),
  token: validator<{ grant_type: string; code: string; code_verifier: string; redirect_uri: string; client_id: string; remember?: boolean }>(
    obj(
      { grant_type: { const: 'authorization_code' }, code: S.token, code_verifier: { type: 'string', pattern: '^[A-Za-z0-9._~-]{43,128}$' }, redirect_uri: { type: 'string', maxLength: 200 }, client_id: { type: 'string', maxLength: 64 }, remember: REMEMBER },
      ['grant_type', 'code', 'code_verifier', 'redirect_uri', 'client_id'],
    ),
  ),
  passkeyRegister: validator<{ challenge: string; clientDataJSON: string; attestationObject: string }>(obj({ challenge: S.token, clientDataJSON: b64u(1, 6000), attestationObject: b64u(1, 11000) })),
  passkeyLogin: validator<{ challenge: string; credentialId: string; clientDataJSON: string; authenticatorData: string; signature: string; userHandle?: string; remember?: boolean }>(
    obj(
      { challenge: S.token, credentialId: b64u(16, 1400), clientDataJSON: b64u(1, 6000), authenticatorData: b64u(37, 1400), signature: b64u(64, 200), userHandle: b64u(1, 100), remember: REMEMBER },
      ['challenge', 'credentialId', 'clientDataJSON', 'authenticatorData', 'signature'],
    ),
  ),
  consent: validator<{ version: string }>(obj({ version: { type: 'string', pattern: '^[a-z0-9.-]{1,32}$' } })),
  pinAik: validator<{ aikPub: string; deviceList: DeviceList; platform: string; name: string; escrow?: { enc: string; ct: string } }>(
    obj(
      { aikPub: S.b64key32, deviceList: deviceListSchema, platform: { enum: ['windows', 'macos'] }, name: { type: 'string', minLength: 1, maxLength: 40 }, escrow: obj({ enc: S.b64key32, ct: SEALED_KEY }) },
      ['aikPub', 'deviceList', 'platform', 'name'],
    ),
  ),
  enroll: validator<{ deviceId: string; role: 'desktop' | 'mobile'; platform: string; name: string; Sx: string; Vx: string }>(
    obj({ deviceId: S.uuid4, role: { enum: ['desktop', 'mobile'] }, platform: { enum: ['windows', 'macos', 'ios', 'android'] }, name: { type: 'string', minLength: 1, maxLength: 40 }, Sx: S.b64key32, Vx: S.b64key32 }),
  ),
  deviceList: validator<{ deviceList: DeviceList }>(obj({ deviceList: deviceListSchema })),
  /** PC가 폰을 대신 등록(페어링 7단계). roomId는 그 PC가 만든 1회용 페어링 룸(16B base64url, D08 §4.2) */
  enrollMobile: validator<{ deviceId: string; role: 'mobile'; platform: 'ios' | 'android'; name: string; Sx: string; Vx: string; roomId: string }>(
    obj({ deviceId: S.uuid4, role: { const: 'mobile' }, platform: { enum: ['ios', 'android'] }, name: { type: 'string', minLength: 1, maxLength: 40 }, Sx: S.b64key32, Vx: S.b64key32, roomId: { type: 'string', pattern: '^[A-Za-z0-9_-]{22}$' } }),
  ),
  op: validator<{ op: AcctOp; aikSig: string }>(signedOpSchema),
  /** scopes(선택): 범위 축소(ADR-040 결정 1). 비어 있지 않고 중복 없는 알려진 범위 이름 */
  // model: 기기가 알린 모델 이름(예: "iPhone 16 Pro", "MacBook Pro"). 있으면 목록의 기기 이름을 이것으로 고친다(2026-11-19 대표)
  deviceToken: validator<{ cert: SignedCert; scopes?: Scope[]; model?: string }>(obj({ cert: signedCertSchema, scopes: { type: 'array', minItems: 1, maxItems: ALL_SCOPES.length, uniqueItems: true, items: { enum: [...ALL_SCOPES] } }, model: { type: 'string', minLength: 1, maxLength: 40 } }, ['cert'])),
  linkId: validator<{ id: string }>(obj({ id: S.uuid4 })),
  // 새 PC 연결 우편함(D08 §4.3). 모양과 크기만 본다. 약속·6자리·서명·봉인문의 진위는 두 PC가 본다
  pcLinkHello: validator<{ hello: { v: 1; device_id: string; Sx: string; Vx: string; Hx: string; commit: string } }>(
    obj({ hello: obj({ v: { const: 1 }, device_id: S.uuid4, Sx: S.b64key32, Vx: S.b64key32, Hx: S.b64key32, commit: S.b64key32 }) }),
  ),
  pcLinkChallenge: validator<{ challenge: { v: 1; device_id: string; aik_pub: string; nonce: string } }>(obj({ challenge: obj({ v: { const: 1 }, device_id: S.uuid4, aik_pub: S.b64key32, nonce: S.b64key32 }) })),
  pcLinkReveal: validator<{ reveal: { v: 1; nonce: string } }>(obj({ reveal: obj({ v: { const: 1 }, nonce: S.b64key32 }) })),
  pcLinkGrant: validator<{ grant: { v: 1; cert: SignedCert; deviceList: DeviceList; enc: string; ct: string } }>(
    obj({ grant: obj({ v: { const: 1 }, cert: signedCertSchema, deviceList: deviceListSchema, enc: S.b64key32, ct: { type: 'string', pattern: '^[A-Za-z0-9+/]{64}$' } }) }),
  ),
  // 계정 열쇠 보관(ADR-050). 봉인문은 모양과 크기만 본다(진위는 서비스가 열어서 본다)
  keyEscrowPut: validator<{ enc: string; ct: string }>(obj({ enc: S.b64key32, ct: SEALED_KEY })),
  keyEscrowReset: validator<{ deviceId: string; aikPub: string; deviceList: DeviceList; enc: string; ct: string }>(
    obj({ deviceId: S.uuid4, aikPub: S.b64key32, deviceList: deviceListSchema, enc: S.b64key32, ct: SEALED_KEY }),
  ),
  keyEscrowClaim: validator<{ deviceId: string; Hx: string }>(obj({ deviceId: S.uuid4, Hx: S.b64key32 })),
  keyEscrowJoin: validator<{ deviceId: string; deviceList: DeviceList }>(obj({ deviceId: S.uuid4, deviceList: deviceListSchema })),
  issueLockId: validator<{ lockId: string }>(obj({ lockId: S.token })),
  // 계정 공유 기록(D07 §10). 본문은 암호문이라 모양(b64url)과 크기만 본다
  shareRowId: validator<{ id: string }>(obj({ id: SHARE_ROW_ID })),
  shareRow: validator<{ kind: ShareKind; epoch: number; body: string; taskId?: string }>(
    obj(
      { kind: { enum: [...SHARE.kinds] }, epoch: { type: 'integer', minimum: 0, maximum: SHARE.maxEpoch }, body: { type: 'string', pattern: '^[A-Za-z0-9_-]+$', minLength: 64, maxLength: SHARE.maxBodyChars }, taskId: SHARE_ROW_ID },
      ['kind', 'epoch', 'body'],
    ),
  ),
  bindBiz: validator<{ bizHmac: string; rkOp?: { op: AcctOp; aikSig: string } }>(obj({ bizHmac: S.hex32, rkOp: signedOpSchema }, ['bizHmac'])),
} as const;

const PLATFORM_ROLE: Record<string, 'desktop' | 'mobile'> = { windows: 'desktop', macos: 'desktop', ios: 'mobile', android: 'mobile' };

export interface AccountAppOpts {
  svc: AccountService;
  /** 이 서비스가 발급한 기기 토큰을 검증(기기 범위 엔드포인트용) */
  verifier: TokenVerifier;
  publicOrigin: string;
  /** 내부 경로(/internal/*) 서명 검사(INTERNAL_CALL_KEY HMAC, 팀장 결정 2026-11-06 #135) */
  internal: InternalCheck;
  /** 한도 카운터·키 솔트. 없으면 메모리(단일 인스턴스). 운영은 sqlLimits(db) */
  limits?: Limits;
}

export function accountRouter(o: AccountAppOpts): Router {
  const { svc } = o;
  const r = new Router();
  // 한도: 카운터와 키 솔트는 다중 인스턴스면 DB(팀장 결정 2026-11-05 (가)), 로그용 aid 솔트는 인스턴스 메모리
  const limits = o.limits ?? memoryLimits(svc.now);
  const ipSalt = limits.salt('ip');
  const emailSalt = limits.salt('email');
  const devSalt = limits.idSalt('dev');
  const idSalt = new DailySalt('aid', svc.now);
  const directory: DeviceDirectory = { get: (id) => svc.deviceRecord(id) };
  const deviceAuth = new DeviceAuth({ verifier: o.verifier, directory, publicOrigin: o.publicOrigin, now: svc.now });

  const limit = async (key: string, n: number, windowMs: number) => {
    const h = await limits.limiter.hit(key, n, windowMs);
    if (!h.ok) fail('policy.rate_limited', { retryAfterSec: h.retryAfterSec });
  };
  const ipKey = (ctx: Ctx) => ipSalt.hash(ctx.ip);
  /** 로그인 응답. remember면 갱신 토큰을 함께 준다(자동 로그인, ADR-038 (f)) */
  const loggedIn = async (ctx: Ctx, out: { session: string; accountId: string }, method: AuthMethod, remember: boolean | undefined) => {
    ctx.logAid = idSalt.hash(out.accountId);
    const body: Record<string, unknown> = { session: out.session, expiresInSec: ACCOUNT.sessionTtlMs / 1000 };
    if (remember) {
      body.refreshToken = await svc.issueRefresh(out.accountId, method);
      body.refreshExpiresInSec = ACCOUNT.refreshTtlMs / 1000;
    }
    return json(200, body);
  };
  const passwordsOn = () => {
    if (!svc.passwordsEnabled) fail('request.not_found');
  };
  const session = async (ctx: Ctx): Promise<Session> => {
    const s = await svc.session(ctx.headers.authorization);
    ctx.logAid = idSalt.hash(s.accountId);
    return s;
  };
  const device = async (ctx: Ctx, scope: 'devlist' | 'slots' | 'acct_op') => {
    const c = await deviceAuth.check(ctx, scope, 'account.unauthorized', 'account.device_suspended');
    ctx.logAid = idSalt.hash(c.acc);
    return c;
  };
  /** 세션 또는 기기 토큰(읽기 전용 조회) */
  /**
   * 구독 경로: 계정 세션 또는 데스크톱 기기 토큰(devlist 범위). 데스크톱은 기기 등록 뒤 계정 세션을 버리므로(remote-account) 앱의 구독 화면은
   * 기기 토큰으로 부른다. 폰 토큰은 거부(구독·해지·환불은 PC에서).
   */
  const billingAuth = async (ctx: Ctx): Promise<BillingCaller> => {
    if (String(ctx.headers.authorization ?? '').startsWith('DPoP ')) {
      const c = await device(ctx, 'devlist');
      if (c.role !== 'desktop') fail('account.scope_denied');
      return { accountId: c.acc };
    }
    return session(ctx);
  };
  const sessionOrDevice = async (ctx: Ctx): Promise<string> => {
    const auth = String(ctx.headers.authorization ?? '');
    if (auth.startsWith('DPoP ')) return (await device(ctx, 'devlist')).acc;
    return (await session(ctx)).accountId;
  };
  /** 기기 관리(ADR-048 결정 6): 데스크톱(devlist) 또는 폰(devices) 기기 토큰. 목록 보기·스스로 나가기·다른 기기 정지 */
  const deviceMgmt = async (ctx: Ctx) => {
    const c = await deviceAuth.check(ctx, ['devlist', 'devices'], 'account.unauthorized', 'account.device_suspended');
    ctx.logAid = idSalt.hash(c.acc);
    return c;
  };

  // 로그인
  r.add('POST', '/v1/auth/code', async (ctx) => {
    const b = V.codeStart(ctx.body);
    await limit(`code-ip:${await ipKey(ctx)}`, ACCOUNT.loginCodeSendsPerIpHour, MS.H);
    await limit(`code-email:${await emailSalt.hash(b.email.trim().toLowerCase())}`, ACCOUNT.loginCodeSendsPerEmailHour, MS.H);
    return json(200, await svc.startEmailCode(b.email));
  });
  r.add('POST', '/v1/auth/code/verify', async (ctx) => {
    const b = V.codeVerify(ctx.body);
    await limit(`auth-ip:${await ipKey(ctx)}`, ACCOUNT.authAttemptsPerIpHour, MS.H);
    const out = await svc.verifyEmailCode(b.loginId, b.code);
    return loggedIn(ctx, out, 'email_code', b.remember);
  });
  r.add('POST', '/v1/auth/passkey/options', async (ctx) => {
    await limit(`auth-ip:${await ipKey(ctx)}`, ACCOUNT.authAttemptsPerIpHour, MS.H);
    return json(200, await svc.passkeyLoginOptions());
  });
  r.add('POST', '/v1/auth/passkey/verify', async (ctx) => {
    const b = V.passkeyLogin(ctx.body);
    await limit(`auth-ip:${await ipKey(ctx)}`, ACCOUNT.authAttemptsPerIpHour, MS.H);
    const { remember, ...assertion } = b;
    const out = await svc.passkeyLogin(b.challenge, assertion);
    return loggedIn(ctx, out, 'passkey', remember);
  });
  r.add('POST', '/v1/auth/logout', async (ctx) => {
    await svc.logout(ctx.headers.authorization);
    return json(204, undefined);
  });
  /** [모든 기기에서 로그아웃]: 계정 세션·갱신 토큰 전부. 기기 범위 토큰·기기 등록은 그대로 */
  r.add('POST', '/v1/auth/logout-all', async (ctx) => {
    await svc.logoutAll(await session(ctx));
    return json(204, undefined);
  });

  // 비밀번호(ADR-038). 응답 시각 하한은 계정 존재·잠금과 무관하게 같다(열거 방지). IP 한도는 하한 밖(이유가 계정과 무관)
  r.add('POST', '/v1/auth/password', async (ctx) => {
    passwordsOn();
    const b = V.passwordLogin(ctx.body);
    await limit(`auth-ip:${await ipKey(ctx)}`, ACCOUNT.authAttemptsPerIpHour, MS.H);
    const out = await withFloor(PASSWORD.responseFloorMs, () => svc.passwordLogin(b.email, b.password));
    return loggedIn(ctx, out, 'password', b.remember);
  });
  r.add('PUT', '/v1/password', async (ctx) => {
    passwordsOn();
    const s = await session(ctx);
    const b = V.passwordSet(ctx.body);
    // 바꾸기의 현재 비밀번호 대조는 로그인과 같은 잠금·같은 하한(서비스가 맞춘다, 사용자 확정 2026-11-09)
    const out = await svc.setPassword(s, b.password, b.currentPassword);
    // 바꾸기: 옛 갱신 토큰은 모두 폐기됐고 이 기기용 새 토큰을 준다(자동 로그인 유지). 만들기는 204 그대로
    if (out.refreshToken) return json(200, { refreshToken: out.refreshToken, refreshExpiresInSec: ACCOUNT.refreshTtlMs / 1000 });
    return json(204, undefined);
  });
  // 계정 설정 재인증: 이메일 코드로 이 세션의 인증 시각을 갱신한다(새 세션 없음). 보내기 한도는 로그인 코드와 같은 이메일 묶음
  r.add('POST', '/v1/auth/reauth', async (ctx) => {
    passwordsOn();
    const s = await session(ctx);
    await limit(`code-ip:${await ipKey(ctx)}`, ACCOUNT.loginCodeSendsPerIpHour, MS.H);
    await limit(`code-email:${await emailSalt.hash((await svc.accountEmail(s.accountId)).trim().toLowerCase())}`, ACCOUNT.loginCodeSendsPerEmailHour, MS.H);
    return json(200, await svc.startReauth(s));
  });
  r.add('POST', '/v1/auth/reauth/verify', async (ctx) => {
    passwordsOn();
    const s = await session(ctx);
    const b = V.reauthVerify(ctx.body);
    await limit(`auth-ip:${await ipKey(ctx)}`, ACCOUNT.authAttemptsPerIpHour, MS.H);
    const out = await svc.finishReauth(s, b.reauthId, b.code);
    return json(200, { authAt: out.authAt, reauthMaxAgeSec: PASSWORD.reauthMaxAgeMs / 1000 });
  });
  r.add('DELETE', '/v1/password', async (ctx) => {
    passwordsOn();
    await svc.deletePassword(await session(ctx));
    return json(204, undefined);
  });
  r.add('POST', '/v1/auth/password/reset', async (ctx) => {
    passwordsOn();
    const b = V.resetStart(ctx.body);
    await limit(`reset-ip:${await ipKey(ctx)}`, PASSWORD.resetSendsPerIpHour, MS.H);
    await limit(`reset-email:${await emailSalt.hash(b.email.trim().toLowerCase())}`, PASSWORD.resetSendsPerEmailHour, MS.H);
    return json(200, await withFloor(PASSWORD.responseFloorMs, () => svc.startPasswordReset(b.email)));
  });
  r.add('POST', '/v1/auth/password/reset/verify', async (ctx) => {
    passwordsOn();
    const b = V.resetVerify(ctx.body);
    await limit(`auth-ip:${await ipKey(ctx)}`, ACCOUNT.authAttemptsPerIpHour, MS.H);
    const out = await svc.finishPasswordReset(b.resetId, b.code, b.password);
    return loggedIn(ctx, out, 'email_code', b.remember);
  });

  // 자동 로그인: 갱신 토큰 회전(ADR-038 (f)). 실패는 이유를 가르지 않고 401
  r.add('POST', '/v1/auth/refresh', async (ctx) => {
    const b = V.refresh(ctx.body);
    await limit(`refresh-ip:${await ipKey(ctx)}`, ACCOUNT.authAttemptsPerIpHour, MS.H);
    const out = await svc.refresh(b.refreshToken);
    ctx.logAid = idSalt.hash(out.accountId);
    return json(200, { session: out.session, expiresInSec: ACCOUNT.sessionTtlMs / 1000, refreshToken: out.refreshToken, refreshExpiresInSec: ACCOUNT.refreshTtlMs / 1000 });
  });
  r.add('POST', '/v1/auth/refresh/revoke', async (ctx) => {
    const b = V.refresh(ctx.body);
    await svc.revokeRefresh(b.refreshToken);
    return json(204, undefined);
  });

  // 데스크톱 루프백 + PKCE
  r.add('POST', '/v1/oauth/authorize', async (ctx) => {
    const s = await session(ctx);
    const b = V.authorize(ctx.body);
    return json(200, await svc.authorize(s, { clientId: b.client_id, redirectUri: b.redirect_uri, codeChallenge: b.code_challenge, method: b.code_challenge_method, state: b.state }));
  });
  r.add('POST', '/v1/oauth/token', async (ctx) => {
    const b = V.token(ctx.body);
    await limit(`auth-ip:${await ipKey(ctx)}`, ACCOUNT.authAttemptsPerIpHour, MS.H);
    const out = await svc.exchangeCode({ code: b.code, verifier: b.code_verifier, redirectUri: b.redirect_uri, clientId: b.client_id });
    return loggedIn(ctx, out, out.authMethod, b.remember);
  });

  // 패스키 등록
  r.add('POST', '/v1/passkeys/options', async (ctx) => json(200, await svc.passkeyRegisterOptions(await session(ctx))));
  r.add('POST', '/v1/passkeys', async (ctx) => {
    const s = await session(ctx);
    const b = V.passkeyRegister(ctx.body);
    return json(201, await svc.passkeyRegister(s, b.challenge, b));
  });

  // 계정
  r.add('GET', '/v1/me', async (ctx) => json(200, await svc.me(await session(ctx))));
  r.add('POST', '/v1/consents', async (ctx) => {
    const s = await session(ctx);
    await svc.consent(s, V.consent(ctx.body).version);
    return json(204, undefined);
  });

  // 탈퇴(7일 유예). 계정 세션 또는 데스크톱 기기 토큰(데스크톱은 등록 뒤 세션을 버리고 기기 토큰만 갖는다). 폰 토큰은 거부
  const sessionOrDesktop = async (ctx: Ctx): Promise<string> => {
    if (!String(ctx.headers.authorization ?? '').startsWith('DPoP ')) return (await session(ctx)).accountId;
    const c = await device(ctx, 'devlist');
    if (c.role !== 'desktop') fail('account.scope_denied');
    return c.acc;
  };
  r.add('GET', '/v1/account/deletion', async (ctx) => json(200, await svc.accountDeletion(await sessionOrDesktop(ctx))));
  r.add('POST', '/v1/account/delete-request', async (ctx) => json(202, await svc.requestAccountDelete(await sessionOrDesktop(ctx))));
  r.add('POST', '/v1/account/delete-cancel', async (ctx) => {
    await svc.cancelAccountDelete(await sessionOrDesktop(ctx));
    return json(204, undefined);
  });

  // 구독·결제
  r.add('POST', '/v1/billing/checkout', async (ctx) => json(200, await svc.checkout(await billingAuth(ctx))));
  r.add('GET', '/v1/billing/subscription', async (ctx) => {
    const who = await billingAuth(ctx);
    // 구독 화면은 한 번에: 구독과 유료 기능 권리
    return json(200, { subscription: await svc.subscription(who), entitlement: await svc.entitlementOf(who) });
  });
  r.add('GET', '/v1/billing/entitlement', async (ctx) => json(200, await svc.entitlementOf(await billingAuth(ctx))));
  r.add('POST', '/v1/billing/refund', async (ctx) => json(200, await svc.refundSubscription(await billingAuth(ctx))));
  r.add('POST', '/v1/billing/cancel', async (ctx) => {
    await svc.cancelSubscription(await billingAuth(ctx));
    return json(204, undefined);
  });
  // 카드 정기결제(빌링키 PG) 창·돌아옴. 브라우저가 여는 HTML이라 세션 없이 열린다(참조는 그 계정만 받은 무작위 값). 모의 PG면 404
  const page = (r: { status: number; html: string }, nonce: string) => ({ status: r.status, raw: r.html, headers: pageHeaders(nonce) });
  r.add('GET', '/v1/billing/card', async (ctx) => {
    const nonce = randomToken(16);
    return page(await svc.billingCardPage(ctx.query.get('ref') ?? '', nonce), nonce);
  });
  r.add('GET', '/v1/billing/card/success', async (ctx) => {
    const nonce = randomToken(16);
    return page(await svc.billingCardSuccess(ctx.query.get('customerKey') ?? '', ctx.query.get('authKey') ?? '', nonce), nonce);
  });
  r.add('GET', '/v1/billing/card/fail', async (ctx) => {
    const nonce = randomToken(16);
    return page(svc.billingCardFail(ctx.query.get('code') ?? '', nonce), nonce);
  });
  r.add(
    'POST',
    '/v1/billing/webhook',
    async (ctx) => {
      await svc.paymentWebhook(ctx.rawBody, ctx.headers);
      return json(200, { ok: true });
    },
    { raw: true, maxBodyBytes: 16 * 1024 },
  );

  // 기기(계정 세션)
  r.add('POST', '/v1/aik', async (ctx) => {
    const s = await session(ctx);
    const b = V.pinAik(ctx.body);
    return json(201, await svc.pinFirstDesktop(s, b));
  });
  /** 기기 목록 읽기: 계정 세션, 데스크톱(devlist) 또는 폰(devices) 기기 토큰 */
  const sessionOrMgmt = async (ctx: Ctx): Promise<string> =>
    String(ctx.headers.authorization ?? '').startsWith('DPoP ') ? (await deviceMgmt(ctx)).acc : (await session(ctx)).accountId;
  r.add('GET', '/v1/devices', async (ctx) => json(200, { devices: await svc.listDevices(await sessionOrMgmt(ctx)) }));
  // 연결 끊기(기기 토큰, ADR-048 결정 6). 이 기기가 스스로 나감: 바로 폐기
  r.add('POST', '/v1/devices/self/leave', async (ctx) => {
    const c = await deviceMgmt(ctx);
    await svc.leave({ accountId: c.acc, deviceId: c.dev });
    return json(204, undefined);
  });
  // 다른 기기 정지(잃어버린 폰·PC): 바로 정지 + 7일 뒤 폐기 예약
  r.add('POST', '/v1/devices/:id/stop', async (ctx) => {
    const c = await deviceMgmt(ctx);
    await limit(`devstop:${await devSalt.hash(c.dev)}`, DEVICE.stopsPerDeviceDay, MS.D);
    return json(202, await svc.stopByDevice({ accountId: c.acc, deviceId: c.dev }, ctx.params.id!));
  });
  r.add('POST', '/v1/devices/enroll', async (ctx) => {
    // 데스크톱 기기 토큰(DPoP)이면 폰 대리 등록(페어링 룸 소비 필요), 아니면 계정 세션 등록
    if (String(ctx.headers.authorization ?? '').startsWith('DPoP ')) {
      const c = await device(ctx, 'devlist');
      if (c.role !== 'desktop') fail('account.scope_denied');
      const b = V.enrollMobile(ctx.body);
      // 같은 폰(같은 키)의 재등록은 멱등 200(룸 소비·상한 계산 없음), 새 등록은 201
      const { created, ...out } = await svc.enrollByDesktop({ accountId: c.acc, deviceId: c.dev }, b);
      return json(created ? 201 : 200, created ? { holdUntil: out.holdUntil } : out);
    }
    const s = await session(ctx);
    const b = V.enroll(ctx.body);
    if (PLATFORM_ROLE[b.platform] !== b.role) fail('request.param_rejected');
    return json(201, await svc.enroll(s, b));
  });
  r.add('POST', '/v1/devices/:id/activate', async (ctx) => {
    await svc.activateAfterHold(await session(ctx), ctx.params.id!);
    return json(204, undefined);
  });
  r.add('POST', '/v1/devices/:id/suspend', async (ctx) => {
    await svc.suspend(await session(ctx), ctx.params.id!);
    return json(204, undefined);
  });
  r.add('POST', '/v1/devices/:id/delete-request', async (ctx) => json(202, await svc.requestDelete(await session(ctx), ctx.params.id!)));
  r.add('POST', '/v1/devices/:id/delete-cancel', async (ctx) => {
    await svc.cancelDelete(await session(ctx), ctx.params.id!);
    return json(204, undefined);
  });
  r.add('GET', '/v1/device-list', async (ctx) => json(200, await svc.deviceList(await sessionOrMgmt(ctx))));
  // 서버 서명 계정 클레임(페어링 7단계, PC가 PAIR_OK에 싣는다). 데스크톱 기기 토큰만
  r.add('GET', '/v1/acct-claim', async (ctx) => {
    const c = await device(ctx, 'devlist');
    if (c.role !== 'desktop') fail('account.scope_denied');
    await limit(`acctclaim:${await devSalt.hash(c.dev)}`, DEVICE.acctClaimsPerHour, MS.H);
    return json(200, await svc.acctClaim({ accountId: c.acc, deviceId: c.dev }));
  });

  // 기기(데스크톱 기기 범위 토큰 + DPoP + AIK 서명)
  r.add('PUT', '/v1/device-list', async (ctx) => {
    const c = await device(ctx, 'devlist');
    const b = V.deviceList(ctx.body);
    return json(200, await svc.updateDeviceList({ accountId: c.acc, deviceId: c.dev }, b.deviceList));
  });
  r.add('POST', '/v1/devices/:id/reactivate', async (ctx) => {
    const c = await device(ctx, 'acct_op');
    await svc.reactivate({ accountId: c.acc, deviceId: c.dev }, ctx.params.id!, V.op(ctx.body));
    return json(204, undefined);
  });

  // 기기 범위 토큰 발급(인증서 + DPoP)
  r.add('POST', '/v1/device-tokens', async (ctx) => {
    const b = V.deviceToken(ctx.body);
    // 검증 전에는 IP 단위만(서명 검증 비용), 기기 단위는 검증 통과 뒤에 센다
    await limit(`devtok-ip:${await ipKey(ctx)}`, DEVICE.deviceTokenAttemptsPerIpHour, MS.H);
    const dpop = ctx.headers.dpop;
    const out = await svc.issueDeviceToken(b.cert, Array.isArray(dpop) ? undefined : dpop, o.publicOrigin + ctx.path, async () => limit(`devtok:${await devSalt.hash(b.cert.cert.device_id)}`, DEVICE.deviceTokensPerHour, MS.H), b.scopes, b.model);
    return json(200, out);
  });

  // 프로필 슬롯·사업자 HMAC(데스크톱 기기 범위 토큰)
  r.add('POST', '/v1/slots', async (ctx) => json(201, await svc.createSlot((await device(ctx, 'slots')).acc)));
  r.add('GET', '/v1/slots', async (ctx) => json(200, { slots: await svc.listSlots(await sessionOrDevice(ctx)) }));
  r.add('PUT', '/v1/slots/:slot/biz', async (ctx) => {
    const c = await device(ctx, 'slots');
    const b = V.bindBiz(ctx.body);
    return json(200, await svc.bindBiz(c.acc, ctx.params.slot!, b.bizHmac, b.rkOp));
  });
  r.add('DELETE', '/v1/slots/:slot', async (ctx) => {
    await svc.deleteSlot((await device(ctx, 'slots')).acc, ctx.params.slot!);
    return json(204, undefined);
  });

  // 새 PC 연결 우편함(ADR-048 결정 3, D08 §4.3). 새 PC는 계정 세션으로(아직 기기 토큰이 없다), 기존 PC는 데스크톱 기기 토큰으로 부른다
  const accSalt = limits.idSalt('acc');
  const linkId = (ctx: Ctx) => V.linkId({ id: ctx.params.id }).id;
  const linkNew = async (ctx: Ctx) => {
    const s = await session(ctx);
    await limit(`pclink:s:${await accSalt.hash(s.accountId)}`, PC_LINK.callsPerHour, MS.H);
    return s;
  };
  const linkOld = async (ctx: Ctx) => {
    const c = await device(ctx, 'devlist');
    await limit(`pclink:d:${await devSalt.hash(c.dev)}`, PC_LINK.callsPerHour, MS.H);
    return { accountId: c.acc, deviceId: c.dev };
  };
  const dpopAuth = (ctx: Ctx) => String(ctx.headers.authorization ?? '').startsWith('DPoP ');
  r.add('GET', '/v1/pc-links', async (ctx) => json(200, { links: await svc.pcLinks((await linkOld(ctx)).accountId) }));
  r.add('PUT', '/v1/pc-links/:id', async (ctx) => {
    const s = await linkNew(ctx);
    await limit(`pclink:h:${await accSalt.hash(s.accountId)}`, PC_LINK.hellosPerAccountHour, MS.H);
    await svc.putPcLinkHello(s, linkId(ctx), V.pcLinkHello(ctx.body).hello);
    return json(204, undefined);
  });
  r.add('GET', '/v1/pc-links/:id', async (ctx) => json(200, await svc.pcLinkForNew(await linkNew(ctx), linkId(ctx))));
  r.add('POST', '/v1/pc-links/:id/reveal', async (ctx) => {
    await svc.putPcLinkReveal(await linkNew(ctx), linkId(ctx), V.pcLinkReveal(ctx.body).reveal);
    return json(204, undefined);
  });
  r.add('POST', '/v1/pc-links/:id/challenge', async (ctx) => {
    await svc.putPcLinkChallenge(await linkOld(ctx), linkId(ctx), V.pcLinkChallenge(ctx.body).challenge);
    return json(204, undefined);
  });
  r.add('POST', '/v1/pc-links/:id/grant', async (ctx) => {
    await svc.putPcLinkGrant(await linkOld(ctx), linkId(ctx), V.pcLinkGrant(ctx.body).grant);
    return json(204, undefined);
  });
  r.add('DELETE', '/v1/pc-links/:id', async (ctx) => {
    // 쓰던 PC가 지우면(거절) 아직 활성화되지 않은 그 PC의 신청 기록도 지운다. 새 PC가 지우면 우편함만 비운다
    const old = dpopAuth(ctx);
    await svc.deletePcLink(old ? (await linkOld(ctx)).accountId : (await linkNew(ctx)).accountId, linkId(ctx), old);
    return json(204, undefined);
  });

  // 계정 열쇠 보관(ADR-050): 로그인된 PC는 데스크톱 기기 토큰으로 맡기고, 새 PC는 계정 세션으로 받아 스스로 목록에 들어간다
  const escrowOld = async (ctx: Ctx) => {
    const c = await device(ctx, 'devlist');
    await limit(`escrow:d:${await devSalt.hash(c.dev)}`, KEY_ESCROW.callsPerHour, MS.H);
    return { accountId: c.acc, deviceId: c.dev };
  };
  const escrowNew = async (ctx: Ctx) => {
    const s = await session(ctx);
    await limit(`escrow:s:${await accSalt.hash(s.accountId)}`, KEY_ESCROW.callsPerHour, MS.H);
    return s;
  };
  r.add('GET', '/v1/key-escrow', async (ctx) => json(200, await svc.keyEscrowState((await escrowOld(ctx)).accountId)));
  r.add('PUT', '/v1/key-escrow', async (ctx) => {
    await svc.putKeyEscrow(await escrowOld(ctx), V.keyEscrowPut(ctx.body));
    return json(204, undefined);
  });
  r.add('POST', '/v1/key-escrow/claim', async (ctx) => {
    const s = await escrowNew(ctx);
    const b = V.keyEscrowClaim(ctx.body);
    await limit(`escrow:c:${await accSalt.hash(s.accountId)}`, KEY_ESCROW.claimsPerAccountDay, MS.D);
    return json(200, await svc.claimKeyEscrow(s, b.deviceId, b.Hx));
  });
  r.add('GET', '/v1/key-escrow/pub', async (ctx) => {
    await escrowNew(ctx);
    return json(200, svc.keyEscrowPub());
  });
  r.add('POST', '/v1/key-escrow/reset', async (ctx) => {
    const s = await escrowNew(ctx);
    const b = V.keyEscrowReset(ctx.body);
    await limit(`escrow:c:${await accSalt.hash(s.accountId)}`, KEY_ESCROW.claimsPerAccountDay, MS.D);
    return json(200, await svc.resetByKeyEscrow(s, b.deviceId, b));
  });
  r.add('POST', '/v1/key-escrow/join', async (ctx) => {
    const s = await escrowNew(ctx);
    const b = V.keyEscrowJoin(ctx.body);
    return json(200, await svc.joinByKeyEscrow(s, b.deviceId, b.deviceList));
  });

  // 발급 잠금(ADR-048 결정 7, 데스크톱 기기 토큰). PC가 2대 이상인 계정의 PC만 부른다(PC가 자기 기기 목록으로 판단)
  const issueLock = async (ctx: Ctx) => {
    const c = await device(ctx, 'devlist');
    await limit(`issuelock:${await devSalt.hash(c.dev)}`, ISSUE_LOCK.callsPerDeviceHour, MS.H);
    return { accountId: c.acc, deviceId: c.dev };
  };
  r.add('GET', '/v1/issue-lock', async (ctx) => {
    const c = await issueLock(ctx);
    const l = await svc.issueLock(c.accountId);
    return json(200, { ...l, mine: l.deviceId === c.deviceId });
  });
  r.add('POST', '/v1/issue-lock/acquire', async (ctx) => json(200, await svc.acquireIssueLock(await issueLock(ctx))));
  r.add('POST', '/v1/issue-lock/renew', async (ctx) => {
    const c = await issueLock(ctx);
    return json(200, await svc.renewIssueLock(c, V.issueLockId(ctx.body).lockId));
  });
  r.add('POST', '/v1/issue-lock/release', async (ctx) => {
    const c = await issueLock(ctx);
    await svc.releaseIssueLock(c, V.issueLockId(ctx.body).lockId);
    return json(204, undefined);
  });

  // 계정 공유 기록(ADR-048 결정 5, D07 §10, 기기 토큰 share 범위). 줄은 암호문이고, 쓸 수 있는 종류는 역할로 가른다(폰은 맡긴 일만)
  const share = async (ctx: Ctx, kind: 'r' | 'w') => {
    const c = await deviceAuth.check(ctx, 'share', 'account.unauthorized', 'account.device_suspended');
    ctx.logAid = idSalt.hash(c.acc);
    await limit(`share:${kind}:${await devSalt.hash(c.dev)}`, kind === 'w' ? SHARE.writesPerDeviceHour : SHARE.readsPerDeviceHour, MS.H);
    return { accountId: c.acc, deviceId: c.dev, role: c.role };
  };
  const shareDesktop = async (ctx: Ctx) => {
    const c = await share(ctx, 'w');
    if (c.role !== 'desktop') fail('account.scope_denied');
    return c;
  };
  const shareId = (ctx: Ctx) => V.shareRowId({ id: ctx.params.id }).id;
  r.add('PUT', '/v1/share/rows/:id', async (ctx) => {
    const c = await share(ctx, 'w');
    return json(200, await svc.putShareRow(c, { rowId: shareId(ctx), ...V.shareRow(ctx.body) }));
  });
  // 이어 받기는 쿼리가 아니라 경로로 한다(PC의 클라우드 출구는 쿼리를 받지 않는다, @sax/net cloud.ts)
  const shareRowsFrom = async (ctx: Ctx, raw: string) => {
    const c = await share(ctx, 'r');
    if ([...ctx.query.keys()].length || !/^(0|[1-9][0-9]{0,15})$/.test(raw)) fail('request.param_rejected');
    return json(200, await svc.shareRows(c.accountId, Number(raw)));
  };
  r.add('GET', '/v1/share/rows', (ctx) => shareRowsFrom(ctx, '0'));
  r.add('GET', '/v1/share/rows/after/:seq', (ctx) => shareRowsFrom(ctx, ctx.params.seq ?? ''));
  r.add('GET', '/v1/share/tasks', async (ctx) => json(200, { tasks: await svc.shareTasks((await share(ctx, 'r')).accountId) }));
  r.add('POST', '/v1/share/tasks/:id/claim', async (ctx) => json(200, await svc.claimShareTask(await shareDesktop(ctx), shareId(ctx))));
  r.add('POST', '/v1/share/tasks/:id/release', async (ctx) => {
    await svc.releaseShareTask(await shareDesktop(ctx), shareId(ctx));
    return json(204, undefined);
  });
  r.add('POST', '/v1/share/tasks/:id/cancel', async (ctx) => {
    await svc.cancelShareTask(await share(ctx, 'w'), shareId(ctx));
    return json(204, undefined);
  });

  // 내부(게이트웨이·릴레이가 기기 상태를 묻는다)
  r.add('GET', '/internal/v1/devices/:id', async (ctx) => {
    await o.internal.check(ctx);
    const rec = await svc.deviceRecord(ctx.params.id!);
    return rec ? json(200, rec) : json(404, { error: 'account.device_not_found' });
  });
  r.add(
    'POST',
    '/internal/v1/devices/:id/auto-suspend',
    async (ctx) => {
      await o.internal.check(ctx);
      return json(200, { suspended: await svc.autoSuspend(ctx.params.id!) });
    },
    { raw: true },
  );
  r.add('GET', '/healthz', () => json(200, { ok: true }));
  return r;
}
