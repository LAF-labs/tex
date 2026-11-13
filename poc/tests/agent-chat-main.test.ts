// 대화 에이전트 main 쪽(apps/desktop/src/agent-chat.ts): 도구 루프·값 공간·슬롯 채우기·진행 표시·오류 문구.
// 엔진 chat.step은 각본 함수(fakeStep)로 대신한다. 포트는 가짜이고, 목록 밖 이름을 읽으면 적어 둔다(준비·발급 길이 없음을 보인다).
import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { CHAT_ADVICE_TEXT, type DomainCall, type ShownReply, type StepParams, type StepResult, type ToolOutput } from '@sax/engine';
import { finalOf, fixJosa } from '../apps/desktop/src/josa.ts';
import { SLOT_FIELDS as MODEL_SLOT_FIELDS, SLOT_PATHS as MODEL_SLOT_PATHS, SLOT_POSITIONS as MODEL_SLOT_POSITIONS } from '@sax/model';
import { CHAT_MAP_IDLE_MS as REDACTION_IDLE_MS } from '@sax/redaction';
import {
  AGENT_ERROR_TEXT,
  AGENT_UNAVAILABLE_TEXT,
  AGENT_SETUP_TEXT,
  AGENT_SLOT_MISSING_TEXT,
  AGENT_STEP_MAX,
  AgentChat,
  CHAT_MAP_IDLE_MS,
  SLOT_FIELDS,
  SLOT_PATHS,
  SLOT_POSITIONS,
  type AgentChatPorts,
  type AgentCounterparty,
  type AgentPhase,
  type DraftCard,
  type IssuedRow,
  type ReceivableRow,
} from '../apps/desktop/src/agent-chat.ts';

const BOOK: AgentCounterparty[] = [
  { id: 'cpA', name: 'A상사', item: '컨설팅' },
  { id: 'cpB', name: 'B상사', item: null },
  { id: 'cpC', name: 'C테크', item: '유지보수' },
];
const ISSUED: IssuedRow[] = [
  { counterpartyId: 'cpA', counterparty: 'A상사', date: '2026-10-15', total: 1_100_000, approvalNo: '20261015-41000012-00000001' },
  { counterpartyId: 'cpB', counterparty: 'B상사', date: '2026-10-20', total: 550_000 },
  { counterpartyId: 'cpA', counterparty: 'A상사', date: '2026-09-03', total: 2_200_000 },
  { counterpartyId: null, counterparty: 'C테크', date: '2026-11-02', total: null },
];
const PORT_KEYS = ['step', 'profileId', 'drafts', 'issued', 'receivables', 'counterparties', 'today', 'onProgress', 'now'];
const DRAFT_KEYS = ['list', 'setupMissing', 'create', 'update', 'discard'];

type Handler = (p: StepParams) => StepResult;
const reply = (r: Partial<ShownReply>): StepResult => ({ kind: 'reply', reply: { kind: 'answer', text: '확인했어요.', show: [], ask: null, filtered: null, values: {}, unknownName: null, ...r } });
const tools = (...calls: DomainCall[]): StepResult => ({ kind: 'tools', calls: calls.map((c, i) => ({ callId: `call-${'abcdefgh'[i]}`, ...c })) });
const outputs = (p: StepParams): ToolOutput[] => {
  assert.ok('continue' in p, 'continue 호출');
  return p.continue.outputs.map((o) => o.output);
};
const frame = (p: StepParams) => {
  assert.ok('start' in p, 'start 호출');
  return p.start.frame;
};

class FakeDrafts {
  cards: DraftCard[] = [];
  creates: unknown[][] = [];
  updates: unknown[][] = [];
  discards: string[] = [];
  setupGap = false;
  setupMissing() {
    return this.setupGap;
  }
  list() {
    return this.cards.map((c) => ({ ...c }));
  }
  create(counterpartyId: string, amount: number, vat: DraftCard['vat'], item: string | null) {
    this.creates.push([counterpartyId, amount, vat, item]);
    if (this.setupGap) return { setup: true as const };
    const runId = `run-${this.cards.length + 1}`;
    this.cards.push({ runId, counterpartyId, amount, vat, item: item ?? BOOK.find((c) => c.id === counterpartyId)!.item, status: 'draft' });
    return { runId };
  }
  update(runId: string, patch: { amount?: number; vat?: DraftCard['vat']; item?: string }) {
    this.updates.push([runId, patch]);
    Object.assign(this.cards.find((c) => c.runId === runId)!, patch);
  }
  discard(runId: string) {
    this.discards.push(runId);
    this.cards.find((c) => c.runId === runId)!.status = 'stopped';
  }
}

/** 목록 밖 이름을 읽으면 strays에 적고 undefined를 준다(던지면 AgentChat이 오류로 접어 가려진다). */
function guarded<T extends object>(o: T, allowed: string[], strays: string[]): T {
  return new Proxy(o, {
    get(t, k, r) {
      if (typeof k === 'string' && !allowed.includes(k)) {
        strays.push(k);
        return undefined;
      }
      const v = Reflect.get(t, k, r);
      return typeof v === 'function' ? v.bind(t) : v;
    },
  });
}

let plan: Handler[];
let sent: StepParams[];
let drafts: FakeDrafts;
let phases: AgentPhase[];
let strays: string[];
let clock: number;
let profile: string | null;
let receivable: ReceivableRow[] | null;

function chat(): AgentChat {
  const ports: AgentChatPorts = {
    step: async (p) => {
      sent.push(structuredClone(p));
      const h = plan.shift();
      assert.ok(h, '각본에 남은 단계가 있다');
      return h(p);
    },
    profileId: () => profile,
    drafts: guarded(drafts, DRAFT_KEYS, strays),
    issued: () => ISSUED,
    receivables: async () => receivable,
    counterparties: () => BOOK,
    today: () => '2026-11-12',
    onProgress: (p) => phases.push(p),
    now: () => clock,
  };
  return new AgentChat(guarded(ports, PORT_KEYS, strays));
}

beforeEach(() => {
  plan = [];
  sent = [];
  drafts = new FakeDrafts();
  phases = [];
  strays = [];
  clock = 1_000_000;
  profile = 'pf-1';
  receivable = null;
});

async function say(a: AgentChat, text: string, ...steps: Handler[]) {
  plan = steps;
  const r = await a.turn(text);
  assert.equal(plan.length, 0, `${text}: 각본을 다 썼다`);
  return r;
}
const agent = (r: Awaited<ReturnType<AgentChat['turn']>>) => {
  assert.equal(r.kind, 'agent', JSON.stringify(r));
  const a = r as Extract<typeof r, { kind: 'agent' }>;
  amountsMatchShown(a);
  return a;
};
const won = (n: number) => `${n.toLocaleString('en-US')}원`;
/**
 * 답 문장의 금액은 같이 보이는 표·카드의 값 가운데 하나다(부장 지시 2026-11-12: 숫자가 틀린 답이 가장 나쁜 실패).
 * 표: 제목의 금액, 행 합계와 그 공급가. 카드: 지금 장부의 카드 금액과 그 공급가·합계.
 */
function amountsMatchShown(r: { text: string; show: Array<{ type: 'card'; runId: string } | { type: 'table'; title: string; rows: Array<{ total: number | null }> }> }) {
  const seen = new Set<string>();
  for (const x of r.show) {
    if (x.type === 'table') {
      for (const m of x.title.matchAll(/[\d,]+원/g)) seen.add(m[0]);
      for (const row of x.rows) if (row.total !== null) for (const v of [row.total, Math.floor((row.total * 10) / 11)]) seen.add(won(v));
    } else {
      const c = drafts.cards.find((d) => d.runId === x.runId);
      if (c?.amount) for (const v of [c.amount, c.amount + Math.floor(c.amount / 10), Math.floor((c.amount * 10) / 11)]) seen.add(won(v));
    }
  }
  for (const m of r.text.matchAll(/[\d,]+원/g)) assert.ok(seen.has(m[0]), `답 금액 ${m[0]}은 같이 보이는 표·카드에 있다: ${[...seen].join(' ')}`);
}

describe('AgentChat 11턴', () => {
  it('표·카드·슬롯이 값 공간에서 채워지고, 모델에 가는 도구 결과에는 숫자·이름이 없다', async () => {
    const a = chat();
    const cp = (id: string) => BOOK.find((c) => c.id === id)!.name;
    let hist = '';

    const t1 = agent(await say(a, '지난달 매출 얼마야', () => tools({ tool: 'sales_summary', monthOffset: -1 }), (p) => reply({ text: '지난달 매출은 {X.count}건, 공급가 합계 {X.sum.supply}, 합계 {X.sum.total}이에요.'.replaceAll('X', outputs(p)[0]!.ref!), show: [outputs(p)[0]!.ref!] })));
    assert.equal(t1.text, '지난달 매출은 2건, 공급가 합계 1,500,000원, 합계 1,650,000원이에요.');
    assert.deepEqual(t1.show, [
      {
        type: 'table',
        table: 'sales',
        title: '10월 발급 2건 · 공급가 1,500,000원 · 합계 1,650,000원',
        rows: [
          { date: '2026-10-20', counterparty: 'B상사', total: 550_000, approvalNo: null, documentId: null, mail: null },
          { date: '2026-10-15', counterparty: 'A상사', total: 1_100_000, approvalNo: '20261015-41000012-00000001', documentId: null, mail: null },
        ],
      },
    ]);
    assert.deepEqual(outputs(sent[1]!), [{ ref: 'r1', status: 'ok', fields: [...SLOT_FIELDS], needs: null }]);

    const t2 = agent(
      await say(
        a,
        'A상사에 세금계산서 끊어줘 110만원',
        () => tools({ tool: 'invoice_draft', counterpartyId: 'cpA', amount: { value: 1_100_000 }, vat: null, item: '컨설팅' }),
        (p) => reply({ kind: 'did', text: '[NAME_1]으로 보낼 카드를 만들었어요.', values: { '[NAME_1]': cp('cpA') }, show: [outputs(p)[0]!.ref!] }),
      ),
    );
    assert.equal(t2.text, 'A상사로 보낼 카드를 만들었어요.', '토큰은 엔진이 준 값으로, 조사는 받침에 맞춰');
    assert.deepEqual(drafts.creates, [['cpA', 1_100_000, null, '컨설팅']]);
    assert.deepEqual(t2.show, [{ type: 'card', runId: 'run-1' }]);
    assert.equal(outputs(sent.at(-1)!)[0]!.status, 'card_shown');

    await say(
      a,
      '아 부가세 별도로',
      (p) => {
        assert.deepEqual(frame(p).cards, [{ ref: 'd2', counterpartyId: 'cpA', amount: true, vat: null, item: true }]);
        return tools({ tool: 'draft_edit', draft: frame(p).cards[0]!.ref, amount: null, vat: 'separate', item: null });
      },
      (p) => {
        assert.deepEqual(outputs(p), [{ ref: 'd2', status: 'card_updated', fields: null, needs: null }]);
        return reply({ kind: 'did', text: '부가세 별도로 확정했어요.' });
      },
    );
    assert.deepEqual(drafts.updates, [['run-1', { vat: 'separate' }]]);

    await say(
      a,
      'A상쓰에 50만 세계 ㄱㄱ',
      () => tools({ tool: 'invoice_draft', counterpartyId: 'cpA', amount: null, vat: null, item: null }),
      (p) => {
        assert.deepEqual(outputs(p), [{ ref: null, status: 'needs_input', fields: null, needs: ['amount'] }]);
        return reply({ kind: 'ask', text: '금액을 알려 주세요.', ask: 'amount' });
      },
    );
    assert.equal(drafts.creates.length, 1, '금액이 없으면 카드를 만들지 않는다');

    const t5 = agent(await say(a, '이거 비용처리 돼?', () => reply({ kind: 'tax_advice', text: CHAT_ADVICE_TEXT, filtered: 'advice' })));
    assert.deepEqual(t5, { kind: 'agent', text: CHAT_ADVICE_TEXT, show: [], ask: null, filtered: 'advice' });

    await say(
      a,
      '아직 못 받은 돈 있어?',
      () => tools({ tool: 'receivables', counterpartyId: null }),
      (p) => {
        assert.deepEqual(outputs(p), [{ ref: null, status: 'not_set_up', fields: null, needs: null }]);
        return reply({ text: '계좌 연결이 아직이라 받을 돈은 볼 수 없어요.' });
      },
    );

    await say(
      a,
      '아까 그거 취소해',
      (p) => tools({ tool: 'draft_discard', draft: frame(p).cards.at(-1)!.ref }),
      (p) => {
        assert.deepEqual(outputs(p), [{ ref: 'd2', status: 'discarded', fields: null, needs: null }]);
        return reply({ kind: 'did', text: '방금 카드를 취소했어요.' });
      },
    );
    assert.deepEqual(drafts.discards, ['run-1']);

    const t8 = agent(await say(a, '다음 주 화요일에 거래처 미팅 잡아줘', (p) => (assert.deepEqual(frame(p).cards, [], '취소한 카드는 프레임에서 빠진다'), reply({ kind: 'cannot', text: '일정은 잡아 드리지 못해요.' }))));
    assert.equal(t8.text, '일정은 잡아 드리지 못해요.');

    const t9 = agent(
      await say(
        a,
        'A상사 마지막으로 언제 발급했지?',
        () => tools({ tool: 'invoice_history', counterpartyId: 'cpA' }),
        (p) => {
          hist = outputs(p)[0]!.ref!;
          return reply({ text: `{${hist}.first.date}에 마지막으로 발급했어요.`, show: [hist] });
        },
      ),
    );
    assert.equal(t9.text, '10월 15일에 마지막으로 발급했어요.');
    assert.deepEqual(t9.show, [
      {
        type: 'table',
        table: 'history',
        title: 'A상사 발급 기록 2건 · 공급가 3,000,000원 · 합계 3,300,000원',
        rows: [
          { date: '2026-10-15', counterparty: 'A상사', total: 1_100_000, approvalNo: '20261015-41000012-00000001', documentId: null, mail: null },
          { date: '2026-09-03', counterparty: 'A상사', total: 2_200_000, approvalNo: null, documentId: null, mail: null },
        ],
      },
    ]);

    const t10 = agent(await say(a, '그때 얼마였어?', () => reply({ text: `그때는 공급가 {${hist}.first.supply}, 합계 {${hist}.first.total}이었어요.` })));
    assert.equal(t10.text, '그때는 공급가 1,000,000원, 합계 1,100,000원이었어요.');
    assert.deepEqual(t10.show.map((x) => x.type === 'table' && x.title), ['A상사 발급 기록 2건 · 공급가 3,000,000원 · 합계 3,300,000원'], '슬롯이 가리키는 표는 모델이 show에 넣지 않아도 보인다');

    // 승인번호 슬롯: 원장 값을 main이 채운다(모델에는 슬롯만). 승인번호가 없는 행이면 지어내지 않고 표를 가리킨다.
    const t10a = agent(await say(a, '승인번호 알려줘', () => reply({ text: `가장 최근 건 승인번호는 {${hist}.first.approvalNo}예요.` })));
    assert.equal(t10a.text, '가장 최근 건 승인번호는 20261015-41000012-00000001이에요.', '조사도 받침에 맞춘다');
    const t10b = agent(await say(a, '맨 처음 건은?', () => reply({ text: `그 건 승인번호는 {${hist}.last.approvalNo}예요.` })));
    assert.equal(t10b.text, AGENT_SLOT_MISSING_TEXT);

    const t11 = agent(
      await say(
        a,
        '같은 금액으로 또 끊어줘',
        () => tools({ tool: 'invoice_draft', counterpartyId: 'cpA', amount: { slot: `{${hist}.first.supply}` }, vat: 'separate', item: '컨설팅' }),
        (p) => reply({ kind: 'did', text: '같은 금액으로 만들었어요.', show: [outputs(p)[0]!.ref!] }),
      ),
    );
    assert.deepEqual(drafts.creates.at(-1), ['cpA', 1_000_000, 'separate', '컨설팅']);
    assert.deepEqual(t11.show, [{ type: 'card', runId: 'run-2' }]);

    const conts = sent.filter((p) => 'continue' in p).map((p) => JSON.stringify(p).replace(/"(?:ref|callId)":"[^"]*"/g, ''));
    assert.equal(conts.length, 8);
    for (const j of conts) {
      assert.ok(!/\d/.test(j), `도구 결과에 숫자가 없다: ${j}`);
      for (const c of BOOK) assert.ok(!j.includes(c.name), `도구 결과에 거래처 이름이 없다: ${c.name}`);
    }
    assert.deepEqual(strays, []);
  });
});

describe('조사 맞추기', () => {
  it('끝소리: 한글 받침, 숫자는 한국어 읽기, 영문은 모름', () => {
    assert.deepEqual(['원', '사', '일', '1', '2', '3', '7', 'C', ''].map(finalOf), ['other', 'none', 'rieul', 'rieul', 'none', 'other', 'rieul', null, null]);
  });
  it('바꾼 값 바로 뒤의 조사만 받침에 맞춘다', () => {
    const cases: Array<[string, string, string]> = [
      ['1,650,000원', '예요.', '이에요.'],
      ['A상사', '이에요.', '예요.'],
      ['3', '이에요', '이에요'],
      ['2', '이에요', '예요'],
      ['1,100,000원', '였어요.', '이었어요.'],
      ['A상사', '이었어요.', '였어요.'],
      ['10월 15일', '으로 바꿨어요', '로 바꿨어요'],
      ['A상사', '으로', '로'],
      ['1,000,000원', '로 할게요', '으로 할게요'],
      ['A상사', '은 ', '는 '],
      ['C테크놀로지', '이 보냈어요', '가 보냈어요'],
      ['1,000,000원', '가 맞아요', '이 맞아요'],
      ['C테크', '을', '를'],
      ['B상사', '과 A상사', '와 A상사'],
      ['A상사', '가게', '가게'],
      ['ABC', '이에요', '이에요'],
      ['A상사', '에 보낼', '에 보낼'],
    ];
    for (const [v, rest, want] of cases) assert.equal(fixJosa(v, rest), want, `${v}+${rest}`);
  });
  it('AgentChat: 슬롯 합계와 거래처 토큰 뒤 조사가 값에 맞는다', async () => {
    const a = chat();
    const t = agent(
      await say(
        a,
        '지난달 매출 얼마야',
        () => tools({ tool: 'sales_summary', monthOffset: -1 }),
        (p) => {
          const r = outputs(p)[0]!.ref!;
          return reply({ text: `공급가 합계는 {${r}.sum.supply}예요. [NAME_2]은 이번에 없어요.`, values: { '[NAME_2]': 'C테크' } });
        },
      ),
    );
    assert.equal(t.text, '공급가 합계는 1,500,000원이에요. C테크는 이번에 없어요.');
  });
});

describe('AgentChat 장부에 없는 거래처(U8-1)', () => {
  it('엔진이 준 이름이 장부에 없으면 안내 문장(조사 맞춤)과 이름을 싣고, 장부에 있는 이름이면 싣지 않는다', async () => {
    const a = chat();
    const r1 = agent(await say(a, '라온상사에 끊어줘', () => reply({ kind: 'ask', text: '어느 거래처인지 알려 주세요.', ask: 'counterparty', unknownName: '라온상사' })));
    assert.deepEqual(r1.unknown, { name: '라온상사', text: '라온상사는 장부에 없는 거래처예요.' });
    const r2 = agent(await say(a, '가온전자 건', () => reply({ kind: 'ask', text: '어느 거래처인지 알려 주세요.', ask: 'counterparty', unknownName: '가온전자' })));
    assert.equal(r2.unknown?.text, '가온전자는 장부에 없는 거래처예요.');
    const r3 = agent(await say(a, '한빛통신 건', () => reply({ kind: 'ask', text: '어느 거래처인지 알려 주세요.', ask: 'counterparty', unknownName: '한빛통신' })));
    assert.equal(r3.unknown?.text, '한빛통신은 장부에 없는 거래처예요.');
    const r4 = agent(await say(a, 'ACME 건', () => reply({ kind: 'ask', text: '어느 거래처인지 알려 주세요.', ask: 'counterparty', unknownName: 'ACME' })));
    assert.equal(r4.unknown?.text, 'ACME은(는) 장부에 없는 거래처예요.', '받침을 모르면 은(는)');
    const r5 = agent(await say(a, 'A상사 건', () => reply({ kind: 'ask', text: '어느 거래처인지 알려 주세요.', ask: 'counterparty', unknownName: 'A상사' })));
    assert.equal(r5.unknown, undefined, '장부에 있는 이름은 안내하지 않는다');
    const r6 = agent(await say(a, '안녕', () => reply({ text: '안녕하세요.' })));
    assert.equal(r6.unknown, undefined);
  });
});

describe('AgentChat 받을 돈·기록 표 제목', () => {
  it('제목의 건수·합계는 슬롯과 같은 집계이고, 금액 모르는 행은 빼고 적는다', async () => {
    receivable = [
      { counterpartyId: 'cpA', counterparty: 'A상사', date: '2026-10-15', total: 1_100_000 },
      { counterpartyId: 'cpB', counterparty: 'B상사', date: '2026-10-20', total: 550_000 },
    ];
    const a = chat();
    const t = agent(
      await say(
        a,
        '아직 못 받은 돈 있어?',
        () => tools({ tool: 'receivables', counterpartyId: null }),
        (p) => {
          const r = outputs(p)[0]!.ref!;
          return reply({ text: `{${r}.count}건, 합계 {${r}.sum.total}이 아직 입금 확인 전이에요.` });
        },
      ),
    );
    assert.equal(t.text, '2건, 합계 1,650,000원이 아직 입금 확인 전이에요.');
    assert.deepEqual(t.show.map((x) => x.type === 'table' && x.title), ['입금 확인 전 2건 · 공급가 1,500,000원 · 합계 1,650,000원']);

    receivable = [...receivable, { counterpartyId: null, counterparty: 'C테크', date: '2026-11-02', total: null }];
    const u = agent(
      await say(
        a,
        '다시 봐 줘',
        () => tools({ tool: 'receivables', counterpartyId: null }),
        (p) => {
          const r = outputs(p)[0]!.ref!;
          return reply({ text: `합계 {${r}.sum.total}이에요.` });
        },
      ),
    );
    assert.equal(u.text, AGENT_SLOT_MISSING_TEXT, '금액 모르는 행이 있으면 합계 슬롯은 채우지 않는다');
    assert.deepEqual(u.show.map((x) => x.type === 'table' && x.title), ['입금 확인 전 3건 · 공급가 1,500,000원 · 합계 1,650,000원(금액 모르는 1건 빼고)']);
  });
});

describe('AgentChat 초안 도구', () => {
  it('준비 중 카드는 not_editable이고 update·discard를 부르지 않는다, 모르는 카드는 no_such_draft', async () => {
    const a = chat();
    await say(
      a,
      'B상사에 30만원 디자인',
      () => tools({ tool: 'invoice_draft', counterpartyId: 'cpB', amount: { value: 300_000 }, vat: null, item: '디자인' }),
      () => reply({ kind: 'did' }),
    );
    drafts.cards[0]!.status = 'preparing';
    await say(
      a,
      '그거 부가세 포함으로 바꾸고 취소해',
      (p) => (assert.deepEqual(frame(p).cards, [], '준비 중 카드는 프레임에 없다'), tools({ tool: 'draft_edit', draft: 'd1', amount: null, vat: 'included', item: null }, { tool: 'draft_discard', draft: 'd1' }, { tool: 'draft_edit', draft: 'd77', amount: null, vat: 'included', item: null })),
      (p) => {
        assert.deepEqual(
          outputs(p).map((o) => [o.ref, o.status]),
          [
            ['d1', 'not_editable'],
            ['d1', 'not_editable'],
            [null, 'no_such_draft'],
          ],
        );
        return reply({ kind: 'cannot', text: '이미 준비 중이라 고칠 수 없어요.' });
      },
    );
    assert.deepEqual(drafts.updates, []);
    assert.deepEqual(drafts.discards, []);
  });

  it('품목이 문장에도 저장 품목에도 없으면 만들지 않고 needs item, 사업장 등록 전이면 setup_missing', async () => {
    const a = chat();
    await say(
      a,
      'B상사에 30만원',
      () => tools({ tool: 'invoice_draft', counterpartyId: 'cpB', amount: { value: 300_000 }, vat: null, item: null }),
      (p) => (assert.deepEqual(outputs(p), [{ ref: null, status: 'needs_input', fields: null, needs: ['item'] }]), reply({ kind: 'ask', ask: 'item' })),
    );
    assert.deepEqual(drafts.creates, []);
    drafts.setupGap = true;
    // 금액·품목이 다 비어 있어도 등록이 빠졌다는 것을 먼저 말한다(묻고 나서 막히지 않게)
    const r = await say(
      a,
      'C테크에 끊어줘',
      () => tools({ tool: 'invoice_draft', counterpartyId: 'cpC', amount: null, vat: null, item: null }),
      (p) => (assert.deepEqual(outputs(p), [{ ref: null, status: 'setup_missing', fields: null, needs: null }]), reply({ kind: 'cannot' })),
    );
    assert.equal(r.kind === 'agent' && r.setup, true, '등록이 빠졌던 턴은 화면이 등록 버튼을 둔다');
    assert.deepEqual(drafts.creates, []);
  });

  it('합계 슬롯으로 만들면 부가세 포함, 날짜 슬롯이나 모르는 결과 슬롯은 금액으로 쓰지 않는다', async () => {
    const a = chat();
    await say(a, 'A상사 기록', () => tools({ tool: 'invoice_history', counterpartyId: 'cpA' }), () => reply({}));
    await say(
      a,
      '그 합계로 끊어줘',
      () =>
        tools(
          { tool: 'invoice_draft', counterpartyId: 'cpA', amount: { slot: '{r1.last.total}' }, vat: null, item: null },
          { tool: 'invoice_draft', counterpartyId: 'cpA', amount: { slot: '{r1.first.date}' }, vat: null, item: null },
          { tool: 'invoice_draft', counterpartyId: 'cpA', amount: { slot: '{r9.first.total}' }, vat: null, item: null },
        ),
      (p) => (assert.deepEqual(outputs(p).map((o) => o.status), ['card_shown', 'needs_input', 'needs_input']), reply({ kind: 'did' })),
    );
    assert.deepEqual(drafts.creates, [['cpA', 2_200_000, 'included', null]]);
  });

  it('초안 포트에는 목록 다섯 메서드뿐이고(준비·발급 없음) AgentChat은 그 밖의 포트 이름을 읽지 않는다', async () => {
    assert.deepEqual(Object.getOwnPropertyNames(FakeDrafts.prototype).filter((k) => k !== 'constructor').sort(), [...DRAFT_KEYS].sort());
    const a = chat();
    await say(
      a,
      '여러 가지',
      () => tools({ tool: 'sales_summary', monthOffset: 0 }, { tool: 'invoice_draft', counterpartyId: 'cpA', amount: { value: 10_000 }, vat: null, item: null }, { tool: 'receivables', counterpartyId: null }),
      (p) => tools({ tool: 'draft_edit', draft: outputs(p)[1]!.ref!, amount: { value: 20_000 }, vat: null, item: '교육' }, { tool: 'draft_discard', draft: outputs(p)[1]!.ref! }),
      () => reply({ kind: 'did' }),
    );
    assert.deepEqual(strays, []);
  });
});

describe('AgentChat 화면 결과', () => {
  it('채울 값이 없는 슬롯이 있으면 문장 전체가 고정 문장이다', async () => {
    const a = chat();
    await say(a, '이번 달 매출', () => tools({ tool: 'sales_summary', monthOffset: 0 }), () => reply({}));
    const r = agent(await say(a, '얼마야', () => reply({ text: '{r1.first.date}에 {r1.first.total}이에요.', show: ['r1'] })));
    assert.equal(r.text, AGENT_SLOT_MISSING_TEXT, '이번 달 C테크 줄은 금액을 모른다');
    assert.equal(r.show.length, 1, '표는 그대로 보인다');
    const r2 = agent(await say(a, '그거', () => reply({ text: '{r5.last.counterparty}예요.' })));
    assert.equal(r2.text, AGENT_SLOT_MISSING_TEXT);
  });

  it('되묻기 칩: 거래처는 장부 이름, 부가세는 별도·포함, 카드 고르기는 열린 카드마다', async () => {
    const a = chat();
    const ask = async (k: NonNullable<ShownReply['ask']>) => agent(await say(a, '음', () => reply({ kind: 'ask', ask: k }))).ask;
    assert.deepEqual(await ask('counterparty'), { kind: 'counterparty', chips: BOOK.map((c) => ({ label: c.name, text: c.name })) });
    assert.deepEqual(await ask('vat'), { kind: 'vat', chips: [{ label: '별도', text: '부가세 별도로' }, { label: '포함', text: '부가세 포함으로' }] });
    drafts.create('cpA', 1_100_000, null, null);
    drafts.create('cpC', 50_000, null, null);
    assert.deepEqual(await ask('which_card'), {
      kind: 'which_card',
      chips: [
        { label: 'A상사 1,100,000원', text: '1번째 카드(A상사 1,100,000원)' },
        { label: 'C테크 50,000원', text: '2번째 카드(C테크 50,000원)' },
      ],
    });
    assert.deepEqual(await ask('amount'), { kind: 'amount', chips: [] });
  });

  it('사업자 프로필이 없으면 엔진을 부르지 않고 고정 안내', async () => {
    profile = null;
    const r = await chat().turn('안녕');
    assert.deepEqual(r, { kind: 'agent', text: AGENT_SETUP_TEXT, show: [], ask: null, filtered: null, setup: true });
    assert.deepEqual(sent, []);
    assert.deepEqual(phases, []);
  });

  it('15분 쉬거나 프로필이 바뀌면 앞 결과·카드 ref를 버리고 번호는 이어 간다', async () => {
    const a = chat();
    await say(a, '기록', () => tools({ tool: 'invoice_history', counterpartyId: null }), () => reply({}));
    drafts.create('cpA', 10_000, null, null);
    clock += CHAT_MAP_IDLE_MS + 1;
    const r = agent(await say(a, '그때 얼마', (p) => (assert.deepEqual(frame(p).cards.map((c) => c.ref), ['d2']), reply({ text: '{r1.first.total}이에요.' }))));
    assert.equal(r.text, AGENT_SLOT_MISSING_TEXT);
    profile = 'pf-2';
    await say(a, '카드', (p) => (assert.deepEqual(frame(p).cards.map((c) => c.ref), ['d3']), reply({})));
  });
});

describe('AgentChat 진행 표시·오류', () => {
  it('생각 중 → 장부 보는 중 → 카드 만드는 중, 같은 단계는 한 번만', async () => {
    const a = chat();
    await say(a, '인사', () => reply({ kind: 'smalltalk' }));
    assert.deepEqual(phases, ['thinking']);
    phases = [];
    await say(
      a,
      '보고 만들어',
      () => tools({ tool: 'sales_summary', monthOffset: -1 }, { tool: 'invoice_history', counterpartyId: null }),
      () => tools({ tool: 'invoice_draft', counterpartyId: 'cpA', amount: { value: 10_000 }, vat: null, item: null }),
      () => reply({ kind: 'did' }),
    );
    assert.deepEqual(phases, ['thinking', 'reading', 'drafting']);
  });

  it('chat.* 오류는 문구·다시 시도로 바꾸고 모르는 오류는 chat.unavailable로 접는다', async () => {
    const cases: Array<[unknown, string, boolean]> = [
      [new Error('chat.unavailable'), 'chat.unavailable', true],
      [new Error('chat.budget_exceeded'), 'chat.budget_exceeded', true],
      [new Error('chat.quota_exceeded'), 'chat.quota_exceeded', false],
      [new Error('chat.secret_rejected'), 'chat.secret_rejected', false],
      [new Error('chat.turn_limit'), 'chat.turn_limit', false],
      [Object.assign(new Error('engine said no'), { code: 'chat.input_too_large' }), 'chat.input_too_large', false],
      [new Error('ECONNRESET 10.0.0.1'), 'chat.unavailable', true],
    ];
    for (const [err, code, retry] of cases) {
      const r = await say(chat(), '아무 말', () => {
        throw err;
      });
      assert.deepEqual(r, { kind: 'unavailable', code, text: AGENT_ERROR_TEXT[code]!.text, retry }, code);
    }
    assert.equal(AGENT_ERROR_TEXT['chat.turn_limit']!.text, '한 번에 하기 어려워요. 나눠서 말씀해 주세요.');
    // 모델 답을 못 받은 경우는 원인을 단정하지 않는다(U8-5): 인터넷·연결 탓 문구가 없다
    for (const c of ['chat.unavailable', 'chat.bad_response', 'chat.bad_tool_output']) {
      assert.equal(AGENT_ERROR_TEXT[c]!.text, AGENT_UNAVAILABLE_TEXT, c);
      assert.equal(AGENT_ERROR_TEXT[c]!.retry, true, c);
    }
    assert.ok(!/인터넷|연결/.test(AGENT_UNAVAILABLE_TEXT));
  });

  it('엔진이 계속 도구를 불러도 한 턴의 chat.step은 상한까지만', async () => {
    const a = chat();
    plan = Array.from({ length: AGENT_STEP_MAX + 3 }, () => () => tools({ tool: 'sales_summary', monthOffset: 0 }));
    const r = await a.turn('계속');
    assert.deepEqual(r, { kind: 'unavailable', code: 'chat.turn_limit', ...AGENT_ERROR_TEXT['chat.turn_limit']! });
    assert.equal(sent.length, AGENT_STEP_MAX);
  });
});

describe('AgentChat 옮겨 둔 상수', () => {
  it('슬롯 칸·위치·쉬는 시간이 @sax/model·@sax/redaction과 같다', () => {
    assert.deepEqual([...SLOT_FIELDS], [...MODEL_SLOT_FIELDS]);
    assert.deepEqual([...SLOT_POSITIONS], [...MODEL_SLOT_POSITIONS]);
    assert.deepEqual([...SLOT_PATHS], [...MODEL_SLOT_PATHS]);
    assert.equal(CHAT_MAP_IDLE_MS, REDACTION_IDLE_MS);
  });
});
