// 사업자등록증 OCR 해석(엔진 parseBizCert, PoC-5, 08 §4 O-02, ADR-014): OCR로 깨진 상호는 후보로 내지 않고 missing으로 보낸다.
// #219 관찰: 신뢰도 67 회차에서 상호 줄이 `가나상사상호 _ :： 가나상사`로 깨졌는데 null이 아니어서 missing에 들어가지 않았다.
// 실제 상호(괄호·&·점·하이픈·가운뎃점, '상호저축은행'·'대성명품'처럼 라벨 글자가 든 이름)는 그대로 둔다. 시험은 글자만 쓴다(tesseract 없음).
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { syntheticBizNo } from '@sax/db';
import { brokenBizName, parseBizCert } from '@sax/engine';

const cert = (nameLine: string) => {
  const b = syntheticBizNo(11);
  return `사 업 자 등 록 증\n( 일 반 과 세 자 )\n등 록 번 호 : ${b.slice(0, 3)}-${b.slice(3, 5)}-${b.slice(5)}\n${nameLine}\n대 표 자 : 이가나\n개 업 연 월 일 : 2020 년 01 월 15 일\n사 업 장 소 재 지 : 서울특별시 마포구 월드컵로 10\n`;
};

describe('parseBizCert: 깨진 상호는 missing으로(#219)', () => {
  it('#219 실패 회차의 상호 줄은 name null, missing에 name. 나머지 칸은 그대로', () => {
    const r = parseBizCert(cert('상 호 : 가나상사상호 _ :： 가나상사'));
    assert.equal(r.fields.name, null);
    assert.deepEqual(r.missing, ['name']);
    assert.equal(r.fields.repName, '이가나');
    assert.equal(r.fields.openDate, '20200115');
    assert.equal(r.bizNoChecksumOk, true);
  });

  it('깨짐 판정: 잡음 글자·낱자모, 다른 칸 라벨(줄 합쳐짐), 라벨을 사이에 둔 되풀이', () => {
    for (const v of [
      '가나상사상호 _ :： 가나상사',
      '가나상사 :',
      '가나_상사',
      '가나|상사',
      '가나상ㅅㅏ',
      '가나상사 [주]',
      '가나상사 대표자 이가나',
      '가나상사 개 업 연 월 일 2020',
      '가나상사 사업장소재지 서울',
      '가나상사상호가나상사',
      '가나상사 상 호 가나상사',
    ]) assert.equal(brokenBizName(v), true, v);
  });

  it('실제 상호는 깨짐이 아니다: 괄호·&·점·쉼표·하이픈·가운뎃점·영문, 상호·성명 글자가 든 이름', () => {
    for (const v of ['가나상사', '주식회사 가나다', '(주)가나다', '가나다(주)', '에이비씨 & 코', 'A.B.C 코리아', '가나-다라', '가나·다라', "Kim's 카페", 'Gana, Inc 코리아', '가나상호저축은행', '대성명품', '상호무역']) {
      assert.equal(brokenBizName(v), false, v);
      assert.equal(parseBizCert(cert(`상 호 : ${v}`)).fields.name, v, v);
    }
  });

  it('법인 등록증의 법인명(단체명) 칸도 같다', () => {
    const r = parseBizCert(cert('법 인 명 ( 단 체 명 ) : 주식회사 다라테크 업태'));
    assert.equal(r.fields.name, null);
    assert.ok(r.missing.includes('name'));
    assert.equal(parseBizCert(cert('법 인 명 ( 단 체 명 ) : 주식회사 다라테크')).fields.name, '주식회사 다라테크');
  });
});

// 2026-11-10 설치본: 실제 등록증 JPEG에서 6칸 중 4칸이 비었다(대표자 포함). 실제 양식의 표기 변형을 OCR 글자 견본(가상 값)으로 본다.
// 원칙: 못 뽑은 칸은 null(사용자가 채운다). 잘못 채우는 것이 비우는 것보다 나쁘다.
describe('parseBizCert: 실제 양식 표기 변형(OCR 글자 견본)', () => {
  const b = syntheticBizNo(31);
  const dashed = `${b.slice(0, 3)}-${b.slice(3, 5)}-${b.slice(5)}`;
  const p = (body: string) => parseBizCert(`사 업 자 등 록 증\n( 일 반 과 세 자 )\n등 록 번 호 : ${dashed}\n${body}`).fields;

  it('개인 양식: 성명과 생년월일이 한 줄(쌍점이 잡음으로 읽혀도 생년월일은 대표자가 아니다)', () => {
    for (const line of ['성 명 : 이 가 나 생 년 월 일 : 1985 년 03 월 12 일', '. 성명 : 이가나 생년월일 _ :1985 년 03 월 12 일', '성명 : 이가나 생년월일 1985 년 03 월 12 일', '성명 ; 이가나 생년 월일 ; 1985.03.12']) {
      assert.equal(p(line).repName, '이가나', line);
    }
  });

  it('대표자 라벨 변형: 성명(대표자)·대표자(성명)·대 표 자·성명 :, 줄 머리 잡음', () => {
    for (const line of ['성 명 (대표자) : 홍길동', '대 표 자 (성 명) : 홍길동', '대 표 자 : 홍 길 동', '성명 : 홍길동', '| 대표자 : 홍길동', 'ㆍ 성 명 : 홍길동 |', '① 대 표 자 : 홍길동', '대표자（성명）：홍길동']) {
      assert.equal(p(line).repName, '홍길동', line);
    }
  });

  it('대표자 성명만: 생년월일·주민번호·괄호는 버린다, 공동대표 "외 N명"은 둔다', () => {
    assert.equal(p('대표자 : 홍길동 (800101-1******)').repName, '홍길동');
    assert.equal(p('성명 : 홍길동 800101-1234567').repName, '홍길동');
    assert.equal(p('성명 : 홍길동 주민등록번호 : 800101-*******').repName, '홍길동');
    assert.equal(p('대 표 자 : 홍길동 외 1명').repName, '홍길동 외 1명');
    assert.equal(p('대표자 : 홍길동외 2 명').repName, '홍길동 외 2명');
    assert.equal(p('대표자 : GILDONG HONG').repName, 'GILDONG HONG');
  });

  it('대표자 이름 모양이 아니면 비운다(추측하지 않는다)', () => {
    for (const line of ['대표자 : 1234', '대표자 : 가나다라마바사', '대표자 :', '대표자 : 홍_길동', '대표자 : ㅎㄱㄷ']) assert.equal(p(line).repName, null, line);
  });

  it('상호 라벨 변형: 상 호 (법인명)·법인명(단체명)·법 인 명, 값의 (주)는 둔다', () => {
    assert.equal(p('상 호 (법인명) : 가나상사').name, '가나상사');
    assert.equal(p('법인명(단체명) : 주식회사 가나').name, '주식회사 가나');
    assert.equal(p('법 인 명 ( 단 체 명 ) ： 주식회사 가나').name, '주식회사 가나');
    assert.equal(p('법 인 명 : (주)가나').name, '(주)가나');
    assert.equal(p('상호 : (주)가나').name, '(주)가나');
    assert.equal(p('| 상 호 : 가 나 상사').name, '가나상사');
  });

  it('상호에 라벨 글자가 들어 있어도 대표자로 읽지 않는다("대성명품"의 성명)', () => {
    const f = p('상 호 : 대 성 명 품\n성 명 : 이가나');
    assert.equal(f.name, '대성명품');
    assert.equal(f.repName, '이가나');
    assert.equal(p('상 호 : 대성명품').repName, null);
  });

  it('주소: 사업장 소재지 우선, 법인은 본점 소재지만 있으면 그것, 비어 있으면 null', () => {
    assert.equal(p('사업장 소재지 : 서울특별시 마포구 월드컵로 10').address, '서울특별시 마포구 월드컵로 10');
    assert.equal(p('사 업 장 소 재 지 : 서 울 특별시 마포구 월 드 컵 로 10').address, '서울특별시 마포구 월드컵로 10');
    assert.equal(p('본 점 소 재 지 : 경기도 성남시 분당구 판교로 20\n사업장 소재지 : 경기도 수원시 팔달구 효원로 1').address, '경기도 수원시 팔달구 효원로 1');
    assert.equal(p('본점 소재지 : 경기도 성남시 분당구 판교로 20').address, '경기도 성남시 분당구 판교로 20');
    assert.equal(p('사업장 소재지 :\n사 업 의 종 류 : 업태 도매 종목 문구').address, null);
  });

  it('업태·종목: 사업의 종류 한 줄, 따로 두 줄, 여러 줄은 첫 줄만, 머리 줄만 있으면 비운다', () => {
    let f = p('사 업 의 종 류 : 업태 도매 및 소매업 종목 전자상거래 소매업\n서비스업 소프트웨어 개발');
    assert.deepEqual([f.bizType, f.bizItem], ['도매 및 소매업', '전자상거래 소매업']);
    f = p('사업의 종류 : 업 태 : 제조업 종 목 : 금속 가공');
    assert.deepEqual([f.bizType, f.bizItem], ['제조업', '금속 가공']);
    f = p('업 태 : 서비스\n종 목 : 소프트웨어 개발');
    assert.deepEqual([f.bizType, f.bizItem], ['서비스', '소프트웨어 개발']);
    f = p('사업의 종류 : 업태 종목\n도매 및 소매업 전자상거래');
    assert.deepEqual([f.bizType, f.bizItem], [null, null], '열을 가를 수 없으면 비운다');
    f = p('업태 : 서비스');
    assert.deepEqual([f.bizType, f.bizItem], ['서비스', null]);
  });

  it('라벨과 값이 다른 줄: 바로 다음 줄을 값으로. 라벨 열·값 열이 따로 나온 순서는 짝짓지 않는다', () => {
    let f = p('상 호\n가나상사\n성 명\n이가나\n사업장 소재지\n서울특별시 마포구 월드컵로 10');
    assert.deepEqual([f.name, f.repName, f.address], ['가나상사', '이가나', '서울특별시 마포구 월드컵로 10']);
    f = p('상 호 :\n성 명 :\n가나상사\n이가나');
    assert.deepEqual([f.name, f.repName], [null, null]);
  });

  it('등록번호: 숫자 사이 공백·O/l 오인식·여러 줄표, 법인등록번호·발급번호와 섞지 않는다', () => {
    const q = (no: string) => parseBizCert(`등 록 번 호 : ${no}\n상호 : 가나`);
    const sp = `${b.slice(0, 3).split('').join(' ')} - ${b.slice(3, 5)} - ${b.slice(5)}`;
    assert.equal(q(sp).fields.bizNo, b);
    assert.equal(q(dashed.replace(/0/g, 'O').replace(/1/g, 'l')).fields.bizNo, b);
    assert.equal(q(dashed.replace(/-/g, '–')).fields.bizNo, b);
    assert.equal(q(dashed.replace(/-/g, ' _ ')).fields.bizNo, b);
    // 한 자리 더 읽힌 번호(합성 스캔에서 본 "1900-16-62990")를 잘라 맞추지 않는다
    assert.equal(q(`1${dashed}`).fields.bizNo, null);
    const corp = parseBizCert('발급번호 : 0000-000-0000-000\n법인등록번호 : 131111-0012345\n법인명(단체명) : 주식회사 가나');
    assert.equal(corp.fields.bizNo, null);
    assert.equal(corp.fields.corpNo, '1311110012345');
    // 라벨이 깨져도 문서 안의 3-2-5는 찾는다
    assert.equal(parseBizCert(`등 롤 번 호 ; ${dashed}`).fields.bizNo, b);
  });

  it('6칸이 모두 있는 개인·법인 견본(OCR 잡음 섞임)', () => {
    const ind = parseBizCert(`| 발 급 번호: 0000-000-0000-000\n사 업 자 등 록 증\n( 일 반 과세자 )\n, 등 록 번호 : ${dashed}\n상호 : 가 나 상사\n. 성명 : 이가나 생년월일 _ :1985 년 03 월 12 일\n개 업 연월일 : 2020 년 01 월 15 일\nㆍ 사 업 장 소재지 : 서 울 특별시 마포구 월 드 컵 로 10, 2층\n사 업 의 종 류 : 업태 도매 및 소매업 종목 전 자 상거래 소매업\n서비스업 소프트웨어 개발\n발 급 사유 : 신규\n공 동 사업자\n`).fields;
    assert.deepEqual([ind.bizNo, ind.name, ind.repName, ind.address, ind.bizType, ind.bizItem, ind.kind, ind.openDate], [b, '가나상사', '이가나', '서울특별시 마포구 월드컵로 10, 2층', '도매 및 소매업', '전자상거래 소매업', 'individual', '20200115']);
    const c = syntheticBizNo(32);
    const corp = parseBizCert(`사 업 자 등 록 증\n( 법 인 사업자 )\n등 록 번호 : ${c.slice(0, 3)}-${c.slice(3, 5)}-${c.slice(5)}\nㆍ 법 인 명 (단체명) : 주식회사 다 라 테크\n대표자 : 박 다 라 외 1명\n! 개 업 연월일 : 2018 년 11 월 02 일 법 인 등 록 번호 : 131111-0012345\n. 사 업 장 소재지 : 경기도 성남시 분당구 판 교 로 20\nㆍ 본 점 소재지 : 경기도 성남시 분당구 판 교 로 21\nㆍ 사 업 의 종 류 : 업태 서비스 종목 소프트웨어 개발 및 공급\n`).fields;
    assert.deepEqual([corp.bizNo, corp.name, corp.repName, corp.address, corp.bizType, corp.bizItem, corp.kind, corp.corpNo, corp.openDate], [c, '주식회사 다라테크', '박다라 외 1명', '경기도 성남시 분당구 판교로 20', '서비스', '소프트웨어 개발 및 공급', 'corporate', '1311110012345', '20181102']);
  });
});
