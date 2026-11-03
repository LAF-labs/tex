// 앱 스모크(수동 실행): 실제 Electron 앱(개발 콘솔 main.ts)을 임시 앱 루트로 띄워 utilityProcess 금고·엔진 배선과 암호화 DB를 확인한다.
// 실 루트(%LOCALAPPDATA%\SovereignAX)·실 DB·실 프로필을 건드리지 않는다(N-57). 실 루트에 DB가 있으면 시작하지 않는다.
// 앱은 디버그 스위치(CDP·검사기)가 있으면 열리지 않으므로(ADR-022 결정 8) Playwright로 붙지 않고 프로세스를 띄워 디스크 결과만 본다.
// 실행: node --conditions=development tests/app-smoke.ts  (OS 키체인 항목 SovereignAX/db-key는 읽거나 만든다. DB는 임시 루트에만)
import { spawn } from 'node:child_process';
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { isEncryptedFile } from '@sax/db';
import { appPaths, defaultAppRoot } from '@sax/platform';
import { smokeRootPlan } from '../apps/desktop/src/smoke-plan.ts';

const electronPath = (await import('electron')).default as unknown as string;
const appDir = path.resolve(import.meta.dirname, '../apps/desktop');
const isWin = process.platform === 'win32';
// 컨테이너(root)에서는 Chromium 샌드박스를 쓸 수 없다.
const baseArgs = process.getuid?.() === 0 ? ['--no-sandbox'] : [];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const exists = (p: string) => fsSync.existsSync(p);

/** 임시 홈(HOME·LOCALAPPDATA) 아래의 앱 루트(defaultAppRoot와 같은 규칙). */
const rootUnder = (home: string) => (isWin ? path.join(home, 'SovereignAX') : process.platform === 'darwin' ? path.join(home, 'Library', 'Application Support', 'SovereignAX') : path.join(home, '.local', 'share', 'SovereignAX'));

/** 띄우고 until이 참이 되거나 끝날 때까지 기다린다. 아직 살아 있으면 끝낸다. 종료 코드(끝내기 전에 스스로 끝났으면)를 돌려준다. */
async function run(env: Record<string, string>, extra: string[], until: () => boolean, ms: number, linger = 0): Promise<{ code: number | null; selfExit: boolean }> {
  const child = spawn(electronPath, [appDir, ...baseArgs, ...extra], { env, stdio: 'ignore' });
  let code: number | null = null;
  let done = false;
  child.on('exit', (c) => {
    code = c;
    done = true;
  });
  const end = Date.now() + ms;
  while (!done && Date.now() < end && !until()) await sleep(250);
  if (!done && linger) await sleep(linger);
  const selfExit = done;
  if (!done) {
    child.kill('SIGTERM');
    for (let i = 0; i < 40 && !done; i++) await sleep(250);
    if (!done) child.kill('SIGKILL');
  }
  return { code, selfExit };
}

const tmp = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'sax-smoke-'));
const plan = smokeRootPlan({ env: process.env, tmp, realRoot: defaultAppRoot(), exists });
if (!plan.ok) {
  console.error(plan.reason);
  await fs.rm(tmp, { recursive: true, force: true });
  process.exit(1);
}
const out: Record<string, unknown> = { exe: path.basename(electronPath) };
try {
  const paths = appPaths(rootUnder(tmp));
  // 0단계: 디버그 스위치가 있으면 앱 폴더를 만들기 전에 끝난다(하드닝).
  out.debugSwitchRefused = {};
  for (const sw of ['--remote-debugging-port=0', '--inspect=0']) {
    const r = await run(plan.env, [sw], () => false, 15_000);
    (out.debugSwitchRefused as Record<string, unknown>)[sw] = r.selfExit && r.code === 1 && !exists(paths.root);
  }
  // 1단계: 임시 루트로 띄워 DB가 생기고 금고가 뜨기를 기다린다. 그동안 두 번째 실행은 단일 인스턴스 잠금으로 바로 끝난다.
  const vaultLog = path.join(paths.logs, 'vault.log');
  const dbFile = path.join(paths.db, 'db.sqlite');
  const vaultUp = () => exists(vaultLog) && fsSync.readFileSync(vaultLog, 'utf8').includes('vault.started');
  let second: { code: number | null; selfExit: boolean } | null = null;
  const first = run(plan.env, [], () => exists(dbFile) && vaultUp(), 45_000, 1500);
  for (let i = 0; i < 120 && !vaultUp(); i++) await sleep(250);
  if (vaultUp()) second = await run(plan.env, [], () => false, 15_000);
  out.firstRun = await first;
  out.secondInstanceExited = !!second && second.selfExit && second.code === 0;
  out.dbEncrypted = exists(dbFile) && isEncryptedFile(dbFile);
  out.rootMode = ((await fs.stat(paths.root)).mode & 0o777).toString(8);
  out.dirs = (await fs.readdir(paths.root)).sort();
  out.userDataUsed = (await fs.readdir(paths.userData).catch(() => [])).length > 0;
  out.chromeProfileHasDevToolsActivePort = exists(path.join(paths.chromeProfile, 'DevToolsActivePort'));
  out.vaultLog = (await fs.readFile(vaultLog, 'utf8').catch(() => '')).trim().split('\n').filter(Boolean).slice(-8).map((l) => JSON.parse(l).code);
  out.plantedLinks = await plantedLinksRun();
} finally {
  // Windows는 끝난 직후 엔진·백신이 파일을 잡고 있을 수 있다. 정리 실패로 결과까지 잃지 않게 한다.
  await fs.rm(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }).catch((e: Error) => console.error(`임시 앱 루트 정리 실패: ${tmp}: ${e.message}`));
}
console.log(JSON.stringify(out, null, 2));
await fs.writeFile(path.resolve(import.meta.dirname, '../reports/raw/app-smoke.json'), JSON.stringify(out, null, 2));

/**
 * 2단계: 임시 앱 루트(macOS·Linux HOME, Windows LOCALAPPDATA)의 userData·logs·crashDumps 자리에 바깥 폴더로 가는 링크를 심고 띄운다.
 * main이 setPath 전에 치우면 바깥 폴더는 비어 있고 세 자리는 실제 폴더다. ready 뒤에 치우던 옛 순서에서는 Electron이 링크 너머에 먼저 쓴다.
 */
async function plantedLinksRun(): Promise<Record<string, unknown>> {
  const home = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'sax-smoke-home-'));
  try {
    const root = rootUnder(home);
    const outside = path.join(home, 'outside');
    await fs.mkdir(root, { recursive: true, mode: 0o700 });
    const names = ['userData', 'logs', 'crashDumps'];
    for (const n of names) {
      await fs.mkdir(path.join(outside, n), { recursive: true });
      await fs.symlink(path.join(outside, n), path.join(root, n), isWin ? 'junction' : 'dir');
    }
    const env = smokeRootPlan({ env: process.env, tmp: home, realRoot: defaultAppRoot(), exists }).env;
    const mainLog = path.join(root, 'logs', 'main.log');
    const setAsideCount = () => (exists(mainLog) ? fsSync.readFileSync(mainLog, 'utf8').split('\n').filter((l) => l.includes('main.layout_set_aside')).length : 0);
    // 폴더 준비가 실패하면 모달 오류 상자에서 멈춘다. 치운 기록이 생긴 뒤 Chromium이 userData에 쓸 시간(2초)을 둔다.
    const r = await run(env, [], () => setAsideCount() === names.length, 30_000, 2000);
    const outsideFiles: string[] = [];
    for (const n of names) outsideFiles.push(...(await fs.readdir(path.join(outside, n))).map((f) => `${n}/${f}`));
    const realDirs = await Promise.all(names.map(async (n) => (await fs.lstat(path.join(root, n))).isDirectory()));
    const setAside = setAsideCount();
    return { ok: !r.selfExit && outsideFiles.length === 0 && realDirs.every(Boolean) && setAside === names.length, selfExit: r.selfExit, outsideFiles: outsideFiles.slice(0, 10), realDirs, setAside };
  } finally {
    await fs.rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }).catch((e: Error) => console.error(`임시 앱 루트 정리 실패: ${home}: ${e.message}`));
  }
}
