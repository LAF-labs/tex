import type { AcctClaimSigner, SignedAcctClaim } from './acct-claim.ts';
import { createHash, randomBytes, randomInt, randomUUID } from 'node:crypto';
import {
  DESKTOP_SCOPES,
  JtiCache,
  MOBILE_SCOPES_P1,
  PAID_SCOPES,
  ServiceError,
  TokenIssuer,
  b64u,
  fail,
  fromB64,
  hmacHex,
  jcs,
  kstDay,
  openAead,
  randomToken,
  safeEqual,
  sealAead,
  sha256,
  sha256hex,
  verifyDpop,
  type DeviceRecord,
  type Scope,
  type Sql,
} from '@sax/svc-shared';
import { TERMS_VERSION, resultPageHtml } from './pg-toss.ts';
import { PLAN, type DeviceStopHook, type MailSender, type PairingRooms, type NoticeKind, type PaymentEvent, type PaymentGateway } from './adapters.ts';
import { certSigOk, entrySigOk, opSigOk, revokeSigOk, type AcctOp, type DeviceList, type SignedCert } from './aik.ts';
import { ACCOUNT, BILLING, DEVICE, ISSUE_LOCK, MS, NOTICE, PASSWORD, PC_LINK, PROFILE, SHARE } from './constants.ts';
import type { KeyEscrow } from './escrow.ts';
import { checkPasswordPolicy, withFloor, type CommonPasswords, type PasswordHasher } from './password.ts';
import { verifyAssertion, verifyRegistration, WebAuthnError, type AssertionInput, type RegistrationInput, type RpConfig } from './webauthn.ts';

/** 세션을 준 수단. refresh = 갱신 토큰으로 새로 받은 세션(강한 인증·최근 로그인으로 치지 않는다) */
export type AuthMethod = 'email_code' | 'passkey' | 'password' | 'refresh';

/** 구독 경로의 호출자: 계정 세션 또는 데스크톱 기기 토큰(app.ts billingAuth). 계정 ID만 쓴다 */
export type BillingCaller = { accountId: string };

export interface Session {
  accountId: string;
  authMethod: AuthMethod;
  authAt: number;
  tokenHash: string;
}

/** 비밀번호 로그인 구성(ADR-038). 없으면 비밀번호 경로는 닫힌다(PASSWORD_PEPPER_KEYS 없음·argon2id 미지원) */
export interface PasswordDeps {
  hasher: PasswordHasher;
  common: CommonPasswords;
  onEvent?: (name: string) => void;
}

interface AccountRow {
  id: string;
  email: string;
  status: string;
  created_at: number;
  aik_pub: string | null;
  aik_pinned_at: number | null;
  device_list_version: number;
  device_list_json: string | null;
  last_biz_change_at: number | null;
  delete_after: number | null;
}

export type ShareKind = (typeof SHARE.kinds)[number];
/** 받는 쪽에 주는 줄. at은 서버가 받은 시각(ms)이다(줄 안의 at은 쓴 기기의 시계). */
export interface ShareRowOut {
  seq: number;
  rowId: string;
  kind: ShareKind;
  epoch: number;
  deviceId: string;
  at: number;
  body: string;
}
export interface ShareTaskOut {
  taskId: string;
  state: 'open' | 'claimed' | 'done' | 'cancelled' | 'expired';
  createdBy: string;
  claimedBy: string | null;
  claimExpiresAt: number | null;
  createdAt: number;
  updatedAt: number;
}
interface ShareTaskRow {
  task_id: string;
  state: 'open' | 'claimed' | 'done' | 'cancelled';
  created_by: string;
  claimed_by: string | null;
  claim_expires_at: number | null;
  created_at: number;
  updated_at: number;
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
  last_seen_at: number | null;
}

export interface AccountDeps {
  db: Sql;
  mail: MailSender;
  payments: PaymentGateway;
  tokens: TokenIssuer;
  codeMacKey: Buffer;
  rp: RpConfig;
  publicOrigin: string;
  billingReturnUrl: string;
  stopHooks?: DeviceStopHook[];
  pairing?: PairingRooms;
  acctClaims?: AcctClaimSigner;
  passwords?: PasswordDeps;
  escrow?: KeyEscrow;
  billingKeySealKey?: Buffer;
  onEvent?: (name: string) => void;
  defer?: (task: () => Promise<void>) => void;
  now?: () => number;
}

const SESSION_PREFIX = 'sxs1.';
const REFRESH_PREFIX = 'sxa1.';
const REFRESH_RE = /^sxa1\.[A-Za-z0-9_-]{43}$/;
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
    if (d.payments.billing && d.billingKeySealKey?.length !== 32) throw new Error('config_BILLING_KEY_SEAL_KEY');
  }

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

  private async createSession(accountId: string, method: AuthMethod, authAt?: number): Promise<string> {
    const token = SESSION_PREFIX + randomToken();
    const now = this.now();
    await this.db.run('INSERT INTO sessions (token_hash, account_id, auth_method, created_at, auth_at, expires_at) VALUES ($1, $2, $3, $4, $5, $6)', [
      sha256hex(token),
      accountId,
      method,
      now,
      authAt ?? now,
      now + ACCOUNT.sessionTtlMs,
    ]);
    await this.db.run('UPDATE accounts SET last_login_at = $1 WHERE id = $2', [now, accountId]);
    return token;
  }

  async session(authorization: string | undefined): Promise<Session> {
    const m = /^Bearer (sxs1\.[A-Za-z0-9_-]{43})$/.exec(authorization ?? '');
    if (!m) fail('account.unauthorized');
    const tokenHash = sha256hex(m![1]!);
    const row = await this.db.one<{ account_id: string; auth_method: AuthMethod; auth_at: number; expires_at: number; status: string }>(
      'SELECT s.account_id, s.auth_method, s.auth_at, s.expires_at, a.status FROM sessions s JOIN accounts a ON a.id = s.account_id WHERE s.token_hash = $1',
      [tokenHash],
    );
    if (!row || Number(row.expires_at) <= this.now() || row.status !== 'active') fail('account.unauthorized');
    return { accountId: row!.account_id, authMethod: row!.auth_method, authAt: Number(row!.auth_at), tokenHash };
  }

  async logout(authorization: string | undefined): Promise<void> {
    const m = /^Bearer (sxs1\.[A-Za-z0-9_-]{43})$/.exec(authorization ?? '');
    if (m) await this.db.run('DELETE FROM sessions WHERE token_hash = $1', [sha256hex(m[1]!)]);
  }

  async revokeAllSessions(accountId: string, keep?: { token: string } | { tokenHash: string }, q: Sql = this.db): Promise<number> {
    await q.run('DELETE FROM refresh_tokens WHERE account_id = $1', [accountId]);
    if (keep) return q.run('DELETE FROM sessions WHERE account_id = $1 AND token_hash <> $2', [accountId, 'token' in keep ? sha256hex(keep.token) : keep.tokenHash]);
    return q.run('DELETE FROM sessions WHERE account_id = $1', [accountId]);
  }

  async issueRefresh(accountId: string, method: AuthMethod, q: Sql = this.db): Promise<string> {
    const token = REFRESH_PREFIX + randomToken();
    const now = this.now();
    await q.run('INSERT INTO refresh_tokens (token_hash, account_id, family_id, parent_hash, auth_method, issued_at, expires_at, rotated_at) VALUES ($1, $2, $3, NULL, $4, $5, $6, NULL)', [
      sha256hex(token),
      accountId,
      randomUUID(),
      method,
      now,
      now + ACCOUNT.refreshTtlMs,
    ]);
    return token;
  }

  async refresh(tokenRaw: string): Promise<{ session: string; refreshToken: string; accountId: string }> {
    if (!REFRESH_RE.test(tokenRaw)) fail('account.unauthorized');
    const h = sha256hex(tokenRaw);
    const now = this.now();
    const next = REFRESH_PREFIX + randomToken();
    const out = await this.db.tx(async (q) => {
      const row = await q.one<{ account_id: string; family_id: string; auth_method: string; expires_at: number; rotated_at: number | null; status: string }>(
        `SELECT r.account_id, r.family_id, r.auth_method, r.expires_at, r.rotated_at, a.status FROM refresh_tokens r JOIN accounts a ON a.id = r.account_id WHERE r.token_hash = $1${q.forUpdate}`,
        [h],
      );
      if (!row) return 'invalid' as const;
      if (row.rotated_at !== null && row.rotated_at !== undefined) {
        await q.run('DELETE FROM refresh_tokens WHERE account_id = $1', [row.account_id]);
        await q.run('DELETE FROM sessions WHERE account_id = $1', [row.account_id]);
        return { reuse: row.account_id };
      }
      if (Number(row.expires_at) <= now || row.status !== 'active') {
        await q.run('DELETE FROM refresh_tokens WHERE token_hash = $1', [h]);
        return 'invalid' as const;
      }
      await q.run('UPDATE refresh_tokens SET rotated_at = $1 WHERE token_hash = $2', [now, h]);
      await q.run('INSERT INTO refresh_tokens (token_hash, account_id, family_id, parent_hash, auth_method, issued_at, expires_at, rotated_at) VALUES ($1, $2, $3, $4, $5, $6, $7, NULL)', [
        sha256hex(next),
        row.account_id,
        row.family_id,
        h,
        row.auth_method,
        now,
        now + ACCOUNT.refreshTtlMs,
      ]);
      return { accountId: row.account_id };
    });
    if (out === 'invalid') fail('account.unauthorized');
    const { reuse, accountId } = out as { reuse?: string; accountId?: string };
    if (reuse) {
      this.d.passwords?.onEvent?.('account.refresh_reuse_detected');
      await this.notify(reuse, 'sessions_revoked');
      fail('account.unauthorized');
    }
    return { session: await this.createSession(accountId!, 'refresh'), refreshToken: next, accountId: accountId! };
  }

  async revokeRefresh(tokenRaw: string): Promise<void> {
    if (!REFRESH_RE.test(tokenRaw)) return;
    const row = await this.db.one<{ family_id: string }>('SELECT family_id FROM refresh_tokens WHERE token_hash = $1', [sha256hex(tokenRaw)]);
    if (row) await this.db.run('DELETE FROM refresh_tokens WHERE family_id = $1', [row.family_id]);
  }

  private pw(): PasswordDeps {
    return this.d.passwords ?? fail('request.not_found');
  }

  get passwordsEnabled(): boolean {
    return !!this.d.passwords;
  }

  async passwordLogin(emailRaw: string, pw: string): Promise<{ session: string; accountId: string }> {
    const p = this.pw();
    const email = normEmail(emailRaw);
    const row = await this.db.one<{ id: string; status: string; pw_hash: string | null; salt: string | null; params: string | null; fails: number | null; locked_until: number | null; lock_level: number | null }>(
      'SELECT a.id, a.status, c.pw_hash, c.salt, c.params, l.fails, l.locked_until, l.lock_level FROM accounts a LEFT JOIN pw_creds c ON c.account_id = a.id LEFT JOIN pw_locks l ON l.account_id = a.id WHERE a.email = $1',
      [email],
    );
    const now = this.now();
    const stored = row?.pw_hash && row.salt && row.params ? { hash: row.pw_hash, salt: row.salt, params: row.params } : null;
    const v = await p.hasher.verify(pw, stored);
    if (!row || !stored) fail('account.credentials_invalid');
    if (!(await this.countAttempt(row!.id, row!.locked_until, v.ok, now))) fail('account.credentials_invalid');
    if (row!.status !== 'active') fail('account.credentials_invalid');
    await this.db.run('DELETE FROM pw_locks WHERE account_id = $1', [row!.id]);
    if (v.needsRehash) {
      const h = await p.hasher.hash(pw);
      await this.db.run('UPDATE pw_creds SET pw_hash = $1, salt = $2, params = $3 WHERE account_id = $4', [h.hash, h.salt, h.params, row!.id]);
      p.onEvent?.('account.password_rehashed');
    }
    return { session: await this.createSession(row!.id, 'password'), accountId: row!.id };
  }

  private async countAttempt(accountId: string, lockedUntil: number | null | undefined, ok: boolean, now: number): Promise<boolean> {
    const p = this.pw();
    if (lockedUntil !== null && lockedUntil !== undefined && Number(lockedUntil) > now) return false;
    if (ok) return true;
    const lockedNow = await this.db.tx(async (q) => {
      const l = await q.one<{ fails: number; lock_level: number; locked_until: number | null }>(`SELECT fails, lock_level, locked_until FROM pw_locks WHERE account_id = $1${q.forUpdate}`, [accountId]);
      if (l && l.locked_until !== null && Number(l.locked_until) > now) return false;
      const fails = Number(l?.fails ?? 0) + 1;
      const level = Number(l?.lock_level ?? 0);
      if (fails >= PASSWORD.maxFails) {
        const until = now + Math.min(PASSWORD.lockBaseMs * 2 ** level, PASSWORD.lockMaxMs);
        await this.upsertLock(q, accountId, 0, until, level + 1, now);
        await this.enqueueNotice(q, accountId, 'password_locked', now);
        return true;
      }
      await this.upsertLock(q, accountId, fails, null, level, now);
      return false;
    });
    if (lockedNow) {
      p.onEvent?.('account.password_locked');
      this.kickNotices();
    }
    return false;
  }

  private async upsertLock(q: Sql, accountId: string, fails: number, lockedUntil: number | null, level: number, now: number): Promise<void> {
    const n = await q.run('UPDATE pw_locks SET fails = $1, locked_until = $2, lock_level = $3, updated_at = $4 WHERE account_id = $5', [fails, lockedUntil, level, now, accountId]);
    if (n === 0) await q.run('INSERT INTO pw_locks (account_id, fails, locked_until, lock_level, updated_at) VALUES ($1, $2, $3, $4, $5)', [accountId, fails, lockedUntil, level, now]);
  }

  private requireRecentLogin(s: Session): void {
    if (s.authMethod === 'refresh' || this.now() - s.authAt > PASSWORD.reauthMaxAgeMs) fail('account.reauth_required');
  }

  private async setHash(q: Sql, accountId: string, h: { hash: string; salt: string; params: string }, now: number): Promise<void> {
    const n = await q.run('UPDATE pw_creds SET pw_hash = $1, salt = $2, params = $3, set_at = $4 WHERE account_id = $5', [h.hash, h.salt, h.params, now, accountId]);
    if (n === 0) await q.run('INSERT INTO pw_creds (account_id, pw_hash, salt, params, set_at) VALUES ($1, $2, $3, $4, $5)', [accountId, h.hash, h.salt, h.params, now]);
    await q.run('DELETE FROM pw_locks WHERE account_id = $1', [accountId]);
  }

  async setPassword(s: Session, pw: string, current?: string): Promise<{ changed: boolean; revokedSessions: number; refreshToken?: string }> {
    const p = this.pw();
    const a = await this.account(s.accountId);
    const cred = await this.db.one<{ pw_hash: string; salt: string; params: string; locked_until: number | null }>(
      'SELECT c.pw_hash, c.salt, c.params, l.locked_until FROM pw_creds c LEFT JOIN pw_locks l ON l.account_id = c.account_id WHERE c.account_id = $1',
      [s.accountId],
    );
    if (!cred) {
      this.requireRecentLogin(s);
      checkPasswordPolicy(pw, a.email, p.common);
      return this.storePassword(s, pw, false);
    }
    if (current === undefined) fail('account.current_password_required');
    return withFloor(PASSWORD.responseFloorMs, async () => {
      checkPasswordPolicy(pw, a.email, p.common);
      const v = await p.hasher.verify(current!, { hash: cred.pw_hash, salt: cred.salt, params: cred.params });
      if (!(await this.countAttempt(s.accountId, cred.locked_until, v.ok, this.now()))) fail('account.current_password_invalid');
      return this.storePassword(s, pw, true);
    });
  }

  private async storePassword(s: Session, pw: string, changed: boolean): Promise<{ changed: boolean; revokedSessions: number; refreshToken?: string }> {
    const p = this.pw();
    const h = await p.hasher.hash(pw);
    const now = this.now();
    const out = await this.db.tx(async (q) => {
      await this.setHash(q, s.accountId, h, now);
      const n = changed ? await this.revokeAllSessions(s.accountId, { tokenHash: s.tokenHash }, q) : 0;
      const refreshToken = changed ? await this.issueRefresh(s.accountId, 'password', q) : undefined;
      await this.enqueueNotice(q, s.accountId, 'password_set', now);
      return { n, refreshToken };
    });
    p.onEvent?.(changed ? 'account.password_changed' : 'account.password_created');
    this.kickNotices();
    return { changed, revokedSessions: out.n, ...(out.refreshToken ? { refreshToken: out.refreshToken } : {}) };
  }

  private reauthMac(tokenHash: string, reauthId: string, code: string): string {
    return hmacHex(this.d.codeMacKey, 'SAX-reauth-code-v1', '\u0000', tokenHash, '\u0000', reauthId, '\u0000', code);
  }

  async startReauth(s: Session): Promise<{ reauthId: string; expiresInSec: number }> {
    const a = await this.account(s.accountId);
    const reauthId = randomToken();
    const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
    await this.db.run('INSERT INTO login_codes (login_id_hash, email, code_mac, attempts, expires_at) VALUES ($1, $2, $3, 0, $4)', [sha256hex(reauthId), a.email, this.reauthMac(s.tokenHash, reauthId, code), this.now() + ACCOUNT.loginCodeTtlMs]);
    await this.d.mail.sendReauthCode(a.email, code);
    return { reauthId, expiresInSec: ACCOUNT.loginCodeTtlMs / 1000 };
  }

  async finishReauth(s: Session, reauthId: string, code: string): Promise<{ authAt: number }> {
    const a = await this.account(s.accountId);
    const h = sha256hex(reauthId);
    const outcome = await this.db.tx(async (q) => {
      const row = await q.one<{ email: string; code_mac: string; attempts: number; expires_at: number }>(`SELECT email, code_mac, attempts, expires_at FROM login_codes WHERE login_id_hash = $1${q.forUpdate}`, [h]);
      if (!row || Number(row.expires_at) <= this.now() || row.email !== a.email) {
        if (row && Number(row.expires_at) <= this.now()) await q.run('DELETE FROM login_codes WHERE login_id_hash = $1', [h]);
        return 'invalid' as const;
      }
      if (!safeEqual(row.code_mac, this.reauthMac(s.tokenHash, reauthId, code))) {
        const attempts = row.attempts + 1;
        if (attempts >= ACCOUNT.loginCodeMaxAttempts) {
          await q.run('DELETE FROM login_codes WHERE login_id_hash = $1', [h]);
          return 'locked' as const;
        }
        await q.run('UPDATE login_codes SET attempts = $1 WHERE login_id_hash = $2', [attempts, h]);
        return 'invalid' as const;
      }
      await q.run('DELETE FROM login_codes WHERE login_id_hash = $1', [h]);
      const now = this.now();
      const n = await q.run("UPDATE sessions SET auth_at = $1, auth_method = 'email_code' WHERE token_hash = $2 AND account_id = $3", [now, s.tokenHash, s.accountId]);
      return n === 1 ? { authAt: now } : ('invalid' as const);
    });
    if (outcome === 'invalid') fail('account.code_invalid');
    if (outcome === 'locked') fail('account.code_locked');
    this.d.onEvent?.('account.reauth_ok');
    return outcome as { authAt: number };
  }

  async deletePassword(s: Session): Promise<void> {
    this.pw();
    this.requireRecentLogin(s);
    await this.db.run('DELETE FROM pw_creds WHERE account_id = $1', [s.accountId]);
    await this.db.run('DELETE FROM pw_locks WHERE account_id = $1', [s.accountId]);
  }

  private resetMac(resetId: string, code: string): string {
    return hmacHex(this.d.codeMacKey, 'SAX-reset-code-v1', '\u0000', resetId, '\u0000', code);
  }

  async startPasswordReset(emailRaw: string): Promise<{ resetId: string; expiresInSec: number }> {
    this.pw();
    const email = normEmail(emailRaw);
    const resetId = randomToken();
    const acc = await this.db.one<{ id: string; status: string }>('SELECT id, status FROM accounts WHERE email = $1', [email]);
    if (acc && acc.status === 'active') {
      const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
      await this.db.run('INSERT INTO reset_codes (reset_id_hash, account_id, code_mac, attempts, expires_at) VALUES ($1, $2, $3, 0, $4)', [sha256hex(resetId), acc.id, this.resetMac(resetId, code), this.now() + PASSWORD.resetCodeTtlMs]);
      this.later(() => this.d.mail.sendResetCode(email, code), 'account.reset_mail_failed');
    }
    return { resetId, expiresInSec: PASSWORD.resetCodeTtlMs / 1000 };
  }

  async finishPasswordReset(resetId: string, code: string, pw: string): Promise<{ session: string; accountId: string }> {
    const p = this.pw();
    const h = sha256hex(resetId);
    const outcome = await this.db.tx(async (q) => {
      const row = await q.one<{ account_id: string; code_mac: string; attempts: number; expires_at: number }>(`SELECT account_id, code_mac, attempts, expires_at FROM reset_codes WHERE reset_id_hash = $1${q.forUpdate}`, [h]);
      if (!row || Number(row.expires_at) <= this.now()) {
        if (row) await q.run('DELETE FROM reset_codes WHERE reset_id_hash = $1', [h]);
        return 'invalid' as const;
      }
      if (!safeEqual(row.code_mac, this.resetMac(resetId, code))) {
        const attempts = row.attempts + 1;
        if (attempts >= PASSWORD.resetCodeMaxAttempts) {
          await q.run('DELETE FROM reset_codes WHERE reset_id_hash = $1', [h]);
          return 'locked' as const;
        }
        await q.run('UPDATE reset_codes SET attempts = $1 WHERE reset_id_hash = $2', [attempts, h]);
        return 'invalid' as const;
      }
      return { accountId: row.account_id };
    });
    if (outcome === 'invalid') fail('account.code_invalid');
    if (outcome === 'locked') fail('account.code_locked');
    const accountId = (outcome as { accountId: string }).accountId;
    const a = await this.account(accountId);
    if (a.status !== 'active') fail('account.unauthorized');
    checkPasswordPolicy(pw, a.email, p.common);
    if ((await this.db.run('DELETE FROM reset_codes WHERE reset_id_hash = $1', [h])) === 0) fail('account.code_invalid');
    const hashed = await p.hasher.hash(pw);
    await this.setHash(this.db, accountId, hashed, this.now());
    await this.revokeAllSessions(accountId);
    await this.db.run('DELETE FROM reset_codes WHERE account_id = $1', [accountId]);
    await this.notify(accountId, 'password_reset');
    return { session: await this.createSession(accountId, 'email_code'), accountId };
  }

  async logoutAll(s: Session): Promise<void> {
    await this.revokeAllSessions(s.accountId);
  }

  async authorize(s: Session, o: { clientId: string; redirectUri: string; codeChallenge: string; method: string; state: string }): Promise<{ redirect: string }> {
    if (o.clientId !== DESKTOP_CLIENT || o.method !== 'S256') fail('account.pkce_invalid');
    const lb = LOOPBACK.exec(o.redirectUri);
    if (!lb || Number(lb[2]) < 1024 || Number(lb[2]) > 65535) fail('account.redirect_not_loopback');
    const code = randomToken();
    await this.db.run('INSERT INTO oauth_codes (code_hash, account_id, auth_method, client_id, redirect_uri, code_challenge, expires_at, auth_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)', [
      sha256hex(code),
      s.accountId,
      s.authMethod,
      o.clientId,
      o.redirectUri,
      o.codeChallenge,
      this.now() + ACCOUNT.oauthCodeTtlMs,
      s.authAt,
    ]);
    const u = new URL(o.redirectUri);
    u.searchParams.set('code', code);
    u.searchParams.set('state', o.state);
    return { redirect: u.toString() };
  }

  async exchangeCode(o: { code: string; verifier: string; redirectUri: string; clientId: string }): Promise<{ session: string; accountId: string; authMethod: AuthMethod }> {
    const h = sha256hex(o.code);
    const row = await this.db.tx(async (q) => {
      const r = await q.one<{ account_id: string; auth_method: AuthMethod; client_id: string; redirect_uri: string; code_challenge: string; expires_at: number; auth_at: number | null }>(`SELECT * FROM oauth_codes WHERE code_hash = $1${q.forUpdate}`, [h]);
      if (r) await q.run('DELETE FROM oauth_codes WHERE code_hash = $1', [h]);
      return r;
    });
    if (!row || row.expires_at <= this.now() || row.client_id !== o.clientId || row.redirect_uri !== o.redirectUri) fail('account.pkce_invalid');
    if (!safeEqual(b64u(sha256(o.verifier)), row!.code_challenge)) fail('account.pkce_invalid');
    return { session: await this.createSession(row!.account_id, row!.auth_method, Number(row!.auth_at ?? 0)), accountId: row!.account_id, authMethod: row!.auth_method };
  }

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

  async accountEmail(id: string): Promise<string> {
    return (await this.account(id)).email;
  }

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
      entitlement: await this.entitlement(a.id),
      authMethod: s.authMethod,
      hasPassword: !!(await this.db.one('SELECT 1 AS x FROM pw_creds WHERE account_id = $1', [a.id])),
      reauthUntil: s.authMethod === 'refresh' ? null : s.authAt + PASSWORD.reauthMaxAgeMs,
      deleteAfter: a.delete_after == null ? null : Number(a.delete_after),
    };
  }

  async accountDeletion(accountId: string): Promise<{ deleteAfter: number | null }> {
    const a = await this.account(accountId);
    return { deleteAfter: a.delete_after == null ? null : Number(a.delete_after) };
  }

  async requestAccountDelete(accountId: string): Promise<{ deleteAfter: number }> {
    const s = { accountId };
    const after = this.now() + ACCOUNT.deleteGraceDays * MS.D;
    const n = await this.db.run('UPDATE accounts SET delete_after = $1 WHERE id = $2 AND delete_after IS NULL', [after, s.accountId]);
    if (!n) {
      const a = await this.account(s.accountId);
      return { deleteAfter: Number(a.delete_after) };
    }
    const sub = await this.db.one<{ pg_customer_ref: string; status: string }>('SELECT pg_customer_ref, status FROM subscriptions WHERE account_id = $1', [s.accountId]);
    if (sub && sub.status !== 'canceled') {
      await this.d.payments.cancel(sub.pg_customer_ref);
      await this.db.run("UPDATE subscriptions SET status = 'canceled' WHERE account_id = $1", [s.accountId]);
    }
    if (sub) await this.db.run('UPDATE subscriptions SET billing_key_sealed = NULL, next_charge_at = NULL WHERE account_id = $1', [s.accountId]);
    await this.notify(s.accountId, 'account_delete_pending');
    return { deleteAfter: after };
  }

  async cancelAccountDelete(accountId: string): Promise<void> {
    const n = await this.db.run('UPDATE accounts SET delete_after = NULL WHERE id = $1 AND delete_after IS NOT NULL', [accountId]);
    if (!n) fail('account.not_pending');
  }

  async consent(s: Session, version: string): Promise<void> {
    await this.db.run('INSERT INTO consents (account_id, version, at) VALUES ($1, $2, $3) ON CONFLICT (account_id, version) DO NOTHING', [s.accountId, version, this.now()]);
  }

  private async enqueueNotice(q: Sql, accountId: string, kind: NoticeKind, now: number): Promise<void> {
    await q.run('INSERT INTO notice_outbox (id, account_id, kind, created_at, attempts, next_at) VALUES ($1, $2, $3, $4, 0, $4)', [randomToken(), accountId, kind, now]);
  }

  private later(task: () => Promise<unknown>, failEvent: string): void {
    const run = () => task().then(
      () => undefined,
      () => this.d.onEvent?.(failEvent),
    );
    if (this.d.defer) this.d.defer(run);
    else void run();
  }

  private kickNotices(): void {
    this.later(() => this.drainNotices(), 'account.notice_drain_failed');
  }

  async drainNotices(limit: number = NOTICE.batch): Promise<{ sent: number; failed: number }> {
    const now = this.now();
    const due = await this.db.all<{ id: string; account_id: string; kind: NoticeKind; attempts: number; next_at: number }>(
      'SELECT id, account_id, kind, attempts, next_at FROM notice_outbox WHERE next_at <= $1 ORDER BY next_at, id LIMIT $2',
      [now, limit],
    );
    let sent = 0;
    let failed = 0;
    for (const r of due) {
      const claimed = await this.db.run('UPDATE notice_outbox SET next_at = $1 WHERE id = $2 AND next_at = $3', [now + NOTICE.leaseMs, r.id, r.next_at]);
      if (!claimed) continue;
      const a = await this.db.one<{ email: string }>('SELECT email FROM accounts WHERE id = $1', [r.account_id]);
      const res = !a ? 'ok' : await this.d.mail.sendNotice(a.email, r.kind).then(() => 'ok' as const, (e: unknown) => ((e as { retryable?: unknown } | null)?.retryable === false ? ('final' as const) : ('retry' as const)));
      if (res === 'ok') {
        await this.db.run('DELETE FROM notice_outbox WHERE id = $1', [r.id]);
        if (a) {
          sent++;
          this.d.onEvent?.(`account.notice_sent.${r.kind}`);
        }
      } else {
        failed++;
        const attempts = Number(r.attempts) + 1;
        if (res === 'final' || attempts >= NOTICE.maxAttempts) {
          await this.db.run('DELETE FROM notice_outbox WHERE id = $1', [r.id]);
          this.d.onEvent?.(`account.notice_dropped.${r.kind}`);
        } else {
          const wait = Math.min(NOTICE.retryBaseMs * 2 ** (attempts - 1), NOTICE.retryMaxMs);
          await this.db.run('UPDATE notice_outbox SET attempts = $1, next_at = $2 WHERE id = $3', [attempts, now + wait, r.id]);
          this.d.onEvent?.(`account.notice_retry.${r.kind}`);
        }
      }
    }
    return { sent, failed };
  }

  private async notify(accountId: string, kind: NoticeKind): Promise<void> {
    const a = await this.db.one<{ email: string }>('SELECT email FROM accounts WHERE id = $1', [accountId]);
    if (a) await this.d.mail.sendNotice(a.email, kind);
  }

  async checkout(s: BillingCaller): Promise<{ checkoutUrl: string }> {
    const ref = await this.db.tx(async (q) => {
      await q.one(`SELECT id FROM accounts WHERE id = $1${q.forUpdate}`, [s.accountId]);
      const sub = await q.one<{ status: string; pg_customer_ref: string }>(`SELECT status, pg_customer_ref FROM subscriptions WHERE account_id = $1${q.forUpdate}`, [s.accountId]);
      if (sub?.status === 'active') fail('request.param_rejected');
      if (sub && sub.status !== 'canceled') return sub.pg_customer_ref;
      const next = `cus_${randomToken(18)}`;
      if (sub) await q.run("UPDATE subscriptions SET status = 'pending', renew_at = NULL, pg_event_at = NULL, pg_customer_ref = $1 WHERE account_id = $2", [next, s.accountId]);
      else await q.run("INSERT INTO subscriptions (account_id, plan, status, period, renew_at, pg_customer_ref) VALUES ($1, 'standard', 'pending', 'month', NULL, $2)", [s.accountId, next]);
      return next;
    });
    return this.d.payments.createCheckout({ pgCustomerRef: ref, plan: PLAN, returnUrl: this.d.billingReturnUrl });
  }

  async paymentWebhook(raw: Buffer, headers: Record<string, string | string[] | undefined>): Promise<void> {
    const e: PaymentEvent | null = this.d.payments.verifyWebhook(raw, headers);
    if (!e) fail('account.billing_signature_invalid');
    const ev = e!;
    const newer = '(pg_event_at IS NULL OR pg_event_at < $2)';
    if (ev.type === 'subscription.activated' || ev.type === 'subscription.renewed')
      await this.db.run(`UPDATE subscriptions SET status = 'active', renew_at = $3, pg_event_at = $2 WHERE pg_customer_ref = $1 AND status <> 'canceled' AND ${newer}`, [ev.pgCustomerRef, ev.at, ev.renewAt]);
    else if (ev.type === 'payment.failed') await this.db.run(`UPDATE subscriptions SET status = 'past_due', pg_event_at = $2 WHERE pg_customer_ref = $1 AND status = 'active' AND ${newer}`, [ev.pgCustomerRef, ev.at]);
    else await this.db.run("UPDATE subscriptions SET status = 'canceled', pg_event_at = CASE WHEN pg_event_at IS NULL OR pg_event_at < $2 THEN $2 ELSE pg_event_at END WHERE pg_customer_ref = $1", [ev.pgCustomerRef, ev.at]);
  }

  async billingCardPage(ref: string, nonce: string): Promise<{ status: number; html: string }> {
    const b = this.billingOrFail();
    const sub = REF_RE.test(ref) ? await this.db.one<{ status: string; account_id: string }>('SELECT status, account_id FROM subscriptions WHERE pg_customer_ref = $1', [ref]) : undefined;
    if (!sub || (sub.status !== 'pending' && sub.status !== 'past_due'))
      return { status: 404, html: this.resultPage('결제 창이 만료됐어요', '앱에서 구독하기를 다시 눌러 주세요.', nonce) };
    const base = `${this.d.publicOrigin}/v1/billing/card`;
    const ent = sub.status === 'pending' ? await this.entitlement(sub.account_id) : null;
    const trialEndsAt = ent?.state === 'trial' && ent.until !== null ? ent.until : undefined;
    return { status: 200, html: b.cardPage({ customerKey: ref, successUrl: `${base}/success`, failUrl: `${base}/fail`, amountKrw: PLAN.amountKrw, nonce, ...(trialEndsAt ? { trialEndsAt } : {}) }) };
  }

  async billingCardSuccess(customerKey: string, authKey: string, nonce: string): Promise<{ status: number; html: string }> {
    const b = this.billingOrFail();
    const bad = () => ({ status: 400, html: this.resultPage('카드를 등록하지 못했어요', '앱에서 구독하기를 다시 눌러 주세요.', nonce) });
    if (!REF_RE.test(customerKey) || !/^[A-Za-z0-9_=.-]{1,300}$/.test(authKey)) return bad();
    const sub = await this.db.one<{ status: string; account_id: string }>('SELECT status, account_id FROM subscriptions WHERE pg_customer_ref = $1', [customerKey]);
    if (!sub || sub.status === 'canceled') return bad();
    if (sub.status === 'active') return { status: 200, html: this.resultPage('구독 중이에요', '이미 등록이 끝났어요. 앱으로 돌아가세요.', nonce) };
    const key = await b.issueBillingKey({ authKey, customerKey });
    if (!key) return bad();
    const now = this.now();
    const ent = sub.status === 'pending' ? await this.entitlement(sub.account_id) : null;
    if (ent?.state === 'trial' && ent.until !== null && ent.until > now) {
      const n = await this.db.run(
        "UPDATE subscriptions SET billing_key_sealed = $2, charge_attempts = 0, next_charge_at = NULL, renew_at = $3, status = 'active' WHERE pg_customer_ref = $1 AND status = 'pending'",
        [customerKey, sealAead(this.d.billingKeySealKey!, bkAad(customerKey), Buffer.from(key.billingKey, 'utf8')), ent.until],
      );
      if (n !== 1) return bad();
      await this.db.run('INSERT INTO consents (account_id, version, at) VALUES ($1, $2, $3) ON CONFLICT (account_id, version) DO NOTHING', [sub.account_id, TERMS_VERSION, now]);
      this.d.onEvent?.(`account.billing_key_issued_trial.${b.mode}`);
      return { status: 200, html: this.resultPage('카드를 등록했어요', `무료 체험은 그대로 이어져요. ${kstDateLabel(ent.until)}부터 매월 ${PLAN.amountKrw.toLocaleString('ko-KR')}원이 자동 결제돼요. 그 전에 해지하면 결제되지 않아요.`, nonce) };
    }
    const n = await this.db.run(
      "UPDATE subscriptions SET billing_key_sealed = $2, charge_attempts = 0, next_charge_at = NULL, renew_at = CASE WHEN status = 'pending' THEN $3 ELSE renew_at END WHERE pg_customer_ref = $1 AND status IN ('pending', 'past_due')",
      [customerKey, sealAead(this.d.billingKeySealKey!, bkAad(customerKey), Buffer.from(key.billingKey, 'utf8')), now],
    );
    if (n !== 1) return bad();
    await this.db.run('INSERT INTO consents (account_id, version, at) SELECT account_id, $2, $3 FROM subscriptions WHERE pg_customer_ref = $1 ON CONFLICT (account_id, version) DO NOTHING', [customerKey, TERMS_VERSION, now]);
    this.d.onEvent?.(`account.billing_key_issued.${b.mode}`);
    const r = await this.chargeRef(customerKey);
    if (r === 'paid') return { status: 200, html: this.resultPage('구독을 시작했어요', `${PLAN.amountKrw.toLocaleString('ko-KR')}원이 결제됐어요. 다음 달 같은 날짜에 자동으로 결제돼요.`, nonce) };
    if (r === 'declined') return { status: 402, html: this.resultPage('결제가 승인되지 않았어요', '카드 한도나 상태를 확인하고 다른 카드로 다시 시도해 주세요.', nonce) };
    return { status: 202, html: this.resultPage('결제를 확인하고 있어요', '잠시 뒤 앱에서 구독 상태를 확인해 주세요. 두 번 결제되지는 않아요.', nonce) };
  }

  billingCardFail(code: string, nonce: string): { status: number; html: string } {
    this.billingOrFail();
    const canceled = code === 'PAY_PROCESS_CANCELED' || code === 'USER_CANCEL';
    this.d.onEvent?.(`account.billing_card_fail.${/^[A-Z_]{1,64}$/.test(code) ? code : 'unknown'}`);
    return { status: 200, html: this.resultPage(canceled ? '카드 등록을 취소했어요' : '카드를 등록하지 못했어요', '앱에서 구독하기를 다시 눌러 주세요.', nonce) };
  }

  async chargeDue(limit = 200): Promise<{ paid: number; declined: number; uncertain: number }> {
    const out = { paid: 0, declined: 0, uncertain: 0 };
    if (!this.d.payments.billing) return out;
    const now = this.now();
    const due = await this.db.all<{ pg_customer_ref: string }>(
      "SELECT pg_customer_ref FROM subscriptions WHERE billing_key_sealed IS NOT NULL AND status IN ('pending', 'active', 'past_due') AND renew_at IS NOT NULL AND renew_at <= $1 AND (next_charge_at IS NULL OR next_charge_at <= $1) ORDER BY renew_at LIMIT $2",
      [now, limit],
    );
    for (const d of due) {
      const r = await this.chargeRef(d.pg_customer_ref);
      if (r !== 'busy') out[r]++;
    }
    return out;
  }

  private async chargeRef(ref: string): Promise<'paid' | 'declined' | 'uncertain' | 'busy'> {
    const b = this.billingOrFail();
    const now = this.now();
    const lease = await this.db.run(
      "UPDATE subscriptions SET next_charge_at = $2 WHERE pg_customer_ref = $1 AND billing_key_sealed IS NOT NULL AND status IN ('pending', 'active', 'past_due') AND renew_at IS NOT NULL AND renew_at <= $3 AND (next_charge_at IS NULL OR next_charge_at <= $3)",
      [ref, now + BILLING.chargeLeaseMs, now],
    );
    if (lease !== 1) return 'busy';
    const row = await this.db.one<{ account_id: string; status: string; renew_at: number; charge_attempts: number; billing_key_sealed: Buffer }>('SELECT account_id, status, renew_at, charge_attempts, billing_key_sealed FROM subscriptions WHERE pg_customer_ref = $1', [ref]);
    if (!row?.billing_key_sealed) return 'busy';
    const bk = openAead(this.d.billingKeySealKey!, bkAad(ref), Buffer.from(row.billing_key_sealed));
    if (!bk) {
      this.d.onEvent?.('account.billing_key_unsealable');
      return 'uncertain';
    }
    const periodStart = Number(row.renew_at);
    const attempts = Number(row.charge_attempts);
    const orderId = `${ref.slice(4)}-${periodStart.toString(36)}-${attempts}-${createHash('sha256').update(bk).digest('base64url').slice(0, 8)}`;
    const r = await b.charge({ billingKey: bk.toString('utf8'), customerKey: ref, orderId, amountKrw: PLAN.amountKrw, orderName: BILLING.orderName });
    if (r.ok) {
      await this.db.run(
        "UPDATE subscriptions SET status = CASE WHEN status = 'canceled' THEN status ELSE 'active' END, renew_at = $2, charge_attempts = 0, next_charge_at = NULL, last_payment_key = $4, last_paid_at = $5, last_paid_amount = $6 WHERE pg_customer_ref = $1 AND renew_at = $3",
        [ref, addMonthKst(periodStart), periodStart, r.paymentKey ?? null, now, PLAN.amountKrw],
      );
      this.d.onEvent?.(`account.billing_charged.${b.mode}`);
      if (!r.paymentKey) this.d.onEvent?.('account.billing_charged_without_payment_key');
      return 'paid';
    }
    if (r.uncertain) {
      this.d.onEvent?.(`account.billing_charge_uncertain.${r.code}`);
      return 'uncertain';
    }
    this.d.onEvent?.(`account.billing_charge_declined.${r.code}`);
    const failed = attempts + 1;
    if (row.status === 'pending') {
      await this.db.run('UPDATE subscriptions SET billing_key_sealed = NULL, charge_attempts = $2, next_charge_at = NULL WHERE pg_customer_ref = $1', [ref, failed]);
    } else if (failed >= BILLING.maxFailedCharges) {
      await this.db.tx(async (q) => {
        await q.run("UPDATE subscriptions SET status = 'canceled', billing_key_sealed = NULL, charge_attempts = $2, next_charge_at = NULL WHERE pg_customer_ref = $1", [ref, failed]);
        await this.enqueueNotice(q, row.account_id, 'subscription_ended', now);
      });
      this.d.onEvent?.('account.billing_canceled_after_failures');
      this.kickNotices();
    } else {
      await this.db.tx(async (q) => {
        await q.run("UPDATE subscriptions SET status = 'past_due', charge_attempts = $2, next_charge_at = $3 WHERE pg_customer_ref = $1 AND status <> 'canceled'", [ref, failed, now + BILLING.retryAfterMs]);
        await this.enqueueNotice(q, row.account_id, 'payment_failed', now);
      });
      this.kickNotices();
    }
    return 'declined';
  }

  async trialConversionNotices(): Promise<number> {
    if (!this.d.payments.billing) return 0;
    const now = this.now();
    const due = await this.db.all<{ account_id: string; pg_customer_ref: string }>(
      "SELECT account_id, pg_customer_ref FROM subscriptions WHERE status = 'active' AND billing_key_sealed IS NOT NULL AND last_paid_at IS NULL AND trial_notice_at IS NULL AND renew_at IS NOT NULL AND renew_at > $1 AND renew_at <= $2",
      [now, now + BILLING.trialNoticeMs],
    );
    for (const r of due) {
      await this.db.tx(async (q) => {
        if ((await q.run('UPDATE subscriptions SET trial_notice_at = $2 WHERE pg_customer_ref = $1 AND trial_notice_at IS NULL', [r.pg_customer_ref, now])) === 1) await this.enqueueNotice(q, r.account_id, 'trial_converting', now);
      });
    }
    if (due.length) this.kickNotices();
    return due.length;
  }

  private billingOrFail() {
    const b = this.d.payments.billing;
    if (!b) fail('request.not_found');
    return b!;
  }

  private resultPage(title: string, body: string, nonce: string): string {
    return resultPageHtml({ title, body, returnUrl: this.d.billingReturnUrl, nonce });
  }

  async subscription(s: BillingCaller): Promise<Record<string, unknown> | null> {
    const sub = await this.db.one<{ plan: string; status: string; renew_at: number | null; last_payment_key: string | null; last_paid_at: number | null; last_paid_amount: number | null }>(
      'SELECT plan, status, renew_at, last_payment_key, last_paid_at, last_paid_amount FROM subscriptions WHERE account_id = $1',
      [s.accountId],
    );
    if (!sub) return null;
    const out: Record<string, unknown> = { plan: sub.plan, status: sub.status, renewAt: sub.renew_at, amountKrw: PLAN.amountKrw, period: PLAN.period };
    const q = this.d.payments.billing ? this.refundQuote(sub, this.now()) : null;
    if (q) out.refund = q;
    return out;
  }

  async entitlementOf(s: BillingCaller): Promise<{ state: string; until: number | null; trialMonths: number }> {
    return { ...(await this.entitlement(s.accountId)), trialMonths: BILLING.trialMonths };
  }

  async cancelSubscription(s: BillingCaller): Promise<void> {
    const sub = await this.db.one<{ pg_customer_ref: string; status: string }>('SELECT pg_customer_ref, status FROM subscriptions WHERE account_id = $1', [s.accountId]);
    if (!sub || sub.status === 'canceled') fail('request.param_rejected');
    await this.d.payments.cancel(sub!.pg_customer_ref);
    await this.db.tx(async (q) => {
      await q.run("UPDATE subscriptions SET status = 'canceled', billing_key_sealed = NULL, next_charge_at = NULL WHERE account_id = $1", [s.accountId]);
      await this.enqueueNotice(q, s.accountId, 'subscription_canceled', this.now());
    });
    this.kickNotices();
  }

  refundQuote(sub: { last_payment_key: string | null; last_paid_at: number | null; last_paid_amount: number | null; renew_at: number | null }, now: number): { refundableUntil: number; amountKrw: number } | null {
    if (!sub.last_payment_key || sub.last_paid_at === null || sub.last_paid_amount === null || sub.renew_at === null) return null;
    const paidAt = Number(sub.last_paid_at);
    const until = paidAt + BILLING.refundWindowMs;
    if (now >= until) return null;
    const paid = Number(sub.last_paid_amount);
    const periodDays = Math.max(1, Math.round((Number(sub.renew_at) - paidAt) / MS.D));
    const usedDays = Math.floor((now - paidAt) / MS.D);
    return { refundableUntil: until, amountKrw: Math.max(0, paid - Math.ceil((paid * usedDays) / periodDays)) };
  }

  async refundSubscription(s: BillingCaller): Promise<{ amountKrw: number }> {
    const b = this.d.payments.billing;
    if (!b) fail('account.refund_unavailable');
    const now = this.now();
    const sub = await this.db.one<{ pg_customer_ref: string; status: string; last_payment_key: string | null; last_paid_at: number | null; last_paid_amount: number | null; renew_at: number | null }>(
      'SELECT pg_customer_ref, status, last_payment_key, last_paid_at, last_paid_amount, renew_at FROM subscriptions WHERE account_id = $1',
      [s.accountId],
    );
    const quote = sub && this.refundQuote(sub, now);
    if (!sub || !quote) fail('account.refund_unavailable');
    const key = sub!.last_payment_key!;
    if ((await this.db.run('UPDATE subscriptions SET last_payment_key = NULL WHERE account_id = $1 AND last_payment_key = $2', [s.accountId, key])) !== 1) fail('account.refund_unavailable');
    const r = quote!.amountKrw > 0 ? await b!.refund({ paymentKey: key, amountKrw: quote!.amountKrw, reason: '청약철회', idempotencyKey: `refund-${key}`.slice(0, 300) }) : ({ ok: true } as const);
    if (!r.ok) {
      await this.db.run('UPDATE subscriptions SET last_payment_key = $2 WHERE account_id = $1 AND last_payment_key IS NULL', [s.accountId, key]);
      this.d.onEvent?.(`account.billing_refund_failed.${r.code}`);
      fail('account.refund_failed');
    }
    await this.db.tx(async (q) => {
      await q.run("UPDATE subscriptions SET status = 'canceled', billing_key_sealed = NULL, next_charge_at = NULL, renew_at = $2 WHERE account_id = $1", [s.accountId, now]);
      await this.enqueueNotice(q, s.accountId, 'subscription_refunded', now);
    });
    this.d.onEvent?.(`account.billing_refunded.${b!.mode}`);
    this.kickNotices();
    return { amountKrw: quote!.amountKrw };
  }

  async entitlement(accountId: string): Promise<{ state: 'trial' | 'paid' | 'none'; until: number | null }> {
    const now = this.now();
    const a = await this.db.one<{ created_at: number }>('SELECT created_at FROM accounts WHERE id = $1', [accountId]);
    const sub = await this.db.one<{ status: string; renew_at: number | null }>('SELECT status, renew_at FROM subscriptions WHERE account_id = $1', [accountId]);
    const renew = sub?.renew_at === null || sub?.renew_at === undefined ? null : Number(sub.renew_at);
    if (sub && renew !== null) {
      if (sub.status === 'active' && renew > now) return { state: 'paid', until: renew };
      if ((sub.status === 'active' || sub.status === 'past_due') && renew + BILLING.pastDueGraceMs > now) return { state: 'paid', until: renew + BILLING.pastDueGraceMs };
      if (sub.status === 'canceled' && renew > now) return { state: 'paid', until: renew };
    }
    let trialEnd = a ? Number(a.created_at) : 0;
    for (let i = 0; a && i < BILLING.trialMonths; i++) trialEnd = addMonthKst(trialEnd);
    if (trialEnd > now) return { state: 'trial', until: trialEnd };
    return { state: 'none', until: null };
  }

  private async churnOk(q: Sql, accountId: string, role: 'desktop' | 'mobile'): Promise<boolean> {
    if (role === 'mobile') return true;
    const since = kstDay(this.now() - DEVICE.churnWindowDays * MS.D);
    const r = await q.one<{ n: number }>("SELECT COUNT(*) AS n FROM device_events WHERE account_id = $1 AND role = $2 AND kind = 'add' AND day >= $3", [accountId, role, since]);
    return Number(r?.n ?? 0) < DEVICE.churnDesktop;
  }

  private async countOk(q: Sql, accountId: string, role: 'desktop' | 'mobile', extra = 1): Promise<boolean> {
    const states = role === 'mobile' ? "state IN ('active', 'pending')" : "state <> 'revoked'";
    const r = await q.one<{ n: number }>(`SELECT COUNT(*) AS n FROM devices WHERE account_id = $1 AND role = $2 AND ${states}`, [accountId, role]);
    return Number(r?.n ?? 0) + extra <= (role === 'desktop' ? DEVICE.maxDesktops : DEVICE.maxMobiles);
  }

  private async requireStrongSessionIfPasskeys(q: Sql, s: Session): Promise<void> {
    if (s.authMethod === 'passkey') return;
    const r = await q.one<{ n: number }>('SELECT COUNT(*) AS n FROM passkeys WHERE account_id = $1', [s.accountId]);
    if (Number(r?.n ?? 0) > 0) fail('account.passkey_required');
  }

  async pinFirstDesktop(s: Session, o: { aikPub: string; deviceList: DeviceList; platform: string; name: string; escrow?: { enc: string; ct: string } }): Promise<{ deviceId: string }> {
    const aik = fromB64(o.aikPub, 32);
    if (!aik) fail('request.param_rejected');
    const sealed = o.escrow && this.d.escrow ? this.sealedFor(aik!, o.escrow) : null;
    const l = o.deviceList;
    const e = l.entries[0];
    if (l.listVersion !== 1 || l.entries.length !== 1 || l.revoked.length !== 0 || !e || e.entry.role !== 'desktop' || e.entry.list_version !== 1) fail('request.param_rejected');
    if (!entrySigOk(aik!, e!)) fail('account.aik_signature_invalid');
    return this.db.tx(async (q) => {
      const a = await q.one<AccountRow>(`SELECT * FROM accounts WHERE id = $1${q.forUpdate}`, [s.accountId]);
      if (!a) return fail('account.unauthorized');
      if (a.aik_pub) fail('account.aik_already_pinned');
      await this.requireStrongSessionIfPasskeys(q, s);
      const desk = await q.one<{ n: number }>("SELECT COUNT(*) AS n FROM devices WHERE account_id = $1 AND role = 'desktop' AND state IN ('active', 'suspended')", [s.accountId]);
      if (Number(desk?.n ?? 0) > 0) fail('account.aik_already_pinned');
      const replaced = (await q.run("DELETE FROM devices WHERE device_id = $1 AND account_id = $2 AND role = 'desktop' AND state = 'pending'", [e!.entry.device_id, s.accountId])) > 0;
      if (!(await this.countOk(q, s.accountId, 'desktop'))) fail('account.device_limit');
      if (!replaced && !(await this.churnOk(q, s.accountId, 'desktop'))) fail('account.device_churn_limit');
      const now = this.now();
      await q.run(
        "INSERT INTO devices (device_id, account_id, role, platform, name, sx, vx, registered_at, state) VALUES ($1, $2, 'desktop', $3, $4, $5, $6, $7, 'active')",
        [e!.entry.device_id, s.accountId, o.platform, o.name, e!.entry.Sx, e!.entry.Vx, now],
      ).catch(() => fail('request.param_rejected'));
      await q.run('UPDATE accounts SET aik_pub = $1, aik_pinned_at = $2, device_list_version = 1, device_list_json = $3 WHERE id = $4', [o.aikPub, now, jcs(l), s.accountId]);
      if (sealed) await this.storeEscrow(q, s.accountId, o.aikPub, sealed);
      if (!replaced) await q.run("INSERT INTO device_events (account_id, role, kind, day) VALUES ($1, 'desktop', 'add', $2)", [s.accountId, kstDay(now)]);
      return { deviceId: e!.entry.device_id };
    }).then(async (r) => {
      await this.notify(s.accountId, 'aik_pinned');
      return r;
    });
  }

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

  async enrollByDesktop(
    requester: { accountId: string; deviceId: string },
    o: { deviceId: string; platform: string; name: string; Sx: string; Vx: string; roomId: string },
  ): Promise<{ created: boolean; holdUntil: number | null; state: 'pending' | 'active' }> {
    if (!this.d.pairing) fail('relay.room_unavailable');
    const same = (d: DeviceRow) => ({ created: false, holdUntil: d.state === 'pending' ? d.email_hold_until : null, state: d.state as 'pending' | 'active' });
    const redeem = async () => {
      const r = await this.d.pairing!.redeem(o.roomId, requester.deviceId);
      if (r === 'used') fail('relay.room_used');
      if (r !== 'ok') fail('relay.room_unavailable');
    };
    const prev = await this.mobileReenroll(this.db, requester, o);
    if (prev) {
      await this.requireActiveDesktop(this.db, requester);
      await redeem();
      return same(prev);
    }
    if (!(await this.countOk(this.db, requester.accountId, 'mobile'))) fail('account.device_limit');
    if (!(await this.churnOk(this.db, requester.accountId, 'mobile'))) fail('account.device_churn_limit');
    await redeem();
    const r = await this.db.tx(async (q) => {
      await q.one(`SELECT id FROM accounts WHERE id = $1${q.forUpdate}`, [requester.accountId]);
      await this.requireActiveDesktop(q, requester);
      const raced = await this.mobileReenroll(q, requester, o);
      if (raced) return same(raced);
      if (!(await this.countOk(q, requester.accountId, 'mobile'))) fail('account.device_limit');
      if (!(await this.churnOk(q, requester.accountId, 'mobile'))) fail('account.device_churn_limit');
      const now = this.now();
      const holdUntil = now + DEVICE.emailOnlyAddDelayHours * MS.H;
      await q.run("INSERT INTO devices (device_id, account_id, role, platform, name, sx, vx, registered_at, state, email_hold_until) VALUES ($1, $2, 'mobile', $3, $4, $5, $6, $7, 'pending', $8)", [
        o.deviceId,
        requester.accountId,
        o.platform,
        o.name,
        o.Sx,
        o.Vx,
        now,
        holdUntil,
      ]);
      await q.run("INSERT INTO device_events (account_id, role, kind, day) VALUES ($1, 'mobile', 'add', $2)", [requester.accountId, kstDay(now)]);
      return { created: true, holdUntil, state: 'pending' as const };
    });
    if (r.created) await this.notify(requester.accountId, 'device_enrolled');
    return r;
  }

  private async requireActiveDesktop(q: Sql, requester: { accountId: string; deviceId: string }): Promise<void> {
    const me = await q.one<DeviceRow>('SELECT * FROM devices WHERE device_id = $1 AND account_id = $2', [requester.deviceId, requester.accountId]);
    if (!me || me.role !== 'desktop' || me.state !== 'active') fail('account.scope_denied');
  }

  private async mobileReenroll(q: Sql, requester: { accountId: string }, o: { deviceId: string; Sx: string; Vx: string }): Promise<DeviceRow | null> {
    const d = await q.one<DeviceRow>('SELECT * FROM devices WHERE device_id = $1', [o.deviceId]);
    if (!d) return null;
    if (d.account_id === requester.accountId && d.role === 'mobile' && (d.state === 'pending' || d.state === 'active') && d.sx === o.Sx && d.vx === o.Vx) return d;
    return fail('request.param_rejected');
  }

  async acctClaim(requester: { accountId: string; deviceId: string }): Promise<SignedAcctClaim> {
    if (!this.d.acctClaims) fail('request.not_found');
    const a = await this.account(requester.accountId);
    if (a.status !== 'active') fail('account.unauthorized');
    await this.requireActiveDesktop(this.db, requester);
    if (!a.aik_pub) fail('account.aik_not_pinned');
    return this.d.acctClaims!.sign({ account_id: a.id, email: a.email, aik_pub: a.aik_pub! }, this.now());
  }

  async activateAfterHold(s: Session, deviceId: string): Promise<void> {
    await this.db.tx(async (q) => {
      await this.requireStrongSessionIfPasskeys(q, s);
      const d = await q.one<DeviceRow>(`SELECT * FROM devices WHERE device_id = $1 AND account_id = $2${q.forUpdate}`, [deviceId, s.accountId]);
      if (!d) fail('account.device_not_found');
      if (d!.state !== 'pending') fail('account.not_pending');
      if ((d!.email_hold_until ?? Infinity) > this.now()) fail('account.device_hold', { retryAfterSec: Math.ceil(((d!.email_hold_until ?? 0) - this.now()) / 1000) });
      if (!(await this.countOk(q, s.accountId, d!.role, 0))) fail('account.device_limit');
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
      lastSeenAt: d.last_seen_at == null ? null : Number(d.last_seen_at),
    }));
  }

  async deviceList(accountId: string): Promise<{ aikPub: string | null; deviceList: DeviceList | null }> {
    const a = await this.account(accountId);
    return { aikPub: a.aik_pub, deviceList: a.device_list_json ? (JSON.parse(a.device_list_json) as DeviceList) : null };
  }

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
      for (const d of devices) if ((d.state === 'active' || d.state === 'suspended') && !ids.has(d.device_id) && !revoked.has(d.device_id)) fail('request.param_rejected');
      for (const role of ['desktop', 'mobile'] as const) {
        const n = toActivate.filter((d) => d.role === role).length;
        if (n && !(await this.countOk(q, requester.accountId, role, 0))) fail('account.device_limit');
      }
      for (const d of toActivate) await q.run("UPDATE devices SET state = 'active', email_hold_until = NULL WHERE device_id = $1", [d.device_id]);
      const first = a.aik_pinned_at !== null && Number(me!.registered_at) <= Number(a.aik_pinned_at);
      const cooling = !first && now - me!.registered_at < DEVICE.newDeviceCoolingDays * MS.D;
      for (const [id, r] of revoked) {
        const d = byId.get(id);
        if (!d || d.state === 'revoked') continue;
        if (cooling && d.role === 'desktop') {
          await q.run('UPDATE devices SET delete_after = COALESCE(delete_after, $1), revoke_record = $2 WHERE device_id = $3', [now + ACCOUNT.deleteGraceDays * MS.D, jcs(r), id]);
        } else {
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

  async leave(requester: { accountId: string; deviceId: string }): Promise<void> {
    await this.db.tx(async (q) => {
      await q.one(`SELECT id FROM accounts WHERE id = $1${q.forUpdate}`, [requester.accountId]);
      const me = await q.one<DeviceRow>('SELECT * FROM devices WHERE device_id = $1 AND account_id = $2', [requester.deviceId, requester.accountId]);
      if (!me || me.state !== 'active') return fail('account.device_not_found');
      if (me.role === 'desktop' && !(await this.otherActiveDesktop(q, requester.accountId, me.device_id))) fail('account.last_desktop');
      const now = this.now();
      await q.run("UPDATE devices SET state = 'revoked', delete_after = NULL WHERE device_id = $1", [me.device_id]);
      await q.run("INSERT INTO device_events (account_id, role, kind, day) VALUES ($1, $2, 'remove', $3)", [requester.accountId, me.role, kstDay(now)]);
    });
    await this.stopped(requester.deviceId);
    await this.notify(requester.accountId, 'device_revoked');
  }

  async stopByDevice(requester: { accountId: string; deviceId: string }, deviceId: string): Promise<{ deleteAfter: number }> {
    if (deviceId === requester.deviceId) fail('request.param_rejected');
    const after = await this.db.tx(async (q) => {
      await q.one(`SELECT id FROM accounts WHERE id = $1${q.forUpdate}`, [requester.accountId]);
      const d = await q.one<DeviceRow>('SELECT * FROM devices WHERE device_id = $1 AND account_id = $2', [deviceId, requester.accountId]);
      if (!d || d.state === 'revoked') return fail('account.device_not_found');
      if (d.role === 'desktop' && d.state === 'active' && !(await this.otherActiveDesktop(q, requester.accountId, d.device_id))) fail('account.last_desktop');
      const at = d.delete_after ?? this.now() + ACCOUNT.deleteGraceDays * MS.D;
      await q.run("UPDATE devices SET state = 'suspended', delete_after = $1 WHERE device_id = $2", [at, deviceId]);
      return Number(at);
    });
    await this.stopped(deviceId);
    await this.notify(requester.accountId, 'device_suspended');
    return { deleteAfter: after };
  }


  async putPcLinkHello(s: Session, deviceId: string, hello: { device_id: string; Sx: string; Vx: string }): Promise<void> {
    await this.db.tx(async (q) => {
      const d = await q.one<DeviceRow>('SELECT * FROM devices WHERE device_id = $1 AND account_id = $2', [deviceId, s.accountId]);
      if (!d || d.role !== 'desktop' || (d.state !== 'pending' && d.state !== 'active')) return fail('account.device_not_found');
      if (hello.device_id !== deviceId || hello.Sx !== d.sx || hello.Vx !== d.vx) fail('request.param_rejected');
      const now = this.now();
      await q.run('DELETE FROM pc_links WHERE device_id = $1', [deviceId]);
      await q.run('INSERT INTO pc_links (device_id, account_id, hello, created_at, expires_at) VALUES ($1, $2, $3, $4, $5)', [deviceId, s.accountId, jcs(hello), now, now + PC_LINK.ttlDays * MS.D]);
    });
  }

  async pcLinkForNew(s: Session, deviceId: string): Promise<{ challenge: unknown; grant: unknown }> {
    const l = await this.pcLink(s.accountId, deviceId);
    return { challenge: l.challenge ? JSON.parse(l.challenge) : null, grant: l.grant_msg ? JSON.parse(l.grant_msg) : null };
  }

  async putPcLinkReveal(s: Session, deviceId: string, reveal: unknown): Promise<void> {
    const n = await this.db.run('UPDATE pc_links SET reveal = $1 WHERE device_id = $2 AND account_id = $3 AND challenge IS NOT NULL AND reveal IS NULL AND expires_at > $4', [jcs(reveal), deviceId, s.accountId, this.now()]);
    if (!n) {
      await this.pcLink(s.accountId, deviceId);
      fail('account.link_state');
    }
  }

  async pcLinks(accountId: string): Promise<Array<{ deviceId: string; name: string; platform: string; createdAt: number; hello: unknown; challengedBy: string | null; reveal: unknown }>> {
    const rows = await this.db.all<{ device_id: string; hello: string; challenge: string | null; reveal: string | null; created_at: number; name: string; platform: string }>(
      "SELECT l.device_id, l.hello, l.challenge, l.reveal, l.created_at, d.name, d.platform FROM pc_links l JOIN devices d ON d.device_id = l.device_id WHERE l.account_id = $1 AND l.expires_at > $2 AND l.grant_msg IS NULL AND d.state IN ('pending', 'active') ORDER BY l.created_at",
      [accountId, this.now()],
    );
    return rows.map((r) => ({
      deviceId: r.device_id,
      name: r.name,
      platform: r.platform,
      createdAt: Number(r.created_at),
      hello: JSON.parse(r.hello),
      challengedBy: r.challenge ? ((JSON.parse(r.challenge) as { device_id?: string }).device_id ?? null) : null,
      reveal: r.reveal ? JSON.parse(r.reveal) : null,
    }));
  }

  async putPcLinkChallenge(requester: { accountId: string; deviceId: string }, deviceId: string, challenge: { device_id: string }): Promise<void> {
    if (challenge.device_id !== requester.deviceId || deviceId === requester.deviceId) fail('request.param_rejected');
    const n = await this.db.run('UPDATE pc_links SET challenge = $1 WHERE device_id = $2 AND account_id = $3 AND challenge IS NULL AND expires_at > $4', [jcs(challenge), deviceId, requester.accountId, this.now()]);
    if (!n) {
      await this.pcLink(requester.accountId, deviceId);
      fail('account.link_state');
    }
  }

  async putPcLinkGrant(requester: { accountId: string; deviceId: string }, deviceId: string, grant: unknown): Promise<void> {
    await this.db.tx(async (q) => {
      const l = await q.one<{ challenge: string | null; reveal: string | null; grant_msg: string | null; expires_at: number }>(`SELECT challenge, reveal, grant_msg, expires_at FROM pc_links WHERE device_id = $1 AND account_id = $2${q.forUpdate}`, [deviceId, requester.accountId]);
      if (!l || Number(l.expires_at) <= this.now()) return fail('account.link_not_found');
      const by = l.challenge ? (JSON.parse(l.challenge) as { device_id?: string }).device_id : null;
      const d = await q.one<DeviceRow>('SELECT * FROM devices WHERE device_id = $1 AND account_id = $2', [deviceId, requester.accountId]);
      if (by !== requester.deviceId || !l.reveal || l.grant_msg || !d || d.state !== 'active') fail('account.link_state');
      await q.run('UPDATE pc_links SET grant_msg = $1 WHERE device_id = $2', [jcs(grant), deviceId]);
    });
  }

  async deletePcLink(accountId: string, deviceId: string, dropPending = false): Promise<void> {
    await this.db.tx(async (q) => {
      await q.run('DELETE FROM pc_links WHERE device_id = $1 AND account_id = $2', [deviceId, accountId]);
      if (dropPending) await q.run("DELETE FROM devices WHERE device_id = $1 AND account_id = $2 AND role = 'desktop' AND state = 'pending'", [deviceId, accountId]);
    });
  }

  private async pcLink(accountId: string, deviceId: string): Promise<{ challenge: string | null; reveal: string | null; grant_msg: string | null }> {
    const l = await this.db.one<{ challenge: string | null; reveal: string | null; grant_msg: string | null }>('SELECT challenge, reveal, grant_msg FROM pc_links WHERE device_id = $1 AND account_id = $2 AND expires_at > $3', [deviceId, accountId, this.now()]);
    return l ?? fail('account.link_not_found');
  }


  private get escrow(): KeyEscrow {
    return this.d.escrow ?? fail('request.not_found');
  }

  async keyEscrowState(accountId: string): Promise<{ pub: string; stored: boolean }> {
    const e = this.escrow;
    const a = await this.account(accountId);
    const r = await this.db.one<{ aik_pub: string; key_pub: string }>('SELECT aik_pub, key_pub FROM key_escrow WHERE account_id = $1', [accountId]);
    return { pub: e.publicKey, stored: !!r && !!a.aik_pub && r.aik_pub === a.aik_pub && r.key_pub === e.publicKey };
  }

  async putKeyEscrow(requester: { accountId: string; deviceId: string }, o: { enc: string; ct: string }): Promise<void> {
    const e = this.escrow;
    const enc = fromB64(o.enc, 32);
    const ct = fromB64(o.ct, 48);
    if (!enc || !ct) fail('request.param_rejected');
    await this.db.tx(async (q) => {
      const a = await q.one<AccountRow>(`SELECT * FROM accounts WHERE id = $1${q.forUpdate}`, [requester.accountId]);
      if (!a) return fail('account.unauthorized');
      if (!a.aik_pub) fail('account.aik_not_pinned');
      await this.requireActiveDesktop(q, requester);
      if (!e.holds(enc!, ct!, fromB64(a.aik_pub, 32)!)) fail('request.param_rejected');
      await q.run('DELETE FROM key_escrow WHERE account_id = $1', [requester.accountId]);
      await q.run('INSERT INTO key_escrow (account_id, aik_pub, key_pub, enc, ct) VALUES ($1, $2, $3, $4, $5)', [requester.accountId, a.aik_pub, e.publicKey, o.enc, o.ct]);
    });
    this.d.onEvent?.('account.key_escrow_stored');
  }

  async claimKeyEscrow(s: Session, deviceId: string, linkPub: string): Promise<{ aikPub: string; enc: string; ct: string }> {
    const e = this.escrow;
    const hx = fromB64(linkPub, 32);
    if (!hx) fail('request.param_rejected');
    await this.requireStrongSessionIfPasskeys(this.db, s);
    const a = await this.account(s.accountId);
    const d = await this.db.one<DeviceRow>('SELECT * FROM devices WHERE device_id = $1 AND account_id = $2', [deviceId, s.accountId]);
    if (!d || d.role !== 'desktop' || (d.state !== 'pending' && d.state !== 'active')) fail('account.device_not_found');
    const r = await this.db.one<{ aik_pub: string; enc: string; ct: string }>('SELECT aik_pub, enc, ct FROM key_escrow WHERE account_id = $1', [s.accountId]);
    if (!a.aik_pub || !r || r.aik_pub !== a.aik_pub) return fail('account.escrow_missing');
    const out = e.reseal(fromB64(r.enc, 32)!, fromB64(r.ct, 48)!, fromB64(a.aik_pub, 32)!, deviceId, hx!);
    if (!out) return fail('account.escrow_missing');
    this.d.onEvent?.('account.key_escrow_claimed');
    return { aikPub: a.aik_pub, enc: out.enc.toString('base64'), ct: out.ct.toString('base64') };
  }

  async joinByKeyEscrow(s: Session, deviceId: string, l: DeviceList): Promise<{ listVersion: number }> {
    void this.escrow;
    await this.requireStrongSessionIfPasskeys(this.db, s);
    const d = await this.db.one<DeviceRow>('SELECT * FROM devices WHERE device_id = $1 AND account_id = $2', [deviceId, s.accountId]);
    if (!d || d.role !== 'desktop' || (d.state !== 'pending' && d.state !== 'active')) fail('account.device_not_found');
    const cur = (await this.deviceList(s.accountId)).deviceList;
    if (!cur || l.revoked.length !== cur.revoked.length || l.entries.length !== cur.entries.length + 1) fail('request.param_rejected');
    const out = await this.updateDeviceList({ accountId: s.accountId, deviceId }, l);
    await this.db.run('DELETE FROM pc_links WHERE device_id = $1 AND account_id = $2', [deviceId, s.accountId]);
    this.d.onEvent?.('account.key_escrow_joined');
    return out;
  }

  private sealedFor(aik: Buffer, o: { enc: string; ct: string }): { enc: string; ct: string } {
    const enc = fromB64(o.enc, 32);
    const ct = fromB64(o.ct, 48);
    if (!enc || !ct || !this.escrow.holds(enc, ct, aik)) fail('request.param_rejected');
    return { enc: o.enc, ct: o.ct };
  }

  private async storeEscrow(q: Sql, accountId: string, aikPub: string, o: { enc: string; ct: string }): Promise<void> {
    await q.run('DELETE FROM key_escrow WHERE account_id = $1', [accountId]);
    await q.run('INSERT INTO key_escrow (account_id, aik_pub, key_pub, enc, ct) VALUES ($1, $2, $3, $4, $5)', [accountId, aikPub, this.escrow.publicKey, o.enc, o.ct]);
  }

  keyEscrowPub(): { pub: string } {
    return { pub: this.escrow.publicKey };
  }

  async resetByKeyEscrow(s: Session, deviceId: string, o: { aikPub: string; deviceList: DeviceList; enc: string; ct: string }): Promise<{ listVersion: number }> {
    const aik = fromB64(o.aikPub, 32);
    if (!aik) fail('request.param_rejected');
    const sealed = this.sealedFor(aik!, o);
    const l = o.deviceList;
    const dropped: string[] = [];
    await this.db.tx(async (q) => {
      const a = await q.one<AccountRow>(`SELECT * FROM accounts WHERE id = $1${q.forUpdate}`, [s.accountId]);
      if (!a) return fail('account.unauthorized');
      if (!a.aik_pub) fail('account.aik_not_pinned');
      await this.requireStrongSessionIfPasskeys(q, s);
      if (a.aik_pub === o.aikPub) fail('account.aik_already_pinned');
      const held = await q.one<{ aik_pub: string; enc: string; ct: string }>('SELECT aik_pub, enc, ct FROM key_escrow WHERE account_id = $1', [s.accountId]);
      if (held && held.aik_pub === a.aik_pub && this.escrow.holds(fromB64(held.enc, 32)!, fromB64(held.ct, 48)!, fromB64(a.aik_pub!, 32)!)) fail('account.aik_already_pinned');
      if (l.listVersion !== Number(a.device_list_version) + 1 || l.revoked.length !== 0) fail('request.param_rejected');
      const ids = new Set<string>();
      for (const e of l.entries) {
        if (ids.has(e.entry.device_id) || e.entry.role !== 'desktop' || e.entry.list_version > l.listVersion || !entrySigOk(aik!, e)) fail('account.aik_signature_invalid');
        ids.add(e.entry.device_id);
      }
      const devices = await q.all<DeviceRow>('SELECT * FROM devices WHERE account_id = $1', [s.accountId]);
      const byId = new Map(devices.map((d) => [d.device_id, d]));
      const me = byId.get(deviceId);
      if (!me || me.role !== 'desktop' || (me.state !== 'pending' && me.state !== 'active')) fail('account.device_not_found');
      if (!ids.has(deviceId)) fail('request.param_rejected');
      for (const e of l.entries) {
        const d = byId.get(e.entry.device_id);
        if (!d || d.sx !== e.entry.Sx || d.vx !== e.entry.Vx) fail('request.param_rejected');
        if (d!.device_id !== deviceId && d!.state !== 'active' && d!.state !== 'suspended') fail('request.param_rejected');
      }
      for (const d of devices) if (d.role === 'desktop' && (d.state === 'active' || d.state === 'suspended') && !ids.has(d.device_id)) fail('request.param_rejected');
      const now = this.now();
      if (me!.state === 'pending') await q.run("UPDATE devices SET state = 'active', email_hold_until = NULL WHERE device_id = $1", [deviceId]);
      for (const d of devices) {
        if (d.role !== 'mobile' || d.state === 'revoked') continue;
        await q.run("UPDATE devices SET state = 'revoked', delete_after = NULL WHERE device_id = $1", [d.device_id]);
        await q.run("INSERT INTO device_events (account_id, role, kind, day) VALUES ($1, 'mobile', 'remove', $2)", [s.accountId, kstDay(now)]);
        dropped.push(d.device_id);
      }
      await q.run('UPDATE accounts SET aik_pub = $1, device_list_version = $2, device_list_json = $3 WHERE id = $4', [o.aikPub, l.listVersion, jcs(l), s.accountId]);
      await this.storeEscrow(q, s.accountId, o.aikPub, sealed);
      await q.run('DELETE FROM share_rows WHERE account_id = $1', [s.accountId]);
      await q.run('DELETE FROM share_tasks WHERE account_id = $1', [s.accountId]);
      await q.run('UPDATE share_heads SET epoch = 0 WHERE account_id = $1', [s.accountId]);
      await q.run('DELETE FROM pc_links WHERE account_id = $1', [s.accountId]);
    });
    for (const id of dropped) await this.stopped(id);
    await this.notify(s.accountId, 'aik_pinned');
    if (dropped.length) await this.notify(s.accountId, 'device_revoked');
    this.d.onEvent?.('account.key_escrow_reset');
    return { listVersion: l.listVersion };
  }


  async acquireIssueLock(requester: { accountId: string; deviceId: string }): Promise<{ lockId: string; expiresAt: number }> {
    return this.db.tx(async (q) => {
      await q.one(`SELECT id FROM accounts WHERE id = $1${q.forUpdate}`, [requester.accountId]);
      const now = this.now();
      const cur = await q.one<{ device_id: string; expires_at: number }>('SELECT device_id, expires_at FROM issue_locks WHERE account_id = $1', [requester.accountId]);
      if (cur && Number(cur.expires_at) > now && cur.device_id !== requester.deviceId) fail('account.issue_locked');
      const lockId = randomToken();
      const expiresAt = now + ISSUE_LOCK.ttlMs;
      if (cur) await q.run('UPDATE issue_locks SET device_id = $1, hold_id = $2, expires_at = $3 WHERE account_id = $4', [requester.deviceId, lockId, expiresAt, requester.accountId]);
      else await q.run('INSERT INTO issue_locks (account_id, device_id, hold_id, expires_at) VALUES ($1, $2, $3, $4)', [requester.accountId, requester.deviceId, lockId, expiresAt]);
      return { lockId, expiresAt };
    });
  }

  async renewIssueLock(requester: { accountId: string; deviceId: string }, lockId: string): Promise<{ expiresAt: number }> {
    const now = this.now();
    const expiresAt = now + ISSUE_LOCK.ttlMs;
    const n = await this.db.run('UPDATE issue_locks SET expires_at = $1 WHERE account_id = $2 AND device_id = $3 AND hold_id = $4 AND expires_at > $5', [expiresAt, requester.accountId, requester.deviceId, lockId, now]);
    if (!n) fail('account.issue_lock_lost');
    return { expiresAt };
  }

  async releaseIssueLock(requester: { accountId: string; deviceId: string }, lockId: string): Promise<void> {
    await this.db.run('DELETE FROM issue_locks WHERE account_id = $1 AND device_id = $2 AND hold_id = $3', [requester.accountId, requester.deviceId, lockId]);
  }

  async issueLock(accountId: string): Promise<{ held: boolean; deviceId: string | null; expiresAt: number | null }> {
    const cur = await this.db.one<{ device_id: string; expires_at: number }>('SELECT device_id, expires_at FROM issue_locks WHERE account_id = $1', [accountId]);
    if (!cur || Number(cur.expires_at) <= this.now()) return { held: false, deviceId: null, expiresAt: null };
    return { held: true, deviceId: cur.device_id, expiresAt: Number(cur.expires_at) };
  }


  async putShareRow(
    requester: { accountId: string; deviceId: string; role: 'desktop' | 'mobile' },
    row: { rowId: string; kind: ShareKind; epoch: number; body: string; taskId?: string },
  ): Promise<{ seq: number }> {
    if (requester.role !== 'desktop' && !(SHARE.mobileKinds as readonly string[]).includes(row.kind)) fail('account.scope_denied');
    if ((row.kind === 'task_result') !== (row.taskId !== undefined)) fail('request.param_rejected');
    return this.db.tx(async (q) => {
      await q.one(`SELECT id FROM accounts WHERE id = $1${q.forUpdate}`, [requester.accountId]);
      const now = this.now();
      const dup = await q.one<{ seq: number; kind: string; epoch: number; device_id: string; sealed: string }>(
        'SELECT seq, kind, epoch, device_id, sealed FROM share_rows WHERE account_id = $1 AND row_id = $2',
        [requester.accountId, row.rowId],
      );
      if (dup) {
        if (dup.kind !== row.kind || Number(dup.epoch) !== row.epoch || dup.device_id !== requester.deviceId || dup.sealed !== row.body) fail('account.share_row_conflict');
        return { seq: Number(dup.seq) };
      }
      const devs = await q.one<{ n: number }>("SELECT COUNT(*) AS n FROM devices WHERE account_id = $1 AND state = 'active'", [requester.accountId]);
      if (Number(devs?.n ?? 0) < 2) fail('account.share_single_device');
      const head = await q.one<{ next_seq: number; epoch: number }>('SELECT next_seq, epoch FROM share_heads WHERE account_id = $1', [requester.accountId]);
      if (head && row.epoch < Number(head.epoch)) fail('account.share_epoch_stale');
      const rows = await q.one<{ n: number }>('SELECT COUNT(*) AS n FROM share_rows WHERE account_id = $1', [requester.accountId]);
      if (Number(rows?.n ?? 0) >= SHARE.maxRows) fail('account.share_full');
      if (row.kind === 'task_result') {
        const n = await q.run("UPDATE share_tasks SET state = 'done', claim_expires_at = NULL, updated_at = $1 WHERE account_id = $2 AND task_id = $3 AND state = 'claimed' AND claimed_by = $4", [
          now,
          requester.accountId,
          row.taskId!,
          requester.deviceId,
        ]);
        if (!n) fail('account.task_not_claimed');
      }
      const seq = Number(head?.next_seq ?? 1);
      await q.run('INSERT INTO share_rows (account_id, seq, row_id, kind, epoch, device_id, task_id, sealed, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)', [
        requester.accountId,
        seq,
        row.rowId,
        row.kind,
        row.epoch,
        requester.deviceId,
        row.kind === 'task' ? row.rowId : (row.taskId ?? null),
        row.body,
        now,
      ]);
      if (row.kind === 'task') {
        await q.run("INSERT INTO share_tasks (account_id, task_id, state, created_by, created_at, updated_at) VALUES ($1, $2, 'open', $3, $4, $4)", [requester.accountId, row.rowId, requester.deviceId, now]);
      }
      if ((SHARE.latestOnlyKinds as readonly string[]).includes(row.kind)) {
        await q.run('DELETE FROM share_rows WHERE account_id = $1 AND kind = $2 AND seq < $3', [requester.accountId, row.kind, seq]);
      }
      if (head) await q.run('UPDATE share_heads SET next_seq = $1, epoch = $2 WHERE account_id = $3', [seq + 1, Math.max(Number(head.epoch), row.epoch), requester.accountId]);
      else await q.run('INSERT INTO share_heads (account_id, next_seq, epoch) VALUES ($1, $2, $3)', [requester.accountId, seq + 1, row.epoch]);
      return { seq };
    });
  }

  async shareRows(accountId: string, after: number): Promise<{ rows: ShareRowOut[]; head: number; epoch: number; more: boolean }> {
    const head = await this.db.one<{ next_seq: number; epoch: number }>('SELECT next_seq, epoch FROM share_heads WHERE account_id = $1', [accountId]);
    if (!head) return { rows: [], head: 0, epoch: 0, more: false };
    const got = await this.db.all<{ seq: number; row_id: string; kind: ShareKind; epoch: number; device_id: string; sealed: string; created_at: number }>(
      `SELECT seq, row_id, kind, epoch, device_id, sealed, created_at FROM share_rows WHERE account_id = $1 AND seq > $2 ORDER BY seq LIMIT ${SHARE.pageRows + 1}`,
      [accountId, after],
    );
    const rows: ShareRowOut[] = [];
    let chars = 0;
    for (const r of got.slice(0, SHARE.pageRows)) {
      if (rows.length && chars + r.sealed.length > SHARE.pageChars) break;
      chars += r.sealed.length;
      rows.push({ seq: Number(r.seq), rowId: r.row_id, kind: r.kind, epoch: Number(r.epoch), deviceId: r.device_id, at: Number(r.created_at), body: r.sealed });
    }
    return { rows, head: Number(head.next_seq) - 1, epoch: Number(head.epoch), more: rows.length < got.length };
  }

  async shareTasks(accountId: string): Promise<ShareTaskOut[]> {
    const now = this.now();
    const rows = await this.db.all<ShareTaskRow>('SELECT task_id, state, created_by, claimed_by, claim_expires_at, created_at, updated_at FROM share_tasks WHERE account_id = $1 ORDER BY created_at, task_id', [accountId]);
    return rows.map((t) => {
      const lease = t.claim_expires_at === null ? null : Number(t.claim_expires_at);
      const expired = Number(t.created_at) + SHARE.taskTtlMs <= now;
      const live = t.state === 'claimed' && lease !== null && lease > now;
      const state: ShareTaskOut['state'] = t.state === 'done' || t.state === 'cancelled' ? t.state : live ? 'claimed' : expired ? 'expired' : 'open';
      return { taskId: t.task_id, state, createdBy: t.created_by, claimedBy: live ? t.claimed_by : null, claimExpiresAt: live ? lease : null, createdAt: Number(t.created_at), updatedAt: Number(t.updated_at) };
    });
  }

  async claimShareTask(requester: { accountId: string; deviceId: string }, taskId: string): Promise<{ claimExpiresAt: number }> {
    return this.db.tx(async (q) => {
      const t = await q.one<ShareTaskRow>(`SELECT task_id, state, created_by, claimed_by, claim_expires_at, created_at, updated_at FROM share_tasks WHERE account_id = $1 AND task_id = $2${q.forUpdate}`, [requester.accountId, taskId]);
      if (!t) fail('account.task_not_found');
      if (t.state === 'done' || t.state === 'cancelled') fail('account.task_closed');
      const now = this.now();
      const mine = t.state === 'claimed' && t.claimed_by === requester.deviceId;
      if (t.state === 'claimed' && !mine && Number(t.claim_expires_at ?? 0) > now) fail('account.task_claimed');
      if (!mine && Number(t.created_at) + SHARE.taskTtlMs <= now) fail('account.task_closed');
      const claimExpiresAt = now + SHARE.claimMs;
      await q.run("UPDATE share_tasks SET state = 'claimed', claimed_by = $1, claim_expires_at = $2, updated_at = $3 WHERE account_id = $4 AND task_id = $5", [requester.deviceId, claimExpiresAt, now, requester.accountId, taskId]);
      return { claimExpiresAt };
    });
  }

  async releaseShareTask(requester: { accountId: string; deviceId: string }, taskId: string): Promise<void> {
    await this.db.run("UPDATE share_tasks SET state = 'open', claimed_by = NULL, claim_expires_at = NULL, updated_at = $1 WHERE account_id = $2 AND task_id = $3 AND state = 'claimed' AND claimed_by = $4", [
      this.now(),
      requester.accountId,
      taskId,
      requester.deviceId,
    ]);
  }

  async cancelShareTask(requester: { accountId: string; deviceId: string }, taskId: string): Promise<void> {
    await this.db.tx(async (q) => {
      const t = await q.one<ShareTaskRow>(`SELECT task_id, state, created_by, claimed_by, claim_expires_at, created_at, updated_at FROM share_tasks WHERE account_id = $1 AND task_id = $2${q.forUpdate}`, [requester.accountId, taskId]);
      if (!t) fail('account.task_not_found');
      if (t.state === 'cancelled') return;
      if (t.state === 'done') fail('account.task_closed');
      const now = this.now();
      if (t.state === 'claimed' && t.claimed_by !== requester.deviceId && Number(t.claim_expires_at ?? 0) > now) fail('account.task_claimed');
      await q.run("UPDATE share_tasks SET state = 'cancelled', claimed_by = NULL, claim_expires_at = NULL, updated_at = $1 WHERE account_id = $2 AND task_id = $3", [now, requester.accountId, taskId]);
    });
  }

  private async otherActiveDesktop(q: Sql, accountId: string, except: string): Promise<boolean> {
    const r = await q.one<{ n: number }>("SELECT COUNT(*) AS n FROM devices WHERE account_id = $1 AND role = 'desktop' AND state = 'active' AND device_id <> $2", [accountId, except]);
    return Number(r?.n ?? 0) > 0;
  }

  private async stopped(deviceId: string): Promise<void> {
    await this.db.run('DELETE FROM issue_locks WHERE device_id = $1', [deviceId]).catch(() => undefined);
    await this.db.run('DELETE FROM pc_links WHERE device_id = $1', [deviceId]).catch(() => undefined);
    await this.db
      .run("UPDATE share_tasks SET state = 'open', claimed_by = NULL, claim_expires_at = NULL, updated_at = $1 WHERE claimed_by = $2 AND state = 'claimed'", [this.now(), deviceId])
      .catch(() => undefined);
    for (const h of this.d.stopHooks ?? []) await h.stopped(deviceId).catch(() => undefined);
  }

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

  async autoSuspend(deviceId: string): Promise<boolean> {
    const d = await this.db.one<{ account_id: string }>('SELECT account_id FROM devices WHERE device_id = $1', [deviceId]);
    if (!d) return false;
    const n = await this.db.run("UPDATE devices SET state = 'suspended' WHERE device_id = $1 AND state = 'active'", [deviceId]);
    if (!n) return false;
    await this.stopped(deviceId);
    await this.notify(d.account_id, 'device_auto_suspended');
    return true;
  }

  async reactivate(requester: { accountId: string; deviceId: string }, deviceId: string, op: { op: AcctOp; aikSig: string }): Promise<void> {
    const a = await this.account(requester.accountId);
    if (!a.aik_pub || op.op.op !== 'device.reactivate' || !opSigOk(fromB64(a.aik_pub, 32)!, op, a.id, deviceId, this.now())) fail('account.aik_signature_invalid');
    const n = await this.db.tx(async (q) => {
      await q.one(`SELECT id FROM accounts WHERE id = $1${q.forUpdate}`, [a.id]);
      const d = await q.one<DeviceRow>("SELECT * FROM devices WHERE device_id = $1 AND account_id = $2 AND state = 'suspended'", [deviceId, a.id]);
      if (!d) return 0;
      if (d.role === 'mobile' && !(await this.countOk(q, a.id, 'mobile'))) fail('account.device_limit');
      return q.run("UPDATE devices SET state = 'active', delete_after = CASE WHEN revoke_record IS NULL THEN NULL ELSE delete_after END WHERE device_id = $1 AND account_id = $2 AND state = 'suspended'", [deviceId, a.id]);
    });
    if (!n) fail('account.device_not_found');
  }

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

  async issueDeviceToken(c: SignedCert, dpop: string | undefined, htu: string, onVerified?: () => void | Promise<void>, want?: readonly Scope[], model?: string): Promise<{ token: string; expiresAt: number; scopes: string[] }> {
    const d = await this.db.one<DeviceRow & { aik_pub: string | null }>('SELECT d.*, a.aik_pub FROM devices d JOIN accounts a ON a.id = d.account_id WHERE d.device_id = $1 AND a.status = $2', [c.cert.device_id, 'active']);
    if (!d || !d.aik_pub) fail('account.cert_invalid');
    const now = this.now();
    if (!certSigOk(fromB64(d!.aik_pub!, 32)!, c) || c.cert.role !== d!.role || c.cert.Sx !== d!.sx || c.cert.Vx !== d!.vx) fail('account.cert_invalid');
    if (c.cert.not_after <= now || c.cert.not_after > now + DEVICE.certMaxDays * MS.D) fail('account.cert_invalid');
    const vx = fromB64(d!.vx, 32)!;
    verifyDpop(dpop, { method: 'POST', htu, token: jcs(c), cnf: vx, now, jti: this.jti, code: 'account.dpop_invalid' });
    if (d!.state !== 'active') fail('account.device_suspended');
    const roleScopes = d!.role === 'desktop' ? DESKTOP_SCOPES : MOBILE_SCOPES_P1;
    if (want && (want.length === 0 || new Set(want).size !== want.length || !want.every((s) => roleScopes.includes(s)))) fail('request.param_rejected');
    await onVerified?.();
    let scopes = want ? roleScopes.filter((s) => want.includes(s)) : [...roleScopes];
    let tier: 'trial' | 'paid' | undefined;
    if (scopes.some((x) => PAID_SCOPES.includes(x))) {
      const ent = (await this.entitlement(d!.account_id)).state;
      if (ent === 'none') {
        if (want && scopes.every((x) => PAID_SCOPES.includes(x))) fail('account.subscription_required');
        scopes = scopes.filter((x) => !PAID_SCOPES.includes(x));
        this.d.onEvent?.('account.gateway_scope_withheld');
      } else tier = ent;
    }
    await this.seen(d!, now, model);
    const { token, claims } = this.d.tokens.issue({ acc: d!.account_id, dev: d!.device_id, role: d!.role, scp: scopes, cnf: d!.vx, ...(tier ? { tier } : {}) }, now);
    this.d.onEvent?.(`account.device_token_issued.${d!.role}.${want && scopes.length < roleScopes.length ? scopes.join('-') : 'all'}`);
    return { token, expiresAt: claims.exp, scopes };
  }

  private async seen(d: DeviceRow, now: number, model?: string): Promise<void> {
    const m = model?.replace(/[\p{Cc}\p{Cf}]/gu, '').trim().slice(0, 40) || null;
    const rename = m !== null && m !== d.name;
    if (!rename && d.last_seen_at != null && now - Number(d.last_seen_at) < DEVICE.lastSeenWriteMs) return;
    await this.db.run('UPDATE devices SET last_seen_at = $1, name = $2 WHERE device_id = $3', [now, rename ? m : d.name, d.device_id]);
  }

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

  async deleteSlot(accountId: string, slotToken: string): Promise<void> {
    await this.db.tx(async (q) => {
      const slot = await q.one<{ biz_hmac: string | null }>(`SELECT biz_hmac FROM profile_slots WHERE slot_token = $1 AND account_id = $2${q.forUpdate}`, [slotToken, accountId]);
      if (!slot) fail('account.slot_not_found');
      if (slot!.biz_hmac) await q.run('UPDATE accounts SET last_biz_change_at = $1 WHERE id = $2', [this.now(), accountId]);
      await q.run('DELETE FROM profile_slots WHERE slot_token = $1', [slotToken]);
    });
  }

  async deviceRecord(deviceId: string): Promise<DeviceRecord | null> {
    const d = await this.db.one<DeviceRow>('SELECT * FROM devices WHERE device_id = $1', [deviceId]);
    return d ? { accountId: d.account_id, deviceId: d.device_id, role: d.role, state: d.state } : null;
  }

  async sweep(): Promise<{ revoked: string[] }> {
    const now = this.now();
    await this.db.run('DELETE FROM login_codes WHERE expires_at <= $1', [now]);
    await this.db.run('DELETE FROM issue_locks WHERE expires_at <= $1', [now]);
    await this.db.run('DELETE FROM pc_links WHERE expires_at <= $1', [now]);
    const closedBefore = now - SHARE.closedTaskDays * MS.D;
    const staleTask = (t: string) =>
      `(${t}state IN ('done', 'cancelled') AND ${t}updated_at <= $1) OR (${t}state IN ('open', 'claimed') AND ${t}created_at <= $2 AND (${t}claim_expires_at IS NULL OR ${t}claim_expires_at <= $3))`;
    const staleArgs = [closedBefore, closedBefore - SHARE.taskTtlMs, now];
    await this.db.run(
      `DELETE FROM share_rows WHERE task_id IS NOT NULL AND EXISTS (SELECT 1 FROM share_tasks t WHERE t.account_id = share_rows.account_id AND t.task_id = share_rows.task_id AND (${staleTask('t.')}))`,
      staleArgs,
    );
    await this.db.run(`DELETE FROM share_tasks WHERE ${staleTask('')}`, staleArgs);
    await this.db.run('DELETE FROM oauth_codes WHERE expires_at <= $1', [now]);
    await this.db.run('DELETE FROM webauthn_challenges WHERE expires_at <= $1', [now]);
    await this.db.run('DELETE FROM sessions WHERE expires_at <= $1', [now]);
    await this.db.run('DELETE FROM refresh_tokens WHERE expires_at <= $1', [now]);
    await this.db.run('DELETE FROM reset_codes WHERE expires_at <= $1', [now]);
    await this.drainNotices();
    await this.trialConversionNotices();
    await this.chargeDue();
    await this.db.run('DELETE FROM pw_locks WHERE updated_at <= $1 AND (locked_until IS NULL OR locked_until <= $2)', [now - PASSWORD.lockDecayMs, now]);
    await this.db.run('DELETE FROM device_events WHERE day < $1', [kstDay(now - DEVICE.churnWindowDays * MS.D)]);
    await this.db.run("DELETE FROM devices WHERE state = 'pending' AND registered_at <= $1", [now - DEVICE.pendingTtlDays * MS.D]);
    const due = await this.db.all<DeviceRow>("SELECT * FROM devices WHERE delete_after IS NOT NULL AND delete_after <= $1 AND state <> 'revoked'", [now]);
    for (const d of due) {
      await this.db.run("UPDATE devices SET state = 'revoked', delete_after = NULL WHERE device_id = $1", [d.device_id]);
      await this.db.run("INSERT INTO device_events (account_id, role, kind, day) VALUES ($1, $2, 'remove', $3)", [d.account_id, d.role, kstDay(now)]);
      await this.stopped(d.device_id);
    }
    const gone = await this.db.all<{ id: string }>('SELECT id FROM accounts WHERE delete_after IS NOT NULL AND delete_after <= $1', [now]);
    for (const a of gone) {
      const devs = await this.db.all<{ device_id: string }>("SELECT device_id FROM devices WHERE account_id = $1 AND state <> 'revoked'", [a.id]);
      for (const d of devs) await this.stopped(d.device_id);
      await this.db.run('DELETE FROM accounts WHERE id = $1 AND delete_after IS NOT NULL AND delete_after <= $2', [a.id, now]);
      this.d.onEvent?.('account.deleted');
    }
    return { revoked: due.map((d) => d.device_id) };
  }
}

const REF_RE = /^cus_[A-Za-z0-9_-]{24}$/;
const bkAad = (ref: string) => `sax-billing-key-v1|${ref}`;

/** 'YYYY년 M월 D일'(KST) */
export function kstDateLabel(ms: number): string {
  const k = new Date(ms + 9 * 3600_000);
  return `${k.getUTCFullYear()}년 ${k.getUTCMonth() + 1}월 ${k.getUTCDate()}일`;
}

/** 한 달 뒤(KST 달력, 말일 보정: 1/31 → 2/28). 시각은 그대로 */
export function addMonthKst(ms: number): number {
  const k = new Date(ms + 9 * 3600_000);
  const y = k.getUTCFullYear();
  const m = k.getUTCMonth() + 1;
  const last = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  const t = Date.UTC(y, m, Math.min(k.getUTCDate(), last), k.getUTCHours(), k.getUTCMinutes(), k.getUTCSeconds(), k.getUTCMilliseconds());
  return t - 9 * 3600_000;
}

export function normEmail(e: string): string {
  const s = e.trim().toLowerCase();
  if (s.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)) throw new ServiceError('request.param_rejected');
  return s;
}
