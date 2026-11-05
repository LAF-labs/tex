// 계정·구독 도메인(D09 §2). HTTP와 무관한 규칙만 여기에 둔다(라우트·요청 검증은 app.ts).
import { randomBytes, randomInt, randomUUID } from 'node:crypto';
import {
  DESKTOP_SCOPES,
  JtiCache,
  MOBILE_SCOPES_P1,
  ServiceError,
  TokenIssuer,
  b64u,
  fail,
  fromB64,
  hmacHex,
  jcs,
  kstDay,
  randomToken,
  safeEqual,
  sha256,
  sha256hex,
  verifyDpop,
  type DeviceRecord,
  type Sql,
} from '@sax/svc-shared';
import { PLAN, type DeviceStopHook, type MailSender, type NoticeKind, type PaymentEvent, type PaymentGateway } from './adapters.ts';
import { certSigOk, entrySigOk, opSigOk, revokeSigOk, type AcctOp, type DeviceList, type SignedCert } from './aik.ts';
import { ACCOUNT, DEVICE, MS, PROFILE } from './constants.ts';
import { verifyAssertion, verifyRegistration, WebAuthnError, type AssertionInput, type RegistrationInput, type RpConfig } from './webauthn.ts';

export type AuthMethod = 'email_code' | 'passkey';

export interface Session {
  accountId: string;
  authMethod: AuthMethod;
}

interface AccountRow {
  id: string;
  email: string;
  status: string;
  created_at: number;
  aik_pub: string | null;
  device_list_version: number;
  device_list_json: string | null;
  last_biz_change_at: number | null;
}

interface DeviceRow {
  device_id: string;
  account_id: string;
  role: 'desktop' | 'mobile';
  platform: string;
  name: string;
  sx: string;
  vx: string;
  registered_at: number;
  state: 'pending' | 'active' | 'suspended' | 'revoked';
  email_hold_until: number | null;
  delete_after: number | null;
  revoke_record: string | null;
}

export interface AccountDeps {
  db: Sql;
  mail: MailSender;
  payments: PaymentGateway;
  tokens: TokenIssuer;
  /** 로그인 코드 MAC 키(32B, KMS) */
  codeMacKey: Buffer;
  rp: RpConfig;
  /** 계정 서비스 공개 origin(DPoP htu) */
  publicOrigin: string;
  /** 결제 완료 후 돌아올 URL(설정 고정, 클라이언트가 고를 수 없다) */
  billingReturnUrl: string;
  stopHooks?: DeviceStopHook[];
  now?: () => number;
}

const SESSION_PREFIX = 'sxs1.';
const LOOPBACK = /^http:\/\/(127\.0\.0\.1|\[::1\]):(\d{4,5})(\/[A-Za-z0-9._~/-]{0,128})?$/;
const DESKTOP_CLIENT = 'sax-desktop';

export class AccountService {
  readonly db: Sql;
  private readonly d: AccountDeps;
  readonly now: () => number;
  private readonly jti = new JtiCache();

  constructor(d: AccountDeps) {
    this.d = d;
    this.db = d.db;
    this.now = d.now ?? Date.now;
  }

  // ---------- 로그인: 이메일 6자리 코드(C-30) ----------

  /** 코드 발급. loginId는 요청한 앱·브라우저가 쥐고 있어야 검증할 수 있다(같은 세션에서만 완료). 계정 존재 여부와 무관하게 같은 응답. */
  async startEmailCode(emailRaw: string): Promise<{ loginId: string; expiresInSec: number }> {
    const email = normEmail(emailRaw);
    const loginId = randomToken();
    const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
    await this.db.run('INSERT INTO login_codes (login_id_hash, email, code_mac, attempts, expires_at) VALUES ($1, $2, $3, 0, $4)', [sha256hex(loginId), email, this.codeMac(loginId, code), this.now() + ACCOUNT.loginCodeTtlMs]);
    await this.d.mail.sendLoginCode(email, code);
    return { loginId, expiresInSec: ACCOUNT.loginCodeTtlMs / 1000 };
  }

  private codeMac(loginId: string, code: string): string {
    return hmacHex(this.d.codeMacKey, 'SAX-login-code-v1', '\u0000', loginId, '\u0000', code);
  }

  async verifyEmailCode(loginId: string, code: string): Promise<{ session: string; accountId: string }> {
    const h = sha256hex(loginId);
    const outcome = await this.db.tx(async (q) => {
      const row = await q.one<{ email: string; code_mac: string; attempts: number; expires_at: number }>(`SELECT email, code_mac, attempts, expires_at FROM login_codes WHERE login_id_hash = $1${q.forUpdate}`, [h]);
      if (!row || row.expires_at <= this.now()) {
        if (row) await q.run('DELETE FROM login_codes WHERE login_id_hash = $1', [h]);
        return 'invalid' as const;
      }
      if (!safeEqual(row.code_mac, this.codeMac(loginId, code))) {
        const attempts = row.attempts + 1;
        if (attempts >= ACCOUNT.loginCodeMaxAttempts) {
          await q.run('DELETE FROM login_codes WHERE login_id_hash = $1', [h]);
          return 'locked' as const;
        }
        await q.run('UPDATE login_codes SET attempts = $1 WHERE login_id_hash = $2', [attempts, h]);
        return 'invalid' as const;
      }
      await q.run('DELETE FROM login_codes WHERE login_id_hash = $1', [h]);
      let acc = await q.one<{ id: string; status: string }>('SELECT id, status FROM accounts WHERE email = $1', [row.email]);
      if (!acc) {
        acc = { id: randomUUID(), status: 'active' };
        await q.run("INSERT INTO accounts (id, email, status, created_at) VALUES ($1, $2, 'active', $3)", [acc.id, row.email, this.now()]);
      }
      return acc;
    });
    if (outcome === 'invalid') fail('account.code_invalid');
    if (outcome === 'locked') fail('account.code_locked');
    const acc = outcome as { id: string; status: string };
    if (acc.status !== 'active') fail('account.unauthorized');
    return { session: await this.createSession(acc.id, 'email_code'), accountId: acc.id };
  }

  private async createSession(accountId: string, method: AuthMethod): Promise<string> {
    const token = SESSION_PREFIX + randomToken();
    const now = this.now();
    await this.db.run('INSERT INTO sessions (token_hash, account_id, auth_method, created_at, expires_at) VALUES ($1, $2, $3, $4, $5)', [sha256hex(token), accountId, method, now, now + ACCOUNT.sessionTtlMs]);
    await this.db.run('UPDATE accounts SET last_login_at = $1 WHERE id = $2', [now, accountId]);
    return token;
  }

  /** `Authorization: Bearer sxs1.…`(계정 세션). 기기 범위 토큰·DPoP는 여기서 받지 않는다. */
  async session(authorization: string | undefined): Promise<Session> {
    const m = /^Bearer (sxs1\.[A-Za-z0-9_-]{43})$/.exec(authorization ?? '');
    if (!m) fail('account.unauthorized');
    const row = await this.db.one<{ account_id: string; auth_method: AuthMethod; expires_at: number; status: string }>(
      'SELECT s.account_id, s.auth_method, s.expires_at, a.status FROM sessions s JOIN accounts a ON a.id = s.account_id WHERE s.token_hash = $1',
      [sha256hex(m![1]!)],
    );
    if (!row || row.expires_at <= this.now() || row.status !== 'active') fail('account.unauthorized');
    return { accountId: row!.account_id, authMethod: row!.auth_method };
  }

  async logout(authorization: string | undefined): Promise<void> {
    const m = /^Bearer (sxs1\.[A-Za-z0-9_-]{43})$/.exec(authorization ?? '');
    if (m) await this.db.run('DELETE FROM sessions WHERE token_hash = $1', [sha256hex(m[1]!)]);
  }

  /** 사고 대응(D09 §9.2): 계정 세션 전면 무효화. 운영 도구에서만 부른다(공개 API 없음). */
  async revokeAllSessions(accountId: string): Promise<number> {
    return this.db.run('DELETE FROM sessions WHERE account_id = $1', [accountId]);
  }

  // ---------- 데스크톱 로그인: RFC 8252 루프백 + PKCE(디바이스 플로우 없음) ----------

  async authorize(s: Session, o: { clientId: string; redirectUri: string; codeChallenge: string; method: string; state: string }): Promise<{ redirect: string }> {
    if (o.clientId !== DESKTOP_CLIENT || o.method !== 'S256') fail('account.pkce_invalid');
    const lb = LOOPBACK.exec(o.redirectUri);
    if (!lb || Number(lb[2]) < 1024 || Number(lb[2]) > 65535) fail('account.redirect_not_loopback');
    const code = randomToken();
    await this.db.run('INSERT INTO oauth_codes (code_hash, account_id, auth_method, client_id, redirect_uri, code_challenge, expires_at) VALUES ($1, $2, $3, $4, $5, $6, $7)', [
      sha256hex(code),
      s.accountId,
      s.authMethod,
      o.clientId,
      o.redirectUri,
      o.codeChallenge,
      this.now() + ACCOUNT.oauthCodeTtlMs,
    ]);
    const u = new URL(o.redirectUri);
    u.searchParams.set('code', code);
    u.searchParams.set('state', o.state);
    return { redirect: u.toString() };
  }

  async exchangeCode(o: { code: string; verifier: string; redirectUri: string; clientId: string }): Promise<{ session: string }> {
    const h = sha256hex(o.code);
    const row = await this.db.tx(async (q) => {
      const r = await q.one<{ account_id: string; auth_method: AuthMethod; client_id: string; redirect_uri: string; code_challenge: string; expires_at: number }>(`SELECT * FROM oauth_codes WHERE code_hash = $1${q.forUpdate}`, [h]);
      // 1회용: 맞든 틀리든 지운다.
      if (r) await q.run('DELETE FROM oauth_codes WHERE code_hash = $1', [h]);
      return r;
    });
    if (!row || row.expires_at <= this.now() || row.client_id !== o.clientId || row.redirect_uri !== o.redirectUri) fail('account.pkce_invalid');
    if (!safeEqual(b64u(sha256(o.verifier)), row!.code_challenge)) fail('account.pkce_invalid');
    return { session: await this.createSession(row!.account_id, row!.auth_method) };
  }

  // ---------- 패스키(WebAuthn) ----------

  private userHandle(accountId: string): string {
    return b64u(sha256(`SAX-webauthn-user-v1${accountId}`).subarray(0, 16));
  }

  async passkeyRegisterOptions(s: Session): Promise<Record<string, unknown>> {
    const challenge = randomToken();
    await this.db.run('INSERT INTO webauthn_challenges (challenge_hash, account_id, kind, expires_at) VALUES ($1, $2, $3, $4)', [sha256hex(challenge), s.accountId, 'register', this.now() + ACCOUNT.webauthnChallengeTtlMs]);
    const existing = await this.db.all<{ credential_id: string }>('SELECT credential_id FROM passkeys WHERE account_id = $1', [s.accountId]);
    return {
      challenge,
      rp: { id: this.d.rp.rpId, name: 'tex' },
      user: { id: this.userHandle(s.accountId), name: 'tex', displayName: 'tex' },
      pubKeyCredParams: [
        { type: 'public-key', alg: -7 },
        { type: 'public-key', alg: -8 },
      ],
      attestation: 'none',
      authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
      excludeCredentials: existing.map((c) => ({ type: 'public-key', id: c.credential_id })),
      timeout: ACCOUNT.webauthnChallengeTtlMs,
    };
  }

  private async takeChallenge(challenge: string, kind: 'register' | 'login', accountId: string | null): Promise<void> {
    const h = sha256hex(challenge);
    const row = await this.db.tx(async (q) => {
      const r = await q.one<{ account_id: string | null; kind: string; expires_at: number }>(`SELECT account_id, kind, expires_at FROM webauthn_challenges WHERE challenge_hash = $1${q.forUpdate}`, [h]);
      if (r) await q.run('DELETE FROM webauthn_challenges WHERE challenge_hash = $1', [h]);
      return r;
    });
    if (!row || row.kind !== kind || row.expires_at <= this.now() || row.account_id !== accountId) fail('account.passkey_invalid');
  }

  async passkeyRegister(s: Session, challenge: string, inp: RegistrationInput): Promise<{ credentialId: string }> {
    await this.takeChallenge(challenge, 'register', s.accountId);
    let c;
    try {
      c = verifyRegistration(inp, challenge, this.d.rp);
    } catch (e) {
      if (e instanceof WebAuthnError || e instanceof Error) fail('account.passkey_invalid');
      throw e;
    }
    const dup = await this.db.one('SELECT 1 AS x FROM passkeys WHERE credential_id = $1', [c!.credentialId]);
    if (dup) fail('account.passkey_invalid');
    await this.db.run('INSERT INTO passkeys (credential_id, account_id, public_key, alg, sign_count, created_at) VALUES ($1, $2, $3, $4, $5, $6)', [c!.credentialId, s.accountId, c!.publicKeySpki, c!.alg, c!.signCount, this.now()]);
    await this.notify(s.accountId, 'passkey_added');
    return { credentialId: c!.credentialId };
  }

  async passkeyLoginOptions(): Promise<Record<string, unknown>> {
    const challenge = randomToken();
    await this.db.run('INSERT INTO webauthn_challenges (challenge_hash, account_id, kind, expires_at) VALUES ($1, NULL, $2, $3)', [sha256hex(challenge), 'login', this.now() + ACCOUNT.webauthnChallengeTtlMs]);
    return { challenge, rpId: this.d.rp.rpId, userVerification: 'required', timeout: ACCOUNT.webauthnChallengeTtlMs };
  }

  async passkeyLogin(challenge: string, inp: AssertionInput): Promise<{ session: string; accountId: string }> {
    await this.takeChallenge(challenge, 'login', null);
    const pk = await this.db.one<{ account_id: string; public_key: string; alg: number; sign_count: number; status: string }>(
      'SELECT p.account_id, p.public_key, p.alg, p.sign_count, a.status FROM passkeys p JOIN accounts a ON a.id = p.account_id WHERE p.credential_id = $1',
      [inp.credentialId],
    );
    if (!pk || pk.status !== 'active') fail('account.passkey_invalid');
    let count = 0;
    try {
      count = verifyAssertion(inp, challenge, this.d.rp, { publicKeySpki: pk!.public_key, alg: pk!.alg, signCount: Number(pk!.sign_count) });
    } catch {
      fail('account.passkey_invalid');
    }
    await this.db.run('UPDATE passkeys SET sign_count = $1 WHERE credential_id = $2', [count, inp.credentialId]);
    return { session: await this.createSession(pk!.account_id, 'passkey'), accountId: pk!.account_id };
  }

  // ---------- 계정 정보·동의 ----------

  private async account(id: string): Promise<AccountRow> {
    const a = await this.db.one<AccountRow>('SELECT * FROM accounts WHERE id = $1', [id]);
    if (!a) fail('account.unauthorized');
    return a!;
  }

  async me(s: Session): Promise<Record<string, unknown>> {
    const a = await this.account(s.accountId);
    const slots = await this.db.all<{ biz_hmac: string | null }>('SELECT biz_hmac FROM profile_slots WHERE account_id = $1', [a.id]);
    const passkeys = await this.db.one<{ n: number }>('SELECT COUNT(*) AS n FROM passkeys WHERE account_id = $1', [a.id]);
    const sub = await this.db.one<{ plan: string; status: string; renew_at: number | null }>('SELECT plan, status, renew_at FROM subscriptions WHERE account_id = $1', [a.id]);
    const consents = await this.db.all<{ version: string }>('SELECT version FROM consents WHERE account_id = $1 ORDER BY version', [a.id]);
    return {
      email: a.email,
      status: a.status,
      aikPinned: !!a.aik_pub,
      slotsUsed: slots.length,
      hasBizProfile: slots.some((x) => !!x.biz_hmac),
      passkeys: Number(passkeys?.n ?? 0),
      subscription: sub ? { plan: sub.plan, status: sub.status, renewAt: sub.renew_at, amountKrw: PLAN.amountKrw } : null,
      consents: consents.map((c) => c.version),
      authMethod: s.authMethod,
    };
  }

  async consent(s: Session, version: string): Promise<void> {
    await this.db.run('INSERT INTO consents (account_id, version, at) VALUES ($1, $2, $3) ON CONFLICT (account_id, version) DO NOTHING', [s.accountId, version, this.now()]);
  }

  private async notify(accountId: string, kind: NoticeKind): Promise<void> {
    const a = await this.db.one<{ email: string }>('SELECT email FROM accounts WHERE id = $1', [accountId]);
    if (a) await this.d.mail.sendNotice(a.email, kind);
  }

  // ---------- 구독·결제(9,900원 한 플랜, ADR-034) ----------

  async checkout(s: Session): Promise<{ checkoutUrl: string }> {
    let sub = await this.db.one<{ status: string; pg_customer_ref: string }>('SELECT status, pg_customer_ref FROM subscriptions WHERE account_id = $1', [s.accountId]);
    if (sub?.status === 'active') fail('request.param_rejected');
    // 해지 뒤 다시 구독: 새 PG 고객 참조로 연다(옛 참조로 늦게 온 이벤트는 어디에도 맞지 않는다)
    if (sub?.status === 'canceled') {
      sub = { status: 'pending', pg_customer_ref: `cus_${randomToken(18)}` };
      await this.db.run("UPDATE subscriptions SET status = 'pending', renew_at = NULL, pg_customer_ref = $1 WHERE account_id = $2", [sub.pg_customer_ref, s.accountId]);
    }
    if (!sub) {
      sub = { status: 'pending', pg_customer_ref: `cus_${randomToken(18)}` };
      await this.db.run("INSERT INTO subscriptions (account_id, plan, status, period, renew_at, pg_customer_ref) VALUES ($1, 'standard', 'pending', 'month', NULL, $2)", [s.accountId, sub.pg_customer_ref]);
    }
    return this.d.payments.createCheckout({ pgCustomerRef: sub.pg_customer_ref, plan: PLAN, returnUrl: this.d.billingReturnUrl });
  }

  /** PG 웹훅. 서명이 틀리면 거부, 모르는 참조는 조용히 무시(참조 존재 오라클 없음). */
  async paymentWebhook(raw: Buffer, headers: Record<string, string | string[] | undefined>): Promise<void> {
    const e: PaymentEvent | null = this.d.payments.verifyWebhook(raw, headers);
    if (!e) fail('account.billing_signature_invalid');
    const ev = e!;
    // 상태 전이만 받는다(늦게 오거나 재전송된 이벤트가 해지를 되살리거나 갱신을 되돌리지 않게): 해지는 끝 상태이고 다시 구독은 checkout이 pending으로 연다.
    // 갱신은 renew_at이 앞으로 갈 때만, 결제 실패는 active에서만.
    if (ev.type === 'subscription.activated' || ev.type === 'subscription.renewed')
      await this.db.run("UPDATE subscriptions SET status = 'active', renew_at = $1 WHERE pg_customer_ref = $2 AND status <> 'canceled' AND (renew_at IS NULL OR renew_at < $1)", [ev.renewAt, ev.pgCustomerRef]);
    else if (ev.type === 'payment.failed') await this.db.run("UPDATE subscriptions SET status = 'past_due' WHERE pg_customer_ref = $1 AND status = 'active'", [ev.pgCustomerRef]);
    else await this.db.run("UPDATE subscriptions SET status = 'canceled' WHERE pg_customer_ref = $1", [ev.pgCustomerRef]);
  }

  async subscription(s: Session): Promise<Record<string, unknown> | null> {
    const sub = await this.db.one<{ plan: string; status: string; renew_at: number | null }>('SELECT plan, status, renew_at FROM subscriptions WHERE account_id = $1', [s.accountId]);
    return sub ? { plan: sub.plan, status: sub.status, renewAt: sub.renew_at, amountKrw: PLAN.amountKrw, period: PLAN.period } : null;
  }

  async cancelSubscription(s: Session): Promise<void> {
    const sub = await this.db.one<{ pg_customer_ref: string; status: string }>('SELECT pg_customer_ref, status FROM subscriptions WHERE account_id = $1', [s.accountId]);
    if (!sub || sub.status === 'canceled') fail('request.param_rejected');
    await this.d.payments.cancel(sub!.pg_customer_ref);
    await this.db.run("UPDATE subscriptions SET status = 'canceled' WHERE account_id = $1", [s.accountId]);
  }

  // ---------- 기기: 첫 데스크톱·등록 신청·AIK 서명 기기 목록·긴급 정지·삭제 유예 ----------

  private async churnOk(q: Sql, accountId: string, role: 'desktop' | 'mobile'): Promise<boolean> {
    const since = kstDay(this.now() - DEVICE.churnWindowDays * MS.D);
    const r = await q.one<{ n: number }>("SELECT COUNT(*) AS n FROM device_events WHERE account_id = $1 AND role = $2 AND kind = 'add' AND day >= $3", [accountId, role, since]);
    return Number(r?.n ?? 0) < (role === 'desktop' ? DEVICE.churnDesktop : DEVICE.churnMobile);
  }

  private async countOk(q: Sql, accountId: string, role: 'desktop' | 'mobile', extra = 1): Promise<boolean> {
    const r = await q.one<{ n: number }>("SELECT COUNT(*) AS n FROM devices WHERE account_id = $1 AND role = $2 AND state <> 'revoked'", [accountId, role]);
    return Number(r?.n ?? 0) + extra <= (role === 'desktop' ? DEVICE.maxDesktops : DEVICE.maxMobiles);
  }

  /** 패스키가 있는 계정은 이메일 코드 세션만으로 기기를 추가할 수 없다(D09 §2.2). */
  private async requireStrongSessionIfPasskeys(q: Sql, s: Session): Promise<void> {
    if (s.authMethod === 'passkey') return;
    const r = await q.one<{ n: number }>('SELECT COUNT(*) AS n FROM passkeys WHERE account_id = $1', [s.accountId]);
    if (Number(r?.n ?? 0) > 0) fail('account.passkey_required');
  }

  /**
   * 첫 데스크톱(D09 §2.2): 계정에 AIK가 없고 데스크톱이 없을 때 처음 설치한 데스크톱이 AIK_pub를 1회 등록·고정한다.
   * deviceList는 이 데스크톱 항목 하나(listVersion 1)이고 AIK로 서명돼 있어야 한다.
   */
  async pinFirstDesktop(s: Session, o: { aikPub: string; deviceList: DeviceList; platform: string; name: string }): Promise<{ deviceId: string }> {
    const aik = fromB64(o.aikPub, 32);
    if (!aik) fail('request.param_rejected');
    const l = o.deviceList;
    const e = l.entries[0];
    if (l.listVersion !== 1 || l.entries.length !== 1 || l.revoked.length !== 0 || !e || e.entry.role !== 'desktop' || e.entry.list_version !== 1) fail('request.param_rejected');
    if (!entrySigOk(aik!, e!)) fail('account.aik_signature_invalid');
    return this.db.tx(async (q) => {
      const a = await q.one<AccountRow>(`SELECT * FROM accounts WHERE id = $1${q.forUpdate}`, [s.accountId]);
      if (!a) return fail('account.unauthorized');
      if (a.aik_pub) fail('account.aik_already_pinned');
      await this.requireStrongSessionIfPasskeys(q, s);
      // 신뢰된(활성·정지) 데스크톱이 있으면 이미 고정된 계정이다. AIK 전에 신청만 한 pending 데스크톱은 막지 않는다:
      // 같은 기기면 이 고정으로 대신하고, 다른 기기는 pending으로 남아 나중에 AIK 서명 목록으로만 활성화된다.
      const desk = await q.one<{ n: number }>("SELECT COUNT(*) AS n FROM devices WHERE account_id = $1 AND role = 'desktop' AND state IN ('active', 'suspended')", [s.accountId]);
      if (Number(desk?.n ?? 0) > 0) fail('account.aik_already_pinned');
      await q.run("DELETE FROM devices WHERE device_id = $1 AND account_id = $2 AND role = 'desktop' AND state = 'pending'", [e!.entry.device_id, s.accountId]);
      if (!(await this.churnOk(q, s.accountId, 'desktop'))) fail('account.device_churn_limit');
      const now = this.now();
      await q.run(
        "INSERT INTO devices (device_id, account_id, role, platform, name, sx, vx, registered_at, state) VALUES ($1, $2, 'desktop', $3, $4, $5, $6, $7, 'active')",
        [e!.entry.device_id, s.accountId, o.platform, o.name, e!.entry.Sx, e!.entry.Vx, now],
      ).catch(() => fail('request.param_rejected'));
      await q.run('UPDATE accounts SET aik_pub = $1, aik_pinned_at = $2, device_list_version = 1, device_list_json = $3 WHERE id = $4', [o.aikPub, now, jcs(l), s.accountId]);
      await q.run("INSERT INTO device_events (account_id, role, kind, day) VALUES ($1, 'desktop', 'add', $2)", [s.accountId, kstDay(now)]);
      return { deviceId: e!.entry.device_id };
    }).then(async (r) => {
      await this.notify(s.accountId, 'aik_pinned');
      return r;
    });
  }

  /**
   * 등록 신청(서버 등록, 신뢰 아님). 폰은 이메일 로그인 뒤 자기 공개키를 올리고 PC가 페어링 6단계에서 이 목록과 대조한다.
   * 활성화는 둘 중 하나: (a) AIK 서명 기기 목록에 들어감(즉시), (b) 72시간 대기 뒤 계정 세션으로(activateAfterHold).
   * (b)로 활성화해도 AIK 인증서가 없으면 기기 범위 토큰을 받지 못한다(D09 §2.2 "서버 등록은 신뢰가 아니다").
   */
  async enroll(s: Session, o: { deviceId: string; role: 'desktop' | 'mobile'; platform: string; name: string; Sx: string; Vx: string }): Promise<{ holdUntil: number }> {
    const r = await this.db.tx(async (q) => {
      await this.requireStrongSessionIfPasskeys(q, s);
      await q.one(`SELECT id FROM accounts WHERE id = $1${q.forUpdate}`, [s.accountId]);
      if (!(await this.countOk(q, s.accountId, o.role))) fail('account.device_limit');
      if (!(await this.churnOk(q, s.accountId, o.role))) fail('account.device_churn_limit');
      const exists = await q.one('SELECT 1 AS x FROM devices WHERE device_id = $1', [o.deviceId]);
      if (exists) fail('request.param_rejected');
      const now = this.now();
      const holdUntil = now + DEVICE.emailOnlyAddDelayHours * MS.H;
      await q.run("INSERT INTO devices (device_id, account_id, role, platform, name, sx, vx, registered_at, state, email_hold_until) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'pending', $9)", [
        o.deviceId,
        s.accountId,
        o.role,
        o.platform,
        o.name,
        o.Sx,
        o.Vx,
        now,
        holdUntil,
      ]);
      await q.run("INSERT INTO device_events (account_id, role, kind, day) VALUES ($1, $2, 'add', $3)", [s.accountId, o.role, kstDay(now)]);
      return { holdUntil };
    });
    await this.notify(s.accountId, 'device_enrolled');
    return r;
  }

  /** (b) 경로: 이메일 확인 + 72시간 대기 끝. 패스키 계정은 패스키 세션이어야 한다. */
  async activateAfterHold(s: Session, deviceId: string): Promise<void> {
    await this.db.tx(async (q) => {
      await this.requireStrongSessionIfPasskeys(q, s);
      const d = await q.one<DeviceRow>(`SELECT * FROM devices WHERE device_id = $1 AND account_id = $2${q.forUpdate}`, [deviceId, s.accountId]);
      if (!d) fail('account.device_not_found');
      if (d!.state !== 'pending') fail('account.not_pending');
      if ((d!.email_hold_until ?? Infinity) > this.now()) fail('account.device_hold', { retryAfterSec: Math.ceil(((d!.email_hold_until ?? 0) - this.now()) / 1000) });
      await q.run("UPDATE devices SET state = 'active', email_hold_until = NULL WHERE device_id = $1", [deviceId]);
    });
  }

  async listDevices(accountId: string): Promise<Array<Record<string, unknown>>> {
    const rows = await this.db.all<DeviceRow>('SELECT * FROM devices WHERE account_id = $1 ORDER BY registered_at', [accountId]);
    return rows.map((d) => ({
      deviceId: d.device_id,
      role: d.role,
      platform: d.platform,
      name: d.name,
      state: d.state,
      registeredAt: d.registered_at,
      Sx: d.sx,
      Vx: d.vx,
      holdUntil: d.state === 'pending' ? d.email_hold_until : null,
      deleteAfter: d.delete_after,
    }));
  }

  async deviceList(accountId: string): Promise<{ aikPub: string | null; deviceList: DeviceList | null }> {
    const a = await this.account(accountId);
    return { aikPub: a.aik_pub, deviceList: a.device_list_json ? (JSON.parse(a.device_list_json) as DeviceList) : null };
  }

  /**
   * AIK 서명 기기 목록 갱신(데스크톱 기기 범위 토큰). 새 항목은 등록 신청(pending)과 키가 같아야 활성화된다(페어링 7단계).
   * 목록에서 빠지는 기기는 AIK 서명 폐기 레코드가 있어야 한다. 요청한 데스크톱이 등록 7일 미만이면 폐기는 7일 유예(D09 §2.2).
   */
  async updateDeviceList(requester: { accountId: string; deviceId: string }, l: DeviceList): Promise<{ listVersion: number }> {
    const stopped: string[] = [];
    await this.db.tx(async (q) => {
      const a = await q.one<AccountRow>(`SELECT * FROM accounts WHERE id = $1${q.forUpdate}`, [requester.accountId]);
      if (!a) return fail('account.unauthorized');
      if (!a.aik_pub) fail('account.aik_not_pinned');
      const aik = fromB64(a.aik_pub, 32)!;
      if (l.listVersion <= a.device_list_version) fail('account.list_version_stale');
      const ids = new Set<string>();
      for (const e of l.entries) {
        if (ids.has(e.entry.device_id) || e.entry.list_version > l.listVersion || !entrySigOk(aik, e)) fail('account.aik_signature_invalid');
        ids.add(e.entry.device_id);
      }
      const revoked = new Map<string, (typeof l.revoked)[number]>();
      for (const r of l.revoked) {
        if (ids.has(r.device_id) || !revokeSigOk(aik, r)) fail('account.aik_signature_invalid');
        revoked.set(r.device_id, r);
      }
      const devices = await q.all<DeviceRow>('SELECT * FROM devices WHERE account_id = $1', [requester.accountId]);
      const byId = new Map(devices.map((d) => [d.device_id, d]));
      const me = byId.get(requester.deviceId);
      if (!me || me.role !== 'desktop' || !ids.has(me.device_id)) fail('account.aik_signature_invalid');
      const now = this.now();
      const toActivate: DeviceRow[] = [];
      for (const e of l.entries) {
        const d = byId.get(e.entry.device_id);
        if (!d || d.state === 'revoked' || d.role !== e.entry.role || d.sx !== e.entry.Sx || d.vx !== e.entry.Vx) fail('request.param_rejected');
        if (d!.state === 'pending') toActivate.push(d!);
      }
      // 목록에서 조용히 빠지는 기기 금지: 활성·정지 기기는 항목 또는 폐기 레코드 중 하나에 있어야 한다.
      for (const d of devices) if ((d.state === 'active' || d.state === 'suspended') && !ids.has(d.device_id) && !revoked.has(d.device_id)) fail('request.param_rejected');
      for (const role of ['desktop', 'mobile'] as const) {
        const n = toActivate.filter((d) => d.role === role).length;
        if (n && !(await this.countOk(q, requester.accountId, role, 0))) fail('account.device_limit');
      }
      for (const d of toActivate) await q.run("UPDATE devices SET state = 'active', email_hold_until = NULL WHERE device_id = $1", [d.device_id]);
      const cooling = now - me!.registered_at < DEVICE.newDeviceCoolingDays * MS.D;
      for (const [id, r] of revoked) {
        const d = byId.get(id);
        if (!d || d.state === 'revoked') continue;
        // 유예는 처음 폐기 레코드가 들어온 때부터 센다(목록을 다시 올려도 다시 시작하지 않는다)
        if (cooling) await q.run('UPDATE devices SET delete_after = COALESCE(delete_after, $1), revoke_record = $2 WHERE device_id = $3', [now + ACCOUNT.deleteGraceDays * MS.D, jcs(r), id]);
        else {
          await q.run("UPDATE devices SET state = 'revoked', revoke_record = $1, delete_after = NULL WHERE device_id = $2", [jcs(r), id]);
          await q.run("INSERT INTO device_events (account_id, role, kind, day) VALUES ($1, $2, 'remove', $3)", [requester.accountId, d.role, kstDay(now)]);
          stopped.push(id);
        }
      }
      await q.run('UPDATE accounts SET device_list_version = $1, device_list_json = $2 WHERE id = $3', [l.listVersion, jcs(l), requester.accountId]);
    });
    for (const id of stopped) await this.stopped(id);
    if (stopped.length) await this.notify(requester.accountId, 'device_revoked');
    return { listVersion: l.listVersion };
  }

  private async stopped(deviceId: string): Promise<void> {
    for (const h of this.d.stopHooks ?? []) await h.stopped(deviceId).catch(() => undefined);
  }

  /** 계정 웹 '기기 긴급 정지'(D08 §9.3): 정지만. 재활성화는 AIK. 릴레이 우편함·푸시 토큰·깨우기도 즉시 멈춘다(stopHooks). */
  async suspend(s: Session, deviceId: string): Promise<void> {
    const n = await this.db.run("UPDATE devices SET state = 'suspended' WHERE device_id = $1 AND account_id = $2 AND state IN ('active', 'pending')", [deviceId, s.accountId]);
    if (!n) {
      const d = await this.db.one<{ state: string }>('SELECT state FROM devices WHERE device_id = $1 AND account_id = $2', [deviceId, s.accountId]);
      if (!d) fail('account.device_not_found');
      if (d!.state === 'revoked') fail('account.device_not_found');
    }
    await this.stopped(deviceId);
    await this.notify(s.accountId, 'device_suspended');
  }

  /** AIK 서명 재활성화(데스크톱이 요청). 폐기된 기기는 되살리지 않는다. */
  async reactivate(requester: { accountId: string; deviceId: string }, deviceId: string, op: { op: AcctOp; aikSig: string }): Promise<void> {
    const a = await this.account(requester.accountId);
    if (!a.aik_pub || op.op.op !== 'device.reactivate' || !opSigOk(fromB64(a.aik_pub, 32)!, op, a.id, deviceId, this.now())) fail('account.aik_signature_invalid');
    const n = await this.db.run("UPDATE devices SET state = 'active' WHERE device_id = $1 AND account_id = $2 AND state = 'suspended'", [deviceId, a.id]);
    if (!n) fail('account.device_not_found');
  }

  /** 계정 세션만 있는 삭제 요청은 7일 유예(D09 §2.2). 유예 중 모든 기기·이메일에 알리고 취소할 수 있다. */
  async requestDelete(s: Session, deviceId: string): Promise<{ deleteAfter: number }> {
    const after = this.now() + ACCOUNT.deleteGraceDays * MS.D;
    const n = await this.db.run("UPDATE devices SET delete_after = $1 WHERE device_id = $2 AND account_id = $3 AND state <> 'revoked' AND delete_after IS NULL", [after, deviceId, s.accountId]);
    if (!n) fail('account.device_not_found');
    await this.notify(s.accountId, 'device_delete_pending');
    return { deleteAfter: after };
  }

  async cancelDelete(s: Session, deviceId: string): Promise<void> {
    const n = await this.db.run("UPDATE devices SET delete_after = NULL, revoke_record = NULL WHERE device_id = $1 AND account_id = $2 AND state <> 'revoked' AND delete_after IS NOT NULL", [deviceId, s.accountId]);
    if (!n) fail('account.device_not_found');
  }

  // ---------- 기기 범위 토큰(AIK 인증서 + DPoP) ----------

  /**
   * AIK가 서명한 기기 인증서를 내고, 같은 요청에 그 인증서의 Vx로 서명한 DPoP 증명(ath = sha256(JCS(cert)))을 붙인다.
   * Phase 1 폰 토큰은 relay·push 범위만(ADR-034, D09 §2.1).
   */
  async issueDeviceToken(c: SignedCert, dpop: string | undefined, htu: string, onVerified?: () => void): Promise<{ token: string; expiresAt: number; scopes: string[] }> {
    const d = await this.db.one<DeviceRow & { aik_pub: string | null }>('SELECT d.*, a.aik_pub FROM devices d JOIN accounts a ON a.id = d.account_id WHERE d.device_id = $1 AND a.status = $2', [c.cert.device_id, 'active']);
    if (!d || !d.aik_pub) fail('account.cert_invalid');
    const now = this.now();
    if (!certSigOk(fromB64(d!.aik_pub!, 32)!, c) || c.cert.role !== d!.role || c.cert.Sx !== d!.sx || c.cert.Vx !== d!.vx) fail('account.cert_invalid');
    if (c.cert.not_after <= now || c.cert.not_after > now + DEVICE.certMaxDays * MS.D) fail('account.cert_invalid');
    const vx = fromB64(d!.vx, 32)!;
    verifyDpop(dpop, { method: 'POST', htu, token: jcs(c), cnf: vx, now, jti: this.jti, code: 'account.dpop_invalid' });
    // 기기별 발급 한도는 인증서·DPoP가 맞은 뒤에만 센다(남이 device_id만 알고 한도를 태우지 못하게)
    onVerified?.();
    if (d!.state !== 'active') fail('account.device_suspended');
    const scopes = d!.role === 'desktop' ? [...DESKTOP_SCOPES] : [...MOBILE_SCOPES_P1];
    const { token, claims } = this.d.tokens.issue({ acc: d!.account_id, dev: d!.device_id, role: d!.role, scp: scopes, cnf: d!.vx }, now);
    return { token, expiresAt: claims.exp, scopes };
  }

  // ---------- 프로필 슬롯·사업자 HMAC(B-28) ----------

  async createSlot(accountId: string): Promise<{ slotToken: string }> {
    return this.db.tx(async (q) => {
      await q.one(`SELECT id FROM accounts WHERE id = $1${q.forUpdate}`, [accountId]);
      const n = await q.one<{ n: number }>('SELECT COUNT(*) AS n FROM profile_slots WHERE account_id = $1', [accountId]);
      if (Number(n?.n ?? 0) >= PROFILE.slotMax) fail('account.slot_limit');
      const slotToken = b64u(randomBytes(16));
      await q.run('INSERT INTO profile_slots (slot_token, account_id) VALUES ($1, $2)', [slotToken, accountId]);
      return { slotToken };
    });
  }

  async listSlots(accountId: string): Promise<Array<{ slotToken: string; bound: boolean }>> {
    const rows = await this.db.all<{ slot_token: string; biz_hmac: string | null }>('SELECT slot_token, biz_hmac FROM profile_slots WHERE account_id = $1 ORDER BY slot_token', [accountId]);
    return rows.map((r) => ({ slotToken: r.slot_token, bound: !!r.biz_hmac }));
  }

  /**
   * 사업자 HMAC 등록·재바인딩. 재바인딩은 마지막 바인딩(이 슬롯 또는 계정의 바인딩 변경·바인딩 슬롯 삭제)에서 90일 뒤에만.
   * RK 교체 재등록(D08 §9.4)은 AIK 서명(slot.rebind_rk, target = slot:hmac)이 있으면 세지 않는다.
   */
  async bindBiz(accountId: string, slotToken: string, bizHmac: string, rkOp?: { op: AcctOp; aikSig: string }): Promise<{ changed: boolean }> {
    return this.db.tx(async (q) => {
      const a = await q.one<AccountRow>(`SELECT * FROM accounts WHERE id = $1${q.forUpdate}`, [accountId]);
      if (!a) return fail('account.unauthorized');
      const slot = await q.one<{ biz_hmac: string | null; biz_bound_at: number | null }>('SELECT biz_hmac, biz_bound_at FROM profile_slots WHERE slot_token = $1 AND account_id = $2', [slotToken, accountId]);
      if (!slot) return fail('account.slot_not_found');
      if (slot.biz_hmac === bizHmac) return { changed: false };
      const now = this.now();
      const minMs = PROFILE.rebindMinDays * MS.D;
      if (rkOp) {
        if (!a.aik_pub || rkOp.op.op !== 'slot.rebind_rk' || !opSigOk(fromB64(a.aik_pub, 32)!, rkOp, accountId, `${slotToken}:${bizHmac}`, now)) fail('account.aik_signature_invalid');
        await q.run('UPDATE profile_slots SET biz_hmac = $1, biz_bound_at = $2 WHERE slot_token = $3', [bizHmac, now, slotToken]);
        return { changed: true };
      }
      const lastChange = a.last_biz_change_at ?? -Infinity;
      if (now - lastChange < minMs) fail('account.rebind_too_soon', { retryAfterSec: Math.ceil((lastChange + minMs - now) / 1000) });
      if (slot.biz_hmac) {
        const bound = slot.biz_bound_at ?? -Infinity;
        if (now - bound < minMs) fail('account.rebind_too_soon', { retryAfterSec: Math.ceil((bound + minMs - now) / 1000) });
        await q.run('UPDATE accounts SET last_biz_change_at = $1 WHERE id = $2', [now, accountId]);
      }
      await q.run('UPDATE profile_slots SET biz_hmac = $1, biz_bound_at = $2 WHERE slot_token = $3', [bizHmac, now, slotToken]);
      return { changed: true };
    });
  }

  /** 프로필 삭제. 바인딩된 슬롯을 지우면 재바인딩 시계가 돈다(지우고 새로 만들어 90일 규칙을 피하지 못하게). */
  async deleteSlot(accountId: string, slotToken: string): Promise<void> {
    await this.db.tx(async (q) => {
      const slot = await q.one<{ biz_hmac: string | null }>(`SELECT biz_hmac FROM profile_slots WHERE slot_token = $1 AND account_id = $2${q.forUpdate}`, [slotToken, accountId]);
      if (!slot) fail('account.slot_not_found');
      if (slot!.biz_hmac) await q.run('UPDATE accounts SET last_biz_change_at = $1 WHERE id = $2', [this.now(), accountId]);
      await q.run('DELETE FROM profile_slots WHERE slot_token = $1', [slotToken]);
    });
  }

  // ---------- 내부 ----------

  async deviceRecord(deviceId: string): Promise<DeviceRecord | null> {
    const d = await this.db.one<DeviceRow>('SELECT * FROM devices WHERE device_id = $1', [deviceId]);
    return d ? { accountId: d.account_id, deviceId: d.device_id, role: d.role, state: d.state } : null;
  }

  /** 주기 작업: 만료 레코드 삭제, 삭제 유예 완료, 오래된 등록 신청·이력 정리. */
  async sweep(): Promise<{ revoked: string[] }> {
    const now = this.now();
    await this.db.run('DELETE FROM login_codes WHERE expires_at <= $1', [now]);
    await this.db.run('DELETE FROM oauth_codes WHERE expires_at <= $1', [now]);
    await this.db.run('DELETE FROM webauthn_challenges WHERE expires_at <= $1', [now]);
    await this.db.run('DELETE FROM sessions WHERE expires_at <= $1', [now]);
    await this.db.run('DELETE FROM device_events WHERE day < $1', [kstDay(now - DEVICE.churnWindowDays * MS.D)]);
    await this.db.run("DELETE FROM devices WHERE state = 'pending' AND registered_at <= $1", [now - DEVICE.pendingTtlDays * MS.D]);
    const due = await this.db.all<DeviceRow>("SELECT * FROM devices WHERE delete_after IS NOT NULL AND delete_after <= $1 AND state <> 'revoked'", [now]);
    for (const d of due) {
      await this.db.run("UPDATE devices SET state = 'revoked', delete_after = NULL WHERE device_id = $1", [d.device_id]);
      await this.db.run("INSERT INTO device_events (account_id, role, kind, day) VALUES ($1, $2, 'remove', $3)", [d.account_id, d.role, kstDay(now)]);
      await this.stopped(d.device_id);
    }
    return { revoked: due.map((d) => d.device_id) };
  }
}

export function normEmail(e: string): string {
  const s = e.trim().toLowerCase();
  if (s.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)) throw new ServiceError('request.param_rejected');
  return s;
}
