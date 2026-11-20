import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { PhoneChat, issueIntent, type PhoneChatPorts, type PhoneCopy, type PhoneModel, type PhoneRespondRequest, type PhoneRespondResult, type PhoneTurnResult } from '@sax/chat-core';

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

  it('"5만원 끊어줘": 앱 판단 줄을 싣고, 모델이 잡담으로 넘기면 고정 답 없이 모델을 한 번 더 부른다(그 답을 쓴다)', async () => {
    const t = rig({ pc: true, reply: (n) => (n === 1 ? say(n, 'smalltalk', '네, 말씀하세요.') : say(n, 'ask', '어느 거래처에 끊을까요?', 'counterparty')) });
    const r = reply(await t.chat.send('5만원 끊어줘'));
    assert.match(t.reqs[0]!.text, /앱 판단: 세금계산서 발급 요청\n사용자: \[AMT_\d+\] 끊어줘/);
    assert.equal(t.reqs.length, 2);
    assert.match(t.reqs[1]!.text, /앱 판단: 세금계산서 발급 요청\(앞 답이 발급으로 잇지 않았다/);
    assert.equal(t.reqs[1]!.replay.length, 0, '다시 부를 때는 앞 답을 잇지 않는다');
    assert.equal(r.text, '어느 거래처에 끊을까요?');
    assert.equal(r.ask?.kind, 'counterparty');
  });

  it('다시 불러도 넘기면 모델 답을 그대로 쓴다(고정 문장으로 바꾸지 않는다). 모델이 처음부터 되물었으면 한 번만 부른다', async () => {
    const t = rig({ reply: (n) => say(n, 'smalltalk', '좋아요.') });
    const r = reply(await t.chat.send('한빛전자 끊어 줘'));
    assert.equal(t.reqs.length, 2);
    assert.equal(r.text, '좋아요.');
    const t2 = rig({ reply: (n) => say(n, 'ask', '얼마로 할까요?', 'amount') });
    const r2 = reply(await t2.chat.send('한빛전자 끊어 줘'));
    assert.equal(t2.reqs.length, 1);
    assert.equal(r2.text, '얼마로 할까요?');
  });

  it('일상 말("오늘 점심 뭐 먹을까?")은 앱 판단 줄 없이 모델 답 그대로, 한 번만 부른다', async () => {
    const t = rig({ reply: (n) => say(n, 'smalltalk', '날이 쌀쌀하니 따뜻한 국밥 어떠세요?') });
    const r = reply(await t.chat.send('오늘 점심 뭐 먹을까?'));
    assert.doesNotMatch(t.reqs[0]!.text, /앱 판단/);
    assert.equal(t.reqs.length, 1);
    assert.equal(r.text, '날이 쌀쌀하니 따뜻한 국밥 어떠세요?');
  });

  it('open_screen: 모델이 화면을 열면 단추(show screen)로 붙는다', async () => {
    const tag2 = (n: number) => n.toString(16).padStart(64, '0');
    const t = rig({
      reply: (n) =>
        n === 1
          ? { status: 'completed', output: undefined, toolCalls: [{ callId: 'c1', name: 'open_screen', arguments: { screen: 'capture' } }], replay: [{ item: { type: 'function_call', call_id: 'c1', name: 'open_screen', arguments: '{"screen":"capture"}' }, tag: tag2(n) }] }
          : say(n, 'answer', '아래 단추로 바로 찍을 수 있어요.'),
    });
    const r = reply(await t.chat.send('영수증 찍을래'));
    assert.equal((t.reqs[1]!.replay[1] as { output: string }).output, '{"ref":null,"status":"screen_shown","fields":null,"needs":null}');
    assert.deepEqual(r.show, [{ type: 'screen', screen: 'capture' }]);
    assert.equal(r.text, '아래 단추로 바로 찍을 수 있어요.');
  });

  it('조회 말에는 앱 판단 줄이 없고 안전망도 손대지 않는다', async () => {
    const t = rig({ reply: (n) => say(n, 'answer', '발급 기록을 찾지 못했어요.') });
    const r = reply(await t.chat.send('지난주 끊은 거 보여 줘'));
    assert.doesNotMatch(t.reqs[0]!.text, /앱 판단/);
    assert.equal(r.text, '발급 기록을 찾지 못했어요.');
  });
});
