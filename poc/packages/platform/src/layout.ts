import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { dirGuard, type AclCheck, type AclProblem, type DirGuard } from './acl.ts';
import { appPaths, type AppPaths } from './paths.ts';

export interface PreparedLayout {
  paths: AppPaths;
  root: AclCheck;
  stagingCleared: number;
  setAside: string[];
}

/** 루트를 사용자 전용으로 만들고 하위 폴더를 준비한다. 루트 ACL이 맞지 않으면 복구를 시도한다. */
export async function prepareLayout(root?: string, guard: DirGuard = dirGuard()): Promise<PreparedLayout> {
  const paths = appPaths(root);
  let rootCheck = await guard.checkPrivate(paths.root);
  if (!rootCheck.ok) rootCheck = await guard.ensurePrivate(paths.root);
  if (!rootCheck.ok) return { paths, root: rootCheck, stagingCleared: 0, setAside: [] };
  await guard.excludeFromIndex(paths.root);
  const setAside: string[] = [];
  for (const dir of [paths.userData, paths.db, paths.vault, paths.chromeProfile, paths.staging, paths.logs, paths.crashDumps]) {
    const st = await fs.lstat(dir).catch(() => null);
    if (st && !st.isDirectory()) setAside.push(await moveAside(dir));
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  }
  let stagingCleared = 0;
  for (const name of await fs.readdir(paths.staging)) {
    await fs.rm(path.join(paths.staging, name), { recursive: true, force: true });
    stagingCleared++;
  }
  return { paths, root: rootCheck, stagingCleared, setAside };
}

export interface PreparedDir {
  check: AclCheck;
  before: AclProblem[];
  reason?: AclProblem[];
  setAside?: string;
}

const NOT_OURS: readonly AclProblem[] = ['not_owner', 'reparse_point', 'not_dir', 'unreadable'];
const notOurs = (c: AclCheck): boolean => c.problems.some((p) => NOT_OURS.includes(p));

interface Judged {
  check: AclCheck;
  error?: unknown;
}

/**
 * 앱만 쓰는 하위 폴더(전용 Chrome 프로필)를 사용자 전용으로 준비한다. 실패하지 않는 쪽을 먼저 고른다.
 * 1. 이미 맞으면 손대지 않는다. Windows는 DACL을 다시 쓸 때마다 하위 전체로 전파한다.
 * 2. 권한만 틀리면 제자리에서 고친다. 다른 주체 ACE는 Chrome 샌드박스가 붙일 수도 있어, 이것만으로 프로필을 치우지는 않는다.
 * 3. 폴더가 우리 것이 아니면 같은 부모 안에서 이름을 바꿔 치우고 새로 만든다. 부모가 사용자 전용이면 하위 항목 권한과 관계없이
 *    이름을 바꿀 수 있다(Windows 부모의 FILE_DELETE_CHILD, POSIX 부모 쓰기 권한). 치운 항목은 지우지 않는다(링크 대상을 지우지 않게, 원인 조사용).
 *    이 폴더에서만 도구가 실패해도(접근 거부) 우리 것이 아닌 것으로 본다. 부모 확인 통과와 한 번 더 확인으로 도구 고장·일시 실패와 구분한다.
 * 4. 새 폴더도 맞지 않으면 치운 것을 되돌린다. 그래도 맞지 않거나 부모가 사용자 전용이 아니면 실패를 돌려준다(도구 예외는 그대로 던진다).
 *    호출자는 그 폴더를 쓰지 않는다(D05 §3.1).
 */
export async function preparePrivateDir(dir: string, guard: DirGuard = dirGuard()): Promise<PreparedDir> {
  const attempt = async (f: () => Promise<AclCheck>): Promise<Judged> => {
    try {
      return { check: await f() };
    } catch (error) {
      return { check: { ok: false, problems: ['unreadable'] }, error };
    }
  };
  const inspect = async (): Promise<Judged> => {
    const st = await fs.lstat(dir).catch(() => null);
    if (st && !st.isDirectory()) return { check: { ok: false, problems: [st.isSymbolicLink() ? 'reparse_point' : 'not_dir'] } };
    return attempt(() => guard.checkPrivate(dir));
  };
  const repair = async (j: Judged): Promise<Judged> => (j.check.ok || notOurs(j.check) ? j : attempt(() => guard.ensurePrivate(dir)));
  const first = await inspect();
  const before = first.check.problems;
  let judged = await repair(first);
  if (!notOurs(judged.check)) return { check: judged.check, before };
  if (!(await guard.checkPrivate(path.dirname(dir))).ok) {
    if (judged.error) throw judged.error;
    return { check: judged.check, before };
  }
  if (judged.error) {
    judged = await repair(await inspect());
    if (!notOurs(judged.check)) return { check: judged.check, before };
  }
  const reason = judged.check.problems;
  const setAside = await moveAside(dir);
  const fresh = await attempt(async () => {
    await retryingOnWindows(() => fs.mkdir(dir, { mode: 0o700 }));
    return guard.ensurePrivate(dir);
  });
  if (fresh.check.ok) return { check: fresh.check, before, reason, setAside };
  try {
    await fs.rmdir(dir).catch((e: NodeJS.ErrnoException) => {
      if (e.code !== 'ENOENT') throw e;
    });
    await retryingOnWindows(() => fs.rename(path.join(path.dirname(dir), setAside), dir));
  } catch {
    if (fresh.error) throw fresh.error;
    return { check: fresh.check, before, reason, setAside };
  }
  if (fresh.error) throw fresh.error;
  return { check: fresh.check, before, reason };
}

async function moveAside(entry: string): Promise<string> {
  const name = `${path.basename(entry)}.untrusted-${Date.now()}-${randomBytes(3).toString('hex')}`;
  await retryingOnWindows(() => fs.rename(entry, path.join(path.dirname(entry), name)));
  return name;
}

async function retryingOnWindows<T>(op: () => Promise<T>): Promise<T> {
  for (let i = 0; ; i++) {
    try {
      return await op();
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code ?? '';
      if (process.platform !== 'win32' || i >= 4 || !['EPERM', 'EACCES', 'EBUSY'].includes(code)) throw e;
      await new Promise((r) => setTimeout(r, 100 * (i + 1)));
    }
  }
}
