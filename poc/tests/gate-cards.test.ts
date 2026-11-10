// 승인 카드 id별 게이트 요청(팀장 지시 2026-11-09, D03 §3, ADR-021): invoice.confirm = H-01 13칸, cert.confirm = 민원증명 4칸(H-03·H-04·H-08·H-09 공통).
// readbackCard·buildGateRequest·gateSelfCheck가 같은 앱 내장 표(GATE_CARDS)를 본다. 표에 없는 카드는 게이트를 열지 않는다.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildGateRequest, CERT_READBACK_KEYS, GATE_CARDS, gateSelfCheck, READBACK_KEYS, readbackCard, readbackHash, type GateField } from '@sax/engine';
import { APPROVAL_SUMMARIES, newScope } from '@sax/engine/core';

const H01_RB = Object.fromEntries(READBACK_KEYS.map((k) => [k, `값-${k}`]));
const CERT_RB = { certDoc: '납세증명서', certPurpose: '대금수령', certSubmitTo: '관공서', rrnDisclosure: '공개 안 함' };
const FIRST: GateField[] = [{ fieldKey: '$first.bizNo', value: 'false' }, { fieldKey: '$first.email', value: 'false' }];
const base = { runId: 'r1', gateStepId: 's20', packageDigest: 'd'.repeat(64), authorizes: ['s21'], intentId: 'i1', waitMs: 1000 };

describe('승인 카드 표(GATE_CARDS)', () => {
  it('카드 칸은 앱 내장 승인 바 요약 표(APPROVAL_SUMMARIES)의 요약 칸을 모두 담는다', () => {
    for (const [card, c] of GATE_CARDS) for (const k of APPROVAL_SUMMARIES.get(card) ?? ['(요약 표에 없음)']) assert.ok(c.keys.includes(k as never), `${card} ${k}`);
    assert.deepEqual([...GATE_CARDS.keys()].sort(), [...APPROVAL_SUMMARIES.keys()].sort(), '요약 표의 카드마다 게이트 칸이 있다');
  });
});

describe('readbackCard(카드 id별)', () => {
  it('cert.confirm: $readback의 민원증명 4칸만, 하나라도 없으면 null', () => {
    const s = newScope();
    for (const [k, v] of Object.entries(CERT_RB)) s.readback.set(k, v);
    s.readback.set('supplierBizNo', '1234567891');
    s.readback.set('applicantName', '홍길동');
    assert.deepEqual(readbackCard(s, 'cert.confirm'), CERT_RB);
    assert.equal(readbackCard(s), null, '기본(invoice.confirm)은 13칸이 없어 null');
    s.readback.delete('rrnDisclosure');
    assert.equal(readbackCard(s, 'cert.confirm'), null);
  });
  it('invoice.confirm(기본): 13칸 그대로', () => {
    const s = newScope();
    for (const [k, v] of Object.entries(H01_RB)) s.readback.set(k, v);
    assert.deepEqual(readbackCard(s), H01_RB);
    assert.deepEqual(readbackCard(s, 'invoice.confirm'), H01_RB);
  });
  it('표에 없는 카드는 null', () => {
    const s = newScope();
    for (const [k, v] of Object.entries(H01_RB)) s.readback.set(k, v);
    assert.equal(readbackCard(s, 'card.issue'), null);
    assert.equal(readbackCard(s, 'constructor'), null);
  });
});

describe('buildGateRequest·gateSelfCheck(카드 id별)', () => {
  it('cert.confirm: docType cert, 앞 4칸 + 예약 키, readbackHash는 4칸, main 자기 일치 확인 통과($first 없음)', () => {
    const req = buildGateRequest({ ...base, card: 'cert.confirm', readback: { ...CERT_RB, extra: 'x' }, reserved: [{ fieldKey: '$dup.businessKey', value: 'committed' }] });
    assert.equal(req.docType, 'cert');
    assert.deepEqual(req.fields.map((f) => f.fieldKey), [...CERT_READBACK_KEYS, '$dup.businessKey']);
    assert.equal(req.cardHashInputs.readbackHash, readbackHash(CERT_RB));
    assert.equal(gateSelfCheck(req), null);
  });
  it('invoice.confirm(기본): 이전과 같은 H-01 요청(docType H-01, 13칸 + $first)', () => {
    const a = buildGateRequest({ ...base, readback: H01_RB, reserved: FIRST });
    const b = buildGateRequest({ ...base, card: 'invoice.confirm', readback: H01_RB, reserved: FIRST });
    assert.equal(a.docType, 'H-01');
    assert.deepEqual(a.fields, b.fields);
    assert.equal(a.cardHashInputs.readbackHash, readbackHash(H01_RB));
    assert.equal(gateSelfCheck(a), null);
    assert.equal(gateSelfCheck({ ...a, docType: undefined } as never), null, 'docType 없는 요청은 H-01로 본다');
  });
  it('표에 없는 카드·칸이 빠진 readback은 요청을 만들지 않는다(던짐)', () => {
    assert.throws(() => buildGateRequest({ ...base, card: 'card.issue', readback: H01_RB, reserved: FIRST }), /gate.unknown_card/);
    const short: Record<string, string> = { ...CERT_RB };
    delete short.rrnDisclosure;
    assert.throws(() => buildGateRequest({ ...base, card: 'cert.confirm', readback: short, reserved: [] }), /gate.readback_missing/);
  });
  it('자기 일치 확인: 서류 종류와 앞 칸이 다르면 field_key(바를 무장하지 않음)', () => {
    const cert = buildGateRequest({ ...base, card: 'cert.confirm', readback: CERT_RB, reserved: [] });
    const h01 = buildGateRequest({ ...base, readback: H01_RB, reserved: FIRST });
    assert.equal(gateSelfCheck({ ...cert, docType: 'H-01' }), 'field_key', '민원증명 칸을 H-01로');
    assert.equal(gateSelfCheck({ ...h01, docType: 'cert' }), 'field_key', 'H-01 칸을 민원증명으로');
    assert.equal(gateSelfCheck({ ...cert, docType: 'gov24' as never }), 'field_key', '모르는 서류 종류');
    assert.equal(gateSelfCheck({ ...cert, docType: 'toString' as never }), 'field_key');
    assert.equal(gateSelfCheck({ ...h01, fields: h01.fields.filter((f) => f.fieldKey !== '$first.email') }), 'field_key', 'H-01은 $first가 늘 있어야 한다');
    const swapped = [cert.fields[1]!, cert.fields[0]!, ...cert.fields.slice(2)];
    assert.equal(gateSelfCheck({ ...cert, fields: swapped }), 'field_key', '칸 순서가 표와 다름');
    const forged = cert.fields.map((f) => (f.fieldKey === 'certSubmitTo' ? { ...f, value: '다른 곳' } : f));
    assert.equal(gateSelfCheck({ ...cert, fields: forged }), 'readback_hash', '보이는 값과 해시한 값이 다름');
  });
});
