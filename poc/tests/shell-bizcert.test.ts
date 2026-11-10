// 사업자등록증 읽기(bizcert-read.ts, M4-3, 08 §4 O-02, ADR-014): 고른 파일 → 샌드박스 글자 → 엔진 bizcert.parse → 온보딩 후보.
// 샌드박스는 가짜(글자만 돌려준다), 해석은 엔진과 같은 parseBizCert. 실제 샌드박스 경로는 ocr-e2e가 본다.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { parseBizCert } from '@sax/engine';
import { bizCertFormat, bizFieldsOf, readBizCert, type BizCertReadPorts } from '../apps/desktop/src/bizcert-read.ts';
import { OnboardingFlow } from '../apps/desktop/src/onboarding.ts';
import { MockOnboardingPorts } from '../apps/desktop/src/onboarding-mock.ts';

const PDF = () => new Uint8Array(Buffer.from('%PDF-1.7\n%fake\n'));
const PNG = () => new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
const JPEG = () => new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16]);
const CERT_TEXT = `사업자등록증
(일반과세자)
등록번호 : 220-81-62517
상 호 : 마바사상회
대 표 자 : 최마바
개 업 연 월 일 : 2021 년 06 월 30 일
사업장 소재지 : 부산광역시 해운대구 센텀로 5
업 태 : 도매 종 목 : 전자부품`;

function ports(o: Partial<{ bytes: Uint8Array | null; pdf: string[]; image: string; throwAt: 'pick' | 'pdf' | 'image' | 'parse' }> = {}) {
  const calls: string[] = [];
  const logs: Array<[string, Record<string, string | number>]> = [];
  let held: Uint8Array | null = null;
  const pdf = [...(o.pdf ?? [CERT_TEXT])];
  const p: BizCertReadPorts = {
    pick: async () => {
      calls.push('pick');
      if (o.throwAt === 'pick') throw new Error('input_size');
      held = o.bytes === undefined ? PDF() : o.bytes;
      return held;
    },
    pdfText: async (_b, x) => {
      calls.push(`pdf:${x.forceOcr ? 'ocr' : 'text'}`);
      if (o.throwAt === 'pdf') throw Object.assign(new Error('x'), { code: 'timeout' });
      return pdf.shift() ?? '';
    },
    imageText: async () => {
      calls.push('image');
      if (o.throwAt === 'image') throw Object.assign(new Error('x'), { code: 'schema' });
      return o.image ?? CERT_TEXT;
    },
    parse: async (text) => {
      calls.push('parse');
      if (o.throwAt === 'parse') throw new Error('engine_exit');
      return parseBizCert(text);
    },
    log: (n, d) => logs.push([n, d]),
  };
  return { p, calls, logs, held: () => held };
}

describe('readBizCert', () => {
  it('PDF 글자 층 → 엔진 해석 → 온보딩 칸(이메일은 비운다)', async () => {
    const r = ports();
    const got = await readBizCert(r.p);
    assert.deepEqual(got, { name: '마바사상회', bizNo: '2208162517', rep: '최마바', bizType: '도매', bizItem: '전자부품', address: '부산광역시 해운대구 센텀로 5', email: '' });
    assert.deepEqual(r.calls, ['pick', 'pdf:text', 'parse']);
    assert.deepEqual(r.logs, [['main.bizcert_read', { format: 'pdf', via: 'text', result: 'ok', blanks: 0 }]]);
    assert.ok(r.held()!.every((b) => b === 0), '고른 바이트는 읽은 뒤 0으로 덮는다');
  });

  it('PDF 글자 층에서 상호·번호를 못 뽑으면 OCR로 한 번 더(스캔 PDF)', async () => {
    const r = ports({ pdf: ['사업자등록증\n국세청', CERT_TEXT] });
    const got = await readBizCert(r.p);
    assert.equal(got?.rep, '최마바');
    assert.deepEqual(r.calls, ['pick', 'pdf:text', 'parse', 'pdf:ocr', 'parse']);
    assert.equal(r.logs[0]![1].via, 'ocr');
    // 글자 층이 비면 엔진을 부르지 않고 바로 OCR
    const e = ports({ pdf: ['  ', CERT_TEXT] });
    await readBizCert(e.p);
    assert.deepEqual(e.calls, ['pick', 'pdf:text', 'pdf:ocr', 'parse']);
  });

  it('PNG·JPEG은 그림 OCR(증명서 모드)', async () => {
    for (const [bytes, format] of [[PNG(), 'png'], [JPEG(), 'jpeg']] as const) {
      const r = ports({ bytes });
      assert.equal((await readBizCert(r.p))?.name, '마바사상회');
      assert.deepEqual(r.calls, ['pick', 'image', 'parse']);
      assert.equal(r.logs[0]![1].format, format);
    }
  });

  it('고르지 않으면 null(로그 없음), 모르는 형식은 읽지 않고 bad_format', async () => {
    const c = ports({ bytes: null });
    assert.equal(await readBizCert(c.p), null);
    assert.deepEqual(c.logs, []);
    const b = ports({ bytes: new Uint8Array(Buffer.from('GIF89a....')) });
    assert.equal(await readBizCert(b.p), null);
    assert.deepEqual(b.calls, ['pick']);
    assert.deepEqual(b.logs, [['main.bizcert_read', { result: 'bad_format' }]]);
    assert.ok(b.held()!.every((x) => x === 0));
  });

  it('못 읽으면 null: 상호·번호 둘 다 없음, 샌드박스·엔진·고르기 실패(코드만 남긴다)', async () => {
    const u = ports({ pdf: ['아무 글자', '여전히 아님'] });
    assert.equal(await readBizCert(u.p), null);
    assert.deepEqual(u.logs, [['main.bizcert_read', { format: 'pdf', via: 'ocr', result: 'unreadable' }]]);
    for (const [throwAt, code] of [['pdf', 'timeout'], ['parse', 'engine_exit'], ['pick', 'input_size']] as const) {
      const r = ports({ throwAt });
      assert.equal(await readBizCert(r.p), null);
      assert.equal(r.logs[0]![1].result, code, throwAt);
    }
    const i = ports({ bytes: PNG(), throwAt: 'image' });
    assert.equal(await readBizCert(i.p), null);
    assert.equal(i.logs[0]![1].result, 'schema');
  });

  it('체크섬이 틀린 번호도 후보로 넘긴다(온보딩이 조회하지 않고 [고칠게요]로 보낸다)', async () => {
    const r = ports({ pdf: [CERT_TEXT.replace('220-81-62517', '220-81-62518')] });
    const got = await readBizCert(r.p);
    assert.equal(got?.bizNo, '2208162518');
    const flow = new OnboardingFlow(Object.assign(new MockOnboardingPorts({ saveProfile: async () => {} }), { recognizeBizCert: () => readBizCert(ports({ pdf: [CERT_TEXT.replace('220-81-62517', '220-81-62518')] }).p) }));
    await flow.answer({ step: 'terms', choice: 'agree' });
    await flow.answer({ step: 'welcome', choice: 'upload' });
    assert.equal(flow.state.step, 'biz-confirm');
    assert.equal(flow.state.biz?.name, '마바사상회');
    assert.match(flow.state.notice ?? '', /사업자번호가 맞지 않아요/);
    assert.equal(flow.state.check, null);
  });

  it('로그에 글자·필드 값·형식 밖 코드가 없다', async () => {
    const r = ports();
    await readBizCert(r.p);
    const s = JSON.stringify(r.logs);
    for (const bad of ['마바사', '최마바', '2208162517', '해운대', '사업자등록증']) assert.ok(!s.includes(bad), bad);
    const odd = ports({ throwAt: 'parse' });
    odd.p.parse = async () => {
      throw new Error('/Users/kim/등록증.pdf not found');
    };
    await readBizCert(odd.p);
    assert.equal(odd.logs[0]![1].result, 'failed');
  });
});

describe('bizFieldsOf·bizCertFormat', () => {
  it('엔진 응답 모양이 틀리면 null, 문자열 아닌 칸은 비우고 제어 문자는 공백, 상한에서 자른다', () => {
    assert.equal(bizFieldsOf(null), null);
    assert.equal(bizFieldsOf({ fields: [] }), null);
    assert.equal(bizFieldsOf({}), null);
    const f = bizFieldsOf({ fields: { name: '가\n나\u0000다', bizNo: '220-81-62517', repName: 7, address: 'x'.repeat(500) } })!;
    assert.equal(f.name, '가 나 다');
    assert.equal(f.bizNo, '2208162517');
    assert.equal(f.rep, '');
    assert.equal(f.address.length, 200);
    assert.equal(f.email, '');
  });
  it('형식은 앞 바이트로만 본다', () => {
    assert.equal(bizCertFormat(PDF()), 'pdf');
    assert.equal(bizCertFormat(PNG()), 'png');
    assert.equal(bizCertFormat(JPEG()), 'jpeg');
    assert.equal(bizCertFormat(new Uint8Array([0x89, 0x50])), null);
    assert.equal(bizCertFormat(new Uint8Array(0)), null);
  });
});

describe('셸 배선(소스 검사)', () => {
  const src = fs.readFileSync(path.join(import.meta.dirname, '../apps/desktop/src/shell-app.ts'), 'utf8');
  it('제품 온보딩 O-02는 고른 파일 → 샌드박스(PDF ocrPages 1, 그림 document) → 엔진 bizcert.parse, fixture는 목업 그대로', () => {
    assert.match(src, /recognizeBizCert: \(\) => readBizCert\(bizCertPorts\)/);
    assert.match(src, /const bizCertPorts: BizCertReadPorts = \{/);
    assert.match(src, /pickFileBytes\(\[\{ name: '사업자등록증\(PDF·사진\)', extensions: \['pdf', 'png', 'jpg', 'jpeg'\] \}\], win\)/);
    assert.match(src, /parsePdfInSandbox\(b, \{ ocrPages: 1, forceOcr: o\.forceOcr \}\)/);
    assert.match(src, /ocrImageInSandbox\(b, \{ mode: 'document' \}\)/);
    assert.match(src, /parse: \(text\) => host\.rpc\('bizcert\.parse', \{ text \}\)/);
    assert.doesNotMatch(src, /recognizeBizCert: \(\) => onbMock\.recognizeBizCert\(\)/);
    assert.match(src, /const onbExternal: OnboardingExternal = fixture\s*\? sample!\.onboarding\(\)/);
  });
  it('bizcert-read는 Electron·파일 시스템·x509·docparse 파서를 직접 쓰지 않는다', () => {
    const s = fs.readFileSync(path.join(import.meta.dirname, '../apps/desktop/src/bizcert-read.ts'), 'utf8');
    assert.doesNotMatch(s, /from 'electron'|from 'node:fs|@sax\/docparse|@sax\/engine/);
  });
});
