// 계좌 자동조회(CODEF 공동인증서 방식, 대표 결정 2026-11-12) 로그인 봉인. 엔진은 평문 비밀번호·인증서 경로를 보지 않는다.
//   1. 엔진 codef.seal{certId, publicKey, scope, mode} → 금고가 기억해 둔 비밀번호(사장님이 고른 때만)를 쓰거나,
//      main에 secret.needed{mode:'codef', reqId, scope}를 보내 금고 직결 비밀번호 창을 열게 한다.
//   2. 창이 secret.provide{bytes, remember?}를 한 번 보낸다(결속 reqId가 맞을 때만).
//   3. 금고가 고른 인증서 하나의 signCert.der·signPri.key를 읽고(npki-scan readNpkiLoginPair), 비밀번호를 CODEF 공개키로
//      RSA(PKCS#1 v1.5) 암호화해 base64 세 칸을 엔진에 준다. 평문 비밀번호 바이트는 바로 0으로 덮는다.
//   개인키 파일(signPri.key)은 인증서 비밀번호로 암호화된 파일이고, 감싼 비밀번호는 CODEF 개인키로만 풀린다. 이 묶음이 CODEF로 간다는 것은
//   동의 화면에 그대로 적는다(사용자 선택 예외, 09-bank-matching §4.5).
import { constants as cc, createHash, createPublicKey, publicEncrypt, randomBytes, type KeyObject } from 'node:crypto';
import type { EventLog } from '@sax/platform';
import { CODEF_SEAL_TTL_MS, isProfileScope, type CodefSealParams, type CodefSealResult, type ProfileScope } from './protocol.ts';
import type { CodefPasswordStore } from './keychain/codef.ts';
import { CODEF_PASSWORD_MAX_BYTES } from './keychain/codef.ts';
import type { NpkiPairRead } from './npki-scan.ts';

const CERT_ID_RE = /^[0-9a-f]{16}$/;
const B64 = /^[A-Za-z0-9+/]+={0,2}$/;

interface Pending {
  reqId: string;
  scope: ProfileScope;
  field: 'cert' | 'account';
  done: (v: { bytes: Uint8Array; remember: boolean } | 'cancelled' | 'timeout') => void;
  timer: ReturnType<typeof setTimeout>;
}

export interface CodefSealerOptions {
  log: EventLog;
  store: CodefPasswordStore;
  readPair: (certId: string) => Promise<NpkiPairRead>;
  /** main에 비밀번호 창을 열라고 알린다(secret.needed). */
  askWindow: (data: { mode: 'codef'; reqId: string; scope: ProfileScope; field?: 'account' }) => void;
  ttlMs?: number;
}

/** CODEF 공개키(base64 DER SPKI 또는 PEM) → RSA 키. 아니면 null */
export function codefPublicKey(raw: unknown): KeyObject | null {
  if (typeof raw !== 'string' || raw.length > 4096) return null;
  try {
    const pem = raw.includes('-----BEGIN');
    const b64 = raw.replace(/\s+/g, '');
    if (!pem && !B64.test(b64)) return null;
    const k = pem ? createPublicKey(raw) : createPublicKey({ key: Buffer.from(b64, 'base64'), format: 'der', type: 'spki' });
    return k.asymmetricKeyType === 'rsa' ? k : null;
  } catch {
    return null;
  }
}

export class CodefSealer {
  private readonly o: CodefSealerOptions;
  /** 한 번에 하나만(창 둘이 겹치지 않게) */
  private pending: Pending | null = null;

  constructor(o: CodefSealerOptions) {
    this.o = o;
  }

  /** 창 결속 확인: 지금 기다리는 요청과 reqId·scope가 같은가 */
  hasPending(reqId: string, scope: ProfileScope): boolean {
    return this.pending !== null && this.pending.reqId === reqId && this.pending.scope === scope;
  }

  /** 창이 보낸 값. 결속이 틀리면 던지고 값은 지운다. 받은 바이트의 주인은 이제 sealer다(쓰고 지운다). */
  provide(reqId: string, bytes: Uint8Array, remember: boolean): void {
    const p = this.pending;
    if (!p || p.reqId !== reqId) {
      bytes.fill(0);
      throw new Error('not_requested');
    }
    if (bytes.length === 0 || bytes.length > CODEF_PASSWORD_MAX_BYTES || (p.field === 'account' && !/^\d{4}$/.test(Buffer.from(bytes).toString('latin1')))) {
      bytes.fill(0);
      throw new Error('bad_length');
    }
    this.finish(p, { bytes, remember });
  }

  /** 엔진 [취소]·창 닫힘. reqId가 있으면 그 요청만 */
  cancel(reqId?: string): void {
    const p = this.pending;
    if (p && (reqId === undefined || p.reqId === reqId)) this.finish(p, 'cancelled');
  }

  private finish(p: Pending, v: { bytes: Uint8Array; remember: boolean } | 'cancelled' | 'timeout'): void {
    clearTimeout(p.timer);
    if (this.pending === p) this.pending = null;
    p.done(v);
  }

  async seal(params: CodefSealParams): Promise<CodefSealResult> {
    const { certId, scope, mode } = params;
    if (typeof certId !== 'string' || !CERT_ID_RE.test(certId) || !isProfileScope(scope) || !['ask', 'stored', 'auto'].includes(mode)) throw new Error('bad_params');
    const key = codefPublicKey(params.publicKey);
    if (!key) return this.refuse('bad_public_key');
    if (params.field === 'account') return this.sealAccount(certId, scope, mode, key);
    // 인증서를 먼저 확인한다(없는 인증서에 비밀번호를 묻지 않는다). 읽은 바이트는 끝에 지운다.
    const pair = await this.o.readPair(certId);
    if (!pair.ok) return this.refuse(pair.reason === 'not_found' || pair.reason === 'no_key' ? pair.reason : 'unreadable');
    let pw: Uint8Array | null = null;
    let remembered = false;
    try {
      if (mode !== 'ask') {
        const r = await this.o.store.read(scope, certId);
        if (r.ok) {
          pw = r.bytes;
          remembered = true;
        } else if (mode === 'stored') return this.refuse(r.reason === 'vault_locked' ? 'vault_locked' : 'missing');
      }
      if (!pw) {
        if (this.pending) return this.refuse('busy');
        const got = await this.ask(scope, 'cert');
        if (typeof got === 'string') return this.refuse(got);
        pw = got.bytes;
        if (got.remember) remembered = (await this.o.store.write(scope, certId, pw)) === 'ok';
        // 기억을 고르지 않았으면 예전에 기억해 둔 것도 지운다(새 비밀번호로 바꿨을 수 있다)
        else await this.o.store.forget(scope, certId);
      }
      const enc = publicEncrypt({ key, padding: cc.RSA_PKCS1_PADDING }, pw);
      this.o.log.event('vault.codef_sealed', { remembered: remembered ? 1 : 0 });
      return { ok: true, derFile: Buffer.from(pair.der).toString('base64'), keyFile: Buffer.from(pair.key).toString('base64'), password: enc.toString('base64'), remembered };
    } catch (e) {
      // 'unreadable' 하나로 뭉치기 전에 어디서 깨졌는지 남긴다(Electron BoringSSL에서만 나는 암호 오류 등). 오류 코드·이름만, 메시지는 넣지 않는다
      const x = e as { code?: unknown; name?: unknown } | null;
      const why = typeof x?.code === 'string' && /^[A-Z0-9_]{1,48}$/.test(x.code) ? x.code : typeof x?.name === 'string' && /^[A-Za-z]{1,32}$/.test(x.name) ? x.name : 'other';
      this.o.log.event('vault.codef_seal_error', { why });
      return this.refuse('unreadable');
    } finally {
      pw?.fill(0);
      pair.key.fill(0);
    }
  }

  /**
   * 출금계좌 비밀번호 4자리: 기억해 둔 것(같은 칸 저장소, 인증서별 따로 이름)이나 금고 창('account' 모드)에서 받아 CODEF 공개키로 감싼다.
   * 인증서 파일은 싣지 않는다(derFile·keyFile 빈 칸). 평문 바이트는 바로 0으로 덮는다.
   */
  private async sealAccount(certId: string, scope: ProfileScope, mode: CodefSealParams['mode'], key: KeyObject): Promise<CodefSealResult> {
    const slot = accountSlotId(certId);
    let pw: Uint8Array | null = null;
    let remembered = false;
    try {
      if (mode !== 'ask') {
        const r = await this.o.store.read(scope, slot);
        if (r.ok) {
          pw = r.bytes;
          remembered = true;
        } else if (mode === 'stored') return this.refuse(r.reason === 'vault_locked' ? 'vault_locked' : 'missing');
      }
      if (!pw) {
        if (this.pending) return this.refuse('busy');
        const got = await this.ask(scope, 'account');
        if (typeof got === 'string') return this.refuse(got);
        pw = got.bytes;
        if (got.remember) remembered = (await this.o.store.write(scope, slot, pw)) === 'ok';
        else await this.o.store.forget(scope, slot);
      }
      const enc = publicEncrypt({ key, padding: cc.RSA_PKCS1_PADDING }, pw);
      this.o.log.event('vault.codef_sealed', { remembered: remembered ? 1 : 0, field: 'account' });
      return { ok: true, derFile: '', keyFile: '', password: enc.toString('base64'), remembered };
    } catch (e) {
      const x = e as { code?: unknown; name?: unknown } | null;
      this.o.log.event('vault.codef_seal_error', { why: typeof x?.code === 'string' && /^[A-Z0-9_]{1,48}$/.test(x.code) ? x.code : 'other', field: 'account' });
      return this.refuse('unreadable');
    } finally {
      pw?.fill(0);
    }
  }

  /** 기억해 둔 비밀번호 지우기([연결 해제]·비밀번호 틀림). 같은 인증서의 출금계좌 비밀번호도 함께 */
  async forget(scope: ProfileScope, certId: string): Promise<boolean> {
    const a = await this.o.store.forget(scope, certId);
    await this.o.store.forget(scope, accountSlotId(certId)).catch(() => false);
    return a;
  }

  private ask(scope: ProfileScope, field: 'cert' | 'account'): Promise<{ bytes: Uint8Array; remember: boolean } | 'cancelled' | 'timeout'> {
    return new Promise((resolve) => {
      const reqId = randomBytes(16).toString('hex');
      const timer = setTimeout(() => this.pending?.reqId === reqId && this.finish(this.pending, 'timeout'), this.o.ttlMs ?? CODEF_SEAL_TTL_MS);
      timer.unref?.();
      this.pending = { reqId, scope, field, done: resolve, timer };
      this.o.askWindow({ mode: 'codef', reqId, scope, ...(field === 'account' ? { field } : {}) });
    });
  }

  private refuse(reason: Extract<CodefSealResult, { ok: false }>['reason']): CodefSealResult {
    this.o.log.event('vault.codef_seal_refused', { reason });
    return { ok: false, reason };
  }
}

/** 출금계좌 비밀번호를 기억해 둘 칸 이름(인증서 id에서 만든 16 hex, 인증서 비밀번호 칸과 겹치지 않는다) */
export const accountSlotId = (certId: string): string => createHash('sha256').update(`codef-account:${certId}`).digest('hex').slice(0, 16);
