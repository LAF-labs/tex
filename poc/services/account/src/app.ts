// 계정·구독 API 라우트(services/account/API.md가 계약 문서). 요청은 모두 스키마로 검증하고 스키마 밖 필드는 400.
import {
  DailySalt,
  DeviceAuth,
  Router,
  S,
  fail,
  json,
  memoryLimits,
  validator,
  type Ctx,
  type InternalCheck,
  type DeviceDirectory,
  type TokenVerifier,
  type Limits,
} from '@sax/svc-shared';
import { deviceListSchema, signedCertSchema, signedOpSchema, type AcctOp, type DeviceList, type SignedCert } from './aik.ts';
import { ACCOUNT, DEVICE, MS, PASSWORD } from './constants.ts';
import { withFloor } from './password.ts';
import type { AccountService, AuthMethod, Session } from './service.ts';

const obj = (properties: Record<string, unknown>, required: string[] = Object.keys(properties)) => ({ type: 'object', additionalProperties: false, required, properties });
const b64u = (min: number, max: number) => ({ type: 'string', pattern: `^[A-Za-z0-9_-]{${min},${max}}$` });

const EMAIL = { type: 'string', minLength: 3, maxLength: 254 } as const;
/** 요청 상한만(정규화 전). 길이 정책 10~128자(NFKC 코드 포인트)는 서버 정책 검사가 판정한다 */
const PASSWORD_IN = { type: 'string', minLength: 1, maxLength: 1024 } as const;
const REMEMBER = { type: 'boolean' } as const;
const REFRESH_TOKEN = { type: 'string', pattern: '^sxa1\\.[A-Za-z0-9_-]{43}$' } as const;

const V = {
  codeStart: validator<{ email: string }>(obj({ email: EMAIL })),
  codeVerify: validator<{ loginId: string; code: string; remember?: boolean }>(obj({ loginId: S.token, code: { type: 'string', pattern: '^[0-9]{6}$' }, remember: REMEMBER }, ['loginId', 'code'])),
  passwordLogin: validator<{ email: string; password: string; remember?: boolean }>(obj({ email: EMAIL, password: PASSWORD_IN, remember: REMEMBER }, ['email', 'password'])),
  passwordSet: validator<{ password: string }>(obj({ password: PASSWORD_IN })),
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
  pinAik: validator<{ aikPub: string; deviceList: DeviceList; platform: string; name: string }>(
    obj({ aikPub: S.b64key32, deviceList: deviceListSchema, platform: { enum: ['windows', 'macos'] }, name: { type: 'string', minLength: 1, maxLength: 40 } }),
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
  deviceToken: validator<{ cert: SignedCert }>(obj({ cert: signedCertSchema })),
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
  const sessionOrDevice = async (ctx: Ctx): Promise<string> => {
    const auth = String(ctx.headers.authorization ?? '');
    if (auth.startsWith('DPoP ')) return (await device(ctx, 'devlist')).acc;
    return (await session(ctx)).accountId;
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
    await svc.setPassword(s, b.password);
    return json(204, undefined);
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

  // 구독·결제
  r.add('POST', '/v1/billing/checkout', async (ctx) => json(200, await svc.checkout(await session(ctx))));
  r.add('GET', '/v1/billing/subscription', async (ctx) => json(200, { subscription: await svc.subscription(await session(ctx)) }));
  r.add('POST', '/v1/billing/cancel', async (ctx) => {
    await svc.cancelSubscription(await session(ctx));
    return json(204, undefined);
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
  r.add('GET', '/v1/devices', async (ctx) => json(200, { devices: await svc.listDevices(await sessionOrDevice(ctx)) }));
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
  r.add('GET', '/v1/device-list', async (ctx) => json(200, await svc.deviceList(await sessionOrDevice(ctx))));
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
    const out = await svc.issueDeviceToken(b.cert, Array.isArray(dpop) ? undefined : dpop, o.publicOrigin + ctx.path, async () => limit(`devtok:${await devSalt.hash(b.cert.cert.device_id)}`, DEVICE.deviceTokensPerHour, MS.H));
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
