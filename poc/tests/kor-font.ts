// 시험 입력(합성 사업자등록증) 렌더링용 한글 글꼴. OS 글꼴 대신 저장소에 넣은 Noto Sans KR 부분 집합만 쓴다(tests/fixtures/fonts/README.md).
// 러너·컨테이너마다 sans-serif가 다른 글꼴로 잡혀(Linux 컨테이너의 WenQuanYi 등) tesseract kor 결과가 흔들렸다("월드컵로"→"월드컴로").
// 글꼴은 data: URL로 페이지에 넣는다(setContent 페이지는 file:// 를 못 읽는다). 이름은 어느 OS에도 없는 것으로 지어 로컬 글꼴이 끼어들지 않게 한다.
import fs from 'node:fs';
import path from 'node:path';
import type { Page } from 'playwright-core';

const DIR = path.join(import.meta.dirname, 'fixtures', 'fonts');
export const KOR_FONT_FAMILY = 'SaxTestKR';

const face = (file: string, weight: number) =>
  `@font-face{font-family:'${KOR_FONT_FAMILY}';font-style:normal;font-weight:${weight};font-display:block;src:url(data:font/woff2;base64,${fs.readFileSync(path.join(DIR, file)).toString('base64')}) format('woff2')}`;

/** <style> 안에 넣을 CSS. body 글꼴을 이 글꼴 하나로 고정하고 굵기 흉내(synthesis)를 끈다. */
export const KOR_FONT_CSS = [
  face('NotoSansKR-Regular.subset.woff2', 400),
  face('NotoSansKR-Bold.subset.woff2', 700),
  `body{font-family:'${KOR_FONT_FAMILY}';font-synthesis:none}`,
].join('\n');

// 부분 집합에 든 글자(README와 같은 규칙): ASCII, 몇 가지 문장 부호, KS X 1001 완성형 한글.
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

/**
 * 글꼴 두 굵기가 실제로 적재됐고 페이지 글자가 모두 부분 집합 안에 있는지 본다. 아니면 던진다
 * (빠진 글자는 Chrome이 OS 글꼴로 조용히 대체해 다시 OS마다 달라지므로, OCR 판정 전에 막는다).
 */
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
