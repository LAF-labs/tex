import { randomBytes, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import type { Counterparty as DbCounterparty, PortalProfileKey, Profile as DbProfile } from '@sax/db';
import type { Vat } from '@sax/chat-core';
import type { EnginePortal } from '@sax/engine/protocol';
import type { Channel, Revocation, TrustRoot } from '@sax/updater';
import type { Egress } from '@sax/net';
import { makeShareKeyBody, shareEpoch, wsRelayClient, type DesktopKeys, type DesktopPairResult, type PaperInvoice, type RelayClient } from '@sax/remote';
import { appPaths, defaultAppRoot, FileEventLog } from '@sax/platform';
import { findInstalledChrome, pageAddress, SESSION_IDLE_REPORT_MS } from '@sax/vault';
import { execFile } from 'node:child_process';
import { app, autoUpdater as nativeUpdater, BrowserWindow, clipboard, dialog, ipcMain, Menu, Notification, powerMonitor, powerSaveBlocker, protocol, safeStorage, screen, session, ShareMenu, shell as desktop } from 'electron';
import { deviceModel } from './device-model.ts';
import { runVersion } from './run-version.ts';
import { AccountantPack, isPackMonth, packAsk } from './accountant-pack.ts';
import { ACTION_TEXT, actionText, issueLocalApproval, kstToday, verifyLocalApproval, verifyLocalAttestation, type LocalApproval } from './approval-gate.ts';
import { CERT_DOCS_SHOWN, certDocByCode, certInputsFor, type CertDocDef } from './cert-docs.ts';
import { buildBoard, type Board, type BoardInput, type IssuedInvoice } from './board.ts';
import { BankHost, bankShellHandlers, type PickKind } from './bank-host.ts';
import { CONSENT_CONFIG, OnboardingFlow, onboardingTodos, type BizFields } from './onboarding.ts';
import { EngineOnboardingStore, onboardingPorts, type OnboardingExternal } from './onboarding-store.ts';
import { listNpkiCerts } from './npki-certs.ts';
import { openBillingCheckout, openExternalKey } from './external-links.ts';
import { CLOUD_ORIGIN } from '@sax/net';
import { securityBlocks, securityStatus, startSecurityProgram, type SecurityStatus } from './security-programs.ts';
import { APPROVAL_SCHEME, ApprovalBar } from './approval-bar.ts';
import { startDaemonHost, type DaemonHost, type ShowNotification } from './daemon-host.ts';
import { startUpdateHost, updatePolicy, type UpdateHost } from './update-host.ts';
import type { AppUpdaterLike, ProviderBase } from './update-electron.ts';
import { certInfoInSandbox, DOCPARSE_SCHEME, ocrImageInSandbox, parsePdfInSandbox, readSheetInSandbox } from './docparse.ts';
import { EngineHost } from './engine-host.ts';
import type { FixtureMode } from './fixture-mode.ts';
import { GestureClock, isGestureKey, isTypingKey, RateWindow } from './gesture.ts';
import { appHeaders, assertNoDebugSwitches, hardenApp, hardenSession, hardenWindow, SECRET_CSP } from './harden.ts';
import { dispatchShell, IPC, type ShellEvent, type ShellHandlers } from './ipc.ts';
import { SECRET_LABELS, SecretWindowCoordinator, type SecretInputBind as OneShotInputBind } from './secret-labels.ts';
import { openVaultInputWindow } from './secret-window.ts';
import { bankAutoHandlers, CODEF_WINDOW_TITLE, codefPageHtml, parseCodefNeeded, type CodefNeeded } from './bank-auto.ts';
import { barBounds, browserPanelWidth, SHELL, WINDOW_MIN } from './shell-layout.ts';
import { EmbeddedBrowser, keepDrawingWhenHidden } from './embedded-browser.ts';
import { engineIntentResolver, INTENT_UNAVAILABLE_TEXT, MODEL_CONSENT_FIRST_TEXT, routed, type IntentResolver } from './intent-route.ts';
import { CHAT_ERROR_TEXT, engineChatResponder, suggestChips, type ChatResponder } from './chat-reply.ts';
import { answersPending, emptyDocStore, NO_AUTH, SETUP_LABEL, setupMissing, setupText, type SetupItem, SIGN_LABEL, interpret, parseRegex, QUICK, REMINDER_DAY_DEFAULT, sentFromGateway, type Counterparty, type DocStore, type G24Doc, type Parsed, type Profile, type RunView, type SentTo, EMPTY_REQUEST_TEXT } from './shell-model.ts';
import { engineDocsProvider, type DocsProvider } from './shell-docs.ts';
import { readPastRuns, type PastRun } from './run-history.ts';
import { pendingWork, RunResumeStore } from './run-resume.ts';
import { BATCH_AUTO_NOTE, BATCH_CHANGED_NOTE, fatalText, REHEARSAL, ShellRuns, vaultNotice, QUEUED_NOTE, REPLACED_NOTE, REPLACING_NOTE } from './shell-runs.ts';
import { AgentChat, type AgentPhase } from './agent-chat.ts';
import { agentPorts } from './agent-wiring.ts';
import type { StepParams, StepResult } from '@sax/engine';
import { bundleCss, tokensCss } from './shell-tokens.ts';
import { cancelPick, importPdf, pickFileBytes } from './vault-import.ts';
import { readBizCert, type BizCertReadPorts } from './bizcert-read.ts';
import { CounterpartyBook } from './counterparty-book.ts';
import { nameMissing, ProfileEditLog, ProfileEditor } from './profile-edit.ts';
import { DesktopAccount, PendingCodeFile, RemoteIdentityFile, type AccountView } from './remote-account.ts';
import { GatewayAuthHost } from './gateway-auth.ts';
import { IssueLockHost } from './issue-lock-host.ts';
import type { AccountClient, BillingView, CloudPorts, DeviceAuth, PcLinkVault, VaultKeysFactory } from './remote-ports.ts';
import { PairingHost, type PairView } from './remote-pairing.ts';
import { buildPhoneCopy } from './phone-copy.ts';
import { ApprovalLog, PhoneGate } from './phone-gate.ts';
import { PhoneWaker } from './phone-wake.ts';
import { CmdLog, PhoneIssue } from './phone-issue.ts';
import { DESKTOP_CAPS, PhoneLink, PhoneStore, type PhoneView, type TokenSeal } from './phone-link.ts';
import { APPROVE_CAPS, phoneSession, SESSION_CAPS } from './phone-session.ts';
import { DeviceManager, type DeviceView } from './remote-devices.ts';
import { engineShareStore, ShareSync } from './share-sync.ts';
import { PcLinkHost } from './remote-pclink.ts';
import { phoneReceiver } from './phone-receive.ts';
import { closeAction, shouldStartPhones, shouldStayAwake, StayAwake } from './phone-presence.ts';
import type { VaultDesktopKeys } from './remote-keys.ts';
import { qrSvgDataUrl } from './remote-qr.ts';
import type { DemoModel, mergeParsed } from './demo-model.ts';
import type { DemoSeed, startDemoSeed } from './demo-seed.ts';

const STATIC = path.join(import.meta.dirname, '../static');
const SHELL_SCHEME = 'sax-shell';
const NO_BUSINESS: Profile = { kind: 'business', name: '내 사업장', email: '', auth: '' };

const NO_PERSONAL: Profile = { kind: 'personal', name: '개인', email: '', auth: '', placeholder: true };
const SHELL_URL = `${SHELL_SCHEME}://shell/shell.html`;

export function registerShellSchemes(): void {
  hardenApp(app, [`${SHELL_SCHEME}:`, `${APPROVAL_SCHEME}:`, `${DOCPARSE_SCHEME}:`]);
  keepDrawingWhenHidden(app);
  protocol.registerSchemesAsPrivileged([
    { scheme: SHELL_SCHEME, privileges: { standard: true, secure: true } },
    { scheme: APPROVAL_SCHEME, privileges: { standard: true, secure: true } },
    { scheme: DOCPARSE_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true } },
  ]);
}

const DOC_CODES = new Set([
  'bad_request', 'busy', 'profile_required', 'not_pdf', 'input_size', 'read_failed', 'invalid_pdf', 'timeout', 'memory_limit', 'session_failed', 'renderer_gone',
  'pick_expired', 'password_too_long', 'schema', 'issued_in_future', 'expires_before_issued', 'expires_after_legal_max', 'invalid_issued_on', 'invalid_expires_on',
  'not_found', 'invalid_doc_type', 'file_missing', 'open_failed', 'seen_required', 'stale',
  'worker_failed', 'parse_failed', 'render_failed', 'ocr_failed', 'bad_extract',
  'gesture_required', 'throttled', 'pick_password_tries',
]);

function docsError(e: unknown): Error {
  const code = (e as { code?: unknown }).code ?? (e as Error).message;
  if (typeof code === 'string' && DOC_CODES.has(code)) return new Error(code);
  console.error('docs failed', typeof code === 'string' ? code.split(':')[0] : (e as Error).name);
  return new Error('failed');
}

const FILES: Record<string, string> = {
  '/shell.html': 'text/html; charset=utf-8',
  '/shell.css': 'text/css',
  '/shell.js': 'text/javascript',
  '/shell-views.js': 'text/javascript',
  '/fields.js': 'text/javascript',
  '/shell-g24.js': 'text/javascript',
  '/shell-onboarding.js': 'text/javascript',
  '/shell-account.js': 'text/javascript',
  '/shell-biz.js': 'text/javascript',
  '/shell-bank.js': 'text/javascript',
  '/shell-billing.js': 'text/javascript',
  '/shell-devices.js': 'text/javascript',
  '/shell-pack.js': 'text/javascript',
  '/password-rules.js': 'text/javascript',
  '/common-passwords.js': 'text/javascript',
  '/shell-pair.js': 'text/javascript',
  '/secret.css': 'text/css',
  '/codef-secret.js': 'text/javascript',
  '/shell-bank-auto.js': 'text/javascript',
};

let codefPage: () => string | null = () => null;

function serve(): void {
  protocol.handle(SHELL_SCHEME, async (req) => {
    const p = new URL(req.url).pathname;
    if (p === '/tokens.css') return new Response(tokensCss(), { headers: appHeaders('text/css') });
    if (p === '/codef-secret.html') {
      const html = codefPage();
      return html ? new Response(html, { headers: appHeaders('text/html; charset=utf-8', SECRET_CSP) }) : new Response('', { status: 404 });
    }
    if (p === '/bundle.css') return new Response(bundleCss(), { headers: appHeaders('text/css') });
    const type = FILES[p];
    if (!type) return new Response('', { status: 404 });
    return new Response(await fs.readFile(path.join(STATIC, 'shell', p.slice(1))), { headers: appHeaders(type) });
  });
  session.defaultSession.webRequest.onBeforeRequest((d, cb) => cb({ cancel: !d.url.startsWith(`${SHELL_SCHEME}://`) && !d.url.startsWith('devtools://') }));
  hardenSession(session.defaultSession);
}

export interface ShellOptions {
  daemon?: boolean;
  width?: number;
  height?: number;
  show?: boolean;
  engine?: { root?: string; portal: EnginePortal };
  headful?: boolean;
  docs?: DocsProvider;
  preparePerMin?: number;
  chromeReady?: () => boolean;
  externalChrome?: boolean;
  billingOpen?: (url: string, accountOrigin: string) => Promise<void>;
  security?: { status(): SecurityStatus; install?(key: string): Promise<void>; start?(): boolean };
  demoModel?: DemoModel | null;
  demoSeed?: boolean;
  dev?: ShellDev;
  buildBadges?: string[];
  onboarding?: boolean;
  update?: UpdateWiring;
  remote?: RemoteWiring;
  bankPick?: (kind: PickKind) => Promise<Uint8Array | null>;
  intent?: IntentResolver;
  chat?: ChatResponder;
  agent?: {
    step(p: StepParams): Promise<StepResult>;
    route?(p: Record<string, unknown>): Promise<unknown>;
    history?(p: Record<string, unknown>): Promise<unknown>;
  };
}

const CHAT_REACTIONS_ON = true;

export interface RemoteWiring {
  cloud: CloudPorts | null;
  keys: VaultKeysFactory | null;
  deviceName?: string;
  relayClient?: RelayClient;
  pairing?: boolean;
}

export interface UpdateWiring {
  channel: Channel;
  origin: string;
  egress: Pick<Egress, 'getRegistry' | 'getRegistryBytes'>;
  trust?: TrustRoot;
  loopback?: boolean;
  relaunch?: boolean;
  testBuild: boolean;
  setting?: { requireTransparency?: unknown } | null;
  updater?: AppUpdaterLike;
}

export interface ShellDev {
  startFixture(opts: { headful?: boolean }): Promise<FixtureMode>;
  startDemoSeed: typeof startDemoSeed;
  mergeParsed: typeof mergeParsed;
  sample: ShellSample;
}

interface ShellSample {
  store(): DocStore;
  profiles: Record<Profile['kind'], Profile>;
  timeline(): unknown[];
  quick: typeof QUICK;
  bundle(today: string): BoardInput['bundle'];
  settings: { reminderDay: number; cardFetchedOn: string | null };
  g24Candidates(doc: G24Doc, startedAt: number): Array<{ id: string; name: string; size: string; at: string }>;
  onboarding(): OnboardingExternal;
  cpCert: BizFields;
}

export interface Shell {
  win: BrowserWindow;
  bar: ApprovalBar;
  runs: ShellRuns;
  store: DocStore;
  host: EngineHost;
  fixture: FixtureMode | null;
  ready: Promise<void>;
  methods: string[];
  secretAsk(): { reqId: string; kind: string; runId: string } | null;
  close(): Promise<void>;
}


const SHELL_BIZ_KEY: Record<PortalProfileKey, NonNullable<Profile['fromHometax']>[number]> = { displayName: 'name', repName: 'rep', bizType: 'bizType', bizItem: 'bizItem', address: 'address', email: 'email' };

function profileView(p: DbProfile): Profile {
  const unnamed = p.kind === 'business' && nameMissing(p);
  const fromHometax = p.fromPortal.map((k) => SHELL_BIZ_KEY[k]);
  return { kind: p.kind, name: unnamed ? NO_BUSINESS.name : p.displayName, ...(unnamed ? { nameMissing: true } : {}), ...(fromHometax.length ? { fromHometax } : {}), bizNo: p.bizNo ?? undefined, rep: p.repName ?? undefined, bizType: p.bizType ?? undefined, bizItem: p.bizItem ?? undefined, address: p.address ?? undefined, email: p.email ?? '', auth: p.signMethod ? SIGN_LABEL[p.signMethod] : NO_AUTH };
}

function counterpartyView(c: DbCounterparty, items: Record<string, string>, saved?: string): Counterparty {
  return {
    id: c.id,
    name: c.name,
    bizNo: c.bizNo,
    rep: c.repName ?? '',
    email: c.email ?? '',
    item: saved || (items[c.bizNo] ?? ''),
    status: c.verifiedStatus ?? '확인 전',
    checkedOn: c.verifiedAt?.slice(0, 10) ?? '',
    lastIssuedOn: c.lastUsedAt?.slice(0, 10) ?? null,
  };
}

export async function startShell(opts: ShellOptions = {}): Promise<Shell> {
  assertNoDebugSwitches(app);
  serve();
  const key = new Uint8Array(randomBytes(32));
  const store: DocStore = opts.engine ? emptyDocStore() : opts.dev!.sample.store();
  if (!opts.engine && !opts.dev) throw new Error('shell.no_portal');
  const fixture = opts.engine ? null : await opts.dev!.startFixture({ headful: opts.headful });
  const made: { host?: EngineHost } = {};
  try {
    return wireShell(opts, fixture, key, store, made);
  } catch (e) {
    await made.host?.shutdown().catch(() => {});
    await fixture?.close().catch(() => {});
    throw e;
  }
}

const LINK_POLL_MS = 4_000;
const REVERIFY_WAIT_NOTE = '지난 발급을 홈택스 목록에서 확인하고 있어요. 끝나면 바로 시작해요.';

function wireShell(opts: ShellOptions, fixture: FixtureMode | null, key: Uint8Array, store: DocStore, made: { host?: EngineHost }): Shell {
  const demo = fixture ? (opts.demoModel ?? null) : null;
  const dev = fixture ? opts.dev! : null;
  const sample = dev?.sample ?? null;
  const root = fixture?.root ?? opts.engine?.root;
  const log = new FileEventLog(appPaths(root ?? defaultAppRoot()).logs, 'main');
  const embedded = opts.externalChrome !== true;
  const host = new EngineHost({ vault: fixture ? fixture.vault : 'process', root, portal: fixture?.portal ?? opts.engine!.portal, log, appVersion: runVersion(app.isPackaged, process.env, () => app.getVersion()), embeddedBrowser: embedded });
  made.host = host;
  let business: Profile | null = null;
  let businessId: string | null = null;
  let cps: Counterparty[] = [];
  const refresh = async () => {
    const ps = (await host.rpc('db.query.profiles.list')) as DbProfile[];
    const b = ps.find((p) => p.kind === 'business');
    business = b ? profileView(b) : null;
    businessId = b?.id ?? null;
    const lastDoc = (name: string) => store.docs.filter((d) => d.kind === '세금계산서' && d.name === `세금계산서 ${name}`).reduce<string | null>((m, d) => (d.issuedOn && (!m || d.issuedOn > m) ? d.issuedOn : m), null);
    const rows = (await host.rpc('db.query.counterparties.list')) as DbCounterparty[];
    const firsts = await Promise.all(rows.map((c) => host.rpc('counterparty.getItems', { id: c.id }).then((r) => (Array.isArray(r) ? (r[0] as { name?: string } | undefined)?.name : undefined), () => undefined)));
    cps = rows.map((c, i) => counterpartyView(c, fixture?.itemHints ?? {}, firsts[i])).map((c) => ({ ...c, lastIssuedOn: c.lastIssuedOn ?? lastDoc(c.name) }));
    runs.syncAuth();
  };
  const bank = new BankHost({
    rpc: (m, p) => host.rpc(m, p ?? {}),
    profileId: async () => ((await host.rpc('db.query.profiles.list')) as DbProfile[]).find((p) => p.kind === 'business')?.id ?? null,
    pick: (kind) =>
      opts.bankPick
        ? opts.bankPick(kind)
        : pickFileBytes([{ name: kind === 'statement' ? '은행 거래내역(엑셀/CSV)' : '홈택스 발급 목록(엑셀)', extensions: ['xlsx', 'xls', 'csv', 'htm', 'html'] }], win),
    readSheet: async (bytes) => {
      const r = await readSheetInSandbox(bytes);
      return { format: r.format, encoding: r.encoding, sheets: r.sheets, flags: r.flags };
    },
    log: (n, d) => log.event(n, d),
  });
  let seed: DemoSeed | null = null;
  const profiles = () =>
    sample ? { business: business ?? sample.profiles.business, personal: sample.profiles.personal } : { business: business ?? NO_BUSINESS, personal: NO_PERSONAL };
  const chromeReady = opts.chromeReady ?? (() => embedded || findInstalledChrome() !== null);
  const securityNow = opts.security ? () => opts.security!.status() : () => securityStatus();
  const securityMissing = () => profile === 'business' && profiles().business.auth === SIGN_LABEL.cert && securityBlocks(securityNow());
  const runs = new ShellRuns(host, { counterparties: () => cps, auth: () => profiles().business.auth, chromeReady, log: (n, d) => log.event(n, d), prepare: (id: string): Promise<unknown> => prepareNow(id) });
  let profile: Profile['kind'] = 'business';
  const docs = opts.docs ?? engineDocsProvider((m, p) => host.rpc(m, p), (params, engine) => importPdf(params, engine, win));
  const listDocs = async () => {
    try {
      const vault = await docs.list();
      const mem = new Map(store.docs.map((d) => [d.id, d]));
      const named = vault.map((d) => (d.runId && mem.has(`d-${d.runId}`) ? { ...d, name: mem.get(`d-${d.runId}`)!.name } : d));
      const runs = new Set(vault.flatMap((d) => (d.runId ? [`d-${d.runId}`] : [])));
      return [...named, ...store.docs.filter((d) => !runs.has(d.id))];
    } catch (e) {
      throw docsError(e);
    }
  };
  const docsCall =
    (fn: (p: Record<string, unknown>) => unknown) =>
    async (p: Record<string, unknown>): Promise<unknown> => {
      try {
        const r = await fn(p);
        pushBoard();
        return r;
      } catch (e) {
        throw docsError(e);
      }
    };
  let importing = false;
  const docFile = async (id: string) => store.files.get(id) ?? (await docs.filePath(id));

  const win = new BrowserWindow({
    width: Math.max(opts.width ?? 1280, WINDOW_MIN.width),
    height: Math.max(opts.height ?? 820, WINDOW_MIN.height),
    useContentSize: true,
    minWidth: WINDOW_MIN.width,
    minHeight: WINDOW_MIN.height,
    show: opts.show ?? true,
    title: fixture ? '소버린 AX (PoC 데모, 가짜 홈택스 페이지)' : '소버린 AX',
    ...(process.platform === 'darwin' ? { titleBarStyle: 'hiddenInset' as const, trafficLightPosition: { x: 16, y: 15 } } : {}),
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: false,
      disableDialogs: true,
      spellcheck: false,
      devTools: !app.isPackaged,
      preload: path.join(STATIC, 'preload-shell.cjs'),
    },
  });
  win.on('page-title-updated', (e) => e.preventDefault());
  const wc = win.webContents;
  hardenWindow(win);
  const gesture = new GestureClock();
  const typing = new GestureClock();
  const panelInput = new GestureClock();
  wc.on('before-mouse-event', (_e, m) => {
    panelInput.note(performance.now());
    if (m.type === 'mouseUp') {
      gesture.note(performance.now());
      typing.note(performance.now());
    }
  });
  wc.on('before-input-event', (_e, i) => {
    if (i.type === 'keyDown' || i.type === 'keyUp') panelInput.note(performance.now());
    if (isGestureKey(i)) gesture.note(performance.now());
    if (isTypingKey(i)) typing.note(performance.now());
  });
  const prepareRate = new RateWindow(opts.preparePerMin ?? 3, 60_000);
  const openRate = new RateWindow(5, 60_000);
  const needGesture = (ms: number) => {
    if (!gesture.within(performance.now(), ms)) throw new Error('gesture_required');
  };
  const needTyping = (ms: number) => {
    if (!typing.within(performance.now(), ms)) throw new Error('gesture_required');
  };

  let browserAvailable = false;
  let browserShown = false;
  let browserWant: number | null = null;
  const panelNow = (): number => {
    if (!embedded || !browserAvailable || win.isDestroyed()) return SHELL.panel;
    return browserPanelWidth(win.getContentSize()[0]!, browserWant, browserShown, bar.active);
  };
  let phoneIssue: PhoneIssue | null = null;
  let phoneGate: PhoneGate | null = null;
  const REMOTE_APPROVED_NOTE = '폰에서 승인했어요. 2초 안에 [중지]하면 발급하지 않아요';
  const bar: ApprovalBar = new ApprovalBar(win, key, (w, h, wide, height) => barBounds(w, h, wide, height, panelNow()), { log });
  const send = (ev: ShellEvent) => {
    if (!win.isDestroyed()) wc.send(IPC.event, ev);
  };
  let pageNow: { url: string; title: string } | null = null;
  const eb = embedded
    ? new EmbeddedBrowser({
        win,
        post: (m) => host.browserPost(m),
        log,
        onPage: (p) => {
          if (pageNow?.url === p?.url && pageNow?.title === p?.title) return;
          pageNow = p;
          const addr = p?.url ? pageAddress(p.url) : '';
          if (mirrorRun && addr) send({ type: 'screen', runId: mirrorRun, url: addr, title: p!.title.slice(0, 120) });
        },
      })
    : null;
  host.on('browser', (m: unknown) => eb?.feed(m));
  win.once('closed', () => eb?.closeAll('window'));
  if (eb) {
    win.on('hide', () => log.event('main.window_hide', { visible: win.isVisible(), minimized: win.isMinimized() }));
    win.on('show', () => log.event('main.window_show', { visible: win.isVisible(), minimized: win.isMinimized() }));
  }
  win.on('focus', () => {
    if (win.isDestroyed()) return;
    const p = screen.getCursorScreenPoint();
    const c = win.getContentBounds();
    const x = p.x - c.x;
    const y = p.y - c.y;
    if (x >= 0 && y >= 0 && x < c.width && y < c.height) send({ type: 'activated', x, y });
  });
  const issuedInvoices = (): IssuedInvoice[] => {
    const total = new Map((seed?.past ?? []).flatMap((p) => (p.documentId ? [[p.documentId, p.total]] : [])));
    return store.docs.filter((d) => d.kind === '세금계산서' && d.issuedOn).map((d) => ({ who: d.name.replace(/^세금계산서 /, ''), date: d.issuedOn!, total: total.get(d.id) ?? null }));
  };
  let boardDay = '';
  const boardNow = async (): Promise<Board> => {
    const today = kstToday(Date.now());
    const docsNow = await listDocs().catch((e: unknown) => {
      boardDay = '';
      throw e;
    });
    boardDay = today;
    const money = profile === 'business' ? await bank.boardCards() : [];
    return buildBoard({
      today,
      reminderDay: sample?.settings.reminderDay ?? REMINDER_DAY_DEFAULT,
      issued: issuedInvoices(),
      runs: runs.list().flatMap((r) => (r.cert ? [] : [{ id: r.id, status: r.status, who: r.counterparty.name, inDoubt: r.inDoubt === true }])),
      docs: docsNow.map((d) => ({ id: d.id, name: d.name, expiresOn: d.expiresOn, needsUser: !!d.vault?.needsUser })),
      bundle: sample ? sample.bundle(today) : null,
      cardFetchedOn: sample?.settings.cardFetchedOn ?? null,
      cardEnabled: !!sample,
      setup: [...onboardingTodos(onb?.state ?? null).filter((t) => t.id !== 'counterparties' || !cps.length), ...(profile === 'business' && !chromeReady() ? [{ id: 'chrome', label: SETUP_LABEL.chrome, view: 'chrome' as const }] : []), ...(securityMissing() ? [{ id: 'security', label: SETUP_LABEL.security, view: 'security' as const }] : [])],
      money,
    });
  };
  let boardQueued = false;
  let boardGen = 0;
  const pushBoard = () => {
    if (boardQueued) return;
    boardQueued = true;
    setImmediate(() => {
      boardQueued = false;
      const gen = ++boardGen;
      void boardNow().then(
        (board) => gen === boardGen && send({ type: 'board', board }),
        (e: Error) => log.event('main.board_failed', { error: e.message.slice(0, 80) }),
      );
    });
  };
  const bootBoard = () => {
    boardGen++;
    return boardNow();
  };
  const boardDayTimer = setInterval(() => {
    if (kstToday(Date.now()) !== boardDay) pushBoard();
  }, 60_000);
  boardDayTimer.unref();
  bar.on('shown', (e: { band: boolean; height: number }) => {
    send({ type: 'bar', active: true, band: e.band, height: e.height });
    if (embedded && browserAvailable) sendBrowserState();
  });
  bar.on('layout', (e: { band: boolean; height: number }) => send({ type: 'bar-layout', band: e.band, height: e.height }));
  bar.on('hidden', (reason: string) => {
    send({ type: 'bar', active: false, reason });
    if (embedded && browserAvailable) sendBrowserState();
  });
  const settled = new Map<string, string>();
  runs.on('update', (run) => {
    send({ type: 'run', run });
    if (['waiting', 'done', 'stopped', 'attention'].includes(run.status) && settled.get(run.id) !== run.status) {
      settled.set(run.id, run.status);
      void refresh().then(pushBoard, () => {});
    }
    pushBoard();
  });
  runs.on('doc', (doc) => {
    store.docs.unshift(doc);
    const run = runs.get(doc.id.slice(2));
    if (seed && run && !run.cert) void seed.issued(doc, run).catch((e) => log.event('main.seed_issued_failed', { error: (e as Error).message.slice(0, 120) }));
    send({ type: 'doc', doc });
    pushBoard();
    void refresh().catch(() => {});
  });
  runs.on('gate-closed', (runId: string, reqId: string, reason: string) => {
    phoneGate?.close(runId, reqId, reason === 'expired' ? 'expired' : 'stopped');
    bar.close(reason, reqId);
  });

  const secrets = new SecretWindowCoordinator((runId) => runs.isActive(runId));
  let runChromePid = 0;
  const appToFront = () => {
    if (win.isDestroyed()) return;
    app.focus({ steal: true });
    win.moveTop();
    win.focus();
  };
  let frontWatch: NodeJS.Timeout | null = null;
  let frontBusy = false;
  const frontPid = (cb: (pid: number) => void) =>
    execFile('lsappinfo', ['front'], { timeout: 1_000 }, (e, asn) => {
      if (e || !String(asn).trim()) return cb(0);
      execFile('lsappinfo', ['info', '-only', 'pid', String(asn).trim()], { timeout: 1_000 }, (e2, out) => {
        const m = !e2 && /"pid"\s*=\s*(\d+)/i.exec(String(out));
        cb(m ? Number(m[1]) : 0);
      });
    });
  const watchChromeFront = (on: boolean) => {
    if (process.platform !== 'darwin') return;
    if (!on) {
      if (frontWatch) clearInterval(frontWatch);
      frontWatch = null;
      return;
    }
    if (frontWatch) return;
    frontWatch = setInterval(() => {
      if (frontBusy || !runChromePid) return;
      frontBusy = true;
      frontPid((pid) => {
        frontBusy = false;
        if (pid && pid === runChromePid) {
          appToFront();
          log.event('main.chrome_front_refocus', { guard: true });
        }
      });
    }, 400);
  };
  let mainClosing = false;
  win.once('close', () => {
    mainClosing = true;
  });
  let secretAsk: { reqId: string; bind: OneShotInputBind } | null = null;
  const closeSecret = () => {
    if (!secretAsk) return;
    send({ type: 'secretAsk', reqId: secretAsk.reqId, state: 'closed' });
    secretAsk = null;
    secrets.closed();
  };
  const openSecret = (data: unknown): void => {
    if (mainClosing || win.isDestroyed()) return log.event('main.secret_needed_ignored');
    const r = secrets.request(data);
    if (!r) return log.event(secrets.open ? 'main.secret_needed_queued' : 'main.secret_needed_ignored');
    const bind: OneShotInputBind = { runId: r.runId, kind: r.kind, scope: r.scope };
    secretAsk = { reqId: randomUUID().slice(0, 18), bind };
    const label = SECRET_LABELS[r.kind];
    const note = r.kind === 'cert_password' ? '처음 한 번만 넣으면 이 Mac 금고에 두고 다음부터 묻지 않아요.' : '이번 실행에서 한 번만 쓰고 저장하지 않아요.';
    send({ type: 'secretAsk', reqId: secretAsk.reqId, state: 'open', runId: r.runId, kind: r.kind, label, note });
    if (win.isMinimized()) win.restore();
    if (!win.isVisible()) win.show();
    app.focus({ steal: true });
    win.focus();
    log.event('main.secret_ask_shown', { kind: r.kind });
  };
  const vaultSecretSend = (bind: Parameters<typeof host.secretInputPort>[0], method: 'secret.provide' | 'secret.store', params: Record<string, unknown>): Promise<{ ok: boolean; error?: string }> =>
    new Promise((resolve) => {
      let port: ReturnType<typeof host.secretInputPort> | null = null;
      const done = (v: { ok: boolean; error?: string }) => {
        clearTimeout(timer);
        try {
          port?.close();
        } catch {
          // 이미 닫힘
        }
        resolve(v);
      };
      const timer = setTimeout(() => done({ ok: false, error: 'timeout' }), 10_000);
      try {
        port = host.secretInputPort(bind);
        port.on('message', (e: { data: unknown }) => {
          const d = e.data as { error?: unknown } | null;
          done(d && typeof d.error === 'string' ? { ok: false, error: d.error.slice(0, 40) } : { ok: true });
        });
        port.start();
        port.postMessage({ t: 'rpc', id: 1, method, params });
      } catch (e) {
        done({ ok: false, error: (e as Error).message.slice(0, 40) });
      }
    });
  const saveCertMemory = async (value: unknown): Promise<{ remembered: boolean }> => {
    if (typeof value !== 'string' || !value) throw new Error('bad_value');
    const bytes = new TextEncoder().encode(value);
    const r = await vaultSecretSend({ mode: 'store', kind: 'cert_password', scope: 'business', notice: { version: 'cert-settings-2026-11-14' } }, 'secret.store', { entries: [{ field: 'pw', bytes }] });
    bytes.fill(0);
    log.event('main.cert_memory_saved', { ok: r.ok, ...(r.error ? { error: r.error } : {}) });
    if (!r.ok) throw new Error('vault_refused');
    return { remembered: true };
  };
  const answerSecret = async (p: { reqId?: unknown; value?: unknown; cancel?: unknown }): Promise<{ ok: true }> => {
    const ask = secretAsk;
    if (!ask || p.reqId !== ask.reqId) throw new Error('not_requested');
    if (p.cancel === true) {
      secretAsk = null;
      send({ type: 'secretAsk', reqId: ask.reqId, state: 'closed' });
      const next = secrets.closed();
      log.event('main.secret_ask_cancelled', { kind: ask.bind.kind });
      if (next) openSecret(next);
      return { ok: true };
    }
    if (typeof p.value !== 'string' || !p.value) throw new Error('bad_value');
    const bytes = new TextEncoder().encode(p.value);
    const r = await vaultSecretSend(ask.bind, 'secret.provide', { kind: ask.bind.kind, scope: ask.bind.scope, bytes });
    bytes.fill(0);
    log.event('main.secret_ask_answered', { kind: ask.bind.kind, ok: r.ok, ...(r.error ? { error: r.error } : {}) });
    if (!r.ok) throw new Error('vault_refused');
    if (secretAsk === ask) secretAsk = null;
    send({ type: 'secretAsk', reqId: ask.reqId, state: 'done' });
    const next = secrets.closed();
    if (next) openSecret(next);
    return { ok: true };
  };
  let codefWin: { win: BrowserWindow; req: CodefNeeded } | null = null;
  codefPage = () => {
    if (!codefWin) log.event('main.secret_window_blank', { step: 'no_request' });
    return codefWin ? codefPageHtml(codefWin.req, { profileName: profiles()[codefWin.req.scope].name, certLabel: bankAuto.chosenLabel(), bankName: bankAuto.chosenBank() }) : null;
  };
  const openCodef = (req: CodefNeeded): void => {
    if (mainClosing || win.isDestroyed() || codefWin) {
      void host.control('codef.windowClosed', { reqId: req.reqId }).catch(() => {});
      return log.event('main.codef_window_ignored');
    }
    let port: ReturnType<typeof host.secretInputPort> | null = null;
    try {
      port = host.secretInputPort(req);
      const w = openVaultInputWindow(win, port, `${SHELL_SCHEME}://shell/codef-secret.html`, CODEF_WINDOW_TITLE, 340, (n, d) => log.event(n, d));
      codefWin = { win: w, req };
      w.on('closed', () => {
        if (codefWin?.win === w) codefWin = null;
        void host.control('codef.windowClosed', { reqId: req.reqId }).catch(() => {});
      });
    } catch (e) {
      port?.close();
      void host.control('codef.windowClosed', { reqId: req.reqId }).catch(() => {});
      log.event('main.codef_window_failed', { error: (e as Error).message.slice(0, 120) });
    }
  };
  host.on('codef', (data: unknown) => send({ type: 'bankAuto', event: data }));
  host.on('vault-event', (name: string, data: unknown) => {
    if (name === 'screen.frame' || name === 'screen.paused') {
      if (!mirrorRun) return;
      const d = (data ?? {}) as { data?: unknown; w?: unknown; h?: unknown; url?: unknown; paused?: unknown };
      if (name === 'screen.paused') return send({ type: 'screen', runId: mirrorRun, paused: d.paused === true });
      if (typeof d.data !== 'string' || d.data.length > 2_000_000) return;
      return send({ type: 'screen', runId: mirrorRun, frame: `data:image/jpeg;base64,${d.data}`, w: Number(d.w) || 0, h: Number(d.h) || 0, url: typeof d.url === 'string' ? d.url.slice(0, 200) : '' });
    }
    if (name === 'browser.blocked') {
      const on = (data as { blocked?: unknown } | null)?.blocked === true;
      eb?.setBlocked(on);
      if (mirrorRun) send({ type: 'screen', runId: mirrorRun, paused: on });
      return;
    }
    if (name === 'browser.launched') {
      const pid = Number((data as { pid?: unknown } | null)?.pid);
      if (Number.isSafeInteger(pid) && pid > 0) runChromePid = pid;
      watchChromeFront(true);
      appToFront();
      for (const ms of [250, 600, 1_000, 1_600, 2_400]) setTimeout(appToFront, ms);
      log.event('main.chrome_front_refocus', { popup: (data as { popup?: unknown } | null)?.popup === true });
      return;
    }
    if (name === 'browser.closed') {
      log.event('main.browser_closed', { reason: (data as { reason?: unknown } | null)?.reason === 'chrome' ? 'chrome' : 'tab' });
      if (mirrorRun) send({ type: 'screen', runId: mirrorRun, gone: true });
      if ((data as { reason?: unknown } | null)?.reason === 'chrome') {
        runChromePid = 0;
        watchChromeFront(false);
      }
      runs.browserClosed();
      return;
    }
    const cr = name === 'secret.needed' ? parseCodefNeeded(data) : null;
    if (cr) return openCodef(cr);
    if (name === 'secret.needed') return openSecret(data);
    const n = vaultNotice(name, data);
    if (n) runs.notice(n.runId, n.text, n.retry);
  });
  runs.on('update', (run: { id: string }) => {
    if (secrets.open?.runId === run.id && !runs.isActive(run.id)) closeSecret();
  });
  host.on('exit', (who: string) => {
    if (who === 'engine') bar.close('engine_exit');
  });
  runs.on('gate', (runId: string, req) => {
    if (runs.get(runId)?.rehearsal) {
      log.event('main.rehearsal_gate_refused', { runId });
      return void runs.stop(runId).catch(() => {});
    }
    const sendApproval = async (approval: LocalApproval, note?: string) => {
      phoneGate?.close(runId, req.reqId, 'pc');
      runs.approved(runId, note);
      await saveResume().catch(() => {});
      const r = await host.answerGate(approval);
      if (!r.ok) log.event('main.gate_answer_not_ok', { code: r.code ?? '', verdict: r.verdict });
      await runs.onAnswer(runId, r);
    };
    if (runs.batchAutoApprove(runId, req)) return void sendApproval(issueLocalApproval(key, req, 'click+batch'), BATCH_AUTO_NOTE);
    const gr = runs.get(runId);
    void phoneGate
      ?.offer(runId, req, {
        approve: async () => {
          bar.close('remote_approved', req.reqId);
          const name = runs.get(runId)?.counterparty.name ?? '';
          runNotify('gate', runId, '폰에서 승인했어요', `세금계산서${name ? ` ${name}` : ''} 발급을 시작해요`);
          await sendApproval(issueLocalApproval(key, req, 'remote+px'), REMOTE_APPROVED_NOTE);
        },
        deny: async () => {
          phoneIssue?.deniedByPhone(runId);
          await runs.stop(runId).catch((e: Error) => log.event('main.phone_deny_stop_failed', { error: e.message.slice(0, 80) }));
        },
      })
      .catch((e: Error) => log.event('main.phone_gate_offer_failed', { error: e.message.slice(0, 80) }));
    const offer = runs.batchOffer(runId);
    const manyShown = !!offer && actionText(req) === ACTION_TEXT;
    if (gr) runNotify('gate', runId, '승인이 필요해요', manyShown ? `세금계산서 ${offer.count}건, ${gr.counterparty.name} 외 ${offer.count - 1}건` : `세금계산서 ${gr.counterparty.name} ${wonText(gr.total)}`);
    void bar.open(req, gr?.auth, offer, runs.get(runId)?.cert?.name).then(async (o) => {
      if (o.decision === 'approve') {
        if (!verifyLocalApproval(key, o.approval)) return runs.abortGate(runId, 'answer.rejected');
        if (offer && o.batch === offer.count && !runs.batchApproved(runId, offer)) send({ type: 'say', text: BATCH_CHANGED_NOTE });
        await sendApproval(o.approval);
      } else if (o.reason === 'stopped') {
        await runs.stop(runId).catch((e: Error) => log.event('main.card_stop_failed', { error: e.message.slice(0, 80) }));
      } else if (o.reason === 'load_failed') await runs.abortGate(runId, 'bar.load_failed');
      else if (o.reason === 'busy') log.event('main.gate_while_open');
    });
  });

  let incidentOpen: string | null = null;
  const showAttest = (runId: string) => {
    const req = runs.attestFor(runId);
    if (!req || incidentOpen !== runId || bar.visible) return;
    void bar.openAttest(req).then(async (o) => {
      if (o.decision !== 'attest') {
        if (o.reason === 'load_failed') log.event('main.attest_bar_load_failed');
        if (o.reason === 'dismissed' && incidentOpen === runId) incidentOpen = null;
        return;
      }
      if (!verifyLocalAttestation(key, o.attestation) || o.attestation.attestReqId !== req.attestReqId) return log.event('main.attest_self_check_failed');
      runs.attestUsed(runId, req.attestReqId);
      const r = await host.answerAttest(o.attestation);
      if (!r.ok) log.event('main.attest_answer_not_ok', { code: String(r.code ?? ''), verdict: r.verdict });
      runs.onAttestAnswer(runId, r);
    });
  };
  const incidents = {
    open(id: string): { ready: boolean } {
      if (!runs.get(id)?.inDoubt) throw new Error('not_in_doubt');
      if (incidentOpen && incidentOpen !== id) bar.closeAttest('card_switched', { runId: incidentOpen });
      incidentOpen = id;
      showAttest(id);
      return { ready: !!runs.attestFor(id) };
    },
    close(id: string): { ok: true } {
      if (incidentOpen === id) incidentOpen = null;
      bar.closeAttest('card_closed', { runId: id });
      return { ok: true };
    },
  };
  runs.on('attest-ready', (runId: string) => showAttest(runId));
  runs.on('attest-withdrawn', (_runId: string, attestReqId: string, reason: string) => bar.closeAttest(`withdrawn.${reason}`, { attestReqId }));
  bar.on('hidden', (_reason: string, kind: string) => {
    if (kind === 'gate' && incidentOpen) setTimeout(() => incidentOpen && showAttest(incidentOpen), 0);
  });

  const g24Doc = (v: unknown): G24Doc => {
    if (v !== '주민등록표 등본' && v !== '주민등록표 초본') throw new Error('bad_doc');
    return v;
  };
  let daemon: DaemonHost | null = null;
  const liveNotices = new Set<Notification>();
  const showOsNotification: ShowNotification = (t, onClick) => {
    if (!Notification.isSupported()) throw new Error('notify_unsupported');
    const n = new Notification({ title: t.title, body: t.body });
    liveNotices.add(n);
    n.on('click', () => {
      liveNotices.delete(n);
      onClick();
    });
    n.on('close', () => liveNotices.delete(n));
    n.show();
  };
  const runNotify = (kind: 'gate' | 'turn' | 'end', runId: string, title: string, body: string) => {
    if (win.isDestroyed() || (win.isFocused() && win.isVisible() && !win.isMinimized())) return;
    try {
      showOsNotification({ title, body: body.slice(0, 120) }, () => {
        if (win.isDestroyed()) return;
        if (win.isMinimized()) win.restore();
        win.show();
        win.focus();
        send({ type: 'open', to: 'run', id: runId });
      });
      log.event('main.run_notify', { kind });
    } catch (e) {
      log.event('main.run_notify_failed', { error: (e as Error).message.slice(0, 60) });
    }
  };
  const resumeStore = new RunResumeStore({ save: (value) => host.rpc('resume.save', { value }), take: () => host.rpc('resume.take', {}) });
  const resumeWork = () =>
    pendingWork(
      runs.list(),
      (r) => runs.batchWaiting(r),
      (id) => cps.find((c) => c.id === id)?.email,
    );
  const saveResume = () => resumeStore.save(resumeWork(), Date.now());
  runs.on('update', () => void saveResume());
  let restored = false;
  const restoreRuns = async () => {
    if (restored) return;
    restored = true;
    const work = await resumeStore.take(Date.now());
    const items = work.items.filter((it) => !runs.get(it.from));
    const approved = work.approved.filter((a) => !runs.get(a.from));
    void saveResume();
    for (const a of approved) send({ type: 'say', text: `앞에서 승인한 ${a.name} ${wonText(a.total)} 건은 앱이 꺼져 발급됐는지 확인하지 못했어요. 홈택스 발급목록을 확인해 주세요. 다시 발급하지 마세요.` });
    if (approved.length) log.event('main.resume_approved_notice', { count: approved.length });
    if (!items.length) return;
    const first = runs.restore(items);
    pushBoard();
    if (!first || (onb && !onb.done)) return;
    try {
      await needLogin();
    } catch {
      return log.event('main.restore_prepare_skipped', { why: 'login' });
    }
    prepareNow(first.id).catch((e: Error) => log.event('main.restore_prepare_failed', { code: e.message.slice(0, 60) }));
  };
  const wonText = (n: number) => `${Number(n).toLocaleString('ko-KR')}원`;
  const runLast = new Map<string, string>();
  runs.on('update', (r: RunView) => {
    const prev = runLast.get(r.id);
    runLast.set(r.id, r.status);
    if (prev === r.status || r.discarded) return;
    const what = `세금계산서 ${r.counterparty.name} ${wonText(r.total)}`;
    if (r.status === 'turn') return runNotify('turn', r.id, '홈택스에서 할 일이 있어요', r.turn?.text ?? what);
    if (!['done', 'attention', 'stopped'].includes(r.status) || !prev || prev === 'draft') return;
    if (r.batch) {
      const all = runs.batchRuns(r.batch.id);
      if (runs.batchOpen(r.batch.id)) return;
      const done = all.filter((x) => x.status === 'done').length;
      return runNotify('end', all[0]!.id, done === all.length ? `${all.length}건 모두 발급했어요` : `${all.length}건 중 ${done}건 발급했어요`, all.map((x) => `${x.counterparty.name} ${x.status === 'done' ? '발급' : x.status === 'draft' ? '남음' : '멈춤'}`).join(', '));
    }
    if (r.rehearsal) return runNotify('end', r.id, '예행을 마쳤어요', '승인 직전까지 갔고 발급하지 않았어요');
    if (r.status === 'done') return runNotify('end', r.id, '발급했어요', `${what}${r.result?.approvalNo ? `, 승인번호 ${r.result.approvalNo}` : ''}`);
    runNotify('end', r.id, r.status === 'attention' ? '확인이 필요해요' : '멈췄어요', `${what}, ${r.stoppedNote ?? ''}`);
  });
  let updater: UpdateHost | null = null;
  const REGISTRY_EVERY_MS = 15 * 60_000;
  const HOMETAX_KEEPALIVE_MS = 10 * 60_000;
  let registryAt = 0;
  let registryInflight: Promise<void> | null = null;
  const registrySync = (why: string): Promise<void> => {
    if (fixture) return Promise.resolve();
    return (registryInflight ??= host
      .rpc('registry.sync', {})
      .then(
        (r) => {
          registryAt = Date.now();
          const x = (r ?? {}) as { index?: unknown; policy?: unknown; packages?: Record<string, unknown> };
          log.event('main.registry_sync', { why, index: String(x.index ?? ''), policy: String(x.policy ?? ''), h01: String(x.packages?.['hometax.invoice.issue'] ?? '') });
        },
        (e: unknown) => log.event('main.registry_sync', { why, result: String((e as Error)?.message ?? 'failed').slice(0, 60) }),
      )
      .finally(() => (registryInflight = null)));
  };
  const registryFresh = async (): Promise<void> => {
    if (fixture || Date.now() - registryAt < REGISTRY_EVERY_MS) return;
    let t: NodeJS.Timeout | undefined;
    await Promise.race([registrySync('run'), new Promise<void>((r) => (t = setTimeout(r, 10_000)))]);
    clearTimeout(t);
  };
  const registryTimer = setInterval(() => void registrySync('timer'), REGISTRY_EVERY_MS);
  registryTimer.unref();
  const keepHometax = async (why: string) => {
    if (!eb || runs.list().some((r) => r.status === 'preparing' || r.status === 'issuing' || r.approvedPending === true || r.handoff?.afterGate === true)) return;
    const result = await eb.keepSession().catch(() => 'error');
    if (result !== 'none') log.event('main.hometax_keepalive', { why, result });
  };
  const keepTimer = setInterval(() => void keepHometax('timer'), HOMETAX_KEEPALIVE_MS);
  keepTimer.unref();
  const onResume = () => {
    void keepHometax('resume');
    void registrySync('resume');
    daemon?.requestReload();
    void updater?.check();
  };
  let onb: OnboardingFlow | null = null;
  let onbShow = true;
  const onbStore = new EngineOnboardingStore((m, p) => host.rpc(m, p));
  const legacyOnbFile = path.join(appPaths(root ?? defaultAppRoot()).userData, 'onboarding-state.json');
  const bizCertPorts: BizCertReadPorts = {
    pick: () => pickFileBytes([{ name: '사업자등록증(PDF/사진)', extensions: ['pdf', 'png', 'jpg', 'jpeg'] }], win),
    pdfText: async (b, o) => (await parsePdfInSandbox(b, { ocrPages: 1, forceOcr: o.forceOcr })).text,
    imageText: async (b) => (await ocrImageInSandbox(b, { mode: 'document' })).text,
    parse: (text) => host.rpc('bizcert.parse', { text }),
    log: (n, d) => log.event(n, d),
  };
  const certNames = new Map<string, string>();
  const onbExternal: OnboardingExternal = fixture
    ? sample!.onboarding()
    : {
        recognizeBizCert: () => readBizCert(bizCertPorts),
        checkBizNo: async () => ({ status: 'unknown', label: '조회하지 못했어요', taxType: null, source: '국세청 조회' }),
        consentConfig: async () => structuredClone(CONSENT_CONFIG),
        findCerts: () => listNpkiCerts((m, p) => host.control(m, p), (der) => certInfoInSandbox(der), { today: kstToday(Date.now()), log: (n, d) => log.event(n, d), names: certNames }),
        certName: async (id) => {
          if (!certNames.has(id)) await onbExternal.findCerts();
          return certNames.get(id) || null;
        },
      };
  const onbPorts = onboardingPorts(onbExternal, onbStore, refresh);
  const bankAuto = bankAutoHandlers({ engine: (m, p) => host.rpc(m, p), certs: () => onbExternal.findCerts(), preferredCertId: () => onb?.state.certId ?? null, log: (n, d) => log.event(n, d) });
  const cpBook = new CounterpartyBook(
    (m, p) => host.rpc(m, p),
    fixture
      ? async () => ({ ...sample!.cpCert })
      : async () => {
          let picked = false;
          const pick = async () => {
            const b = await bizCertPorts.pick();
            picked = b !== null;
            return b;
          };
          return (await readBizCert({ ...bizCertPorts, pick })) ?? (picked ? 'unreadable' : null);
        },
  );
  const editLog = new ProfileEditLog(appPaths(root ?? defaultAppRoot()).userData);
  const editor = new ProfileEditor({
    list: async () => (await host.rpc('db.query.profiles.list')) as DbProfile[],
    upsert: async (row) => (await host.rpc('profile.upsert', row)) as DbProfile,
    checkBizNo: (n) => onbExternal.checkBizNo(n),
    saved: async (biz, changed) => {
      try {
        if (onb?.done) await onb.syncBiz(biz);
      } finally {
        if (changed.length) editLog.add({ at: new Date().toISOString(), kind: 'business', fields: changed });
        log.event('main.profile_edit', { fields: changed.join('.') || 'none' });
        await refresh();
        pushBoard();
      }
    },
  });
  const readOwnCert = async (): Promise<BizFields | 'unreadable' | null> => {
    if (fixture) return onbExternal.recognizeBizCert();
    let picked = false;
    const pick = async () => {
      const b = await bizCertPorts.pick();
      picked = b !== null;
      return b;
    };
    return (await readBizCert({ ...bizCertPorts, pick })) ?? (picked ? 'unreadable' : null);
  };
  let readingCert = false;
  const keepItem = async (runId: string) => {
    const r = runs.get(runId);
    if (!r || r.rehearsal || r.itemGuessed || !r.item) return;
    const cp = cps.find((c) => c.id === r.counterparty.id);
    if (!cp || cp.item) return;
    try {
      await cpBook.setFirstItem(cp.id, r.item);
      await refresh();
      runs.notice(r.id, `이 품목을 ${cp.name}의 저장 품목으로 남겼어요. 다음부터 먼저 채워요(거래처 화면에서 바꿀 수 있어요).`);
      log.event('main.item_kept', { result: 'ok' });
    } catch (e) {
      log.event('main.item_kept', { result: (e as Error).message === 'bad_item_name' ? 'bad_item_name' : 'failed' });
    }
  };
  const intent: IntentResolver = opts.intent ?? engineIntentResolver((m, p) => host.rpc(m, p));
  const chatReply: ChatResponder = opts.chat ?? engineChatResponder((m, p) => host.rpc(m, p));
  let agentCreated: RunView[] = [];
  const agentReads = agentPorts({
    rpc: (m, p) => (m === 'chat.step' && opts.agent ? opts.agent.step(p as unknown as StepParams) : m === 'chat.route' && opts.agent?.route ? opts.agent.route(p) : m === 'db.query.runs.history' && opts.agent?.history ? opts.agent.history(p) : host.rpc(m, p)),
    route: CHAT_REACTIONS_ON && (!opts.agent || !!opts.agent.route),
    onReaction: (reaction) => send({ type: 'chat-reaction', reaction }),
    profileId: () => businessId,
    runs,
    setupMissing: () => setupMissing(profiles().business).length > 0 || !chromeReady(),
    onCreated: (run) => agentCreated.push(run),
    receivables: () => bank.receivables(),
    payables: () => bank.payables(),
    cashFlow: (month) => bank.cashFlowValues(month),
    pastIssued: () => (seed?.past ?? []).flatMap((x) => (x.kind === 'issued' && x.approvalNo && x.who && x.day ? [{ counterpartyId: cps.find((c) => c.name === x.who)?.id ?? null, counterparty: x.who, date: x.day, total: x.total, approvalNo: x.approvalNo, documentId: x.documentId, mail: null }] : [])),
    onProgress: (phase: AgentPhase) => send({ type: 'chat-progress', phase }),
    openScreen: (screen: string) => send({ type: 'open-screen', screen }),
  });
  const agent = new AgentChat(agentReads);
  const finishReply = (reply: ReturnType<typeof interpret>, via: 'model' | 'offline', note: string | null, sent: SentTo[]) => {
    if (reply.kind === 'draft') {
      reply.run.interp = via;
      reply.run.sent = sent;
      pushBoard();
      if (sendByUser) autoPrepare(reply.run.id);
    }
    return { ...reply, via, note, sent };
  };
  let sendByUser = false;
  const autoPrepare = (id: string) => {
    const r = runs.get(id);
    if (!r || r.status !== 'draft' || (!r.cert && !String(r.item ?? '').trim())) return;
    setImmediate(() => {
      log.event('main.prepare_auto', {});
      if (queueIfBusy(id)) return;
      prepareNow(id).catch((e: Error) => log.event('main.prepare_auto_failed', { code: e.message.slice(0, 60) }));
    });
  };
  let nextUp: string | null = null;
  const queueIfBusy = (id: string): boolean => {
    const active = runs.activeRun();
    const d = runs.get(id);
    if (!active || !d || active.id === id) return false;
    if (nextUp && nextUp !== id) runs.dropNotice(nextUp, QUEUED_NOTE);
    nextUp = id;
    if (runs.replaceable(active.id) && active.counterparty.id === d.counterparty.id) {
      log.event('main.prepare_replace', {});
      runs.noteOn(id, REPLACING_NOTE);
      runs.stop(active.id).then(
        () => {
          const prev = runs.get(active.id);
          if (prev) prev.replaced = true;
          runs.noteOn(active.id, REPLACED_NOTE);
        },
        (e: Error) => log.event('main.prepare_replace_failed', { code: e.message.slice(0, 60) }),
      );
    } else {
      log.event('main.prepare_queued', {});
      runs.noteOn(id, QUEUED_NOTE);
    }
    return true;
  };
  runs.on('update', () => {
    if (!nextUp || runs.anyActive()) return;
    const id = nextUp;
    nextUp = null;
    runs.dropNotice(id, QUEUED_NOTE);
    runs.dropNotice(id, REPLACING_NOTE);
    if (runs.get(id)?.status !== 'draft') return;
    setImmediate(() => prepareNow(id).catch((e: Error) => log.event('main.prepare_next_failed', { code: e.message.slice(0, 60) })));
  });
  const prepareNow = async (id: string) => {
    const pause = runs.prepareWaitMs();
    const now = performance.now();
    if (pause > 0 || !prepareRate.take(now)) {
      const why = pause > 0 ? 'streak' : 'rate';
      log.event('main.prepare_throttled', { why });
      throw new Error(`throttled.${why}:${Math.max(1, Math.ceil((pause > 0 ? pause : prepareRate.waitMs(now)) / 1000))}`);
    }
    const waitReverify = async () => {
      while (reverifying) {
        runs.notice(id, REVERIFY_WAIT_NOTE);
        await reverifying;
        runs.dropNotice(id, REVERIFY_WAIT_NOTE);
      }
    };
    await waitReverify();
    await registryFresh();
    await waitReverify();
    const r = await runs.prepare(id);
    await keepItem(id);
    return r;
  };
  const linkVaultOf = (k: DesktopKeys): PcLinkVault => {
    const v = (k as Partial<VaultDesktopKeys>).link;
    if (!v) throw Object.assign(new Error('keys'), { code: 'account.keys_unavailable' });
    return v;
  };
  let remoteKeys: Promise<DesktopKeys> | null = null;
  const keysOf = (): Promise<DesktopKeys> => {
    const f = opts.remote?.keys;
    if (!f) return Promise.reject(Object.assign(new Error('keys'), { code: 'account.keys_unavailable' }));
    remoteKeys ??= f((m, p) => host.control(m, p)).catch((e: unknown) => {
      remoteKeys = null;
      throw e;
    });
    return remoteKeys;
  };
  const account = new DesktopAccount({
    client: opts.remote?.keys ? (opts.remote.cloud?.account ?? null) : null,
    keys: keysOf,
    identity: new RemoteIdentityFile(appPaths(root ?? defaultAppRoot()).userData),
    pending: new PendingCodeFile(appPaths(root ?? defaultAppRoot()).userData),
    platform: process.platform === 'darwin' ? 'macos' : 'windows',
    deviceName: opts.remote?.deviceName ?? (process.platform === 'darwin' ? 'Mac PC' : 'Windows PC'),
    model: deviceModel,
    pairing: opts.remote?.pairing !== false,
    linkVault: async () => linkVaultOf(await keysOf()),
    resetKeys: () => {
      remoteKeys = null;
    },
    onRekey: () => void host.rpc('share.resend').catch(() => undefined),
    log: (n, d) => log.event(n, d),
  });
  let linkTimer: ReturnType<typeof setInterval> | null = null;
  let keyDeposited = false;
  const depositKey = (v: AccountView): void => {
    if (v.step === 'signed_out') keyDeposited = false;
    if (keyDeposited || v.step !== 'signed_in') return;
    keyDeposited = true;
    void account.depositKey().then((r) => {
      if (r !== 'stored' && r !== 'already' && r !== 'request.not_found' && r !== 'skipped') keyDeposited = false;
      if (r === 'account.cert_invalid') send({ type: 'account', account: account.view() });
    });
  };
  const watchLink = <T extends AccountView>(v: T): T => {
    depositKey(v);
    if (shouldStartPhones({ signedIn: !!account.device(), running: !!phoneLink })) {
      void Promise.resolve(phones()?.start())
        .then(() => syncAwake())
        .catch((e: Error) => log.event('main.phone_link', { step: 'start', result: e.message.slice(0, 40) }));
    }
    const linking = v.step.startsWith('link_');
    if (linking && !linkTimer) {
      linkTimer = setInterval(() => {
        void account.linkPoll().then((changed) => {
          const now = account.view();
          if (changed) send({ type: 'account', account: now });
          if (!now.step.startsWith('link_')) watchLink(now);
        });
      }, LINK_POLL_MS);
      linkTimer.unref?.();
    } else if (!linking && linkTimer) {
      clearInterval(linkTimer);
      linkTimer = null;
    }
    return v;
  };
  let accountReady: Promise<unknown> | null = null;
  const accountInit = () => (accountReady ??= account.init().then((v) => (depositKey(v), v)));
  let gwSeq = 0;
  let gwLog: Array<[number, string]> = [];
  const gwIssuedSince = (n: number) => gwLog.filter(([i]) => i > n).map(([, p]) => p);
  const gwAuth = new GatewayAuthHost({
    device: async () => {
      await accountInit().catch(() => null);
      return account.device();
    },
    log: (n, d) => log.event(n, d),
    onIssued: (path) => {
      gwLog = [...gwLog.slice(-199), [++gwSeq, path]];
    },
    modelAllowed: () => modelOk(),
  });
  host.setGatewayAuth((m) => gwAuth.handle(m));
  const issueLock = new IssueLockHost({
    client: opts.remote?.keys ? (opts.remote.cloud?.account ?? null) : null,
    device: async () => {
      await accountInit();
      return account.device();
    },
    log: (n, d) => log.event(n, d),
  });
  host.setIssueLock((m) => issueLock.handle(m));
  host.on('exit', () => void issueLock.release());
  let pairHost: PairingHost | null = null;
  const pairedThisRun: DesktopPairResult[] = [];
  let pairShielded = false;
  const pairShield = (v: PairView) => {
    const on = v.step === 'waiting_phone' || v.step === 'awaiting_sas' || v.step === 'checking';
    if (on === pairShielded || win.isDestroyed()) return;
    pairShielded = on;
    win.setContentProtection(on);
  };
  const pairPush = (v: PairView) => {
    pairShield(v);
    send({ type: 'pair', pair: v });
  };
  const pairing = (): PairingHost => {
    if (pairHost) return pairHost;
    const cloud = opts.remote?.cloud;
    const device = account.device();
    if (opts.remote?.pairing === false) throw new Error('pair_unavailable');
    if (!cloud || !device) throw new Error(device ? 'pair_unavailable' : 'account_required');
    pairHost = new PairingHost({
      account: cloud.account,
      relayHttp: cloud.relay,
      relay: opts.remote?.relayClient ?? wsRelayClient({ host: cloud.relayHost, open: cloud.openSocket, insecureLocal: cloud.insecureLocal }),
      relayHost: cloud.relayHost,
      device,
      keys: keysOf,
      qr: qrSvgDataUrl,
      desktopName: opts.remote?.deviceName ?? (process.platform === 'darwin' ? 'Mac PC' : 'Windows PC'),
      log: (n, d) => log.event(n, d),
      onView: pairPush,
      onPaired: (r) => {
        pairedThisRun.push(r);
        const link = phones();
        if (!link) log.event('main.phone_link', { step: 'add', result: account.device() ? 'no_cloud' : 'signed_out' });
        void link?.add(r).catch((e: Error) => log.event('main.phone_link', { step: 'add', result: e.message.slice(0, 40) }));
        send({ type: 'account', account: account.view() });
      },
    });
    return pairHost;
  };
  const pairReset = () => {
    pairHost?.cancel();
    pairHost = null;
  };
  const billingCall = async <T>(f: (c: AccountClient, auth: DeviceAuth) => Promise<T>): Promise<T> => {
    await accountInit().catch(() => null);
    const cloud = opts.remote?.cloud;
    const device = account.device();
    if (!cloud || !device) throw new Error('account_required');
    try {
      return await f(cloud.account, device.auth);
    } catch (e) {
      if ((e as { code?: string }).code !== 'account.unauthorized') throw e;
      device.clearToken();
      return f(cloud.account, device.auth);
    }
  };
  const tokenSeal: TokenSeal = {
    seal: (b) => (safeStorage.isEncryptionAvailable() ? `ss1:${safeStorage.encryptString(Buffer.from(b).toString('base64')).toString('base64')}` : `b64:${Buffer.from(b).toString('base64')}`),
    open: (v) => new Uint8Array(Buffer.from(v.startsWith('ss1:') ? safeStorage.decryptString(Buffer.from(v.slice(4), 'base64')) : v.startsWith('b64:') ? v.slice(4) : '', 'base64')),
  };
  let phoneLink: PhoneLink | null = null;
  const phoneIssueOf = (): PhoneIssue => {
    phoneIssue ??= new PhoneIssue({
      approver: (pairId) => phoneGateOf().canApprove(pairId),
      approveCode: (id) => phoneGate?.codeOf(id),
      counterparty: (ref) => cps.find((c) => c.id === ref) ?? null,
      createDraft: (cp, supply, item) => runs.createDraft(cp, supply, 'separate', item),
      prepare: (id) => prepareNow(id),
      anyActive: () => runs.anyActive(),
      retryCert: (id) => runs.retryCert(id),
      simpleAuth: (id, op, d) => runs.simpleAuth(id, op, d),
      get: (id) => runs.get(id),
      onDraft: () => pushBoard(),
      cmds: new CmdLog(path.join(appPaths(root ?? defaultAppRoot()).userData, 'remote-cmds.json')),
      log: (n, d) => log.event(n, d ?? {}),
      wake: (pairId, kind) => void phoneWaker.wake(pairId, kind),
    });
    return phoneIssue;
  };
  const wakeClient = opts.remote?.keys ? (opts.remote.cloud?.account ?? null) : null;
  const phoneWaker = new PhoneWaker({
    deviceOf: (pairId) => phoneLink?.deviceOf(pairId) ?? null,
    call: wakeClient
      ? async (deviceId, kind) => {
          const d = account.device();
          if (!d) throw Object.assign(new Error('account'), { code: 'account.signed_out' });
          try {
            return await wakeClient.wakePhone(d.auth, deviceId, kind);
          } catch (e) {
            if ((e as { code?: unknown }).code !== 'account.unauthorized' && (e as { code?: unknown }).code !== 'push.unauthorized') throw e;
            d.clearToken();
            return wakeClient.wakePhone(d.auth, deviceId, kind);
          }
        }
      : null,
    log: (n, d) => log.event(n, d),
  });
  const phoneGateOf = (): PhoneGate => {
    phoneGate ??= new PhoneGate({
      px: (pairId) => phoneLink?.px(pairId) ?? null,
      tracked: (id) => phoneIssue?.trackedOf(id) ?? null,
      poke: (id) => phoneIssue?.poke(id),
      wake: (pairId, kind) => void phoneWaker.wake(pairId, kind),
      attached: (pairId) => phoneWaker.forget(pairId),
      approvals: new ApprovalLog(path.join(appPaths(root ?? defaultAppRoot()).userData, 'remote-approvals.json')),
      log: (n, d) => log.event(n, d ?? {}),
    });
    return phoneGate;
  };
  runs.on('restart', (x: { from: string; to: string }) => phoneIssue?.relink(x.from, x.to));
  runs.on('update', (run) => {
    phoneIssue?.update(run);
    if (run.status !== 'waiting') phoneGate?.close(run.id, undefined, run.status === 'issuing' || run.status === 'done' ? 'pc' : 'stopped');
  });
  const phones = (): PhoneLink | null => {
    if (phoneLink) return phoneLink;
    const cloud = opts.remote?.cloud;
    if (fixture || !cloud?.mailboxQueue || !account.device()) return null;
    const auth = (htm: 'GET' | 'POST' | 'PUT' | 'DELETE', htu: string) => {
      const d = account.device();
      if (!d) return Promise.reject(Object.assign(new Error('account'), { code: 'account.signed_out' }));
      return d.auth(htm, htu);
    };
    const live = wsRelayClient({ host: cloud.relayHost, open: cloud.openSocket, insecureLocal: cloud.insecureLocal, deviceAuth: (htm, htu) => auth(htm, htu) });
    phoneLink = new PhoneLink({
      store: new PhoneStore(path.join(appPaths(root ?? defaultAppRoot()).userData, 'remote-phones.json')),
      seal: tokenSeal,
      keys: async () => {
        const k = (await keysOf()) as Partial<VaultDesktopKeys> & DesktopKeys;
        if (!k.hpkeOpen || !k.qdPublic) throw Object.assign(new Error('keys'), { code: 'account.keys_unavailable' });
        return { noise: k.noise, vd: k.vd, hpkeOpen: k.hpkeOpen, qdPublic: k.qdPublic };
      },
      joinMailbox: opts.remote?.relayClient ? undefined : (id, tok) => live.joinMailbox(id, tok, 'desktop'),
      queue: (id, tok) => cloud.mailboxQueue!(id, tok, auth),
      deleteMailbox: (id, w, peer) => cloud.relay.deleteMailbox(auth, id, w, peer),
      receiver: () =>
        phoneReceiver((m, p) => host.rpc(m, p), {
          onReceipt: () => pushBoard(),
          onCash: () => pushBoard(),
          log: (n, d) => log.event(n, d),
        }),
      deviceListVersion: () => account.device()?.deviceList.listVersion ?? 0,
      shareKeys: async (deviceId) => {
        const d = account.device();
        const vault = ((await keysOf()) as Partial<VaultDesktopKeys>).share;
        if (!d || !vault || !d.deviceList.entries.some((e) => e.entry.device_id === deviceId && e.entry.role === 'mobile')) return null;
        const keys: Uint8Array[] = [];
        try {
          let signPub: Uint8Array = new Uint8Array(0);
          for (let e = 0; e <= shareEpoch(d.deviceList); e++) {
            const r = await vault.key(e);
            keys.push(r.key);
            signPub = r.signPub;
          }
          return makeShareKeyBody({ signPub, keys });
        } finally {
          for (const k of keys) k.fill(0);
        }
      },
      appVersion: runVersion(app.isPackaged, process.env, () => app.getVersion()),
      capabilities: () => [...DESKTOP_CAPS, ...SESSION_CAPS, ...APPROVE_CAPS],
      session: phoneSession({
        issue: phoneIssueOf(),
        copy: (pairId, want) =>
          buildPhoneCopy({
            counterparties: () => cps,
            runs: () => runs.list(),
            bank: (m, p) => bank.call(m, p ?? {}),
            approval: async () => ({ approver: !!phoneLink?.px(pairId), left: await phoneGateOf().leftToday() }),
            ...(want.issued ? { issued: () => agentReads.issued(), today: () => kstToday(Date.now()) } : {}),
          }),
        approve: { gate: phoneGateOf(), enroll: (pairId, body) => (phoneLink ? phoneLink.enrollPx(pairId, body) : Promise.resolve({ state: 'rejected' as const, pxId: '0'.repeat(16) })) },
        log: (n, d) => log.event(n, d ?? {}),
      }),
      log: (n, d) => log.event(n, d ?? {}),
      onChange: () => {
        send({ type: 'account', account: account.view() });
        syncAwake();
      },
    });
    return phoneLink;
  };
  let deviceMgr: DeviceManager | null = null;
  const withApproval = (devices: DeviceView[]): Array<DeviceView & { approval?: PhoneView['approver'] }> => {
    const phones = phoneLink?.list() ?? [];
    return devices.map((d) => {
      if (d.role !== 'mobile') return d;
      const x = phones.find((ph) => ph.deviceId === d.deviceId);
      return x ? { ...d, approval: x.approver } : d;
    });
  };
  const devicesOf = (): DeviceManager => {
    const client = opts.remote?.cloud?.account;
    if (!client || !account.device()) throw new Error('account_required');
    return (deviceMgr ??= new DeviceManager({
      client,
      session: () => account.device(),
      aik: async () => (await keysOf()).aik,
      dropPhone: async (id) => void (await phones()?.removeDevice(id)),
      log: (n, d) => log.event(n, d),
    }));
  };
  let pcLinkHost: PcLinkHost | null = null;
  const pcLinkHostOf = (): PcLinkHost => {
    const client = opts.remote?.cloud?.account;
    const mgr = devicesOf();
    if (!client) throw new Error('account_required');
    return (pcLinkHost ??= new PcLinkHost({
      client,
      exclusive: (f) => mgr.exclusive(f),
      aik: async () => (await keysOf()).aik,
      vault: async () => linkVaultOf(await keysOf()),
      log: (n, d) => log.event(n, d),
    }));
  };
  const reconcileDevices = async (): Promise<void> => {
    try {
      if ((await devicesOf().reconcile()) > 0) {
        send({ type: 'account', account: account.view() });
        void phoneLink?.pushShareKeys();
      }
    } catch (e) {
      log.event('main.device_sync', { result: typeof (e as { code?: unknown }).code === 'string' ? ((e as { code: string }).code) : 'skipped' });
    }
  };
  const shareSync = new ShareSync({
    client: opts.remote?.keys ? (opts.remote.cloud?.account ?? null) : null,
    device: async () => {
      await accountInit();
      return account.device();
    },
    vault: async () => {
      const v = ((await keysOf()) as Partial<VaultDesktopKeys>).share;
      if (!v) throw Object.assign(new Error('keys'), { code: 'account.keys_unavailable' });
      return v;
    },
    store: engineShareStore((m, p) => host.rpc(m, p)),
    collect: () => host.rpc('share.collect'),
    refreshDeviceList: async () => {
      if ((await devicesOf().reconcile()) > 0) {
        send({ type: 'account', account: account.view() });
        void phoneLink?.pushShareKeys();
      }
    },
    log: (n, d) => log.event(n, d),
  });
  const syncShare = async (): Promise<void> => {
    const r = await shareSync.sync();
    if (r.parties > 0) {
      await refresh();
      pushBoard();
    }
  };
  const SHARE_EVERY_MS = 10 * 60_000;
  const shareTimer = setInterval(() => void syncShare().catch(() => undefined), SHARE_EVERY_MS);
  shareTimer.unref?.();
  const stayAwake = new StayAwake(powerSaveBlocker, (on) => log.event('main.phone_stay_awake', { on }));
  const pairedPhones = () => phoneLink?.list().length ?? 0;
  const syncAwake = () => stayAwake.set(shouldStayAwake({ phones: pairedPhones(), onBattery: powerMonitor.isOnBatteryPower() }));
  let quitting = false;
  let backgroundNoted = false;
  const onBeforeQuit = () => {
    quitting = true;
  };
  app.on('before-quit', onBeforeQuit);
  if (process.platform === 'darwin') nativeUpdater.on('before-quit-for-update', onBeforeQuit);
  win.on('close', (e) => {
    const act = closeAction({ phones: pairedPhones(), quitting, platform: process.platform });
    if (act === 'quit') return;
    e.preventDefault();
    if (act === 'hide') win.hide();
    else win.minimize();
    log.event('main.window_background', { act });
    if (!backgroundNoted) {
      backgroundNoted = true;
      try {
        showOsNotification({ title: '소버린 AX가 계속 켜져 있어요', body: '폰에서 보낸 영수증을 바로 받으려고 창만 내렸어요. 끝내려면 메뉴 [창 > 소버린 AX 끝내기]를 누르세요.' }, () => onActivate());
      } catch {
        /* 알림을 못 띄우는 OS */
      }
    }
  });
  const onActivate = () => {
    if (win.isDestroyed()) return;
    if (win.isMinimized()) win.restore();
    win.show();
  };
  app.on('activate', onActivate);
  const onPowerSource = () => syncAwake();
  powerMonitor.on('on-ac', onPowerSource);
  powerMonitor.on('on-battery', onPowerSource);
  void accountInit()
    .then(() => phones()?.start())
    .then(() => syncAwake())
    .then(() => reconcileDevices())
    .then(() => syncShare())
    .catch(() => undefined);
  const onbView = async () => (onb && onbShow ? await onb.view() : null);
  const termsOk = () => !onb || onb.state.consents.terms?.choice === 'agreed';
  const modelOk = () => !onb || onb.modelAllowed();
  const loginRequired = !fixture;
  const signedIn = async () => {
    await accountInit().catch(() => null);
    return account.view().step === 'signed_in';
  };
  const needLogin = async () => {
    if (loginRequired && !(await signedIn())) throw new Error('account_required');
  };
  const setupGate = (parsed: Parsed) => {
    if (profile !== 'business') return null;
    if (!(parsed.intent === 'invoice' || parsed.intent === 'cert' || answersPending(parsed, runs))) return null;
    const needsHometax = parsed.intent !== 'cert' || (!!parsed.cert && !certDocByCode(parsed.cert)?.hidden);
    const needsChrome = needsHometax && !chromeReady();
    const needsSecurity = needsHometax && securityMissing();
    const missing: SetupItem[] = [...setupMissing(profiles().business), ...(needsChrome ? (['chrome'] as const) : []), ...(needsSecurity ? (['security'] as const) : [])];
    if (!missing.length) return null;
    runs.pending.asked = null;
    return { kind: 'setup' as const, text: setupText(parsed.intent === 'cert' ? 'cert' : 'invoice', missing), missing: missing.map((id) => ({ id, label: SETUP_LABEL[id] })) };
  };

  const bankAutoH = bankAuto.handlers;
  const pastNow = async (): Promise<PastRun[]> => [...(await readPastRuns((m, p) => host.rpc(m, p), (n, d) => log.event(n, d))), ...(seed?.past ?? [])];
  const pack = new AccountantPack({
    past: async () => [...(await readPastRuns((m, p) => host.rpc(m, p), (n, d) => log.event(n, d), 200)), ...(seed?.past ?? [])],
    docs: () => listDocs(),
    docFile,
    receivables: () => bank.receivables(),
    businessName: () => (businessId || sample ? profiles().business.name || null : null),
    businessBizNo: () => (businessId ? profiles().business.bizNo || null : null),
    paperInvoices: async (month) => {
      if (!businessId) return [];
      const [y, m] = [Number(month.slice(0, 4)), Number(month.slice(5, 7))];
      const next = m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
      const out: Array<{ docId: string; paper: PaperInvoice; file: string | null }> = [];
      for (const mm of [month, next]) {
        const r = (await host.rpc('db.query.receipt.list', { profileId: businessId, month: mm }).catch(() => null)) as { receipts?: Array<{ docId: string; phoneOcr?: { paperInvoice?: PaperInvoice } | null }> } | null;
        for (const x of r?.receipts ?? []) {
          const paper = x.phoneOcr?.paperInvoice;
          if (!paper || out.some((o) => o.docId === x.docId)) continue;
          out.push({ docId: x.docId, paper, file: await docFile(x.docId).catch(() => null) });
        }
      }
      return out;
    },
    outRoot: path.join(appPaths(root ?? defaultAppRoot()).userData, '세무사 꾸러미'),
  });
  const packMonth = (m: unknown) => {
    if (!isPackMonth(m)) throw new Error('bad_request');
    return m;
  };
  const packZip = async (m: unknown) => {
    const f = pack.zipPath(packMonth(m));
    if (!(await fs.stat(f).then((x) => x.isFile(), () => false))) throw new Error('pack_missing');
    return f;
  };

  let reverifying: Promise<void> | null = null;
  const reverify = (exclude: string | null) => {
    if (reverifying || runs.anyActive()) return;
    reverifying = (async () => {
      const read = () => readPastRuns((m, p) => host.rpc(m, p), (n, d) => log.event(n, d));
      if (!(await read()).some((p) => p.kind === 'unsure' && p.runId !== exclude)) return;
      const r = (await host.rpc('run.reverify', exclude ? { exclude } : {})) as { ok?: boolean; code?: string; checked?: number; committed?: number; unknown?: number; skipped?: number };
      log.event('main.reverify', { ok: r?.ok === true, code: r?.code ?? '', checked: r?.checked ?? 0, committed: r?.committed ?? 0, unknown: r?.unknown ?? 0, skipped: r?.skipped ?? 0 });
      if (!r?.committed) return;
      const past = await pastNow();
      for (const p of past) if (p.kind === 'issued' && p.approvalNo) runs.reverified(p.runId, p.approvalNo);
      send({ type: 'past', past });
      pushBoard();
    })()
      .catch((e: Error) => log.event('main.reverify_failed', { error: e.message.slice(0, 60) }))
      .finally(() => (reverifying = null));
  };
  host.on('run', (e: { type?: string; runId?: string }) => {
    if (e.type === 'end') setTimeout(() => reverify(typeof e.runId === 'string' ? e.runId : null), 3_000);
    if (e.type === 'end') setTimeout(() => void syncShare().catch(() => undefined), 15_000).unref?.();
  });

  let mirrorRun: string | null = null;

  const CHROME_BEHIND = { width: 1280, height: 900 };
  function sendBrowserState(focus = false) {
    send({ type: 'browser', shown: browserShown, available: browserAvailable, ...(embedded ? { embedded: true, width: panelNow() } : {}), ...(focus ? { focus: true } : {}) });
  }
  const placeBehind = async (): Promise<boolean> => {
    if (embedded) {
      browserAvailable = true;
      return true;
    }
    if (win.isDestroyed()) return false;
    const c = win.getContentBounds();
    const r = (await host.control('browser.place', { x: c.x, y: c.y, ...CHROME_BEHIND, front: false }).catch(() => null)) as { placed?: unknown } | null;
    if (r?.placed !== true) return false;
    browserAvailable = true;
    if (process.platform === 'darwin') app.focus({ steal: true });
    win.moveTop();
    win.focus();
    log.event('main.chrome_placed', { front: false, width: CHROME_BEHIND.width });
    return true;
  };
  const setPanelBig = (big: boolean, focus = false) => {
    if (browserShown === big && !focus) return;
    browserShown = big;
    sendBrowserState(focus);
    if (embedded) bar.layoutChanged();
    if (focus) eb?.focus();
  };
  const resizeBrowser = (width: number) => {
    if (!embedded || !browserAvailable) return { width: panelNow() };
    browserWant = Math.round(width);
    browserShown = false;
    sendBrowserState();
    bar.layoutChanged();
    return { width: panelNow() };
  };
  const placeBrowser = (r: { x: number; y: number; width: number; height: number } | null) => {
    if (!eb) return {};
    if (!r || !browserAvailable || win.isDestroyed()) return eb.setSlot(null), {};
    const [cw, ch] = win.getContentSize() as [number, number];
    const left = cw - panelNow();
    const x = Math.max(left, Math.round(r.x));
    const y = Math.max(SHELL.titlebar, Math.round(r.y));
    const right = Math.min(cw, Math.round(r.x + r.width));
    const bottom = Math.min(ch, Math.round(r.y + r.height));
    eb.setSlot(right - x >= 80 && bottom - y >= 80 ? { x, y, width: right - x, height: bottom - y } : null);
    return {};
  };
  win.on('resize', () => {
    if (embedded && browserAvailable) sendBrowserState();
  });
  const panelBrowserInput = async (p: Record<string, unknown>) => {
    if (!mirrorRun || embedded) return { ok: false };
    if (!panelInput.within(performance.now(), 1_000)) throw new Error('gesture_required');
    const r = (await host.control('screen.input', p).catch(() => null)) as { ok?: unknown } | null;
    return { ok: r?.ok === true };
  };
  const businessRow = async () => ((await host.rpc('db.query.profiles.list', {})) as DbProfile[]).find((x) => x.kind === 'business');
  const certNameStatus = async () => {
    const name = (await businessRow())?.certName ?? null;
    return { set: !!name, owner: name ? name.replace(/\(\)[0-9A-Za-z]*$/, '').trim().slice(0, 60) : null };
  };
  const clearCertName = async () => {
    const p = await businessRow();
    if (p?.certName) await host.rpc('profile.setCertName', { id: p.id, name: null });
    log.event('main.cert_name_cleared', { had: p?.certName ? 1 : 0 });
    return { set: false, owner: null };
  };
  const showRunBrowser = async (id: string) => {
    if (!runs.isActive(id)) throw new Error('not_running');
    setPanelBig(true, true);
    return { focused: true };
  };
  const toggleBrowser = async (show: boolean) => {
    setPanelBig(show, show);
    return { shown: show };
  };
  let followTimer: NodeJS.Timeout | null = null;
  const follow = () => {
    if (!browserAvailable || !mirrorRun || embedded) return;
    if (followTimer) clearTimeout(followTimer);
    followTimer = setTimeout(() => {
      followTimer = null;
      void placeBehind();
    }, 120);
  };
  win.on('move', follow);
  win.on('resize', follow);
  const mirrorTick = setInterval(() => {
    if (embedded) return;
    const r = mirrorRun ? runs.get(mirrorRun) : undefined;
    if (r && runs.isActive(r.id) && r.status !== 'draft') void host.control('screen.start').catch(() => {});
  }, 1_000);
  mirrorTick.unref();
  runs.on('update', (r: RunView) => {
    const live = runs.isActive(r.id) && r.status !== 'draft';
    if (live && mirrorRun !== r.id) {
      mirrorRun = r.id;
      browserAvailable = true;
      sendBrowserState();
      if (embedded) bar.layoutChanged();
      else void host.control('screen.start').catch(() => {});
    } else if (!live && mirrorRun === r.id) {
      mirrorRun = null;
      browserAvailable = false;
      browserShown = false;
      sendBrowserState();
      send({ type: 'screen', runId: r.id, ended: true });
      if (embedded) {
        eb?.setSlot(null);
        bar.layoutChanged();
      } else void host.control('screen.stop').catch(() => {});
    }
  });
  const chromeSpot = new Map<string, string>();
  runs.on('update', (r: RunView) => {
    if (!runs.isActive(r.id) || r.status === 'draft') {
      chromeSpot.delete(r.id);
      return;
    }
    const turn = r.status === 'turn' ? `turn:${r.handoff?.phase ?? ''}` : r.status === 'issuing' && !r.cert && r.steps[5]?.state === 'now' ? 'sign' : null;
    const want = turn ?? 'back';
    if (chromeSpot.get(r.id) === want) return;
    if (want === 'back' && chromeSpot.has(r.id)) {
      if (chromeSpot.get(r.id) !== 'back') chromeSpot.set(r.id, 'away');
      return;
    }
    chromeSpot.set(r.id, want);
    if (turn) {
      setPanelBig(true, true);
      return;
    }
    void (async () => {
      for (let i = 0; i < 40 && chromeSpot.get(r.id) === 'back' && runs.isActive(r.id); i++) {
        if (await placeBehind()) return;
        await new Promise((res) => setTimeout(res, 500));
      }
    })();
  });

  const CERT_SLOT = { kind: 'cert_password', scope: 'business' } as const;
  const certMemory = {
    has: async () => (await host.control('secret.has', CERT_SLOT).catch(() => false)) === true,
    forget: async (why: string) => {
      const r = await host.control('secret.forget', CERT_SLOT).catch(() => false);
      log.event('main.cert_memory_forget', { why, removed: r === true });
    },
  };
  host.on('run', (e: { type?: string; code?: string }) => {
    if ((e.type === 'handoff' || e.type === 'end') && (e.code === 'sign.password_wrong' || e.code === 'sign.password_retry_limit')) void certMemory.forget(e.code);
  });
  const handlers: ShellHandlers = {
    'bankAuto.status': () => bankAutoH['bankAuto.status'](),
    'bankAuto.certs': () => bankAutoH['bankAuto.certs'](),
    'bankAuto.consent': (p) => {
      needGesture(3_000);
      return bankAutoH['bankAuto.consent'](p);
    },
    'bankAuto.connect': async (p) => {
      needGesture(3_000);
      await needLogin();
      return bankAutoH['bankAuto.connect'](p);
    },
    'bankAuto.choose': (p) => {
      needGesture(3_000);
      return bankAutoH['bankAuto.choose'](p);
    },
    'bankAuto.sms': (p) => {
      needGesture(3_000);
      return bankAutoH['bankAuto.sms'](p);
    },
    'bankAuto.refresh': async () => {
      needGesture(3_000);
      await needLogin();
      return bankAutoH['bankAuto.refresh']();
    },
    'bankAuto.cancel': () => bankAutoH['bankAuto.cancel'](),
    'bankAuto.disconnect': () => {
      needGesture(3_000);
      return bankAutoH['bankAuto.disconnect']();
    },
    'shell.bootstrap': async () => (setTimeout(() => void restoreRuns(), 1_000).unref(), {
      board: await bootBoard(),
      layout: SHELL,
      profiles: profiles(),
      profile,
      counterparties: cps,
      docs: await listDocs(),
      timeline: sample ? sample.timeline() : [],
      quick: sample ? sample.quick : QUICK.filter((q) => q.label === '세금계산서 발급' || q.cert || q.soon),
      sample: !!sample,
      platform: process.platform,
      loginRequired,
      build: opts.buildBadges ?? [],
      past: await pastNow(),
      onboarding: await onbView(),
      cpBook: fixture ? 'demo' : 'local',
      profileEdits: editLog.list(),
      authReopen: !!onb,
    }),
    'profile.set': (p) => {
      if (p.kind !== 'business' && p.kind !== 'personal') throw new Error('bad_profile');
      profile = p.kind;
      return { profile };
    },
    'request.send': async (p) => {
      sendByUser = gesture.within(performance.now(), 2_000);
      const vat = p.vat === 'separate' || p.vat === 'included' ? (p.vat as Vat) : null;
      if (!termsOk()) throw new Error('onboarding_terms');
      await needLogin();
      const text = String(p.text ?? '').slice(0, 2000);
      const t0 = performance.now();
      const local = parseRegex(text, runs.counterparties);
      if (profile === 'business' && local.cert) return (certDocByCode(local.cert)?.hidden ? null : setupGate(local)) ?? finishReply(interpret(text, vat, profile, runs, local), 'offline', null, []);
      const packFor = profile === 'business' ? packAsk(text, kstToday(Date.now())) : null;
      if (packFor) return { kind: 'pack', pack: await pack.make(packFor), via: 'l0', note: null, sent: [] };
      if (demo) {
        const ask = modelOk() && !!text.trim();
        const model = ask ? await demo.parse(text, runs.counterparties.map((c) => c.name)) : null;
        const via = model ? 'model' : 'offline';
        log.event('main.interpret', { via, ms: Math.round(performance.now() - t0) });
        const parsed = model && dev ? dev.mergeParsed(model, local, text) : local;
        return setupGate(parsed) ?? finishReply(interpret(text, vat, profile, runs, parsed), via, null, ask ? ['openrouter_demo'] : []);
      }
      const g24Ask = local.intent === 'resident_copy' || local.intent === 'resident_abstract';
      if (profile === 'business' && (!fixture || opts.agent) && !g24Ask) {
        if (!text.trim()) return { kind: 'say', text: EMPTY_REQUEST_TEXT, via: 'model', note: null, sent: [] };
        if (!modelOk()) return { kind: 'say', text: MODEL_CONSENT_FIRST_TEXT, via: 'model', note: null, sent: [] };
        const mark = gwSeq;
        agentCreated = [];
        const r = await agent.turn(text);
        const sent = sentFromGateway(gwIssuedSince(mark));
        for (const run of agentCreated) {
          run.interp = 'model';
          run.sent = sent;
        }
        if (agentCreated.length) pushBoard();
        const batched = runs.makeBatch(agentCreated.map((x) => x.id));
        if (sendByUser) for (const run of batched ? agentCreated.filter((x) => x.batch?.index === 0) : agentCreated) autoPrepare(run.id);
        log.event('main.agent', r.kind === 'agent' ? { result: 'ok', filtered: r.filtered ?? 'none', show: r.show.length, ask: r.ask?.kind ?? 'none', ms: Math.round(performance.now() - t0) } : r.kind === 'reaction' ? { result: 'reaction', reaction: r.reaction, ms: Math.round(performance.now() - t0) } : { result: r.code, ms: Math.round(performance.now() - t0) });
        if (r.kind === 'unavailable') return { kind: 'unavailable', text: r.text, retry: r.retry, via: 'model', note: null, sent };
        if (r.kind === 'reaction') return { kind: 'reaction', reaction: r.reaction, via: 'model', note: null, sent };
        type Shown = { type: 'card'; run: RunView } | Extract<(typeof r.show)[number], { type: 'table' }>;
        const show = r.show.flatMap((x): Shown[] => {
          if (x.type !== 'card') return [x];
          const run = runs.get(x.runId);
          return run ? [{ type: 'card', run }] : [];
        });
        const missing: SetupItem[] = r.setup ? [...setupMissing(profiles().business), ...(chromeReady() ? [] : (['chrome'] as const)), ...(securityMissing() ? (['security'] as const) : [])] : [];
        return { kind: 'agent', text: r.text, show, ask: r.ask, filtered: r.filtered, setup: missing.map((id) => ({ id, label: SETUP_LABEL[id] })), unknown: r.unknown ?? null, via: 'model', note: null, sent };
      }
      if (fixture && !opts.intent) return setupGate(local) ?? finishReply(interpret(text, vat, profile, runs, local), 'offline', null, []);
      if (!text.trim()) return { kind: 'say', text: EMPTY_REQUEST_TEXT, via: 'model', note: null, sent: [] };
      if (!modelOk()) return { kind: 'say', text: MODEL_CONSENT_FIRST_TEXT, via: 'model', note: null, sent: [] };
      const mark = gwSeq;
      const r = await intent.resolve(text);
      log.event('main.interpret', { path: r.route ? `engine.${r.route.via}` : `unavailable.${r.fallback ?? 'none'}`, outcome: r.route?.outcome ?? 'unavailable', ms: Math.round(performance.now() - t0) });
      if (!r.route) return { kind: 'unavailable', text: INTENT_UNAVAILABLE_TEXT, retry: true, via: 'model', note: null, sent: sentFromGateway(gwIssuedSince(mark)) };
      const via = 'model';
      if (r.route.outcome === 'unknown' && !answersPending(local, runs, text)) {
        const c = await chatReply.respond(text);
        const sent = sentFromGateway(gwIssuedSince(mark));
        log.event('main.chat', 'reply' in c ? { result: 'ok', kind: c.reply.kind, filtered: c.reply.filtered ?? 'none', suggest: c.reply.suggest.length } : { result: c.error });
        if ('error' in c) return { kind: 'unavailable', ...CHAT_ERROR_TEXT[c.error], via, note: null, sent };
        runs.pending.asked = null;
        return { kind: 'chat', text: c.reply.reply, suggest: suggestChips(c.reply.suggest), filtered: c.reply.filtered, via, note: null, sent };
      }
      const sent = sentFromGateway(gwIssuedSince(mark));
      const to = routed(r.route, local);
      if ('say' in to) {
        runs.pending.asked = null;
        return { kind: 'say', text: to.say, via, note: null, sent };
      }
      const gate = setupGate(to.parsed);
      if (gate) return { ...gate, via, note: to.note, sent };
      return finishReply(interpret(text, vat, profile, runs, to.parsed), via, to.note, sent);
    },
    'run.redraft': (p) => {
      const d = runs.redraft(String(p.id));
      pushBoard();
      return d;
    },
    'draft.update': (p) =>
      runs.updateDraft(String(p.id), {
        vat: p.vat === 'separate' || p.vat === 'included' ? p.vat : undefined,
        amount: typeof p.amount === 'number' ? p.amount : undefined,
        amountText: typeof p.amountText === 'string' ? p.amountText.slice(0, 100) : undefined,
        item: typeof p.item === 'string' ? p.item : undefined,
        email: typeof p.email === 'string' ? p.email : undefined,
        counterpartyId: typeof p.counterpartyId === 'string' ? p.counterpartyId : undefined,
      }),
    'run.prepare': async (p) => {
      needGesture(2_000);
      const id = String(p.id);
      if (queueIfBusy(id)) return runs.get(id);
      return prepareNow(id);
    },
    'run.stop': (p) => runs.stop(String(p.id)),
    'run.retryCert': (p) => {
      needGesture(3_000);
      return runs.retryCert(String(p.id));
    },
    'run.simpleDone': (p) => {
      needGesture(3_000);
      return runs.simpleAuth(String(p.id), 'complete');
    },
    'run.resume': (p) => {
      needGesture(3_000);
      return runs.resume(String(p.id));
    },
    'run.manualDone': (p) => {
      needGesture(3_000);
      return runs.manualDone(String(p.id));
    },
    'run.showBrowser': async (p) => {
      needGesture(3_000);
      return showRunBrowser(String(p.id));
    },
    'browser.toggle': async (p) => {
      needGesture(3_000);
      return toggleBrowser(p.show === true);
    },
    'browser.input': (p) => panelBrowserInput(p as Record<string, unknown>),
    'browser.slot': (p) => placeBrowser(p.none === true ? null : { x: Number(p.x), y: Number(p.y), width: Number(p.width), height: Number(p.height) }),
    'browser.resize': (p) => resizeBrowser(Number(p.width)),
    'incident.open': (p) => {
      needGesture(3_000);
      return incidents.open(String(p.id));
    },
    'incident.close': (p) => incidents.close(String(p.id)),
    'docs.list': () => listDocs(),
    'issued.list': () => pastNow(),
    'pack.make': (p) => pack.make(packMonth(p.month)),
    'pack.reveal': async (p) => {
      needGesture(3_000);
      desktop.showItemInFolder(await packZip(p.month));
      return {};
    },
    'pack.share': async (p) => {
      needGesture(3_000);
      const file = await packZip(p.month);
      if (process.platform !== 'darwin') {
        desktop.showItemInFolder(file);
        return { via: 'folder' };
      }
      new ShareMenu({ filePaths: [file] }).popup({ window: win });
      return { via: 'share' };
    },
    'docs.import': docsCall(async (p) => {
      if (p.pick !== true && typeof p.pickId !== 'string') throw new Error('bad_request');
      if (typeof p.pickId !== 'string') needGesture(3_000);
      if (importing) throw new Error('busy');
      importing = true;
      try {
        return await docs.importPdf({ pickId: p.pickId, password: p.password });
      } finally {
        importing = false;
      }
    }),
    'docs.importCancel': (p) => {
      cancelPick(p.pickId);
      return {};
    },
    'docs.update': docsCall((p) => {
      const patch = (p.patch ?? {}) as Record<string, unknown>;
      const seen = (p.seen ?? {}) as Record<string, unknown>;
      return docs.update(String(p.id), { docType: patch.docType, issuedOn: patch.issuedOn, expiresOn: patch.expiresOn }, { docType: seen.docType, issuedOn: seen.issuedOn, expiresOn: seen.expiresOn });
    }),
    'docs.open': docsCall(async (p) => {
      needGesture(3_000);
      if (!openRate.take(performance.now())) throw new Error('throttled');
      const file = await docFile(String(p.id));
      if (path.extname(file).toLowerCase() !== '.pdf') throw new Error('open_failed');
      if (await desktop.openPath(file)) throw new Error('open_failed');
      return {};
    }),
    'docs.reveal': docsCall(async (p) => {
      needGesture(3_000);
      if (!openRate.take(performance.now())) throw new Error('throttled');
      desktop.showItemInFolder(await docFile(String(p.id)));
      return {};
    }),
    'counterparty.save': async (p) => {
      const saved = await cpBook.save(p);
      if (fixture) delete fixture.itemHints[saved.bizNo];
      try {
        await cpBook.setFirstItem(saved.id, p.item);
      } finally {
        await refresh();
      }
      return { id: saved.id, counterparties: cps };
    },
    'counterparty.readCert': () => {
      needGesture(3_000);
      return cpBook.readCert();
    },
    'counterparties.list': async () => {
      await refresh();
      return cps;
    },
    'profiles.list': async () => {
      await refresh();
      return profiles();
    },
    'g24.candidates': (p) => (sample ? sample.g24Candidates(g24Doc(p.doc), Number(p.startedAt)) : []),
    'g24.save': (p) => store.g24Save(String(p.id), g24Doc(p.doc)),
    'account.view': async () => {
      await accountInit();
      return account.view();
    },
    'account.sendCode': async (p) => {
      needGesture(3_000);
      await accountInit();
      return account.sendCode(String(p.email), p.signup === true);
    },
    'account.verify': async (p) => {
      needTyping(3_000);
      await accountInit();
      return watchLink(await account.verify(String(p.code)));
    },
    'account.password': async (p) => {
      needGesture(3_000);
      await accountInit();
      return watchLink(await account.passwordLogin(String(p.email), p.password));
    },
    'account.setPassword': async (p) => {
      needGesture(3_000);
      await accountInit();
      return account.setPassword(p.password);
    },
    'account.skipPassword': async () => {
      await accountInit();
      return account.skipPassword();
    },
    'account.startReset': async (p) => {
      needGesture(3_000);
      await accountInit();
      return account.startReset(String(p.email));
    },
    'account.finishReset': async (p) => {
      needTyping(3_000);
      await accountInit();
      return watchLink(await account.finishReset(String(p.code), p.password));
    },
    'account.back': async () => {
      await accountInit();
      return account.back();
    },
    'account.signOut': async () => {
      needGesture(3_000);
      await accountInit();
      if (runs.anyActive()) throw new Error('run_active');
      pairReset();
      phoneLink?.stop();
      phoneLink = null;
      syncAwake();
      const v = watchLink(await account.signOut());
      pushBoard();
      return v;
    },
    'billing.view': async () => billingCall((c, a) => c.billing(a)),
    'billing.subscribe': async () => {
      needGesture(3_000);
      const { checkoutUrl } = await billingCall<{ checkoutUrl: string }>((c, a) => c.billingCheckout(a));
      await (opts.billingOpen ?? openBillingCheckout)(checkoutUrl, opts.remote?.cloud?.accountOrigin ?? CLOUD_ORIGIN);
      log.event('main.billing_checkout_opened');
      return {};
    },
    'billing.cancel': async () => {
      needGesture(3_000);
      await billingCall((c, a) => c.billingCancel(a));
      log.event('main.billing_canceled');
      return billingCall((c, a) => c.billing(a));
    },
    'billing.refund': async () => {
      needGesture(3_000);
      const r = await billingCall<{ amountKrw: number }>((c, a) => c.billingRefund(a));
      log.event('main.billing_refunded');
      return { ...(await billingCall<BillingView>((c, a) => c.billing(a))), refundedKrw: r.amountKrw };
    },
    'account.deletion': async () => {
      await accountInit();
      const d = account.device();
      if (!d) throw new Error('account_signed_out');
      return d.deletion();
    },
    'account.delete': async () => {
      needGesture(3_000);
      await accountInit();
      const d = account.device();
      if (!d) throw new Error('account_signed_out');
      const r = await d.requestDelete();
      log.event('main.account_delete_request', { result: 'ok' });
      return r;
    },
    'account.deleteCancel': async () => {
      needGesture(3_000);
      await accountInit();
      const d = account.device();
      if (!d) throw new Error('account_signed_out');
      await d.cancelDelete();
      log.event('main.account_delete_cancel', { result: 'ok' });
      return { deleteAfter: null };
    },
    'pair.open': async () => {
      needGesture(3_000);
      await accountInit();
      await reconcileDevices();
      return pairing().start();
    },
    'pair.view': async () => pairHost?.view() ?? { step: 'idle', qr: null, expiresAt: null, phoneName: null, triesLeft: null, error: null },
    'pair.submit': async (p) => {
      needTyping(3_000);
      return pairing().submitSas(String(p.code).slice(0, 6));
    },
    'pair.retry': async () => {
      needGesture(3_000);
      await accountInit();
      await reconcileDevices();
      const h = pairing();
      h.cancel();
      return h.start();
    },
    'pair.cancel': async () => pairHost?.dismiss() ?? { step: 'idle', qr: null, expiresAt: null, phoneName: null, triesLeft: null, error: null },
    'devices.list': async () => {
      await accountInit();
      return { devices: withApproval(await devicesOf().list()) };
    },
    'devices.px': async (p) => {
      needGesture(3_000);
      await accountInit();
      const id = String(p.deviceId);
      const pairs = (phoneLink?.list() ?? []).filter((x) => x.deviceId === id);
      if (!pairs.length) throw new Error('device.not_phone');
      for (const x of pairs) await (p.on === true ? phoneLink!.allowPx(x.pairId) : phoneLink!.revokePx(x.pairId));
      return { devices: withApproval(await devicesOf().list()) };
    },
    'devices.unlink': async (p) => {
      needGesture(3_000);
      await accountInit();
      const devices = await devicesOf().unlink(String(p.deviceId));
      send({ type: 'account', account: account.view() });
      syncAwake();
      void phoneLink?.pushShareKeys();
      return { devices };
    },
    'devices.leave': async () => {
      needGesture(3_000);
      await accountInit();
      if (runs.anyActive()) throw new Error('run_active');
      await devicesOf().leave();
      pairReset();
      phoneLink?.stop();
      phoneLink = null;
      deviceMgr = null;
      pcLinkHost = null;
      syncAwake();
      const v = watchLink(await account.signOut());
      pushBoard();
      return v;
    },
    'account.linkAccept': async () => {
      needGesture(3_000);
      await accountInit();
      const v = watchLink(await account.linkAccept());
      if (v.step === 'signed_in') pushBoard();
      return v;
    },
    'account.linkCancel': async () => {
      needGesture(3_000);
      await accountInit();
      return watchLink(await account.linkCancel());
    },
    'pclink.list': async () => {
      await accountInit();
      return { requests: await pcLinkHostOf().list() };
    },
    'pclink.begin': async (p) => {
      needGesture(3_000);
      await accountInit();
      return { requests: await pcLinkHostOf().begin(String(p.deviceId)) };
    },
    'pclink.confirm': async (p) => {
      needGesture(3_000);
      await accountInit();
      const r = await pcLinkHostOf().confirm(String(p.deviceId), String(p.code));
      if (r.ok) send({ type: 'account', account: account.view() });
      return r;
    },
    'pclink.reject': async (p) => {
      needGesture(3_000);
      await accountInit();
      return { requests: await pcLinkHostOf().reject(String(p.deviceId)) };
    },
    'onboarding.reply': async (p) => {
      needGesture(3_000);
      if (!onb) throw new Error('onboarding_done');
      if (p.step !== 'terms') await needLogin();
      const r = await onb.answer({ step: p.step, choice: p.choice, fields: p.fields, certId: p.certId, tasks: p.tasks } as Parameters<OnboardingFlow['answer']>[0]);
      if (onb.done) pushBoard();
      return { onboarding: await onbView(), fill: r.fill ?? null, profiles: profiles() };
    },
    'certMemory.status': async () => ({ remembered: await certMemory.has() }),
    'certName.status': () => certNameStatus(),
    'certName.clear': async () => {
      needGesture(3_000);
      return clearCertName();
    },
    'certMemory.forget': async () => {
      needGesture(3_000);
      await certMemory.forget('user');
      return { remembered: await certMemory.has() };
    },
    'certMemory.save': async (p) => {
      needGesture(3_000);
      return saveCertMemory((p as { value?: unknown }).value);
    },
    'secret.answer': (p) => {
      needGesture(3_000);
      return answerSecret(p as { reqId?: unknown; value?: unknown; cancel?: unknown });
    },
    'security.check': async () => {
      const st = securityNow();
      pushBoard();
      return st;
    },
    'security.install': async () => {
      needGesture(3_000);
      const st = securityNow();
      if (!st.installKey) throw new Error('no_installer');
      await (opts.security?.install ?? openExternalKey)(st.installKey);
      log.event('main.security_install_open', { platform: process.platform === 'darwin' ? 1 : 0 });
      return { opened: true };
    },
    'legal.open': async (p) => {
      needGesture(3_000);
      await openExternalKey(p.doc === 'privacy' ? 'legal.privacy' : 'legal.terms');
      return { opened: true };
    },
    'security.start': async () => {
      needGesture(3_000);
      const ok = opts.security?.start ? opts.security.start() : startSecurityProgram();
      for (let i = 0; i < 20 && ok && securityBlocks(securityNow()); i++) await new Promise((r) => setTimeout(r, 250));
      const st = securityNow();
      pushBoard();
      return st;
    },
    'chrome.check': async () => {
      const ready = chromeReady();
      pushBoard();
      return { ready };
    },
    'onboarding.reopen': async (p) => {
      needGesture(3_000);
      await needLogin();
      if (!onb) throw new Error('onboarding_unavailable');
      await onb.reopen(p.item as 'biz' | 'auth');
      onbShow = true;
      pushBoard();
      return { onboarding: await onbView(), profiles: profiles() };
    },
    'profile.edit': async (p) => {
      needGesture(3_000);
      await needLogin();
      if (onb && !onb.done) throw new Error('onboarding_open');
      const r = await editor.save((p.fields ?? {}) as Record<string, unknown>, p.confirmUnverified === true);
      return { ...r, profiles: profiles(), edits: editLog.list() };
    },
    ...bankShellHandlers(bank, () => pushBoard()),
    'bank.pickStatement': () => {
      needGesture(3_000);
      return bank.pickStatement();
    },
    'bank.refresh': (p) => {
      needGesture(3_000);
      return bank.call('bank.refresh', { accountId: p.accountId });
    },
    'bank.pickInvoices': async () => {
      needGesture(3_000);
      const r = await bank.pickInvoices();
      pushBoard();
      return r;
    },
    'profile.readCert': async () => {
      needGesture(3_000);
      await needLogin();
      if (readingCert) throw new Error('busy');
      readingCert = true;
      try {
        const f = await readOwnCert();
        if (f === null) return { found: false, reason: 'cancelled' };
        if (f === 'unreadable') return { found: false, reason: 'unreadable' };
        return { found: true, fields: f };
      } finally {
        readingCert = false;
      }
    },
    'clipboard.copy': (p) => {
      clipboard.writeText(String(p.text ?? '').slice(0, 200));
      return {};
    },
  };

  ipcMain.handle('sax', async (e, req: { method?: unknown; params?: unknown }) => {
    if (e.sender !== wc || e.senderFrame?.url !== SHELL_URL) throw new Error('forbidden');
    return dispatchShell(e.senderFrame, SHELL_URL, handlers, req);
  });

  const startAppUpdater = async (w: UpdateWiring): Promise<UpdateHost | null> => {
    try {
      const { electronInstaller } = await import('./update-electron.ts');
      const { egressUpdateSources } = await import('./update-sources.ts');
      const eu = (await import('electron-updater')).default;
      const u = w.updater ?? (eu.autoUpdater as unknown as AppUpdaterLike);
      const trust = w.trust ?? ((await host.rpc('db.query.registry.pins', {})) as TrustRoot);
      const revocation = async (): Promise<Revocation> => {
        const r = (await host.rpc('db.query.registry.revocation', {})) as { keyIds?: unknown; fresh?: unknown } | null;
        return { keyIds: new Set(Array.isArray(r?.keyIds) ? r.keyIds.filter((k): k is string => typeof k === 'string') : []), fresh: r?.fresh === true };
      };
      const h = startUpdateHost({
        sources: egressUpdateSources({ egress: w.egress, trust, revocation }),
        installer: electronInstaller(u, { origin: w.origin, channel: w.channel, Provider: eu.Provider as unknown as ProviderBase, loopback: w.loopback, relaunch: w.relaunch }),
        channel: w.channel,
        installedVersion: app.getVersion(),
        stateFile: path.join(appPaths(root ?? defaultAppRoot()).userData, 'updater-state.json'),
        policy: updatePolicy({ testBuild: w.testBuild, setting: w.setting, log: (n, d) => log.event(n, d) }),
        idle: () => {
          const list = runs.list();
          return {
            runActive: list.some((r) => runs.isActive(r.id)),
            commitZone: bar.visible || list.some((r) => r.status === 'issuing' || r.inDoubt === true),
            daemonRunning: false,
          };
        },
        onStale: () => {
          try {
            showOsNotification({ title: '소버린 AX', body: '14일 동안 업데이트를 확인하지 못했어요. 인터넷 연결을 확인해 주세요.' }, () => {});
          } catch {
            // 알림을 못 띄우는 환경이면 로그(main.update_stale_notice)만 남는다
          }
        },
        log: (n, d) => log.event(n, d),
      });
      void registrySync('update').finally(() => void h.check());
      return h;
    } catch (e) {
      log.event('main.update_start_failed', { error: (e as Error).message.slice(0, 80) });
      return null;
    }
  };
  const reportIdle = () => void host.control('session.idle', { idleSec: powerMonitor.getSystemIdleTime() }).catch(() => {});
  const idleTimer = setInterval(reportIdle, SESSION_IDLE_REPORT_MS);
  idleTimer.unref();
  const SESSION_KINDS = ['lock-screen', 'unlock-screen', 'suspend', 'resume'] as const;
  const onSession = SESSION_KINDS.map((kind) => {
    const fn = () => {
      void host.control('session.event', { kind }).catch(() => {});
      if (kind === 'unlock-screen' || kind === 'resume') reportIdle();
      if (kind === 'resume') phoneLink?.wake('resume');
      else if (kind === 'unlock-screen') phoneLink?.wake('unlock');
      if (kind === 'resume') {
        runs.woke();
        if (fixture || opts.daemon === false) void keepHometax('resume');
      }
    };
    powerMonitor.on(kind as 'resume', fn);
    return { kind, fn };
  });
  const ready = (async () => {
    try {
      await host.ready;
      reportIdle();
    } catch (e) {
      const text = fatalText((e as Error).message);
      if (text) dialog.showErrorBox('소버린 AX', text);
      throw e;
    }
    if (fixture) await fixture.seed(host);
    void registrySync('boot');
    if (fixture && dev && opts.demoSeed) seed = await dev.startDemoSeed(host, store, fixture.root, fixture.itemHints);
    await refresh();
    if (opts.onboarding) onb = new OnboardingFlow(onbPorts);
    else if (!fixture) {
      const saved = (await onbStore.load()) ?? (await onbStore.importLegacyFile(legacyOnbFile));
      if (saved) {
        onb = new OnboardingFlow(onbPorts, saved);
        onbShow = !onb.done;
      } else if (!business) onb = new OnboardingFlow(onbPorts);
    }
    await win.loadURL(SHELL_URL);
    if (!fixture && opts.daemon !== false) {
      daemon = startDaemonHost({
        rpc: (m, p) => host.rpc(m, p),
        show: showOsNotification,
        onDelivered: () => pushBoard(),
        onOpen: () => {
          if (win.isDestroyed()) return;
          if (win.isMinimized()) win.restore();
          win.show();
          win.focus();
        },
        stateFile: path.join(appPaths(root ?? defaultAppRoot()).userData, 'daemon-state.json'),
        log: (n, d) => log.event(n, d),
      });
      powerMonitor.on('resume', onResume);
    }
    if (!fixture && app.isPackaged && opts.update) updater = await startAppUpdater(opts.update);
    void seed
      ?.fill()
      .then(async () => {
        await refresh();
        send({ type: 'docs-reload' });
        pushBoard();
      })
      .catch((e) => log.event('main.seed_failed', { error: (e as Error).message.slice(0, 120) }));
  })();
  const rehearse = async () => {
    try {
      if (runs.anyActive()) throw new Error('busy');
      const find = () => cps.find((c) => c.bizNo.replace(/\D/g, '') === REHEARSAL.bizNo);
      if (!find()) {
        await cpBook.save({ name: REHEARSAL.name, bizNo: REHEARSAL.bizNo });
        await refresh();
      }
      const cp = find();
      if (!cp) throw new Error('no_counterparty');
      const d = runs.rehearsalDraft(cp);
      pushBoard();
      log.event('main.rehearsal_started', { runId: d.id });
      await prepareNow(d.id);
    } catch (e) {
      log.event('main.rehearsal_failed', { error: (e as Error).message.slice(0, 60) });
    }
  };
  const stopRehearsals = () => {
    for (const r of runs.list()) {
      if (!r.rehearsal || !runs.isActive(r.id)) continue;
      log.event('main.rehearsal_stop', { runId: r.id });
      void runs.stop(r.id).catch((e: Error) => log.event('main.rehearsal_stop_failed', { error: e.message.slice(0, 60) }));
    }
  };
  const certRehearse = async (doc: CertDocDef) => {
    try {
      if (runs.anyActive()) throw new Error('busy');
      const d = runs.createCertDraft(doc.code, certInputsFor(doc, '', kstToday(Date.now())), { rehearsal: true });
      pushBoard();
      log.event('main.rehearsal_started', { runId: d.id, playbook: doc.playbookId });
      await prepareNow(d.id);
    } catch (e) {
      log.event('main.rehearsal_failed', { error: (e as Error).message.slice(0, 60) });
    }
  };
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      { role: 'appMenu' },
      { role: 'editMenu' },
      {
        label: '도구',
        submenu: [
          { id: 'rehearsal', label: '홈택스 예행(발급 안 함)', click: () => void rehearse() },
          { label: '민원증명 예행(발급 안 함)', submenu: CERT_DOCS_SHOWN.map((d) => ({ id: `certRehearsal.${d.code}`, label: d.label, click: () => void certRehearse(d) })) },
          { id: 'rehearsalStop', label: '예행 중지', click: () => stopRehearsals() },
        ],
      },
      { label: '창', submenu: [{ role: 'minimize' }, { role: 'close' }, { type: 'separator' }, { label: '소버린 AX 끝내기', accelerator: 'CmdOrCtrl+Q', click: () => app.quit() }] },
    ]),
  );
  const close = async () => {
    clearInterval(boardDayTimer);
    clearInterval(registryTimer);
    clearInterval(shareTimer);
    clearInterval(keepTimer);
    if (linkTimer) clearInterval(linkTimer);
    daemon?.stop();
    powerMonitor.removeListener('resume', onResume);
    clearInterval(idleTimer);
    for (const { kind, fn } of onSession) powerMonitor.removeListener(kind as 'resume', fn);
    updater?.stop();
    pairHost?.cancel();
    for (const r of pairedThisRun) r.channel.close();
    phoneLink?.stop();
    stayAwake.set(false);
    app.removeListener('before-quit', onBeforeQuit);
    if (process.platform === 'darwin') nativeUpdater.removeListener('before-quit-for-update', onBeforeQuit);
    app.removeListener('activate', onActivate);
    powerMonitor.removeListener('on-ac', onPowerSource);
    powerMonitor.removeListener('on-battery', onPowerSource);
    watchChromeFront(false);
    closeSecret();
    await host.shutdown().catch(() => {});
    await fixture?.close().catch(() => {});
  };
  return { win, bar, runs, store, host, fixture, ready, methods: Object.keys(handlers), secretAsk: () => (secretAsk ? { reqId: secretAsk.reqId, kind: secretAsk.bind.kind, runId: secretAsk.bind.runId } : null), close };
}
