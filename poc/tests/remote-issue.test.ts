import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  CAP, ISSUE_PLAYBOOK, MAX_INNER, checkIssueRequest, decodeEnvelope, encodeEnvelope, fitPhoneCopy, issueCmd, makeEnvelope, ulid,
  type CopyCounterparty, type PhoneCopyBody,
} from '@sax/remote';

const PAIR = ulid();
const ok = { counterpartyRef: 'cp_12', supply: 800000, tax: 80000, item: '과일', day: '2026-11-17' };

describe('폰 발급 명령', () => {
  it('거래처는 참조만 싣고 사업자번호·이메일은 넣지 않는다', () => {
    const body = issueCmd(ulid(), ok);
    assert.equal(body.playbookId, ISSUE_PLAYBOOK);
    assert.deepEqual(body.inputs.counterpart, { counterpartyRef: 'cp_12' });
    assert.deepEqual(body.inputs.amounts, { supply: 800000, tax: 80000 });
    assert.equal(body.inputs.issueDay, '2026-11-17');
    const flat = JSON.stringify(body);
    assert.ok(!/email|bizNo|\d{3}-\d{2}-\d{5}/.test(flat));
    const e = makeEnvelope('cmd.run', body, { pairId: PAIR, from: 'mobile', seq: 1 });
    assert.deepEqual(decodeEnvelope(encodeEnvelope(e))?.body, body);
  });

  it('맞지 않는 입력은 이유 코드로 거른다', () => {
    assert.equal(checkIssueRequest({ ...ok, counterpartyRef: '211-09-87654 서울' }), 'ref');
    assert.equal(checkIssueRequest({ ...ok, supply: 0 }), 'supply');
    assert.equal(checkIssueRequest({ ...ok, supply: 1.5 }), 'supply');
    assert.equal(checkIssueRequest({ ...ok, tax: -1 }), 'tax');
    assert.equal(checkIssueRequest({ ...ok, item: '  ' }), 'item');
    assert.equal(checkIssueRequest({ ...ok, day: '2026-13-01' }), 'day');
    assert.throws(() => issueCmd(ulid(), { ...ok, supply: -5 }));
  });

  it('기능 표시가 있다', () => {
    assert.equal(CAP.issue, 'issue.v1');
    assert.equal(CAP.copy, 'copy.v1');
  });
});

describe('cmd.ack', () => {
  it('accepted·start_gate·pc_only는 runId, rejected는 이유가 있어야 한다', () => {
    const c = { pairId: PAIR, from: 'desktop' as const, seq: 2 };
    assert.ok(encodeEnvelope(makeEnvelope('cmd.ack', { cmdId: ulid(), state: 'pc_only', runId: ulid() }, c)));
    assert.ok(encodeEnvelope(makeEnvelope('cmd.ack', { cmdId: ulid(), state: 'rejected', reason: 'counterparty_unknown' }, c)));
    assert.throws(() => encodeEnvelope(makeEnvelope('cmd.ack', { cmdId: ulid(), state: 'accepted' }, c)));
    assert.throws(() => encodeEnvelope(makeEnvelope('cmd.ack', { cmdId: ulid(), state: 'start_gate' }, c)));
    assert.throws(() => encodeEnvelope(makeEnvelope('cmd.ack', { cmdId: ulid(), state: 'rejected' }, c)));
  });
});

describe('phone.copy 크기', () => {
  const cp = (i: number): CopyCounterparty => ({
    ref: `cp_${i}`,
    name: `주식회사 아주 긴 거래처 이름 ${i}번 성수동 본점 정원 관리 서비스`.slice(0, 60),
    aliases: ['별칭 하나', '별칭 둘', '별칭 셋'],
    bizNo: '211-09-87654',
    emailHint: 'very.long.address.for.invoices@flower-garden-service.example'.slice(0, 80),
    phoneApprovable: i % 2 === 0,
    last: { supply: 12_300_000, vatMode: 'excl', item: '사무실 화분 관리(11월분) 및 계절 꽃 교체 작업 일체 포함'.slice(0, 60), day: '2026-11-16' },
  });
  const ctx = { pairId: PAIR, from: 'desktop' as const, seq: 3 };

  it('100곳을 꽉 채워도 한 프레임 안이거나, 줄여서 맞춘다', () => {
    const body: PhoneCopyBody = { asOf: Date.now(), counterparties: Array.from({ length: 100 }, (_, i) => cp(i)), todayApprovalsLeft: 5 };
    const fit = fitPhoneCopy(body, ctx);
    assert.ok(fit);
    const bytes = encodeEnvelope(makeEnvelope('phone.copy', fit.body, ctx));
    assert.ok(bytes.length <= MAX_INNER);
    assert.equal(fit.body.counterparties.length + fit.dropped, 100);
    assert.equal(decodeEnvelope(bytes)?.type, 'phone.copy');
  });

  it('100곳을 넘으면 앞의 100곳만 쓴다', () => {
    const body: PhoneCopyBody = { asOf: 1, counterparties: Array.from({ length: 130 }, (_, i) => ({ ref: `c${i}`, name: `거래처${i}` })) };
    const fit = fitPhoneCopy(body, ctx);
    assert.equal(fit?.body.counterparties.length, 100);
    assert.equal(fit?.dropped, 30);
  });

  it('대화 원문 같은 모르는 칸은 스키마가 막는다', () => {
    assert.throws(() => encodeEnvelope(makeEnvelope('phone.copy', { asOf: 1, counterparties: [], chat: '안녕' } as unknown as PhoneCopyBody, ctx)));
  });
});
