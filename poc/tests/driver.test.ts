// M2-4 D Playwright 드라이버: PageReader·원시 Actuator·이벤트 배선·페이지 세션 CDP 탭.
// 실제 금고 중계 + Chrome(headless) + 로컬 픽스처(127.0.0.1). 실제 포털 접속 없음.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import fsp from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { openDatabase, type Db } from '@sax/db';
import {
  ariaHead, CommitGuard, connectRunBrowser, FetchInterceptor, PlaywrightActuator, PlaywrightPageReader, PlaywrightScreenSource, RateGuard, ratePolicyFrom, RunEnforcer, SIGNAL_DICT, treeToObservation, wireRun,
  type RunBrowser, type RunWiring,
} from '@sax/engine';
import { clampPolicy, GuardedActuator, resolveTarget, type Policy, type Resolved, type SelectorDict, type SelectorEntry } from '@sax/engine/core';
import { Redactor } from '@sax/redaction';
import { POLICY_EXAMPLE } from './core-fixtures.ts';
import { FakeClock } from './core-page-fakes.ts';
import { startHarness, type Harness } from './harness.ts';

const FORM = `<!doctype html><html><head><meta charset="utf-8"><title>form</title></head><body>
<main id="app">
<form aria-label="발급 양식" onsubmit="return false">
  <label for="amt">공급가액</label><input id="amt" name="amt">
  <label for="kind">종류</label><select id="kind"><option>일반</option><option>영세율</option></select>
  <button id="iss" type="button" onclick="fetch('/issue',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:'v=1'}).then(r=>out.textContent='sent '+r.status,()=>out.textContent='blocked')">발급하기</button>
  <button id="al" type="button" onclick="alert('안내 문구입니다')">알림</button>
  <button id="cf" type="button" onclick="out.textContent=confirm('발급하시겠습니까?')?'yes':'no'">확인창</button>
  <a id="go" href="/next">다음 화면</a>
  <label for="pw">비밀번호</label><input id="pw" type="password" value="pw-s3cr3t">
  <p>담당 010-1234-5678</p>
</form>
<div id="out" role="status"></div>
</main></body></html>`;

interface Fx {
  origin: string;
  posts: string[];
  close(): Promise<void>;
}
async function startFx(): Promise<Fx> {
  const posts: string[] = [];
  const srv = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c: Buffer) => (body += c.toString()));
    req.on('end', () => {
      const u = new URL(req.url ?? '/', 'http://x');
      if (req.method === 'POST') posts.push(`${u.pathname} ${body}`);
      const html = (status: number, s: string) => {
        res.writeHead(status, { 'content-type': 'text/html; charset=utf-8' });
        res.end(s);
      };
      if (u.pathname === '/form') return html(200, FORM);
      if (u.pathname === '/next') return html(200, '<!doctype html><meta charset="utf-8"><main id="app"><h1>다음 화면</h1></main>');
      if (u.pathname === '/limited') return html(429, '<!doctype html><meta charset="utf-8"><p>잠시 후</p>');
      if (u.pathname === '/issue') return html(200, 'ok');
      html(404, 'nf');
    });
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  return { origin: `http://127.0.0.1:${(srv.address() as AddressInfo).port}`, posts, close: () => new Promise((r) => srv.close(() => r())) };
}

const entry = (o: Partial<SelectorEntry> & Pick<SelectorEntry, 'role' | 'namePattern' | 'landmark' | 'candidates'>): SelectorEntry => ({ frame: 'main', commits: false, lastVerified: '2026-11-06', ...o });
const DICT: SelectorDict = {
  portal: 'hometax',
  commitEndpoints: [{ match: { method: 'POST', pathPattern: '^/issue$' }, effect: 'issue_document', maxRequests: 1 }],
  knownEndpoints: [{ method: 'GET', pathPattern: '^/(form|next|limited)$' }],
  entries: {
    'p.root': entry({ role: 'main', namePattern: '^$', landmark: 'p.root', candidates: [{ kind: 'css', value: '#app' }] }),
    'f.root': entry({ role: 'form', namePattern: '^발급 양식$', landmark: 'p.root', candidates: [{ kind: 'role', role: 'form', name: '발급 양식' }] }),
    'f.amt': entry({ role: 'textbox', namePattern: '^공급가액$', landmark: 'f.root', candidates: [{ kind: 'label', value: '공급가액' }], fieldKey: 'supplyAmount' }),
    'f.kind': entry({ role: 'combobox', namePattern: '^종류$', landmark: 'f.root', candidates: [{ kind: 'css', value: '#kind' }] }),
    'f.issue': entry({ role: 'button', namePattern: '^발급하기$', landmark: 'f.root', candidates: [{ kind: 'role', role: 'button', name: '발급하기' }], commits: true, commitEffect: 'issue_document' }),
    'f.alias': entry({ role: 'button', namePattern: '^발급하기$', landmark: 'f.root', candidates: [{ kind: 'css', value: '#iss' }], reviewNote: { by: 'qa', reason: '시험' } }),
    'f.alert': entry({ role: 'button', namePattern: '^알림$', landmark: 'f.root', candidates: [{ kind: 'css', value: '#al' }] }),
    'f.confirm': entry({ role: 'button', namePattern: '^확인창$', landmark: 'f.root', candidates: [{ kind: 'css', value: '#cf' }], reviewNote: { by: 'qa', reason: '시험 확인창' } }),
    'f.go': entry({ role: 'link', namePattern: '^다음 화면$', landmark: 'f.root', candidates: [{ kind: 'role', role: 'link', name: '다음 화면' }], navigationOnly: true, reviewNote: { by: 'qa', reason: '조회 이동' } }),
    'f.pw': entry({ role: 'textbox', namePattern: '^비밀번호$', landmark: 'f.root', candidates: [{ kind: 'label', value: '비밀번호' }], inputType: 'password', secretKind: 'portal_password', secretPurpose: 'login' }),
    'f.out': entry({ role: 'status', namePattern: '^$', landmark: 'p.root', candidates: [{ kind: 'css', value: '#out' }] }),
  },
};
const POLICY = clampPolicy(structuredClone(POLICY_EXAMPLE) as unknown as Policy).policy;

describe('Playwright 드라이버(금고 중계 + Chrome)', () => {
  let h: Harness;
  let fx: Fx;
  let run: RunBrowser;
  let root: string;
  let db: Db;
  before(async () => {
    fx = await startFx();
    h = await startHarness();
    run = await connectRunBrowser(h.client);
    root = await fsp.mkdtemp(path.join(os.tmpdir(), 'sax-drv-'));
    db = openDatabase(path.join(root, 'a.sqlite'), new Uint8Array(randomBytes(32)));
  });
  after(async () => {
    await run?.browser.close().catch(() => {});
    await h?.close();
    await fx?.close();
    db?.close();
    await fsp.rm(root, { recursive: true, force: true });
  });

  const setup = async (o: { guard?: boolean } = {}) => {
    const clock = new FakeClock();
    const journal: Array<[string, Record<string, unknown> | undefined]> = [];
    const security: string[] = [];
    const rg = new RateGuard(db, 'hometax', ratePolicyFrom(POLICY, 'hometax', 'interactive', false)!, { wall: () => Date.now(), mono: () => clock.t });
    const enforcer = new RunEnforcer({ guard: rg, clock, mono: () => clock.t, dict: SIGNAL_DICT.fixture, profileId: `p${randomBytes(3).toString('hex')}`, journal: (t, p) => journal.push([t, p]), random: () => 0 });
    const reader = new PlaywrightPageReader(run.page);
    const raw = new PlaywrightActuator({ page: run.page, reader, afterNavigation: () => enforcer.settled() });
    const act = new GuardedActuator({ driver: raw, reader, dict: DICT, domains: ['127.0.0.1'], policy: enforcer, events: { security: (c, k) => security.push(`${c} ${k}`), journal: (t, p) => journal.push([t, p]) } });
    let guard: CommitGuard | undefined;
    let interceptor: FetchInterceptor | undefined;
    if (o.guard) {
      const g = CommitGuard.create({
        runId: 'r1', targetId: run.targetId, mode: 'assisted', endpoints: DICT.commitEndpoints, known: DICT.knownEndpoints, domains: ['127.0.0.1'],
        vault: { arm: async () => ({ armed: false, reason: 'bad_params' }), disarm: async () => {} },
        ledger: { resolve: () => {}, observedManual: () => {} }, manualRow: () => null, now: () => Date.now(),
        journal: (t, p) => journal.push([t, p]), security: (c) => security.push(c), stop: (c) => enforcer.haltFor(c),
      });
      assert.ok(g.ok);
      guard = g.guard;
      interceptor = new FetchInterceptor({ session: run.cdp, guard, domains: ['127.0.0.1'], journal: (t, p) => journal.push([t, p]), insecureLoopback: true });
    }
    const wiring: RunWiring = await wireRun({ page: run.page, reader, enforcer, actuator: act, domains: ['127.0.0.1'], guard, interceptor, vaultOn: (n, fn) => h.client.on(n, fn) });
    const res = async (key: string): Promise<Resolved> => {
      const r = await resolveTarget(reader, DICT, key);
      assert.ok(r.ok, `${key} ${JSON.stringify(r)}`);
      return r.t;
    };
    return { enforcer, reader, raw, act, guard, interceptor, wiring, journal, security, res };
  };

  it('PageReader: 후보(role·css·label)·랜드마크 하위·역할·이름·같은 요소·값·접근성 값·본문', async () => {
    const s = await setup();
    try {
      assert.deepEqual(await s.act.goto(`${fx.origin}/form`), { ok: false, code: 'step.url_not_allowed' }, 'GuardedActuator는 https·manifest.domains만(V-06), 픽스처는 원시 드라이버로 연다');
      assert.deepEqual(await s.raw.goto(`${fx.origin}/form`), { ok: true });
      const amt = await s.res('f.amt');
      assert.deepEqual(await s.reader.info(amt.el), { role: 'textbox', name: '공급가액', visible: true, enabled: true });
      const kind = await s.res('f.kind');
      assert.equal((await s.reader.info(kind.el)).role, 'combobox');
      assert.ok(await s.reader.same((await s.res('f.issue')).el, (await s.res('f.alias')).el), '다른 후보 같은 요소');
      assert.ok(!(await s.reader.same(amt.el, kind.el)));
      const form = await s.res('f.root');
      assert.equal((await s.reader.query({ kind: 'css', value: '#out' }, 'main', form.el)).length, 0, '양식 밖 요소는 within 하위 아님');
      assert.equal((await s.reader.query({ kind: 'css', value: '#amt' }, 'nope', null)).length, 0, '없는 프레임');
      assert.match(await s.reader.bodyText(), /다음 화면/);
      assert.equal(s.reader.url(), `${fx.origin}/form`);
      assert.deepEqual(ariaHead('- textbox "공급가액": "1,000"'), { role: 'textbox', name: '공급가액' });
    } finally {
      await s.wiring.dispose();
    }
  });

  it('decide 화면 관측(PlaywrightScreenSource): root·scope 스냅숏 → A11yNode, 입력 값·비밀 칸 값 없음, 마스킹 입력(M2-2 B)', async () => {
    const s = await setup();
    try {
      assert.deepEqual(await s.raw.goto(`${fx.origin}/form`), { ok: true });
      assert.deepEqual(await s.raw.fill(await s.res('f.amt'), '1234567', { keyEvents: false }), { ok: true });
      const src = new PlaywrightScreenSource({ page: run.page, reader: s.reader, dict: DICT });
      const root = await src.capture('root');
      assert.ok(root);
      assert.equal(root.title, 'form');
      assert.equal(root.url, `${fx.origin}/form`);
      const pw = JSON.stringify(root.tree);
      assert.ok(!pw.includes('pw-s3cr3t'), '비밀 칸 값은 트리에 없다');
      const red = new Redactor({ runId: 'r1' }).applyTree(root.tree, { maxBytes: 6144 }).redacted;
      for (const raw of ['1234567', 'pw-s3cr3t', '010-1234-5678']) assert.ok(!red.includes(raw), `${raw}: ${red}`);
      assert.match(red, /form "발급 양식"/);
      assert.match(red, /button "발급하기"/);
      const obs = treeToObservation(root.tree, root.url, root.title);
      assert.ok(!JSON.stringify(obs).includes('1234567'));
      assert.ok(obs.nodes.some((n) => n.role === 'button' && n.name === '조회') || obs.nodes.some((n) => n.role === 'button' && n.name === '발급하기'));
      const form = await src.capture('f.root');
      assert.ok(form);
      assert.deepEqual([form.tree.children?.length, form.tree.children?.[0]?.role, form.tree.children?.[0]?.scopeId], [1, 'form', 'f.root']);
      const fred = new Redactor({ runId: 'r1' }).applyTree(form.tree, { maxBytes: 6144, scopeId: 'f.root' }).redacted;
      assert.ok(!fred.includes('#out') && !fred.includes('status'), fred);
      await s.reader.release();
      assert.equal(await src.capture('f.nothing'), null, '사전에 없는 scope');
    } finally {
      await s.wiring.dispose();
    }
  });

  it('원시 Actuator(GuardedActuator 아래): 키 입력 fill·select·링크 이동 뒤 settled, 값은 DOM·접근성 둘 다', async () => {
    const s = await setup();
    try {
      await s.raw.goto(`${fx.origin}/form`);
      assert.deepEqual(await s.act.fill(await s.res('f.amt'), '1,000', { keyEvents: true }), { ok: true });
      const amt = await s.res('f.amt');
      assert.equal(await s.reader.value(amt.el), '1,000');
      assert.equal(await s.reader.a11yValue(amt.el), '1,000');
      assert.deepEqual(await s.act.fill(amt, '2,000', { keyEvents: false }), { ok: true });
      assert.equal(await s.reader.value((await s.res('f.amt')).el), '2,000');
      assert.deepEqual(await s.act.clear(await s.res('f.amt')), { ok: true });
      assert.equal(await s.reader.value((await s.res('f.amt')).el), '');
      assert.deepEqual(await s.act.select(await s.res('f.kind'), '영세율'), { ok: true });
      assert.equal(await s.reader.a11yValue((await s.res('f.kind')).el), '영세율');
      assert.deepEqual(await s.act.select(await s.res('f.kind'), '없는 값'), { ok: false, code: 'step.selector_miss' });
      assert.deepEqual(await s.act.click(await s.res('f.go')), { ok: true });
      assert.equal(s.reader.url(), `${fx.origin}/next`);
      assert.ok(s.enforcer.actuationCount >= 6);
    } finally {
      await s.wiring.dispose();
    }
  });

  it('GuardedActuator: 무장 없는 커밋 항목·그림자 항목은 누르지 않는다(실제 요소)', async () => {
    const s = await setup();
    try {
      await s.raw.goto(`${fx.origin}/form`);
      assert.deepEqual(await s.act.click(await s.res('f.issue')), { ok: false, code: 'step.irreversible_unguarded' });
      assert.deepEqual(await s.act.click(await s.res('f.alias')), { ok: false, code: 'step.commit_shadow' });
      assert.deepEqual(s.security, ['step.commit_shadow f.alias']);
      assert.equal(fx.posts.length, 0);
    } finally {
      await s.wiring.dispose();
    }
  });

  it('대화상자 배선: alert 수락, 무장 없는 confirm은 거부(dismiss), 문구는 신호 사전만 본다', async () => {
    const s = await setup();
    try {
      await s.raw.goto(`${fx.origin}/form`);
      assert.deepEqual(await s.act.click(await s.res('f.alert')), { ok: true });
      assert.deepEqual(await s.act.click(await s.res('f.confirm')), { ok: true });
      await run.page.waitForFunction(() => document.getElementById('out')?.textContent === 'no', null, { timeout: 5000 });
      assert.equal(s.enforcer.halted, null);
      assert.ok(!JSON.stringify(s.journal).includes('발급하시겠습니까'), '대화상자 문구는 저널에 없다');
    } finally {
      await s.wiring.dispose();
    }
  });

  it('커밋 가드(실제 금고 중계, 페이지 세션 탭): 무장 없는 커밋 요청은 Fetch에서 막혀 서버에 닿지 않고 실행이 멈춘다', async () => {
    const s = await setup({ guard: true });
    try {
      await s.raw.goto(`${fx.origin}/form`);
      assert.ok(s.interceptor!.hosts.includes(`http://127.0.0.1:${new URL(fx.origin).port}`), s.interceptor!.hosts.join(','));
      // 가드 우회 시도: GuardedActuator를 거치지 않고 원시 드라이버로 누른다. 네트워크 층이 따로 막는다.
      assert.deepEqual(await s.raw.click(await s.res('f.alias')), { ok: true });
      await run.page.waitForFunction(() => document.getElementById('out')?.textContent === 'blocked', null, { timeout: 5000 });
      assert.equal(fx.posts.filter((p) => p.startsWith('/issue')).length, 0, '서버에 닿지 않음');
      assert.deepEqual(s.security, ['commit_guard.blocked_request']);
      assert.equal(s.enforcer.halted, 'commit_guard.blocked_request');
      assert.deepEqual(await s.act.click(await s.res('f.alert')), { ok: false, code: 'commit_guard.blocked_request' }, '그 뒤 모든 동작 거부');
      // 커밋이 아닌 요청과 Playwright 자체 동작은 그대로(Fetch 이벤트를 Playwright에 넘기지 않아도 깨지지 않음)
      assert.equal(await run.page.evaluate(() => fetch('/next').then((r) => r.status)), 200);
      assert.ok(s.journal.some(([t]) => t === 'commit_guard.unclassified') === false, '알려진 요청은 미분류 아님');
    } finally {
      await s.wiring.dispose();
    }
    // 배선을 걷으면 Fetch도 내려 이후 실행에 남지 않는다
    assert.equal(await run.page.evaluate(() => fetch('/issue', { method: 'POST', body: 'x' }).then((r) => r.status)), 200);
  });

  it('응답 배선: 포털 문서 429는 집행기 HTTP 규칙으로 걸쇠', async () => {
    const s = await setup();
    try {
      await s.raw.goto(`${fx.origin}/limited`);
      assert.ok(s.enforcer.halted, 'halted');
      assert.ok(s.journal.some(([t]) => t === 'block.signal'));
    } finally {
      await s.wiring.dispose();
    }
  });
});
