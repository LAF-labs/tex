import { randomBytes } from 'node:crypto';

// 무인 등급 앱 내부 키(D05 §2). PoC는 DB 키 하나만 둔다. 사람 비밀은 저장하지 않는다(ADR-017).
// 읽기와 만들기를 나눈다(N-30): 항목이 없거나 길이가 틀려도 조용히 새 키로 덮지 않는다.
export interface KeyStore {
  /** 없으면 null. 길이가 다르면 덮지 않고 Error('vault.keystore_mismatch'). */
  get(name: string, bytes: number): Promise<Uint8Array | null>;
  /** 새 키를 만들어 기록한다. 부르는 쪽이 "없음"을 확인한 뒤에만 부른다. */
  create(name: string, bytes: number): Promise<Uint8Array>;
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

  /** 시험용: 항목을 그대로 넣는다(길이 불일치 재현). */
  set(name: string, value: Uint8Array): void {
    this.keys.set(name, Uint8Array.from(value));
  }

  /** 호환용(시험·픽스처 모드). 앱 경로는 get/create를 쓴다. */
  async getOrCreate(name: string, bytes: number): Promise<Uint8Array> {
    return (await this.get(name, bytes)) ?? this.create(name, bytes);
  }
}
