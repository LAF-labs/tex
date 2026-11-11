// 데스크톱 계정 로그인(A-01)·첫 PC 등록·기기 토큰 보관(D08 §4.2, D09 §2.1·§2.2, 팀장 결정 2026-11-06 (가)).
// 흐름: 이메일 → 비밀번호(ADR-038) 또는 6자리 코드 → 계정 세션(메모리) → 기기 목록 조회 → (첫 PC) AIK 서명 첫 목록 + POST /v1/aik → 자기 인증서(AIK 서명)
//       → 신원 파일 저장 → 로그아웃(세션 버림). 그 뒤 계정 호출은 기기 범위 토큰(인증서 + DPoP(Vd), 15분, 메모리 캐시)으로만 한다.
//   계정 만들기(코드)로 들어왔고 비밀번호가 없으면(GET /v1/me hasPassword) 등록 뒤 비밀번호 만들기 단계(set_password)를 둔다.
//   그 단계 동안만 세션을 메모리에 둔다(방금 인증한 세션이라 PUT /v1/password를 바로 부른다, 10분 안). 만들거나 [나중에]면 로그아웃.
// - 비밀번호 찾기(인계 명세 §4): 이메일 → 재설정 코드(계정이 없어도 같은 응답) → 코드 6자리(서버 검증 없음) + 새 비밀번호 → 재설정·로그인
//   (서버가 다른 세션·갱신 토큰을 모두 폐기) → 첫 PC 등록 → 로그아웃. resetId는 이 객체 안 메모리에만 있다.
// - 계정 세션·기기 토큰·loginId는 이 객체 안 메모리에만 있다. 렌더러에는 단계·이메일·만료 시각·오류 코드만 간다.
// - 신원 파일(remote-identity.json)에는 비밀이 없다(deviceId·공개키·AIK 서명 인증서·목록·계정 이메일). 키 연산은 금고(DesktopKeys)가 한다.
// - 두 번째 PC(A-03, 계정에 다른 AIK가 이미 있음)는 이 범위 밖이다: account.aik_already_pinned로 끝낸다.
//   같은 금고(AIK·Sd·Vd가 같음)를 다시 설치한 경우는 서버 목록에서 이 PC 항목을 찾아 신원을 되살린다.
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  b64,
  certNotAfter,
  DeviceTokenCache,
  deviceAuthHeaders,
  fromB64,
  initialDeviceList,
  isEmailShape,
  issueCert,
  jcsBytes,
  verifyAcctClaim,
  verifyCert,
  verifyDeviceList,
  type DesktopKeys,
  type DeviceListJson,
  type SignedCert,
} from '@sax/remote';
import type { AccountClient, DeviceAuth } from './remote-ports.ts';

/** 엔진에 가는 기기 토큰의 범위(gateway-auth.ts). 게이트웨이는 이 범위만 본다. */
export const GATEWAY_SCOPES: readonly string[] = Object.freeze(['gateway']);

/** 인증서를 새로 서명하는 때(만료 14일 전). 서버는 not_after ≤ 지금 + 91일만 받는다. */
export const CERT_RENEW_MS = 14 * 86_400_000;
const FILE_VERSION = 1;

export interface RemoteIdentity {
  v: 1;
  accountEmail: string;
  deviceId: string;
  /** 공개키(base64 32B). 금고 키가 바뀌면(다른 금고) 신원을 쓰지 않는다. */
  aikPub: string;
  Sd: string;
  Vd: string;
  cert: SignedCert;
  deviceList: DeviceListJson;
  enrolledAt: number;
}

const UUID4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const key32 = (s: unknown) => {
  try {
    return typeof s === 'string' && fromB64(s).length === 32;
  } catch {
    return false;
  }
};

/** 파일 모양 검사 + AIK로 인증서·목록 서명 검사. 틀리면 null. */
export function checkIdentity(v: unknown, now = Date.now()): RemoteIdentity | null {
  const i = v as Partial<RemoteIdentity> | null;
  if (!i || typeof i !== 'object' || i.v !== FILE_VERSION) return null;
  if (typeof i.accountEmail !== 'string' || !isEmailShape(i.accountEmail) || typeof i.deviceId !== 'string' || !UUID4.test(i.deviceId)) return null;
  if (!key32(i.aikPub) || !key32(i.Sd) || !key32(i.Vd) || !Number.isSafeInteger(i.enrolledAt) || !i.cert || !i.deviceList) return null;
  const aik = fromB64(i.aikPub!);
  // 만료된 인증서도 신원은 맞다(새로 서명한다). 서명·필드만 본다: 검사 시각을 not_after 직전으로 둔다.
  const c = verifyCert(i.cert, aik, Math.min(now, i.cert.cert?.not_after - 1));
  if (!c || c.device_id !== i.deviceId || c.role !== 'desktop' || b64(c.Sx) !== i.Sd || b64(c.Vx) !== i.Vd) return null;
  const l = verifyDeviceList(i.deviceList, aik);
  if (!l.ok || !l.devices.some((d) => d.deviceId === i.deviceId && d.role === 'desktop')) return null;
  return i as RemoteIdentity;
}

/** userData/remote-identity.json. 임시 파일 + 이름 바꾸기, 사용자만 읽기·쓰기. */
export class RemoteIdentityFile {
  readonly file: string;
  constructor(dir: string) {
    this.file = path.join(dir, 'remote-identity.json');
  }
  async load(now = Date.now()): Promise<RemoteIdentity | null> {
    let raw: string;
    try {
      raw = await fs.readFile(this.file, 'utf8');
    } catch {
      return null;
    }
    try {
      return checkIdentity(JSON.parse(raw), now);
    } catch {
      return null;
    }
  }
  async save(i: RemoteIdentity): Promise<void> {
    const tmp = `${this.file}.${process.pid}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(i), { mode: 0o600 });
    await fs.rename(tmp, this.file);
  }
  async clear(): Promise<void> {
    await fs.rm(this.file, { force: true });
  }
}

/** 받은 로그인 코드의 대기 정보(코드 자체는 없다). 이것만으로는 로그인할 수 없다(메일의 6자리가 있어야 한다). */
export interface PendingCode {
  email: string;
  loginId: string;
  expiresAt: number;
  signup: boolean;
}

/**
 * userData/remote-pending-code.json: 앱을 껐다 켜도 만료(10분) 전이면 같은 코드로 로그인한다(0.1.5 실사용, 부장 지시 2026-11-10).
 * 코드 확인 성공·[뒤로]·다른 로그인·만료에 지운다. 임시 파일 + 이름 바꾸기, 사용자만 읽기·쓰기. 모양이 다르거나 만료면 버린다.
 */
export class PendingCodeFile {
  readonly file: string;
  constructor(dir: string) {
    this.file = path.join(dir, 'remote-pending-code.json');
  }
  async load(now = Date.now()): Promise<PendingCode | null> {
    let v: unknown;
    try {
      v = JSON.parse(await fs.readFile(this.file, 'utf8'));
    } catch {
      return null;
    }
    const o = v as Record<string, unknown> | null;
    const ok =
      !!o &&
      typeof o === 'object' &&
      typeof o.email === 'string' &&
      isEmailShape(o.email) &&
      typeof o.loginId === 'string' &&
      o.loginId.length > 0 &&
      o.loginId.length <= 200 &&
      typeof o.expiresAt === 'number' &&
      Number.isFinite(o.expiresAt) &&
      typeof o.signup === 'boolean';
    if (!ok || (o.expiresAt as number) <= now || (o.expiresAt as number) > now + 60 * 60 * 1000) {
      await this.clear().catch(() => {});
      return null;
    }
    return { email: o.email as string, loginId: o.loginId as string, expiresAt: o.expiresAt as number, signup: o.signup as boolean };
  }
  async save(p: PendingCode): Promise<void> {
    const tmp = `${this.file}.${process.pid}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(p), { mode: 0o600 });
    await fs.rename(tmp, this.file);
  }
  async clear(): Promise<void> {
    await fs.rm(this.file, { force: true });
  }
}

/** 렌더러가 보는 것(값은 이메일·만료 시각·오류 코드뿐). */
export interface AccountView {
  step: 'unavailable' | 'signed_out' | 'code_sent' | 'reset_code' | 'working' | 'set_password' | 'signed_in';
  email: string | null;
  codeExpiresAt: number | null;
  error: string | null;
  /** 이 계정에 연결된 폰 수(AIK 서명 기기 목록의 mobile 항목). 로그인 전이면 0. */
  phones: number;
}

export interface DesktopAccountOptions {
  /** 없으면 이 빌드에서는 계정에 닿을 수 없다(unavailable). */
  client: AccountClient | null;
  keys: () => Promise<DesktopKeys>;
  identity: RemoteIdentityFile;
  /** 받은 코드의 대기 정보 저장(없으면 메모리에만, 재시작하면 사라진다). */
  pending?: PendingCodeFile;
  platform: 'windows' | 'macos';
  /** 계정 기기 목록에 보이는 이름(40자). 사람 이름이 들어가지 않게 진입점이 고른다. */
  deviceName: string;
  now?: () => number;
  log?: (name: string, data: Record<string, string | number>) => void;
}

const codeOf = (e: unknown): string => {
  const c = (e as { code?: unknown } | null)?.code;
  return typeof c === 'string' && /^[a-z_]+\.[a-z_]+$/.test(c) ? c : 'account.failed';
};

export class DesktopAccount {
  #o: DesktopAccountOptions;
  #now: () => number;
  #log: NonNullable<DesktopAccountOptions['log']>;
  #id: RemoteIdentity | null = null;
  #pendingCode: PendingCode | null = null;
  #pendingWrite: Promise<void> = Promise.resolve();
  /** 받은 코드(대기 정보). 바꿀 때마다 파일에도 순서대로 쓴다(지우기 포함). */
  get #pending(): PendingCode | null {
    return this.#pendingCode;
  }
  set #pending(p: PendingCode | null) {
    this.#pendingCode = p;
    const f = this.#o.pending;
    if (f) this.#pendingWrite = this.#pendingWrite.then(() => (p ? f.save(p) : f.clear())).catch(() => {});
  }
  /** 비밀번호 찾기(재설정 코드를 보냄). 코드가 틀리면 남는다(서버가 5회째에 막는다). */
  #reset: { email: string; resetId: string; expiresAt: number } | null = null;
  /** 계정 만들기 뒤 비밀번호 만들기 단계(ADR-038 (a) 선택). 세션은 이 단계 동안만 메모리에 있다. */
  #offer: { session: string; email: string } | null = null;
  /** 이메일 칸을 다시 채우는 값(코드를 쓴 뒤 등록이 실패했을 때). */
  #lastEmail: string | null = null;
  #working = false;
  #error: string | null = null;
  #device: DeviceSession | null = null;

  constructor(o: DesktopAccountOptions) {
    this.#o = o;
    this.#now = o.now ?? Date.now;
    this.#log = o.log ?? (() => {});
  }

  /** 앱 시작: 신원 파일을 읽고 금고 키와 맞춰 본다(다른 금고면 쓰지 않는다). */
  async init(): Promise<AccountView> {
    const id = await this.#o.identity.load(this.#now());
    if (id) {
      try {
        const k = await this.#o.keys();
        if (b64(k.aik.publicKey) === id.aikPub && b64(k.noise.publicKey) === id.Sd && b64(k.vd.publicKey) === id.Vd) this.#id = id;
        else this.#log('main.account_identity', { result: 'key_mismatch' });
      } catch (e) {
        this.#log('main.account_identity', { result: codeOf(e) });
      }
    }
    // 지난 실행에 받은 코드가 아직 살아 있으면 코드 화면으로 돌아온다(로그인돼 있으면 버린다)
    const f = this.#o.pending;
    if (f) {
      const p = await f.load(this.#now());
      if (p && !this.#id) {
        this.#pendingCode = p;
        this.#log('main.account_code', { result: 'resumed' });
      } else if (p) this.#pending = null;
    }
    return this.view();
  }

  view(): AccountView {
    if (!this.#o.client) return { step: 'unavailable', email: null, codeExpiresAt: null, error: null, phones: 0 };
    if (this.#offer) return { step: 'set_password', email: this.#offer.email, codeExpiresAt: null, error: this.#error, phones: 0 };
    // 로그인 상태의 오류는 비밀번호 단계를 끝낸 이유(account.password_later)뿐이다
    if (this.#id) return { step: 'signed_in', email: this.#id.accountEmail, codeExpiresAt: null, error: this.#error === 'account.password_later' ? this.#error : null, phones: this.#id.deviceList.entries.filter((e) => e.entry.role === 'mobile').length };
    if (this.#working) return { step: 'working', email: this.#pending?.email ?? null, codeExpiresAt: null, error: null, phones: 0 };
    if (this.#reset) {
      if (this.#reset.expiresAt > this.#now()) return { step: 'reset_code', email: this.#reset.email, codeExpiresAt: this.#reset.expiresAt, error: this.#error, phones: 0 };
      return { step: 'signed_out', email: this.#reset.email, codeExpiresAt: null, error: 'account.code_expired', phones: 0 };
    }
    if (this.#pending && this.#pending.expiresAt > this.#now()) return { step: 'code_sent', email: this.#pending.email, codeExpiresAt: this.#pending.expiresAt, error: this.#error, phones: 0 };
    return { step: 'signed_out', email: this.#pending?.email ?? this.#lastEmail, codeExpiresAt: null, error: this.#pending ? (this.#error ?? 'account.code_expired') : this.#error, phones: 0 };
  }

  get identity(): RemoteIdentity | null {
    return this.#id;
  }

  /**
   * 이메일 → 코드 보내기. 다시 보내기도 이것(서버가 시간당 5회로 막는다).
   * signup이면 계정 만들기 화면에서 왔다: 코드 확인·등록 뒤 비밀번호가 없으면 만들기 단계를 둔다. 서버 호출은 같다(첫 검증 때 계정 생성).
   */
  async sendCode(emailRaw: string, signup = false): Promise<AccountView> {
    const client = this.#need();
    const email = emailRaw.trim();
    this.#error = null;
    if (!isEmailShape(email)) {
      this.#error = 'account.email_shape';
      return this.view();
    }
    await this.#run(async () => {
      const r = await client.startEmailCode(email);
      this.#pending = { email, loginId: r.loginId, expiresAt: this.#now() + r.expiresInSec * 1000, signup };
      this.#log('main.account_code', { result: 'sent' });
    }, 'main.account_code');
    return this.view();
  }

  /** 6자리 → 세션 → 첫 PC 등록. 세션은 이 함수 안에서만 쓰고 버린다. */
  async verify(code: string): Promise<AccountView> {
    const client = this.#need();
    const p = this.#pending;
    this.#error = null;
    if (!p || p.expiresAt <= this.#now()) {
      this.#error = 'account.code_expired';
      return this.view();
    }
    if (!/^\d{6}$/.test(code)) {
      this.#error = 'account.code_shape';
      return this.view();
    }
    await this.#run(async () => {
      const { session } = await client.verifyEmailCode(p.loginId, code);
      // 코드는 한 번 쓰면 끝이다. 등록이 실패해도 코드 입력으로 돌아가지 않고 이메일부터 다시 한다.
      this.#pending = null;
      this.#lastEmail = p.email;
      let keep = false;
      try {
        this.#id = await this.#enroll(client, session, p.email);
        this.#log('main.account_enroll', { result: 'ok' });
        // 이미 비밀번호가 있으면 건너뛴다(인계 명세 §3). /v1/me가 실패하면 묻지 않는다(설정 > 계정에서 만든다).
        if (p.signup) keep = (await client.me(session).then((m) => m.hasPassword === false).catch(() => false));
        if (keep) this.#offer = { session, email: p.email };
      } finally {
        if (!keep) await client.logout(session).catch(() => {});
      }
    }, 'main.account_enroll');
    return this.view();
  }

  /**
   * 이메일 + 비밀번호 → 세션 → 첫 PC 등록(ADR-038 (a)). verify와 같이 세션은 이 함수 안에서만 쓰고 버린다.
   * 비밀번호는 계정 서비스 호출 본문으로만 넘기고 어디에도 남기지 않는다. 기록은 결과 코드뿐이다.
   * 틀림·없는 계정·잠금은 서버가 같은 응답(account.credentials_invalid)을 준다. 화면은 셋을 가르지 않는다.
   */
  async passwordLogin(emailRaw: string, password: string): Promise<AccountView> {
    const client = this.#need();
    const email = emailRaw.trim();
    this.#error = null;
    if (!isEmailShape(email)) {
      this.#error = 'account.email_shape';
      return this.view();
    }
    if (!password) {
      this.#error = 'account.password_empty';
      return this.view();
    }
    this.#pending = null;
    this.#lastEmail = email;
    await this.#run(async () => {
      const { session } = await client.passwordLogin(email, password);
      try {
        this.#id = await this.#enroll(client, session, email);
        this.#log('main.account_enroll', { result: 'ok' });
      } finally {
        await client.logout(session).catch(() => {});
      }
    }, 'main.account_password');
    return this.view();
  }

  /**
   * 계정 만들기 비밀번호 단계: PUT /v1/password(만들기, 204). 비밀번호는 이 호출 본문으로만 나가고 어디에도 남기지 않는다.
   * 정책 거부(account.password_*)·요청이 많음은 이 단계에 남아 문구를 보인다. 세션이 쓸 수 없게 됐으면(재인증 필요·만료) 단계를 끝내고
   * account.password_later를 남긴다(설정 > 계정에서 만든다). 성공하면 세션을 로그아웃하고 버린다.
   */
  async setPassword(password: string): Promise<AccountView> {
    const client = this.#o.client;
    const o = this.#offer;
    if (!client || !o) throw new Error('account_no_offer');
    if (this.#working) throw new Error('busy');
    this.#error = null;
    if (!password) {
      this.#error = 'account.password_empty';
      return this.view();
    }
    this.#working = true;
    try {
      await client.setPassword(o.session, password);
      this.#log('main.account_password_set', { result: 'ok' });
      await this.#endOffer();
    } catch (e) {
      const code = codeOf(e);
      this.#log('main.account_password_set', { result: code });
      // 서버에 비밀번호 기능이 꺼져 있어도(request.not_found) 이 단계는 끝낸다.
      if (code === 'account.reauth_required' || code === 'account.unauthorized' || code === 'request.not_found') {
        await this.#endOffer();
        this.#error = 'account.password_later';
      } else this.#error = code;
    } finally {
      this.#working = false;
    }
    return this.view();
  }

  /** 비밀번호 단계 [나중에]: 세션을 로그아웃하고 버린다. */
  async skipPassword(): Promise<AccountView> {
    if (this.#working) throw new Error('busy');
    if (this.#offer) {
      this.#log('main.account_password_set', { result: 'later' });
      await this.#endOffer();
    }
    this.#error = null;
    return this.view();
  }

  async #endOffer(): Promise<void> {
    const o = this.#offer;
    this.#offer = null;
    if (o) await this.#o.client?.logout(o.session).catch(() => {});
  }

  /**
   * [비밀번호 찾기] → 재설정 코드 보내기(POST /v1/auth/password/reset). 계정이 없어도 같은 응답이라 늘 코드 단계로 간다(열거 방지).
   * 다시 받기도 이것이다(새 resetId).
   */
  async startReset(emailRaw: string): Promise<AccountView> {
    const client = this.#need();
    const email = emailRaw.trim();
    this.#error = null;
    if (!isEmailShape(email)) {
      this.#error = 'account.email_shape';
      return this.view();
    }
    this.#pending = null;
    this.#lastEmail = email;
    await this.#run(async () => {
      const r = await client.startPasswordReset(email);
      this.#reset = { email, resetId: r.resetId, expiresAt: this.#now() + r.expiresInSec * 1000 };
      this.#log('main.account_reset', { result: 'sent' });
    }, 'main.account_reset');
    return this.view();
  }

  /**
   * 코드 6자리 + 새 비밀번호 → POST /v1/auth/password/reset/verify(서버는 이때만 코드를 본다, 명세 §8 G6) → 받은 세션으로 첫 PC 등록 → 로그아웃.
   * 코드 오류(code_invalid·code_locked)·정책 거부는 재설정 단계에 남는다(렌더러가 코드 칸 / 새 비밀번호 칸으로 돌린다). 비밀번호는 남기지 않는다.
   */
  async finishReset(code: string, password: string): Promise<AccountView> {
    const client = this.#need();
    const r = this.#reset;
    this.#error = null;
    if (!r || r.expiresAt <= this.#now()) {
      this.#error = 'account.code_expired';
      return this.view();
    }
    if (!/^\d{6}$/.test(code)) {
      this.#error = 'account.code_shape';
      return this.view();
    }
    if (!password) {
      this.#error = 'account.password_empty';
      return this.view();
    }
    await this.#run(async () => {
      const { session } = await client.verifyPasswordReset(r.resetId, code, password);
      this.#reset = null;
      this.#log('main.account_reset', { result: 'ok' });
      try {
        this.#id = await this.#enroll(client, session, r.email);
        this.#log('main.account_enroll', { result: 'ok' });
      } finally {
        await client.logout(session).catch(() => {});
      }
    }, 'main.account_reset');
    return this.view();
  }

  /** [다른 이메일로] 코드 입력을 버린다(재설정 코드도). */
  back(): AccountView {
    this.#lastEmail = this.#pending?.email ?? this.#reset?.email ?? this.#lastEmail;
    this.#pending = null;
    this.#reset = null;
    this.#error = null;
    return this.view();
  }

  /**
   * 이 PC에서 로그아웃(설정 > 계정 [로그아웃]): 신원 파일·받아 둔 코드·기기 토큰(메모리)·비밀번호 만들기 세션을 지운다.
   * 계정의 기기 등록은 그대로 둔다(같은 금고로 다시 로그인하면 이 PC를 되살린다, #enroll). 이메일 칸은 다시 채운다.
   */
  async signOut(): Promise<AccountView> {
    if (this.#working) throw new Error('busy');
    const email = this.#id?.accountEmail ?? this.#offer?.email ?? null;
    const offer = this.#offer;
    this.#device?.clearToken();
    this.#device?.clearGatewayToken();
    this.#device = null;
    this.#id = null;
    this.#offer = null;
    this.#reset = null;
    this.#error = null;
    this.#pending = null;
    if (email) this.#lastEmail = email;
    if (offer) await this.#o.client?.logout(offer.session).catch(() => {});
    await this.#pendingWrite;
    await this.#o.identity.clear();
    this.#log('main.account_signout', { result: 'ok' });
    return this.view();
  }

  /** 기기 범위 호출(토큰·DPoP). 등록 전이면 null. */
  device(): DeviceSession | null {
    if (!this.#id || !this.#o.client) return null;
    if (!this.#device) this.#device = new DeviceSession(this.#o.client, this.#o.keys, this.#o.identity, this.#id, this.#now, (id) => (this.#id = id));
    return this.#device;
  }

  #need(): AccountClient {
    if (!this.#o.client) throw new Error('account_unavailable');
    if (this.#id) throw new Error('account_signed_in');
    if (this.#working) throw new Error('busy');
    return this.#o.client;
  }

  async #run(f: () => Promise<void>, logName: string): Promise<void> {
    this.#working = true;
    try {
      await f();
    } catch (e) {
      this.#error = codeOf(e);
      this.#log(logName, { result: this.#error });
    } finally {
      this.#working = false;
    }
  }

  async #enroll(client: AccountClient, session: string, email: string): Promise<RemoteIdentity> {
    const k = await this.#o.keys();
    const now = this.#now();
    const aikPub = b64(k.aik.publicKey);
    const Sd = b64(k.noise.publicKey);
    const Vd = b64(k.vd.publicKey);
    const cur = await client.deviceList(session);
    let deviceId: string;
    let list: DeviceListJson;
    if (cur.aikPub) {
      // 이미 고정된 계정: 같은 금고로 다시 설치한 이 PC만 되살린다.
      const mine = cur.aikPub === aikPub && cur.deviceList ? cur.deviceList.entries.find((e) => e.entry.role === 'desktop' && e.entry.Sx === Sd && e.entry.Vx === Vd) : undefined;
      if (!mine || !cur.deviceList || !verifyDeviceList(cur.deviceList, k.aik.publicKey).ok) throw Object.assign(new Error('pinned'), { code: 'account.aik_already_pinned' });
      deviceId = mine.entry.device_id;
      list = cur.deviceList;
    } else {
      deviceId = randomUUID();
      list = await initialDeviceList(k.aik, { deviceId, role: 'desktop', noisePub: k.noise.publicKey, signPub: k.vd.publicKey, registeredAt: now });
      const r = await client.pinFirstDesktop(session, { aikPub, deviceList: list, platform: this.#o.platform, name: this.#o.deviceName.slice(0, 40) });
      if (r.deviceId !== deviceId) throw Object.assign(new Error('device'), { code: 'account.bad_response' });
    }
    const cert = await issueCert(k.aik, { device_id: deviceId, role: 'desktop', Sx: k.noise.publicKey, Vx: k.vd.publicKey, not_after: certNotAfter(now) });
    const id: RemoteIdentity = { v: 1, accountEmail: email, deviceId, aikPub, Sd, Vd, cert, deviceList: list, enrolledAt: now };
    await this.#o.identity.save(id);
    return id;
  }
}

/**
 * 기기 범위 호출. 토큰은 DeviceTokenCache(메모리, 만료 1분 전 갱신). 인증서는 만료 14일 전에 AIK로 새로 서명해 파일에 둔다.
 * 기기 목록이 바뀌면(페어링) setDeviceList로 파일까지 갱신한다.
 */
export class DeviceSession {
  #client: AccountClient;
  #keys: () => Promise<DesktopKeys>;
  #file: RemoteIdentityFile;
  #id: RemoteIdentity;
  #now: () => number;
  #cache: DeviceTokenCache;
  /** 게이트웨이 전용 범위 토큰(엔진 auth 포트용, gateway-auth.ts). 전체 범위 토큰과 따로 두고 따로 지운다. */
  #gwCache: DeviceTokenCache;
  #gwInflight: Promise<string> | null = null;
  #onChange: (id: RemoteIdentity) => void;

  constructor(client: AccountClient, keys: () => Promise<DesktopKeys>, file: RemoteIdentityFile, id: RemoteIdentity, now: () => number, onChange: (id: RemoteIdentity) => void = () => {}) {
    this.#onChange = onChange;
    this.#client = client;
    this.#keys = keys;
    this.#file = file;
    this.#id = id;
    this.#now = now;
    this.#cache = new DeviceTokenCache(async () => this.#client.deviceToken(await this.#cert(), (await this.#keys()).vd), now);
    this.#gwCache = new DeviceTokenCache(async () => {
      const t = await this.#client.deviceToken(await this.#cert(), (await this.#keys()).vd, GATEWAY_SCOPES);
      // 엔진이 받는 Authorization에는 토큰 원문이 든다. 서버가 범위를 줄이지 않았으면(구 서버 등) 그 토큰을 쓰지 않는다.
      if (t.scopes.length !== GATEWAY_SCOPES.length || t.scopes.some((s, i) => s !== GATEWAY_SCOPES[i])) throw Object.assign(new Error('scope'), { code: 'account.scope_unavailable' });
      return t;
    }, now);
  }

  get deviceList(): DeviceListJson {
    return this.#id.deviceList;
  }

  /** Authorization: DPoP <token> + DPoP 증명(Vd). 401·토큰 만료면 호출자가 clearToken() 뒤 한 번 다시 한다. */
  readonly auth: DeviceAuth = async (htm, htu) => deviceAuthHeaders(await this.#cache.token(), (await this.#keys()).vd, htm, htu, this.#now());

  clearToken(): void {
    this.#cache.clear();
  }

  /**
   * 게이트웨이 요청 헤더(엔진 auth 포트 전용). 토큰은 scopes ['gateway']만인 것을 따로 받는다.
   * 동시에 여럿 와도 토큰은 한 번만 받는다(기기당 시간 한도 60).
   */
  async gatewayAuth(htm: 'POST', htu: string): Promise<Record<string, string>> {
    const p = (this.#gwInflight ??= this.#gwCache.token().finally(() => (this.#gwInflight = null)));
    return deviceAuthHeaders(await p, (await this.#keys()).vd, htm, htu, this.#now());
  }

  /** 게이트웨이 전용 토큰만 버린다(엔진이 401을 받았을 때). 전체 범위 토큰은 그대로다. */
  clearGatewayToken(): void {
    this.#gwCache.clear();
  }

  /** pair.ok acctClaim 필드(b64 JCS({claim, sig})). 받은 주장이 이 계정·이 AIK 것인지 먼저 본다(서명은 폰이 고정 키로 본다). */
  async acctClaimField(): Promise<string> {
    const sc = await this.#client.acctClaim(this.auth);
    if (!sc || typeof sc !== 'object' || sc.claim?.aik_pub !== this.#id.aikPub) throw Object.assign(new Error('claim'), { code: 'account.bad_response' });
    const field = b64(jcsBytes(sc));
    // 모양은 폰과 같은 함수로 본다. 계정 서비스 키를 넘기지 않으니 모양이 맞으면 'signature'로 끝난다(서명은 폰이 고정 키로 본다).
    const shape = verifyAcctClaim(field, { accountKeys: [], aikPub: fromB64(this.#id.aikPub), now: this.#now() });
    if (!shape.ok && shape.reason === 'shape') throw Object.assign(new Error('claim'), { code: 'account.bad_response' });
    return field;
  }

  /** 페어링 7단계 뒤: 새 목록을 파일에. */
  async setDeviceList(list: DeviceListJson): Promise<void> {
    this.#id = { ...this.#id, deviceList: list };
    await this.#file.save(this.#id);
    this.#onChange(this.#id);
  }

  async #cert(): Promise<SignedCert> {
    const now = this.#now();
    if (this.#id.cert.cert.not_after - CERT_RENEW_MS > now) return this.#id.cert;
    const k = await this.#keys();
    const cert = await issueCert(k.aik, { device_id: this.#id.deviceId, role: 'desktop', Sx: k.noise.publicKey, Vx: k.vd.publicKey, not_after: certNotAfter(now) });
    this.#id = { ...this.#id, cert };
    await this.#file.save(this.#id);
    this.#onChange(this.#id);
    return cert;
  }
}
