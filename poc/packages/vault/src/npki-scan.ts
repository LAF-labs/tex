import { createHash } from 'node:crypto';
import { constants as fsc, type BigIntStats, type Dirent } from 'node:fs';
import fsp, { type FileHandle } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { EventLog } from '@sax/platform';
import { NPKI_CERT_MAX_BYTES, type NpkiCertEntry, type NpkiListResult, type NpkiRootKind } from './protocol.ts';

// 공동인증서(NPKI) 탐지(D05 §6 허용 동작, A-28). 이 파일 밖의 NPKI 접근은 없다.
//   (1) NPKI 디렉터리 열거
//   (2) signCert.der(공개 인증서) 바이트만 읽는다. 파싱하지 않는다(docparse 샌드박스 certInfo, ADR-014·D17 §3)
//   (3) signPri.key는 이름으로 있는지만 본다. 열지도 stat하지도 않는다
//   (4) 감시하지 않는다(부를 때 한 번 읽는다)
//   (5) 경로·파일명·CA 이름은 로그에 남기지 않는다(개수만)
// LocalLow는 낮은 무결성 프로세스도 쓸 수 있는 위치라 내용과 구조를 비신뢰로 다룬다.
// 심볼릭 링크(디렉터리·파일 모두)는 따라가지 않고, 연 파일이 열거한 파일과 같은지(dev·ino, bigint) 확인한다.
// Windows의 ino는 64비트 NTFS 파일 ID라 Number로 받으면 2^53 위에서 뭉개져 다른 파일이 같아 보인다(Windows CI에서 바꿔치기를 놓쳤다).

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
  /** bigint로 돌려준다(dev·ino 비교, Windows 64비트 파일 ID). */
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
/** CA 폴더 이름(yessign·CrossCert·SignKorea·KICA·TradeSign·NCASign 등). 인쇄 가능한 ASCII만. */
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
      // USER는 이름 대소문자가 섞여 오기도 한다. 링크가 아닌 디렉터리만.
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
        // signPri.key는 이름이 있는 일반 파일 항목인지만 본다(열지 않음, D05 §6 (3)).
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

/** 링크가 아닌 하위 디렉터리 이름(정렬). */
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

/** signCert.der만 연다. 링크·특수 파일·바꿔치기·하드링크·크기 초과는 읽지 않는다. */
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
    // 열거와 열기 사이에 바뀌었으면(링크 바꿔치기) 버린다. 하드링크(다른 파일과 같은 내용)도 받지 않는다.
    // 파일 ID를 주지 않는 파일 시스템(ino 0)은 같은 파일인지 알 수 없으니 바뀐 것으로 본다.
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
