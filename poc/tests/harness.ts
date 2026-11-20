import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { MessageChannel } from 'node:worker_threads';
import { FileEventLog, prepareLayout, tapPort, wrapPort, type AppPaths, type DirGuard } from '@sax/platform';
import { LeakCapture, MemoryKeyStore, RELAY_DENIED_METHODS, RELAY_DOMAIN_METHOD_ALLOWLIST, Vault, type HumanSecretVault, type RelayPolicy, type SecretInputBind } from '@sax/vault';
import { VaultClient } from '@sax/engine';

export const TEST_CHROME_ARGS = ['--headless=new', '--use-mock-keychain'];

export function testPolicy(over: Partial<RelayPolicy> = {}): RelayPolicy {
  return {
    allowedHosts: ['127.0.0.1'],
    secretHosts: { cert_password: ['127.0.0.1'], portal_password: ['127.0.0.1'] },
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
  control: VaultClient;
  secretPort(bind?: SecretInputBind): VaultClient;
  provide(bind: SecretInputBind, secret: string): Promise<unknown>;
  log: FileEventLog;
  capture: LeakCapture;
  close(): Promise<void>;
}

export async function startHarness(opts: { policy?: RelayPolicy; headful?: boolean; appCert?: boolean; dirGuard?: DirGuard; launchTimeoutMs?: number; secretTtlMs?: number; human?: HumanSecretVault; pdf?: { maxBytes?: number; armTtlMs?: number } } = {}): Promise<Harness> {
  const base = await fs.realpath(os.tmpdir());
  const root = await fs.mkdtemp(path.join(base, 'sax-poc-'));
  const { paths } = await prepareLayout(root);
  const log = new FileEventLog(paths.logs, 'vault');
  const capture = new LeakCapture();
  const vault = new Vault({ paths, log, keyStore: new MemoryKeyStore(), policy: opts.policy ?? testPolicy(), testChromeArgs: opts.headful ? ['--use-mock-keychain'] : TEST_CHROME_ARGS, certFromApp: opts.appCert === true, dirGuard: opts.dirGuard, launchTimeoutMs: opts.launchTimeoutMs, secretTtlMs: opts.secretTtlMs, human: opts.human, pdf: opts.pdf });
  const ch = new MessageChannel();
  vault.attachPort('engine', tapPort(wrapPort(ch.port1, 'node'), (dir, m) => capture.add(`ipc.engine.${dir}`, m)));
  const client = new VaultClient(wrapPort(ch.port2, 'node'));
  const ctl = new MessageChannel();
  vault.attachPort('control', tapPort(wrapPort(ctl.port1, 'node'), (dir, m) => capture.add(`ipc.control.${dir}`, m)));
  const channels = [ch, ctl];
  const secretPort = (bind?: SecretInputBind): VaultClient => {
    const sec = new MessageChannel();
    channels.push(sec);
    vault.attachPort('secretInput', wrapPort(sec.port1, 'node'), bind);
    return new VaultClient(wrapPort(sec.port2, 'node'));
  };
  return {
    paths,
    vault,
    client,
    control: new VaultClient(wrapPort(ctl.port2, 'node')),
    secretPort,
    provide: (bind, secret) => secretPort(bind).rpc('secret.provide', { bytes: new TextEncoder().encode(secret) }),
    log,
    capture,
    async close() {
      await vault.shutdown();
      for (const c of channels) {
        c.port1.close();
        c.port2.close();
      }
      await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    },
  };
}
