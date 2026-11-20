import { execFile, type ExecFileOptions } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/**
 * 읽기 도구(whoami·icacls /save·Get-Acl·ls) 하나의 상한. 멈추면(PowerShell 등) 앱 기동이나 Chrome 기동이 끝나지 않으므로, 넘으면 죽이고 실패로 돌려준다.
 * 고치는 도구(icacls /grant·/remove, SetAccessControl)에는 두지 않는다(REPAIR). 폴더 DACL을 먼저 쓰고 하위로 전파하므로,
 * 도중에 죽이면 최상위만 고쳐진 채 확인을 통과하고 하위에는 옛 상속 ACE가 남는다.
 */
export const TOOL_TIMEOUT_MS = 30_000;
/**
 * 소유자 읽기(PowerShell Get-Acl) 상한(ADR-041). 느린 Windows PC에서 PowerShell 기동이 3.4~15초, 부하 때는 30초를 넘었다(WIN-REALDEVICE §6.1).
 * 소유자는 폴더 식별마다 프로세스당 한 번만 읽으므로(OwnerMemo) 다른 읽기 도구보다 길게 둔다.
 */
export const OWNER_TIMEOUT_MS = 90_000;
const REPAIR: ExecFileOptions = { timeout: 0 };

function run(file: string, args: string[], opts: ExecFileOptions = {}): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync(file, args, { timeout: TOOL_TIMEOUT_MS, ...opts, encoding: 'utf8' });
}

export type AclProblem = 'missing' | 'not_dir' | 'reparse_point' | 'not_owner' | 'others_access' | 'no_user_access' | 'inherited' | 'extra_principal' | 'unreadable';

export interface AclCheck {
  ok: boolean;
  problems: AclProblem[];
}

export interface DirGuard {
  ensurePrivate(dir: string): Promise<AclCheck>;
  checkPrivate(dir: string): Promise<AclCheck>;
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
      return null;
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
    if ((st.mode & 0o700) !== 0o700) problems.push('no_user_access');
    if (process.platform === 'darwin' && (await hasDarwinAcl(dir))) problems.push('extra_principal');
    return { ok: problems.length === 0, problems };
  }

  async excludeFromIndex(dir: string): Promise<void> {
    if (process.platform === 'darwin') await fs.writeFile(path.join(dir, '.metadata_never_index'), '');
  }
}

async function hasDarwinAcl(dir: string): Promise<boolean> {
  const { stdout } = await run('/bin/ls', ['-led', dir]);
  return stdout.split('\n').some((l) => /^\s*\d+: /.test(l));
}

export function windowsTool(exe: string): string {
  return path.win32.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', exe);
}

/**
 * Windows PowerShell 5.1(System32 powershell.exe)에 넘길 환경. PSModulePath는 빼서 5.1이 자기 기본 경로를 다시 만들게 한다.
 * PowerShell 7(pwsh)에서 앱을 띄우면 PSModulePath가 7의 모듈 폴더를 가리킨 채 상속되고, 5.1이 Microsoft.PowerShell.Security를
 * 7의 판으로 읽으려다 실패해 Get-Acl 등을 못 쓴다("module could not be loaded", windows-latest CI에서 확인).
 */
export function windowsPowerShellEnv(extra: Record<string, string>, base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(base)) if (k.toLowerCase() !== 'psmodulepath') env[k] = v;
  return { ...env, ...extra };
}

const SDDL_ALIASES: Record<string, string> = {
  SY: 'S-1-5-18', BA: 'S-1-5-32-544', BU: 'S-1-5-32-545', BG: 'S-1-5-32-546', PU: 'S-1-5-32-547',
  AU: 'S-1-5-11', WD: 'S-1-1-0', IU: 'S-1-5-4', AN: 'S-1-5-7', LS: 'S-1-5-19', NS: 'S-1-5-20',
  CO: 'S-1-3-0', CG: 'S-1-3-1', OW: 'S-1-3-4', AC: 'S-1-15-2-1',
};

export interface DaclEntry {
  type: string;
  flags: string[];
  rights: string;
  sid: string;
}

export interface Dacl {
  protected: boolean;
  aces: DaclEntry[];
}

const unreadableAce = (): DaclEntry => ({ type: '?', flags: [], rights: '', sid: '?' });

/**
 * `icacls /save`가 쓰는 SDDL 한 줄(`D:PAI(...)(...)S:AI(ML;...)`)에서 DACL만 읽는다.
 * ACE는 최상위 괄호 단위로 나눈다. 조건부 ACE(`XA;...;WD;(조건)`)도 한 항목으로 남아야 빠뜨리지 않는다.
 * 읽지 못한 ACE와 null DACL(`NO_ACCESS_CONTROL`, 누구나 접근)은 SID `?`·`WD` 항목으로 남겨 판정에서 걸리게 한다.
 */
export function parseDacl(sddl: string): Dacl {
  const start = sddl.indexOf('D:');
  if (start < 0) return { protected: false, aces: [unreadableAce()] };
  const aceTexts: string[] = [];
  let header = '';
  let depth = 0;
  let from = -1;
  for (let i = start + 2; i < sddl.length; i++) {
    const ch = sddl[i];
    if (depth === 0 && ch !== '(') {
      if (sddl.startsWith('S:', i) || sddl.startsWith('O:', i) || sddl.startsWith('G:', i)) break;
      if (aceTexts.length === 0) header += ch;
      continue;
    }
    if (ch === '(' && depth++ === 0) from = i + 1;
    else if (ch === ')' && --depth === 0) aceTexts.push(sddl.slice(from, i));
  }
  const aces = aceTexts.map((t) => {
    const f = t.split(';');
    if (f.length < 6 || !f[5]) return unreadableAce();
    return { type: f[0] ?? '?', flags: (f[1] ?? '').match(/../g) ?? [], rights: f[2] ?? '', sid: f[5] };
  });
  if (depth !== 0) aces.push(unreadableAce());
  if (header.includes('NO_ACCESS_CONTROL')) aces.push({ type: 'A', flags: [], rights: 'FA', sid: 'WD' });
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

/**
 * 소유자 SID. `icacls /save`에는 소유자가 없어 .NET으로 읽는다. 경로는 환경 변수로 넘긴다.
 * PoC-1 PC에서는 PowerShell 기동이 약 0.3초였지만 느린 PC에서는 3.4~15초다(WIN-REALDEVICE §6.1). 그래서 직접 부르지 않고 OwnerMemo를 거친다(ADR-041).
 */
export async function readOwner(target: string): Promise<string> {
  const script = '$o = (Get-Acl -LiteralPath $env:SAX_ACL_TARGET).GetOwner([System.Security.Principal.SecurityIdentifier]); if ($o) { $o.Value }';
  const { stdout } = await run(windowsTool('WindowsPowerShell\\v1.0\\powershell.exe'), ['-NoProfile', '-NonInteractive', '-Command', script], { timeout: OWNER_TIMEOUT_MS, env: windowsPowerShellEnv({ SAX_ACL_TARGET: target }) });
  return stdout.trim();
}

/**
 * 폴더 식별: 볼륨·파일 ID·생성 시각(ns). 지우고 같은 이름으로 다시 만들면 바뀐다. 링크·파일이거나 파일 ID를 주지 않는 파일 시스템(0)이면 null.
 */
export async function dirIdentity(dir: string): Promise<string | null> {
  const st = await fs.lstat(dir, { bigint: true }).catch(() => null);
  if (!st || !st.isDirectory() || st.ino === 0n) return null;
  return `${st.dev}:${st.ino}:${st.birthtimeNs}`;
}

/**
 * 신뢰 소유자 확인을 폴더 식별마다 프로세스당 한 번으로 줄인다(ADR-041).
 * - 근거: 사용자 전용 DACL(사용자·SYSTEM만, checkPrivate가 매번 icacls로 확인)이면 소유자를 남에게 넘길 수 있는 것은 사용자·SYSTEM·관리자 특권뿐이다.
 *   모두 isTrustedOwner가 이미 믿는 쪽이다. 그래서 한 번 신뢰 소유자로 확인한 폴더는, 같은 폴더(식별 동일)인 동안 다시 읽지 않아도 판정이 같다.
 * - 신뢰 소유자만 기억한다. 남의 소유는 매번 다시 읽는다(관리자가 소유권을 고친 뒤 다시 시도하면 통한다).
 * - 같은 폴더를 동시에 물으면 읽기 하나를 같이 기다린다(금고 미리 확인과 Chrome 기동이 겹칠 때). 읽기가 실패하면 기억하지 않는다.
 */
export class OwnerMemo {
  private readonly trusted = new Map<string, string>();
  private readonly inflight = new Map<string, Promise<string>>();
  private readonly read: (dir: string) => Promise<string>;
  private readonly identity: (dir: string) => Promise<string | null>;
  constructor(read: (dir: string) => Promise<string> = readOwner, identity: (dir: string) => Promise<string | null> = dirIdentity) {
    this.read = read;
    this.identity = identity;
  }

  async isTrusted(dir: string, userSid: string): Promise<boolean> {
    const id = await this.identity(dir);
    const known = id ? this.trusted.get(id) : undefined;
    if (known !== undefined && isTrustedOwner(known, userSid)) return true;
    const key = id ?? `path:${path.resolve(dir)}`;
    let pending = this.inflight.get(key);
    if (!pending) {
      pending = this.read(dir).finally(() => this.inflight.delete(key));
      this.inflight.set(key, pending);
    }
    const owner = await pending;
    const ok = isTrustedOwner(owner, userSid);
    if (ok && id && (await this.identity(dir)) === id) this.trusted.set(id, owner);
    return ok;
  }

  get size(): number {
    return this.trusted.size;
  }
}

const ownerMemo = new OwnerMemo();

/**
 * 소유자는 DACL과 무관하게 DACL을 다시 쓸 수 있다(암묵적 WRITE_DAC). 다른 계정이 먼저 만든 폴더면 우리가 고쳐도 그 계정이 다시 연다(PoC-1 S6m 보조 볼륨).
 * Administrators·SYSTEM은 소유권을 가져오는 특권이 이미 있어 소유자여도 더해지는 힘이 없으므로 받아들인다. 승격 상태에서 만든 폴더의 기본 소유자가 Administrators다.
 */
export function isTrustedOwner(owner: string, userSid: string): boolean {
  return owner === userSid || owner === 'S-1-5-18' || owner === 'S-1-5-32-544';
}

const isSystem = (sid: string): boolean => sid === 'SY' || sid === 'S-1-5-18';

/**
 * ACE의 SID가 현재 사용자인지. SDDL은 이 컴퓨터의 기본 제공 Administrator(RID 500)·Guest(RID 501)를 전체 SID 대신 `LA`·`LG`로 쓴다
 * (GitHub windows-latest 러너 계정 runneradmin이 RID 500이다). 별칭은 이 컴퓨터 계정만 뜻하므로 로컬 계정일 때만 같다고 본다.
 */
export function isUserSid(aceSid: string, userSid: string, local: boolean): boolean {
  if (aceSid === userSid) return true;
  if (!local || !/^S-1-5-21-\d+-\d+-\d+-50[01]$/.test(userSid)) return false;
  return aceSid === (userSid.endsWith('-500') ? 'LA' : 'LG');
}

/**
 * 사용자에게 이 폴더와 하위 전체의 모든 권한을 주는 ACE가 있는지. ensurePrivate가 쓰는 `(A;OICI;FA;;;<사용자>)` 모양이다.
 * 상속 전용(IO)은 폴더 자체에 효력이 없다. ACE가 하나도 없는 보호 DACL(복구가 끊긴 흔적 등)도 여기서 걸린다.
 */
export function grantsUserFullControl(dacl: Dacl, userSid: string, local = false): boolean {
  return dacl.aces.some((a) => a.type === 'A' && isUserSid(a.sid, userSid, local) && /^(FA|0x1f01ff)$/i.test(a.rights) && a.flags.includes('OI') && a.flags.includes('CI') && !a.flags.includes('IO'));
}

let userOnce: Promise<{ sid: string; local: boolean }> | null = null;

class WindowsDirGuard implements DirGuard {
  private user(): Promise<{ sid: string; local: boolean }> {
    userOnce ??= this.readUser().catch((e: unknown) => {
      userOnce = null;
      throw e;
    });
    return userOnce;
  }

  private async readUser(): Promise<{ sid: string; local: boolean }> {
    const { stdout } = await run(windowsTool('whoami.exe'), ['/user', '/fo', 'csv', '/nh']);
    const [name, sid] = stdout.trim().split('","').map((f) => f.replace(/"/g, ''));
    if (!sid?.startsWith('S-1-')) throw new Error('cannot resolve user SID');
    const domain = name?.includes('\\') ? name.split('\\')[0] : '';
    const machine = [process.env.COMPUTERNAME, os.hostname()].filter((n): n is string => !!n).map((n) => n.toLowerCase());
    return { sid, local: !!domain && machine.includes(domain.toLowerCase()) };
  }

  async ensurePrivate(dir: string): Promise<AclCheck> {
    if (await findReparsePoint(dir)) return { ok: false, problems: ['reparse_point'] };
    await fs.mkdir(dir, { recursive: true });
    const { sid, local } = await this.user();
    if (!(await ownerMemo.isTrusted(dir, sid))) return this.checkPrivate(dir);
    const icacls = windowsTool('icacls.exe');
    await run(icacls, [dir, '/inheritance:r', '/grant:r', `*${sid}:(OI)(CI)F`, '/grant:r', '*S-1-5-18:(OI)(CI)F'], REPAIR);
    const extra = new Set((await readDacl(dir)).aces.map((a) => a.sid).filter((s) => !isUserSid(s, sid, local) && !isSystem(s)));
    const removable = [...extra].map((s) => (s.startsWith('S-1-') ? s : SDDL_ALIASES[s])).filter((s): s is string => !!s);
    if (removable.length) await run(icacls, [dir, '/remove', ...removable.map((s) => `*${s}`)], REPAIR);
    const check = await this.checkPrivate(dir);
    if (check.ok || check.problems.includes('reparse_point') || check.problems.includes('not_dir')) return check;
    const script = `$s = New-Object System.Security.AccessControl.DirectorySecurity; $s.SetSecurityDescriptorSddlForm('D:PAI(A;OICI;FA;;;SY)(A;OICI;FA;;;${sid})', 'Access'); [System.IO.Directory]::SetAccessControl($env:SAX_ACL_TARGET, $s)`;
    await run(windowsTool('WindowsPowerShell\\v1.0\\powershell.exe'), ['-NoProfile', '-NonInteractive', '-Command', script], { ...REPAIR, env: windowsPowerShellEnv({ SAX_ACL_TARGET: dir }) });
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
    const { sid, local } = await this.user();
    if (!(await ownerMemo.isTrusted(dir, sid))) problems.push('not_owner');
    const dacl = await readDacl(dir);
    if (!dacl.protected || dacl.aces.some((a) => a.flags.includes('ID'))) problems.push('inherited');
    if (!grantsUserFullControl(dacl, sid, local)) problems.push('no_user_access');
    if (dacl.aces.some((a) => a.type !== 'A' || (!isUserSid(a.sid, sid, local) && !isSystem(a.sid)))) problems.push('extra_principal');
    return { ok: problems.length === 0, problems };
  }

  async excludeFromIndex(dir: string): Promise<void> {
    await run(windowsTool('attrib.exe'), ['+I', dir]);
  }
}

export function dirGuard(platform: NodeJS.Platform = process.platform): DirGuard {
  return platform === 'win32' ? new WindowsDirGuard() : new PosixDirGuard();
}
