// 게시본 H-01 전체 스텝 건조 실행(가짜 홈·로그인·서명 창 + 가짜 H-01 폼). 하네스: tests/h01-published-dryrun.ts. 실제 홈택스에 접속하지 않는다.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { BizVerifier, connectRunBrowser, DataService, fixturePortal, RunService, type GatePortMessage, type IrPackage, type RunEvent } from '@sax/engine';
import { fixtureOriginGrant, type PdfPort } from '@sax/engine/core';
import { openDatabase } from '@sax/db';
import { Egress } from '@sax/net';
import { FileEventLog } from '@sax/platform';
import { startHarness } from './harness.ts';
import { h01FixtureLookupDefs } from './h01-fixture-package.ts';
import { loadPublishedDryRun, startLoginFixture, type LoginFixture, type StepPatch } from './h01-published-dryrun.ts';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 시험용 PDF 포트(보관 성공). save_pdf 뒤 s33까지 보려고 붙인다(제품 포트는 PR-A). */
const PDF: PdfPort = {
  print: async () => ({ ok: true, fileId: 'a'.repeat(32) }),
  armDownload: async () => ({ armed: false, reason: 'n/a' }),
  awaitDownload: async () => ({ ok: false, reason: 'n/a' }),
  disarmDownload: async () => {},
  store: async () => ({ ok: true, documentId: 'doc-1' }),
};

interface Scenario {
  signMethod: 'simple_auth' | 'cert';
  loggedIn?: boolean;
  captcha?: boolean;
  supplier?: { bizNo: string; name: string };
  patches?: Record<string, StepPatch>;
  /** 사람 흉내: 실행 중 반복해서 불린다. */
  human?: (fx: LoginFixture) => void;
  approve?: boolean;
  /** 최대 기다림(ms). */
  maxMs?: number;
  stopAfterMs?: number;
  /** 사람 대기 알림(handoff 이벤트)마다 한 번. n = 몇 번째(0부터). */
  onHandoff?: (h: { phase: string; code?: string }, c: { runs: RunService; fx: LoginFixture; n: number }) => void;
  /** RunService 시험 옵션(handoffCapMs 등). */
  deps?: Record<string, unknown>;
}

interface Outcome {
  end: RunEvent | undefined;
  journal: string[];
  steps: string[];
  gate: boolean;
  handoffs: string[];
  /** 서명 차례가 끝난 까닭(sign.turn_closed why). */
  turn: string[];
  posts: number;
  signs: number;
  fx: LoginFixture;
}

async function dryRun(sc: Scenario): Promise<Outcome> {
  const fx = await startLoginFixture({ loggedIn: sc.loggedIn, captcha: sc.captcha, supplier: sc.supplier });
  const h = await startHarness();
  const dir = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'sax-dry-'));
  const db = openDatabase(path.join(dir, 'db.sqlite'), new Uint8Array(randomBytes(32)));
  const events: RunEvent[] = [];
  const gm: GatePortMessage[] = [];
  const steps: string[] = [];
  try {
    const { pkg } = loadPublishedDryRun(fx.origin, sc.patches);
    const p = fixturePortal(fx.origin);
    const judge = {
      decide: async (bundle: string) => {
        const outcome = bundle.startsWith('screen_state') ? (fx.state.loggedIn ? 'logged_in' : fx.state.captcha ? 'captcha' : fx.state.pending ? 'mfa_pending' : 'login_required') : 'no_visible_error';
        return { outcome, confidence: 1, raw: {}, usage: { input_tokens: 0, output_tokens: 0 }, refusals: [], rule: 3, provider: 'openai', model: 'fixture', l0Only: true, injectionHit: false, shadow: [] } as never;
      },
    };
    const ir: IrPackage = { pkg, lookupDefs: h01FixtureLookupDefs(fx.origin), fixtureGrant: fixtureOriginGrant(pkg), verifyTiming: { minElapsedMs: p.verify.minElapsedMs, lookups: p.verify.lookups, maxMs: p.verify.maxMs }, judge, pdf: PDF };
    const data = new DataService(db, new BizVerifier(new Egress()));
    data.profiles.upsert({ kind: 'business', displayName: '가나다컴퍼니', bizNo: '1234567891', corpNo: null, repName: '김', bizType: null, bizItem: null, address: null, email: null, signMethod: sc.signMethod });
    const cp = data.counterparties.create({ bizNo: '2148651233', name: 'A상사', email: 'tax@asangsa.example' }).id;
    const rb = await connectRunBrowser(h.client);
    const runs = new RunService({
      db, data, ledgerKey: new Uint8Array(randomBytes(32)), portal: p, log: new FileEventLog(null, 'engine'), page: async () => rb.page,
      postGate: (m) => gm.push(m), engine: 'ir', irSource: () => ({ ok: true, ir }), ...sc.deps,
      trace: (_r: string, t: { name: string; stepId: string; code?: string }) => {
        if (t.name === 'step.finished') steps.push(t.code ? `${t.stepId}!${t.code}` : t.stepId);
      },
    } as never);
    runs.on('event', (e: RunEvent) => events.push(e));
    const ended = () => events.find((e) => e.type === 'end');
    runs.start({ runId: 'r1', counterpartyId: cp, supply: 100000, tax: 10000, itemName: '경영 컨설팅' });
    const t0 = Date.now();
    let approved = false;
    let seen = 0;
    const handoffs = () => events.filter((e): e is Extract<RunEvent, { type: 'handoff' }> => e.type === 'handoff');
    while (!ended() && Date.now() - t0 < (sc.maxMs ?? 40_000)) {
      sc.human?.(fx);
      for (const e of handoffs().slice(seen)) sc.onHandoff?.(e, { runs, fx, n: seen++ });
      const g = gm.find((m) => m.t === 'gate.request');
      if (g && !approved && sc.approve !== false && g.t === 'gate.request') {
        approved = true;
        const q = g.req;
        runs.answer({ v: 2, runId: q.runId, gateStepId: q.gateStepId, reqId: q.reqId, approvalNonce: q.approvalNonce, actionHash: q.actionHash, exp: Date.now() + 120_000, presence: 'click', mac: 'not-verified-in-phase1' });
      }
      if (sc.stopAfterMs && Date.now() - t0 > sc.stopAfterMs) {
        try {
          runs.stop('r1');
        } catch {
          /* 무장 중 */
        }
      }
      await sleep(100);
    }
    const journal = runs.inspect('r1').journal;
    if (process.env.SAX_DRY_DUMP) for (const r of db.prepare(`SELECT * FROM run_events WHERE run_id = 'r1' ORDER BY seq`).all() as Array<Record<string, unknown>>) console.log('EV', JSON.stringify(r));
    const turn = (db.prepare(`SELECT payload_json FROM run_events WHERE run_id = 'r1' AND type = 'sign.turn_closed'`).pluck().all() as string[]).map((j) => String(JSON.parse(j).why));
    const end = ended();
    try {
      runs.stop('r1');
    } catch {
      /* 끝남 */
    }
    // 끝나지 않았으면(시험 실패) 끝날 때까지 조금 기다려 실행·타이머가 남지 않게 한다.
    for (let i = 0; i < 100 && !ended(); i++) await sleep(100);
    await rb.browser.close().catch(() => {});
    return { end, journal, steps, gate: gm.some((m) => m.t === 'gate.request'), handoffs: handoffs().map((e) => `${e.phase}:${e.code ?? ''}`), turn, posts: fx.inner.posts(), signs: fx.state.signs, fx };
  } finally {
    db.close();
    await h.close();
    await fx.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
}

const show = (o: Outcome) => `end=${JSON.stringify(o.end)} turn=${o.turn.join(',')} steps=${o.steps.join(' ')} journal=${o.journal.join(',')}`;

const st = (o: Outcome) => (o.end as { status?: string; code?: string; mailConfirmed?: boolean } | undefined) ?? {};
const login = (fx: LoginFixture) => void (fx.state.pending && setTimeout(() => fx.completeLogin(), 1000));

describe('게시본 H-01 건조 실행: 지금 동작(사실 고정)', () => {
  it('간편인증, 로그아웃에서 시작: s0 → 로그인(s2·s3·s4·s5·s6) → 폼 → 게이트 → 발급 확인창 → 서명 창 [서명] → 발급목록 → PDF → 메일 확인', async () => {
    const o = await dryRun({ signMethod: 'simple_auth', human: login });
    assert.equal(st(o).status, 'success', show(o));
    assert.equal(st(o).mailConfirmed, true);
    assert.deepEqual([o.posts, o.signs], [1, 1], '발급 POST·서명 각 1번');
    assert.deepEqual(o.steps.slice(0, 7), ['s0', 's1', 's2', 's3', 's4', 's5', 's6']);
    assert.ok(o.journal.includes('commit.confirm_accepted'), '확인창(expectConfirm)을 무장 구간에서 수락');
  });
  it('이미 로그인된 상태로 시작하면 s2에서 s10으로 간다', async () => {
    const o = await dryRun({ signMethod: 'simple_auth', loggedIn: true });
    assert.equal(st(o).status, 'success', show(o));
    assert.deepEqual(o.steps.slice(0, 4), ['s0', 's1', 's2', 's10']);
  });
  it('s19c: 홈택스에 로그인한 사업자가 프로필과 다르면 게이트 전에 failed assert.supplier_mismatch', async () => {
    const o = await dryRun({ signMethod: 'simple_auth', loggedIn: true, supplier: { bizNo: '9999999999', name: '다른회사' } });
    assert.deepEqual([st(o).status, st(o).code, o.gate, o.posts], ['failed', 'assert.supplier_mismatch', false, 0], show(o));
  });
  it('로그인 대기(s5 wait text 120초) 중 [중지]는 바로 stopped', async () => {
    const o = await dryRun({ signMethod: 'simple_auth', stopAfterMs: 4000, maxMs: 15_000 });
    assert.equal(st(o).status, 'stopped', show(o));
    assert.equal(o.steps.at(-1), 's5!run.stopped');
    assert.equal(o.posts, 0);
  });
});

const S5_SHORT: Record<string, StepPatch> = { s5: (s) => void (s.timeoutMs = 1500) };
// 스키마 하한(10초).
const PUSH_SHORT: StepPatch = (s) => void ((s.signFlow as { maxWaitMs: number }).maxWaitMs = 10_000);
const resume = (c: { runs: RunService }) => assert.deepEqual(c.runs.resume('r1'), { ok: true });

describe('게시본 H-01 건조 실행: 사람 대기 재개(B3)', () => {
  it('로그인 시간 초과(s5 step.timeout) → handoff login → 사람이 로그인을 마치고 [다 했어요] → s0부터 다시 → success', async () => {
    const o = await dryRun({ signMethod: 'simple_auth', patches: S5_SHORT, onHandoff: (_h, c) => (c.fx.completeLogin(), resume(c)) });
    assert.equal(st(o).status, 'success', show(o));
    assert.deepEqual(o.handoffs, ['login:step.timeout']);
    assert.deepEqual([o.posts, o.signs], [1, 1]);
    assert.ok(o.journal.includes('run.handoff') && o.journal.includes('run.resumed'));
  });
  it('캡차(s90 portal.captcha) → handoff login → 사람이 풀고 로그인 → [다 했어요] → success', async () => {
    const o = await dryRun({ signMethod: 'simple_auth', captcha: true, onHandoff: (_h, c) => ((c.fx.state.captcha = false), c.fx.completeLogin(), resume(c)) });
    assert.equal(st(o).status, 'success', show(o));
    assert.deepEqual(o.handoffs, ['login:portal.captcha']);
  });
  it('사람 대기 중 [중지]는 바로 stopped, 아무것도 발급하지 않는다', async () => {
    const o = await dryRun({ signMethod: 'simple_auth', patches: S5_SHORT, onHandoff: (_h, c) => assert.deepEqual(c.runs.stop('r1'), { stopped: true }) });
    assert.deepEqual([st(o).status, o.posts], ['stopped', 0], show(o));
  });
  it('사람 대기 상한: 답이 없으면 handoff run.handoff_timeout으로 끝난다(시험 상한 2초)', async () => {
    const o = await dryRun({ signMethod: 'simple_auth', patches: S5_SHORT, deps: { handoffCapMs: 2000 } });
    assert.deepEqual([st(o).status, st(o).code, o.posts], ['handoff', 'run.handoff_timeout', 0], show(o));
  });
  it('서명 차례: PUSH를 maxWaitMs 뒤에 승인하면(서명 창이 늦게 뜸) handoff sign → 엔진이 [서명]을 한 번 누르고 → success, POST 1번', async () => {
    const o = await dryRun({ signMethod: 'simple_auth', loggedIn: true, patches: { s21: PUSH_SHORT }, human: (fx) => void (fx.state.signDelayMs = 13_000), maxMs: 60_000 });
    assert.equal(st(o).status, 'success', show(o));
    assert.deepEqual(o.handoffs, ['sign:sign.waiting']);
    assert.deepEqual([o.posts, o.signs], [1, 1]);
  });
  it('서명 차례 안전: [다 했어요]·[중지]는 버튼을 누르지 않고 verify로만(발급 요청을 엔진이 다시 내보내지 않는다, POST 0번이어도 in_doubt 유지)', async () => {
    for (const how of ['resume', 'stop'] as const) {
      const o = await dryRun({
        signMethod: 'simple_auth', loggedIn: true, patches: { s21: PUSH_SHORT }, human: (fx) => void (fx.state.signDelayMs = 60_000), maxMs: 60_000,
        onHandoff: (_h, c) => (how === 'resume' ? resume(c) : assert.deepEqual(c.runs.stop('r1'), { stopped: false })),
      });
      assert.equal(st(o).status, 'in_doubt', `${how}: ${show(o)}`);
      assert.deepEqual([o.posts, o.signs], [0, 0], how);
      assert.ok(o.journal.includes('sign.turn_closed'), how);
    }
  });
});

// 공동인증서 실행(engine-cert, B1·B2): tests/h01-published-dryrun-cert.test.ts(CertSecretPort, 사람이 인증서 창에서 직접 넣는 길).
});

// 수동 관찰: SAX_DRY=cert-login,captcha,... node --conditions=development --test tests/h01-published-dryrun.test.ts
const SC: Array<[string, Scenario]> = [
  ['cert-login', { signMethod: 'cert', maxMs: 20_000 }],
  ['cert-sign', { signMethod: 'cert', loggedIn: true, maxMs: 60_000 }],
  ['login-timeout', { signMethod: 'simple_auth', patches: { s5: (s) => void (s.timeoutMs = 2000) }, maxMs: 60_000 }],
  ['captcha', { signMethod: 'simple_auth', captcha: true, maxMs: 20_000 }],
  ['push-never', { signMethod: 'simple_auth', loggedIn: true, maxMs: 150_000, human: (fx) => void (fx.state.signDelayMs = 10_000_000) }],
];
const only = process.env.SAX_DRY?.split(',');
if (only) {
  describe('게시본 H-01 건조 실행(수동 관찰)', () => {
    for (const [name, sc] of SC) {
      if (!only.includes(name)) continue;
      it(name, async () => {
        const o = await dryRun(sc);
        console.log(`DRY ${name} status=${st(o).status} code=${st(o).code} posts=${o.posts} signs=${o.signs} gate=${o.gate}\n  steps=${o.steps.join(' ')}\n  journal=${o.journal.join(',')}`);
      });
    }
  });
}
