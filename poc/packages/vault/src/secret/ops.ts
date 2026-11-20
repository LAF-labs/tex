import type { EventLog } from '@sax/platform';
import { HUMAN_SETTLE_MS, SECRET_TTL_MS, SELF_SCAN_TIMEOUT_MS } from '../constants.ts';
import { scanDir } from '../leak/scanner.ts';
import { isTypistKind, type FillReason, type FillRequest, type OneShotBind, type VaultEventName } from '../protocol.ts';
import { hostAllowed, type RelayPolicy } from '../relay/policy.ts';
import type { Relay, TargetState } from '../relay/relay.ts';
import { KNOWN_VALUE_MIN_LEN, knownValuePrefixVariants, knownValueVariants } from '../relay/sanitize.ts';

type Json = Record<string, unknown>;


interface HeldSecret {
  runId: string;
  kind: string;
  bytes: Uint8Array;
  timer: NodeJS.Timeout;
}

/**
 * PoC는 비밀을 저장하지 않는다(ADR-017). 사용자가 금고 직결 입력 창에서 넣은 값을 한 번만 쓰고 지운다.
 * main·렌더러 본체는 이 값을 중계하지 않는다(입력 창 포트는 금고에 직결).
 * 값은 실행(runId)에 묶이고 TTL이 지나거나 run.end면 0으로 덮어 지운다(N-44).
 */
export class OneShotSecrets {
  private readonly items = new Map<string, HeldSecret>();
  private readonly ttlMs: number;
  private readonly onExpire: (runId: string, kind: string) => void;

  constructor(ttlMs = SECRET_TTL_MS, onExpire: (runId: string, kind: string) => void = () => {}) {
    this.ttlMs = ttlMs;
    this.onExpire = onExpire;
  }

  private key(runId: string, kind: string, scope: string) {
    return `${runId}|${kind}/${scope}`;
  }

  private drop(k: string): HeldSecret | undefined {
    const v = this.items.get(k);
    if (!v) return undefined;
    clearTimeout(v.timer);
    this.items.delete(k);
    return v;
  }

  provide(bind: OneShotBind, bytes: Uint8Array): void {
    const k = this.key(bind.runId, bind.kind, bind.scope);
    this.drop(k)?.bytes.fill(0);
    const timer = setTimeout(() => {
      const v = this.drop(k);
      if (!v) return;
      v.bytes.fill(0);
      this.onExpire(v.runId, v.kind);
    }, this.ttlMs);
    timer.unref();
    this.items.set(k, { runId: bind.runId, kind: bind.kind, bytes, timer });
  }

  take(runId: string, kind: string, scope: string): Uint8Array | null {
    return this.drop(this.key(runId, kind, scope))?.bytes ?? null;
  }

  get size(): number {
    return this.items.size;
  }

  clearRun(runId: string): void {
    for (const [k, v] of [...this.items]) if (v.runId === runId) this.drop(k)?.bytes.fill(0);
  }

  clear(): void {
    for (const k of [...this.items.keys()]) this.drop(k)?.bytes.fill(0);
  }
}

interface Probe {
  type: string;
  active: boolean;
  connected: boolean;
  len: number;
}

const PROBE_FN = `function () {
  let a = this.ownerDocument.activeElement;
  while (a && a.shadowRoot && a.shadowRoot.activeElement) a = a.shadowRoot.activeElement;
  let type = String(this.type || '').toLowerCase();
  if (type === 'text') {
    const v = getComputedStyle(this).getPropertyValue('-webkit-text-security');
    if (v === 'disc' || v === 'circle' || v === 'square') type = 'password';
  }
  return { type, active: a === this, connected: this.isConnected, len: typeof this.value === 'string' ? this.value.length : 0 };
}`;

interface HumanWatch {
  objectId: string;
  runId: string;
  scope?: string;
  timer: NodeJS.Timeout;
  idleSince?: number;
  lastLen?: number;
}

export type VaultEmit = (to: ReadonlyArray<'engine' | 'control'>, name: VaultEventName, data: Json) => void;

export interface SecretOpsOptions {
  secretTtlMs?: number;
  selfScan?: { roots: string[] };
  emit?: VaultEmit;
  usedSlots?: Set<string>;
  stored?: (kind: string, scope: string) => Promise<StoredRead>;
  now?: () => number;
  certMemory?: {
    scopeOf(runId: string): string | undefined;
    read(scope: string): Promise<StoredRead>;
    hold(runId: string, scope: string, bytes: Uint8Array): void;
  };
  askApp?: () => boolean;
}

export type StoredRead = { ok: true; bytes: Uint8Array } | { ok: false; reason: 'vault_locked' | 'secret_missing' | 'credential_suspect' | 'corrupt' | 'kek_unavailable' };

/** 실행당 종류별 1회 키. */
export const slotKey = (runId: string, kind: string): string => `${runId}|${kind}`;

/** 비밀 창(D05 §3.5)과 타이피스트(D05 §4). 모든 동작은 금고 감시 세션에서 한다. */
export class SecretOps {
  private readonly relay: Relay;
  private readonly policy: RelayPolicy;
  private readonly log: EventLog;
  private readonly opts: SecretOpsOptions;
  private readonly emit: VaultEmit;
  readonly secrets: OneShotSecrets;
  readonly runTriggers = new Map<string, 'local' | 'remote' | 'daemon'>();
  private readonly human = new Map<string, HumanWatch>();
  private readonly appAsk = new Map<string, { runId: string; scope: string; objectId: string }>();
  private readonly opening = new Set<string>();
  readonly usedSlots: Set<string>;
  selfScanDone: Promise<void> = Promise.resolve();
  openBlocker: () => Promise<string | null> = async () => 'profile_not_checked';

  constructor(relay: Relay, policy: RelayPolicy, log: EventLog, opts: SecretOpsOptions = {}) {
    this.relay = relay;
    this.policy = policy;
    this.log = log;
    this.opts = opts;
    this.emit = opts.emit ?? (() => {});
    this.usedSlots = opts.usedSlots ?? new Set();
    relay.activeValueHook = (targetId) => this.noteHumanValue(targetId);
    this.secrets = new OneShotSecrets(opts.secretTtlMs ?? SECRET_TTL_MS, (runId, kind) => {
      this.log.event('vault.secret_expired', { kind });
      this.emit(['control'], 'secret.expired', { runId, kind });
    });
  }

  private async resolve(t: TargetState, frame: string, selector: string): Promise<{ objectId: string; backendNodeId: number; frameId: string; frameUrl: string } | null> {
    const frameId = frame === 'main' ? t.mainFrameId : /^[0-9A-F]{16,64}$/i.test(frame) ? frame : await this.childFrame(t, frame);
    if (!frameId) return null;
    const { executionContextId } = await this.relay.send<{ executionContextId: number }>('Page.createIsolatedWorld', { frameId, worldName: '__sax_vault' }, t.vaultSession);
    const ev = await this.relay.send<{ result: Json }>('Runtime.evaluate', { expression: `document.querySelector(${JSON.stringify(selector)})`, contextId: executionContextId }, t.vaultSession);
    const objectId = ev.result.objectId as string | undefined;
    if (!objectId) return null;
    const { node } = await this.relay.send<{ node: Json }>('DOM.describeNode', { objectId }, t.vaultSession);
    const { frameTree } = await this.relay.send<{ frameTree: Json }>('Page.getFrameTree', {}, t.vaultSession);
    return { objectId, backendNodeId: Number(node.backendNodeId), frameId, frameUrl: findFrameUrl(frameTree, frameId) ?? '' };
  }

  private async childFrame(t: TargetState, frameSelector: string): Promise<string | null> {
    if (!t.mainFrameId) return null;
    const { executionContextId } = await this.relay.send<{ executionContextId: number }>('Page.createIsolatedWorld', { frameId: t.mainFrameId, worldName: '__sax_vault' }, t.vaultSession);
    const ev = await this.relay.send<{ result: Json }>('Runtime.evaluate', { expression: `document.querySelector(${JSON.stringify(frameSelector)})`, contextId: executionContextId }, t.vaultSession);
    const objectId = ev.result.objectId as string | undefined;
    if (!objectId) return null;
    const { node } = await this.relay.send<{ node: Json }>('DOM.describeNode', { objectId }, t.vaultSession);
    return typeof node.frameId === 'string' ? node.frameId : null;
  }

  private async probe(t: TargetState, objectId: string): Promise<Probe | null> {
    try {
      const r = await this.relay.send<{ result: { value: Probe } }>('Runtime.callFunctionOn', { objectId, functionDeclaration: PROBE_FN, returnByValue: true }, t.vaultSession);
      return r.result.value;
    } catch {
      return null;
    }
  }

  private refuse(reason: string): { ok: false; reason: 'secret_window_refused' } {
    this.log.event('vault.secret_window_refused', { reason });
    this.emit(['engine', 'control'], 'secret_window.refused', { reason });
    return { ok: false, reason: 'secret_window_refused' };
  }

  private triggerAllowed(runId: string): boolean {
    const trigger = this.runTriggers.get(runId);
    return trigger === 'local' || trigger === 'remote';
  }

  private fillTriggerAllowed(req: FillRequest): boolean {
    const trigger = this.runTriggers.get(req.runId);
    return trigger === 'local' || (trigger === 'remote' && req.startGate === true);
  }

  async fill(req: FillRequest): Promise<{ ok: boolean; reason?: FillReason }> {
    const t = this.relay.exposedTarget(req.targetId);
    if (!t) return { ok: false, reason: 'not_found' };
    if (!this.fillTriggerAllowed(req)) return { ok: false, reason: 'denied' };
    if (!isTypistKind(req.secret?.kind)) {
      this.log.event('vault.typist_kind_refused', { kind: String(req.secret?.kind).slice(0, 20) });
      return { ok: false, reason: 'denied' };
    }
    if (!req.slot || req.slot.secretKind !== req.secret?.kind) return { ok: false, reason: 'not_secret_slot' };
    const used = slotKey(req.runId, req.secret.kind);
    if (this.usedSlots.has(used)) return { ok: false, reason: 'denied' };
    if (t.win || this.opening.has(t.targetId)) return { ok: false, reason: 'denied' };
    this.opening.add(t.targetId);
    try {
      return await this.fillOpening(t, req, used);
    } finally {
      this.opening.delete(t.targetId);
    }
  }

  private async fillOpening(t: TargetState, req: FillRequest, used: string): Promise<{ ok: boolean; reason?: FillReason }> {
    const blocker = await this.openBlocker();
    if (blocker) return this.refuse(blocker);
    const el = await this.resolve(t, req.frame, req.element).catch(() => null);
    if (!el) return { ok: false, reason: 'not_found' };
    const hosts = this.policy.secretHosts[req.secret.kind] ?? [];
    if (!hostAllowed(hostOf(el.frameUrl), hosts)) return { ok: false, reason: 'origin_not_allowed' };
    const p0 = await this.probe(t, el.objectId);
    if (!p0 || p0.type !== 'password') return { ok: false, reason: 'not_secret_slot' };
    if (!p0.active) return { ok: false, reason: 'denied' };
    let secret = this.secrets.take(req.runId, req.secret.kind, req.secret.scope);
    if (!secret && this.opts.stored) {
      const r = await this.opts.stored(req.secret.kind, req.secret.scope);
      if (r.ok) secret = r.bytes;
      else if (r.reason === 'vault_locked' || r.reason === 'credential_suspect') return { ok: false, reason: r.reason };
    }
    if (!secret) {
      this.emit(['control'], 'secret.needed', { runId: req.runId, targetId: t.targetId, kind: req.secret.kind, scope: req.secret.scope });
      return { ok: false, reason: 'secret_missing' };
    }
    this.usedSlots.add(used);

    const text = new TextDecoder().decode(secret);
    secret.fill(0);
    this.relay.openWindow(t, 'typist', el.frameId, el.backendNodeId);
    this.relay.addKnownSecret(t.targetId, knownValuePrefixVariants(text));
    let ok = true;
    let reason: FillReason | undefined;
    const keyEvents = this.policy.typistInput === 'keyEvents';
    try {
      if (!keyEvents) await this.relay.send('Input.setIgnoreInputEvents', { ignore: true }, t.vaultSession);
      for (const ch of text) {
        const p = await this.probe(t, el.objectId);
        if (!p || !p.active || p.type !== 'password' || !p.connected) {
          ok = false;
          reason = 'denied';
          break;
        }
        if (keyEvents) {
          await this.relay.send('Input.dispatchKeyEvent', { type: 'keyDown', key: ch, text: ch, unmodifiedText: ch }, t.vaultSession);
          await this.relay.send('Input.dispatchKeyEvent', { type: 'keyUp', key: ch }, t.vaultSession);
        } else {
          await this.relay.send('Input.insertText', { text: ch }, t.vaultSession);
        }
        if (this.policy.keyDelayMs > 0) await sleep(this.policy.keyDelayMs);
      }
      if (ok) {
        const p = await this.probe(t, el.objectId);
        if (!p || p.len !== [...text].length) {
          ok = false;
          reason = 'blocked_by_module';
        }
      }
    } finally {
      if (!keyEvents) await this.relay.send('Input.setIgnoreInputEvents', { ignore: false }, t.vaultSession).catch(() => {});
      this.relay.addKnownSecret(t.targetId, knownValueVariants(text));
      this.relay.deactivateWindow(t);
    }
    this.log.event('secret.used', { kind: req.secret.kind, viaTypist: true, ok });
    this.selfScan(text);
    return ok ? { ok } : { ok, reason };
  }

  private async typeInto(t: TargetState, objectId: string, text: string): Promise<{ ok: boolean }> {
    const keyEvents = this.policy.typistInput === 'keyEvents';
    let ok = true;
    try {
      if (!keyEvents) await this.relay.send('Input.setIgnoreInputEvents', { ignore: true }, t.vaultSession);
      await this.relay.send('Runtime.callFunctionOn', { objectId, functionDeclaration: 'function(){this.focus();this.value=""}' }, t.vaultSession);
      for (const ch of text) {
        const p = await this.probe(t, objectId);
        if (!p || p.type !== 'password' || !p.connected) {
          ok = false;
          break;
        }
        if (keyEvents) {
          await this.relay.send('Input.dispatchKeyEvent', { type: 'keyDown', key: ch, text: ch, unmodifiedText: ch }, t.vaultSession);
          await this.relay.send('Input.dispatchKeyEvent', { type: 'keyUp', key: ch }, t.vaultSession);
        } else {
          await this.relay.send('Input.insertText', { text: ch }, t.vaultSession);
        }
        if (this.policy.keyDelayMs > 0) await sleep(this.policy.keyDelayMs);
      }
      if (ok) {
        const p = await this.probe(t, objectId);
        ok = !!p && p.len === [...text].length;
      }
    } catch {
      ok = false;
    } finally {
      if (!keyEvents) await this.relay.send('Input.setIgnoreInputEvents', { ignore: false }, t.vaultSession).catch(() => {});
    }
    return { ok };
  }

  private selfScan(text: string): void {
    const roots = this.opts.selfScan?.roots;
    if (!roots?.length || text.length < KNOWN_VALUE_MIN_LEN) return;
    const scan = (async () => {
      let files = 0;
      let findings = 0;
      for (const root of roots) {
        const r = await scanDir(root, [text]);
        files += r.files;
        findings += r.findings.length;
      }
      return { files, findings };
    })().catch(() => null);
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<'timeout'>((r) => {
      timer = setTimeout(() => r('timeout'), SELF_SCAN_TIMEOUT_MS);
      timer.unref();
    });
    this.selfScanDone = Promise.race([scan, timeout]).then((r) => {
      clearTimeout(timer);
      if (r === 'timeout' || r === null) {
        this.log.event('vault.leak_scan_skipped');
        return;
      }
      this.log.event('vault.leak_scan', r);
      if (r.findings > 0) this.emit(['engine', 'control'], 'secret_window.leak_suspected', { hits: r.findings });
    });
  }

  async openForHuman(req: { runId: string; targetId: string; frame: string; element: string }): Promise<{ ok: boolean; auto?: boolean; reason?: 'secret_window_refused' | 'origin_not_allowed' | 'not_found' | 'denied' }> {
    const t = this.relay.exposedTarget(req.targetId);
    if (!t || t.win?.phase === 'active' || this.opening.has(t.targetId)) return { ok: false, reason: 'not_found' };
    if (!this.triggerAllowed(req.runId)) return { ok: false, reason: 'denied' };
    this.opening.add(t.targetId);
    try {
      const blocker = await this.openBlocker();
      if (blocker) return this.refuse(blocker);
      const el = await this.resolve(t, req.frame, req.element).catch(() => null);
      if (!el) return { ok: false, reason: 'not_found' };
      const hosts = Object.values(this.policy.secretHosts).flat();
      if (!hostAllowed(hostOf(el.frameUrl), hosts)) return { ok: false, reason: 'origin_not_allowed' };
      const mem = this.opts.certMemory;
      const scope = mem?.scopeOf(req.runId);
      if (mem && scope) {
        const r = await mem.read(scope).catch(() => null);
        if (r?.ok) {
          const text = new TextDecoder().decode(r.bytes);
          r.bytes.fill(0);
          this.relay.openWindow(t, 'typist', el.frameId, el.backendNodeId);
          this.relay.addKnownSecret(t.targetId, knownValuePrefixVariants(text));
          const typed = await this.typeInto(t, el.objectId, text);
          this.relay.addKnownSecret(t.targetId, knownValueVariants(text));
          this.relay.deactivateWindow(t);
          this.log.event('secret.used', { kind: 'cert_password', viaTypist: true, ok: typed.ok, remembered: true });
          this.selfScan(text);
          if (typed.ok) return { ok: true, auto: true };
        }
      }
      if (this.opts.askApp?.()) {
        const askScope = scope ?? 'business';
        this.relay.openWindow(t, 'human', el.frameId, el.backendNodeId);
        this.appAsk.set(t.targetId, { runId: req.runId, scope: askScope, objectId: el.objectId });
        this.emit(['control'], 'secret.needed', { runId: req.runId, targetId: t.targetId, kind: 'cert_password', scope: askScope });
        this.log.event('vault.cert_password_asked_app');
        return { ok: true };
      }
      this.relay.openWindow(t, 'human', el.frameId, el.backendNodeId);
      const watch: HumanWatch = {
        objectId: el.objectId,
        runId: req.runId,
        timer: setInterval(() => void this.tickHuman(t), 250),
        ...(scope ? { scope } : {}),
      };
      this.human.set(t.targetId, watch);
      return { ok: true };
    } finally {
      this.opening.delete(t.targetId);
    }
  }

  private async noteHumanValue(targetId: string): Promise<void> {
    const w = this.human.get(targetId);
    const t = this.relay.targets.get(targetId);
    if (!w || !t) return;
    try {
      const r = await this.relay.send<{ result: { value?: string } }>('Runtime.callFunctionOn', { objectId: w.objectId, functionDeclaration: 'function(){return typeof this.value==="string"?this.value:""}', returnByValue: true }, t.vaultSession);
      if (typeof r.result.value === 'string' && r.result.value) this.relay.addKnownSecret(targetId, knownValuePrefixVariants(r.result.value));
    } catch {
      // 노드가 사라졌으면 tick이 창을 닫는다
    }
  }

  private async tickHuman(t: TargetState): Promise<void> {
    const w = this.human.get(t.targetId);
    if (!w) return;
    if (t.win?.phase !== 'active') {
      this.stopHuman(t.targetId);
      return;
    }
    const p = await this.probe(t, w.objectId);
    if (!p || !p.connected) return this.closeHuman(t);
    if (p.len > 0) await this.noteHumanValue(t.targetId);
    if (p.active || p.len === 0) {
      w.idleSince = undefined;
      return;
    }
    const now = this.opts.now?.() ?? Date.now();
    if (w.idleSince === undefined || w.lastLen !== p.len) {
      w.idleSince = now;
      w.lastLen = p.len;
      return;
    }
    if (now - w.idleSince >= HUMAN_SETTLE_MS) await this.closeHuman(t);
  }

  private stopHuman(targetId: string): void {
    this.appAsk.delete(targetId);
    const w = this.human.get(targetId);
    if (w) clearInterval(w.timer);
    this.human.delete(targetId);
  }

  private async closeHuman(t: TargetState): Promise<void> {
    const w = this.human.get(t.targetId);
    this.stopHuman(t.targetId);
    const kind = t.win?.kind ?? 'human';
    if (w) {
      try {
        const r = await this.relay.send<{ result: { value?: string } }>('Runtime.callFunctionOn', { objectId: w.objectId, functionDeclaration: 'function(){return typeof this.value==="string"?this.value:""}', returnByValue: true }, t.vaultSession);
        if (r.result.value) {
          this.relay.addKnownSecret(t.targetId, knownValueVariants(r.result.value));
          this.selfScan(r.result.value);
          if (this.opts.certMemory && w.scope) this.opts.certMemory.hold(w.runId, w.scope, new TextEncoder().encode(r.result.value));
        }
      } catch {
        // 노드가 이미 분리됨
      }
    }
    this.relay.deactivateWindow(t);
    this.log.event('secret.used', { kind, viaTypist: false });
  }

  async appProvided(bind: { runId: string; kind: string; scope: string }): Promise<void> {
    if (bind.kind !== 'cert_password') return;
    const entry = [...this.appAsk].find(([, a]) => a.runId === bind.runId && a.scope === bind.scope);
    if (!entry) return;
    const [targetId, ask] = entry;
    this.appAsk.delete(targetId);
    const bytes = this.secrets.take(bind.runId, 'cert_password', bind.scope);
    const t = this.relay.targets.get(targetId);
    if (!bytes) return;
    const text = new TextDecoder().decode(bytes);
    bytes.fill(0);
    if (!t || t.win?.phase !== 'active') {
      this.log.event('vault.cert_password_app_late');
      return;
    }
    this.relay.addKnownSecret(t.targetId, knownValuePrefixVariants(text));
    const typed = await this.typeInto(t, ask.objectId, text);
    this.relay.addKnownSecret(t.targetId, knownValueVariants(text));
    if (typed.ok && this.opts.certMemory) this.opts.certMemory.hold(bind.runId, ask.scope, new TextEncoder().encode(text));
    this.relay.deactivateWindow(t);
    this.log.event('secret.used', { kind: 'cert_password', viaTypist: true, ok: typed.ok, fromApp: true });
    this.selfScan(text);
  }

  async userDone(targetId: string): Promise<void> {
    const t = this.relay.exposedTarget(targetId);
    if (t?.win?.phase === 'active' && t.win.kind === 'human') await this.closeHuman(t);
  }

  async requestClose(req: { runId: string; targetId: string }): Promise<{ ok: boolean }> {
    const t = this.relay.exposedTarget(req.targetId);
    if (!t?.win || t.win.phase !== 'active') return { ok: true };
    if (t.win.kind !== 'human') {
      this.log.event('vault.secret_window_close_denied', { target: t.targetId.slice(0, 8), kind: t.win.kind });
      return { ok: false };
    }
    const w = this.human.get(t.targetId);
    const p = w ? await this.probe(t, w.objectId) : null;
    if (w && p && p.active) {
      this.log.event('vault.secret_window_close_denied', { target: t.targetId.slice(0, 8) });
      return { ok: false };
    }
    await this.closeHuman(t);
    return { ok: true };
  }

  async scrubTainted(t: TargetState): Promise<boolean> {
    if (!t.win) return true;
    if (t.win.phase !== 'tainted') return false;
    for (const backendNodeId of t.secretBackendIds) {
      const r = await this.relay.send<{ object: { objectId?: string } }>('DOM.resolveNode', { backendNodeId }, t.vaultSession).catch(() => null);
      const objectId = r?.object.objectId;
      if (!objectId) continue;
      const left = await this.relay
        .send<{ result: { value?: unknown } }>('Runtime.callFunctionOn', { objectId, functionDeclaration: 'function(){if(typeof this.value!=="string")return 0;this.value="";return this.value.length}', returnByValue: true }, t.vaultSession)
        .catch(() => null);
      if (left?.result.value !== 0) return false;
    }
    if (t.win?.phase !== 'tainted') return false;
    this.relay.endWindow(t, 'scrubbed');
    this.log.event('vault.secret_window_scrubbed', { target: t.targetId.slice(0, 8) });
    return true;
  }

  shutdown(): void {
    for (const id of [...this.human.keys()]) this.stopHuman(id);
    this.appAsk.clear();
    this.secrets.clear();
  }
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

function findFrameUrl(tree: Json, frameId: string): string | undefined {
  const frame = tree.frame as Json;
  if (frame.id === frameId) return String(frame.url) + String(frame.urlFragment ?? '');
  for (const c of (tree.childFrames as Json[]) ?? []) {
    const u = findFrameUrl(c, frameId);
    if (u) return u;
  }
  return undefined;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
