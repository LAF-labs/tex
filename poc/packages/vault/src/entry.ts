// 금고 utilityProcess 진입점. main이 첫 메시지로 engine·control 포트를, 이후 비밀 입력 창마다 secretInput 포트를 넘긴다.
import type { MessagePortMain } from 'electron';
// 정책·경로·Chrome 인자는 전부 상수다(이 파일은 아무 설정도 받지 않는다).
import { appPaths, defaultAppRoot, FileEventLog, wrapPort } from '@sax/platform';
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
const vault = new Vault({ paths, log, keyStore: new OsKeyStore() });

parentPort.on('message', (e) => {
  const kinds = (e.data as { ports?: PortKind[] })?.ports ?? [];
  kinds.forEach((kind, i) => {
    const p = e.ports[i];
    if (p && (kind === 'engine' || kind === 'control' || kind === 'secretInput')) vault.attachPort(kind, wrapPort(p, 'electron'));
  });
});

process.on('exit', () => void vault.shutdown());
log.event('vault.started');
parentPort.postMessage({ t: 'ready' });
