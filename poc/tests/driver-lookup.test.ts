// 조회 포트 Playwright 구현(M2-3, D02 §4.4, D03 §5.6): 허용 origin 팝업에서 읽고 닫는다. 기준은 H01Runner.lookup이다.
// 실제 금고 중계 + Chrome(headless) + 가짜 H-01 페이지(127.0.0.1). 실제 포털 접속 없음.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, beforeEach, describe, it } from 'node:test';
import { openDatabase, type Db } from '@sax/db';
import { connectRunBrowser, fixturePortal, PopupLookupPort, RateGuard, ratePolicyFrom, RunEnforcer, SIGNAL_DICT, type LookupDef, type LookupPolicy, type RunBrowser } from '@sax/engine';
import { clampPolicy, type LookupRequest, type Policy } from '@sax/engine/core';
import { startH01Fixture, type H01Fixture, type IssuedInvoice } from '../apps/desktop/src/h01-fixture.ts';
import { POLICY_EXAMPLE } from './core-fixtures.ts';
import { FakeClock } from './core-page-fakes.ts';
import { startHarness, type Harness } from './harness.ts';

const SUPPLIER = { bizNo: '1234567891', name: '가나다컴퍼니' };
const POLICY = clampPolicy(structuredClone(POLICY_EXAMPLE) as unknown as Policy).policy;
const INV = (o: Partial<IssuedInvoice> = {}): IssuedInvoice => ({
  approvalNo: '20261106-41000012-00000123', supplierBizNo: SUPPLIER.bizNo, counterpartBizNo: '2148651233', counterpartName: 'A상사', counterpartEmail: 'tax@asangsa.example',
  itemName: '경영 컨설팅', supplyAmount: '1000000', taxAmount: '100000', issueDate: '2026-11-06', ...o,
});
const REQ = (o: Partial<LookupRequest> = {}): LookupRequest => ({
  stepId: 's30', playbook: 'hometax.invoice.lookup', match: { counterpartBizNo: '2148651233', issueDate: '2026-11-06', supplyAmount: '1000000', taxAmount: '100000' }, window: 'issueDate', purpose: 'verify', ...o,
});

describe('PopupLookupPort(조회 팝업, 금고 중계 + Chrome)', () => {
  let h: Harness;
  let fx: H01Fixture;
  let run: RunBrowser;
  let root: string;
  let db: Db;
  before(async () => {
    fx = await startH01Fixture({ registry: {}, supplier: SUPPLIER });
    h = await startHarness();
    run = await connectRunBrowser(h.client);
    root = await fsp.mkdtemp(path.join(os.tmpdir(), 'sax-lookup-'));
    db = openDatabase(path.join(root, 'a.sqlite'), new Uint8Array(randomBytes(32)));
    await run.page.goto(`${fx.origin}/invoice/issue`);
  });
  after(async () => {
    await run?.browser.close().catch(() => {});
    await h?.close();
    await fx?.close();
    db?.close();
    await fsp.rm(root, { recursive: true, force: true });
  });
  beforeEach(() => {
    fx.issued.length = 0;
    Object.assign(fx.knobs, { block: null, status: null, lookupDelayMs: 0 });
  });

  const setup = (o: { refuse?: string; timeoutMs?: number } = {}) => {
    const clock = new FakeClock();
    const journal: string[] = [];
    const rg = new RateGuard(db, 'hometax', ratePolicyFrom(POLICY, 'hometax', 'interactive', false)!, { wall: () => Date.now(), mono: () => clock.t });
    const enforcer = new RunEnforcer({ guard: rg, clock, mono: () => clock.t, dict: SIGNAL_DICT.fixture, profileId: `p${randomBytes(3).toString('hex')}`, journal: (t) => journal.push(t), random: () => 0 });
    const calls: string[] = [];
    const policy: LookupPolicy = {
      beforeAction: async (k) => (calls.push(`before ${k}`), o.refuse ? { ok: false, code: o.refuse } : enforcer.beforeAction(k)),
      settled: async () => (calls.push('settled'), enforcer.settled()),
      observe: (w) => enforcer.observe(w),
      observeStatus: (s, d) => (calls.push(`status ${s} ${d}`), enforcer.observeStatus(s, d)),
      get halted() {
        return enforcer.halted;
      },
    };
    const p = fixturePortal(fx.origin);
    const defs = new Map<string, LookupDef>([['hometax.invoice.lookup', p.invoiceLookup], ['hometax.invoice.email_status', p.mailLookup]]);
    const port = new PopupLookupPort({ page: run.page, origin: fx.origin, defs, policy, domains: ['127.0.0.1'], timeoutMs: o.timeoutMs });
    return { port, calls, journal, enforcer };
  };
  const pages = () => run.page.context().pages().length;

  it('발급목록: 질의(bizNo·date)로 연 팝업의 data-count와 행 수가 같으면 그 행(화면 문구 그대로). 팝업은 닫는다, 원래 탭은 그대로', async () => {
    fx.issued.push(INV(), INV({ approvalNo: '20261106-41000012-00000124', supplyAmount: '5000' }), INV({ approvalNo: 'other-day', issueDate: '2026-11-05' }));
    const before = pages();
    const url = run.page.url();
    const { port, calls } = setup();
    const r = await port.run(REQ());
    assert.ok(r.ok);
    assert.deepEqual(r.rows.map((x) => x.approvalNo), ['20261106-41000012-00000123', '20261106-41000012-00000124'], '날짜가 다른 건은 질의에서 빠진다');
    assert.deepEqual(r.rows[0], { approvalNo: '20261106-41000012-00000123', counterpartBizNo: '2148651233', issueDate: '2026-11-06', supplyAmount: '1000000', taxAmount: '100000' });
    assert.deepEqual(calls.filter((c) => !c.startsWith('status')), ['before navigate', 'settled'], '네비게이션 자리 → 안정 대기');
    assert.equal(pages(), before, '팝업을 닫았다');
    assert.equal(run.page.url(), url);
    assert.ok(fx.requests.some((q) => q.path === '/invoice/list'));
  });

  it('메일발송목록(email_status): approvalNo 질의, status 열', async () => {
    fx.issued.push(INV());
    const { port } = setup();
    const r = await port.run(REQ({ stepId: 's33', playbook: 'hometax.invoice.email_status', match: { approvalNo: '20261106-41000012-00000123' }, window: 'today' }));
    assert.ok(r.ok);
    assert.deepEqual(r.rows, [{ approvalNo: '20261106-41000012-00000123', status: '전송완료' }]);
  });

  it('빈 결과도 data-count="0"이면 성공(0건)', async () => {
    const { port } = setup();
    assert.deepEqual(await port.run(REQ()), { ok: true, rows: [] });
  });

  it('모르는 조회 id·집행기 거절이면 팝업을 열지 않는다', async () => {
    const before = fx.requests.length;
    assert.deepEqual(await setup().port.run(REQ({ playbook: 'hometax.other' })), { ok: false, code: 'lookup.unknown_playbook' });
    assert.deepEqual(await setup({ refuse: 'policy.navigations_per_min' }).port.run(REQ()), { ok: false, code: 'policy.navigations_per_min' });
    assert.equal(fx.requests.length, before);
  });

  it('조회가 차단 안내로 가면 걸쇠 코드(portal.blocked)를 돌려준다(judgeVerify는 더 조회하지 않는다)', async () => {
    fx.knobs.block = 'lookup';
    const { port, enforcer } = setup();
    const before = pages();
    const r = await port.run(REQ());
    assert.deepEqual(r, { ok: false, code: 'portal.blocked' });
    assert.equal(enforcer.halted, 'portal.blocked');
    assert.equal(pages(), before);
  });

  it('결과 준비 신호가 시간 안에 없으면 조회 실패(부재 증거가 아니다)', async () => {
    fx.knobs.lookupDelayMs = 3_000;
    const r = await setup({ timeoutMs: 500 }).port.run(REQ());
    assert.equal(r.ok, false);
    assert.match((r as { code: string }).code, /^lookup\./);
  });
});
