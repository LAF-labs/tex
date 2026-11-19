// PC 쪽 폰 발급 명령·폰 사본(remote-envelope v1.8, ADR-046 결정 2·5): apps/desktop/src/phone-issue.ts·phone-copy.ts·phone-session.ts.
// 단위(입력 해석·단계·답) + 라이브 세션 한 번(폰이 사본을 받고, cmd.run → cmd.ack pc_only → run.event).
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import {
  CAP, MemoryRelay, b64, fromB64, hpkeOpen, issueCmd, MAX_INNER, encodeEnvelope, makeEnvelope, monotonicClock, openMobileSession, ulid, x25519Keygen,
  type CmdAckBody, type Link, type PhoneCopyBody, type RelayLink, type RunEventBody,
} from '@sax/remote';
import { kstToday } from '../apps/desktop/src/approval-gate.ts';
import { alertOf, bizNoOf, buildPhoneCopy, copyCounterparties, copyMoney, lastIssues, maskEmail, type BankSummaryLike, type CashFlowLike } from '../apps/desktop/src/phone-copy.ts';
import { CmdLog, eventOf, parseIssueInputs, phaseOf, PhoneIssue, type PhoneIssuePorts, type PhoneSink } from '../apps/desktop/src/phone-issue.ts';
import { PhoneLink, PhoneStore, type TokenSeal } from '../apps/desktop/src/phone-link.ts';
import { phoneReceiver } from '../apps/desktop/src/phone-receive.ts';
import { phoneSession, SESSION_CAPS } from '../apps/desktop/src/phone-session.ts';
import type { Counterparty, RunView } from '../apps/desktop/src/shell-model.ts';
import { pairOnce, pairWorld, until } from './remote-support.ts';

let dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs) await fs.rm(d, { recursive: true, force: true });
  dirs = [];
});
const tmp = async () => {
  const d = await fs.mkdtemp(path.join(os.tmpdir(), 'phone-issue-'));
  dirs.push(d);
  return d;
};

const NOW = Date.parse('2026-11-17T01:00:00Z');
const TODAY = kstToday(NOW);
const CP: Counterparty = { id: 'cp_12', name: '가나식자재', bizNo: '2110987654', rep: '김가나', email: 'tax@ganafood.example', item: '식자재', status: '정상', checkedOn: '2026-11-01', lastIssuedOn: '2026-10-31' };
const STEP_LABELS = ['홈택스 로그인', '세금계산서 화면 열기', '내용 넣기', '넣은 내용 확인', '사장님 승인', '인증서로 서명', '발급됐는지 확인', '메일 보낸 것 확인'];

function run(over: Partial<RunView> & { at?: number } = {}): RunView {
  const at = over.at ?? -1;
  return {
    id: 'run-abc',
    doc: 'H-01',
    cert: null,
    status: 'preparing',
    createdAt: '10:00',
    counterparty: { id: CP.id, name: CP.name, bizNo: CP.bizNo, first: false },
    email: { value: CP.email, first: false },
    amount: 800_000,
    vat: 'separate',
    vatGuessed: false,
    supply: 800_000,
    tax: 80_000,
    total: 880_000,
    item: '과일',
    itemGuessed: false,
    writeDate: TODAY,
    auth: '공동인증서',
    steps: STEP_LABELS.map((label, i) => ({ label, state: i < at ? 'done' : i === at ? 'now' : 'todo' })),
    turn: null,
    confirmed: false,
    result: null,
    warnings: [],
    ...over,
  } as RunView;
}

const req = { counterpartyRef: 'cp_12', supply: 800_000, tax: 80_000, item: '과일', day: TODAY };

class Sink implements PhoneSink {
  acks: CmdAckBody[] = [];
  events: RunEventBody[] = [];
  send(type: 'cmd.ack' | 'run.event', body: CmdAckBody | RunEventBody): unknown {
    if (type === 'cmd.ack') this.acks.push(body as CmdAckBody);
    else this.events.push(body as RunEventBody);
    return null;
  }
}

async function issueWorld(over: Partial<PhoneIssuePorts> = {}) {
  const dir = await tmp();
  const runs = new Map<string, RunView>();
  const prepared: string[] = [];
  const drafts: Array<{ supply: number; item: string }> = [];
  const p = new PhoneIssue({
    counterparty: (ref) => (ref === CP.id ? CP : null),
    createDraft: (cp, supply, item) => {
      drafts.push({ supply, item });
      const r = run({ id: `run-${drafts.length}`, status: 'draft', counterparty: { id: cp.id, name: cp.name, bizNo: cp.bizNo, first: false }, item, supply });
      runs.set(r.id, r);
      return r;
    },
    prepare: async (id) => void prepared.push(id),
    anyActive: () => false,
    get: (id) => runs.get(id),
    cmds: new CmdLog(path.join(dir, 'remote-cmds.json')),
    now: () => NOW,
    ...over,
  });
  return { p, runs, prepared, drafts, dir };
}

describe('폰 발급 명령 입력 해석', () => {
  it('issueCmd가 만든 입력을 그대로 읽는다', () => {
    assert.deepEqual(parseIssueInputs(issueCmd(ulid(), req).inputs), req);
  });
  it('모르는 칸·사업자번호·이메일·품목 줄 불일치는 받지 않는다', () => {
    const ok = issueCmd(ulid(), req).inputs as Record<string, unknown>;
    assert.equal(parseIssueInputs({ ...ok, email: 'a@b.c' }), null);
    assert.equal(parseIssueInputs({ ...ok, counterpart: { counterpartyRef: 'cp_12', bizNo: '211-09-87654' } }), null);
    assert.equal(parseIssueInputs({ ...ok, items: [{ name: '과일', supply: 1, tax: 0 }] }), null);
    assert.equal(parseIssueInputs({ ...ok, amounts: { supply: '800000', tax: 80000 } }), null);
    assert.equal(parseIssueInputs(null), null);
  });
});

describe('셸 실행 → 폰 단계', () => {
  it('단계 순서대로 바뀐다', () => {
    assert.equal(phaseOf(run({ status: 'draft' })), 'prepare');
    assert.equal(phaseOf(run({ at: 0 })), 'login');
    assert.equal(phaseOf(run({ at: 2 })), 'prepare');
    assert.equal(phaseOf(run({ at: 3 })), 'readback');
    assert.equal(phaseOf(run({ status: 'waiting', at: 4 })), 'approve');
    assert.equal(phaseOf(run({ status: 'issuing', at: 5 })), 'issue');
    assert.equal(phaseOf(run({ status: 'issuing', at: 6 })), 'verify');
    assert.equal(phaseOf(run({ status: 'stopped' })), 'stopped');
    assert.equal(phaseOf(run({ status: 'attention', at: 3 })), 'readback', '끝나지 않은 주의는 그 단계');
    assert.equal(phaseOf(run({ status: 'attention', endedAt: 1 })), 'stopped');
  });
  it('끝나면 승인번호·합계·메일 확인만 싣는다(거래처·품목 없음)', () => {
    const docId = '3f2b9b7a-1c2d-4e5f-8a9b-0c1d2e3f4a5b';
    const r = run({ status: 'done', result: { approvalNo: '20261117-41000000-12345678', mailTo: CP.email, docId, doneAt: '10:03', mailConfirmed: true } });
    const ev = eventOf(r, ulid(NOW), ulid(NOW), NOW);
    assert.equal(ev.event, 'end');
    assert.deepEqual(ev.result, { approvalNo: '20261117-41000000-12345678', total: 880_000, emailSent: true, docId });
    assert.ok(!JSON.stringify(ev).includes(CP.name) && !JSON.stringify(ev).includes(CP.email));
    // 스키마 통과
    assert.ok(encodeEnvelope(makeEnvelope('run.event', ev, { pairId: ulid(), from: 'desktop', seq: 1 })));
    const v = eventOf(run({ status: 'issuing', at: 6, verifyAttempt: 3 }), ulid(NOW), ulid(NOW), NOW);
    assert.equal(v.attempt, 3);
    assert.equal(eventOf(run({ status: 'stopped', inDoubt: true }), ulid(), ulid(), NOW).code, 'in_doubt');
  });
  it('사람 차례는 turn 사건과 까닭 코드로 보낸다(폰이 "진행 중"에 머물지 않게)', () => {
    const t = eventOf(run({ status: 'turn', at: 0, handoff: { phase: 'login', afterGate: false, kind: 'login', code: 'login.simple_auth' } }), ulid(NOW), ulid(NOW), NOW);
    assert.equal(t.event, 'turn');
    assert.equal(t.phase, 'login');
    assert.equal(t.code, 'login.simple_auth');
    assert.ok(encodeEnvelope(makeEnvelope('run.event', t, { pairId: ulid(), from: 'desktop', seq: 1 })));
    // 코드가 없거나 규칙 밖이면 종류만
    assert.equal(eventOf(run({ status: 'turn', at: 0, handoff: { phase: 'login', afterGate: false, kind: 'login' } }), ulid(), ulid(), NOW).code, 'turn.login');
    assert.equal(eventOf(run({ status: 'turn', at: 2, handoff: { phase: 'fill', afterGate: false, kind: 'other', code: 'Bad Code!' } }), ulid(), ulid(), NOW).code, 'turn.other');
    // 발급 없이 멈춤
    assert.equal(eventOf(run({ status: 'stopped', redo: true }), ulid(), ulid(), NOW).code, 'not_issued');
    assert.equal(eventOf(run({ status: 'stopped' }), ulid(), ulid(), NOW).code, undefined);
  });
  it('차례가 오고 풀리면 각각 한 번 보낸다', async () => {
    const x = await issueWorld();
    const sink = new Sink();
    x.p.attach('p', sink);
    await x.p.handle('p', sink, issueCmd(ulid(NOW), req));
    const r = x.runs.get('run-1')!;
    const turn = { ...r, status: 'turn' as const, steps: run({ at: 0 }).steps, handoff: { phase: 'login', afterGate: false, kind: 'login' as const, code: 'login.simple_auth' } };
    x.p.update({ ...r, status: 'preparing', steps: run({ at: 0 }).steps });
    x.p.update(turn);
    x.p.update(turn);
    x.p.update({ ...r, status: 'preparing', steps: run({ at: 0 }).steps, handoff: null });
    assert.deepEqual(sink.events.map((e) => [e.event, e.phase, e.code ?? '']), [['phase', 'login', ''], ['turn', 'login', 'login.simple_auth'], ['phase', 'login', '']]);
  });
});

describe('PhoneIssue 인증서 다시 시도', () => {
  it('새 실행이 대신한 끝은 보내지 않고, relink 뒤 새 실행 진행을 같은 runId로 보낸다. 폰 cmd.resume은 공동인증서 실패 차례에서만 받는다', async () => {
    const retried: string[] = [];
    const x = await issueWorld({ retryCert: async (id) => void retried.push(id) });
    const sink = new Sink();
    x.p.attach('p', sink);
    const ack = await x.p.handle('p', sink, issueCmd(ulid(NOW), req));
    const r = x.runs.get('run-1')!;
    // 차례가 아닐 때의 cmd.resume은 받지 않고 지금 상태를 다시 보낸다
    x.runs.set('run-1', { ...r, status: 'preparing', steps: run({ at: 0 }).steps });
    assert.equal(await x.p.resume('p', sink, { runId: ack.runId! }), false);
    const turn = { ...r, status: 'turn' as const, steps: run({ at: 0 }).steps, handoff: { phase: 'login', afterGate: false, kind: 'login' as const, code: 'login.simple_auth' } };
    x.runs.set('run-1', turn);
    assert.equal(await x.p.resume('p', sink, { runId: ulid() }), false, '모르는 runId');
    assert.equal(await x.p.resume('p', sink, { runId: ack.runId! }), true);
    assert.deepEqual(retried, ['run-1']);
    const n = sink.events.length;
    x.p.update({ ...turn, status: 'stopped', replaced: true, handoff: null });
    assert.equal(sink.events.length, n, '대신한 끝은 보내지 않는다');
    x.runs.set('run-2', run({ id: 'run-2', at: 0 }));
    x.p.relink('run-1', 'run-2');
    assert.deepEqual(x.p.trackedOf('run-2'), { pairId: 'p', runId: ack.runId });
    assert.equal(x.p.trackedOf('run-1'), null);
    assert.equal(sink.events.at(-1)!.event, 'phase');
  });
});

describe('PhoneIssue', () => {
  it('맞는 명령은 초안을 만들고 준비를 시작한 뒤 pc_only로 답한다. 같은 cmdId는 다시 시작하지 않는다', async () => {
    const x = await issueWorld();
    const sink = new Sink();
    x.p.attach('pair-1', sink);
    const body = issueCmd(ulid(NOW), req);
    const ack = await x.p.handle('pair-1', sink, body);
    assert.equal(ack.state, 'pc_only');
    assert.ok(ack.runId);
    assert.deepEqual(x.drafts, [{ supply: 800_000, item: '과일' }]);
    await until(() => x.prepared.length === 1);
    // cmdId는 디스크에 있다
    const file = JSON.parse(await fs.readFile(path.join(x.dir, 'remote-cmds.json'), 'utf8'));
    assert.equal(file.cmds[0].cmdId, body.cmdId);
    // 재전송: 새 PhoneIssue(앱을 다시 켠 것)에서도 duplicate + 같은 runId
    const y = new PhoneIssue({ counterparty: () => CP, createDraft: () => assert.fail('다시 만들면 안 된다'), prepare: async () => assert.fail(), anyActive: () => false, get: () => undefined, cmds: new CmdLog(path.join(x.dir, 'remote-cmds.json')), now: () => NOW });
    const again = await y.handle('pair-1', new Sink(), body);
    assert.deepEqual(again, { cmdId: body.cmdId, state: 'rejected', reason: 'duplicate', runId: ack.runId });
    // 진행: 단계가 바뀔 때만 보낸다
    const r = x.runs.get('run-1')!;
    x.p.update({ ...r, status: 'preparing', steps: run({ at: 0 }).steps });
    x.p.update({ ...r, status: 'preparing', steps: run({ at: 0 }).steps });
    x.p.update({ ...r, status: 'waiting', steps: run({ at: 4 }).steps });
    assert.deepEqual(sink.events.map((e) => e.phase), ['login', 'approve']);
    assert.ok(sink.events.every((e) => e.runId === ack.runId && e.cmdId === body.cmdId));
    assert.deepEqual(sink.acks, [ack]);
  });

  it('거절 이유', async () => {
    const x = await issueWorld();
    const s = new Sink();
    const ack = async (b: ReturnType<typeof issueCmd>) => (await x.p.handle('p', s, b)).reason;
    assert.equal(await ack({ ...issueCmd(ulid(), req), playbookId: 'hometax.cert.issue' }), 'playbook_unavailable');
    assert.equal(await ack(issueCmd(ulid(), { ...req, counterpartyRef: 'cp_99' })), 'counterparty_unknown');
    assert.equal(await ack(issueCmd(ulid(), { ...req, tax: 79_999 })), 'input_invalid', '세액은 공급가액의 10%');
    assert.equal(await ack(issueCmd(ulid(), { ...req, day: '2026-11-18' })), 'input_invalid', '작성일자는 오늘만');
    const busy = await issueWorld({ anyActive: () => true });
    assert.equal((await busy.p.handle('p', s, issueCmd(ulid(), req))).reason, 'pc_busy');
    assert.equal(x.drafts.length + busy.drafts.length, 0);
    for (const a of s.acks) assert.ok(encodeEnvelope(makeEnvelope('cmd.ack', a, { pairId: ulid(), from: 'desktop', seq: 1 })), '스키마 통과');
  });

  it('겹쳐 온 명령: 같은 cmdId는 한 번만 시작하고, 동시에 적은 cmdId도 디스크에 모두 남는다', async () => {
    const x = await issueWorld();
    const s = new Sink();
    const body = issueCmd(ulid(NOW), req);
    const [a, b] = await Promise.all([x.p.handle('pair-1', s, body), x.p.handle('pair-2', s, body)]);
    assert.deepEqual([a.state, b.state].sort(), ['pc_only', 'rejected']);
    assert.equal((a.state === 'rejected' ? a : b).reason, 'duplicate');
    assert.equal(x.drafts.length, 1);
    // 처음 읽기 전에 겹친 put 두 개
    const log = new CmdLog(path.join(x.dir, 'other.json'));
    const c1 = ulid(), c2 = ulid();
    await Promise.all([log.put(c1, ulid(), NOW), log.put(c2, ulid(), NOW)]);
    const again = new CmdLog(path.join(x.dir, 'other.json'));
    assert.ok((await again.get(c1)) && (await again.get(c2)));
  });

  it('끝 소식을 못 보내면 다음 세션에서 다시 보낸다', async () => {
    const x = await issueWorld();
    const bad = { send: () => { throw new Error('closed'); } };
    x.p.attach('p', bad);
    const ack = await x.p.handle('p', new Sink(), issueCmd(ulid(), req));
    const done = run({ id: 'run-1', status: 'done', result: { approvalNo: '20261117-41000000-12345678', mailTo: CP.email, docId: '', doneAt: '10:03', mailConfirmed: true } });
    x.runs.set('run-1', done);
    x.p.update(done);
    const s = new Sink();
    x.p.attach('p', s);
    assert.deepEqual(s.events.map((e) => [e.runId, e.phase]), [[ack.runId, 'done']]);
  });

  it('준비가 막혀도(상한) 초안은 PC에 남고, 폰에는 준비 단계로 보인다', async () => {
    const x = await issueWorld({ prepare: async () => Promise.reject(new Error('throttled.rate:3')) });
    const s = new Sink();
    x.p.attach('p', s);
    await x.p.handle('p', s, issueCmd(ulid(), req));
    await until(() => s.events.length === 1);
    assert.equal(s.events[0]!.phase, 'prepare');
  });
});

describe('폰 사본', () => {
  it('거래처: 최근 쓴 순서, 사업자번호 모양 맞추기, 이메일은 가린 힌트만, 폰 승인 표시는 false', () => {
    const other: Counterparty = { ...CP, id: 'cp_3', name: '나다상사', bizNo: '123', email: 'x', lastIssuedOn: '2026-11-10' };
    const bad: Counterparty = { ...CP, id: 'cp 4', name: '띄어쓰기 id' };
    const last = lastIssues([run({ status: 'done', counterparty: { ...run().counterparty, id: 'cp_3' }, writeDate: '2026-11-16', supply: 300_000, item: '포장' })]);
    const rows = copyCounterparties([CP, other, bad], last);
    assert.deepEqual(rows.map((r) => r.ref), ['cp_3', 'cp_12']);
    assert.equal(rows[1]!.bizNo, '211-09-87654');
    assert.equal(rows[1]!.emailHint, 'ta***@ganafood.example');
    assert.equal(rows[0]!.bizNo, undefined);
    assert.equal(rows[0]!.emailHint, undefined);
    assert.deepEqual(rows[0]!.last, { supply: 300_000, vatMode: 'excl', item: '포장', day: '2026-11-16' });
    assert.ok(rows.every((r) => r.phoneApprovable === false));
    assert.equal(bizNoOf('211-09-87654'), '211-09-87654');
    assert.equal(maskEmail('a@b.c'), 'a***@b.c');
  });

  const summary: BankSummaryLike = {
    hasAccounts: true, unpaidCount: 6, unpaidTotal: 17_623_000, overdueCount: 2, overdueTotal: 2_233_000, reviewCount: 1,
    payable: { unpaidCount: 4, unpaidTotal: 2_172_000, overdueCount: 1, overdueTotal: 352_000, dueSoonCount: 1, dueSoonTotal: 440_000, reviewCount: 0 },
  };
  const cf = (complete: boolean): CashFlowLike => ({
    month: { month: '2026-11', complete, hasAccounts: true, missing: complete ? [] : [{ bank: '국민' }], cash: { in: { total: 18_420_000 }, out: { total: 12_950_000 }, net: 5_470_000 } },
    snapshot: { next30: { payOut: 1_820_000, payOverdue: 352_000, payIn: 18_420_000, noDuePay: 1 } },
    alerts: [{ id: 'a1', kind: 'slowdown', cpName: '가나식자재', priorDays: 12, recentDays: 31 }, { id: 'a2', kind: 'mystery' }],
  });

  it('돈: 엔진 값 그대로, 받을 돈 7일 안은 목록으로 세고, 확인 못 함이면 이번 달 숫자는 null', () => {
    const recv = [{ remaining: 495_000, dueIn: 3, overdue: false }, { remaining: 1_000, dueIn: -2, overdue: true }, { remaining: 9, dueIn: null, overdue: false }];
    const m = copyMoney(summary, cf(true), recv, 2, NOW)!;
    assert.deepEqual(m.receivable, { unpaidCount: 6, unpaidTotal: 17_623_000, overdueCount: 2, overdueTotal: 2_233_000, dueSoonCount: 1, dueSoonTotal: 495_000, reviewCount: 1 });
    assert.equal(m.payable.dueSoonTotal, 440_000);
    assert.equal(m.cashflow!.net, 5_470_000);
    assert.equal(m.cashflow!.out30, 2_172_000, '기한 지난 낼 돈 포함(§3.4)');
    assert.deepEqual(m.cashflow!.alerts, [{ id: 'a1', kind: 'slow_collection', text: '가나식자재 입금이 평소보다 늦어지고 있어요(평균 12일 → 31일)' }]);
    const u = copyMoney(summary, cf(false), recv, 2, NOW)!;
    assert.equal(u.cashflow!.inTotal, null);
    assert.equal(u.cashflow!.net, null);
    assert.deepEqual(u.cashflow!.missing, ['국민']);
    assert.equal(alertOf({ id: 'x', kind: 'shortfall', gap: 1_200_000 })!.text, '다음 30일에 낼 돈이 통장 잔액과 들어올 돈보다 1,200,000원 많아요');
  });

  it('조회가 실패하면 돈 칸 없이 거래처만 보낸다. 만든 사본은 스키마를 지난다', async () => {
    const failed = await buildPhoneCopy({ counterparties: () => [CP], runs: () => [], bank: async () => Promise.reject(new Error('x')), now: () => NOW });
    assert.equal(failed.money, undefined);
    assert.equal(failed.counterparties.length, 1);
    const full = await buildPhoneCopy({
      counterparties: () => [CP],
      runs: () => [],
      bank: async (m) => (m === 'db.query.bank.overview' ? { summary, unpaid: [], accounts: [{}, {}] } : cf(true)),
      now: () => NOW,
    });
    assert.equal(full.money!.accounts, 2);
    const bytes = encodeEnvelope(makeEnvelope('phone.copy', full, { pairId: ulid(), from: 'desktop', seq: 1 }));
    assert.ok(bytes.length <= MAX_INNER);
  });
});

// ---- 라이브 세션 한 번 ----
const asRelayLink = (l: Link): RelayLink => Object.assign(l, { onEnv() {}, closeCode: null }) as unknown as RelayLink;
const seal: TokenSeal = { seal: (p) => `sealed:${b64(p)}`, open: (s) => fromB64(s.slice(7)) };
const emptyQueue = () => ({ bundle: null, list: async () => [], listPage: async () => ({ items: [], more: false }), ack: async () => {}, putBundle: async () => {} });

describe('라이브 세션(phone-link + phone-session)', () => {
  it('copy.v1·issue.v1을 알린 폰은 사본을 받고, cmd.run에 cmd.ack(pc_only)와 진행을 받는다', async () => {
    const relay = new MemoryRelay();
    const w = await pairWorld({ relay });
    const { pc, phone } = await pairOnce(w);
    pc.channel.close();
    const dir = await tmp();
    const qd = x25519Keygen();
    const x = await issueWorld({ now: Date.now });
    const link = new PhoneLink({
      store: new PhoneStore(path.join(dir, 'remote-phones.json')),
      seal,
      keys: async () => ({ noise: w.desk.keys.noise, vd: w.desk.keys.vd, qdPublic: qd.publicKey, hpkeOpen: async (r) => hpkeOpen(qd.secretKey, r.enc, r.info, r.aad, r.ct) }),
      joinMailbox: async (id, tok) => asRelayLink(await relay.joinMailbox(id, tok, 'desktop')),
      queue: () => emptyQueue() as never,
      receiver: () => phoneReceiver(async () => ({})),
      deviceListVersion: () => 2,
      appVersion: 'test',
      capabilities: () => [CAP.receipt, ...SESSION_CAPS],
      session: phoneSession({ issue: x.p, copy: async () => ({ asOf: Date.now(), counterparties: copyCounterparties([CP], new Map()) }) }),
      pollMs: { live: 60_000, idle: 60_000 },
    });
    await link.start();
    await link.add(pc);
    await until(() => link.list().length === 1);
    await new Promise((r) => setTimeout(r, 20));
    const phLink = await relay.joinMailbox(fromB64(phone.mbxId), { read: fromB64(phone.tokRead), write: fromB64(phone.tokWrite) }, 'mobile');
    const sess = await openMobileSession(phLink, {
      pairId: phone.pairId, noise: w.phone.keys.noise, desktopStatic: phone.desktopStatic, nextTimestamp: monotonicClock(0),
      hello: { appVersion: 'm', deviceListVersion: 2, capabilities: [CAP.receipt, CAP.issue, CAP.copy] },
    });
    assert.ok(sess);
    assert.ok(sess.peerHello.capabilities.includes(CAP.issue) && sess.peerHello.capabilities.includes(CAP.copy));
    const copy = await sess.channel.recv(3000);
    assert.equal(copy?.type, 'phone.copy');
    assert.deepEqual((copy!.body as PhoneCopyBody).counterparties.map((c) => c.ref), ['cp_12']);
    const today = kstToday(Date.now());
    const cmd = issueCmd(ulid(), { ...req, day: today });
    sess.channel.send('cmd.run', cmd);
    const ack = await sess.channel.recv(3000);
    assert.equal(ack?.type, 'cmd.ack');
    assert.equal((ack!.body as CmdAckBody).state, 'pc_only');
    const runId = (ack!.body as CmdAckBody).runId!;
    const r = x.runs.get('run-1')!;
    x.p.update({ ...r, status: 'preparing', steps: run({ at: 0 }).steps });
    const ev = await sess.channel.recv(3000);
    assert.equal(ev?.type, 'run.event');
    assert.deepEqual([(ev!.body as RunEventBody).runId, (ev!.body as RunEventBody).phase], [runId, 'login']);
    sess.channel.close();
    phLink.close();
    link.stop();
  });
});
