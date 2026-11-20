import { netDenyInstalled } from './net-deny.ts';
import type { MessagePortMain } from 'electron';
import { appPaths, defaultAppRoot, FileEventLog, wrapPort } from '@sax/platform';
import { keychainBackend } from './keychain/backend.ts';
import { HumanSecretVault } from './keychain/human.ts';
import { OsKeyStore } from './keystore.ts';
import type { PortKind } from './protocol.ts';
import { Vault } from './service.ts';

interface ParentPort {
  on(ev: 'message', fn: (e: { data: unknown; ports: MessagePortMain[] }) => void): void;
  postMessage(m: unknown): void;
}

const parentPort = (process as unknown as { parentPort: ParentPort }).parentPort;
const paths = appPaths(defaultAppRoot());
const log = new FileEventLog(paths.logs, 'vault');
const human = new HumanSecretVault({ backend: keychainBackend(), log });
const vault = new Vault({ paths, log, keyStore: new OsKeyStore(), human });
if (process.platform === 'win32') void vault.warmDirChecks();

parentPort.on('message', (e) => {
  const data = e.data as { ports?: PortKind[]; bind?: unknown };
  const kinds = data?.ports ?? [];
  kinds.forEach((kind, i) => {
    const p = e.ports[i];
    if (p && (kind === 'engine' || kind === 'control' || kind === 'secretInput' || kind === 'browser')) vault.attachPort(kind, wrapPort(p, 'electron'), kind === 'secretInput' ? data.bind : undefined);
  });
});

process.on('exit', () => void vault.shutdown());
if (!netDenyInstalled) log.event('vault.net_deny_unavailable');
log.event('vault.started');
parentPort.postMessage({ t: 'ready' });
