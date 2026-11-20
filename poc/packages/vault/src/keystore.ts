import { randomBytes } from 'node:crypto';

export interface KeyStore {
  get(name: string, bytes: number): Promise<Uint8Array | null>;
  create(name: string, bytes: number): Promise<Uint8Array>;
  put(name: string, value: Uint8Array): Promise<void>;
}

export const KEYCHAIN_SERVICE = 'SovereignAX';

/** OS 키체인(Windows Credential Manager / macOS Keychain). 바이트 API(setSecret/getSecret) 사용. */
export class OsKeyStore implements KeyStore {
  private async entry(name: string) {
    const { AsyncEntry } = await import('@napi-rs/keyring');
    return new AsyncEntry(KEYCHAIN_SERVICE, name);
  }

  async get(name: string, bytes: number): Promise<Uint8Array | null> {
    const existing = await (await this.entry(name)).getSecret();
    if (!existing) return null;
    if (existing.length !== bytes) throw new Error('vault.keystore_mismatch');
    return Uint8Array.from(existing);
  }

  async create(name: string, bytes: number): Promise<Uint8Array> {
    const fresh = new Uint8Array(randomBytes(bytes));
    await (await this.entry(name)).setSecret(fresh);
    return fresh;
  }

  async put(name: string, value: Uint8Array): Promise<void> {
    await (await this.entry(name)).setSecret(Uint8Array.from(value));
  }
}

export class MemoryKeyStore implements KeyStore {
  private readonly keys = new Map<string, Uint8Array>();

  async get(name: string, bytes: number): Promise<Uint8Array | null> {
    const k = this.keys.get(name);
    if (!k) return null;
    if (k.length !== bytes) throw new Error('vault.keystore_mismatch');
    return Uint8Array.from(k);
  }

  async create(name: string, bytes: number): Promise<Uint8Array> {
    const k = new Uint8Array(randomBytes(bytes));
    this.keys.set(name, k);
    return Uint8Array.from(k);
  }

  async put(name: string, value: Uint8Array): Promise<void> {
    this.keys.set(name, Uint8Array.from(value));
  }

  set(name: string, value: Uint8Array): void {
    this.keys.set(name, Uint8Array.from(value));
  }

  async getOrCreate(name: string, bytes: number): Promise<Uint8Array> {
    return (await this.get(name, bytes)) ?? this.create(name, bytes);
  }
}
