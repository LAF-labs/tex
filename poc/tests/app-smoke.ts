// 앱 스모크(수동 실행): 실제 Electron 앱을 띄워 utilityProcess 금고·엔진 배선과 암호화 DB를 확인한다.
// 실행: node --conditions=development tests/app-smoke.ts  (앱 폴더와 키체인 항목 SovereignAX/db-key를 만든다)
import fs from 'node:fs/promises';
import path from 'node:path';
import { _electron as electron } from 'playwright-core';
import { isEncryptedFile, syntheticBizNo } from '@sax/db';
import { appPaths, defaultAppRoot } from '@sax/platform';

const exe = path.resolve(import.meta.dirname, '../node_modules/.bin/electron');
const realExe = await fs.realpath(exe).catch(() => exe);
const electronPath = (await import('electron')).default as unknown as string;
const appDir = path.resolve(import.meta.dirname, '../apps/desktop');
const out: Record<string, unknown> = { exe: path.basename(realExe) };
const app = await electron.launch({ executablePath: electronPath, args: [appDir] });
try {
  const win = await app.firstWindow();
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
const paths = appPaths(defaultAppRoot());
const dbFile = path.join(paths.db, 'db.sqlite');
out.dbEncrypted = isEncryptedFile(dbFile);
out.rootMode = ((await fs.stat(paths.root)).mode & 0o777).toString(8);
out.dirs = await fs.readdir(paths.root);
out.chromeProfileHasDevToolsActivePort = await fs.access(path.join(paths.chromeProfile, 'DevToolsActivePort')).then(() => true, () => false);
out.vaultLog = (await fs.readFile(path.join(paths.logs, 'vault.log'), 'utf8').catch(() => '')).trim().split('\n').slice(-8).map((l) => JSON.parse(l).code);
console.log(JSON.stringify(out, null, 2));
await fs.writeFile(path.resolve(import.meta.dirname, '../reports/raw/app-smoke.json'), JSON.stringify(out, null, 2));
