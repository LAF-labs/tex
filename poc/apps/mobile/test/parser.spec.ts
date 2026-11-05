// P-08 규칙 파서 시험(폰 앱 자체 시험 실행기: node --test).
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseAmount, parseBizNo, parseDate, parseMerchant, parseReceipt, validBizNo } from '../src/capture/parser.ts';

const today = new Date(2026, 10, 5);

describe('사업자번호', () => {
  it('검증 숫자', () => {
    assert.equal(validBizNo('2208162517'), true);
    assert.equal(validBizNo('2208162518'), false);
    assert.equal(validBizNo('1234567890'), false);
    assert.equal(validBizNo('12345'), false);
  });
  it('하이픈·공백 변형을 읽고 틀린 번호는 버린다', () => {
    assert.equal(parseBizNo(['사업자번호: 220-81-62517']), '220-81-62517');
    assert.equal(parseBizNo(['등록번호 220 81 62517']), '220-81-62517');
    assert.equal(parseBizNo(['2208162517']), '220-81-62517');
    assert.equal(parseBizNo(['220-81-62518', '전화 02-1234-5678']), undefined);
  });
});

describe('날짜', () => {
  it('여러 표기', () => {
    assert.equal(parseDate(['거래일시 2026-11-01 13:22:05'], today), '2026-11-01');
    assert.equal(parseDate(['2026.10.31'], today), '2026-10-31');
    assert.equal(parseDate(['2026년 9월 3일'], today), '2026-09-03');
    assert.equal(parseDate(['26/11/04 09:10'], today), '2026-11-04');
  });
  it('없는 날·먼 미래·아주 오래된 날은 버린다', () => {
    assert.equal(parseDate(['2026-02-30'], today), undefined);
    assert.equal(parseDate(['2027-01-01'], today), undefined);
    assert.equal(parseDate(['2015-01-01'], today), undefined);
  });
});

describe('금액', () => {
  it('합계 줄을 고르고 부가세·받은 돈은 고르지 않는다', () => {
    const lines = ['아메리카노 2 4,500 9,000', '공급가액 13,637', '부가세 1,363', '합계 15,000', '받은돈 20,000', '거스름돈 5,000'];
    assert.equal(parseAmount(lines), 15000);
  });
  it('금액이 다음 줄에 있는 영수증', () => {
    assert.equal(parseAmount(['결제금액', '₩ 38,000']), 38000);
  });
  it('키워드가 없으면 원 표기가 붙은 가장 큰 수', () => {
    assert.equal(parseAmount(['볼트 3개 1,200원', '너트 2,400원', '전화 031-123-4567']), 2400);
  });
  it('날짜·전화·사업자번호를 금액으로 읽지 않는다', () => {
    assert.equal(parseAmount(['2026-11-01', '010-1234-5678', '220-81-62517']), undefined);
  });
});

describe('상호', () => {
  it('상호 라벨', () => {
    assert.equal(parseMerchant(['[영수증]', '상호: 가나다상회', '대표 홍길동']), '가나다상회');
    assert.equal(parseMerchant(['가맹점명 (주)테스트마트 강남점']), '(주)테스트마트 강남점');
  });
  it('라벨이 없으면 맨 위 한글 줄', () => {
    assert.equal(parseMerchant(['행복한 분식', '서울 강남구 테헤란로 1', 'TEL 02-555-1234']), '행복한 분식');
  });
  it('영수증 머리말은 상호가 아니다', () => {
    assert.equal(parseMerchant(['영수증', 'RECEIPT', '1234']), undefined);
  });
});

describe('영수증 전체', () => {
  it('간이영수증 한 장', () => {
    const lines = ['간이영수증', '상호 가나다상회', '사업자등록번호 220-81-62517', '2026.11.01 14:03', '품목 수량 금액', '종이컵 2 6,000', '합 계 12,000원'];
    assert.deepEqual(parseReceipt(lines, today), { amount: 12000, issuedOn: '2026-11-01', merchant: '가나다상회', merchantBizNo: '220-81-62517' });
  });
  it('읽은 것이 없으면 빈 후보', () => {
    assert.deepEqual(parseReceipt([], today), {});
  });
});
