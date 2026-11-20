import { createHash } from 'node:crypto';
import { constants as fsc, type BigIntStats, type Dirent } from 'node:fs';
import fsp, { type FileHandle } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { EventLog } from '@sax/platform';
import { NPKI_CERT_MAX_BYTES, type NpkiCertEntry, type NpkiListResult, type NpkiRootKind } from './protocol.ts';


export interface NpkiRoot {
  kind: NpkiRootKind;
  dir: string;
}

/** 표준 NPKI 위치(R3 §3, PyPinkSign 탐색 목록·KISA 경로). 이동식 저장소는 자동으로 훑지 않는다. */
export function npkiRoots(platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env, home = os.homedir()): NpkiRoot[] {
  if (platform === 'win32') {
    const p = path.win32;
    const profile = env.USERPROFILE || home;
    const out: NpkiRoot[] = [];
    if (profile) out.push({ kind: 'locallow', dir: p.join(profile, 'AppData', 'LocalLow', 'NPKI') });
    const pf = env.ProgramFiles || 'C:\\Program Files';
    out.push({ kind: 'program_files', dir: p.join(pf, 'NPKI') });
    return out;
  }
  if (!home) return [];
  const p = path.posix;
  if (platform === 'darwin') {
    return [
      { kind: 'preferences', dir: p.join(home, 'Library', 'Preferences', 'NPKI') },
      { kind: 'documents', dir: p.join(home, 'Documents', 'NPKI') },
      { kind: 'home', dir: p.join(home, 'NPKI') },
    ];
  }
  return [{ kind: 'home', dir: p.join(home, 'NPKI') }];
}

/** 시험에서 접근을 감사하려고 주입한다. 기본은 node:fs/promises. open은 signCert.der에만 쓴다. */
export interface NpkiFs {
  lstat(p: string): Promise<BigIntStats>;
  readdir(p: string): Promise<Dirent[]>;
  open(p: string, flags: number): Promise<FileHandle>;
}

export const nodeNpkiFs: NpkiFs = {
  lstat: (p) => fsp.lstat(p, { bigint: true }),
  readdir: (p) => fsp.readdir(p, { withFileTypes: true }),
  open: (p, flags) => fsp.open(p, flags),
};

/** 비신뢰 디렉터리라 크기를 묶는다. 실제 PC는 CA 몇 개·인증서 몇 개다. */
export const NPKI_LIMITS = { casPerRoot: 32, certsPerCa: 64, total: 128, entriesPerDir: 512 } as const;

const CERT_NAME = /^signcert\.der$/i;
const KEY_NAME = /^signpri\.key$/i;
const CA_NAME = /^[A-Za-z0-9][A-Za-z0-9._ -]{0,63}$/;
const NOFOLLOW = fsc.O_NOFOLLOW ?? 0;

export type NpkiSkip = keyof NpkiListResult['skipped'];

export interface NpkiScanOptions {
  roots?: NpkiRoot[];
  fs?: NpkiFs;
  log?: EventLog;
}

/** 표준 위치를 한 번 훑는다. 실패한 항목은 건너뛰고 이유별 개수만 센다. */
export async function scanNpki(o: NpkiScanOptions = {}): Promise<NpkiListResult> {
  const fs = o.fs ?? nodeNpkiFs;
  const roots = o.roots ?? npkiRoots();
  const certs: NpkiCertEntry[] = [];
  const skipped: Partial<Record<NpkiSkip, number>> = {};
  const skip = (why: NpkiSkip) => {
    skipped[why] = (skipped[why] ?? 0) + 1;
  };
  const seen = new Set<string>();
  let rootsFound = 0;

  for (const root of roots) {
    if (!(await isRealDir(fs, root.dir))) continue;
    rootsFound++;
    const cas = (await dirs(fs, root.dir, skip)).slice(0, NPKI_LIMITS.casPerRoot);
    for (const ca of cas) {
      if (!CA_NAME.test(ca)) {
        skip('bad_name');
        continue;
      }
      const caDir = await dirEntries(fs, path.join(root.dir, ca));
      const user = caDir?.find((d) => d.name.toUpperCase() === 'USER');
      if (!user) continue;
      if (user.isSymbolicLink()) {
        skip('symlink');
        continue;
      }
      if (!user.isDirectory()) continue;
      const realUser = path.join(root.dir, ca, user.name);
      const certDirs = (await dirs(fs, realUser, skip)).slice(0, NPKI_LIMITS.certsPerCa);
      for (const name of certDirs) {
        if (certs.length >= NPKI_LIMITS.total) {
          skip('limit');
          break;
        }
        const dir = path.join(realUser, name);
        const files = await dirEntries(fs, dir);
        if (!files) {
          skip('unreadable');
          continue;
        }
        const certEnt = files.find((f) => CERT_NAME.test(f.name));
        if (!certEnt) continue;
        const hasKey = files.some((f) => KEY_NAME.test(f.name) && f.isFile());
        const read = await readCert(fs, path.join(dir, certEnt.name), certEnt);
        if (typeof read === 'string') {
          skip(read);
          continue;
        }
        const id = createHash('sha256').update(dir).digest('hex').slice(0, 16);
        if (seen.has(id)) continue;
        seen.add(id);
        certs.push({ id, root: root.kind, ca, dir, certFile: certEnt.name, certDer: read, hasKey });
      }
    }
  }
  o.log?.event('vault.npki_listed', { roots: rootsFound, certs: certs.length, skipped: Object.values(skipped).reduce((a, b) => a + (b ?? 0), 0) });
  return { certs, skipped };
}

export type NpkiPairRead = { ok: true; der: Uint8Array; key: Uint8Array } | { ok: false; reason: 'not_found' | 'no_key' | NpkiSkip };

/**
 * 고른 인증서 하나(id = scanNpki의 id)의 signCert.der와 signPri.key를 읽는다(D05 §6 (3)의 CODEF 예외). 열거·링크·바꿔치기·크기 검사는
 * scanNpki·readCert와 같다. 다른 인증서 폴더의 개인키는 열지 않는다. 로그에는 결과만 남긴다(경로·id 없음).
 */
export async function readNpkiLoginPair(certId: string, o: NpkiScanOptions = {}): Promise<NpkiPairRead> {
  if (!/^[0-9a-f]{16}$/.test(certId)) return { ok: false, reason: 'not_found' };
  const fs = o.fs ?? nodeNpkiFs;
  const listed = await scanNpki({ roots: o.roots, fs });
  const hit = listed.certs.find((c) => c.id === certId);
  if (!hit) return { ok: false, reason: 'not_found' };
  if (!hit.hasKey) return { ok: false, reason: 'no_key' };
  const files = await dirEntries(fs, hit.dir);
  const keyEnt = files?.find((f) => KEY_NAME.test(f.name));
  if (!keyEnt) return { ok: false, reason: 'no_key' };
  const key = await readCert(fs, path.join(hit.dir, keyEnt.name), keyEnt);
  if (typeof key === 'string') return { ok: false, reason: key };
  return { ok: true, der: hit.certDer, key };
}

async function isRealDir(fs: NpkiFs, p: string): Promise<boolean> {
  try {
    const st = await fs.lstat(p);
    return st.isDirectory() && !st.isSymbolicLink();
  } catch {
    return false;
  }
}

async function dirEntries(fs: NpkiFs, p: string): Promise<Dirent[] | null> {
  try {
    return (await fs.readdir(p)).slice(0, NPKI_LIMITS.entriesPerDir);
  } catch {
    return null;
  }
}

async function dirs(fs: NpkiFs, p: string, skip: (w: NpkiSkip) => void): Promise<string[]> {
  const ents = await dirEntries(fs, p);
  if (!ents) return [];
  const out: string[] = [];
  for (const d of ents) {
    if (d.isSymbolicLink()) skip('symlink');
    else if (d.isDirectory()) out.push(d.name);
  }
  return out.sort();
}

async function readCert(fs: NpkiFs, file: string, ent: Dirent): Promise<Uint8Array | NpkiSkip> {
  if (ent.isSymbolicLink()) return 'symlink';
  if (!ent.isFile()) return 'not_file';
  let before: BigIntStats;
  try {
    before = await fs.lstat(file);
  } catch {
    return 'unreadable';
  }
  if (before.isSymbolicLink()) return 'symlink';
  if (!before.isFile()) return 'not_file';
  if (before.size > BigInt(NPKI_CERT_MAX_BYTES)) return 'too_large';
  if (before.size === 0n) return 'empty';
  let fh: FileHandle;
  try {
    fh = await fs.open(file, fsc.O_RDONLY | NOFOLLOW);
  } catch {
    return 'unreadable';
  }
  try {
    const st = await fh.stat({ bigint: true });
    if (!st.isFile() || st.ino === 0n || st.dev !== before.dev || st.ino !== before.ino) return 'changed';
    if (st.nlink > 1n) return 'linked';
    if (st.size > BigInt(NPKI_CERT_MAX_BYTES)) return 'too_large';
    const buf = Buffer.alloc(NPKI_CERT_MAX_BYTES + 1);
    let n = 0;
    while (n < buf.length) {
      const { bytesRead } = await fh.read(buf, n, buf.length - n, n);
      if (bytesRead === 0) break;
      n += bytesRead;
    }
    if (n > NPKI_CERT_MAX_BYTES) return 'too_large';
    if (n === 0) return 'empty';
    return new Uint8Array(buf.subarray(0, n));
  } catch {
    return 'unreadable';
  } finally {
    await fh.close().catch(() => {});
  }
}
