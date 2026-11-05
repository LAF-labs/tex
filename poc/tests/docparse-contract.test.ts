// @sax/docparse 공개 계약(Electron 없음): parse(bytes, kind, host) → 스키마 통과 결과, 샌드박스 출력 검증, 수동 입력 폴백, 보관 이름.
// host는 가짜(샌드박스가 낼 모양을 그대로 돌려준다). 실제 샌드박스 host는 apps/desktop/src/docparse.ts의 sandboxHost(e2e).
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { checkManual, DocparseError, parse, parseOutcomeErrors, shortId, storedFileName, validateParseOutcome, validateSandboxOutput, type DocparseHost, type ImageOcr, type PdfExtract } from '@sax/docparse';
import { deliveryXlsx, fakeBizNo, healthNoticeXlsx, receiptText, syntheticReceipts } from '@sax/docparse/fixtures';
import { readSheetBytes } from '@sax/docparse/sandbox';

const TODAY = '2026-11-05';
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x03, 0x20, 0x02, 0x58, 0x03, 0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01, 0xff, 0xd9]);
const PDF = new TextEncoder().encode('%PDF-1.4\n%fake\n');

function host(o: { pdf?: Partial<PdfExtract>; image?: Partial<ImageOcr>; calls?: string[] } = {}): DocparseHost {
  return {
    pdf: async (_b, opts) => {
      o.calls?.push(`pdf:${opts.forceOcr}`);
      return { text: '', pages: 1, totalPages: 1, hasTextLayer: true, scanned: false, ocrConfidence: null, timing: { loadMs: 1, textMs: 1, ocrMs: 0 }, ...o.pdf };
    },
    image: async (_b, opts) => {
      o.calls?.push(`image:${opts.mode}`);
      return { text: '', confidence: 80, lines: [], width: 600, height: 800, exif: false, ...o.image };
    },
    sheet: (b) => readSheetBytes(b),
  };
}

describe('parse(bytes, kind) 계약', () => {
  it('종이 증빙 사진(JPEG, 폰 사진도 같은 길): photo 모드 OCR → 규칙 → 스키마 통과', async () => {
    const r = syntheticReceipts()[0]!;
    const calls: string[] = [];
    const out = await parse(JPEG, 'receipt', host({ image: { text: receiptText(r), confidence: 88 }, calls }), { today: TODAY });
    assert.deepEqual(calls, ['image:photo']);
    assert.equal(out.schema, 'sax.docparse/v1');
    assert.equal(out.kind, 'receipt');
    assert.ok(out.result.extractor === 'receipt-v1');
    assert.equal(out.result.amount.value, r.expected.amount);
    assert.deepEqual(out.source, { format: 'jpeg', textLayer: null, ocr: true, ocrConfidence: 88, pages: null, image: { width: 600, height: 800 } });
    assert.ok(out.warnings.includes('ocr_used'));
    assert.equal(out.needsManual, false);
    assert.ok(out.confidence > 0.6);
  });

  it('EXIF가 남은 PC 사진은 exif_present 경고, OCR 신뢰도가 낮으면 low_ocr_confidence·needsManual', async () => {
    const out = await parse(JPEG, 'receipt', host({ image: { text: '흐릿한 글자', confidence: 31, exif: true } }), { today: TODAY });
    assert.ok(out.warnings.includes('exif_present') && out.warnings.includes('low_ocr_confidence'));
    assert.equal(out.needsManual, true);
  });

  it('증명서 PDF: 텍스트 층에서 핵심 칸을 못 뽑으면 OCR로 한 번 더(engine/docmeta 규칙 재사용)', async () => {
    const calls: string[] = [];
    const out = await parse(PDF, 'certificate', host({ pdf: { text: '납세증명서\n세무서장\n' + 'x'.repeat(40) }, calls }), { today: TODAY });
    assert.deepEqual(calls, ['pdf:false', 'pdf:true']);
    assert.equal(out.kind, 'certificate');
    assert.ok('docType' in out.result);
    assert.equal(out.needsManual, true);
  });

  it('정산 엑셀·고지내역: 표 → 규칙, 추정 형식 경고', async () => {
    const s = await parse(await deliveryXlsx().bytes, 'settlement', host(), { expectedChannel: 'delivery' });
    assert.equal(s.source.format, 'xlsx');
    assert.ok(s.warnings.includes('format_estimated') && s.warnings.includes('formula_cached_values'));
    const n = await parse(await healthNoticeXlsx().bytes, 'insurance_notice', host());
    assert.ok(n.result.extractor === 'insurance-notice-v1' && n.result.rows.length === 6);
  });

  it('칸과 형식이 안 맞으면 wrong_kind, 알아본 거부 형식은 unsupported_format(+형식 이름), 표를 못 알아보면 format_not_recognized', async () => {
    const err = (p: Promise<unknown>) => p.then(() => 'ok', (e: DocparseError) => `${e.code}${e.detail ? `:${e.detail}` : ''}`);
    assert.equal(await err(parse(await deliveryXlsx().bytes, 'receipt', host())), 'wrong_kind:xlsx');
    assert.equal(await err(parse(JPEG, 'settlement', host())), 'wrong_kind:jpeg');
    assert.equal(await err(parse(new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0]), 'settlement', host())), 'unsupported_format:xls_or_encrypted_ooxml');
    assert.equal(await err(parse(new TextEncoder().encode('메모\n아무것도'), 'settlement', host())), 'format_not_recognized');
  });

  it('host가 스키마 밖 값을 내면 schema로 끝낸다(샌드박스 출력은 믿지 않는다)', async () => {
    const bad: DocparseHost = { ...host(), image: async () => ({ text: 'x', confidence: 80, lines: [], width: 1, height: 1, exif: false, extra: 'leak' }) as unknown as ImageOcr };
    await assert.rejects(parse(JPEG, 'receipt', bad, { today: TODAY }), (e: DocparseError) => e.code === 'schema');
    const big: DocparseHost = { ...host(), pdf: async () => ({ text: 'x'.repeat(2 * 1024 * 1024), pages: 1, totalPages: 1, hasTextLayer: true, scanned: false, ocrConfidence: null, timing: { loadMs: 1, textMs: 1, ocrMs: 0 } }) };
    await assert.rejects(parse(PDF, 'receipt', big, { today: TODAY }), (e: DocparseError) => e.code === 'schema');
  });
});

describe('스키마', () => {
  it('샌드박스 출력: 오류 코드 목록 밖·추가 필드·쪽수 초과는 통과하지 않는다', () => {
    assert.ok(validateSandboxOutput('error', { error: 'zip_bomb' }));
    assert.equal(validateSandboxOutput('error', { error: 'something_else' }), null);
    assert.equal(validateSandboxOutput('pdf', { text: '', pages: 6, totalPages: 6, hasTextLayer: false, scanned: false, ocrConfidence: null, timing: { loadMs: 0, textMs: 0, ocrMs: 0 } }), null);
  });

  it('결과: 값이 있으면 이유가 없고, 값이 없으면 신뢰도 0·이유가 있다(판정 필드는 둘 곳이 없다)', async () => {
    const r = syntheticReceipts()[1]!;
    const out = await parse(JPEG, 'receipt', host({ image: { text: receiptText(r) } }), { today: TODAY });
    const tampered = structuredClone(out) as unknown as { result: Record<string, unknown> };
    tampered.result.deductible = true;
    assert.ok(parseOutcomeErrors(tampered).includes('/result:additionalProperties'));
    const t2 = structuredClone(out) as unknown as { result: { amount: { value: null; confidence: number; reason: null } } };
    t2.result.amount = { value: null, confidence: 0.5, reason: null };
    assert.equal(validateParseOutcome(t2), null);
  });
});

describe('수동 입력 폴백·보관 이름', () => {
  it('영수증 수동 입력: 날짜·금액·사업자번호 체크섬, 공백 정리', () => {
    const biz = fakeBizNo(5);
    assert.deepEqual(checkManual({ kind: 'receipt', issuedOn: '2026-10-31', merchant: '  가상   상점 ', merchantBizNo: `${biz.slice(0, 3)}-${biz.slice(3, 5)}-${biz.slice(5)}`, amount: 12000 }), { ok: true, value: { kind: 'receipt', issuedOn: '2026-10-31', merchant: '가상 상점', merchantBizNo: biz, amount: 12000 } });
    const bad = checkManual({ kind: 'receipt', issuedOn: '2026-02-30', merchant: '', merchantBizNo: '1234567890', amount: -1 });
    assert.deepEqual(bad, { ok: false, errors: ['issued_on', 'merchant', 'biz_no', 'amount'] });
    assert.deepEqual(checkManual({ kind: 'certificate', issuedOn: '2026-11-01', validUntil: '2026-10-01' }), { ok: false, errors: ['valid_until'] });
    assert.deepEqual(checkManual({ kind: 'nope' }), { ok: false, errors: ['kind'] });
  });

  it('보관 이름 {docType}_{yyyyMMdd}_{shortId}.{ext}: PII 없음, 허용 글자만', () => {
    let k = 0;
    const id = shortId(() => [0.01, 0.5, 0.99, 0.3][k++]!);
    assert.equal(id, '0GZ9');
    assert.equal(storedFileName({ docType: 'paper_receipt', date: '2026-10-31', shortId: id, format: 'jpeg' }), 'paper_receipt_20261031_0GZ9.jpg');
    assert.equal(storedFileName({ docType: 'insurance_notice', date: '2026-10-01', shortId: 'AB12', format: 'xlsx' }), 'insurance_notice_20261001_AB12.xlsx');
    assert.throws(() => storedFileName({ docType: '가나다식당', date: '2026-10-31', shortId: id, format: 'jpeg' }));
    assert.throws(() => storedFileName({ docType: 'paper_receipt', date: '2026-10-31', shortId: 'IL0U', format: 'jpeg' }));
  });
});
