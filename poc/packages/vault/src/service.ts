import fs from 'node:fs';
import path from 'node:path';
import { dirGuard, preparePrivateDir, type AppPaths, type DirGuard, type EventLog } from '@sax/platform';
import { downloadPreferences, EXTENSION_ALLOWLIST, LOOPBACK_ORIGINS, LOOPBACK_PERMISSION_NAMES, SECRET_ORIGINS, SECRET_TTL_MS, TYPIST_INPUT_MODE, TYPIST_KEY_DELAY_MS, VAULT_SELF_SCAN } from './constants.ts';
import { CHROME_NOT_INSTALLED, findInstalledChrome } from './chrome/find.ts';
import { PortConnection, type CdpConnection } from './cdp/connection.ts';
import { launchChrome } from './chrome/launch.ts';
import { hasGoogleSignin, listInstalledExtensions, removeCrashDumps, removeProfileResidue, verifyProfileSettings, writeProfileSettings } from './chrome/profile.ts';
import type { KeyStore } from './keystore.ts';
import type { PortLike } from '@sax/platform';
import {
  PORTAL_LOGIN_ID_MAX, RPC_BY_PORT, RUN_TRIGGERS, isProfileScope, isTypistKind, STORABLE_KINDS,
  SESSION_EVENTS, CODEF_REQ_ID_RE, type CodefSealParams, type InboundMessage, type ProfileScope, type SecretStoreResult, type OneShotBind, type PortalField, type SessionEventKind, type OutboundMessage, type PortKind, type RunTrigger, type SecretInputBind, type SecretKind, type StorableKind, type VaultEventName,
} from './protocol.ts';
import { defaultRelayPolicy, type RelayPolicy } from './relay/policy.ts';
import { VaultCrypto } from './crypto/ops.ts';
import { readNpkiLoginPair, scanNpki, type NpkiFs, type NpkiRoot } from './npki-scan.ts';
import { CodefSealer } from './codef-seal.ts';
import { CommitGuard } from './relay/commit-guard.ts';
import { PdfSaver, sweepStagingDir } from './pdf/save.ts';
import { Relay, type TargetState } from './relay/relay.ts';
import { SecretOps, type StoredRead } from './secret/ops.ts';
import { HumanSecretVault } from './keychain/human.ts';
import { MemoryItemStore, MemoryWrapper, UnavailableHello } from './keychain/backend.ts';

const MIRROR_FRAME_MS = 300;
const MIRROR_FAST_FRAME_MS = 90;
const MIRROR_FAST_HOLD_MS = 3_000;
const SCREEN_TEXT_MAX = 2_000;
const SCREEN_KEYS: Record<string, [string, number]> = {
  Enter: ['Enter', 13], Backspace: ['Backspace', 8], Tab: ['Tab', 9], Escape: ['Escape', 27], Delete: ['Delete', 46],
  ArrowLeft: ['ArrowLeft', 37], ArrowUp: ['ArrowUp', 38], ArrowRight: ['ArrowRight', 39], ArrowDown: ['ArrowDown', 40],
  Home: ['Home', 36], End: ['End', 35], PageUp: ['PageUp', 33], PageDown: ['PageDown', 34], ' ': ['Space', 32],
};
const SCREEN_MOD_MAX = 15;
const SCREEN_COMMANDS: Record<string, string> = { a: 'selectAll', z: 'undo', x: 'cut', c: 'copy' };

const RUN_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const NOTICE_VERSION_RE = /^[A-Za-z0-9._-]{1,32}$/;

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
}
/**
 * 로그에 남길 RPC 실패 사유. 금고가 스스로 던진 코드 모양(bad_params, vault.keystore_mismatch 등)은 그대로,
 * 런타임 오류는 Node 오류 코드(ERR_CRYPTO_UNKNOWN_CIPHER 등)만 남긴다. 오류 문장은 남기지 않는다(경로·값이 섞일 수 있다).
 */
export const rpcErrorCode = (e: unknown): string => {
  const m = (e as { message?: unknown } | null)?.message;
  if (typeof m === 'string' && /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)?$/.test(m) && m.length <= 60) return m;
  const c = (e as { code?: unknown } | null)?.code;
  return typeof c === 'string' && /^[A-Z][A-Z0-9_]{1,59}$/.test(c) ? c : 'error';
};

const needKey = (n: NeedLike): string => `${String(n.runId)}|${String(n.kind)}|${String(n.scope)}`;

/** secretInput 결속 검사(I-1). 맞으면 필요한 필드만 복사해 돌려준다. mode가 없으면 oneshot(PoC 호환). */
export function parseSecretInputBind(b: unknown): SecretInputBind | null {
  if (!b || typeof b !== 'object') return null;
  const x = b as Record<string, unknown>;
  if (!isProfileScope(x.scope)) return null;
  if (x.mode === 'store') {
    if (typeof x.kind !== 'string' || !(STORABLE_KINDS as readonly string[]).includes(x.kind)) return null;
    const notice = x.notice as Record<string, unknown> | undefined;
    if (!notice || typeof notice.version !== 'string' || !NOTICE_VERSION_RE.test(notice.version)) return null;
    if (x.runId !== undefined) return null;
    return { mode: 'store', kind: x.kind as StorableKind, scope: x.scope, notice: { version: notice.version } };
  }
  if (x.mode === 'codef') {
    if (typeof x.reqId !== 'string' || !CODEF_REQ_ID_RE.test(x.reqId) || x.kind !== undefined || x.runId !== undefined) return null;
    return { mode: 'codef', reqId: x.reqId, scope: x.scope };
  }
  if (x.mode !== undefined && x.mode !== 'oneshot') return null;
  if (typeof x.runId !== 'string' || !RUN_ID_RE.test(x.runId)) return null;
  if (!(isTypistKind(x.kind) || x.kind === 'cert_password') || !Object.hasOwn(SECRET_ORIGINS, x.kind)) return null;
  return { runId: x.runId, kind: x.kind as SecretKind, scope: x.scope };
}

export interface VaultOptions {
  paths: AppPaths;
  log: EventLog;
  keyStore: KeyStore;
  policy?: RelayPolicy;
  testChromeArgs?: string[];
  headless?: boolean;
  certFromApp?: boolean;
  dirGuard?: DirGuard;
  launchTimeoutMs?: number;
  secretTtlMs?: number;
  commitArmTtlMs?: number;
  human?: HumanSecretVault;
  npki?: { roots?: NpkiRoot[]; fs?: NpkiFs };
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

/** 포털 기본 팝업 숨김 스크립트(문서마다 한 번). 값은 JSON으로만 싣는다. */
export function popupScript(hide: string, idPrefix: string, cookie: string): string {
  return `(() => { try {
  if (window.__saxPopups) return; window.__saxPopups = 1;
  const HIDE = ${JSON.stringify(hide)}, PRE = ${JSON.stringify(idPrefix)}, COOKIE = ${JSON.stringify(cookie)};
  const css = HIDE + '{display:none!important;visibility:hidden!important}';
  const add = () => { const r = document.head || document.documentElement; if (!r) return false; const s = document.createElement('style'); s.textContent = css; r.appendChild(s); return true; };
  const seen = new Set();
  const mark = () => { if (!COOKIE) return; for (const e of document.querySelectorAll(HIDE)) { const id = e.id || ''; if (!id || seen.has(id) || (PRE && !id.startsWith(PRE))) continue; seen.add(id); const key = id.slice(PRE.length); if (!/^[A-Za-z0-9_-]{1,60}$/.test(key)) continue; document.cookie = COOKIE.split('{key}').join(key); } };
  const start = () => { add(); mark(); new MutationObserver(mark).observe(document.documentElement, { childList: true, subtree: true }); };
  if (document.documentElement) start(); else document.addEventListener('DOMContentLoaded', start, { once: true });
} catch (e) {} })();`;
}

/** Chrome을 띄운 뒤 붙기까지의 상한. 응답 없는 Chrome(멈춘 파이프)에 붙는 중이면 끝나지 않으므로, 넘으면 내리고 실패한다. 보통 2초 안쪽이다. */
export const LAUNCH_TIMEOUT_MS = 30_000;

export interface LaunchResult {
  targetId: string;
  webdriver: boolean;
}

interface RunBrowser {
  conn: CdpConnection;
  close(): Promise<void>;
  embedded: boolean;
  pid?: number;
}

/** 금고(TB-1). Chrome 파이프 단독 소유자이며 엔진에는 허용 목록 중계만 준다(ADR-005 v3). */
export class Vault {
  private readonly opts: VaultOptions;
  private pdf: PdfSaver | null = null;
  private readonly policy: RelayPolicy;
  private chrome: RunBrowser | null = null;
  private browserPort: PortLike | null = null;
  private embedded: PortConnection | null = null;
  private launching = false;
  private headlessNow = false;
  private generation = 0;
  relay: Relay | null = null;
  ops: SecretOps | null = null;
  private enginePort: PortLike | null = null;
  private controlPort: PortLike | null = null;
  private dbKeyIssued = false;
  private profileProblems: string[] | null = null;
  private readonly pendingTriggers = new Map<string, RunTrigger>();
  private readonly needs = new Map<string, number>();
  private readonly runProfiles = new Map<string, ProfileScope>();
  private readonly pendingCert = new Map<string, { scope: string; bytes: Uint8Array }>();
  private readonly usedSlots = new Set<string>();
  readonly human: HumanSecretVault;
  readonly crypto: VaultCrypto;
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
    const wipe = this.human.lock.onLock;
    this.human.lock.onLock = (reason) => {
      wipe(reason);
      this.emit(['control'], 'vault.state', { open: false, reason });
    };
  }

  private readStored(kind: string, scope: string): Promise<StoredRead> {
    if (!(STORABLE_KINDS as readonly string[]).includes(kind) || !isProfileScope(scope)) return Promise.resolve({ ok: false, reason: 'secret_missing' });
    return this.human.readOne(kind as StorableKind, scope, { field: 'pw' });
  }

  attachPort(kind: PortKind, port: PortLike, bind?: unknown): void {
    if (kind === 'secretInput') {
      const b = parseSecretInputBind(bind);
      if (!b) {
        this.opts.log.event('vault.secret_input_unbound');
        return;
      }
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
    if (kind === 'browser') {
      this.browserPort = port;
      port.onMessage((raw) => this.embedded?.feed(raw));
      return;
    }
    if (kind === 'engine') this.enginePort = port;
    if (kind === 'control') {
      this.controlPort = port;
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

  private recordNeed(n: NeedLike): void {
    const now = Date.now();
    for (const [k, until] of this.needs) if (now > until) this.needs.delete(k);
    this.needs.set(needKey(n), now + (this.opts.secretTtlMs ?? SECRET_TTL_MS));
  }

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

  private onSecretInput(port: PortLike, bind: SecretInputBind, state: { used: boolean }, msg: InboundMessage): void {
    if (msg?.t !== 'rpc') return;
    const p = msg.params ?? {};
    const bytes = p.bytes instanceof Uint8Array ? p.bytes : null;
    const entryBytes = Array.isArray(p.entries) ? (p.entries as Array<{ bytes?: unknown }>).map((e) => (e?.bytes instanceof Uint8Array ? e.bytes : null)) : [];
    const wipe = () => {
      bytes?.fill(0);
      for (const b of entryBytes) b?.fill(0);
    };
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
      const parsed = entries.map((e, i) => ({ field: e?.field as PortalField | undefined, bytes: entryBytes[i] ?? new Uint8Array() }));
      const loginId = parsePortalLoginId(p.portalLoginId);
      if (loginId === null || (loginId !== undefined && bind.kind !== 'portal_password')) {
        wipe();
        this.post(port, { t: 'rpc', id: msg.id, error: 'bad_login_id' });
        return;
      }
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
      const same = (k: 'kind' | 'scope') => p[k] === undefined || p[k] === bind[k];
      if (!same('kind') || !same('scope')) throw new Error('bind_mismatch');
      if (!this.hasNeed(bind)) throw new Error('not_requested');
      const ops = this.requireOps();
      ops.secrets.provide(bind, bytes);
      this.needs.delete(needKey(bind));
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
      if (msg.method.startsWith('crypto.')) this.opts.log.event('vault.rpc_failed', { method: msg.method, port: kind, error: rpcErrorCode(e) });
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
      case 'crypto.linkKey':
        return { pub: await this.crypto.linkKey() };
      case 'crypto.rkSeal':
        return this.crypto.rkSeal(p);
      case 'crypto.rkImport':
        return { aik: await this.crypto.rkImport(p) };
      case 'crypto.shareKey':
        return this.crypto.shareKey(p);
      case 'crypto.signShare':
        return { sig: await this.crypto.signShare(p) };
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
        if (this.dropPendingCert(runId)) this.opts.log.event('vault.cert_password_unconfirmed');
        for (const k of [...this.needs.keys()]) if (k.startsWith(runId + '|')) this.needs.delete(k);
        this.ops?.secrets.clearRun(runId);
        this.relay?.commitGuard?.clearRun(runId);
        for (const k of [...this.usedSlots]) if (k.startsWith(runId + '|')) this.usedSlots.delete(k);
        if (this.relay && !this.relay.hasOpenWindow()) this.relay.clearKnownSecrets();
        this.human.lock.runEnded();
        return {};
      }
      case 'popups.configure':
        return { ok: this.configurePopups(p) };
      case 'typist.authOk': {
        if (p.kind !== 'cert_password' || !isProfileScope(p.scope)) throw new Error('bad_params');
        const held = this.pendingCert.get(String(p.runId));
        if (!held || held.scope !== p.scope) return { saved: false };
        this.pendingCert.delete(String(p.runId));
        const saved = await this.human
          .store('cert_password', p.scope, [{ field: 'pw', bytes: held.bytes }], { version: 'cert-memory-2026-11-13' })
          .then(() => true, () => false)
          .finally(() => held.bytes.fill(0));
        this.opts.log.event('secret.remembered', { kind: 'cert_password', ok: saved });
        return { saved };
      }
      case 'typist.authFailed': {
        const kind = String(p.kind);
        if (!(STORABLE_KINDS as readonly string[]).includes(kind) || !isProfileScope(p.scope)) throw new Error('bad_params');
        if (kind === 'cert_password') {
          if (typeof p.runId === 'string') this.dropPendingCert(p.runId);
          for (const [r, v] of [...this.pendingCert]) if (v.scope === p.scope) this.dropPendingCert(r);
          const had = await this.human.forget('cert_password', p.scope, 'replace');
          this.opts.log.event('vault.cert_password_forgotten', { had: had ? 1 : 0 });
          this.emit(['control'], 'secret.suspect', { kind, scope: p.scope });
          return {};
        }
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
        this.opts.log.event('vault.browser_focus_refused');
        return { focused: false };
      case 'screen.start':
        return { started: await this.startMirror() };
      case 'screen.stop':
        await this.stopMirror();
        return {};
      case 'screen.input':
        return { ok: await this.screenInput(p) };
      case 'browser.place': {
        const n = (k: string) => {
          const v = p[k];
          if (typeof v !== 'number' || !Number.isInteger(v) || Math.abs(v) > 100_000) throw new Error('bad_params');
          return v;
        };
        const bounds = { left: n('x'), top: n('y'), width: n('width'), height: n('height') };
        if (bounds.width < 200 || bounds.height < 200) throw new Error('bad_params');
        if (this.headlessNow) return { placed: false, headless: true };
        return { placed: this.relay ? await this.relay.placeWindow(bounds) : false };
      }
    }
    throw new Error('not_implemented');
  }

  private mirror: { targetId: string; session: string; last: number; paused: boolean; meta: { w: number; h: number }; fastUntil: number; buttons: number } | null = null;

  private async screenInput(p: Record<string, unknown>): Promise<boolean> {
    const m = this.mirror;
    const relay = this.relay;
    if (!m || !relay || m.paused) return false;
    const t = relay.targets.get(m.targetId);
    if (!t || t.revoked || t.win) return false;
    const num = (k: string, lo: number, hi: number) => {
      const v = p[k];
      if (typeof v !== 'number' || !Number.isFinite(v) || v < lo || v > hi) throw new Error('bad_params');
      return v;
    };
    const mods = p.modifiers === undefined ? 0 : num('modifiers', 0, SCREEN_MOD_MAX) | 0;
    const send = (method: string, params: Record<string, unknown>) => relay.send(method, params as never, m.session);
    m.fastUntil = Date.now() + MIRROR_FAST_HOLD_MS;
    switch (p.kind) {
      case 'mouse': {
        const type = p.type;
        if (type !== 'mousePressed' && type !== 'mouseReleased' && type !== 'mouseMoved') throw new Error('bad_params');
        const x = num('x', 0, 1) * m.meta.w;
        const y = num('y', 0, 1) * m.meta.h;
        const button = type === 'mouseMoved' ? (m.buttons & 1 ? 'left' : 'none') : p.button === 'right' ? 'right' : 'left';
        const clickCount = type === 'mouseMoved' ? 0 : Math.min(3, Math.max(1, num('clickCount', 1, 3) | 0));
        if (type === 'mousePressed') m.buttons |= button === 'left' ? 1 : 2;
        if (type === 'mouseReleased') m.buttons &= button === 'left' ? ~1 : ~2;
        await send('Input.dispatchMouseEvent', { type, x, y, button, buttons: m.buttons, clickCount, modifiers: mods });
        return true;
      }
      case 'wheel': {
        const x = num('x', 0, 1) * m.meta.w;
        const y = num('y', 0, 1) * m.meta.h;
        await send('Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX: num('dx', -5000, 5000), deltaY: num('dy', -5000, 5000), modifiers: mods });
        return true;
      }
      case 'key': {
        const key = typeof p.key === 'string' ? p.key : '';
        const cmd = (mods & 6) && key.length === 1 ? SCREEN_COMMANDS[key.toLowerCase()] : undefined;
        if (cmd) {
          await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key, modifiers: mods, commands: [cmd] });
          await send('Input.dispatchKeyEvent', { type: 'keyUp', key, modifiers: mods });
          return true;
        }
        const k = Object.hasOwn(SCREEN_KEYS, key) ? SCREEN_KEYS[key]! : null;
        if (!k) throw new Error('bad_params');
        const base = { key, code: k[0], windowsVirtualKeyCode: k[1], nativeVirtualKeyCode: k[1], modifiers: mods };
        const text = key === 'Enter' ? '\r' : key === ' ' ? ' ' : undefined;
        await send('Input.dispatchKeyEvent', { type: text ? 'keyDown' : 'rawKeyDown', ...base, ...(text ? { text, unmodifiedText: text } : {}) });
        await send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
        return true;
      }
      case 'text': {
        const text = p.text;
        if (typeof text !== 'string' || !text || text.length > SCREEN_TEXT_MAX) throw new Error('bad_params');
        const clean = [...text].filter((ch) => ch.charCodeAt(0) >= 0x20 && ch.charCodeAt(0) !== 0x7f).join('');
        if (clean) await send('Input.insertText', { text: clean });
        return true;
      }
    }
    throw new Error('bad_params');
  }

  private async startMirror(): Promise<boolean> {
    const relay = this.relay;
    const t = relay?.runWindowTarget();
    if (!relay || !t) return false;
    if (this.mirror?.targetId === t.targetId) return true;
    await this.stopMirror();
    const m = { targetId: t.targetId, session: t.vaultSession, last: 0, paused: !!(t.win && t.win.phase === 'active'), meta: { w: 0, h: 0 }, fastUntil: 0, buttons: 0 };
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
      const meta = (p.metadata ?? {}) as Record<string, unknown>;
      if (Number(meta.deviceWidth) > 0 && Number(meta.deviceHeight) > 0) m.meta = { w: Number(meta.deviceWidth), h: Number(meta.deviceHeight) };
      if (now - m.last < (now < m.fastUntil ? MIRROR_FAST_FRAME_MS : MIRROR_FRAME_MS)) return;
      m.last = now;
      this.emit(['control'], 'screen.frame', { data: String(p.data ?? ''), w: Number(meta.deviceWidth) || 0, h: Number(meta.deviceHeight) || 0, url: pageAddress(w.url) });
    };
    try {
      await relay.send('Page.startScreencast', { format: 'jpeg', quality: 70, maxWidth: 1400, maxHeight: 1400, everyNthFrame: 1 }, m.session);
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

  async launch(): Promise<LaunchResult> {
    if (this.chrome || this.launching) throw new Error('already launched');
    this.launching = true;
    this.profileProblems = null;
    try {
      return await (this.browserPort ? this.startEmbedded(this.generation, this.browserPort) : this.startChrome(this.generation));
    } finally {
      this.launching = false;
    }
  }

  private async startChrome(generation: number): Promise<LaunchResult> {
    const current = (): boolean => generation === this.generation;
    const exe = findInstalledChrome();
    if (!exe) throw new Error(CHROME_NOT_INSTALLED);
    const guard = this.opts.dirGuard ?? dirGuard();
    const rootCheck = await guard.checkPrivate(this.opts.paths.root);
    if (!rootCheck.ok) throw new Error(`app root not private: ${rootCheck.problems.join(',')}`);
    const profileDir = this.opts.paths.chromeProfile;
    const profile = await preparePrivateDir(profileDir, guard);
    if (profile.before.length) this.opts.log.event('vault.profile_dir_problem', { problems: profile.before.join(':'), reason: profile.reason?.join(':'), setAside: profile.setAside, ok: profile.check.ok });
    if (!profile.check.ok) throw new Error(`chrome profile not private: ${profile.check.problems.join(',')}`);
    await this.removeDumps(profileDir);
    await this.sweepStaging('launch');
    await writeProfileSettings(profileDir, downloadPreferences(this.opts.paths.staging));
    if (!current()) throw new Error('launch cancelled');
    const headless = this.opts.headless === true;
    const launched = await launchChrome({ executable: exe, profileDir, testArgs: this.opts.testChromeArgs, headless });
    const chrome: RunBrowser = { conn: launched.conn, close: () => launched.close(), embedded: false, pid: launched.proc.pid };
    this.chrome = chrome;
    this.headlessNow = headless;
    if (!headless) this.emit(['control'], 'browser.launched', { pid: launched.proc.pid ?? 0 });
    await this.grantLoopback(chrome.conn);
    return this.connectRelay(generation, chrome, () => void this.checkProfile(profileDir, generation));
  }

  private async startEmbedded(generation: number, port: PortLike): Promise<LaunchResult> {
    await this.sweepStaging('launch');
    if (generation !== this.generation) throw new Error('launch cancelled');
    const conn = new PortConnection((m) => port.postMessage(m));
    this.embedded = conn;
    const browser: RunBrowser = { conn, close: async () => conn.close(), embedded: true };
    this.chrome = browser;
    this.headlessNow = false;
    this.profileProblems = [];
    await this.grantLoopback(conn);
    return this.connectRelay(generation, browser, () => {});
  }

  private async connectRelay(generation: number, chrome: RunBrowser, onAttached: () => void): Promise<LaunchResult> {
    const current = (): boolean => generation === this.generation;
    chrome.conn.on('close', () => {
      this.opts.log.event(chrome.embedded ? 'vault.embedded_closed' : 'vault.chrome_closed');
      if (this.chrome === chrome && !this.closingChrome) this.browserGone('chrome');
      if (this.enginePort && (this.chrome === chrome || this.chrome === null)) this.post(this.enginePort, { t: 'cdp_closed' });
    });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      void this.shutdown().catch(() => {});
    }, this.opts.launchTimeoutMs ?? LAUNCH_TIMEOUT_MS);
    try {
      if (!current()) throw new Error('launch cancelled');
      const result = await this.attachRelay(chrome.conn);
      if (!current()) throw new Error('launch cancelled');
      onAttached();
      return result;
    } catch (e) {
      clearTimeout(timer);
      const cause = timedOut ? new Error('chrome launch timed out') : current() ? e : new Error('launch cancelled');
      await this.shutdown().catch(() => {});
      throw cause;
    } finally {
      clearTimeout(timer);
    }
  }

  private async grantLoopback(conn: CdpConnection): Promise<void> {
    for (const origin of LOOPBACK_ORIGINS) {
      const granted: string[] = [];
      for (const name of LOOPBACK_PERMISSION_NAMES) {
        try {
          await conn.send('Browser.setPermission', { permission: { name }, setting: 'granted', origin });
          granted.push(name);
        } catch {
          // 이 Chrome에 없는 이름이다. 다음 이름
        }
      }
      this.opts.log.event(granted.length ? 'vault.loopback_granted' : 'vault.loopback_grant_failed', { origin, ...(granted.length ? { name: granted.join(',') } : {}) });
    }
  }

  private async sweepStaging(when: 'launch' | 'shutdown'): Promise<void> {
    const r = await sweepStagingDir(this.opts.paths.staging).catch(() => ({ removed: 0, left: 0 }));
    if (r.removed || r.left) this.opts.log.event('vault.staging_swept', { removed: r.removed, left: r.left, when });
  }

  private async removeDumps(profileDir: string): Promise<void> {
    const count = await removeCrashDumps(profileDir, { onFailed: (n) => this.opts.log.event('vault.chrome_dump_busy', { count: n }) }).catch(() => 0);
    if (count > 0) this.opts.log.event('vault.chrome_dump_removed', { count });
    else if (count < 0) this.opts.log.event('vault.chrome_dump_dir_link');
    const residue = await removeProfileResidue(profileDir, { onFailed: (n) => this.opts.log.event('vault.chrome_residue_busy', { count: n }) }).catch(() => 0);
    if (residue > 0) this.opts.log.event('vault.chrome_residue_removed', { count: residue });
    else if (residue < 0) this.opts.log.event('vault.chrome_residue_link');
  }

  private async attachRelay(conn: CdpConnection): Promise<LaunchResult> {
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
    });
    this.relay?.commitGuard?.shutdown();
    this.relay = relay;
    relay.onPageOpened = (t) => {
      if (this.relay !== relay) return;
      if (!this.headlessNow && !this.chrome?.embedded) this.emit(['control'], 'browser.launched', { popup: true });
      void this.applyPopups(t);
    };
    relay.onPageUrl = (t) => {
      if (this.relay === relay) this.closePopupWindow(t);
    };
    const typing = new Set<string>();
    const typingChanged = (had: boolean) => {
      if (had !== typing.size > 0) emit(['control'], 'browser.blocked', { blocked: typing.size > 0 });
    };
    if (this.chrome?.embedded) {
      relay.onWindowActive = (t, active) => {
        const had = typing.size > 0;
        if (active && t.win?.kind === 'typist') typing.add(t.targetId);
        if (!active) typing.delete(t.targetId);
        typingChanged(had);
      };
    }
    relay.onTargetGone = (t) => {
      const had = typing.size > 0;
      typing.delete(t.targetId);
      typingChanged(had);
      if (t.type !== 'page' || !t.exposed || this.relay !== relay || this.closingChrome) return;
      if (!relay.hasExposedPage()) this.browserGone('tab');
    };
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
      stored: (kind, scope) => this.readStored(kind, scope),
      askApp: () => this.opts.certFromApp !== false,
      certMemory: {
        scopeOf: (runId) => this.runProfiles.get(runId) ?? 'business',
        read: (scope) => this.readStored('cert_password', scope),
        hold: (runId, scope, bytes) => {
          this.dropPendingCert(runId);
          this.pendingCert.set(runId, { scope, bytes });
          this.opts.log.event('vault.cert_password_held');
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
      scrub: (t) => this.ops?.scrubTainted(t) ?? Promise.resolve(false),
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

  private async checkProfile(profileDir: string, generation: number): Promise<void> {
    await new Promise((r) => setTimeout(r, 1500));
    const problems = await this.readProfileProblems(profileDir);
    if (generation === this.generation) this.profileProblems = problems;
  }

  private async profileBlocker(): Promise<string | null> {
    if (this.profileProblems === null) return 'profile_not_checked';
    if (this.chrome?.embedded) return null;
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
      const ids = Object.fromEntries(ext.slice(0, 4).map((id, i) => [`ext${i}`, /^[a-p]{32}$/.test(id) ? id : 'unknown']));
      this.opts.log.event('vault.extension_not_allowed', { count: ext.length, ...ids });
    }
    if (await hasGoogleSignin(profileDir)) {
      problems.push('google_signin_detected');
      this.opts.log.event('vault.google_signin_detected');
    }
    return problems;
  }

  async profileChecked(): Promise<string[]> {
    while (this.profileProblems === null) await new Promise((r) => setTimeout(r, 100));
    return this.profileProblems;
  }

  get chromePid(): number | undefined {
    return this.chrome?.pid;
  }

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
      if (fs.existsSync(path.join(this.opts.paths.db, 'db.sqlite'))) {
        this.opts.log.event('vault.dbkey_missing');
        throw new Error('db.key_missing');
      }
      const created = await ks.create('db-key', 32);
      const back = await ks.get('db-key', 32);
      if (!back || Buffer.compare(Buffer.from(back), Buffer.from(created)) !== 0) throw new Error('vault.keystore_mismatch');
      return created;
    } catch (e) {
      if ((e as Error).message === 'vault.keystore_mismatch') this.opts.log.event('vault.keystore_mismatch');
      throw e;
    }
  }

  private popupCfg: { hide: string; idPrefix: string; cookie: string; closeUrl: RegExp | null } | null = null;
  private readonly popupScripted = new Set<string>();

  configurePopups(p: Record<string, unknown>): boolean {
    const str = (k: string, max: number) => (typeof p[k] === 'string' && (p[k] as string).length <= max ? (p[k] as string) : '');
    const hide = str('hide', 500);
    const idPrefix = str('idPrefix', 60);
    const cookie = str('cookie', 300);
    const close = str('closeUrl', 300);
    if (hide && /[{}<>\\]/.test(hide)) return false;
    if (idPrefix && !/^[A-Za-z0-9_-]+$/.test(idPrefix)) return false;
    if (cookie && (/[\r\n<>]/.test(cookie) || !cookie.includes('{key}'))) return false;
    let closeUrl: RegExp | null = null;
    if (close) {
      try {
        closeUrl = new RegExp(close);
      } catch {
        return false;
      }
    }
    if (!hide && !closeUrl) {
      this.popupCfg = null;
      return true;
    }
    this.popupCfg = { hide, idPrefix, cookie, closeUrl };
    this.popupScripted.clear();
    this.opts.log.event('vault.popups_configured', { hide: hide ? 1 : 0, cookie: cookie ? 1 : 0, close: closeUrl ? 1 : 0 });
    for (const t of this.relay?.targets.values() ?? []) {
      if (t.type !== 'page') continue;
      void this.applyPopups(t);
      this.closePopupWindow(t);
    }
    return true;
  }

  private async applyPopups(t: TargetState): Promise<void> {
    const c = this.popupCfg;
    const relay = this.relay;
    if (!c || !c.hide || !relay || t.type !== 'page' || this.popupScripted.has(t.targetId)) return;
    this.popupScripted.add(t.targetId);
    const source = popupScript(c.hide, c.idPrefix, c.cookie);
    await relay.send('Page.addScriptToEvaluateOnNewDocument', { source }, t.vaultSession).catch(() => {});
    await relay.send('Runtime.evaluate', { expression: source }, t.vaultSession).catch(() => {});
  }

  private closePopupWindow(t: TargetState): void {
    const re = this.popupCfg?.closeUrl;
    if (!re || t.type !== 'page' || !t.url || !re.test(t.url) || !this.chrome) return;
    void this.chrome.conn.send('Target.closeTarget', { targetId: t.targetId }).then(
      () => this.opts.log.event('vault.popup_window_closed'),
      () => {},
    );
  }

  private dropPendingCert(runId: string): boolean {
    const v = this.pendingCert.get(runId);
    if (!v) return false;
    v.bytes.fill(0);
    this.pendingCert.delete(runId);
    return true;
  }

  private browserGone(reason: 'tab' | 'chrome'): void {
    const gen = this.generation;
    if (this.goneNotified === gen) return;
    this.goneNotified = gen;
    this.opts.log.event('vault.browser_gone', { reason });
    const m = this.mirror;
    this.mirror = null;
    if (m && this.relay) {
      this.relay.onScreencastFrame = undefined;
      this.relay.onWindowActive = undefined;
    }
    this.emit(['control'], 'browser.closed', { reason });
  }
  private goneNotified = -1;
  private closingChrome = false;

  async shutdown(): Promise<void> {
    this.closingChrome = true;
    try {
      await this.shutdownInner();
    } finally {
      this.closingChrome = false;
    }
  }

  private async shutdownInner(): Promise<void> {
    for (const r of [...this.pendingCert.keys()]) this.dropPendingCert(r);
    this.generation++;
    this.profileProblems = null;
    const { ops, relay, chrome, pdf } = this;
    this.ops = null;
    this.relay = null;
    this.pdf = null;
    pdf?.shutdown();
    for (const [k, v] of ops?.runTriggers ?? []) this.pendingTriggers.set(k, v);
    ops?.shutdown();
    relay?.commitGuard?.shutdown();
    relay?.clearKnownSecrets();
    await chrome?.close();
    if (this.embedded?.isClosed) this.embedded = null;
    if (chrome) {
      if (!chrome.embedded) await this.removeDumps(this.opts.paths.chromeProfile);
      await this.sweepStaging('shutdown');
    }
    if (this.chrome === chrome) this.chrome = null;
  }
}
