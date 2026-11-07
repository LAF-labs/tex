// 계정·구독 도메인(D09 §2). HTTP와 무관한 규칙만 여기에 둔다(라우트·요청 검증은 app.ts).
import type { AcctClaimSigner, SignedAcctClaim } from './acct-claim.ts';
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
  type Scope,
  type Sql,
} from '@sax/svc-shared';
import { PLAN, type DeviceStopHook, type MailSender, type PairingRooms, type NoticeKind, type PaymentEvent, type PaymentGateway } from './adapters.ts';
import { certSigOk, entrySigOk, opSigOk, revokeSigOk, type AcctOp, type DeviceList, type SignedCert } from './aik.ts';
import { ACCOUNT, DEVICE, MS, NOTICE, PASSWORD, PROFILE } from './constants.ts';
import { checkPasswordPolicy, type CommonPasswords, type PasswordHasher } from './password.ts';
import { verifyAssertion, verifyRegistration, WebAuthnError, type AssertionInput, type RegistrationInput, type RpConfig } from './webauthn.ts';

/** 세션을 준 수단. refresh = 갱신 토큰으로 새로 받은 세션(강한 인증·최근 로그인으로 치지 않는다) */
export type AuthMethod = 'email_code' | 'passkey' | 'password' | 'refresh';

export interface Session {
  accountId: string;
  authMethod: AuthMethod;
  /** 실제로 인증한 시각(ms). 루프백 교환으로 받은 세션은 원래 세션의 인증 시각을 잇는다. 비밀번호 설정·삭제의 최근 로그인 판정 */
  authAt: number;
}

/** 비밀번호 로그인 구성(ADR-038). 없으면 비밀번호 경로는 닫힌다(PASSWORD_PEPPER_KEYS 없음·argon2id 미지원) */
export interface PasswordDeps {
  hasher: PasswordHasher;
  common: CommonPasswords;
  /** 이벤트(이름만): 잠금·재사용 감지·재해시 */
  onEvent?: (name: string) => void;
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
  /** 릴레이 페어링 룸 소비 확인(PC가 폰을 대신 등록). 없으면 그 경로는 닫힌다 */
  pairing?: PairingRooms;
  /** acct_claim 서명(전용 키 ACCT_CLAIM_SIGNING_KEY). 없으면 GET /v1/acct-claim은 닫힌다(404) */
  acctClaims?: AcctClaimSigner;
  passwords?: PasswordDeps;
  /** 이벤트 로그(이름만, 수·ID 없음). 기기 토큰 발급 기록 등(ADR-040 결정 1) */
  onEvent?: (name: string) => void;
  /**
   * 응답과 따로 돌릴 일(알림 큐 즉시 발송). 기본은 기다리지 않고 바로 시작한다. 플랫폼이 응답 뒤 실행을 멈춰도
   * 큐 행이 남으므로 정리 작업(sweep)이 다시 보낸다. 시험은 일을 모아 두었다가 기다린다.
   */
  defer?: (task: () => Promise<void>) => void;
  now?: () => number;
}

const SESSION_PREFIX = 'sxs1.';
/** 갱신 토큰(자동 로그인, ADR-038 (f)). 서버는 sha256만 저장 */
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

  /** `Authorization: Bearer sxs1.…`(계정 세션). 기기 범위 토큰·DPoP는 여기서 받지 않는다. */
  async session(authorization: string | undefined): Promise<Session> {
    const m = /^Bearer (sxs1\.[A-Za-z0-9_-]{43})$/.exec(authorization ?? '');
    if (!m) fail('account.unauthorized');
    const row = await this.db.one<{ account_id: string; auth_method: AuthMethod; auth_at: number; expires_at: number; status: string }>(
      'SELECT s.account_id, s.auth_method, s.auth_at, s.expires_at, a.status FROM sessions s JOIN accounts a ON a.id = s.account_id WHERE s.token_hash = $1',
      [sha256hex(m![1]!)],
    );
    if (!row || Number(row.expires_at) <= this.now() || row.status !== 'active') fail('account.unauthorized');
    return { accountId: row!.account_id, authMethod: row!.auth_method, authAt: Number(row!.auth_at) };
  }

  async logout(authorization: string | undefined): Promise<void> {
    const m = /^Bearer (sxs1\.[A-Za-z0-9_-]{43})$/.exec(authorization ?? '');
    if (m) await this.db.run('DELETE FROM sessions WHERE token_hash = $1', [sha256hex(m[1]!)]);
  }

  /**
   * 계정 세션·갱신 토큰 전면 무효화. 사고 대응(D09 §9.2) 운영 도구, [모든 기기에서 로그아웃], 비밀번호 재설정, 갱신 토큰 재사용 감지가 부른다.
   * 기기 범위 토큰·기기 등록은 그대로다(ADR-038 (e)(f)). keepToken이 있으면 그 세션 하나는 남긴다.
   */
  async revokeAllSessions(accountId: string, keepToken?: string): Promise<number> {
    await this.db.run('DELETE FROM refresh_tokens WHERE account_id = $1', [accountId]);
    if (keepToken) return this.db.run('DELETE FROM sessions WHERE account_id = $1 AND token_hash <> $2', [accountId, sha256hex(keepToken)]);
    return this.db.run('DELETE FROM sessions WHERE account_id = $1', [accountId]);
  }

  // ---------- 자동 로그인: 갱신 토큰(ADR-038 (f)) ----------

  /** 로그인 성공 뒤 `remember: true`면 새 계보의 갱신 토큰(30일 미사용 만료) */
  async issueRefresh(accountId: string, method: AuthMethod): Promise<string> {
    const token = REFRESH_PREFIX + randomToken();
    const now = this.now();
    await this.db.run('INSERT INTO refresh_tokens (token_hash, account_id, family_id, parent_hash, auth_method, issued_at, expires_at, rotated_at) VALUES ($1, $2, $3, NULL, $4, $5, $6, NULL)', [
      sha256hex(token),
      accountId,
      randomUUID(),
      method,
      now,
      now + ACCOUNT.refreshTtlMs,
    ]);
    return token;
  }

  /**
   * 갱신: 쓸 때마다 회전한다(새 토큰, 이전 토큰은 회전됨 표시). 회전된 토큰이 다시 오면 복제 신호로 보고 그 계정의 세션·갱신 토큰을 모두 폐기한다.
   * 실패는 모두 account.unauthorized(이유를 가르지 않는다).
   */
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

  /** [로그인 상태 유지 끄기]: 그 토큰의 계보 전체를 폐기한다. 없는 토큰이어도 같은 결과(204) */
  async revokeRefresh(tokenRaw: string): Promise<void> {
    if (!REFRESH_RE.test(tokenRaw)) return;
    const row = await this.db.one<{ family_id: string }>('SELECT family_id FROM refresh_tokens WHERE token_hash = $1', [sha256hex(tokenRaw)]);
    if (row) await this.db.run('DELETE FROM refresh_tokens WHERE family_id = $1', [row.family_id]);
  }

  // ---------- 비밀번호(ADR-038 (a)~(e)) ----------

  private pw(): PasswordDeps {
    return this.d.passwords ?? fail('request.not_found');
  }

  get passwordsEnabled(): boolean {
    return !!this.d.passwords;
  }

  /**
   * 비밀번호 로그인. 이메일 없음·비밀번호 없음·틀림·잠금·정지 계정은 모두 account.credentials_invalid이고, 모두 argon2id를 한 번 돈다(없으면 더미).
   * 응답 시각 하한은 라우트(withFloor)가 맞춘다. 계정당 5회 연속 실패면 잠그고(15분 × 2^단계, 상한 24시간) 잠금마다 알림 1회.
   * 잠금은 비밀번호만 막는다. 이메일 코드·패스키 로그인은 그대로다.
   */
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
    const locked = row!.locked_until !== null && row!.locked_until !== undefined && Number(row!.locked_until) > now;
    // 잠금 중에는 맞아도 틀린 것과 같은 응답이고, 실패 횟수도 쌓지 않는다(잠금 주기 하나에 알림 하나)
    if (locked) fail('account.credentials_invalid');
    if (!v.ok) {
      const lockedNow = await this.db.tx(async (q) => {
        const l = await q.one<{ fails: number; lock_level: number; locked_until: number | null }>(`SELECT fails, lock_level, locked_until FROM pw_locks WHERE account_id = $1${q.forUpdate}`, [row!.id]);
        if (l && l.locked_until !== null && Number(l.locked_until) > now) return false;
        const fails = Number(l?.fails ?? 0) + 1;
        const level = Number(l?.lock_level ?? 0);
        if (fails >= PASSWORD.maxFails) {
          const until = now + Math.min(PASSWORD.lockBaseMs * 2 ** level, PASSWORD.lockMaxMs);
          await this.upsertLock(q, row!.id, 0, until, level + 1, now);
          // 알림은 잠금과 같은 트랜잭션으로 큐에 넣는다(잠금 주기마다 정확히 1회). 메일은 응답 경로에서 보내지 않는다
          await this.enqueueNotice(q, row!.id, 'password_locked', now);
          return true;
        }
        await this.upsertLock(q, row!.id, fails, null, level, now);
        return false;
      });
      if (lockedNow) {
        p.onEvent?.('account.password_locked');
        this.kickNotices();
      }
      fail('account.credentials_invalid');
    }
    if (row!.status !== 'active') fail('account.credentials_invalid');
    await this.db.run('DELETE FROM pw_locks WHERE account_id = $1', [row!.id]);
    if (v.needsRehash) {
      const h = await p.hasher.hash(pw);
      await this.db.run('UPDATE pw_creds SET pw_hash = $1, salt = $2, params = $3 WHERE account_id = $4', [h.hash, h.salt, h.params, row!.id]);
      p.onEvent?.('account.password_rehashed');
    }
    return { session: await this.createSession(row!.id, 'password'), accountId: row!.id };
  }

  private async upsertLock(q: Sql, accountId: string, fails: number, lockedUntil: number | null, level: number, now: number): Promise<void> {
    const n = await q.run('UPDATE pw_locks SET fails = $1, locked_until = $2, lock_level = $3, updated_at = $4 WHERE account_id = $5', [fails, lockedUntil, level, now, accountId]);
    if (n === 0) await q.run('INSERT INTO pw_locks (account_id, fails, locked_until, lock_level, updated_at) VALUES ($1, $2, $3, $4, $5)', [accountId, fails, lockedUntil, level, now]);
  }

  /** 최근(10분) 코드·패스키·비밀번호 로그인 세션만. 갱신으로 받은 세션은 다시 로그인해야 한다 */
  private requireRecentLogin(s: Session): void {
    if (s.authMethod === 'refresh' || this.now() - s.authAt > PASSWORD.reauthMaxAgeMs) fail('account.reauth_required');
  }

  private async setHash(accountId: string, pw: string): Promise<void> {
    const h = await this.pw().hasher.hash(pw);
    const now = this.now();
    const n = await this.db.run('UPDATE pw_creds SET pw_hash = $1, salt = $2, params = $3, set_at = $4 WHERE account_id = $5', [h.hash, h.salt, h.params, now, accountId]);
    if (n === 0) await this.db.run('INSERT INTO pw_creds (account_id, pw_hash, salt, params, set_at) VALUES ($1, $2, $3, $4, $5)', [accountId, h.hash, h.salt, h.params, now]);
    await this.db.run('DELETE FROM pw_locks WHERE account_id = $1', [accountId]);
  }

  /** 비밀번호 설정·바꾸기(선택, 가입 뒤). 정책은 서버가 판정한다 */
  async setPassword(s: Session, pw: string): Promise<void> {
    const p = this.pw();
    this.requireRecentLogin(s);
    const a = await this.account(s.accountId);
    checkPasswordPolicy(pw, a.email, p.common);
    await this.setHash(s.accountId, pw);
    await this.notify(s.accountId, 'password_set');
  }

  /** 비밀번호 삭제(코드·패스키만 쓰는 계정으로). 보존표: 비밀번호 삭제 때 해시·잠금 삭제(D09 §10) */
  async deletePassword(s: Session): Promise<void> {
    this.pw();
    this.requireRecentLogin(s);
    await this.db.run('DELETE FROM pw_creds WHERE account_id = $1', [s.accountId]);
    await this.db.run('DELETE FROM pw_locks WHERE account_id = $1', [s.accountId]);
  }

  private resetMac(resetId: string, code: string): string {
    return hmacHex(this.d.codeMacKey, 'SAX-reset-code-v1', '\u0000', resetId, '\u0000', code);
  }

  /** 재설정 코드 요청. 계정이 있을 때만 메일을 보내지만 응답은 같다(시각 하한은 라우트) */
  async startPasswordReset(emailRaw: string): Promise<{ resetId: string; expiresInSec: number }> {
    this.pw();
    const email = normEmail(emailRaw);
    const resetId = randomToken();
    const acc = await this.db.one<{ id: string; status: string }>('SELECT id, status FROM accounts WHERE email = $1', [email]);
    if (acc && acc.status === 'active') {
      const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
      await this.db.run('INSERT INTO reset_codes (reset_id_hash, account_id, code_mac, attempts, expires_at) VALUES ($1, $2, $3, 0, $4)', [sha256hex(resetId), acc.id, this.resetMac(resetId, code), this.now() + PASSWORD.resetCodeTtlMs]);
      await this.d.mail.sendResetCode(email, code);
    }
    return { resetId, expiresInSec: PASSWORD.resetCodeTtlMs / 1000 };
  }

  /**
   * 재설정 완료: 코드가 맞으면 새 비밀번호를 정책에 맞춰 보고 저장한다. 정책에 맞지 않으면 코드는 남는다(다른 비밀번호로 다시).
   * 저장하면 그 계정의 다른 세션·갱신 토큰을 모두 폐기하고 알림 메일을 보낸 뒤, 새 세션을 준다(코드로 메일함을 증명했다).
   * 금고·기기 키·기기 목록·기기 범위 토큰은 건드리지 않는다(ADR-038 (e)).
   */
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
    // 코드는 한 번만: 동시에 온 두 요청 중 지운 쪽만 이어 간다
    if ((await this.db.run('DELETE FROM reset_codes WHERE reset_id_hash = $1', [h])) === 0) fail('account.code_invalid');
    await this.setHash(accountId, pw);
    await this.revokeAllSessions(accountId);
    await this.db.run('DELETE FROM reset_codes WHERE account_id = $1', [accountId]);
    await this.notify(accountId, 'password_reset');
    return { session: await this.createSession(accountId, 'email_code'), accountId };
  }

  /** [모든 기기에서 로그아웃]: 계정 세션·갱신 토큰 전부(이 세션 포함). 기기 범위 토큰·기기 등록은 그대로 */
  async logoutAll(s: Session): Promise<void> {
    await this.revokeAllSessions(s.accountId);
  }

  // ---------- 데스크톱 로그인: RFC 8252 루프백 + PKCE(디바이스 플로우 없음) ----------

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
      // 1회용: 맞든 틀리든 지운다.
      if (r) await q.run('DELETE FROM oauth_codes WHERE code_hash = $1', [h]);
      return r;
    });
    if (!row || row.expires_at <= this.now() || row.client_id !== o.clientId || row.redirect_uri !== o.redirectUri) fail('account.pkce_invalid');
    if (!safeEqual(b64u(sha256(o.verifier)), row!.code_challenge)) fail('account.pkce_invalid');
    // 새 세션은 원래 세션의 인증 시각을 잇는다(교환으로 최근 로그인을 새로 만들지 않는다). 마이그레이션 전 코드는 0
    return { session: await this.createSession(row!.account_id, row!.auth_method, Number(row!.auth_at ?? 0)), accountId: row!.account_id, authMethod: row!.auth_method };
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

  // ---------- 알림 메일 발송 큐(notice_outbox) ----------

  private async enqueueNotice(q: Sql, accountId: string, kind: NoticeKind, now: number): Promise<void> {
    await q.run('INSERT INTO notice_outbox (id, account_id, kind, created_at, attempts, next_at) VALUES ($1, $2, $3, $4, 0, $4)', [randomToken(), accountId, kind, now]);
  }

  /** 큐를 응답과 따로 비운다. 실패는 이벤트 이름만(행은 남아 다음 정리 때 다시) */
  private kickNotices(): void {
    const run = () => this.drainNotices().then(
      () => undefined,
      () => this.d.onEvent?.('account.notice_drain_failed'),
    );
    if (this.d.defer) this.d.defer(run);
    else void run();
  }

  /**
   * 기한이 된 알림을 보낸다(요청 뒤 즉시 시도와 정리 cron이 부른다). 행마다 임대를 걸어 동시에 도는 처리자가 같은 알림을 두 번 보내지 않게 한다.
   * 보내면 지우고, 실패하면 5분 × 2^(시도-1)(상한 6시간) 뒤로 미룬다. 8번 실패하면 버린다. 이벤트는 이름·종류만(계정·주소 없음).
   */
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
      // 메일 호출만 실패로 본다(보낸 뒤 DB 오류로 다시 보내지 않게). 계정이 사라졌으면 보내지 않고 지운다
      const ok = !a || (await this.d.mail.sendNotice(a.email, r.kind).then(() => true, () => false));
      if (ok) {
        await this.db.run('DELETE FROM notice_outbox WHERE id = $1', [r.id]);
        if (a) {
          sent++;
          this.d.onEvent?.(`account.notice_sent.${r.kind}`);
        }
      } else {
        failed++;
        const attempts = Number(r.attempts) + 1;
        if (attempts >= NOTICE.maxAttempts) {
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

  // ---------- 구독·결제(9,900원 한 플랜, ADR-034) ----------

  async checkout(s: Session): Promise<{ checkoutUrl: string }> {
    // 계정 행 잠금 안에서 참조를 정한다: 동시에 두 번 눌러도 같은 참조의 결제 창이 나온다(버려지는 참조로 결제되는 일 없음)
    const ref = await this.db.tx(async (q) => {
      await q.one(`SELECT id FROM accounts WHERE id = $1${q.forUpdate}`, [s.accountId]);
      const sub = await q.one<{ status: string; pg_customer_ref: string }>(`SELECT status, pg_customer_ref FROM subscriptions WHERE account_id = $1${q.forUpdate}`, [s.accountId]);
      if (sub?.status === 'active') fail('request.param_rejected');
      if (sub && sub.status !== 'canceled') return sub.pg_customer_ref; // pending·past_due: 같은 참조로 다시 결제
      const next = `cus_${randomToken(18)}`;
      // 해지 뒤 다시 구독은 새 참조(옛 참조로 늦게 온 이벤트는 어디에도 맞지 않는다)
      if (sub) await q.run("UPDATE subscriptions SET status = 'pending', renew_at = NULL, pg_event_at = NULL, pg_customer_ref = $1 WHERE account_id = $2", [next, s.accountId]);
      else await q.run("INSERT INTO subscriptions (account_id, plan, status, period, renew_at, pg_customer_ref) VALUES ($1, 'standard', 'pending', 'month', NULL, $2)", [s.accountId, next]);
      return next;
    });
    return this.d.payments.createCheckout({ pgCustomerRef: ref, plan: PLAN, returnUrl: this.d.billingReturnUrl });
  }

  /** PG 웹훅. 서명이 틀리면 거부, 모르는 참조는 조용히 무시(참조 존재 오라클 없음). */
  async paymentWebhook(raw: Buffer, headers: Record<string, string | string[] | undefined>): Promise<void> {
    const e: PaymentEvent | null = this.d.payments.verifyWebhook(raw, headers);
    if (!e) fail('account.billing_signature_invalid');
    const ev = e!;
    // 순서는 PG 이벤트 시각(서명 범위 안)으로 정한다: 마지막으로 반영한 이벤트보다 늦게 만들어진 이벤트만 반영(늦게 온·재전송 이벤트는 무시).
    // 해지는 끝 상태(되살리지 않는다). 다시 구독은 checkout이 새 참조로 연다. 결제 실패 뒤 재결제 성공은 더 늦은 이벤트라 active로 돌아온다.
    const newer = '(pg_event_at IS NULL OR pg_event_at < $2)';
    if (ev.type === 'subscription.activated' || ev.type === 'subscription.renewed')
      await this.db.run(`UPDATE subscriptions SET status = 'active', renew_at = $3, pg_event_at = $2 WHERE pg_customer_ref = $1 AND status <> 'canceled' AND ${newer}`, [ev.pgCustomerRef, ev.at, ev.renewAt]);
    else if (ev.type === 'payment.failed') await this.db.run(`UPDATE subscriptions SET status = 'past_due', pg_event_at = $2 WHERE pg_customer_ref = $1 AND status = 'active' AND ${newer}`, [ev.pgCustomerRef, ev.at]);
    else await this.db.run("UPDATE subscriptions SET status = 'canceled', pg_event_at = CASE WHEN pg_event_at IS NULL OR pg_event_at < $2 THEN $2 ELSE pg_event_at END WHERE pg_customer_ref = $1", [ev.pgCustomerRef, ev.at]);
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
      // 같은 기기의 pending 신청은 이 고정으로 대신한다(신청 때 이미 센 등록 이력은 다시 세지 않는다)
      const replaced = (await q.run("DELETE FROM devices WHERE device_id = $1 AND account_id = $2 AND role = 'desktop' AND state = 'pending'", [e!.entry.device_id, s.accountId])) > 0;
      if (!(await this.countOk(q, s.accountId, 'desktop'))) fail('account.device_limit');
      if (!replaced && !(await this.churnOk(q, s.accountId, 'desktop'))) fail('account.device_churn_limit');
      const now = this.now();
      await q.run(
        "INSERT INTO devices (device_id, account_id, role, platform, name, sx, vx, registered_at, state) VALUES ($1, $2, 'desktop', $3, $4, $5, $6, $7, 'active')",
        [e!.entry.device_id, s.accountId, o.platform, o.name, e!.entry.Sx, e!.entry.Vx, now],
      ).catch(() => fail('request.param_rejected'));
      await q.run('UPDATE accounts SET aik_pub = $1, aik_pinned_at = $2, device_list_version = 1, device_list_json = $3 WHERE id = $4', [o.aikPub, now, jcs(l), s.accountId]);
      if (!replaced) await q.run("INSERT INTO device_events (account_id, role, kind, day) VALUES ($1, 'desktop', 'add', $2)", [s.accountId, kstDay(now)]);
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

  /**
   * 폰 대리 등록(팀장 결정 2026-11-06): 폰 앱에는 계정 로그인이 없어서 페어링 7단계에서 PC가 데스크톱 기기 토큰으로 대신 등록한다.
   * 조건: 요청 기기가 활성 데스크톱(라우터의 기기 토큰 검사), 그 PC가 만든 1회용 페어링 룸이 소비됨(릴레이 확인, 한 번만), 계정당 모바일 상한·교체 한도.
   * 등록된 폰은 다른 등록과 같이 pending이고, 같은 PC가 AIK 서명 기기 목록(PUT /v1/device-list)을 올리면 활성이 된다.
   */
  /**
   * PC가 폰을 대신 등록(페어링 7단계). 재등록은 멱등이다(팀장 결정 2026-11-06, #118):
   * 같은 계정·같은 기기 ID·같은 Sx·Vx의 pending/active 모바일이면 기존 기록을 돌려준다(created: false, 상한·교체 한도에 다시 넣지 않음).
   * 이때도 룸은 소비한다(룸 하나에 enroll 성공 한 번, 팀장 결정 2026-11-06). 같은 룸의 두 번째 enroll은 키와 무관하게 409 relay.room_used.
   * 같은 기기 ID인데 키·계정·역할이 다르거나 정지·폐기된 기록이면 지금처럼 400이다(폐기 뒤 새 기기 ID로 재등록). 이 판단은 룸 소비 전에 한다(실패는 룸을 쓰지 않는다).
   */
  async enrollByDesktop(
    requester: { accountId: string; deviceId: string },
    o: { deviceId: string; platform: string; name: string; Sx: string; Vx: string; roomId: string },
  ): Promise<{ created: boolean; holdUntil: number | null; state: 'pending' | 'active' }> {
    if (!this.d.pairing) fail('relay.room_unavailable');
    const same = (d: DeviceRow) => ({ created: false, holdUntil: d.state === 'pending' ? d.email_hold_until : null, state: d.state as 'pending' | 'active' });
    // 룸 하나에 enroll 성공은 한 번이다(같은 키 재등록 200도 룸을 'enroll 사용됨'으로 표시한다). 이미 쓴 룸은 409 relay.room_used
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
    // 상한은 룸을 소비하기 전에 한 번 보고(헛되이 룸을 쓰지 않게), 쓰기 트랜잭션에서 다시 본다
    if (!(await this.countOk(this.db, requester.accountId, 'mobile'))) fail('account.device_limit');
    if (!(await this.churnOk(this.db, requester.accountId, 'mobile'))) fail('account.device_churn_limit');
    await redeem();
    const r = await this.db.tx(async (q) => {
      await q.one(`SELECT id FROM accounts WHERE id = $1${q.forUpdate}`, [requester.accountId]);
      await this.requireActiveDesktop(q, requester);
      // 동시에 같은 폰을 등록한 다른 요청이 먼저 넣었으면 그 기록을 돌려준다(키가 다르면 400)
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

  /** 같은 기기 ID 기록: 없으면 null, 같은 계정·모바일·같은 키·pending/active면 그 행(멱등 재등록), 그 밖은 400. */
  private async mobileReenroll(q: Sql, requester: { accountId: string }, o: { deviceId: string; Sx: string; Vx: string }): Promise<DeviceRow | null> {
    const d = await q.one<DeviceRow>('SELECT * FROM devices WHERE device_id = $1', [o.deviceId]);
    if (!d) return null;
    if (d.account_id === requester.accountId && d.role === 'mobile' && (d.state === 'pending' || d.state === 'active') && d.sx === o.Sx && d.vx === o.Vx) return d;
    return fail('request.param_rejected');
  }

  /**
   * 서버 서명 계정 클레임(D08 §4.2 7단계). 요청한 기기가 그 계정의 활성 데스크톱이어야 하고, 계정 AIK가 고정되어 있어야 한다.
   * 클레임은 언제나 토큰의 계정 것이다(다른 계정을 지정할 수 없다).
   */
  async acctClaim(requester: { accountId: string; deviceId: string }): Promise<SignedAcctClaim> {
    if (!this.d.acctClaims) fail('request.not_found');
    const a = await this.account(requester.accountId);
    if (a.status !== 'active') fail('account.unauthorized');
    await this.requireActiveDesktop(this.db, requester);
    if (!a.aik_pub) fail('account.aik_not_pinned');
    return this.d.acctClaims!.sign({ account_id: a.id, email: a.email, aik_pub: a.aik_pub! }, this.now());
  }

  /** (b) 경로: 이메일 확인 + 72시간 대기 끝. 패스키 계정은 패스키 세션이어야 한다. */
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

  /**
   * 게이트웨이 자동 정지(D09 §3 "거절·위반 급증 시 기기 단위로 먼저 자동 정지하고, 계정 정지 전 다른 기기에 알린다").
   * 내부 API로만 부른다. 해제는 사용자 긴급 정지와 같이 AIK 서명 재활성화만.
   */
  async autoSuspend(deviceId: string): Promise<boolean> {
    const d = await this.db.one<{ account_id: string }>('SELECT account_id FROM devices WHERE device_id = $1', [deviceId]);
    if (!d) return false;
    const n = await this.db.run("UPDATE devices SET state = 'suspended' WHERE device_id = $1 AND state = 'active'", [deviceId]);
    if (!n) return false;
    await this.stopped(deviceId);
    await this.notify(d.account_id, 'device_auto_suspended');
    return true;
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
   * `want`가 있으면 그 범위만 준다(ADR-040 결정 1: 엔진용 gateway 전용 토큰 등). 빈 배열·모르는 이름·중복은 요청 스키마가 먼저 거부하고,
   * 역할 범위의 부분집합이 아니면 여기서(검증된 기기 기록으로) 거부한다. 발급마다 이벤트 이름에 역할·범위를 남긴다(ID·토큰 없음).
   */
  async issueDeviceToken(c: SignedCert, dpop: string | undefined, htu: string, onVerified?: () => void | Promise<void>, want?: readonly Scope[]): Promise<{ token: string; expiresAt: number; scopes: string[] }> {
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
    // 기기별 발급 한도는 인증서·DPoP가 맞고 기기가 활성일 때만 센다(남이 device_id나 정지 기기의 인증서로 한도를 태우지 못하게)
    await onVerified?.();
    // 순서는 역할 범위 순서로 고정한다(기록·비교가 요청 순서에 흔들리지 않게)
    const scopes = want ? roleScopes.filter((s) => want.includes(s)) : [...roleScopes];
    const { token, claims } = this.d.tokens.issue({ acc: d!.account_id, dev: d!.device_id, role: d!.role, scp: scopes, cnf: d!.vx }, now);
    this.d.onEvent?.(`account.device_token_issued.${d!.role}.${want && scopes.length < roleScopes.length ? scopes.join('-') : 'all'}`);
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
    await this.db.run('DELETE FROM refresh_tokens WHERE expires_at <= $1', [now]);
    await this.db.run('DELETE FROM reset_codes WHERE expires_at <= $1', [now]);
    // 응답 뒤 즉시 시도가 끝나지 못한(플랫폼이 멈춤·메일 실패) 알림을 보낸다
    await this.drainNotices();
    // 잠금이 끝나고 하루 동안 실패가 없으면 점증 단계를 0으로
    await this.db.run('DELETE FROM pw_locks WHERE updated_at <= $1 AND (locked_until IS NULL OR locked_until <= $2)', [now - PASSWORD.lockDecayMs, now]);
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
