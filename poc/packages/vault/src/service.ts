import fs from 'node:fs';
import path from 'node:path';
import { dirGuard, preparePrivateDir, type AppPaths, type DirGuard, type EventLog } from '@sax/platform';
import { downloadPreferences, EXTENSION_ALLOWLIST, LOOPBACK_ORIGINS, LOOPBACK_PERMISSION_NAMES, SECRET_ORIGINS, SECRET_TTL_MS, TYPIST_INPUT_MODE, TYPIST_KEY_DELAY_MS, VAULT_SELF_SCAN } from './constants.ts';
import { CHROME_NOT_INSTALLED, findInstalledChrome } from './chrome/find.ts';
import { launchChrome, type LaunchedChrome } from './chrome/launch.ts';
import { hasGoogleSignin, listInstalledExtensions, removeCrashDumps, removeProfileResidue, verifyProfileSettings, writeProfileSettings } from './chrome/profile.ts';
import type { KeyStore } from './keystore.ts';
import type { PortLike } from '@sax/platform';
import {
  PORTAL_LOGIN_ID_MAX, RPC_BY_PORT, RUN_TRIGGERS, isProfileScope, isTypistKind, SECURITY_CARD_ROWS, STORABLE_KINDS,
  SESSION_EVENTS, CODEF_REQ_ID_RE, type CodefSealParams, type InboundMessage, type ProfileScope, type SecretStoreResult, type OneShotBind, type PortalField, type SessionEventKind, type OutboundMessage, type PortKind, type RunTrigger, type SecretInputBind, type SecretKind, type StorableKind, type VaultEventName,
} from './protocol.ts';
import { defaultRelayPolicy, type RelayPolicy } from './relay/policy.ts';
import { VaultCrypto } from './crypto/ops.ts';
import { readNpkiLoginPair, scanNpki, type NpkiFs, type NpkiRoot } from './npki-scan.ts';
import { CodefSealer } from './codef-seal.ts';
import { CommitGuard } from './relay/commit-guard.ts';
import { PdfSaver, sweepStagingDir } from './pdf/save.ts';
import { Relay } from './relay/relay.ts';
import { SecretOps, type StoredRead } from './secret/ops.ts';
import { HumanSecretVault } from './keychain/human.ts';
import { MemoryItemStore, MemoryWrapper, UnavailableHello } from './keychain/backend.ts';

/** 진행 화면 중계 간격(초당 3장 남짓, 부장 지시 2~4장). */
const MIRROR_FRAME_MS = 300;

const RUN_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const NOTICE_VERSION_RE = /^[A-Za-z0-9._-]{1,32}$/;

/**
 * 등록 창이 함께 넘긴 포털 아이디 검사(비밀 아님, ADR-035). 없으면 undefined, 틀리면 null.
 * 금고는 이 값을 저장·로그하지 않고 secret.store 결과로 돌려줄 뿐이다.
 */
function parsePortalLoginId(v: unknown): string | undefined | null {
  if (v === undefined) return undefined;
  if (typeof v !== 'string') return null;
  const s = v.normalize('NFC').trim();
  if (!s || s.length > PORTAL_LOGIN_ID_MAX || /[\p{Cc}\s]/u.test(s)) return null;
  return s;
}

interface NeedLike {
  runId: unknown;
  kind: unknown;
  scope: unknown;
  row?: unknown;
}
const needKey = (n: NeedLike): string => `${String(n.runId)}|${String(n.kind)}|${String(n.scope)}|${n.row ?? ''}`;

const isRow = (r: unknown): r is number => Number.isInteger(r) && (r as number) >= SECURITY_CARD_ROWS.min && (r as number) <= SECURITY_CARD_ROWS.max;

/** secretInput 결속 검사(I-1). 맞으면 필요한 필드만 복사해 돌려준다. mode가 없으면 oneshot(PoC 호환). */
export function parseSecretInputBind(b: unknown): SecretInputBind | null {
  if (!b || typeof b !== 'object') return null;
  const x = b as Record<string, unknown>;
  if (!isProfileScope(x.scope)) return null;
  if (x.mode === 'store') {
    // 등록 창(T-06)은 보안카드·포털 비밀번호만. 인증서 비밀번호는 등록 창이 아니라 처음 쓸 때 금고가 기억한다(대표 지시 2026-11-13, ADR-020 결정 2 갱신).
    if (typeof x.kind !== 'string' || x.kind === 'cert_password' || !(STORABLE_KINDS as readonly string[]).includes(x.kind)) return null;
    const notice = x.notice as Record<string, unknown> | undefined;
    if (!notice || typeof notice.version !== 'string' || !NOTICE_VERSION_RE.test(notice.version)) return null;
    if (x.runId !== undefined || x.row !== undefined) return null;
    return { mode: 'store', kind: x.kind as StorableKind, scope: x.scope, notice: { version: notice.version } };
  }
  if (x.mode === 'codef') {
    // 계좌 자동조회 인증서 비밀번호 창(codef-seal.ts). 금고가 연 요청 id만.
    if (typeof x.reqId !== 'string' || !CODEF_REQ_ID_RE.test(x.reqId) || x.kind !== undefined || x.runId !== undefined || x.row !== undefined) return null;
    return { mode: 'codef', reqId: x.reqId, scope: x.scope };
  }
  if (x.mode !== undefined && x.mode !== 'oneshot') return null;
  if (typeof x.runId !== 'string' || !RUN_ID_RE.test(x.runId)) return null;
  // 1회용 입력 창은 타이피스트가 넣는 종류와, 인증서 비밀번호(금고가 칸을 잡고 앱 창으로 받는다, 부장 지시 2026-11-13 (b)).
  // 어느 쪽이든 금고가 먼저 secret.needed로 부른 결속만 붙는다(attachPort의 hasNeed).
  if (!(isTypistKind(x.kind) || x.kind === 'cert_password') || !Object.hasOwn(SECRET_ORIGINS, x.kind)) return null;
  if (x.kind === 'cert_password' && x.row !== undefined) return null;
  // 보안카드는 칸 하나씩(row 필수), 포털 비밀번호는 칸 번호가 없다(D05 §4).
  if (x.kind === 'security_card' ? !isRow(x.row) : x.row !== undefined) return null;
  const out: OneShotBind = { runId: x.runId, kind: x.kind as SecretKind, scope: x.scope };
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
  /**
   * 창 없는 Chrome으로 띄운다(시험·측정 전용, 기본 false). 앱은 창 있는 Chrome을 앱 창 뒤 브라우저 패널 자리에 두고
   * [브라우저] 토글로 앞으로 올린다(대표 지시 2026-11-13 "claude desktop처럼 버튼을 누르면 브라우저가 보이게").
   */
  headless?: boolean;
  /**
   * 기억값이 없는 첫 인증서 비밀번호를 앱 금고 입력 창(secret.needed → secretInput 포트)으로 받는다(기본 true, 부장 지시 2026-11-13 (b)).
   * false면 옛 길: 사람이 Chrome의 그 칸에 직접 친다(그 길을 보는 시험만).
   */
  certFromApp?: boolean;
  /** 테스트에서 비공개 루트 확인을 건너뛰지 않도록 기본은 OS 구현. */
  dirGuard?: DirGuard;
  /** 테스트 전용. 기본은 LAUNCH_TIMEOUT_MS. */
  launchTimeoutMs?: number;
  /** 테스트 전용. 기본은 SECRET_TTL_MS. */
  secretTtlMs?: number;
  /** R-C1 무장 유효 시간(시험용, 기본 COMMIT_ARM_TTL_MS). */
  commitArmTtlMs?: number;
  /**
   * 사람 비밀(세션 결박) 저장소(ADR-026). 앱 진입점은 keychainBackend()로 만든다.
   * 없으면 메모리 백엔드(저장해도 프로세스 밖에 남지 않음, 시험·픽스처 모드).
   */
  human?: HumanSecretVault;
  /** 시험 전용: NPKI 탐지 위치·파일 접근(감사). 기본은 표준 위치·node:fs. */
  npki?: { roots?: NpkiRoot[]; fs?: NpkiFs };
  /** 시험 전용: PDF 저장 상한(기본 PDF_MAX_BYTES)·다운로드 무장 유효 시간(기본 DOWNLOAD_ARM_TTL_MS). */
  pdf?: { maxBytes?: number; armTtlMs?: number };
}

/** 앱 패널 위 읽기 전용 주소 한 줄: 출처와 경로만(검색어·조각은 싣지 않는다). http(s)가 아니면 빈 글. */
export function pageAddress(url: string): string {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' || u.protocol === 'http:' ? `${u.host}${u.pathname}`.slice(0, 200) : '';
  } catch {
    return '';
  }
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
  private pdf: PdfSaver | null = null;
  private readonly policy: RelayPolicy;
  private chrome: LaunchedChrome | null = null;
  private launching = false;
  /** 지금 Chrome이 창 없이 떴나(시험·옵션만, 앱은 창 있는 Chrome). */
  private headlessNow = false;
  /** shutdown마다 늘린다. 기동 중에 내리기가 오면 기동이 자기 세대가 지난 것을 보고 그만둔다. */
  private generation = 0;
  relay: Relay | null = null;
  ops: SecretOps | null = null;
  private enginePort: PortLike | null = null;
  private controlPort: PortLike | null = null;
  private dbKeyIssued = false;
  private profileProblems: string[] | null = null;
  private readonly pendingTriggers = new Map<string, RunTrigger>();
  /** 금고가 보낸 secret.needed(runId|kind|scope|row → 만료 시각). 1회용 입력 창은 여기에 있는 결속만 받는다. Chrome을 다시 띄워도 남는다. */
  private readonly needs = new Map<string, number>();
  /** run별 활성 프로필(Q-2). run.begin에서 고정하고 run.end까지 바꾸지 않는다. */
  private readonly runProfiles = new Map<string, ProfileScope>();
  /** 실행당 종류별 1회 기록(N-46). Chrome을 다시 띄워도 남는다(엔진이 재기동으로 지우지 못하게). */
  private readonly usedSlots = new Set<string>();
  readonly human: HumanSecretVault;
  /** 장기 키 연산(D05 §5.1). Chrome과 무관하게 산다. */
  readonly crypto: VaultCrypto;
  /** 계좌 자동조회(CODEF) 로그인 봉인. Chrome과 무관하게 산다. */
  readonly codef: CodefSealer;

  constructor(opts: VaultOptions) {
    this.opts = opts;
    this.policy = opts.policy ?? defaultRelayPolicy(SECRET_ORIGINS, TYPIST_KEY_DELAY_MS, TYPIST_INPUT_MODE);
    this.crypto = new VaultCrypto({ keyStore: opts.keyStore, log: opts.log });
    this.human = opts.human ?? new HumanSecretVault({ backend: { items: new MemoryItemStore(), wrapper: new MemoryWrapper(), hello: new UnavailableHello() }, log: opts.log });
    this.codef = new CodefSealer({
      log: opts.log,
      store: this.human.codef,
      readPair: (certId) => readNpkiLoginPair(certId, { roots: this.opts.npki?.roots, fs: this.opts.npki?.fs }),
      askWindow: (data) => this.emit(['control'], 'secret.needed', data),
      ttlMs: opts.secretTtlMs,
    });
    // 잠기면 KEK는 HumanSecretVault가 지운다. main에는 상태만 알린다.
    const wipe = this.human.lock.onLock;
    this.human.lock.onLock = (reason) => {
      wipe(reason);
      this.emit(['control'], 'vault.state', { open: false, reason });
    };
  }

  /** 타이피스트가 1회용 값이 없을 때 부른다. 보안카드는 row, 포털은 pw 칸(포털 아이디는 금고에 없다, ADR-035). */
  private readStored(kind: string, scope: string, row?: number): Promise<StoredRead> {
    if (!(STORABLE_KINDS as readonly string[]).includes(kind) || !isProfileScope(scope)) return Promise.resolve({ ok: false, reason: 'secret_missing' });
    const cell: { row?: number; field?: PortalField } = kind === 'security_card' ? { row } : { field: 'pw' };
    return this.human.readOne(kind as StorableKind, scope, cell);
  }

  attachPort(kind: PortKind, port: PortLike, bind?: unknown): void {
    if (kind === 'secretInput') {
      // 결속 없는 비밀 입력 포트는 붙이지 않는다(I-1, N-44). 렌더러·엔진이 창 시점·라벨을 정하지 못하게.
      const b = parseSecretInputBind(bind);
      if (!b) {
        this.opts.log.event('vault.secret_input_unbound');
        return;
      }
      // 1회용 입력 창은 금고가 secret.needed로 부른 것만 붙인다(비밀 창은 금고가 부른다, ADR-025 결정 10).
      if (b.mode === 'codef' && !this.codef.hasPending(b.reqId, b.scope)) {
        this.opts.log.event('vault.secret_input_unrequested', { kind: 'codef' });
        return;
      }
      if (b.mode !== 'store' && b.mode !== 'codef' && !this.hasNeed(b)) {
        this.opts.log.event('vault.secret_input_unrequested', { kind: b.kind });
        return;
      }
      const state = { used: false };
      port.onMessage((raw) => this.onSecretInput(port, b, state, raw as InboundMessage));
      return;
    }
    if (kind === 'engine') this.enginePort = port;
    if (kind === 'control') {
      this.controlPort = port;
      // 기동 중(설정 읽는 동안)에는 session.* 응답이 startup이다. 붙은 control 포트에 설정을 다 읽은 뒤의 실제 상태를 한 번 알린다
      // (포트가 설정 읽기보다 먼저 붙든 나중에 붙든).
      void this.human.ready().then(() => {
        if (this.controlPort !== port) return;
        const v = this.human.lock.check();
        this.post(port, { t: 'ev', name: 'vault.state', data: v.open ? { open: true } : { open: false, reason: v.reason } });
      });
    }
    port.onMessage((raw) => void this.onPortMessage(kind, port, raw as InboundMessage));
  }

  private post(port: PortLike, msg: OutboundMessage): void {
    port.postMessage(msg);
  }

  /** 금고 이벤트(I-2·I-3). */
  /** secret.needed를 기록한다. 만료된 기록은 이때 함께 지운다. */
  private recordNeed(n: NeedLike): void {
    const now = Date.now();
    for (const [k, until] of this.needs) if (now > until) this.needs.delete(k);
    this.needs.set(needKey(n), now + (this.opts.secretTtlMs ?? SECRET_TTL_MS));
  }

  /** 금고가 보낸 secret.needed가 아직 살아 있나(만료된 것은 지운다). */
  private hasNeed(b: OneShotBind): boolean {
    const k = needKey(b);
    const until = this.needs.get(k);
    if (until === undefined) return false;
    if (Date.now() > until) {
      this.needs.delete(k);
      return false;
    }
    return true;
  }

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
    const entryBytes = Array.isArray(p.entries) ? (p.entries as Array<{ bytes?: unknown }>).map((e) => (e?.bytes instanceof Uint8Array ? e.bytes : null)) : [];
    const wipe = () => {
      bytes?.fill(0);
      for (const b of entryBytes) b?.fill(0);
    };
    // 결속 모드가 메서드를 정한다: oneshot은 secret.provide, store(T-06)는 secret.store. 한 포트에서 한 번만.
    const expected = bind.mode === 'store' ? 'secret.store' : 'secret.provide';
    if (msg.method !== expected || state.used) {
      wipe();
      this.opts.log.event('vault.rpc_denied', { method: msg.method, port: 'secretInput' });
      this.post(port, { t: 'rpc', id: msg.id, error: 'denied' });
      return;
    }
    state.used = true;
    if (bind.mode === 'store') {
      const entries = Array.isArray(p.entries) ? (p.entries as Array<Record<string, unknown>>) : [];
      const parsed = entries.map((e, i) => ({ row: e?.row as number | undefined, field: e?.field as PortalField | undefined, bytes: entryBytes[i] ?? new Uint8Array() }));
      // 포털 아이디는 비밀이 아니다. 포털 결속에서만 받고, 저장하지 않고 결과로 돌려준다(D05 §2·§4, ADR-035).
      const loginId = parsePortalLoginId(p.portalLoginId);
      if (loginId === null || (loginId !== undefined && bind.kind !== 'portal_password')) {
        wipe();
        this.post(port, { t: 'rpc', id: msg.id, error: 'bad_login_id' });
        return;
      }
      // 결속 kind가 칸 모양을 정한다: 보안카드는 row만, 포털은 field: 'pw'만(human.store가 다시 검사한다).
      void this.human.store(bind.kind, bind.scope, parsed, bind.notice).then(
        (consent) => {
          const result: SecretStoreResult = { handle: { kind: bind.kind, scope: bind.scope }, tier: consent.tier, consent };
          if (loginId !== undefined) result.portalLoginId = loginId;
          this.post(port, { t: 'rpc', id: msg.id, result });
        },
        (e: Error) => {
          wipe();
          this.post(port, { t: 'rpc', id: msg.id, error: e.message.slice(0, 80) });
        },
      );
      return;
    }
    if (bind.mode === 'codef') {
      try {
        if (!bytes) throw new Error('bytes required');
        if (p.scope !== undefined && p.scope !== bind.scope) throw new Error('bind_mismatch');
        // 값의 주인은 sealer다(감싼 뒤 지운다). 실패하면 sealer가 지운다.
        this.codef.provide(bind.reqId, bytes, p.remember === true);
        this.post(port, { t: 'rpc', id: msg.id, result: {} });
      } catch (e) {
        bytes?.fill(0);
        this.post(port, { t: 'rpc', id: msg.id, error: (e as Error).message.slice(0, 80) });
      }
      return;
    }
    try {
      if (!bytes) throw new Error('bytes required');
      const same = (k: 'kind' | 'scope' | 'row') => p[k] === undefined || p[k] === bind[k];
      if (!same('kind') || !same('scope') || !same('row')) throw new Error('bind_mismatch');
      // 포트를 붙인 뒤 요청이 만료·소비됐으면(같은 요청에 창이 둘 등) 받지 않는다.
      if (!this.hasNeed(bind)) throw new Error('not_requested');
      const ops = this.requireOps();
      ops.secrets.provide(bind, bytes);
      this.needs.delete(needKey(bind));
      // 인증서 비밀번호(앱 입력 창): 기다리던 칸에 금고가 바로 넣는다(SecretOps.appProvided).
      if (bind.kind === 'cert_password') void ops.appProvided(bind);
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
      case 'typist.fill': {
        // run에 고정된 프로필과 다른 scope는 넣지 않는다(run 중 프로필 전환 없음, Q-2).
        const pinned = this.runProfiles.get(String(p.runId));
        const scope = (p.secret as { scope?: unknown } | undefined)?.scope;
        if (pinned !== undefined && scope !== pinned) {
          this.opts.log.event('vault.profile_mismatch', { runId: String(p.runId).slice(0, 64) });
          return { ok: false, reason: 'denied' };
        }
        return this.requireOps().fill(p as never);
      }
      case 'secretWindow.openForHuman':
        return this.requireOps().openForHuman(p as never);
      case 'secretWindow.requestClose':
        return this.requireOps().requestClose(p as never);
      case 'getDbKeyOnce':
        return this.getDbKeyOnce();
      case 'crypto.publicKeys':
        return this.crypto.publicKeys();
      case 'crypto.noiseDH':
        return { shared: await this.crypto.noiseDH(p) };
      case 'crypto.signVd':
        return { sig: await this.crypto.signVd(p) };
      case 'crypto.signAik':
        return { sig: await this.crypto.signAik(p) };
      case 'crypto.hpkeOpen':
        return { pt: await this.crypto.hpkeOpen(p) };
      case 'commitGuard.arm':
        return this.requireGuard().arm(p);
      case 'commitGuard.disarm':
        this.requireGuard().disarm(p);
        return {};
      case 'pdf.print':
        return this.requirePdf().print(p);
      case 'download.arm':
        return this.requirePdf().arm(p);
      case 'download.disarm':
        this.requirePdf().disarm();
        return {};
      case 'run.begin': {
        // 열거형 밖 트리거는 저장하지 않는다(N-77, fail-closed).
        if (!RUN_TRIGGERS.includes(p.trigger as RunTrigger)) throw new Error('bad_trigger');
        const runId = String(p.runId);
        if (p.profile !== undefined) {
          if (!isProfileScope(p.profile)) throw new Error('bad_profile');
          const was = this.runProfiles.get(runId);
          if (was !== undefined && was !== p.profile) throw new Error('profile_locked');
          this.runProfiles.set(runId, p.profile);
        }
        this.setTrigger(runId, p.trigger as RunTrigger);
        return {};
      }
      case 'run.end': {
        const runId = String(p.runId);
        this.ops?.runTriggers.delete(runId);
        this.pendingTriggers.delete(runId);
        this.runProfiles.delete(runId);
        for (const k of [...this.needs.keys()]) if (k.startsWith(runId + '|')) this.needs.delete(k);
        this.ops?.secrets.clearRun(runId);
        this.relay?.commitGuard?.clearRun(runId);
        for (const k of [...this.usedSlots]) if (k.startsWith(runId + '|')) this.usedSlots.delete(k);
        // 열린 창이 없으면 알려진 값 변형을 전부 버린다(N-78).
        if (this.relay && !this.relay.hasOpenWindow()) this.relay.clearKnownSecrets();
        // 엄격 모드: 실행이 끝나면 Hello로 연 금고를 즉시 잠근다(ADR-026 결정 4).
        this.human.lock.runEnded();
        return {};
      }
      case 'typist.authFailed': {
        // 포털의 명시적 인증 실패 1회 → suspect(ADR-026 결정 7). 엔진이 거짓으로 보내도 할 수 있는 일은 입력 정지뿐이다.
        const kind = String(p.kind);
        if (!(STORABLE_KINDS as readonly string[]).includes(kind) || !isProfileScope(p.scope)) throw new Error('bad_params');
        if (await this.human.markSuspect(kind as StorableKind, p.scope)) this.emit(['control'], 'secret.suspect', { kind, scope: p.scope });
        return {};
      }
      case 'session.event': {
        if (!(SESSION_EVENTS as readonly string[]).includes(String(p.kind))) throw new Error('bad_params');
        return this.vaultState(this.human.lock.sessionEvent(p.kind as SessionEventKind));
      }
      case 'session.idle': {
        if (typeof p.idleSec !== 'number') throw new Error('bad_params');
        return this.vaultState(this.human.lock.reportIdle(p.idleSec));
      }
      case 'vault.unlock': {
        const task = typeof p.task === 'string' ? p.task.slice(0, 40) : '';
        const portal = typeof p.portal === 'string' ? p.portal.slice(0, 20) : '';
        const r = await this.human.unlockWithHello({ task, portal });
        if (r.ok) this.emit(['control'], 'vault.state', { open: true });
        return r;
      }
      case 'vault.setStrict':
        if (typeof p.on !== 'boolean') throw new Error('bad_params');
        return this.human.setStrict(p.on);
      case 'secret.list':
        return this.human.list();
      case 'secret.has':
      case 'secret.forget': {
        const kind = String(p.kind);
        if (!(STORABLE_KINDS as readonly string[]).includes(kind) || !isProfileScope(p.scope)) throw new Error('bad_params');
        return method === 'secret.has' ? this.human.has(kind as StorableKind, p.scope) : this.human.forget(kind as StorableKind, p.scope);
      }
      case 'secretWindow.userDone':
        await this.requireOps().userDone(String(p.targetId));
        return {};
      case 'account.refresh.read':
        return this.human.account.read();
      case 'account.refresh.write':
        return this.human.account.write(p.token as string);
      case 'account.refresh.forget':
        return { removed: await this.human.account.forget() };
      case 'codef.seal':
        return this.codef.seal(p as unknown as CodefSealParams);
      case 'codef.cancel':
        this.codef.cancel();
        return {};
      case 'codef.windowClosed':
        this.codef.cancel(typeof p.reqId === 'string' ? p.reqId : '');
        return {};
      case 'codef.forget': {
        if (!isProfileScope(p.scope) || typeof p.certId !== 'string') throw new Error('bad_params');
        return { removed: await this.codef.forget(p.scope, p.certId) };
      }
      case 'npki.list':
        return scanNpki({ roots: this.opts.npki?.roots, fs: this.opts.npki?.fs, log: this.opts.log });
      case 'status':
        return { launched: !!this.chrome, headless: !!this.chrome && this.headlessNow, profileProblems: this.profileProblems };
      case 'browser.focus':
        // 창 없는 Chrome(시험 옵션)은 앞으로 올릴 창이 없다.
        if (this.headlessNow) return { focused: false, headless: true };
        return { focused: this.relay ? await this.relay.bringToFront() : false };
      case 'screen.start':
        return { started: await this.startMirror() };
      case 'screen.stop':
        await this.stopMirror();
        return {};
      case 'browser.place': {
        const n = (k: string) => {
          const v = p[k];
          if (typeof v !== 'number' || !Number.isInteger(v) || Math.abs(v) > 100_000) throw new Error('bad_params');
          return v;
        };
        const bounds = { left: n('x'), top: n('y'), width: n('width'), height: n('height') };
        if (bounds.width < 200 || bounds.height < 200) throw new Error('bad_params');
        if (this.headlessNow) return { placed: false, headless: true };
        return { placed: this.relay ? await this.relay.placeWindow(bounds, p.front === true) : false };
      }
    }
    // RPC_BY_PORT에 있으나 아직 구현하지 않은 메서드(M1-3 진행 중). 거부한다.
    throw new Error('not_implemented');
  }

  /** 진행 화면 중계 상태(B3). 실행 탭 하나만, 보기 전용. */
  private mirror: { targetId: string; session: string; last: number; paused: boolean } | null = null;

  /**
   * 실행 탭 화면을 main에 중계한다(Page.startScreencast, 금고 감시 세션). 엔진은 이 프레임을 받지 않는다.
   * 비밀 창이 열린 동안은 프레임을 보내지 않고 screen.paused만 보낸다(ACTIVE_WINDOW_DENY_PREFIXES의 Page.startScreencast 규칙과 같은 뜻).
   * 같은 탭이면 그대로 둔다(main이 실행이 바뀔 때마다 불러도 된다). 팝업 창이 실행 탭이 되면 그쪽으로 옮긴다.
   */
  private async startMirror(): Promise<boolean> {
    const relay = this.relay;
    const t = relay?.runWindowTarget();
    if (!relay || !t) return false;
    if (this.mirror?.targetId === t.targetId) return true;
    await this.stopMirror();
    const m = { targetId: t.targetId, session: t.vaultSession, last: 0, paused: !!(t.win && t.win.phase === 'active') };
    this.mirror = m;
    relay.onWindowActive = (w, active) => {
      if (this.mirror !== m || w.targetId !== m.targetId || m.paused === active) return;
      m.paused = active;
      this.emit(['control'], 'screen.paused', { paused: active });
    };
    relay.onScreencastFrame = (w, p) => {
      if (w.targetId !== m.targetId) return;
      void relay.send('Page.screencastFrameAck', { sessionId: p.sessionId }, m.session).catch(() => {});
      if (this.mirror !== m || m.paused || (w.win && w.win.phase === 'active')) return;
      const now = Date.now();
      if (now - m.last < MIRROR_FRAME_MS) return;
      m.last = now;
      const meta = (p.metadata ?? {}) as Record<string, unknown>;
      this.emit(['control'], 'screen.frame', { data: String(p.data ?? ''), w: Number(meta.deviceWidth) || 0, h: Number(meta.deviceHeight) || 0, url: pageAddress(w.url) });
    };
    try {
      await relay.send('Page.startScreencast', { format: 'jpeg', quality: 60, maxWidth: 960, maxHeight: 1200, everyNthFrame: 1 }, m.session);
    } catch {
      this.mirror = null;
      return false;
    }
    if (m.paused) this.emit(['control'], 'screen.paused', { paused: true });
    return true;
  }

  private async stopMirror(): Promise<void> {
    const m = this.mirror;
    this.mirror = null;
    if (!m || !this.relay) return;
    this.relay.onScreencastFrame = undefined;
    this.relay.onWindowActive = undefined;
    await this.relay.send('Page.stopScreencast', {}, m.session).catch(() => {});
  }

  private setTrigger(runId: string, trigger: RunTrigger): void {
    if (this.ops) this.ops.runTriggers.set(runId, trigger);
    else this.pendingTriggers.set(runId, trigger);
  }

  private vaultState(v: { open: boolean; reason?: string }): { open: boolean; reason?: string } {
    return v.open ? { open: true } : { open: false, reason: v.reason };
  }

  private requireGuard(): CommitGuard {
    const g = this.relay?.commitGuard;
    if (!g) throw new Error('browser not launched');
    return g;
  }

  private requirePdf(): PdfSaver {
    if (!this.pdf) throw new Error('browser not launched');
    return this.pdf;
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
    if (!exe) throw new Error(CHROME_NOT_INSTALLED);
    const guard = this.opts.dirGuard ?? dirGuard();
    const rootCheck = await guard.checkPrivate(this.opts.paths.root);
    if (!rootCheck.ok) throw new Error(`app root not private: ${rootCheck.problems.join(',')}`);
    const profileDir = this.opts.paths.chromeProfile;
    // 맞으면 그대로 두고, 권한만 틀리면 고치고, 우리 것이 아니면(다른 계정 소유·링크·파일) 치우고 새로 만든다. 그래도 아니면 기동하지 않는다(D05 §3.1).
    const profile = await preparePrivateDir(profileDir, guard);
    if (profile.before.length) this.opts.log.event('vault.profile_dir_problem', { problems: profile.before.join(':'), reason: profile.reason?.join(':'), setAside: profile.setAside, ok: profile.check.ok });
    if (!profile.check.ok) throw new Error(`chrome profile not private: ${profile.check.problems.join(',')}`);
    await this.removeDumps(profileDir);
    // 지난 Chrome이 받는 중에 죽었으면 그 중간 파일(받은 PDF 바이트)이 staging에 남는다(WIN-REALDEVICE §10.4). 띄우기 전에 쓴다.
    await this.sweepStaging('launch');
    await writeProfileSettings(profileDir, downloadPreferences(this.opts.paths.staging));
    if (!current()) throw new Error('launch cancelled'); // 준비 중에 내리기가 왔으면 띄우지 않는다
    const headless = this.opts.headless === true;
    const chrome = await launchChrome({ executable: exe, profileDir, testArgs: this.opts.testChromeArgs, headless });
    this.chrome = chrome;
    this.headlessNow = headless;
    await this.grantLoopback(chrome);
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

  /**
   * 홈택스 출처에만 이 PC 보안 프로그램(127.0.0.1) 접근 권한을 준다(LOOPBACK_ORIGINS). 다른 출처에는 주지 않는다.
   * Chrome 판마다 권한 이름이 달라 앞에서부터 처음 받아들여진 이름 하나만 쓴다. 못 주면 기동은 그대로 하고 기록만 남긴다
   * (홈택스가 "보안프로그램 설치"를 띄우면 사람 차례로 넘어간다).
   */
  private async grantLoopback(chrome: LaunchedChrome): Promise<void> {
    for (const origin of LOOPBACK_ORIGINS) {
      let granted: string | null = null;
      for (const name of LOOPBACK_PERMISSION_NAMES) {
        try {
          await chrome.conn.send('Browser.setPermission', { permission: { name }, setting: 'granted', origin });
          granted = name;
          break;
        } catch {
          // 이 Chrome에 없는 이름이다. 다음 이름
        }
      }
      this.opts.log.event(granted ? 'vault.loopback_granted' : 'vault.loopback_grant_failed', { origin, ...(granted ? { name: granted } : {}) });
    }
  }

  /** staging에서 금고가 쓴 PDF 말고 지운다(Chrome이 없을 때: 기동 전·종료 뒤). 개수만 남긴다. */
  private async sweepStaging(when: 'launch' | 'shutdown'): Promise<void> {
    const r = await sweepStagingDir(this.opts.paths.staging).catch(() => ({ removed: 0, left: 0 }));
    if (r.removed || r.left) this.opts.log.event('vault.staging_swept', { removed: r.removed, left: r.left, when });
  }

  /** 전용 Chrome 크래시 덤프 삭제(N-04). 기동 전·종료 뒤. */
  private async removeDumps(profileDir: string): Promise<void> {
    // 잠금으로 못 지운 경로는 건수만 남긴다(다음 기동 전 정리에서 다시 지운다, WIN-REALDEVICE §6.3).
    const count = await removeCrashDumps(profileDir, { onFailed: (n) => this.opts.log.event('vault.chrome_dump_busy', { count: n }) }).catch(() => 0);
    if (count > 0) this.opts.log.event('vault.chrome_dump_removed', { count });
    else if (count < 0) this.opts.log.event('vault.chrome_dump_dir_link');
    const residue = await removeProfileResidue(profileDir, { onFailed: (n) => this.opts.log.event('vault.chrome_residue_busy', { count: n }) }).catch(() => 0);
    if (residue > 0) this.opts.log.event('vault.chrome_residue_removed', { count: residue });
    else if (residue < 0) this.opts.log.event('vault.chrome_residue_link');
  }

  private async attachRelay(conn: LaunchedChrome['conn']): Promise<LaunchResult> {
    // 내린 뒤의 옛 중계·비밀 동작 이벤트는 다음 Chrome의 포트로 보내지 않는다.
    const emit = (to: ReadonlyArray<'engine' | 'control'>, name: VaultEventName, data: Record<string, unknown>) => {
      if (this.relay !== relay) return;
      if (name === 'secret.needed') this.recordNeed(data as unknown as NeedLike);
      this.emit(to, name, data);
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
    this.relay?.commitGuard?.shutdown();
    this.relay = relay;
    relay.commitGuard = new CommitGuard({
      log: this.opts.log,
      allowedHosts: this.policy.allowedHosts,
      emit: (d) => emit(['engine'], 'commit.body_compared', { ...d }),
      send: (m, params, sid) => relay.send(m, params, sid),
      exposed: (id) => !!relay.exposedTarget(id),
      ttlMs: this.opts.commitArmTtlMs,
    });
    this.ops = new SecretOps(relay, this.policy, this.opts.log, {
      secretTtlMs: this.opts.secretTtlMs,
      selfScan: VAULT_SELF_SCAN ? { roots: [this.opts.paths.logs, this.opts.paths.staging] } : undefined,
      emit,
      usedSlots: this.usedSlots,
      stored: (kind, scope, row) => this.readStored(kind, scope, row),
      askApp: () => this.opts.certFromApp !== false,
      // 인증서 비밀번호 기억(대표 지시 2026-11-13). 데스크톱은 run.begin에 프로필을 주지 않으니 사업자로 본다(Phase 1).
      certMemory: {
        scopeOf: (runId) => this.runProfiles.get(runId) ?? 'business',
        read: (scope) => this.readStored('cert_password', scope),
        save: async (scope, bytes) => {
          if (!isProfileScope(scope)) return false;
          await this.human.store('cert_password', scope, [{ field: 'pw', bytes }], { version: 'cert-memory-2026-11-13' });
          return true;
        },
      },
    });
    for (const [k, v] of this.pendingTriggers) this.ops.runTriggers.set(k, v);
    this.pendingTriggers.clear();
    this.ops.openBlocker = () => this.profileBlocker();
    relay.onSecretWindowClosed.add((targetId) => {
      if (this.enginePort) this.post(this.enginePort, { t: 'ev', name: 'secret_window.closed', data: { targetId, ok: true } });
    });
    this.pdf?.shutdown();
    const pdf = new PdfSaver({
      staging: this.opts.paths.staging,
      log: this.opts.log,
      send: (m, params, sid) => relay.send(m, params, sid),
      exposed: (id) => relay.exposedTarget(id),
      emit: (name, data) => emit(['engine'], name, data),
      maxBytes: this.opts.pdf?.maxBytes,
      armTtlMs: this.opts.pdf?.armTtlMs,
    });
    this.pdf = pdf;
    relay.onDownloadEvent = (m, params) => pdf.onBrowserEvent(m, params);
    await relay.init();
    await pdf.init();
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
    if ((await verifyProfileSettings(profileDir, downloadPreferences(this.opts.paths.staging))).length) {
      problems.push('profile_prefs_mismatch');
      this.opts.log.event('vault.profile_prefs_mismatch');
    }
    const ext = (await listInstalledExtensions(profileDir)).filter((id) => !EXTENSION_ALLOWLIST.includes(id));
    if (ext.length) {
      problems.push('extension_not_allowed');
      // 진단: 확장 ID만 ext0~ext3에 남긴다(경로·이름 없음). ID 꼴(a-p 32자)이 아니면 'unknown'으로 바꿔 파일 내용이 로그에 섞이지 않게 한다.
      const ids = Object.fromEntries(ext.slice(0, 4).map((id, i) => [`ext${i}`, /^[a-p]{32}$/.test(id) ? id : 'unknown']));
      this.opts.log.event('vault.extension_not_allowed', { count: ext.length, ...ids });
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

  /**
   * 앱 루트·전용 프로필의 폴더 확인을 미리 한다(ADR-041). 결과는 쓰지 않는다: 기동할 때 다시 확인하고,
   * 그때 소유자 읽기는 플랫폼 OwnerMemo가 기억한 값을 쓴다. 걸린 시간만 남긴다.
   */
  async warmDirChecks(): Promise<void> {
    const guard = this.opts.dirGuard ?? dirGuard();
    const t0 = Date.now();
    let ok = true;
    for (const d of [this.opts.paths.root, this.opts.paths.chromeProfile]) {
      try {
        if (!(await guard.checkPrivate(d)).ok) ok = false;
      } catch {
        ok = false;
      }
    }
    this.opts.log.event('vault.dir_check_warm', { ms: Date.now() - t0, ok });
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
    const { ops, relay, chrome, pdf } = this;
    this.ops = null;
    this.relay = null;
    this.pdf = null;
    pdf?.shutdown();
    // 실행 트리거(run.begin)는 Chrome보다 오래 산다. 다시 띄우면 새 ops로 옮긴다.
    for (const [k, v] of ops?.runTriggers ?? []) this.pendingTriggers.set(k, v);
    ops?.shutdown();
    relay?.commitGuard?.shutdown();
    relay?.clearKnownSecrets();
    await chrome?.close();
    if (chrome) {
      await this.removeDumps(this.opts.paths.chromeProfile);
      // Chrome이 끝난 뒤라 잠금이 풀려 있다. 받는 중에 내린 다운로드의 중간 파일을 남기지 않는다.
      await this.sweepStaging('shutdown');
    }
    if (this.chrome === chrome) this.chrome = null;
  }
}
