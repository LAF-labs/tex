// 계정·구독 API 라우트(services/account/API.md가 계약 문서). 요청은 모두 스키마로 검증하고 스키마 밖 필드는 400.
import {
  DailySalt,
  DeviceAuth,
  Router,
  S,
  fail,
  json,
  memoryLimits,
  requireInternal,
  validator,
  type Ctx,
  type DeviceDirectory,
  type TokenVerifier,
  type Limits,
} from '@sax/svc-shared';
import { deviceListSchema, signedCertSchema, signedOpSchema, type AcctOp, type DeviceList, type SignedCert } from './aik.ts';
import { ACCOUNT, DEVICE, MS } from './constants.ts';
import type { AccountService, Session } from './service.ts';

const obj = (properties: Record<string, unknown>, required: string[] = Object.keys(properties)) => ({ type: 'object', additionalProperties: false, required, properties });
const b64u = (min: number, max: number) => ({ type: 'string', pattern: `^[A-Za-z0-9_-]{${min},${max}}$` });

const V = {
  codeStart: validator<{ email: string }>(obj({ email: { type: 'string', minLength: 3, maxLength: 254 } })),
  codeVerify: validator<{ loginId: string; code: string }>(obj({ loginId: S.token, code: { type: 'string', pattern: '^[0-9]{6}$' } })),
  authorize: validator<{ client_id: string; redirect_uri: string; code_challenge: string; code_challenge_method: string; state: string }>(
    obj({ client_id: { type: 'string', maxLength: 64 }, redirect_uri: { type: 'string', maxLength: 200 }, code_challenge: b64u(43, 43), code_challenge_method: { const: 'S256' }, state: b64u(16, 128) }),
  ),
  token: validator<{ grant_type: string; code: string; code_verifier: string; redirect_uri: string; client_id: string }>(
    obj({ grant_type: { const: 'authorization_code' }, code: S.token, code_verifier: { type: 'string', pattern: '^[A-Za-z0-9._~-]{43,128}$' }, redirect_uri: { type: 'string', maxLength: 200 }, client_id: { type: 'string', maxLength: 64 } }),
  ),
  passkeyRegister: validator<{ challenge: string; clientDataJSON: string; attestationObject: string }>(obj({ challenge: S.token, clientDataJSON: b64u(1, 6000), attestationObject: b64u(1, 11000) })),
  passkeyLogin: validator<{ challenge: string; credentialId: string; clientDataJSON: string; authenticatorData: string; signature: string; userHandle?: string }>(
    obj({ challenge: S.token, credentialId: b64u(16, 1400), clientDataJSON: b64u(1, 6000), authenticatorData: b64u(37, 1400), signature: b64u(64, 200), userHandle: b64u(1, 100) }, ['challenge', 'credentialId', 'clientDataJSON', 'authenticatorData', 'signature']),
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
  internalSecret: string;
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
    ctx.logAid = idSalt.hash(out.accountId);
    return json(200, { session: out.session, expiresInSec: ACCOUNT.sessionTtlMs / 1000 });
  });
  r.add('POST', '/v1/auth/passkey/options', async (ctx) => {
    await limit(`auth-ip:${await ipKey(ctx)}`, ACCOUNT.authAttemptsPerIpHour, MS.H);
    return json(200, await svc.passkeyLoginOptions());
  });
  r.add('POST', '/v1/auth/passkey/verify', async (ctx) => {
    const b = V.passkeyLogin(ctx.body);
    await limit(`auth-ip:${await ipKey(ctx)}`, ACCOUNT.authAttemptsPerIpHour, MS.H);
    const out = await svc.passkeyLogin(b.challenge, b);
    ctx.logAid = idSalt.hash(out.accountId);
    return json(200, { session: out.session, expiresInSec: ACCOUNT.sessionTtlMs / 1000 });
  });
  r.add('POST', '/v1/auth/logout', async (ctx) => {
    await svc.logout(ctx.headers.authorization);
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
    return json(200, { session: out.session, expiresInSec: ACCOUNT.sessionTtlMs / 1000 });
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
      return json(201, await svc.enrollByDesktop({ accountId: c.acc, deviceId: c.dev }, b));
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
    requireInternal(ctx, o.internalSecret);
    const rec = await svc.deviceRecord(ctx.params.id!);
    return rec ? json(200, rec) : json(404, { error: 'account.device_not_found' });
  });
  r.add('POST', '/internal/v1/devices/:id/auto-suspend', async (ctx) => {
    requireInternal(ctx, o.internalSecret);
    return json(200, { suspended: await svc.autoSuspend(ctx.params.id!) });
  });
  r.add('GET', '/healthz', () => json(200, { ok: true }));
  return r;
}
