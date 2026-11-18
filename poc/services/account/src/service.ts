// 계정·구독 도메인(D09 §2). HTTP와 무관한 규칙만 여기에 둔다(라우트·요청 검증은 app.ts).
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
  /** 실제로 인증한 시각(ms). 루프백 교환으로 받은 세션은 원래 세션의 인증 시각을 잇는다. 비밀번호 설정·삭제의 최근 로그인 판정 */
  authAt: number;
  /** sha256(세션 토큰). 재인증(auth_at 갱신)·비밀번호 바꾼 뒤 이 세션만 남기기에 쓴다 */
  tokenHash: string;
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
  /** AIK를 고정한 시각(첫 PC의 등록 시각과 같다) */
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
  /** 계정 열쇠 보관(ADR-050, KEY_ESCROW_KEY). 없으면 /v1/key-escrow 경로는 닫히고(404) 새 PC는 쓰던 PC의 승인으로만 붙는다 */
  escrow?: KeyEscrow;
  /** 빌링키 봉인 키(32B, KMS, BILLING_KEY_SEAL_KEY). 빌링키 방식 PG(payments.billing)면 필수 */
  billingKeySealKey?: Buffer;
  /** 이벤트 로그(이름만, 수·ID 없음). 기기 토큰 발급 기록 등(ADR-040 결정 1) */
  onEvent?: (name: string) => void;
  /**
   * 응답과 따로 돌릴 일(알림 큐 즉시 발송, 재설정 코드 메일). 기본은 기다리지 않고 바로 시작한다. 플랫폼이 응답 뒤 실행을 멈춰도
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
    if (d.payments.billing && d.billingKeySealKey?.length !== 32) throw new Error('config_BILLING_KEY_SEAL_KEY');
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

  /**
   * 계정 세션·갱신 토큰 전면 무효화. 사고 대응(D09 §9.2) 운영 도구, [모든 기기에서 로그아웃], 비밀번호 재설정, 갱신 토큰 재사용 감지가 부른다.
   * 기기 범위 토큰·기기 등록은 그대로다(ADR-038 (e)(f)). keep이 있으면 그 세션 하나는 남긴다(토큰 또는 sha256 해시). 갱신 토큰은 모두 지운다.
   */
  async revokeAllSessions(accountId: string, keep?: { token: string } | { tokenHash: string }, q: Sql = this.db): Promise<number> {
    await q.run('DELETE FROM refresh_tokens WHERE account_id = $1', [accountId]);
    if (keep) return q.run('DELETE FROM sessions WHERE account_id = $1 AND token_hash <> $2', [accountId, 'token' in keep ? sha256hex(keep.token) : keep.tokenHash]);
    return q.run('DELETE FROM sessions WHERE account_id = $1', [accountId]);
  }

  // ---------- 자동 로그인: 갱신 토큰(ADR-038 (f)) ----------

  /** 로그인 성공 뒤 `remember: true`면 새 계보의 갱신 토큰(30일 미사용 만료) */
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

  /**
   * 비밀번호 대조 결과를 잠금 규칙에 넣는다(로그인·비밀번호 바꾸기 공통, ADR-038 (d)). 통과면 true.
   * 잠금 중에는 맞아도 false이고 실패 횟수도 쌓지 않는다(잠금 주기 하나에 알림 하나). 틀리면 계정당 5회 연속에서 잠근다(15분 × 2^단계, 상한 24시간).
   */
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
        // 알림은 잠금과 같은 트랜잭션으로 큐에 넣는다(잠금 주기마다 정확히 1회). 메일은 응답 경로에서 보내지 않는다
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

  /** 최근(10분) 코드·패스키·비밀번호 로그인 세션, 또는 10분 안에 재인증한 세션만. 갱신으로 받은 세션은 재인증해야 한다 */
  private requireRecentLogin(s: Session): void {
    if (s.authMethod === 'refresh' || this.now() - s.authAt > PASSWORD.reauthMaxAgeMs) fail('account.reauth_required');
  }

  private async setHash(q: Sql, accountId: string, h: { hash: string; salt: string; params: string }, now: number): Promise<void> {
    const n = await q.run('UPDATE pw_creds SET pw_hash = $1, salt = $2, params = $3, set_at = $4 WHERE account_id = $5', [h.hash, h.salt, h.params, now, accountId]);
    if (n === 0) await q.run('INSERT INTO pw_creds (account_id, pw_hash, salt, params, set_at) VALUES ($1, $2, $3, $4, $5)', [accountId, h.hash, h.salt, h.params, now]);
    await q.run('DELETE FROM pw_locks WHERE account_id = $1', [accountId]);
  }

  /**
   * 비밀번호 만들기·바꾸기(사용자 확정 2026-11-09, ADR-038). 정책은 서버가 판정한다.
   * - 만들기(아직 비밀번호 없음): 세션 인증 시각이 10분 안이어야 한다. 아니면 account.reauth_required(이메일 코드 재인증 → 다시).
   * - 바꾸기(비밀번호 있음): 현재 비밀번호가 필수다. 틀림·잠금은 account.current_password_invalid이고 로그인과 같은 잠금 횟수에 들어간다.
   *   바꾸기는 성공·실패 모두 로그인과 같은 응답 시각 하한(700ms)에 맞춘다(틀림·잠금·정책 오류가 시각으로 갈리지 않게).
   *   바꾸면 이 세션을 뺀 그 계정의 세션과 갱신 토큰을 모두 폐기한다(재설정과 같다). 기기 범위 토큰·기기 등록은 그대로다.
   *   같은 트랜잭션에서 이 세션용 새 갱신 토큰(새 계보, auth_method password)을 발급한다. 방금 현재 비밀번호로 본인 확인을 했으니
   *   이 기기의 자동 로그인은 끊지 않는다(데스크톱이 금고 account.refresh를 이 값으로 바꾼다, 팀장 결정 2026-11-09).
   * 둘 다 알림 메일(password_set)을 같은 트랜잭션으로 큐에 넣는다.
   */
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
      // 옛 계보는 모두 지우고(이 기기 것 포함) 그 뒤에 이 세션용 새 계보를 연다
      const n = changed ? await this.revokeAllSessions(s.accountId, { tokenHash: s.tokenHash }, q) : 0;
      const refreshToken = changed ? await this.issueRefresh(s.accountId, 'password', q) : undefined;
      await this.enqueueNotice(q, s.accountId, 'password_set', now);
      return { n, refreshToken };
    });
    p.onEvent?.(changed ? 'account.password_changed' : 'account.password_created');
    this.kickNotices();
    return { changed, revokedSessions: out.n, ...(out.refreshToken ? { refreshToken: out.refreshToken } : {}) };
  }

  // ---------- 계정 설정 재인증(이메일 코드, 사용자 확정 2026-11-09) ----------

  /** 재인증 코드 MAC: 이 세션(sha256 토큰)과 reauthId에 결속한다. 로그인 코드와 라벨이 달라 로그인 검증으로는 맞지 않는다 */
  private reauthMac(tokenHash: string, reauthId: string, code: string): string {
    return hmacHex(this.d.codeMacKey, 'SAX-reauth-code-v1', '\u0000', tokenHash, '\u0000', reauthId, '\u0000', code);
  }

  /** 계정 주소로 6자리 코드를 보낸다(10분, 5회). 표는 로그인 코드(login_codes)와 같이 쓰고 MAC 라벨로 용도를 가른다. 새 세션은 만들지 않는다 */
  async startReauth(s: Session): Promise<{ reauthId: string; expiresInSec: number }> {
    const a = await this.account(s.accountId);
    const reauthId = randomToken();
    const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
    await this.db.run('INSERT INTO login_codes (login_id_hash, email, code_mac, attempts, expires_at) VALUES ($1, $2, $3, 0, $4)', [sha256hex(reauthId), a.email, this.reauthMac(s.tokenHash, reauthId, code), this.now() + ACCOUNT.loginCodeTtlMs]);
    await this.d.mail.sendReauthCode(a.email, code);
    return { reauthId, expiresInSec: ACCOUNT.loginCodeTtlMs / 1000 };
  }

  /** 코드가 맞으면 이 세션의 인증 시각을 지금으로, 방식을 email_code로 바꾼다(갱신 세션도 이걸로 최근 인증이 된다). 실패는 로그인 코드와 같은 코드 */
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

  /**
   * 재설정 코드 요청. 계정이 있을 때만 메일을 보내지만 응답은 같다(시각 하한은 라우트).
   * 메일은 응답 경로에서 기다리지 않는다(ADR-038 (e), 팀장 결정 2026-11-07 ①): 메일 지연·실패가 응답 본문·시각을 바꾸지 않는다.
   * 코드 평문은 큐(DB)에 두지 않으므로 메모리에서만 따로 보낸다. 플랫폼이 멈춰 유실되면 사용자가 다시 요청한다(실패는 이벤트 이름만).
   */
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
    const hashed = await p.hasher.hash(pw);
    await this.setHash(this.db, accountId, hashed, this.now());
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

  /** 한도 키용(라우트가 솔트 해시로만 쓴다) */
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
      // 계정 설정 화면: 비밀번호 [만들기]/[바꾸기](현재 비밀번호 칸) 가르기와 재인증 필요 여부(사용자 확정 2026-11-09)
      hasPassword: !!(await this.db.one('SELECT 1 AS x FROM pw_creds WHERE account_id = $1', [a.id])),
      reauthUntil: s.authMethod === 'refresh' ? null : s.authAt + PASSWORD.reauthMaxAgeMs,
      // 탈퇴 유예 중이면 삭제 예정 시각(ms), 아니면 null
      deleteAfter: a.delete_after == null ? null : Number(a.delete_after),
    };
  }

  // ---------- 탈퇴(계정 삭제, 7일 유예) ----------

  /**
   * 탈퇴 요청(D09 §2.2: 계정 세션만 있는 삭제 요청은 7일 유예). 다음 결제가 일어나지 않게 구독을 바로 해지하고,
   * 계정 이메일로 알린다(직접 한 일이 아니면 유예 중 취소). 이미 요청 중이면 같은 예정 시각을 돌려준다.
   */
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
    // 탈퇴 요청이면 저장한 카드 빌링키를 바로 지운다(유예 7일 뒤 행 삭제를 기다리지 않는다, 약관 제15조·처리방침)
    if (sub) await this.db.run('UPDATE subscriptions SET billing_key_sealed = NULL, next_charge_at = NULL WHERE account_id = $1', [s.accountId]);
    await this.notify(s.accountId, 'account_delete_pending');
    return { deleteAfter: after };
  }

  /** 유예 중 탈퇴 취소. 해지한 구독은 되살리지 않는다(다시 구독은 checkout). */
  async cancelAccountDelete(accountId: string): Promise<void> {
    const n = await this.db.run('UPDATE accounts SET delete_after = NULL WHERE id = $1 AND delete_after IS NOT NULL', [accountId]);
    if (!n) fail('account.not_pending');
  }

  async consent(s: Session, version: string): Promise<void> {
    await this.db.run('INSERT INTO consents (account_id, version, at) VALUES ($1, $2, $3) ON CONFLICT (account_id, version) DO NOTHING', [s.accountId, version, this.now()]);
  }

  // ---------- 알림 메일 발송 큐(notice_outbox) ----------

  private async enqueueNotice(q: Sql, accountId: string, kind: NoticeKind, now: number): Promise<void> {
    await q.run('INSERT INTO notice_outbox (id, account_id, kind, created_at, attempts, next_at) VALUES ($1, $2, $3, $4, 0, $4)', [randomToken(), accountId, kind, now]);
  }

  /** 응답과 따로 돌린다(AccountDeps.defer). 실패는 이벤트 이름만 */
  private later(task: () => Promise<unknown>, failEvent: string): void {
    const run = () => task().then(
      () => undefined,
      () => this.d.onEvent?.(failEvent),
    );
    if (this.d.defer) this.d.defer(run);
    else void run();
  }

  /** 큐를 응답과 따로 비운다(행은 남아 실패해도 다음 정리 때 다시) */
  private kickNotices(): void {
    this.later(() => this.drainNotices(), 'account.notice_drain_failed');
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
      // 메일 호출만 실패로 본다(보낸 뒤 DB 오류로 다시 보내지 않게). 계정이 사라졌으면 보내지 않고 지운다.
      // 어댑터가 다시 보내도 같다고 한 실패(retryable === false: 주소 거부·설정·인증)는 기다리지 않고 버린다
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

  // ---------- 구독·결제(19,900원 한 플랜, ADR-034) ----------

  async checkout(s: BillingCaller): Promise<{ checkoutUrl: string }> {
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

  // ---------- 카드 정기결제(빌링키 PG): 카드 등록 창 → 빌링키 발급 → 첫 달 청구, 다음 달부터 정리 cron이 갱신일에 청구 ----------

  /** 카드 등록 창(GET /v1/billing/card?ref=). 결제 대기·연체인 참조만 연다. 세션 없이 열린다(브라우저): 참조는 그 계정만 받은 무작위 값이다 */
  async billingCardPage(ref: string, nonce: string): Promise<{ status: number; html: string }> {
    const b = this.billingOrFail();
    const sub = REF_RE.test(ref) ? await this.db.one<{ status: string; account_id: string }>('SELECT status, account_id FROM subscriptions WHERE pg_customer_ref = $1', [ref]) : undefined;
    if (!sub || (sub.status !== 'pending' && sub.status !== 'past_due'))
      return { status: 404, html: this.resultPage('결제 창이 만료됐어요', '앱에서 구독하기를 다시 눌러 주세요.', nonce) };
    const base = `${this.d.publicOrigin}/v1/billing/card`;
    // 체험 중 첫 구독이면 오늘은 결제하지 않고 체험이 끝나는 날 첫 결제(창에 그 날짜를 보인다)
    const ent = sub.status === 'pending' ? await this.entitlement(sub.account_id) : null;
    const trialEndsAt = ent?.state === 'trial' && ent.until !== null ? ent.until : undefined;
    return { status: 200, html: b.cardPage({ customerKey: ref, successUrl: `${base}/success`, failUrl: `${base}/fail`, amountKrw: PLAN.amountKrw, nonce, ...(trialEndsAt ? { trialEndsAt } : {}) }) };
  }

  /** 카드 등록 성공 돌아옴(GET /v1/billing/card/success?customerKey&authKey). 빌링키를 발급·봉인하고 이번 기간을 청구한다 */
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
      // 체험 중 첫 구독: 오늘은 청구하지 않는다. 체험이 끝나는 날(renew_at)에 정리 cron이 첫 결제. 체험 중 해지하면 결제가 없다
      const n = await this.db.run(
        "UPDATE subscriptions SET billing_key_sealed = $2, charge_attempts = 0, next_charge_at = NULL, renew_at = $3, status = 'active' WHERE pg_customer_ref = $1 AND status = 'pending'",
        [customerKey, sealAead(this.d.billingKeySealKey!, bkAad(customerKey), Buffer.from(key.billingKey, 'utf8')), ent.until],
      );
      if (n !== 1) return bad();
      await this.db.run('INSERT INTO consents (account_id, version, at) VALUES ($1, $2, $3) ON CONFLICT (account_id, version) DO NOTHING', [sub.account_id, TERMS_VERSION, now]);
      this.d.onEvent?.(`account.billing_key_issued_trial.${b.mode}`);
      return { status: 200, html: this.resultPage('카드를 등록했어요', `무료 체험은 그대로 이어져요. ${kstDateLabel(ent.until)}부터 매월 ${PLAN.amountKrw.toLocaleString('ko-KR')}원이 자동 결제돼요. 그 전에 해지하면 결제되지 않아요.`, nonce) };
    }
    // 결제 대기면 이번 기간은 오늘부터(renew_at = 이번 기간 시작, 청구 성공 뒤 한 달 뒤로). 연체면 밀린 기간부터. 새 카드는 실패 수를 0으로
    const n = await this.db.run(
      "UPDATE subscriptions SET billing_key_sealed = $2, charge_attempts = 0, next_charge_at = NULL, renew_at = CASE WHEN status = 'pending' THEN $3 ELSE renew_at END WHERE pg_customer_ref = $1 AND status IN ('pending', 'past_due')",
      [customerKey, sealAead(this.d.billingKeySealKey!, bkAad(customerKey), Buffer.from(key.billingKey, 'utf8')), now],
    );
    if (n !== 1) return bad();
    // 결제 창에서 동의한 약관 판을 계정 동의 이력에 남긴다(계약 기록). 창은 동의 체크 뒤에만 PG 창을 연다
    await this.db.run('INSERT INTO consents (account_id, version, at) SELECT account_id, $2, $3 FROM subscriptions WHERE pg_customer_ref = $1 ON CONFLICT (account_id, version) DO NOTHING', [customerKey, TERMS_VERSION, now]);
    this.d.onEvent?.(`account.billing_key_issued.${b.mode}`);
    const r = await this.chargeRef(customerKey);
    if (r === 'paid') return { status: 200, html: this.resultPage('구독을 시작했어요', `${PLAN.amountKrw.toLocaleString('ko-KR')}원이 결제됐어요. 다음 달 같은 날짜에 자동으로 결제돼요.`, nonce) };
    if (r === 'declined') return { status: 402, html: this.resultPage('결제가 승인되지 않았어요', '카드 한도나 상태를 확인하고 다른 카드로 다시 시도해 주세요.', nonce) };
    return { status: 202, html: this.resultPage('결제를 확인하고 있어요', '잠시 뒤 앱에서 구독 상태를 확인해 주세요. 두 번 결제되지는 않아요.', nonce) };
  }

  /** 카드 등록 실패·취소 돌아옴(GET /v1/billing/card/fail). PG 메시지는 보여주지 않는다(고정 문구) */
  billingCardFail(code: string, nonce: string): { status: number; html: string } {
    this.billingOrFail();
    const canceled = code === 'PAY_PROCESS_CANCELED' || code === 'USER_CANCEL';
    this.d.onEvent?.(`account.billing_card_fail.${/^[A-Z_]{1,64}$/.test(code) ? code : 'unknown'}`);
    return { status: 200, html: this.resultPage(canceled ? '카드 등록을 취소했어요' : '카드를 등록하지 못했어요', '앱에서 구독하기를 다시 눌러 주세요.', nonce) };
  }

  /**
   * 갱신일이 된 구독을 청구한다(정리 cron, 한 시간마다). 결제 대기(첫 청구 결과 모름)·활성·연체 중 빌링키가 있고 시도 시각이 된 것.
   * 한 번에 limit개까지. 반환: 결과별 수
   */
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

  /**
   * 한 구독의 이번 기간 청구. 임대를 잡은 쪽만 청구한다. 주문번호 = 참조·기간 시작·확정 실패 수·빌링키 지문: 결과를 모를 때는 같은 주문번호(= 멱등 키)로 다시 물어
   * 두 번 결제되지 않고, 카드 사유 실패 뒤의 재시도는 새 주문이다.
   */
  private async chargeRef(ref: string): Promise<'paid' | 'declined' | 'uncertain' | 'busy'> {
    const b = this.billingOrFail();
    const now = this.now();
    const lease = await this.db.run(
      "UPDATE subscriptions SET next_charge_at = $2 WHERE pg_customer_ref = $1 AND billing_key_sealed IS NOT NULL AND status IN ('pending', 'active', 'past_due') AND renew_at IS NOT NULL AND renew_at <= $3 AND (next_charge_at IS NULL OR next_charge_at <= $3)",
      [ref, now + BILLING.chargeLeaseMs, now],
    );
    if (lease !== 1) return 'busy';
    const row = await this.db.one<{ account_id: string; status: string; renew_at: number; charge_attempts: number; billing_key_sealed: Buffer }>('SELECT account_id, status, renew_at, charge_attempts, billing_key_sealed FROM subscriptions WHERE pg_customer_ref = $1', [ref]);
    // 임대와 읽기 사이에 해지(빌링키 삭제)가 들어왔으면 청구하지 않는다
    if (!row?.billing_key_sealed) return 'busy';
    const bk = openAead(this.d.billingKeySealKey!, bkAad(ref), Buffer.from(row.billing_key_sealed));
    if (!bk) {
      this.d.onEvent?.('account.billing_key_unsealable');
      return 'uncertain';
    }
    const periodStart = Number(row.renew_at);
    const attempts = Number(row.charge_attempts);
    // 끝 8자 = 빌링키 지문: 새 카드로 다시 등록하면(실패 수가 0으로 돌아가도) 앞서 거절된 주문번호와 겹치지 않는다
    const orderId = `${ref.slice(4)}-${periodStart.toString(36)}-${attempts}-${createHash('sha256').update(bk).digest('base64url').slice(0, 8)}`;
    const r = await b.charge({ billingKey: bk.toString('utf8'), customerKey: ref, orderId, amountKrw: PLAN.amountKrw, orderName: BILLING.orderName });
    if (r.ok) {
      // 다음 갱신일 = 기간 시작 + 한 달(KST 달력). 해지가 그사이 들어왔으면 상태는 그대로 두고 갱신일만 맞춘다(이미 결제된 기간)
      await this.db.run(
        "UPDATE subscriptions SET status = CASE WHEN status = 'canceled' THEN status ELSE 'active' END, renew_at = $2, charge_attempts = 0, next_charge_at = NULL, last_payment_key = $4, last_paid_at = $5, last_paid_amount = $6 WHERE pg_customer_ref = $1 AND renew_at = $3",
        [ref, addMonthKst(periodStart), periodStart, r.paymentKey ?? null, now, PLAN.amountKrw],
      );
      this.d.onEvent?.(`account.billing_charged.${b.mode}`);
      // 앞선 결과 모름 시도가 실은 성공(ALREADY_PROCESSED_PAYMENT)이면 결제 키가 없다: 청약철회는 운영에서 토스 관리자로 처리
      if (!r.paymentKey) this.d.onEvent?.('account.billing_charged_without_payment_key');
      return 'paid';
    }
    if (r.uncertain) {
      // 임대 끝(next_charge_at)에 같은 주문번호로 다시 묻는다
      this.d.onEvent?.(`account.billing_charge_uncertain.${r.code}`);
      return 'uncertain';
    }
    this.d.onEvent?.(`account.billing_charge_declined.${r.code}`);
    const failed = attempts + 1;
    if (row.status === 'pending') {
      // 첫 결제 실패: 빌링키를 지우고 사용자가 다른 카드로 다시 등록한다(자동 재시도하지 않는다)
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

  /** 체험이 끝나 첫 결제로 넘어가기 7일 전 안내(전환 전 고지, 한 번). 등록만 하고 아직 결제가 없는 구독 */
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
    // 청약철회 가능하면 기한과 지금 환불 금액(빌링키 PG만)
    const q = this.d.payments.billing ? this.refundQuote(sub, this.now()) : null;
    if (q) out.refund = q;
    return out;
  }

  /** GET /v1/billing/entitlement: 유료 기능 권리(구독 화면·잠금 안내) */
  async entitlementOf(s: BillingCaller): Promise<{ state: string; until: number | null; trialMonths: number }> {
    return { ...(await this.entitlement(s.accountId)), trialMonths: BILLING.trialMonths };
  }

  async cancelSubscription(s: BillingCaller): Promise<void> {
    const sub = await this.db.one<{ pg_customer_ref: string; status: string }>('SELECT pg_customer_ref, status FROM subscriptions WHERE account_id = $1', [s.accountId]);
    if (!sub || sub.status === 'canceled') fail('request.param_rejected');
    await this.d.payments.cancel(sub!.pg_customer_ref);
    // 빌링키도 지운다(더 청구하지 않음). 이미 결제된 기간의 갱신일(renew_at)은 남긴다(그날까지 이용). 접수 메일을 바로 보낸다
    await this.db.tx(async (q) => {
      await q.run("UPDATE subscriptions SET status = 'canceled', billing_key_sealed = NULL, next_charge_at = NULL WHERE account_id = $1", [s.accountId]);
      await this.enqueueNotice(q, s.accountId, 'subscription_canceled', this.now());
    });
    this.kickNotices();
  }

  /**
   * 청약철회 환불(결제 후 7일 안, 전자상거래법 §17). 금액 = 결제액 − 쓴 날만큼(결제 시각부터 지난 날 수 ÷ 그 기간 날 수, 원 단위 올림).
   * 결제 당일이면 전액. 환불하면 구독은 바로 끝난다(빌링키 삭제, 이용 끝 = 지금). 같은 결제의 환불 요청은 멱등 키가 같아 두 번 환불되지 않는다.
   */
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
    // 같은 결제를 동시에 두 번 환불하지 않게 먼저 결제 참조를 비운다(실패하면 되돌린다)
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

  /**
   * 유료 기능을 쓸 수 있는가(게이트웨이 범위 토큰). 체험(가입 뒤 BILLING.trialMonths달, 카드 없음) 또는 낸 기간 안(활성·연체 유예·해지했지만 갱신일 전).
   * until = 그 권리가 끝나는 시각(체험 끝·갱신일). 모의 PG(웹훅)도 같은 규칙이다.
   */
  async entitlement(accountId: string): Promise<{ state: 'trial' | 'paid' | 'none'; until: number | null }> {
    const now = this.now();
    const a = await this.db.one<{ created_at: number }>('SELECT created_at FROM accounts WHERE id = $1', [accountId]);
    const sub = await this.db.one<{ status: string; renew_at: number | null }>('SELECT status, renew_at FROM subscriptions WHERE account_id = $1', [accountId]);
    const renew = sub?.renew_at === null || sub?.renew_at === undefined ? null : Number(sub.renew_at);
    if (sub && renew !== null) {
      if (sub.status === 'active' && renew > now) return { state: 'paid', until: renew };
      // 활성인데 갱신일이 지난 것은 청구 대기(cron 한 시간 주기)·연체 재시도 중이다: 유예 안에서는 쓸 수 있다
      if ((sub.status === 'active' || sub.status === 'past_due') && renew + BILLING.pastDueGraceMs > now) return { state: 'paid', until: renew + BILLING.pastDueGraceMs };
      if (sub.status === 'canceled' && renew > now) return { state: 'paid', until: renew };
    }
    let trialEnd = a ? Number(a.created_at) : 0;
    for (let i = 0; a && i < BILLING.trialMonths; i++) trialEnd = addMonthKst(trialEnd);
    if (trialEnd > now) return { state: 'trial', until: trialEnd };
    return { state: 'none', until: null };
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
    /** 유예 중이라 폐기는 아직이지만 바로 정지한 폰 */
    const halted: string[] = [];
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
      // 유예(등록 7일 미만 데스크톱의 폐기)는 새로 붙은 PC가 쓰던 기기를 밀어내지 못하게 하는 장치다. 계정의 첫 PC(AIK를 고정한 PC)는 대상이 아니다(ADR-048 결정 6)
      const first = a.aik_pinned_at !== null && Number(me!.registered_at) <= Number(a.aik_pinned_at);
      const cooling = !first && now - me!.registered_at < DEVICE.newDeviceCoolingDays * MS.D;
      for (const [id, r] of revoked) {
        const d = byId.get(id);
        if (!d || d.state === 'revoked') continue;
        // 유예는 처음 폐기 레코드가 들어온 때부터 센다(목록을 다시 올려도 다시 시작하지 않는다)
        if (cooling) {
          await q.run('UPDATE devices SET delete_after = COALESCE(delete_after, $1), revoke_record = $2 WHERE device_id = $3', [now + ACCOUNT.deleteGraceDays * MS.D, jcs(r), id]);
          // 폰은 유예 중에도 바로 정지한다(잃어버린 폰의 토큰·우편함·푸시가 7일 살아 있지 않게). 자리는 유예가 끝나야 빈다.
          // PC는 정지하지 않는다: 새로 붙은 PC가 쓰던 PC를 즉시 멈출 수 없어야 한다
          if (d.role === 'mobile' && (d.state === 'active' || d.state === 'pending')) {
            await q.run("UPDATE devices SET state = 'suspended' WHERE device_id = $1", [id]);
            halted.push(id);
          }
        } else {
          await q.run("UPDATE devices SET state = 'revoked', revoke_record = $1, delete_after = NULL WHERE device_id = $2", [jcs(r), id]);
          await q.run("INSERT INTO device_events (account_id, role, kind, day) VALUES ($1, $2, 'remove', $3)", [requester.accountId, d.role, kstDay(now)]);
          stopped.push(id);
        }
      }
      await q.run('UPDATE accounts SET device_list_version = $1, device_list_json = $2 WHERE id = $3', [l.listVersion, jcs(l), requester.accountId]);
    });
    for (const id of [...stopped, ...halted]) await this.stopped(id);
    if (stopped.length) await this.notify(requester.accountId, 'device_revoked');
    if (halted.length) await this.notify(requester.accountId, 'device_suspended');
    return { listVersion: l.listVersion };
  }

  /**
   * 기기가 스스로 나간다(ADR-048 결정 6, 기기 토큰). 바로 폐기하고 자리를 비운다. AIK 폐기 레코드는 없다:
   * 자기 자신을 빼는 것이라 남을 밀어낼 수 없고, 데스크톱이 다음 목록 갱신 때 이 항목을 폐기 레코드로 옮긴다(이미 폐기된 기기의 레코드는 그대로 받는다).
   * 계정에 남은 마지막 활성 데스크톱은 나갈 수 없다(AIK를 가진 기기가 없어지면 기기를 더하거나 끊을 수 없다. 그 PC는 로그아웃만 한다).
   */
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

  /**
   * 기기 토큰으로 다른 기기를 정지한다(ADR-048 결정 6: 폰에서 잃어버린 폰·PC 막기). AIK가 없으니 정지까지만 한다:
   * 바로 suspended(토큰·우편함·푸시가 즉시 멈춤) + 7일 뒤 폐기 예약 + 알림 메일. 켜져 있는 데스크톱이 AIK 폐기로 바로 확정하거나 재활성화로 되돌린다.
   * 마지막 남은 활성 데스크톱은 정지할 수 없다(훔친 폰으로 계정을 잠그지 못하게). 자기 자신은 leave로 한다.
   */
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

  // ---- 새 PC 연결 우편함(ADR-048 결정 3, D08 §4.3) ----
  // 서버는 순서만 지킨다(hello → challenge → reveal → grant). 내용의 진위(약속·6자리·AIK 서명·봉인문)는 두 PC가 본다.

  /**
   * [새 PC, 세션] m1. 내 계정의 데스크톱이고 hello의 키가 등록한 키와 같아야 한다. 다시 올리면 앞 단계를 지우고 새로 시작한다.
   * 신청 중(pending)이 보통이다. 활성(active)도 받는다: 목록에는 올랐는데 RK를 받지 못하고 끊긴 PC가 다시 받는 길이다(쓰던 PC의 6자리 승인은 같다).
   */
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

  /** [새 PC, 세션] 답을 본다. */
  async pcLinkForNew(s: Session, deviceId: string): Promise<{ challenge: unknown; grant: unknown }> {
    const l = await this.pcLink(s.accountId, deviceId);
    return { challenge: l.challenge ? JSON.parse(l.challenge) : null, grant: l.grant_msg ? JSON.parse(l.grant_msg) : null };
  }

  /** [새 PC, 세션] m3. challenge가 온 뒤 한 번만. */
  async putPcLinkReveal(s: Session, deviceId: string, reveal: unknown): Promise<void> {
    const n = await this.db.run('UPDATE pc_links SET reveal = $1 WHERE device_id = $2 AND account_id = $3 AND challenge IS NOT NULL AND reveal IS NULL AND expires_at > $4', [jcs(reveal), deviceId, s.accountId, this.now()]);
    if (!n) {
      await this.pcLink(s.accountId, deviceId);
      fail('account.link_state');
    }
  }

  /** [기존 PC, 기기 토큰] 기다리는 신청들. 이름·플랫폼은 서버 값(신청 때 새 PC가 적은 것)이다. */
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

  /** [기존 PC] m2. 신청 하나에 한 번만(먼저 답한 PC가 승인한다). challenge의 device_id는 요청한 기기여야 한다. */
  async putPcLinkChallenge(requester: { accountId: string; deviceId: string }, deviceId: string, challenge: { device_id: string }): Promise<void> {
    if (challenge.device_id !== requester.deviceId || deviceId === requester.deviceId) fail('request.param_rejected');
    const n = await this.db.run('UPDATE pc_links SET challenge = $1 WHERE device_id = $2 AND account_id = $3 AND challenge IS NULL AND expires_at > $4', [jcs(challenge), deviceId, requester.accountId, this.now()]);
    if (!n) {
      await this.pcLink(requester.accountId, deviceId);
      fail('account.link_state');
    }
  }

  /** [기존 PC] m4. 답했던 PC만, reveal이 온 뒤, 새 PC가 목록으로 활성화된 뒤에만(목록을 먼저 올린다). */
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

  /**
   * 신청 지우기. 없어도 오류가 아니다.
   * - 새 PC(세션): 받아 갔거나 그만둘 때. 신청 중인 기기 기록은 둔다(같은 PC가 다시 시도하면 그대로 쓴다. 7일 뒤 정리).
   * - 쓰던 PC(기기 토큰, dropPending): 6자리가 다르거나 거절할 때. 아직 활성화되지 않은(pending) 그 데스크톱 기록도 지워 자리를 비운다.
   */
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

  // ---- 계정 열쇠 보관(ADR-050, 대표 결정 2026-11-18) ----
  // 쓰던 PC 없이 로그인한 새 PC가 이메일 인증만으로 붙는다. 로그인된 PC가 계정 열쇠(RK)를 보관 키로 봉인해 맡기고,
  // 새 PC는 계정 세션으로 받아 자기 금고에 넣은 뒤 AIK로 서명한 기기 목록을 스스로 올린다(서버는 서명만 본다).
  // 이 서비스는 맡긴 열쇠를 열 수 있다. 패스키가 있는 계정은 패스키 세션이어야 받는다(기기 추가와 같은 규칙).

  private get escrow(): KeyEscrow {
    return this.d.escrow ?? fail('request.not_found');
  }

  /** [로그인된 PC, 기기 토큰] 보관 키의 공개키와, 이 계정의 열쇠가 지금 키로 맡겨져 있는지. */
  async keyEscrowState(accountId: string): Promise<{ pub: string; stored: boolean }> {
    const e = this.escrow;
    const a = await this.account(accountId);
    const r = await this.db.one<{ aik_pub: string; key_pub: string }>('SELECT aik_pub, key_pub FROM key_escrow WHERE account_id = $1', [accountId]);
    return { pub: e.publicKey, stored: !!r && !!a.aik_pub && r.aik_pub === a.aik_pub && r.key_pub === e.publicKey };
  }

  /** [로그인된 PC, 기기 토큰] 맡긴다. 열어서 나온 AIK 공개키가 계정의 AIK와 같을 때만 받는다(다른 열쇠·옛 보관 키로 봉인한 것은 400). */
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

  /**
   * [새 PC, 세션] 맡긴 열쇠를 이 PC의 넘겨받기 키(Hx)로 다시 봉인해 받는다. 이 PC는 내 계정에 신청 중이거나 활성인 데스크톱이어야 한다
   * (신청은 POST /v1/devices/enroll이 한도·알림 메일과 함께 한다). 맡긴 열쇠가 없으면 account.escrow_missing.
   */
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
    // 보관 키가 바뀌어 열리지 않는 줄은 없는 것과 같다(로그인된 PC가 다음에 켤 때 다시 맡긴다)
    if (!out) return fail('account.escrow_missing');
    this.d.onEvent?.('account.key_escrow_claimed');
    return { aikPub: a.aik_pub, enc: out.enc.toString('base64'), ct: out.ct.toString('base64') };
  }

  /**
   * [새 PC, 세션] 열쇠를 받은 새 PC가 자기를 넣은 AIK 서명 기기 목록을 올린다(아직 활성이 아니라 기기 토큰이 없다).
   * 검사는 PUT /v1/device-list와 같다: 계정 AIK의 서명, 버전, 신청한 키와 같은 항목, 한도. 서명은 계정 열쇠를 가진 PC만 만들 수 있다.
   * 이 PC는 방금 붙었으므로 이 PC가 올리는 폐기는 7일 유예에 걸린다(쓰던 기기를 바로 밀어내지 못한다).
   */
  async joinByKeyEscrow(s: Session, deviceId: string, l: DeviceList): Promise<{ listVersion: number }> {
    void this.escrow;
    await this.requireStrongSessionIfPasskeys(this.db, s);
    const d = await this.db.one<DeviceRow>('SELECT * FROM devices WHERE device_id = $1 AND account_id = $2', [deviceId, s.accountId]);
    if (!d || d.role !== 'desktop' || (d.state !== 'pending' && d.state !== 'active')) fail('account.device_not_found');
    // 이 길로는 자기를 더하기만 한다(폐기 레코드가 늘면 받지 않는다)
    const cur = (await this.deviceList(s.accountId)).deviceList;
    if (!cur || l.revoked.length !== cur.revoked.length || l.entries.length !== cur.entries.length + 1) fail('request.param_rejected');
    const out = await this.updateDeviceList({ accountId: s.accountId, deviceId }, l);
    await this.db.run('DELETE FROM pc_links WHERE device_id = $1 AND account_id = $2', [deviceId, s.accountId]);
    this.d.onEvent?.('account.key_escrow_joined');
    return out;
  }

  // ---- 발급 잠금(ADR-048 결정 7) ----
  // 계정당 하나. 잡은 PC만 홈택스 발급에 들어간다. 서버는 무엇을 발급하는지 모르고(기기·만료뿐), 놓으면 줄을 지워 횟수도 남기지 않는다.

  /** 잡기. 다른 데스크톱이 잡고 있으면 account.issue_locked. 같은 데스크톱이 다시 잡으면 새 값으로 바꾼다(앞 실행이 죽은 경우, 앞 값은 죽는다). */
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

  /** 갱신. 내가 잡은 값이 아직 살아 있을 때만 늘린다. 만료됐거나 넘어갔으면 account.issue_lock_lost(커밋하지 않는다). */
  async renewIssueLock(requester: { accountId: string; deviceId: string }, lockId: string): Promise<{ expiresAt: number }> {
    const now = this.now();
    const expiresAt = now + ISSUE_LOCK.ttlMs;
    const n = await this.db.run('UPDATE issue_locks SET expires_at = $1 WHERE account_id = $2 AND device_id = $3 AND hold_id = $4 AND expires_at > $5', [expiresAt, requester.accountId, requester.deviceId, lockId, now]);
    if (!n) fail('account.issue_lock_lost');
    return { expiresAt };
  }

  /** 놓기. 내가 잡은 값일 때만 줄을 지운다. 이미 넘어갔거나 만료됐어도 오류가 아니다. */
  async releaseIssueLock(requester: { accountId: string; deviceId: string }, lockId: string): Promise<void> {
    await this.db.run('DELETE FROM issue_locks WHERE account_id = $1 AND device_id = $2 AND hold_id = $3', [requester.accountId, requester.deviceId, lockId]);
  }

  /** 누가 잡고 있는지(기다리는 PC가 "다른 PC(이름)에서 발급 중"을 보이는 데 쓴다. 이름은 PC가 자기 기기 목록에서 찾는다). */
  async issueLock(accountId: string): Promise<{ held: boolean; deviceId: string | null; expiresAt: number | null }> {
    const cur = await this.db.one<{ device_id: string; expires_at: number }>('SELECT device_id, expires_at FROM issue_locks WHERE account_id = $1', [accountId]);
    if (!cur || Number(cur.expires_at) <= this.now()) return { held: false, deviceId: null, expiresAt: null };
    return { held: true, deviceId: cur.device_id, expiresAt: Number(cur.expires_at) };
  }

  // ---- 계정 공유 기록(ADR-048 결정 5, D07 §10) ----
  // 계정의 PC와 폰이 발급 기록·거래처·내 사업자·돈 요약·맡긴 일을 같이 쓴다. 서버는 줄의 종류·순번·시각·크기·올린 기기와 일의 상태만 본다.
  // 내용은 계정 열쇠에서 나온 키로 봉인한 암호문이고 서명도 그 안에 있어서, 서버는 줄을 지어내지도 읽지도 못한다(숨기거나 순서를 바꿀 수는 있다).

  /**
   * 줄 올리기. 같은 줄 id를 같은 내용으로 다시 올리면 처음 순번을 그대로 준다(끊긴 응답 뒤 다시 올리기).
   * 기기가 하나뿐인 계정은 받지 않는다(서버가 발급 시각을 알 이유가 없다, E-07). 폰은 맡긴 일(task)만 올린다.
   * task_result는 그 일을 맡은 데스크톱만 올리고, 올리면 일이 끝난 것으로 바뀐다.
   * 돈 요약(money)은 새 줄을 받으면 그 계정의 앞 요약 줄을 지운다(SHARE.latestOnlyKinds).
   */
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
      // 마지막 한 장만 뜻이 있는 종류(돈 요약)는 앞 줄을 지운다. 읽는 쪽은 (at, dev)로 고르므로 순번에 기대지 않는다
      if ((SHARE.latestOnlyKinds as readonly string[]).includes(row.kind)) {
        await q.run('DELETE FROM share_rows WHERE account_id = $1 AND kind = $2 AND seq < $3', [requester.accountId, row.kind, seq]);
      }
      if (head) await q.run('UPDATE share_heads SET next_seq = $1, epoch = $2 WHERE account_id = $3', [seq + 1, Math.max(Number(head.epoch), row.epoch), requester.accountId]);
      else await q.run('INSERT INTO share_heads (account_id, next_seq, epoch) VALUES ($1, $2, $3)', [requester.accountId, seq + 1, row.epoch]);
      return { seq };
    });
  }

  /** 줄 받기: after보다 큰 순번을 순서대로. 한 번에 SHARE.pageRows줄·본문 합계 SHARE.pageChars까지이고, 더 있으면 more. head는 마지막으로 준 순번(없으면 0)이다. */
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

  /** 맡긴 일의 상태(내용은 줄에 있다). 열린 일이 유효 시간을 넘겼으면 expired로 보인다. 지워지기 전(30일)의 끝난 일도 준다. */
  async shareTasks(accountId: string): Promise<ShareTaskOut[]> {
    const now = this.now();
    const rows = await this.db.all<ShareTaskRow>('SELECT task_id, state, created_by, claimed_by, claim_expires_at, created_at, updated_at FROM share_tasks WHERE account_id = $1 ORDER BY created_at, task_id', [accountId]);
    return rows.map((t) => {
      const lease = t.claim_expires_at === null ? null : Number(t.claim_expires_at);
      const expired = Number(t.created_at) + SHARE.taskTtlMs <= now;
      const live = t.state === 'claimed' && lease !== null && lease > now;
      // 맡은 PC가 죽어 맡김이 만료된 일은 다시 열린 것으로 보인다(유효 시간이 남았을 때)
      const state: ShareTaskOut['state'] = t.state === 'done' || t.state === 'cancelled' ? t.state : live ? 'claimed' : expired ? 'expired' : 'open';
      return { taskId: t.task_id, state, createdBy: t.created_by, claimedBy: live ? t.claimed_by : null, claimExpiresAt: live ? lease : null, createdAt: Number(t.created_at), updatedAt: Number(t.updated_at) };
    });
  }

  /**
   * 일 맡기(데스크톱). 한 번에 한 PC만 성공한다. 맡은 PC가 다시 부르면 만료만 늘린다.
   * 다른 PC의 맡김이 살아 있으면 account.task_claimed, 끝났거나 취소됐거나 유효 시간(72시간)이 지났으면 account.task_closed.
   */
  async claimShareTask(requester: { accountId: string; deviceId: string }, taskId: string): Promise<{ claimExpiresAt: number }> {
    return this.db.tx(async (q) => {
      const t = await q.one<ShareTaskRow>(`SELECT task_id, state, created_by, claimed_by, claim_expires_at, created_at, updated_at FROM share_tasks WHERE account_id = $1 AND task_id = $2${q.forUpdate}`, [requester.accountId, taskId]);
      if (!t) fail('account.task_not_found');
      if (t.state === 'done' || t.state === 'cancelled') fail('account.task_closed');
      const now = this.now();
      const mine = t.state === 'claimed' && t.claimed_by === requester.deviceId;
      if (t.state === 'claimed' && !mine && Number(t.claim_expires_at ?? 0) > now) fail('account.task_claimed');
      // 유효 시간은 새로 맡을 때만 본다. 이미 맡아 돌리는 PC는 끝까지 늘릴 수 있다
      if (!mine && Number(t.created_at) + SHARE.taskTtlMs <= now) fail('account.task_closed');
      const claimExpiresAt = now + SHARE.claimMs;
      await q.run("UPDATE share_tasks SET state = 'claimed', claimed_by = $1, claim_expires_at = $2, updated_at = $3 WHERE account_id = $4 AND task_id = $5", [requester.deviceId, claimExpiresAt, now, requester.accountId, taskId]);
      return { claimExpiresAt };
    });
  }

  /** 맡은 일 내려놓기(맡은 PC가 못 하게 됐을 때). 내가 맡은 일일 때만 다시 연다. 아니어도 오류가 아니다. */
  async releaseShareTask(requester: { accountId: string; deviceId: string }, taskId: string): Promise<void> {
    await this.db.run("UPDATE share_tasks SET state = 'open', claimed_by = NULL, claim_expires_at = NULL, updated_at = $1 WHERE account_id = $2 AND task_id = $3 AND state = 'claimed' AND claimed_by = $4", [
      this.now(),
      requester.accountId,
      taskId,
      requester.deviceId,
    ]);
  }

  /** 일 취소(계정의 어느 기기든). 다른 기기가 맡아 돌리는 중이면 account.task_claimed, 이미 끝났으면 account.task_closed. 이미 취소된 일은 그대로 둔다. */
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
    // 정지·폐기된 PC가 잡고 있던 발급 잠금은 바로 놓는다(그 PC는 갱신도 못 한다)
    await this.db.run('DELETE FROM issue_locks WHERE device_id = $1', [deviceId]).catch(() => undefined);
    await this.db.run('DELETE FROM pc_links WHERE device_id = $1', [deviceId]).catch(() => undefined);
    // 정지·폐기된 PC가 맡고 있던 일은 다시 연다(다른 PC가 맡는다)
    await this.db
      .run("UPDATE share_tasks SET state = 'open', claimed_by = NULL, claim_expires_at = NULL, updated_at = $1 WHERE claimed_by = $2 AND state = 'claimed'", [this.now(), deviceId])
      .catch(() => undefined);
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
    // 폐기 레코드 없이 예약된 삭제(기기 토큰 정지·세션 삭제 요청)는 재활성화로 같이 취소한다. AIK 폐기 유예(revoke_record 있음)는 그대로 둔다
    const n = await this.db.run(
      "UPDATE devices SET state = 'active', delete_after = CASE WHEN revoke_record IS NULL THEN NULL ELSE delete_after END WHERE device_id = $1 AND account_id = $2 AND state = 'suspended'",
      [deviceId, a.id],
    );
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
   * Phase 1 폰 토큰은 relay·push와 chat(폰 대화, ADR-047) 범위만(ADR-034, D09 §2.1).
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
    let scopes = want ? roleScopes.filter((s) => want.includes(s)) : [...roleScopes];
    // 유료 기능(게이트웨이·폰 대화)은 체험 중이거나 낸 기간 안일 때만. 유료 범위만 달라면 402, 다른 범위와 같이 달라면 유료 범위만 빼고 준다(연결·기기 관리는 그대로).
    // 줄 때는 등급(tier)을 싣는다: 게이트웨이 일 한도가 체험·유료로 다르다
    let tier: 'trial' | 'paid' | undefined;
    if (scopes.some((x) => PAID_SCOPES.includes(x))) {
      const ent = (await this.entitlement(d!.account_id)).state;
      if (ent === 'none') {
        if (want && scopes.every((x) => PAID_SCOPES.includes(x))) fail('account.subscription_required');
        scopes = scopes.filter((x) => !PAID_SCOPES.includes(x));
        this.d.onEvent?.('account.gateway_scope_withheld');
      } else tier = ent;
    }
    const { token, claims } = this.d.tokens.issue({ acc: d!.account_id, dev: d!.device_id, role: d!.role, scp: scopes, cnf: d!.vx, ...(tier ? { tier } : {}) }, now);
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
    await this.db.run('DELETE FROM issue_locks WHERE expires_at <= $1', [now]);
    await this.db.run('DELETE FROM pc_links WHERE expires_at <= $1', [now]);
    // 계정 공유 기록: 끝난·취소된 일과 유효 시간이 지난 일은 30일 뒤 줄과 함께 지운다(발급 기록·거래처 줄은 계정이 있는 동안 둔다)
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
    // 응답 뒤 즉시 시도가 끝나지 못한(플랫폼이 멈춤·메일 실패) 알림을 보낸다
    await this.drainNotices();
    // 갱신일이 된 카드 정기결제 청구(빌링키 PG일 때만)
    await this.trialConversionNotices();
    await this.chargeDue();
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
    // 탈퇴 유예가 끝난 계정: 기기 정지 훅(릴레이 우편함·푸시 토큰) 뒤 계정 행 삭제(나머지 표는 CASCADE). 결제 기록은 PG가 법정 기간 보관한다
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

/** pgCustomerRef 형식(checkout이 만든 값: cus_ + 18바이트 base64url) */
const REF_RE = /^cus_[A-Za-z0-9_-]{24}$/;
/** 빌링키 봉인 aad: 행(참조)에 묶어 다른 구독으로 옮겨 붙이지 못하게 한다 */
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
