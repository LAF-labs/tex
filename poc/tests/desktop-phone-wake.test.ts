// 폰 깨우기(ADR-053 결정 2): phone-wake PhoneWaker, PhoneGate의 approve 깨우기, PhoneIssue의 update 깨우기, 데스크톱 클라이언트 POST /v1/wake.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { issueCmd, ulid, type GateRequestBody } from '@sax/remote';
import { buildGateRequest, type GateRequest } from '@sax/engine/gate';
import { kstToday } from '../apps/desktop/src/approval-gate.ts';
import { ApprovalLog, PhoneGate, type GateSink } from '../apps/desktop/src/phone-gate.ts';
import { CmdLog, PhoneIssue, wakeWorthy, type PhoneSink } from '../apps/desktop/src/phone-issue.ts';
import { PhoneWaker, WAKE_APPROVE_AGAIN_MS, WAKE_DETACHED_MS, WAKE_NO_TOKEN_MS, type WakeKind } from '../apps/desktop/src/phone-wake.ts';
import type { Counterparty, RunView } from '../apps/desktop/src/shell-model.ts';

let dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs) await fs.rm(d, { recursive: true, force: true });
  dirs = [];
});
const tmp = async () => {
  const d = await fs.mkdtemp(path.join(os.tmpdir(), 'phone-wake-'));
  dirs.push(d);
  return d;
};

const NOW = Date.parse('2026-11-19T03:00:00Z');
const TODAY = kstToday(NOW);
const PAIR = 'pair-1';
const DEV = '3f2b9b7a-1c2d-4e5f-8a9b-0c1d2e3f4a5b';
const err = (code: string) => Object.assign(new Error(code), { code });

describe('PhoneWaker', () => {
  it('폰 deviceId와 종류만 보낸다. 토큰이 없다는 답이면 1시간 쉬고, 세션이 붙으면 푼다. 한도·오류는 던지지 않는다', async () => {
    let now = NOW;
    const calls: Array<[string, WakeKind]> = [];
    let answer: () => Promise<{ sent: boolean }> = async () => ({ sent: true });
    const logs: Array<Record<string, unknown>> = [];
    const w = new PhoneWaker({ deviceOf: (p) => (p === PAIR ? DEV : null), call: (d, k) => (calls.push([d, k]), answer()), now: () => now, log: (_n, d) => void logs.push(d) });
    assert.equal(await w.wake(PAIR, 'approve'), 'sent');
    assert.equal(await w.wake('gone', 'update'), 'no_phone');
    answer = async () => ({ sent: false });
    assert.equal(await w.wake(PAIR, 'update'), 'not_sent');
    answer = () => Promise.reject(err('policy.rate_limited'));
    assert.equal(await w.wake(PAIR, 'update'), 'limited');
    answer = () => Promise.reject(err('net.network'));
    assert.equal(await w.wake(PAIR, 'update'), 'net.network');
    answer = () => Promise.reject(new Error('boom'));
    assert.equal(await w.wake(PAIR, 'update'), 'error');
    answer = () => Promise.reject(err('push.token_not_found'));
    assert.equal(await w.wake(PAIR, 'approve'), 'no_token');
    const n = calls.length;
    answer = async () => ({ sent: true });
    assert.equal(await w.wake(PAIR, 'approve'), 'quiet');
    now += WAKE_NO_TOKEN_MS - 1;
    assert.equal(await w.wake(PAIR, 'approve'), 'quiet');
    assert.equal(calls.length, n, '쉬는 동안 부르지 않는다');
    now += 1;
    assert.equal(await w.wake(PAIR, 'approve'), 'sent');
    answer = () => Promise.reject(err('push.token_not_found'));
    await w.wake(PAIR, 'approve');
    w.forget(PAIR);
    answer = async () => ({ sent: true });
    assert.equal(await w.wake(PAIR, 'approve'), 'sent', '세션이 붙으면(새 토큰일 수 있다) 다시 부른다');
    assert.ok(calls.every(([d]) => d === DEV));
    for (const l of logs) assert.ok(!JSON.stringify(l).includes(DEV), '로그에 기기 ID 없음');
    const off = new PhoneWaker({ deviceOf: () => DEV, call: null });
    assert.equal(await off.wake(PAIR, 'approve'), 'no_cloud');
  });
});

const readback = {
  supplierBizNo: '1234567890', supplierName: '율무상회', counterpartBizNo: '2110987654', counterpartName: '가나식자재', counterpartEmail: 'tax@ganafood.example',
  itemName: '과일', itemCount: '1', supplyAmount: '800000', taxAmount: '80000', totalAmount: '880000', issueDate: TODAY, remark: '', receiptType: '청구',
};
const gateReq = (first = false): GateRequest =>
  buildGateRequest({
    runId: 'engine-run', gateStepId: 's20', readback,
    reserved: [{ fieldKey: '$first.bizNo', value: String(first) }, { fieldKey: '$first.email', value: 'false' }],
    packageDigest: 'ab'.repeat(32), authorizes: ['s21'], intentId: ulid(NOW), waitMs: 600_000,
  });

class Sink implements GateSink {
  sent: GateRequestBody[] = [];
  send(_t: 'gate.request', body: GateRequestBody): unknown {
    this.sent.push(body);
    return null;
  }
}

async function gateWorld(o: { px?: boolean } = {}) {
  const dir = await tmp();
  const wakes: Array<[string, WakeKind]> = [];
  const attached: string[] = [];
  const timers: Array<{ f: () => void; ms: number; live: boolean }> = [];
  const gate = new PhoneGate({
    px: () => (o.px === false ? null : { pub: new Uint8Array(65), hw: 'ios_se', deviceId: DEV }),
    tracked: (id) => (id.startsWith('run-') ? { pairId: PAIR, runId: ulid(NOW) } : null),
    poke: () => {},
    approvals: new ApprovalLog(path.join(dir, 'remote-approvals.json')),
    now: () => NOW,
    wake: (p, k) => void wakes.push([p, k]),
    attached: (p) => void attached.push(p),
    timers: {
      set: (f, ms) => {
        const t = { f, ms, live: true };
        timers.push(t);
        return t;
      },
      clear: (h) => void ((h as { live: boolean }).live = false),
    },
  });
  const fire = () => {
    for (const t of timers.splice(0)) if (t.live) t.f();
  };
  const on = { approve: () => {}, deny: () => {} };
  return { gate, wakes, attached, timers, fire, on };
}

describe('PhoneGate: 승인 게이트를 열 때 폰이 없으면 approve로 깨운다', () => {
  it('세션이 없으면 열 때 한 번, 60초 뒤에도 없으면 한 번 더(게이트당 최대 2번)', async () => {
    const w = await gateWorld();
    assert.equal(await w.gate.offer('run-1', gateReq(), w.on), true);
    assert.deepEqual(w.wakes, [[PAIR, 'approve']]);
    assert.equal(w.timers[0]!.ms, WAKE_APPROVE_AGAIN_MS);
    w.fire();
    assert.deepEqual(w.wakes, [[PAIR, 'approve'], [PAIR, 'approve']]);
    assert.equal(w.timers.length, 0, '세 번째는 없다');
    w.fire();
    assert.equal(w.wakes.length, 2);
  });

  it('세션이 붙으면 다시 깨우지 않고 바로 보낸다. 붙어 있으면 아예 깨우지 않는다', async () => {
    const w = await gateWorld();
    await w.gate.offer('run-1', gateReq(), w.on);
    const sink = new Sink();
    w.gate.attach(PAIR, sink);
    assert.deepEqual(w.attached, [PAIR]);
    assert.equal(sink.sent.length, 1, '붙으면 새 챌린지로 보낸다');
    assert.equal(w.timers[0]!.live, false, '다시 깨우기 취소');
    w.fire();
    assert.equal(w.wakes.length, 1);
    await w.gate.offer('run-2', gateReq(), w.on);
    assert.equal(w.wakes.length, 1, '앱이 앞에 있으면 깨우지 않는다');
  });

  it('보낸 승인 요청에 답 없이 세션이 닫히면 5초 뒤 깨운다. 그 사이 다시 붙으면 깨우지 않는다', async () => {
    const w = await gateWorld();
    const sink = new Sink();
    w.gate.attach(PAIR, sink);
    await w.gate.offer('run-1', gateReq(), w.on);
    assert.equal(sink.sent.length, 1);
    assert.deepEqual(w.wakes, []);
    // 앱이 뒤로 갔다가 바로 다시 붙었다
    w.gate.detach(PAIR, sink);
    assert.equal(w.timers[0]!.ms, WAKE_DETACHED_MS);
    const back = new Sink();
    w.gate.attach(PAIR, back);
    assert.equal(w.timers[0]!.live, false);
    w.fire();
    assert.deepEqual(w.wakes, []);
    // 이번엔 닫힌 채
    w.gate.detach(PAIR, back);
    w.fire();
    assert.deepEqual(w.wakes, [[PAIR, 'approve']]);
    assert.equal(w.timers[0]!.ms, WAKE_APPROVE_AGAIN_MS);
    w.fire();
    assert.equal(w.wakes.length, 2, '게이트당 최대 2번');
    const third = new Sink();
    w.gate.attach(PAIR, third);
    w.gate.detach(PAIR, third);
    assert.equal(w.timers.length, 0, '세 번째는 없다');
    // 닫힌 게이트, 아직 보낸 적 없는 다른 폰 세션의 detach는 깨우지 않는다
    const w2 = await gateWorld();
    const s2 = new Sink();
    w2.gate.attach(PAIR, s2);
    await w2.gate.offer('run-1', gateReq(), w2.on);
    w2.gate.close('run-1');
    w2.gate.detach(PAIR, s2);
    assert.equal(w2.timers.length, 0);
  });

  it('게이트가 닫히면(PC 승인·중지) 다시 깨우지 않는다', async () => {
    const w = await gateWorld();
    await w.gate.offer('run-1', gateReq(), w.on);
    w.gate.close('run-1');
    assert.equal(w.timers[0]!.live, false);
    w.fire();
    assert.equal(w.wakes.length, 1);
  });

  it('폰으로 못 보내는 게이트(처음 거래처, 승인 키 없음)는 approve로 깨우지 않는다(update는 PhoneIssue가 한다)', async () => {
    const w = await gateWorld();
    await w.gate.offer('run-1', gateReq(true), w.on);
    assert.equal(w.gate.codeOf('run-1'), 'pc_first');
    const nokey = await gateWorld({ px: false });
    await nokey.gate.offer('run-1', gateReq(), nokey.on);
    assert.equal(nokey.gate.codeOf('run-1'), 'pc_key');
    assert.deepEqual([...w.wakes, ...nokey.wakes], []);
    assert.equal(w.timers.length + nokey.timers.length, 0);
  });

  it('PC가 시작한 실행은 깨우지 않는다', async () => {
    const w = await gateWorld();
    assert.equal(await w.gate.offer('pc-run', gateReq(), w.on), false);
    assert.deepEqual(w.wakes, []);
  });
});

const CP: Counterparty = { id: 'cp_12', name: '가나식자재', bizNo: '2110987654', rep: '김가나', email: 'tax@ganafood.example', item: '식자재', status: '정상', checkedOn: '2026-11-01', lastIssuedOn: '2026-10-31' };
const LABELS = ['홈택스 로그인', '세금계산서 화면 열기', '내용 넣기', '넣은 내용 확인', '사장님 승인', '인증서로 서명', '발급됐는지 확인', '메일 보낸 것 확인'];
const steps = (at: number) => LABELS.map((label, i) => ({ label, state: i < at ? 'done' : i === at ? 'now' : 'todo' }));
const baseRun = (id: string): RunView =>
  ({
    id, doc: 'H-01', cert: null, status: 'draft', createdAt: '10:00', counterparty: { id: CP.id, name: CP.name, bizNo: CP.bizNo, first: false }, email: { value: CP.email, first: false },
    amount: 800_000, vat: 'separate', vatGuessed: false, supply: 800_000, tax: 80_000, total: 880_000, item: '과일', itemGuessed: false, writeDate: TODAY, auth: '공동인증서',
    steps: steps(-1), turn: null, confirmed: false, result: null, warnings: [],
  }) as unknown as RunView;

class IssueSink implements PhoneSink {
  n = 0;
  send(): unknown {
    this.n++;
    return null;
  }
}

describe('PhoneIssue: 폰이 맡긴 일에 새 소식이 생기면 update로 깨운다', () => {
  it('끝·멈춤·사람 차례·PC 승인(pc_*)만, 같은 소식은 한 번, 세션이 있으면 깨우지 않는다', async () => {
    const dir = await tmp();
    const runs = new Map<string, RunView>();
    const wakes: string[] = [];
    const st: { code?: string } = {};
    const p = new PhoneIssue({
      counterparty: () => CP,
      createDraft: () => {
        const r = baseRun('run-1');
        runs.set(r.id, r);
        return r;
      },
      prepare: async () => {},
      anyActive: () => false,
      get: (id) => runs.get(id),
      cmds: new CmdLog(path.join(dir, 'remote-cmds.json')),
      approveCode: () => st.code,
      now: () => NOW,
      wake: (pair, kind) => void wakes.push(`${pair}:${kind}`),
    });
    const live = new IssueSink();
    p.attach(PAIR, live);
    await p.handle(PAIR, live, issueCmd(ulid(NOW), { counterpartyRef: CP.id, supply: 800_000, tax: 80_000, item: '과일', day: TODAY }));
    const r = runs.get('run-1')!;
    p.update({ ...r, status: 'preparing', steps: steps(0) } as RunView);
    p.update({ ...r, status: 'turn', steps: steps(0), handoff: { phase: 'login', afterGate: false, kind: 'login', code: 'login.simple_auth' } } as RunView);
    assert.deepEqual(wakes, [], '세션이 붙어 있으면 깨우지 않는다');
    // 폰이 앱을 닫았다
    p.detach(PAIR, live);
    p.update({ ...r, status: 'preparing', steps: steps(2) } as RunView);
    assert.deepEqual(wakes, [], '진행 단계는 깨우지 않는다');
    p.update({ ...r, status: 'turn', steps: steps(2), handoff: { phase: 'fill', afterGate: false, kind: 'login', code: 'login.simple_auth' } } as RunView);
    assert.deepEqual(wakes, [`${PAIR}:update`], '사람 차례');
    const waiting = { ...r, status: 'waiting', steps: steps(4) } as RunView;
    runs.set('run-1', waiting);
    p.update(waiting);
    assert.equal(wakes.length, 1, '폰 승인으로 가는 승인 단계는 phone-gate가 approve로 깨운다');
    st.code = 'pc_first';
    p.poke('run-1');
    p.poke('run-1');
    assert.equal(wakes.length, 2, 'PC에서 승인해야 함, 같은 소식은 한 번');
    const done = { ...r, status: 'done', steps: steps(8), result: { approvalNo: '20261119-41000000-12345678', mailTo: CP.email, docId: '', doneAt: '12:03', mailConfirmed: true } } as unknown as RunView;
    runs.set('run-1', done);
    p.update(done);
    p.update(done);
    assert.equal(wakes.length, 3, '발급 끝남');
    // 다시 붙으면 끝 소식을 받는다(깨우기와 상관없이)
    const back = new IssueSink();
    p.attach(PAIR, back);
    assert.equal(back.n, 1);
    assert.equal(wakes.length, 3);
  });

  it('wakeWorthy', () => {
    const ev = { runId: ulid(), cmdId: ulid(), at: NOW, status: 'x' };
    assert.equal(wakeWorthy({ ...ev, event: 'end', phase: 'stopped' } as never), true);
    assert.equal(wakeWorthy({ ...ev, event: 'turn', phase: 'login' } as never), true);
    assert.equal(wakeWorthy({ ...ev, event: 'phase', phase: 'approve', code: 'pc_limit' } as never), true);
    assert.equal(wakeWorthy({ ...ev, event: 'phase', phase: 'approve' } as never), false);
    assert.equal(wakeWorthy({ ...ev, event: 'phase', phase: 'verify' } as never), false);
  });
});
