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
  /** 금고 직결 비밀 입력 창 포트 대역: 창마다 새 포트를 결속(bind)과 함께 붙인다(I-1). bind 없이 부르면 결속 없는 포트. */
  secretPort(bind?: SecretInputBind): VaultClient;
  /** 결속 포트 하나로 비밀을 한 번 넣는다. */
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
  // 시험은 사람이 Chrome 칸에 직접 치는 옛 길을 본다. appCert만 앱 기본(첫 인증서 비밀번호를 앱 금고 창으로)처럼.
  const vault = new Vault({ paths, log, keyStore: new MemoryKeyStore(), policy: opts.policy ?? testPolicy(), testChromeArgs: opts.headful ? ['--use-mock-keychain'] : TEST_CHROME_ARGS, certFromApp: opts.appCert === true, dirGuard: opts.dirGuard, launchTimeoutMs: opts.launchTimeoutMs, secretTtlMs: opts.secretTtlMs, human: opts.human, pdf: opts.pdf });
  const ch = new MessageChannel();
  // 엔진 포트 IPC 캡처: 금고 쪽에서 양방향을 기록한다(엔진이 받은 CDP 이벤트 스트림 포함).
  vault.attachPort('engine', tapPort(wrapPort(ch.port1, 'node'), (dir, m) => capture.add(`ipc.engine.${dir}`, m)));
  const client = new VaultClient(wrapPort(ch.port2, 'node'));
  const ctl = new MessageChannel();
  // control 포트 IPC도 담는다(main ↔ 금고, 누출 스캐너 확장). 비밀 입력 포트(secret.provide)는 비밀을 싣는 것이 정상이라 담지 않는다.
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
      // Windows: Chrome 주 프로세스가 끝나도 자식이 프로필 파일(Network/Cookies 등)을 잠시 잡는다(WIN-REALDEVICE §5). 잠금이면 다시 시도한다.
      await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    },
  };
}
