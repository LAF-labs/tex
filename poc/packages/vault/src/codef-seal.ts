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
  private pending: Pending | null = null;

  constructor(o: CodefSealerOptions) {
    this.o = o;
  }

  hasPending(reqId: string, scope: ProfileScope): boolean {
    return this.pending !== null && this.pending.reqId === reqId && this.pending.scope === scope;
  }

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
        else await this.o.store.forget(scope, certId);
      }
      const enc = publicEncrypt({ key, padding: cc.RSA_PKCS1_PADDING }, pw);
      this.o.log.event('vault.codef_sealed', { remembered: remembered ? 1 : 0 });
      return { ok: true, derFile: Buffer.from(pair.der).toString('base64'), keyFile: Buffer.from(pair.key).toString('base64'), password: enc.toString('base64'), remembered };
    } catch (e) {
      const x = e as { code?: unknown; name?: unknown } | null;
      const why = typeof x?.code === 'string' && /^[A-Z0-9_]{1,48}$/.test(x.code) ? x.code : typeof x?.name === 'string' && /^[A-Za-z]{1,32}$/.test(x.name) ? x.name : 'other';
      this.o.log.event('vault.codef_seal_error', { why });
      return this.refuse('unreadable');
    } finally {
      pw?.fill(0);
      pair.key.fill(0);
    }
  }

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
