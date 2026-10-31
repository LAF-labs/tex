import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { MessageChannel } from 'node:worker_threads';
import { FileEventLog, prepareLayout, tapPort, wrapPort, type AppPaths, type DirGuard } from '@sax/platform';
import { LeakCapture, MemoryKeyStore, RELAY_DENIED_METHODS, RELAY_DOMAIN_METHOD_ALLOWLIST, Vault, type RelayPolicy } from '@sax/vault';
import { VaultClient } from '@sax/engine';

export const TEST_CHROME_ARGS = ['--headless=new', '--use-mock-keychain'];

export function testPolicy(over: Partial<RelayPolicy> = {}): RelayPolicy {
  return {
    allowedHosts: ['127.0.0.1'],
    secretHosts: { cert_password: ['127.0.0.1'], portal_password: ['127.0.0.1'], security_card: ['127.0.0.1'] },
    domainMethods: RELAY_DOMAIN_METHOD_ALLOWLIST,
    deniedMethods: RELAY_DENIED_METHODS,
    keyDelayMs: 5,
    typistInput: 'insertText',
    ...over,
  };
}

export interface Harness {
  paths: AppPaths;
  vault: Vault;
  client: VaultClient;
  /** main 제어 포트 대역. */
  control: VaultClient;
  /** 금고 직결 비밀 입력 창 포트 대역. */
  secretInput: VaultClient;
  log: FileEventLog;
  capture: LeakCapture;
  close(): Promise<void>;
}

export async function startHarness(opts: { policy?: RelayPolicy; headful?: boolean; dirGuard?: DirGuard } = {}): Promise<Harness> {
  const base = await fs.realpath(os.tmpdir());
  const root = await fs.mkdtemp(path.join(base, 'sax-poc-'));
  const { paths } = await prepareLayout(root);
  const log = new FileEventLog(paths.logs, 'vault');
  const capture = new LeakCapture();
  const vault = new Vault({ paths, log, keyStore: new MemoryKeyStore(), policy: opts.policy ?? testPolicy(), testChromeArgs: opts.headful ? ['--use-mock-keychain'] : TEST_CHROME_ARGS, dirGuard: opts.dirGuard });
  const ch = new MessageChannel();
  // 엔진 포트 IPC 캡처: 금고 쪽에서 양방향을 기록한다(엔진이 받은 CDP 이벤트 스트림 포함).
  vault.attachPort('engine', tapPort(wrapPort(ch.port1, 'node'), (dir, m) => capture.add(`ipc.engine.${dir}`, m)));
  const client = new VaultClient(wrapPort(ch.port2, 'node'));
  const ctl = new MessageChannel();
  vault.attachPort('control', wrapPort(ctl.port1, 'node'));
  const sec = new MessageChannel();
  vault.attachPort('secretInput', wrapPort(sec.port1, 'node'));
  return {
    paths,
    vault,
    client,
    control: new VaultClient(wrapPort(ctl.port2, 'node')),
    secretInput: new VaultClient(wrapPort(sec.port2, 'node')),
    log,
    capture,
    async close() {
      await vault.shutdown();
      for (const c of [ch, ctl, sec]) {
        c.port1.close();
        c.port2.close();
      }
      await fs.rm(root, { recursive: true, force: true });
    },
  };
}
