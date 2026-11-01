// PoC-8 메타 추출(S4)·만료 규칙(D07 §3)·docparse 텍스트 정리. 입력은 pdf.js·OCR이 내는 모양을 흉내 낸 합성 텍스트(가짜 값)다.
// PDF를 실제로 샌드박스에서 읽는 경로는 Electron e2e(apps/desktop/src/docparse-e2e.ts)가 본다.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { formatBizNo, syntheticBizNo } from '@sax/db';
import { addDays, daysLeft, decideExpiry, extractDocMeta, kstToday, l0ShadowPick, validateDocMeta, type DocMetaExtract } from '@sax/engine';
// @ts-expect-error 샌드박스 정적 모듈(JS)
import { cleanForOcr } from '../apps/desktop/static/docparse-image.mjs';
// @ts-expect-error 샌드박스 정적 모듈(JS)
import { assessTextLayer, itemsToLines, tidyText } from '../apps/desktop/static/docparse-text.mjs';

const BIZ = syntheticBizNo(7);
const BIZ_F = formatBizNo(BIZ);

function taxText(o: { issued?: string; valid?: string; spaced?: boolean; extra?: string; issuer?: string } = {}): string {
  const s = (x: string) => (o.spaced ? x.split('').join(' ') : x);
  return [
    `${s('발급번호')} 0123-457-5258-910 ${s('처리기간')} 즉시 (단, 해외이주용 10일)`,
    s('납세증명서'),
    '성명(상호) 주식회사 가나다테크',
    `${s('납세자')} 주민등록번호(사업자등록번호) ${BIZ_F}`,
    '증명서의 사용목적 [√] 대금수령 [ ] 해외이주 [ ] 기타',
    `${s('유효기간')} ${o.valid ?? '2026년 11월 30일'}`,
    '증명서의 유효기간을 정한 사유 [√] 「국세징수법 시행령」 제96조제1항 [ ] 기타 (사유: )',
    '연장ㆍ유예 내역 (단위: 원)',
    '종류 기간 과세기간 세목 납부기한 세액 가산금',
    '징수유예 2026년 10월 4일 ~ 2026년 12월 3일 2026년 1기 부가가치세 2026년 12월 3일 1,200,000 0',
    '「국세징수법」 제108조 및 같은 법 시행령 제95조에 따라 … 다른 체납액이 없음을 증명합니다.',
    '※ 발급일 현재 지정납부기한이 도래하지 않은 미납국세는 체납액이 아니므로 증명 대상에서 제외됨.',
    `${s('담당부서')} 민원봉사실 ${s('담당자')} 김담당`,
    o.issued ?? '2026년 11월 1일',
    `${s('연락처')} 02-000-0000 ${o.issuer ?? `가나${s('세무서장')} 직인`}`,
    o.extra ?? '',
  ].join('\n');
}

function bizText(o: { issued?: string; spaced?: boolean; title?: boolean } = {}): string {
  const s = (x: string) => (o.spaced ? x.split('').join(' ') : x);
  return [
    `${s('발급번호')} T123-472-2634-650 ${s('처리기간')} 즉시`,
    o.title === false ? '어 드 즈 ㅁ' : s('사업자등록증명'),
    '( 법인사업자 )',
    `${s('상호(법인명)')} 주식회사 바사아 ${s('사업자등록번호')} ${BIZ_F}`,
    '대표자성명(대표유형) 최바사(단독) 주민(법인)등록번호 110111-*******',
    `${s('개업일')} 2019년 04월 11일 ${s('사업자등록일')} 2019년 04월 14일`,
    '업태 서비스 종목 소프트웨어 개발',
    '위와 같이 증명합니다.',
    '※ 위 내용은 발급일 현재 상황으로서 추후 변경될 수 있습니다.',
    o.issued ?? '2026년 10월 06일',
    `${s('접수번호')} 2634650 ${s('담당부서')} 민원봉사실`,
    `아자${s('세무서장')} (인)`,
  ].join('\n');
}

describe('메타 추출: 납세증명서(국세)', () => {
  it('붙여 쓴 라벨·띄운 라벨 모두 발급일·유효기간·발급기관·발급번호·사업자번호', () => {
    for (const spaced of [false, true]) {
      const m = extractDocMeta(taxText({ spaced }));
      assert.equal(m.docType, 'national_tax_cert');
      assert.deepEqual([m.issuedOn.value, m.validUntil.value, m.issuer.value, m.docNo.value, m.subjectBizNo.value], ['2026-11-01', '2026-11-30', '가나세무서장', '0123-457-5258-910', BIZ], `spaced=${spaced}`);
      assert.ok(validateDocMeta(m), '스키마 통과');
    }
  });

  it('날짜 형식: 한글·0 채움·점·하이픈("까지")', () => {
    for (const [issued, valid] of [['2026년 11월 01일', '2026년 12월 01일'], ['2026. 11. 1.', '2026. 12. 1.'], ['2026-11-01', '2026-12-01 까지'], ['2026.11.01', '2026.12.01']] as const) {
      const m = extractDocMeta(taxText({ issued, valid }));
      assert.deepEqual([m.issuedOn.value, m.validUntil.value], ['2026-11-01', '2026-12-01'], issued);
    }
  });

  it('유효기간이 "A ~ B"면 끝 날짜', () => {
    assert.equal(extractDocMeta(taxText({ valid: '2026. 11. 1. ~ 2026. 11. 20.' })).validUntil.value, '2026-11-20');
  });

  it('연장ㆍ유예 내역·납부기한·출력 시각 날짜는 발급일 후보가 아니다', () => {
    const m = extractDocMeta(taxText({ extra: '출력일시 2026-11-02 10:42' }));
    assert.equal(m.issuedOn.value, '2026-11-01');
    const timed = extractDocMeta(taxText({ extra: '2026-11-02 10:42:31' }));
    assert.equal(timed.issuedOn.value, '2026-11-01', '시각이 붙은 날짜(인쇄 시각)는 뺀다');
  });

  it('맺음 부분에 서로 다른 날짜가 둘이면 정하지 않고 후보만 준다', () => {
    const m = extractDocMeta(taxText({ extra: '2026년 11월 3일' }));
    assert.equal(m.issuedOn.value, null);
    assert.equal(m.issuedOn.reason, 'ambiguous');
    assert.equal(m.issuedOn.suggested, '2026-11-03');
  });

  it('유효기간 기간 표기: 〜(U+301C)도 끝 날짜, "부터 30일간"처럼 끝이 없으면 정하지 않는다', () => {
    assert.equal(extractDocMeta(taxText({ valid: '2026. 11. 1. \u301c 2026. 11. 20.' })).validUntil.value, '2026-11-20');
    const open = extractDocMeta(taxText({ valid: '2026. 11. 1.부터 30일간' })).validUntil;
    assert.deepEqual([open.value, open.reason, open.suggested], [null, 'ambiguous', '2026-11-01']);
  });

  it('OCR이 숫자 뒤에 영문을 붙이면(3O일) 날짜를 자르지 않고 못 찾음으로', () => {
    const m = extractDocMeta(taxText({ valid: '2026년 11월 3O일' }));
    assert.deepEqual([m.validUntil.value, m.validUntil.reason], [null, 'not_found']);
  });

  it("'증명합니다'를 못 읽으면 세무서장 근처 날짜를 쓰되 불확실로 둔다(사용자 확인)", () => {
    // 납부기한 날짜가 근처에 있으면 둘 중 정하지 않는다(후보만)
    const near = extractDocMeta(taxText().replace('증명합니다', '증멍합니다'));
    assert.deepEqual([near.issuedOn.value, near.issuedOn.reason, near.issuedOn.suggested], [null, 'ambiguous', '2026-11-01']);
    const noRow = taxText().split('\n').filter((l) => !l.startsWith('징수유예')).join('\n');
    const m = extractDocMeta(noRow.replace('증명합니다', '증멍합니다'));
    assert.equal(m.issuedOn.value, '2026-11-01');
    assert.deepEqual(m.uncertain, ['issuedOn']);
    const d = decideExpiry(m, '2026-11-10');
    assert.equal(d.needsUser, true);
    assert.ok(d.reasons.includes('issued_on_uncertain'));
    const labelled = extractDocMeta(noRow.replace('증명합니다', '증멍합니다').replace('\n2026년 11월 1일', '\n발급일 2026년 11월 1일'));
    assert.deepEqual([labelled.issuedOn.value, labelled.uncertain], ['2026-11-01', []], "'발급일' 라벨이 있으면 확실");
  });

  it('개업연월일·서식 개정일·하이픈 기간은 발급일 후보가 아니다', () => {
    const m = extractDocMeta(bizText().replace('위와 같이 증명합니다.', '위와 같이 증명합니다.\n개업연월일 2019년 04월 11일 <개정 2023. 3. 20.> 2026-01-01 - 2026-03-31'));
    assert.equal(m.issuedOn.value, '2026-10-06');
  });

  it('없는 날짜(2월 30일)는 해석 불가', () => {
    const m = extractDocMeta(taxText({ valid: '2026년 2월 30일' }));
    assert.deepEqual([m.validUntil.value, m.validUntil.reason], [null, 'unparseable']);
  });

  it('발급기관: 붙은 이름, 띄운 낱글자, OCR이 섞은 띄어쓰기', () => {
    assert.equal(extractDocMeta(taxText({ issuer: '다 라 세 무 서 장 직인' })).issuer.value, '다라세무서장');
    assert.equal(extractDocMeta(taxText({ issuer: '마 바 사세 무 서 장 직인' })).issuer.value, '마바사세무서장');
    assert.equal(extractDocMeta(taxText({ issuer: '역삼 세무서장' })).issuer.value, '역삼세무서장');
    assert.equal(extractDocMeta(taxText({ issuer: '담당자김담당가나다라세무서장' })).issuer.reason, 'ambiguous', '이름이 4자를 넘으면 정하지 않는다');
    assert.equal(extractDocMeta(taxText({ issuer: '민원봉사실세무서장 직인' })).issuer.reason, 'ambiguous', '직인에 가려 부서명이 붙은 경우');
    assert.equal(extractDocMeta(taxText({ issuer: '자세무서장 직인' })).issuer.reason, 'ambiguous', '한 글자는 이름으로 보지 않는다');
  });

  it('사업자번호: 체크섬이 틀리면 값을 두지 않고 후보로', () => {
    const wrong = `${BIZ.slice(0, 9)}${(Number(BIZ[9]) + 1) % 10}`;
    const m = extractDocMeta(taxText().replace(BIZ_F, formatBizNo(wrong)));
    assert.deepEqual([m.subjectBizNo.value, m.subjectBizNo.reason, m.subjectBizNo.suggested], [null, 'checksum_failed', wrong]);
    const spacedDigits = extractDocMeta(taxText().replace(BIZ_F, `${BIZ_F.slice(0, 8)} ${BIZ_F.slice(8)}`));
    assert.equal(spacedDigits.subjectBizNo.value, BIZ, 'OCR이 숫자 사이에 넣은 공백');
  });

  it('OCR 잡음: 제목을 놓쳐도 본문 문구로 알아보고, T를 ㅠ로 읽은 발급번호를 되돌린다', () => {
    const ocr = taxText({ spaced: true }).replace('납 세 증 명 서', '나 즈 며').replace('0123-457-5258-910', 'ㅠ 123-457-5258-910');
    const m = extractDocMeta(ocr);
    assert.equal(m.docType, 'national_tax_cert');
    assert.equal(m.docNo.value, 'T123-457-5258-910');
  });
});

describe('메타 추출: 사업자등록증명', () => {
  it('발급일만 있고 유효기간은 해당 없음. 개업일·등록일은 발급일이 아니다', () => {
    for (const spaced of [false, true]) {
      const m = extractDocMeta(bizText({ spaced }));
      assert.equal(m.docType, 'biz_registration_cert');
      assert.deepEqual([m.issuedOn.value, m.validUntil.reason, m.issuer.value, m.docNo.value, m.subjectBizNo.value], ['2026-10-06', 'not_applicable', '아자세무서장', 'T123-472-2634-650', BIZ]);
    }
  });

  it('제목을 놓친 OCR 텍스트도 사업자등록일·증명 문구·세무서장으로 알아본다', () => {
    assert.equal(extractDocMeta(bizText({ title: false })).docType, 'biz_registration_cert');
  });
});

describe('메타 추출: 지원하지 않는 서류', () => {
  const cases: Array<[string, string]> = [
    ['지방세 납세증명서\n「지방세징수법」 제5조에 따라 위와 같이 증명합니다.\n2026년 10월 20일\n가나구청장 (인)', 'localtax_cert'],
    ['사업자등록증\n( 일반과세자 )\n등록번호 : 123-45-67890\n2026년 10월 20일\n가나세무서장', 'biz_registration'],
    ['( 휴업 폐업 ) 사 실 증 명\n위와 같이 증명합니다.\n2026년 10월 20일\n가나세무서장 (인)', 'closure_cert'],
    ['CERTIFICATE OF TAX PAYMENT\nIssue No. 0123-457-5258-910', 'english_cert'],
    ['영수증\n2026년 10월 20일', 'unknown'],
    [`${taxText()}\n${bizText()}`, 'ambiguous'],
  ];
  for (const [text, kind] of cases) {
    it(kind, () => {
      const m = extractDocMeta(text);
      assert.equal(m.kind, kind);
      assert.equal(m.docType, null);
      assert.equal(m.issuedOn.reason, 'unsupported_doc');
      assert.ok(validateDocMeta(m));
    });
  }
});

describe('doc_meta_check_v1 후보와 L0 규칙(그림자 판정)', () => {
  it('후보는 최대 8개, 문맥은 마스킹. L0 규칙이 발급일·유효기간 후보를 고른다', () => {
    const m = extractDocMeta(taxText());
    assert.ok(m.candidates.length > 0 && m.candidates.length <= 8);
    assert.ok(m.candidates.every((c) => !c.context.includes(BIZ_F)), '사업자번호가 문맥에 남지 않는다');
    // 지금 L0 규칙은 ±40자 문맥이 겹쳐(유효기간·발급일 라벨이 여러 후보에 들어간다) 실제 서식 배치에서 답하지 못한다(PoC-8 보고서 §4).
    // 답하지 못하면(null) 모델 몫이다. 답했다면 추출기와 같아야 한다.
    for (const [q, want] of [['issued_on', '2026-11-01'], ['valid_until', '2026-11-30']] as const) {
      const got = l0ShadowPick(m, q);
      assert.ok(got === null || got === want, `${q}: ${got}`);
    }
    const lone = extractDocMeta('납세증명서 국세징수법 세무서장\n유효기간 2026년 11월 30일까지' + ' '.repeat(80) + '\n발급일 2026년 11월 1일');
    assert.deepEqual([l0ShadowPick(lone, 'issued_on'), l0ShadowPick(lone, 'valid_until')], ['2026-11-01', '2026-11-30'], '문맥이 겹치지 않으면 L0가 고른다');
  });
});

describe('만료 규칙(D07 §3)', () => {
  const TODAY = '2026-11-10';
  const meta = (o: Partial<Record<'issued' | 'valid', string | null>> & { docType?: DocMetaExtract['docType'] } = {}): DocMetaExtract => {
    const m = extractDocMeta(taxText());
    const f = (v: string | null | undefined, keep: DocMetaExtract['issuedOn']) => (v === undefined ? keep : v === null ? { value: null, reason: 'not_found' as const } : { value: v, reason: null });
    return { ...m, docType: o.docType === undefined ? m.docType : o.docType, issuedOn: f(o.issued, m.issuedOn), validUntil: f(o.valid, m.validUntil) };
  };

  it('납세증명서: 문서의 유효기간이 발급일~발급일+30일이면 그대로(출처 문서)', () => {
    for (const valid of ['2026-11-01', '2026-11-30', '2026-12-01', '2026-11-13']) {
      assert.deepEqual(decideExpiry(meta({ valid }), TODAY), { expiresOn: valid, source: 'document', needsUser: false, reasons: [] }, valid);
    }
  });

  it('납세증명서: 범위 밖·못 읽음이면 규칙표(발급일 포함 30일)로 추정하고 확인을 요구한다', () => {
    for (const [valid, reason] of [['2026-12-02', 'valid_until_out_of_range'], ['2026-10-31', 'valid_until_out_of_range'], [null, 'valid_until_not_found']] as const) {
      const d = decideExpiry(meta({ valid }), TODAY);
      assert.deepEqual(d, { expiresOn: '2026-11-30', source: 'rule', needsUser: true, reasons: [reason] }, String(valid));
    }
  });

  it('사업자등록증명: 발급일 포함 90일 추정, 사용자 조정 일수 우선', () => {
    const m = extractDocMeta(bizText());
    assert.deepEqual(decideExpiry(m, TODAY), { expiresOn: addDays('2026-10-06', 89), source: 'rule', needsUser: false, reasons: [] });
    assert.equal(decideExpiry(m, TODAY, 30).expiresOn, '2026-11-04');
  });

  it('발급일이 없거나 오늘보다 뒤면 확인 필요. 종류를 모르면 만료일 없음', () => {
    assert.deepEqual(decideExpiry(meta({ issued: null }), TODAY), { expiresOn: '2026-11-30', source: 'document', needsUser: true, reasons: ['issued_on_not_found'] });
    assert.equal(decideExpiry(meta({ issued: '2026-11-11', valid: '2026-11-20' }), TODAY).needsUser, true);
    assert.deepEqual(decideExpiry(meta({ docType: null }), TODAY), { expiresOn: null, source: null, needsUser: true, reasons: ['doc_type_unknown'] });
  });

  it('남은 날은 한국 시간 달력 기준(당일 0, 지나면 음수)', () => {
    assert.equal(kstToday(new Date('2026-11-01T14:59:59Z')), '2026-11-01');
    assert.equal(kstToday(new Date('2026-11-01T15:00:00Z')), '2026-11-02');
    assert.deepEqual([daysLeft('2026-11-30', '2026-11-01'), daysLeft('2026-11-01', '2026-11-01'), daysLeft('2026-10-31', '2026-11-01')], [29, 0, -1]);
  });

  it('입력 길이에 비례하는 시간으로 끝난다(라벨·날짜를 반복해 채운 1MB 텍스트)', () => {
    for (const unit of ['발급번호ㅠ 000-', '유효기간 2026년 11월 1일 ~ ', '2026. 11. 1. ', '세무서장 ', '사업자등록번호 ']) {
      const t = unit.repeat(Math.ceil(1_000_000 / unit.length));
      const started = performance.now();
      extractDocMeta(t);
      const ms = performance.now() - started;
      assert.ok(ms < 2000, `${unit.trim()}: ${Math.round(ms)}ms`);
    }
  });

  it('스키마: 값과 이유가 함께 있거나 형식이 틀린 결과는 막는다', () => {
    const m = extractDocMeta(taxText());
    assert.equal(validateDocMeta({ ...m, kind: 'biz_registration_cert' }), null, '종류와 판별 결과가 다르다');
    assert.equal(validateDocMeta({ ...m, docType: null, kind: 'unknown' }), null, '종류를 못 정했는데 값이 있다');
    const b = extractDocMeta(bizText());
    assert.equal(validateDocMeta({ ...b, validUntil: { value: '2026-12-01', reason: null } }), null, '사업자등록증명에 유효기간 값');
    assert.equal(validateDocMeta({ ...m, issuedOn: { value: null, reason: 'ambiguous', suggested: 'x' } }), null, '날짜 후보가 날짜 형식이 아니다');
    assert.equal(validateDocMeta({ ...m, issuedOn: { value: '2026-11-01', reason: 'ambiguous' } }), null);
    assert.equal(validateDocMeta({ ...m, issuedOn: { value: '2026/11/01', reason: null } }), null);
    assert.equal(validateDocMeta({ ...m, subjectBizNo: { value: null, reason: null } }), null);
    assert.equal(validateDocMeta({ ...m, extra: 1 }), null);
  });
});

describe('docparse 텍스트 정리(샌드박스 모듈)', () => {
  const item = (str: string, x: number, y: number, size = 10, width = str.length * size) => ({ str, transform: [size, 0, 0, size, x, y], width, height: size, hasEOL: false });

  it('같은 줄(글자 크기 절반 안의 y 차이)은 x 순으로 잇고, 벌어진 칸 사이에 공백', () => {
    const lines = itemsToLines([item('2026년 11월 1일', 200, 500.4), item('유효기간', 50, 500), item('납세증명서', 100, 700, 20), item('', 0, 0), { type: 'beginMarkedContent' }]);
    assert.deepEqual(lines, ['납세증명서', '유효기간 2026년 11월 1일']);
  });

  it('제어 문자·공백류 정리, 폭 없는 문자 제거, 빈 줄 제거, NFC', () => {
    assert.equal(tidyText('가\u0001나  다\u3000라\n\n  마\u200b바 \n'), '가 나 다 라\n마바');
    assert.equal(tidyText('2\u200b0\u200b2\u200b6\u200b년'), '2026년');
    assert.equal(tidyText('가'), '가');
  });

  it('텍스트 층 판정: 정상 / 글자 너무 적음 / 깨진 글자 / 이상한 문자', () => {
    const korean = '납세증명서 유효기간 2026년 11월 30일 가나세무서장 직인 사업자등록번호 123-45-67890';
    assert.equal(assessTextLayer(korean, 1).ok, true);
    assert.equal(assessTextLayer('가나', 1).reason, 'too_little_text');
    assert.equal(assessTextLayer(`${korean}${''.repeat(10)}`, 1).reason, 'garbled');
    assert.equal(assessTextLayer('ĀāĂăĄąĆćĈĉĊċČčĎďĐđĒēĔĕĖėĘęĚě'.repeat(2), 1).reason, 'unusual_chars');
  });

  it('OCR 전처리: 음영은 흰색, 긴 선은 지우고, 글자 크기 획은 남긴다', () => {
    const w = 400;
    const h = 200;
    const px = new Uint8ClampedArray(w * h * 4).fill(255);
    const set = (x: number, y: number, v: number) => px.set([v, v, v, 255], (y * w + x) * 4);
    for (let x = 0; x < w; x++) for (let y = 0; y < h; y++) if (y < 40) set(x, y, 230); // 음영 칸
    for (let x = 0; x < w; x++) set(x, 100, 0); // 가로 표 선
    for (let y = 0; y < h; y++) set(300, y, 0); // 세로 표 선
    for (let x = 50; x < 70; x++) for (let y = 120; y < 150; y++) set(x, y, 0); // 글자 획(20×30)
    for (let x = 100; x < 160; x++) for (let y = 120; y < 180; y++) px.set([200, 40, 40, 255], (y * w + x) * 4); // 붉은 직인
    for (let x = 120; x < 130; x++) for (let y = 130; y < 160; y++) set(x, y, 20); // 직인 아래 검은 글자
    cleanForOcr(px, w, h);
    const at = (x: number, y: number) => px[(y * w + x) * 4];
    assert.deepEqual([at(10, 10), at(10, 100), at(300, 10), at(60, 130), at(105, 125), at(125, 140)], [255, 255, 255, 0, 255, 0]);
  });
});
