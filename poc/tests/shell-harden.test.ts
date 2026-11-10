// M4-1 하드닝 점검(D11 §4 데스크톱 하드닝 체크리스트): 표의 행마다 describe 하나. 이 트랙 범위 밖 행은 todo에 담당 WBS를 적는다.
// 함수는 가짜 Electron 객체로 돌리고, 배선은 소스를 읽어 본다. 실제 창에서 걸린 값(webPreferences·CSP 헤더·iframe)은 shell-e2e가 본다.
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import type { App, BrowserWindow, Session } from 'electron';
import { BAR_CSP } from '../apps/desktop/src/approval-gate.ts';
import { childEnv } from '../apps/desktop/src/child-env.ts';
import { APP_CSP, appHeaders, assertWebPrefs, hardenApp, hardenSession, hardenWindow, lastWebPrefs, SECRET_CSP, webPrefsProblems } from '../apps/desktop/src/harden.ts';

const root = path.resolve(import.meta.dirname, '..');
const read = (p: string) => fs.readFileSync(path.join(root, p), 'utf8');
const SRC = 'apps/desktop/src';
const srcFiles = fs.readdirSync(path.join(root, SRC)).filter((f) => f.endsWith('.ts'));
/** 제품 경로 소스(e2e·시험 도구 제외). */
const productFiles = srcFiles.filter((f) => !f.includes('e2e') && !['h01-fixture.ts', 'poc8-measure.ts', 'smoke-plan.ts'].includes(f));
const staticJs = ['shell/shell.js', 'shell/shell-views.js', 'shell/shell-g24.js', 'shell/shell-onboarding.js', 'shell/shell-account.js', 'shell/shell-biz.js', 'shell/password-rules.js', 'shell/common-passwords.js', 'shell/pair.js', 'shell/secret.js'];
const directives = (csp: string) => new Map(csp.split(';').map((d) => d.trim().split(/\s+/)).map(([k, ...v]) => [k!, v.join(' ')]));
/** 생성자 호출 하나의 webPreferences 블록(괄호 짝 맞춰 자른다). */
function prefsBlocks(src: string, ctor: string): string[] {
  const out: string[] = [];
  for (let i = src.indexOf(ctor); i >= 0; i = src.indexOf(ctor, i + 1)) {
    let depth = 0;
    let j = i + ctor.length - 1;
    for (; j < src.length; j++) {
      if (src[j] === '(') depth++;
      else if (src[j] === ')' && --depth === 0) break;
    }
    out.push(src.slice(i, j + 1));
  }
  return out;
}
const ev = () => {
  const e = { prevented: false, preventDefault: () => void (e.prevented = true) };
  return e;
};

const GOOD = { sandbox: true, contextIsolation: true, nodeIntegration: false, nodeIntegrationInSubFrames: false, nodeIntegrationInWorker: false, webviewTag: false, webSecurity: true, allowRunningInsecureContent: false, experimentalFeatures: false, enableBlinkFeatures: '', javascript: true };

describe('D11 §4 렌더러: contextIsolation·sandbox·nodeIntegration·좁은 preload·devTools·webview·원격 콘텐츠', () => {
  it('webPrefsProblems: Electron 45 실측 값(기본값 채움)은 통과, 하나라도 풀리면 그 이름', () => {
    assert.deepEqual(webPrefsProblems(GOOD), []);
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ sandbox: false }, 'sandbox'],
      [{ sandbox: undefined }, 'sandbox'],
      [{ contextIsolation: false }, 'contextIsolation'],
      [{ nodeIntegration: true }, 'nodeIntegration'],
      [{ nodeIntegrationInSubFrames: true }, 'nodeIntegrationInSubFrames'],
      [{ nodeIntegrationInWorker: true }, 'nodeIntegrationInWorker'],
      [{ webviewTag: true }, 'webviewTag'],
      [{ webSecurity: false }, 'webSecurity'],
      [{ allowRunningInsecureContent: true }, 'allowRunningInsecureContent'],
      [{ experimentalFeatures: true }, 'experimentalFeatures'],
      [{ enableBlinkFeatures: 'X' }, 'enableBlinkFeatures'],
    ];
    for (const [patch, name] of cases) assert.deepEqual(webPrefsProblems({ ...GOOD, ...patch }), [name], name);
    assert.deepEqual(webPrefsProblems(null), ['webprefs_unknown']);
  });

  it('assertWebPrefs·lastWebPrefs: 실제 값을 못 읽으면(메서드 없음·null) 통과시키지 않는다', () => {
    assert.doesNotThrow(() => assertWebPrefs({ getLastWebPreferences: () => GOOD }));
    assert.throws(() => assertWebPrefs({ getLastWebPreferences: () => ({ ...GOOD, nodeIntegration: true }) }), /harden\.webprefs:nodeIntegration/);
    assert.throws(() => assertWebPrefs({}), /webprefs_unknown/);
    assert.throws(() => assertWebPrefs({ getLastWebPreferences: () => null }), /webprefs_unknown/);
    assert.equal(lastWebPrefs({}), null);
  });

  it('창·뷰를 만드는 제품 소스는 모두 sandbox:true를 직접 달고 nodeIntegration·contextIsolation을 풀지 않는다', () => {
    let n = 0;
    for (const f of productFiles) {
      const src = read(`${SRC}/${f}`);
      for (const b of [...prefsBlocks(src, 'new BrowserWindow('), ...prefsBlocks(src, 'new WebContentsView(')]) {
        n++;
        assert.match(b, /sandbox: true/, `${f}: ${b.slice(0, 80)}`);
        assert.ok(!/nodeIntegration: true|contextIsolation: false|webviewTag: true|webSecurity: false/.test(b), f);
      }
    }
    assert.ok(n >= 5, `${n}`); // 셸 창·승인 바·비밀 창·docparse·시연 씨앗(개발 콘솔 창은 W-1에서 지웠다)
  });

  it('devTools: 셸 메인 창은 제품 빌드에서 끄고, 비밀 창·승인 바·docparse는 늘 끈다. 셸은 webview를 끈다', () => {
    const shell = read(`${SRC}/shell-app.ts`);
    assert.ok(shell.includes('devTools: !app.isPackaged') && shell.includes('webviewTag: false'));
    for (const f of ['secret-window.ts', 'approval-bar.ts', 'docparse.ts']) assert.match(read(`${SRC}/${f}`), /devTools: false/, f);
  });

  it('원격 콘텐츠: 앱 창은 자기 스킴만 불러오고, 기본 세션은 자기 스킴 밖 요청을 취소한다', () => {
    for (const f of ['shell-app.ts']) {
      const src = read(`${SRC}/${f}`);
      assert.match(src, /onBeforeRequest\(\(d, cb\) => cb\(\{ cancel: !d\.url\.startsWith\(`\$\{[A-Z_]+_SCHEME\}:\/\/`\)/, f);
    }
    for (const f of productFiles) {
      for (const m of read(`${SRC}/${f}`).matchAll(/loadURL\(([^)]*)\)/g)) {
        const arg = m[1]!;
        // 시연 PDF 만들기(demo-pdfs·demo-seed, javascript:false 창)만 data: HTML을 쓴다.
        const pdfMaker = ['demo-pdfs.ts', 'demo-seed.ts'].includes(f) && arg.startsWith("'data:text/html") && /javascript: false/.test(read(`${SRC}/${f}`));
        assert.ok(/SCHEME|SHELL_URL|^url$/.test(arg) || pdfMaker, `${f}: loadURL(${arg})`);
      }
    }
  });
});

describe('D11 §4 퓨즈', () => {
  it.todo('RunAsNode·NODE_OPTIONS·inspect 인자 off, ASAR 무결성·OnlyLoadAppFromAsar·쿠키 암호화 on, file 특권 off, 퓨즈 → ASAR → 서명 순서 CI 검증 — M4-9 패키징(아직 패키징 빌드가 없다)');
});

describe('D11 §4 CSP(앱 스킴 응답 헤더)', () => {
  it('APP_CSP는 D11 표의 지시어를 모두 담는다', () => {
    const want = {
      'default-src': "'self'",
      'script-src': "'self'",
      'object-src': "'none'",
      'base-uri': "'none'",
      'form-action': "'none'",
      'frame-ancestors': "'none'",
      'connect-src': "'none'",
      'img-src': "'self' data:",
      'require-trusted-types-for': "'script'",
    };
    const got = directives(APP_CSP);
    for (const [k, v] of Object.entries(want)) assert.equal(got.get(k), v, k);
    assert.equal(got.get('style-src'), "'self'");
    assert.ok(![...got.values()].some((v) => v.includes('unsafe')), '느슨한 값 없음');
    const sec = directives(SECRET_CSP);
    for (const k of ['default-src', 'object-src', 'base-uri', 'form-action', 'frame-ancestors', 'connect-src']) assert.equal(sec.get(k), "'none'", k);
    assert.equal(sec.get('require-trusted-types-for'), "'script'");
    assert.deepEqual(appHeaders('text/css'), { 'content-type': 'text/css', 'content-security-policy': APP_CSP, 'x-content-type-options': 'nosniff' });
  });

  it('셸·승인 바는 본문 있는 응답마다 CSP 헤더를 단다(빈 404만 예외)', () => {
    for (const f of ['shell-app.ts', 'approval-bar.ts']) {
      const src = read(`${SRC}/${f}`);
      const responses = [...src.matchAll(/new Response\(([^\n]*)/g)].map((m) => m[1]!);
      assert.ok(responses.length >= 2, f);
      for (const r of responses) assert.ok(r.startsWith("''") || /headers: appHeaders\(/.test(r), `${f}: new Response(${r.slice(0, 60)}`);
    }
    assert.ok(read(`${SRC}/shell-app.ts`).includes("appHeaders('text/html; charset=utf-8', SECRET_CSP)"), '비밀 창 페이지는 좁은 CSP');
    assert.ok(read(`${SRC}/approval-bar.ts`).includes("appHeaders('text/html; charset=utf-8', BAR_CSP)"), '승인 바 페이지는 바 CSP');
  });

  it('렌더러 스크립트에 Trusted Types 싱크·문자열 실행이 없다(require-trusted-types-for를 걸 수 있다)', () => {
    for (const f of staticJs) {
      const src = read(`apps/desktop/static/${f}`).replace(/^\s*\/\/.*$/gm, '');
      for (const bad of ['innerHTML', 'outerHTML', 'insertAdjacentHTML', 'document.write', 'srcdoc', 'eval(', 'new Function', 'setAttribute(\'on']) assert.ok(!src.includes(bad), `${f}: ${bad}`);
    }
  });

  it("정적 페이지의 meta CSP도 'self'·connect-src 'none'(헤더와 겹쳐 걸린다)", () => {
    for (const f of ['shell/shell.html']) {
      const m = /http-equiv="Content-Security-Policy" content="([^"]+)"/.exec(read(`apps/desktop/static/${f}`));
      assert.ok(m, f);
      const d = directives(m[1]!);
      assert.equal(d.get('connect-src'), "'none'", f);
      assert.equal(d.get('script-src'), "'self'", f);
    }
  });
});

describe('D11 §4 전역 핸들러: 권한 거부, 이동·리디렉트·새 창·webview 거부', () => {
  function fakeApp() {
    const app = new EventEmitter() as EventEmitter & { commandLine: { hasSwitch: (s: string) => boolean }; exit: () => void; enableSandbox: () => void; sandboxed: boolean };
    app.commandLine = { hasSwitch: () => false };
    app.exit = () => assert.fail('exit');
    app.sandboxed = false;
    app.enableSandbox = () => void (app.sandboxed = true);
    return app;
  }
  /** node --test(Node 26)의 execArgv에는 기본값 --inspect-port가 들어 있어 스위치 검사가 걸린다. 부르는 동안만 비운다. */
  function withCleanArgv(fn: () => void): void {
    const saved = process.execArgv;
    process.execArgv = [];
    try {
      fn();
    } finally {
      process.execArgv = saved;
    }
  }
  function fakeWc() {
    const wc = new EventEmitter() as EventEmitter & { open?: () => { action: string }; setWindowOpenHandler: (fn: () => { action: string }) => void };
    wc.setWindowOpenHandler = (fn) => void (wc.open = fn);
    return wc;
  }

  it('hardenApp: 샌드박스 켜고, 새로 생긴 모든 webContents에 새 창·이동·하위 프레임 이동·webview 거부, 리디렉트는 허용 스킴만', () => {
    const app = fakeApp();
    withCleanArgv(() => hardenApp(app as unknown as App, ['sax-shell:']));
    assert.ok(app.sandboxed);
    const wc = fakeWc();
    app.emit('web-contents-created', {}, wc);
    assert.deepEqual(wc.open?.(), { action: 'deny' });
    const nav = ev();
    wc.emit('will-navigate', nav);
    assert.ok(nav.prevented, 'will-navigate');
    const sub = Object.assign(ev(), { isMainFrame: false });
    wc.emit('will-frame-navigate', sub);
    assert.ok(sub.prevented, '하위 프레임 이동');
    const main = Object.assign(ev(), { isMainFrame: true });
    wc.emit('will-frame-navigate', main);
    assert.ok(!main.prevented, '최상위는 will-navigate가 맡는다');
    const r1 = Object.assign(ev(), { url: 'https://evil.example/' });
    const r2 = Object.assign(ev(), { url: 'sax-shell://shell/shell.html' });
    wc.emit('will-redirect', r1);
    wc.emit('will-redirect', r2);
    assert.ok(r1.prevented && !r2.prevented);
    const wv = ev();
    wc.emit('will-attach-webview', wv);
    assert.ok(wv.prevented);
  });

  it('hardenApp: --no-sandbox 개발 환경에서는 enableSandbox를 건너뛴다(창마다 sandbox:true가 대신한다)', () => {
    const app = fakeApp();
    app.commandLine.hasSwitch = (s) => s === 'no-sandbox';
    withCleanArgv(() => hardenApp(app as unknown as App, []));
    assert.equal(app.sandboxed, false);
  });

  it('hardenSession: 권한 요청·확인·장치 접근 거부, 내려받기 취소, 맞춤법 사전 끔', () => {
    const got: Record<string, unknown> = {};
    const ses = new EventEmitter() as EventEmitter & Record<string, unknown>;
    ses.setPermissionRequestHandler = (fn: (wc: unknown, p: string, cb: (ok: boolean) => void) => void) => fn(null, 'media', (ok) => (got.request = ok));
    ses.setPermissionCheckHandler = (fn: () => boolean) => (got.check = fn());
    ses.setDevicePermissionHandler = (fn: () => boolean) => (got.device = fn());
    ses.setSpellCheckerEnabled = (on: boolean) => (got.spell = on);
    hardenSession(ses as unknown as Session);
    const dl = ev();
    ses.emit('will-download', dl);
    assert.deepEqual(got, { request: false, check: false, device: false, spell: false });
    assert.ok(dl.prevented);
  });

  it('hardenWindow: 자기 점검을 먼저 하고(걸리면 던진다) 새 창·이동·창 이동/크기 변경을 막고 배율을 1로', async () => {
    const make = (prefs: unknown) => {
      const wc = new EventEmitter() as EventEmitter & Record<string, unknown>;
      const z: number[] = [];
      Object.assign(wc, {
        getLastWebPreferences: () => prefs,
        setWindowOpenHandler: (fn: () => unknown) => (wc.open = fn),
        setZoomFactor: (f: number) => z.push(f),
        setVisualZoomLevelLimits: async (a: number, b: number) => void z.push(a, b),
      });
      return { win: { webContents: wc } as unknown as BrowserWindow, wc, z };
    };
    assert.throws(() => hardenWindow(make({ ...GOOD, sandbox: false }).win), /harden\.webprefs:sandbox/);
    const { win, wc, z } = make(GOOD);
    hardenWindow(win);
    assert.deepEqual((wc.open as () => unknown)(), { action: 'deny' });
    for (const name of ['will-navigate', 'content-bounds-updated']) {
      const e = ev();
      wc.emit(name, e);
      assert.ok(e.prevented, name);
    }
    wc.emit('did-finish-load');
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(z, [1, 1, 1]);
  });

  it('창을 만드는 제품 소스는 모두 hardenWindow를 부르고, 셸 main은 hardenApp·hardenSession을 부른다', () => {
    for (const f of productFiles.filter((f) => read(`${SRC}/${f}`).includes('new BrowserWindow('))) assert.match(read(`${SRC}/${f}`), /hardenWindow\(/, f);
    for (const f of ['shell-app.ts']) assert.ok(/hardenApp\(app,/.test(read(`${SRC}/${f}`)) && read(`${SRC}/${f}`).includes('hardenSession(session.defaultSession)'), f);
    assert.ok(read(`${SRC}/approval-bar.ts`).includes('hardenSession(ses)'), '승인 바 전용 파티션도');
  });
});

describe('D11 §4 IPC: 수신부 검사, 최상위 프레임, 사용자 동작 결속, 횟수 상한', () => {
  it('셸 IPC는 메인 창·셸 페이지에서 온 것만 받고 표 검사(dispatchShell)를 거친다', () => {
    const src = read(`${SRC}/shell-app.ts`);
    const h = src.slice(src.indexOf("ipcMain.handle('sax'"));
    assert.match(h, /e\.sender !== wc \|\| e\.senderFrame\?\.url !== SHELL_URL/);
    assert.match(h, /return dispatchShell\(e\.senderFrame, SHELL_URL, handlers, req\)/);
    assert.ok(src.includes('const handlers: ShellHandlers'), '처리기 표 형이 요청 표와 묶여 있다');
  });

  it('run.prepare 분당 3회, docs.open 분당 5회(ADR-027, D-21(N-27))', () => {
    const src = read(`${SRC}/shell-app.ts`);
    assert.ok(src.includes('new RateWindow(opts.preparePerMin ?? 3, 60_000)') && src.includes('new RateWindow(5, 60_000)'));
    assert.match(src, /'docs\.open': docsCall\(async \(p\) => \{\s*needGesture\(3_000\);\s*if \(!openRate\.take/);
  });

  it.todo('JSON Schema 정본(design/schemas/ipc/renderer-request.schema.json)으로 검사 — 스키마는 M1-4 스키마 목록, 그 전에는 ipc.ts 표(D-48)');
});

describe('D11 §4 shell.openExternal: main만, URL이 아니라 키만', () => {
  it('데스크톱 제품 소스·렌더러에 openExternal이 없다(외부 URL을 여는 길이 아직 없다)', () => {
    for (const f of productFiles) assert.ok(!read(`${SRC}/${f}`).includes('openExternal'), f);
    for (const f of staticJs) assert.ok(!read(`apps/desktop/static/${f}`).includes('openExternal'), f);
  });
  it.todo('외부 URL 열기(정부24 후처리 안내 등)가 생기면 portalId 키 → https·userinfo 없음·포트 없음·내장 eTLD+1 허용 목록 검사 함수로 — 그 화면(D17 후처리)과 함께');
});

describe('D11 §4 경로: 앱 준비 전 setPath, 사용자 전용 루트', () => {
  it('제품 진입점은 앱 폴더 준비(prepareLayout) 뒤에 setPath를 하고, 그 뒤에 ready를 기다린다. 치운 항목은 로그에 남긴다', () => {
    assert.match(read(`${SRC}/shell.ts`), /for \(const name of prepared\.setAside\) layoutLog\.event\('main\.layout_set_aside', \{ name \}\)/);
    for (const [f, prepCall] of [['shell.ts', 'await prepareLayout(root)']] as const) {
      const src = read(`${SRC}/${f}`);
      const prep = src.indexOf(prepCall);
      const set = src.indexOf("app.setPath('userData', paths.userData)");
      const ready = src.indexOf('app.whenReady()');
      assert.ok(prep >= 0 && set > prep && ready > set, f);
      for (const k of ['logs', 'crashDumps']) assert.ok(src.includes(`app.setPath('${k}', paths.${k})`), `${f}: ${k}`);
    }
  });
  it.todo('루트 DACL(소유자 + SYSTEM, 상속 차단)·검색 색인 제외 — @sax/platform prepareLayout(플랫폼 트랙, tests/localdata.test.ts)');
});

describe('D11 §4 프로세스: execArgv 고정, env 허용 목록, docparse 대화상자 끔', () => {
  it('엔진·금고 utilityProcess는 env: childEnv(), execArgv: []로만 띄운다', () => {
    const src = read(`${SRC}/engine-host.ts`);
    const forks = [...src.matchAll(/utilityProcess\.fork\(([^\n]*)/g)].map((m) => m[1]!);
    assert.equal(forks.length, 2);
    for (const f of forks) assert.ok(f.includes('env: childEnv()') && f.includes('execArgv: []') && f.includes("stdio: 'ignore'"), f);
  });
  it('childEnv: DEBUG·NODE_*·ELECTRON_*·PLAYWRIGHT_*·프록시·TLS·API 키 변수를 넘기지 않는다', () => {
    const env = childEnv({ PATH: '/bin', DEBUG: '*', NODE_DEBUG: 'x', NODE_OPTIONS: '--inspect', ELECTRON_RUN_AS_NODE: '1', ELECTRON_ENABLE_LOGGING: '1', PLAYWRIGHT_BROWSERS_PATH: '/x', HTTPS_PROXY: 'http://p', NODE_TLS_REJECT_UNAUTHORIZED: '0', SSLKEYLOGFILE: '/k', OPENAI_API_KEY: 'k' });
    assert.deepEqual(env, { PATH: '/bin' });
  });
  it('docparse 숨김 창은 disableDialogs: true, 네트워크 차단 세션', () => {
    const src = read(`${SRC}/docparse.ts`);
    assert.ok(src.includes('disableDialogs: true') && src.includes('session: ses'));
  });
});

describe('D11 §4 승인 바(ADR-021)', () => {
  it('뷰 webPreferences: sandbox·javascript:false·preload 없음·devTools:false·focusOnNavigation:false, 전용 메모리 파티션', () => {
    const src = read(`${SRC}/approval-bar.ts`);
    const [b] = prefsBlocks(src, 'new WebContentsView(');
    assert.ok(b);
    for (const k of ['sandbox: true', 'javascript: false', 'devTools: false', 'focusOnNavigation: false', 'webviewTag: false', 'session: barSession()']) assert.ok(b.includes(k), k);
    assert.ok(!b.includes('preload'));
    assert.ok(src.includes("session.fromPartition('sax-approval')") && !src.includes("'persist:sax-approval'"));
    // 실제로 걸린 값으로 한 번 더 본다(스크립트가 켜져 있으면 바를 만들지 않는다).
    assert.match(src, /prefs\?\.javascript !== false/);
  });
  it("바 CSP는 default-src 'none'; style-src 'self'(meta와 응답 헤더), 배경색 지정, 메인 창 cursor-changed 감시", () => {
    assert.equal(BAR_CSP, "default-src 'none'; style-src 'self'");
    const src = read(`${SRC}/approval-bar.ts`);
    assert.ok(src.includes("win.webContents.on('cursor-changed'") && src.includes('setBackgroundColor('));
  });
  it('메인 창: webviewTag:false·disableDialogs:true, 제품 소스에 sendInputEvent·debugger 없음(e2e만)', () => {
    const shell = read(`${SRC}/shell-app.ts`);
    assert.ok(shell.includes('webviewTag: false') && shell.includes('disableDialogs: true'));
    for (const f of productFiles) assert.ok(!/sendInputEvent|\.debugger\b/.test(read(`${SRC}/${f}`)), f);
  });
});

describe('D11 §4 기동 자기 점검', () => {
  it('셸 진입점은 스위치 검사(hardenApp)를 ready 전에, startShell·ApprovalBar도 다시 검사한다', () => {
    const shell = read(`${SRC}/shell-app.ts`);
    assert.ok(shell.indexOf('hardenApp(app,') < shell.indexOf('export async function startShell'));
    const start = shell.slice(shell.indexOf('export async function startShell'));
    assert.ok(start.indexOf('assertNoDebugSwitches(app);') < start.indexOf('serve();'), 'startShell 첫 동작이 스위치 검사');
    assert.match(read(`${SRC}/harden.ts`), /export function hardenWindow\(win: BrowserWindow\): void \{\s*const wc = win\.webContents;\s*assertWebPrefs\(wc\);/);
  });
  it.todo('금고 navigator.webdriver === true 확인(ADR-010) — 금고 트랙(packages/vault)');
});

describe('D11 §4 덤프·로그·자동 업데이트·모바일·의존성·크래시 리포트', () => {
  it('크래시 리포터를 켜지 않는다(옵트인 전까지), 의존성 버전은 정확히 고정', () => {
    for (const f of productFiles) assert.ok(!read(`${SRC}/${f}`).includes('crashReporter'), f);
    const pkg = JSON.parse(read('apps/desktop/package.json')) as { dependencies: Record<string, string>; devDependencies: Record<string, string> };
    for (const [k, v] of Object.entries({ ...pkg.dependencies, ...pkg.devDependencies })) assert.ok(v.startsWith('workspace:') || /^\d+\.\d+\.\d+$/.test(v), `${k}@${v}`);
    assert.ok(fs.existsSync(path.join(root, 'pnpm-lock.yaml')));
  });
  it.todo('덤프: 금고 sodium_malloc + WerRegisterExcludedMemoryBlock — 금고 트랙(Phase 1)');
  it.todo('로그: 릴리스 빌드에서 CDP 프로토콜 로깅 경로 제거, 14일 보존, 진단 내보내기 전 누출 스캐너 — M4-9 릴리스 빌드·D12');
  it.todo('자동 업데이트: electron-updater ≥ 6.3.0-alpha.6, latest.yml Ed25519 서명·expires·단조 version — M4-7·M4-9');
  it.todo('모바일 OTA 미사용·ThisDeviceOnly 키 — 폰 트랙 M7-1');
  it.todo('의존성 서명/프로비넌스 검증·월 1회 감사(pnpm audit --prod CI) — CI(ADR-028)');
});
