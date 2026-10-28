// PoC-4 금고 최소판: 허용 목록 중계·응답 정리·비밀 창·누출 스캐너 (D05 §3~§4, D13 S6·S6c·S6d·S6f).
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { scanDir, testSecret, variantsOf } from '@sax/vault';
import { startFixture, type Fixture } from './fixtures/server.ts';
import { startHarness, testPolicy, type Harness } from './harness.ts';
import { RawEngine, sleep } from './raw-engine.ts';

const REPORT_DIR = path.resolve(import.meta.dirname, '../reports/raw');

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
    await fs.mkdir(REPORT_DIR, { recursive: true });
    await fs.writeFile(path.join(REPORT_DIR, 'relay-measurements.json'), JSON.stringify(measurements, null, 2));
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
    await h.secretInput.rpc('secret.provide', { kind: 'cert_password', scope: 'p1', bytes: new TextEncoder().encode(secret) });
    await eng.navigate(sid, `${fx.origin}/login`);
    await eng.evaluate(sid, `document.getElementById('pw').focus()`);
    const closed = h.client.once('secret_window.closed', (d) => d.targetId === targetId);
    const r = await h.client.rpc<{ ok: boolean; reason?: string }>('typist.fill', { runId: 'r1', targetId, frame: 'main', element: '#pw', secret: { kind: 'cert_password', scope: 'p1' } });
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
    await userEval(h, targetId, `document.activeElement.blur()`);
    await sleep(400);
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
    };
    measurements.leakScan = report;
    assert.deepEqual(ipc, []);
    assert.deepEqual(logs.findings, []);
    assert.deepEqual(profile.findings, []);
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

