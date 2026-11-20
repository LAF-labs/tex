import { spawn } from 'node:child_process';
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { isEncryptedFile } from '@sax/db';
import { appPaths, defaultAppRoot } from '@sax/platform';
import { smokeRootPlan } from '../apps/desktop/src/smoke-plan.ts';
import { measurePath } from './measure-out.ts';

const electronPath = (await import('electron')).default as unknown as string;
const appDir = path.resolve(import.meta.dirname, '../apps/desktop');
const isWin = process.platform === 'win32';
const baseArgs = process.getuid?.() === 0 ? ['--no-sandbox'] : [];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const exists = (p: string) => fsSync.existsSync(p);
async function linkKeychains(home: string): Promise<void> {
  if (process.platform !== 'darwin') return;
  await fs.mkdir(path.join(home, 'Library'), { recursive: true });
  await fs.symlink(path.join(os.userInfo().homedir, 'Library', 'Keychains'), path.join(home, 'Library', 'Keychains'));
}

const rootUnder = (home: string) => (isWin ? path.join(home, 'SovereignAX') : process.platform === 'darwin' ? path.join(home, 'Library', 'Application Support', 'SovereignAX') : path.join(home, '.local', 'share', 'SovereignAX'));

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
await linkKeychains(tmp);
const plan = smokeRootPlan({ env: process.env, tmp, realRoot: defaultAppRoot(), exists });
if (!plan.ok) {
  console.error(plan.reason);
  await fs.rm(tmp, { recursive: true, force: true });
  process.exit(1);
}
const out: Record<string, unknown> = { exe: path.basename(electronPath) };
try {
  const paths = appPaths(rootUnder(tmp));
  out.debugSwitchRefused = {};
  for (const sw of ['--remote-debugging-port=0', '--inspect=0']) {
    const r = await run(plan.env, [sw], () => false, 15_000);
    (out.debugSwitchRefused as Record<string, unknown>)[sw] = r.selfExit && r.code === 1 && !exists(paths.root);
  }
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
  await fs.rm(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }).catch((e: Error) => console.error(`임시 앱 루트 정리 실패: ${tmp}: ${e.message}`));
}
console.log(JSON.stringify(out, null, 2));
const smokeOut = measurePath('app-smoke.json');
await fs.mkdir(path.dirname(smokeOut), { recursive: true });
await fs.writeFile(smokeOut, JSON.stringify(out, null, 2));

async function plantedLinksRun(): Promise<Record<string, unknown>> {
  const home = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'sax-smoke-home-'));
  try {
    await linkKeychains(home);
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
