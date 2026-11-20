import fs from 'node:fs';
import path from 'node:path';
import type { Page } from 'playwright-core';

const DIR = path.join(import.meta.dirname, 'fixtures', 'fonts');
export const KOR_FONT_FAMILY = 'SaxTestKR';

const face = (file: string, weight: number) =>
  `@font-face{font-family:'${KOR_FONT_FAMILY}';font-style:normal;font-weight:${weight};font-display:block;src:url(data:font/woff2;base64,${fs.readFileSync(path.join(DIR, file)).toString('base64')}) format('woff2')}`;

export const KOR_FONT_CSS = [
  face('NotoSansKR-Regular.subset.woff2', 400),
  face('NotoSansKR-Bold.subset.woff2', 700),
  `body{font-family:'${KOR_FONT_FAMILY}';font-synthesis:none}`,
].join('\n');

const COVERED = new Set<number>([...Array.from({ length: 0x7f - 0x20 }, (_, i) => 0x20 + i), 0xa0, 0xb7, 0x2010, 0x2013, 0x2014, 0x2018, 0x2019, 0x201c, 0x201d, 0x2026, 0x203b, 0x3000, 0x3001, 0x3002]);
{
  const dec = new TextDecoder('euc-kr', { fatal: true });
  for (let hi = 0xb0; hi <= 0xc8; hi++)
    for (let lo = 0xa1; lo <= 0xfe; lo++) {
      try {
        COVERED.add(dec.decode(new Uint8Array([hi, lo])).codePointAt(0)!);
      } catch {
        /* 빈 칸 */
      }
    }
}

export async function assertKorFont(page: Page): Promise<void> {
  const { loaded, text } = await page.evaluate(async (family) => {
    await Promise.all([document.fonts.load(`400 20px '${family}'`, '가'), document.fonts.load(`700 20px '${family}'`, '가')]);
    await document.fonts.ready;
    return { loaded: document.fonts.check(`400 20px '${family}'`, '가') && document.fonts.check(`700 20px '${family}'`, '가'), text: document.body.innerText };
  }, KOR_FONT_FAMILY);
  if (!loaded) throw new Error(`시험 글꼴 ${KOR_FONT_FAMILY}가 적재되지 않음(tests/fixtures/fonts)`);
  const missing = [...new Set([...text.replace(/\s/g, '')])].filter((ch) => !COVERED.has(ch.codePointAt(0)!));
  if (missing.length) throw new Error(`시험 글꼴에 없는 글자: ${missing.join(' ')} (tests/fixtures/fonts/README.md대로 부분 집합을 다시 만든다)`);
}
