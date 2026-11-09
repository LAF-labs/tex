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
