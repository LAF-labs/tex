// verify 판정(M2-3, D02 §4.4, D03 §5.6): 기준선 B₀, B₁ \ B₀ 정확히 1건 → committed, 부재 증거가 모두 있을 때만 not_committed, 나머지 unknown.
// 기준은 H01Runner verifyInvoice다(조회 실패 3회 연속 → unknown, 새 건 2건 이상 → unknown, 간격 두 배·상한).
// 조회 하위 플레이북은 가짜 조회 포트가 대신한다. 실제 포털 접속 없음.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  failSignalKeys, judgeVerify, matchingIds, newScope, takeBaseline, verifyHandler, verifyOfIrreversible, VerifyBook, VERIFY_FAILS_IN_A_ROW,
  type LookupRequest, type LookupResult, type LookupRow, type PlaybookIR, type Policy, type StepOf, type VerifyDeps,
} from '@sax/engine/core';
import { FakeClock, FakePage, type FEl } from './core-page-fakes.ts';
import { h01 } from './core-fixtures.ts';

const GOLDEN = h01();
const IR: PlaybookIR = GOLDEN.playbook;
const DICT = GOLDEN.selectors;
const stepOf = <T extends StepOf<'verify'> | StepOf<'gate'>>(id: string) => IR.steps.find((s) => s.id === id) as T;
const S30 = stepOf<StepOf<'verify'>>('s30');
const S33 = stepOf<StepOf<'verify'>>('s33');
const S20 = stepOf<StepOf<'gate'>>('s20');

/** 게이트 앞 readback에 고정된 값(정규화 뒤). */
const RB = { counterpartBizNo: '1234567890', issueDate: '2026-11-06', supplyAmount: '1000000', taxAmount: '100000' };
/** 같은 건의 조회 행(화면 문구, 포털 표기). */
const row = (approvalNo: string, o: Partial<Record<keyof typeof RB, string>> = {}): LookupRow => ({
  counterpartBizNo: '123-45-67890', issueDate: '2026.11.06', supplyAmount: '1,000,000', taxAmount: '100,000원', approvalNo, ...o,
});
const OTHER = row('X-other', { supplyAmount: '999' });

const POLICY: Policy['verify'] = { minElapsedMs: 60_000, lookups: 2, maxMs: 300_000 };

/** 차례대로 결과를 내는 가짜 조회 포트. 비면 마지막 결과를 되풀이한다. 조회마다 시계가 1초 간다(새 탭 조회 시간). */
class ScriptLookup {
  reqs: LookupRequest[] = [];
  private script: Array<LookupResult | (() => LookupResult)>;
  private clock: FakeClock;
  constructor(clock: FakeClock, script: Array<LookupResult | (() => LookupResult)>) {
    this.clock = clock;
    this.script = script;
  }
  async run(req: LookupRequest): Promise<LookupResult> {
    this.reqs.push(req);
    this.clock.t += 1_000;
    const next = this.script.length > 1 ? this.script.shift()! : this.script[0]!;
    return typeof next === 'function' ? next() : next;
  }
}
const rows = (...r: LookupRow[]): LookupResult => ({ ok: true, rows: r });
const failed = (code = 'verify.lookup_failed'): LookupResult => ({ ok: false, code });

/** 실패 신호 요소(원래 탭). */
const ERR_BOX = (o: Partial<FEl> = {}): FEl => ({ id: 'err', role: 'dialog', name: '', css: ['#errorDialog'], text: '발급에 실패했습니다. 다시 시도하세요', ...o });

function mk(script: Array<LookupResult | (() => LookupResult)>, o: { els?: FEl[]; policy?: Policy['verify']; readback?: Record<string, string> } = {}) {
  const clock = new FakeClock();
  clock.t = 1_000_000;
  const page = new FakePage(clock, o.els ?? []);
  const scope = newScope({ inputs: {}, intentId: 'intent-1' });
  for (const [k, v] of Object.entries(o.readback ?? RB)) scope.readback.set(k, v);
  const lookup = new ScriptLookup(clock, script);
  const book = new VerifyBook();
  const d: VerifyDeps = { lookup, book, page, clock, dict: DICT, scope, policy: () => o.policy ?? POLICY };
  /** 기준선을 찍고, 클릭을 보냈다고 기록한다(클릭 직전 실패 신호와 함께). */
  const dispatched = async () => book.markDispatched('s30', clock.now(), await failSignalKeys(page, S30.failSignals ?? []));
  return { clock, page, scope, lookup, book, d, dispatched };
}

describe('verify 기준선 B₀(D02 §4.4 B-07)', () => {
  it('게이트 진입 전: 주 비가역 X(s21)의 verify(s30) 조회로 match에 맞는 승인번호만 모은다. 포털 표기(하이픈·쉼표·원·점 날짜)는 fieldKey 규칙으로 맞춘다', async () => {
    const h = mk([rows(row('A-1'), OTHER, row('', {}), row('A-2', { counterpartBizNo: '999-99-99999' }))]);
    assert.deepEqual(await takeBaseline(h.d, IR, S20), { ok: true });
    assert.deepEqual([...h.book.baseline('s30')!], ['A-1']);
    assert.equal(h.lookup.reqs.length, 1);
    const q = h.lookup.reqs[0]!;
    assert.equal(q.purpose, 'baseline');
    assert.equal(q.playbook, 'hometax.invoice.lookup');
    assert.equal(q.stepId, 's30');
    assert.equal(q.window, 'issueDate');
    assert.deepEqual(q.match, RB, 'match는 $readback 고정 값');
  });

  it('조회 실패 → verify.baseline_missing(게이트를 열지 않는다). 차단 신호면 그 코드. 기준선은 남기지 않는다', async () => {
    const a = mk([failed()]);
    assert.deepEqual(await takeBaseline(a.d, IR, S20), { ok: false, code: 'verify.baseline_missing' });
    assert.equal(a.book.baseline('s30'), undefined);
    const b = mk([failed('portal.blocked')]);
    assert.deepEqual(await takeBaseline(b.d, IR, S20), { ok: false, code: 'portal.blocked' });
    const c = mk([failed()]);
    c.d.lookup = { run: async () => Promise.reject(new Error('tab crashed')) };
    assert.deepEqual(await takeBaseline(c.d, IR, S20), { ok: false, code: 'verify.baseline_missing' }, '포트 예외도 기준선 없음');
  });

  it('match 값이 없으면(readback 미고정) 조회하지 않고 verify.baseline_missing', async () => {
    const h = mk([rows(row('A-1'))], { readback: { counterpartBizNo: '1234567890' } });
    assert.deepEqual(await takeBaseline(h.d, IR, S20), { ok: false, code: 'verify.baseline_missing' });
    assert.equal(h.lookup.reqs.length, 0);
  });

  it('verifyOfIrreversible: s21 → s30. verify가 아닌 스텝·없는 스텝은 null', () => {
    assert.equal(verifyOfIrreversible(IR, 's21')?.id, 's30');
    assert.equal(verifyOfIrreversible(IR, 's20'), null);
    assert.equal(verifyOfIrreversible(IR, 'nope'), null);
  });
});

describe('verify 판정(D02 §4.4, D03 §5.6)', () => {
  it('committed: B₁ \\ B₀가 정확히 1건 → bind($vars.approvalNo), 원장 verify_ref', async () => {
    const h = mk([rows(row('A-1')), rows(row('A-1'), row('B-7'))]);
    await takeBaseline(h.d, IR, S20);
    await h.dispatched();
    assert.deepEqual(await judgeVerify(h.d, S30), { result: 'committed', ref: 'B-7' });
    assert.equal(h.scope.vars.get('approvalNo'), 'B-7');
    assert.equal(h.book.ref('s30'), 'B-7');
    assert.equal(h.lookup.reqs[1]!.purpose, 'verify');
  });

  it('반영이 늦으면 다시 조회한다: 0건 → 0건 → 1건이면 committed(간격 10·20초)', async () => {
    const h = mk([rows(), rows(), rows(), rows(row('B-7'))]);
    await takeBaseline(h.d, IR, S20);
    await h.dispatched();
    assert.deepEqual(await judgeVerify(h.d, S30), { result: 'committed', ref: 'B-7' });
    assert.deepEqual(h.clock.sleeps, [10_000, 20_000]);
  });

  it('새 건이 2건 이상 → 곧바로 unknown(어느 것이 이 실행의 것인지 모른다). bind·verify_ref 없음', async () => {
    const h = mk([rows(), rows(row('B-7'), row('B-8'))]);
    await takeBaseline(h.d, IR, S20);
    await h.dispatched();
    assert.deepEqual(await judgeVerify(h.d, S30), { result: 'unknown' });
    assert.equal(h.lookup.reqs.length, 2);
    assert.equal(h.scope.vars.has('approvalNo'), false);
    assert.equal(h.book.ref('s30'), undefined);
  });

  it('기준선에 있던 건은 새 건이 아니다(포털 기존 건·다른 PC 발급)', async () => {
    const h = mk([rows(row('A-1')), rows(row('A-1')), rows(row('A-1'), row('B-7'))]);
    await takeBaseline(h.d, IR, S20);
    await h.dispatched();
    assert.deepEqual(await judgeVerify(h.d, S30), { result: 'committed', ref: 'B-7' });
  });

  it('not_committed: minElapsedMs 경과 + lookups회 연속 0건 + 클릭 뒤 새로 보인 실패 신호(css·^…$ 문구)가 모두 있을 때만', async () => {
    const box = ERR_BOX({ appearAt: Number.MAX_SAFE_INTEGER });
    const h = mk([rows()], { els: [box] });
    await takeBaseline(h.d, IR, S20);
    await h.dispatched();
    box.appearAt = 0; // 클릭 뒤 오류 대화상자가 떴다
    const t0 = h.clock.now();
    assert.deepEqual(await judgeVerify(h.d, S30), { result: 'not_committed' });
    assert.ok(h.clock.now() - t0 >= 60_000, 'minElapsedMs 전에는 판정하지 않는다');
    assert.ok(h.lookup.reqs.filter((r) => r.purpose === 'verify').length >= 2);
  });

  it('실패 신호가 없으면 0건이 이어져도 not_committed가 아니다: maxMs까지 지수 간격(10·20·40·40…초)으로 조회하고 unknown', async () => {
    const h = mk([rows()]);
    await takeBaseline(h.d, IR, S20);
    await h.dispatched();
    const t0 = h.clock.now();
    assert.deepEqual(await judgeVerify(h.d, S30), { result: 'unknown' });
    assert.ok(h.clock.now() - t0 >= 300_000, 'maxMs(앱 하한 300초)까지');
    assert.deepEqual(h.clock.sleeps.slice(0, 4), [10_000, 20_000, 40_000, 40_000]);
    assert.ok(h.clock.sleeps.every((s) => s <= 40_000));
  });

  it('not_committed 근거가 아닌 실패 신호: 클릭 전부터 있던 것, 숨은 것, 같은 css의 다른 문구(성공 안내)', async () => {
    const before = mk([rows()], { els: [ERR_BOX()] });
    await takeBaseline(before.d, IR, S20);
    await before.dispatched();
    assert.deepEqual(await judgeVerify(before.d, S30), { result: 'unknown' }, '클릭 전부터 보이던 문구');

    const hidden = ERR_BOX({ visible: false });
    const h2 = mk([rows()], { els: [hidden] });
    await takeBaseline(h2.d, IR, S20);
    await h2.dispatched();
    assert.deepEqual(await judgeVerify(h2.d, S30), { result: 'unknown' }, '숨은 오류 상자');

    const ok = ERR_BOX({ appearAt: Number.MAX_SAFE_INTEGER, text: '발급되었습니다' });
    const h3 = mk([rows()], { els: [ok] });
    await takeBaseline(h3.d, IR, S20);
    await h3.dispatched();
    ok.appearAt = 0;
    assert.deepEqual(await judgeVerify(h3.d, S30), { result: 'unknown' }, '문구가 앵커 패턴에 맞지 않음');
  });

  it('조회 실패는 부재 증거가 아니다: 연속 0건을 끊는다(0건·실패·0건은 연속 2회가 아니다)', async () => {
    const box = ERR_BOX({ appearAt: Number.MAX_SAFE_INTEGER });
    // 60초가 지난 뒤 0건 → 실패 → 0건 → 0건: 실패 뒤 다시 두 번 0건이어야 not_committed
    const h = mk([rows(), rows(), rows(), rows(), failed(), rows(), rows()], { els: [box] });
    await takeBaseline(h.d, IR, S20);
    await h.dispatched();
    box.appearAt = 0;
    h.d.policy = () => ({ ...POLICY, minElapsedMs: 0 });
    // 정책 0이어도 플레이북(60초)이 더 엄격하다
    assert.deepEqual(await judgeVerify(h.d, S30), { result: 'not_committed' });
    // 실패가 0건을 끊지 않았다면 5번째 조회(115초)에서 판정했다
    assert.equal(h.lookup.reqs.filter((r) => r.purpose === 'verify').length, 6);
  });

  it(`조회가 ${VERIFY_FAILS_IN_A_ROW}회 연속 실패하면 더 두드리지 않고 unknown`, async () => {
    const h = mk([rows(), failed()]);
    await takeBaseline(h.d, IR, S20);
    await h.dispatched();
    assert.deepEqual(await judgeVerify(h.d, S30), { result: 'unknown' });
    assert.equal(h.lookup.reqs.filter((r) => r.purpose === 'verify').length, VERIFY_FAILS_IN_A_ROW);
  });

  it('차단 신호(portal.blocked)면 곧바로 멈추고 unknown(발급됐는지 모른다)', async () => {
    const h = mk([rows(), failed('portal.blocked')]);
    await takeBaseline(h.d, IR, S20);
    await h.dispatched();
    assert.deepEqual(await judgeVerify(h.d, S30), { result: 'unknown' });
    assert.equal(h.lookup.reqs.filter((r) => r.purpose === 'verify').length, 1);
  });

  it('기준선이 없으면(pre_gate_snapshot인데 찍지 않음: 재시작 뒤 등) 조회하지 않고 unknown', async () => {
    const h = mk([rows(row('B-7'))]);
    assert.deepEqual(await judgeVerify(h.d, S30), { result: 'unknown' });
    assert.equal(h.lookup.reqs.length, 0);
  });

  it('클릭 기록이 없으면(핸드오프 재개 뒤 reverify) 새 실패 신호를 셀 수 없어 not_committed는 나오지 않는다. committed는 된다', async () => {
    const a = mk([rows()], { els: [ERR_BOX()] });
    await takeBaseline(a.d, IR, S20);
    assert.deepEqual(await judgeVerify(a.d, S30), { result: 'unknown' });
    const b = mk([rows(), rows(row('B-7'))]);
    await takeBaseline(b.d, IR, S20);
    assert.deepEqual(await judgeVerify(b.d, S30), { result: 'committed', ref: 'B-7' });
  });

  it('플레이북·정책 중 엄격한 쪽: 정책 lookups 4회가 플레이북 2회를 이기고, 플레이북 minElapsedMs 30초가 정책 0을 이긴다', async () => {
    const s30 = structuredClone(S30);
    s30.lookup.notCommittedPolicy = { minElapsedMs: 30_000, lookups: 2 };
    const box = ERR_BOX({ appearAt: Number.MAX_SAFE_INTEGER });
    const h = mk([rows()], { els: [box], policy: { minElapsedMs: 0, lookups: 4, maxMs: 300_000 } });
    await takeBaseline(h.d, IR, S20);
    await h.dispatched();
    box.appearAt = 0;
    // 조회 시각 1·12·33·74초. 플레이북 값만 보면 33초(3번째, 0건 3회)에서 판정했다. 정책 4회라 4번째에서.
    assert.deepEqual(await judgeVerify(h.d, s30), { result: 'not_committed' });
    assert.equal(h.lookup.reqs.filter((r) => r.purpose === 'verify').length, 4);
    // 정책 minElapsedMs가 0이어도 플레이북 30초: 0건 2회(12초)에서는 판정하지 않는다
    const h2 = mk([rows()], { els: [ERR_BOX({ appearAt: Number.MAX_SAFE_INTEGER })], policy: { minElapsedMs: 0, lookups: 2, maxMs: 300_000 } });
    await takeBaseline(h2.d, IR, S20);
    await h2.dispatched();
    h2.page.els.get('err')!.appearAt = 0;
    assert.deepEqual(await judgeVerify(h2.d, s30), { result: 'not_committed' });
    assert.equal(h2.lookup.reqs.filter((r) => r.purpose === 'verify').length, 3);
  });
});

describe('verify baseline:none(D02 §4.4, 골든 s33 메일 발송 확인)', () => {
  it('앞선 verify의 bind 값($vars.approvalNo)으로 조회: 그 행이 1건이면 committed. 값이 없으면 조회하지 않고 unknown', async () => {
    const h = mk([rows({ approvalNo: 'B-7' }, { approvalNo: 'C-1' })]);
    assert.deepEqual(await judgeVerify(h.d, S33), { result: 'unknown' }, '$vars.approvalNo 없음');
    assert.equal(h.lookup.reqs.length, 0);
    h.scope.vars.set('approvalNo', 'B-7');
    assert.deepEqual(await judgeVerify(h.d, S33), { result: 'committed', ref: 'B-7' });
    const q = h.lookup.reqs[0]!;
    assert.deepEqual([q.playbook, q.window, q.match], ['hometax.invoice.email_status', 'today', { approvalNo: 'B-7' }]);
    assert.equal(h.book.ref('s33'), 'B-7');
  });
});

describe('verify 핸들러(실행 조율기 밖)', () => {
  it('판정 → on[결과]. 판정이 예외면 unknown', async () => {
    const h = mk([rows(), rows(row('B-7'))]);
    await takeBaseline(h.d, IR, S20);
    await h.dispatched();
    assert.deepEqual(await verifyHandler(h.d)(S30, undefined as never), { t: 'jump', to: 's32' });
    const bad = mk([rows()]);
    bad.d.policy = () => {
      throw new Error('boom');
    };
    assert.deepEqual(await verifyHandler(bad.d)(S30, undefined as never), { t: 'jump', to: 'handoff' });
  });

  it('matchingIds: match 키가 하나라도 다르면 빠지고, 승인번호 없는 행은 셀 수 없다', () => {
    assert.deepEqual([...matchingIds(DICT, [row('A'), row('B', { taxAmount: '1' }), row('  ')], RB)], ['A']);
  });
});
