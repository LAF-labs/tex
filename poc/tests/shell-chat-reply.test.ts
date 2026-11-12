// 대화 짧은 응대 배선(apps/desktop/src/chat-reply.ts, 엔진 chat.respond 계약 LAF-labs/tex#261): 응답 검사·오류 코드·되묻기 이어 가기·main/렌더러 배선.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { describe, it } from 'node:test';
import { CHAT_ERROR_TEXT, CHAT_SUGGEST_CHIPS, engineChatResponder, parseChatReply, suggestChips } from '../apps/desktop/src/chat-reply.ts';
import { INTENT_UNAVAILABLE_TEXT } from '../apps/desktop/src/intent-route.ts';
import { answersPending, type Counterparty, type Drafts } from '../apps/desktop/src/shell-model.ts';

const ok = { reply: '안녕하세요. 세금계산서 발급을 도와드릴까요?', kind: 'smalltalk', suggest: ['hometax.invoice.issue'], filtered: null };

describe('parseChatReply: 엔진 응답을 믿지 않는다', () => {
  it('계약 모양만 받는다', () => {
    assert.deepEqual(parseChatReply(ok), ok);
    assert.deepEqual(parseChatReply({ ...ok, suggest: [], filtered: 'advice', kind: 'tax_advice' }), { ...ok, suggest: [], filtered: 'advice', kind: 'tax_advice' });
    assert.deepEqual(parseChatReply({ ...ok, extra: '<img>' }), ok, '모르는 키는 버린다');
  });
  it('모양이 다르면 null', () => {
    for (const bad of [
      null,
      [],
      'hi',
      { ...ok, reply: '' },
      { ...ok, reply: '   ' },
      { ...ok, reply: 'ㄱ'.repeat(201) },
      { ...ok, kind: 'run' },
      { ...ok, filtered: 'other' },
      { ...ok, filtered: undefined },
      { ...ok, suggest: ['run.start'] },
      { ...ok, suggest: ['hometax.invoice.issue', 'hometax.invoice.issue'] },
      { ...ok, suggest: ['hometax.invoice.issue', 'hometax.invoice.issue', 'hometax.invoice.issue', 'hometax.invoice.issue'] },
      // 증명서는 지금 못 하는 일이라 제안 목록에 없다(#291)
      { ...ok, suggest: ['hometax.cert.taxpayment'] },
      { ...ok, suggest: 'hometax.invoice.issue' },
    ])
      assert.equal(parseChatReply(bad), null, JSON.stringify(bad));
  });
  it('제안 칩은 빠른 실행과 같은 시작 문장(입력창 채우기)', () => {
    assert.deepEqual(suggestChips(['hometax.invoice.issue']), [{ playbook: 'hometax.invoice.issue', label: '세금계산서 발급', text: '세금계산서 ' }]);
    assert.deepEqual(Object.keys(CHAT_SUGGEST_CHIPS), ['hometax.invoice.issue'], '증명서 칩은 없다(지금 못 하는 일)');
  });
});

describe('engineChatResponder: 엔진 rpc 위', () => {
  it('chat.respond에 문장만 보낸다', async () => {
    const calls: Array<[string, unknown]> = [];
    const r = await engineChatResponder(async (m, p) => (calls.push([m, p]), ok)).respond('안녕');
    assert.deepEqual(r, { reply: ok });
    assert.deepEqual(calls, [['chat.respond', { text: '안녕' }]]);
  });
  it('오류 코드는 표대로, 모르는 오류·시간 초과는 chat.unavailable, 모양 다름은 chat.bad_response(메시지 값은 옮기지 않는다)', async () => {
    const err = (m: string) => engineChatResponder(async () => Promise.reject(new Error(m))).respond('x');
    for (const c of Object.keys(CHAT_ERROR_TEXT)) assert.deepEqual(await err(c), { error: c });
    assert.deepEqual(await err('bad_text'), { error: 'chat.unavailable' });
    assert.deepEqual(await err('boom: A상사 3,300,000'), { error: 'chat.unavailable' });
    assert.deepEqual(await engineChatResponder(async () => ({ reply: 1 })).respond('x'), { error: 'chat.bad_response' });
    const t0 = Date.now();
    assert.deepEqual(await engineChatResponder(() => new Promise(() => {}), 50).respond('x'), { error: 'chat.unavailable' });
    assert.ok(Date.now() - t0 < 1_000);
  });
  it('문구: 연결 안 됨·응답 이상은 #260과 같은 문장 + 다시 시도, 한도·긴 문장·비밀 값은 다시 시도 없음', () => {
    assert.equal(CHAT_ERROR_TEXT['chat.unavailable'].text, INTENT_UNAVAILABLE_TEXT);
    assert.equal(CHAT_ERROR_TEXT['chat.bad_response'].text, INTENT_UNAVAILABLE_TEXT);
    assert.deepEqual(Object.entries(CHAT_ERROR_TEXT).filter(([, v]) => v.retry).map(([k]) => k), ['chat.unavailable', 'chat.bad_response', 'chat.budget_exceeded']);
    assert.match(CHAT_ERROR_TEXT['chat.budget_exceeded'].text, /잠시 뒤/);
    assert.match(CHAT_ERROR_TEXT['chat.quota_exceeded'].text, /이번 달 대화 한도/);
    assert.match(CHAT_ERROR_TEXT['chat.input_too_large'].text, /짧게/);
    assert.match(CHAT_ERROR_TEXT['chat.secret_rejected'].text, /비밀번호.*대화창에 입력하지 마세요/);
    for (const { text } of Object.values(CHAT_ERROR_TEXT)) for (const bad of ['데모', '절세', '세무대리', '대신 처리']) assert.ok(!text.includes(bad), `${bad}: ${text}`);
  });
});

describe('answersPending: 되묻던 것에 답하면 대화 응대로 보내지 않는다', () => {
  const cps = [{ name: '인스피릿' }, { name: 'A상사' }] as Counterparty[];
  const runs = (asked: 'counterparty' | 'amount' | null) => ({ counterparties: cps, pending: { asked, cp: null, amount: null } }) as unknown as Drafts;
  const p = (o: { counterparties?: string[]; amount?: number | null }) => ({ intent: 'other' as const, counterparties: o.counterparties ?? [], amount: o.amount ?? null, vat: null, item: null });
  it('거래처를 묻던 중 거래처 하나, 금액을 묻던 중 금액이면 이어 간다', () => {
    assert.equal(answersPending(p({ counterparties: ['인스피릿'] }), runs('counterparty')), true);
    assert.equal(answersPending(p({ amount: 500_000 }), runs('amount')), true);
  });
  it('묻던 것이 없거나 답이 아니면 대화 응대로', () => {
    assert.equal(answersPending(p({ counterparties: ['인스피릿'] }), runs(null)), false);
    assert.equal(answersPending(p({ counterparties: ['인스피릿', 'A상사'] }), runs('counterparty')), false);
    assert.equal(answersPending(p({}), runs('counterparty')), false);
    assert.equal(answersPending(p({ counterparties: ['인스피릿'] }), runs('amount')), false);
  });
});

describe('배선(main·렌더러)', () => {
  const src = fs.readFileSync(new URL('../apps/desktop/src/shell-app.ts', import.meta.url), 'utf8');
  const send = src.slice(src.indexOf("'request.send': async"), src.indexOf("'draft.update':"));
  it('unknown이고 되묻기 답이 아닐 때만 chat.respond, 실패는 정규식 대체 없이 오류 문장, sent는 그 호출까지 센다', () => {
    assert.match(send, /if \(r\.route\.outcome === 'unknown' && !answersPending\(local, runs, text\)\) \{\s*const c = await chatReply\.respond\(text\);\s*const sent = sentFromGateway\(gwIssuedSince\(mark\)\);/);
    assert.match(send, /if \('error' in c\) return \{ kind: 'unavailable', \.\.\.CHAT_ERROR_TEXT\[c\.error\], via, note: null, sent \};/);
    assert.match(send, /return \{ kind: 'chat', text: c\.reply\.reply, suggest: suggestChips\(c\.reply\.suggest\), filtered: c\.reply\.filtered, via, note: null, sent \};/);
    const chatPart = send.slice(send.indexOf("r.route.outcome === 'unknown'"), send.indexOf('const to = routed('));
    assert.doesNotMatch(chatPart, /interpret\(/);
    // 로그에는 결과 종류만(문장·답 없음)
    assert.match(send, /log\.event\('main\.chat', 'reply' in c \? \{ result: 'ok', kind: c\.reply\.kind, filtered: c\.reply\.filtered \?\? 'none', suggest: c\.reply\.suggest\.length \} : \{ result: c\.error \}\);/);
  });
  it('렌더러: 답은 텍스트로, 칩은 입력창 채우기, 다시 시도는 retry일 때만. chat.respond는 렌더러 IPC 표에 없다', () => {
    const shell = fs.readFileSync(new URL('../apps/desktop/static/shell/shell.js', import.meta.url), 'utf8');
    assert.match(shell, /if \(r\.kind === 'chat'\) \{\s*const box = h\('div', \{ class: 'sx-app', 'data-chat-reply': r\.filtered \?\? '' \}, h\('p', \{\}, r\.text\)\);/);
    assert.match(shell, /btn\(c\.label, \(\) => fillComposer\(c\.text\), '', \{ 'data-chat-suggest': c\.playbook \}\)/);
    assert.match(shell, /if \(r\.retry === false\) return;/);
    assert.doesNotMatch(shell, /innerHTML\s*=\s*r\./);
    const ipc = fs.readFileSync(new URL('../apps/desktop/src/ipc.ts', import.meta.url), 'utf8');
    assert.doesNotMatch(ipc, /chat\.respond/);
  });
});
