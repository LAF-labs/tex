// 서명 백엔드. Phase 1 단독 모드(ADR-037): macOS 키체인 + Secure Enclave 감싸기 + Touch ID(macos/sax-keychain.swift 도우미).
// 이 모듈은 도우미에 "이 keyId로 이 바이트에 서명하라"만 보낸다. 서명은 도우미 프로세스 안에서 하고 시드는 Node로 오지 않는다.
// 예외는 백업 내보내기·들여오기(exportSeeds·importSeed)뿐이다. 부르는 쪽이 바로 암호로 잠그고 버퍼를 0으로 덮는다.
// 보유자 여럿으로 승격하면 YubiKey PIV(아래 PivDevice 인터페이스)로 옮긴다(CEREMONY.md §8). 그 구현은 승격 때 넣는다.
import { spawn } from 'node:child_process';
import { createPublicKey, verify as edVerify } from 'node:crypto';
import type { Role } from '../verify.ts';
import { CeremonyError } from './content.ts';

/** 한 번에 서명하는 입력 상한(도우미와 같다). 인덱스 게시 상한(512KB)과 같다. */
export const MAX_SIGN_BYTES = 512 * 1024;

export interface SigningBackend {
  /** 화면 표시용(비밀 없음) */
  describe(): string;
  /** keyId의 Ed25519 공개키 32B(Touch ID 없음) */
  publicKey(keyId: string): Promise<Buffer>;
  /** keyId로 message 전체에 서명(PureEdDSA, 64B). Touch ID 창에 confirm(확인 코드)을 보인다. */
  sign(keyId: string, message: Buffer, confirm: string): Promise<Buffer>;
}

/** 키를 만들고 백업할 수 있는 백엔드(단독 모드 키체인). */
export interface KeyStoreBackend extends SigningBackend {
  generate(keyId: string): Promise<Buffer>;
  list(): Promise<string[]>;
  /** 백업 전용. Touch ID 한 번. 돌려받은 seed 버퍼는 부르는 쪽이 0으로 덮는다. */
  exportSeeds(keyIds: readonly string[]): Promise<Array<{ keyId: string; pub: string; seed: Buffer }>>;
  /** 백업 들여오기. 같은 keyId가 있으면 거부(덮지 않는다). 돌려주는 값은 공개키. */
  importSeed(keyId: string, seed: Buffer): Promise<Buffer>;
}

/**
 * 승격 뒤 YubiKey PIV(펌웨어 5.7 이상 Ed25519, 슬롯 82 package·83 policy·84 root, PIN·터치 ALWAYS, 팀장 결정 2026-11-06)의 자리.
 * 인터페이스만 둔다: ykcs11 + pkcs11-tool EDDSA로 서명하고 ykman으로 공개키·증명(attestation)을 받는다. PIN은 도구를 지나가지 않는다.
 */
export interface PivDevice {
  publicKey(slot: PivSlot): Promise<Buffer>;
  sign(slot: PivSlot, message: Buffer): Promise<Buffer>;
  attestation(slot: PivSlot): Promise<{ attestation: string; intermediate: string }>;
}
export type PivSlot = '82' | '83' | '84' | '85' | '86';
export const PIV_ROLE_SLOT: Partial<Record<Role, PivSlot>> = { package: '82', policy: '83', root: '84', release: '85', emergency: '86' };

const SPKI_ED25519 = Buffer.from('302a300506032b6570032100', 'hex');

/** PEM·DER SPKI → Ed25519 원시 공개키. Ed25519가 아니면 거부. */
export function rawEd25519FromSpki(pemOrDer: string | Buffer): Buffer {
  let k;
  try {
    k = createPublicKey(typeof pemOrDer === 'string' ? pemOrDer : { key: pemOrDer, format: 'der', type: 'spki' });
  } catch {
    throw new CeremonyError('ceremony.pubkey_invalid');
  }
  if (k.asymmetricKeyType !== 'ed25519') throw new CeremonyError('ceremony.pubkey_not_ed25519', String(k.asymmetricKeyType));
  const der = k.export({ format: 'der', type: 'spki' });
  if (der.length !== 44 || !der.subarray(0, 12).equals(SPKI_ED25519)) throw new CeremonyError('ceremony.pubkey_invalid');
  return Buffer.from(der.subarray(12));
}

export function edVerifyRaw(pubRaw: Uint8Array, message: Uint8Array, sig: Uint8Array): boolean {
  try {
    return sig.length === 64 && edVerify(null, message, createPublicKey({ key: Buffer.concat([SPKI_ED25519, Buffer.from(pubRaw)]), format: 'der', type: 'spki' }), sig);
  } catch {
    return false;
  }
}

/** 도우미 실행기: stdin 한 덩어리를 넣고 stdout 한 줄 JSON을 받는다. Touch ID 창은 OS가 띄운다(터미널 입력 없음). 시험은 가짜를 넣는다. */
export type HelperRunner = (helper: string, args: readonly string[], stdin: string | null) => Promise<{ code: number; stdout: string }>;

export const spawnHelper: HelperRunner = (helper, args, stdin) =>
  new Promise((resolve, reject) => {
    const p = spawn(helper, args, { stdio: ['pipe', 'pipe', 'inherit'], shell: false });
    const chunks: Buffer[] = [];
    p.stdout.on('data', (d: Buffer) => chunks.push(d));
    p.on('error', reject);
    p.on('close', (code) => {
      const buf = Buffer.concat(chunks);
      const stdout = buf.toString('utf8');
      buf.fill(0); // 내보내기 응답에는 시드가 실린다
      for (const c of chunks) c.fill(0);
      resolve({ code: code ?? 1, stdout });
    });
    p.stdin.end(stdin ?? '');
  });

const KEY_ID = /^(root|package|policy|emergency|timestamp|release)-[0-9]+$/;

/** macOS 키체인 + Secure Enclave + Touch ID(도우미 sax-keychain). */
export class MacKeychainBackend implements KeyStoreBackend {
  private readonly helper: string;
  private readonly run: HelperRunner;
  constructor(o: { helper: string; run?: HelperRunner }) {
    this.helper = o.helper;
    this.run = o.run ?? spawnHelper;
  }

  describe(): string {
    return 'macOS 키체인(Secure Enclave·Touch ID)';
  }

  private async call(args: string[], stdin: string | null = null): Promise<Record<string, unknown>> {
    for (const a of args.slice(1)) if (!KEY_ID.test(a) && !/^[0-9a-f]{4}(-[0-9a-f]{4}){7}$/.test(a)) throw new CeremonyError('ceremony.usage', '도우미 인자');
    let r;
    try {
      r = await this.run(this.helper, args, stdin);
    } catch {
      throw new CeremonyError('ceremony.helper_missing', this.helper);
    }
    let o: Record<string, unknown>;
    try {
      o = JSON.parse(r.stdout.trim().split('\n').pop() ?? '') as Record<string, unknown>;
    } catch {
      throw new CeremonyError('ceremony.helper_failed');
    }
    if (r.code !== 0 || typeof o.error === 'string') throw new CeremonyError(typeof o.error === 'string' ? o.error : 'ceremony.helper_failed');
    return o;
  }

  private pubOf(o: Record<string, unknown>, keyId: string): Buffer {
    const b = typeof o.pub === 'string' ? Buffer.from(o.pub, 'base64') : Buffer.alloc(0);
    if (o.keyId !== keyId || b.length !== 32) throw new CeremonyError('ceremony.helper_failed');
    return b;
  }

  async publicKey(keyId: string): Promise<Buffer> {
    return this.pubOf(await this.call(['pubkey', keyId]), keyId);
  }

  async generate(keyId: string): Promise<Buffer> {
    return this.pubOf(await this.call(['generate', keyId]), keyId);
  }

  async list(): Promise<string[]> {
    const o = await this.call(['list']);
    return Array.isArray(o.keys) ? (o.keys as unknown[]).filter((k): k is string => typeof k === 'string') : [];
  }

  async sign(keyId: string, message: Buffer, confirm: string): Promise<Buffer> {
    if (message.length === 0 || message.length > MAX_SIGN_BYTES) throw new CeremonyError('ceremony.message_size');
    const o = await this.call(['sign', keyId, confirm], message.toString('base64'));
    const sig = typeof o.sig === 'string' ? Buffer.from(o.sig, 'base64') : Buffer.alloc(0);
    if (o.keyId !== keyId || sig.length !== 64) throw new CeremonyError('ceremony.signature_invalid');
    return sig;
  }

  async exportSeeds(keyIds: readonly string[]): Promise<Array<{ keyId: string; pub: string; seed: Buffer }>> {
    const o = await this.call(['export', ...keyIds]);
    const keys = Array.isArray(o.keys) ? (o.keys as Array<{ keyId?: unknown; pub?: unknown; seed?: unknown }>) : [];
    const out = keys.map((k) => ({ keyId: String(k.keyId), pub: String(k.pub), seed: Buffer.from(String(k.seed), 'base64') }));
    for (const k of keys) k.seed = undefined;
    if (out.length !== keyIds.length || out.some((k, i) => k.keyId !== keyIds[i] || k.seed.length !== 32)) {
      for (const k of out) k.seed.fill(0);
      throw new CeremonyError('ceremony.helper_failed');
    }
    return out;
  }

  async importSeed(keyId: string, seed: Buffer): Promise<Buffer> {
    if (seed.length !== 32) throw new CeremonyError('ceremony.usage');
    return this.pubOf(await this.call(['import', keyId], seed.toString('base64')), keyId);
  }
}
