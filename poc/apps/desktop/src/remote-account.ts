// 데스크톱 계정 로그인(A-01)·첫 PC 등록·기기 토큰 보관(D08 §4.2, D09 §2.1·§2.2, 팀장 결정 2026-11-06 (가)).
// 흐름: 이메일 → 6자리 코드 → 계정 세션(메모리) → 기기 목록 조회 → (첫 PC) AIK 서명 첫 목록 + POST /v1/aik → 자기 인증서(AIK 서명)
//       → 신원 파일 저장 → 로그아웃(세션 버림). 그 뒤 계정 호출은 기기 범위 토큰(인증서 + DPoP(Vd), 15분, 메모리 캐시)으로만 한다.
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

/** 렌더러가 보는 것(값은 이메일·만료 시각·오류 코드뿐). */
export interface AccountView {
  step: 'unavailable' | 'signed_out' | 'code_sent' | 'working' | 'signed_in';
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
  #pending: { email: string; loginId: string; expiresAt: number } | null = null;
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
    return this.view();
  }

  view(): AccountView {
    if (!this.#o.client) return { step: 'unavailable', email: null, codeExpiresAt: null, error: null, phones: 0 };
    if (this.#id) return { step: 'signed_in', email: this.#id.accountEmail, codeExpiresAt: null, error: null, phones: this.#id.deviceList.entries.filter((e) => e.entry.role === 'mobile').length };
    if (this.#working) return { step: 'working', email: this.#pending?.email ?? null, codeExpiresAt: null, error: null, phones: 0 };
    if (this.#pending && this.#pending.expiresAt > this.#now()) return { step: 'code_sent', email: this.#pending.email, codeExpiresAt: this.#pending.expiresAt, error: this.#error, phones: 0 };
    return { step: 'signed_out', email: this.#pending?.email ?? this.#lastEmail, codeExpiresAt: null, error: this.#pending ? (this.#error ?? 'account.code_expired') : this.#error, phones: 0 };
  }

  get identity(): RemoteIdentity | null {
    return this.#id;
  }

  /** 이메일 → 코드 보내기. 다시 보내기도 이것(서버가 시간당 5회로 막는다). */
  async sendCode(emailRaw: string): Promise<AccountView> {
    const client = this.#need();
    const email = emailRaw.trim();
    this.#error = null;
    if (!isEmailShape(email)) {
      this.#error = 'account.email_shape';
      return this.view();
    }
    await this.#run(async () => {
      const r = await client.startEmailCode(email);
      this.#pending = { email, loginId: r.loginId, expiresAt: this.#now() + r.expiresInSec * 1000 };
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
      try {
        this.#id = await this.#enroll(client, session, p.email);
        this.#log('main.account_enroll', { result: 'ok' });
      } finally {
        await client.logout(session).catch(() => {});
      }
    }, 'main.account_enroll');
    return this.view();
  }

  /** [다른 이메일로] 코드 입력을 버린다. */
  back(): AccountView {
    this.#lastEmail = this.#pending?.email ?? this.#lastEmail;
    this.#pending = null;
    this.#error = null;
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
  #onChange: (id: RemoteIdentity) => void;

  constructor(client: AccountClient, keys: () => Promise<DesktopKeys>, file: RemoteIdentityFile, id: RemoteIdentity, now: () => number, onChange: (id: RemoteIdentity) => void = () => {}) {
    this.#onChange = onChange;
    this.#client = client;
    this.#keys = keys;
    this.#file = file;
    this.#id = id;
    this.#now = now;
    this.#cache = new DeviceTokenCache(async () => this.#client.deviceToken(await this.#cert(), (await this.#keys()).vd), now);
  }

  get deviceList(): DeviceListJson {
    return this.#id.deviceList;
  }

  /** Authorization: DPoP <token> + DPoP 증명(Vd). 401·토큰 만료면 호출자가 clearToken() 뒤 한 번 다시 한다. */
  readonly auth: DeviceAuth = async (htm, htu) => deviceAuthHeaders(await this.#cache.token(), (await this.#keys()).vd, htm, htu, this.#now());

  clearToken(): void {
    this.#cache.clear();
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
