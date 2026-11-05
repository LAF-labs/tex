import type { EventLog } from '@sax/platform';
import { ACTIVE_WINDOW_DROP_EVENTS } from '../constants.ts';
import type { CdpMessage, PipeConnection } from '../cdp/connection.ts';
import { checkSessionCommand, urlAllowed, type RelayPolicy, type Verdict } from './policy.ts';
import { scrubAxNodes, scrubDomNode, scrubDomSnapshot, scrubKnownValues, stripAuthHeaders, stripMessageHeaders, stripRequestBody, type SecretNodes } from './sanitize.ts';

type Json = Record<string, unknown>;

/** 오염 상태 Runtime.getProperties에서 지우는 입력 값 속성. */
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
  /** 금고 감시 세션(브라우저 수준 자동 부착으로 생긴 세션). 엔진에 노출하지 않는다. */
  vaultSession: string;
  /** waitForDebuggerOnStart로 멈춰 있는가(금고 세션 기준). */
  paused: boolean;
  exposed: boolean;
  engineSession?: string;
  mainFrameId?: string;
  win?: SecretWindow;
  /** 금고가 입력한 노드·human:secret 대상 노드. */
  secretBackendIds: Set<number>;
  /** 목적지를 모르는 팝업: 금고가 숨긴 채 재개하고, 문서 커밋 + getFrameTree로 허용이 확인될 때만 노출한다. */
  pendingPopup?: boolean;
  /** 허용 밖 이동·커밋이 한 번이라도 확인된 타깃. 이후 어떤 이동에도 다시 노출하지 않는다(영구, 단조). */
  revoked?: boolean;
  /** expose() 진행 중(await 사이). 이 동안의 허용 밖 이동도 거부로 기록한다. */
  exposing?: boolean;
}

interface EngineSession {
  targetId: string;
  child: boolean;
  /** 자식 세션: 부착된 부모 세션(page 또는 다른 자식). */
  parent?: string;
  /** 자식 세션의 자기 타깃 ID(OOPIF 루트 프레임 ID와 같다). */
  childTargetId?: string;
  /** 자식 세션의 현재 문서 URL. */
  url?: string;
  /** 목적지를 모르는 자식 iframe: 금고가 재개하고 첫 커밋 origin을 본 뒤 엔진에 알린다(그 전까지 엔진은 모른다). */
  pending?: { attach: CdpMessage };
  /** 영구 분리됨(맵에서도 지운다). 진행 중인 보류 해제가 이 표시를 보고 중단한다. */
  revoked?: boolean;
}

interface PendingEngineRequest {
  engineId: number;
  sessionId: string;
  method: string;
  params?: Json;
  /**
   * 보낼 때의 창 상태. 문서 커밋은 금고 세션에서 바로 처리돼 창을 닫고 비밀 노드를 비우지만, 그 전에 보낸 요청의 응답은
   * 옛 문서 것이다. 응답 정화는 보낼 때와 받을 때 상태의 합집합으로 한다(이벤트는 받을 때 오염 여부를 이미 떠 둔다).
   */
  sentTainted: boolean;
  sentSecretIds?: number[];
}

export interface RelayOptions {
  conn: PipeConnection;
  policy: RelayPolicy;
  log: EventLog;
  /** 엔진으로 가는 직렬화된 CDP 프레임. */
  toEngine: (raw: string) => void;
  /** 알려진 값 치환이 적중했다(누출 의심, N-17). 창(타깃의 알려진 값 묶음)마다 1회. */
  onLeakSuspected?: (hits: number) => void;
}

/**
 * 기본 거부 허용 목록 CDP 중계(D05 §3.3·§3.4, ADR-005 v3 결정 2·3).
 * - 엔진은 가상 브라우저 루트만 본다. 루트 명령은 합성 응답(Browser.getVersion, Target.setAutoAttach)이거나 거부다.
 * - 엔진 세션은 금고가 만든 실행 page 타깃과 그 허용 origin 팝업, 그 안의 허용 자식(워커·허용 origin iframe)뿐이다.
 * - 엔진행 메시지는 한 줄 큐로 순서를 지키며 정리한 뒤 보낸다.
 */
export class Relay {
  private readonly conn: PipeConnection;
  private readonly policy: RelayPolicy;
  private readonly log: EventLog;
  private readonly toEngine: (raw: string) => void;
  readonly targets = new Map<string, TargetState>();
  private readonly byVaultSession = new Map<string, TargetState>();
  private readonly engineSessions = new Map<string, EngineSession>();
  private readonly pending = new Map<number, PendingEngineRequest>();
  private readonly taintedRequests = new Set<string>();
  /** 타깃별 알려진 값 변형(N-78). 창이 커밋·분리로 끝나면 그 타깃 것을 지운다. */
  private readonly knownVariants = new Map<string, string[]>();
  /** 누출 의심을 이미 알린 타깃(알려진 값 묶음이 지워지면 다시 알린다). */
  private readonly leakNotified = new Set<string>();
  private readonly onLeakSuspected?: (hits: number) => void;
  private engineAutoAttach = false;
  private creating = 0;
  private deferred: TargetState[] = [];
  private outQ: Promise<void> = Promise.resolve();
  private version: Json = {};
  /** 측정용(S6b): 엔진이 보낸 메서드별 판정. */
  readonly methodStats = new Map<string, { forwarded: number; denied: number; synthetic: number; scope: 'root' | 'session' }>();
  readonly onSecretWindowClosed = new Set<(targetId: string) => void>();

  constructor(opts: RelayOptions) {
    this.conn = opts.conn;
    this.policy = opts.policy;
    this.log = opts.log;
    this.toEngine = opts.toEngine;
    this.onLeakSuspected = opts.onLeakSuspected;
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

  /** 이번 실행을 위한 page 타깃을 금고가 만든다(엔진의 Target.createTarget은 거부). */
  async createRunPage(): Promise<string> {
    this.creating++;
    let targetId: string;
    try {
      ({ targetId } = await this.conn.send<{ targetId: string }>('Target.createTarget', { url: 'about:blank' }));
    } finally {
      this.creating--;
    }
    // 부착 이벤트가 응답보다 늦게 올 수 있으므로 잠시 기다린다.
    for (let i = 0; i < 50 && !this.targets.has(targetId); i++) await sleep(20);
    const t = this.targets.get(targetId);
    if (!t) throw new Error('run page did not attach');
    const queued = this.deferred;
    this.deferred = [];
    await this.expose(t);
    for (const d of queued) if (d !== t) await this.decide(d);
    return targetId;
  }

  // ───────────────────────── 엔진 → Chrome ─────────────────────────

  onEngineMessage(raw: string): void {
    let msg: CdpMessage;
    try {
      msg = JSON.parse(raw) as CdpMessage;
    } catch {
      return;
    }
    if (typeof msg.id !== 'number' || typeof msg.method !== 'string') return;
    if (!msg.sessionId) {
      // Chrome이 닫히는 중이면 conn.send가 거부된다. 잡지 않으면 금고 프로세스가 처리 안 된 거부로 죽는다. 엔진에는 오류로 답한다.
      void this.onRootCommand(msg).catch((e: Error) => this.enqueue(async () => ({ id: msg.id, error: { code: -32000, message: e.message } })));
      return;
    }
    const es = this.engineSessions.get(msg.sessionId);
    const t = es ? this.targets.get(es.targetId) : undefined;
    if (!es || !t || !t.exposed || es.pending) {
      this.reject(msg, { ok: false, reason: 'unknown_session' }, 'session');
      return;
    }
    // 자식 프레임 감시는 금고가 켠 Page 도메인에 기댄다. 엔진이 끄지 못하게 한다.
    if (es.child && msg.method === 'Page.disable') {
      this.reject(msg, { ok: false, reason: 'child_page_monitor' }, 'session');
      return;
    }
    const verdict = checkSessionCommand(msg.method, msg.params, this.stateOf(t), this.policy, this.taintedRequests);
    if (!verdict.ok) {
      this.reject(msg, verdict, 'session');
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
        // 인자 없는 호출은 Playwright 연결 장벽(결과 미사용). 브라우저 타깃 정보 대신 가상 루트 정보를 준다.
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
        if (method === 'Target.activateTarget' && t.win?.phase === 'active') return this.reject(msg, { ok: false, reason: 'secret_window_active' }, 'root');
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

  // ───────────────────────── Chrome → 엔진 ─────────────────────────

  private onChrome(msg: CdpMessage): void {
    if (msg.id !== undefined) {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      this.enqueue(() => this.sanitizeResponse(p, msg));
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
      // 받은 시점의 창 상태를 찍어 둔다: 커밋(창 종료)은 금고 세션에서 바로 처리되지만 이 이벤트는 줄 뒤에서 정리된다.
      const t = this.targetOfSession(msg.sessionId);
      // 비밀 노드도 함께 떠 둔다(커밋이 secretBackendIds를 비워도 옛 문서 이벤트는 정화한다).
      const at = t ? { ...this.stateOf(t), secretIds: t.secretBackendIds.size ? [...t.secretBackendIds] : undefined } : undefined;
      this.enqueue(() => this.sanitizeEvent(msg, at));
    }
  }

  private async onBrowserEvent(msg: CdpMessage): Promise<void> {
    const p = msg.params ?? {};
    switch (msg.method) {
      case 'Target.attachedToTarget': {
        const info = p.targetInfo as Json;
        const targetId = String(info.targetId);
        if (this.targets.has(targetId)) return; // 엔진용 attachToTarget의 반향
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
        }
        return;
      }
      case 'Target.targetInfoChanged': {
        const info = p.targetInfo as Json;
        const t = this.targets.get(String(info.targetId));
        if (t) {
          t.url = String(info.url ?? t.url);
          if (info.openerId) t.openerId = String(info.openerId);
        }
        return;
      }
    }
  }

  /**
   * 새 타깃 노출 여부(D05 §3.3 "허용 origin 팝업만"): 노출 타깃이 연 팝업 중 허용 origin인 것만 노출한다.
   * Chrome은 팝업 부착 때 targetInfo.url을 비워 주므로(실측) 목적지를 모르면 금고가 숨긴 채 재개하고,
   * 첫 문서 커밋의 origin을 본 뒤에야 엔진에 붙인다. 사용자 탭·워커 타깃은 재개 후 숨긴다.
   */
  private async decide(t: TargetState): Promise<void> {
    const opener = t.openerId ? this.targets.get(t.openerId) : undefined;
    if (t.type === 'page' && opener?.exposed) {
      // fail-closed: 부착 정보의 url·시간 경과로는 노출하지 않는다. 빈 URL은 "모름"이다.
      t.pendingPopup = true;
      await this.conn.send('Page.enable', {}, t.vaultSession).catch(() => {});
      await this.resume(t);
      return;
    }
    if (t.type === 'page') this.log.event('vault.user_tab_hidden', { target: t.targetId.slice(0, 8) });
    await this.resume(t);
  }

  /**
   * 확인된 문서 URL만 허용한다. 빈 URL·Chrome 오류 페이지는 목적지를 알 수 없으므로 거부하고,
   * about:blank는 opener·부모가 허용 origin일 때만 통과한다.
   */
  private confirmedAllowed(url: string, parentUrl: string): boolean {
    if (!url || url.startsWith('chrome-error://')) return false;
    if (url === 'about:blank') return !!parentUrl && parentUrl !== 'about:blank' && urlAllowed(parentUrl, this.policy.allowedHosts);
    return urlAllowed(url, this.policy.allowedHosts);
  }

  /** 팝업 문서 커밋: getFrameTree로 현재 문서를 다시 확인한 뒤에만 노출한다. 허용 밖이면 계속 숨긴다. */
  private async confirmPopup(t: TargetState, committedUrl: string): Promise<void> {
    const tree = await this.conn.send<{ frameTree: { frame: Json } }>('Page.getFrameTree', {}, t.vaultSession).catch(() => null);
    if (!t.pendingPopup || !this.targets.has(t.targetId)) return;
    const current = String(tree?.frameTree.frame.url ?? '');
    if (current !== committedUrl) return; // 그사이 다시 이동했다: 다음 커밋에서 판정
    const opener = t.openerId ? this.targets.get(t.openerId) : undefined;
    if (opener?.exposed && this.confirmedAllowed(current, opener.url)) {
      t.pendingPopup = false;
      await this.expose(t);
    } else {
      this.revokePopup(t);
    }
  }

  /** 보류 팝업 영구 거부(자식의 revokeChild와 같은 규칙): 비신뢰 origin을 거친 팝업은 허용 host로 와도 노출하지 않는다. */
  private revokePopup(t: TargetState): void {
    void this.revokeTarget(t, 'vault.popup_hidden');
  }

  /**
   * 타깃 영구 거부. 상태(revoked)를 먼저 단조롭게 기록하고(되돌리지 않음) 그 뒤에 세션을 분리한다.
   * 진행 중인 expose()·attachEngine()은 await마다 이 표시를 다시 보고 중단한다.
   */
  private async revokeTarget(t: TargetState, code: 'vault.popup_hidden' | 'vault.origin_left'): Promise<void> {
    const first = !t.revoked;
    t.revoked = true;
    t.pendingPopup = false;
    t.exposed = false;
    if (first) this.log.event(code, { target: t.targetId.slice(0, 8) });
    const sid = t.engineSession;
    if (sid) await this.conn.send('Target.detachFromTarget', { sessionId: sid }).catch(() => {});
  }

  /** 노출 후보(노출 중·노출 진행 중·보류 팝업)의 메인 프레임 판정. page 타깃의 메인 프레임 ID는 타깃 ID와 같다. */
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
      if (t.revoked) return; // await 사이에 거부됨
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
    // 모든 await 뒤 마지막 확인: 거부된 타깃의 부착을 엔진에 알리지 않는다.
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
      if (t.win && frame.id === t.win.frameId) this.endWindow(t, 'commit');
    } else if (msg.method === 'Page.frameStartedNavigating') {
      // 커밋 전에 막는다: 메인 프레임이 허용 밖으로 이동을 시작하면 노출 타깃은 엔진 세션을 분리하고,
      // 보류 팝업은 영구 거부한다(서버 리디렉션으로 허용 host에 커밋돼도 노출하지 않는다).
      const offsite = !urlAllowed(String(p.url ?? ''), this.policy.allowedHosts);
      if (offsite && this.isMainFrame(t, p.frameId)) {
        if (t.pendingPopup) this.revokePopup(t);
        else if (t.exposed || t.exposing) void this.originLeft(t);
      }
    } else if (msg.method === 'Page.frameDetached') {
      if (t.win && p.frameId === t.win.frameId) this.endWindow(t, 'detached');
    }
  }

  /** origin 재집행(D05 §3.3): 노출 타깃이 허용 밖으로 나가면 엔진 세션을 분리한다. */
  private async originLeft(t: TargetState): Promise<void> {
    await this.revokeTarget(t, 'vault.origin_left');
  }

  private enqueue(produce: () => Promise<CdpMessage | null>): void {
    this.outQ = this.outQ.then(async () => {
      let out: CdpMessage | null;
      try {
        out = await produce();
      } catch {
        out = null;
      }
      if (!out) return;
      let raw = JSON.stringify(out);
      // 긴 변형부터 지운다(짧은 변형이 긴 변형의 일부를 먼저 깨지 않게). 적중한 타깃마다 한 번 알린다.
      const all = [...this.knownVariants].flatMap(([targetId, variants]) => variants.map((v) => [targetId, v] as const)).sort((a, b) => b[1].length - a[1].length);
      let total = 0;
      for (const [targetId, v] of all) {
        const r = scrubKnownValues(raw, [v]);
        if (!r.hits) continue;
        raw = r.text;
        total += r.hits;
        if (!this.leakNotified.has(targetId)) {
          this.leakNotified.add(targetId);
          this.onLeakSuspected?.(r.hits);
        }
      }
      if (total) this.log.event('vault.known_value_scrubbed', { hits: total });
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
    const p = (msg.params ?? {}) as Json;
    // 받은 시점과 지금 중 엄격한 쪽(오염 표시·요청 바디 제거가 커밋 처리 순서에 밀리지 않게).
    const now = this.stateOf(t);
    const st = { active: now.active || !!at?.active, tainted: now.tainted || !!at?.tainted };
    // 자식 세션의 이동 시작: 허용 밖이면 커밋 전에 그 자식만 분리한다.
    if (es.child && msg.method === 'Page.frameStartedNavigating') {
      if (p.frameId === es.childTargetId && !urlAllowed(String(p.url ?? ''), this.policy.allowedHosts)) {
        this.revokeChild(msg.sessionId!, es);
        return null;
      }
      return es.pending ? null : msg;
    }
    // 자식 세션(OOPIF)의 문서 커밋: 그 자식만 재검사·분리한다. 부모 page의 originLeft를 부르지 않는다.
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

  /** 부모 세션의 현재 URL(page는 타깃 URL, 자식은 자기 문서 URL). */
  private sessionUrl(sessionId: string | undefined): string {
    if (!sessionId) return '';
    const es = this.engineSessions.get(sessionId);
    if (!es) return '';
    return es.child ? (es.url ?? '') : (this.targets.get(es.targetId)?.url ?? '');
  }

  /** 자식 문서 URL 허용 여부. about:blank·빈 URL은 부모가 허용 origin일 때만. */
  private childUrlAllowed(url: string, parent: string | undefined): boolean {
    const parentOk = !!parent && this.engineSessions.has(parent) && urlAllowed(this.sessionUrl(parent), this.policy.allowedHosts);
    if (!parentOk) return false;
    if (url === '' || url === 'about:blank') return true;
    return urlAllowed(url, this.policy.allowedHosts);
  }

  /** 자식 세션과 그 자손만 엔진에서 떼어 낸다(부모 page는 유지). 엔진에는 분리 이벤트를 합성해 준다. */
  private revokeChild(sid: string, es: EngineSession): void {
    es.revoked = true; // 상태를 먼저 기록(단조), 분리는 그 뒤
    const drop = [sid];
    for (let i = 0; i < drop.length; i++) {
      for (const [k, v] of this.engineSessions) if (v.parent === drop[i] && !drop.includes(k)) drop.push(k);
    }
    for (const k of drop) this.engineSessions.delete(k);
    this.log.event(es.pending ? 'vault.child_hidden' : 'vault.child_origin_left', { count: drop.length });
    // 엔진이 몰랐던(보류 중) 자식이면 분리 이벤트를 만들지 않는다.
    if (!es.pending && es.parent && this.engineSessions.has(es.parent)) {
      this.enqueue(async () => ({ method: 'Target.detachedFromTarget', sessionId: es.parent, params: { sessionId: sid, targetId: es.childTargetId } }));
    }
    void this.conn.send('Target.detachFromTarget', { sessionId: sid }, es.parent).catch(() => {});
  }

  /** 보류 자식의 커밋: getFrameTree로 다시 확인해 허용이 확정될 때만 엔진에 부착을 알린다(fail-closed). */
  private async releasePendingChild(sid: string, es: EngineSession): Promise<CdpMessage | null> {
    if (!es.pending) return null;
    const tree = await this.conn.send<{ frameTree: { frame: Json } }>('Page.getFrameTree', {}, sid).catch(() => null);
    if (!es.pending || es.revoked || this.engineSessions.get(sid) !== es) return null;
    const current = String(tree?.frameTree.frame.url ?? '');
    if (current !== es.url) return null; // 다시 이동 중: 다음 커밋에서 판정
    if (!this.confirmedAllowed(current, this.sessionUrl(es.parent))) {
      this.revokeChild(sid, es);
      return null;
    }
    const attach = es.pending.attach;
    es.pending = undefined;
    const p = attach.params as Json;
    return { ...attach, params: { ...p, targetInfo: { ...(p.targetInfo as Json), url: current } } };
  }

  /** page 수준 자동 부착의 자식: 워커와 허용 origin iframe만 엔진에 넘긴다. 이후 이동은 금고가 감시한다. */
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
      // 엔진이 Page를 켜지 않아도 금고가 자식 문서 커밋을 볼 수 있게 한다(이벤트는 같은 세션으로 엔진에도 간다).
      await this.conn.send('Page.enable', {}, child).catch(() => {});
      if (url !== '' && url !== 'about:blank') return msg;
      // 부착 정보의 url이 비어도 이미 커밋된 문서가 있을 수 있다(실측: OOPIF는 커밋 뒤 부착). 자식 루트 프레임 URL을 직접 본다.
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
      // 목적지를 모른다(빈 URL, 또는 진행 중 이동 앞의 about:blank). 엔진에 알리지 않고 금고가 재개한 뒤
      // 문서 커밋 + getFrameTree로 허용이 확인될 때만 알린다. 시간이 지나도 노출하지 않는다(fail-closed).
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
      // 오염 상태(D05 §3.5, D-17(N-12)): 엔진의 objectId가 비밀 노드에서 왔는지 금고는 모른다(세션마다 다른 객체 ID).
      // 그래서 이 동안은 모든 응답에서 입력 값 속성(value·defaultValue)의 문자열을 지운다. 창은 다음 문서 커밋까지라 짧다.
      // RemoteObject는 문자열을 description에도 복사하므로 함께 지운다(보안카드 숫자는 짧아 알려진 값 치환에 안 걸린다).
      for (const prop of (result.result as Json[] | undefined) ?? []) {
        const v = prop?.value as Json | undefined;
        if (VALUE_PROPS.has(String(prop?.name)) && v && v.type === 'string') {
          v.value = '';
          if ('description' in v) v.description = '';
        }
      }
    } else if ((p.method === 'Network.getRequestPostData' || p.method === 'Fetch.getRequestPostData') && tainted) {
      // 보낼 때나 응답 도착 때 창이 있었으면 바디를 넘기지 않는다(두 메서드는 D05 거부·정책 검사가 같다).
      out.result = { postData: '' };
    }
    return out;
  }

  /** 정화용 비밀 노드: 지금 아는 것 ∪ 요청을 보낼 때·이벤트를 받을 때 알던 것(그사이 커밋으로 비워졌어도). */
  private secretsOf(t: TargetState, snap?: readonly number[]): SecretNodes {
    if (!snap?.length) return { backendIds: t.secretBackendIds };
    return { backendIds: new Set([...t.secretBackendIds, ...snap]) };
  }

  /** 접근성 응답은 속성이 없어 type=password를 알 수 없으므로, 금고 세션으로 password 노드를 다시 센다. */
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

  // ───────────────────────── 비밀 창(secret/ops.ts가 사용) ─────────────────────────

  send<T = Json>(method: string, params: Json, sessionId?: string): Promise<T> {
    return this.conn.send<T>(method, params, sessionId);
  }

  openWindow(t: TargetState, kind: SecretWindow['kind'], frameId: string, backendNodeId: number): void {
    t.win = { phase: 'active', kind, frameId };
    t.secretBackendIds.add(backendNodeId);
  }

  /** 활성 창 → 오염 상태(D05 §3.5 ②). */
  deactivateWindow(t: TargetState): void {
    if (t.win?.phase === 'active') {
      t.win.phase = 'tainted';
      for (const fn of this.onSecretWindowClosed) fn(t.targetId);
    }
  }

  /** 문서 커밋·노드 분리: 창 종료(활성이었다면 닫힘 알림도 보낸다). */
  endWindow(t: TargetState, _why: 'commit' | 'detached'): void {
    if (!t.win) return;
    const wasActive = t.win.phase === 'active';
    t.win = undefined;
    t.secretBackendIds.clear();
    // 그 창의 알려진 값은 버린다. 열린 창이 하나도 없으면 전부 버린다(N-78). 단 이미 줄에 선 엔진 메시지(커밋 직전의
    // 요청 바디 등)가 나간 뒤에 버린다: 커밋 이벤트는 금고 세션에서 바로 처리되고 엔진 쪽 정리는 줄 뒤에 돌기 때문이다.
    // 적중 알림은 창마다 한 번이므로 다음 창을 위해 바로 푼다.
    this.leakNotified.delete(t.targetId);
    const stale = this.knownVariants.get(t.targetId);
    this.enqueue(async () => {
      if (this.knownVariants.get(t.targetId) === stale) this.clearKnownSecrets(t.targetId);
      if (!this.hasOpenWindow()) this.clearKnownSecrets();
      return null;
    });
    if (wasActive) for (const fn of this.onSecretWindowClosed) fn(t.targetId);
  }

  addKnownSecret(targetId: string, variants: string[]): void {
    this.knownVariants.set(targetId, [...new Set([...(this.knownVariants.get(targetId) ?? []), ...variants])]);
  }

  /** targetId가 없으면 전부 지운다. */
  clearKnownSecrets(targetId?: string): void {
    if (targetId === undefined) {
      this.knownVariants.clear();
      this.leakNotified.clear();
    } else {
      this.knownVariants.delete(targetId);
      this.leakNotified.delete(targetId);
    }
  }

  /** 지금까지 줄에 선 엔진 메시지가 다 나갈 때까지(시험용). */
  drained(): Promise<void> {
    return this.outQ;
  }

  /** 시험·진단용: 지금 들고 있는 변형 수(값은 내보내지 않는다). */
  knownVariantCount(targetId?: string): number {
    if (targetId !== undefined) return this.knownVariants.get(targetId)?.length ?? 0;
    return [...this.knownVariants.values()].reduce((n, v) => n + v.length, 0);
  }

  /** 열린(활성·오염) 창이 있는 타깃이 있는가. */
  hasOpenWindow(): boolean {
    return [...this.targets.values()].some((t) => t.win);
  }

  exposedTarget(targetId: string): TargetState | undefined {
    const t = this.targets.get(targetId);
    return t?.exposed ? t : undefined;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
