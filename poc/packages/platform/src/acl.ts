import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
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

// Windows 구현: PoC-1(Windows 11 VM) 전에는 검증하지 않았다. 인터페이스와 명령 구성만 둔다.
class WindowsDirGuard implements DirGuard {
  private async userSid(): Promise<string> {
    const { stdout } = await run('whoami', ['/user', '/fo', 'csv', '/nh']);
    const sid = stdout.trim().split(',').pop()?.replace(/"/g, '');
    if (!sid?.startsWith('S-1-')) throw new Error('cannot resolve user SID');
    return sid;
  }

  async ensurePrivate(dir: string): Promise<AclCheck> {
    if (await findReparsePoint(dir)) return { ok: false, problems: ['reparse_point'] };
    await fs.mkdir(dir, { recursive: true });
    const sid = await this.userSid();
    await run('icacls', [dir, '/inheritance:r', '/grant:r', `*${sid}:(OI)(CI)F`, '/grant:r', '*S-1-5-18:(OI)(CI)F']);
    return this.checkPrivate(dir);
  }

  async checkPrivate(dir: string): Promise<AclCheck> {
    const problems: AclProblem[] = [];
    if (await findReparsePoint(dir)) problems.push('reparse_point');
    try {
      await fs.access(dir);
    } catch {
      return { ok: false, problems: ['missing'] };
    }
    const sid = await this.userSid();
    const { stdout } = await run('icacls', [dir, '/q']);
    const aces = stdout.split(/\r?\n/).slice(0, -1).map((l) => l.replace(dir, '').trim()).filter((l) => l.includes(':('));
    if (aces.some((a) => a.includes('(I)'))) problems.push('inherited');
    const sids = await Promise.all(aces.map(async (a) => a.split(':(')[0] ?? ''));
    const { stdout: me } = await run('whoami');
    const allowed = new Set([me.trim().toLowerCase(), 'nt authority\\system', `*${sid}`.toLowerCase(), '*s-1-5-18']);
    if (sids.some((s) => !allowed.has(s.toLowerCase()))) problems.push('extra_principal');
    return { ok: problems.length === 0, problems };
  }

  async excludeFromIndex(dir: string): Promise<void> {
    await run('attrib', ['+I', dir]);
  }
}

export function dirGuard(platform: NodeJS.Platform = process.platform): DirGuard {
  return platform === 'win32' ? new WindowsDirGuard() : new PosixDirGuard();
}
