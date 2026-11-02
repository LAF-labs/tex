import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { dirGuard, type AclCheck, type AclProblem, type DirGuard } from './acl.ts';
import { appPaths, type AppPaths } from './paths.ts';

export interface PreparedLayout {
  paths: AppPaths;
  root: AclCheck;
  /** 기동 시 정리한 staging 잔존 파일 수(D07 §1). */
  stagingCleared: number;
  /** 하위 폴더 자리에 파일·링크가 있어 루트 안에서 이름을 바꿔 치운 항목. */
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
    // 폴더 자리의 파일·링크(정션 포함)는 치우고 새로 만든다. 파일이면 mkdir이 실패해 앱이 뜨지 않고,
    // 링크면 이후 앱 데이터가 루트 밖에 쓰이며 아래 staging 정리가 링크 대상의 파일을 지운다.
    // userData·logs·crashDumps는 Electron에 넘기는 폴더라, main은 이 함수를 setPath 앞에서 부른다.
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
  /** 처음 확인에서 나온 문제. 이미 맞았으면 빈 배열. */
  before: AclProblem[];
  /** 치우기로 판단한 문제(도구 예외면 unreadable). 새 폴더도 맞지 않아 되돌렸으면 setAside 없이 이것만 있다. */
  reason?: AclProblem[];
  /** 제자리에서 고칠 수 없어 같은 부모 안에서 이름을 바꿔 치운 원래 항목. */
  setAside?: string;
}

// 권한을 고쳐도 소용없는 문제: 폴더가 우리 것이 아니다. 다른 계정 소유(소유자는 DACL을 다시 열 수 있고 POSIX chmod는 거부된다), 링크, 파일,
// 그리고 우리가 읽거나 고칠 수 없는 폴더(우리 소유라면 OWNER RIGHTS ACE로 막지 않는 한 READ_CONTROL·WRITE_DAC가 늘 있다).
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
  // 도구 예외는 unreadable로 받되 예외를 함께 들고 다닌다. 폴더 탓이 아니면 그 예외를 그대로 던진다.
  const attempt = async (f: () => Promise<AclCheck>): Promise<Judged> => {
    try {
      return { check: await f() };
    } catch (error) {
      return { check: { ok: false, problems: ['unreadable'] }, error };
    }
  };
  const inspect = async (): Promise<Judged> => {
    // 파일·링크는 OS 도구에 넘기지 않는다. icacls·Get-Acl은 링크를 따라가 대상의 ACL을 읽고, 대상이 없으면 실패한다.
    const st = await fs.lstat(dir).catch(() => null);
    if (st && !st.isDirectory()) return { check: { ok: false, problems: [st.isSymbolicLink() ? 'reparse_point' : 'not_dir'] } };
    return attempt(() => guard.checkPrivate(dir));
  };
  // 고쳤거나, 새 폴더를 만들어도 같은 이유로 실패할 문제면 제자리 복구 결과로 끝낸다.
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
    // 도구 예외로 판단했으면 한 번 더 해 본다. 일시적인 실패(PowerShell 기동 실패 등) 한 번으로 정상 프로필을 치우지 않게.
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
  // 새 폴더를 못 만들었거나 맞지 않으면 원래 폴더 탓이 아니다(쓰기 도구가 막힘 등). 되돌려 놓고 실패한다.
  // 원래 프로필을 잃지 않고, 재시도마다 쌓이지 않는다.
  try {
    await fs.rmdir(dir).catch((e: NodeJS.ErrnoException) => {
      if (e.code !== 'ENOENT') throw e; // mkdir이 실패했으면 없다
    });
    await retryingOnWindows(() => fs.rename(path.join(path.dirname(dir), setAside), dir));
  } catch {
    if (fresh.error) throw fresh.error;
    return { check: fresh.check, before, reason, setAside };
  }
  if (fresh.error) throw fresh.error;
  return { check: fresh.check, before, reason };
}

/** 링크는 따라가지 않고 링크 자체의 이름을 바꾼다. 같은 부모 안이라 볼륨을 넘지 않는다. */
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
      // Windows: 백신·색인기가 항목을 잠깐 열고 있으면 이름 바꾸기·만들기가 거부된다. 잠깐 기다렸다 다시 한다(최대 약 1초).
      const code = (e as NodeJS.ErrnoException).code ?? '';
      if (process.platform !== 'win32' || i >= 4 || !['EPERM', 'EACCES', 'EBUSY'].includes(code)) throw e;
      await new Promise((r) => setTimeout(r, 100 * (i + 1)));
    }
  }
}
