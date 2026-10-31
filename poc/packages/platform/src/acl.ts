import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

// D07 §1.1: 루트 DACL = 소유자 + SYSTEM, 상속 차단. 매 기동 시 확인하고 다르면 복구·경고.
// D05 §3.1: 경로의 어느 구성 요소도 재분석 지점(심볼릭 링크·정션)이 아니어야 한다.
export type AclProblem = 'missing' | 'not_dir' | 'reparse_point' | 'not_owner' | 'others_access' | 'inherited' | 'extra_principal';

export interface AclCheck {
  ok: boolean;
  problems: AclProblem[];
}

export interface DirGuard {
  /** 없으면 만들고, 사용자 전용으로 설정한 뒤 다시 읽어 확인한다. */
  ensurePrivate(dir: string): Promise<AclCheck>;
  checkPrivate(dir: string): Promise<AclCheck>;
  /** 검색 색인 제외(Windows FILE_ATTRIBUTE_NOT_CONTENT_INDEXED, macOS Spotlight). */
  excludeFromIndex(dir: string): Promise<void>;
}

/** 경로의 각 구성 요소를 lstat로 확인한다. Windows에서 Node는 정션도 심볼릭 링크로 보고한다. */
export async function findReparsePoint(p: string): Promise<string | null> {
  const abs = path.resolve(p);
  const { root } = path.parse(abs);
  let cur = root;
  for (const part of abs.slice(root.length).split(path.sep).filter(Boolean)) {
    cur = path.join(cur, part);
    let st;
    try {
      st = await fs.lstat(cur);
    } catch {
      return null; // 아직 없는 꼬리 구성 요소
    }
    if (st.isSymbolicLink()) return cur;
  }
  return null;
}

class PosixDirGuard implements DirGuard {
  async ensurePrivate(dir: string): Promise<AclCheck> {
    const rp = await findReparsePoint(dir);
    if (rp) return { ok: false, problems: ['reparse_point'] };
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    await fs.chmod(dir, 0o700);
    return this.checkPrivate(dir);
  }

  async checkPrivate(dir: string): Promise<AclCheck> {
    const problems: AclProblem[] = [];
    if (await findReparsePoint(dir)) problems.push('reparse_point');
    let st;
    try {
      st = await fs.lstat(dir);
    } catch {
      return { ok: false, problems: ['missing'] };
    }
    if (!st.isDirectory()) problems.push('not_dir');
    if (typeof process.getuid === 'function' && st.uid !== process.getuid()) problems.push('not_owner');
    if ((st.mode & 0o077) !== 0) problems.push('others_access');
    if (process.platform === 'darwin' && (await hasDarwinAcl(dir))) problems.push('extra_principal');
    return { ok: problems.length === 0, problems };
  }

  async excludeFromIndex(dir: string): Promise<void> {
    if (process.platform === 'darwin') await fs.writeFile(path.join(dir, '.metadata_never_index'), '');
  }
}

async function hasDarwinAcl(dir: string): Promise<boolean> {
  const { stdout } = await run('/bin/ls', ['-led', dir]);
  // 첫 줄은 권한 줄, ACL 항목은 " 0: ..." 형태로 이어진다.
  return stdout.split('\n').some((l) => /^\s*\d+: /.test(l));
}

// Windows 도구는 PATH가 아니라 System32 절대 경로로 부른다. PATH 앞에 Git의 whoami 같은 같은 이름 도구가 있으면 그것이 돈다(PoC-1 실측).
export function windowsTool(exe: string): string {
  return path.win32.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', exe);
}

// SDDL 별칭 → SID. /remove에 넘길 때만 쓴다. 모르는 별칭은 지우지 못하고 extra_principal로 남는다(실패 닫힘).
const SDDL_ALIASES: Record<string, string> = {
  SY: 'S-1-5-18', BA: 'S-1-5-32-544', BU: 'S-1-5-32-545', BG: 'S-1-5-32-546', PU: 'S-1-5-32-547',
  AU: 'S-1-5-11', WD: 'S-1-1-0', IU: 'S-1-5-4', AN: 'S-1-5-7', LS: 'S-1-5-19', NS: 'S-1-5-20',
  CO: 'S-1-3-0', CG: 'S-1-3-1', OW: 'S-1-3-4', AC: 'S-1-15-2-1',
};

export interface DaclEntry {
  type: string;
  flags: string[];
  sid: string;
}

/**
 * icacls 출력의 계정 이름은 콘솔 코드 페이지(한글 Windows는 CP949)로 나와 한글 사용자 이름이면 비교가 깨진다.
 * `/save`는 SDDL(UTF-16LE)로 SID를 그대로 주므로 SID로 판정한다.
 */
export async function readDacl(dir: string): Promise<{ protected: boolean; aces: DaclEntry[] }> {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'sax-acl-'));
  try {
    const out = path.join(tmp, 'acl.txt');
    await run(windowsTool('icacls.exe'), [dir, '/save', out]);
    const sddl = (await fs.readFile(out, 'utf16le')).split(/\r?\n/).find((l) => l.startsWith('D:')) ?? '';
    const aces = [...sddl.matchAll(/\(([^;()]*);([^;()]*);[^;()]*;[^;()]*;[^;()]*;([^;()]*)\)/g)].map((m) => ({
      type: m[1] ?? '',
      flags: (m[2] ?? '').match(/../g) ?? [],
      sid: m[3] ?? '',
    }));
    return { protected: /^D:[A-Z]*P/.test(sddl), aces };
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
}

const isSystem = (sid: string): boolean => sid === 'SY' || sid === 'S-1-5-18';

class WindowsDirGuard implements DirGuard {
  private async userSid(): Promise<string> {
    const { stdout } = await run(windowsTool('whoami.exe'), ['/user', '/fo', 'csv', '/nh']);
    const sid = stdout.trim().split(',').pop()?.replace(/"/g, '');
    if (!sid?.startsWith('S-1-')) throw new Error('cannot resolve user SID');
    return sid;
  }

  async ensurePrivate(dir: string): Promise<AclCheck> {
    if (await findReparsePoint(dir)) return { ok: false, problems: ['reparse_point'] };
    await fs.mkdir(dir, { recursive: true });
    const sid = await this.userSid();
    const icacls = windowsTool('icacls.exe');
    await run(icacls, [dir, '/inheritance:r', '/grant:r', `*${sid}:(OI)(CI)F`, '/grant:r', '*S-1-5-18:(OI)(CI)F']);
    // 상속을 끊어도 명시 ACE(누가 직접 추가한 Users 읽기 등)는 남는다. 사용자·SYSTEM 밖은 지운다.
    const extra = new Set((await readDacl(dir)).aces.map((a) => a.sid).filter((s) => s !== sid && !isSystem(s)));
    const removable = [...extra].map((s) => (s.startsWith('S-1-') ? s : SDDL_ALIASES[s])).filter((s): s is string => !!s);
    if (removable.length) await run(icacls, [dir, '/remove', ...removable.map((s) => `*${s}`)]);
    return this.checkPrivate(dir);
  }

  async checkPrivate(dir: string): Promise<AclCheck> {
    const problems: AclProblem[] = [];
    if (await findReparsePoint(dir)) problems.push('reparse_point');
    let st;
    try {
      st = await fs.lstat(dir);
    } catch {
      return { ok: false, problems: ['missing'] };
    }
    if (!st.isDirectory()) problems.push('not_dir');
    const sid = await this.userSid();
    const dacl = await readDacl(dir);
    if (!dacl.protected || dacl.aces.some((a) => a.flags.includes('ID'))) problems.push('inherited');
    if (dacl.aces.some((a) => a.type !== 'A' || (a.sid !== sid && !isSystem(a.sid)))) problems.push('extra_principal');
    return { ok: problems.length === 0, problems };
  }

  async excludeFromIndex(dir: string): Promise<void> {
    await run(windowsTool('attrib.exe'), ['+I', dir]);
  }
}

export function dirGuard(platform: NodeJS.Platform = process.platform): DirGuard {
  return platform === 'win32' ? new WindowsDirGuard() : new PosixDirGuard();
}
