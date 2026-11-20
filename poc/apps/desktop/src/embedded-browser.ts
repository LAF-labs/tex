import { randomUUID } from 'node:crypto';
import { app, session, WebContentsView, type App, type BaseWindow, type Rectangle, type Session, type WebContents } from 'electron';
import type { EventLog } from '@sax/platform';
import { CHROME_APP_START_URL } from '@sax/vault';
import { assertWebPrefs, NAV_EXEMPT_SESSIONS } from './harden.ts';

export const EMBEDDED_PARTITION = 'persist:sax-hometax';

type Json = Record<string, unknown>;
interface CdpFrame {
  id?: number;
  method?: string;
  params?: Json;
  result?: Json;
  error?: { code: number; message: string };
  sessionId?: string;
}

const SLOW_CMD_MS = 3000;
const WATCHED_CMD = /^(Input|DOM)\./;
const DIALOG_FALLBACK_MS = 60_000;

interface Tab {
  view: WebContentsView;
  wc: WebContents;
  targetId: string;
  openerId?: string;
  sessions: Set<string>;
  gone: boolean;
}

const PAGE_WIDTH = 1280;
const HIDDEN_BOUNDS: Rectangle = { x: 0, y: 0, width: PAGE_WIDTH, height: 900 };

const BLOCKED_SCHEMES = /^(file|chrome|chrome-extension|devtools|view-source|sax-[a-z]+):/i;

function chromeLikeUserAgent(fallback = app.userAgentFallback, chromeVersion = process.versions.chrome): string {
  const major = chromeVersion.split('.')[0];
  return fallback
    .split(' ')
    .filter((t) => !/^[A-Za-z][\w.-]*\/[\w.-]+$/.test(t) || /^(Mozilla|AppleWebKit|Chrome|Safari)\//.test(t))
    .join(' ')
    .replace(/Chrome\/[\d.]+/, `Chrome/${major}.0.0.0`);
}

export function keepDrawingWhenHidden(a: App = app): void {
  for (const s of ['disable-backgrounding-occluded-windows', 'disable-renderer-backgrounding', 'disable-background-timer-throttling']) a.commandLine.appendSwitch(s);
}

interface EmbeddedBrowserOptions {
  win: BaseWindow;
  post: (m: unknown) => void;
  log: EventLog;
  onPage?: (p: { url: string; title: string } | null) => void;
}

export class EmbeddedBrowser {
  private readonly o: EmbeddedBrowserOptions;
  private readonly ses: Session;
  private readonly tabs = new Map<string, Tab>();
  private readonly bySession = new Map<string, Tab>();
  private order: Tab[] = [];
  private autoAttach = false;
  private downloadBehavior: Json | null = null;
  private downloadHost: Tab | null = null;
  private readonly granted = new Map<string, Set<string>>();
  private readonly topSessions = new Set<string>();
  private readonly pdfStreams = new Map<string, { buf: Buffer; pos: number }>();
  private slot: Rectangle | null = null;
  private placed: Rectangle = HIDDEN_BOUNDS;
  private blocked = false;
  private connected = false;

  constructor(o: EmbeddedBrowserOptions) {
    this.o = o;
    this.ses = session.fromPartition(EMBEDDED_PARTITION);
    NAV_EXEMPT_SESSIONS.add(this.ses);
    this.ses.setUserAgent(chromeLikeUserAgent(), 'ko-KR,ko,en-US,en');
    this.ses.setPermissionRequestHandler((wc, permission, cb, details) => cb(this.allowed(permission, details.requestingUrl ?? wc.getURL())));
    this.ses.setPermissionCheckHandler((_wc, permission, origin) => this.allowed(permission, origin));
    this.ses.setDevicePermissionHandler(() => false);
    this.ses.setSpellCheckerEnabled(false);
    this.ses.on('will-download', (e, item) => {
      if (!item.getSavePath()) {
        e.preventDefault();
        this.o.log.event('main.embedded_download_refused');
      }
    });
    o.win.on('resize', () => this.place());
  }

  private allowed(permission: string, url: string): boolean {
    try {
      return this.granted.get(new URL(url).origin)?.has(permission) === true;
    } catch {
      return false;
    }
  }

  feed(raw: unknown): void {
    const m = raw as { t?: unknown; m?: unknown } | null;
    if (m?.t === 'cdp_closed') return void this.closeAll('vault');
    if (m?.t !== 'cdp' || typeof m.m !== 'string') return;
    let msg: CdpFrame;
    try {
      msg = JSON.parse(m.m) as CdpFrame;
    } catch {
      return;
    }
    if (typeof msg.id !== 'number' || typeof msg.method !== 'string') return;
    this.connected = true;
    const done = (p: Promise<Json>) =>
      void p.then(
        (result) => this.toVault({ id: msg.id, result, ...(msg.sessionId ? { sessionId: msg.sessionId } : {}) }),
        (e: Error) => this.toVault({ id: msg.id, error: { code: -32000, message: String(e?.message ?? e).slice(0, 300) }, ...(msg.sessionId ? { sessionId: msg.sessionId } : {}) }),
      );
    if (msg.sessionId) {
      const t = this.bySession.get(msg.sessionId);
      if (!t || t.gone) return done(Promise.reject(new Error(`No session with given id`)));
      return done(this.watch(t, msg.method, this.session(t, msg.sessionId, msg.method, msg.params ?? {}) ?? (t.wc.debugger.sendCommand(msg.method, msg.params ?? {}, msg.sessionId) as Promise<Json>)));
    }
    done(this.root(msg.method, msg.params ?? {}));
  }

  private watch(t: Tab, method: string, p: Promise<Json>): Promise<Json> {
    if (!WATCHED_CMD.test(method)) return p;
    const t0 = Date.now();
    let slow = false;
    const timer = setTimeout(() => {
      slow = true;
      const w = this.o.win;
      this.o.log.event('main.embedded_cmd_slow', { method, top: this.top() === t, shown: this.shown(t), win: w.isVisible(), focused: w.isFocused(), minimized: w.isMinimized() });
    }, SLOW_CMD_MS);
    const end = () => {
      clearTimeout(timer);
      if (slow) this.o.log.event('main.embedded_cmd_done', { method, ms: Date.now() - t0 });
    };
    p.then(end, end);
    return p;
  }

  private async root(method: string, p: Json): Promise<Json> {
    switch (method) {
      case 'Browser.getVersion':
        return { protocolVersion: '1.3', product: `Chrome/${process.versions.chrome}`, revision: '', userAgent: this.ses.getUserAgent(), jsVersion: process.versions.v8 };
      case 'Target.setDiscoverTargets':
        return {};
      case 'Target.setAutoAttach': {
        this.autoAttach = true;
        if (!this.order.length) await this.openTab(CHROME_APP_START_URL);
        for (const t of this.order) await this.announce(t);
        return {};
      }
      case 'Target.createTarget': {
        const t = await this.openTab(String(p.url ?? 'about:blank'));
        return { targetId: t.targetId };
      }
      case 'Target.attachToTarget': {
        const t = this.tabs.get(String(p.targetId));
        if (!t || t.gone) throw new Error('No target with given id found');
        const r = (await t.wc.debugger.sendCommand('Target.attachToTarget', { targetId: t.targetId, flatten: true })) as { sessionId: string };
        this.own(t, r.sessionId);
        this.topSessions.add(r.sessionId);
        return r;
      }
      case 'Target.detachFromTarget': {
        const sid = String(p.sessionId);
        const t = this.bySession.get(sid);
        if (!t) throw new Error('No session with given id');
        this.bySession.delete(sid);
        this.topSessions.delete(sid);
        t.sessions.delete(sid);
        if (!t.gone) await t.wc.debugger.sendCommand('Target.detachFromTarget', { sessionId: sid }).catch(() => {});
        this.toVault({ method: 'Target.detachedFromTarget', params: { sessionId: sid, targetId: t.targetId } });
        return {};
      }
      case 'Target.getTargetInfo': {
        const t = this.tabs.get(String(p.targetId));
        if (!t || t.gone) throw new Error('No target with given id found');
        return { targetInfo: await this.info(t) };
      }
      case 'Target.closeTarget': {
        const t = this.tabs.get(String(p.targetId));
        if (!t || t.gone) throw new Error('No target with given id found');
        this.drop(t);
        return { success: true };
      }
      case 'Target.activateTarget':
        return {};
      case 'Browser.setPermission': {
        const name = String((p.permission as Json | undefined)?.name ?? '');
        const origin = String(p.origin ?? '');
        if (!name || !/^https:\/\/[^/]+$/.test(origin) || p.setting !== 'granted') throw new Error('unsupported permission');
        if (!this.granted.has(origin)) this.granted.set(origin, new Set());
        this.granted.get(origin)!.add(name);
        return {};
      }
      case 'Browser.setDownloadBehavior':
        this.downloadBehavior = p;
        await this.hostDownloads();
        return {};
      case 'Browser.cancelDownload':
        if (this.downloadHost && !this.downloadHost.gone) await this.downloadHost.wc.debugger.sendCommand('Browser.cancelDownload', p).catch(() => {});
        return {};
      case 'Browser.getWindowForTarget':
        return { windowId: 1, bounds: { left: 0, top: 0, width: 0, height: 0, windowState: 'normal' } };
      case 'Browser.setWindowBounds':
        return {};
      case 'Browser.close':
        setImmediate(() => this.closeAll('vault'));
        return {};
    }
    throw new Error(`'${method}' wasn't found`);
  }

  private toVault(m: CdpFrame): void {
    this.o.post({ t: 'cdp', m: JSON.stringify(m) });
  }

  private async openTab(url: string, adopt?: WebContents, openerId?: string): Promise<Tab> {
    const view = new WebContentsView({ ...(adopt ? { webContents: adopt } : {}), webPreferences: { partition: EMBEDDED_PARTITION, sandbox: true, contextIsolation: true, nodeIntegration: false, webviewTag: false, spellcheck: false } });
    const wc = view.webContents;
    try {
      assertWebPrefs(wc);
    } catch (e) {
      wc.close();
      throw e;
    }
    this.policy(wc);
    this.quietDialogs(wc);
    wc.setBackgroundThrottling(false);
    wc.debugger.attach('1.3');
    const loaded = adopt ? Promise.resolve() : wc.loadURL(url).catch(() => {});
    const { targetInfo } = (await wc.debugger.sendCommand('Target.getTargetInfo')) as { targetInfo: { targetId: string } };
    const t: Tab = { view, wc, targetId: targetInfo.targetId, openerId, sessions: new Set(), gone: false };
    this.tabs.set(t.targetId, t);
    this.order.push(t);
    wc.debugger.on('message', (_e, method: string, params: Json, sessionId?: string) => this.fromTab(t, method, params, sessionId));
    wc.debugger.on('detach', () => this.drop(t));
    wc.once('destroyed', () => this.drop(t));
    await wc.debugger.sendCommand('Emulation.setAutomationOverride', { enabled: true });
    await wc.debugger.sendCommand('Target.setDiscoverTargets', { discover: true });
    this.o.win.contentView.addChildView(view, 0);
    this.layout();
    if (this.downloadBehavior && !this.downloadHost) await this.hostDownloads();
    await loaded;
    if (this.autoAttach) await this.announce(t);
    this.o.log.event('main.embedded_tab_opened', { popup: !!openerId });
    return t;
  }

  private async announce(t: Tab): Promise<void> {
    if (t.gone || [...this.bySession.values()].includes(t)) return;
    const { sessionId } = (await t.wc.debugger.sendCommand('Target.attachToTarget', { targetId: t.targetId, flatten: true })) as { sessionId: string };
    this.own(t, sessionId);
    this.topSessions.add(sessionId);
    this.toVault({ method: 'Target.attachedToTarget', params: { sessionId, targetInfo: { ...(await this.info(t)), attached: true }, waitingForDebugger: false } });
  }

  private session(t: Tab, sid: string, method: string, p: Json): Promise<Json> | null {
    if (method === 'Page.printToPDF') {
      if (!this.topSessions.has(sid)) return Promise.reject(new Error("'Page.printToPDF' wasn't found"));
      return (async () => {
        const buf = await t.wc.printToPDF({
          landscape: p.landscape === true,
          printBackground: p.printBackground === true,
          preferCSSPageSize: p.preferCSSPageSize === true,
          ...(typeof p.scale === 'number' ? { scale: p.scale } : {}),
          ...(typeof p.pageRanges === 'string' && p.pageRanges ? { pageRanges: p.pageRanges } : {}),
        });
        if (p.transferMode !== 'ReturnAsStream') return { data: buf.toString('base64') };
        const handle = `embedded-pdf-${randomUUID()}`;
        this.pdfStreams.set(handle, { buf, pos: 0 });
        return { stream: handle };
      })();
    }
    const handle = String(p.handle ?? '');
    const st = this.pdfStreams.get(handle);
    if (!st || (method !== 'IO.read' && method !== 'IO.close')) return null;
    if (method === 'IO.close') {
      this.pdfStreams.delete(handle);
      return Promise.resolve({});
    }
    const size = Math.max(1, Math.min(Number(p.size) || 65_536, 1 << 20));
    const chunk = st.buf.subarray(st.pos, st.pos + size);
    st.pos += chunk.length;
    return Promise.resolve({ data: chunk.toString('base64'), base64Encoded: true, eof: st.pos >= st.buf.length });
  }

  private async info(t: Tab): Promise<Json> {
    const { targetInfo } = (await t.wc.debugger.sendCommand('Target.getTargetInfo', { targetId: t.targetId })) as { targetInfo: Json };
    return { ...targetInfo, ...(t.openerId && !targetInfo.openerId ? { openerId: t.openerId } : {}) };
  }

  private own(t: Tab, sessionId: string): void {
    t.sessions.add(sessionId);
    this.bySession.set(sessionId, t);
  }

  private fromTab(t: Tab, method: string, params: Json, sessionId?: string): void {
    if (sessionId) {
      if (!t.sessions.has(sessionId) && !this.bySession.has(sessionId)) return;
      if (method === 'Target.attachedToTarget') this.own(t, String(params.sessionId));
      if (method === 'Target.detachedFromTarget') {
        this.bySession.delete(String(params.sessionId));
        t.sessions.delete(String(params.sessionId));
      }
      this.toVault({ method, params, sessionId });
      return;
    }
    if (method === 'Target.targetInfoChanged') {
      const info = params.targetInfo as Json;
      if (info?.targetId !== t.targetId) return;
      this.toVault({ method, params: { targetInfo: { ...info, ...(t.openerId && !info.openerId ? { openerId: t.openerId } : {}) } } });
      if (this.top() === t) this.o.onPage?.({ url: String(info.url ?? ''), title: String(info.title ?? '') });
    } else if (method === 'Target.detachedFromTarget' && t.sessions.has(String(params.sessionId))) {
      this.bySession.delete(String(params.sessionId));
      t.sessions.delete(String(params.sessionId));
      this.toVault({ method, params });
    } else if (method.startsWith('Browser.download') && t === this.downloadHost) {
      this.toVault({ method, params });
    }
  }

  private async hostDownloads(): Promise<void> {
    if (!this.downloadBehavior) return;
    const host = this.order.find((x) => !x.gone) ?? null;
    this.downloadHost = host;
    if (host) await host.wc.debugger.sendCommand('Browser.setDownloadBehavior', this.downloadBehavior).catch(() => {});
  }

  private quietDialogs(wc: WebContents): void {
    const ev = wc as unknown as NodeJS.EventEmitter;
    ev.removeAllListeners('-run-dialog');
    const timers = new Set<ReturnType<typeof setTimeout>>();
    ev.on('-run-dialog', (info: { dialogType?: unknown } | null, callback: (ok: boolean, input: string) => void) => {
      const type = String(info?.dialogType ?? '');
      this.o.log.event('main.embedded_dialog', { type });
      const timer = setTimeout(() => {
        timers.delete(timer);
        callback(type === 'alert', '');
      }, DIALOG_FALLBACK_MS);
      timers.add(timer);
    });
    const clear = () => {
      for (const x of timers) clearTimeout(x);
      timers.clear();
    };
    ev.on('-cancel-dialogs', clear);
    wc.once('destroyed', clear);
  }

  private policy(wc: WebContents): void {
    const guard = (e: { url: string; preventDefault(): void }) => {
      if (BLOCKED_SCHEMES.test(e.url)) {
        e.preventDefault();
        this.o.log.event('main.embedded_nav_blocked', { scheme: e.url.split(':')[0]!.slice(0, 20) });
      }
    };
    wc.on('will-navigate', guard);
    wc.on('will-frame-navigate', guard);
    wc.on('will-redirect', guard);
    wc.on('will-attach-webview', (e) => e.preventDefault());
    wc.on('did-navigate', () => wc.setZoomFactor(this.zoom()));
    wc.on('before-input-event', (e) => {
      if (this.blocked) e.preventDefault();
    });
    wc.on('before-mouse-event', (e) => {
      if (this.blocked) e.preventDefault();
    });
    wc.setWindowOpenHandler(({ url }) => {
      if (!/^(https?:|about:blank)/i.test(url)) return { action: 'deny' };
      if (SESSION_OUT_POPUP.test(url)) {
        void wc
          .executeJavaScript(HOMETAX_EXTEND_JS, true)
          .then((r: unknown) => this.o.log.event('main.hometax_session_popup', { result: String(r).slice(0, 20) }))
          .catch(() => this.o.log.event('main.hometax_session_popup', { result: 'error' }));
        return { action: 'deny' };
      }
      const opener = [...this.tabs.values()].find((x) => x.wc === wc);
      return {
        action: 'allow',
        createWindow: (options) => {
          const guest = (options as { webContents?: WebContents }).webContents;
          if (!guest) throw new Error('no guest webContents');
          void this.openTab(url, guest, opener?.targetId).catch((e: Error) => this.o.log.event('main.embedded_popup_failed', { error: e.message.slice(0, 120) }));
          return guest;
        },
      };
    });
  }

  private top(): Tab | undefined {
    return this.order.filter((x) => !x.gone).at(-1);
  }

  private drop(t: Tab): void {
    if (t.gone) return;
    t.gone = true;
    this.tabs.delete(t.targetId);
    this.order = this.order.filter((x) => x !== t);
    for (const sid of t.sessions) {
      this.bySession.delete(sid);
      this.topSessions.delete(sid);
      if (this.connected) this.toVault({ method: 'Target.detachedFromTarget', params: { sessionId: sid, targetId: t.targetId } });
    }
    t.sessions.clear();
    if (this.connected) this.toVault({ method: 'Target.targetDestroyed', params: { targetId: t.targetId } });
    try {
      this.o.win.contentView.removeChildView(t.view);
    } catch {
      // 창이 먼저 닫혔다
    }
    if (!t.wc.isDestroyed()) {
      try {
        t.wc.debugger.detach();
      } catch {
        // 이미 떨어졌다
      }
      t.wc.close();
    }
    if (this.downloadHost === t) void this.hostDownloads();
    this.layout();
  }

  closeAll(why: 'vault' | 'window'): void {
    const wasConnected = this.connected;
    this.connected = false;
    for (const t of [...this.order]) this.drop(t);
    this.autoAttach = false;
    this.downloadHost = null;
    this.downloadBehavior = null;
    this.granted.clear();
    this.pdfStreams.clear();
    this.setBlocked(false);
    if (why === 'window' && wasConnected) this.o.post({ t: 'cdp_closed' });
    this.o.onPage?.(null);
  }

  setSlot(r: Rectangle | null): void {
    this.slot = r;
    this.layout();
  }

  private zoom(): number {
    return Math.min(1, this.placed.width / PAGE_WIDTH);
  }

  private layout(): void {
    this.place();
    const top = this.top();
    if (top) this.o.onPage?.({ url: top.wc.getURL(), title: top.wc.getTitle() });
  }

  private shown(t: Tab): boolean {
    return t === this.top() && this.slot !== null;
  }

  private place(): void {
    if (this.o.win.isDestroyed()) return;
    if (this.slot) this.placed = this.slot;
    const zoom = this.zoom();
    const [cw, ch] = this.o.win.getContentSize() as [number, number];
    this.order.forEach((t, k) => {
      if (t.gone) return;
      t.view.setBounds(this.shown(t) ? this.placed : { x: Math.max(0, cw - 1 - k), y: Math.max(0, ch - 1), width: this.placed.width, height: this.placed.height });
      if (Math.abs(t.wc.getZoomFactor() - zoom) > 0.001) t.wc.setZoomFactor(zoom);
      t.view.setVisible(true);
    });
  }

  setBlocked(on: boolean): void {
    this.blocked = on;
  }

  focus(): void {
    this.top()?.wc.focus();
  }

  get hasPage(): boolean {
    return this.order.length > 0;
  }

  async keepSession(): Promise<'extended' | 'idle' | 'none'> {
    const tabs = this.order.filter((t) => !t.gone && /^https:\/\/([a-z0-9-]+\.)*hometax\.go\.kr\//i.test(t.wc.getURL()));
    if (!tabs.length) return 'none';
    const out = await Promise.all(tabs.map((t) => t.wc.executeJavaScript(HOMETAX_EXTEND_JS, true).catch(() => 'error')));
    return out.includes('extended') ? 'extended' : 'idle';
  }
}

const SESSION_OUT_POPUP = /UTXPPABB27/;

const HOMETAX_EXTEND_JS = `(() => { try {
  const w = window;
  if (typeof w.sessionTimer !== 'function' || !w.$c || !w.$c.pp || typeof w.$c.pp.sessionXtn !== 'function') return 'no_timer';
  if (w.sessiontimerEndFnc == null) return 'idle';
  if (String(w.top.location.href).indexOf('UTXPPADA01') > -1 && typeof w.top.fn_smpcSessionXtn === 'function') w.top.fn_smpcSessionXtn();
  else w.$c.pp.sessionXtn(w.$p);
  for (const id of ['errLayer1', 'errLayer2']) { const el = document.getElementById(id); if (el) el.remove(); }
  w.sessionTimer('Y');
  return 'extended';
} catch (e) { return 'error'; } })()`;
