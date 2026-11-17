// 대화로 작성일자·수량×단가(ADR-049): 날짜·곱 계산(chat-core), main 도구 실행(agent-chat), 초안·준비 막음(shell-runs), 엔진 입력 검사(runs).
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { describe, it } from 'node:test';
import { draftDate, issueDateRule, lineSupply, parseQuantity, shortDate, type DomainCall, type StepParams, type StepResult, type ToolOutput } from '@sax/engine';
import { AgentChat, type AgentChatPorts, type DraftCard, type DraftExtraValues, type DraftPatch } from '../apps/desktop/src/agent-chat.ts';
import { ShellRuns } from '../apps/desktop/src/shell-runs.ts';
import { dayOffset, type Counterparty } from '../apps/desktop/src/shell-model.ts';

describe('draftDate·issueDateRule (chat-core)', () => {
  it('달·날 → KST 날짜: 말일·윤년·연 넘김, 둘 다 없으면 오늘(null), 없는 날·모양이 틀리면 bad', () => {
    assert.equal(draftDate('2026-11-17', null, null), null);
    assert.equal(draftDate('2026-11-17', -1, 'last'), '2026-10-31');
    assert.equal(draftDate('2026-11-17', 0, '5'), '2026-11-05');
    assert.equal(draftDate('2026-01-05', -1, 'last'), '2025-12-31');
    assert.equal(draftDate('2028-03-02', -1, 'last'), '2028-02-29');
    assert.equal(draftDate('2027-03-02', -1, '29'), 'bad');
    assert.equal(draftDate('2026-11-17', -1, null), 'bad', '지난달인데 날이 없다');
    assert.equal(draftDate('2026-11-17', 1, '1'), 'bad', '다음 달');
    assert.equal(draftDate('2026-11-17', 0, '2026-11-01'), 'bad', '연월일을 직접 씀');
    assert.equal(draftDate('2026-11-17', null, '3'), '2026-11-03', '달이 없으면 이번 달');
  });
  it('규칙: 미래 거절, 공급한 달 다음 달 10일까지 ok, 그 뒤 late(막지 않음), 확정신고기한(7/25·1/25) 지나면 past_period', () => {
    assert.equal(issueDateRule('2026-11-18', '2026-11-17'), 'future');
    assert.equal(issueDateRule('2026-10-31', '2026-11-10'), 'ok');
    assert.equal(issueDateRule('2026-10-31', '2026-11-11'), 'late');
    assert.equal(issueDateRule('2026-06-30', '2026-07-25'), 'late');
    assert.equal(issueDateRule('2026-06-30', '2026-07-26'), 'past_period');
    assert.equal(issueDateRule('2025-12-31', '2026-01-10'), 'ok');
    assert.equal(issueDateRule('2025-12-31', '2026-01-26'), 'past_period');
  });
  it('수량은 양의 정수만(단위 글자 허용), 곱은 정수·상한 안', () => {
    assert.equal(parseQuantity('10'), 10);
    assert.equal(parseQuantity('10kg'), 10);
    assert.equal(parseQuantity('1,000개'), 1000);
    assert.equal(parseQuantity('1.5'), null);
    assert.equal(parseQuantity('0'), null);
    assert.equal(parseQuantity(null), null);
    assert.equal(lineSupply(10, 12_000), 120_000);
    assert.equal(lineSupply(1e9, 1e9), null);
    assert.equal(shortDate('2026-10-31', '2026-11-17'), '10월 31일');
    assert.equal(shortDate('2025-12-31', '2026-01-05'), '2025년 12월 31일');
  });
});

const BOOK = [{ id: 'cpA', name: 'A상사', item: '원두' }];
class Drafts {
  cards: DraftCard[] = [];
  creates: Array<[string, number, DraftCard['vat'], string | null, DraftExtraValues | undefined]> = [];
  updates: Array<[string, DraftPatch]> = [];
  setupMissing() {
    return false;
  }
  list() {
    return this.cards.map((c) => ({ ...c }));
  }
  create(cp: string, amount: number, vat: DraftCard['vat'], item: string | null, extra?: DraftExtraValues) {
    this.creates.push([cp, amount, vat, item, extra]);
    const runId = `run-${this.cards.length + 1}`;
    this.cards.push({ runId, counterpartyId: cp, amount, vat, item, status: 'draft' });
    return { runId };
  }
  update(runId: string, patch: DraftPatch) {
    this.updates.push([runId, patch]);
  }
  discard() {}
}

/** main 한 턴: 엔진 각본은 도구 호출 하나 → 결과를 받고 끝. 도구 결과를 돌려준다. */
async function run(call: DomainCall, d = new Drafts()): Promise<{ out: ToolOutput; d: Drafts }> {
  let out: ToolOutput | null = null;
  const steps: Array<(p: StepParams) => StepResult> = [
    () => ({ kind: 'tools', calls: [{ callId: 'c1', ...call }] }),
    (p) => {
      out = 'continue' in p ? p.continue.outputs[0]!.output : null;
      return { kind: 'reply', reply: { kind: 'did', text: '했어요.', show: [], ask: null, filtered: null, values: {}, unknownName: null } };
    },
  ];
  const ports: AgentChatPorts = {
    step: async (p) => steps.shift()!(p),
    profileId: () => 'p1',
    drafts: d,
    issued: async () => [],
    receivables: async () => null,
    payables: async () => null,
    cashFlow: async () => null,
    counterparties: () => BOOK,
    today: () => '2026-11-17',
    onProgress: () => {},
  };
  await new AgentChat(ports).turn('x');
  return { out: out!, d };
}
const draft = (o: Partial<Extract<DomainCall, { tool: 'invoice_draft' }>>): DomainCall => ({ tool: 'invoice_draft', counterpartyId: 'cpA', amount: null, vat: null, item: '원두', ...o });

describe('AgentChat: 작성일자·수량×단가', () => {
  it('수량×단가 → 공급가액은 곱, 단가·수량은 카드에 싣는다. 단가 슬롯 total이면 부가세 포함', async () => {
    const { out, d } = await run(draft({ quantity: '10kg', unitPrice: { value: 12_000 } }));
    assert.equal(out.status, 'card_shown');
    assert.deepEqual(d.creates[0], ['cpA', 120_000, null, '원두', { quantity: 10, unitPrice: 12_000 }]);
  });
  it('수량이 소수·단가가 없음·amount와 곱이 다르면 금액을 되묻는다', async () => {
    for (const c of [draft({ quantity: '1.5', unitPrice: { value: 12_000 } }), draft({ quantity: '3' }), draft({ quantity: '3', unitPrice: { value: 10_000 }, amount: { value: 50_000 } })]) {
      const { out, d } = await run(c);
      assert.deepEqual([out.status, out.needs], ['needs_input', ['amount']]);
      assert.equal(d.creates.length, 0);
    }
    const { d } = await run(draft({ quantity: '3', unitPrice: { value: 10_000 }, amount: { value: 30_000 } }));
    assert.equal(d.creates[0]![1], 30_000, '같으면 받는다');
  });
  it('작성일자: 지난달 말일은 writeDate로, 오늘이면 싣지 않고, 미래·없는 날·지난 과세기간은 되묻는다(date)', async () => {
    assert.deepEqual((await run(draft({ amount: { value: 1_000_000 }, date: { monthOffset: -1, day: 'last' } }))).d.creates[0]![4], { writeDate: '2026-10-31' });
    assert.deepEqual((await run(draft({ amount: { value: 1_000_000 }, date: { monthOffset: 0, day: '17' } }))).d.creates[0]![4], {});
    for (const date of [{ monthOffset: 0, day: '20' }, { monthOffset: -2, day: '31' }, { monthOffset: -6, day: '1' }]) {
      const { out, d } = await run(draft({ amount: { value: 1_000_000 }, date }));
      assert.deepEqual([out.status, out.needs], ['needs_input', ['date']], JSON.stringify(date));
      assert.equal(d.creates.length, 0);
    }
  });
  it('고치기: 작성일자만, 수량×단가로 금액까지', async () => {
    const d = new Drafts();
    d.cards.push({ runId: 'run-9', counterpartyId: 'cpA', amount: 100_000, vat: null, item: '원두', status: 'draft' });
    const a = new AgentChat({
      step: (() => {
        const st: Array<(p: StepParams) => StepResult> = [
          () => ({ kind: 'tools', calls: [{ callId: 'c0', ...draft({ amount: { value: 100_000 } }) }] }),
          () => ({ kind: 'reply', reply: { kind: 'did', text: '했어요.', show: [], ask: null, filtered: null, values: {}, unknownName: null } }),
          () => ({ kind: 'tools', calls: [{ callId: 'c1', tool: 'draft_edit', draft: 'd1', amount: null, vat: null, item: null, date: { monthOffset: -1, day: '25' }, quantity: '5', unitPrice: { value: 30_000 } }] }),
          () => ({ kind: 'reply', reply: { kind: 'did', text: '했어요.', show: [], ask: null, filtered: null, values: {}, unknownName: null } }),
        ];
        return async (p: StepParams) => st.shift()!(p);
      })(),
      profileId: () => 'p1',
      drafts: d,
      issued: async () => [],
      receivables: async () => null,
      payables: async () => null,
      cashFlow: async () => null,
      counterparties: () => BOOK,
      today: () => '2026-11-17',
      onProgress: () => {},
    });
    await a.turn('A상사 원두 10만원');
    await a.turn('작성일 지난달 25일로, 5개 3만원으로');
    assert.deepEqual(d.updates.at(-1)![1], { writeDate: '2026-10-25', amount: 150_000, quantity: 5, unitPrice: 30_000 });
  });
});

describe('ShellRuns: 작성일자 카드', () => {
  class Host extends EventEmitter {
    starts: unknown[] = [];
    async control(): Promise<unknown> {
      return {};
    }
    async rpc(m: string, p: unknown): Promise<unknown> {
      if (m === 'run.start') this.starts.push(p);
      return {};
    }
  }
  const CP: Counterparty = { id: 'cpA', name: 'A상사', bizNo: '1234567890', rep: '김', email: 'a@x.kr', item: '원두', status: 'active', checkedOn: '2026-11-01', lastIssuedOn: null };
  const ymd = (d: Date) => d.toISOString().slice(0, 10);
  it('오늘이 아닌 작성일자는 카드에 표시하고 준비를 막는다(작성일자 칸 채우기 전). 채우는 패키지면 run.start에 issueDate를 싣는다', async () => {
    const yesterday = ymd(new Date(Date.parse(`${dayOffset(0)}T00:00:00Z`) - 86_400_000));
    const host = new Host();
    const runs = new ShellRuns(host as never, { counterparties: () => [CP], auth: () => '' });
    const r = runs.createDraft(CP, 120_000, null, '원두', { writeDate: yesterday, quantity: 10, unitPrice: 12_000 });
    assert.deepEqual([r.writeDate, r.writeDateSet, r.issueDateHeld, r.quantity, r.unitPrice], [yesterday, true, true, 10, 12_000]);
    await assert.rejects(runs.prepare(r.id), /issue_date\.not_supported/);
    // 오늘로 되돌리면 표시가 빠지고, 금액만 고치면 수량×단가도 빠진다
    runs.updateDraft(r.id, { writeDate: dayOffset(0), amount: 130_000 });
    assert.deepEqual([r.writeDateSet, r.issueDateHeld, r.quantity], [undefined, false, undefined]);
    const host2 = new Host();
    const fill = new ShellRuns(host2 as never, { counterparties: () => [CP], auth: () => '', issueDateFill: () => true });
    const r2 = fill.createDraft(CP, 120_000, null, '원두', { writeDate: yesterday });
    assert.equal(r2.issueDateHeld, false);
    await fill.prepare(r2.id);
    assert.equal((host2.starts[0] as { issueDate?: string }).issueDate, yesterday);
  });
});
