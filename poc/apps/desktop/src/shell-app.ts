// PoC-9 데모 UI 셸의 main(PoC-6부터 엔진·금고를 띄운다). 승인 바는 main 소유 WebContentsView다(ADR-021).
// 렌더러는 바 자리를 비우기만 하고 바를 그리거나 숨기지 못한다. 승인 근거는 바 → main → 게이트 포트(엔진)로만 간다.
// 기본은 fixture 모드(가짜 H-01 페이지, 시험 정책 금고, 임시 앱 폴더). 홈택스 실제 화면은 PoC-3 셀렉터가 들어온 뒤.
import { randomBytes, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import type { Counterparty as DbCounterparty, Profile as DbProfile } from '@sax/db';
import type { EnginePortal } from '@sax/engine/protocol';
import type { Channel, Revocation, TrustRoot } from '@sax/updater';
import type { Egress } from '@sax/net';
import { wsRelayClient, type DesktopKeys, type DesktopPairResult, type RelayClient } from '@sax/remote';
import { appPaths, defaultAppRoot, FileEventLog } from '@sax/platform';
import { findInstalledChrome, pageAddress, SESSION_IDLE_REPORT_MS } from '@sax/vault';
import { execFile } from 'node:child_process';
import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, Notification, powerMonitor, protocol, screen, session, shell as desktop } from 'electron';
import { kstToday, verifyLocalApproval, verifyLocalAttestation } from './approval-gate.ts';
import { buildBoard, type Board, type BoardInput, type IssuedInvoice } from './board.ts';
import { BankHost, bankShellHandlers, type PickKind } from './bank-host.ts';
import { CONSENT_CONFIG, OnboardingFlow, onboardingTodos, type BizFields } from './onboarding.ts';
import { EngineOnboardingStore, onboardingPorts, type OnboardingExternal } from './onboarding-store.ts';
import { listNpkiCerts } from './npki-certs.ts';
import { openExternalKey } from './external-links.ts';
import { securityBlocks, securityStatus, startSecurityProgram, type SecurityStatus } from './security-programs.ts';
import { APPROVAL_SCHEME, ApprovalBar } from './approval-bar.ts';
import { startDaemonHost, type DaemonHost, type ShowNotification } from './daemon-host.ts';
import { startUpdateHost, updatePolicy, type UpdateHost } from './update-host.ts';
import type { AppUpdaterLike, ProviderBase } from './update-electron.ts';
import { certInfoInSandbox, DOCPARSE_SCHEME, ocrImageInSandbox, parsePdfInSandbox, readSheetInSandbox } from './docparse.ts';
import { EngineHost } from './engine-host.ts';
import type { FixtureMode } from './fixture-mode.ts';
import { GestureClock, isGestureKey, isTypingKey, RateWindow } from './gesture.ts';
import { appHeaders, assertNoDebugSwitches, hardenApp, hardenSession, hardenWindow, PAIR_CSP, SECRET_CSP } from './harden.ts';
import { dispatchShell, IPC, type ShellEvent, type ShellHandlers } from './ipc.ts';
import { secretPageHtml, SecretWindowCoordinator, type SecretInputBind as OneShotInputBind } from './secret-labels.ts';
import { openVaultInputWindow } from './secret-window.ts';
import { bankAutoHandlers, CODEF_WINDOW_TITLE, codefPageHtml, parseCodefNeeded, type CodefNeeded } from './bank-auto.ts';
import { barBounds, browserPanelWidth, SHELL } from './shell-layout.ts';
import { EmbeddedBrowser, keepDrawingWhenHidden } from './embedded-browser.ts';
import { engineIntentResolver, INTENT_UNAVAILABLE_TEXT, MODEL_CONSENT_FIRST_TEXT, routed, type IntentResolver } from './intent-route.ts';
import { CHAT_ERROR_TEXT, engineChatResponder, suggestChips, type ChatResponder } from './chat-reply.ts';
import { answersPending, emptyDocStore, NO_AUTH, SETUP_LABEL, setupMissing, setupText, type SetupItem, SIGN_LABEL, interpret, parseRegex, QUICK, REMINDER_DAY_DEFAULT, sentFromGateway, type Counterparty, type DocStore, type G24Doc, type Parsed, type Profile, type RunView, type SentTo, type VatMode, EMPTY_REQUEST_TEXT } from './shell-model.ts';
import { engineDocsProvider, type DocsProvider } from './shell-docs.ts';
import { readPastRuns, type PastRun } from './run-history.ts';
import { fatalText, REHEARSAL, ShellRuns, vaultNotice } from './shell-runs.ts';
import { AgentChat, type AgentPhase } from './agent-chat.ts';
import { agentPorts } from './agent-wiring.ts';
import type { StepParams, StepResult } from '@sax/engine';
import { bundleCss, tokensCss } from './shell-tokens.ts';
import { cancelPick, importPdf, pickFileBytes } from './vault-import.ts';
import { readBizCert, type BizCertReadPorts } from './bizcert-read.ts';
import { CounterpartyBook } from './counterparty-book.ts';
import { nameMissing, ProfileEditLog, ProfileEditor } from './profile-edit.ts';
import { DesktopAccount, PendingCodeFile, RemoteIdentityFile } from './remote-account.ts';
import { GatewayAuthHost } from './gateway-auth.ts';
import type { CloudPorts, VaultKeysFactory } from './remote-ports.ts';
import { PairingHost } from './remote-pairing.ts';
import { qrSvgDataUrl } from './remote-qr.ts';
import { PairWindow } from './pair-window.ts';
import type { DemoModel, mergeParsed } from './demo-model.ts';
import type { DemoSeed, startDemoSeed } from './demo-seed.ts';

const STATIC = path.join(import.meta.dirname, '../static');
export const SHELL_SCHEME = 'sax-shell';
/** 제품에서 사업장·개인 프로필을 아직 등록하지 않았을 때의 자리(견본 이름을 쓰지 않는다). */
const NO_BUSINESS: Profile = { kind: 'business', name: '내 사업장', email: '', auth: '' };

/** 제품에는 아직 개인 프로필 저장이 없다. 자리 표시만(내 사업장은 이 카드를 그리지 않는다). */
const NO_PERSONAL: Profile = { kind: 'personal', name: '개인', email: '', auth: '', placeholder: true };
const SHELL_URL = `${SHELL_SCHEME}://shell/shell.html`;
const PAIR_URL = `${SHELL_SCHEME}://shell/pair.html`;

export function registerShellSchemes(): void {
  // 한 번만 부를 수 있다(ready 전). 문서함 PDF 가져오기가 docparse 샌드박스를 쓰므로 그 스킴도 여기서 등록한다.
  // 공용 하드닝(디버그 스위치·샌드박스·새 창·이동·webview 거부)도 ready 전에 여기서 건다(ADR-025 결정 8).
  hardenApp(app, [`${SHELL_SCHEME}:`, `${APPROVAL_SCHEME}:`, `${DOCPARSE_SCHEME}:`]);
  // 앱 안 브라우저 자동화는 앱 창이 가려지거나 화면이 잠겨도 멈추지 않아야 한다(예행은 사람이 자리를 비운 채 돈다).
  keepDrawingWhenHidden(app);
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
  '/shell-account.js': 'text/javascript',
  '/shell-biz.js': 'text/javascript',
  '/shell-bank.js': 'text/javascript',
  '/password-rules.js': 'text/javascript',
  '/common-passwords.js': 'text/javascript',
  '/pair.html': 'text/html; charset=utf-8',
  '/pair.js': 'text/javascript',
  '/pair.css': 'text/css',
  '/secret.js': 'text/javascript',
  '/secret.css': 'text/css',
  '/codef-secret.js': 'text/javascript',
  '/shell-bank-auto.js': 'text/javascript',
};

/** 지금 열린 비밀 창의 페이지(main이 만든다). 열린 창이 없으면 null(404). */
let secretPage: () => string | null = () => null;
/** 지금 열린 계좌 자동조회 인증서 비밀번호 창의 페이지(bank-auto.ts). 없으면 null(404). */
let codefPage: () => string | null = () => null;

function serve(): void {
  protocol.handle(SHELL_SCHEME, async (req) => {
    const p = new URL(req.url).pathname;
    // 모든 응답에 CSP 헤더(D11 §4): 셸은 APP_CSP, main이 만든 비밀 창 페이지는 더 좁은 SECRET_CSP.
    if (p === '/tokens.css') return new Response(tokensCss(), { headers: appHeaders('text/css') });
    if (p === '/secret.html') {
      const html = secretPage();
      return html ? new Response(html, { headers: appHeaders('text/html; charset=utf-8', SECRET_CSP) }) : new Response('', { status: 404 });
    }
    if (p === '/codef-secret.html') {
      const html = codefPage();
      return html ? new Response(html, { headers: appHeaders('text/html; charset=utf-8', SECRET_CSP) }) : new Response('', { status: 404 });
    }
    if (p === '/bundle.css') return new Response(bundleCss(), { headers: appHeaders('text/css') });
    const type = FILES[p];
    if (!type) return new Response('', { status: 404 });
    // 폰 연결 창(S-03)은 비밀 창과 같은 좁은 CSP(연결·폼 전송 없음)
    return new Response(await fs.readFile(path.join(STATIC, 'shell', p.slice(1))), { headers: appHeaders(type, p === '/pair.html' ? PAIR_CSP : undefined) });
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
  /** 앱 금고(utilityProcess·OS 키체인)와 앱 폴더로 띄운다. 없으면 fixture 모드(dev가 있어야 한다). */
  engine?: { root?: string; portal: EnginePortal };
  /** fixture 모드에서 실행 Chrome을 화면에 띄운다(시연). */
  headful?: boolean;
  /** 문서함 보관함 공급자(shell-docs.ts). 없으면 이 셸의 엔진(host.rpc)을 쓴다. e2e가 감싸서 넘긴다. */
  docs?: DocsProvider;
  /** e2e: [홈택스에서 준비] 분당 상한(기본 3, 사람 속도). 렌더러가 바꿀 수 없다(진입점이 정한다). */
  preparePerMin?: number;
  /** e2e: Chrome 사전 점검을 바꿔 끼운다. 기본은 금고와 같은 후보 경로(@sax/vault findInstalledChrome)에 Chrome이 있는가. */
  chromeReady?: () => boolean;
  /**
   * 옛 길: 실행 브라우저로 설치 Chrome을 띄운다(앱 뒤에 두고 패널에 중계). 기본은 앱 안 브라우저(embedded-browser.ts, 대표 지시 2026-11-13
   * "크롬 탭이 아예 열리지 않게"). 앱 안 브라우저가 고객 PC에서 막히면 되돌릴 수 있게 한 판 동안 남긴다.
   */
  externalChrome?: boolean;
  /** e2e·첫 실행 따라가기: 보안 프로그램 점검·설치 링크 열기·켜기를 바꿔 끼운다. 기본은 이 PC의 MagicLine4NX(security-programs.ts)와 기본 브라우저. */
  security?: { status(): SecurityStatus; install?(key: string): Promise<void>; start?(): boolean };
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
  /**
   * 계정·기기 연결(A-01 로그인, S-03 폰 연결, remote-ports.ts). 제품 진입점은 remote-wiring.ts productRemote(cloudPorts + vaultDesktopKeys)를 넘긴다.
   * 없으면 화면은 "이 빌드에서는 아직 연결할 수 없어요"로 끝난다. e2e는 가짜 포트를 넘긴다.
   */
  remote?: RemoteWiring;
  /** 받을 돈 파일 고르기(09). 기본은 메인 창 파일 대화상자. e2e가 가짜 파일로 바꿔 끼운다. */
  bankPick?: (kind: PickKind) => Promise<Uint8Array | null>;
  /** 대화 의도 해석기(M4-3 ③). 기본은 엔진 `intent.resolve`(intent-route.ts). e2e가 바꿔 끼운다. */
  intent?: IntentResolver;
  /** 대화 짧은 응대(chat-reply.ts). 기본은 엔진 `chat.respond`. e2e가 바꿔 끼운다. */
  chat?: ChatResponder;
  /**
   * 대화 에이전트의 모델 경계(엔진 `chat.step`, agent-chat.ts). 제품 사업자 대화는 늘 이 길이다.
   * 시연(fixture)은 이것을 넘긴 e2e만 이 길로 간다(넘기지 않으면 옛 해석 길).
   */
  agent?: {
    step(p: StepParams): Promise<StepResult>;
    /** 확인용: 대화 에이전트가 읽는 원장 발급 이력(db.query.runs.history) 자리. 없으면 엔진에 묻는다. */
    history?(p: Record<string, unknown>): Promise<unknown>;
  };
}

/** ShellOptions.remote. */
export interface RemoteWiring {
  cloud: CloudPorts | null;
  keys: VaultKeysFactory | null;
  /** 계정 기기 목록에 보일 이름. 사람 이름이 들어가지 않게 기본은 운영체제 이름. */
  deviceName?: string;
  /** 룸 클라이언트를 바꿔 끼운다(e2e·개발 스택의 메모리 릴레이). 없으면 cloud.openSocket 위 WSS(wsRelayClient). */
  relayClient?: RelayClient;
}

/** ShellOptions.update. updater가 없으면(시험) electron-updater를 불러온다. */
export interface UpdateWiring {
  channel: Channel;
  origin: string;
  /** 레지스트리 GET(latest.json·투명성 로그, update-sources.ts). 폐기 목록은 엔진이 받아 둔 것을 쓴다. */
  egress: Pick<Egress, 'getRegistry' | 'getRegistryBytes'>;
  /** 핀 키. 없으면 엔진 핀(db.query.registry.pins). 실계정 시험 빌드의 로컬 피드만 넘긴다(shell.ts). */
  trust?: TrustRoot;
  /** 실계정 시험 빌드의 로컬 피드(http://127.0.0.1)만 true(update-electron feedUrl). */
  loopback?: boolean;
  /** false면 설치 뒤 다시 열지 않는다. 로컬 피드 시험만(update-electron electronInstaller). */
  relaunch?: boolean;
  testBuild: boolean;
  setting?: { requireTransparency?: unknown } | null;
  updater?: AppUpdaterLike;
}

/** 개발 전용 연결(ShellOptions.dev). 여기에는 타입만 있고, 구현은 demo-dev.ts가 묶는다. */
export interface ShellDev {
  startFixture(opts: { headful?: boolean }): Promise<FixtureMode>;
  startDemoSeed: typeof startDemoSeed;
  mergeParsed: typeof mergeParsed;
  /** 견본 데이터(시연·e2e만, shell-mock.ts·onboarding-mock.ts). 제품은 이 값을 갖지 않는다(ADR-035 W-7). */
  sample: ShellSample;
}

/** 시연 견본: 견본 서류 저장소·사업장·대화·빠른 실행·꾸러미·카드·정부24 후보·온보딩 바깥 일·거래처 등록증. */
export interface ShellSample {
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
  /** fixture 모드면 가짜 페이지·임시 앱 폴더. */
  fixture: FixtureMode | null;
  ready: Promise<void>;
  /** 렌더러가 부를 수 있는 메서드 전부(e2e가 승인 경로가 없는지 훑는다). */
  methods: string[];
  /** 지금 대화에 떠 있는 비밀 입력 카드(금고 secret.needed로만 뜬다). 값은 없다. */
  secretAsk(): { reqId: string; kind: string; runId: string } | null;
  close(): Promise<void>;
}


function profileView(p: DbProfile): Profile {
  const unnamed = p.kind === 'business' && nameMissing(p);
  return { kind: p.kind, name: unnamed ? NO_BUSINESS.name : p.displayName, ...(unnamed ? { nameMissing: true } : {}), bizNo: p.bizNo ?? undefined, rep: p.repName ?? undefined, bizType: p.bizType ?? undefined, bizItem: p.bizItem ?? undefined, address: p.address ?? undefined, email: p.email ?? '', auth: (p.signMethod && Object.hasOwn(SIGN_LABEL, p.signMethod) ? SIGN_LABEL[p.signMethod as keyof typeof SIGN_LABEL] : null) ?? NO_AUTH };
}

/** DB 거래처 → 셸 화면 모델. 품목은 저장 품목(counterparty.getItems)의 첫 이름, 없으면 fixture 시연 값(itemHints). */
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
  // CDP로 넣은 마우스 이벤트도 before-mouse-event를 일으키므로 디버그 스위치가 있으면 끝낸다(ADR-021·ADR-025 결정 8, 값싼 차단).
  assertNoDebugSwitches(app);
  serve();
  const key = new Uint8Array(randomBytes(32));
  // 제품(엔진 모드)은 견본 서류를 보이지 않는다. 문서함은 엔진 보관함(PoC-8)만이다. 견본 저장소는 시연 연결로만 온다.
  const store: DocStore = opts.engine ? emptyDocStore() : opts.dev!.sample.store();
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

function wireShell(opts: ShellOptions, fixture: FixtureMode | null, key: Uint8Array, store: DocStore, made: { host?: EngineHost }): Shell {
  // 공급사 직결(D04 예외)은 fixture 시연에만. 실제 홈택스 모드에서는 넘겨받아도 쓰지 않는다.
  const demo = fixture ? (opts.demoModel ?? null) : null;
  const dev = fixture ? opts.dev! : null;
  /** 견본 데이터는 fixture(시연·e2e)에서만 있다. 제품은 null. */
  const sample = dev?.sample ?? null;
  const root = fixture?.root ?? opts.engine?.root;
  const log = new FileEventLog(appPaths(root ?? defaultAppRoot()).logs, 'main');
  const embedded = opts.externalChrome !== true;
  const host = new EngineHost({ vault: fixture ? fixture.vault : 'process', root, portal: fixture?.portal ?? opts.engine!.portal, log, appVersion: app.getVersion(), embeddedBrowser: embedded });
  made.host = host;
  let business: Profile | null = null;
  /** 사업자 프로필 DB id(대화 에이전트 세션 기준). 없으면 대화가 등록부터 안내한다. */
  let businessId: string | null = null;
  let cps: Counterparty[] = [];
  const refresh = async () => {
    const ps = (await host.rpc('db.query.profiles.list')) as DbProfile[];
    const b = ps.find((p) => p.kind === 'business');
    business = b ? profileView(b) : null;
    businessId = b?.id ?? null;
    // 최근 발급일: 원장(DB)에 없으면 문서함 세금계산서(지난 발급 견본 포함)에서
    const lastDoc = (name: string) => store.docs.filter((d) => d.kind === '세금계산서' && d.name === `세금계산서 · ${name}`).reduce<string | null>((m, d) => (d.issuedOn && (!m || d.issuedOn > m) ? d.issuedOn : m), null);
    const rows = (await host.rpc('db.query.counterparties.list')) as DbCounterparty[];
    // 저장 품목의 첫 이름(못 읽으면 없음). 거래처 목록 모양은 #141 그대로라 품목은 따로 읽는다(#144).
    const firsts = await Promise.all(rows.map((c) => host.rpc('counterparty.getItems', { id: c.id }).then((r) => (Array.isArray(r) ? (r[0] as { name?: string } | undefined)?.name : undefined), () => undefined)));
    cps = rows.map((c, i) => counterpartyView(c, fixture?.itemHints ?? {}, firsts[i])).map((c) => ({ ...c, lastIssuedOn: c.lastIssuedOn ?? lastDoc(c.name) }));
    runs.syncAuth();
  };
  // 받을 돈(09 D-09): 파일은 main이 고르고 샌드박스로 읽어 다듬은 줄만 엔진에 보낸다(bank-host.ts).
  const bank = new BankHost({
    rpc: (m, p) => host.rpc(m, p ?? {}),
    profileId: async () => ((await host.rpc('db.query.profiles.list')) as DbProfile[]).find((p) => p.kind === 'business')?.id ?? null,
    pick: (kind) =>
      opts.bankPick
        ? opts.bankPick(kind)
        : pickFileBytes([{ name: kind === 'statement' ? '은행 거래내역(엑셀·CSV)' : '홈택스 발급 목록(엑셀)', extensions: ['xlsx', 'xls', 'csv', 'htm', 'html'] }], win),
    readSheet: async (bytes) => {
      const r = await readSheetInSandbox(bytes);
      return { format: r.format, encoding: r.encoding, sheets: r.sheets, flags: r.flags };
    },
    log: (n, d) => log.event(n, d),
  });
  let seed: DemoSeed | null = null;
  // 제품은 견본 사업장(가나다컴퍼니)을 보이지 않는다. 등록 전이면 빈 자리 이름만(온보딩이 채운다).
  const profiles = () =>
    sample ? { business: business ?? sample.profiles.business, personal: sample.profiles.personal } : { business: business ?? NO_BUSINESS, personal: NO_PERSONAL };
  // Chrome이 있어야 홈택스 작업을 한다. 판의 할 일·첫 발급 요청(U6)과 [홈택스에서 준비](#288)가 같은 점검을 쓴다.
  // 앱 안 브라우저면 설치 Chrome이 필요 없다(설치 안내 단계도 없다).
  const chromeReady = opts.chromeReady ?? (() => embedded || findInstalledChrome() !== null);
  const securityNow = opts.security ? () => opts.security!.status() : () => securityStatus();
  /** 공동인증서로 발급하는 사업자인데 MagicLine4NX가 없거나 꺼져 있다(홈택스가 설치 안내로 멈출 자리, B4). */
  const securityMissing = () => profile === 'business' && profiles().business.auth === SIGN_LABEL.cert && securityBlocks(securityNow());
  // prepare: 점검 끝 자동 재시작도 [홈택스에서 준비]와 같은 상한·레지스트리 재조회를 거친다(prepareNow는 아래에서 정의, 부를 때 읽는다)
  const runs = new ShellRuns(host, { counterparties: () => cps, auth: () => profiles().business.auth, chromeReady, log: (n, d) => log.event(n, d), prepare: (id: string): Promise<unknown> => prepareNow(id) });
  let profile: Profile['kind'] = 'business';
  // 파일 대화상자는 메인 창을 부모로 띄운다(win은 아래에서 만든다).
  const docs = opts.docs ?? engineDocsProvider((m, p) => host.rpc(m, p), (params, engine) => importPdf(params, engine, win));
  /** 문서함 = 보관함 서류 + 실행이 만든 서류(세금계산서·정부24 목업) */
  const listDocs = async () => {
    try {
      // 실행이 보관한 발급 PDF가 있으면 같은 실행의 메모리 줄(d-<runId>, 거래처 이름)을 그 PDF 줄로 바꾼다([열기]가 보관함 파일을 연다).
      const vault = await docs.list();
      const mem = new Map(store.docs.map((d) => [d.id, d]));
      const named = vault.map((d) => (d.runId && mem.has(`d-${d.runId}`) ? { ...d, name: mem.get(`d-${d.runId}`)!.name } : d));
      const runs = new Set(vault.flatMap((d) => (d.runId ? [`d-${d.runId}`] : [])));
      return [...named, ...store.docs.filter((d) => !runs.has(d.id))];
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
    // 설치본은 앱 이름만. 가짜 홈택스(fixture)일 때만 시연 표시를 남긴다.
    title: fixture ? '소버린 AX (PoC 데모 · 가짜 홈택스 페이지)' : '소버린 AX',
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
  // 창 제목은 main이 정한다(페이지 <title>이 덮지 않게): 설치본 "소버린 AX", fixture만 시연 표시.
  win.on('page-title-updated', (e) => e.preventDefault());
  const wc = win.webContents;
  // 새 창·이동 거부, 렌더러의 window.moveTo·resizeTo 무시, 배율 1 고정.
  hardenWindow(win);
  // 사용자 동작 결속(ADR-027 결정 8): main이 메인 창에서 직접 본 실제 입력(mouseUp, 수식키 없는 Enter·Space) 시각.
  const gesture = new GestureClock();
  // 코드 칸 입력(이메일 6자리 확인만): 실제 입력 + 메인 창의 아무 키 입력(숫자·붙여 넣기). 이것도 main이 직접 본 입력이다.
  const typing = new GestureClock();
  /** 패널 브라우저 조작: main이 메인 창에서 본 아무 마우스·키 입력(이동·휠 포함) 시각. browser.input은 이것이 1초 안에 있을 때만 넘긴다. */
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
  /** 실제 입력이 ms 안에 없으면 gesture_required. */
  const needGesture = (ms: number) => {
    if (!gesture.within(performance.now(), ms)) throw new Error('gesture_required');
  };
  /** 코드 칸이 6자리가 차서 바로 확인할 때: 클릭·Enter·Space 또는 키 입력이 ms 안에 있어야 한다. */
  const needTyping = (ms: number) => {
    if (!typing.within(performance.now(), ms)) throw new Error('gesture_required');
  };

  /**
   * 앱 안 브라우저 패널 폭(실행 중일 때, main 상태). 사람이 경계를 끌어 고른 폭(browserWant)과 [브라우저] 크게(browserShown)로 정하고,
   * 승인 대기 중에는 승인 카드가 대화 열 안에 들어가게 줄인다. 승인 카드 자리(barBounds)도 이 값을 쓴다(렌더러가 보고한 값이 아니다, ADR-021).
   */
  let browserAvailable = false;
  let browserShown = false;
  let browserWant: number | null = null;
  const panelNow = (): number => {
    if (!embedded || !browserAvailable || win.isDestroyed()) return SHELL.panel;
    return browserPanelWidth(win.getContentSize()[0]!, browserWant, browserShown, bar.active);
  };
  const bar: ApprovalBar = new ApprovalBar(win, key, (w, h, wide, height) => barBounds(w, h, wide, height, panelNow()), { log });
  const send = (ev: ShellEvent) => {
    if (!win.isDestroyed()) wc.send(IPC.event, ev);
  };
  /** 실행 화면 주소(패널 주소창·탭 이름). 금고 중계 프레임이 아니라 보기의 실제 주소다. */
  let pageNow: { url: string; title: string } | null = null;
  const eb = embedded
    ? new EmbeddedBrowser({
        win,
        post: (m) => host.browserPost(m),
        log,
        onPage: (p) => {
          if (pageNow?.url === p?.url && pageNow?.title === p?.title) return;
          pageNow = p;
          // 주소창에는 호스트·경로만(검색어·조각은 싣지 않는다, 금고 pageAddress와 같다)
          const addr = p?.url ? pageAddress(p.url) : '';
          if (mirrorRun && addr) send({ type: 'screen', runId: mirrorRun, url: addr, title: p!.title.slice(0, 120) });
        },
      })
    : null;
  host.on('browser', (m: unknown) => eb?.feed(m));
  win.once('closed', () => eb?.closeAll('window'));
  // 진단: macOS는 창이 다른 Space로 가거나 완전히 가려지면 hide, 돌아오면 show를 낸다(Electron 가림 알림). 예행 로그에서 실패 시각과 맞춰 본다.
  if (eb) {
    win.on('hide', () => log.event('main.window_hide', { visible: win.isVisible(), minimized: win.isMinimized() }));
    win.on('show', () => log.event('main.window_show', { visible: win.isVisible(), minimized: win.isMinimized() }));
  }
  // 다른 앱에서 돌아온 클릭이 버튼 위였는지 렌더러가 보게 커서 자리만 알린다(F-11). 클릭을 만들거나 실제 입력으로 세지 않는다.
  win.on('focus', () => {
    if (win.isDestroyed()) return;
    const p = screen.getCursorScreenPoint();
    const c = win.getContentBounds();
    const x = p.x - c.x;
    const y = p.y - c.y;
    if (x >= 0 && y >= 0 && x < c.width && y < c.height) send({ type: 'activated', x, y });
  });
  /** 지난 발급(시연 씨앗 이력 + 문서함 세금계산서). 원장 발급 이력 질의가 나오면 그쪽으로 바꾼다. */
  const issuedInvoices = (): IssuedInvoice[] => {
    const total = new Map((seed?.past ?? []).flatMap((p) => (p.documentId ? [[p.documentId, p.total]] : [])));
    return store.docs.filter((d) => d.kind === '세금계산서' && d.issuedOn).map((d) => ({ who: d.name.replace(/^세금계산서 · /, ''), date: d.issuedOn!, total: total.get(d.id) ?? null }));
  };
  /** 이번 달 판(M-02, ADR-033). 꾸러미·카드는 아직 견본뿐이라 시연(sample)에서만 칸을 둔다. */
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
    const money = profile === 'business' ? await bank.boardCards() : [];
    return buildBoard({
      today,
      reminderDay: sample?.settings.reminderDay ?? REMINDER_DAY_DEFAULT,
      issued: issuedInvoices(),
      runs: runs.list().map((r) => ({ id: r.id, status: r.status, who: r.counterparty.name, inDoubt: r.inDoubt === true })),
      docs: docsNow.map((d) => ({ id: d.id, name: d.name, expiresOn: d.expiresOn, needsUser: !!d.vault?.needsUser })),
      // 세무사 꾸러미(D-05)·사업용 카드(D-04)는 아직 목업 어댑터다. 제품은 칸을 두지 않는다.
      bundle: sample ? sample.bundle(today) : null,
      cardFetchedOn: sample?.settings.cardFetchedOn ?? null,
      cardEnabled: !!sample,
      setup: [...onboardingTodos(onb?.state ?? null), ...(profile === 'business' && !chromeReady() ? [{ id: 'chrome', label: SETUP_LABEL.chrome, view: 'chrome' as const }] : []), ...(securityMissing() ? [{ id: 'security', label: SETUP_LABEL.security, view: 'security' as const }] : [])],
      // 받을 돈 카드(대표 결정 ⑤, ADR-033 카드 4종 → 6종 개정 전 제안). 판 뒤에 붙인다.
      money,
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
  bar.on('shown', (e: { band: boolean; height: number }) => {
    send({ type: 'bar', active: true, band: e.band, height: e.height });
    if (embedded && browserAvailable) sendBrowserState(); // 승인 카드가 대화 열 안에 들어가게 줄인 패널 폭
  });
  bar.on('layout', (e: { band: boolean; height: number }) => send({ type: 'bar-layout', band: e.band, height: e.height }));
  bar.on('hidden', (reason: string) => {
    send({ type: 'bar', active: false, reason });
    if (embedded && browserAvailable) sendBrowserState();
  });
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
  secretPage = () => {
    const r = secrets.open;
    return r ? secretPageHtml(r, profiles()[r.scope].name) : null;
  };
  /**
   * 실행 Chrome은 어떤 경우에도 앱 앞에 오지 않는다(대표 지시 2026-11-14). 앱(비밀번호 창이 열려 있으면 그 창)을 앞으로 둔다.
   * Chrome이 스스로 앞으로 오는 때(기동·팝업 창·페이지의 창 포커스)는 금고 알림과 아래 앱 비활성 감시로 바로 되돌린다.
   */
  let runChromePid = 0;
  const appToFront = () => {
    if (win.isDestroyed()) return;
    app.focus({ steal: true });
    win.moveTop();
    win.focus();
  };
  // 맥: 실행 Chrome이 떠 있는 동안 맨 앞 앱을 0.4초마다 본다. 금고가 띄운 그 Chrome 프로세스가 맨 앞이면(스스로 창을 올림) 앱을 다시 앞으로.
  // 사람이 다른 앱(자기 Chrome 포함)을 쓰는 것은 건드리지 않는다(프로세스 id로만 가린다).
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
  // 메인 창이 닫히는 중이면 비밀 창을 새로 열지 않는다(들고 있던 다음 요청 포함).
  let mainClosing = false;
  win.once('close', () => {
    mainClosing = true;
  });
  /**
   * 비밀 입력은 대화 안 카드로 받는다(대표 지시 2026-11-14 "앱 내 채팅으로", 따로 뜨는 금고 창 없음).
   * 금고 secret.needed → 렌더러에 가려진 입력 카드(secretAsk open) → 사람이 넣으면 secret.answer로 main → 금고 1회용 입력 포트(secret.provide)로만.
   * 값은 main에서 바이트로 바꿔 넘기고 바로 0으로 덮는다. 로그·대화 기록·모델·렌더러 상태에 남기지 않는다(대화에는 "●●●● 입력함"만).
   */
  let secretAsk: { reqId: string; bind: OneShotInputBind } | null = null;
  const SECRET_LABEL: Record<string, string> = { cert_password: '공동인증서 비밀번호', portal_password: '홈택스 비밀번호', security_card: '보안카드 번호' };
  const closeSecret = () => {
    if (!secretAsk) return;
    send({ type: 'secretAsk', reqId: secretAsk.reqId, state: 'closed' });
    secretAsk = null;
    secrets.closed(); // main이 닫았다(실행 끝·종료): 든 요청은 버린다
  };
  const openSecret = (data: unknown): void => {
    if (mainClosing || win.isDestroyed()) return log.event('main.secret_needed_ignored');
    const r = secrets.request(data);
    if (!r) return log.event(secrets.open ? 'main.secret_needed_queued' : 'main.secret_needed_ignored');
    const bind: OneShotInputBind = { runId: r.runId, kind: r.kind, scope: r.scope, ...(r.row !== undefined ? { row: r.row } : {}) };
    secretAsk = { reqId: randomUUID().slice(0, 18), bind };
    const label = r.kind === 'security_card' && r.row ? `${SECRET_LABEL[r.kind]} ${r.row}번` : (SECRET_LABEL[r.kind] ?? '비밀번호');
    const note = r.kind === 'cert_password' ? '처음 한 번만 넣으면 이 Mac 금고에 두고 다음부터 묻지 않아요.' : '이번 실행에서 한 번만 쓰고 저장하지 않아요.';
    send({ type: 'secretAsk', reqId: secretAsk.reqId, state: 'open', runId: r.runId, kind: r.kind, label, note });
    // 앱이 앞에 있어야 카드가 보인다(Chrome은 올리지 않는다)
    if (win.isMinimized()) win.restore();
    if (!win.isVisible()) win.show();
    app.focus({ steal: true });
    win.focus();
    log.event('main.secret_ask_shown', { kind: r.kind });
  };
  /** 금고 1회용 입력 포트로 한 번 보낸다(값은 이 함수 밖으로 나가지 않는다). */
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
  /** 설정에서 인증서 비밀번호를 금고에 저장한다(값은 이 함수 밖으로 나가지 않는다). */
  const saveCertMemory = async (value: unknown): Promise<{ remembered: boolean }> => {
    if (typeof value !== 'string' || !value) throw new Error('bad_value');
    const bytes = new TextEncoder().encode(value);
    const r = await vaultSecretSend({ mode: 'store', kind: 'cert_password', scope: 'business', notice: { version: 'cert-settings-2026-11-14' } }, 'secret.store', { entries: [{ field: 'pw', bytes }] });
    bytes.fill(0);
    log.event('main.cert_memory_saved', { ok: r.ok, ...(r.error ? { error: r.error } : {}) });
    if (!r.ok) throw new Error('vault_refused');
    return { remembered: true };
  };
  /** 대화 카드의 답(secret.answer). 넣었으면 금고로, 취소면 카드만 닫는다(금고 칸은 실행 TTL까지 기다린다). */
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
    const params: Record<string, unknown> = { kind: ask.bind.kind, scope: ask.bind.scope, bytes, ...(ask.bind.row !== undefined ? { row: ask.bind.row } : {}) };
    const r = await vaultSecretSend(ask.bind, 'secret.provide', params);
    bytes.fill(0);
    log.event('main.secret_ask_answered', { kind: ask.bind.kind, ok: r.ok, ...(r.error ? { error: r.error } : {}) });
    if (!r.ok) throw new Error('vault_refused');
    if (secretAsk === ask) secretAsk = null;
    send({ type: 'secretAsk', reqId: ask.reqId, state: 'done' });
    const next = secrets.closed();
    if (next) openSecret(next);
    return { ok: true };
  };
  // 계좌 자동조회 인증서 비밀번호 창(금고 codef.seal이 부른다). 하나만. 값 없이 닫히면 금고에 알려 기다림을 끝낸다.
  let codefWin: { win: BrowserWindow; req: CodefNeeded } | null = null;
  codefPage = () => (codefWin ? codefPageHtml(codefWin.req, { profileName: profiles()[codefWin.req.scope].name, certLabel: bankAuto.chosenLabel() }) : null);
  const openCodef = (req: CodefNeeded): void => {
    if (mainClosing || win.isDestroyed() || codefWin) {
      void host.control('codef.windowClosed', { reqId: req.reqId }).catch(() => {});
      return log.event('main.codef_window_ignored');
    }
    let port: ReturnType<typeof host.secretInputPort> | null = null;
    try {
      port = host.secretInputPort(req);
      const w = openVaultInputWindow(win, port, `${SHELL_SCHEME}://shell/codef-secret.html`, CODEF_WINDOW_TITLE, 340);
      codefWin = { win: w, req };
      w.on('closed', () => {
        if (codefWin?.win === w) codefWin = null;
        // 값을 넘겼으면 금고는 이미 요청을 끝냈다(같은 reqId 취소는 할 일이 없다)
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
    // 진행 화면(B3): 금고가 중계한 실행 탭 화면을 지금 실행 패널로만 보낸다(보기 전용, 저장하지 않는다).
    if (name === 'screen.frame' || name === 'screen.paused') {
      if (!mirrorRun) return;
      const d = (data ?? {}) as { data?: unknown; w?: unknown; h?: unknown; url?: unknown; paused?: unknown };
      if (name === 'screen.paused') return send({ type: 'screen', runId: mirrorRun, paused: d.paused === true });
      if (typeof d.data !== 'string' || d.data.length > 2_000_000) return;
      return send({ type: 'screen', runId: mirrorRun, frame: `data:image/jpeg;base64,${d.data}`, w: Number(d.w) || 0, h: Number(d.h) || 0, url: typeof d.url === 'string' ? d.url.slice(0, 200) : '' });
    }
    // 앱 안 브라우저: 금고가 비밀 칸에 넣는 동안 보기의 사람 입력을 막고 패널에 "비밀번호 입력 중"
    if (name === 'browser.blocked') {
      const on = (data as { blocked?: unknown } | null)?.blocked === true;
      eb?.setBlocked(on);
      if (mirrorRun) send({ type: 'screen', runId: mirrorRun, paused: on });
      return;
    }
    // 실행 Chrome이 사람 손으로 닫혔다(탭 전부·프로세스): 패널은 "연결 끊김", 제출 전 실행은 멈추고 [다시 시작]
    if (name === 'browser.launched') {
      // Chrome이 막 떴거나 포털 팝업 창이 떠 macOS가 Chrome을 앞으로 올렸다: 앱을 바로 다시 앞으로(창이 늦게 그려지니 2초 동안 몇 번 더).
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
    // 예행은 엔진이 게이트 요청을 보내지 않는다. 그래도 오면 바를 띄우지 않고 멈춘다(토큰 없음).
    if (runs.get(runId)?.rehearsal) {
      log.event('main.rehearsal_gate_refused', { runId });
      return void runs.stop(runId).catch(() => {});
    }
    // 비가역 줄은 이 실행의 발급 인증(시작 때 고정, 엔진이 고르는 인증유형과 같다)으로 말한다.
    void bar.open(req, runs.get(runId)?.auth).then(async (o) => {
      if (o.decision === 'approve') {
        if (!verifyLocalApproval(key, o.approval)) return runs.abortGate(runId, 'answer.rejected');
        // 보내기 전에 표시한다. 보낸 뒤 엔진이 끝나면 발급됐는지 모르는 쪽(in_doubt)으로 다룬다.
        runs.approved(runId);
        const r = await host.answerGate(o.approval);
        if (!r.ok) log.event('main.gate_answer_not_ok', { code: r.code ?? '', verdict: r.verdict });
        await runs.onAnswer(runId, r);
      } else if (o.reason === 'stopped') {
        // 카드의 [중지](main이 관찰한 클릭·키). 렌더러 [중지]와 같은 경로로 실행을 멈춘다(안전한 실패).
        await runs.stop(runId).catch((e: Error) => log.event('main.card_stop_failed', { error: e.message.slice(0, 80) }));
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
        // 증언 카드의 [닫기]: 카드를 다시 열 때(incident.open)까지 띄우지 않는다.
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
  // 레지스트리 동기화(D09 §8.1 인덱스 15분, D03 §7.1 정책 재조회): 제품만. 엔진이 운영 레지스트리(tax.laf-co.com, Egress 고정 origin·핀 키)에서
  // 인덱스·정책·H-01 패키지를 받아 둔다. 받지 못하면 엔진이 실행 시작을 package.not_loaded·policy.*로 거부한다(fail-closed).
  // 기동은 기다리지 않는다(네트워크가 없어도 홈까지 간다). 실행 직전에는 15분 넘었으면 최대 10초 기다린다. 기록은 결과 코드뿐이다.
  const REGISTRY_EVERY_MS = 15 * 60_000;
  /** 홈택스 안내 창(24분)보다 넉넉히 앞. 홈택스 [연장하기] 한 번과 같은 요청이다. */
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
  // 홈택스 로그인 유지: 앱이 켜져 있는 동안 홈택스 자동 로그아웃(24분 안내·30분 로그아웃)보다 먼저 [연장하기]와 같은 일을 한다.
  // 엔진이 화면을 움직이는 동안(준비·발급 중), 승인을 보낸 뒤(거부 우선 창), 게이트 뒤 사람 차례(서명)는 건드리지 않는다.
  // 승인 대기·게이트 앞 사람 차례(로그인 등)는 한다.
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
  // 온보딩(08 §4, M4-2). 저장(동의 기록·이어 하기·프로필·포털 아이디)은 엔진 main 전용 명령으로 DB에(onboarding-store.ts, 엔진 #91·db #53).
  // 바깥 일: 등록증 읽기(bizcert-read.ts, M4-3)·NPKI(npki-certs.ts, #93)는 제품 어댑터다. 진위확인(#65)·금고 등록 창(T-06)은 아직 없어 정직한 실패로 둔다.
  // 처리자 표는 앱 내장 판(CONSENT_CONFIG). 시연·e2e(fixture)는 견본 바깥 일(ShellDev.sample.onboarding)을 쓴다.
  let onb: OnboardingFlow | null = null;
  /** 이번 기동에 온보딩 대화를 보일지. 지난 기동에 끝낸 온보딩은 불러와 두되(동의·할 일) 대화로 다시 그리지 않는다. */
  let onbShow = true;
  const onbStore = new EngineOnboardingStore((m, p) => host.rpc(m, p));
  /** M4-2 목업 때의 이어 하기 파일. DB에 행이 없으면 한 번 옮기고 지운다. */
  const legacyOnbFile = path.join(appPaths(root ?? defaultAppRoot()).userData, 'onboarding-state.json');
  // 공동인증서 목록: 제품은 금고 npki.list(이 PC의 NPKI 폴더 열거) → docparse 샌드박스 certInfo → 표시 행(npki-certs.ts).
  // 시연·e2e(fixture)는 이 PC를 훑지 않고 목업 목록을 쓴다.
  // 사업자등록증 읽기(M4-3): 사용자가 고른 PDF·그림 → docparse 샌드박스 → 엔진 bizcert.parse(텍스트만) → 후보. 온보딩 O-02와 거래처 O-05가 같은 길을 쓴다.
  const bizCertPorts: BizCertReadPorts = {
    pick: () => pickFileBytes([{ name: '사업자등록증(PDF·사진)', extensions: ['pdf', 'png', 'jpg', 'jpeg'] }], win),
    pdfText: async (b, o) => (await parsePdfInSandbox(b, { ocrPages: 1, forceOcr: o.forceOcr })).text,
    imageText: async (b) => (await ocrImageInSandbox(b, { mode: 'document' })).text,
    parse: (text) => host.rpc('bizcert.parse', { text }),
    log: (n, d) => log.event(n, d),
  };
  /** 인증서 id → CN(main 안에서만, 렌더러·로그로 보내지 않는다). */
  const certNames = new Map<string, string>();
  const onbExternal: OnboardingExternal = fixture
    ? sample!.onboarding()
    : {
        // O-02 등록증(M4-3): 사용자가 고른 PDF·그림 → docparse 샌드박스 → 엔진 bizcert.parse(텍스트만) → 확인 화면 후보
        recognizeBizCert: () => readBizCert(bizCertPorts),
        // 진위확인은 클라우드 프록시(M4-6)가 아직 없다. 견본 결과(계속사업자) 대신 "조회하지 못함"으로 둔다(온보딩은 그대로 이어 간다).
        checkBizNo: async () => ({ status: 'unknown', label: '조회하지 못했어요', taxType: null, source: '국세청 조회' }),
        // 금고 등록 창(T-06)이 main에 아직 없다. 견본 등록 대신 "지금은 등록할 수 없음"으로 끝내 다른 인증으로 바꾸게 한다.
        registerSecrets: async () => ({ ok: false, reason: 'unavailable' }),
        consentConfig: async () => structuredClone(CONSENT_CONFIG),
        findCerts: () => listNpkiCerts((m, p) => host.control(m, p), (der) => certInfoInSandbox(der), { today: kstToday(Date.now()), log: (n, d) => log.event(n, d), names: certNames }),
        // 고른 인증서의 CN. 이번 기동에 목록을 본 적이 없으면(이어 하기) 한 번 다시 연다
        certName: async (id) => {
          if (!certNames.has(id)) await onbExternal.findCerts();
          return certNames.get(id) || null;
        },
      };
  const onbPorts = onboardingPorts(onbExternal, onbStore, refresh);
  // 계좌 자동조회 인증서 목록은 온보딩 O-03과 같은 길(금고 npki.list → 샌드박스 certInfo, 시연은 목업)
  const bankAuto = bankAutoHandlers({ engine: (m, p) => host.rpc(m, p), certs: () => onbExternal.findCerts(), preferredCertId: () => onb?.state.certId ?? null, log: (n, d) => log.event(n, d) });
  // 거래처 장부(M4-3 O-05). [등록증으로 채우기]는 같은 등록증 읽기(fixture는 시연 거래처 등록증). 골랐지만 못 읽은 것과 고르지 않은 것을 나눈다.
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
  // 내 사업장(D-03) 고치기(profile-edit.ts): 엔진 profile.upsert 그대로. 번호가 바뀌면 온보딩과 같은 상태조회 포트, 고친 칸 이름만 기록.
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
        // 로그 값은 ID 모양만 받는다(쉼표 없음): 칸 이름을 점으로 잇는다
        log.event('main.profile_edit', { fields: changed.join('.') || 'none' });
        await refresh();
        pushBoard();
      }
    },
  });
  /** [파일에서 읽기]: 온보딩 O-02와 같은 등록증 읽기(#265 개선 포함). 고르지 않음(null)과 골랐지만 못 읽음을 나눈다. */
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
  /**
   * 이번 품목을 거래처 저장 품목으로 남긴다(08 §144): 저장 품목이 없는 거래처에만, [홈택스에서 준비]로 실행을 시작할 때 한 번.
   * 저장 품목이 있으면 건드리지 않는다(바꾸기는 거래처 화면). 카드 꼬리에 한 줄 알린다. 실패해도 실행은 그대로 간다.
   */
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
  // 대화 의도(M4-3 ③, 개인 프로필·시연): 엔진 intent.resolve(L0 → 마스킹 → 게이트웨이). 판정을 못 하면 의도를 대신 고르지 않는다(오프라인 해석 없음, 사용자 결정 2026-11-10).
  const intent: IntentResolver = opts.intent ?? engineIntentResolver((m, p) => host.rpc(m, p));
  // 대화 짧은 응대(엔진 chat.respond, #261): 의도가 unknown이고 되묻던 것에 답하는 문장이 아닐 때만. e2e가 바꿔 끼운다.
  const chatReply: ChatResponder = opts.chat ?? engineChatResponder((m, p) => host.rpc(m, p));
  // 대화 에이전트(결정안 agent-chat-design-2026-11-12, PR-B): 루프·값 공간은 AgentChat, 모델 경계는 엔진 chat.step.
  // 이 턴에 만든 초안은 끝나고 해석 출처·송신처를 적는다(활동 기록). 진행 단계는 렌더러에 이벤트로만 알린다.
  let agentCreated: RunView[] = [];
  const agent = new AgentChat(
    agentPorts({
      rpc: (m, p) => (m === 'chat.step' && opts.agent ? opts.agent.step(p as unknown as StepParams) : m === 'db.query.runs.history' && opts.agent?.history ? opts.agent.history(p) : host.rpc(m, p)),
      profileId: () => businessId,
      runs,
      // 사업자 등록·발급 인증, 그리고 Chrome(U6, #301). 빠졌으면 초안 카드를 만들지 않고 할 일을 보인다(옛 길 setupGate와 같은 규칙).
      setupMissing: () => setupMissing(profiles().business).length > 0 || !chromeReady(),
      onCreated: (run) => agentCreated.push(run),
      // 받을 돈(#284): 계좌가 하나도 없으면 null(not_set_up). 계좌·거래내역이 있으면 못 받은 건을 준다.
      receivables: () => bank.receivables(),
      // 시연: 씨앗 이력(승인번호 있는 것)도 지난 발급이다. 제품은 원장만.
      pastIssued: () => (seed?.past ?? []).flatMap((x) => (x.kind === 'issued' && x.approvalNo && x.who && x.day ? [{ counterpartyId: cps.find((c) => c.name === x.who)?.id ?? null, counterparty: x.who, date: x.day, total: x.total, approvalNo: x.approvalNo, documentId: x.documentId, mail: null }] : [])),
      onProgress: (phase: AgentPhase) => send({ type: 'chat-progress', phase }),
    }),
  );
  const finishReply = (reply: ReturnType<typeof interpret>, via: 'model' | 'offline', note: string | null, sent: SentTo[]) => {
    if (reply.kind === 'draft') {
      reply.run.interp = via;
      reply.run.sent = sent;
      pushBoard(); // 초안은 update 이벤트 없이 생긴다
      if (sendByUser) autoPrepare(reply.run.id);
    }
    return { ...reply, via, note, sent };
  };
  /** 이번 request.send가 실제 사용자 전송(클릭·Enter, 2초 안)인가. 0클릭 준비는 이 전송에 묶는다. */
  let sendByUser = false;
  /**
   * [홈택스에서 준비] 0클릭(대표 지시 2026-11-13 "두 번째 발급부터 대화 한 문장과 [승인] 1번"). 준비는 홈택스 칸에 넣고 되읽기만 해서 되돌릴 수 있다.
   * 초안이 다 찼으면(품목이 있으면, 기본값·저장 품목 포함) 대화 전송에 묶어 바로 시작한다(해석기·대화 에이전트 둘 다). 초안 카드가 먼저 그려지게 답을 보낸 뒤에 시작한다.
   * 막히면(Chrome 없음·이메일 모양·상한) 초안 카드에 그 이유가 남고 [홈택스에서 준비]로 다시 할 수 있다. 실제 사용자 동작을 묻는 곳은 [승인] 하나다.
   */
  const autoPrepare = (id: string) => {
    const r = runs.get(id);
    if (!r || r.status !== 'draft' || !String(r.item ?? '').trim()) return;
    setImmediate(() => {
      log.event('main.prepare_auto', {});
      prepareNow(id).catch((e: Error) => log.event('main.prepare_auto_failed', { code: e.message.slice(0, 60) }));
    });
  };
  const prepareNow = async (id: string) => {
    // 상한 이유와 남은 초를 코드에 붙인다(F-07: "잠시 뒤"만 보이던 것). 화면은 이유별 문장 + N초.
    const pause = runs.prepareWaitMs();
    const now = performance.now();
    if (pause > 0 || !prepareRate.take(now)) {
      const why = pause > 0 ? 'streak' : 'rate';
      log.event('main.prepare_throttled', { why });
      throw new Error(`throttled.${why}:${Math.max(1, Math.ceil((pause > 0 ? pause : prepareRate.waitMs(now)) / 1000))}`);
    }
    // 실행 직전 레지스트리 재조회(D03 §7.1): 15분이 지났으면 최대 10초 기다린다. 실패해도 엔진이 받아 둔 것으로 판정한다.
    await registryFresh();
    const r = await runs.prepare(id);
    await keepItem(id);
    return r;
  };
  // 계정 로그인(A-01)·첫 PC 등록(remote-account.ts). 금고 키는 처음 쓸 때 한 번 읽는다(금고가 먼저 떠 있어야 한다).
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
    // 받은 코드는 만료(10분)까지 쓴다: 앱을 껐다 켜도 코드 화면으로 돌아온다(대기 정보만, 코드 자체는 없다)
    pending: new PendingCodeFile(appPaths(root ?? defaultAppRoot()).userData),
    platform: process.platform === 'darwin' ? 'macos' : 'windows',
    deviceName: opts.remote?.deviceName ?? (process.platform === 'darwin' ? 'Mac PC' : 'Windows PC'),
    log: (n, d) => log.event(n, d),
  });
  let accountReady: Promise<unknown> | null = null;
  const accountInit = () => (accountReady ??= account.init());
  // 엔진 → 게이트웨이 인증(gateway-auth.ts): gateway 범위 기기 토큰으로 만든 헤더만 auth 포트로 간다. 로그인 전이면 account.signed_out.
  // 내준 헤더의 경로(활동 기록 근거). 번호를 붙여 최근 200개만 둔다.
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
    // 온보딩 ②에서 모델을 거절했으면 게이트웨이 헤더를 내주지 않는다(입력 문장·화면이 모델로 가지 않게). 끝낸 기존 사용자(!onb)·동의한 사용자는 그대로.
    modelAllowed: () => modelOk(),
  });
  host.setGatewayAuth((m) => gwAuth.handle(m));
  // 폰 연결(S-03, remote-pairing.ts·pair-window.ts). 로그인(첫 PC 등록)을 마치고 클라우드 포트·QR 인코더가 있을 때만.
  // 우편함 토큰·채널이 든 결과는 지금은 이 실행의 메모리에만 둔다(수신 배선 PR에서 금고 보관).
  let pairWin: PairWindow | null = null;
  const pairedThisRun: DesktopPairResult[] = [];
  const pairWindow = (): PairWindow => {
    if (pairWin) return pairWin;
    const cloud = opts.remote?.cloud;
    const device = account.device();
    if (!cloud || !device) throw new Error(device ? 'pair_unavailable' : 'account_required');
    const host = new PairingHost({
      account: cloud.account,
      relayHttp: cloud.relay,
      relay: opts.remote?.relayClient ?? wsRelayClient({ host: cloud.relayHost, open: cloud.openSocket, insecureLocal: cloud.insecureLocal }),
      relayHost: cloud.relayHost,
      device,
      keys: keysOf,
      qr: qrSvgDataUrl,
      desktopName: opts.remote?.deviceName ?? (process.platform === 'darwin' ? 'Mac PC' : 'Windows PC'),
      log: (n, d) => log.event(n, d),
      onView: (v) => pairWin?.push(v),
      onPaired: (r) => {
        pairedThisRun.push(r);
        send({ type: 'account', account: account.view() });
      },
    });
    pairWin = new PairWindow({ parent: win, url: PAIR_URL, host, onClosed: () => send({ type: 'account', account: account.view() }) });
    return pairWin;
  };
  const onbView = async () => (onb && onbShow ? await onb.view() : null);
  /** 온보딩이 끝나기 전에는 약관(④) 동의 전 요청을 받지 않는다. 모델 해석은 ②에 동의했을 때만(기존 사용자는 지금처럼). */
  const termsOk = () => !onb || onb.state.consents.terms?.choice === 'agreed';
  const modelOk = () => !onb || onb.modelAllowed();
  /**
   * 로그인이 먼저다(사용자 결정 2026-11-10): 제품은 계정에 로그인(첫 PC 등록)해야 약관 다음 온보딩·대화로 간다.
   * 렌더러는 같은 조건으로 닫을 수 없는 로그인 화면을 띄우고, main은 그 전의 대화·온보딩 답을 account_required로 거절한다.
   * 시연(fixture)·e2e는 계정 없이 돈다.
   */
  const loginRequired = !fixture;
  const signedIn = async () => {
    await accountInit().catch(() => null);
    return account.view().step === 'signed_in';
  };
  const needLogin = async () => {
    if (loginRequired && !(await signedIn())) throw new Error('account_required');
  };
  /**
   * 세금계산서·증명서는 사업자 프로필(사업자번호)과 발급 인증이 있어야 시작할 수 있다(엔진 run.start가 profile_missing으로 멈춘다).
   * 빠졌으면 카드를 만들지 않고 무엇이 빠졌는지와 [사업자 등록 마치기]·[발급 인증 고르기]를 보인다(0.1.5 실사용).
   */
  const setupGate = (parsed: Parsed) => {
    if (profile !== 'business') return null;
    if (!(parsed.intent === 'invoice' || parsed.intent === 'cert' || answersPending(parsed, runs))) return null;
    // Chrome이 없으면 세금계산서 초안 카드를 만들기 전에 말한다(U6). [홈택스에서 준비]의 점검(#288)은 그 뒤에 지워진 경우를 막는 마지막 자리로 남는다.
    // 증명서는 이 빌드가 떼지 못하므로(interpret가 "곧 할 수 있어요") 할 수 없는 일 때문에 설치를 시키지 않는다(#291, 부장 판정 2026-11-12).
    const needsChrome = parsed.intent !== 'cert' && !chromeReady();
    const needsSecurity = parsed.intent !== 'cert' && securityMissing();
    const missing: SetupItem[] = [...setupMissing(profiles().business), ...(needsChrome ? (['chrome'] as const) : []), ...(needsSecurity ? (['security'] as const) : [])];
    if (!missing.length) return null;
    runs.pending.asked = null;
    return { kind: 'setup' as const, text: setupText(parsed.intent === 'cert' ? 'cert' : 'invoice', missing), missing: missing.map((id) => ({ id, label: SETUP_LABEL[id] })) };
  };

  const bankAutoH = bankAuto.handlers;
  /** 활동 기록의 지난 실행: 이 PC 실행 이력(엔진, 최근 50건) + 시연 씨앗. 이력을 읽지 못하면(db_not_ready 등) 지난 실행 없이 연다. */
  const pastNow = async (): Promise<PastRun[]> => [...(await readPastRuns((m, p) => host.rpc(m, p), (n, d) => log.event(n, d))), ...(seed?.past ?? [])];

  /** 진행 화면을 받는 실행(하나). */
  let mirrorRun: string | null = null;

  /**
   * 앱 안 브라우저(대표 지시 2026-11-13 "인앱브라우저에서 조작해야지 그냥 새로 창 띄워서 가린다고?"). 실행 Chrome은 늘 앱 창 뒤에 고정 크기로 둔다
   * (앞으로 올리지 않는다, 가려져도 중계 프레임이 온다). 사람은 패널의 중계 화면을 직접 누르고 친다(browser.input → 금고 screen.input → CDP Input).
   * [브라우저] 토글은 패널 크게/작게다(크게: 대화 열을 줄인다). 사람 차례가 되면 크게 하고 입력 포커스를 준다.
   * 렌더러 처리기는 금고 제어 포트에 직접 닿지 않는다(h01-guards). 이 함수들만 browser.place·screen.input을 부른다.
   */
  /** 실행 Chrome 창 크기(고정). 앱 창 뒤 왼쪽 위에 둔다. 페이지 레이아웃이 패널 크기에 따라 바뀌지 않게 한다. */
  const CHROME_BEHIND = { width: 1280, height: 900 };
  function sendBrowserState(focus = false) {
    send({ type: 'browser', shown: browserShown, available: browserAvailable, ...(embedded ? { embedded: true, width: panelNow() } : {}), ...(focus ? { focus: true } : {}) });
  }
  /** Chrome을 앱 창 뒤 자리로(고정 크기). 앱을 앞으로 둔다. 앱 안 브라우저는 옮길 창이 없다. */
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
  /** 패널 크게/작게. focus면 렌더러가 중계 화면에 입력 포커스를 준다. */
  const setPanelBig = (big: boolean, focus = false) => {
    if (browserShown === big && !focus) return;
    browserShown = big;
    sendBrowserState(focus);
    if (embedded) bar.layoutChanged();
    // 앱 안 브라우저: 사람 차례면 그 보기에 키보드 포커스(사람이 바로 친다)
    if (focus) eb?.focus();
  };
  /** 앱 안 브라우저 패널 경계를 끌었다(렌더러가 고른 폭). main이 범위 안으로 줄여 정하고 다시 알린다. */
  const resizeBrowser = (width: number) => {
    if (!embedded || !browserAvailable) return { width: panelNow() };
    browserWant = Math.round(width);
    browserShown = false;
    sendBrowserState();
    bar.layoutChanged();
    return { width: panelNow() };
  };
  /**
   * 앱 안 브라우저 보기 자리(렌더러 패널의 화면 칸, 창 콘텐츠 DIP). main은 그 칸을 패널 영역(창 오른쪽 panelNow() 폭, 제목줄 아래) 안으로
   * 잘라서 쓴다: 렌더러가 보기를 대화 열이나 승인 카드 위로 옮기지 못한다(카드는 늘 보기 위에 있다).
   */
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
  /** 패널 안 브라우저 조작 하나를 금고에 넘긴다(메인 창에서 1초 안에 본 실제 입력이 있을 때만). 앱 안 브라우저는 사람이 보기를 직접 누른다. */
  const panelBrowserInput = async (p: Record<string, unknown>) => {
    if (!mirrorRun || embedded) return { ok: false };
    if (!panelInput.within(performance.now(), 1_000)) throw new Error('gesture_required');
    const r = (await host.control('screen.input', p).catch(() => null)) as { ok?: unknown } | null;
    return { ok: r?.ok === true };
  };
  /** 기억한 홈택스 인증서 이름(profiles.cert_name): 보기(이름 부분만)·지우기. */
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
  // 앱 창을 옮기거나 크기를 바꾸면 Chrome도 뒤 자리로(드러나지 않게). 연속 이벤트는 잠깐 모아서 한 번.
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
  /**
   * 진행 화면(B3, 부장 지시 2026-11-13): 실행 중이면 금고에 실행 탭 화면 중계를 맡긴다(screen.start, 같은 탭이면 그대로).
   * Chrome이 뜨고 탭이 붙기 전에는 실패하니 실행이 바뀔 때마다, 그리고 1초마다 다시 부른다. 실행이 끝나면 멈춘다.
   */
  const mirrorTick = setInterval(() => {
    if (embedded) return; // 앱 안 브라우저: 패널이 그 보기 자체라 중계하지 않는다
    const r = mirrorRun ? runs.get(mirrorRun) : undefined;
    if (r && runs.isActive(r.id) && r.status !== 'draft') void host.control('screen.start').catch(() => {});
  }, 1_000);
  mirrorTick.unref();
  runs.on('update', (r: RunView) => {
    const live = runs.isActive(r.id) && r.status !== 'draft';
    if (live && mirrorRun !== r.id) {
      mirrorRun = r.id;
      // 실행이 시작되면 렌더러가 패널을 브라우저 폭으로 넓히고 주소 줄을 단다(Chrome이 뜨기 전에 자리가 정해지게).
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
  /** 실행마다 마지막 자리(뒤·사람 차례). 같은 차례에 두 번 앞으로 올리지 않는다(사람이 [브라우저]로 뒤로 보냈으면 그대로 둔다). */
  const chromeSpot = new Map<string, string>();
  runs.on('update', (r: RunView) => {
    if (!runs.isActive(r.id) || r.status === 'draft') {
      chromeSpot.delete(r.id);
      return;
    }
    // 사람 차례: 핸드오프(로그인·서명·기타) 또는 승인 뒤 서명 단계(인증서 비밀번호·간편인증·보안카드). 승인 자체는 앱의 승인 바에서 한다.
    const turn = r.status === 'turn' ? `turn:${r.handoff?.phase ?? ''}` : r.status === 'issuing' && r.steps[5]?.state === 'now' ? 'sign' : null;
    const want = turn ?? 'back';
    if (chromeSpot.get(r.id) === want) return;
    // 시작 때 한 번만 뒤에 둔다. 사람 차례가 끝났으면 'away'로 바꿔 다음 차례(같은 단계의 다른 핸드오프)에도 패널을 크게 한다
    if (want === 'back' && chromeSpot.has(r.id)) {
      if (chromeSpot.get(r.id) !== 'back') chromeSpot.set(r.id, 'away');
      return;
    }
    chromeSpot.set(r.id, want);
    if (turn) {
      // 사람 차례: 패널을 크게 하고 중계 화면에 입력 포커스(Chrome은 앞으로 올리지 않는다)
      setPanelBig(true, true);
      return;
    }
    // 시작: Chrome이 뜨고 실행 탭이 붙을 때까지 잠깐 다시 해 본다(엔진이 run.start 뒤에 금고에 기동을 맡긴다).
    void (async () => {
      for (let i = 0; i < 40 && chromeSpot.get(r.id) === 'back' && runs.isActive(r.id); i++) {
        if (await placeBehind()) return;
        await new Promise((res) => setTimeout(res, 500));
      }
    })();
  });

  /**
   * 기억한 인증서 비밀번호(대표 지시 2026-11-13). 금고가 처음 넣은 값을 저장하고 다음부터 넣는다(vault SecretOps.certMemory).
   * 홈택스가 비밀번호가 틀렸다고 하면 바로 지운다(다시 넣어 인증서가 잠기지 않게). 설정에는 [지우기] 하나만 둔다. 값은 main에 오지 않는다.
   */
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
    // 계좌 자동조회(CODEF 공동인증서, bank-auto.ts). 연결·고르기·[최신화]·[연결 해제]는 실제 입력 뒤에만.
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
    'shell.bootstrap': async () => ({
      board: await bootBoard(),
      layout: SHELL,
      profiles: profiles(),
      profile,
      counterparties: cps,
      docs: await listDocs(),
      // 견본 대화·견본 표시는 시연(fixture)만. 제품은 빈 대화에서 시작하고 빠른 실행은 세금계산서만(정부24 안내는 견본 후보라 뺀다).
      timeline: sample ? sample.timeline() : [],
      quick: sample ? sample.quick : QUICK.filter((q) => q.label === '세금계산서 발급' || q.soon),
      sample: !!sample,
      platform: process.platform,
      loginRequired,
      // 설치본 자기 점검의 warn(미서명 빌드 등). 제품 진입점(shell.ts)이 정한다. 렌더러는 글자만 보인다.
      build: opts.buildBadges ?? [],
      past: await pastNow(),
      onboarding: await onbView(),
      // 거래처 장부: 시연 DB(fixture, 저장 품목까지) / 이 PC 장부(제품, 품목 열은 아직 없다)
      cpBook: fixture ? 'demo' : 'local',
      // 내 사업장 고친 기록(칸 이름만)과 [발급 인증 바꾸기]를 온보딩 대화로 열 수 있는지(온보딩 기록이 없는 옛 프로필은 못 연다)
      profileEdits: editLog.list(),
      authReopen: !!onb,
    }),
    'profile.set': (p) => {
      if (p.kind !== 'business' && p.kind !== 'personal') throw new Error('bad_profile');
      profile = p.kind;
      return { profile };
    },
    // 제품: 엔진 intent.resolve(M4-3 ③, 4초 상한). 실패(게이트웨이 불가·시간 초과·모양 다름)하면 정규식으로 의도를 고르지 않고
    // kind 'unavailable'(연결 안 됨 + [다시 시도])을 돌려준다. 되묻던 것(pending)도 그대로 둔다(사용자 결정 2026-11-10 "오프라인 해석은 없다").
    // 인자(거래처·금액·부가세)는 로컬 파서가 뽑는다(D01 §5.1). 시연(fixture)은 시연 모델(4초 상한) → 실패하면 정규식(e2e가 기댄다).
    'request.send': async (p) => {
      sendByUser = gesture.within(performance.now(), 2_000);
      const vat = p.vat === 'separate' || p.vat === 'included' ? (p.vat as VatMode) : null;
      if (!termsOk()) throw new Error('onboarding_terms');
      await needLogin();
      const text = String(p.text ?? '').slice(0, 2000);
      const t0 = performance.now();
      const local = parseRegex(text, runs.counterparties);
      if (demo) {
        // 시연 모델은 부르면 보낸 것이다(실패·시간 초과여도). 활동 기록은 결과가 아니라 송신으로 적는다.
        const ask = modelOk() && !!text.trim();
        const model = ask ? await demo.parse(text, runs.counterparties.map((c) => c.name)) : null;
        const via = model ? 'model' : 'offline';
        log.event('main.interpret', { via, ms: Math.round(performance.now() - t0) });
        const parsed = model && dev ? dev.mergeParsed(model, local, text) : local;
        return setupGate(parsed) ?? finishReply(interpret(text, vat, profile, runs, parsed), via, null, ask ? ['openrouter_demo'] : []);
      }
      // 사업자 대화는 대화 에이전트로 간다(제품 전부, 시연은 e2e가 agent를 넘겼을 때만). 개인 프로필은 아래 옛 해석 길(정부24 안내).
      // 등본·초본(정부24 직접 발급 안내)은 사업자도 옛 길로 간다. 첫 화면 칩 [주민등록등본 떼 줘]가 안내를 잃지 않게(#300 판정).
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
        // 기본값(부가세 별도)·저장 품목으로 채운 초안도 바로 준비한다(대표 실사용 2026-11-14 "일호유통에 100원"이 [홈택스에서 준비]를 기다렸다).
        // 준비는 칸에 넣고 되읽기만 해서 되돌릴 수 있고, 승인 카드에서 다시 본다. 품목이 비면(진짜 빠짐) autoPrepare가 건너뛴다.
        if (sendByUser) for (const run of agentCreated) autoPrepare(run.id);
        log.event('main.agent', r.kind === 'agent' ? { result: 'ok', filtered: r.filtered ?? 'none', show: r.show.length, ask: r.ask?.kind ?? 'none', ms: Math.round(performance.now() - t0) } : { result: r.code, ms: Math.round(performance.now() - t0) });
        if (r.kind === 'unavailable') return { kind: 'unavailable', text: r.text, retry: r.retry, via: 'model', note: null, sent };
        // 카드는 지금 실행 값으로 싣는다(렌더러가 그린다). 버린 초안은 목록에 없어 빠지고, 그 카드는 update 이벤트로 "취소함"이 된다.
        type Shown = { type: 'card'; run: RunView } | Extract<(typeof r.show)[number], { type: 'table' }>;
        const show = r.show.flatMap((x): Shown[] => {
          if (x.type !== 'card') return [x];
          const run = runs.get(x.runId);
          return run ? [{ type: 'card', run }] : [];
        });
        const missing: SetupItem[] = r.setup ? [...setupMissing(profiles().business), ...(chromeReady() ? [] : (['chrome'] as const)), ...(securityMissing() ? (['security'] as const) : [])] : [];
        return { kind: 'agent', text: r.text, show, ask: r.ask, filtered: r.filtered, setup: missing.map((id) => ({ id, label: SETUP_LABEL[id] })), unknown: r.unknown ?? null, via: 'model', note: null, sent };
      }
      // 시연(fixture)·e2e는 게이트웨이가 없다. 해석기를 바꿔 끼우지 않았으면 로컬 정규식으로 돈다(시연 전용, 제품에는 없는 길).
      if (fixture && !opts.intent) return setupGate(local) ?? finishReply(interpret(text, vat, profile, runs, local), 'offline', null, []);
      if (!text.trim()) return { kind: 'say', text: EMPTY_REQUEST_TEXT, via: 'model', note: null, sent: [] };
      // 온보딩 ②(모델 처리 동의) 전에는 문장을 모델로 보내지 않는다. "연결 안 됨"이 아니라 동의가 먼저라고 말한다.
      if (!modelOk()) return { kind: 'say', text: MODEL_CONSENT_FIRST_TEXT, via: 'model', note: null, sent: [] };
      // 이 해석 동안 main이 내준 게이트웨이 헤더가 곧 우리 서버로 간 것이다(헤더 없이는 엔진이 게이트웨이를 부를 수 없다).
      // 해석은 한 번에 하나라(렌더러 sending) 이 구간의 발급은 이 요청 것이다.
      const mark = gwSeq;
      const r = await intent.resolve(text);
      log.event('main.interpret', { path: r.route ? `engine.${r.route.via}` : `unavailable.${r.fallback ?? 'none'}`, outcome: r.route?.outcome ?? 'unavailable', ms: Math.round(performance.now() - t0) });
      if (!r.route) return { kind: 'unavailable', text: INTENT_UNAVAILABLE_TEXT, retry: true, via: 'model', note: null, sent: sentFromGateway(gwIssuedSince(mark)) };
      const via = 'model';
      // 모름(unknown)이고 되묻던 것에 답하는 문장도 아니면 모델이 짧게 답한다(chat.respond). 고정 문구(EMPTY_REQUEST_TEXT)는 빈 입력에만.
      // 답은 텍스트로만 보이고, 제안 작업은 입력창을 채우는 칩일 뿐이다(실행은 사용자가 보내고 확인 카드를 거친다). 실패는 정규식 대체 없이 오류 문장.
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
    // [다시 준비]: 발급 전에 멈춘 실행과 같은 값의 새 초안(시작은 그 카드의 [홈택스에서 준비]로만)
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
    // 실행 시작은 2초 안의 실제 입력이 있어야 하고, 사람 속도(분당 3회)·게이트 없이 끝난 연속 3회에서 멈춘다.
    'run.prepare': async (p) => {
      needGesture(2_000);
      return prepareNow(String(p.id));
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
    'run.showBrowser': async (p) => {
      needGesture(3_000);
      return showRunBrowser(String(p.id));
    },
    'browser.toggle': async (p) => {
      needGesture(3_000);
      return toggleBrowser(p.show === true);
    },
    // 패널 안 브라우저 조작: 메인 창에서 방금(1초) 본 실제 마우스·키 입력이 있을 때만. 중계 중인 실행 탭에만 들어간다(금고가 비밀 창 동안 거부).
    'browser.input': (p) => panelBrowserInput(p as Record<string, unknown>),
    // 앱 안 브라우저: 패널 화면 칸 자리(보기를 그 위에 둔다, main이 패널 영역으로 자른다)·경계 끌기 폭. 값·페이지는 건드리지 않는다.
    'browser.slot': (p) => placeBrowser(p.none === true ? null : { x: Number(p.x), y: Number(p.y), width: Number(p.width), height: Number(p.height) }),
    'browser.resize': (p) => resizeBrowser(Number(p.width)),
    // InDoubt 카드를 열었다(실제 입력 3초 안). 증언 요청이 무장돼 있으면 main이 바를 띄운다. 돌려주는 것은 무장됐는지뿐이다.
    'incident.open': (p) => {
      needGesture(3_000);
      return incidents.open(String(p.id));
    },
    // 카드를 닫았다. 증언 바를 내린다(증언이 안 될 뿐이라 안전한 실패다).
    'incident.close': (p) => incidents.close(String(p.id)),
    'docs.list': () => listDocs(),
    'issued.list': () => pastNow(),
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
    // 거래처 추가·수정(엔진 counterparty.create/update) + [저장 품목] 칸 = 첫 저장 품목(counterparty.setItems, #144).
    // 시연 값(itemHints)은 저장한 뒤로는 쓰지 않는다(DB가 정본).
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
    // [등록증으로 채우기]: 파일 고르기를 여니 실제 클릭 뒤에만(ADR-027 결정 8). 후보만 돌려준다(주소는 main이 든다).
    'counterparty.readCert': () => {
      needGesture(3_000);
      return cpBook.readCert();
    },
    'counterparties.list': async () => {
      await refresh();
      return cps;
    },
    // 정부24 후보 파일은 아직 견본이다(다운로드 폴더를 읽지 않는다). 제품은 후보를 보이지 않는다.
    'g24.candidates': (p) => (sample ? sample.g24Candidates(g24Doc(p.doc), Number(p.startedAt)) : []),
    'g24.save': (p) => store.g24Save(String(p.id), g24Doc(p.doc)),
    // 비밀이 아닌 값(승인번호·사업자번호·주소)만. 클립보드 기록 제외 형식은 Phase 1(D17 §1.2).
    // 온보딩 답 하나. 동의·확정은 화면마다 실제 클릭이라 3초 안의 실제 입력이 있어야 한다(ADR-027 결정 8).
    // 계정 로그인(A-01). 단계·이메일·코드 만료 시각·오류 코드만 돌려준다(세션·토큰은 main에만).
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
      // 6자리가 차면 렌더러가 바로 부른다: 숫자 키·붙여 넣기도 main이 본 입력으로 친다(클릭은 3초 전일 수 있다). 메뉴 붙여 넣기는 [확인] 클릭으로.
      needTyping(3_000);
      await accountInit();
      return account.verify(String(p.code));
    },
    'account.password': async (p) => {
      needGesture(3_000);
      await accountInit();
      return account.passwordLogin(String(p.email), p.password);
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
      // [바꾸기]·Enter가 보통이지만, 코드·새 비밀번호를 치는 키 입력도 main이 본 입력으로 친다(account.verify와 같다)
      needTyping(3_000);
      await accountInit();
      return account.finishReset(String(p.code), p.password);
    },
    'account.back': async () => {
      await accountInit();
      return account.back();
    },
    // 설정 > 계정 [로그아웃]: 실제 입력 뒤에만, 발급 실행 중이면 거부. 폰 연결 창을 닫고 신원·받아 둔 코드를 지운 뒤 로그인 화면으로(렌더러 게이트).
    'account.signOut': async () => {
      needGesture(3_000);
      await accountInit();
      if (runs.anyActive()) throw new Error('run_active');
      pairWin?.close();
      pairWin = null;
      const v = await account.signOut();
      pushBoard();
      return v;
    },
    // [폰 연결]: main 소유 창(S-03)을 연다. 창은 셸 렌더러와 통하지 않는다(QR·6자리는 그 창에만).
    'pair.open': async () => {
      needGesture(3_000);
      await accountInit();
      pairWindow().open();
      return {};
    },
    'onboarding.reply': async (p) => {
      needGesture(3_000);
      if (!onb) throw new Error('onboarding_done');
      if (p.step !== 'terms') await needLogin();
      const r = await onb.answer({ step: p.step, choice: p.choice, fields: p.fields, certId: p.certId, tasks: p.tasks } as Parameters<OnboardingFlow['answer']>[0]);
      if (onb.done) pushBoard(); // 건너뛴 항목이 판의 할 일로
      return { onboarding: await onbView(), fill: r.fill ?? null, profiles: profiles() };
    },
    'certMemory.status': async () => ({ remembered: await certMemory.has() }),
    // 기억한 홈택스 인증서 이름(profiles.cert_name, CN). 렌더러에는 이름 부분만(뒤의 식별 번호 없이) 보인다
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
    // 설정 > 발급 인증의 [인증서 비밀번호 저장]: 가려진 칸의 값을 금고로만(저장 결속 secret.store). 처음 로그인에서 틀리면 금고가 지운다.
    'certMemory.save': async (p) => {
      needGesture(3_000);
      return saveCertMemory((p as { value?: unknown }).value);
    },
    // 대화 비밀 입력 카드의 답(대표 지시 2026-11-14). 값은 금고 1회용 포트로만.
    'secret.answer': (p) => {
      needGesture(3_000);
      return answerSecret(p as { reqId?: unknown; value?: unknown; cancel?: unknown });
    },
    // 보안 프로그램(MagicLine4NX) 점검·설치 링크·켜기(B4). 설치는 홈택스 공식 설치 파일을 기본 브라우저로 연다(사람이 설치를 마친다).
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
    'security.start': async () => {
      needGesture(3_000);
      const ok = opts.security?.start ? opts.security.start() : startSecurityProgram();
      // 켜는 데 잠시 걸린다
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
      // 온보딩 기록이 없는 기존 사용자(!onb)는 다시 열 대화가 없다: 렌더러가 내 사업장으로 간다
      if (!onb) throw new Error('onboarding_unavailable');
      await onb.reopen(p.item as 'biz' | 'auth');
      onbShow = true;
      pushBoard();
      return { onboarding: await onbView(), profiles: profiles() };
    },
    // 내 사업장 [저장]: 실제 입력 뒤에만, 실행 중이면 거부(profile-edit.ts). 번호를 조회하지 못하면 confirm을 돌려주고 [맞습니다]면 confirmUnverified로 다시 온다.
    'profile.edit': async (p) => {
      needGesture(3_000);
      await needLogin();
      if (onb && !onb.done) throw new Error('onboarding_open');
      const r = await editor.save((p.fields ?? {}) as Record<string, unknown>, p.confirmUnverified === true);
      return { ...r, profiles: profiles(), edits: editLog.list() };
    },
    // 내 사업장 [파일에서 읽기]: 파일 고르기를 여니 실제 클릭 뒤에만. 칸 후보만 돌려준다(저장은 [저장]으로, 같은 검사를 거친다).
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
    // 메인 창의 셸 페이지에서 온 호출만 받는다. 승인 바(javascript:false)는 IPC가 없다.
    if (e.sender !== wc || e.senderFrame?.url !== SHELL_URL) throw new Error('forbidden');
    // 최상위 프레임만, 표(ipc.ts SHELL_METHODS)에 있는 메서드·필드만(D11 §4 IPC 행).
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
      // 첫 확인은 기동 레지스트리 동기화 뒤에: 엔진이 폐기 목록을 받기 전이면 registry.revocation_stale로 보류되고 다음 확인은 15분 뒤다
      // (새 설치 격리 프로필 실측 2026-11-13, 동기화가 2초 늦었다). 기동 동기화가 돌고 있으면 그 약속을 같이 기다린다.
      void registrySync('update').finally(() => void h.check());
      return h;
    } catch (e) {
      log.event('main.update_start_failed', { error: (e as Error).message.slice(0, 80) });
      return null;
    }
  };
  // 금고 잠금은 사람 세션을 따른다(ADR-026 결정 3). utilityProcess에는 powerMonitor가 없어 main이 유휴 시간·잠금 이벤트를 넘긴다.
  // 넘기지 않으면 금고가 idle_unknown으로 닫혀 기억한 인증서 비밀번호를 저장도 사용도 못 한다(2026-11-13 발견, #308 기억이 제품에서 동작하지 않던 원인).
  const reportIdle = () => void host.control('session.idle', { idleSec: powerMonitor.getSystemIdleTime() }).catch(() => {});
  const idleTimer = setInterval(reportIdle, SESSION_IDLE_REPORT_MS);
  idleTimer.unref();
  const SESSION_KINDS = ['lock-screen', 'unlock-screen', 'suspend', 'resume'] as const;
  const onSession = SESSION_KINDS.map((kind) => {
    const fn = () => {
      void host.control('session.event', { kind }).catch(() => {});
      if (kind === 'unlock-screen' || kind === 'resume') reportIdle();
    };
    powerMonitor.on(kind as 'resume', fn);
    return { kind, fn };
  });
  const ready = (async () => {
    try {
      await host.ready;
      reportIdle();
    } catch (e) {
      // 금고 키 유실·환경 변수 변조 등은 사실 문장으로 알리고 열지 않는다(복구 화면은 Phase 1).
      const text = fatalText((e as Error).message);
      if (text) dialog.showErrorBox('소버린 AX', text);
      throw e;
    }
    if (fixture) await fixture.seed(host);
    // 제품: 기동 때 한 번(기다리지 않는다)
    void registrySync('boot');
    if (fixture && dev && opts.demoSeed) seed = await dev.startDemoSeed(host, store, fixture.root, fixture.itemHints);
    await refresh();
    // 온보딩: 시연·e2e는 opts.onboarding. 엔진 모드는 이어 하기 저장이 있으면 그 자리부터(끝났으면 대화 없이 동의·할 일만),
    // 저장이 없고 사업자 프로필도 없으면 처음부터. 사업자를 건너뛰고 끝낸 사용자도 다음 기동에 약관부터 다시 묻지 않는다.
    if (opts.onboarding) onb = new OnboardingFlow(onbPorts);
    else if (!fixture) {
      const saved = (await onbStore.load()) ?? (await onbStore.importLegacyFile(legacyOnbFile));
      if (saved) {
        // 모델 거절이 저장된 프로필은 ②를 다시 묻는다(reaskModel). 그때는 끝낸 온보딩이라도 대화로 다시 그린다.
        onb = new OnboardingFlow(onbPorts, saved);
        onbShow = !onb.done;
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
  /**
   * 도구 > 홈택스 예행(발급 안 함): 고정 초안(REHEARSAL)으로 실행을 시작하고 엔진이 첫 게이트에서 스스로 멈춘다(B1 실화면 예행).
   * 메인 프로세스 메뉴라 렌더러 제스처 규칙(USER_ACTION_METHODS)을 거치지 않는다. 준비 상한(prepareNow)은 그대로 받는다.
   * 장부에 일호유통이 없으면 그 번호로 추가한다.
   */
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
  /** 도구 > 예행 중지: 진행 중인 예행 실행만 [중지]와 같은 길로 멈춘다(창이 다른 Space에 있어도 메뉴로 부를 수 있다). 예행이 아닌 실행은 건드리지 않는다. */
  const stopRehearsals = () => {
    for (const r of runs.list()) {
      if (!r.rehearsal || !runs.isActive(r.id)) continue;
      log.event('main.rehearsal_stop', { runId: r.id });
      void runs.stop(r.id).catch((e: Error) => log.event('main.rehearsal_stop_failed', { error: e.message.slice(0, 60) }));
    }
  };
  // 확대·축소 메뉴를 두지 않는다(렌더러 배율은 1, 바 자리는 DIP 고정). 접근성 배율은 Phase 1.
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      { role: 'appMenu' },
      { role: 'editMenu' },
      {
        label: '도구',
        submenu: [
          { id: 'rehearsal', label: '홈택스 예행(발급 안 함)', click: () => void rehearse() },
          { id: 'rehearsalStop', label: '예행 중지', click: () => stopRehearsals() },
        ],
      },
      { label: '창', submenu: [{ role: 'minimize' }, { role: 'close' }] },
    ]),
  );
  const close = async () => {
    clearInterval(boardDayTimer);
    clearInterval(registryTimer);
    clearInterval(keepTimer);
    daemon?.stop();
    powerMonitor.removeListener('resume', onResume);
    clearInterval(idleTimer);
    for (const { kind, fn } of onSession) powerMonitor.removeListener(kind as 'resume', fn);
    updater?.stop();
    pairWin?.dispose();
    for (const r of pairedThisRun) r.channel.close();
    watchChromeFront(false);
    closeSecret();
    // 엔진이 실제로 끝난 뒤에 임시 앱 폴더를 지운다(DB·WAL이 열린 채 지우지 않게).
    await host.shutdown().catch(() => {});
    await fixture?.close().catch(() => {});
  };
  return { win, bar, runs, store, host, fixture, ready, methods: Object.keys(handlers), secretAsk: () => (secretAsk ? { reqId: secretAsk.reqId, kind: secretAsk.bind.kind, runId: secretAsk.bind.runId } : null), close };
}
