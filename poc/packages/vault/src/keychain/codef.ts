import { randomBytes } from 'node:crypto';
import type { EventLog } from '@sax/platform';
import type { ProfileScope } from '../protocol.ts';
import { ITEM_MAX_BYTES, open as openSealed, seal, type KeychainBackend } from './backend.ts';
import type { SessionLock } from './session.ts';

export const CODEF_CERT_ID_RE = /^[0-9a-f]{16}$/;
/** 인증서 비밀번호 평문 상한(바이트) */
export const CODEF_PASSWORD_MAX_BYTES = 128;

export const codefItem = (scope: ProfileScope, certId: string): string => `codef/${scope}/${certId}`;
export const codefKekItem = (scope: ProfileScope, certId: string): string => `kek/codef/${scope}/${certId}/device`;

export type CodefPasswordRead = { ok: true; bytes: Uint8Array } | { ok: false; reason: 'vault_locked' | 'missing' | 'corrupt' | 'kek_unavailable' };

export class CodefPasswordStore {
  private readonly o: { backend: KeychainBackend; lock: SessionLock; ready: () => Promise<void>; log: EventLog };
  constructor(o: { backend: KeychainBackend; lock: SessionLock; ready: () => Promise<void>; log: EventLog }) {
    this.o = o;
  }

  private check(certId: string): void {
    if (typeof certId !== 'string' || !CODEF_CERT_ID_RE.test(certId)) throw new Error('bad_cert');
  }

  async read(scope: ProfileScope, certId: string): Promise<CodefPasswordRead> {
    this.check(certId);
    await this.o.ready();
    if (!this.o.lock.check().open) return { ok: false, reason: 'vault_locked' };
    const name = codefItem(scope, certId);
    const blob = await this.o.backend.items.get(name);
    if (!blob) return { ok: false, reason: 'missing' };
    const wrapped = await this.o.backend.items.get(codefKekItem(scope, certId));
    if (!wrapped) return { ok: false, reason: 'kek_unavailable' };
    let kek: Uint8Array;
    try {
      kek = await this.o.backend.wrapper.unwrap(wrapped, name);
    } catch {
      return { ok: false, reason: 'kek_unavailable' };
    }
    try {
      const pt = openSealed(kek, blob, name);
      if (pt.length === 0 || pt.length > CODEF_PASSWORD_MAX_BYTES) {
        pt.fill(0);
        return { ok: false, reason: 'corrupt' };
      }
      if (!this.o.lock.check().open) {
        pt.fill(0);
        return { ok: false, reason: 'vault_locked' };
      }
      return { ok: true, bytes: pt };
    } catch {
      return { ok: false, reason: 'corrupt' };
    } finally {
      kek.fill(0);
    }
  }

  async write(scope: ProfileScope, certId: string, bytes: Uint8Array): Promise<'ok' | 'vault_locked' | 'kek_unavailable' | 'write_failed'> {
    this.check(certId);
    if (!(bytes instanceof Uint8Array) || bytes.length === 0 || bytes.length > CODEF_PASSWORD_MAX_BYTES) throw new Error('bad_params');
    await this.o.ready();
    if (!this.o.lock.check().open) return 'vault_locked';
    const name = codefItem(scope, certId);
    const kek = new Uint8Array(randomBytes(32));
    try {
      let wrapped: Uint8Array;
      try {
        wrapped = await this.o.backend.wrapper.wrap(kek, name);
      } catch {
        return 'kek_unavailable';
      }
      const blob = seal(kek, bytes, name);
      if (blob.length > ITEM_MAX_BYTES) return 'write_failed';
      await this.o.backend.items.set(codefKekItem(scope, certId), wrapped);
      await this.o.backend.items.set(name, blob);
      this.o.log.event('vault.codef_password_stored');
      return 'ok';
    } catch {
      return 'write_failed';
    } finally {
      kek.fill(0);
    }
  }

  async forget(scope: ProfileScope, certId: string): Promise<boolean> {
    this.check(certId);
    const a = await this.o.backend.items.delete(codefItem(scope, certId)).catch(() => false);
    const b = await this.o.backend.items.delete(codefKekItem(scope, certId)).catch(() => false);
    if (a || b) this.o.log.event('vault.codef_password_forgotten');
    return a || b;
  }

  async has(scope: ProfileScope, certId: string): Promise<boolean> {
    this.check(certId);
    return (await this.o.backend.items.get(codefItem(scope, certId))) !== null;
  }
}
