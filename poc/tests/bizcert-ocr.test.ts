// 사업자등록증 그림 → 칸 6개(2026-11-10 설치본 "대표자가 안 들어간다", 로그 blanks 4). 견본은 국세청 양식을 본뜬 합성 그림(가상 값, bizcert-synth.ts).
// 경로는 제품과 같다: 그림 → 샌드박스와 같은 전처리·tesseract kor → 엔진 parseBizCert → readBizCert(bizFieldsOf) → 온보딩·거래처 칸.
// 원인(재현): ① 폰 촬영 JPEG는 종이가 회색이라 고정 임계 흑백(cleanForOcr)이 그늘진 아래쪽을 통째로 검게 만들어 대표자·주소·업태·종목이 비었다.
// ② 개인 양식 "성명 : 이가나 생년월일 : …" 한 줄에서 대표자가 "이가나생년"으로 잘못 채워졌다(파서). ③ 흑백 자르기가 등록번호 "100"을 "190"으로 읽게 했다.
// 판정(세 OS 같은 규칙): 칸 뽑기가 맞았는가를 본다. 채운 칸은 정답과 편집 거리 ≤ max(1, 길이/8)(OS 글꼴에 따른 낱글자 오인식 "박다라→박하라"·"2층→2 증"은 OCR 몫,
// 다른 칸이 섞인 "이가나생년"은 걸린다), 체크섬 맞는 번호는 정답과 같다, 6칸 중 5칸 이상 채운다. macOS(실측 기준 글꼴)는 6칸 모두 정답.
// 2026-11-10 #265 첫 CI: Linux 70/72·Windows 66/72·macOS 72/72 정확 일치, 틀린 칸은 모두 낱글자 하나.
// CI는 견본을 줄인다(깨끗한 PNG·그늘진 촬영 JPEG·흐린 것): tesseract가 CPU를 많이 써 러너가 느려진다. 로컬은 전부 돈다.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { chromium, type Browser } from 'playwright-core';
import { createWorker, type Worker } from 'tesseract.js';
import { isValidBizNo, syntheticBizNo } from '@sax/db';
import { cleanDocumentForOcr, DOCUMENT_PHOTO_INK_SHARE, ocrScale } from '@sax/docparse/sandbox';
import { parseBizCert } from '@sax/engine';
import { readBizCert } from '../apps/desktop/src/bizcert-read.ts';
import type { BizFields } from '../apps/desktop/src/onboarding.ts';
import { certHtml, KOR, renderCert, sandboxLikeOcr, type CertSample, type Variant } from './bizcert-synth.ts';
import { appendMeasure, measurePath, writeMeasure } from './measure-out.ts';

const SAMPLES: CertSample[] = [
  { kind: 'individual', bizNo: syntheticBizNo(21), name: '가나상사', rep: '이가나', birth: '1985 년 03 월 12 일', open: '2020 년 01 월 15 일', addr: '서울특별시 마포구 월드컵로 10, 2층', types: ['도매 및 소매업', '서비스업'], items: ['전자상거래 소매업', '소프트웨어 개발'] },
  { kind: 'corporate', bizNo: syntheticBizNo(22), name: '주식회사 다라테크', rep: '박다라', open: '2018 년 11 월 02 일', corpNo: '131111-0012345', addr: '경기도 성남시 분당구 판교로 20', hq: '경기도 성남시 분당구 판교로 20', types: ['서비스'], items: ['소프트웨어 개발 및 공급'] },
];
const ALL_VARIANTS: Array<[Variant, 'png' | 'jpeg']> = [
  ['clean', 'png'],
  ['scan', 'jpeg'],
  ['photo', 'jpeg'],
  ['photo-mild', 'jpeg'],
  ['photo-mild', 'png'],
  ['small', 'jpeg'],
];
const VARIANTS = process.env.CI ? ALL_VARIANTS.filter(([v, f]) => (v === 'clean' && f === 'png') || (v === 'photo-mild' && f === 'jpeg')) : ALL_VARIANTS;
const KEYS = ['name', 'bizNo', 'rep', 'address', 'bizType', 'bizItem'] as const;
const expected = (s: CertSample): Record<(typeof KEYS)[number], string> => ({ name: s.name, bizNo: s.bizNo, rep: s.rep, address: s.addr, bizType: s.types[0]!, bizItem: s.items[0]! });
const squash = (a: string) => a.replace(/\s/g, '');
const same = (a: string, b: string) => squash(a) === squash(b);
/** 편집 거리(공백 무시) */
function editDistance(x: string, y: string): number {
  const a = [...squash(x)];
  const b = [...squash(y)];
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[b.length]!;
}
/** 같은 칸을 뽑았다(낱글자 오인식만 허용) */
const close = (got: string, exp: string) => editDistance(got, exp) <= Math.max(1, Math.floor(squash(exp).length / 8));
const MEASURED_OS = process.platform === 'darwin';

describe('사업자등록증 합성 그림 → 칸 6개(샌드박스 전처리·tesseract kor·parseBizCert·readBizCert)', () => {
  let browser: Browser;
  let worker: Worker;
  let cache: string;

  before(async () => {
    browser = await chromium.launch({ channel: 'chrome', headless: true });
    cache = await fs.mkdtemp(path.join(os.tmpdir(), 'sax-bizcert-'));
    worker = await createWorker('kor', 1, { langPath: KOR.langPath, gzip: KOR.gzip, cachePath: cache });
  });

  after(async () => {
    await worker?.terminate();
    await browser?.close();
    await fs.rm(cache, { recursive: true, force: true });
  });

  const read = async (img: Buffer): Promise<{ got: BizFields | null; text: string; confidence: number; logs: unknown[] }> => {
    let text = '';
    let confidence = 0;
    const logs: unknown[] = [];
    const got = await readBizCert({
      pick: async () => new Uint8Array(img),
      pdfText: async () => '',
      imageText: async (b) => {
        const r = await sandboxLikeOcr(browser, worker, Buffer.from(b), 'document');
        text = r.text;
        confidence = r.confidence;
        return r.text;
      },
      parse: async (t) => parseBizCert(t),
      log: (n, d) => logs.push([n, d]),
    });
    return { got, text, confidence, logs };
  };

  for (const s of SAMPLES) {
    for (const [v, fmt] of VARIANTS) {
      it(`${s.kind === 'individual' ? '개인' : '법인'} ${v} ${fmt.toUpperCase()}`, async () => {
        const img = await renderCert(browser, certHtml(s), v, fmt);
        const { got, text, confidence, logs } = await read(img);
        const exp = expected(s);
        const verdict = Object.fromEntries(KEYS.map((k) => [k, !got?.[k] ? 'blank' : same(got[k], exp[k]) ? 'ok' : close(got[k], exp[k]) ? 'glyph' : 'wrong']));
        await appendMeasure('bizcert-ocr.jsonl', { sample: `${s.kind}-${v}-${fmt}`, confidence: Math.round(confidence), verdict });
        try {
          assert.ok(got, `읽지 못함(신뢰도 ${Math.round(confidence)})`);
          // 세 OS: 채운 칸은 같은 칸(낱글자 오인식만), 체크섬 맞는 번호는 정답, 6칸 중 5칸 이상
          for (const k of KEYS) if (got[k]) assert.ok(close(got[k], exp[k]), `${k} 다른 값을 채움: ${got[k]} ≠ ${exp[k]}`);
          if (isValidBizNo(got.bizNo)) assert.equal(got.bizNo, exp.bizNo);
          assert.ok(KEYS.filter((k) => got[k]).length >= 5, `빈 칸이 많다: ${KEYS.filter((k) => !got[k]).join(',')}`);
          if (MEASURED_OS) for (const k of KEYS) assert.ok(same(got[k], exp[k]), `${k}: ${got[k] || '(빈 칸)'} ≠ ${exp[k]}`);
          assert.deepEqual(logs, [['main.bizcert_read', { format: fmt, via: 'ocr', result: 'ok', blanks: KEYS.filter((k) => !got[k]).length }]]);
        } catch (e) {
          // 실패하면 입력 그림과 OCR 원문을 측정 폴더에 남긴다(가상 값 견본)
          const dir = path.dirname(await writeMeasure(`bizcert-fail/${s.kind}-${v}-${fmt}.txt`, `confidence ${confidence}\n${text}`));
          await fs.writeFile(measurePath(`bizcert-fail/${s.kind}-${v}-${fmt}.${fmt}`), img);
          console.error(`등록증 OCR 실패 입력·원문: ${dir}`);
          throw e;
        }
      });
    }
    it(`${s.kind === 'individual' ? '개인' : '법인'} 읽을 수 없게 흐린 JPEG → 채우지 않는다(사업자번호 입력으로)`, async () => {
      const { got, logs } = await read(await renderCert(browser, certHtml(s), 'unreadable', 'jpeg'));
      assert.equal(got, null);
      assert.deepEqual(logs, [['main.bizcert_read', { format: 'jpeg', via: 'ocr', result: 'unreadable' }]]);
    });
  }
});

describe('판정 규칙: 낱글자 오인식은 OCR 몫, 다른 칸이 섞이면 잘못 채움', () => {
  it('close: 박다라→박하라·2층→2 증은 같은 칸, 이가나→이가나생년·가나상사→가나상사 대표자 이가나는 다른 칸', () => {
    assert.equal(close('박 하라', '박다라'), true);
    assert.equal(close('서울특별시 마포구 월드컵로 10, 2 증', '서울특별시 마포구 월드컵로 10, 2층'), true);
    assert.equal(close('이가나생년', '이가나'), false);
    assert.equal(close('가나상사 대표자 이가나', '가나상사'), false);
    assert.equal(close('주식회사 가다라테크', '주식회사 다라테크'), true);
    assert.equal(close('주식회사 가나다라마', '주식회사 다라테크'), false);
  });
});

describe('증명서 그림 전처리(cleanDocumentForOcr)·OCR 배율(ocrScale)', () => {
  const page = (w: number, h: number, paper: number) => {
    const px = new Uint8ClampedArray(w * h * 4).fill(paper);
    const set = (x: number, y: number, rgb: [number, number, number]) => px.set([...rgb, 255], (y * w + x) * 4);
    return { px, set, at: (x: number, y: number) => px[(y * w + x) * 4] };
  };

  it('흰 종이: 회색 글자 가장자리는 남기고, 붉은 직인·긴 표 선·옅은 바탕무늬는 흰색', () => {
    const w = 400;
    const h = 200;
    const { px, set, at } = page(w, h, 255);
    for (let x = 0; x < w; x++) set(x, 100, [20, 20, 20]); // 표 선
    for (let x = 50; x < 70; x++) for (let y = 20; y < 50; y++) set(x, y, [10, 10, 10]); // 글자 획
    for (let y = 20; y < 50; y++) set(70, y, [130, 130, 130]); // 획 가장자리(회색)
    for (let x = 100; x < 160; x++) for (let y = 120; y < 180; y++) set(x, y, [200, 40, 40]); // 붉은 직인
    for (let x = 200; x < 260; x++) for (let y = 20; y < 60; y++) set(x, y, [235, 235, 235]); // 바탕무늬
    assert.deepEqual(cleanDocumentForOcr(px, w, h), { photo: false });
    assert.deepEqual([at(60, 30), at(70, 30), at(10, 100), at(120, 150), at(220, 40), at(300, 150)], [10, 130, 255, 255, 255, 255]);
  });

  it('바탕이 어두운 촬영본: 흑백으로 자르지 않고 회색조만(고정 임계면 종이까지 검게 뭉친다)', () => {
    const w = 100;
    const h = 100;
    const { px, set, at } = page(w, h, 150);
    for (let x = 40; x < 50; x++) for (let y = 40; y < 60; y++) set(x, y, [40, 40, 40]);
    assert.ok(DOCUMENT_PHOTO_INK_SHARE < 1);
    assert.deepEqual(cleanDocumentForOcr(px, w, h), { photo: true });
    assert.deepEqual([at(10, 10), at(45, 45)], [150, 40]);
  });

  it('증명서 모드는 작은 그림을 2배까지 키우고, 큰 그림은 긴 변 상한으로 줄인다. 사진 모드는 키우지 않는다', () => {
    assert.equal(ocrScale(1000, 1100, 'document', 2400), 2);
    assert.equal(ocrScale(1500, 1600, 'document', 2400), 1.5);
    assert.equal(ocrScale(2000, 2200, 'document', 2400), 1);
    assert.equal(ocrScale(3000, 4000, 'document', 2400), 0.6);
    assert.equal(ocrScale(1000, 1100, 'photo', 2400), 1);
    assert.equal(ocrScale(3000, 4000, 'photo', 2400), 0.6);
  });
});
