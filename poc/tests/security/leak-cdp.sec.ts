// M5-1 누출 스캐너 확장: 엔진이 받는 CDP 이벤트 스트림(D13 §6, D05 §3.4·§3.5, AUDIT-D D-11(N-17)·D-17(N-12)·D-33(N-51)).
// 1) 양성 대조: 합성 이벤트에 비밀을 인코딩 변형별로 넣으면 스캐너가 메서드 이름과 함께 잡는다(스캐너가 헛돌지 않는다).
// 2) 실브라우저: 금고 타이피스트가 비밀을 넣은 뒤, 포털 페이지 자신의 스크립트가 그 값을 콘솔·예외·제목·URL·DOM 속성·요청으로 흘려도
//    엔진이 받은 이벤트(허용 목록 중계 뒤)에는 비밀이 0건이다. 포털(픽스처)은 실제로 값을 받았는지 함께 확인한다.
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { testSecret, variantsOf } from '@sax/vault';
import { startFixture, type Fixture } from '../fixtures/server.ts';
import { startHarness, type Harness } from '../harness.ts';
import { RawEngine, sleep } from '../raw-engine.ts';
import { writeMeasure } from '../measure-out.ts';
import { CdpLeakTap } from './lib/cdp-leak.ts';

describe('M5-1 누출 스캐너: CDP 이벤트 양성 대조', () => {
  it('인코딩 변형마다 이벤트 종류 이름으로 잡는다', () => {
    const secret = testSecret('TEST-CDP');
    const enc = (name: string) => variantsOf(secret).find((v) => v.name === name)!.bytes.toString('utf8');
    const tap = new CdpLeakTap().addAll([
      { method: 'Runtime.consoleAPICalled', params: { args: [{ type: 'string', value: secret }] } },
      { method: 'Network.requestWillBeSent', params: { request: { url: `https://x/?q=${enc('url')}` } } },
      { method: 'Page.frameNavigated', params: { frame: { url: `https://x/#${enc('base64@0')}` } } },
      { method: 'DOM.attributeModified', params: { value: enc('hex') } },
      { method: 'Target.targetInfoChanged', params: { targetInfo: { title: 'ok' } } },
    ]);
    const hit = new Set(tap.scan([secret]).map((f) => f.source));
    assert.deepEqual([...hit].sort(), ['cdp:DOM.attributeModified', 'cdp:Network.requestWillBeSent', 'cdp:Page.frameNavigated', 'cdp:Runtime.consoleAPICalled']);
    for (const f of tap.scan([secret])) assert.ok(!f.secret.includes(secret), '보고에 비밀 원문이 없다');
  });
});

describe('M5-1 누출 스캐너: 실브라우저 CDP 이벤트(가짜 포털, 금고 중계 위)', () => {
  let fx: Fixture;
  let h: Harness;
  let eng: RawEngine;
  let sid: string;
  let targetId: string;
  const enabled: Record<string, boolean> = {};

  before(async () => {
    fx = await startFixture();
    h = await startHarness();
    eng = new RawEngine(h.client);
    await h.client.rpc('browser.launch');
    ({ sessionId: sid, targetId } = await eng.attachRunPage());
    await h.vault.profileChecked();
    // 엔진이 켤 수 있는 이벤트 도메인을 최대한 켠다(거부되면 그 도메인은 허용 목록 밖이라 이벤트도 없다).
    for (const [m, p] of [['Log.enable', {}], ['DOM.enable', {}], ['Page.setLifecycleEventsEnabled', { enabled: true }], ['Target.setDiscoverTargets', { discover: true }], ['Audits.enable', {}], ['Security.enable', {}], ['Fetch.enable', {}], ['Inspector.enable', {}]] as const) {
      enabled[m] = (await eng.tryCall(m, p as Record<string, never>, m === 'Target.setDiscoverTargets' ? undefined : sid)).ok;
    }
  });

  after(async () => {
    await h?.close();
    await fx?.close();
  });

  it('타이피스트 입력 뒤 포털 스크립트가 값을 흘려도 엔진 이벤트에 비밀 0건', async () => {
    const secret = testSecret('TEST-CDPLIVE');
    await h.control.rpc('run.begin', { runId: 'sec1', trigger: 'local' });
    await h.provide({ runId: 'sec1', kind: 'cert_password', scope: 'personal' }, secret);
    await eng.navigate(sid, `${fx.origin}/login`);
    await eng.evaluate(sid, `document.getElementById('pw').focus()`);
    const mark = eng.events.length;
    const closed = h.client.once('secret_window.closed', (d) => d.targetId === targetId);
    const r = await h.client.rpc<{ ok: boolean }>('typist.fill', { runId: 'sec1', targetId, frame: 'main', element: '#pw', secret: { kind: 'cert_password', scope: 'personal' }, slot: { secretKind: 'cert_password', purpose: 'login' } });
    assert.deepEqual(r, { ok: true });
    await closed;

    // 포털 페이지 자신의 스크립트(금고 감시 세션 = 페이지 안 동작 대역)가 값을 여러 통로로 흘린다.
    const t = h.vault.relay!.targets.get(targetId)!;
    await h.vault.relay!.send('Runtime.evaluate', {
      expression: `(() => { const v = document.getElementById('pw').value;
        console.log('echo', v); console.error(btoa(v));
        document.title = v; document.body.setAttribute('data-echo', v);
        history.replaceState(null, '', '?e=' + encodeURIComponent(v));
        fetch('/api/login', { method: 'POST', headers: { 'x-echo': v }, body: v });
        setTimeout(() => { throw new Error('leak ' + v); }, 0);
        return true; })()`,
      returnByValue: true,
    }, t.vaultSession);
    await sleep(800);
    assert.ok(fx.bodies.some((b) => b.includes(secret)), '포털(픽스처)은 실제로 비밀을 받았다(시험이 헛돌지 않음)');

    const tap = new CdpLeakTap().addAll(eng.events.slice(mark));
    const findings = tap.scan([secret]);
    await writeMeasure('security/leak-cdp.json', { enabled, methods: tap.methods(), findings });
    // 값을 흘린 통로의 이벤트가 엔진에 실제로 왔어야 0건이 의미가 있다(금고가 통로째 막는 것도 정답이라 2개 이상만 요구).
    const echo = ['Runtime.consoleAPICalled', 'Runtime.exceptionThrown', 'Page.navigatedWithinDocument', 'Network.requestWillBeSent'].filter((m) => tap.methods()[m]);
    assert.ok(echo.length >= 2, `값을 흘린 통로의 이벤트가 엔진에 거의 없다: ${JSON.stringify(tap.methods())}`);
    assert.deepEqual(findings, [], `엔진 CDP 이벤트에 비밀: ${JSON.stringify(findings)}`);
  });
});
