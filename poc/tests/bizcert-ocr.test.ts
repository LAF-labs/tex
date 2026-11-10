// 사업자등록증 그림 → 칸 6개(2026-11-10 설치본 "대표자가 안 들어간다", 로그 blanks 4). 견본은 국세청 양식을 본뜬 합성 그림(가상 값, bizcert-synth.ts).
// 경로는 제품과 같다: 그림 → 샌드박스와 같은 전처리·tesseract kor → 엔진 parseBizCert → readBizCert(bizFieldsOf) → 온보딩·거래처 칸.
// 원인(재현): ① 폰 촬영 JPEG는 종이가 회색이라 고정 임계 흑백(cleanForOcr)이 그늘진 아래쪽을 통째로 검게 만들어 대표자·주소·업태·종목이 비었다.
// ② 개인 양식 "성명 : 이가나 생년월일 : …" 한 줄에서 대표자가 "이가나생년"으로 잘못 채워졌다(파서). ③ 흑백 자르기가 등록번호 "100"을 "190"으로 읽게 했다.
// 판정: macOS(합성 견본을 실측한 글꼴)에서는 읽을 수 있는 견본 모두 6칸이 정답. 다른 OS는 글꼴이 달라 깨끗한 PNG만 6칸, 나머지는 "잘못 채우지 않음"만.
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
const VARIANTS: Array<[Variant, 'png' | 'jpeg']> = [
  ['clean', 'png'],
  ['scan', 'jpeg'],
  ['photo', 'jpeg'],
  ['photo-mild', 'jpeg'],
  ['photo-mild', 'png'],
  ['small', 'jpeg'],
];
const KEYS = ['name', 'bizNo', 'rep', 'address', 'bizType', 'bizItem'] as const;
const expected = (s: CertSample): Record<(typeof KEYS)[number], string> => ({ name: s.name, bizNo: s.bizNo, rep: s.rep, address: s.addr, bizType: s.types[0]!, bizItem: s.items[0]! });
const same = (a: string, b: string) => a.replace(/\s/g, '') === b.replace(/\s/g, '');
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
        const verdict = Object.fromEntries(KEYS.map((k) => [k, !got?.[k] ? 'blank' : same(got[k], exp[k]) ? 'ok' : 'wrong']));
        await appendMeasure('bizcert-ocr.jsonl', { sample: `${s.kind}-${v}-${fmt}`, confidence: Math.round(confidence), verdict });
        try {
          assert.ok(got, `읽지 못함(신뢰도 ${Math.round(confidence)})`);
          // 늘 성립: 대표자는 정답이거나 비어 있다(2026-11-10 "이가나생년" 같은 잘못 채움 금지). 체크섬이 맞는 번호는 정답이다.
          assert.ok(got.rep === '' || got.rep === exp.rep, `대표자 잘못 채움: ${got.rep}`);
          if (isValidBizNo(got.bizNo)) assert.equal(got.bizNo, exp.bizNo);
          if (MEASURED_OS || v === 'clean') for (const k of KEYS) assert.ok(same(got[k], exp[k]), `${k}: ${got[k] || '(빈 칸)'} ≠ ${exp[k]}`);
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
