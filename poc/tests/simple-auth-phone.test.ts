// 폰에서 시작하는 간편인증(대표 결정 2026-11-19 A): 값 검사, 폰 답 해석, PC가 연 요청에만 받기, 셸 차례 코드.
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { checkIdentity, OACX_PROVIDERS } from '../packages/engine/src/run/simple-auth.ts';
import { encodeEnvelope, issueCmd, makeEnvelope, ulid, type CmdAckBody, type RunEventBody } from '@sax/remote';
import { kstToday } from '../apps/desktop/src/approval-gate.ts';
import { CmdLog, parseSimpleAnswer, PhoneIssue, type PhoneSink } from '../apps/desktop/src/phone-issue.ts';
import { interpret } from '../apps/desktop/src/shell-mock.ts';
import { ShellRuns, SIMPLE_SENT } from '../apps/desktop/src/shell-runs.ts';
import type { Counterparty, RunView } from '../apps/desktop/src/shell-model.ts';

const NOW = Date.parse('2026-11-19T03:00:00Z');
const CP: Counterparty = { id: 'cp_12', name: 'A상사', bizNo: '2148651233', rep: '이에이', email: 'tax@asangsa.example', item: '경영 컨설팅', status: '계속사업자', checkedOn: '', lastIssuedOn: null };

describe('간편인증 값', () => {
  it('인증 앱 코드·이름·생년월일·휴대폰 번호 검사', () => {
    const ok = { provider: 'kakao', name: '홍길동', birth: '19900101', phone: '01012345678' };
    assert.equal(checkIdentity(ok), null);
    assert.equal(checkIdentity({ ...ok, provider: 'pass' }), 'simple.carrier', 'PASS는 통신사가 있어야 한다');
    assert.equal(checkIdentity({ ...ok, provider: 'pass', carrier: 'SA' }), null);
    assert.equal(checkIdentity({ ...ok, carrier: 'S' }), 'simple.carrier', 'PASS가 아니면 통신사가 없다');
    assert.equal(checkIdentity({ ...ok, provider: 'nope' }), 'simple.provider');
    assert.equal(checkIdentity({ ...ok, birth: '19901301' }), 'simple.birth');
    assert.equal(checkIdentity({ ...ok, phone: '0101234' }), 'simple.phone');
    assert.equal(checkIdentity({ ...ok, name: '1234' }), 'simple.name');
    assert.ok(Object.keys(OACX_PROVIDERS).length >= 10);
  });
  it('폰 답 해석(64자 안)', () => {
    const v = 'sa1:req:kakaobank:19900101:01012345678:남궁민수아름다운이름입니다';
    assert.ok(v.length <= 64);
    assert.deepEqual(parseSimpleAnswer(v), { op: 'request', d: { provider: 'kakaobank', birth: '19900101', phone: '01012345678', name: '남궁민수아름다운이름입니다' } });
    assert.deepEqual(parseSimpleAnswer('sa1:done'), { op: 'complete' });
    assert.deepEqual(parseSimpleAnswer('sa1:req:pass-ka:19900101:01012345678:홍길동'), { op: 'request', d: { provider: 'pass', birth: '19900101', phone: '01012345678', name: '홍길동', carrier: 'KA' } });
    assert.equal(parseSimpleAnswer('sa1:req:kakao:1990:010:x'), null);
    assert.equal(parseSimpleAnswer(42), null);
  });
});

class Sink implements PhoneSink {
  sent: Array<{ type: string; body: unknown }> = [];
  send(type: string, body: unknown): unknown {
    this.sent.push({ type, body });
    return null;
  }
}

describe('PhoneIssue 간편인증', () => {
  it('공동인증서 실패 차례면 human.request(manual simple_auth)를 열고, 그 reqId의 답만 셸로 넘긴다. 못 하면 login.simple_failed', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sa-'));
    const runs = new Map<string, RunView>();
    const calls: Array<[string, string, unknown]> = [];
    let fail = false;
    const base = (o: Partial<RunView>) => ({ id: 'run-1', doc: 'H-01', cert: null, status: 'preparing', createdAt: '', counterparty: { id: CP.id, name: CP.name, bizNo: CP.bizNo, first: false }, email: { value: '', first: false }, amount: 1, vat: 'separate', vatGuessed: false, supply: 100_000, tax: 10_000, total: 110_000, item: '과일', itemGuessed: false, writeDate: '', auth: '', steps: [{ label: '로그인', state: 'now' }], turn: null, confirmed: false, result: null, warnings: [], ...o }) as RunView;
    const p = new PhoneIssue({
      counterparty: () => CP,
      createDraft: () => (runs.set('run-1', base({ status: 'draft' })), runs.get('run-1')!),
      prepare: async () => {},
      anyActive: () => false,
      get: (id) => runs.get(id),
      cmds: new CmdLog(path.join(dir, 'c.json')),
      simpleAuth: async (id, op, d) => {
        calls.push([id, op, d]);
        if (fail) throw new Error('simple.fill_failed');
      },
      now: () => NOW,
    });
    const sink = new Sink();
    p.attach('p', sink);
    const ack = (await p.handle('p', sink, issueCmd(ulid(NOW), { counterpartyRef: CP.id, supply: 100_000, tax: 10_000, item: '과일', day: kstToday(NOW) }))) as CmdAckBody;
    runs.set('run-1', base({ status: 'turn', handoff: { phase: 'login', afterGate: false, kind: 'login', code: 'login.simple_auth' } }));
    p.update(runs.get('run-1')!);
    const hr = sink.sent.find((x) => x.type === 'human.request')!.body as { reqId: string; runId: string; kind: string; prompt: string };
    assert.deepEqual([hr.runId, hr.kind, hr.prompt], [ack.runId, 'manual', 'simple_auth']);
    assert.ok(encodeEnvelope(makeEnvelope('human.request' as never, hr as never, { pairId: ulid(), from: 'desktop', seq: 1 })), '스키마 통과');
    // 다른 reqId·다른 폰은 받지 않는다
    assert.equal(await p.human('p', sink, { runId: ack.runId, reqId: ulid(), value: 'sa1:done' }), false);
    assert.equal(await p.human('q', sink, { runId: ack.runId, reqId: hr.reqId, value: 'sa1:done' }), false);
    assert.equal(calls.length, 0);
    assert.equal(await p.human('p', sink, { runId: ack.runId, reqId: hr.reqId, value: 'sa1:req:kakao:19900101:01012345678:홍길동' }), true);
    assert.deepEqual(calls[0], ['run-1', 'request', { provider: 'kakao', birth: '19900101', phone: '01012345678', name: '홍길동' }]);
    // 셸이 요청을 보낸 차례: 폰에는 앱과 마감
    runs.set('run-1', { ...runs.get('run-1')!, handoff: { phase: 'login', afterGate: false, kind: 'login', code: SIMPLE_SENT }, simpleAuth: { provider: 'kakao', deadline: NOW + 300_000 } });
    p.update(runs.get('run-1')!);
    const ev = sink.sent.filter((x) => x.type === 'run.event').at(-1)!.body as RunEventBody;
    assert.deepEqual([ev.event, ev.code, ev.deadline], ['turn', 'login.simple_sent.kakao', NOW + 300_000]);
    assert.ok(encodeEnvelope(makeEnvelope('run.event', ev, { pairId: ulid(), from: 'desktop', seq: 1 })));
    fail = true;
    assert.equal(await p.human('p', sink, { runId: ack.runId, reqId: hr.reqId, value: 'sa1:done' }), false);
    assert.ok(sink.sent.some((x) => x.type === 'run.event' && (x.body as RunEventBody).code === 'login.simple_failed'));
  });
});

class FakeHost extends EventEmitter {
  readonly calls: Array<[string, Record<string, unknown>]> = [];
  reply: Record<string, unknown> = {};
  async control(): Promise<unknown> {
    return {};
  }
  async rpc(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    this.calls.push([method, params]);
    return this.reply[method] ?? {};
  }
}

describe('셸 간편인증 차례', () => {
  it('요청을 보내면 login.simple_sent(앱·마감, 값은 카드에 없음), [승인했어요]는 완료 뒤 준비 중', async () => {
    const host = new FakeHost();
    const runs = new ShellRuns(host, { counterparties: () => [CP], auth: () => '공동인증서' });
    const a = interpret('A상사에 16만원 세금계산서', null, 'business', runs);
    assert.ok(a.kind === 'draft');
    await runs.prepare(a.run.id);
    const r0 = runs.get(a.run.id)!;
    r0.certRetryOf = 'run-0'; // 이미 한 번 다시 했다
    host.emit('run', { runId: a.run.id, type: 'handoff', phase: 'login', code: 'login.simple_auth' });
    host.reply['run.simpleAuth'] = { ok: true };
    const r = await runs.simpleAuth(a.run.id, 'request', { provider: 'kakao', name: '홍길동', birth: '19900101', phone: '01012345678' });
    assert.equal(r.handoff?.code, SIMPLE_SENT);
    assert.equal(r.simpleAuth?.provider, 'kakao');
    assert.match(r.turn!.text, /카카오톡에서 간편인증을 승인해 주세요/);
    assert.ok(!JSON.stringify(r).includes('01012345678') && !JSON.stringify(r).includes('홍길동'));
    assert.deepEqual(host.calls.find(([m]) => m === 'run.simpleAuth')![1], { runId: a.run.id, op: 'request', provider: 'kakao', name: '홍길동', birth: '19900101', phone: '01012345678' });
    host.reply['run.simpleAuth'] = { ok: false, code: 'simple.no_complete_button' };
    await assert.rejects(runs.simpleAuth(a.run.id, 'complete'), /simple\.no_complete_button/);
    host.reply['run.simpleAuth'] = { ok: true };
    const done = await runs.simpleAuth(a.run.id, 'complete');
    assert.equal(done.status, 'preparing');
    assert.equal(done.simpleAuth, undefined);
  });
});
