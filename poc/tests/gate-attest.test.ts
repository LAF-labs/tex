// InDoubt 증언 계약(ADR-021 결정 5, D03 §2 InDoubt 행): 요청 모양·요약 해시·main 자기 확인·엔진 대조.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  ATTEST_SUMMARY_KEYS, LOCAL_ATTEST_CONTEXT, LOCAL_ATTEST_TTL_MS, attestSelfCheck, attestSummaryHash, buildAttestRequest, cardHash, checkAttestation,
  type AttestRequest, type LocalAttestation,
} from '@sax/engine/gate';

const NOW = Date.parse('2026-11-05T06:00:00Z');
const summary = { counterpartName: '주식회사 시험상사', counterpartBizNo: '1234567890', totalAmount: '110000' };
const req = (o: Partial<Parameters<typeof buildAttestRequest>[0]> = {}): AttestRequest =>
  buildAttestRequest({ runId: 'run-1', intentId: 'intent-1', stepId: 's20', portal: 'hometax', summary, manualCheck: false, ...o });
const att = (r: AttestRequest, o: Partial<LocalAttestation> = {}): LocalAttestation => ({
  v: 1, intentId: r.intentId, stepId: r.stepId, attestReqId: r.attestReqId, attestNonce: r.attestNonce, summaryHash: r.summaryHash,
  kind: 'not_committed', exp: NOW + LOCAL_ATTEST_TTL_MS, mac: 'm', ...o,
});

describe('증언 요청(attest.request)', () => {
  it('요약은 상호·사업자번호·합계 세 칸, 이 순서이고 summaryHash는 cardHash와 같은 바이트 규칙이다', () => {
    const r = req();
    assert.deepEqual(r.fields.map((f) => f.fieldKey), [...ATTEST_SUMMARY_KEYS]);
    assert.deepEqual(r.fields.map((f) => f.value), ['주식회사 시험상사', '1234567890', '110000']);
    assert.equal(r.summaryHash, attestSummaryHash(r.fields));
    assert.equal(r.summaryHash, cardHash(r.fields));
    assert.equal(r.v, 1);
    assert.equal(LOCAL_ATTEST_CONTEXT, 'SAX-local-attest-v1');
    assert.ok(!('exp' in r), '요청은 자기 만료가 없다(철회될 때까지 유효)');
  });
  it('요청마다 attestNonce가 다르고, attestReqId는 넘기면 유지한다(조회를 다시 해도 InDoubt면 같은 요청)', () => {
    const a = req({ attestReqId: 'ar-1' });
    const b = req({ attestReqId: 'ar-1' });
    assert.equal(a.attestReqId, b.attestReqId);
    assert.notEqual(a.attestNonce, b.attestNonce);
    assert.notEqual(req().attestReqId, req().attestReqId);
  });
  it('다른 건의 요약이면 해시가 다르다("확인 필요"가 둘 이상일 때 다른 건 증언 방지)', () => {
    assert.notEqual(req().summaryHash, req({ summary: { ...summary, totalAmount: '220000' } }).summaryHash);
  });
});

describe('main 자기 확인(attestSelfCheck)', () => {
  it('맞으면 null', () => assert.equal(attestSelfCheck(req()), null));
  it('키가 빠지거나·순서가 바뀌거나·더 있으면 field_key', () => {
    const r = req();
    assert.equal(attestSelfCheck({ ...r, fields: r.fields.slice(0, 2) }), 'field_key');
    assert.equal(attestSelfCheck({ ...r, fields: [r.fields[1]!, r.fields[0]!, r.fields[2]!] }), 'field_key');
    assert.equal(attestSelfCheck({ ...r, fields: [...r.fields, { fieldKey: 'remark', value: '' }] }), 'field_key');
    assert.equal(attestSelfCheck({ ...r, fields: [r.fields[0]!, r.fields[1]!, { fieldKey: 'totalAmount', value: 1 as unknown as string }] }), 'field_key');
  });
  it('해시가 다르면 summary_hash(무장하지 않는다)', () => {
    const r = req();
    assert.equal(attestSelfCheck({ ...r, summaryHash: '0'.repeat(64) }), 'summary_hash');
    assert.equal(attestSelfCheck({ ...r, fields: r.fields.map((f) => (f.fieldKey === 'totalAmount' ? { ...f, value: '1' } : f)) }), 'summary_hash');
  });
});

describe('엔진 대조(checkAttestation)', () => {
  it('미결 요청과 모두 맞으면 null', () => {
    const r = req();
    assert.equal(checkAttestation(att(r), r, NOW), null);
  });
  it('미결 요청이 없거나(철회 뒤 포함) 다른 요청 ID면 attest.no_request', () => {
    const r = req();
    assert.equal(checkAttestation(att(r), null, NOW), 'attest.no_request');
    assert.equal(checkAttestation(att(r, { attestReqId: 'other' }), r, NOW), 'attest.no_request');
    assert.equal(checkAttestation(null, r, NOW), 'attest.no_request');
    assert.equal(checkAttestation('x', r, NOW), 'attest.no_request');
  });
  it('nonce·intentId·stepId·summaryHash·kind·버전·mac 중 하나라도 다르면 attest.mismatch', () => {
    const r = req();
    for (const o of [
      { attestNonce: 'x' }, { intentId: 'intent-2' }, { stepId: 's21' }, { summaryHash: req({ summary: { ...summary, totalAmount: '1' } }).summaryHash },
      { kind: 'committed' as never }, { v: 2 as never }, { mac: undefined as never },
    ]) assert.equal(checkAttestation(att(r, o), r, NOW), 'attest.mismatch', JSON.stringify(o));
  });
  it('만료됐거나 발급 + 120초를 넘는 exp면 attest.expired', () => {
    const r = req();
    assert.equal(checkAttestation(att(r, { exp: NOW }), r, NOW), 'attest.expired');
    assert.equal(checkAttestation(att(r, { exp: NOW - 1 }), r, NOW), 'attest.expired');
    assert.equal(checkAttestation(att(r, { exp: NOW + LOCAL_ATTEST_TTL_MS + 1 }), r, NOW), 'attest.expired');
    assert.equal(checkAttestation(att(r, { exp: Number.NaN }), r, NOW), 'attest.expired');
    assert.equal(checkAttestation(att(r, { exp: NOW + 1 }), r, NOW), null);
  });
  it('승인 근거(LocalApproval 모양)는 증언으로 통하지 않는다', () => {
    const r = req();
    const approvalShaped = { v: 2, runId: r.runId, gateStepId: r.stepId, reqId: r.attestReqId, approvalNonce: r.attestNonce, actionHash: r.summaryHash, exp: NOW + 1000, presence: 'click', mac: 'm' };
    assert.notEqual(checkAttestation(approvalShaped, r, NOW), null);
  });
});
