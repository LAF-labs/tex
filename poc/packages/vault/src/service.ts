import fs from 'node:fs';
import path from 'node:path';
import { dirGuard, preparePrivateDir, type AppPaths, type DirGuard, type EventLog } from '@sax/platform';
import { EXTENSION_ALLOWLIST, SECRET_ORIGINS, TYPIST_INPUT_MODE, TYPIST_KEY_DELAY_MS, VAULT_SELF_SCAN } from './constants.ts';
import { findInstalledChrome } from './chrome/find.ts';
import { launchChrome, type LaunchedChrome } from './chrome/launch.ts';
import { hasGoogleSignin, listInstalledExtensions, removeCrashDumps, verifyProfileSettings, writeProfileSettings } from './chrome/profile.ts';
import type { KeyStore } from './keystore.ts';
import type { PortLike } from '@sax/platform';
import { RPC_BY_PORT, RUN_TRIGGERS, type InboundMessage, type OutboundMessage, type PortKind, type RunTrigger, type SecretInputBind, type VaultEventName } from './protocol.ts';
import { defaultRelayPolicy, type RelayPolicy } from './relay/policy.ts';
import { Relay } from './relay/relay.ts';
import { SecretOps } from './secret/ops.ts';

const RUN_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

/** secretInput 결속 검사(I-1). 맞으면 필요한 필드만 복사해 돌려준다. */
export function parseSecretInputBind(b: unknown): SecretInputBind | null {
  if (!b || typeof b !== 'object') return null;
  const x = b as Record<string, unknown>;
  if (typeof x.runId !== 'string' || !RUN_ID_RE.test(x.runId)) return null;
  if (typeof x.kind !== 'string' || !Object.keys(SECRET_ORIGINS).includes(x.kind)) return null;
  if (x.scope !== 'business' && x.scope !== 'personal') return null;
  if (x.row !== undefined && !(Number.isInteger(x.row) && (x.row as number) >= 1 && (x.row as number) <= 35)) return null;
  const out: SecretInputBind = { runId: x.runId, kind: x.kind as SecretInputBind['kind'], scope: x.scope };
  if (x.row !== undefined) out.row = x.row as number;
  return out;
}

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
  /** 테스트 전용. 기본은 SECRET_TTL_MS. */
  secretTtlMs?: number;
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
  private controlPort: PortLike | null = null;
  private dbKeyIssued = false;
  private profileProblems: string[] | null = null;
  private readonly pendingTriggers = new Map<string, RunTrigger>();
  /** 실행당 종류별 1회 기록(N-46). Chrome을 다시 띄워도 남는다(엔진이 재기동으로 지우지 못하게). */
  private readonly usedSlots = new Set<string>();

  constructor(opts: VaultOptions) {
    this.opts = opts;
    this.policy = opts.policy ?? defaultRelayPolicy(SECRET_ORIGINS, TYPIST_KEY_DELAY_MS, TYPIST_INPUT_MODE);
  }

  attachPort(kind: PortKind, port: PortLike, bind?: unknown): void {
    if (kind === 'secretInput') {
      // 결속 없는 비밀 입력 포트는 붙이지 않는다(I-1, N-44). 렌더러·엔진이 창 시점·라벨을 정하지 못하게.
      const b = parseSecretInputBind(bind);
      if (!b) {
        this.opts.log.event('vault.secret_input_unbound');
        return;
      }
      const state = { used: false };
      port.onMessage((raw) => this.onSecretInput(port, b, state, raw as InboundMessage));
      return;
    }
    if (kind === 'engine') this.enginePort = port;
    if (kind === 'control') this.controlPort = port;
    port.onMessage((raw) => void this.onPortMessage(kind, port, raw as InboundMessage));
  }

  private post(port: PortLike, msg: OutboundMessage): void {
    port.postMessage(msg);
  }

  /** 금고 이벤트(I-2·I-3). */
  private emit(to: ReadonlyArray<'engine' | 'control'>, name: VaultEventName, data: Record<string, unknown>): void {
    for (const k of to) {
      const port = k === 'engine' ? this.enginePort : this.controlPort;
      if (port) this.post(port, { t: 'ev', name, data });
    }
  }

  /** 결속된 포트는 secret.provide를 한 번만 받는다. 그 뒤 메시지는 거부하고 실린 값은 0으로 덮는다. */
  private onSecretInput(port: PortLike, bind: SecretInputBind, state: { used: boolean }, msg: InboundMessage): void {
    if (msg?.t !== 'rpc') return;
    const p = msg.params ?? {};
    const bytes = p.bytes instanceof Uint8Array ? p.bytes : null;
    if (msg.method !== 'secret.provide' || state.used) {
      bytes?.fill(0);
      this.opts.log.event('vault.rpc_denied', { method: msg.method, port: 'secretInput' });
      this.post(port, { t: 'rpc', id: msg.id, error: 'denied' });
      return;
    }
    state.used = true;
    try {
      if (!bytes) throw new Error('bytes required');
      const same = (k: 'kind' | 'scope' | 'row') => p[k] === undefined || p[k] === bind[k];
      if (!same('kind') || !same('scope') || !same('row')) throw new Error('bind_mismatch');
      this.requireOps().secrets.provide(bind, bytes);
      this.post(port, { t: 'rpc', id: msg.id, result: {} });
    } catch (e) {
      bytes?.fill(0);
      this.post(port, { t: 'rpc', id: msg.id, error: (e as Error).message.slice(0, 200) });
    }
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
      case 'run.begin': {
        // 열거형 밖 트리거는 저장하지 않는다(N-77, fail-closed).
        if (!RUN_TRIGGERS.includes(p.trigger as RunTrigger)) throw new Error('bad_trigger');
        this.setTrigger(String(p.runId), p.trigger as RunTrigger);
        return {};
      }
      case 'run.end': {
        const runId = String(p.runId);
        this.ops?.runTriggers.delete(runId);
        this.pendingTriggers.delete(runId);
        this.ops?.secrets.clearRun(runId);
        for (const k of [...this.usedSlots]) if (k.startsWith(runId + '|')) this.usedSlots.delete(k);
        // 열린 창이 없으면 알려진 값 변형을 전부 버린다(N-78).
        if (this.relay && !this.relay.hasOpenWindow()) this.relay.clearKnownSecrets();
        return {};
      }
      case 'secretWindow.userDone':
        await this.requireOps().userDone(String(p.targetId));
        return {};
      case 'status':
        return { launched: !!this.chrome, profileProblems: this.profileProblems };
    }
    throw new Error('unknown method');
  }

  private setTrigger(runId: string, trigger: RunTrigger): void {
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
    await this.removeDumps(profileDir);
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

  /** 전용 Chrome 크래시 덤프 삭제(N-04). 기동 전·종료 뒤. */
  private async removeDumps(profileDir: string): Promise<void> {
    const count = await removeCrashDumps(profileDir).catch(() => 0);
    if (count > 0) this.opts.log.event('vault.chrome_dump_removed', { count });
    else if (count < 0) this.opts.log.event('vault.chrome_dump_dir_link');
  }

  private async attachRelay(conn: LaunchedChrome['conn']): Promise<LaunchResult> {
    // 내린 뒤의 옛 중계·비밀 동작 이벤트는 다음 Chrome의 포트로 보내지 않는다.
    const emit = (to: ReadonlyArray<'engine' | 'control'>, name: VaultEventName, data: Record<string, unknown>) => {
      if (this.relay === relay) this.emit(to, name, data);
    };
    const relay: Relay = new Relay({
      conn,
      policy: this.policy,
      log: this.opts.log,
      toEngine: (raw) => {
        if (this.relay === relay) this.enginePort?.postMessage({ t: 'cdp', m: raw } satisfies OutboundMessage);
      },
      onLeakSuspected: (hits) => emit(['engine', 'control'], 'secret_window.leak_suspected', { hits }),
    });
    this.relay = relay;
    this.ops = new SecretOps(relay, this.policy, this.opts.log, {
      secretTtlMs: this.opts.secretTtlMs,
      selfScan: VAULT_SELF_SCAN ? { roots: [this.opts.paths.logs, this.opts.paths.staging] } : undefined,
      emit,
      usedSlots: this.usedSlots,
    });
    for (const [k, v] of this.pendingTriggers) this.ops.runTriggers.set(k, v);
    this.pendingTriggers.clear();
    this.ops.openBlocker = () => this.profileBlocker();
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

  /** 비밀 창 개시 조건(D05 §3.6): Preferences 재확인, 확장 허용 목록, Google 로그인 없음. 기동 1.5초 뒤 점검은 status용이다. */
  private async checkProfile(profileDir: string, generation: number): Promise<void> {
    await new Promise((r) => setTimeout(r, 1500));
    const problems = await this.readProfileProblems(profileDir);
    if (generation === this.generation) this.profileProblems = problems; // 그사이 내리고 다시 띄웠으면 앞 기동의 결과로 덮지 않는다
  }

  /** 창을 열 때마다 프로필 파일을 다시 읽는다(N-18). 기동 뒤 첫 점검 전이면 profile_not_checked. */
  private async profileBlocker(): Promise<string | null> {
    if (this.profileProblems === null) return 'profile_not_checked';
    return (await this.readProfileProblems(this.opts.paths.chromeProfile))[0] ?? null;
  }

  private async readProfileProblems(profileDir: string): Promise<string[]> {
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
    return problems;
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
    const ks = this.opts.keyStore;
    try {
      const existing = await ks.get('db-key', 32);
      if (existing) return existing;
      // 키가 없는데 DB가 있으면 새 키로 덮지 않는다(N-30). 원장·중복 이력이 조용히 리셋되지 않게.
      if (fs.existsSync(path.join(this.opts.paths.db, 'db.sqlite'))) {
        this.opts.log.event('vault.dbkey_missing');
        throw new Error('db.key_missing');
      }
      const created = await ks.create('db-key', 32);
      // 첫 기동 경쟁: 되읽은 값이 만든 값과 같을 때만 쓴다.
      const back = await ks.get('db-key', 32);
      if (!back || Buffer.compare(Buffer.from(back), Buffer.from(created)) !== 0) throw new Error('vault.keystore_mismatch');
      return created;
    } catch (e) {
      if ((e as Error).message === 'vault.keystore_mismatch') this.opts.log.event('vault.keystore_mismatch');
      throw e;
    }
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
    if (chrome) await this.removeDumps(this.opts.paths.chromeProfile);
    if (this.chrome === chrome) this.chrome = null;
  }
}
