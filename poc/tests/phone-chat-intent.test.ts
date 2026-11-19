// 발급 의도(사장님이 "세금계산서"라고 말하지 않아도): 규칙 issueIntent, 폰 대화의 "앱 판단" 줄과 안전망, PC 켜짐 줄.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { PHONE_ASK_TEXT, PhoneChat, issueIntent, type PhoneChatPorts, type PhoneCopy, type PhoneModel, type PhoneRespondRequest, type PhoneRespondResult, type PhoneTurnResult } from '@sax/chat-core';

describe('issueIntent: 가린 문장에서 발급 의도', () => {
  const yes = [
    '[AMT_1] 끊어줘',
    '[AMT_1] 끊어 줄래?',
    '[NAME_1] [AMT_1] 떼 줘',
    '[AMT_1] 발급해줘',
    '[NAME_1]에 [AMT_1] 발행 부탁해',
    '[AMT_1]짜리 하나 끊자',
    '[NAME_1] 계산서 [AMT_1]',
    '세계 [AMT_1] ㄱㄱ',
    '[NAME_1] [AMT_1] 해 줘',
    '[NAME_1] [AMT_1]',
    '[NAME_1] 끊어',
    '[AMT_1] 세금계산서',
  ];
  const no = ['지난주 끊은 거 보여 줘', '[NAME_1] 발급한 거 얼마야', '발급 취소해 줘', '[AMT_1] 들어왔어?', '받을 돈 알려 줘', '안녕', '이번 달 매출 얼마야', '[NAME_1] 발급 기록'];
  for (const t of yes) it(`발급: ${t}`, () => assert.equal(issueIntent(t).issue, true));
  for (const t of no) it(`발급 아님: ${t}`, () => assert.equal(issueIntent(t).issue, false));
  it('금액·거래처 칸', () => {
    assert.deepEqual(issueIntent('[AMT_1] 끊어줘'), { issue: true, amount: true, counterparty: false });
    assert.deepEqual(issueIntent('[NAME_1] 끊어'), { issue: true, amount: false, counterparty: true });
  });
});

const T0 = Date.UTC(2026, 10, 19, 3, 0);
const COPY: PhoneCopy = {
  asOf: T0 - 3600_000,
  profile: null,
  counterparties: [{ id: 'c1', name: '한빛전자', item: '컨설팅' }],
  issued: [],
  receivables: [],
};
const tag = (n: number) => n.toString(16).padStart(64, '0');
const say = (n: number, kind: string, text: string, ask: string | null = null): PhoneRespondResult => ({
  status: 'completed',
  output: { kind, text, show: [], ask },
  toolCalls: [],
  replay: [{ item: { type: 'message', content: [{ type: 'output_text', text: '' }] }, tag: tag(n) }],
});

function rig(o: { pc?: boolean; reply?: (n: number) => PhoneRespondResult }) {
  let id = 0;
  let saved: string | null = null;
  const reqs: PhoneRespondRequest[] = [];
  const model: PhoneModel = {
    runToken: async (s) => `rt-${s}-0123456789abcdef`,
    respond: async (req) => {
      reqs.push(req);
      return (o.reply ?? ((n) => say(n, 'smalltalk', '네, 말씀하세요.')))(reqs.length);
    },
  };
  const ports: PhoneChatPorts = {
    model,
    store: { load: async () => saved, save: async (d) => void (saved = d) },
    copy: () => COPY,
    now: () => T0,
    newId: () => `01KA${String(++id).padStart(22, '0')}`,
    randomHex: () => 'a'.repeat(32),
    ...(o.pc === undefined ? {} : { pcOnline: () => o.pc! }),
  };
  return { chat: new PhoneChat(ports), reqs };
}
const reply = (r: PhoneTurnResult) => {
  assert.equal(r.kind, 'reply', JSON.stringify(r));
  return r as Extract<PhoneTurnResult, { kind: 'reply' }>;
};

describe('폰 대화: 발급 의도와 PC 켜짐', () => {
  it('[사실]에 PC 줄: 켜짐·꺼짐, 포트가 없으면 꺼짐', async () => {
    for (const [pc, line] of [[true, 'PC: 켜짐'], [false, 'PC: 꺼짐'], [undefined, 'PC: 꺼짐']] as const) {
      const t = rig({ pc });
      await t.chat.send('안녕');
      assert.match(t.reqs[0]!.text, new RegExp(`\\[사실\\]\\n${line}\\n사본: fresh`));
    }
  });

  it('"5만원 끊어줘": 앱 판단 줄을 싣고, 모델이 잡담으로 넘기면 거래처를 되묻는다', async () => {
    const t = rig({ pc: true });
    const r = reply(await t.chat.send('5만원 끊어줘'));
    assert.match(t.reqs[0]!.text, /앱 판단: 세금계산서 발급 요청\n사용자: \[AMT_\d+\] 끊어줘/);
    assert.equal(r.reply, 'ask');
    assert.equal(r.text, PHONE_ASK_TEXT.counterparty);
    assert.equal(r.ask?.kind, 'counterparty');
  });

  it('"한빛전자 끊어 줘": 금액을 되묻는다. 모델이 되물었으면 그대로 둔다', async () => {
    const t = rig({});
    const r = reply(await t.chat.send('한빛전자 끊어 줘'));
    assert.equal(r.ask?.kind, 'amount');
    const t2 = rig({ reply: (n) => say(n, 'ask', '얼마로 할까요?', 'amount') });
    const r2 = reply(await t2.chat.send('한빛전자 끊어 줘'));
    assert.equal(r2.text, '얼마로 할까요?');
    assert.equal(r2.filtered, null);
  });

  it('조회 말에는 앱 판단 줄이 없고 안전망도 손대지 않는다', async () => {
    const t = rig({ reply: (n) => say(n, 'answer', '발급 기록을 찾지 못했어요.') });
    const r = reply(await t.chat.send('지난주 끊은 거 보여 줘'));
    assert.doesNotMatch(t.reqs[0]!.text, /앱 판단/);
    assert.equal(r.text, '발급 기록을 찾지 못했어요.');
  });
});
