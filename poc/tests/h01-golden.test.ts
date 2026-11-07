// RunService IR 전환 골든 대조(엔진 M2-3 PR-C, ADR-039 결과). 같은 가짜 H-01 페이지에서 H01Runner(기본)와 IR 조율기(engine 'ir',
// fixture 패키지 s10~s35)를 같은 시나리오로 돌리고, 바깥 모양을 비교한다: 스텝 순서·종료 상태와 코드·원장·저널 코드·게이트 카드·제출 횟수.
// 기준은 차이 0이다. 두 실행기의 구조가 달라 생기는 차이는 KNOWN에 이유와 함께 적은 것만 뺀다(그 밖의 차이는 IR 쪽에서 고친다).
// 실제 포털 접속 없음: 금고는 프로세스 안(시험 정책 127.0.0.1)·헤드리스 Chrome, 모델 없음(decide는 고정 판정기), PDF는 가짜 포트.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { BizVerifier, connectRunBrowser, DataService, fixturePortal, RunService, type GatePortMessage, type GateRequest, type IrPackage, type LocalApproval, type RunEvent, type RunServiceDeps } from '@sax/engine';
import { fixtureOriginGrant, type PdfPort } from '@sax/engine/core';
import { openDatabase, type Db } from '@sax/db';
import { Egress } from '@sax/net';
import { FileEventLog } from '@sax/platform';
import type { Page } from 'playwright-core';
import { startH01Fixture, type H01Fixture } from '../apps/desktop/src/h01-fixture.ts';
import { startHarness, type Harness } from './harness.ts';
import { h01FixtureLookupDefs, loadH01Fixture } from './h01-fixture-package.ts';

const SUPPLIER = { bizNo: '1234567891', name: '가나다컴퍼니' };
const A = { bizNo: '2148651233', name: 'A상사', email: 'tax@asangsa.example' };
const C = { bizNo: '4182577343', name: 'C테크', email: 'billing@ctech.example' };

type Engine = 'h01' | 'ir';

/**
 * 두 실행기의 구조 차이(기준에서 빼는 것). 이 밖의 차이는 실패다.
 * - IR_ONLY_STEPS: H01 TS 플레이북에 없는 골든 스텝. s19 decide(form_ready, 모델 판정)·s19f(readback = 입력 대조)·s32 save_pdf·s32b(메일 분기).
 *   H01은 s19f를 따로 두지 않고 s19a~s19e로, s32b는 s33 skipUnless로 한다.
 * - H01_ONLY_STEPS: s36·s37(H01 종료 스텝). IR은 verify on.not_committed·unknown이 s11(재게이트)·handoff다.
 */
const IR_ONLY_STEPS = new Set(['s19', 's19f', 's32', 's32b']);
const H01_ONLY_STEPS = new Set(['s36', 's37']);
/**
 * 저널 코드 중 IR만 내는 것(값 없는 진행 기록). 비교에서 뺀다.
 * - run.state: 조율기 상태 전이(D03 §2 상태 기계). H01은 상태 기계가 없다.
 * - decide.result·verify.result: IR만 있는 s19 판정·verify 결과 행(H01은 결과를 원장 행으로만 남긴다).
 * - artifact.saved: IR만 있는 s32 save_pdf.
 * - gate.tokens_discarded: 조율기가 토큰을 버린 기록(H01 토큰은 RunService 메모리에만 있고 저널이 없다).
 */
const JOURNAL_IGNORE: Record<Engine, ReadonlySet<string>> = {
  h01: new Set([]),
  ir: new Set(['run.state', 'decide.result', 'verify.result', 'artifact.saved', 'gate.tokens_discarded']),
};

interface Obs {
  status: string;
  code: string | undefined;
  approvalNo: boolean;
  mailConfirmed: boolean | undefined;
  ledger: string | null;
  journal: string[];
  phases: string[];
  posts: number;
  /** 게이트 카드(fieldKey=value). 시험마다 바뀌는 값(runId·nonce·해시)은 뺀다. */
  gate: string[] | null;
  /** 게이트 포트로 나간 gate.closed 사유. */
  closed: string[];
  steps: string[];
}

class Side {
  readonly engine: Engine;
  readonly events: RunEvent[] = [];
  readonly gateMsgs: GatePortMessage[] = [];
  readonly traces = new Map<string, string[]>();
  runs!: RunService;
  /** 같은 DB·같은 실행기로 의존성 일부만 바꾼 RunService(gateWaitMs 등). */
  svc!: (over?: Partial<RunServiceDeps>) => RunService;
  db!: Db;
  dir!: string;
  data!: DataService;
  cp: Record<'A' | 'C', string> = { A: '', C: '' };
  constructor(engine: Engine) {
    this.engine = engine;
  }
}

describe('골든 대조: H01Runner와 IR 조율기(가짜 H-01 페이지, PR-C)', () => {
  let fx: H01Fixture;
  let h: Harness;
  let page: Page | null = null;
  const log = new FileEventLog(null, 'engine');
  const sides: Record<Engine, Side> = { h01: new Side('h01'), ir: new Side('ir') };
  let n = 0;

  const next = <T>(pred: () => T | undefined, ms = 30_000): Promise<T> =>
    new Promise((resolve, reject) => {
      const until = Date.now() + ms;
      const tick = () => {
        const v = pred();
        if (v !== undefined) return resolve(v);
        if (Date.now() > until) return reject(new Error('timeout'));
        setTimeout(tick, 50);
      };
      tick();
    });
  const gateFor = (s: Side, runId: string, nth = 0) => next(() => (s.gateMsgs.filter((m) => m.t === 'gate.request' && m.req.runId === runId)[nth] as { req: GateRequest } | undefined)?.req);
  const endOf = (s: Side, runId: string) => next(() => s.events.find((e) => e.runId === runId && e.type === 'end') as Extract<RunEvent, { type: 'end' }> | undefined, 60_000);
  const approval = (req: GateRequest): LocalApproval => ({
    v: 2, runId: req.runId, gateStepId: req.gateStepId, reqId: req.reqId, approvalNonce: req.approvalNonce, actionHash: req.actionHash, exp: Date.now() + 120_000, presence: 'click', mac: 'not-verified-in-phase1',
  });

  async function setup(s: Side, ir: IrPackage | undefined): Promise<void> {
    s.dir = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), `sax-golden-${s.engine}-`));
    s.db = openDatabase(path.join(s.dir, 'db.sqlite'), new Uint8Array(randomBytes(32)));
    s.data = new DataService(s.db, new BizVerifier(new Egress()));
    s.data.profiles.upsert({ kind: 'business', displayName: SUPPLIER.name, bizNo: SUPPLIER.bizNo, corpNo: null, repName: '김가나', bizType: null, bizItem: null, address: null, email: null, signMethod: 'simple_auth' });
    s.cp = { A: s.data.counterparties.create({ ...A }).id, C: s.data.counterparties.create({ ...C }).id };
    const ledgerKey = new Uint8Array(randomBytes(32));
    s.svc = (over = {}) => {
      const r = new RunService({
      db: s.db, data: s.data, ledgerKey, portal: fixturePortal(fx.origin), log,
      page: async () => (page && !page.isClosed() ? page : (page = (await connectRunBrowser(h.client)).page)),
      postGate: (m) => s.gateMsgs.push(m),
      ...(ir ? { engine: 'ir' as const, ir } : {}),
      trace: (runId, e) => {
        if (e.name !== 'step.started') return;
        const t = s.traces.get(runId) ?? [];
        if (t.at(-1) !== e.stepId) t.push(e.stepId);
        s.traces.set(runId, t);
      },
      ...over,
      });
      r.on('event', (e: RunEvent) => s.events.push(e));
      return r;
    };
    s.runs = s.svc();
  }

  before(async () => {
    fx = await startH01Fixture({ registry: { [A.bizNo]: A.name, [C.bizNo]: C.name }, supplier: SUPPLIER });
    h = await startHarness();
    const { pkg } = loadH01Fixture(fx.origin);
    const p = fixturePortal(fx.origin);
    const pdf: PdfPort = {
      print: async () => ({ ok: true, fileId: 'a'.repeat(32) }),
      armDownload: async () => ({ armed: true }),
      awaitDownload: async () => ({ ok: true, fileId: 'a'.repeat(32) }),
      disarmDownload: async () => {},
      store: async () => ({ ok: true, documentId: 'doc-1' }),
    };
    const ir: IrPackage = {
      pkg, lookupDefs: h01FixtureLookupDefs(fx.origin), fixtureGrant: fixtureOriginGrant(pkg), pdf,
      verifyTiming: { minElapsedMs: p.verify.minElapsedMs, lookups: p.verify.lookups, maxMs: p.verify.maxMs },
      // 모델 없음: form_ready는 늘 "보이는 오류 없음"(H01에는 이 판정이 없다).
      judge: { decide: async () => ({ outcome: 'no_visible_error', confidence: 1, raw: {}, usage: { input_tokens: 0, output_tokens: 0 }, refusals: [], rule: 3, provider: 'openai', model: 'fixture', l0Only: true, injectionHit: false, shadow: [] }) as never },
    };
    await setup(sides.h01, undefined);
    await setup(sides.ir, ir);
  });

  /** 끝나지 않은 실행(시험 실패 뒤 승인 대기 등). 정리 단계에서 멈춘다. */
  const live = new Map<string, { s: Side; runs: RunService }>();

  after(async () => {
    for (const [runId, x] of live) {
      try {
        x.runs.stop(runId);
      } catch { /* 커밋 구간 */ }
      await endOf(x.s, runId).catch(() => {});
    }
    await page?.context().browser()?.close().catch(() => {});
    await h.close();
    await fx.close();
    for (const s of Object.values(sides)) {
      s.db?.close();
      await fs.rm(s.dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });

  /** 한 실행기로 시나리오를 돌리고 관찰한다. drive는 게이트 요청을 받아 승인·중지 등을 한다. */
  interface Opts {
    extra?: Record<string, unknown>;
    /** 게이트 요청을 기다리지 않는다(게이트 전에 끝나는 시나리오). */
    noGate?: boolean;
    /** 시나리오 전용 의존성(같은 DB). */
    deps?: Partial<RunServiceDeps>;
    /** 시험 손잡이: 실행마다 켜고 끈다(한쪽이 실패해도 다른 쪽에 새지 않게). */
    knob?: { set: () => void; reset: () => void };
  }

  async function observe(s: Side, cp: 'A' | 'C', supply: number, drive: (req: GateRequest | null, runId: string, runs: RunService) => Promise<void>, o: Opts = {}): Promise<Obs> {
    const runId = `${s.engine}-${++n}`;
    const posts = fx.posts();
    const runs = o.deps ? s.svc(o.deps) : s.runs;
    o.knob?.set();
    live.set(runId, { s, runs });
    runs.start({ runId, counterpartyId: s.cp[cp], supply, tax: Math.floor(supply / 10), itemName: '경영 컨설팅', ...o.extra });
    let req: GateRequest | null;
    let end: Extract<RunEvent, { type: 'end' }>;
    try {
      req = o.noGate ? null : await gateFor(s, runId);
      await drive(req, runId, runs);
      end = await endOf(s, runId);
    } catch (e) {
      // 진단: 값 없는 궤적·이벤트·저널 코드만.
      console.error(s.engine, runId, JSON.stringify({ steps: s.traces.get(runId), events: s.events.filter((x) => x.runId === runId), journal: runs.inspect(runId).journal }));
      try {
        runs.stop(runId);
      } catch { /* 커밋 구간 */ }
      await endOf(s, runId).catch(() => {});
      throw e;
    } finally {
      o.knob?.reset();
    }
    live.delete(runId);
    const ins = runs.inspect(runId);
    return {
      status: end.status, code: end.code, approvalNo: !!end.approvalNo, mailConfirmed: end.mailConfirmed, ledger: ins.ledger,
      journal: ins.journal.filter((t) => !JOURNAL_IGNORE[s.engine].has(t) && !t.startsWith('step.')),
      phases: s.events.filter((e) => e.runId === runId && e.type === 'phase' && e.state === 'now').map((e) => (e as { phase: string }).phase),
      posts: fx.posts() - posts,
      gate: req ? req.fields.map((f) => `${f.fieldKey}=${f.value}`) : null,
      closed: s.gateMsgs.filter((m) => m.t === 'gate.closed' && m.runId === runId).map((m) => (m as { reason: string }).reason),
      steps: (s.traces.get(runId) ?? []).filter((id) => !IR_ONLY_STEPS.has(id) && !H01_ONLY_STEPS.has(id)),
    };
  }

  type Drive = (x: { s: Side; req: GateRequest | null; runId: string; runs: RunService }) => Promise<void>;
  async function both(cp: 'A' | 'C', supply: number, drive: Drive, o: Opts = {}): Promise<Record<Engine, Obs>> {
    const out = {} as Record<Engine, Obs>;
    for (const e of ['h01', 'ir'] as const) out[e] = await observe(sides[e], cp, supply, (req, runId, runs) => drive({ s: sides[e], req, runId, runs }), o);
    return out;
  }
  const approve: Drive = async ({ req, runs }) => assert.deepEqual(runs.answer(approval(req!)), { ok: true });

  const same = (o: Record<Engine, Obs>) => {
    const diff = (Object.keys(o.h01) as Array<keyof Obs>).filter((k) => JSON.stringify(o.h01[k]) !== JSON.stringify(o.ir[k]));
    if (diff.length) console.error('golden diff', JSON.stringify(Object.fromEntries(diff.map((k) => [k, { h01: o.h01[k], ir: o.ir[k] }]))));
    assert.deepEqual(diff, [], 'IR ≠ H01');
  };

  it('초안 → 게이트 → 승인 → 발급 → verify → 메일 확인 → 원장 committed', async () => {
    const o = await both('A', 3_300_000, approve);
    same(o);
    assert.deepEqual([o.ir.status, o.ir.ledger, o.ir.posts], ['success', 'committed', 1]);
  });

  it('같은 건 두 번째: 중복 경고($dup.businessKey) 카드 → [중지]하면 발급하지 않는다', async () => {
    const o = await both('A', 3_300_000, async ({ runId, runs }) => assert.deepEqual(runs.stop(runId), { stopped: true }));
    same(o);
    assert.deepEqual([o.ir.status, o.ir.posts, o.ir.ledger], ['stopped', 0, null]);
    assert.ok(o.ir.gate!.includes('$dup.businessKey=committed'));
  });

  it('공급자 사업자번호가 프로필과 다르면 게이트를 열지 않는다(assert.supplier_mismatch)', async () => {
    const o = await both('C', 500_000, async () => {}, { noGate: true, knob: { set: () => (fx.knobs.supplier = { bizNo: '3051288767', name: 'B상사' }), reset: () => (fx.knobs.supplier = SUPPLIER) } });
    same(o);
    assert.deepEqual([o.ir.status, o.ir.code, o.ir.gate], ['failed', 'assert.supplier_mismatch', null]);
  });

  it('작성일자가 의도와 다르면 게이트를 열지 않는다(assert.issue_date_mismatch)', async () => {
    const clock = { wall: () => Date.now() + 86_400_000, mono: () => performance.now() };
    const o = await both('C', 180_000, async () => {}, { noGate: true, deps: { clock } });
    same(o);
    assert.deepEqual([o.ir.status, o.ir.code], ['failed', 'assert.issue_date_mismatch']);
  });

  it('[알려진 차이] 승인 뒤 화면 값이 바뀌면 클릭하지 않는다: 둘 다 원장 not_committed(pre_dispatch_mismatch)·제출 0. H01은 끝내고, IR은 D03대로 게이트 앞 checkpoint(s11)로 돌아간다', async () => {
    const o = await both('C', 700_000, async (x) => {
      await approve(x);
      fx.knobs.mutate = { field: 'splAmt', value: '7000001' };
    }, { knob: { set: () => {}, reset: () => (fx.knobs.mutate = null) } });
    assert.deepEqual([o.h01.status, o.h01.code, o.h01.posts, o.h01.ledger], ['failed', 'pre_dispatch_mismatch', 0, 'not_committed']);
    // IR: 다시 채운 뒤 바뀐 화면 값이 입력과 달라 s19f에서 멈춘다(두 번째 게이트를 열지 않는다).
    assert.deepEqual([o.ir.status, o.ir.code, o.ir.posts, o.ir.ledger], ['failed', 'assert.input_mismatch', 0, 'not_committed']);
    assert.ok(o.ir.journal.includes('checkpoint.reentry'));
    assert.deepEqual(o.ir.gate, o.h01.gate);
    assert.deepEqual(o.ir.steps.slice(0, o.h01.steps.length), o.h01.steps);
    assert.deepEqual(o.ir.closed, o.h01.closed);
  });

  it('발급 요청을 보냈는데 목록에 안 보이면 in_doubt(verify.unknown)', async () => {
    const o = await both('C', 800_000, approve, { knob: { set: () => (fx.knobs.dropIssue = true), reset: () => (fx.knobs.dropIssue = false) } });
    same(o);
    assert.deepEqual([o.ir.status, o.ir.code, o.ir.ledger, o.ir.posts], ['in_doubt', 'verify.unknown', 'in_doubt', 1]);
  });

  it('기준선 조회 중 [중지]: 게이트를 열지 않는다', async () => {
    const o = await both('C', 110_000, async ({ s, runId, runs }) => {
      // 게이트 스텝(s20)에 들어가 기준선 조회(1.5초 지연)를 하는 동안 멈춘다.
      await next(() => (s.traces.get(runId)?.includes('s20') ? true : undefined));
      assert.deepEqual(runs.stop(runId), { stopped: true });
    }, { noGate: true, knob: { set: () => (fx.knobs.lookupDelayMs = 1500), reset: () => (fx.knobs.lookupDelayMs = 0) } });
    same(o);
    assert.deepEqual([o.ir.status, o.ir.gate], ['stopped', null]);
  });

  it('승인 직후(거부 우선 창 2초) [중지]가 이긴다: 제출 없음, 원장 행 없음', async () => {
    const o = await both('C', 120_000, async (x) => {
      await approve(x);
      assert.deepEqual(x.runs.stop(x.runId), { stopped: true });
    });
    same(o);
    assert.deepEqual([o.ir.status, o.ir.code, o.ir.posts, o.ir.ledger], ['stopped', 'gate.stopped', 0, null]);
  });

  it('승인 대기가 waitMs를 넘으면 만료(발급 없음)', async () => {
    const o = await both('C', 140_000, async () => {}, { deps: { gateWaitMs: 400 } });
    same(o);
    assert.deepEqual([o.ir.status, o.ir.code, o.ir.posts], ['expired', 'gate.expired', 0]);
  });

  it('게이트 전 금고 누출 의심: vault.leak_suspected로 끝나고 열린 게이트를 닫는다', async () => {
    const o = await both('C', 160_000, async ({ runs }) => runs.leakSuspected());
    same(o);
    assert.deepEqual([o.ir.status, o.ir.code, o.ir.posts, o.ir.ledger], ['failed', 'vault.leak_suspected', 0, null]);
  });

  it('늦은 반영(최소 경과 뒤)은 committed', async () => {
    const o = await both('C', 150_000, approve, { knob: { set: () => (fx.knobs.reflectDelayMs = 1_500), reset: () => (fx.knobs.reflectDelayMs = 0) } });
    same(o);
    assert.deepEqual([o.ir.status, o.ir.ledger], ['success', 'committed']);
  });

  it('[알려진 차이] 초안에 이메일이 없는데 포털이 주소를 다시 채우면: H01은 그 주소를 승인받아 메일까지 확인하고, IR은 V-03m(팀장 결정 2026-11-06)대로 s19f에서 멈춘다(게이트 없음·제출 0)', async () => {
    const o = await both('A', 123_000, async ({ s, runId, runs }) => {
      if (s.engine === 'h01') assert.deepEqual(runs.answer(approval(await gateFor(s, runId))), { ok: true });
    }, { extra: { email: '' }, knob: { set: () => (fx.knobs.refillEmail = 'late@asangsa.example'), reset: () => (fx.knobs.refillEmail = null) }, noGate: true });
    assert.deepEqual([o.ir.status, o.ir.code, o.ir.posts, o.ir.gate, o.ir.ledger], ['failed', 'assert.input_mismatch', 0, null, null]);
    assert.equal(o.ir.steps.at(-1), 's19d', '입력 대조(s19f, 궤적 비교에서 빼는 IR 전용 스텝)에서 멈췄다');
    assert.deepEqual([o.h01.status, o.h01.mailConfirmed, o.h01.posts], ['success', true, 1]);
    assert.deepEqual(o.ir.steps, o.h01.steps.slice(0, o.ir.steps.length));
  });

  it('[알려진 차이] 명시적 실패 신호 + 부재 증거: 둘 다 원장 not_committed. H01은 실행을 끝내고(s36), IR은 D02 §8대로 s11로 돌아가 다시 게이트를 연다', async () => {
    const o = await both('C', 900_000, async (x) => {
      await approve(x);
      if (x.s.engine === 'ir') {
        // 재게이트: 같은 실행에 두 번째 게이트 요청. 직전 시도 경고가 붙는다. 여기서 [중지]한다.
        const again = await gateFor(x.s, x.runId, 1);
        assert.ok(again.fields.some((f) => f.fieldKey === '$dup.priorNotCommitted' && f.value === 'true'));
        fx.knobs.failIssue = false;
        assert.deepEqual(x.runs.stop(x.runId), { stopped: true });
      }
    }, { knob: { set: () => (fx.knobs.failIssue = true), reset: () => (fx.knobs.failIssue = false) } });
    assert.deepEqual([o.h01.status, o.h01.code, o.h01.ledger, o.h01.posts], ['failed', 'verify.not_committed', 'not_committed', 1]);
    assert.deepEqual([o.ir.status, o.ir.ledger, o.ir.posts], ['stopped', 'not_committed', 1]);
    // 원장 행·제출 횟수·첫 게이트 카드와 s30까지의 궤적은 같다.
    assert.deepEqual(o.ir.gate, o.h01.gate);
    assert.deepEqual(o.ir.steps.slice(0, o.h01.steps.length), o.h01.steps);
  });
});

