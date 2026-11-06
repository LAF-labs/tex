// 서명 장치(YubiKey 5, 펌웨어 5.7 이상 PIV Ed25519). 개인키는 장치 안에서 만들고 장치 밖으로 나오지 않는다.
// 이 모듈은 장치에 "이 바이트에 서명하라"와 "공개키·증명서를 달라"만 보낸다. PIN은 다루지 않는다:
// pkcs11-tool·ykman이 터미널에서 직접 묻는다(명령줄·환경 변수·파일에 PIN을 두지 않는다). 터치는 장치가 요구한다(정책 ALWAYS).
import { spawn } from 'node:child_process';
import { createPublicKey, verify as edVerify } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Role } from '../verify.ts';
import { CeremonyError } from './content.ts';

/** PIV 슬롯(팀장 결정: 82 package, 83 policy, 84 root). 85 release·86 emergency는 이 절차서의 제안이다(CEREMONY.md §1·§10). */
export const ROLE_SLOT: Partial<Record<Role, PivSlot>> = { package: '82', policy: '83', root: '84', release: '85', emergency: '86' };
export type PivSlot = '82' | '83' | '84' | '85' | '86';

/** ykcs11 객체 id: 9a=1, 9c=2, 9d=3, 9e=4, 82~95 = 5~24(16진 05~18), f9 = 25. */
export function ykcs11KeyId(slot: PivSlot): string {
  const n = 5 + (parseInt(slot, 16) - 0x82);
  return n.toString(16).padStart(2, '0');
}

/** 한 번에 장치로 보내는 서명 입력 상한. 펌웨어 5.7 PIV Ed25519의 실제 메시지 한도는 실측 전이다(CEREMONY.md §10). */
export const MAX_SIGN_BYTES = 512 * 1024;

export interface SigningDevice {
  /** 화면 표시용(일련번호 등, 비밀 없음) */
  describe(): string;
  /** 슬롯 공개키(Ed25519 원시 32바이트) */
  publicKey(slot: PivSlot): Promise<Buffer>;
  /** 슬롯 키로 message 전체에 서명(PureEdDSA). PIN·터치는 장치가 요구한다. 64바이트. */
  sign(slot: PivSlot, message: Buffer): Promise<Buffer>;
  /** PIV 증명(attestation): 슬롯 키 인증서와 장치 증명 중간 인증서(f9) PEM */
  attestation(slot: PivSlot): Promise<{ attestation: string; intermediate: string }>;
}

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

/** 외부 명령 실행기. interactive면 표준 입출력을 터미널에 그대로 붙인다(PIN 입력). 시험은 가짜를 넣는다. */
export type Runner = (cmd: string, args: readonly string[], o: { interactive: boolean }) => Promise<{ code: number; stdout: string }>;

export const spawnRunner: Runner = (cmd, args, o) =>
  new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: o.interactive ? ['inherit', 'inherit', 'inherit'] : ['ignore', 'pipe', 'inherit'], shell: false });
    let out = '';
    p.stdout?.on('data', (d: Buffer) => (out += d.toString('utf8')));
    p.on('error', reject);
    p.on('close', (code) => resolve({ code: code ?? 1, stdout: out }));
  });

export interface YubiKeyOptions {
  /** ykcs11 라이브러리 경로(yubico-piv-tool 2.5 이상, macOS 예 /usr/local/lib/libykcs11.dylib, Windows 예 C:\Program Files\Yubico\Yubico PIV Tool\bin\libykcs11.dll) */
  module: string;
  /** 장치 일련번호(여러 대가 꽂혀 있을 때 ykman --device). PKCS#11 쪽은 tokenLabel로 고른다. */
  serial?: string;
  /** PKCS#11 토큰 이름(ykcs11은 "YubiKey PIV #<serial>"). 없으면 serial로 만든다. */
  tokenLabel?: string;
  ykman?: string;
  pkcs11Tool?: string;
  run?: Runner;
  /** 임시 파일 위치(기본 OS 임시 폴더 아래 0700 폴더). 서명 입력·서명만 잠시 둔다(비밀 아님). */
  tmpRoot?: string;
}

/**
 * YubiKey PIV(ykcs11 + OpenSC pkcs11-tool로 서명, ykman으로 공개키·증명).
 * 서명: pkcs11-tool --module M --token-label L --login --sign --mechanism EDDSA --id <ykcs11 id> --input-file in --output-file out
 *  - --pin을 넘기지 않는다(pkcs11-tool이 묻는다). 터치는 장치 LED가 깜빡일 때 보유자가 한다.
 */
export class YubiKeyPiv implements SigningDevice {
  private readonly o: YubiKeyOptions;
  private readonly run: Runner;
  constructor(o: YubiKeyOptions) {
    this.o = o;
    this.run = o.run ?? spawnRunner;
  }

  describe(): string {
    return `YubiKey PIV${this.o.serial ? ` #${this.o.serial}` : ''}`;
  }

  private ykman(args: string[]): string[] {
    return [...(this.o.serial ? ['--device', this.o.serial] : []), ...args];
  }

  private async tmp<T>(fn: (dir: string) => Promise<T>): Promise<T> {
    const dir = await fs.mkdtemp(path.join(this.o.tmpRoot ?? os.tmpdir(), 'sax-ceremony-'));
    await fs.chmod(dir, 0o700).catch(() => {});
    try {
      return await fn(dir);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  }

  async publicKey(slot: PivSlot): Promise<Buffer> {
    return this.tmp(async (dir) => {
      const out = path.join(dir, 'pub.pem');
      const r = await this.run(this.o.ykman ?? 'ykman', this.ykman(['piv', 'keys', 'export', slot, out]), { interactive: false });
      if (r.code !== 0) throw new CeremonyError('ceremony.device_failed', `ykman piv keys export ${slot}`);
      return rawEd25519FromSpki(await fs.readFile(out, 'utf8'));
    });
  }

  async attestation(slot: PivSlot): Promise<{ attestation: string; intermediate: string }> {
    return this.tmp(async (dir) => {
      const a = path.join(dir, 'attest.pem');
      const f9 = path.join(dir, 'f9.pem');
      const r1 = await this.run(this.o.ykman ?? 'ykman', this.ykman(['piv', 'keys', 'attest', slot, a]), { interactive: false });
      const r2 = await this.run(this.o.ykman ?? 'ykman', this.ykman(['piv', 'certificates', 'export', 'f9', f9]), { interactive: false });
      if (r1.code !== 0 || r2.code !== 0) throw new CeremonyError('ceremony.device_failed', 'ykman attest');
      return { attestation: await fs.readFile(a, 'utf8'), intermediate: await fs.readFile(f9, 'utf8') };
    });
  }

  async sign(slot: PivSlot, message: Buffer): Promise<Buffer> {
    if (message.length === 0 || message.length > MAX_SIGN_BYTES) throw new CeremonyError('ceremony.message_size');
    return this.tmp(async (dir) => {
      const inp = path.join(dir, 'tosign.bin');
      const out = path.join(dir, 'sig.bin');
      await fs.writeFile(inp, message, { mode: 0o600 });
      const label = this.o.tokenLabel ?? (this.o.serial ? `YubiKey PIV #${this.o.serial}` : undefined);
      const args = ['--module', this.o.module, ...(label ? ['--token-label', label] : []), '--login', '--sign', '--mechanism', 'EDDSA', '--id', ykcs11KeyId(slot), '--input-file', inp, '--output-file', out];
      const r = await this.run(this.o.pkcs11Tool ?? 'pkcs11-tool', args, { interactive: true });
      if (r.code !== 0) throw new CeremonyError('ceremony.device_failed', 'pkcs11-tool --sign');
      const sig = await fs.readFile(out);
      if (sig.length !== 64) throw new CeremonyError('ceremony.signature_invalid', `${sig.length}B`);
      return sig;
    });
  }
}
