import type { EventLog } from '@sax/platform';
import { ACTIVE_WINDOW_DROP_EVENTS, RELAY_DROPPED_EVENTS } from '../constants.ts';
import type { CdpConnection, CdpMessage } from '../cdp/connection.ts';
import type { CommitGuard } from './commit-guard.ts';
import { checkSessionCommand, urlAllowed, type RelayPolicy, type Verdict } from './policy.ts';
import { scrubAxNodes, scrubDomNode, scrubDomSnapshot, scrubKnownValues, stripAuthHeaders, stripMessageHeaders, stripRequestBody, type SecretNodes } from './sanitize.ts';

type Json = Record<string, unknown>;

const VALUE_PROPS = new Set(['value', 'defaultValue']);

export interface SecretWindow {
  phase: 'active' | 'tainted';
  kind: 'typist' | 'human' | 'remote';
  frameId: string;
}

export interface TargetState {
  targetId: string;
  type: string;
  url: string;
  openerId?: string;
  vaultSession: string;
  paused: boolean;
  exposed: boolean;
  engineSession?: string;
  mainFrameId?: string;
  win?: SecretWindow;
  secretBackendIds: Set<number>;
  pendingPopup?: boolean;
  revoked?: boolean;
  exposing?: boolean;
}

interface EngineSession {
  targetId: string;
  child: boolean;
  parent?: string;
  childTargetId?: string;
  url?: string;
  pending?: { attach: CdpMessage };
  revoked?: boolean;
}

interface PendingEngineRequest {
  engineId: number;
  sessionId: string;
  method: string;
  params?: Json;
  sentTainted: boolean;
  sentSecretIds?: number[];
}

export interface RelayOptions {
  conn: CdpConnection;
  policy: RelayPolicy;
  log: EventLog;
  toEngine: (raw: string) => void;
}

/**
 * 기본 거부 허용 목록 CDP 중계(D05 §3.3·§3.4, ADR-005 v3 결정 2·3).
 * - 엔진은 가상 브라우저 루트만 본다. 루트 명령은 합성 응답(Browser.getVersion, Target.setAutoAttach)이거나 거부다.
 * - 엔진 세션은 금고가 만든 실행 page 타깃과 그 허용 origin 팝업, 그 안의 허용 자식(워커·허용 origin iframe)뿐이다.
 * - 엔진행 메시지는 한 줄 큐로 순서를 지키며 정리한 뒤 보낸다.
 */
export class Relay {
  private readonly conn: CdpConnection;
  private readonly policy: RelayPolicy;
  private readonly log: EventLog;
  private readonly toEngine: (raw: string) => void;
  readonly targets = new Map<string, TargetState>();
  private readonly byVaultSession = new Map<string, TargetState>();
  private readonly engineSessions = new Map<string, EngineSession>();
  private readonly pending = new Map<number, PendingEngineRequest>();
  private readonly taintedRequests = new Set<string>();
  private readonly knownVariants = new Map<string, string[]>();
  private engineAutoAttach = false;
  private creating = 0;
  private deferred: TargetState[] = [];
  private outQ: Promise<void> = Promise.resolve();
  private version: Json = {};
  readonly methodStats = new Map<string, { forwarded: number; denied: number; synthetic: number; scope: 'root' | 'session' }>();
  readonly onSecretWindowClosed = new Set<(targetId: string) => void>();
  activeValueHook?: (targetId: string) => Promise<void>;
  commitGuard: CommitGuard | null = null;
  onDownloadEvent?: (method: string, params: Json) => Promise<void>;

  constructor(opts: RelayOptions) {
    this.conn = opts.conn;
    this.policy = opts.policy;
    this.log = opts.log;
    this.toEngine = opts.toEngine;
    this.conn.on('message', (m: CdpMessage) => this.onChrome(m));
  }

  async init(): Promise<void> {
    this.version = await this.conn.send('Browser.getVersion');
    await this.conn.send('Target.setDiscoverTargets', { discover: true });
    await this.conn.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true });
  }

  get browserVersion(): Json {
    return this.version;
  }

  async createRunPage(): Promise<string> {
    for (let i = 0; i < 50 && !this.appStartTarget(); i++) await sleep(20);
    const app = this.appStartTarget();
    if (app) {
      await this.conn.send('Page.navigate', { url: 'about:blank' }, app.vaultSession).catch(() => {});
      for (let i = 0; i < 50; i++) {
        const tree = await this.conn.send<{ frameTree: { frame: Json } }>('Page.getFrameTree', {}, app.vaultSession).catch(() => null);
        if (tree && tree.frameTree.frame.url === 'about:blank') break;
        await sleep(20);
      }
      app.url = 'about:blank';
      await this.expose(app);
      this.log.event('vault.run_page_app_window');
      return app.targetId;
    }
    this.creating++;
    let targetId: string;
    try {
      ({ targetId } = await this.conn.send<{ targetId: string }>('Target.createTarget', { url: 'about:blank' }));
    } finally {
      this.creating--;
    }
    for (let i = 0; i < 50 && !this.targets.has(targetId); i++) await sleep(20);
    const t = this.targets.get(targetId);
    if (!t) throw new Error('run page did not attach');
    const queued = this.deferred;
    this.deferred = [];
    await this.expose(t);
    for (const d of queued) if (d !== t) await this.decide(d);
    return targetId;
  }

  private appStartTarget(): TargetState | undefined {
    return [...this.targets.values()].find((t) => t.type === 'page' && !t.exposed && !t.revoked && !t.openerId && t.url.startsWith('data:text/html'));
  }

  onEngineMessage(raw: string): void {
    let msg: CdpMessage;
    try {
      msg = JSON.parse(raw) as CdpMessage;
    } catch {
      return;
    }
    if (typeof msg.id !== 'number' || typeof msg.method !== 'string') return;
    if (!msg.sessionId) {
      void this.onRootCommand(msg).catch((e: Error) => this.enqueue(async () => ({ id: msg.id, error: { code: -32000, message: e.message } })));
      return;
    }
    const es = this.engineSessions.get(msg.sessionId);
    const t = es ? this.targets.get(es.targetId) : undefined;
    if (!es || !t || !t.exposed || es.pending) {
      this.reject(msg, { ok: false, reason: 'unknown_session' }, 'session');
      return;
    }
    if (es.child && msg.method === 'Page.disable') {
      this.reject(msg, { ok: false, reason: 'child_page_monitor' }, 'session');
      return;
    }
    const verdict = checkSessionCommand(msg.method, msg.params, this.stateOf(t), this.policy, this.taintedRequests);
    if (!verdict.ok) {
      this.reject(msg, verdict, 'session');
      return;
    }
    if (msg.method.startsWith('Fetch.') && this.commitGuard?.blocked.has(String(msg.params?.requestId))) {
      this.reject(msg, { ok: false, reason: 'commit_blocked' }, 'session');
      return;
    }
    if (msg.method === 'Fetch.enable' && !this.fetchPatternsAllowed(msg.params)) {
      this.reject(msg, { ok: false, reason: 'fetch_pattern_not_allowed' }, 'session');
      return;
    }
    this.stat(msg.method, 'session', 'forwarded');
    const relayId = this.conn.allocId();
    this.pending.set(relayId, {
      engineId: msg.id, sessionId: msg.sessionId, method: msg.method, params: msg.params,
      sentTainted: !!t?.win, sentSecretIds: t?.secretBackendIds.size ? [...t.secretBackendIds] : undefined,
    });
    this.conn.sendRaw({ id: relayId, method: msg.method, params: msg.params ?? {}, sessionId: msg.sessionId });
    if (msg.method === 'Runtime.runIfWaitingForDebugger' && !es.child && t.paused) {
      t.paused = false;
      void this.conn.send('Runtime.runIfWaitingForDebugger', {}, t.vaultSession).catch(() => {});
    }
  }

  private async onRootCommand(msg: CdpMessage): Promise<void> {
    const id = msg.id!;
    const method = msg.method!;
    const reply = (result: Json) => {
      this.stat(method, 'root', 'synthetic');
      this.enqueue(async () => ({ id, result }));
    };
    switch (method) {
      case 'Browser.getVersion':
        return reply(this.version);
      case 'Target.setAutoAttach': {
        if (msg.params?.flatten !== true) return this.reject(msg, { ok: false, reason: 'flatten_required' }, 'root');
        this.engineAutoAttach = true;
        for (const t of this.targets.values()) if (t.exposed && !t.engineSession) await this.attachEngine(t);
        return reply({});
      }
      case 'Target.getBrowserContexts':
        return reply({ browserContextIds: [] });
      case 'Target.getTargetInfo': {
        if (msg.params?.targetId === undefined) {
          return reply({ targetInfo: { targetId: 'vault-virtual-root', type: 'browser', title: '', url: '', attached: true, canAccessOpener: false } });
        }
        const t = this.targets.get(String(msg.params.targetId));
        if (!t?.exposed) return this.reject(msg, { ok: false, reason: 'target_not_exposed' }, 'root');
        this.stat(method, 'root', 'forwarded');
        const r = await this.conn.send('Target.getTargetInfo', { targetId: t.targetId });
        return this.enqueue(async () => ({ id, result: r }));
      }
      case 'Target.closeTarget':
      case 'Target.activateTarget': {
        const t = this.targets.get(String(msg.params?.targetId));
        if (!t?.exposed) return this.reject(msg, { ok: false, reason: 'target_not_exposed' }, 'root');
        if (method === 'Target.activateTarget') return this.reject(msg, { ok: false, reason: t.win?.phase === 'active' ? 'secret_window_active' : 'window_front_refused' }, 'root');
        this.stat(method, 'root', 'forwarded');
        const r = await this.conn.send(method, { targetId: t.targetId }).catch((e: Error) => ({ __error: e.message }));
        this.enqueue(async () => ('__error' in r ? { id, error: { code: -32000, message: String(r.__error) } } : { id, result: r }));
        return;
      }
      default:
        return this.reject(msg, { ok: false, reason: 'browser_target_not_exposed' }, 'root');
    }
  }

  private reject(msg: CdpMessage, v: Verdict, scope: 'root' | 'session'): void {
    const reason = v.ok ? 'denied' : v.reason;
    this.stat(msg.method!, scope, 'denied');
    this.log.event('vault.cdp_denied', { method: msg.method, reason, scope });
    const out: CdpMessage = { id: msg.id, error: { code: -32601, message: `vault relay denied ${msg.method} (${reason})` } };
    if (msg.sessionId) out.sessionId = msg.sessionId;
    this.enqueue(async () => out);
  }

  private fetchPatternsAllowed(params: Json | undefined): boolean {
    const patterns = params?.patterns;
    if (!Array.isArray(patterns) || patterns.length === 0) return false;
    return patterns.every((p) => {
      const url = String((p as Json).urlPattern ?? '');
      const m = /^https?:\/\/([^/*?]+)\//.exec(url);
      return !!m && urlAllowed(`https://${m[1]}/`, this.policy.allowedHosts);
    });
  }

  private stat(method: string, scope: 'root' | 'session', kind: 'forwarded' | 'denied' | 'synthetic'): void {
    const key = `${scope} ${method}`;
    const s = this.methodStats.get(key) ?? { forwarded: 0, denied: 0, synthetic: 0, scope };
    s[kind]++;
    this.methodStats.set(key, s);
  }

  private onChrome(msg: CdpMessage): void {
    if (msg.id !== undefined) {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      this.enqueue(() => this.sanitizeResponse(p, msg), p.method);
      return;
    }
    if (!msg.sessionId) {
      void this.onBrowserEvent(msg).catch((e: Error) => this.log.event('vault.browser_event_failed', { method: msg.method, error: e.message.slice(0, 120) }));
      return;
    }
    const vt = this.byVaultSession.get(msg.sessionId);
    if (vt) {
      this.onVaultSessionEvent(vt, msg);
      return;
    }
    if (this.engineSessions.has(msg.sessionId)) {
      const t = this.targetOfSession(msg.sessionId);
      const at = t ? { ...this.stateOf(t), secretIds: t.secretBackendIds.size ? [...t.secretBackendIds] : undefined } : undefined;
      this.enqueue(() => this.sanitizeEvent(msg, at), msg.method);
    }
  }

  private async onBrowserEvent(msg: CdpMessage): Promise<void> {
    const p = msg.params ?? {};
    switch (msg.method) {
      case 'Target.attachedToTarget': {
        const info = p.targetInfo as Json;
        const targetId = String(info.targetId);
        if (this.targets.has(targetId)) return;
        const t: TargetState = {
          targetId,
          type: String(info.type),
          url: String(info.url ?? ''),
          openerId: info.openerId ? String(info.openerId) : undefined,
          vaultSession: String(p.sessionId),
          paused: p.waitingForDebugger === true,
          exposed: false,
          secretBackendIds: new Set(),
        };
        this.targets.set(targetId, t);
        this.byVaultSession.set(t.vaultSession, t);
        if (t.type === 'page') this.onPageOpened?.(t);
        if (this.creating > 0 && t.type === 'page') this.deferred.push(t);
        else await this.decide(t);
        return;
      }
      case 'Target.detachedFromTarget': {
        const sid = String(p.sessionId);
        const es = this.engineSessions.get(sid);
        if (es && !es.child) {
          this.engineSessions.delete(sid);
          const t = this.targets.get(es.targetId);
          if (t) t.engineSession = undefined;
          this.enqueue(async () => ({ method: 'Target.detachedFromTarget', params: { sessionId: sid, targetId: es.targetId } }));
        }
        const vt = this.byVaultSession.get(sid);
        if (vt) {
          this.byVaultSession.delete(sid);
          this.targets.delete(vt.targetId);
          this.onTargetGone?.(vt);
        }
        return;
      }
      case 'Target.targetInfoChanged': {
        const info = p.targetInfo as Json;
        const t = this.targets.get(String(info.targetId));
        if (t) {
          t.url = String(info.url ?? t.url);
          if (info.openerId) t.openerId = String(info.openerId);
          if (t.type === 'page') this.onPageUrl?.(t);
        }
        return;
      }
      case 'Browser.downloadWillBegin':
      case 'Browser.downloadProgress':
        await this.onDownloadEvent?.(String(msg.method), p);
        return;
    }
  }

  private async decide(t: TargetState): Promise<void> {
    const opener = t.openerId ? this.targets.get(t.openerId) : undefined;
    if (t.type === 'page' && opener?.exposed) {
      t.pendingPopup = true;
      const wasPaused = t.paused;
      await this.conn.send('Page.enable', {}, t.vaultSession).catch(() => {});
      await this.resume(t);
      if (!wasPaused) {
        const tree = await this.conn.send<{ frameTree: { frame: Json } }>('Page.getFrameTree', {}, t.vaultSession).catch(() => null);
        const url = String(tree?.frameTree.frame.url ?? '');
        if (url && url !== 'about:blank') await this.confirmPopup(t, url);
      }
      return;
    }
    if (t.type === 'page') this.log.event('vault.user_tab_hidden', { target: t.targetId.slice(0, 8) });
    await this.resume(t);
  }

  private confirmedAllowed(url: string, parentUrl: string): boolean {
    if (!url || url.startsWith('chrome-error://')) return false;
    if (url === 'about:blank') return !!parentUrl && parentUrl !== 'about:blank' && urlAllowed(parentUrl, this.policy.allowedHosts);
    return urlAllowed(url, this.policy.allowedHosts);
  }

  private async confirmPopup(t: TargetState, committedUrl: string): Promise<void> {
    const tree = await this.conn.send<{ frameTree: { frame: Json } }>('Page.getFrameTree', {}, t.vaultSession).catch(() => null);
    if (!t.pendingPopup || !this.targets.has(t.targetId)) return;
    const current = String(tree?.frameTree.frame.url ?? '');
    if (current !== committedUrl) return;
    const opener = t.openerId ? this.targets.get(t.openerId) : undefined;
    if (opener?.exposed && this.confirmedAllowed(current, opener.url)) {
      t.pendingPopup = false;
      await this.expose(t);
    } else {
      this.revokePopup(t);
    }
  }

  private revokePopup(t: TargetState): void {
    void this.revokeTarget(t, 'vault.popup_hidden');
  }

  private async revokeTarget(t: TargetState, code: 'vault.popup_hidden' | 'vault.origin_left'): Promise<void> {
    const first = !t.revoked;
    t.revoked = true;
    t.pendingPopup = false;
    t.exposed = false;
    if (first) this.log.event(code, { target: t.targetId.slice(0, 8) });
    const sid = t.engineSession;
    if (sid) await this.conn.send('Target.detachFromTarget', { sessionId: sid }).catch(() => {});
  }

  private isMainFrame(t: TargetState, frameId: unknown): boolean {
    return frameId === t.targetId;
  }

  private async resume(t: TargetState): Promise<void> {
    if (!t.paused) return;
    t.paused = false;
    await this.conn.send('Runtime.runIfWaitingForDebugger', {}, t.vaultSession).catch(() => {});
  }

  private async expose(t: TargetState): Promise<void> {
    if (t.revoked) return;
    t.exposing = true;
    try {
      await this.conn.send('Page.enable', {}, t.vaultSession);
      const { frameTree } = await this.conn.send<{ frameTree: { frame: Json } }>('Page.getFrameTree', {}, t.vaultSession);
      t.mainFrameId = String(frameTree.frame.id);
      if (t.revoked) return;
      t.exposed = true;
      if (this.engineAutoAttach) await this.attachEngine(t);
    } finally {
      t.exposing = false;
    }
  }

  private async attachEngine(t: TargetState): Promise<void> {
    if (t.revoked) return;
    const { sessionId } = await this.conn.send<{ sessionId: string }>('Target.attachToTarget', { targetId: t.targetId, flatten: true });
    const abandon = async () => {
      this.engineSessions.delete(sessionId);
      if (t.engineSession === sessionId) t.engineSession = undefined;
      await this.conn.send('Target.detachFromTarget', { sessionId }).catch(() => {});
    };
    if (t.revoked) return abandon();
    t.engineSession = sessionId;
    const { targetInfo } = await this.conn.send<{ targetInfo: Json }>('Target.getTargetInfo', { targetId: t.targetId });
    if (t.revoked) return abandon();
    this.engineSessions.set(sessionId, { targetId: t.targetId, child: false });
    this.enqueue(async () => {
      if (t.revoked || t.engineSession !== sessionId) return null;
      return { method: 'Target.attachedToTarget', params: { sessionId, targetInfo: { ...targetInfo, attached: true }, waitingForDebugger: t.paused } };
    });
  }

  private onVaultSessionEvent(t: TargetState, msg: CdpMessage): void {
    const p = msg.params ?? {};
    if (msg.method === 'Page.frameNavigated') {
      const frame = p.frame as Json;
      if (!frame.parentId) {
        t.url = String(frame.url ?? '');
        if (t.pendingPopup) void this.confirmPopup(t, t.url);
        else if ((t.exposed || t.exposing) && !urlAllowed(t.url, this.policy.allowedHosts)) void this.originLeft(t);
      }
      if (t.win && (frame.id === t.win.frameId || !frame.parentId)) this.endWindow(t, 'commit');
    } else if (msg.method === 'Page.frameStartedNavigating') {
      const offsite = !urlAllowed(String(p.url ?? ''), this.policy.allowedHosts);
      if (offsite && this.isMainFrame(t, p.frameId)) {
        if (t.pendingPopup) this.revokePopup(t);
        else if (t.exposed || t.exposing) void this.originLeft(t);
      }
    } else if (msg.method === 'Page.frameDetached') {
      if (t.win && p.frameId === t.win.frameId) this.endWindow(t, 'detached');
    } else if (msg.method === 'Page.screencastFrame') {
      this.onScreencastFrame?.(t, p);
    }
  }

  private async originLeft(t: TargetState): Promise<void> {
    await this.revokeTarget(t, 'vault.origin_left');
  }

  private enqueue(produce: () => Promise<CdpMessage | null>, method?: string): void {
    this.outQ = this.outQ.then(async () => {
      let out: CdpMessage | null;
      try {
        out = await produce();
      } catch {
        out = null;
      }
      if (!out) return;
      let raw = JSON.stringify(out);
      const all = [...this.knownVariants].flatMap(([targetId, variants]) => variants.map((v) => [targetId, v] as const)).sort((a, b) => b[1].length - a[1].length);
      let total = 0;
      for (const [, v] of all) {
        const r = scrubKnownValues(raw, [v]);
        if (!r.hits) continue;
        raw = r.text;
        total += r.hits;
      }
      if (total) this.log.event('vault.known_value_scrubbed', { hits: total, method: (method ?? out.method ?? 'response').slice(0, 60) });
      this.toEngine(raw);
    });
  }

  private targetOfSession(sessionId: string): TargetState | undefined {
    const es = this.engineSessions.get(sessionId);
    return es ? this.targets.get(es.targetId) : undefined;
  }

  stateOf(t: TargetState): { active: boolean; tainted: boolean } {
    return { active: t.win?.phase === 'active', tainted: !!t.win };
  }

  private async sanitizeEvent(msg: CdpMessage, at?: { active: boolean; tainted: boolean; secretIds?: number[] }): Promise<CdpMessage | null> {
    const es = this.engineSessions.get(msg.sessionId!);
    const t = es ? this.targets.get(es.targetId) : undefined;
    if (!es || !t || !t.exposed) return null;
    if (RELAY_DROPPED_EVENTS.has(String(msg.method))) return null;
    const p = (msg.params ?? {}) as Json;
    const now = this.stateOf(t);
    const st = { active: now.active || !!at?.active, tainted: now.tainted || !!at?.tainted };
    if (now.active && t.win?.kind !== 'typist') await this.activeValueHook?.(t.targetId).catch(() => {});
    if (es.child && msg.method === 'Page.frameStartedNavigating') {
      if (p.frameId === es.childTargetId && !urlAllowed(String(p.url ?? ''), this.policy.allowedHosts)) {
        this.revokeChild(msg.sessionId!, es);
        return null;
      }
      return es.pending ? null : msg;
    }
    if (es.child && msg.method === 'Page.frameNavigated') {
      const frame = p.frame as Json;
      if (frame.id === es.childTargetId || !frame.parentId) {
        es.url = String(frame.url ?? '');
        if (!this.childUrlAllowed(es.url, es.parent)) {
          this.revokeChild(msg.sessionId!, es);
          return null;
        }
        if (es.pending) return this.releasePendingChild(msg.sessionId!, es);
      }
      return es.pending ? null : msg;
    }
    if (es.pending) return null;
    switch (msg.method) {
      case 'Target.attachedToTarget':
        return this.filterChildAttach(msg);
      case 'Target.detachedFromTarget': {
        const sid = String(p.sessionId);
        if (!this.engineSessions.has(sid)) return null;
        this.engineSessions.delete(sid);
        return msg;
      }
      case 'Page.frameNavigated': {
        const frame = p.frame as Json;
        if (!frame.parentId && !urlAllowed(String(frame.url ?? ''), this.policy.allowedHosts)) {
          void this.originLeft(t);
          return null;
        }
        return msg;
      }
      case 'Network.requestWillBeSentExtraInfo':
      case 'Network.responseReceivedExtraInfo':
        stripMessageHeaders(p);
        return msg;
      case 'Network.responseReceived':
      case 'Network.webSocketHandshakeResponseReceived':
        stripMessageHeaders(p.response as Json);
        return msg;
      case 'Network.webSocketWillSendHandshakeRequest':
        stripMessageHeaders(p.request as Json);
        return msg;
      case 'Network.requestWillBeSent':
      case 'Fetch.requestPaused':
        if (this.commitGuard && (await this.commitBody(msg, t, p)) === 'drop') return null;
        stripMessageHeaders(p.request as Json);
        stripMessageHeaders(p.redirectResponse as Json);
        stripAuthHeaders(p.responseHeaders as Json[]);
        if (st.tainted) {
          this.taintedRequests.add(String(p.requestId));
          if (p.networkId) this.taintedRequests.add(String(p.networkId));
          stripRequestBody(p.request as Json);
        }
        return msg;
      case 'Network.webSocketFrameSent':
        if (st.tainted && p.response) (p.response as Json).payloadData = '';
        return msg;
      case 'DOM.setChildNodes':
        for (const n of (p.nodes as Json[]) ?? []) scrubDomNode(n, this.secretsOf(t, at?.secretIds));
        return msg;
      case 'DOM.childNodeInserted':
        scrubDomNode(p.node as Json, this.secretsOf(t, at?.secretIds));
        return msg;
      case 'DOM.shadowRootPushed':
        scrubDomNode(p.root as Json, this.secretsOf(t, at?.secretIds));
        return msg;
      case 'DOM.attributeModified':
        if (st.tainted && String(p.name).toLowerCase() === 'value') p.value = '';
        return msg;
      case 'Accessibility.nodesUpdated':
        scrubAxNodes(p.nodes, await this.secretsWithPasswords(t, at?.secretIds));
        return msg;
      case 'Page.screencastFrame':
        return st.tainted ? null : msg;
    }
    if (st.active && msg.method && ACTIVE_WINDOW_DROP_EVENTS.has(msg.method)) return null;
    return msg;
  }

  private async commitBody(msg: CdpMessage, t: TargetState, p: Json): Promise<'pass' | 'hide' | 'drop'> {
    const guard = this.commitGuard!;
    const req = (p.request ?? {}) as Json;
    let d: 'pass' | 'hide' | 'drop';
    if (msg.method === 'Fetch.requestPaused') d = await guard.onPaused(t.targetId, msg.sessionId!, p);
    else d = guard.armedFor(t.targetId, String(req.url ?? ''), String(req.method ?? '')) || this.taintedRequests.has(String(p.requestId)) ? 'hide' : 'pass';
    if (d === 'hide') {
      stripRequestBody(req);
      this.taintedRequests.add(String(p.requestId));
      if (p.networkId) this.taintedRequests.add(String(p.networkId));
    }
    return d;
  }

  private sessionUrl(sessionId: string | undefined): string {
    if (!sessionId) return '';
    const es = this.engineSessions.get(sessionId);
    if (!es) return '';
    return es.child ? (es.url ?? '') : (this.targets.get(es.targetId)?.url ?? '');
  }

  private childUrlAllowed(url: string, parent: string | undefined): boolean {
    const parentOk = !!parent && this.engineSessions.has(parent) && urlAllowed(this.sessionUrl(parent), this.policy.allowedHosts);
    if (!parentOk) return false;
    if (url === '' || url === 'about:blank') return true;
    return urlAllowed(url, this.policy.allowedHosts);
  }

  private revokeChild(sid: string, es: EngineSession): void {
    es.revoked = true;
    const drop = [sid];
    for (let i = 0; i < drop.length; i++) {
      for (const [k, v] of this.engineSessions) if (v.parent === drop[i] && !drop.includes(k)) drop.push(k);
    }
    for (const k of drop) this.engineSessions.delete(k);
    this.log.event(es.pending ? 'vault.child_hidden' : 'vault.child_origin_left', { count: drop.length });
    if (!es.pending && es.parent && this.engineSessions.has(es.parent)) {
      this.enqueue(async () => ({ method: 'Target.detachedFromTarget', sessionId: es.parent, params: { sessionId: sid, targetId: es.childTargetId } }));
    }
    void this.conn.send('Target.detachFromTarget', { sessionId: sid }, es.parent).catch(() => {});
  }

  private async releasePendingChild(sid: string, es: EngineSession): Promise<CdpMessage | null> {
    if (!es.pending) return null;
    const tree = await this.conn.send<{ frameTree: { frame: Json } }>('Page.getFrameTree', {}, sid).catch(() => null);
    if (!es.pending || es.revoked || this.engineSessions.get(sid) !== es) return null;
    const current = String(tree?.frameTree.frame.url ?? '');
    if (current !== es.url) return null;
    if (!this.confirmedAllowed(current, this.sessionUrl(es.parent))) {
      this.revokeChild(sid, es);
      return null;
    }
    const attach = es.pending.attach;
    es.pending = undefined;
    const p = attach.params as Json;
    return { ...attach, params: { ...p, targetInfo: { ...(p.targetInfo as Json), url: current } } };
  }

  private async filterChildAttach(msg: CdpMessage): Promise<CdpMessage | null> {
    const p = msg.params as Json;
    const info = p.targetInfo as Json;
    const child = String(p.sessionId);
    const type = String(info.type);
    const url = String(info.url ?? '');
    const parent = msg.sessionId!;
    const parentEs = this.engineSessions.get(parent)!;
    const workerUrlOk = url.startsWith('blob:') || url.startsWith('data:') || this.childUrlAllowed(url, parent);
    const ok = (type === 'worker' && workerUrlOk && this.childUrlAllowed('', parent)) || (type === 'iframe' && this.childUrlAllowed(url, parent));
    if (ok) {
      const es: EngineSession = { targetId: parentEs.targetId, child: true, parent, childTargetId: String(info.targetId), url };
      this.engineSessions.set(child, es);
      if (type !== 'iframe') return msg;
      await this.conn.send('Page.enable', {}, child).catch(() => {});
      if (url !== '' && url !== 'about:blank') return msg;
      const tree = await this.conn.send<{ frameTree: { frame: Json } }>('Page.getFrameTree', {}, child).catch(() => null);
      const committed = String(tree?.frameTree.frame.url ?? '');
      if (committed && committed !== 'about:blank') {
        es.url = committed;
        if (!this.confirmedAllowed(committed, this.sessionUrl(parent))) {
          this.engineSessions.delete(child);
          return this.hideChild(msg, child, type);
        }
        return { ...msg, params: { ...p, targetInfo: { ...info, url: committed } } };
      }
      es.pending = { attach: { ...msg, params: { ...p, waitingForDebugger: false } } };
      await this.conn.send('Runtime.runIfWaitingForDebugger', {}, child).catch(() => {});
      return null;
    }
    return this.hideChild(msg, child, type);
  }

  private async hideChild(msg: CdpMessage, child: string, type: string): Promise<null> {
    this.log.event('vault.child_hidden', { type });
    await this.conn.send('Runtime.runIfWaitingForDebugger', {}, child).catch(() => {});
    await this.conn.send('Target.detachFromTarget', { sessionId: child }, msg.sessionId).catch(() => {});
    return null;
  }

  private async sanitizeResponse(p: PendingEngineRequest, msg: CdpMessage): Promise<CdpMessage | null> {
    const out: CdpMessage = { id: p.engineId, sessionId: p.sessionId };
    if (msg.error) {
      out.error = msg.error;
      return out;
    }
    const result = (msg.result ?? {}) as Json;
    out.result = result;
    const t = this.targetOfSession(p.sessionId);
    if (!t) return out;
    const tainted = p.sentTainted || !!t.win;
    if (t.win?.phase === 'active' && t.win.kind !== 'typist') await this.activeValueHook?.(t.targetId).catch(() => {});
    const [domain] = p.method.split('.');
    if (domain === 'DOM') {
      const secrets = this.secretsOf(t, p.sentSecretIds);
      scrubDomNode(result.root as Json, secrets);
      scrubDomNode(result.node as Json, secrets);
      for (const n of (result.nodes as Json[]) ?? []) scrubDomNode(n, secrets);
    } else if (domain === 'Accessibility') {
      const secrets = await this.secretsWithPasswords(t, p.sentSecretIds);
      scrubAxNodes(result.nodes, secrets);
      if (result.node) scrubAxNodes([result.node], secrets);
    } else if (p.method === 'DOMSnapshot.captureSnapshot') {
      scrubDomSnapshot(result, this.secretsOf(t, p.sentSecretIds));
    } else if (p.method === 'Runtime.getProperties' && tainted) {
      for (const prop of (result.result as Json[] | undefined) ?? []) {
        const v = prop?.value as Json | undefined;
        if (VALUE_PROPS.has(String(prop?.name)) && v && v.type === 'string') {
          v.value = '';
          if ('description' in v) v.description = '';
        }
      }
    } else if ((p.method === 'Network.getRequestPostData' || p.method === 'Fetch.getRequestPostData') && tainted) {
      out.result = { postData: '' };
    }
    return out;
  }

  private secretsOf(t: TargetState, snap?: readonly number[]): SecretNodes {
    if (!snap?.length) return { backendIds: t.secretBackendIds };
    return { backendIds: new Set([...t.secretBackendIds, ...snap]) };
  }

  private async secretsWithPasswords(t: TargetState, snap?: readonly number[]): Promise<SecretNodes> {
    const ids = new Set([...t.secretBackendIds, ...(snap ?? [])]);
    try {
      const { root } = await this.conn.send<{ root: Json }>('DOM.getDocument', { depth: -1, pierce: true }, t.vaultSession);
      const walk = (n: Json | undefined) => {
        if (!n) return;
        const attrs = n.attributes as string[] | undefined;
        if (String(n.nodeName).toUpperCase() === 'INPUT' && attrs) {
          for (let i = 0; i + 1 < attrs.length; i += 2) if (attrs[i]!.toLowerCase() === 'type' && attrs[i + 1]!.toLowerCase() === 'password') ids.add(Number(n.backendNodeId));
        }
        for (const k of ['children', 'shadowRoots']) for (const c of (n[k] as Json[]) ?? []) walk(c);
        walk(n.contentDocument as Json | undefined);
      };
      walk(root);
    } catch {
      // 타깃이 사라졌으면 금고가 아는 노드만으로 정리
    }
    return { backendIds: ids };
  }

  send<T = Json>(method: string, params: Json, sessionId?: string): Promise<T> {
    return this.conn.send<T>(method, params, sessionId);
  }

  openWindow(t: TargetState, kind: SecretWindow['kind'], frameId: string, backendNodeId: number): void {
    t.win = { phase: 'active', kind, frameId };
    t.secretBackendIds.add(backendNodeId);
    this.onWindowActive?.(t, true);
  }

  onScreencastFrame?: (t: TargetState, p: Json) => void;
  onWindowActive?: (t: TargetState, active: boolean) => void;
  onTargetGone?: (t: TargetState) => void;
  onPageOpened?: (t: TargetState) => void;
  onPageUrl?: (t: TargetState) => void;
  hasExposedPage(): boolean {
    return [...this.targets.values()].some((x) => x.type === 'page' && x.exposed && !x.revoked);
  }

  deactivateWindow(t: TargetState): void {
    if (t.win?.phase === 'active') {
      t.win.phase = 'tainted';
      for (const fn of this.onSecretWindowClosed) fn(t.targetId);
      this.onWindowActive?.(t, false);
    }
  }

  endWindow(t: TargetState, _why: 'commit' | 'detached' | 'scrubbed'): void {
    if (!t.win) return;
    const wasActive = t.win.phase === 'active';
    t.win = undefined;
    t.secretBackendIds.clear();
    const stale = this.knownVariants.get(t.targetId);
    this.enqueue(async () => {
      if (this.knownVariants.get(t.targetId) === stale) this.clearKnownSecrets(t.targetId);
      if (!this.hasOpenWindow()) this.clearKnownSecrets();
      return null;
    });
    if (wasActive) {
      for (const fn of this.onSecretWindowClosed) fn(t.targetId);
      this.onWindowActive?.(t, false);
    }
  }

  addKnownSecret(targetId: string, variants: string[]): void {
    this.knownVariants.set(targetId, [...new Set([...(this.knownVariants.get(targetId) ?? []), ...variants])]);
  }

  clearKnownSecrets(targetId?: string): void {
    if (targetId === undefined) {
      this.knownVariants.clear();
    } else {
      this.knownVariants.delete(targetId);
    }
  }

  drained(): Promise<void> {
    return this.outQ;
  }

  knownVariantCount(targetId?: string): number {
    if (targetId !== undefined) return this.knownVariants.get(targetId)?.length ?? 0;
    return [...this.knownVariants.values()].reduce((n, v) => n + v.length, 0);
  }

  hasOpenWindow(): boolean {
    return [...this.targets.values()].some((t) => t.win);
  }

  runWindowTarget(): TargetState | undefined {
    return [...this.targets.values()].filter((x) => x.type === 'page' && x.exposed && !x.revoked && !x.win && !x.pendingPopup).pop();
  }

  async placeWindow(bounds: { left: number; top: number; width: number; height: number }): Promise<boolean> {
    const t = this.runWindowTarget();
    if (!t) return false;
    try {
      const { windowId } = await this.conn.send<{ windowId: number }>('Browser.getWindowForTarget', { targetId: t.targetId });
      await this.conn.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'normal' } });
      await this.conn.send('Browser.setWindowBounds', { windowId, bounds });
      return true;
    } catch {
      return false;
    }
  }

  exposedTarget(targetId: string): TargetState | undefined {
    const t = this.targets.get(targetId);
    return t?.exposed ? t : undefined;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
