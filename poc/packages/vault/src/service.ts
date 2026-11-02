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
  /** 테스트 전용. 기본은 LAUNCH_TIMEOUT_MS. */
  launchTimeoutMs?: number;
}

/** Chrome을 띄운 뒤 붙기까지의 상한. 응답 없는 Chrome(멈춘 파이프)에 붙는 중이면 끝나지 않으므로, 넘으면 내리고 실패한다. 보통 2초 안쪽이다. */
export const LAUNCH_TIMEOUT_MS = 30_000;

export interface LaunchResult {
  targetId: string;
  webdriver: boolean;
}

/** 금고(TB-1). Chrome 파이프 단독 소유자이며 엔진에는 허용 목록 중계만 준다(ADR-005 v3). */
export class Vault {
  private readonly opts: VaultOptions;
  private readonly policy: RelayPolicy;
  private chrome: LaunchedChrome | null = null;
  private launching = false;
  /** shutdown마다 늘린다. 기동 중에 내리기가 오면 기동이 자기 세대가 지난 것을 보고 그만둔다. */
  private generation = 0;
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
        this.pendingTriggers.delete(String(p.runId));
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
    // 기동 중에 또 오면 거부한다. 같은 프로필 폴더를 두 번 준비하면 한쪽이 다른 쪽이 쓰는 폴더를 치울 수 있다.
    if (this.chrome || this.launching) throw new Error('already launched');
    this.launching = true;
    this.profileProblems = null; // 이 기동의 프로필 점검 전까지 비밀 창을 열지 않는다(D05 §3.6)
    try {
      return await this.startChrome(this.generation);
    } finally {
      this.launching = false;
    }
  }

  /** 앞 단계(폴더 확인 도구)는 도구마다 상한이 있다(acl.ts). Chrome을 띄운 뒤는 LAUNCH_TIMEOUT_MS로 끊는다. */
  private async startChrome(generation: number): Promise<LaunchResult> {
    const current = (): boolean => generation === this.generation;
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
    if (!current()) throw new Error('launch cancelled'); // 준비 중에 내리기가 왔으면 띄우지 않는다
    const chrome = await launchChrome({ executable: exe, profileDir, testArgs: this.opts.testChromeArgs });
    this.chrome = chrome;
    chrome.conn.on('close', () => {
      this.opts.log.event('vault.chrome_closed');
      // 엔진 transport도 닫는다. 알리지 않으면 Playwright는 끊긴 줄 모르고 닫힌 Chrome의 페이지를 쓴다. 다음 Chrome이 이미 떴으면 보내지 않는다.
      if (this.enginePort && (this.chrome === chrome || this.chrome === null)) this.post(this.enginePort, { t: 'cdp_closed' });
    });
    // 넘으면 내린다. Chrome을 닫으면 파이프가 닫히며 대기 중 요청이 거부되어 기동이 끝난다.
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      void this.shutdown().catch(() => {});
    }, this.opts.launchTimeoutMs ?? LAUNCH_TIMEOUT_MS);
    try {
      if (!current()) throw new Error('launch cancelled'); // 띄우는 동안 온 내리기는 아직 이 Chrome을 몰랐다
      const result = await this.attachRelay(chrome.conn);
      if (!current()) throw new Error('launch cancelled');
      void this.checkProfile(profileDir, generation);
      return result;
    } catch (e) {
      clearTimeout(timer);
      // 원인은 실패한 그 순간에 정한다. 이어지는 정리 동안 상한이 지나도 바뀌지 않게. 내리기로 파이프가 닫힌 것은 취소로 알린다.
      const cause = timedOut ? new Error('chrome launch timed out') : current() ? e : new Error('launch cancelled');
      // 띄운 Chrome을 남기면 다음 launch가 already launched로 막힌다. 닫고 처음 상태로 돌린다.
      await this.shutdown().catch(() => {});
      throw cause;
    } finally {
      clearTimeout(timer);
    }
  }

  private async attachRelay(conn: LaunchedChrome['conn']): Promise<LaunchResult> {
    const relay = new Relay({
      conn,
      policy: this.policy,
      log: this.opts.log,
      // 내린 뒤의 옛 중계 출력(늦은 응답·오류)은 다음 Chrome에 붙은 엔진 연결로 보내지 않는다.
      toEngine: (raw) => {
        if (this.relay === relay) this.enginePort?.postMessage({ t: 'cdp', m: raw } satisfies OutboundMessage);
      },
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
    const webdriver = await this.selfCheck(relay, targetId);
    return { targetId, webdriver };
  }

  /** ADR-010 자기 점검: about:blank에서 navigator.webdriver === true여야 자동화를 진행한다. 기동 중 내리기로 this.relay가 비어도 이 기동의 중계를 쓴다. */
  private async selfCheck(relay: Relay, targetId: string): Promise<boolean> {
    const t = relay.targets.get(targetId);
    if (!t) throw new Error('run page not found');
    if (t.paused) {
      t.paused = false;
      await relay.send('Runtime.runIfWaitingForDebugger', {}, t.vaultSession);
    }
    const r = await relay.send<{ result: { value?: unknown } }>('Runtime.evaluate', { expression: 'navigator.webdriver === true', returnByValue: true }, t.vaultSession);
    const ok = r.result.value === true;
    if (!ok) {
      this.opts.log.event('vault.webdriver_selfcheck_failed');
      t.exposed = false;
    }
    return ok;
  }

  /** 비밀 창 개시 조건(D05 §3.6): Preferences 재확인, 확장 허용 목록, Google 로그인 없음. */
  private async checkProfile(profileDir: string, generation: number): Promise<void> {
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
    if (generation === this.generation) this.profileProblems = problems; // 그사이 내리고 다시 띄웠으면 앞 기동의 결과로 덮지 않는다
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
    this.generation++;
    this.profileProblems = null;
    // 닫기를 기다리기 전에 떼어 낸다. 닫는 동안 온 run.begin·secret.provide가 버려질 ops에 들어가지 않게.
    // chrome은 닫힐 때까지 남겨 그사이의 launch를 already launched로 막는다.
    const { ops, relay, chrome } = this;
    this.ops = null;
    this.relay = null;
    // 실행 트리거(run.begin)는 Chrome보다 오래 산다. 다시 띄우면 새 ops로 옮긴다.
    for (const [k, v] of ops?.runTriggers ?? []) this.pendingTriggers.set(k, v);
    ops?.shutdown();
    relay?.clearKnownSecrets();
    await chrome?.close();
    if (this.chrome === chrome) this.chrome = null;
  }
}
