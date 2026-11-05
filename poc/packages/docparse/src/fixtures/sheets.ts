// 합성 정산내역·4대보험 고지내역(가짜 이름·가짜 금액). 칸 이름은 settlement.ts·insurance.ts의 "추정" 규칙과 같은 출처(공개 안내의 칸 이름)다.
import { encodeEucKr, writeXlsx, type FixtureCell } from './zipwrite.ts';

export interface SettlementFixture {
  name: string;
  bytes: Promise<Uint8Array>;
  expected: { channel: 'delivery' | 'market'; platform: string | null; rows: number; gross: number; fees: number; payout: number; from: string; to: string };
}

const days = (n: number, start = '2026-10-01') => Array.from({ length: n }, (_, i) => new Date(Date.parse(`${start}T00:00:00Z`) + i * 86400000).toISOString().slice(0, 10));

/** 배달앱 형식(추정): 제목 줄 + 머리글 + 날짜별 줄 + 합계 줄, 수수료 칸 셋 */
export function deliveryXlsx(): SettlementFixture {
  const ds = days(10);
  const rows: FixtureCell[][] = [['배달의민족 정산내역 (가상 가게)'], ['조회기간', '2026-10-01 ~ 2026-10-10'], [], ['정산기준일', '주문건수', '주문금액', '중개수수료', '결제수수료', '배달비', '정산금액']];
  let g = 0;
  let f = 0;
  let p = 0;
  ds.forEach((d, i) => {
    const gross = 300000 + i * 12500;
    const fee1 = Math.round(gross * 0.068);
    const fee2 = Math.round(gross * 0.03);
    const fee3 = 3000 * (5 + (i % 4));
    const pay = gross - fee1 - fee2 - fee3;
    g += gross;
    f += fee1 + fee2 + fee3;
    p += pay;
    rows.push([{ date: d }, 10 + i, gross, -fee1, -fee2, -fee3, pay]);
  });
  rows.push(['합계', null, { f: 'SUM(C5:C14)', v: g }, null, null, null, { f: 'SUM(G5:G14)', v: p }]);
  return { name: 'delivery.xlsx', bytes: writeXlsx([{ name: '정산내역', rows }]), expected: { channel: 'delivery', platform: 'baemin', rows: 10, gross: g, fees: f, payout: p, from: ds[0]!, to: ds[9]! } };
}

/** 오픈마켓 형식(추정): 주문 단위 줄, 날짜가 글자, 판매수수료 하나, CSV(EUC-KR) */
export function marketCsv(): SettlementFixture {
  const header = ['상품주문번호', '구매확정일', '상품명', '판매금액', '판매수수료', '정산예정금액'];
  const lines = [header.join(',')];
  let g = 0;
  let f = 0;
  let p = 0;
  const ds = days(12, '2026-10-03');
  ds.forEach((d, i) => {
    const gross = 15000 + i * 1300;
    const fee = Math.round(gross * 0.055);
    g += gross;
    f += fee;
    p += gross - fee;
    lines.push([`20261003${String(1000 + i)}`, d.replaceAll('-', '.'), `"가상상품 ${i + 1}, 1개"`, `"${gross.toLocaleString('en-US')}"`, String(fee), String(gross - fee)].join(','));
  });
  lines.unshift('스마트스토어 정산 내역 (합성)');
  return { name: 'market.csv', bytes: Promise.resolve(encodeEucKr(lines.join('\r\n'))), expected: { channel: 'market', platform: 'smartstore', rows: 12, gross: g, fees: f, payout: p, from: ds[0]!, to: ds[11]! } };
}

export interface InsuranceFixture {
  name: string;
  bytes: Promise<Uint8Array>;
  expected: { month: string; rows: Array<{ name: string; birthDate: string; insurance: string; employee: number; employer: number; total: number }> };
}

/** 건강보험 고지내역 형식(추정): 두 줄 머리글(위: 건강·장기요양, 아래: 근로자·사업자 부담), 가린 주민번호 */
export function healthNoticeXlsx(): InsuranceFixture {
  const people = [
    { name: '김가상', rrn: '900101-1******', birth: '1990-01-01', base: 3000000 },
    { name: '이테스트', rrn: '010315-4******', birth: '2001-03-15', base: 2500000 },
    { name: '박합성', rrn: '850720-2123456', birth: '1985-07-20', base: 4200000 }, // 전체 번호(가짜) → 앞 7자리만 남아야 한다
  ];
  const rows: FixtureCell[][] = [['건강보험 사업장 가입자별 고지내역'], ['고지년월', '2026년 10월', '사업장명', '가상상사'], [], ['성명', '주민등록번호', '보수월액', '건강보험', null, null, '장기요양', null, null], [null, null, null, '산출보험료', '근로자부담', '사업자부담', '산출보험료', '근로자부담', '사업자부담']];
  const expected: InsuranceFixture['expected']['rows'] = [];
  for (const p of people) {
    const h = Math.floor((p.base * 0.0719) / 10) * 10;
    const he = Math.floor(h / 2 / 10) * 10;
    const l = Math.floor((h * 0.1314) / 10) * 10;
    const le = Math.floor(l / 2 / 10) * 10;
    rows.push([p.name, p.rrn, p.base, h, he, h - he, l, le, l - le]);
    expected.push({ name: p.name, birthDate: p.birth, insurance: 'health', employee: he, employer: h - he, total: h }, { name: p.name, birthDate: p.birth, insurance: 'ltc', employee: le, employer: l - le, total: l });
  }
  rows.push(['합계', null, null, null, null, null, null, null, null]);
  return { name: 'health-notice.xlsx', bytes: writeXlsx([{ name: '고지내역', rows }]), expected: { month: '2026-10', rows: expected } };
}

/** 국민연금 결정내역 형식(추정, CSV UTF-8 BOM): 한 줄 머리글, 보험 이름은 제목에만 */
export function pensionNoticeCsv(): InsuranceFixture {
  const people = [
    { name: '김가상', rrn: '900101-1******', birth: '1990-01-01', base: 3000000 },
    { name: '최모의', rrn: '920202-2******', birth: '1992-02-02', base: 2800000 },
  ];
  const lines = ['국민연금 사업장 가입자 결정내역,,,,', '귀속년월: 2026.10,,,,', '성명,주민등록번호,기준소득월액,월보험료,근로자부담금,사용자부담금'];
  const expected: InsuranceFixture['expected']['rows'] = [];
  for (const p of people) {
    const t = Math.floor((p.base * 0.095) / 10) * 10;
    const e = t / 2;
    lines.push([p.name, p.rrn, p.base, t, e, t - e].join(','));
    expected.push({ name: p.name, birthDate: p.birth, insurance: 'pension', employee: e, employer: t - e, total: t });
  }
  const body = new TextEncoder().encode(lines.join('\n'));
  const bytes = new Uint8Array(body.length + 3);
  bytes.set([0xef, 0xbb, 0xbf]);
  bytes.set(body, 3);
  return { name: 'pension-notice.csv', bytes: Promise.resolve(bytes), expected: { month: '2026-10', rows: expected } };
}
