import { dirGuard, preparePrivateDir, type AppPaths, type DirGuard, type EventLog } from '@sax/platform';
import { EXTENSION_ALLOWLIST, SECRET_ORIGINS, TYPIST_INPUT_MODE, TYPIST_KEY_DELAY_MS } from './constants.ts';
import { findInstalledChrome } from './chrome/find.ts';
import { launchChrome, type LaunchedChrome } from './chrome/launch.ts';
import { hasGoogleSignin, listInstalledExtensions, verifyProfileSettings, writeProfileSettings } from './chrome/profile.ts';
import type { KeyStore } from './keystore.ts';
import type { PortLike } from '@sax/platform';
import { RPC_BY_PORT, type InboundMessage, type OutboundMessage, type PortKind } from './protocol.ts';
import { defaultRelayPolicy, type RelayPolicy } from './relay/policy.ts';
import { Relay } from './relay/relay.ts';
import { SecretOps } from './secret/ops.ts';

export interface VaultOptions {
  paths: AppPaths;
  log: EventLog;
  keyStore: KeyStore;
  /** 테스트만 주입한다. 앱 진입점은 상수 정책을 쓴다. */
  policy?: RelayPolicy;
  /** 테스트 전용 Chrome 인자(헤드리스 등). */
  testChromeArgs?: string[];
  /** 테스트에서 비공개 루트 확인을 건너뛰지 않도록 기본은 OS 구현. */
  dirGuard?: DirGuard;
}

export interface LaunchResult {
  targetId: string;
  webdriver: boolean;
}

/** 금고(TB-1). Chrome 파이프 단독 소유자이며 엔진에는 허용 목록 중계만 준다(ADR-005 v3). */
export class Vault {
  private readonly opts: VaultOptions;
  private readonly policy: RelayPolicy;
  private chrome: LaunchedChrome | null = null;
  relay: Relay | null = null;
  ops: SecretOps | null = null;
  private enginePort: PortLike | null = null;
  private dbKeyIssued = false;
  private profileProblems: string[] | null = null;
  private readonly pendingTriggers = new Map<string, 'local' | 'remote' | 'daemon'>();

  constructor(opts: VaultOptions) {
    this.opts = opts;
    this.policy = opts.policy ?? defaultRelayPolicy(SECRET_ORIGINS, TYPIST_KEY_DELAY_MS, TYPIST_INPUT_MODE);
  }

  attachPort(kind: PortKind, port: PortLike): void {
    if (kind === 'engine') this.enginePort = port;
    port.onMessage((raw) => void this.onPortMessage(kind, port, raw as InboundMessage));
  }

  private post(port: PortLike, msg: OutboundMessage): void {
    port.postMessage(msg);
  }

  private async onPortMessage(kind: PortKind, port: PortLike, msg: InboundMessage): Promise<void> {
    if (msg?.t === 'cdp') {
      if (kind === 'engine' && typeof msg.m === 'string') this.relay?.onEngineMessage(msg.m);
      return;
    }
    if (msg?.t !== 'rpc') return;
    if (!RPC_BY_PORT[kind].includes(msg.method)) {
      this.opts.log.event('vault.rpc_denied', { method: msg.method, port: kind });
      this.post(port, { t: 'rpc', id: msg.id, error: 'denied' });
      return;
    }
    try {
      const result = await this.dispatch(msg.method, msg.params ?? {});
      this.post(port, { t: 'rpc', id: msg.id, result });
    } catch (e) {
      this.post(port, { t: 'rpc', id: msg.id, error: (e as Error).message.slice(0, 200) });
    }
  }

  private async dispatch(method: string, p: Record<string, unknown>): Promise<unknown> {
    switch (method) {
      case 'browser.launch':
        return this.launch();
      case 'browser.shutdown':
        return this.shutdown();
      case 'typist.fill':
        return this.requireOps().fill(p as never);
      case 'secretWindow.openForHuman':
        return this.requireOps().openForHuman(p as never);
      case 'secretWindow.requestClose':
        return this.requireOps().requestClose(p as never);
      case 'getDbKeyOnce':
        return this.getDbKeyOnce();
      case 'run.begin':
        this.setTrigger(String(p.runId), p.trigger as 'local' | 'remote' | 'daemon');
        return {};
      case 'run.end':
        this.ops?.runTriggers.delete(String(p.runId));
        return {};
      case 'secretWindow.userDone':
        await this.requireOps().userDone(String(p.targetId));
        return {};
      case 'secret.provide': {
        const bytes = p.bytes instanceof Uint8Array ? p.bytes : null;
        if (!bytes) throw new Error('bytes required');
        this.requireOps().secrets.provide(String(p.kind), String(p.scope), bytes, typeof p.row === 'number' ? p.row : undefined);
        return {};
      }
      case 'status':
        return { launched: !!this.chrome, profileProblems: this.profileProblems };
    }
    throw new Error('unknown method');
  }

  private setTrigger(runId: string, trigger: 'local' | 'remote' | 'daemon'): void {
    if (this.ops) this.ops.runTriggers.set(runId, trigger);
    else this.pendingTriggers.set(runId, trigger);
  }

  private requireOps(): SecretOps {
    if (!this.ops) throw new Error('browser not launched');
    return this.ops;
  }

  /** 인자 없는 launch(D05 §3.1). 프로필 경로·플래그·엔드포인트는 금고 상수다. */
  async launch(): Promise<LaunchResult> {
    if (this.chrome) throw new Error('already launched');
    const exe = findInstalledChrome();
    if (!exe) throw new Error('chrome not installed');
    const guard = this.opts.dirGuard ?? dirGuard();
    const rootCheck = await guard.checkPrivate(this.opts.paths.root);
    if (!rootCheck.ok) throw new Error(`app root not private: ${rootCheck.problems.join(',')}`);
    const profileDir = this.opts.paths.chromeProfile;
    // 맞으면 그대로 두고, 권한만 틀리면 고치고, 우리 것이 아니면(다른 계정 소유·링크·파일) 치우고 새로 만든다. 그래도 아니면 기동하지 않는다(D05 §3.1).
    const profile = await preparePrivateDir(profileDir, guard);
    if (profile.before.length) this.opts.log.event('vault.profile_dir_problem', { problems: profile.before.join(':'), reason: profile.reason?.join(':'), setAside: profile.setAside, ok: profile.check.ok });
    if (!profile.check.ok) throw new Error(`chrome profile not private: ${profile.check.problems.join(',')}`);
    await writeProfileSettings(profileDir);
    this.chrome = await launchChrome({ executable: exe, profileDir, testArgs: this.opts.testChromeArgs });
    this.chrome.conn.on('close', () => this.opts.log.event('vault.chrome_closed'));

    const relay = new Relay({
      conn: this.chrome.conn,
      policy: this.policy,
      log: this.opts.log,
      toEngine: (raw) => this.enginePort?.postMessage({ t: 'cdp', m: raw } satisfies OutboundMessage),
    });
    this.relay = relay;
    this.ops = new SecretOps(relay, this.policy, this.opts.log);
    for (const [k, v] of this.pendingTriggers) this.ops.runTriggers.set(k, v);
    this.pendingTriggers.clear();
    this.ops.openBlocker = () => (this.profileProblems === null ? 'profile_not_checked' : this.profileProblems[0] ?? null);
    relay.onSecretWindowClosed.add((targetId) => {
      if (this.enginePort) this.post(this.enginePort, { t: 'ev', name: 'secret_window.closed', data: { targetId, ok: true } });
    });
    await relay.init();
    const targetId = await relay.createRunPage();
    const webdriver = await this.selfCheck(targetId);
    void this.checkProfile(profileDir);
    return { targetId, webdriver };
  }

  /** ADR-010 자기 점검: about:blank에서 navigator.webdriver === true여야 자동화를 진행한다. */
  private async selfCheck(targetId: string): Promise<boolean> {
    const t = this.relay!.targets.get(targetId)!;
    if (t.paused) {
      t.paused = false;
      await this.relay!.send('Runtime.runIfWaitingForDebugger', {}, t.vaultSession);
    }
    const r = await this.relay!.send<{ result: { value?: unknown } }>('Runtime.evaluate', { expression: 'navigator.webdriver === true', returnByValue: true }, t.vaultSession);
    const ok = r.result.value === true;
    if (!ok) {
      this.opts.log.event('vault.webdriver_selfcheck_failed');
      t.exposed = false;
    }
    return ok;
  }

  /** 비밀 창 개시 조건(D05 §3.6): Preferences 재확인, 확장 허용 목록, Google 로그인 없음. */
  private async checkProfile(profileDir: string): Promise<void> {
    await new Promise((r) => setTimeout(r, 1500));
    const problems: string[] = [];
    if ((await verifyProfileSettings(profileDir)).length) {
      problems.push('profile_prefs_mismatch');
      this.opts.log.event('vault.profile_prefs_mismatch');
    }
    const ext = (await listInstalledExtensions(profileDir)).filter((id) => !EXTENSION_ALLOWLIST.includes(id));
    if (ext.length) {
      problems.push('extension_not_allowed');
      this.opts.log.event('vault.extension_not_allowed', { count: ext.length });
    }
    if (await hasGoogleSignin(profileDir)) {
      problems.push('google_signin_detected');
      this.opts.log.event('vault.google_signin_detected');
    }
    this.profileProblems = problems;
  }

  /** 프로필 점검이 끝날 때까지 기다린다(테스트·UI). */
  async profileChecked(): Promise<string[]> {
    while (this.profileProblems === null) await new Promise((r) => setTimeout(r, 100));
    return this.profileProblems;
  }

  /** 진단·테스트용(포트 미개방 확인). */
  get chromePid(): number | undefined {
    return this.chrome?.proc.pid;
  }

  /** 금고 기동당 1회(D05 §3.8, A-24). 두 번째는 거부 + 보안 이벤트. */
  async getDbKeyOnce(): Promise<Uint8Array> {
    if (this.dbKeyIssued) {
      this.opts.log.event('vault.dbkey_requested_twice');
      throw new Error('denied');
    }
    this.dbKeyIssued = true;
    return this.opts.keyStore.getOrCreate('db-key', 32);
  }

  async shutdown(): Promise<void> {
    this.ops?.shutdown();
    this.relay?.clearKnownSecrets();
    await this.chrome?.close();
    this.chrome = null;
    this.relay = null;
    this.ops = null;
  }
}
