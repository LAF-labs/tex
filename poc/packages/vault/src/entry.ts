// 금고 utilityProcess 진입점. main이 첫 메시지로 engine·control 포트를, 이후 비밀 입력 창마다 secretInput 포트(+ 결속 bind, I-1)를 넘긴다.
// 송신 모듈 차단을 가장 먼저 건다(N-32).
import { netDenyInstalled } from './net-deny.ts';
import type { MessagePortMain } from 'electron';
// 정책·경로·Chrome 인자는 전부 상수다(이 파일은 아무 설정도 받지 않는다).
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
// 사람 비밀 저장소: Windows는 TPM→DPAPI 래핑(네이티브 헬퍼 S10c 전까지 저장 거부), macOS는 개발용 Keychain 래핑.
const human = new HumanSecretVault({ backend: keychainBackend(), log });
const vault = new Vault({ paths, log, keyStore: new OsKeyStore(), human });
// Windows: 폴더 확인(소유자 PowerShell, 느린 PC 3~15초)을 금고 기동 때 미리 해 둔다. 첫 Chrome 기동이 기다리지 않는다(ADR-041).
if (process.platform === 'win32') void vault.warmDirChecks();

parentPort.on('message', (e) => {
  const data = e.data as { ports?: PortKind[]; bind?: unknown };
  const kinds = data?.ports ?? [];
  kinds.forEach((kind, i) => {
    const p = e.ports[i];
    if (p && (kind === 'engine' || kind === 'control' || kind === 'secretInput')) vault.attachPort(kind, wrapPort(p, 'electron'), kind === 'secretInput' ? data.bind : undefined);
  });
});

process.on('exit', () => void vault.shutdown());
if (!netDenyInstalled) log.event('vault.net_deny_unavailable');
log.event('vault.started');
parentPort.postMessage({ t: 'ready' });
