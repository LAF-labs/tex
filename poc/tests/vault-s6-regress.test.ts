// S6c~S6f 회귀(D13 §4, AUDIT-D 보강)와 누출 스캐너 확장(D11 §115, D13 §6). vault-relay.test.ts가 이미 보는 것은 다시 보지 않고 빈 곳만 채운다.
// - E-18: 워커·자식 프레임이 보낸 요청의 바디 — 포털은 받았고, 엔진이 받은 이벤트 어디에도 없다(CI 트랙 CdpLeakTap 재사용)
// - S6f: 활성 창 동안 엔진에 닿는 이벤트 목록에 ACTIVE_WINDOW_DROP_EVENTS가 없고, ACTIVE_WINDOW_DENY_PREFIXES 전부가 거부된다(상수 표 그대로)
// - S6d: 오염 상태 Runtime.getProperties(값 속성 지움)를 실브라우저로
// - 누출 스캐너: control 포트 IPC까지 담고, 장기 키 시드(D05 §5.1)·NPKI 개인키 파일 내용도 비밀 목록에 넣어 IPC·로그·앱 루트를 훑는다
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import {
  ACTIVE_WINDOW_DENY_PREFIXES, ACTIVE_WINDOW_DROP_EVENTS, CRYPTO_KEY_ITEMS, KNOWN_PREFIX_MAX_LEN, KNOWN_VALUE_MIN_LEN, knownValuePrefixVariants,
  knownValueVariants, PROFILE_RESIDUE_PATHS, removeCrashDumps, removeProfileResidue, RESIDUE_RM_ATTEMPTS, scanDir, scrubKnownValues, testSecret, type KeyStore, type NpkiListResult,
} from '@sax/vault';
import { startFixture, type Fixture } from './fixtures/server.ts';
import { startHarness, type Harness } from './harness.ts';
import { writeMeasure } from './measure-out.ts';
import { RawEngine, sleep } from './raw-engine.ts';
import { CdpLeakTap } from './security/lib/cdp-leak.ts';

const dirLink = process.platform === 'win32' ? 'junction' : 'dir';

async function userType(h: Harness, targetId: string, text: string): Promise<void> {
  const t = h.vault.relay!.targets.get(targetId)!;
  await h.vault.relay!.send('Input.insertText', { text }, t.vaultSession);
}
/** 포털 페이지 자신의 스크립트 대역(금고 감시 세션에서 돈다, 엔진 경로 아님). */
async function pageEval(h: Harness, targetId: string, expression: string): Promise<unknown> {
  const t = h.vault.relay!.targets.get(targetId)!;
  const r = await h.vault.relay!.send<{ result: { value?: unknown } }>('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, t.vaultSession);
  return r.result.value;
}
async function until(pred: () => boolean, ms = 8000): Promise<void> {
  const end = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > end) throw new Error('timeout');
    await sleep(50);
  }
}
/** 활성 창 거부 접두사마다 그 접두사로 시작하는 메서드 하나(접두사 자체가 메서드면 그것). */
const sampleFor = (p: string): [string, Record<string, unknown>] => (p.endsWith('.') ? [`${p}${p === 'Runtime.' ? 'evaluate' : p === 'Input.' ? 'dispatchKeyEvent' : p === 'Emulation.' ? 'setFocusEmulationEnabled' : p === 'Accessibility.' ? 'getFullAXTree' : 'getSnapshot'}`, {}] : [p, {}]);

describe('S6c~f 회귀·누출 스캐너 확장(금고 중계, 가짜 포털)', () => {
  let fx: Fixture;
  let h: Harness;
  let eng: RawEngine;
  let sid: string;
  let targetId: string;
  const secrets: string[] = [];
  const m: Record<string, unknown> = {};

  before(async () => {
    fx = await startFixture();
    h = await startHarness();
    eng = new RawEngine(h.client);
    await h.client.rpc('browser.launch');
    ({ sessionId: sid, targetId } = await eng.attachRunPage());
    await h.vault.profileChecked();
    await h.control.rpc('run.begin', { runId: 's6', trigger: 'local' });
  });

  after(async () => {
    await writeMeasure('s6-regress.json', m);
    await h.close();
    await fx.close();
  });

  it('E-18: 워커·자식 프레임이 보낸 POST 바디는 포털에 닿고 엔진이 받은 이벤트에는 없다', async () => {
    const secret = testSecret('TEST-E18');
    secrets.push(secret);
    await eng.navigate(sid, `${fx.origin}/login`);
    await eng.evaluate(sid, `document.getElementById('pw').focus()`);
    const fill = { runId: 's6', targetId, frame: 'main', element: '#pw', secret: { kind: 'portal_password', scope: 'personal' }, slot: { secretKind: 'portal_password', purpose: 'login' } };
    const needed = h.control.once('secret.needed', (d) => d.runId === 's6');
    assert.deepEqual(await h.client.rpc('typist.fill', fill), { ok: false, reason: 'secret_missing' });
    await needed;
    await h.provide({ runId: 's6', kind: 'portal_password', scope: 'personal' }, secret);
    const closed = h.client.once('secret_window.closed', (d) => d.targetId === targetId);
    assert.deepEqual(await h.client.rpc('typist.fill', fill), { ok: true });
    await closed;
    const mark = eng.events.length;
    // 포털 스크립트: 워커로 보내고(fetch), 같은 origin 자식 프레임 폼에 옮겨 제출한다
    await pageEval(h, targetId, `document.getElementById('pw').dispatchEvent(new Event('change'))`);
    await pageEval(h, targetId, `(() => { const d = document.getElementById('child').contentDocument; d.getElementById('cpw').value = document.getElementById('pw').value; d.querySelector('form').submit(); return true; })()`);
    await until(() => fx.bodies.some((b) => b === `w=${secret}`) && fx.bodies.some((b) => b === `cpw=${encodeURIComponent(secret)}`));
    await sleep(500);
    const evs = eng.events.slice(mark);
    const tap = new CdpLeakTap().addAll(evs);
    assert.deepEqual(tap.scan([secret]), [], '엔진이 받은 이벤트에 비밀 0건');
    const posts = evs.filter((e) => e.method === 'Network.requestWillBeSent' && /\/(worker-post|child-submit)$/.test(String((e.params?.request as { url?: string } | undefined)?.url)));
    for (const p of posts) {
      const req = p.params!.request as Record<string, unknown>;
      assert.equal(req.postData, undefined);
      assert.equal(req.postDataEntries, undefined);
      assert.equal((await eng.tryCall('Network.getRequestPostData', { requestId: p.params!.requestId }, p.sessionId)).ok, false);
    }
    m.e18 = { engineSawPosts: posts.map((p) => String((p.params!.request as { url: string }).url).replace(fx.origin, '')), sessions: [...new Set(posts.map((p) => p.sessionId === sid ? 'page' : p.sessionId ? 'child' : 'browser'))], methods: tap.methods() };
  });

  it('S6f: 타이피스트 입력 도중 페이지가 글자마다 값을 주소·제목으로 흘려도 엔진에는 6자 이상 접두사가 없다', async () => {
    const secret = testSecret('TEST-KEYS');
    secrets.push(secret);
    await h.control.rpc('run.begin', { runId: 's6k', trigger: 'local' });
    await eng.navigate(sid, `${fx.origin}/login`);
    await pageEval(h, targetId, `(() => { const pw = document.getElementById('pw'); pw.addEventListener('input', () => { history.replaceState(null, '', '#' + pw.value); document.title = pw.value; console.log(pw.value); }); return true; })()`);
    await eng.evaluate(sid, `document.getElementById('pw').focus()`);
    const fill = { runId: 's6k', targetId, frame: 'main', element: '#pw', secret: { kind: 'portal_password', scope: 'personal' }, slot: { secretKind: 'portal_password', purpose: 'login' } };
    const needed = h.control.once('secret.needed', (d) => d.runId === 's6k');
    assert.deepEqual(await h.client.rpc('typist.fill', fill), { ok: false, reason: 'secret_missing' });
    await needed;
    await h.provide({ runId: 's6k', kind: 'portal_password', scope: 'personal' }, secret);
    const mark = eng.events.length;
    const closed = h.client.once('secret_window.closed', (d) => d.targetId === targetId);
    assert.deepEqual(await h.client.rpc('typist.fill', fill), { ok: true });
    await closed;
    await sleep(300);
    assert.equal(await pageEval(h, targetId, `location.hash.slice(1)`), secret, '페이지는 실제로 값을 주소에 넣었다');
    const evs = eng.events.slice(mark);
    const prefixes = Array.from({ length: [...secret].length - 5 }, (_, i) => [...secret].slice(0, i + 6).join(''));
    const tap = new CdpLeakTap().addAll(evs);
    assert.deepEqual(tap.scan(prefixes), [], '6자 이상 접두사 0건');
    m.s6f_typist = { events: evs.length, methods: tap.methods() };
    secrets.push(...prefixes.slice(-1));
  });

  it('S6d: 오염 상태 Runtime.getProperties·DOM.resolveNode 경로로도 값이 나오지 않는다', async () => {
    const t = h.vault.relay!.targets.get(targetId)!;
    assert.equal(t.win?.phase, 'tainted');
    const secret = secrets[0]!;
    const r = await eng.tryCall('Runtime.evaluate', { expression: `document.getElementById('pw')` }, sid);
    const ev = r.ok ? await eng.send<{ result: { objectId?: string } }>('Runtime.evaluate', { expression: `document.getElementById('pw')` }, sid) : null;
    const tried: Record<string, string> = {};
    if (ev?.result.objectId) {
      for (const own of [true, false]) {
        const g = await eng.tryCall('Runtime.getProperties', { objectId: ev.result.objectId, ownProperties: own, accessorPropertiesOnly: false, generatePreview: true }, sid);
        if (!g.ok) tried[`getProperties own=${own}`] = 'denied';
        else {
          const res = JSON.stringify(await eng.send('Runtime.getProperties', { objectId: ev.result.objectId, ownProperties: own, generatePreview: true }, sid));
          assert.ok(!res.includes(secret), `getProperties own=${own}`);
          tried[`getProperties own=${own}`] = 'scrubbed';
        }
      }
    } else tried.evaluate = 'denied';
    const doc = await eng.send<{ root: { nodeId: number } }>('DOM.getDocument', { depth: 1 }, sid);
    const q = await eng.send<{ nodeId: number }>('DOM.querySelector', { nodeId: doc.root.nodeId, selector: '#pw' }, sid);
    const rn = await eng.tryCall('DOM.resolveNode', { nodeId: q.nodeId }, sid);
    if (rn.ok) {
      const { object } = await eng.send<{ object: { objectId: string } }>('DOM.resolveNode', { nodeId: q.nodeId }, sid);
      const g = await eng.tryCall('Runtime.getProperties', { objectId: object.objectId, ownProperties: false }, sid);
      if (g.ok) assert.ok(!JSON.stringify(await eng.send('Runtime.getProperties', { objectId: object.objectId, ownProperties: false }, sid)).includes(secret));
      tried.resolveNode = g.ok ? 'scrubbed' : 'getProperties denied';
    } else tried.resolveNode = 'denied';
    m.s6d_getProperties = tried;
  });

  it('S6f: 활성 창 동안 거부 접두사 전부 거부, 엔진이 받은 이벤트에 콘솔·바인딩 없음·비밀 없음', async () => {
    const secret = testSecret('TEST-S6F');
    secrets.push(secret);
    await eng.navigate(sid, `${fx.origin}/login`);
    assert.deepEqual(await h.client.rpc('secretWindow.openForHuman', { runId: 's6', targetId, frame: 'main', element: '#pw' }), { ok: true });
    const mark = eng.events.length;
    const denied: Record<string, boolean> = {};
    for (const p of ACTIVE_WINDOW_DENY_PREFIXES) {
      const [method, params] = sampleFor(p);
      denied[method] = !(await eng.tryCall(method, params, method.startsWith('Target.') ? undefined : sid)).ok;
      assert.ok(denied[method], `${method} 활성 창 동안 거부`);
    }
    await pageEval(h, targetId, `document.getElementById('pw').focus()`);
    await userType(h, targetId, secret);
    // 포털 스크립트가 값을 콘솔·제목·속성·주소로 흘린다
    await pageEval(h, targetId, `(() => { const v = document.getElementById('pw').value; console.log('typed', v); document.title = v; document.body.setAttribute('data-x', v); history.replaceState(null, '', '#' + v); return true; })()`);
    await sleep(300);
    const closed = h.client.once('secret_window.closed', (d) => d.targetId === targetId, 5000);
    await pageEval(h, targetId, `document.getElementById('note').focus()`);
    await closed;
    const during = eng.events.slice(mark);
    const methods = [...new Set(during.map((e) => e.method).filter(Boolean))].sort() as string[];
    for (const d of ACTIVE_WINDOW_DROP_EVENTS) assert.ok(!methods.includes(d), `${d} 비전달`);
    assert.deepEqual(new CdpLeakTap().addAll(during).scan([secret]), [], '활성 창 동안 엔진 이벤트에 비밀 0건');
    m.s6f = { denied, eventsDuringActive: methods };
  });

  it('누출 스캐너 확장: engine·control IPC, 로그, 앱 루트에서 시험 비밀·장기 키 시드·NPKI 개인키 내용 0건', async () => {
    // 장기 키를 만들고 쓴다(control 포트: 엔진 포트에는 crypto.*가 없다). 시드는 금고 KeyStore에만 있어야 한다.
    const pk = await h.control.rpc<{ vd: Uint8Array }>('crypto.publicKeys');
    assert.equal(pk.vd.length, 32);
    await h.control.rpc('crypto.signVd', { purpose: 'SAX-dpop-v1', msg: new Uint8Array([1, 2, 3]) });
    await h.control.rpc('crypto.signAik', { purpose: 'SAX-devlist-v1', msg: new Uint8Array([4, 5, 6]) });
    const ks = (h.vault as unknown as { opts: { keyStore: KeyStore } }).opts.keyStore;
    const seeds: Buffer[] = [];
    for (const name of Object.values(CRYPTO_KEY_ITEMS)) seeds.push(Buffer.from((await ks.get(name, 32))!));
    // NPKI: 개인키 파일 내용은 어디에도 나오지 않는다(열지 않으므로)
    const npkiRoot = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'sax-s6-npki-'));
    const keySentinel = testSecret('TEST-NPKI-KEY');
    const dir = path.join(npkiRoot, 'yessign', 'USER', 'cn=TEST');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'signCert.der'), Buffer.from([0x30, 0x03, 0x02, 0x01, 0x01]));
    await fs.writeFile(path.join(dir, 'signPri.key'), keySentinel);
    (h.vault as unknown as { opts: { npki?: unknown } }).opts.npki = { roots: [{ kind: 'home', dir: npkiRoot }] };
    const listed = await h.control.rpc<NpkiListResult>('npki.list', {});
    assert.equal(listed.certs.length, 1);

    const strSecrets = [...secrets, keySentinel, ...seeds.flatMap((s) => [s.toString('hex'), s.toString('base64')])];
    const ipc = h.capture.scan(strSecrets);
    const sources = h.capture.bySource();
    assert.ok(Object.keys(sources).some((s) => s.startsWith('ipc.control.')), 'control 포트도 담는다');
    const logs = await scanDir(h.paths.logs, strSecrets);
    await h.vault.shutdown();
    const all = await scanDir(h.paths.root, strSecrets);
    // 이진 파일에 시드 원시 바이트가 있는지도 본다
    const rawHits: string[] = [];
    const walk = async (d: string): Promise<void> => {
      for (const e of await fs.readdir(d, { withFileTypes: true }).catch(() => [])) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) await walk(p);
        else if (e.isFile()) {
          const buf = await fs.readFile(p).catch(() => null);
          if (buf && seeds.some((s) => buf.includes(s))) rawHits.push(path.relative(h.paths.root, p));
        }
      }
    };
    await walk(h.paths.root);
    m.leak = { secrets: strSecrets.length, ipcMessages: h.capture.size, ipcBySource: sources, logFiles: logs.files, rootFiles: all.files, rootSkipped: all.skipped };
    assert.deepEqual(ipc, []);
    assert.deepEqual(logs.findings, []);
    assert.deepEqual(all.findings, []);
    assert.deepEqual(rawHits, [], '시드 원시 바이트 0건');
    await fs.rm(npkiRoot, { recursive: true, force: true });
  });
});

describe('알려진 값 접두사·프로필 잔존물(단위)', () => {
  it('접두사 변형: 6자 이상 접두사마다 변형, 64자 넘으면 전체 값만, 긴 것부터 지우면 전체 값이 한 번에 지워진다', () => {
    const v = knownValuePrefixVariants('abcdefgh');
    for (const p of ['abcdef', 'abcdefg', 'abcdefgh']) for (const x of knownValueVariants(p)) assert.ok(v.includes(x), x);
    assert.ok(!v.includes('abcde'), `${KNOWN_VALUE_MIN_LEN}자 미만 없음`);
    assert.deepEqual(knownValuePrefixVariants('a'.repeat(KNOWN_PREFIX_MAX_LEN + 1)), knownValueVariants('a'.repeat(KNOWN_PREFIX_MAX_LEN + 1)));
    assert.deepEqual(knownValuePrefixVariants('abc'), []);
    // 한글(코드 포인트 기준)
    assert.ok(knownValuePrefixVariants('가나다라마바사').includes('가나다라마바'));
    const sorted = [...v].sort((a, b) => b.length - a.length);
    let text = JSON.stringify({ url: 'https://x/#abcdefgh', title: 'abcdefg' });
    for (const x of sorted) text = scrubKnownValues(text, [x]).text;
    assert.equal(text, JSON.stringify({ url: 'https://x/#[vault-redacted]', title: '[vault-redacted]' }));
  });

  it('removeProfileResidue·removeCrashDumps: 잠금(EBUSY·EPERM)은 다시 시도하고, 끝내 잠긴 경로만 건너뛰고 나머지는 지운다, 실패 수를 알린다', async () => {
    const dir = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'sax-residue-busy-'));
    try {
      const make = async () => {
        for (const rel of ['Default/History', 'Default/Visited Links', 'Default/Favicons']) {
          await fs.mkdir(path.join(dir, 'Default'), { recursive: true });
          await fs.writeFile(path.join(dir, ...rel.split('/')), 'x');
        }
      };
      const busy = (code: string) => Object.assign(new Error(code), { code });
      // History: 두 번 EBUSY 뒤 지워진다(Windows 자식 프로세스가 곧 놓는 경우)
      await make();
      let tries = 0;
      const failed: number[] = [];
      const flaky = async (p: string, o: { recursive: true; force: true }) => {
        if (p.endsWith('History') && tries++ < 2) throw busy('EBUSY');
        await fs.rm(p, o);
      };
      assert.equal(await removeProfileResidue(dir, { rm: flaky, retryDelayMs: 0, onFailed: (n) => failed.push(n) }), 3);
      assert.equal(tries, 3);
      assert.deepEqual(failed, []);
      // Visited Links: 늘 EPERM → 그 경로만 남고 Favicons는 지워진다(예전에는 첫 실패에서 멈췄다), 실패 1을 알린다
      await make();
      let calls = 0;
      const stuck = async (p: string, o: { recursive: true; force: true }) => {
        if (p.endsWith('Visited Links')) {
          calls++;
          throw busy('EPERM');
        }
        await fs.rm(p, o);
      };
      assert.equal(await removeProfileResidue(dir, { rm: stuck, retryDelayMs: 0, onFailed: (n) => failed.push(n) }), 2);
      assert.equal(calls, RESIDUE_RM_ATTEMPTS);
      assert.deepEqual(failed, [1]);
      assert.ok(await fs.lstat(path.join(dir, 'Default', 'Visited Links')));
      assert.equal(await fs.lstat(path.join(dir, 'Default', 'Favicons')).catch(() => null), null);
      // 잠금이 아닌 오류는 다시 시도하지 않는다
      let other = 0;
      await removeProfileResidue(dir, { rm: async () => { other++; throw busy('EIO'); }, retryDelayMs: 0 });
      assert.equal(other, 1, 'Visited Links 한 번만');
      // 크래시 덤프도 같다
      await fs.mkdir(path.join(dir, 'Crashpad', 'reports'), { recursive: true });
      await fs.writeFile(path.join(dir, 'Crashpad', 'reports', 'a.dmp'), 'x');
      let d = 0;
      assert.equal(await removeCrashDumps(dir, { rm: async (p, o) => { if (d++ < 1) throw busy('EBUSY'); await fs.rm(p, o); }, retryDelayMs: 0 }), 1);
      assert.equal(await fs.lstat(path.join(dir, 'Crashpad')).catch(() => null), null);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('removeProfileResidue: 탐색 기록·세션 복원·UKM만 지우고 쿠키·Local Storage·Preferences는 남긴다, 링크면 -1', async () => {
    const dir = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'sax-residue-'));
    try {
      for (const rel of PROFILE_RESIDUE_PATHS) {
        const p = path.join(dir, ...rel.split('/'));
        await fs.mkdir(path.dirname(p), { recursive: true });
        if (rel.endsWith('Sessions') || rel === 'segmentation_platform') {
          await fs.mkdir(p, { recursive: true });
          await fs.writeFile(path.join(p, 'Session_1'), 'x');
        } else await fs.writeFile(p, 'x');
      }
      for (const keep of ['Default/Cookies', 'Default/Preferences', 'Local State']) await fs.writeFile(path.join(dir, ...keep.split('/')), 'k');
      await fs.mkdir(path.join(dir, 'Default', 'Local Storage'), { recursive: true });
      assert.equal(await removeProfileResidue(dir), PROFILE_RESIDUE_PATHS.length);
      for (const rel of PROFILE_RESIDUE_PATHS) assert.equal(await fs.lstat(path.join(dir, ...rel.split('/'))).catch(() => null), null, rel);
      for (const keep of ['Default/Cookies', 'Default/Preferences', 'Local State', 'Default/Local Storage']) assert.ok(await fs.lstat(path.join(dir, ...keep.split('/'))), keep);
      assert.equal(await removeProfileResidue(dir), 0);
      // 링크: 너머를 지우지 않는다
      const outside = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'sax-residue-out-'));
      await fs.writeFile(path.join(outside, 'Session_9'), 'keep');
      // Windows는 개발자 모드·관리자가 아니면 심볼릭 링크를 만들 수 없다(EPERM). 디렉터리 링크는 정션으로 만든다(재분석 지점이라 lstat에서 링크로 보인다).
      await fs.symlink(outside, path.join(dir, 'Default', 'Sessions'), dirLink);
      assert.equal(await removeProfileResidue(dir), -1);
      assert.equal(await fs.readFile(path.join(outside, 'Session_9'), 'utf8'), 'keep');
      await fs.rm(path.join(dir, 'Default', 'Sessions'));
      await fs.rename(path.join(dir, 'Default'), path.join(dir, 'D2'));
      await fs.symlink(outside, path.join(dir, 'Default'), dirLink);
      assert.equal(await removeProfileResidue(dir), -1, 'Default 자체가 링크');
      assert.equal(await fs.readFile(path.join(outside, 'Session_9'), 'utf8'), 'keep');
      await fs.rm(outside, { recursive: true, force: true });
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
