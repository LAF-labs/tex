// 대화 에이전트 chat.step(D04 §4 chat_agent): 마스킹 경계(나간 본문에 원문 없음)·도구 결과 구조 검사(C-10)·역치환·답 검사·턴 상한·세션 폐기·오타 별칭.
// 모델은 모의 게이트웨이의 각본 출력, main은 아래 FakePc(카드·조회 결과와 ref를 가진 값 공간)다. 요청은 실제 Egress·응답 어댑터를 지난다.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, beforeEach, describe, it } from 'node:test';
import { CounterpartyRepo, openDatabase, ProfileRepo, syntheticBizNo, type Db } from '@sax/db';
import { CHAT_ADVICE_TEXT, CHAT_AGENT_FALLBACK_TEXT, CHAT_AGENT_INPUT_MAX_BYTES, ChatAgent, gatewayChatAgentModel, parseKrw, type DomainCall, type ScreenFrame, type StepResult, type ToolOutput } from '@sax/engine';
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
    assert.equal(out[1]!.reply.text, 'A상사에 보낼 카드를 만들었어요.');
    assert.deepEqual(out[2]!.calls.map((c) => c.tool === 'draft_edit' && [c.draft, c.vat]), [['d2', 'separate']]);
    const typo = out[3]!.calls[0]!;
    assert.ok(typo.tool === 'invoice_draft' && typo.counterpartyId === cpId['A상사'] && typo.amount && 'value' in typo.amount && typo.amount.value === 500_000);
    assert.deepEqual(out[4]!.reply, { kind: 'tax_advice', text: CHAT_ADVICE_TEXT, show: [], ask: null, filtered: 'advice' });
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
    assert.deepEqual(await one(a, { kind: 'tax_advice', text: '경비 처리돼요' }), { kind: 'tax_advice', text: CHAT_ADVICE_TEXT, show: [], ask: null, filtered: 'advice' });
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

  it('거래처 토큰은 지금 장부 이름으로 보인다(이름을 바꾸면 바뀐 이름), 대화록에는 토큰 그대로 남는다', async () => {
    const a = agent();
    script((b) => reply({ text: `${toks(nowLine(b), 'NAME')[0]}에 보낼까요?` }));
    assert.equal((await say(a, new FakePc(), 'C테크 어때?')).reply.text, 'C테크에 보낼까요?');
    new CounterpartyRepo(db).update(cpId['C테크']!, { name: 'C테크놀로지' });
    try {
      let tok = '';
      script((b) => ((tok = /앱: (\[NAME_\d+\])에/.exec(userText(b))![1]!), reply({ text: `${tok} 맞아요.` })));
      assert.equal((await say(a, new FakePc(), '어디라고?')).reply.text, 'C테크놀로지 맞아요.');
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
