// PoC-4 금고 최소판: 허용 목록 중계·응답 정리·비밀 창·누출 스캐너 (D05 §3~§4, D13 S6·S6c·S6d·S6f).
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { dirGuard } from '@sax/platform';
import { launchChrome, Relay, scanDir, testSecret, variantsOf, Vault } from '@sax/vault';
import { startFixture, type Fixture } from './fixtures/server.ts';
import { writeMeasure } from './measure-out.ts';
import { startHarness, testPolicy, type Harness } from './harness.ts';
import { RawEngine, sleep } from './raw-engine.ts';

/** 사용자 키보드 대역: 금고 감시 세션에 직접 입력한다(엔진 경로가 아님). */
async function userType(h: Harness, targetId: string, text: string): Promise<void> {
  const t = h.vault.relay!.targets.get(targetId)!;
  await h.vault.relay!.send('Input.insertText', { text }, t.vaultSession);
}
async function userEval(h: Harness, targetId: string, expression: string): Promise<unknown> {
  const t = h.vault.relay!.targets.get(targetId)!;
  const r = await h.vault.relay!.send<{ result: { value?: unknown } }>('Runtime.evaluate', { expression, returnByValue: true }, t.vaultSession);
  return r.result.value;
}

describe('vault relay (raw engine)', () => {
  let fx: Fixture;
  let h: Harness;
  let eng: RawEngine;
  let sid: string;
  let targetId: string;
  const secrets: string[] = [];
  const measurements: Record<string, unknown> = {};

  before(async () => {
    fx = await startFixture();
    h = await startHarness();
    eng = new RawEngine(h.client);
    await h.client.rpc('browser.launch');
    ({ sessionId: sid, targetId } = await eng.attachRunPage());
    await h.vault.profileChecked();
  });

  after(async () => {
    await writeMeasure('relay-measurements.json', measurements);
    await h.close();
    await fx.close();
  });

  it('launch() 인자 없음, 파이프 기동, 포트 미사용, webdriver 자기 점검', async () => {
    assert.deepEqual(await h.control.rpc('status').then((s) => Object.keys(s as object)), ['launched', 'profileProblems']);
    const st = await h.client.rpc<{ launched: boolean }>('status').catch((e: Error) => e);
    assert.ok(st instanceof Error, 'control RPC는 엔진 포트에서 거부');
    assert.match(String((st as Error).message), /denied/);
    const devtoolsActivePort = await fs.stat(path.join(h.paths.chromeProfile, 'DevToolsActivePort')).catch(() => null);
    assert.equal(devtoolsActivePort, null, 'remote-debugging-port를 쓰면 생기는 파일이 없어야 한다');
    // Chrome 브라우저 프로세스가 TCP 수신 소켓을 열지 않았다(다른 OS 사용자·인포스틸러가 붙을 포트 없음).
    const { execFileSync } = await import('node:child_process');
    const pid = h.vault.chromePid!;
    let listening: string;
    try {
      listening = execFileSync('lsof', ['-nP', '-a', '-p', String(pid), '-iTCP', '-sTCP:LISTEN'], { encoding: 'utf8' });
    } catch {
      listening = ''; // lsof는 결과가 없으면 1로 끝난다
    }
    measurements.chromeListeningTcp = listening.trim().split('\n').filter(Boolean).length;
    assert.equal(listening.trim(), '');
    assert.equal(await eng.evaluate(sid, 'navigator.webdriver'), true);
  });

  it('브라우저 타깃·Storage·다운로드 경로·쿠키 호출은 거부되고 vault.cdp_denied가 남는다', async () => {
    const root = [
      ['Target.createBrowserContext', {}], ['Target.attachToBrowserTarget', {}], ['Target.createTarget', { url: 'about:blank' }],
      ['Target.setDiscoverTargets', { discover: true }], ['Target.getTargets', {}], ['Target.exposeDevToolsProtocol', { targetId }],
      ['Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: '/tmp' }], ['Browser.getWindowForTarget', {}], ['Browser.close', {}],
      ['Storage.getCookies', {}], ['Storage.clearDataForOrigin', { origin: fx.origin, storageTypes: 'all' }], ['SystemInfo.getInfo', {}],
      ['Tracing.start', {}], ['IO.read', { handle: 'x' }], ['Target.attachToTarget', { targetId, flatten: true }],
    ] as const;
    const session = [
      ['Page.setDownloadBehavior', { behavior: 'allow', downloadPath: '/tmp' }], ['Network.getAllCookies', {}], ['Network.getCookies', {}],
      ['Network.setCookie', { name: 'a', value: 'b', url: fx.origin }], ['Storage.getCookies', {}], ['Browser.getVersion', {}],
      ['Target.createTarget', { url: 'about:blank' }], ['Target.attachToBrowserTarget', {}], ['DOM.setFileInputFiles', { files: ['/etc/hosts'] }],
      ['Runtime.addBinding', { name: 'x' }], ['Page.printToPDF', {}], ['Fetch.enable', { patterns: [{ urlPattern: '*' }] }],
      ['Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: false }], ['Network.setUserAgentOverride', { userAgent: 'x' }],
    ] as const;
    const results: Record<string, string> = {};
    for (const [m, p] of root) {
      const r = await eng.tryCall(m, p as Record<string, unknown>);
      assert.equal(r.ok, false, `root ${m} must be denied`);
      results[`root ${m}`] = r.error!;
    }
    for (const [m, p] of session) {
      const r = await eng.tryCall(m, p as Record<string, unknown>, sid);
      assert.equal(r.ok, false, `session ${m} must be denied`);
      results[`session ${m}`] = r.error!;
    }
    const denied = h.log.lines.filter((l) => l.includes('"vault.cdp_denied"'));
    assert.ok(denied.length >= root.length + session.length);
    for (const l of denied) assert.doesNotMatch(l, /downloadPath|\/tmp|etc\/hosts/, '거부 이벤트에 인자를 남기지 않는다');
    measurements.denied = results;
    // 알 수 없는 세션
    assert.equal((await eng.tryCall('Runtime.evaluate', { expression: '1' }, 'BOGUS')).ok, false);
  });

  it('사용자가 연 탭은 엔진에 노출하지 않고, 노출 페이지의 팝업은 노출한다', async () => {
    const before = eng.events.filter((e) => e.method === 'Target.attachedToTarget' && !e.sessionId).length;
    // 사용자 탭 대역: 금고 파이프로 직접 새 탭을 연다.
    await h.vault.relay!.send('Target.createTarget', { url: `${fx.origin}/login` });
    await sleep(500);
    assert.equal(eng.events.filter((e) => e.method === 'Target.attachedToTarget' && !e.sessionId).length, before, '사용자 탭 비노출');
    assert.ok(h.log.lines.some((l) => l.includes('vault.user_tab_hidden')));

    await eng.navigate(sid, `${fx.origin}/popup`);
    // 팝업 목적지는 부착 때 비어 있어(실측) 금고가 첫 문서 커밋의 origin을 본 뒤 노출한다.
    await eng.evaluate(sid, `document.getElementById('open').click()`);
    const ev = await eng.waitEvent((e) => e.method === 'Target.attachedToTarget' && !e.sessionId && (e.params!.targetInfo as { targetId: string }).targetId !== targetId);
    const popupSid = String(ev.params!.sessionId);
    assert.equal(new URL(String((ev.params!.targetInfo as { url: string }).url)).pathname, '/login');
    await eng.send('Runtime.runIfWaitingForDebugger', {}, popupSid);
    assert.ok(popupSid);
  });

  it('허용 밖 origin: Page.navigate 거부, 링크 이동 시 엔진 세션 분리(origin 재집행)', async () => {
    const nav = await eng.tryCall('Page.navigate', { url: 'https://example.com/' }, sid);
    assert.equal(nav.ok, false);
    assert.match(nav.error!, /origin_not_allowed/);
    // 별도 노출 페이지(팝업)에서 링크로 나간다 — 'localhost'는 테스트 허용 목록(127.0.0.1) 밖이다.
    const popupEv = eng.events.find((e) => e.method === 'Target.attachedToTarget' && !e.sessionId && (e.params!.targetInfo as { targetId: string }).targetId !== targetId)!;
    const popupSid = String(popupEv.params!.sessionId);
    await eng.send('Page.enable', {}, popupSid);
    const port = new URL(fx.origin).port;
    await eng.navigate(popupSid, `${fx.origin}/away?to=${encodeURIComponent(`http://localhost:${port}/login`)}`);
    const mark = eng.events.length;
    await eng.evaluate(popupSid, `document.getElementById('out').click()`);
    await eng.waitEvent((e) => e.method === 'Target.detachedFromTarget' && e.params?.sessionId === popupSid, mark);
    assert.ok(h.log.lines.some((l) => l.includes('vault.origin_left')));
    assert.equal((await eng.tryCall('Runtime.evaluate', { expression: '1' }, popupSid)).ok, false);
    const leaked = eng.events.slice(mark).filter((e) => e.method === 'Page.frameNavigated' && new URL(String((e.params!.frame as { url: string }).url)).hostname === 'localhost');
    assert.equal(leaked.length, 0, '허용 밖 문서 커밋 이벤트를 엔진에 넘기지 않는다');
  });

  it('타이피스트: 금고가 입력하고 엔진은 요청 바디·AX·DOMSnapshot·describeNode·Runtime에서 값을 받지 못한다(S6c·S6d)', async () => {
    const secret = testSecret('TEST-CERT');
    secrets.push(secret);
    await h.control.rpc('run.begin', { runId: 'r1', trigger: 'local' });
    await eng.navigate(sid, `${fx.origin}/login`);
    await eng.evaluate(sid, `document.getElementById('pw').focus()`);
    // 값이 없으면 금고가 secret.needed로 1회용 입력 창을 부르고, 그 결속으로 받은 값을 넣는다(ADR-025 결정 10).
    const fill = { runId: 'r1', targetId, frame: 'main', element: '#pw', secret: { kind: 'portal_password', scope: 'personal' }, slot: { secretKind: 'portal_password', purpose: 'login' } };
    const needed = h.control.once('secret.needed', (d) => d.runId === 'r1');
    assert.deepEqual(await h.client.rpc('typist.fill', fill), { ok: false, reason: 'secret_missing' });
    await needed;
    await h.provide({ runId: 'r1', kind: 'portal_password', scope: 'personal' }, secret);
    const closed = h.client.once('secret_window.closed', (d) => d.targetId === targetId);
    const r = await h.client.rpc<{ ok: boolean; reason?: string }>('typist.fill', fill);
    assert.deepEqual(r, { ok: true });
    await closed;

    // S6d: 금고 자신의 세션(정리 전)에서 값이 실리는 필드를 측정한다.
    const t = h.vault.relay!.targets.get(targetId)!;
    const vs = t.vaultSession;
    const relay = h.vault.relay!;
    const rawAx = JSON.stringify(await relay.send('Accessibility.getFullAXTree', {}, vs));
    const rawSnap = JSON.stringify(await relay.send('DOMSnapshot.captureSnapshot', { computedStyles: [] }, vs));
    const { root } = await relay.send<{ root: { nodeId: number } }>('DOM.getDocument', { depth: -1 }, vs);
    const { nodeId } = await relay.send<{ nodeId: number }>('DOM.querySelector', { nodeId: root.nodeId, selector: '#pw' }, vs);
    const rawDescribe = JSON.stringify(await relay.send('DOM.describeNode', { nodeId, depth: -1 }, vs));
    measurements.s6d_raw = {
      'Accessibility.getFullAXTree': rawAx.includes(secret),
      'DOMSnapshot.captureSnapshot': rawSnap.includes(secret),
      'DOM.describeNode': rawDescribe.includes(secret),
      'AX value of password (masked?)': /"value":\{"type":"string","value":"(•+)"/.exec(rawAx)?.[1]?.length ?? null,
    };

    // 엔진 경로(중계 정리 후)
    const ax = JSON.stringify(await eng.send('Accessibility.getFullAXTree', {}, sid));
    const snap = JSON.stringify(await eng.send('DOMSnapshot.captureSnapshot', { computedStyles: [] }, sid));
    const doc = await eng.send<{ root: { nodeId: number } }>('DOM.getDocument', { depth: -1 }, sid);
    const q = await eng.send<{ nodeId: number }>('DOM.querySelector', { nodeId: doc.root.nodeId, selector: '#pw' }, sid);
    const desc = JSON.stringify(await eng.send('DOM.describeNode', { nodeId: q.nodeId }, sid));
    for (const [name, txt] of [['ax', ax], ['snap', snap], ['desc', desc]] as const) assert.ok(!txt.includes(secret), `${name} must not include secret`);
    // AX는 password 값을 같은 길이의 마스킹 문자로 싣는다(길이 노출) — 중계가 value를 지웠는지 확인
    assert.doesNotMatch(ax, /"value":"•+"/, 'AX 마스킹 값(길이)도 엔진에 넘기지 않는다');

    // 오염 상태: 값 접근 패턴 거부(시도), 스크린샷 거부
    const ev1 = await eng.tryCall('Runtime.evaluate', { expression: `document.getElementById('pw').value` }, sid);
    assert.equal(ev1.ok, false);
    assert.equal((await eng.tryCall('Page.captureScreenshot', {}, sid)).ok, false);
    // 우회 표현식(정직 문구: 패턴 차단은 경계가 아니다) — 결과는 알려진 값 지우기로 정리되는지 확인
    const sneaky = await eng.evaluate(sid, `document.getElementById('pw')['val'+'ue']`);
    measurements.taint_bypass_result = sneaky === secret ? 'LEAKED' : String(sneaky);
    assert.notEqual(sneaky, secret);

    // 제출: 메인 프레임 폼 POST + 워커 fetch POST
    await userEval(h, targetId, `document.getElementById('pw').dispatchEvent(new Event('change'))`);
    const mark = eng.events.length;
    await eng.evaluate(sid, `document.getElementById('go').click()`);
    await eng.waitEvent((e) => e.method === 'Page.loadEventFired' && e.sessionId === sid, mark);
    await sleep(300);
    assert.ok(fx.bodies.some((b) => b.includes(encodeURIComponent(secret))), '포털(픽스처)은 실제로 비밀을 받았다');
    const posts = eng.events.slice(mark).filter((e) => e.method === 'Network.requestWillBeSent' && (e.params!.request as { method: string }).method === 'POST');
    assert.ok(posts.length >= 1);
    for (const p of posts) assert.equal((p.params!.request as Record<string, unknown>).postData, undefined);
    measurements.s6c = { postRequestsSeenByEngine: posts.length, withBody: posts.filter((p) => (p.params!.request as Record<string, unknown>).hasPostData).length };
    // 오염 요청의 바디 조회 거부(커밋 이후에도)
    for (const p of posts) assert.equal((await eng.tryCall('Network.getRequestPostData', { requestId: p.params!.requestId }, sid)).ok, false);
  });

  it('human:secret 활성 창: 엔진 Runtime·Input·AX·스크린샷 거부, 콘솔 이벤트 비전달, blur 후 종료(S6f)', async () => {
    const secret = testSecret('TEST-PORTAL');
    secrets.push(secret);
    await eng.navigate(sid, `${fx.origin}/login`);
    const open = await h.client.rpc<{ ok: boolean }>('secretWindow.openForHuman', { runId: 'r1', targetId, frame: 'main', element: '#pw' });
    if (!open.ok) for (const f of ['Preferences', 'Secure Preferences']) console.log('DIAG pref', f, JSON.stringify(((JSON.parse(await (await import('node:fs/promises')).readFile(path.join(h.paths.chromeProfile, 'Default', f), 'utf8').catch(() => '{}')) as { extensions?: { settings?: Record<string, unknown> } }).extensions?.settings ?? {}), (k, v) => (k === 'manifest' ? { name: (v as { name?: string }).name, version: (v as { version?: string }).version } : v)).replace(/"fignf[^]*?"location":5,"manifest":\{[^}]*\}/, '').slice(0, 3000));
    if (!open.ok) console.log('DIAG S6f', JSON.stringify(h.log.lines.filter((l) => /refused|mismatch|extension|signin/.test(l))), JSON.stringify(await import('@sax/vault').then(async (v) => ({ prefs: await (v as unknown as { verifyProfileSettings?: (d: string) => Promise<string[]> }).verifyProfileSettings?.(h.paths.chromeProfile), ext: await (v as unknown as { listInstalledExtensions?: (d: string) => Promise<string[]> }).listInstalledExtensions?.(h.paths.chromeProfile) })).catch((e) => String(e))));
    assert.deepEqual(open, { ok: true });
    const mark = eng.events.length;
    const activeDenied: Record<string, boolean> = {};
    for (const [m, p] of [
      ['Runtime.evaluate', { expression: '1+1' }], ['Runtime.callFunctionOn', { functionDeclaration: 'function(){}', executionContextId: 1 }],
      ['Input.dispatchMouseEvent', { type: 'mouseMoved', x: 1, y: 1 }], ['DOM.focus', { backendNodeId: 1 }], ['Accessibility.getFullAXTree', {}],
      ['DOMSnapshot.captureSnapshot', { computedStyles: [] }], ['Page.captureScreenshot', {}], ['Emulation.setFocusEmulationEnabled', { enabled: true }],
    ] as const) {
      activeDenied[m] = !(await eng.tryCall(m, p as Record<string, unknown>, sid)).ok;
      assert.ok(activeDenied[m], `${m} denied while active`);
    }
    assert.equal((await eng.tryCall('Target.activateTarget', { targetId })).ok, false);
    // 사용자가 직접 입력(키보드 대역), 페이지가 콘솔에 찍어도 엔진에는 가지 않는다.
    await userEval(h, targetId, `document.getElementById('pw').focus()`);
    await userType(h, targetId, secret);
    await userEval(h, targetId, `console.log('typed', document.getElementById('pw').value)`);
    const closed = h.client.once('secret_window.closed', (d) => d.targetId === targetId, 5000);
    await userEval(h, targetId, `document.getElementById('note').focus()`); // blur
    await closed;
    const during = eng.events.slice(mark).map((e) => e.method);
    assert.ok(!during.includes('Runtime.consoleAPICalled'), '활성 창 동안 콘솔 이벤트 비전달');
    measurements.s6f = { activeDenied, eventsDuringActive: [...new Set(during)] };
    // 오염 상태: 입력 허용(로그인 버튼 클릭 가능, 교착 없음)
    const box = await eng.evaluate(sid, `JSON.stringify(document.getElementById('go').getBoundingClientRect())`);
    const { x, y } = JSON.parse(String(box)) as { x: number; y: number };
    const mark2 = eng.events.length;
    assert.equal((await eng.tryCall('Input.dispatchMouseEvent', { type: 'mousePressed', x: x + 3, y: y + 3, button: 'left', clickCount: 1 }, sid)).ok, true);
    await eng.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: x + 3, y: y + 3, button: 'left', clickCount: 1 }, sid);
    await eng.waitEvent((e) => e.method === 'Page.loadEventFired' && e.sessionId === sid, mark2);
    assert.ok(fx.bodies.some((b) => b.includes(encodeURIComponent(secret))));
  });

  it('SPA 로그인(문서 커밋 없음): 활성 창 종료 후 엔진 클릭 가능, fetch 바디 제거', async () => {
    const secret = testSecret('TEST-SPA');
    secrets.push(secret);
    await eng.navigate(sid, `${fx.origin}/spa`);
    assert.deepEqual(await h.client.rpc('secretWindow.openForHuman', { runId: 'r1', targetId, frame: 'main', element: '#pw' }), { ok: true });
    await userEval(h, targetId, `document.getElementById('pw').focus()`);
    await userType(h, targetId, secret);
    // (라) 엔진 종료 요청: 포커스가 남아 있으면 거부
    assert.deepEqual(await h.client.rpc('secretWindow.requestClose', { runId: 'r1', targetId }), { ok: false });
    // 종료 조건 (나)는 blur + 값 있음이 1.5초 이어질 때(N-47)
    const closed = h.client.once('secret_window.closed', (d) => d.targetId === targetId, 5000);
    await userEval(h, targetId, `document.activeElement.blur()`);
    await closed;
    assert.equal(h.vault.relay!.targets.get(targetId)!.win?.phase, 'tainted');
    const mark = eng.events.length;
    await eng.evaluate(sid, `document.getElementById('go').click()`);
    await eng.waitEvent((e) => e.method === 'Network.loadingFinished' && e.sessionId === sid, mark);
    await sleep(200);
    assert.equal(await eng.evaluate(sid, `!!document.getElementById('ok')`), true, '교착 없음');
    const post = eng.events.slice(mark).find((e) => e.method === 'Network.requestWillBeSent' && String((e.params!.request as { url: string }).url).endsWith('/api/login'));
    assert.ok(post);
    assert.equal((post!.params!.request as Record<string, unknown>).postData, undefined);
    assert.ok(fx.bodies.some((b) => b.includes(secret)));
  });

  it('getDbKeyOnce는 기동당 1회', async () => {
    const k = await h.client.rpc<Uint8Array>('getDbKeyOnce');
    assert.equal(k.length, 32);
    await assert.rejects(h.client.rpc('getDbKeyOnce'), /denied/);
    assert.ok(h.log.lines.some((l) => l.includes('vault.dbkey_requested_twice')));
  });

  it('누출 스캐너: 엔진 IPC·로그·전용 프로필 디스크에서 비밀 0건', async () => {
    assert.ok(secrets.length >= 3);
    const ipc = h.capture.scan(secrets);
    const logs = await scanDir(h.paths.logs, secrets);
    await h.vault.shutdown();
    const profile = await scanDir(h.paths.chromeProfile, secrets);
    // 앱 루트 전체(logs·staging·chrome-profile·db 등, N-17)
    const all = await scanDir(h.paths.root, secrets);
    const report = {
      secrets: secrets.length,
      variantsPerSecret: variantsOf(secrets[0]!).map((v) => v.name),
      ipcMessages: h.capture.size,
      ipcBySource: h.capture.bySource(),
      ipcFindings: ipc,
      logFiles: logs.files,
      logFindings: logs.findings,
      profileFiles: profile.files,
      profileSkipped: profile.skipped,
      profileFindings: profile.findings,
      rootFiles: all.files,
      rootFindings: all.findings,
    };
    measurements.leakScan = report;
    assert.deepEqual(ipc, []);
    assert.deepEqual(logs.findings, []);
    assert.deepEqual(profile.findings, []);
    assert.deepEqual(all.findings, []);
  });
});

describe('vault relay: 팝업·자식 프레임 origin 재집행(PR #1 리뷰)', () => {
  // 이 묶음은 localhost도 허용한다(127.0.0.1과 다른 site라 OOPIF가 된다). 허용 밖은 *.localhost(http)·data:.
  let fx: Fixture;
  let h: Harness;
  let eng: RawEngine;
  let sid: string;
  let port: string;
  const rootAttaches = () => eng.events.filter((e) => e.method === 'Target.attachedToTarget' && !e.sessionId);

  before(async () => {
    fx = await startFixture();
    h = await startHarness({ policy: testPolicy({ allowedHosts: ['127.0.0.1', 'localhost'] }) });
    eng = new RawEngine(h.client);
    await h.client.rpc('browser.launch');
    ({ sessionId: sid } = await eng.attachRunPage());
    port = new URL(fx.origin).port;
    await eng.navigate(sid, `${fx.origin}/login`);
  });

  after(async () => {
    await h.close();
    await fx.close();
  });

  it('허용 밖 host로 열린 팝업은 엔진에 노출하지 않는다', async () => {
    const before = rootAttaches().length;
    await eng.evaluate(sid, `window.open('http://evil.localhost:${port}/login') && 1`);
    await sleep(2000);
    assert.equal(rootAttaches().length, before, '허용 밖 팝업은 부착 이벤트가 없다');
    assert.ok(h.log.lines.some((l) => l.includes('vault.popup_hidden')));
    // 허용 origin 팝업은 그대로 노출된다
    await eng.evaluate(sid, `window.open('http://localhost:${port}/login') && 1`);
    const ev = await eng.waitEvent((e) => e.method === 'Target.attachedToTarget' && !e.sessionId, before);
    assert.equal(new URL(String((ev.params!.targetInfo as { url: string }).url)).hostname, 'localhost');
  });

  it('허용 밖 iframe은 부착되지 않고, 허용 iframe이 허용 밖으로 이동하면 그 자식만 분리된다', async () => {
    const mark = eng.events.length;
    await eng.evaluate(sid, `document.body.insertAdjacentHTML('beforeend', '<iframe id=bad src="http://evil.localhost:${port}/child"></iframe><iframe id=ok src="http://localhost:${port}/child"></iframe>')`);
    const isIframeAttach = (e: { method?: string; sessionId?: string; params?: Record<string, unknown> }) =>
      e.method === 'Target.attachedToTarget' && e.sessionId === sid && (e.params!.targetInfo as { type: string }).type === 'iframe';
    const childEv = await eng.waitEvent(isIframeAttach, mark);
    await sleep(1800);
    const childAttaches = eng.events.slice(mark).filter(isIframeAttach);
    assert.equal(childAttaches.length, 1, '허용 iframe(localhost)만 엔진에 부착');
    assert.equal(new URL(String((childEv.params!.targetInfo as { url: string }).url)).hostname, 'localhost');
    assert.ok(h.log.lines.some((l) => l.includes('vault.child_hidden')));
    const child = String(childEv.params!.sessionId);
    assert.equal(await eng.evaluate(child, '1+1'), 2);
    // 자식 문서가 허용 밖(data:)으로 이동: 같은 자식 프로세스에서 커밋된다
    const mark2 = eng.events.length;
    await eng.evaluate(child, `location.href = 'data:text/html,<p>x</p>'; 1`).catch(() => {});
    const det = await eng.waitEvent((e) => e.method === 'Target.detachedFromTarget' && e.params?.sessionId === child, mark2);
    assert.equal(det.sessionId, sid, '분리 이벤트는 부모 세션으로 온다');
    assert.ok(h.log.lines.some((l) => l.includes('vault.child_origin_left')));
    assert.equal((await eng.tryCall('Runtime.evaluate', { expression: '1' }, child)).ok, false, '분리된 자식 세션 명령 거부');
    const leaked = eng.events.slice(mark2).filter((e) => e.method === 'Page.frameNavigated' && String((e.params!.frame as { url: string }).url).startsWith('data:'));
    assert.equal(leaked.length, 0, '허용 밖 자식 커밋 이벤트를 엔진에 넘기지 않는다');
  });

  it('지연 이동으로 허용 밖 host에 닿는 팝업·iframe은 끝까지 노출되지 않는다(fail-closed)', async () => {
    const mark = eng.events.length;
    const attachesSince = () => eng.events.slice(mark).filter((e) => e.method === 'Target.attachedToTarget');
    await eng.evaluate(sid, `window.open('http://evil.localhost:${port}/slow?ms=3000') && 1`);
    await eng.evaluate(sid, `document.body.insertAdjacentHTML('beforeend', '<iframe id=slowbad src="http://evil.localhost:${port}/slow?ms=3000"></iframe>')`);
    await sleep(5000); // 응답 지연(3초)과 이전 폴백 시간(1.5초)을 모두 넘긴다
    assert.deepEqual(attachesSince().map((e) => (e.params!.targetInfo as { type: string; url: string }).url), [], '지연된 허용 밖 팝업·iframe 비노출');
    assert.ok(h.log.lines.some((l) => l.includes('vault.popup_hidden')));
    // 빈 팝업은 about:blank 커밋 + opener 허용 확인 뒤 노출되지만, 허용 밖으로 이동을 "시작"하면 커밋 전에 분리된다.
    const m2 = eng.events.length;
    await eng.evaluate(sid, `window.__w = window.open(''); 1`);
    const blank = await eng.waitEvent((e) => e.method === 'Target.attachedToTarget' && !e.sessionId, m2, 5000);
    assert.equal((blank.params!.targetInfo as { url: string }).url, 'about:blank');
    const blankSid = String(blank.params!.sessionId);
    await eng.send('Page.enable', {}, blankSid);
    await eng.evaluate(sid, `window.__w.location.href = 'http://evil.localhost:${port}/slow?ms=3000'; 1`);
    const started = Date.now();
    await eng.waitEvent((e) => e.method === 'Target.detachedFromTarget' && e.params?.sessionId === blankSid, m2, 2500);
    assert.ok(Date.now() - started < 2500, '응답(커밋) 전에 분리');
    assert.equal(eng.events.slice(m2).filter((e) => e.method === 'Page.frameNavigated' && e.sessionId === blankSid && String((e.params!.frame as { url: string }).url).includes('evil')).length, 0);
    // 허용 origin으로 늦게 커밋되는 팝업은 커밋 확인 뒤 노출된다
    const m3 = eng.events.length;
    await eng.evaluate(sid, `window.open('http://localhost:${port}/slow?ms=2500') && 1`);
    const ev = await eng.waitEvent((e) => e.method === 'Target.attachedToTarget' && !e.sessionId, m3, 8000);
    assert.equal(new URL(String((ev.params!.targetInfo as { url: string }).url)).pathname, '/slow');
  });

  it('허용 밖 host를 거쳐 허용 host로 리디렉션되는 팝업은 끝까지 비노출(영구 거부)', async () => {
    const mark = eng.events.length;
    const target = encodeURIComponent(`http://localhost:${port}/login`);
    await eng.evaluate(sid, `window.open('http://evil.localhost:${port}/redirect?to=${target}') && 1`); // 서버 302
    await eng.evaluate(sid, `window.open('http://evil.localhost:${port}/bounce?to=${target}') && 1`); // 커밋 후 스크립트 이동
    await sleep(3500);
    const attaches = eng.events.slice(mark).filter((e) => e.method === 'Target.attachedToTarget' && !e.sessionId);
    assert.deepEqual(attaches.map((e) => (e.params!.targetInfo as { url: string }).url), [], '리디렉션 뒤 허용 host에 와도 노출하지 않는다');
    // 두 팝업 모두 실제로 허용 host까지 갔는지 확인(시험이 헛돌지 않게)
    const landed = [...h.vault.relay!.targets.values()].filter((t) => t.revoked && t.url === `http://localhost:${port}/login`);
    assert.equal(landed.length, 2);
  });

  it('OOPIF의 문서 커밋은 부모 page를 끊지 않는다', async () => {
    const mark = eng.events.length;
    const leftBefore = h.log.lines.filter((l) => l.includes('vault.origin_left')).length;
    await eng.evaluate(sid, `document.body.insertAdjacentHTML('beforeend', '<iframe id=ok2 src="http://localhost:${port}/child"></iframe>')`);
    const childEv = await eng.waitEvent((e) => e.method === 'Target.attachedToTarget' && e.sessionId === sid && (e.params!.targetInfo as { type: string }).type === 'iframe', mark);
    const child = String(childEv.params!.sessionId);
    // 허용 범위 안의 자식 이동(같은 localhost) — 자식 세션 유지
    await eng.evaluate(child, `location.href = 'http://localhost:${port}/login'; 1`).catch(() => {});
    await eng.waitEvent((e) => e.method === 'Page.frameNavigated' && e.sessionId === child, mark);
    await sleep(300);
    assert.equal(await eng.evaluate(child, 'location.pathname'), '/login');
    assert.equal(await eng.evaluate(sid, 'location.pathname'), '/login', '부모 page 세션 유지');
    assert.ok(!eng.events.slice(mark).some((e) => e.method === 'Target.detachedFromTarget' && e.params?.sessionId === sid));
    assert.equal(h.log.lines.filter((l) => l.includes('vault.origin_left')).length, leftBefore, '부모에 originLeft 없음');
  });
});

describe('비밀 창 개시 조건 재검사·크래시 잔존물(감사 D V1·V2)', () => {
  let fx: Fixture;
  before(async () => {
    fx = await startFixture();
  });
  after(async () => {
    await fx.close();
  });

  it('google sign-in after launch blocks next openForHuman', async () => {
    const h = await startHarness();
    try {
      const eng = new RawEngine(h.client);
      await h.client.rpc('browser.launch');
      const { sessionId, targetId } = await eng.attachRunPage();
      assert.deepEqual(await h.vault.profileChecked(), [], '기동 점검은 통과');
      await h.control.rpc('run.begin', { runId: 'g1', trigger: 'local' });
      await eng.navigate(sessionId, `${fx.origin}/login`);
      // 기동 뒤 전용 Chrome에서 Google 로그인이 생겼다(hasGoogleSignin이 보는 표식)
      const prefsFile = path.join(h.paths.chromeProfile, 'Default', 'Preferences');
      const prefs = JSON.parse(await fs.readFile(prefsFile, 'utf8')) as Record<string, unknown>;
      await fs.writeFile(prefsFile, JSON.stringify({ ...prefs, account_info: [{ account_id: 'x', email: 'x@example.com' }] }));
      const refusedCtl = h.control.once('secret_window.refused', () => true, 3000);
      const refusedEng = h.client.once('secret_window.refused', () => true, 3000);
      assert.deepEqual(await h.client.rpc('secretWindow.openForHuman', { runId: 'g1', targetId, frame: 'main', element: '#pw' }), { ok: false, reason: 'secret_window_refused' });
      assert.deepEqual(await refusedCtl, { reason: 'google_signin_detected' });
      assert.deepEqual(await refusedEng, { reason: 'google_signin_detected' });
      assert.equal(h.vault.relay!.targets.get(targetId)!.win, undefined, '창을 열지 않았다');
    } finally {
      await h.close();
    }
  });

  it('crash-induced: Page.crash during secret window leaves no test secret in profile', async () => {
    const h = await startHarness();
    try {
      const secret = testSecret('TEST-CERT');
      const eng = new RawEngine(h.client);
      await h.client.rpc('browser.launch');
      const { sessionId, targetId } = await eng.attachRunPage();
      await h.vault.profileChecked();
      await h.control.rpc('run.begin', { runId: 'c1', trigger: 'local' });
      await eng.navigate(sessionId, `${fx.origin}/login`);
      assert.deepEqual(await h.client.rpc('secretWindow.openForHuman', { runId: 'c1', targetId, frame: 'main', element: '#pw' }), { ok: true });
      await userEval(h, targetId, `document.getElementById('pw').focus()`);
      await userType(h, targetId, secret);
      // 활성 창 중 렌더러 크래시(금고 세션에서 유도). 응답이 오지 않을 수 있다.
      const t = h.vault.relay!.targets.get(targetId)!;
      void h.vault.relay!.send('Page.crash', {}, t.vaultSession).catch(() => {});
      await eng.waitEvent((e) => e.method === 'Inspector.targetCrashed' && e.sessionId === sessionId, 0, 5000).catch(() => null);
      await sleep(1000);
      await h.vault.shutdown();
      const profile = await scanDir(h.paths.chromeProfile, [secret]);
      assert.deepEqual(profile.findings, []);
      for (const d of ['Crashpad', 'Crash Reports']) assert.equal(await fs.stat(path.join(h.paths.chromeProfile, d)).catch(() => null), null, `${d} 없음`);
      const root = await scanDir(h.paths.root, [secret]);
      assert.deepEqual(root.findings, []);
    } finally {
      await h.close();
    }
  });
});


describe('launch 전 전용 프로필 폴더 확인(D05 §3.1)', () => {
  const profileEvent = (h: Harness) => h.log.lines.map((l) => JSON.parse(l) as Record<string, unknown>).find((e) => e.code === 'vault.profile_dir_problem');

  it('프로필 자리에 파일·링크가 있으면 치우고 새 폴더로 기동한다', async () => {
    for (const kind of ['file', 'link'] as const) {
      const h = await startHarness();
      const outside = await fs.mkdtemp(path.join(path.dirname(h.paths.root), 'sax-outside-'));
      try {
        await fs.rm(h.paths.chromeProfile, { recursive: true });
        if (kind === 'file') await fs.writeFile(h.paths.chromeProfile, 'x');
        else await fs.symlink(outside, h.paths.chromeProfile, process.platform === 'win32' ? 'junction' : 'dir');
        await h.client.rpc('browser.launch');
        assert.ok(h.vault.chromePid, kind);
        assert.equal((await fs.lstat(h.paths.chromeProfile)).isDirectory(), true);
        const ev = profileEvent(h);
        assert.equal(ev?.problems, kind === 'file' ? 'not_dir' : 'reparse_point');
        assert.equal(ev?.reason, ev?.problems);
        assert.equal(ev?.ok, true);
        assert.match(String(ev?.setAside), /^chrome-profile\.untrusted-\d+-[0-9a-f]{6}$/);
        assert.deepEqual(await fs.readdir(outside), [], `${kind}: 링크 대상에 Chrome 프로필이 쓰이지 않는다`);
      } finally {
        await h.close();
        await fs.rm(outside, { recursive: true, force: true });
      }
    }
  });

  it('사용자 전용으로 만들 수 없으면 Chrome을 띄우지 않는다', async () => {
    const real = dirGuard();
    const notOwner = { ok: false, problems: ['not_owner' as const] };
    const isProfile = (d: string) => path.basename(d) === 'chrome-profile';
    const h = await startHarness({
      dirGuard: {
        checkPrivate: async (d) => (isProfile(d) ? notOwner : real.checkPrivate(d)),
        ensurePrivate: async (d) => (isProfile(d) ? notOwner : real.ensurePrivate(d)),
        excludeFromIndex: (d) => real.excludeFromIndex(d),
      },
    });
    try {
      await assert.rejects(h.client.rpc('browser.launch'), /chrome profile not private: not_owner/);
      assert.equal(h.vault.chromePid, undefined);
      assert.deepEqual(await h.control.rpc('status'), { launched: false, profileProblems: null });
      const ev = profileEvent(h);
      assert.deepEqual([ev?.ok, ev?.reason, ev?.setAside], [false, 'not_owner', undefined], '새 폴더도 맞지 않아 되돌리고 기동하지 않는다');
      assert.deepEqual((await fs.readdir(h.paths.root)).filter((n) => n.includes('.untrusted-')), []);
    } finally {
      await h.close();
    }
  });
});

describe('launch 동시 호출·중간 실패(PoC-1 §5.1 후속)', () => {
  it('기동 중에 또 오면 두 번째는 거부하고 Chrome은 하나만 띄운다', async () => {
    const h = await startHarness();
    try {
      const results = await Promise.allSettled([h.client.rpc('browser.launch'), h.client.rpc('browser.launch')]);
      assert.deepEqual(results.map((r) => r.status).sort(), ['fulfilled', 'rejected']);
      const rejected = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
      assert.match(String((rejected.reason as Error).message), /already launched/);
      assert.ok(h.vault.chromePid);
    } finally {
      await h.close();
    }
  });

  it('Chrome을 띄운 뒤 중계 준비가 실패하면 Chrome을 닫고, 다시 launch할 수 있다', async () => {
    const h = await startHarness();
    const original = Relay.prototype.createRunPage;
    try {
      Relay.prototype.createRunPage = async () => {
        throw new Error('injected createRunPage failure');
      };
      await assert.rejects(h.client.rpc('browser.launch'), /injected createRunPage failure/);
      assert.equal(h.vault.chromePid, undefined, '띄운 Chrome이 남지 않는다');
      assert.deepEqual(await h.control.rpc('status'), { launched: false, profileProblems: null });
      Relay.prototype.createRunPage = original;
      await h.client.rpc('browser.launch');
      assert.ok(h.vault.chromePid, '다시 launch는 already launched로 막히지 않는다');
    } finally {
      Relay.prototype.createRunPage = original;
      await h.close();
    }
  });

  it('응답 없는 Chrome에 붙는 중이면 상한에서 내리고 실패한다, 다시 launch할 수 있다', { timeout: 90_000 }, async () => {
    // 상한은 Chrome을 띄운 뒤부터 잰다. 정상 기동(다시 launch 포함)보다 넉넉하게 둔다(Windows 냉기동 고려).
    const limitMs = 15_000;
    const h = await startHarness({ launchTimeoutMs: limitMs });
    let stubEntered = false;
    type SelfCheck = (relay: Relay, targetId: string) => Promise<boolean>;
    const proto = Vault.prototype as unknown as { selfCheck: SelfCheck };
    const original = proto.selfCheck;
    try {
      // 파이프 응답을 기다리며 멈춘 Chrome 대역: 끝나지 않는 Promise를 평가한다. Chrome을 닫으면 대기 요청이 거부된다.
      proto.selfCheck = async (relay, targetId) => {
        stubEntered = true;
        const t = relay.targets.get(targetId)!;
        if (t.paused) await relay.send('Runtime.runIfWaitingForDebugger', {}, t.vaultSession);
        await relay.send('Runtime.evaluate', { expression: 'new Promise(() => {})', awaitPromise: true }, t.vaultSession);
        return true;
      };
      const started = Date.now();
      await assert.rejects(h.client.rpc('browser.launch'), /chrome launch timed out/);
      assert.ok(stubEntered, '멈춘 파이프 경로를 지났다(상한이 그 전에 터지지 않았다)');
      assert.ok(Date.now() - started < limitMs + 15_000, '상한 뒤 오래지 않아 끝난다');
      assert.equal(h.vault.chromePid, undefined, '멈춘 Chrome이 남지 않는다');
      proto.selfCheck = original;
      await h.client.rpc('browser.launch');
      assert.ok(h.vault.chromePid);
    } finally {
      proto.selfCheck = original;
      await h.close();
    }
  });

  it('금고가 Chrome을 내리면 엔진 CDP transport에 닫힘을 알린다', async () => {
    const h = await startHarness();
    try {
      await h.client.rpc('browser.launch');
      const t = h.client.cdpTransport();
      const closed = new Promise<string | undefined>((r) => (t.onclose = r));
      await h.client.rpc('browser.shutdown');
      const got = await Promise.race([closed, sleep(5000).then(() => 'no close within 5s')]);
      assert.equal(got, 'chrome closed', 'Playwright가 끊긴 줄 알아 다음 열기에서 새로 띄운다');
    } finally {
      await h.close();
    }
  });

  it('실행 트리거(run.begin)는 Chrome을 다시 띄워도 남고, 프로필 점검 결과는 새 기동마다 다시 한다', async () => {
    const h = await startHarness();
    try {
      await h.control.rpc('run.begin', { runId: 'r1', trigger: 'local' });
      await h.client.rpc('browser.launch');
      await h.vault.profileChecked();
      await h.client.rpc('browser.shutdown');
      assert.deepEqual(await h.control.rpc('status'), { launched: false, profileProblems: null }, '내린 뒤 앞 점검 결과가 남지 않는다');
      await h.client.rpc('browser.launch');
      assert.equal(h.vault.ops?.runTriggers.get('r1'), 'local');
      await h.control.rpc('run.end', { runId: 'r1' });
      assert.equal(h.vault.ops?.runTriggers.has('r1'), false);
    } finally {
      await h.close();
    }
  });

  it('내리는 중에 온 실행 트리거도 다시 띄운 Chrome에 남는다', async () => {
    const h = await startHarness();
    try {
      await h.client.rpc('browser.launch');
      const closing = h.vault.shutdown(); // Chrome이 닫히기를 기다리는 동안
      await h.control.rpc('run.begin', { runId: 'r2', trigger: 'local' });
      await closing;
      await h.client.rpc('browser.launch');
      assert.equal(h.vault.ops?.runTriggers.get('r2'), 'local', '버려질 ops에 들어가지 않는다');
    } finally {
      await h.close();
    }
  });

  it('Chrome 실행 파일을 띄우지 못하면 금고가 죽지 않고 거부한다', async () => {
    const dir = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'sax-spawn-'));
    try {
      await assert.rejects(launchChrome({ executable: path.join(dir, 'no-such-chrome'), profileDir: dir }), /ENOENT/);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('기동 준비 중에 내리기가 오면 Chrome을 띄우지 않는다', { timeout: 60_000 }, async () => {
    const real = dirGuard();
    let reachedProfile!: () => void;
    const atProfile = new Promise<void>((r) => (reachedProfile = r));
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    const h = await startHarness({
      dirGuard: {
        checkPrivate: async (d) => {
          if (path.basename(d) === 'chrome-profile') {
            reachedProfile();
            await held;
          }
          return real.checkPrivate(d);
        },
        ensurePrivate: (d) => real.ensurePrivate(d),
        excludeFromIndex: (d) => real.excludeFromIndex(d),
      },
    });
    try {
      const launching = h.client.rpc('browser.launch');
      await atProfile;
      await h.client.rpc('browser.shutdown');
      release();
      await assert.rejects(launching, /launch cancelled/);
      assert.equal(h.vault.chromePid, undefined);
      assert.deepEqual(await h.control.rpc('status'), { launched: false, profileProblems: null });
    } finally {
      release();
      await h.close();
    }
  });
});
