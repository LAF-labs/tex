// M6-5 파일 넣기 파서(Electron 없음): xlsx·CSV 읽기(샌드박스 모듈을 Node에서 직접), 정산(J-01·J-02)·4대보험 고지내역(S-06) 규칙.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseInsuranceNotice, parseSettlement } from '@sax/docparse';
import { deliveryXlsx, healthNoticeXlsx, marketCsv, pensionNoticeCsv, writeXlsx } from '@sax/docparse/fixtures';
import { cellRef, decodeText, excelSerialToIso, isDateFormatCode, parseCsvText, readSheetBytes } from '@sax/docparse/sandbox';

describe('xlsx·CSV 읽기(샌드박스 모듈)', () => {
  it('공유 문자열·숫자·날짜 서식·수식 저장값·숨김 행', async () => {
    const bytes = await writeXlsx([{ name: '시트1', rows: [['이름', '금액', '날짜'], ['가', 1000, { date: '2026-10-31' }], ['나', { f: 'B2*2', v: 2000 }, null], ['숨김', 1, 1]], hiddenRows: [3] }]);
    const out = await readSheetBytes(bytes);
    assert.equal(out.format, 'xlsx');
    assert.deepEqual(out.sheets[0]!.rows, [['이름', '금액', '날짜'], ['가', 1000, '2026-10-31'], ['나', 2000]]);
    assert.equal(out.sheets[0]!.hiddenRows, 1);
    assert.equal(out.flags.formulas, 1);
  });

  it('날짜 일련번호·서식 코드·칸 주소', () => {
    assert.equal(excelSerialToIso(46326), '2026-10-31');
    assert.equal(excelSerialToIso(46326.5), '2026-10-31 12:00');
    assert.equal(excelSerialToIso(0), null);
    assert.ok(isDateFormatCode('yyyy-mm-dd'));
    assert.ok(isDateFormatCode('[$-412]yyyy"년" m"월" d"일"'));
    assert.ok(!isDateFormatCode('#,##0"원"'));
    assert.ok(!isDateFormatCode('[Red]#,##0'));
    assert.deepEqual(cellRef('AB12'), [27, 11]);
  });

  it('CSV: 따옴표 칸·쉼표 금액·탭 구분, UTF-8 BOM·EUC-KR', async () => {
    assert.deepEqual(parseCsvText('a,"1,000","x ""q"""\n b ,,c\r\n').rows, [['a', '1,000', 'x "q"'], ['b', null, 'c']]);
    assert.deepEqual(parseCsvText('a\tb\n1\t2').rows, [['a', 'b'], ['1', '2']]);
    const m = await marketCsv().bytes;
    assert.equal(decodeText(m).encoding, 'euc-kr');
    assert.ok(decodeText(m).text.includes('스마트스토어'));
    assert.equal(decodeText(await pensionNoticeCsv().bytes).encoding, 'utf-8');
  });
});

describe('정산내역 규칙(J-01·J-02, 추정 형식)', () => {
  for (const fx of [deliveryXlsx(), marketCsv()]) {
    it(`${fx.name}: 줄 수·합계·기간·경로, 추정 표시`, async () => {
      const sheet = await readSheetBytes(await fx.bytes);
      const { result, warnings, confidence } = parseSettlement(sheet, fx.expected.channel);
      assert.ok(result);
      assert.equal(result.rows.length, fx.expected.rows);
      assert.deepEqual([result.totals.gross, result.totals.fees, result.totals.payout], [fx.expected.gross, fx.expected.fees, fx.expected.payout]);
      assert.deepEqual(result.period, { from: fx.expected.from, to: fx.expected.to });
      assert.equal(result.channel.value, fx.expected.channel);
      assert.equal(result.platform.value, fx.expected.platform);
      assert.equal(result.estimated, true);
      assert.ok(warnings.includes('format_estimated'));
      assert.ok(confidence > 0.5 && confidence <= 0.85, String(confidence));
      assert.ok(!warnings.includes('total_mismatch'), warnings.join(','));
    });
  }

  it('파일 합계 줄은 줄에서 빼고 비교만, 다르면 total_mismatch(값은 우리가 더한 것)', async () => {
    const fx = deliveryXlsx();
    const sheet = await readSheetBytes(await fx.bytes);
    assert.ok(parseSettlement(sheet).result!.fileTotals);
    const last = sheet.sheets[0]!.rows.at(-1)!;
    last[2] = 1;
    const p = parseSettlement(sheet);
    assert.ok(p.warnings.includes('total_mismatch'));
    assert.equal(p.result!.totals.gross, fx.expected.gross);
  });

  it('꾸러미 항목(배달)과 파일(오픈마켓)이 다르면 channel_mismatch 경고, 머리글이 없으면 결과 없음', async () => {
    const sheet = await readSheetBytes(await marketCsv().bytes);
    assert.ok(parseSettlement(sheet, 'delivery').warnings.includes('channel_mismatch'));
    const junk = await readSheetBytes(await writeXlsx([{ name: 'x', rows: [['메모'], ['아무 내용']] }]));
    const none = parseSettlement(junk);
    assert.equal(none.result, null);
    assert.ok(none.warnings.includes('header_not_found'));
  });
});

describe('4대보험 고지내역 규칙(S-06, 추정 형식)', () => {
  for (const fx of [healthNoticeXlsx(), pensionNoticeCsv()]) {
    it(`${fx.name}: 직원별·보험별 줄, 고지 년월, 주민번호는 앞 7자리만`, async () => {
      const { result, warnings } = parseInsuranceNotice(await readSheetBytes(await fx.bytes));
      assert.ok(result, warnings.join(','));
      assert.equal(result.month.value, fx.expected.month);
      const got = result.rows.map((r) => ({ name: r.name, birthDate: r.birthDate, insurance: r.insurance, employee: r.employee, employer: r.employer, total: r.total }));
      assert.deepEqual(got, fx.expected.rows);
      for (const r of result.rows) {
        assert.match(r.rrnFront7 ?? '', /^\d{7}$/);
        assert.ok(new Set(result.rows.map((x) => x.rowId)).size === result.rows.length);
      }
      assert.ok(!JSON.stringify(result).includes('123456'), '주민번호 뒷자리가 결과에 없다');
      assert.equal(result.estimated, true);
    });
  }

  it('전체 주민번호가 있으면 rrn_full_masked 경고, 기준소득·보수월액은 보험 이름 없는 칸이면 모든 보험에', async () => {
    const { result, warnings } = parseInsuranceNotice(await readSheetBytes(await healthNoticeXlsx().bytes));
    assert.ok(warnings.includes('rrn_full_masked'));
    assert.ok(result!.rows.every((r) => r.base !== null));
    assert.deepEqual(result!.insurances.sort(), ['health', 'ltc']);
  });
});
