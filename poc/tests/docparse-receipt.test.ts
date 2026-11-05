// M6-4 종이 증빙 규칙 파서(Electron 없음). 입력은 합성 영수증 24장의 OCR 흉내 글자(잡음 0·1·2단계).
// 실제 그림 → 샌드박스 OCR → 파서 정확도는 Electron e2e(apps/desktop/src/docparse-e2e.ts)가 재고 표로 낸다.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseReceipt, type ReceiptResult } from '@sax/docparse';
import { fmtBiz, receiptText, syntheticReceipts } from '@sax/docparse/fixtures';

const TODAY = '2026-11-05';
const R = syntheticReceipts();

function score(r: ReceiptResult, e: (typeof R)[number]['expected']) {
  return { amount: r.amount.value === e.amount, issuedOn: r.issuedOn.value === e.issuedOn, merchant: r.merchant.value === e.merchant, bizNo: r.merchantBizNo.value === e.bizNo };
}

describe('종이 증빙 규칙 파서: 합성 24장', () => {
  it('픽스처는 20장 이상, 사업자번호 체크섬만 맞춘 가짜(가운데 99)', () => {
    assert.ok(R.length >= 20);
    for (const r of R) assert.equal(r.bizNo.slice(3, 5), '99');
    assert.equal(new Set(R.map((r) => r.bizNo)).size, R.length);
  });

  for (const level of [0, 1, 2] as const) {
    it(`잡음 ${level}단계: 금액·날짜·상호·사업자번호 전부`, () => {
      const misses: unknown[] = [];
      for (const r of R) {
        const { result } = parseReceipt({ text: receiptText(r, level), ocrConfidence: level ? 80 : null, today: TODAY });
        const s = score(result, r.expected);
        if (!s.amount || !s.issuedOn || !s.bizNo || !s.merchant) misses.push({ id: r.id, layout: r.layout, s, got: { amount: result.amount, issuedOn: result.issuedOn.value, merchant: result.merchant.value, bizNo: result.merchantBizNo.value } });
      }
      assert.deepEqual(misses, []);
    });
  }

  it('깨끗한 글자에는 교차 확인 경고가 없다(품목 합·공급가액+부가세·합계 라벨끼리)', () => {
    for (const r of R) assert.ok(!parseReceipt({ text: receiptText(r), ocrConfidence: null, today: TODAY }).warnings.includes('amount_cross_check_failed'), r.id);
  });

  it('실측 OCR 잡음: 날짜에 붙은 시각, 한 글자씩 띄운 상호, 한 자리 빠진 사업자번호(후보만), 합계 라벨끼리 다른 값(신뢰도 낮춤)', () => {
    const r = R[0]!;
    const t = receiptText(r).replace(`거래일시: ${r.date} ${r.time}`, `거래일시: ${r.date}${r.time}`).replace(`가맹점명: ${r.merchant}`, `가맹점명: ${r.merchant.split('').join(' ')}`).replace(fmtBiz(r.bizNo), fmtBiz(r.bizNo).slice(1));
    const p = parseReceipt({ text: t, ocrConfidence: 85, today: TODAY }).result;
    assert.equal(p.issuedOn.value, r.date);
    assert.equal(p.merchant.value, r.merchant);
    assert.equal(p.merchantBizNo.value, null);
    assert.ok(p.merchantBizNo.candidates?.includes(r.bizNo), JSON.stringify(p.merchantBizNo));
    const pos = R.find((x) => x.layout === 'pos')!;
    const two = parseReceipt({ text: receiptText(pos).replace(/받을금액 [\d,]+/, '받을금액 3,000'), ocrConfidence: 85, today: TODAY });
    assert.ok(two.result.amount.confidence <= 0.5, JSON.stringify(two.result.amount));
    assert.ok(two.result.amount.candidates?.includes(pos.expected.amount));
  });

  it('공급가액 + 부가세 = 합계면 세 칸 신뢰도가 높다(교차 확인), 아니면 경고만', () => {
    const card = R.find((r) => r.layout === 'card')!;
    const ok = parseReceipt({ text: receiptText(card), ocrConfidence: null, today: TODAY });
    assert.ok(ok.result.amount.confidence >= 0.95 && ok.result.vat.confidence >= 0.9, JSON.stringify(ok.result.amount));
    const bad = parseReceipt({ text: receiptText(card).replace(/부가세: [\d,]+/, '부가세: 1'), ocrConfidence: null, today: TODAY });
    assert.ok(bad.warnings.includes('amount_cross_check_failed'));
    assert.equal(bad.result.amount.value, card.expected.amount, '판정하지 않는다: 합계 값은 그대로');
  });

  it('카드 전표: 승인번호·카드 끝 4자리(전체 번호는 내지 않는다), 서류 이름', () => {
    const card = R.find((r) => r.layout === 'card')!;
    const { result } = parseReceipt({ text: receiptText(card), ocrConfidence: null, today: TODAY });
    assert.equal(result.docKind, 'card_slip');
    assert.equal(result.approvalNo.value, card.approvalNo);
    assert.equal(result.cardTail.value, card.cardTail);
    assert.ok(!JSON.stringify(result).includes('9410-12'));
    const kinds = new Set(R.map((r) => parseReceipt({ text: receiptText(r), ocrConfidence: null, today: TODAY }).result.docKind));
    // POS 영수증은 제목 줄이 없어 unknown이다(내용으로 추측하지 않는다)
    assert.deepEqual([...kinds].sort(), ['card_slip', 'cash_receipt', 'simple_receipt', 'tax_invoice', 'unknown']);
  });

  it('사업자번호: OCR 혼동 문자(O→0, l→1)를 되돌리고, 체크섬이 틀리면 값 없이 후보로', () => {
    const r = R[0]!;
    const noisy = receiptText(r).replace(fmtBiz(r.bizNo), fmtBiz(r.bizNo).replace(/0/g, 'O').replace(/1/g, 'l'));
    assert.equal(parseReceipt({ text: noisy, ocrConfidence: 70, today: TODAY }).result.merchantBizNo.value, r.bizNo);
    const wrong = `${r.bizNo.slice(0, 9)}${(Number(r.bizNo[9]) + 1) % 10}`;
    const f = parseReceipt({ text: receiptText(r).replace(fmtBiz(r.bizNo), fmtBiz(wrong)), ocrConfidence: 70, today: TODAY }).result.merchantBizNo;
    assert.deepEqual([f.value, f.reason, f.candidates], [null, 'checksum_failed', [wrong]]);
  });

  it('날짜: 미래·유효기간·환불 기한 날짜는 거래일 후보가 아니다, 라벨 없는 다른 날짜 둘은 정하지 않는다', () => {
    const base = '가상상점\n사업자 ' + fmtBiz(R[1]!.bizNo) + '\n합계 10,000원';
    assert.equal(parseReceipt({ text: `${base}\n거래일시 2026-10-02 10:00\n교환·환불 기한 2026-10-16까지`, ocrConfidence: null, today: TODAY }).result.issuedOn.value, '2026-10-02');
    assert.equal(parseReceipt({ text: `${base}\n2027-01-01`, ocrConfidence: null, today: TODAY }).result.issuedOn.reason, 'not_found');
    const amb = parseReceipt({ text: `${base}\n2026-10-02\n2026-10-05`, ocrConfidence: null, today: TODAY }).result.issuedOn;
    assert.deepEqual([amb.value, amb.reason, amb.candidates], [null, 'ambiguous', ['2026-10-02', '2026-10-05']]);
  });

  it('금액 라벨이 없으면 쉼표·원이 붙은 가장 큰 수를 낮은 신뢰도로', () => {
    const f = parseReceipt({ text: '가상상점\n아메리카노 4,500원\n케이크 28,000원\n32,500원', ocrConfidence: 85, today: TODAY }).result.amount;
    assert.equal(f.value, 32500);
    assert.ok(f.confidence < 0.5);
  });

  it('OCR 신뢰도가 낮으면 같은 규칙이라도 신뢰도가 낮다', () => {
    const t = receiptText(R[2]!);
    const hi = parseReceipt({ text: t, ocrConfidence: 95, today: TODAY }).result.amount.confidence;
    const lo = parseReceipt({ text: t, ocrConfidence: 30, today: TODAY }).result.amount.confidence;
    assert.ok(hi > lo, `${hi} > ${lo}`);
  });

  it('빈 글자·잡음만: 칸이 모두 비고 core_fields_missing, 예외 없음', () => {
    for (const t of ['', '\n\n', 'ㅁㄴㅇㄹ ||| ...', 'x'.repeat(5000)]) {
      const p = parseReceipt({ text: t, ocrConfidence: 10, today: TODAY });
      assert.equal(p.result.amount.value, null);
      assert.ok(p.warnings.includes('core_fields_missing'));
    }
  });
});
