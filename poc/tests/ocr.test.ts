// 사업자등록증 OCR 입력(PoC-5): tesseract.js kor(로컬 언어 데이터, 네트워크 없음) → parseBizCert.
// 앱에서는 같은 tesseract.js가 docparse 샌드박스 렌더러(ADR-014)에서 돈다. 여기서는 Node로 인식 품질과 파서를 본다.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { chromium, type Browser } from 'playwright-core';
import { createWorker, type Worker } from 'tesseract.js';
import { formatBizNo, syntheticBizNo } from '@sax/db';
import { parseBizCert } from '@sax/engine';
import { appendMeasure, measurePath, writeMeasure } from './measure-out.ts';

const require = createRequire(import.meta.url);
const kor = require('@tesseract.js-data/kor') as { langPath: string; gzip: boolean };

function certHtml(f: { bizNo: string; name: string; rep: string; open: string; addr: string; type: string; item: string; corpNo?: string }): string {
  const row = (k: string, v: string) => `<tr><th>${k}</th><td>: ${v}</td></tr>`;
  return `<!doctype html><meta charset="utf-8"><body style="font-family:'Apple SD Gothic Neo','Malgun Gothic',sans-serif;font-size:22px;padding:40px;width:900px;background:#fff">
<h1 style="text-align:center;letter-spacing:12px">사업자등록증</h1>
<p style="text-align:center">(${f.corpNo ? '법인사업자' : '일반과세자'})</p>
<p style="text-align:center">등록번호 : ${formatBizNo(f.bizNo)}</p>
<table style="font-size:22px;border-spacing:0 10px">
${f.corpNo ? row('법인명(단체명)', f.name) : row('상 호', f.name)}
${row('대 표 자', f.rep)}
${row('개 업 연 월 일', f.open)}
${f.corpNo ? row('법인등록번호', f.corpNo) : ''}
${row('사업장 소재지', f.addr)}
<tr><th>사업의 종류</th><td>: 업태 ${f.type} &nbsp;&nbsp; 종목 ${f.item}</td></tr>
${row('교 부 사 유', '신규')}
</table></body>`;
}

// 품질 하한: 세 OS 녹색 기록에서 두 표본 신뢰도는 86~87로 고정이었다(tesseract.js 7.0.0·kor 1.0.0 잠금, 결정적). 67은 한 번 본 깨진 입력(2026-11-07 #215 macOS).
const OCR_CONFIDENCE_FLOOR = 80;

/**
 * 시험 입력 이미지를 안정된 상태로 찍는다(금고 경로 아님). 글꼴 적재(document.fonts.ready)와 두 프레임을 기다린 뒤,
 * 연속 두 장이 바이트까지 같을 때의 이미지를 쓴다. 다섯 번 안에 안 같아지면 실패한다(입력이 흔들리면 OCR 결과로 판정하지 않는다).
 */
async function renderStable(browser: Browser, html: string): Promise<Buffer> {
  const page = await browser.newPage({ viewport: { width: 1000, height: 800 }, deviceScaleFactor: 2 });
  try {
    await page.setContent(html, { waitUntil: 'load' });
    await page.evaluate(async () => {
      await document.fonts.ready;
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    });
    let prev = await page.screenshot({ fullPage: true });
    for (let i = 0; i < 5; i++) {
      const cur = await page.screenshot({ fullPage: true });
      if (cur.equals(prev)) return cur;
      prev = cur;
    }
    throw new Error('시험 입력 이미지가 안정되지 않음(연속 스크린샷이 계속 다름)');
  } finally {
    await page.close();
  }
}

describe('사업자등록증 OCR', () => {
  let browser: Browser;
  let worker: Worker;
  let cache: string;

  before(async () => {
    // 테스트 이미지 생성용 렌더러(금고 경로 아님).
    browser = await chromium.launch({ channel: 'chrome', headless: true });
    cache = await fs.mkdtemp(path.join(os.tmpdir(), 'sax-ocr-'));
    worker = await createWorker('kor', 1, { langPath: kor.langPath, gzip: kor.gzip, cachePath: cache });
  });

  after(async () => {
    await worker?.terminate();
    await browser?.close();
    await fs.rm(cache, { recursive: true, force: true });
  });

  it('파서: OCR 공백·혼동 문자가 섞인 텍스트', () => {
    const b = syntheticBizNo(3);
    const noisy = `사 업 자 등 록 증\n( 법 인 사 업 자 )\n등 록 번 호 : ${b.slice(0, 3)} - ${b.slice(3, 5)} - ${b.slice(5).replace('0', 'O')}\n법 인 명 ( 단 체 명 ) : 주식회사 가나다\n대 표 자 : 홍 길 동\n개 업 연 월 일 : 2019 년 3 월 7 일\n법 인 등 록 번 호 : 110111-1234567\n사 업 장 소 재 지 : 서울특별시 강남구 테헤란로 1\n사 업 의 종 류 : 업 태 서비스 종 목 소프트웨어 개발\n`;
    const r = parseBizCert(noisy);
    assert.equal(r.fields.bizNo, b);
    assert.equal(r.bizNoChecksumOk, true);
    assert.equal(r.fields.name, '주식회사 가나다');
    assert.equal(r.fields.repName, '홍길동');
    assert.equal(r.fields.openDate, '20190307');
    assert.equal(r.fields.corpNo, '1101111234567');
    assert.equal(r.fields.kind, 'corporate');
    assert.equal(r.fields.bizType, '서비스');
    assert.equal(r.fields.bizItem, '소프트웨어 개발');
    assert.deepEqual(r.missing, []);
    assert.equal(parseBizCert('등록번호 : 190-08-71096').bizNoSuggestions.includes('1000871096'), true);
  });

  for (const sample of [
    { bizNo: syntheticBizNo(11), name: '가나상사', rep: '이가나', open: '2020 년 01 월 15 일', addr: '서울특별시 마포구 월드컵로 10', type: '도소매', item: '사무용품' },
    { bizNo: syntheticBizNo(12), name: '주식회사 다라테크', rep: '박다라', open: '2018 년 11 월 02 일', addr: '경기도 성남시 분당구 판교로 20', type: '서비스', item: '소프트웨어 개발', corpNo: '131111-0012345' },
  ]) {
    it(`렌더링된 등록증 이미지 → tesseract kor → 필드(${sample.name})`, async () => {
      const png = await renderStable(browser, certHtml(sample));
      const started = Date.now();
      const { data } = await worker.recognize(png);
      const ms = Date.now() - started;
      const r = parseBizCert(data.text);
      await appendMeasure('ocr-samples.jsonl', { sample: sample.name, ms, confidence: data.confidence, fields: r.fields, missing: r.missing });
      // 실패하면 입력 이미지와 OCR 원문을 측정 폴더에 남긴다(CI macOS는 test-summary-macos 아티팩트로 올라간다). 흔들림을 다음에 바로 볼 수 있게.
      const keep = async () => {
        const txt = await writeMeasure(`ocr-fail/${sample.bizNo}.txt`, `confidence ${data.confidence}\n${data.text}`);
        await fs.writeFile(measurePath(`ocr-fail/${sample.bizNo}.png`), png);
        console.error(`OCR 실패 입력·원문: ${path.dirname(txt)}`);
      };
      try {
        // 제품 판정(항상 성립): 틀리게 읽은 등록번호는 체크섬을 통과하지 않는다. 못 읽은 필수 필드는 missing에 나온다(조용히 비우지 않는다).
        if (r.fields.bizNo !== sample.bizNo) assert.equal(r.bizNoChecksumOk, false, `wrong bizNo passed checksum:\n${data.text}`);
        for (const k of ['bizNo', 'name', 'repName', 'openDate'] as const) if (r.fields[k] === null) assert.ok(r.missing.includes(k), `${k} 못 읽었는데 missing에 없음`);
        // OCR 품질 하한(이 깨끗한 합성 이미지에서): 신뢰도 ≥ OCR_CONFIDENCE_FLOOR, 등록번호는 그대로 읽거나 후보에 정답이 있다(사용자 확인 후 저장), 나머지 필드는 정답.
        // 이 하한 아래면 파서가 아니라 입력·인식 쪽 문제다. 메시지가 그 둘을 가른다.
        assert.ok(data.confidence >= OCR_CONFIDENCE_FLOOR, `OCR 품질 하한 미달: 신뢰도 ${data.confidence} < ${OCR_CONFIDENCE_FLOOR}(입력 이미지·인식 문제, 원문은 measure/ocr-fail)\n${data.text}`);
        if (r.fields.bizNo !== sample.bizNo) assert.ok(r.bizNoSuggestions.includes(sample.bizNo), `suggestions ${r.bizNoSuggestions} lack ${sample.bizNo}`);
        assert.equal(r.fields.repName, sample.rep);
        assert.equal(r.fields.name?.replace(/\s/g, ''), sample.name.replace(/\s/g, ''), `name: ${r.fields.name}`);
        assert.equal(r.fields.address?.replace(/\s/g, ''), sample.addr.replace(/\s/g, ''));
        assert.equal(r.fields.openDate, sample.open.replace(/\D/g, ''));
      } catch (e) {
        await keep();
        throw e;
      }
    });
  }
});
