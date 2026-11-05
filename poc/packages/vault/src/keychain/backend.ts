// 키체인 어댑터의 플랫폼 계층(D05 §7, ADR-026 결정 2). 세 가지 부품으로 나눈다.
// - ItemStore: OS 자격 증명 저장소의 바이트 항목(Windows Credential Manager / macOS Keychain). 암호문·래핑된 KEK만 담는다.
// - KekWrapper: 슬롯 KEK를 이 기기에 결박하는 래핑(TPM 내보낼 수 없는 키 → 없으면 DPAPI). macOS는 개발용.
// - HelloProvider: Windows Hello 결박 사본(KeyCredentialManager 서명-챌린지 → KEK). 사람 확인 프롬프트가 뜬다.
// Windows 구현은 네이티브 헬퍼(Rust N-API, S10c) 전까지 인터페이스와 실패 구현만 둔다. 실측 목록: reports/M1-3-windows.md.
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import type { KeyTier } from '../protocol.ts';
import { KEYCHAIN_SERVICE } from '../keystore.ts';

/** Credential Manager 항목당 상한(D05 §2·§7). 넘는 항목은 쓰지 않는다. */
export const ITEM_MAX_BYTES = 2_560;

export interface ItemStore {
  get(name: string): Promise<Uint8Array | null>;
  set(name: string, value: Uint8Array): Promise<void>;
  /** 지웠으면 true. */
  delete(name: string): Promise<boolean>;
}

/**
 * OS 키체인 바이트 항목(@napi-rs/keyring 2.1.x). Windows는 지속성 LOCAL_MACHINE(vault.credPersist)이어야 한다(S10b 실측 필요).
 * Phase 1 한계(D05 §8): getSecret이 JS 배열 사본을 만든다(0으로 덮을 수 없음, 금고 힙 안).
 */
export class KeyringItemStore implements ItemStore {
  private async entry(name: string) {
    const { AsyncEntry } = await import('@napi-rs/keyring');
    return new AsyncEntry(KEYCHAIN_SERVICE, name);
  }

  async get(name: string): Promise<Uint8Array | null> {
    const v = await (await this.entry(name)).getSecret();
    return v ? Uint8Array.from(v) : null;
  }

  async set(name: string, value: Uint8Array): Promise<void> {
    if (value.length > ITEM_MAX_BYTES) throw new Error('vault.item_too_large');
    await (await this.entry(name)).setSecret(value);
  }

  async delete(name: string): Promise<boolean> {
    return (await this.entry(name)).deleteCredential().catch(() => false);
  }
}

export class MemoryItemStore implements ItemStore {
  readonly items = new Map<string, Uint8Array>();

  async get(name: string): Promise<Uint8Array | null> {
    const v = this.items.get(name);
    return v ? Uint8Array.from(v) : null;
  }

  async set(name: string, value: Uint8Array): Promise<void> {
    if (value.length > ITEM_MAX_BYTES) throw new Error('vault.item_too_large');
    this.items.set(name, Uint8Array.from(value));
  }

  async delete(name: string): Promise<boolean> {
    return this.items.delete(name);
  }
}

/** 슬롯 KEK 래핑. label은 슬롯 이름이며 래핑의 AAD로 묶는다(다른 슬롯 자리에 옮겨 붙인 래핑은 풀리지 않는다). */
export interface KekWrapper {
  readonly tier: KeyTier;
  wrap(kek: Uint8Array, label: string): Promise<Uint8Array>;
  unwrap(blob: Uint8Array, label: string): Promise<Uint8Array>;
}

/** Hello 프롬프트 문구 재료(vault.helloPromptShowsTaskAndPortal). */
export interface HelloPrompt {
  task: string;
  portal: string;
}

export interface HelloProvider {
  /** KeyCredentialManager.IsSupportedAsync 상당. */
  available(): Promise<boolean>;
  wrap(kek: Uint8Array, label: string): Promise<Uint8Array>;
  /** 사람 확인 프롬프트를 띄운다. 사용자가 취소하면 null. */
  unwrap(blob: Uint8Array, label: string, prompt: HelloPrompt): Promise<Uint8Array | null>;
}

// ───────────────────────── AES-256-GCM 봉투(항목·래핑 공통) ─────────────────────────

const SEAL_V1 = 0x01;

/** v1 ‖ iv(12) ‖ ct ‖ tag(16), AAD = utf8(aad). */
export function seal(key: Uint8Array, plain: Uint8Array, aad: string): Uint8Array {
  if (key.length !== 32) throw new Error('bad key length');
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key, iv);
  c.setAAD(Buffer.from(aad, 'utf8'));
  const ct = Buffer.concat([c.update(plain), c.final()]);
  return new Uint8Array(Buffer.concat([Buffer.from([SEAL_V1]), iv, ct, c.getAuthTag()]));
}

export function open(key: Uint8Array, blob: Uint8Array, aad: string): Uint8Array {
  if (key.length !== 32) throw new Error('bad key length');
  if (blob.length < 1 + 12 + 16 || blob[0] !== SEAL_V1) throw new Error('vault.item_corrupt');
  const b = Buffer.from(blob);
  const d = createDecipheriv('aes-256-gcm', key, b.subarray(1, 13));
  d.setAAD(Buffer.from(aad, 'utf8'));
  d.setAuthTag(b.subarray(b.length - 16));
  try {
    return new Uint8Array(Buffer.concat([d.update(b.subarray(13, b.length - 16)), d.final()]));
  } catch {
    throw new Error('vault.item_corrupt');
  }
}

// ───────────────────────── 래핑 구현 ─────────────────────────

/**
 * 시험용·개발용 래핑: 기기 래핑 키 하나로 슬롯 KEK를 AES-GCM 래핑한다.
 * - MemoryWrapper: 래핑 키를 메모리에만(시험).
 * - DevKeychainWrapper: 래핑 키를 Keychain 항목 `wrapkey/dev`에 둔다(macOS 개발). 하드웨어 결박이 아니며 tier='keychain-dev'로 표시한다.
 */
export class MemoryWrapper implements KekWrapper {
  readonly tier: KeyTier = 'memory';
  private readonly key = new Uint8Array(randomBytes(32));
  /** 시험: 다른 기기(다른 래핑 키)를 흉내 낸다. */
  static otherDevice(): MemoryWrapper {
    return new MemoryWrapper();
  }

  async wrap(kek: Uint8Array, label: string): Promise<Uint8Array> {
    return seal(this.key, kek, `kek-wrap|${label}`);
  }

  async unwrap(blob: Uint8Array, label: string): Promise<Uint8Array> {
    return open(this.key, blob, `kek-wrap|${label}`);
  }
}

export class DevKeychainWrapper implements KekWrapper {
  readonly tier: KeyTier = 'keychain-dev';
  private readonly items: ItemStore;
  private keyP: Promise<Uint8Array> | null = null;

  constructor(items: ItemStore) {
    this.items = items;
  }

  private key(): Promise<Uint8Array> {
    this.keyP ??= (async () => {
      const k = await this.items.get('wrapkey/dev');
      if (k) {
        if (k.length !== 32) throw new Error('vault.keystore_mismatch');
        return k;
      }
      const fresh = new Uint8Array(randomBytes(32));
      await this.items.set('wrapkey/dev', fresh);
      return fresh;
    })();
    return this.keyP;
  }

  async wrap(kek: Uint8Array, label: string): Promise<Uint8Array> {
    return seal(await this.key(), kek, `kek-wrap|${label}`);
  }

  async unwrap(blob: Uint8Array, label: string): Promise<Uint8Array> {
    return open(await this.key(), blob, `kek-wrap|${label}`);
  }
}

/**
 * Windows 래핑(실측 전). 네이티브 헬퍼가 없으면 wrap·unwrap이 던진다. 금고는 이 경우 저장을 거부한다(조용히 약한 등급으로 내려가지 않는다).
 * - tpm: NCryptOpenStorageProvider(MS_PLATFORM_CRYPTO_PROVIDER) + 내보낼 수 없는 RSA/ECDH 키(UI 정책 없음)로 KEK 래핑
 * - dpapi: CryptProtectData(CurrentUser, 엔트로피 = label)
 */
export class WindowsNativeWrapper implements KekWrapper {
  readonly tier: KeyTier;
  private readonly helper: WindowsKeyHelper | null;

  constructor(tier: 'tpm' | 'dpapi', helper: WindowsKeyHelper | null) {
    this.tier = tier;
    this.helper = helper;
  }

  async wrap(kek: Uint8Array, label: string): Promise<Uint8Array> {
    if (!this.helper) throw new Error('vault.native_helper_missing');
    return this.tier === 'tpm' ? this.helper.tpmWrap(kek, label) : this.helper.dpapiProtect(kek, label);
  }

  async unwrap(blob: Uint8Array, label: string): Promise<Uint8Array> {
    if (!this.helper) throw new Error('vault.native_helper_missing');
    return this.tier === 'tpm' ? this.helper.tpmUnwrap(blob, label) : this.helper.dpapiUnprotect(blob, label);
  }
}

/** Windows 네이티브 헬퍼(Rust N-API, S10c) 계약. 금고 프로세스 안에서만 불린다(KEK가 다른 프로세스로 가지 않는다). */
export interface WindowsKeyHelper {
  tpmAvailable(): Promise<boolean>;
  tpmWrap(kek: Uint8Array, label: string): Promise<Uint8Array>;
  tpmUnwrap(blob: Uint8Array, label: string): Promise<Uint8Array>;
  dpapiProtect(kek: Uint8Array, label: string): Promise<Uint8Array>;
  dpapiUnprotect(blob: Uint8Array, label: string): Promise<Uint8Array>;
}

/** Hello가 없는 PC·macOS 개발. */
export class UnavailableHello implements HelloProvider {
  async available(): Promise<boolean> {
    return false;
  }
  async wrap(): Promise<Uint8Array> {
    throw new Error('vault.hello_unavailable');
  }
  async unwrap(): Promise<Uint8Array | null> {
    throw new Error('vault.hello_unavailable');
  }
}

/** 시험용 Hello: 다음 응답(승인·취소)을 정해 둔다. 프롬프트 문구를 기록한다. */
export class MockHello implements HelloProvider {
  private readonly key = new Uint8Array(randomBytes(32));
  next: 'approve' | 'cancel' = 'approve';
  readonly prompts: HelloPrompt[] = [];

  async available(): Promise<boolean> {
    return true;
  }

  async wrap(kek: Uint8Array, label: string): Promise<Uint8Array> {
    return seal(this.key, kek, `hello-wrap|${label}`);
  }

  async unwrap(blob: Uint8Array, label: string, prompt: HelloPrompt): Promise<Uint8Array | null> {
    this.prompts.push({ ...prompt });
    if (this.next === 'cancel') return null;
    return open(this.key, blob, `hello-wrap|${label}`);
  }
}

export interface KeychainBackend {
  items: ItemStore;
  wrapper: KekWrapper;
  hello: HelloProvider;
}

/**
 * 플랫폼별 기본 구성(platform 패키지의 dirGuard(platform)와 같은 모양). 앱 진입점만 부른다. 동기: 금고 진입점이 포트를 받기 전에 끝나야 한다.
 * - win32: 헬퍼가 TPM을 확인했으면 tpm, 아니면 dpapi. 헬퍼 자체가 없으면 저장이 거부된다(실측 전).
 * - darwin·그 밖: 개발용 Keychain 래핑, Hello 없음.
 */
export function keychainBackend(platform: NodeJS.Platform = process.platform, helper: WindowsKeyHelper | null = null, tpmAvailable = false): KeychainBackend {
  const items = new KeyringItemStore();
  if (platform === 'win32') return { items, wrapper: new WindowsNativeWrapper(helper && tpmAvailable ? 'tpm' : 'dpapi', helper), hello: new UnavailableHello() };
  return { items, wrapper: new DevKeychainWrapper(items), hello: new UnavailableHello() };
}
