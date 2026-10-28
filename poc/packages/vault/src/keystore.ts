import { randomBytes } from 'node:crypto';

// 무인 등급 앱 내부 키(D05 §2). PoC는 DB 키 하나만 둔다. 사람 비밀은 저장하지 않는다(ADR-017).
export interface KeyStore {
  getOrCreate(name: string, bytes: number): Promise<Uint8Array>;
}

export const KEYCHAIN_SERVICE = 'SovereignAX';

/** OS 키체인(Windows Credential Manager / macOS Keychain). 바이트 API(setSecret/getSecret) 사용. */
export class OsKeyStore implements KeyStore {
  async getOrCreate(name: string, bytes: number): Promise<Uint8Array> {
    const { AsyncEntry } = await import('@napi-rs/keyring');
    const entry = new AsyncEntry(KEYCHAIN_SERVICE, name);
    const existing = await entry.getSecret();
    if (existing && existing.length === bytes) return Uint8Array.from(existing);
    const fresh = new Uint8Array(randomBytes(bytes));
    await entry.setSecret(fresh);
    return fresh;
  }
}

export class MemoryKeyStore implements KeyStore {
  private readonly keys = new Map<string, Uint8Array>();
  async getOrCreate(name: string, bytes: number): Promise<Uint8Array> {
    let k = this.keys.get(name);
    if (!k) {
      k = new Uint8Array(randomBytes(bytes));
      this.keys.set(name, k);
    }
    return Uint8Array.from(k);
  }
}
