// PoC-9 데모 UI 셸의 main(PoC-6부터 엔진·금고를 띄운다). 승인 바는 main 소유 WebContentsView다(ADR-021).
// 렌더러는 바 자리를 비우기만 하고 바를 그리거나 숨기지 못한다. 승인 근거는 바 → main → 게이트 포트(엔진)로만 간다.
// 기본은 fixture 모드(가짜 H-01 페이지, 시험 정책 금고, 임시 앱 폴더). 홈택스 실제 화면은 PoC-3 셀렉터가 들어온 뒤.
import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import type { Counterparty as DbCounterparty, Profile as DbProfile } from '@sax/db';
import type { EnginePortal } from '@sax/engine/protocol';
import type { Channel } from '@sax/updater';
import { appPaths, defaultAppRoot, FileEventLog } from '@sax/platform';
import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, Notification, powerMonitor, protocol, session, shell as desktop } from 'electron';
import { kstToday, verifyLocalApproval, verifyLocalAttestation } from './approval-gate.ts';
import { buildBoard, type Board, type IssuedInvoice } from './board.ts';
import { OnboardingFlow, onboardingTodos } from './onboarding.ts';
import { MockOnboardingPorts } from './onboarding-mock.ts';
import { EngineOnboardingStore, onboardingPorts, type OnboardingExternal } from './onboarding-store.ts';
import { listNpkiCerts } from './npki-certs.ts';
import { APPROVAL_SCHEME, ApprovalBar } from './approval-bar.ts';
import { startDaemonHost, type DaemonHost, type ShowNotification } from './daemon-host.ts';
import { startUpdateHost, updatePolicy, type UpdateHost, type UpdateSources } from './update-host.ts';
import type { AppUpdaterLike } from './update-electron.ts';
import { certInfoInSandbox, DOCPARSE_SCHEME, ocrImageInSandbox, parsePdfInSandbox } from './docparse.ts';
import { EngineHost } from './engine-host.ts';
import type { FixtureMode } from './fixture-mode.ts';
import { GestureClock, isGestureKey, RateWindow } from './gesture.ts';
import { appHeaders, assertNoDebugSwitches, hardenApp, hardenSession, hardenWindow, SECRET_CSP } from './harden.ts';
import { dispatchShell, IPC, type ShellEvent, type ShellHandlers } from './ipc.ts';
import { secretPageHtml, SecretWindowCoordinator } from './secret-labels.ts';
import { openSecretWindow } from './secret-window.ts';
import { barBounds, SHELL } from './shell-layout.ts';
import { g24Candidates, interpret, mockBundle, MOCK_SETTINGS, MockStore, parseRegex, PROFILES, QUICK, seedTimeline, type Counterparty, type G24Doc, type Profile, type VatMode } from './shell-mock.ts';
import { engineDocsProvider, type DocsProvider } from './shell-docs.ts';
import { fatalText, ShellRuns, vaultNotice } from './shell-runs.ts';
import { bundleCss, tokensCss } from './shell-tokens.ts';
import { cancelPick, importPdf, pickFileBytes } from './vault-import.ts';
import { readBizCert } from './bizcert-read.ts';
import type { DemoModel, mergeParsed } from './demo-model.ts';
import type { DemoSeed, startDemoSeed } from './demo-seed.ts';

const STATIC = path.join(import.meta.dirname, '../static');
export const SHELL_SCHEME = 'sax-shell';
const SHELL_URL = `${SHELL_SCHEME}://shell/shell.html`;

export function registerShellSchemes(): void {
  // 한 번만 부를 수 있다(ready 전). 문서함 PDF 가져오기가 docparse 샌드박스를 쓰므로 그 스킴도 여기서 등록한다.
  // 공용 하드닝(디버그 스위치·샌드박스·새 창·이동·webview 거부)도 ready 전에 여기서 건다(ADR-025 결정 8).
  hardenApp(app, [`${SHELL_SCHEME}:`, `${APPROVAL_SCHEME}:`, `${DOCPARSE_SCHEME}:`]);
  protocol.registerSchemesAsPrivileged([
    { scheme: SHELL_SCHEME, privileges: { standard: true, secure: true } },
    { scheme: APPROVAL_SCHEME, privileges: { standard: true, secure: true } },
    { scheme: DOCPARSE_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true } },
  ]);
}

/** 문서함 오류 중 렌더러에 그대로 보낼 코드. 나머지(fs 오류 등, 경로가 들어 있을 수 있다)는 main 로그에만 남기고 'failed'로 보낸다. */
const DOC_CODES = new Set([
  'bad_request', 'busy', 'profile_required', 'not_pdf', 'input_size', 'read_failed', 'invalid_pdf', 'timeout', 'memory_limit', 'session_failed', 'renderer_gone',
  'pick_expired', 'password_too_long', 'schema', 'issued_in_future', 'expires_before_issued', 'expires_after_legal_max', 'invalid_issued_on', 'invalid_expires_on',
  'not_found', 'invalid_doc_type', 'file_missing', 'open_failed', 'seen_required', 'stale',
  'worker_failed', 'parse_failed', 'render_failed', 'ocr_failed', 'bad_extract',
  'gesture_required', 'throttled', 'pick_password_tries',
]);

/** 문서함 오류를 렌더러에 보낼 오류로: 알려진 코드만, 나머지는 로그(앞 코드만)와 'failed' */
function docsError(e: unknown): Error {
  const code = (e as { code?: unknown }).code ?? (e as Error).message;
  if (typeof code === 'string' && DOC_CODES.has(code)) return new Error(code);
  console.error('docs failed', typeof code === 'string' ? code.split(':')[0] : (e as Error).name); // fs 오류 메시지에는 경로가 있어 앞 코드만
  return new Error('failed');
}

const FILES: Record<string, string> = {
  '/shell.html': 'text/html; charset=utf-8',
  '/shell.css': 'text/css',
  '/shell.js': 'text/javascript',
  '/shell-views.js': 'text/javascript',
  '/shell-g24.js': 'text/javascript',
  '/shell-onboarding.js': 'text/javascript',
  '/secret.js': 'text/javascript',
  '/secret.css': 'text/css',
};

/** 지금 열린 비밀 창의 페이지(main이 만든다). 열린 창이 없으면 null(404). */
let secretPage: () => string | null = () => null;

function serve(): void {
  protocol.handle(SHELL_SCHEME, async (req) => {
    const p = new URL(req.url).pathname;
    // 모든 응답에 CSP 헤더(D11 §4): 셸은 APP_CSP, main이 만든 비밀 창 페이지는 더 좁은 SECRET_CSP.
    if (p === '/tokens.css') return new Response(tokensCss(), { headers: appHeaders('text/css') });
    if (p === '/secret.html') {
      const html = secretPage();
      return html ? new Response(html, { headers: appHeaders('text/html; charset=utf-8', SECRET_CSP) }) : new Response('', { status: 404 });
    }
    if (p === '/bundle.css') return new Response(bundleCss(), { headers: appHeaders('text/css') });
    const type = FILES[p];
    if (!type) return new Response('', { status: 404 });
    return new Response(await fs.readFile(path.join(STATIC, 'shell', p.slice(1))), { headers: appHeaders(type) });
  });
  // 렌더러는 네트워크가 없다(D01 §2.1). 자기 스킴 밖 요청을 취소한다.
  session.defaultSession.webRequest.onBeforeRequest((d, cb) => cb({ cancel: !d.url.startsWith(`${SHELL_SCHEME}://`) && !d.url.startsWith('devtools://') }));
  hardenSession(session.defaultSession);
}

export interface ShellOptions {
  /** 서류 데몬(OS 알림). 제품 기본 켬, fixture는 늘 끔. 시험이 false로 끈다. */
  daemon?: boolean;
  width?: number;
  height?: number;
  show?: boolean;
  /** e2e: OS 커서 위치를 바꿔 끼운다. */
  cursorPoint?: () => { x: number; y: number };
  /** 앱 금고(utilityProcess·OS 키체인)와 앱 폴더로 띄운다. 없으면 fixture 모드(dev가 있어야 한다). */
  engine?: { root?: string; portal: EnginePortal };
  /** fixture 모드에서 실행 Chrome을 화면에 띄운다(시연). */
  headful?: boolean;
  /** 문서함 보관함 공급자(shell-docs.ts). 없으면 이 셸의 엔진(host.rpc)을 쓴다. e2e가 감싸서 넘긴다. */
  docs?: DocsProvider;
  /** e2e: [홈택스에서 준비] 분당 상한(기본 3, 사람 속도). 렌더러가 바꿀 수 없다(진입점이 정한다). */
  preparePerMin?: number;
  /** 시연 전용 채팅 해석(SAX_DEMO_MODEL=openrouter, fixture 모드만). 없거나 실패하면 정규식 해석. */
  demoModel?: DemoModel | null;
  /** 시연 씨앗(견본 거래처·발급 이력·문서함 PDF, demo-seed.ts). fixture 모드만. e2e는 끈다. */
  demoSeed?: boolean;
  /**
   * 개발 전용 연결: 가짜 홈택스(fixture 모드)·시연 씨앗·시연 모델 병합. 제품 진입점(shell.ts)은 넘기지 않으므로 제품 dist가
   * 이 코드에 닿지 않는다(ADR-035 W-7, package-win 포함 목록). 시연 진입점(demo-shell.ts)과 e2e만 demo-dev.ts의 DEMO_DEV를 넘긴다.
   */
  dev?: ShellDev;
  /** 설치본 자기 점검 warn 배지 문구(harden.ts BUILD_WARN_TEXT에서 고른 것). 제품 진입점만 넘긴다. */
  buildBadges?: string[];
  /** 온보딩(08 §4)부터 시작한다(시연·e2e). 엔진 모드에서는 DB에 사업자 프로필이 없으면 저절로 시작한다. */
  onboarding?: boolean;
  /**
   * 앱 업데이트(update-host.ts, M4-9). 설치본(app.isPackaged)·엔진 모드에서만 돈다. 제품 진입점이 원천을 갖출 때 넘긴다:
   * 레지스트리 origin(egress 목적지), latest.json·폐기 목록·핀 키·투명성 확인 포트, 실계정 시험 빌드 여부와 설정.
   */
  update?: UpdateWiring;
}

/** ShellOptions.update. updater가 없으면(시험) electron-updater를 불러온다. */
export interface UpdateWiring {
  channel: Channel;
  origin: string;
  sources: UpdateSources;
  testBuild: boolean;
  setting?: { requireTransparency?: unknown } | null;
  updater?: AppUpdaterLike;
}

/** 개발 전용 연결(ShellOptions.dev). 여기에는 타입만 있고, 구현은 demo-dev.ts가 묶는다. */
export interface ShellDev {
  startFixture(opts: { headful?: boolean }): Promise<FixtureMode>;
  startDemoSeed: typeof startDemoSeed;
  mergeParsed: typeof mergeParsed;
}

export interface Shell {
  win: BrowserWindow;
  bar: ApprovalBar;
  runs: ShellRuns;
  store: MockStore;
  host: EngineHost;
  /** fixture 모드면 가짜 페이지·임시 앱 폴더. */
  fixture: FixtureMode | null;
  ready: Promise<void>;
  /** 렌더러가 부를 수 있는 메서드 전부(e2e가 승인 경로가 없는지 훑는다). */
  methods: string[];
  /** 지금 열린 비밀 입력 창(금고 secret.needed로만 열린다). */
  secretWindow(): BrowserWindow | null;
  close(): Promise<void>;
}

const SIGN: Record<string, string> = { simple_auth: '사업자 간편인증', cert: '공동·금융인증서', security_card: '보안카드' };

function profileView(p: DbProfile): Profile {
  return { kind: p.kind, name: p.displayName, bizNo: p.bizNo ?? undefined, rep: p.repName ?? undefined, email: p.email ?? '', auth: SIGN[p.signMethod ?? ''] ?? '발급 인증 미설정' };
}

/** DB 거래처 → 셸 화면 모델. 품목 열이 DB에 없어 fixture 시연 값(itemHints)을 쓴다. */
function counterpartyView(c: DbCounterparty, items: Record<string, string>): Counterparty {
  return {
    id: c.id,
    name: c.name,
    bizNo: c.bizNo,
    rep: c.repName ?? '',
    email: c.email ?? '',
    item: items[c.bizNo] ?? '',
    status: c.verifiedStatus ?? '확인 전',
    checkedOn: c.verifiedAt?.slice(0, 10) ?? '',
    lastIssuedOn: c.lastUsedAt?.slice(0, 10) ?? null,
  };
}

export async function startShell(opts: ShellOptions = {}): Promise<Shell> {
  // CDP로 넣은 마우스 이벤트도 before-mouse-event를 일으키므로 디버그 스위치가 있으면 끝낸다(ADR-021·ADR-025 결정 8, 값싼 차단).
  assertNoDebugSwitches(app);
  serve();
  // 확대·축소 메뉴를 두지 않는다(렌더러 배율은 1, 바 자리는 DIP 고정). 접근성 배율은 Phase 1.
  Menu.setApplicationMenu(Menu.buildFromTemplate([{ role: 'appMenu' }, { role: 'editMenu' }, { label: '창', submenu: [{ role: 'minimize' }, { role: 'close' }] }]));
  const key = new Uint8Array(randomBytes(32));
  const store = new MockStore();
  // 제품 진입점은 엔진 모드만 있다. fixture 모드는 개발 연결(dev)이 있을 때만 띄운다.
  if (!opts.engine && !opts.dev) throw new Error('shell.no_portal');
  const fixture = opts.engine ? null : await opts.dev!.startFixture({ headful: opts.headful });
  const made: { host?: EngineHost } = {};
  try {
    return wireShell(opts, fixture, key, store, made);
  } catch (e) {
    // 창·바를 만들다 실패하면 엔진을 먼저 끝내고(DB가 열린 채 지우지 않게) 가짜 페이지 서버·main 안 금고·임시 앱 폴더를 지운다.
    await made.host?.shutdown().catch(() => {});
    await fixture?.close().catch(() => {});
    throw e;
  }
}

function wireShell(opts: ShellOptions, fixture: FixtureMode | null, key: Uint8Array, store: MockStore, made: { host?: EngineHost }): Shell {
  // 공급사 직결(D04 예외)은 fixture 시연에만. 실제 홈택스 모드에서는 넘겨받아도 쓰지 않는다.
  const demo = fixture ? (opts.demoModel ?? null) : null;
  const dev = fixture ? opts.dev! : null;
  const root = fixture?.root ?? opts.engine?.root;
  const log = new FileEventLog(appPaths(root ?? defaultAppRoot()).logs, 'main');
  const host = new EngineHost({ vault: fixture ? fixture.vault : 'process', root, portal: fixture?.portal ?? opts.engine!.portal, log });
  made.host = host;
  let business: Profile | null = null;
  let cps: Counterparty[] = [];
  const refresh = async () => {
    const ps = (await host.rpc('db.query.profiles.list')) as DbProfile[];
    const b = ps.find((p) => p.kind === 'business');
    business = b ? profileView(b) : null;
    // 최근 발급일: 원장(DB)에 없으면 문서함 세금계산서(지난 발급 견본 포함)에서
    const lastDoc = (name: string) => store.docs.filter((d) => d.kind === '세금계산서' && d.name === `세금계산서 · ${name}`).reduce<string | null>((m, d) => (d.issuedOn && (!m || d.issuedOn > m) ? d.issuedOn : m), null);
    cps = ((await host.rpc('db.query.counterparties.list')) as DbCounterparty[]).map((c) => counterpartyView(c, fixture?.itemHints ?? {})).map((c) => ({ ...c, lastIssuedOn: c.lastIssuedOn ?? lastDoc(c.name) }));
  };
  let seed: DemoSeed | null = null;
  const profiles = () => ({ business: business ?? PROFILES.business, personal: PROFILES.personal });
  const runs = new ShellRuns(host, { counterparties: () => cps, auth: () => profiles().business.auth });
  let profile: Profile['kind'] = 'business';
  // 파일 대화상자는 메인 창을 부모로 띄운다(win은 아래에서 만든다).
  const docs = opts.docs ?? engineDocsProvider((m, p) => host.rpc(m, p), (params, engine) => importPdf(params, engine, win));
  /** 문서함 = 보관함 서류 + 실행이 만든 서류(세금계산서·정부24 목업) */
  const listDocs = async () => {
    try {
      return [...(await docs.list()), ...store.docs];
    } catch (e) {
      throw docsError(e);
    }
  };
  /** 문서함 처리기: 오류는 docsError로 바꿔 던진다(원래 오류는 cause로 붙이지 않는다. ipcMain이 cause까지 출력하고 fs 오류에는 경로가 있다) */
  const docsCall =
    (fn: (p: Record<string, unknown>) => unknown) =>
    async (p: Record<string, unknown>): Promise<unknown> => {
      try {
        const r = await fn(p);
        pushBoard(); // 가져오기·확인으로 만료일·확인 필요가 바뀐다
        return r;
      } catch (e) {
        throw docsError(e);
      }
    };
  let importing = false;
  /** 열 파일: 목업 서류의 견본 PDF(시연 씨앗) 아니면 보관함 서류. */
  const docFile = async (id: string) => store.files.get(id) ?? (await docs.filePath(id));

  const win = new BrowserWindow({
    width: opts.width ?? 1280,
    height: opts.height ?? 820,
    useContentSize: true,
    minHeight: 560,
    show: opts.show ?? true,
    title: fixture ? '소버린 AX (PoC 데모 · 가짜 홈택스 페이지)' : '소버린 AX (PoC 데모)',
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: false,
      disableDialogs: true,
      spellcheck: false,
      // 제품 빌드에서는 개발자 도구를 열 수 없다(D11 §4 렌더러 행). 개발 실행(pnpm demo)에서만 연다.
      devTools: !app.isPackaged,
      preload: path.join(STATIC, 'preload-shell.cjs'),
    },
  });
  const wc = win.webContents;
  // 새 창·이동 거부, 렌더러의 window.moveTo·resizeTo 무시, 배율 1 고정.
  hardenWindow(win);
  // 사용자 동작 결속(ADR-027 결정 8): main이 메인 창에서 직접 본 실제 입력(mouseUp, 수식키 없는 Enter·Space) 시각.
  const gesture = new GestureClock();
  wc.on('before-mouse-event', (_e, m) => {
    if (m.type === 'mouseUp') gesture.note(performance.now());
  });
  wc.on('before-input-event', (_e, i) => {
    if (isGestureKey(i)) gesture.note(performance.now());
  });
  const prepareRate = new RateWindow(opts.preparePerMin ?? 3, 60_000);
  const openRate = new RateWindow(5, 60_000);
  /** 실제 입력이 ms 안에 없으면 gesture_required. */
  const needGesture = (ms: number) => {
    if (!gesture.within(performance.now(), ms)) throw new Error('gesture_required');
  };

  const bar = new ApprovalBar(win, key, barBounds, { cursorPoint: opts.cursorPoint, log });
  const send = (ev: ShellEvent) => {
    if (!win.isDestroyed()) wc.send(IPC.event, ev);
  };
  /** 지난 발급(시연 씨앗 이력 + 문서함 세금계산서). 원장 발급 이력 질의가 나오면 그쪽으로 바꾼다. */
  const issuedInvoices = (): IssuedInvoice[] => {
    const total = new Map((seed?.history ?? []).filter((x) => x.approvalNo).map((x) => [`d-${x.id}`, x.total]));
    return store.docs.filter((d) => d.kind === '세금계산서' && d.issuedOn).map((d) => ({ who: d.name.replace(/^세금계산서 · /, ''), date: d.issuedOn!, total: total.get(d.id) ?? null }));
  };
  /** 이번 달 판(M-02, ADR-033). 꾸러미·카드는 목업 어댑터(shell-mock mockBundle·MOCK_SETTINGS). */
  // 문서함을 읽지 못하면 판을 만들지 않는다(보관함 서류가 빠진 판으로 온전한 판을 덮지 않게). 지난 판이 그대로 남고,
  // boardDay를 비워 두어 날짜 타이머가 1분 뒤 다시 계산한다.
  let boardDay = '';
  const boardNow = async (): Promise<Board> => {
    const today = kstToday(Date.now());
    const docsNow = await listDocs().catch((e: unknown) => {
      boardDay = '';
      throw e;
    });
    boardDay = today;
    return buildBoard({
      today,
      reminderDay: MOCK_SETTINGS.reminderDay,
      issued: issuedInvoices(),
      runs: runs.list().map((r) => ({ id: r.id, status: r.status, who: r.counterparty.name, inDoubt: r.inDoubt === true })),
      docs: docsNow.map((d) => ({ id: d.id, name: d.name, expiresOn: d.expiresOn, needsUser: !!d.vault?.needsUser })),
      bundle: mockBundle(today),
      cardFetchedOn: MOCK_SETTINGS.cardFetchedOn,
      setup: onboardingTodos(onb?.state ?? null),
    });
  };
  // 실행·서류가 바뀌면 판을 다시 계산해 보낸다(한 틱에 여러 번 바뀌어도 한 번).
  // 계산이 겹치면 가장 나중에 시작한 것만 보낸다(먼저 시작한 계산이 늦게 끝나 새 판을 옛 판으로 덮지 않게).
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
  /** 첫 화면의 판. 그 전에 시작한 계산이 늦게 끝나도 보내지 않게 세대를 올린다. */
  const bootBoard = () => {
    boardGen++;
    return boardNow();
  };
  // 날짜가 바뀌면(KST 자정) 다시 계산한다. 이번 달·지난달·만료 30일 창이 날짜에 달려 있다.
  const boardDayTimer = setInterval(() => {
    if (kstToday(Date.now()) !== boardDay) pushBoard();
  }, 60_000);
  boardDayTimer.unref();
  // 렌더러에는 바 자리를 비울지와 띠 여부만 알린다(배치용). 바 내용·좌표는 보내지 않는다.
  bar.on('shown', (e: { band: boolean }) => send({ type: 'bar', active: true, band: e.band }));
  bar.on('layout', (e: { band: boolean }) => send({ type: 'bar-layout', band: e.band }));
  bar.on('hidden', (reason: string) => send({ type: 'bar', active: false, reason }));
  runs.on('update', (run) => {
    send({ type: 'run', run });
    pushBoard();
  });
  runs.on('doc', (doc) => {
    store.docs.unshift(doc);
    const run = runs.get(doc.id.slice(2));
    if (seed && run) void seed.issued(doc, run).catch((e) => log.event('main.seed_issued_failed', { error: (e as Error).message.slice(0, 120) }));
    send({ type: 'doc', doc });
    pushBoard();
    void refresh().catch(() => {});
  });
  runs.on('gate-closed', (_runId: string, reqId: string, reason: string) => bar.close(reason, reqId));

  // 금고가 부르는 비밀 입력 창(ADR-025 결정 10). 열린 창은 하나, 활성 실행의 요청만, 라벨은 main 내장 표.
  const secrets = new SecretWindowCoordinator((runId) => runs.isActive(runId));
  let secretWin: BrowserWindow | null = null;
  secretPage = () => {
    const r = secrets.open;
    return r ? secretPageHtml(r, profiles()[r.scope].name) : null;
  };
  // main이 닫은 창(실행 끝·종료)은 사용자가 돌아온 것이 아니다: 핸드오프 복귀로 치지 않는다.
  let appClosing: BrowserWindow | null = null;
  // 메인 창이 닫히는 중이면 비밀 창을 새로 열지 않는다(들고 있던 다음 요청 포함).
  let mainClosing = false;
  win.once('close', () => {
    mainClosing = true;
  });
  const closeSecret = () => {
    if (!secretWin || secretWin.isDestroyed()) return;
    appClosing = secretWin;
    secretWin.close();
  };
  const openSecret = (data: unknown): void => {
    // 메인 창부터 본다: 열 수 없는데 조정자에 '열림'을 남기면 이후 비밀 창이 영영 열리지 않는다.
    if (mainClosing || win.isDestroyed()) return log.event('main.secret_needed_ignored');
    const r = secrets.request(data);
    if (!r) return log.event(secrets.open ? 'main.secret_needed_queued' : 'main.secret_needed_ignored');
    const bind = { runId: r.runId, kind: r.kind, scope: r.scope, ...(r.row !== undefined ? { row: r.row } : {}) };
    let w: BrowserWindow;
    let port: ReturnType<typeof host.secretInputPort> | null = null;
    try {
      port = host.secretInputPort(bind);
      w = openSecretWindow(win, bind, port, `${SHELL_SCHEME}://shell/secret.html`);
    } catch (e) {
      // 열지 못했으면 '열림'을 남기지 않는다(남으면 이후 요청이 줄만 서고 창이 영영 안 열린다). 든 요청도 버린다.
      // 이미 만든 금고 입력 포트도 닫아 금고 쪽 결속을 끝낸다.
      port?.close();
      secrets.closed();
      return log.event('main.secret_open_failed', { error: (e as Error).message.slice(0, 120) });
    }
    secretWin = w;
    // 사용자가 앱이 연 창에서 돌아옴: 다음 활성화 한 번만 클릭 활성화 예외(ADR-027 결정 5). 메인 창이 포커스를 받기 전에
    // 표시해야 그 활성화가 표시를 쓴다('closed'는 포커스보다 늦을 수 있다).
    let byApp = false;
    w.on('close', () => {
      byApp = appClosing === w;
      if (byApp) appClosing = null;
      else bar.noteHandoff();
    });
    w.on('closed', () => {
      if (secretWin === w) secretWin = null;
      const next = secrets.closed();
      // 들고 있던 요청은 사용자가 창을 마쳤을 때만 이어서 연다. main이 닫은 창(실행 끝·종료)이면 버린다.
      if (next && !byApp) openSecret(next);
    });
  };
  host.on('vault-event', (name: string, data: unknown) => {
    if (name === 'secret.needed') return openSecret(data);
    const n = vaultNotice(name, data);
    if (n) runs.notice(n.runId, n.text);
  });
  // 실행이 끝나면 그 실행의 비밀 창도 닫는다.
  runs.on('update', (run: { id: string }) => {
    if (secrets.open?.runId === run.id && !runs.isActive(run.id)) closeSecret();
  });
  // 엔진이 끝나면 열린 게이트도 끝이다(근거를 받을 곳이 없다). 실행 카드는 ShellRuns가 끝낸다.
  host.on('exit', (who: string) => {
    if (who === 'engine') bar.close('engine_exit');
  });
  // 게이트 요청(엔진 → 게이트 포트 → main). main이 fields로 해시를 다시 계산해 맞을 때만 바를 무장한다(approval-bar).
  // 승인 근거는 바가 관찰한 클릭으로 main이 발급하고, 게이트 포트로만 엔진에 보낸다. 렌더러에는 이 경로가 없다.
  runs.on('gate', (runId: string, req) => {
    void bar.open(req).then(async (o) => {
      if (o.decision === 'approve') {
        if (!verifyLocalApproval(key, o.approval)) return runs.abortGate(runId, 'answer.rejected');
        // 보내기 전에 표시한다. 보낸 뒤 엔진이 끝나면 발급됐는지 모르는 쪽(in_doubt)으로 다룬다.
        runs.approved(runId);
        const r = await host.answerGate(o.approval);
        if (!r.ok) log.event('main.gate_answer_not_ok', { code: r.code ?? '', verdict: r.verdict });
        await runs.onAnswer(runId, r);
      } else if (o.reason === 'load_failed') await runs.abortGate(runId, 'bar.load_failed');
      else if (o.reason === 'busy') log.event('main.gate_while_open');
    });
  });

  // InDoubt 증언(ADR-021 결정 5). 엔진의 증언 요청은 ShellRuns가 무장만 해 둔다(summaryHash 일치). 바는 사용자가 그 카드를
  // 열었다고 렌더러가 알려 온 동안에만 띄우고, 게이트가 오면 게이트가 자리를 가져간다(approval-bar). 증언 근거는 바가 관찰한
  // 클릭으로 main이 발급하고, 게이트 포트(answerAttest)로만 엔진에 보낸다. 렌더러에는 이 경로가 없다.
  let incidentOpen: string | null = null;
  const showAttest = (runId: string) => {
    const req = runs.attestFor(runId);
    if (!req || incidentOpen !== runId || bar.visible) return;
    void bar.openAttest(req).then(async (o) => {
      if (o.decision !== 'attest') {
        if (o.reason === 'load_failed') log.event('main.attest_bar_load_failed');
        return;
      }
      if (!verifyLocalAttestation(key, o.attestation) || o.attestation.attestReqId !== req.attestReqId) return log.event('main.attest_self_check_failed');
      runs.attestUsed(runId, req.attestReqId);
      const r = await host.answerAttest(o.attestation);
      if (!r.ok) log.event('main.attest_answer_not_ok', { code: String(r.code ?? ''), verdict: r.verdict });
      runs.onAttestAnswer(runId, r);
    });
  };
  /** 렌더러의 카드 열림·닫힘(incident.open/close 처리기는 이것만 부른다). */
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
  // 게이트가 끝나 바 자리가 비면, 열린 카드의 증언 요청이 남아 있을 때 다시 띄운다(엔진이 새로 요청하면 그것으로).
  bar.on('hidden', (_reason: string, kind: string) => {
    if (kind === 'gate' && incidentOpen) setTimeout(() => incidentOpen && showAttest(incidentOpen), 0);
  });

  const g24Doc = (v: unknown): G24Doc => {
    if (v !== '주민등록표 등본' && v !== '주민등록표 초본') throw new Error('bad_doc');
    return v;
  };
  /** 시연 DB 쓰기(렌더러 처리기는 이 두 함수만 부른다. 엔진 명령은 여기서 고정한다). fixture 모드가 아니면 거부한다. */
  const demoDb = {
    async saveCounterparty(p: Record<string, unknown>) {
      if (!fixture) throw new Error('unsupported');
      const text = (v: unknown, n: number) => String(v ?? '').trim().slice(0, n);
      const v = { name: text(p.name, 60), repName: text(p.rep, 30) || null, email: text(p.email, 100) || null };
      const id = typeof p.id === 'string' && p.id ? p.id : null;
      const saved = (id ? await host.rpc('counterparty.update', { id, patch: v }) : await host.rpc('counterparty.create', { ...v, bizNo: text(p.bizNo, 20).replace(/\D/g, '') })) as DbCounterparty;
      const item = text(p.item, 40);
      if (item) fixture.itemHints[saved.bizNo] = item;
      await refresh();
      return { id: saved.id, counterparties: cps };
    },
    async setDefaultAuth(p: Record<string, unknown>) {
      if (!fixture) throw new Error('unsupported');
      const signMethod = ({ simple: 'simple_auth', cert: 'cert', card: 'security_card' } as const)[String(p.kind) as 'simple' | 'cert' | 'card'];
      if (!signMethod) throw new Error('bad_request');
      const cur = ((await host.rpc('db.query.profiles.list')) as DbProfile[]).find((x) => x.kind === 'business');
      if (!cur) throw new Error('not_found');
      await host.rpc('profile.upsert', { ...cur, signMethod });
      await refresh();
      return { profiles: profiles() };
    },
  };
  // 서류 데몬(daemon-host.ts). 알림 객체는 눌리거나 닫힐 때까지 잡아 둔다(가비지 수집되면 click이 오지 않는다).
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
  let updater: UpdateHost | null = null;
  const onResume = () => {
    daemon?.requestReload();
    void updater?.check();
  };
  // 온보딩(08 §4, M4-2). 저장(동의 기록·이어 하기·프로필·포털 아이디)은 엔진 main 전용 명령으로 DB에(onboarding-store.ts, 엔진 #91·db #53).
  // 바깥 일: 등록증 읽기(bizcert-read.ts, M4-3)·NPKI(npki-certs.ts, #93)는 제품 어댑터다. 진위확인·금고 등록 창·처리자 표는 아직 목업(onboarding-mock.ts): #65·금고 T-06.
  let onb: OnboardingFlow | null = null;
  /** 이번 기동에 온보딩 대화를 보일지. 지난 기동에 끝낸 온보딩은 불러와 두되(동의·할 일) 대화로 다시 그리지 않는다. */
  let onbShow = true;
  const onbStore = new EngineOnboardingStore((m, p) => host.rpc(m, p));
  /** M4-2 목업 때의 이어 하기 파일. DB에 행이 없으면 한 번 옮기고 지운다. */
  const legacyOnbFile = path.join(appPaths(root ?? defaultAppRoot()).userData, 'onboarding-state.json');
  const onbMock = new MockOnboardingPorts({ saveProfile: async () => {} });
  // 공동인증서 목록: 제품은 금고 npki.list(이 PC의 NPKI 폴더 열거) → docparse 샌드박스 certInfo → 표시 행(npki-certs.ts).
  // 시연·e2e(fixture)는 이 PC를 훑지 않고 목업 목록을 쓴다.
  const onbExternal: OnboardingExternal = fixture
    ? onbMock
    : {
        // O-02 등록증(M4-3): 사용자가 고른 PDF·그림 → docparse 샌드박스 → 엔진 bizcert.parse(텍스트만) → 확인 화면 후보
        recognizeBizCert: () =>
          readBizCert({
            pick: () => pickFileBytes([{ name: '사업자등록증(PDF·사진)', extensions: ['pdf', 'png', 'jpg', 'jpeg'] }], win),
            pdfText: async (b, o) => (await parsePdfInSandbox(b, { ocrPages: 1, forceOcr: o.forceOcr })).text,
            imageText: async (b) => (await ocrImageInSandbox(b, { mode: 'document' })).text,
            parse: (text) => host.rpc('bizcert.parse', { text }),
            log: (n, d) => log.event(n, d),
          }),
        checkBizNo: (bizNo) => onbMock.checkBizNo(bizNo),
        registerSecrets: (binds) => onbMock.registerSecrets(binds),
        consentConfig: () => onbMock.consentConfig(),
        findCerts: () => listNpkiCerts((m, p) => host.control(m, p), (der) => certInfoInSandbox(der), { today: kstToday(Date.now()), log: (n, d) => log.event(n, d) }),
      };
  const onbPorts = onboardingPorts(onbExternal, onbStore, refresh);
  const onbView = async () => (onb && onbShow ? await onb.view() : null);
  /** 온보딩이 끝나기 전에는 약관(④) 동의 전 요청을 받지 않는다. 모델 해석은 ②에 동의했을 때만(기존 사용자는 지금처럼). */
  const termsOk = () => !onb || onb.state.consents.terms?.choice === 'agreed';
  const modelOk = () => !onb || onb.modelAllowed();

  const handlers: ShellHandlers = {
    'shell.bootstrap': async () => ({
      board: await bootBoard(),
      layout: SHELL,
      profiles: profiles(),
      profile,
      counterparties: cps,
      docs: await listDocs(),
      timeline: seedTimeline(),
      quick: QUICK,
      platform: process.platform,
      interp: demo ? 'model' : 'offline',
      // 설치본 자기 점검의 warn(미서명 빌드 등). 제품 진입점(shell.ts)이 정한다. 렌더러는 글자만 보인다.
      build: opts.buildBadges ?? [],
      history: seed?.history ?? null,
      onboarding: await onbView(),
    }),
    'profile.set': (p) => {
      if (p.kind !== 'business' && p.kind !== 'personal') throw new Error('bad_profile');
      profile = p.kind;
      return { profile };
    },
    // 시연 모델이 있으면 먼저 묻고(4초 상한), 없거나 실패하면 정규식. via는 화면 구석 표시용(모델 해석/오프라인 해석).
    'request.send': async (p) => {
      const vat = p.vat === 'separate' || p.vat === 'included' ? (p.vat as VatMode) : null;
      if (!termsOk()) throw new Error('onboarding_terms');
      const text = String(p.text ?? '').slice(0, 2000);
      const t0 = performance.now();
      const model = demo && modelOk() && text.trim() ? await demo.parse(text, runs.counterparties.map((c) => c.name)) : null;
      const via = model ? 'model' : 'offline';
      if (demo) log.event('main.interpret', { via, ms: Math.round(performance.now() - t0) });
      const reply = interpret(text, vat, profile, runs, model && dev ? dev.mergeParsed(model, parseRegex(text, runs.counterparties), text) : undefined);
      if (reply.kind === 'draft') {
        reply.run.interp = via;
        pushBoard(); // 초안은 update 이벤트 없이 생긴다
      }
      return { ...reply, via };
    },
    'draft.update': (p) =>
      runs.updateDraft(String(p.id), {
        vat: p.vat === 'separate' || p.vat === 'included' ? p.vat : undefined,
        amount: typeof p.amount === 'number' ? p.amount : undefined,
        amountText: typeof p.amountText === 'string' ? p.amountText.slice(0, 100) : undefined,
      }),
    // 실행 시작은 2초 안의 실제 입력이 있어야 하고, 사람 속도(분당 3회)·게이트 없이 끝난 연속 3회에서 멈춘다.
    'run.prepare': (p) => {
      needGesture(2_000);
      if (runs.prepareThrottled() || !prepareRate.take(performance.now())) {
        log.event('main.prepare_throttled');
        throw new Error('throttled');
      }
      return runs.prepare(String(p.id));
    },
    'run.stop': (p) => runs.stop(String(p.id)),
    'run.resume': (p) => {
      needGesture(3_000);
      return runs.resume(String(p.id));
    },
    'run.manualDone': (p) => {
      needGesture(3_000);
      return runs.manualDone(String(p.id));
    },
    // InDoubt 카드를 열었다(실제 입력 3초 안). 증언 요청이 무장돼 있으면 main이 바를 띄운다. 돌려주는 것은 무장됐는지뿐이다.
    'incident.open': (p) => {
      needGesture(3_000);
      return incidents.open(String(p.id));
    },
    // 카드를 닫았다. 증언 바를 내린다(증언이 안 될 뿐이라 안전한 실패다).
    'incident.close': (p) => incidents.close(String(p.id)),
    'docs.list': () => listDocs(),
    // 파일 고르기 대화상자는 렌더러가 pick을 보내고 3초 안에 실제 입력이 있었을 때만 연다(가져오기 버튼).
    // 열기 암호를 다시 물을 때는 pickId로 부른다. 가져오기는 한 번에 하나(대화상자가 겹쳐 뜨지 않게).
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
    // 보관함 PDF를 사용자 기본 뷰어로 연다(값을 PDF와 맞춰 보게). 경로는 main 안에서만 쓰고, PDF가 아니면 열지 않는다(실행 파일을 띄우지 않게).
    'docs.open': docsCall(async (p) => {
      needGesture(3_000);
      if (!openRate.take(performance.now())) throw new Error('throttled');
      const file = await docFile(String(p.id));
      if (path.extname(file).toLowerCase() !== '.pdf') throw new Error('open_failed');
      if (await desktop.openPath(file)) throw new Error('open_failed');
      return {};
    }),
    // 같은 파일을 Finder에서 보여 준다(결과 카드 [폴더 열기]).
    'docs.reveal': docsCall(async (p) => {
      needGesture(3_000);
      if (!openRate.take(performance.now())) throw new Error('throttled');
      desktop.showItemInFolder(await docFile(String(p.id)));
      return {};
    }),
    // 시연 DB에서만: 거래처 추가·수정, 발급 인증 기본 바꾸기. 실제 홈택스 모드에서는 쓰지 않는다(demoDb).
    'counterparty.save': (p) => demoDb.saveCounterparty(p),
    'auth.setDefault': (p) => demoDb.setDefaultAuth(p),
    'counterparties.list': async () => {
      await refresh();
      return cps;
    },
    'g24.candidates': (p) => g24Candidates(g24Doc(p.doc), Number(p.startedAt)),
    'g24.save': (p) => store.g24Save(String(p.id), g24Doc(p.doc)),
    // 비밀이 아닌 값(승인번호·사업자번호·주소)만. 클립보드 기록 제외 형식은 Phase 1(D17 §1.2).
    // 온보딩 답 하나. 동의·확정은 화면마다 실제 클릭이라 3초 안의 실제 입력이 있어야 한다(ADR-027 결정 8).
    'onboarding.reply': async (p) => {
      needGesture(3_000);
      if (!onb) throw new Error('onboarding_done');
      const r = await onb.answer({ step: p.step, choice: p.choice, fields: p.fields, certId: p.certId, tasks: p.tasks } as Parameters<OnboardingFlow['answer']>[0]);
      if (onb.done) pushBoard(); // 건너뛴 항목이 판의 할 일로
      return { onboarding: await onbView(), fill: r.fill ?? null, profiles: profiles() };
    },
    'clipboard.copy': (p) => {
      clipboard.writeText(String(p.text ?? '').slice(0, 200));
      return {};
    },
  };

  ipcMain.handle('sax', async (e, req: { method?: unknown; params?: unknown }) => {
    // 메인 창의 셸 페이지에서 온 호출만 받는다. 승인 바(javascript:false)는 IPC가 없다.
    if (e.sender !== wc || e.senderFrame?.url !== SHELL_URL) throw new Error('forbidden');
    // 최상위 프레임만, 표(ipc.ts SHELL_METHODS)에 있는 메서드·필드만(D11 §4 IPC 행).
    return dispatchShell(e.senderFrame, SHELL_URL, handlers, req);
  });

  const startAppUpdater = async (w: UpdateWiring): Promise<UpdateHost | null> => {
    try {
      const { electronInstaller } = await import('./update-electron.ts');
      const u = w.updater ?? ((await import('electron-updater')).default.autoUpdater as unknown as AppUpdaterLike);
      const h = startUpdateHost({
        sources: w.sources,
        installer: electronInstaller(u, { origin: w.origin, channel: w.channel }),
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
      void h.check();
      return h;
    } catch (e) {
      log.event('main.update_start_failed', { error: (e as Error).message.slice(0, 80) });
      return null;
    }
  };
  const ready = (async () => {
    try {
      await host.ready;
    } catch (e) {
      // 금고 키 유실·환경 변수 변조 등은 사실 문장으로 알리고 열지 않는다(복구 화면은 Phase 1).
      const text = fatalText((e as Error).message);
      if (text) dialog.showErrorBox('소버린 AX', text);
      throw e;
    }
    if (fixture) await fixture.seed(host);
    if (fixture && dev && opts.demoSeed) seed = await dev.startDemoSeed(host, store, fixture.root, fixture.itemHints);
    await refresh();
    // 온보딩: 시연·e2e는 opts.onboarding. 엔진 모드는 이어 하기 저장이 있으면 그 자리부터(끝났으면 대화 없이 동의·할 일만),
    // 저장이 없고 사업자 프로필도 없으면 처음부터. 사업자를 건너뛰고 끝낸 사용자도 다음 기동에 약관부터 다시 묻지 않는다.
    if (opts.onboarding) onb = new OnboardingFlow(onbPorts);
    else if (!fixture) {
      const saved = (await onbStore.load()) ?? (await onbStore.importLegacyFile(legacyOnbFile));
      if (saved) {
        onb = new OnboardingFlow(onbPorts, saved);
        onbShow = saved.step !== 'done';
      } else if (!business) onb = new OnboardingFlow(onbPorts);
    }
    await win.loadURL(SHELL_URL);
    // 서류 데몬(D10 notify, M4-8): 제품만. 시연·e2e(fixture)는 이 PC에 OS 알림을 띄우지 않는다.
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
    // 앱 업데이트(M4-9): 설치본만. 실행 중·커밋 구간(승인 바·발급 중·제출 여부 모름)에는 설치를 미룬다(D11 §4). 데몬은 notify만이라 실행이 없다.
    if (!fixture && app.isPackaged && opts.update) updater = await startAppUpdater(opts.update);
    // 견본 PDF·보관함 가져오기는 창을 띄운 뒤 뒤에서(몇 초). 끝나면 렌더러가 문서함을 다시 읽는다.
    void seed
      ?.fill()
      .then(async () => {
        await refresh();
        send({ type: 'docs-reload' });
        pushBoard();
      })
      .catch((e) => log.event('main.seed_failed', { error: (e as Error).message.slice(0, 120) }));
  })();
  const close = async () => {
    clearInterval(boardDayTimer);
    daemon?.stop();
    powerMonitor.removeListener('resume', onResume);
    updater?.stop();
    closeSecret();
    // 엔진이 실제로 끝난 뒤에 임시 앱 폴더를 지운다(DB·WAL이 열린 채 지우지 않게).
    await host.shutdown().catch(() => {});
    await fixture?.close().catch(() => {});
  };
  return { win, bar, runs, store, host, fixture, ready, methods: Object.keys(handlers), secretWindow: () => secretWin, close };
}
