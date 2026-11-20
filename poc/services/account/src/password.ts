import { argon2, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { fail } from '@sax/svc-shared';
import { PASSWORD } from './constants.ts';

/** argon2id 매개변수(ADR-038 (b)). 바꾸면 PARAMS_VERSION을 올린다 */
export const ARGON2ID = { memoryKiB: 65_536, passes: 3, parallelism: 1, saltBytes: 16, tagBytes: 32 } as const;
export const PARAMS_VERSION = 'a2id-v1';
const paramsOf = (kid: string) => `${PARAMS_VERSION}:m${ARGON2ID.memoryKiB}:t${ARGON2ID.passes}:p${ARGON2ID.parallelism}:k${kid}`;
const PARAMS_RE = /^(a2id-v\d+):m(\d+):t(\d+):p(\d+):k([A-Za-z0-9_-]{1,16})$/;

const SERVICE_NAMES = ['sovereignax', 'sovereign', '소버린'];

/** 페퍼 키들. `PASSWORD_PEPPER_KEYS` = `kid:hex64[,kid:hex64…]`, 첫 키가 현재 키(새 해시), 나머지는 회전 중 옛 키(검증만) */
export interface PepperKeys {
  current: string;
  keys: ReadonlyMap<string, Buffer>;
}

export function parsePepperKeys(v: string | undefined): PepperKeys | null {
  if (v === undefined || v === '') return null;
  const keys = new Map<string, Buffer>();
  let current = '';
  for (const part of v.split(',')) {
    const m = /^([A-Za-z0-9_-]{1,16}):([0-9a-f]{64})$/.exec(part.trim());
    if (!m || keys.has(m[1]!)) throw new Error('config_PASSWORD_PEPPER_KEYS');
    keys.set(m[1]!, Buffer.from(m[2]!, 'hex'));
    current ||= m[1]!;
  }
  return { current, keys };
}

/** NFKC 정규화 뒤 코드 포인트 수(ADR-038 (c) 세부) */
export const normPassword = (pw: string): string => pw.normalize('NFKC');
const codePoints = (s: string) => [...s].length;

/** 흔한·유출 비밀번호 목록(로컬 번들, 외부 호출 없음). 한 줄에 하나, 소문자 NFKC로 비교한다 */
export class CommonPasswords {
  private readonly set: ReadonlySet<string>;
  constructor(words: Iterable<string>) {
    this.set = new Set([...words].map((w) => normPassword(w.trim()).toLowerCase()).filter((w) => w.length > 0));
  }
  get size(): number {
    return this.set.size;
  }
  has(pw: string): boolean {
    return this.set.has(normPassword(pw).toLowerCase());
  }
  static fromFile(file: string): CommonPasswords {
    const raw = fs.readFileSync(file);
    const text = (file.endsWith('.gz') ? gunzipSync(raw) : raw).toString('utf8');
    return new CommonPasswords(text.split('\n'));
  }
}

/** 번들 목록 위치(services/account/data). 함수 묶음에도 들어간다(정적 경로) */
export const COMMON_PASSWORDS_FILE = new URL('../data/common-passwords.txt.gz', import.meta.url);

/**
 * 정책 검사(서버가 판정, ADR-038 (c)). 맞지 않으면 코드로 던진다. 구성 규칙(대문자·숫자·특수문자)은 강제하지 않는다(NIST SP 800-63B).
 * 이메일 전체·로컬 부분(3자 이상)과 서비스명을 포함하면 거부한다(대소문자 무시).
 */
export function checkPasswordPolicy(pw: string, email: string, common: CommonPasswords): void {
  const n = normPassword(pw);
  const len = codePoints(n);
  if (len < PASSWORD.minLength) fail('account.password_too_short');
  if (len > PASSWORD.maxLength) fail('account.password_too_long');
  const lower = n.toLowerCase();
  const e = email.trim().toLowerCase();
  const local = e.split('@')[0] ?? '';
  if (lower.includes(e) || (local.length >= 3 && lower.includes(local)) || SERVICE_NAMES.some((s) => lower.includes(s))) fail('account.password_contains_identity');
  if (common.has(n)) fail('account.password_breached');
}

/** 동시 실행 상한 + 대기 줄 상한(넘으면 429). 인스턴스 메모리 = 64MiB × concurrency */
export class HashGate {
  private running = 0;
  private readonly waiting: Array<() => void> = [];
  private readonly concurrency: number;
  private readonly queue: number;
  constructor(concurrency: number, queue: number) {
    this.concurrency = concurrency;
    this.queue = queue;
  }
  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.running >= this.concurrency) {
      if (this.waiting.length >= this.queue) fail('policy.rate_limited', { retryAfterSec: 1 });
      await new Promise<void>((ok) => this.waiting.push(ok));
    } else this.running++;
    try {
      return await fn();
    } finally {
      const next = this.waiting.shift();
      if (next) next();
      else this.running--;
    }
  }
}

export interface StoredHash {
  hash: string;
  salt: string;
  params: string;
}

const b64u = (b: Buffer) => b.toString('base64url');

interface Cost {
  memoryKiB: number;
  passes: number;
  parallelism: number;
}
const CURRENT: Cost = { memoryKiB: ARGON2ID.memoryKiB, passes: ARGON2ID.passes, parallelism: ARGON2ID.parallelism };

function argon2id(message: Buffer, salt: Buffer, c: Cost): Promise<Buffer> {
  return new Promise((ok, no) =>
    argon2('argon2id', { message, nonce: salt, memory: c.memoryKiB, passes: c.passes, parallelism: c.parallelism, tagLength: ARGON2ID.tagBytes }, (e, out) => (e ? no(e) : ok(Buffer.from(out)))),
  );
}

function parseParams(params: string): { cost: Cost; kid: string } | null {
  const m = PARAMS_RE.exec(params);
  if (!m) return null;
  const cost = { memoryKiB: Number(m[2]), passes: Number(m[3]), parallelism: Number(m[4]) };
  if (cost.parallelism < 1 || cost.parallelism > 4 || cost.memoryKiB < 8 * cost.parallelism || cost.memoryKiB > ARGON2ID.memoryKiB * 2 || cost.passes < 1 || cost.passes > 10) return null;
  return { cost, kid: m[5]! };
}

/** argon2id를 이 런타임이 지원하는가(Node 24.7+). 없으면 비밀번호 경로는 닫힌다 */
export const argon2Available = (): boolean => typeof argon2 === 'function';

/** 비밀번호 해시기. 페퍼와 동시 실행 상한을 갖는다. 더미 해시로 없는 계정도 같은 일을 한다(열거 방지) */
export class PasswordHasher {
  private readonly gate = new HashGate(PASSWORD.hashConcurrency, PASSWORD.hashQueue);
  private readonly dummy: StoredHash;
  private readonly peppers: PepperKeys;
  constructor(peppers: PepperKeys) {
    this.peppers = peppers;
    this.dummy = { hash: b64u(randomBytes(ARGON2ID.tagBytes)), salt: b64u(randomBytes(ARGON2ID.saltBytes)), params: paramsOf(peppers.current) };
  }

  private peppered(pw: string, kid: string): Buffer {
    const key = this.peppers.keys.get(kid);
    if (!key) throw new Error('pepper_unknown');
    return createHmac('sha256', key).update(normPassword(pw), 'utf8').digest();
  }

  async hash(pw: string): Promise<StoredHash> {
    const salt = randomBytes(ARGON2ID.saltBytes);
    const out = await this.gate.run(() => argon2id(this.peppered(pw, this.peppers.current), salt, CURRENT));
    return { hash: b64u(out), salt: b64u(salt), params: paramsOf(this.peppers.current) };
  }

  async verify(pw: string, stored: StoredHash | null): Promise<{ ok: boolean; needsRehash: boolean }> {
    const parsed = stored ? parseParams(stored.params) : null;
    const rec = stored && parsed && this.peppers.keys.has(parsed.kid) ? stored : null;
    const use = rec ?? this.dummy;
    const p = rec ? parsed! : parseParams(this.dummy.params)!;
    const want = Buffer.from(use.hash, 'base64url');
    const out = await this.gate.run(() => argon2id(this.peppered(pw, p.kid), Buffer.from(use.salt, 'base64url'), p.cost));
    const ok = !!rec && want.length === out.length && timingSafeEqual(want, out);
    return { ok, needsRehash: ok && rec!.params !== paramsOf(this.peppers.current) };
  }
}

/** 응답 시각 하한(열거 방지): fn이 빨리 끝나도 start + floorMs까지 기다린다. 예외도 같은 시각에 다시 던진다 */
export async function withFloor<T>(floorMs: number, fn: () => Promise<T>, sleep: (ms: number) => Promise<void> = (ms) => new Promise((ok) => setTimeout(ok, ms))): Promise<T> {
  const start = performance.now();
  let out: { ok: true; v: T } | { ok: false; e: unknown };
  try {
    out = { ok: true, v: await fn() };
  } catch (e) {
    out = { ok: false, e };
  }
  const left = floorMs - (performance.now() - start);
  if (left > 0) await sleep(left);
  if (!out.ok) throw out.e;
  return out.v;
}
