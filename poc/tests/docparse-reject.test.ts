import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { DocparseError, parse, type DocparseHost } from '@sax/docparse';
import { CANARY, seedCorpus } from '@sax/docparse/fixtures';
import { imageInfo, parseCsvText, readSheetBytes, SandboxError, SHEET_LIMITS, ZIP_LIMITS } from '@sax/docparse/sandbox';

const code = (e: unknown) => (e instanceof SandboxError || e instanceof DocparseError ? e.code : `throw:${(e as Error)?.message}`);

const hostNoDecode: DocparseHost = {
  pdf: () => Promise.reject(new Error('pdf host called')),
  image: () => Promise.reject(new Error('image host called')),
  sheet: async (b) => {
    try {
      return await readSheetBytes(b);
    } catch (e) {
      throw new DocparseError(code(e));
    }
  },
};

describe('퍼징 시드: 표(xlsx·CSV)', () => {
  for (const seed of seedCorpus().filter((s) => s.target === 'sheet')) {
    it(seed.name, async () => {
      const bytes = await seed.bytes();
      if ('reject' in seed.expect) {
        const got = await readSheetBytes(bytes).then(() => 'ok', code);
        const viaParse = await parse(bytes, 'settlement', hostNoDecode).then(() => 'ok', code);
        assert.ok(seed.expect.reject.includes(got) || seed.expect.reject.includes(viaParse), `${got} / ${viaParse}`);
        assert.notEqual(viaParse, 'ok');
      } else {
        const out = await readSheetBytes(bytes);
        const flags = JSON.stringify(out.flags);
        const map: Record<string, boolean> = {
          macros_ignored: out.flags.macros,
          external_links_ignored: out.flags.externalLinks,
          connections_ignored: out.flags.connections,
          embedded_ignored: out.flags.embedded,
          hidden_sheets_skipped: out.flags.hiddenSheets > 0,
          hidden_rows_skipped: out.sheets.some((s) => s.hiddenRows > 0),
          formula_cached_values: out.flags.formulas > 0,
          sheet_truncated: out.flags.truncated,
          formula_like_text: out.flags.formulaLikeText > 0,
        };
        for (const w of seed.expect.ignore) assert.ok(map[w], `${w} ${flags}`);
        const visible = JSON.stringify(out.sheets);
        if (seed.name !== 'csv-formula-injection.csv') assert.ok(!visible.includes(CANARY), '숨기거나 무시할 내용이 출력에 없다');
        assert.ok(!visible.includes('http://127.0.0.1:9') || seed.name === 'csv-formula-injection.csv', '외부 연결 주소를 따라가거나 내지 않는다');
      }
    });
  }
});

describe('퍼징 시드: 그림 머리·크기', () => {
  for (const seed of seedCorpus().filter((s) => s.target === 'image' || s.target === 'any')) {
    it(seed.name, async () => {
      const bytes = await seed.bytes();
      assert.ok('reject' in seed.expect);
      const got = await parse(bytes, 'receipt', hostNoDecode).then(() => 'ok', code);
      assert.ok(seed.expect.reject.includes(got), got);
    });
  }

  it('정상 크기 머리는 통과(폰 48MP 이하), 상한은 50MP·긴 변 12000', () => {
    const png = (w: number, h: number) => {
      const b = new Uint8Array(33);
      b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
      new DataView(b.buffer).setUint32(16, w);
      new DataView(b.buffer).setUint32(20, h);
      return b;
    };
    assert.deepEqual([imageInfo(png(8000, 6000)).width, imageInfo(png(8000, 6000)).height], [8000, 6000]);
    assert.throws(() => imageInfo(png(12001, 10)), (e) => code(e) === 'image_too_large');
  });
});

describe('ZIP 상한은 정상 xlsx의 수십 배', () => {
  it('항목 2000개·한 항목 64MB·합계 160MB·압축률 250', () => {
    assert.deepEqual([ZIP_LIMITS.maxEntries, ZIP_LIMITS.maxEntryBytes / 2 ** 20, ZIP_LIMITS.maxTotalBytes / 2 ** 20, ZIP_LIMITS.maxRatio], [2000, 64, 160, 250]);
  });
});

describe('CSV 칸 길이 상한(CodeSolar #78)', () => {
  it('닫히지 않는 따옴표는 상한×4 글자에서 바로 거부한다(파일 끝까지 쌓지 않음)', () => {
    const big = 'a,"' + 'x'.repeat(5_000_000);
    assert.throws(() => parseCsvText(big), (e: unknown) => e instanceof SandboxError && e.code === 'sheet_too_large');
  });
  it('따옴표 없는 긴 칸은 상한에서 잘리고 더 쌓지 않는다', () => {
    const r = parseCsvText('a,' + 'y'.repeat(2_000_000) + '\nb,c');
    assert.equal(r.truncated, true);
    assert.equal(String(r.rows[0]![1]).length, SHEET_LIMITS.maxCellChars);
    assert.deepEqual(r.rows[1], ['b', 'c']);
  });
});
