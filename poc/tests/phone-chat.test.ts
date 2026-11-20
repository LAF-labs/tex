import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  PHONE_CONTEXT_MAX_TOKENS,
  PHONE_NUMBER_TEXT,
  PHONE_FALLBACK_TEXT,
  PHONE_ASK_TEXT,
  PHONE_PREFIX_EST_TOKENS,
  PHONE_SESSION_TURNS,
  PHONE_TURNS_MAX,
  PhoneChat,
  PhoneChatError,
  estimateTokens,
  rebind,
  capture,
  type ChatMessage,
  type PhoneChatPorts,
  type PhoneCopy,
  type PhoneModel,
  type PhoneRespondRequest,
  type PhoneRespondResult,
  type PhoneTurnResult,
} from '@sax/chat-core';
import { CHAT_MAP_IDLE_MS, Redactor, wasMinted } from '@sax/redaction';

const T0 = Date.UTC(2026, 10, 16, 3, 0);
const ULID = (n: number) => `01KA${String(n).padStart(22, '0')}`;

const COPY: PhoneCopy = {
  asOf: T0 - 3600_000,
  profile: { id: 'p1', name: '율무상회', repName: '김율무', bizNo: '123-45-67890' },
  counterparties: [
    { id: 'c1', name: '한빛전자', repName: '박한빛', email: 'tax@hanbit.example', bizNo: '220-81-62517', item: '컨설팅' },
    { id: 'c2', name: '서울상사', email: 'acct@seoul.example', bizNo: '105-86-00011', item: null },
    { id: 'c3', name: 'A상사', item: '자문' },
  ],
  issued: [
    { counterpartyId: 'c1', counterparty: '한빛전자', date: '2026-10-15', total: 605000, approvalNo: '20261015-41000000-00000001' },
    { counterpartyId: 'c1', counterparty: '한빛전자', date: '2026-11-03', total: 1100000, approvalNo: null },
    { counterpartyId: 'c2', counterparty: '서울상사', date: '2026-09-30', total: 330000 },
  ],
  receivables: [{ counterpartyId: 'c1', counterparty: '한빛전자', date: '2026-11-03', total: 1100000 }],
};

const RAW = ['한빛전자', '박한빛', '서울상사', 'A상사', '율무상회', '김율무', '220-81-62517', '123-45-67890', 'hanbit', '605,000', '1,100,000', '605000', '1100000', '550000', '55만', '2026-10-15', '20261015'];

type Script = (req: PhoneRespondRequest, n: number) => PhoneRespondResult;
const tag = (n: number) => n.toString(16).padStart(64, '0');
const call = (n: number, name: string, args: object): PhoneRespondResult => ({
  status: 'completed',
  output: undefined,
  toolCalls: [{ callId: `call_${n}`, name: name as never, arguments: args as Record<string, unknown> }],
  replay: [{ item: { type: 'function_call', call_id: `call_${n}`, name, arguments: JSON.stringify(args) }, tag: tag(n) }],
});
const say = (n: number, kind: string, text: string, show: string[] = [], ask: string | null = null): PhoneRespondResult => ({
  status: 'completed',
  output: { kind, text, show, ask },
  toolCalls: [],
  replay: [{ item: { type: 'message', content: [{ type: 'output_text', text: '' }] }, tag: tag(n) }],
});

function rig(o: { copy?: PhoneCopy | null; script?: Script; stored?: string | null } = {}) {
  let now = T0;
  let id = 0;
  let hex = 0;
  let saved: string | null = o.stored ?? null;
  let script: Script = o.script ?? ((_r, n) => say(n, 'smalltalk', '네, 말씀하세요.'));
  let copy = o.copy === undefined ? COPY : o.copy;
  const reqs: PhoneRespondRequest[] = [];
  const sessions: string[] = [];
  const model: PhoneModel = {
    runToken: async (chatSessionId) => {
      sessions.push(chatSessionId);
      return `rt-${chatSessionId}-0123456789abcdef`;
    },
    respond: async (req) => {
      reqs.push(req);
      return script(req, reqs.length);
    },
  };
  const ports: PhoneChatPorts = {
    model,
    store: { load: async () => saved, save: async (d) => void (saved = d) },
    copy: () => copy,
    now: () => now,
    newId: () => ULID(++id),
    randomHex: () => (++hex).toString(16).padStart(32, '0'),
  };
  const chat = new PhoneChat(ports);
  return {
    chat,
    ports,
    reqs,
    sessions,
    saved: () => saved,
    setScript: (s: Script) => void (script = s),
    setCopy: (c: PhoneCopy | null) => void (copy = c),
    tick: (ms: number) => void (now += ms),
    now: () => now,
  };
}

const reply = (r: PhoneTurnResult) => {
  assert.equal(r.kind, 'reply', JSON.stringify(r));
  return r as Extract<PhoneTurnResult, { kind: 'reply' }>;
};
function assertNoRaw(reqs: readonly PhoneRespondRequest[], extra: readonly string[] = []) {
  for (const r of reqs) {
    const sent = [r.text, ...r.replay.map((x) => ('output' in x ? x.output : JSON.stringify(x.item)))].join('\n');
    for (const raw of [...RAW, ...extra]) assert.ok(!sent.includes(raw), `모델에 원값이 나갔다: ${raw}\n${sent}`);
    assert.ok(wasMinted(r.text), '마스킹 계층이 만든 글이다');
  }
}

describe('폰 대화: 컨텍스트와 가림', () => {
  it('한 번 부를 때 [사실] → [지금] 순서로 싣고, 이름·금액·사업자번호는 토큰으로만 나간다', async () => {
    const t = rig();
    const r = reply(await t.chat.send('한빛전자(220-81-62517)에 55만원 세금계산서 끊어줘'));
    assert.equal(r.text, '네, 말씀하세요.');
    const text = t.reqs[0]!.text;
    assert.equal(t.reqs[0]!.toolset, 'chat_phone');
    assert.match(text, /^\[사실\]\nPC: 꺼짐\n사본: fresh\ninvoice_history\(\[NAME_\d+\]\) = \{"ref":"r1","status":"ok","fields":\["date","supply","total","counterparty","approvalNo"\],"needs":null\}\nreceivables\(\[NAME_\d+\]\) = \{"ref":"r2","status":"ok"/);
    assert.match(text, /\n\[지금\]\n화면: 열린 카드 없음\n앱 판단: 세금계산서 발급 요청\n사용자: \[NAME_\d+\]\(\[BIZNO_\d+\]\)에 \[AMT_\d+\] 세금계산서 끊어줘$/);
    assert.ok(!text.includes('[요약]') && !text.includes('[앞 대화]'));
    assertNoRaw(t.reqs);
    assert.deepEqual(t.sessions.length, 1);
    assert.match(t.sessions[0]!, /^chat_[0-9a-f]{32}$/);
  });

  it('둘째 턴: [앞 대화]가 [사실] 앞에 오고, 앞 턴의 접두(앞 대화 첫 줄)는 그대로다. 거래처 없이 이어 물으면 직전 거래처의 사실을 같은 ref로 싣는다', async () => {
    const t = rig({ script: (_r, n) => (n === 1 ? say(n, 'answer', '최근 발급은 {r1.first.date}, 합계 {r1.first.total}이에요.', ['r1']) : say(n, 'answer', '그때 공급가는 {r1.first.supply}이었어요.')) });
    const a = reply(await t.chat.send('한빛전자 발급 기록 보여줘'));
    assert.equal(a.text, '최근 발급은 11월 3일, 합계 1,100,000원이에요.');
    assert.equal(a.show.length, 1);
    assert.deepEqual(a.show[0]!.type === 'table' && [a.show[0]!.table, a.show[0]!.rows.length, a.show[0]!.copy, a.show[0]!.title], ['history', 2, 'fresh', '한빛전자 발급 기록 2건 · 공급가 1,550,000원 · 합계 1,705,000원']);
    const b = reply(await t.chat.send('그때 공급가 얼마였어?'));
    assert.equal(b.text, '그때 공급가는 1,000,000원이었어요.');
    const text = t.reqs[1]!.text;
    const order = ['[앞 대화]', '[사실]', '[지금]'].map((x) => text.indexOf(x));
    assert.ok(order[0] === 0 && order[0]! < order[1]! && order[1]! < order[2]!, text);
    assert.match(text, /\[앞 대화\]\n사용자: \[NAME_\d+\] 발급 기록 보여줘\n앱: 최근 발급은 \(날짜\), 합계 \[AMT_\d+\]이에요\.\n\[사실\]/);
    assert.match(text, /invoice_history\(\[NAME_\d+\]\) = \{"ref":"r1"/, '같은 조회는 같은 ref(접두가 바뀌지 않는다)');
    assertNoRaw(t.reqs, ['11월 3일', '1,000,000']);
  });

  it('사본이 없으면 "사본: none"만 싣고 조회 도구는 not_on_phone, 하루 넘은 사본은 stale', async () => {
    const t = rig({ copy: null, script: (r, n) => (r.replay.length ? say(n, 'cannot', 'PC와 한 번 연결해야 볼 수 있어요.') : call(n, 'invoice_history', { counterparty: null })) });
    reply(await t.chat.send('발급 기록 보여줘'));
    assert.match(t.reqs[0]!.text, /^\[사실\]\nPC: 꺼짐\n사본: none\n\[지금\]/);
    assert.equal((t.reqs[1]!.replay[1] as { output: string }).output, '{"ref":null,"status":"not_on_phone","fields":null,"needs":null}');
    const s = rig({ copy: { ...COPY, asOf: T0 - 25 * 3600_000 } });
    reply(await s.chat.send('한빛전자 얼마 남았지'));
    assert.match(s.reqs[0]!.text, /사본: stale/);
  });

  it('옛 판이 저장한 기록(PC 컨텍스트, origin·base·synced 칸)을 열어도 이 폰의 대화만 남고, 값으로 받은 토큰은 이 세션 번호로 다시 쓴다', async () => {
    const e = { '[NAME_7]': { k: 'NAME', v: '서울상사', r: 'cp:c2' }, '[AMT_3]': { k: 'AMT', v: '33만원' } };
    const stored = JSON.stringify({
      v: 1,
      seq: 3,
      pc: { summary: { t: 'PC 요약', e: {} }, messages: [{ id: ULID(800), at: 1, from: 'app', origin: 'pc', text: 'PC에서 한 말' }], cursor: ULID(800), at: 2 },
      phone: [
        { id: ULID(900), at: T0 - 7200_000, from: 'user', origin: 'phone', base: ULID(800), synced: true, text: '서울상사에 33만원 끊어줘', ctx: { t: '[NAME_7]에 [AMT_3] 끊어줘', e } },
        { id: ULID(901), at: T0 - 7100_000, from: 'app', origin: 'phone', base: ULID(800), text: '서울상사 카드를 만들었어요.', kind: 'did' },
        { id: 7, text: '깨진 줄' },
      ],
      fold: null,
      drafts: [],
    });
    const t = rig({ stored });
    assert.deepEqual((await t.chat.messages()).map((x) => Object.keys(x).sort()), [['at', 'ctx', 'from', 'id', 'text'], ['at', 'from', 'id', 'kind', 'text']]);
    reply(await t.chat.send('아까 그 금액 그대로 한빛전자에도'));
    const text = t.reqs[0]!.text;
    const m = /^\[앞 대화\]\n사용자: (\[NAME_\d+\])에 (\[AMT_\d+\]) 끊어줘\n앱: (\[NAME_\d+\]) 카드를 만들었어요\.\n\[사실\]/.exec(text);
    assert.ok(m, text);
    assert.equal(m[1], m[3], '같은 값은 같은 토큰(값으로 받은 것과 규칙으로 가린 것)');
    assert.ok(!text.includes('PC 요약') && !text.includes('PC에서'), '다른 기기의 대화는 컨텍스트에 넣지 않는다');
    assertNoRaw(t.reqs, ['33만원']);
    assert.ok(!t.saved()!.includes('"pc"') && !t.saved()!.includes('synced'), '다시 저장할 때 옛 칸을 버린다');
  });

  it('세션이 바뀌어도(15분 쉼) 기록은 값으로 이어지고 새 세션 토큰으로 다시 가려 나간다', async () => {
    const t = rig({ script: (_r, n) => say(n, 'did', '[NAME_1] 건을 확인했어요.') });
    reply(await t.chat.send('한빛전자 건 확인'));
    t.tick(CHAT_MAP_IDLE_MS + 1);
    const b = reply(await t.chat.send('서울상사는?'));
    assert.equal(t.sessions.length, 2);
    assert.notEqual(t.sessions[0], t.sessions[1]);
    assert.match(t.reqs[1]!.text, /\[앞 대화\]\n사용자: \[NAME_\d+\] 건 확인\n앱: \[NAME_\d+\] 건을 확인했어요\./);
    assertNoRaw(t.reqs);
    assert.equal(b.text, '한빛전자 건을 확인했어요.');
  });

  it('상한을 넘으면 사실 → 오래된 턴 순으로 줄이고, 요약과 이번 문장은 남긴다', async () => {
    const long = '세금계산서 품목과 납품 일정 이야기를 길게 적는다 '.repeat(12);
    const msgs: ChatMessage[] = [{ id: ULID(499), at: T0 - 9100_000, from: 'user', text: '접힌 줄' }];
    for (let i = 0; i < 20; i++) {
      msgs.push({ id: ULID(500 + i * 2), at: T0 - 9000_000 + i, from: 'user', text: `${i}번째 ${long}` });
      msgs.push({ id: ULID(501 + i * 2), at: T0 - 9000_000 + i, from: 'app', text: `${i}번째 답 ${long}`, kind: 'answer' });
    }
    const t = rig({ stored: JSON.stringify({ v: 1, seq: 0, phone: msgs, fold: { summary: { t: '요약 첫 문장이다.', e: {} }, upto: ULID(499) }, drafts: [] }) });
    reply(await t.chat.send('한빛전자 발급 기록'));
    const text = t.reqs[0]!.text;
    assert.ok(PHONE_PREFIX_EST_TOKENS + estimateTokens(text) <= PHONE_CONTEXT_MAX_TOKENS);
    assert.ok(text.startsWith('[요약]\n요약 첫 문장이다.'));
    assert.match(text, /사용자: \[NAME_\d+\] 발급 기록$/);
    assert.ok(!text.includes('invoice_history('), '사실을 먼저 뺀다');
    assert.ok(!text.includes('0번째') && text.includes('19번째'), '오래된 턴부터 뺀다');
  });

  it('비밀 값이 든 문장·빈 문장·너무 긴 문장은 모델에 보내지 않고 기록하지 않는다', async () => {
    const t = rig();
    for (const [text, code] of [['비밀번호는 abcd1234야', 'chat.secret_rejected'], ['   ', 'bad_text'], ['가'.repeat(2001), 'bad_text']] as const) {
      const r = await t.chat.send(text);
      assert.deepEqual([r.kind, r.kind === 'unavailable' && r.code], ['unavailable', code]);
    }
    assert.equal(t.reqs.length, 0);
    assert.deepEqual(await t.chat.messages(), []);
  });
});

describe('폰 대화: 도구와 카드', () => {
  it('카드 만들기: 금액 토큰은 폰에서 읽고, 품목은 거래처 저장 품목으로 채운다. 발급은 없다(맡기기는 사장님이 카드에서)', async () => {
    const t = rig({ script: (r, n) => (r.replay.length ? say(n, 'did', '[NAME_1] 카드를 만들었어요. 맡기면 PC를 켰을 때 시작해요.', ['d3']) : call(n, 'invoice_draft', { counterparty: '[NAME_1]', amount: '[AMT_1]', vat: null, item: null })) });
    const r = reply(await t.chat.send('한빛전자에 55만원 끊어줘'));
    assert.equal(r.text, '한빛전자 카드를 만들었어요. 맡기면 PC를 켰을 때 시작해요.');
    assert.equal((t.reqs[1]!.replay[1] as { output: string }).output, '{"ref":"d3","status":"card_shown","fields":null,"needs":null}');
    const card = r.show.find((x) => x.type === 'card');
    assert.ok(card && card.type === 'card');
    assert.deepEqual([card.counterparty, card.draft.amount, card.draft.vat, card.draft.item, card.draft.state, card.draft.ref], ['한빛전자', 550000, null, '컨설팅', 'open', 'd3']);
    assertNoRaw(t.reqs);
    t.setScript((_r, n) => say(n, 'smalltalk', '네.'));
    await t.chat.send('고마워');
    assert.match(t.reqs[2]!.text, /화면: 카드 d3\(세금계산서, 거래처 \[NAME_\d+\], 금액 있음, 부가세 미정, 품목 있음\)/);
    const d = await t.chat.entrust(card.draft.id);
    assert.equal(d?.state, 'entrusted');
    assert.equal(await t.chat.entrust(card.draft.id), null, '두 번 맡길 수 없다');
    const log = await t.chat.messages();
    assert.equal(log.at(-1)!.text, '한빛전자 세금계산서를 맡겼어요. PC가 켜지면 시작하고, 발급 전에 한 번 더 확인을 받아요.');
    assert.ok(!log.at(-1)!.ctx!.t.includes('한빛전자'));
    t.setScript((req, n) => (req.replay.length ? say(n, 'cannot', '이미 맡긴 카드라 고칠 수 없어요.') : call(n, 'draft_edit', { draft: 'd3', amount: null, vat: 'included', item: null })));
    await t.chat.send('그 카드 부가세 포함으로');
    assert.equal((t.reqs.at(-1)!.replay[1] as { output: string }).output, '{"ref":"d3","status":"not_editable","fields":null,"needs":null}');
  });

  it('금액·품목이 비면 만들지 않고 needs_input, "같은 금액"은 결과 슬롯으로 받는다(합계 슬롯이면 부가세 포함)', async () => {
    const t = rig({
      script: (r, n) => {
        if (!r.replay.length) return call(n, 'invoice_draft', { counterparty: '[NAME_3]', amount: null, vat: null, item: null });
        return say(n, 'ask', '금액을 알려 주세요.', [], 'amount');
      },
    });
    const a = reply(await t.chat.send('서울상사에 끊어줘'));
    assert.equal((t.reqs[1]!.replay[1] as { output: string }).output, '{"ref":null,"status":"needs_input","fields":null,"needs":["amount","item"]}');
    assert.deepEqual([a.ask?.kind, a.show.length], ['amount', 0]);
    t.setScript((r, n) => (r.replay.length ? say(n, 'did', '같은 금액으로 카드를 만들었어요.') : call(n, 'invoice_draft', { counterparty: '[NAME_1]', amount: `{${/invoice_history\(\[NAME_1\]\) = \{"ref":"(r\d+)"/.exec(r.text)![1]}.first.total}`, vat: null, item: null })));
    const b = reply(await t.chat.send('한빛전자에 지난번이랑 같은 금액으로'));
    const card = b.show.find((x) => x.type === 'card');
    assert.ok(card && card.type === 'card', '모델이 show에 넣지 않아도 이번 턴에 만든 카드는 보인다');
    assert.deepEqual([card.draft.amount, card.draft.vat], [1100000, 'included']);
  });

  it('같은 턴에 같은 도구를 같은 인자로 또 부르면 실행하지 않고 첫 결과로 답한다(카드가 두 장 생기지 않는다)', async () => {
    const args = { counterparty: '[NAME_1]', amount: '[AMT_1]', vat: null, item: null };
    const t = rig({ script: (r, n) => (r.replay.length >= 4 ? say(n, 'did', '카드를 만들었어요.') : call(n, 'invoice_draft', args)) });
    const r = reply(await t.chat.send('한빛전자에 55만원'));
    assert.equal((await t.chat.drafts()).length, 1);
    assert.equal(r.show.filter((x) => x.type === 'card').length, 1);
    assert.equal((t.reqs[2]!.replay[3] as { output: string }).output, (t.reqs[2]!.replay[1] as { output: string }).output);
  });

  it('모델이 답 없이 도구만 거듭 부르다 턴 상한에 닿으면, 이미 낸 결과를 고정 문장과 같이 보인다. 결과가 없으면 chat.turn_limit', async () => {
    const t = rig({ script: (_r, n) => call(n, 'receivables', { counterparty: n % 2 ? '[NAME_1]' : null }) });
    const r = reply(await t.chat.send('한빛전자 못 받은 돈'));
    assert.deepEqual([r.text, r.filtered, r.reply], [PHONE_NUMBER_TEXT, 'number', 'did']);
    assert.ok(r.show.length >= 1 && r.show.every((x) => x.type === 'table'));
    assert.equal(t.reqs.length, 4, '모델 호출은 툴셋 턴 상한까지');
    const u = rig({ copy: null, script: (_r, n) => call(n, 'draft_discard', { draft: `d${n}` }) });
    const e = await u.chat.send('카드 취소');
    assert.deepEqual([e.kind, e.kind === 'unavailable' && e.code], ['unavailable', 'chat.turn_limit']);
  });

  it('답 검사는 PC와 같다: 슬롯·토큰 밖 숫자는 문장만 버리고 표는 보인다, 세무 판단·식별자는 고정 문구, 모르는 토큰·ref는 chat.bad_response', async () => {
    const t = rig({ script: (_r, n) => say(n, 'answer', '합계는 1,705,000원이에요.', ['r1']) });
    const a = reply(await t.chat.send('한빛전자 발급 합계'));
    assert.deepEqual([a.text, a.filtered, a.show.length], [PHONE_NUMBER_TEXT, 'number', 1]);
    t.setScript((_r, n) => say(n, 'answer', '부가세를 줄이려면 공제를 받으세요.'));
    assert.equal(reply(await t.chat.send('세금 줄이는 법')).filtered, 'advice');
    t.setScript((_r, n) => say(n, 'answer', '비밀번호를 입력하세요.'));
    assert.equal(reply(await t.chat.send('안 돼')).filtered, 'unsafe');
    for (const bad of [say(9, 'answer', '[NAME_99]예요.'), say(9, 'answer', '네', ['r77']), say(9, 'issue', '발급했어요.')]) {
      t.setScript(() => bad);
      const r = await t.chat.send('한빛전자');
      assert.deepEqual([r.kind, r.kind === 'unavailable' && r.code], ['unavailable', 'chat.bad_response']);
    }
    t.setScript((_r, n) => say(n, 'defer', '이번 달 매출 합계는 PC를 켜면 이어서 볼게요.'));
    const d = reply(await t.chat.send('이번 달 매출 얼마야'));
    assert.equal(d.reply, 'defer');
    assert.equal((await t.chat.messages()).at(-1)!.kind, 'defer');
  });

  it('PC 대화에서 실제 모델로 찾은 실패와 같은 규칙: 사장님이 쓴 달·날짜는 따라 써도 되고, 되묻기에 숫자가 섞이면 되묻기는 살리고, 틀린 슬롯·중괄호 토큰은 턴을 버리지 않는다', async () => {
    const t = rig({ script: (_r, n) => say(n, 'answer', '9월 기록을 표로 보여 드릴게요.', ['r1']) });
    const a = reply(await t.chat.send('한빛전자 9월 발급 기록'));
    assert.deepEqual([a.text, a.filtered, a.show.length], ['9월 기록을 표로 보여 드릴게요.', null, 1]);
    t.setScript((_r, n) => say(n, 'answer', '10월 기록을 표로 보여 드릴게요.', ['r1']));
    assert.deepEqual([reply(await t.chat.send('한빛전자 9월 발급 기록')).filtered], ['number']);
    t.setScript((_r, n) => say(n, 'ask', '금액은 550000원이 맞나요, 아니면 다른 금액인가요?', [], 'amount'));
    const b = reply(await t.chat.send('서울상사에 끊어줘'));
    assert.deepEqual([b.text, b.filtered, b.ask?.kind], [PHONE_ASK_TEXT.amount, 'number', 'amount']);
    t.setScript((_r, n) => say(n, 'answer', '{r77.count}건이에요.'));
    const c = reply(await t.chat.send('안녕'));
    assert.deepEqual([c.text, c.filtered, c.show.length], [PHONE_FALLBACK_TEXT, 'slot', 0]);

    const u = rig({
      script: (r, n) => {
        if (!r.replay.length) return call(n, 'invoice_draft', { counterparty: '{NAME_1}', amount: '{AMT_1}', vat: null, item: null });
        const ref = /"ref":"(d\d+)"/.exec((r.replay[1] as { output: string }).output)![1]!;
        return say(n, 'ask', `{${ref}.first.supply}으로 카드를 만들었어요. 부가세는 별도인가요?`, [], 'vat');
      },
    });
    const d = reply(await u.chat.send('한빛전자에 55만원 끊어줘'));
    const card = d.show.find((x) => x.type === 'card');
    assert.ok(card && card.type === 'card', JSON.stringify(d));
    assert.deepEqual([card.draft.amount, d.text, d.filtered, d.ask], [550000, PHONE_NUMBER_TEXT, 'slot', null]);
    assertNoRaw(u.reqs);
    u.setScript((_r, n) => say(n, 'ask', '{d9.first.item} 품목이 맞나요?', [], 'item'));
    const e = reply(await u.chat.send('품목은 뭐였지'));
    assert.deepEqual([e.text, e.filtered, e.ask?.kind], [PHONE_ASK_TEXT.item, 'slot', 'item']);
  });

  it('사본에 없는 거래처: 사장님이 쓴 이름이면 화면 안내에 싣고, 모델에는 unknown_counterparty만 간다', async () => {
    const t = rig({ script: (r, n) => (r.replay.length ? say(n, 'ask', '어느 거래처인지 알려 주세요.', [], 'counterparty') : call(n, 'invoice_history', { counterparty: '가나다유통' })) });
    const r = reply(await t.chat.send('가나다유통 발급 기록'));
    assert.equal(r.unknown?.name, '가나다유통');
    assert.deepEqual(r.ask?.chips.map((c) => c.label), ['한빛전자', '서울상사', 'A상사']);
    assert.equal((t.reqs[1]!.replay[1] as { output: string }).output, '{"ref":null,"status":"unknown_counterparty","fields":null,"needs":null}');
  });

  it('게이트웨이 오류는 코드로 옮기고 그 턴은 기록하지 않는다. 예산을 다 쓴 세션은 닫고 다음 문장은 새 세션으로 간다', async () => {
    const t = rig({ script: () => ({ status: 'error', code: 'chat.daily_limit' }) });
    const a = await t.chat.send('한빛전자');
    assert.deepEqual([a.kind, a.kind === 'unavailable' && [a.code, a.retry]], ['unavailable', ['chat.daily_limit', false]]);
    assert.deepEqual(await t.chat.messages(), []);
    t.setScript(() => ({ status: 'error', code: 'chat.budget_exceeded', tokenInvalid: true }));
    await t.chat.send('한빛전자');
    t.setScript((_r, n) => say(n, 'smalltalk', '네.'));
    reply(await t.chat.send('안녕'));
    assert.equal(new Set(t.sessions).size, 2);
    const boom = rig();
    boom.ports.model.runToken = async () => {
      throw new PhoneChatError('chat.subscription_required');
    };
    const b = await boom.chat.send('안녕');
    assert.equal(b.kind === 'unavailable' && b.code, 'chat.subscription_required');
  });

  it(`대화 세션은 ${PHONE_SESSION_TURNS}턴마다 새로 연다(게이트웨이 대화 예산 20에 닿기 전)`, async () => {
    const t = rig();
    for (let i = 0; i < PHONE_SESSION_TURNS + 1; i++) reply(await t.chat.send(`안녕 ${'가'.repeat(i + 1)}`));
    assert.equal(new Set(t.sessions).size, 2);
  });
});

describe('폰 대화: 접기와 PC로 되돌리기', () => {
  it(`사용자 턴이 ${PHONE_TURNS_MAX}을 넘으면 오래된 절반을 chat_digest로 한 번에 접고, 다음 호출은 [요약] + 남은 턴으로 간다`, async () => {
    const t = rig({
      script: (r, n) => (r.toolset === 'chat_digest' ? { status: 'completed', output: { summary: '[NAME_1]와 인사를 나눴다. {r1.count} 아직 끝나지 않은 일은 없다.' }, toolCalls: [], replay: [] } : say(n, 'smalltalk', '네.')),
    });
    for (let i = 1; i <= PHONE_TURNS_MAX + 1; i++) reply(await t.chat.send(`한빛전자 ${'가'.repeat(i)}`));
    await t.chat.messages();
    const digests = t.reqs.filter((r) => r.toolset === 'chat_digest');
    assert.equal(digests.length, 1);
    const d = digests[0]!.text;
    assert.match(d, /^\[대화\]\n\(11월 16일\) 사용자: \[NAME_\d+\] 가\n\(11월 16일\) 앱: 네\./);
    assert.equal(d.split('\n').filter((l) => l.includes('사용자:')).length, PHONE_TURNS_MAX / 2 + 1, '오래된 턴 11개(21 - 10)를 접는다');
    assertNoRaw([digests[0]!]);
    reply(await t.chat.send('서울상사는'));
    const text = t.reqs.at(-1)!.text;
    assert.match(text, /^\[요약\]\n\[NAME_\d+\]와 인사를 나눴다\. 아직 끝나지 않은 일은 없다\.\n\[앞 대화\]\n사용자: \[NAME_\d+\] 가{12}\n/, '슬롯은 요약에 옮기지 않는다');
    assert.equal(text.split('\n').filter((l) => l.startsWith('사용자:')).length, PHONE_TURNS_MAX / 2 + 1);
    assert.equal((await t.chat.messages()).length, (PHONE_TURNS_MAX + 2) * 2);
  });

  it('요약 호출이 실패하거나 요약에 식별자가 섞이면 요약 없이 접기만 한다', async () => {
    for (const bad of [{ status: 'error', code: 'chat.unavailable' } as const, { status: 'completed', output: { summary: '담당자 전화는 010-1234-5678이다.' }, toolCalls: [], replay: [] } as const]) {
      const t = rig({ script: (r, n) => (r.toolset === 'chat_digest' ? bad : say(n, 'smalltalk', '네.')) });
      for (let i = 1; i <= PHONE_TURNS_MAX + 1; i++) reply(await t.chat.send(`안녕 ${'가'.repeat(i)}`));
      reply(await t.chat.send('또 안녕'));
      const text = t.reqs.at(-1)!.text;
      assert.ok(!text.includes('[요약]'));
      assert.equal(text.split('\n').filter((l) => l.startsWith('사용자:')).length, PHONE_TURNS_MAX / 2 + 1);
    }
  });

  it('대화는 이 폰에만 둔다: 저장은 포트로만 하고 다시 열어도 이어진다. 실행 토큰은 저장하지 않는다', async () => {
    const t = rig({ script: (_r, n) => say(n, 'did', '[NAME_1] 건을 적어 뒀어요.') });
    await t.chat.send('한빛전자 건 메모');
    await t.chat.send('서울상사도');
    const before = await t.chat.messages();
    assert.deepEqual(before.map((m) => [m.from, m.text]), [['user', '한빛전자 건 메모'], ['app', '한빛전자 건을 적어 뒀어요.'], ['user', '서울상사도'], ['app', '한빛전자 건을 적어 뒀어요.']]);
    assert.ok(before.every((m) => !('origin' in m) && !('base' in m) && !('synced' in m)));
    for (const gone of ['pendingSync', 'acked', 'applyContext']) assert.equal((t.chat as unknown as Record<string, unknown>)[gone], undefined, gone);
    const again = rig({ stored: t.saved(), script: (_r, n) => say(n, 'smalltalk', '네.') });
    assert.deepEqual(await again.chat.messages(), before);
    reply(await again.chat.send('고마워'));
    assert.match(again.reqs[0]!.text, /^\[앞 대화\]\n사용자: \[NAME_\d+\] 건 메모\n앱: \[NAME_\d+\] 건을 적어 뒀어요\.\n사용자: \[NAME_\d+\]도\n/);
    assert.ok(!again.saved()!.includes('rt-chat_'), '실행 토큰은 저장하지 않는다');
  });
});

describe('가린 글 다시 쓰기', () => {
  it('capture → rebind: 다른 세션에서 같은 값은 그 세션의 토큰이 되고 레코드 묶음도 따라간다. 값 없는 토큰은 자리표시가 된다', () => {
    const a = new Redactor({ chatSessionId: 'chat_a' });
    a.addRecord({ recordId: 'cp:c9', names: ['다른상사'] });
    a.addRecord({ recordId: 'cp:c1', names: ['한빛전자'] });
    const masked = a.apply('한빛전자에 55만원', { frame: 'none' }).redacted;
    assert.equal(masked, '[NAME_2]에 [AMT_1]');
    const m = capture(a, masked)!;
    assert.deepEqual(m.e['[NAME_2]'], { k: 'NAME', v: '한빛전자', r: 'cp:c1' });
    const b = new Redactor({ chatSessionId: 'chat_b' });
    const again = rebind(b, m);
    assert.equal(again, '[NAME_1]에 [AMT_1]');
    assert.equal(b.map.recordOf('[NAME_1]'), 'cp:c1');
    assert.equal(b.map.token('NAME', '한빛전자'), '[NAME_1]', '같은 값은 같은 토큰');
    assert.equal(rebind(b, { t: '[NAME_5]는 모른다', e: {} }), '(가림)는 모른다');
    assert.equal(capture(a, '[NAME_77]'), null);
  });
});
