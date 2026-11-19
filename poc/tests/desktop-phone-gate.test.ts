// 폰 승인(ADR-052): 승인 키 등록(phone-link), 승인 요청 중계와 답 검증(phone-gate), 서명 입력(@sax/remote approve),
// 엔진 쪽 규칙(remotePresenceRefusal), 그리고 라이브 세션 한 번(등록 → cmd.run accepted → gate.request → gate.response).
// 폰의 하드웨어 키는 Node의 P-256 키로 대신한다(서명 형식은 네이티브와 같은 X9.62 DER → r‖s).
import assert from 'node:assert/strict';
import { createSign, generateKeyPairSync, type KeyObject } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import {
  CAP, CTX, MemoryRelay, approveSignBytes, validateEnvelope as validate, b64, ecdsaDerToRaw, fromB64, hpkeOpen, issueCmd, monotonicClock, openMobileSession, pxEnrollMessage, pxIdOf, ulid, validPxPub, verifyApprove,
  x25519Keygen, type Channel, type CmdAckBody, type GateRequestBody, type GateResolvedBody, type GateResponseBody, type Link, type PxAckBody, type PxEnrollBody, type RelayLink, type RunEventBody,
} from '@sax/remote';
import { buildGateRequest, remotePresenceRefusal, type GateRequest } from '@sax/engine/gate';
import { kstToday } from '../apps/desktop/src/approval-gate.ts';
import { ApprovalLog, BAD_SIG_MAX, PHONE_GATE_TTL_MS, PhoneGate, REMOTE_PER_DAY, type GateSink } from '../apps/desktop/src/phone-gate.ts';
import { CmdLog, PhoneIssue } from '../apps/desktop/src/phone-issue.ts';
import { PhoneLink, PhoneStore, type TokenSeal } from '../apps/desktop/src/phone-link.ts';
import { phoneReceiver } from '../apps/desktop/src/phone-receive.ts';
import { APPROVE_CAPS, phoneSession, SESSION_CAPS, sinkFor } from '../apps/desktop/src/phone-session.ts';
import type { Counterparty, RunView } from '../apps/desktop/src/shell-model.ts';
import { pairOnce, pairWorld, until } from './remote-support.ts';

let dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs) await fs.rm(d, { recursive: true, force: true });
  dirs = [];
});
const tmp = async () => {
  const d = await fs.mkdtemp(path.join(os.tmpdir(), 'phone-gate-'));
  dirs.push(d);
  return d;
};

/** 폰 하드웨어 키 대역 */
function pxKey() {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwk = publicKey.export({ format: 'jwk' });
  const pub = new Uint8Array([4, ...Buffer.from(jwk.x!, 'base64url'), ...Buffer.from(jwk.y!, 'base64url')]);
  return { pub, privateKey };
}
const signRaw = (k: KeyObject, bytes: Uint8Array) => ecdsaDerToRaw(new Uint8Array(createSign('sha256').update(bytes).sign(k)))!;

const NOW = Date.parse('2026-11-19T03:00:00Z');
const TODAY = kstToday(NOW);
const PAIR = 'pair-1';
const readback = {
  supplierBizNo: '1234567890', supplierName: '율무상회', counterpartBizNo: '2110987654', counterpartName: '가나식자재', counterpartEmail: 'tax@ganafood.example',
  itemName: '과일', itemCount: '1', supplyAmount: '800000', taxAmount: '80000', totalAmount: '880000', issueDate: TODAY, remark: '', receiptType: '청구',
};
function gateReq(over: { first?: boolean; firstEmail?: boolean; card?: string } = {}): GateRequest {
  return buildGateRequest({
    runId: 'engine-run', gateStepId: 's20', card: over.card, readback: over.card === 'cert.confirm' ? { certDoc: '사업자등록증명', certPurpose: '금융기관 제출', certSubmitTo: '은행', rrnDisclosure: '비공개' } : readback,
    reserved: over.card === 'cert.confirm' ? [] : [{ fieldKey: '$first.bizNo', value: String(!!over.first) }, { fieldKey: '$first.email', value: String(!!over.firstEmail) }],
    packageDigest: 'ab'.repeat(32), authorizes: ['s21'], intentId: ulid(NOW), waitMs: 600_000,
  });
}

class Sink implements GateSink {
  sent: GateRequestBody[] = [];
  resolved: GateResolvedBody[] = [];
  fail = false;
  send(t: 'gate.request' | 'gate.resolved', body: GateRequestBody | GateResolvedBody): unknown {
    if (this.fail) throw new Error('closed');
    if (t === 'gate.resolved') this.resolved.push(body as GateResolvedBody);
    else this.sent.push(body as GateRequestBody);
    return null;
  }
}

async function world(over: { perDay?: number } = {}) {
  const dir = await tmp();
  const key = pxKey();
  const st = { now: NOW, px: { pub: key.pub, hw: 'ios_se' as const, deviceId: 'dev-1' } as { pub: Uint8Array; hw: 'ios_se'; deviceId: string } | null, approved: 0, denied: 0, pokes: [] as string[] };
  const file = path.join(dir, 'remote-approvals.json');
  const gate = new PhoneGate({
    px: (p) => (p === PAIR ? st.px : null),
    tracked: (id) => (id.startsWith('run-') ? { pairId: PAIR, runId: PHONE_RUN } : null),
    poke: (id) => void st.pokes.push(id),
    approvals: new ApprovalLog(file),
    perDay: over.perDay,
    now: () => st.now,
  });
  const sink = new Sink();
  const on = { approve: () => void st.approved++, deny: () => void st.denied++ };
  const answerOf = (g: GateRequestBody, decision: 'approve' | 'deny' = 'approve', k = key.privateKey): GateResponseBody => ({
    runId: g.runId, stepId: g.stepId, reqId: g.reqId, decision, actionHash: g.actionHash, sigAlg: 'p256',
    sig: b64(signRaw(k, approveSignBytes({ pairId: PAIR, reqId: g.reqId, challenge: fromB64(g.challenge), actionHash: g.actionHash, decision }))),
  });
  return { gate, sink, st, on, key, answerOf, file };
}
const PHONE_RUN = ulid(NOW);

describe('승인 서명 입력과 검증(@sax/remote approve)', () => {
  const k = pxKey();
  const i = { pairId: PAIR, reqId: ulid(NOW), challenge: new Uint8Array(32).fill(7), actionHash: 'cd'.repeat(32), decision: 'approve' as const };
  it('네이티브 모양(DER)의 서명을 r‖s로 바꿔 검증한다. 칸 하나라도 다르면 틀린다', () => {
    assert.ok(validPxPub(k.pub));
    for (let n = 0; n < 20; n++) {
      const sig = signRaw(k.privateKey, approveSignBytes(i));
      assert.equal(sig.length, 64);
      assert.ok(verifyApprove(k.pub, i, sig));
      assert.ok(!verifyApprove(k.pub, { ...i, decision: 'deny' }, sig));
      assert.ok(!verifyApprove(k.pub, { ...i, pairId: 'pair-2' }, sig));
      assert.ok(!verifyApprove(k.pub, { ...i, reqId: ulid(NOW + 1) }, sig));
      assert.ok(!verifyApprove(k.pub, { ...i, challenge: new Uint8Array(32).fill(8) }, sig));
      assert.ok(!verifyApprove(k.pub, { ...i, actionHash: 'ce'.repeat(32) }, sig));
      assert.ok(!verifyApprove(pxKey().pub, i, sig));
    }
  });
  it('서명 대상은 컨텍스트로 시작하고, 모양이 틀린 입력은 던진다', () => {
    assert.equal(Buffer.from(approveSignBytes(i).subarray(0, CTX.approve.length)).toString(), 'SAX-approve-v1');
    assert.throws(() => approveSignBytes({ ...i, challenge: new Uint8Array(31) }));
    assert.throws(() => approveSignBytes({ ...i, actionHash: 'zz' }));
    assert.throws(() => approveSignBytes({ ...i, decision: 'yes' as never }));
  });
  it('공개키·서명 모양이 틀리면 검증하지 않는다', () => {
    const sig = signRaw(k.privateKey, approveSignBytes(i));
    assert.ok(!validPxPub(k.pub.subarray(1)));
    assert.ok(!validPxPub(new Uint8Array(65).fill(4)));
    assert.ok(!verifyApprove(k.pub, i, sig.subarray(0, 63)));
    assert.ok(!verifyApprove(k.pub, i, new Uint8Array(64)));
    assert.equal(ecdsaDerToRaw(new Uint8Array([0x30, 0x02, 0x02, 0x00])), null);
    assert.equal(ecdsaDerToRaw(sig), null);
    assert.match(pxIdOf(k.pub), /^[0-9a-f]{16}$/);
  });
});

describe('엔진 규칙: 폰 승인을 받을 수 있는 게이트', () => {
  it('세금계산서이고 처음 거래처·처음 이메일이 아닐 때만', () => {
    assert.equal(remotePresenceRefusal(gateReq()), null);
    assert.equal(remotePresenceRefusal(gateReq({ first: true })), 'first');
    assert.equal(remotePresenceRefusal(gateReq({ firstEmail: true })), 'first');
    assert.equal(remotePresenceRefusal(gateReq({ card: 'cert.confirm' })), 'doc');
    const g = gateReq();
    assert.equal(remotePresenceRefusal({ docType: 'H-01', fields: g.fields.filter((f) => f.fieldKey !== '$first.email') }), 'first');
  });
});

describe('승인 요청 중계와 답 검증(PhoneGate)', () => {
  it('폰이 맡긴 실행의 게이트를 보내고, 맞는 서명에 한 번만 승인한다', async () => {
    const w = await world();
    w.gate.attach(PAIR, w.sink);
    assert.ok(w.gate.canApprove(PAIR));
    const req = gateReq();
    assert.equal(await w.gate.offer('run-1', req, w.on), true);
    assert.equal(w.sink.sent.length, 1);
    const g = w.sink.sent[0]!;
    assert.deepEqual([g.runId, g.stepId, g.cardId, g.gateKind, g.requiredSigAlg, g.actionHash], [PHONE_RUN, 's20', 'invoice.confirm', 'commit', 'p256', req.actionHash]);
    assert.deepEqual(g.effects, ['issue_document', 'send']);
    assert.equal(g.exp, NOW + PHONE_GATE_TTL_MS);
    assert.notEqual(g.reqId, req.reqId);
    assert.equal(w.gate.codeOf('run-1'), undefined);
    const a = w.answerOf(g);
    assert.equal(await w.gate.answer(PAIR, a), 'approved');
    assert.equal(w.st.approved, 1);
    // 같은 답을 다시 보내도(재생) 열린 요청이 없다
    assert.equal(await w.gate.answer(PAIR, a), 'no_request');
    assert.equal(w.st.approved, 1);
    const rows = JSON.parse(await fs.readFile(w.file, 'utf8')).rows;
    assert.equal(rows.length, 1);
    assert.deepEqual([rows[0].day, rows[0].gateReqId, rows[0].reqId, rows[0].actionHash, rows[0].sig], [TODAY, req.reqId, g.reqId, req.actionHash, a.sig]);
    assert.equal(await w.gate.leftToday(), REMOTE_PER_DAY - 1);
  });

  it('폰이 시작한 실행이 아니면 맡지 않는다', async () => {
    const w = await world();
    w.gate.attach(PAIR, w.sink);
    assert.equal(await w.gate.offer('pc-run', gateReq(), w.on), false);
    assert.equal(w.sink.sent.length, 0);
  });

  it('틀린 답은 승인하지 않는다: 다른 폰, 다른 실행·단계, ed25519, 다른 actionHash, 다른 키, 다른 결정의 서명', async () => {
    const w = await world();
    w.gate.attach(PAIR, w.sink);
    await w.gate.offer('run-1', gateReq(), w.on);
    const g = w.sink.sent[0]!;
    const ok = w.answerOf(g);
    assert.equal(await w.gate.answer('pair-2', ok), 'no_request');
    assert.equal(await w.gate.answer(PAIR, { ...ok, reqId: ulid(NOW + 5) }), 'no_request');
    assert.equal(await w.gate.answer(PAIR, { ...ok, runId: ulid(NOW + 5) }), 'wrong_gate');
    assert.equal(await w.gate.answer(PAIR, { ...ok, stepId: 's21' }), 'wrong_gate');
    assert.equal(await w.gate.answer(PAIR, { ...ok, sigAlg: 'ed25519' }), 'sig_alg');
    assert.equal(await w.gate.answer(PAIR, { ...ok, actionHash: 'ef'.repeat(32) }), 'wrong_action');
    assert.equal(await w.gate.answer(PAIR, w.answerOf(g, 'approve', pxKey().privateKey)), 'bad_sig');
    // 거절 서명을 승인으로 바꿔 보낸다
    assert.equal(await w.gate.answer(PAIR, { ...w.answerOf(g, 'deny'), decision: 'approve' }), 'bad_sig');
    assert.equal(w.st.approved + w.st.denied, 0);
    // 틀린 서명 3번이면 이 게이트는 PC에서만
    assert.equal(await w.gate.answer(PAIR, { ...ok, sig: b64(new Uint8Array(64).fill(1)) }), 'bad_sig');
    assert.equal(BAD_SIG_MAX, 3);
    assert.equal(w.gate.codeOf('run-1'), 'pc_only');
    assert.equal(await w.gate.answer(PAIR, ok), 'no_request');
    assert.equal(w.st.approved, 0);
  });

  it('120초가 지난 답은 받지 않고, 다시 요청하면 새 챌린지로 보낸다. 옛 챌린지의 서명은 죽는다', async () => {
    const w = await world();
    w.gate.attach(PAIR, w.sink);
    await w.gate.offer('run-1', gateReq(), w.on);
    const g1 = w.sink.sent[0]!;
    const old = w.answerOf(g1);
    w.st.now += PHONE_GATE_TTL_MS + 1;
    assert.equal(await w.gate.answer(PAIR, old), 'expired');
    w.gate.refresh(PAIR, { runId: g1.runId, reqId: g1.reqId });
    const g2 = w.sink.sent[1]!;
    assert.equal(g2.reqId, g1.reqId);
    assert.notEqual(g2.challenge, g1.challenge);
    assert.equal(await w.gate.answer(PAIR, old), 'bad_sig');
    assert.equal(await w.gate.answer(PAIR, w.answerOf(g2)), 'approved');
    assert.equal(w.st.approved, 1);
  });

  it('세션이 없으면 보내지 않고 기다리다가, 세션이 붙으면 보낸다', async () => {
    const w = await world();
    assert.ok(!w.gate.canApprove(PAIR));
    await w.gate.offer('run-1', gateReq(), w.on);
    assert.equal(w.sink.sent.length, 0);
    w.gate.attach(PAIR, w.sink);
    assert.equal(w.sink.sent.length, 1);
    // 다시 붙으면 새 챌린지
    w.gate.detach(PAIR, w.sink);
    w.gate.attach(PAIR, w.sink);
    assert.notEqual(w.sink.sent[1]!.challenge, w.sink.sent[0]!.challenge);
    assert.equal(await w.gate.answer(PAIR, w.answerOf(w.sink.sent[0]!)), 'bad_sig');
    assert.equal(await w.gate.answer(PAIR, w.answerOf(w.sink.sent[1]!)), 'approved');
  });

  it('처음 거래처·승인 키 없음·민원증명은 폰으로 보내지 않고 이유를 단다', async () => {
    const w = await world();
    w.gate.attach(PAIR, w.sink);
    await w.gate.offer('run-1', gateReq({ first: true }), w.on);
    assert.equal(w.gate.codeOf('run-1'), 'pc_first');
    await w.gate.offer('run-2', gateReq({ firstEmail: true }), w.on);
    assert.equal(w.gate.codeOf('run-2'), 'pc_first');
    await w.gate.offer('run-3', gateReq({ card: 'cert.confirm' }), w.on);
    assert.equal(w.gate.codeOf('run-3'), 'pc_only');
    w.st.px = null;
    await w.gate.offer('run-4', gateReq(), w.on);
    assert.equal(w.gate.codeOf('run-4'), 'pc_key');
    assert.equal(w.sink.sent.length, 0);
    assert.deepEqual(w.st.pokes, ['run-1', 'run-2', 'run-3', 'run-4']);
  });

  it('값 대조가 틀린 게이트는 보내지 않는다', async () => {
    const w = await world();
    w.gate.attach(PAIR, w.sink);
    const req = gateReq();
    req.fields[7] = { fieldKey: 'supplyAmount', value: '900000' };
    await w.gate.offer('run-1', req, w.on);
    assert.equal(w.gate.codeOf('run-1'), 'pc_only');
    assert.equal(w.sink.sent.length, 0);
  });

  it('하루 한도: 넘으면 보내지 않고, 답을 받는 때에도 다시 센다. 날이 바뀌면 다시 받는다', async () => {
    const w = await world({ perDay: 2 });
    w.gate.attach(PAIR, w.sink);
    await w.gate.offer('run-1', gateReq(), w.on);
    await w.gate.offer('run-2', gateReq(), w.on);
    await w.gate.offer('run-3', gateReq(), w.on);
    assert.equal(w.sink.sent.length, 3);
    assert.equal(await w.gate.answer(PAIR, w.answerOf(w.sink.sent[0]!)), 'approved');
    assert.equal(await w.gate.answer(PAIR, w.answerOf(w.sink.sent[1]!)), 'approved');
    assert.equal(await w.gate.answer(PAIR, w.answerOf(w.sink.sent[2]!)), 'limit');
    assert.equal(w.gate.codeOf('run-3'), 'pc_limit');
    assert.equal(w.st.approved, 2);
    await w.gate.offer('run-4', gateReq(), w.on);
    assert.equal(w.gate.codeOf('run-4'), 'pc_limit');
    assert.equal(await w.gate.leftToday(), 0);
    w.st.now += 24 * 3_600_000;
    await w.gate.offer('run-5', gateReq(), w.on);
    assert.equal(w.gate.codeOf('run-5'), undefined);
    // 정책이 앱 상한보다 큰 값을 줘도 5를 넘지 않는다
    const big = await world({ perDay: 50 });
    assert.equal(await big.gate.leftToday(), REMOTE_PER_DAY);
  });

  it('승인 기록 파일이 깨졌으면 폰 승인을 닫는다', async () => {
    const w = await world();
    await fs.writeFile(w.file, '{"v":1,"rows":[{"at":"x"}]}');
    w.gate.attach(PAIR, w.sink);
    await w.gate.offer('run-1', gateReq(), w.on);
    assert.equal(w.gate.codeOf('run-1'), 'pc_limit');
    assert.equal(await w.gate.leftToday(), 0);
  });

  it('거절은 서명이 맞을 때 실행을 멈춘다(한 번)', async () => {
    const w = await world();
    w.gate.attach(PAIR, w.sink);
    await w.gate.offer('run-1', gateReq(), w.on);
    const d = w.answerOf(w.sink.sent[0]!, 'deny');
    assert.equal(await w.gate.answer(PAIR, d), 'denied');
    assert.equal(await w.gate.answer(PAIR, d), 'no_request');
    assert.deepEqual([w.st.approved, w.st.denied], [0, 1]);
    assert.equal(await w.gate.leftToday(), REMOTE_PER_DAY);
  });

  it('PC가 먼저 답했거나 게이트가 닫히면 폰의 답은 받지 않는다. 승인 키가 폐기돼도 받지 않는다', async () => {
    const w = await world();
    w.gate.attach(PAIR, w.sink);
    const req = gateReq();
    await w.gate.offer('run-1', req, w.on);
    w.gate.close('run-1', 'other-req');
    assert.equal(w.gate.codeOf('run-1'), undefined);
    w.gate.close('run-1', req.reqId);
    assert.equal(await w.gate.answer(PAIR, w.answerOf(w.sink.sent[0]!)), 'no_request');
    await w.gate.offer('run-2', gateReq(), w.on);
    w.st.px = null;
    assert.equal(await w.gate.answer(PAIR, w.answerOf(w.sink.sent[1]!)), 'no_key');
    assert.equal(w.gate.codeOf('run-2'), 'pc_key');
    assert.equal(w.st.approved, 0);
  });

  it('v1.11: 폰에 보낸 게이트가 닫히면 gate.resolved로 알린다(누가 닫았는지와 함께, 한 번만)', async () => {
    const w = await world();
    w.gate.attach(PAIR, w.sink);
    const req = gateReq();
    await w.gate.offer('run-1', req, w.on);
    const g = w.sink.sent[0]!;
    // 다른 게이트의 닫힘은 이 게이트를 닫지 않는다
    w.gate.close('run-1', 'other-req', 'pc');
    assert.deepEqual(w.sink.resolved, []);
    w.gate.close('run-1', req.reqId, 'pc');
    w.gate.close('run-1', req.reqId, 'stopped');
    assert.deepEqual(w.sink.resolved, [{ runId: g.runId, reqId: g.reqId, by: 'pc' }]);
    assert.equal(await w.gate.answer(PAIR, w.answerOf(g)), 'no_request');

    // 만료와 중지
    await w.gate.offer('run-2', gateReq(), w.on);
    w.gate.close('run-2', undefined, 'expired');
    await w.gate.offer('run-3', gateReq(), w.on);
    w.gate.close('run-3', undefined, 'stopped');
    assert.deepEqual(w.sink.resolved.slice(1).map((x) => [x.reqId, x.by]), [[w.sink.sent[1]!.reqId, 'expired'], [w.sink.sent[2]!.reqId, 'stopped']]);
  });

  it('v1.11: 폰이 답하면 phone으로 알리고, 보내지 않은 게이트(이유를 단 것, 세션 없음)는 알리지 않는다', async () => {
    const w = await world();
    w.gate.attach(PAIR, w.sink);
    await w.gate.offer('run-1', gateReq(), w.on);
    assert.equal(await w.gate.answer(PAIR, w.answerOf(w.sink.sent[0]!)), 'approved');
    await w.gate.offer('run-2', gateReq(), w.on);
    assert.equal(await w.gate.answer(PAIR, w.answerOf(w.sink.sent[1]!, 'deny')), 'denied');
    assert.deepEqual(w.sink.resolved.map((x) => x.by), ['phone', 'phone']);
    // 폰으로 보내지 않은 게이트
    await w.gate.offer('run-3', gateReq({ first: true }), w.on);
    w.gate.close('run-3', undefined, 'pc');
    // 세션이 없을 때 닫힌 게이트: 보낼 곳이 없고, 다시 붙어도 다시 보내지 않는다
    await w.gate.offer('run-4', gateReq(), w.on);
    w.gate.detach(PAIR, w.sink);
    w.gate.close('run-4', undefined, 'pc');
    w.gate.attach(PAIR, w.sink);
    assert.equal(w.sink.resolved.length, 2);
    assert.equal(w.sink.sent.length, 3);
    // 보내다 던져도 게이트는 닫힌다
    await w.gate.offer('run-5', gateReq(), w.on);
    w.sink.fail = true;
    w.gate.close('run-5', undefined, 'pc');
    w.sink.fail = false;
    assert.equal(await w.gate.answer(PAIR, w.answerOf(w.sink.sent[3]!)), 'no_request');
  });
});

describe('v1.11 sync.v1: 폰 기능에 맞춰 보내기(phone-session sinkFor)', () => {
  const fake = () => {
    const out: [string, Record<string, unknown>][] = [];
    return { out, ch: { send: (type: string, body: Record<string, unknown>) => void out.push([type, body]) } as unknown as Channel };
  };
  const ev = { runId: PHONE_RUN, event: 'phase', at: NOW, phase: 'approve', rev: 3 } as RunEventBody;
  const res: GateResolvedBody = { runId: PHONE_RUN, reqId: ulid(NOW), by: 'pc' };
  it('sync.v1을 알린 폰에는 rev와 gate.resolved를 그대로 보낸다', () => {
    const f = fake();
    const s = sinkFor(f.ch, new Set([CAP.issue, CAP.sync]));
    s.send('run.event', ev);
    s.send('gate.resolved', res);
    assert.deepEqual(f.out, [['run.event', ev], ['gate.resolved', res]]);
  });
  it('모르는 폰에는 rev를 빼고 gate.resolved는 보내지 않는다(옛 스키마가 받지 않는다)', () => {
    const f = fake();
    const s = sinkFor(f.ch, new Set([CAP.issue, CAP.approve]));
    s.send('run.event', ev);
    s.send('gate.resolved', res);
    const plain: Partial<RunEventBody> = { ...ev };
    delete plain.rev;
    assert.deepEqual(f.out, [['run.event', plain]]);
    assert.ok(validate({ v: 1, type: 'run.event', id: ulid(NOW), pairId: ulid(NOW), from: 'desktop', to: 'mobile', seq: 1, ts: NOW, ttl: 60, body: ev }));
    assert.ok(validate({ v: 1, type: 'gate.resolved', id: ulid(NOW), pairId: ulid(NOW), from: 'desktop', to: 'mobile', seq: 1, ts: NOW, ttl: 60, body: res }));
    assert.ok(!validate({ v: 1, type: 'gate.resolved', id: ulid(NOW), pairId: ulid(NOW), from: 'mobile', to: 'desktop', seq: 1, ts: NOW, ttl: 60, body: res }));
    assert.ok(!validate({ v: 1, type: 'gate.resolved', id: ulid(NOW), pairId: ulid(NOW), from: 'desktop', to: 'mobile', seq: 1, ts: NOW, ttl: 60, body: { ...res, by: 'someone' } }));
    assert.ok(!validate({ v: 1, type: 'run.event', id: ulid(NOW), pairId: ulid(NOW), from: 'desktop', to: 'mobile', seq: 1, ts: NOW, ttl: 60, body: { ...ev, rev: 0 } }));
  });
});

// ---- 라이브 세션 ----
const asRelayLink = (l: Link): RelayLink => Object.assign(l, { onEnv() {}, closeCode: null }) as unknown as RelayLink;
const seal: TokenSeal = { seal: (p) => `sealed:${b64(p)}`, open: (s) => fromB64(s.slice(7)) };
const emptyQueue = () => ({ bundle: null, list: async () => [], listPage: async () => ({ items: [], more: false }), ack: async () => {}, putBundle: async () => {} });
const CP: Counterparty = { id: 'cp_12', name: '가나식자재', bizNo: '2110987654', rep: '김가나', email: 'tax@ganafood.example', item: '식자재', status: '정상', checkedOn: '2026-11-01', lastIssuedOn: '2026-10-31' };

describe('라이브 세션: 등록 → 발급 명령 → 폰 승인', () => {
  it('approve.v1 폰은 승인 키를 등록하고, 맡긴 발급의 승인 요청을 받아 서명으로 승인한다', async () => {
    const relay = new MemoryRelay();
    const w = await pairWorld({ relay });
    const { pc, phone } = await pairOnce(w);
    pc.channel.close();
    const dir = await tmp();
    const qd = x25519Keygen();
    const runs = new Map<string, RunView>();
    const state = { approved: 0 };
    const store = new PhoneStore(path.join(dir, 'remote-phones.json'));
    // eslint-disable-next-line prefer-const
    let link: PhoneLink;
    const issue: PhoneIssue = new PhoneIssue({
      counterparty: (ref) => (ref === CP.id ? CP : null),
      createDraft: (cp, supply, item) => {
        const r = { id: 'run-1', status: 'draft', counterparty: { id: cp.id, name: cp.name, bizNo: cp.bizNo, first: false }, item, supply, total: supply + supply / 10, steps: [], result: null } as unknown as RunView;
        runs.set(r.id, r);
        return r;
      },
      prepare: async () => {},
      anyActive: () => false,
      get: (id) => runs.get(id),
      cmds: new CmdLog(path.join(dir, 'remote-cmds.json')),
      approver: (pairId) => gate.canApprove(pairId),
      approveCode: (id) => gate.codeOf(id),
    });
    const gate: PhoneGate = new PhoneGate({
      px: (pairId) => link.px(pairId),
      tracked: (id) => issue.trackedOf(id),
      poke: (id) => issue.poke(id),
      approvals: new ApprovalLog(path.join(dir, 'remote-approvals.json')),
    });
    link = new PhoneLink({
      store,
      seal,
      keys: async () => ({ noise: w.desk.keys.noise, vd: w.desk.keys.vd, qdPublic: qd.publicKey, hpkeOpen: async (r) => hpkeOpen(qd.secretKey, r.enc, r.info, r.aad, r.ct) }),
      joinMailbox: async (id, tok) => asRelayLink(await relay.joinMailbox(id, tok, 'desktop')),
      queue: () => emptyQueue() as never,
      receiver: () => phoneReceiver(async () => ({})),
      deviceListVersion: () => 2,
      appVersion: 'test',
      capabilities: () => [CAP.receipt, ...SESSION_CAPS, ...APPROVE_CAPS],
      session: phoneSession({ issue, copy: async () => ({ asOf: Date.now(), counterparties: [] }), approve: { gate, enroll: (pairId, body) => link.enrollPx(pairId, body) } }),
      pollMs: { live: 60_000, idle: 60_000 },
    });
    await link.start();
    await link.add(pc);
    await until(() => link.list().length === 1);
    assert.equal(link.list()[0]!.approver, 'off');
    await new Promise((r) => setTimeout(r, 20));
    const phLink = await relay.joinMailbox(fromB64(phone.mbxId), { read: fromB64(phone.tokRead), write: fromB64(phone.tokWrite) }, 'mobile');
    const sess = await openMobileSession(phLink, {
      pairId: phone.pairId, noise: w.phone.keys.noise, desktopStatic: phone.desktopStatic, nextTimestamp: monotonicClock(0),
      hello: { appVersion: 'm', deviceListVersion: 2, capabilities: [CAP.receipt, CAP.issue, CAP.approve] },
    });
    assert.ok(sess);
    assert.ok(sess.peerHello.capabilities.includes(CAP.approve));
    const ch = sess.channel;
    const next = async <T>(type: string): Promise<T> => {
      const e = await ch.recv(3000);
      assert.equal(e?.type, type);
      return e!.body as T;
    };

    // 등록: 틀린 서명은 거절, 맞으면 바로 받는다(자동 등록)
    const k = pxKey();
    const enroll = async (key = k, hw: PxEnrollBody['hw'] = 'ios_se', deviceId = w.phone.keys.deviceId): Promise<PxEnrollBody> => ({
      pxPub: b64(key.pub), hw, sig: b64(await w.phone.vm.sign(CTX.pxEnroll, pxEnrollMessage(phone.pairId, deviceId, key.pub, hw))),
    });
    ch.send('px.enroll', await enroll(k, 'ios_se', '00000000-0000-4000-8000-000000000000'));
    assert.equal((await next<PxAckBody>('px.ack')).state, 'rejected');
    ch.send('px.enroll', await enroll(k, 'android_tee'));
    assert.equal((await next<PxAckBody>('px.ack')).state, 'rejected');
    assert.equal(link.px(phone.pairId), null);
    ch.send('px.enroll', await enroll());
    assert.deepEqual(await next<PxAckBody>('px.ack'), { state: 'enrolled', pxId: pxIdOf(k.pub) });
    assert.equal(link.list()[0]!.approver, 'on');
    ch.send('px.enroll', await enroll());
    assert.equal((await next<PxAckBody>('px.ack')).state, 'enrolled');
    assert.equal((await store.load())[0]!.px?.via, 'auto');

    // 발급 명령: 승인 기기라 accepted
    const today = kstToday(Date.now());
    ch.send('cmd.run', issueCmd(ulid(), { counterpartyRef: 'cp_12', supply: 800_000, tax: 80_000, item: '과일', day: today }));
    const ack = await next<CmdAckBody>('cmd.ack');
    assert.equal(ack.state, 'accepted');

    // 엔진이 게이트를 열었다
    const req = buildGateRequest({
      runId: 'engine-run', gateStepId: 's20', readback: { ...readback, issueDate: today },
      reserved: [{ fieldKey: '$first.bizNo', value: 'false' }, { fieldKey: '$first.email', value: 'false' }],
      packageDigest: 'ab'.repeat(32), authorizes: ['s21'], intentId: ulid(), waitMs: 600_000,
    });
    runs.set('run-1', { ...runs.get('run-1')!, status: 'waiting' } as RunView);
    assert.equal(await gate.offer('run-1', req, { approve: () => void state.approved++, deny: () => {} }), true);
    const g = await next<GateRequestBody>('gate.request');
    const ev = await next<RunEventBody>('run.event');
    assert.deepEqual([ev.phase, ev.code, ev.runId], ['approve', undefined, ack.runId]);
    assert.equal(g.runId, ack.runId);
    assert.equal(g.actionHash, req.actionHash);
    assert.deepEqual(g.fields.map((f) => f.key).slice(0, 2), ['supplierBizNo', 'supplierName']);

    // 폰이 서명해 답한다
    const sig = signRaw(k.privateKey, approveSignBytes({ pairId: phone.pairId, reqId: g.reqId, challenge: fromB64(g.challenge), actionHash: g.actionHash, decision: 'approve' }));
    ch.send('gate.response', { runId: g.runId, stepId: g.stepId, reqId: g.reqId, decision: 'approve', actionHash: g.actionHash, sigAlg: 'p256', sig: b64(sig) });
    await until(() => state.approved === 1);

    // PC에서 폰 승인을 끄면 새 키를 바로 받지 않고, 다시 허용하면 그 키를 받는다
    assert.equal(await link.revokePx(phone.pairId), true);
    assert.equal(link.px(phone.pairId), null);
    // 설정 > 기기 연결 줄: 꺼 둠(paused)과 아직 키 없음(off)을 나눠 보인다. 기기 ID로 줄과 맞춘다
    assert.equal(link.list()[0]!.approver, 'paused');
    assert.equal(link.list()[0]!.deviceId, w.phone.keys.deviceId);
    assert.equal(await link.revokePx(phone.pairId), false);
    assert.ok(!gate.canApprove(phone.pairId));
    const k2 = pxKey();
    ch.send('px.enroll', await enroll(k2));
    assert.equal((await next<PxAckBody>('px.ack')).state, 'needs_pc');
    assert.equal(link.list()[0]!.approver, 'asked');
    assert.equal(await link.allowPx(phone.pairId), true);
    assert.deepEqual(Buffer.from(link.px(phone.pairId)!.pub), Buffer.from(k2.pub));
    assert.equal((await store.load())[0]!.px?.via, 'pc');
    // 키가 바뀌면(생체 재등록) 새 키로 바꾼다
    const k3 = pxKey();
    ch.send('px.enroll', await enroll(k3));
    assert.equal((await next<PxAckBody>('px.ack')).state, 'enrolled');
    assert.deepEqual(Buffer.from(link.px(phone.pairId)!.pub), Buffer.from(k3.pub));
    ch.close();
    link.stop();
    await link.idle();
  });
});
