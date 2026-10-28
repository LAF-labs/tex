// 엔진 utilityProcess 진입점. DB의 유일한 소유자(D07 §1.3). main과는 parentPort, 금고와는 전용 MessagePort.
import type { MessagePortMain } from 'electron';
import path from 'node:path';
import { openDatabase } from '@sax/db';
import { Egress } from '@sax/net';
import { appPaths, defaultAppRoot, FileEventLog, wrapPort } from '@sax/platform';
import type { Browser, Page } from 'playwright-core';
import { BizVerifier } from './bizverify.ts';
import { connectRunBrowser } from './browser.ts';
import { COMMANDS, DataService, READ_QUERIES } from './data-service.ts';
import { VaultClient } from './vault-client.ts';

interface ParentPort {
  on(ev: 'message', fn: (e: { data: unknown; ports: MessagePortMain[] }) => void): void;
  postMessage(m: unknown): void;
}

const parentPort = (process as unknown as { parentPort: ParentPort }).parentPort;
const paths = appPaths(defaultAppRoot());
const log = new FileEventLog(paths.logs, 'engine');
let vault: VaultClient | null = null;
let data: DataService | null = null;
let run: { browser: Browser; page: Page; targetId: string } | null = null;

const ALLOWED = new Set<string>([...READ_QUERIES, ...COMMANDS, 'browser.open', 'browser.close', 'engine.status']);

async function init(port: MessagePortMain): Promise<void> {
  vault = new VaultClient(wrapPort(port, 'electron'));
  const key = await vault.rpc<Uint8Array>('getDbKeyOnce');
  data = new DataService(openDatabase(path.join(paths.db, 'db.sqlite'), key), new BizVerifier(new Egress()));
  key.fill(0);
  log.event('engine.db_opened');
}

async function handle(method: string, params: Record<string, unknown>): Promise<unknown> {
  if (!ALLOWED.has(method)) throw new Error('unknown_method');
  if (method === 'engine.status') return { db: !!data, browser: !!run };
  if (method === 'browser.open') {
    if (!vault) throw new Error('vault_not_connected');
    if (!run) run = await connectRunBrowser(vault);
    // PoC-4/5 범위: 실행 페이지만 띄운다. 로그인·발급 자동화는 PoC-6 플레이북에서.
    if (params.portal === 'hometax') await run.page.goto('https://www.hometax.go.kr/');
    return { targetId: run.targetId };
  }
  if (method === 'browser.close') {
    await run?.browser.close().catch(() => {});
    run = null;
    await vault?.rpc('browser.shutdown').catch(() => {});
    return {};
  }
  if (!data) throw new Error('db_not_ready');
  return data.handle(method, params);
}

parentPort.on('message', (e) => {
  const msg = e.data as { t?: string; id?: number; method?: string; params?: Record<string, unknown> };
  if (msg?.t === 'vault-port' && e.ports[0]) {
    init(e.ports[0]).then(
      () => parentPort.postMessage({ t: 'ready' }),
      (err: Error) => parentPort.postMessage({ t: 'fatal', code: err.message.slice(0, 80) }),
    );
    return;
  }
  if (msg?.t !== 'rpc' || typeof msg.id !== 'number' || typeof msg.method !== 'string') return;
  handle(msg.method, msg.params ?? {}).then(
    (result) => parentPort.postMessage({ t: 'rpc', id: msg.id, result }),
    (err: Error & { code?: string }) => parentPort.postMessage({ t: 'rpc', id: msg.id, error: err.code ?? err.message.slice(0, 120) }),
  );
});
