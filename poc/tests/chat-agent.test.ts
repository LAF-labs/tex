// 대화 에이전트 chat.step(D04 §4 chat_agent): 마스킹 경계(나간 본문에 원문 없음)·도구 결과 구조 검사(C-10)·역치환·답 검사·턴 상한·세션 폐기·오타 별칭.
// 모델은 모의 게이트웨이의 각본 출력, main은 아래 FakePc(카드·조회 결과와 ref를 가진 값 공간)다. 요청은 실제 Egress·응답 어댑터를 지난다.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, beforeEach, describe, it } from 'node:test';
import { CounterpartyRepo, openDatabase, ProfileRepo, syntheticBizNo, type Db } from '@sax/db';
import { CHAT_ADVICE_TEXT, CHAT_AGENT_FALLBACK_TEXT, CHAT_AGENT_INPUT_MAX_BYTES, CHAT_AGENT_NUMBER_TEXT, CHAT_AGENT_TRANSCRIPT_TURNS, ChatAgent, gatewayChatAgentModel, numberShaped, parseKrw, type DomainCall, type ScreenFrame, type StepResult, type ToolOutput } from '@sax/engine';
import { CHAT_AGENT_COMMANDS, COMMANDS, MAIN_ONLY, READ_QUERIES } from '@sax/engine/protocol';
import { BundleCatalog } from '@sax/model';
import { Egress } from '@sax/net';
import { CHAT_MAP_IDLE_MS } from '@sax/redaction';
import { startGatewayMock, type GatewayMock } from './fixtures/gateway-mock.ts';

const root = path.resolve(import.meta.dirname, '..');
const catalog = BundleCatalog.load();
const CPS = [
  { name: 'A상사', bizNo: syntheticBizNo(81), email: 'tax@asangsa.example' },
  { name: 'B상사', bizNo: syntheticBizNo(82), email: 'acc@bsangsa.example' },
  { name: 'C테크', bizNo: syntheticBizNo(83), email: 'fin@ctech.example' },
];
const SECRETS = [...CPS.flatMap((c) => [c.name, c.bizNo, c.email]), 'A상쓰', '바다상회', '110만원', '110만', '50만', '1,100,000', '1100000'];
const FIELDS = ['date', 'supply', 'total', 'counterparty'] as const;

let dir: string;
let db: Db;
let mock: GatewayMock;
let cpId: Record<string, string>;
let profileId: string;
let clock: number;

type Item = Record<string, unknown>;
const fc = (name: string, args: object, id = `call_${randomBytes(3).toString('hex')}`): Item[] => [{ type: 'function_call', call_id: id, name, arguments: JSON.stringify(args) }];
const msg = (o: object): Item[] => [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: JSON.stringify(o) }] }];
const reply = (o: Partial<{ kind: string; text: string; show: string[]; ask: string | null }>) => msg({ kind: 'answer', text: '확인했어요.', show: [], ask: null, ...o });
const userText = (body: Item) => ((body.messages as Array<{ content: Array<{ text: string }> }>)[0]!.content[0]!.text);
/** 이번 문장 줄(사용자: …)만 */
const nowLine = (body: Item) => userText(body).split('[지금]\n')[1]!.split('\n').find((l) => l.startsWith('사용자: '))!;
const lastOutput = (body: Item): ToolOutput | null => {
  const r = (body.replay as Item[] | undefined) ?? [];
  const last = r.at(-1);
  return last && last.type === 'function_call_output' ? (JSON.parse(String(last.output)) as ToolOutput) : null;
};
const toks = (t: string, k: string) => [...t.matchAll(new RegExp(`\\[${k}_\\d+\\]`, 'g'))].map((m) => m[0]);
const responds = () => mock.calls.filter((c) => c.path === '/v1/respond');
/** main이 화면에서 하는 토큰 바꾸기(조사는 main 시험이 본다) */
const shownText = (r: { text: string; values: Record<string, string> }) => r.text.replace(/\[[A-Z]+_\d+\]/g, (t) => r.values[t]!);
const code = (p: Promise<unknown>, c: string) => assert.rejects(p, (e: Error & { code?: string }) => e.code === c, c);

/** 모델 각본: 사용자 턴마다 [첫 호출 출력, 도구 결과를 받은 뒤 출력 …]. 함수는 요청 본문을 받는다. */
let plan: Array<(body: Item) => Item[]> = [];
const script = (...steps: Array<(body: Item) => Item[]>) => {
  plan = steps;
};

/** main 쪽 값 공간 흉내: 카드와 조회 결과, ref. 모델에는 ref·status·fields만 돌려준다. */
class FakePc {
  n = 0;
  drafts: Array<{ ref: string; cp: string; amount: boolean; vat: 'separate' | 'included' | null; item: boolean; open: boolean }> = [];
  calls: DomainCall[] = [];
  frame(): ScreenFrame {
    return { cards: this.drafts.filter((d) => d.open).map((d) => ({ ref: d.ref, counterpartyId: d.cp, amount: d.amount, vat: d.vat, item: d.item })) };
  }
  exec(c: DomainCall): ToolOutput {
    this.calls.push(c);
    const ref = (p: string) => `${p}${++this.n}`;
    switch (c.tool) {
      case 'sales_summary':
      case 'invoice_history':
        return { ref: ref('r'), status: 'ok', fields: [...FIELDS], needs: null };
      case 'receivables':
        return { ref: null, status: 'not_set_up', fields: null, needs: null };
      case 'invoice_draft': {
        const d = { ref: ref('d'), cp: c.counterpartyId, amount: c.amount !== null, vat: c.vat, item: c.item !== null, open: true };
        this.drafts.push(d);
        return { ref: d.ref, status: c.item === null ? 'needs_input' : 'card_shown', fields: null, needs: c.item === null ? ['item'] : null };
      }
      case 'draft_edit': {
        const d = this.drafts.find((x) => x.ref === c.draft && x.open)!;
        if (c.vat) d.vat = c.vat;
        return { ref: d.ref, status: 'card_updated', fields: null, needs: null };
      }
      case 'draft_discard': {
        const d = this.drafts.find((x) => x.ref === c.draft && x.open)!;
        d.open = false;
        return { ref: d.ref, status: 'discarded', fields: null, needs: null };
      }
    }
  }
}

const agent = (now = () => clock) => new ChatAgent(db, { model: gatewayChatAgentModel(new Egress({ env: {}, testOrigins: { gateway: mock.origin }, gateway: { auth: { headers: async () => ({ authorization: 'DPoP device-token', dpop: 'proof' }) }, bundles: catalog.allowEntries() } })), now });

/** 사용자 턴 하나: 도구 호출이면 FakePc가 실행해 이어 간다. */
async function say(a: ChatAgent, pc: FakePc, text: string, pf = profileId) {
  let r: StepResult = await a.step({ start: { text, frame: pc.frame(), profileId: pf } });
  const calls: DomainCall[] = [];
  while (r.kind === 'tools') {
    calls.push(...r.calls);
    r = await a.step({ continue: { outputs: r.calls.map((c) => ({ callId: c.callId, output: pc.exec(c) })) } });
  }
  return { reply: r.reply, calls };
}

before(async () => {
  dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'sax-agent-'));
  db = openDatabase(path.join(dir, 'db.sqlite'), new Uint8Array(randomBytes(32)));
  profileId = new ProfileRepo(db).upsert({ kind: 'business', displayName: '바다상회', bizNo: syntheticBizNo(80), corpNo: null, repName: '박바다', bizType: null, bizItem: null, address: null, email: null, signMethod: null }).id;
  cpId = Object.fromEntries(CPS.map((c) => [c.name, new CounterpartyRepo(db).create(c).id]));
  mock = await startGatewayMock();
  mock.opts = { respondScript: (body) => plan.shift()!(body) };
});
after(async () => {
  await mock.close();
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});
beforeEach(() => {
  mock.calls.length = 0;
  plan = [];
  clock = 1_000_000;
});

describe('chat.step 마스킹 경계(11턴)', () => {
  it('나간 본문에 거래처 원문·오타 이름·사업자번호·이메일·금액이 없고 토큰만 있다, 역치환은 레코드 ID·값·슬롯으로', async () => {
    const a = agent();
    const pc = new FakePc();
    const name = (b: Item) => toks(nowLine(b), 'NAME')[0]!;
    const turns: Array<[string, Array<(b: Item) => Item[]>]> = [
      ['지난달 매출 얼마야', [() => fc('sales_summary', { month_offset: -1 }), (b) => reply({ text: '지난달 발급한 세금계산서 합계예요.', show: [lastOutput(b)!.ref!] })]],
      ['A상사에 세금계산서 끊어줘 110만원', [(b) => fc('invoice_draft', { counterparty: name(b), amount: toks(nowLine(b), 'AMT')[0], vat: null, item: '컨설팅' }), (b) => reply({ kind: 'did', text: `${toks(userText(b), 'NAME').at(-1)}에 보낼 카드를 만들었어요.`, show: [lastOutput(b)!.ref!] })]],
      ['아 부가세 별도로', [(b) => fc('draft_edit', { draft: /카드 (d\d+)/.exec(userText(b))![1], amount: null, vat: 'separate', item: null }), () => reply({ kind: 'did', text: '부가세 별도로 확정했어요.' })]],
      ['A상쓰에 50만 세계 ㄱㄱ', [(b) => fc('invoice_draft', { counterparty: name(b), amount: toks(nowLine(b), 'AMT')[0], vat: null, item: null }), (b) => reply({ kind: 'ask', text: '품목을 알려 주세요.', show: [lastOutput(b)!.ref!], ask: 'item' })]],
      ['이거 비용처리 돼?', [() => reply({ kind: 'tax_advice', text: '' })]],
      ['아직 못 받은 돈 있어?', [() => fc('receivables', { counterparty: null }), () => reply({ text: '계좌 연결이 아직이라 받을 돈은 볼 수 없어요.' })]],
      ['아까 그거 취소해', [(b) => fc('draft_discard', { draft: [...userText(b).matchAll(/카드 (d\d+)/g)].at(-1)![1] }), () => reply({ kind: 'did', text: '방금 카드를 취소했어요.' })]],
      ['다음 주 화요일에 거래처 미팅 잡아줘', [() => reply({ kind: 'cannot', text: '일정은 잡아 드리지 못해요.' })]],
      ['A상사 마지막으로 언제 발급했지?', [(b) => fc('invoice_history', { counterparty: name(b) }), (b) => reply({ text: `{${lastOutput(b)!.ref}.first.date}에 마지막으로 발급했어요.`, show: [lastOutput(b)!.ref!] })]],
      ['그때 얼마였어?', [(b) => reply({ text: `그때는 공급가 {${/보임: (r\d+)\)\n\[지금\]/.exec(userText(b))![1]}.first.supply}이었어요.` })]],
      ['같은 금액으로 또 끊어줘', [(b) => fc('invoice_draft', { counterparty: toks(userText(b), 'NAME')[0], amount: `{${[...userText(b).matchAll(/보임: (r\d+)/g)].at(-1)![1]}.first.supply}`, vat: 'separate', item: '컨설팅' }), (b) => reply({ kind: 'did', text: '같은 금액으로 만들었어요.', show: [lastOutput(b)!.ref!] })]],
    ];
    const out: Array<Awaited<ReturnType<typeof say>>> = [];
    for (const [text, steps] of turns) {
      script(...steps);
      out.push(await say(a, pc, text));
      assert.equal(plan.length, 0, `${text}: 각본을 다 썼다`);
    }

    const bodies = responds().map((c) => JSON.stringify(c.body));
    for (const s of SECRETS) assert.ok(!bodies.some((b) => b.includes(s)), `밖으로 나가지 않는다: ${s}`);
    assert.ok(bodies.some((b) => b.includes('[NAME_')) && bodies.some((b) => b.includes('[AMT_')));
    assert.ok(userText(responds().at(-1)!.body!).startsWith('[앞 대화]\n'));

    assert.deepEqual(out[1]!.calls, [{ callId: out[1]!.calls[0]!.callId, tool: 'invoice_draft', counterpartyId: cpId['A상사'], amount: { value: 1_100_000 }, vat: null, item: '컨설팅' }]);
    assert.equal(shownText(out[1]!.reply), 'A상사에 보낼 카드를 만들었어요.');
    assert.deepEqual(out[2]!.calls.map((c) => c.tool === 'draft_edit' && [c.draft, c.vat]), [['d2', 'separate']]);
    const typo = out[3]!.calls[0]!;
    assert.ok(typo.tool === 'invoice_draft' && typo.counterpartyId === cpId['A상사'] && typo.amount && 'value' in typo.amount && typo.amount.value === 500_000);
    assert.deepEqual(out[4]!.reply, { kind: 'tax_advice', text: CHAT_ADVICE_TEXT, show: [], ask: null, filtered: 'advice', values: {} });
    assert.deepEqual(out[5]!.calls.map((c) => c.tool === 'receivables' && c.counterpartyId), [null]);
    assert.deepEqual(out[6]!.calls.map((c) => c.tool === 'draft_discard' && c.draft), ['d3']);
    assert.equal(out[8]!.reply.text, '{r4.first.date}에 마지막으로 발급했어요.');
    assert.equal(out[9]!.reply.text, '그때는 공급가 {r4.first.supply}이었어요.');
    const again = out[10]!.calls[0]!;
    assert.ok(again.tool === 'invoice_draft' && again.counterpartyId === cpId['A상사']);
    assert.deepEqual(again.amount, { slot: '{r4.first.supply}' });
  });
});

describe('chat.step 도구 결과 경계(C-10)', () => {
  it('키가 더 있거나 숫자 값·자유 문자열 status·다른 종류 ref면 chat.bad_tool_output이고 아무것도 보내지 않는다', async () => {
    const bad: unknown[] = [
      { ref: 'r1', status: 'ok', fields: null, needs: null, rows: 3 },
      { ref: 1, status: 'ok', fields: null, needs: null },
      { ref: 'r1', status: 'ok', fields: [3], needs: null },
      { ref: 'r1', status: 'ok 3건', fields: null, needs: null },
      { ref: 'r1', status: 'ok', fields: ['supply:1100000'], needs: null },
      { ref: 'd1', status: 'ok', fields: null, needs: null },
      { ref: 'r1', status: 'ok', fields: null },
    ];
    const a = agent();
    for (const output of bad) {
      script(() => fc('sales_summary', { month_offset: 0 }), () => reply({}));
      const r = await a.step({ start: { text: '이번 달 매출', frame: { cards: [] }, profileId } });
      assert.equal(r.kind, 'tools');
      const sent = responds().length;
      await code(a.step({ continue: { outputs: [{ callId: r.kind === 'tools' ? r.calls[0]!.callId : '', output: output as ToolOutput }] } }), 'chat.bad_tool_output');
      assert.equal(responds().length, sent, JSON.stringify(output));
    }
  });

  it('호출 ID가 맞지 않거나 진행 중인 턴이 없으면 chat.bad_tool_output, 화면 프레임에 값이 섞여도 같다', async () => {
    const a = agent();
    const ok: ToolOutput = { ref: 'r1', status: 'ok', fields: null, needs: null };
    await code(a.step({ continue: { outputs: [{ callId: 'x', output: ok }] } }), 'chat.bad_tool_output');
    script(() => fc('sales_summary', { month_offset: 0 }));
    await a.step({ start: { text: '이번 달 매출', frame: { cards: [] }, profileId } });
    await code(a.step({ continue: { outputs: [{ callId: 'other', output: ok }] } }), 'chat.bad_tool_output');
    const card = { ref: 'd1', counterpartyId: cpId['A상사']!, amount: true, vat: null, item: false };
    for (const frame of [{ cards: [{ ...card, amount: 1_100_000 }] }, { cards: [{ ...card, note: 'A상사' }] }, { cards: [{ ...card, counterpartyId: 'nope' }] }]) {
      await code(a.step({ start: { text: '안녕', frame: frame as unknown as ScreenFrame, profileId } }), 'chat.bad_tool_output');
    }
    assert.equal(responds().length, 1);
  });
});

describe('chat.step 역치환', () => {
  it('모르는 토큰·두 레코드가 섞인 토큰·내 프로필 토큰이면 main에 가지 않고 엔진이 unknown_counterparty로 답한다', async () => {
    const a = agent();
    for (const counterparty of ['[NAME_99]', '[NAME_1] [NAME_3]', '바다상회']) {
      let seen: ToolOutput | null = null;
      script(
        (b) => fc('invoice_history', { counterparty: counterparty === '바다상회' ? toks(nowLine(b), 'NAME')[0] : counterparty }),
        (b) => ((seen = lastOutput(b)), reply({ kind: 'ask', text: '어느 거래처인지 알려 주세요.', ask: 'counterparty' })),
      );
      const text = counterparty === '바다상회' ? '바다상회 발급 기록' : 'A상사 B상사 기록';
      const r = await a.step({ start: { text, frame: { cards: [] }, profileId } });
      assert.equal(r.kind, 'reply', String(counterparty));
      assert.deepEqual(seen, { ref: null, status: 'unknown_counterparty', fields: null, needs: null });
    }
  });

  it('금액 토큰은 원 단위 정수로, 슬롯은 그대로, 모르는 슬롯·지어낸 금액은 chat.bad_response', async () => {
    for (const [s, n] of [['110만원', 1_100_000], ['1,100,000원', 1_100_000], ['50만', 500_000], ['3백만', 3_000_000], ['1억 2천', 120_000_000], ['1억 2천만원', 120_000_000], ['1.5억', 150_000_000], ['삼백삼십만원', 3_300_000], ['50만 3천원', 503_000], ['만원', 10_000]] as const) assert.equal(parseKrw(s), n, s);
    for (const s of ['', '원', '1만 2억', '3건', '1.2.3만']) assert.equal(parseKrw(s), null, s);
    const a = agent();
    for (const amount of ['{r1.first.supply}', '1100000', '[AMT_9]']) {
      script(() => fc('invoice_draft', { counterparty: '[NAME_1]', amount, vat: null, item: null }));
      await code(a.step({ start: { text: 'A상사에 끊어줘', frame: { cards: [] }, profileId } }), 'chat.bad_response');
    }
  });
});

describe('chat.step 답 검사', () => {
  const one = async (a: ChatAgent, o: Parameters<typeof reply>[0], text = 'A상사 어때?') => {
    script(() => reply(o));
    return (await say(a, new FakePc(), text)).reply;
  };

  it('tax_advice·세무 판단 말은 고정 문구, 숫자 식별자·이메일·링크는 고정 안내', async () => {
    const a = agent();
    assert.deepEqual(await one(a, { kind: 'tax_advice', text: '경비 처리돼요' }), { kind: 'tax_advice', text: CHAT_ADVICE_TEXT, show: [], ask: null, filtered: 'advice', values: {} });
    assert.equal((await one(a, { text: '그 비용은 경비로 처리하시면 돼요.' })).filtered, 'advice');
    for (const t of ['사업자번호 214-86-51233로 보낼게요.', 'tax@other.example로 보내 주세요.', 'https://evil.example 에서 확인하세요.', '인증서 비밀번호를 입력하세요.']) {
      const r = await one(a, { text: t });
      assert.deepEqual([r.text, r.filtered], [CHAT_AGENT_FALLBACK_TEXT, 'unsafe'], t);
    }
  });

  it('모르는 토큰·모르는 ref·틀린 슬롯·200자 초과는 chat.bad_response', async () => {
    const a = agent();
    for (const o of [{ text: '[NAME_77]에 만들었어요.' }, { text: '확인했어요.', show: ['r9'] }, { text: '{r1.first.amount}예요.' }, { text: '{r1.first.supply}예요.' }, { text: '{oops}' }, { text: '가'.repeat(201) }]) {
      script(() => reply(o));
      await code(a.step({ start: { text: '안녕', frame: { cards: [] }, profileId } }), 'chat.bad_response');
    }
  });

  it('합계·건수는 집계 슬롯, 슬롯·토큰 밖 숫자가 있으면 문장을 버리고 표는 둔다, 슬롯 안 공백은 붙인다, 금액 인자는 돈 칸 슬롯만', async () => {
    const a = agent();
    const pc = new FakePc();
    script(() => fc('sales_summary', { month_offset: -1 }), (b) => reply({ text: '지난달 매출은 {X.count}건, 합계 { X.sum.total }예요.'.replaceAll('X', lastOutput(b)!.ref!), show: [lastOutput(b)!.ref!] }));
    const r1 = (await say(a, pc, '지난달 매출 얼마야')).reply;
    const ref = r1.show[0]!;
    assert.deepEqual([r1.text, r1.filtered], [`지난달 매출은 {${ref}.count}건, 합계 {${ref}.sum.total}예요.`, null]);
    // 실제 모델이 첫 행 합계를 매출 합계라고 쓴 일(real-run-2): 숫자를 직접 쓰면 문장을 버리고 표만 남긴다
    script(() => reply({ text: '합계는 1,210,000원이에요.', show: [ref] }));
    const r2 = (await say(a, pc, '합계 다시 말해 줘')).reply;
    assert.deepEqual([r2.text, r2.show, r2.filtered], [CHAT_AGENT_NUMBER_TEXT, [ref], 'number']);
    script(() => reply({ text: '지난달에 2건이에요.' }));
    const r3 = (await say(a, pc, '몇 건이야')).reply;
    assert.deepEqual([r3.text, r3.show, r3.filtered], [CHAT_AGENT_FALLBACK_TEXT, [], 'number']);
    for (const amount of [`{${ref}.count}`, `{${ref}.first.date}`]) {
      script(() => fc('invoice_draft', { counterparty: '[NAME_1]', amount, vat: null, item: null }));
      await code(a.step({ start: { text: 'A상사에 같은 금액으로', frame: pc.frame(), profileId } }), 'chat.bad_response');
    }
    script(() => fc('invoice_draft', { counterparty: '[NAME_1]', amount: `{${ref}.sum.supply}`, vat: 'separate', item: '컨설팅' }), () => reply({ kind: 'did', text: '만들었어요.' }));
    const r4 = await say(a, pc, 'A상사에 지난달 합계만큼');
    assert.deepEqual(r4.calls.map((c) => c.tool === 'invoice_draft' && c.amount), [{ slot: `{${ref}.sum.supply}` }]);
  });

  it('거래처 토큰은 지금 장부 이름으로 보인다(이름을 바꾸면 바뀐 이름), 대화록에는 토큰 그대로 남는다', async () => {
    const a = agent();
    script((b) => reply({ text: `${toks(nowLine(b), 'NAME')[0]}에 보낼까요?` }));
    assert.equal(shownText((await say(a, new FakePc(), 'C테크 어때?')).reply), 'C테크에 보낼까요?');
    new CounterpartyRepo(db).update(cpId['C테크']!, { name: 'C테크놀로지' });
    try {
      let tok = '';
      script((b) => ((tok = /앱: (\[NAME_\d+\])에/.exec(userText(b))![1]!), reply({ text: `${tok} 맞아요.` })));
      assert.equal(shownText((await say(a, new FakePc(), '어디라고?')).reply), 'C테크놀로지 맞아요.');
      assert.ok(!responds().some((c) => JSON.stringify(c.body).includes('C테크')));
    } finally {
      new CounterpartyRepo(db).update(cpId['C테크']!, { name: 'C테크' });
    }
  });
});

describe('chat.step 턴 상한·세션 폐기', () => {
  it('턴 상한에서도 도구를 부르면 chat.turn_limit, 그 도구는 main에 가지 않는다', async () => {
    const a = agent();
    const pc = new FakePc();
    const call = () => fc('sales_summary', { month_offset: 0 });
    script(call, call, call, call);
    let r = await a.step({ start: { text: '매출 계속 봐 줘', frame: { cards: [] }, profileId } });
    for (let i = 0; i < 2; i++) {
      assert.equal(r.kind, 'tools');
      r = await a.step({ continue: { outputs: r.kind === 'tools' ? r.calls.map((c) => ({ callId: c.callId, output: pc.exec(c) })) : [] } });
    }
    assert.equal(r.kind, 'tools');
    await code(a.step({ continue: { outputs: r.kind === 'tools' ? r.calls.map((c) => ({ callId: c.callId, output: pc.exec(c) })) : [] } }), 'chat.turn_limit');
    assert.equal(responds().length, 4);
    assert.equal(pc.calls.length, 3);
  });

  it('15분 쉬거나 프로필을 바꾸면 대화록·토큰을 버린다(다음 요청에 앞 대화가 없다)', async () => {
    const a = agent();
    const pc = new FakePc();
    const ok = () => reply({});
    const hasPast = () => userText(responds().at(-1)!.body!).startsWith('[앞 대화]');
    script(ok);
    await say(a, pc, 'A상사 안녕');
    script(ok);
    await say(a, pc, '또 안녕');
    assert.ok(hasPast());
    clock += CHAT_MAP_IDLE_MS + 1;
    script(ok);
    await say(a, pc, '다시 왔어');
    assert.ok(!hasPast(), 'idle');
    script(ok);
    await say(a, pc, '한 번 더');
    assert.ok(hasPast());
    script(ok);
    await say(a, pc, '개인으로', 'pf-personal');
    assert.ok(!hasPast(), 'profile switch');
    assert.equal(mock.calls.filter((c) => c.path === '/v1/run-tokens').length, 3, '세션마다 실행 토큰 하나');
  });

  it('대화록은 최근 12턴, 입력 상한 안으로 오래된 턴부터 버린다', async () => {
    const a = agent();
    const pc = new FakePc();
    for (let i = 0; i < 16; i++) {
      script(() => reply({ text: '네'.repeat(150) }));
      await say(a, pc, `${i}번째 이야기 ${'가'.repeat(120)}`);
    }
    const last = userText(responds().at(-1)!.body!);
    assert.ok(Buffer.byteLength(last, 'utf8') <= CHAT_AGENT_INPUT_MAX_BYTES);
    const past = last.match(/^사용자: /gm)!.length - 1;
    assert.ok(past >= 1 && past <= 12, String(past));
    assert.match(last, /15번째 이야기/);
  });

  it('비밀 값 문장은 보내지 않는다(chat.secret_rejected)', async () => {
    await code(agent().step({ start: { text: '비밀번호는 abcd1234야', frame: { cards: [] }, profileId } }), 'chat.secret_rejected');
    assert.equal(responds().length, 0);
  });
});

describe('chat.step 오타 거래처 별칭', () => {
  it('두 거래처에 다 가까운 낱말은 별칭으로 올리지 않고 오류도 없다', async () => {
    const a = agent();
    script(() => reply({ kind: 'ask', text: '어느 거래처인지 알려 주세요.', ask: 'counterparty' }));
    const r = await say(a, new FakePc(), 'D상사에 끊어줘');
    assert.equal(r.reply.kind, 'ask');
    assert.match(nowLine(responds().at(-1)!.body!), /사용자: D상사에 끊어줘/);
  });
});

describe('protocol·entry 배선', () => {
  it('chat.step은 main 전용 목록이고 entry가 ChatAgent로 보낸다', () => {
    assert.deepEqual([...CHAT_AGENT_COMMANDS], ['chat.step']);
    const others = new Set<string>([...READ_QUERIES, ...COMMANDS, ...MAIN_ONLY]);
    assert.ok(!others.has('chat.step'));
    const entry = fs.readFileSync(path.join(root, 'packages/engine/src/entry.ts'), 'utf8');
    assert.match(entry, /chatAgent = new ChatAgent\(db, \{ model: gatewayChatAgentModel\(egress\) \}\);/);
    assert.match(entry, /if \(CHAT_AGENT\.has\(method\)\) \{\n\s+if \(!chatAgent\) throw new Error\('db_not_ready'\);\n\s+return chatAgent\.handle\(method, params\);/);
  });

  it('엔진 모듈은 로그를 남기지 않는다', () => {
    assert.doesNotMatch(fs.readFileSync(path.join(root, 'packages/engine/src/chat-agent.ts'), 'utf8'), /\blog\.|console\.|journal\(/);
  });
});

// PR #296 독립 판정(mid-verify/pr-296-final.md) 반영: ① 답 숫자 필터 우회, ② 대화 경로 원문 반복 송신, ③ 대화록 12턴 자르기.
// 이 묶음은 장부에 거래처를 더하므로 파일 맨 끝에 둔다(앞 시험의 토큰 번호를 바꾸지 않게).
describe('PR #296 판정 반영', () => {
  before(() => {
    const repo = new CounterpartyRepo(db);
    cpId['LAF테크'] = repo.create({ name: 'LAF테크', bizNo: syntheticBizNo(84), repName: '김철수' }).id;
    cpId['한빛 전자'] = repo.create({ name: '한빛 전자', bizNo: syntheticBizNo(85) }).id;
  });

  it('① 답 숫자 규칙: 전각·아랍-인도·원문자 숫자, 한글·한자 수, 고유어 건수, 달 이름도 숫자다. 낱말 속 글자는 아니다', () => {
    for (const t of ['합계는 １，２１０，０００원이에요.', '합계는 ١٢١٠٠٠٠원이에요.', '합계는 ①②③원이에요.', '합계는 백이십일만 원이에요.', '합계는 일백이십일만원이에요.', '합계는 一百二十一万원이에요.', '합계는 百万원이에요.', '모두 두 건이에요.', '모두 열한 건이에요.', '마지막 발급은 시월 십오일이에요.', '오십만으로 만들었어요.', '이백만 원이에요.'])
      assert.equal(numberShaped(t), true, t);
    for (const t of ['카드를 만들었어요.', '천천히 확인해 주세요.', '이 건은 발급했어요.', '일정은 잡아 드리지 못해요.', '이번 달 매출이에요.', '한 장 더 만들었어요. 앞 카드와 따로예요.', '사업자 정보를 등록해 주세요.', '오늘 발급했어요.', '만약 다르면 말씀해 주세요.', '지난번과 같은 금액으로 카드를 만들었어요.', '방금 만든 카드를 취소했어요.', '부가세 별도로 확정했어요. 공급가에 세액을 더한 금액으로 바뀌었어요.'])
      assert.equal(numberShaped(t), false, t);
  });

  it('① 우회 문장은 chat.step 답에서 filtered number가 되고 문장은 엔진 고정 문구, 표는 그대로', async () => {
    const a = agent();
    for (const text of ['합계는 １，２１０，０００원이에요.', '합계는 백이십일만 원이에요.', '합계는 一百二十一万원이에요.', '모두 두 건이에요.', '마지막 발급은 시월 십오일이에요.', '합계는 ①②③원이에요.']) {
      let ref = '';
      script(
        () => fc('sales_summary', { month_offset: -1 }),
        (b) => ((ref = lastOutput(b)!.ref!), reply({ text, show: [ref] })),
      );
      const r = await say(a, new FakePc(), '지난달 매출 얼마야');
      assert.deepEqual([r.reply.filtered, r.reply.text, r.reply.show], ['number', CHAT_AGENT_NUMBER_TEXT, [ref]], text);
    }
  });

  // 판정 ATK-1: 원래 규칙이 놓치던 것이 대화록·도구 왕복으로 매 호출 다시 나갔다. 공격 문장 7개(+같은 갈래)를 세 턴 보내 세 본문 모두에 원문이 없음을 본다.
  const ATTACKS: Array<[string, string]> = [
    ['a상사에 끊어줘', 'a상사'],
    ['A 상사에 끊어줘', 'A 상사'],
    ['LAF 테크 발급 기록', 'LAF 테크'],
    ['laf테크 발급 기록', 'laf테크'],
    ['한빛  전자 발급 기록', '한빛'],
    ['김 철수 대표한테', '김 철수'],
    ['a상쓰에 끊어줘', 'a상쓰'],
    ['A상사에 1100000 끊어줘', '1100000'],
    ['A상사에 550000', '550000'],
    ['A상사 공급가 99999', '99999'],
    ['A상사에 오십만 끊어줘', '오십만'],
    ['A상사에 이백만', '이백만'],
    ['사업자 123/45/67890 확인', '67890'],
    ['사업자 123_45_67890 확인', '67890'],
  ];
  for (const [text, raw] of ATTACKS) {
    it(`② 대화록 재전송에도 원문이 없다: ${text}`, async () => {
      const a = agent();
      const pc = new FakePc();
      const n0 = responds().length;
      for (const t of [text, '응', '그래']) {
        script(() => reply({ text: '알겠어요.' }));
        await say(a, pc, t);
      }
      const bodies = responds().slice(n0);
      assert.equal(bodies.length, 3);
      for (const b of bodies) assert.ok(!JSON.stringify(b.body).includes(raw), `${raw} 원문이 나갔다: ${userText(b.body!)}`);
    });
  }

  it('② 가린 변형도 도구 인자로 풀린다: a상사 → A상사 레코드, 550000·오십만 → 원 단위 금액. 도구 왕복 본문에도 원문이 없다', async () => {
    const a = agent();
    const pc = new FakePc();
    const n0 = responds().length;
    for (const [text, cp, amount] of [['a상사에 550000 끊어줘', 'A상사', 550_000], ['LAF 테크에 오십만 끊어줘', 'LAF테크', 500_000]] as const) {
      script(
        (b) => fc('invoice_draft', { counterparty: toks(nowLine(b), 'NAME')[0], amount: toks(nowLine(b), 'AMT')[0], vat: null, item: '컨설팅' }),
        () => reply({ kind: 'did', text: '카드를 만들었어요.' }),
      );
      const r = await say(a, pc, text);
      assert.deepEqual(r.calls.map((c) => c.tool === 'invoice_draft' && [c.counterpartyId, c.amount]), [[cpId[cp], { value: amount }]], text);
    }
    for (const b of responds().slice(n0)) for (const raw of ['a상사', '550000', 'LAF 테크', '오십만']) assert.ok(!JSON.stringify(b.body).includes(raw), raw);
  });

  it(`③ 대화록은 최근 ${CHAT_AGENT_TRANSCRIPT_TURNS}턴만 다시 보낸다(짧은 문장이라 바이트 상한과 상관없이)`, async () => {
    const a = agent();
    const pc = new FakePc();
    const words = ['사과', '배', '감', '귤', '포도', '수박', '참외', '딸기', '복숭아', '자두', '살구', '앵두', '오디', '모과'];
    for (const w of words) {
      script(() => reply({ text: '네' }));
      await say(a, pc, `${w} 이야기`);
    }
    const last = userText(responds().at(-1)!.body!);
    const past = last.split('[지금]')[0]!;
    assert.equal(past.match(/^사용자: /gm)?.length, CHAT_AGENT_TRANSCRIPT_TURNS);
    assert.ok(!past.includes('사용자: 사과 이야기'), '13턴 전 문장은 빠진다');
    assert.ok(past.includes('사용자: 배 이야기') && past.includes('사용자: 오디 이야기'));
    assert.match(nowLine(responds().at(-1)!.body!), /모과 이야기/);
  });
});

// PR #296 r2 판정(mid-verify/pr-296-final-r2.md) 반영: 앞이 같은 두 거래처 오인, 이메일 조각, 띄어 쓰거나 끊어 쓴 금액, 답의 "만 원"·달 이름.
// 이 묶음도 장부에 거래처를 더하므로 파일 맨 끝에 둔다.
describe('PR #296 r2 판정 반영', () => {
  before(() => {
    cpId['A상사몰'] = new CounterpartyRepo(db).create({ name: 'A상사몰', bizNo: syntheticBizNo(86) }).id;
  });

  /** 문장 하나를 보내고 모델이 첫 NAME·AMT 토큰으로 카드를 만들게 한다. 풀린 거래처 이름(엔진이 되물으면 null)과 금액. */
  async function drafted(a: ChatAgent, pc: FakePc, text: string) {
    script(
      (b) => fc('invoice_draft', { counterparty: toks(nowLine(b), 'NAME')[0] ?? '없음', amount: toks(nowLine(b), 'AMT')[0] ?? null, vat: null, item: '컨설팅' }),
      () => reply({ kind: 'did', text: '카드를 만들었어요.' }),
    );
    const r = await say(a, pc, text);
    const c = r.calls.find((x) => x.tool === 'invoice_draft');
    return { cp: c && c.tool === 'invoice_draft' ? Object.entries(cpId).find(([, id]) => id === c.counterpartyId)![0] : null, amount: c && c.tool === 'invoice_draft' ? c.amount : null };
  }

  const PREFIX: Array<[string, string | null]> = [
    ['A상사에 550000 끊어줘', 'A상사'],
    ['A상사도 550000 끊어줘', 'A상사'],
    ['A상사랑 550000 끊어줘', 'A상사'],
    ['A상사한테 550000 끊어줘', 'A상사'],
    ['A상사에서 받은 550000 끊어줘', 'A상사'],
    ['A상사 에 550000 끊어줘', 'A상사'],
    ['a상사에 550000 끊어줘', 'A상사'],
    ['A상사몰에 550000 끊어줘', 'A상사몰'],
    ['a상사몰에 550000 끊어줘', 'A상사몰'],
    ['A 상사 몰에 550000 끊어줘', 'A상사몰'],
    ['A상사 몰에 550000 끊어줘', 'A상사몰'],
    ['A상사  몰에 550000 끊어줘', 'A상사몰'],
    ['B상사에 550000 끊어줘', 'B상사'],
    ['A상사물에 550000 끊어줘', null],
  ];
  for (const [text, want] of PREFIX) {
    it(`앞이 같은 거래처(A상사·A상사몰): ${text} → ${want ?? '되묻기'}`, async () => {
      const got = await drafted(agent(), new FakePc(), text);
      assert.equal(got.cp, want);
      if (want) assert.deepEqual(got.amount, { value: 550_000 });
      const line = nowLine(responds()[0]!.body!);
      assert.ok(!/상사|몰/.test(line), `거래처 원문이 나갔다: ${line}`);
    });
  }

  it('앞이 같은 거래처: 같은 세션에서 차례가 바뀌어도 각자 제 거래처로 풀린다', async () => {
    const a = agent();
    const pc = new FakePc();
    const got: Array<string | null> = [];
    for (const text of ['a상사에 550000 끊어줘', 'a상사몰에 550000 끊어줘', 'A상사에 550000 끊어줘', 'A 상사 몰에 550000 끊어줘']) got.push((await drafted(a, pc, text)).cp);
    assert.deepEqual(got, ['A상사', 'A상사몰', 'A상사', 'A상사몰']);
  });

  const EMAILS = ['tax at asangsa.example 로 보내', 'tax @ asangsa.example', 'tax (at) asangsa (dot) example', 'asangsa.example 로 보내', 'tax@asangsa,example', 'TAX@asangsa.EXAMPLE 로 보내', 'tax＠asangsa.example'];
  for (const text of EMAILS) {
    it(`장부 이메일 조각도 가린다(대화록 재전송 포함): ${text}`, async () => {
      const a = agent();
      const pc = new FakePc();
      for (const t of [text, '응', '그래']) {
        script(() => reply({ text: '알겠어요.' }));
        await say(a, pc, t);
      }
      for (const b of responds()) {
        assert.ok(!JSON.stringify(b.body).toLowerCase().includes('asangsa'), userText(b.body!));
        assert.ok(!/\btax\b/i.test(userText(b.body!)), userText(b.body!));
      }
    });
  }

  const AMOUNTS: Array<[string, string, number]> = [
    ['A상사에 550 000 끊어줘', '550', 550_000],
    ['A상사에 550 000원 끊어줘', '550', 550_000],
    ['A상사에 55 0000 끊어줘', '55', 550_000],
    ['A상사에 550.000 끊어줘', '550', 550_000],
    ['A상사에 1 100 000원 끊어줘', '100', 1_100_000],
    ['A상사에 오십 만 끊어줘', '오십', 500_000],
    ['A상사에 오 십 만 끊어줘', '십 만', 500_000],
    ['A상사에 오십 만 원 끊어줘', '오십', 500_000],
    ['A상사에 백 만 원 끊어줘', '백 만', 1_000_000],
  ];
  const D = syntheticBizNo(81).replace(/\D/g, '');
  const OTHERS: Array<[string, string]> = [
    ['A상사에 KRW550000 끊어줘', '550'],
    ['A상사에 550000KRW 끊어줘', '550'],
    ['A상사에 x550000 끊어줘', '550'],
    [`사업자 ${D.slice(0, 3)},${D.slice(3, 5)},${D.slice(5)}`, D.slice(0, 3)],
    [`사업자 ${D.slice(0, 3)} / ${D.slice(3, 5)} / ${D.slice(5)}`, D.slice(0, 3)],
  ];
  for (const [text, raw] of OTHERS) {
    it(`통화 글자가 붙은 금액, 쉼표·띄운 빗금 사업자번호도 가린다: ${text}`, async () => {
      script(() => reply({ text: '알겠어요.' }));
      await say(agent(), new FakePc(), text);
      assert.ok(!userText(responds()[0]!.body!).includes(raw), userText(responds()[0]!.body!));
    });
  }
  for (const [text, raw, value] of AMOUNTS) {
    it(`띄어 쓰거나 끊어 쓴 금액도 가리고 원 단위로 풀린다: ${text}`, async () => {
      const a = agent();
      const pc = new FakePc();
      assert.deepEqual((await drafted(a, pc, text)).amount, { value });
      for (const t of ['응', '그래']) {
        script(() => reply({ text: '알겠어요.' }));
        await say(a, pc, t);
      }
      for (const b of responds()) assert.ok(!userText(b.body!).includes(raw), `${raw} 원문이 나갔다: ${userText(b.body!)}`);
    });
  }

  it('지나친 가림을 줄인다: "이만 끝낼게", "천만에요"는 그대로 나가고 "이만 원", "천만에 끊어줘"는 가린다', async () => {
    const a = agent();
    const pc = new FakePc();
    for (const t of ['이만 끝낼게', '천만에요', 'A상사에 이만 원', 'A상사에 천만에 끊어줘']) {
      script(() => reply({ text: '알겠어요.' }));
      await say(a, pc, t);
    }
    const lines = responds().map((b) => nowLine(b.body!));
    assert.equal(lines[0], '사용자: 이만 끝낼게');
    assert.equal(lines[1], '사용자: 천만에요');
    assert.ok(!lines[2]!.includes('이만') && !lines[3]!.includes('천만'), lines.join(' / '));
  });

  it('답 숫자 규칙: 한 글자 수 + 단위(만 원·천 원·십 원), 띄어 쓴 수(백 만 원·오 십 만), 달 이름(구월·팔월·일월·삼월·오월·십이월)', () => {
    for (const t of ['합계는 만 원이에요.', '합계는 천 원이에요.', '합계는 천원이에요.', '합계는 백 만 원이에요.', '합계는 십 원이에요.', '합계는 오 십 만이에요.', '합계는 오십 만 원이에요.', '마지막 발급은 구월이에요.', '팔월에 발급했어요.', '일월 발급이에요.', '삼월이에요.', '오월에 만들었어요.', '십이월 발급이에요.'])
      assert.equal(numberShaped(t), true, t);
    for (const t of ['이 건은 발급했어요.', '사이에 있는 카드예요.', '일일이 확인할 필요는 없어요.', '만약 다르면 말씀해 주세요.', '카드를 만들었어요.', '천천히 확인해 주세요.', '잔액 이월은 장부에서 봐 주세요.', '월말에 다시 봐 주세요.'])
      assert.equal(numberShaped(t), false, t);
  });

  it('답 숫자 규칙: 시월·유월은 따로 본다(N5)', () => {
    for (const t of ['마지막 발급은 시월이에요.', '유월에 발급했어요.', '시월 십오일이에요.']) assert.equal(numberShaped(t), true, t);
    for (const t of ['시월드 이야기는 몰라요.', '유월드컵은 몰라요.']) assert.equal(numberShaped(t), false, t);
  });

  it('parseKrw: 띄어 쓰거나 점으로 끊은 금액', () => {
    assert.equal(parseKrw('550 000'), 550_000);
    assert.equal(parseKrw('55 0000'), 550_000);
    assert.equal(parseKrw('550.000'), 550_000);
    assert.equal(parseKrw('오 십 만'), 500_000);
    assert.equal(parseKrw('1.5만'), 15_000);
  });
});

// PR #296 r3 판정(mid-verify/pr-296-final-r3.md) 반영: 사전은 공백을 뺀 길이로 긴 이름부터 맞춘다. 장부에 없는 긴 이름의 일부는 되묻는다.
// 이 묶음도 장부에 거래처를 더하므로 파일 맨 끝에 둔다.
describe('PR #296 r3 판정 반영', () => {
  before(() => {
    const repo = new CounterpartyRepo(db);
    for (const [name, n] of [['대한상사', 87], ['대한상사몰', 88], ['한빛전자', 89], ['한빛전자몰', 90], ['A상사몰코리아', 91]] as const) cpId[name] = repo.create({ name, bizNo: syntheticBizNo(n) }).id;
  });

  async function drafted(a: ChatAgent, pc: FakePc, text: string): Promise<string | null> {
    script(
      (b) => fc('invoice_draft', { counterparty: toks(nowLine(b), 'NAME')[0] ?? '없음', amount: toks(nowLine(b), 'AMT')[0] ?? null, vat: null, item: '컨설팅' }),
      () => reply({ kind: 'did', text: '카드를 만들었어요.' }),
    );
    const c = (await say(a, pc, text)).calls.find((x) => x.tool === 'invoice_draft');
    return c && c.tool === 'invoice_draft' ? Object.entries(cpId).find(([, id]) => id === c.counterpartyId)![0] : null;
  }
  const session = async (texts: string[]) => {
    const a = agent();
    const pc = new FakePc();
    const got: Array<string | null> = [];
    for (const t of texts) got.push(await drafted(a, pc, t));
    return got;
  };

  it('앞 턴에 짧은 이름을 띄어 써도 다음 턴의 정확한 긴 이름은 긴 거래처로 풀린다(재현 l)', async () => {
    assert.deepEqual(await session(['대 한 상 사에 550000 끊어줘', '대한상사몰에 550000 끊어줘', '대한상사에 550000 끊어줘', '대 한 상 사 몰에 550000 끊어줘']), ['대한상사', '대한상사몰', '대한상사', '대한상사몰']);
  });

  it('#300 화면 재현: "A 상 사에" 다음 "A상사몰에"는 A상사몰, 장부에 없는 "C테크몰에"는 C테크로 풀지 않고 되묻는다', async () => {
    assert.deepEqual(await session(['A 상 사에 200000 끊어줘', 'A상사몰에 200000 끊어줘', 'C테크몰에 300000 끊어줘', 'C테크에 300000 끊어줘']), ['A상사', 'A상사몰', null, 'C테크']);
  });

  it('공백 든 장부 이름(한빛 전자)이 있어도 붙여 쓴 긴 이름은 긴 거래처로 풀린다(재현 m, 새 세션)', async () => {
    assert.deepEqual(await session(['한빛전자몰에 550000 끊어줘']), ['한빛전자몰']);
    assert.deepEqual(await session(['한빛전자몰한테 550000 끊어줘']), ['한빛전자몰']);
  });

  it('띄어 쓴 짧은 이름 뒤에도 긴 이름이 맞게 풀린다(재현 f). 주인이 둘인 이름(한빛전자·한빛 전자)은 되묻는다', async () => {
    assert.deepEqual(await session(['한 빛 전 자에 550000 끊어줘', '한빛전자몰에 550000 끊어줘']), [null, '한빛전자몰']);
  });

  it('긴 세션: 앞 턴의 변형들이 뒤 턴의 오타·잘린 이름을 짧은 거래처로 끌고 가지 않는다', async () => {
    assert.deepEqual(
      await session(['a 상 사 몰에 550000 끊어줘', 'A 상사에 550000 끊어줘', 'A상사물에 550000 끊어줘', 'A상사몰코리야에 550000 끊어줘', 'A상사몰코에 550000 끊어줘', 'A상사몰에 550000 끊어줘']),
      ['A상사몰', 'A상사', null, 'A상사몰코리아', null, 'A상사몰'],
    );
  });

  it('장부에 없는 긴 이름의 일부("신A상사", 잘린 "A상사몰코리", 띄어 쓴 "B 상사 몰")는 그 거래처로 풀지 않고 되묻는다. 이다 꼴·건·좀 같은 말이 붙은 것은 그대로 푼다', async () => {
    for (const [text, want] of [
      ['신A상사에 550000 끊어줘', null],
      ['A상사몰코리에 550000 끊어줘', null],
      ['B 상사 몰에 550000 끊어줘', null],
      ['B 상사 몰 550000 끊어줘', null],
      ['B 상사 좀 550000 끊어줘', 'B상사'],
      ['B 상사 건 550000 끊어줘', 'B상사'],
      ['B 상사 거래로 550000 끊어줘', 'B상사'],
      ['B상사 에 550000 끊어줘', 'B상사'],
      ['A상사인데 550000 끊어줘', 'A상사'],
      ['A상사건 550000 끊어줘', 'A상사'],
      ['A상사꺼 550000 끊어줘', 'A상사'],
      ['(주)A상사에 550000 끊어줘', 'A상사'],
    ] as const)
      assert.deepEqual(await session([text]), [want], text);
  });
});
