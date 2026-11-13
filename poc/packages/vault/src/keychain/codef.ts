// 계좌 자동조회(CODEF)용 인증서 비밀번호 기억(사장님이 [이 PC에 기억]을 고른 때만, 대표 결정 2026-11-12 과제 지시).
// - ADR-020 결정 2("인증서 비밀번호는 저장 기능이 없다")의 좁은 예외다. 이 칸은 codef.seal만 읽는다. 타이피스트·포털 칸·secret.list에 나오지 않는다
//   (STORABLE_KINDS에 넣지 않는다). 그래서 기억해 둔 비밀번호가 홈택스 등 다른 사이트 입력에 쓰이는 길이 없다.
// - 칸: codef/<scope>/<certId>. 칸마다 KEK(32B 무작위, 기기 결박 래핑 kek/codef/<scope>/<certId>/device)로 AES-256-GCM(AAD = 칸 이름).
// - 금고가 잠겨 있으면 읽지도 쓰지도 않는다. 지우기는 잠겨 있어도 한다([연결 해제]·비밀번호 틀림).
// - 로그는 이벤트 이름만(값·길이·인증서 id 없음).
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

  /** 기억하기. 기기 결박 래핑이 안 되면 저장하지 않는다(약한 등급으로 조용히 내려가지 않는다). 값은 복사해 봉인하고 원본은 부른 쪽이 지운다. */
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
