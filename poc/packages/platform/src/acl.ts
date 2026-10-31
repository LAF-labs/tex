import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

// D07 §1.1: 루트 DACL = 소유자 + SYSTEM, 상속 차단. 매 기동 시 확인하고 다르면 복구·경고.
// D05 §3.1: 경로의 어느 구성 요소도 재분석 지점(심볼릭 링크·정션)이 아니어야 한다.
// unreadable: 확인·복구 도구가 그 폴더에서 실패했다(접근 거부 등). 부모 확인은 통과할 때만 쓴다(preparePrivateDir).
export type AclProblem = 'missing' | 'not_dir' | 'reparse_point' | 'not_owner' | 'others_access' | 'inherited' | 'extra_principal' | 'unreadable';

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
    // macOS ACL 항목(누구나 거부·허용)은 모드 비트와 따로 남는다. 지우지 않으면 extra_principal이 남고, 거부 항목은 이름 바꾸기도 막는다(실측).
    if (process.platform === 'darwin') await run('/bin/chmod', ['-N', dir]);
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

export interface Dacl {
  protected: boolean;
  aces: DaclEntry[];
}

/**
 * `icacls /save`가 쓰는 SDDL 한 줄(`D:PAI(...)(...)S:AI(ML;...)`)에서 DACL만 읽는다.
 * ACE는 최상위 괄호 단위로 나눈다. 조건부 ACE(`XA;...;WD;(조건)`)도 한 항목으로 남아야 빠뜨리지 않는다.
 * 읽지 못한 ACE와 null DACL(`NO_ACCESS_CONTROL`, 누구나 접근)은 SID `?`·`WD` 항목으로 남겨 판정에서 걸리게 한다.
 */
export function parseDacl(sddl: string): Dacl {
  const start = sddl.indexOf('D:');
  if (start < 0) return { protected: false, aces: [{ type: '?', flags: [], sid: '?' }] };
  const aceTexts: string[] = [];
  let header = '';
  let depth = 0;
  let from = -1;
  for (let i = start + 2; i < sddl.length; i++) {
    const ch = sddl[i];
    if (depth === 0 && ch !== '(') {
      if (sddl.startsWith('S:', i) || sddl.startsWith('O:', i) || sddl.startsWith('G:', i)) break; // SACL(무결성 레이블 등)은 보지 않는다
      if (aceTexts.length === 0) header += ch;
      continue;
    }
    if (ch === '(' && depth++ === 0) from = i + 1;
    else if (ch === ')' && --depth === 0) aceTexts.push(sddl.slice(from, i));
  }
  const aces = aceTexts.map((t) => {
    const f = t.split(';');
    if (f.length < 6 || !f[5]) return { type: '?', flags: [], sid: '?' };
    return { type: f[0] ?? '?', flags: (f[1] ?? '').match(/../g) ?? [], sid: f[5] };
  });
  if (depth !== 0) aces.push({ type: '?', flags: [], sid: '?' });
  if (header.includes('NO_ACCESS_CONTROL')) aces.push({ type: 'A', flags: [], sid: 'WD' });
  return { protected: /^[A-Z]*P/.test(header), aces };
}

/**
 * icacls 출력의 계정 이름은 콘솔 코드 페이지(한글 Windows는 CP949)로 나와 한글 사용자 이름이면 비교가 깨진다.
 * `/save`는 SDDL(UTF-16LE)로 SID를 그대로 주므로 SID로 판정한다.
 */
export async function readDacl(target: string): Promise<Dacl> {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'sax-acl-'));
  try {
    const out = path.join(tmp, 'acl.txt');
    await run(windowsTool('icacls.exe'), [target, '/save', out]);
    return parseDacl((await fs.readFile(out, 'utf16le')).split(/\r?\n/).find((l) => l.startsWith('D:')) ?? '');
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
}

/** 소유자 SID. `icacls /save`에는 소유자가 없어 .NET으로 읽는다(PowerShell 기동 약 0.3초, PoC-1 실측). 경로는 환경 변수로 넘긴다. */
export async function readOwner(target: string): Promise<string> {
  const script = '$o = (Get-Acl -LiteralPath $env:SAX_ACL_TARGET).GetOwner([System.Security.Principal.SecurityIdentifier]); if ($o) { $o.Value }';
  const { stdout } = await run(windowsTool('WindowsPowerShell\\v1.0\\powershell.exe'), ['-NoProfile', '-NonInteractive', '-Command', script], { env: { ...process.env, SAX_ACL_TARGET: target } });
  return stdout.trim();
}

/**
 * 소유자는 DACL과 무관하게 DACL을 다시 쓸 수 있다(암묵적 WRITE_DAC). 다른 계정이 먼저 만든 폴더면 우리가 고쳐도 그 계정이 다시 연다(PoC-1 S6m 보조 볼륨).
 * Administrators·SYSTEM은 소유권을 가져오는 특권이 이미 있어 소유자여도 더해지는 힘이 없으므로 받아들인다. 승격 상태에서 만든 폴더의 기본 소유자가 Administrators다.
 */
export function isTrustedOwner(owner: string, userSid: string): boolean {
  return owner === userSid || owner === 'S-1-5-18' || owner === 'S-1-5-32-544';
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
    // 다른 계정 소유 폴더의 DACL은 고쳐 쓰지 않는다. 고쳐도 소유자가 다시 열 수 있다(실패 닫힘).
    if (!isTrustedOwner(await readOwner(dir), sid)) return this.checkPrivate(dir);
    const icacls = windowsTool('icacls.exe');
    await run(icacls, [dir, '/inheritance:r', '/grant:r', `*${sid}:(OI)(CI)F`, '/grant:r', '*S-1-5-18:(OI)(CI)F']);
    // 상속을 끊어도 명시 ACE(누가 직접 추가한 Users 읽기 등)는 남는다. 사용자·SYSTEM 밖은 지운다.
    const extra = new Set((await readDacl(dir)).aces.map((a) => a.sid).filter((s) => s !== sid && !isSystem(s)));
    const removable = [...extra].map((s) => (s.startsWith('S-1-') ? s : SDDL_ALIASES[s])).filter((s): s is string => !!s);
    if (removable.length) await run(icacls, [dir, '/remove', ...removable.map((s) => `*${s}`)]);
    const check = await this.checkPrivate(dir);
    if (check.ok || check.problems.includes('reparse_point') || check.problems.includes('not_dir')) return check;
    // icacls는 조건부(콜백) ACE 등을 지우지 못한다(PoC-1 실측). 남으면 DACL 전체를 바꾼다.
    // Get-Acl 객체는 SACL까지 쓰려 해 SeSecurityPrivilege가 필요하므로 DACL만 담은 새 객체로 쓴다. 경로는 환경 변수로 넘긴다.
    const script = `$s = New-Object System.Security.AccessControl.DirectorySecurity; $s.SetSecurityDescriptorSddlForm('D:PAI(A;OICI;FA;;;SY)(A;OICI;FA;;;${sid})', 'Access'); [System.IO.Directory]::SetAccessControl($env:SAX_ACL_TARGET, $s)`;
    await run(windowsTool('WindowsPowerShell\\v1.0\\powershell.exe'), ['-NoProfile', '-NonInteractive', '-Command', script], { env: { ...process.env, SAX_ACL_TARGET: dir } });
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
    if (!isTrustedOwner(await readOwner(dir), sid)) problems.push('not_owner');
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
