// D05 §3.3~§3.5 표 대조: 중계 허용 목록·명시 거부·세션 범위·응답 정리·비밀 창 2상태(ADR-005 v3 결정 2·3·4).
// CDP 명령 전체 목록은 고정한 playwright-core(1.64.1)의 protocol.d.ts에서 읽는다. 허용 목록 밖 명령은 하나도 빠짐없이 거부되어야 한다.
// Chrome 없이 가짜 연결로 돈다(실 Chrome 회귀는 vault-relay·playwright-relay).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { describe, it } from 'node:test';
import {
  ACTIVE_WINDOW_DENY_PREFIXES, checkSessionCommand, RELAY_DENIED_METHODS, RELAY_DOMAIN_METHOD_ALLOWLIST,
} from '@sax/vault';
import { fakeRelay, tick, type Json } from './fake-relay.ts';
import { testPolicy } from './harness.ts';

/** CDP 명령 전체(Protocol.CommandParameters의 키). */
function allCdpCommands(): string[] {
  const require = createRequire(import.meta.url);
  const pkg = path.dirname(require.resolve('playwright-core/package.json'));
  const src = fs.readFileSync(path.join(pkg, 'types', 'protocol.d.ts'), 'utf8');
  const start = src.indexOf('export interface CommandParameters {');
  assert.ok(start > 0, 'protocol.d.ts CommandParameters');
  const end = src.indexOf('\n  }', start);
  return [...src.slice(start, end).matchAll(/"([A-Za-z]+\.[A-Za-z]+)":/g)].map((m) => m[1]!);
}

const COMMANDS = allCdpCommands();

/**
 * 기대 표(D05 §3.3 + S6b 측정 + 이 PR의 도메인 안 메서드 목록). 상수(constants.ts)와 따로 적어 두 쪽이 어긋나면 실패한다.
 * 허용 도메인 안에서도 메서드 단위 허용 목록이다(도메인 '*' 없음).
 */
const EXPECTED_ALLOWED: Record<string, string[]> = {
  // Page: Playwright 1.64가 실제로 부르는 것(S6b 관측 + coreBundle 조사) 중 정보·권한을 넓히지 않는 것
  Page: [
    'enable', 'disable', 'getFrameTree', 'setLifecycleEventsEnabled', 'addScriptToEvaluateOnNewDocument', 'removeScriptToEvaluateOnNewDocument',
    'createIsolatedWorld', 'navigate', 'reload', 'stopLoading', 'getNavigationHistory', 'navigateToHistoryEntry', 'getLayoutMetrics', 'setFontFamilies',
    'captureScreenshot', 'startScreencast', 'stopScreencast', 'screencastFrameAck', 'handleJavaScriptDialog', 'close', 'getResourceTree',
  ],
  Runtime: ['enable', 'disable', 'evaluate', 'callFunctionOn', 'getProperties', 'releaseObject', 'releaseObjectGroup', 'runIfWaitingForDebugger', 'awaitPromise', 'discardConsoleEntries'],
  DOM: [
    'enable', 'disable', 'getDocument', 'describeNode', 'resolveNode', 'requestNode', 'requestChildNodes', 'pushNodesByBackendIdsToFrontend', 'querySelector', 'querySelectorAll',
    'getAttributes', 'getBoxModel', 'getContentQuads', 'scrollIntoViewIfNeeded', 'getFrameOwner', 'focus',
  ],
  // 접근성·DOMSnapshot은 읽기만이고 응답은 금고가 정리한다(§3.4). D06 마스킹 계층의 입력.
  Accessibility: ['enable', 'disable', 'getFullAXTree', 'getPartialAXTree', 'getRootAXNode', 'getChildAXNodes', 'queryAXTree', 'getAXNodeAndAncestors'],
  DOMSnapshot: ['enable', 'disable', 'captureSnapshot'],
  Input: ['dispatchKeyEvent', 'dispatchMouseEvent', 'dispatchTouchEvent', 'dispatchDragEvent', 'insertText', 'setInterceptDrags', 'cancelDragging', 'setIgnoreInputEvents'],
  Log: ['enable', 'disable', 'clear'],
  // 이벤트 수신·읽기 전용. 응답 바디 조회는 없다(N-51).
  Network: ['enable', 'disable', 'getRequestPostData', 'setCacheDisabled', 'setExtraHTTPHeaders', 'setBypassServiceWorker'],
  // 커밋 가드용. enable은 허용 호스트 패턴일 때만(fetchPatternsAllowed). fulfillRequest·응답 바디는 없다.
  Fetch: ['enable', 'disable', 'continueRequest', 'failRequest', 'getRequestPostData', 'continueWithAuth'],
  // 포커스 관련(+ Playwright 미디어 2개, S6b)
  Emulation: ['setFocusEmulationEnabled', 'setEmulatedMedia', 'setAutoDarkModeOverride'],
  // page 세션 수준 자식 자동 부착·분리만(브라우저 수준은 가상 루트)
  Target: ['setAutoAttach', 'detachFromTarget'],
  CSS: ['enable', 'disable'],
  Inspector: ['enable', 'disable'],
};

/** D05 §3.3 deniedMethods(와일드카드 도메인 포함). 허용 도메인 안의 것은 상수에도 명시돼 있어야 한다. */
const D05_DENIED_EXACT = [
  'Target.createBrowserContext', 'Target.exposeDevToolsProtocol', 'Target.attachToBrowserTarget', 'Page.setDownloadBehavior', 'Network.getAllCookies', 'Network.getCookies',
  'Network.getResponseBodyForInterception', 'Network.streamResourceContent', 'Page.captureSnapshot', 'Page.getResourceContent', 'DOMSnapshot.getSnapshot',
];
const D05_DENIED_DOMAINS = ['Browser', 'Storage', 'SystemInfo', 'Tracing', 'IO'];
/** D05 §3.3·§3.5 본문: 응답 바디 조회는 허용 목록에 없다. */
const D05_NOT_ALLOWED = ['Network.getResponseBody', 'Fetch.getResponseBody', 'Fetch.fulfillRequest', 'Fetch.takeResponseBodyAsStream'];

const NEUTRAL = { active: false, tainted: false };
const policy = testPolicy();
const verdict = (m: string, params: Json = {}, state = NEUTRAL) => checkSessionCommand(m, params, state, policy, new Set());
const isExpectedAllowed = (m: string) => {
  const [d, n] = m.split('.') as [string, string];
  return EXPECTED_ALLOWED[d]?.includes(n) ?? false;
};
/** 판정이 인자에 따라 갈리는 허용 메서드에 넣을 정상 인자. */
const OK_PARAMS: Record<string, Json> = {
  'Page.navigate': { url: 'http://127.0.0.1:1/login' },
  'Target.setAutoAttach': { autoAttach: true, waitForDebuggerOnStart: false, flatten: true },
};

describe('D05 §3.3 중계 허용 목록 = 표', () => {
  it(`CDP 명령 ${COMMANDS.length}개를 모두 판정한다: 표 안만 허용, 나머지는 거부`, () => {
    assert.ok(COMMANDS.length > 600, '프로토콜 목록을 읽었다');
    const wrongAllow: string[] = [];
    const wrongDeny: string[] = [];
    for (const m of COMMANDS) {
      const v = verdict(m, OK_PARAMS[m] ?? {});
      if (v.ok && !isExpectedAllowed(m)) wrongAllow.push(m);
      if (!v.ok && isExpectedAllowed(m)) wrongDeny.push(`${m}(${v.reason})`);
    }
    assert.deepEqual(wrongAllow, [], '표 밖인데 허용된 명령');
    assert.deepEqual(wrongDeny, [], '표 안인데 거부된 명령');
  });

  it('상수에 도메인 전체 허용(*)이 없다(기본 거부는 메서드 단위)', () => {
    for (const [d, rule] of Object.entries(RELAY_DOMAIN_METHOD_ALLOWLIST)) assert.notEqual(rule, '*', d);
    assert.deepEqual(Object.keys(RELAY_DOMAIN_METHOD_ALLOWLIST).sort(), Object.keys(EXPECTED_ALLOWED).sort());
    for (const [d, names] of Object.entries(EXPECTED_ALLOWED)) assert.deepEqual([...(RELAY_DOMAIN_METHOD_ALLOWLIST[d] as string[])].sort(), [...names].sort(), d);
  });

  it('D05 deniedMethods: 명시 목록과 와일드카드 도메인의 모든 명령이 모든 상태에서 거부된다', () => {
    const wild = COMMANDS.filter((m) => D05_DENIED_DOMAINS.includes(m.split('.')[0]!));
    assert.ok(wild.length > 40);
    for (const m of [...D05_DENIED_EXACT, ...wild, ...D05_NOT_ALLOWED]) {
      for (const st of [NEUTRAL, { active: false, tainted: true }, { active: true, tainted: true }]) assert.equal(verdict(m, {}, st).ok, false, `${m} ${JSON.stringify(st)}`);
    }
    for (const m of D05_DENIED_EXACT) if (EXPECTED_ALLOWED[m.split('.')[0]!]) assert.ok(RELAY_DENIED_METHODS.has(m) || !isExpectedAllowed(m), m);
  });

  it('인자 조건: Page.navigate는 허용 origin만, Target.setAutoAttach는 flatten만', () => {
    assert.equal(verdict('Page.navigate', { url: 'https://example.com/' }).ok, false);
    assert.equal(verdict('Page.navigate', { url: 'javascript:alert(1)' }).ok, false);
    assert.equal(verdict('Target.setAutoAttach', { autoAttach: true, flatten: false }).ok, false);
  });
});

describe('D05 §3.3 거부 동작: 엔진에 오류 + vault.cdp_denied(인자 없음)', () => {
  it('표 밖 명령마다 엔진은 오류를 받고 Chrome에는 아무것도 가지 않는다', async () => {
    const f = await fakeRelay();
    const denied = COMMANDS.filter((m) => !isExpectedAllowed(m));
    const rawBefore = f.conn.raw.length;
    for (const m of denied) {
      const r = await f.call(m, { secretArg: 'TEST-ARG-should-not-log' });
      assert.ok(r.error, `${m}: 엔진이 오류를 받는다`);
    }
    assert.equal(f.conn.raw.length, rawBefore, '거부된 명령은 Chrome에 전달되지 않는다');
    const lines = f.log.lines.filter((l) => l.includes('"vault.cdp_denied"'));
    assert.equal(lines.length, denied.length);
    for (const l of lines) assert.doesNotMatch(l, /TEST-ARG/, '거부 이벤트에 인자를 남기지 않는다');
  });

  it('루트(브라우저) 명령: 합성 4종 밖은 전부 거부', async () => {
    const f = await fakeRelay();
    const synthetic = new Set(['Browser.getVersion', 'Target.setAutoAttach', 'Target.getBrowserContexts', 'Target.getTargetInfo', 'Target.closeTarget', 'Target.activateTarget']);
    let id = 5000;
    for (const m of COMMANDS.filter((x) => !synthetic.has(x))) {
      f.relay.onEngineMessage(JSON.stringify({ id: ++id, method: m, params: {} }));
    }
    await tick(20);
    await f.relay.drained();
    const errors = f.toEngine.filter((x) => typeof x.id === 'number' && (x.id as number) > 5000 && x.error);
    assert.equal(errors.length, COMMANDS.length - synthetic.size);
  });
});

describe('D05 §3.4 응답 정리 표', () => {
  it('쿠키·인증 헤더와 원문 헤더·쿠키 목록은 제자리에서 지운다(모든 Network 이벤트 모양)', async () => {
    const f = await fakeRelay();
    const hdr = () => ({ Cookie: 'SID=TEST-COOKIE-1', 'set-cookie': 'a=TEST-COOKIE-2', Authorization: 'Bearer TEST-COOKIE-3', 'Content-Type': 'text/html' });
    const evs: Array<[string, Json]> = [
      ['Network.requestWillBeSent', { requestId: '1', request: { url: 'http://127.0.0.1:1/', headers: hdr() }, redirectResponse: { headers: hdr(), headersText: 'TEST-COOKIE-4' } }],
      ['Network.requestWillBeSentExtraInfo', { requestId: '1', headers: hdr(), associatedCookies: [{ cookie: { value: 'TEST-COOKIE-5' } }] }],
      ['Network.responseReceived', { requestId: '1', response: { headers: hdr(), requestHeaders: hdr(), headersText: 'TEST-COOKIE-6' } }],
      ['Network.responseReceivedExtraInfo', { requestId: '1', headers: hdr(), blockedCookies: [{ cookie: { value: 'TEST-COOKIE-7' } }], exemptedCookies: [{ cookie: { value: 'TEST-COOKIE-8' } }], headersText: 'TEST-COOKIE-9' }],
      ['Network.webSocketWillSendHandshakeRequest', { requestId: '2', request: { headers: hdr() } }],
      ['Network.webSocketHandshakeResponseReceived', { requestId: '2', response: { headers: hdr(), requestHeadersText: 'TEST-COOKIE-10' } }],
      ['Fetch.requestPaused', { requestId: 'F1', request: { url: 'http://127.0.0.1:1/', headers: hdr() }, responseHeaders: [{ name: 'Set-Cookie', value: 'TEST-COOKIE-11' }] }],
    ];
    for (const [m, p] of evs) f.conn.emitEvent(m, p, f.sid);
    await tick(20);
    await f.relay.drained();
    const out = JSON.stringify(f.toEngine);
    assert.doesNotMatch(out, /TEST-COOKIE/);
    assert.match(out, /text\/html/, '다른 헤더는 남긴다');
  });

  it('비밀 오염 동안의 요청 바디: 이벤트의 postData·postDataEntries·hasPostData 제거, 바디 조회 거부', async () => {
    const f = await fakeRelay();
    f.relay.openWindow(f.relay.targets.get('RUN')!, 'typist', 'RUN', 7);
    f.conn.emitEvent('Network.requestWillBeSent', { requestId: 'R9', request: { url: 'http://127.0.0.1:1/', postData: 'pw=TEST-BODY-1', postDataEntries: [{ bytes: 'TEST-BODY-2' }], hasPostData: true } }, f.sid);
    f.conn.emitEvent('Fetch.requestPaused', { requestId: 'F9', networkId: 'R9', request: { url: 'http://127.0.0.1:1/', postData: 'TEST-BODY-3' } }, f.sid);
    await tick(20);
    await f.relay.drained();
    assert.doesNotMatch(JSON.stringify(f.toEngine), /TEST-BODY|hasPostData/);
    f.relay.deactivateWindow(f.relay.targets.get('RUN')!);
    for (const [m, id] of [['Network.getRequestPostData', 'R9'], ['Fetch.getRequestPostData', 'F9']] as const) {
      assert.ok((await f.call(m, { requestId: id })).error, `${m} 오염 요청`);
    }
  });

  it('비밀 노드 값: DOM 응답·이벤트, 접근성, DOMSnapshot에서 지운다', async () => {
    const f = await fakeRelay();
    const t = f.relay.targets.get('RUN')!;
    f.relay.openWindow(t, 'human', 'RUN', 7);
    f.relay.deactivateWindow(t);
    const node = { nodeId: 1, backendNodeId: 7, nodeName: 'INPUT', attributes: ['type', 'text', 'value', 'TEST-VAL-1'], value: 'TEST-VAL-2' };
    const pwNode = { nodeId: 2, backendNodeId: 8, nodeName: 'INPUT', attributes: ['type', 'password', 'value', 'TEST-VAL-3'] };
    const dom = await f.call('DOM.describeNode', { backendNodeId: 7 }, { node: { ...node, children: [pwNode] } });
    assert.doesNotMatch(JSON.stringify(dom), /TEST-VAL/);
    f.conn.emitEvent('DOM.setChildNodes', { parentId: 0, nodes: [structuredClone(node)] }, f.sid);
    f.conn.emitEvent('DOM.attributeModified', { nodeId: 1, name: 'value', value: 'TEST-VAL-4' }, f.sid);
    await tick(20);
    await f.relay.drained();
    assert.doesNotMatch(JSON.stringify(f.toEngine), /TEST-VAL/);
    const ax = await f.call('Accessibility.getFullAXTree', {}, { nodes: [{ nodeId: 'a', backendDOMNodeId: 7, role: { value: 'textbox' }, name: { value: '비밀번호' }, value: { value: 'TEST-VAL-5' } }] });
    assert.doesNotMatch(JSON.stringify(ax), /TEST-VAL/);
    const snap = await f.call('DOMSnapshot.captureSnapshot', { computedStyles: [] }, {
      strings: ['INPUT', 'TEST-VAL-6'], documents: [{ nodes: { backendNodeId: [7], attributes: [[]], inputValue: { index: [0], value: [1] } } }],
    });
    assert.doesNotMatch(JSON.stringify(snap), /TEST-VAL/);
  });

  it('오염 동안 Runtime.getProperties 응답의 문자열 value 항목을 지운다(D-17)', async () => {
    const f = await fakeRelay();
    const t = f.relay.targets.get('RUN')!;
    f.relay.openWindow(t, 'human', 'RUN', 7);
    f.relay.deactivateWindow(t);
    const r = await f.call('Runtime.getProperties', { objectId: 'X' }, {
      result: [
        // Chrome은 문자열 RemoteObject의 값을 description에도 복사한다.
        { name: 'value', value: { type: 'string', value: 'TEST-PROP-1', description: 'TEST-PROP-1' } },
        { name: 'defaultValue', value: { type: 'string', value: 'TEST-PROP-2', description: 'TEST-PROP-2' } },
        { name: 'id', value: { type: 'string', value: 'pw' } },
      ],
    });
    assert.doesNotMatch(JSON.stringify(r), /TEST-PROP/);
    assert.match(JSON.stringify(r), /"pw"/, '다른 속성은 남긴다');
  });

  it('받을 때 오염이었던 DOM·AX 이벤트는 줄에서 기다리는 사이 문서 커밋으로 비밀 노드가 비워져도 정화한다', async () => {
    const f = await fakeRelay();
    const t = f.relay.targets.get('RUN')!;
    f.relay.openWindow(t, 'human', 'RUN', 7);
    f.relay.deactivateWindow(t);
    // type=text 칸(보안카드 숫자 등): 비밀 노드 ID로만 알 수 있다(짧은 값은 알려진 값 치환에도 안 걸린다).
    const node = () => ({ nodeId: 1, backendNodeId: 7, nodeName: 'INPUT', attributes: ['type', 'text', 'value', '1234'], value: '1234' });
    f.conn.emitEvent('DOM.setChildNodes', { parentId: 0, nodes: [node()] }, f.sid);
    f.conn.emitEvent('DOM.childNodeInserted', { parentNodeId: 0, previousNodeId: 0, node: node() }, f.sid);
    f.conn.emitEvent('DOM.shadowRootPushed', { hostId: 0, root: { ...node(), children: [node()] } }, f.sid);
    f.conn.emitEvent('Accessibility.nodesUpdated', { nodes: [{ nodeId: 'a', backendDOMNodeId: 7, role: { value: 'textbox' }, value: { value: '1234' } }] }, f.sid);
    f.relay.endWindow(t, 'commit');
    await tick(5);
    await f.relay.drained();
    assert.doesNotMatch(JSON.stringify(f.toEngine.filter((m) => /DOM\.|Accessibility\./.test(String(m.method)))), /1234/);
  });

  it('보낼 때 오염이었던 요청은 응답 전에 문서 커밋으로 창이 닫혀도 정화한다(getProperties·Network/Fetch 바디·DOM)', async () => {
    const f = await fakeRelay();
    const t = f.relay.targets.get('RUN')!;
    f.relay.openWindow(t, 'human', 'RUN', 7);
    f.relay.deactivateWindow(t);
    const reqs: Array<[string, Json, Json]> = [
      ['Runtime.getProperties', { objectId: 'X' }, { result: [{ name: 'value', value: { type: 'string', value: 'TEST-RACE-1', description: 'TEST-RACE-1' } }] }],
      ['Network.getRequestPostData', { requestId: 'R-ok' }, { postData: 'pw=TEST-RACE-2' }],
      ['Fetch.getRequestPostData', { requestId: 'F-ok' }, { postData: 'pw=TEST-RACE-4' }],
      ['DOM.describeNode', { backendNodeId: 7 }, { node: { nodeId: 1, backendNodeId: 7, nodeName: 'INPUT', attributes: ['value', 'TEST-RACE-3'], value: 'TEST-RACE-3' } }],
    ];
    let id = 900;
    const before = f.conn.raw.length;
    for (const [m, params] of reqs) f.relay.onEngineMessage(JSON.stringify({ id: id++, method: m, params, sessionId: f.sid }));
    await tick(1);
    // 응답보다 먼저 문서 커밋(금고 세션에서 바로 처리) → 창이 닫히고 비밀 노드가 비워진다.
    f.relay.endWindow(t, 'commit');
    assert.equal(t.win, undefined);
    const sent = f.conn.raw.slice(before);
    for (const [m, , result] of reqs) {
      const fwd = sent.find((x) => x.method === m);
      assert.ok(fwd, `${m} 전달됨`);
      f.conn.reply(Number(fwd.id), structuredClone(result), f.sid);
    }
    await tick(5);
    await f.relay.drained();
    assert.doesNotMatch(JSON.stringify(f.toEngine), /TEST-RACE/);
    // 커밋 뒤 새로 보낸 요청은 오염이 아니다.
    const r = await f.call('Runtime.getProperties', { objectId: 'Y' }, { result: [{ name: 'value', value: { type: 'string', value: 'plain-after' } }] });
    assert.match(JSON.stringify(r), /plain-after/);
  });

  it('스크린샷·스크린캐스트: 오염(활성 포함) 동안 거부, 화면 녹화 프레임은 엔진에 안 감', async () => {
    for (const st of [{ active: false, tainted: true }, { active: true, tainted: true }]) {
      for (const m of ['Page.captureScreenshot', 'Page.startScreencast']) assert.equal(verdict(m, {}, st).ok, false, `${m} ${JSON.stringify(st)}`);
    }
    for (const m of ['Page.startScreenRecording', 'Page.getAnnotatedPageContent', 'Page.searchInResource', 'Runtime.compileScript', 'Runtime.runScript', 'Runtime.queryObjects', 'Page.setBypassCSP', 'Page.setDocumentContent', 'Page.deleteCookie', 'DOM.getOuterHTML']) {
      assert.equal(verdict(m).ok, false, `${m}은 상시 거부(스크린샷·값 접근 거부 우회 경로)`);
    }
    const f = await fakeRelay();
    const t = f.relay.targets.get('RUN')!;
    f.relay.openWindow(t, 'typist', 'RUN', 7);
    f.conn.emitEvent('Page.screencastFrame', { data: 'TEST-FRAME', sessionId: 1 }, f.sid);
    await tick(20);
    await f.relay.drained();
    assert.doesNotMatch(JSON.stringify(f.toEngine), /TEST-FRAME/);
  });
});

describe('D05 §3.5 비밀 창 2상태 표', () => {
  const allowedCmds = COMMANDS.filter(isExpectedAllowed);
  const prefixHit = (m: string) => ACTIVE_WINDOW_DENY_PREFIXES.some((p) => m === p || m.startsWith(p));

  it('활성 창: Input·DOM.focus·Emulation·스크린샷·접근성·DOMSnapshot·Runtime 전부 거부, 그 밖 허용 명령은 통과', () => {
    const active = { active: true, tainted: true };
    for (const m of allowedCmds) {
      const v = verdict(m, OK_PARAMS[m] ?? {}, active);
      const [d] = m.split('.');
      const mustDeny = ['Input', 'Emulation', 'Accessibility', 'DOMSnapshot', 'Runtime'].includes(d!) || ['DOM.focus', 'Page.captureScreenshot', 'Page.startScreencast'].includes(m);
      assert.equal(mustDeny, prefixHit(m), `상수와 표: ${m}`);
      if (mustDeny) assert.equal(v.ok, false, `활성 ${m}`);
    }
  });

  it('오염 상태: Input은 다시 허용(로그인 클릭), 값 접근 패턴 Runtime은 거부, 고정 화면 확인 식은 통과', () => {
    const tainted = { active: false, tainted: true };
    for (const m of allowedCmds.filter((x) => x.startsWith('Input.'))) assert.equal(verdict(m, {}, tainted).ok, true, m);
    assert.equal(verdict('Runtime.evaluate', { expression: 'document.querySelector("#pw").value' }, tainted).ok, false);
    assert.equal(verdict('Runtime.callFunctionOn', { functionDeclaration: '(u, ...a) => u.evaluate(...a)', arguments: [{ value: 'e => e.value' }] }, tainted).ok, false);
    assert.equal(verdict('Runtime.evaluate', { expression: '1 + 1' }, tainted).ok, true);
  });

  it('활성 창 동안 Runtime.bindingCalled·consoleAPICalled 이벤트는 엔진에 안 간다', async () => {
    const f = await fakeRelay();
    f.relay.openWindow(f.relay.targets.get('RUN')!, 'typist', 'RUN', 7);
    f.conn.emitEvent('Runtime.consoleAPICalled', { type: 'log', args: [{ value: 'TEST-CONSOLE' }] }, f.sid);
    f.conn.emitEvent('Runtime.bindingCalled', { name: 'x', payload: 'TEST-BINDING' }, f.sid);
    await tick(20);
    await f.relay.drained();
    assert.doesNotMatch(JSON.stringify(f.toEngine), /TEST-CONSOLE|TEST-BINDING/);
  });
});
