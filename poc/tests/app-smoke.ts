// 앱 스모크(수동 실행): 실제 Electron 앱을 띄워 utilityProcess 금고·엔진 배선과 암호화 DB를 확인한다.
// 실행: node --conditions=development tests/app-smoke.ts  (앱 폴더와 키체인 항목 SovereignAX/db-key를 만든다)
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { _electron as electron } from 'playwright-core';
import { isEncryptedFile, syntheticBizNo } from '@sax/db';
import { appPaths, defaultAppRoot } from '@sax/platform';

const exe = path.resolve(import.meta.dirname, '../node_modules/.bin/electron');
const realExe = await fs.realpath(exe).catch(() => exe);
const electronPath = (await import('electron')).default as unknown as string;
const appDir = path.resolve(import.meta.dirname, '../apps/desktop');
const out: Record<string, unknown> = { exe: path.basename(realExe) };
const paths = appPaths(defaultAppRoot());
const app = await electron.launch({ executablePath: electronPath, args: [appDir] });
try {
  const win = await app.firstWindow();
  // main은 폴더 확인 뒤(ready 전) setPath한다. Electron이 넘긴 경로를 그대로 쓰는지 본다.
  const electronPaths = await app.evaluate(({ app: a }) => ({ userData: a.getPath('userData'), logs: a.getPath('logs'), crashDumps: a.getPath('crashDumps') }));
  out.electronPathsMatch = electronPaths.userData === paths.userData && electronPaths.logs === paths.logs && electronPaths.crashDumps === paths.crashDumps;
  const call = (m: string, p: Record<string, unknown> = {}) => win.evaluate(([m, p]) => (window as unknown as { sax: { call(m: string, p: unknown): Promise<unknown> } }).sax.call(m, p), [m, p] as const);
  let status: { engine?: { db?: boolean } } = {};
  for (let i = 0; i < 60 && !status.engine?.db; i++) {
    status = (await call('app.status').catch(() => ({}))) as typeof status;
    await new Promise((r) => setTimeout(r, 250));
  }
  out.status = status;
  out.profile = await call('profile.upsert', { kind: 'business', displayName: 'PoC 스모크 사업자', bizNo: syntheticBizNo(2026), repName: '스모크' });
  const bn = syntheticBizNo(1028);
  const existing = (await call('db.query.counterparties.list', { q: bn })) as unknown[];
  out.counterparty = existing[0] ?? (await call('counterparty.create', { bizNo: bn, name: '스모크 거래처', email: 'cp@example.com' }));
  out.list = ((await call('db.query.counterparties.list')) as unknown[]).length;
  out.browserOpen = await call('browser.open', {}).catch((e: Error) => 'error: ' + e.message);
  out.statusAfterOpen = await call('app.status');
  out.browserClose = await call('browser.close');
  out.forbiddenDirect = await win.evaluate(() => fetch('https://example.com').then(() => 'fetched', (e: Error) => 'blocked: ' + e.message)).catch((e: Error) => 'blocked: ' + e.message);
} finally {
  await app.close();
}
const dbFile = path.join(paths.db, 'db.sqlite');
out.dbEncrypted = isEncryptedFile(dbFile);
out.rootMode = ((await fs.stat(paths.root)).mode & 0o777).toString(8);
out.dirs = await fs.readdir(paths.root);
out.chromeProfileHasDevToolsActivePort = await fs.access(path.join(paths.chromeProfile, 'DevToolsActivePort')).then(() => true, () => false);
out.vaultLog = (await fs.readFile(path.join(paths.logs, 'vault.log'), 'utf8').catch(() => '')).trim().split('\n').slice(-8).map((l) => JSON.parse(l).code);
out.plantedLinks = await plantedLinksRun();
console.log(JSON.stringify(out, null, 2));
await fs.writeFile(path.resolve(import.meta.dirname, '../reports/raw/app-smoke.json'), JSON.stringify(out, null, 2));

/**
 * 2단계: 임시 앱 루트(macOS HOME, Windows LOCALAPPDATA)의 userData·logs·crashDumps 자리에 바깥 폴더로 가는 링크를 심고 띄운다.
 * main이 setPath 전에 치우면 바깥 폴더는 비어 있고 세 자리는 실제 폴더다. ready 뒤에 치우던 옛 순서에서는 Electron이 링크 너머에 먼저 쓴다.
 */
async function plantedLinksRun(): Promise<Record<string, unknown>> {
  const win = process.platform === 'win32';
  const home = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'sax-smoke-home-'));
  try {
    const root = win ? path.join(home, 'SovereignAX') : path.join(home, 'Library', 'Application Support', 'SovereignAX');
    const outside = path.join(home, 'outside');
    await fs.mkdir(root, { recursive: true, mode: 0o700 });
    const names = ['userData', 'logs', 'crashDumps'];
    for (const n of names) {
      await fs.mkdir(path.join(outside, n), { recursive: true });
      await fs.symlink(path.join(outside, n), path.join(root, n), win ? 'junction' : 'dir');
    }
    const env = { ...process.env, ...(win ? { LOCALAPPDATA: home } : { HOME: home }) } as Record<string, string>;
    const planted = await electron.launch({ executablePath: electronPath, args: [appDir], env });
    let launchError: string | undefined;
    try {
      await planted.firstWindow({ timeout: 30_000 }); // 폴더 준비가 실패하면 모달 오류 상자에서 멈춘다
      await new Promise((r) => setTimeout(r, 2000)); // Chromium이 userData에 쓸 시간
    } catch (e) {
      launchError = (e as Error).message.split('\n')[0];
    } finally {
      await Promise.race([planted.close(), new Promise((r) => setTimeout(r, 10_000))]);
      planted.process().kill();
    }
    const outsideFiles: string[] = [];
    for (const n of names) outsideFiles.push(...(await fs.readdir(path.join(outside, n))).map((f) => `${n}/${f}`));
    const realDirs = await Promise.all(names.map(async (n) => (await fs.lstat(path.join(root, n))).isDirectory()));
    const mainLog = await fs.readFile(path.join(root, 'logs', 'main.log'), 'utf8').catch(() => '');
    const setAside = mainLog.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as { code?: string }).filter((e) => e.code === 'main.layout_set_aside').length;
    return { ok: !launchError && outsideFiles.length === 0 && realDirs.every(Boolean) && setAside === names.length, launchError, outsideFiles: outsideFiles.slice(0, 10), realDirs, setAside };
  } finally {
    // Windows는 끝난 직후 엔진·백신이 파일을 잡고 있을 수 있다. 정리 실패로 1단계 결과까지 잃지 않게 한다.
    await fs.rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }).catch((e: Error) => console.error(`임시 앱 루트 정리 실패: ${home}: ${e.message}`));
  }
}
