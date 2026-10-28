import fs from 'node:fs/promises';
import path from 'node:path';
import { dirGuard, type AclCheck, type DirGuard } from './acl.ts';
import { appPaths, type AppPaths } from './paths.ts';

export interface PreparedLayout {
  paths: AppPaths;
  root: AclCheck;
  /** 기동 시 정리한 staging 잔존 파일 수(D07 §1). */
  stagingCleared: number;
}

/** 루트를 사용자 전용으로 만들고 하위 폴더를 준비한다. 루트 ACL이 맞지 않으면 복구를 시도한다. */
export async function prepareLayout(root?: string, guard: DirGuard = dirGuard()): Promise<PreparedLayout> {
  const paths = appPaths(root);
  let rootCheck = await guard.checkPrivate(paths.root);
  if (!rootCheck.ok) rootCheck = await guard.ensurePrivate(paths.root);
  if (!rootCheck.ok) return { paths, root: rootCheck, stagingCleared: 0 };
  await guard.excludeFromIndex(paths.root);
  for (const dir of [paths.userData, paths.db, paths.vault, paths.chromeProfile, paths.staging, paths.logs, paths.crashDumps]) {
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  }
  let stagingCleared = 0;
  for (const name of await fs.readdir(paths.staging)) {
    await fs.rm(path.join(paths.staging, name), { recursive: true, force: true });
    stagingCleared++;
  }
  return { paths, root: rootCheck, stagingCleared };
}
