// M6-12 준비: 파서 퍼징 하네스(D14 M6-12, D13 S17 숨김 텍스트, ADR-028 의존성 목록). 파서마다 "입력 생성기 + 성질"을 한 표에 둔다.
// 성질: 예외는 던져도 되지만(거부) 멈추지 않는다(회차당 시간 상한), 프로세스를 죽이지 않는다, 출력이 있으면 스키마 검사기를 통과한다.
// 지금 도는 것: OCR 문자 파서 parseBizCert·문서 메타 추출 extractDocMeta(엔진, 문자열 입력).
// 자리만: 이미지·엑셀 파서(docparse 트랙 M6-4·M6-5) — 모듈이 생기면 PARSERS의 module·export만 맞추면 돈다.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { FUZZ_ITER, FUZZ_SEED, pick, rng } from './lib/fuzz.ts';

type Gen = (r: () => number) => string | Uint8Array;
interface ParserCase {
  name: string;
  /** import 지정자(워크스페이스 패키지). 없으면 건너뛴다. */
  module: string;
  export: string;
  input: Gen;
  /** 결과 검사(있으면). 실패 메시지 또는 null. */
  check?: (out: unknown, mod: Record<string, unknown>) => string | null;
  perCallMs?: number;
  /** 어느 태스크가 채우는가 */
  owner: string;
}

const CHARS = ['0', '1', '9', '-', ' ', '\n', '\t', '사', '업', '자', '등', '록', '번', '호', '대', '표', '년', '월', '일', ':', '(', ')', '​', '‮', '­', '�', '𝟙', 'Ａ', '\u0000', '<', '>', '"', '\\'];
const TEMPLATES = ['사업자등록번호 : ', '상 호 : ', '대 표 자 : ', '개업연월일 : ', '사업장소재지 : ', '발급일 ', '유효기간 ', '주민등록번호 '];

/** 문자열 입력: 실제 서식 줄 + 잡음 + 매우 긴 줄 + 반복(ReDoS 모양). */
const textGen: Gen = (r) => {
  const lines: string[] = [];
  const n = 1 + Math.floor(r() * 40);
  for (let i = 0; i < n; i++) {
    const k = r();
    if (k < 0.4) lines.push(pick(r, TEMPLATES) + Array.from({ length: Math.floor(r() * 30) }, () => pick(r, CHARS)).join(''));
    else if (k < 0.5) lines.push(pick(r, CHARS).repeat(1 + Math.floor(r() * 20_000)));
    else if (k < 0.6) lines.push('1-'.repeat(Math.floor(r() * 5_000)) + '!');
    else lines.push(Array.from({ length: Math.floor(r() * 120) }, () => pick(r, CHARS)).join(''));
  }
  return lines.join(pick(r, ['\n', '\r\n', ' ']));
};

/** 바이너리 입력: 형식 머리(매직)는 맞고 나머지는 잘리거나 망가진 바이트. */
const MAGIC: Record<string, number[]> = {
  png: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
  jpeg: [0xff, 0xd8, 0xff, 0xe0],
  zip: [0x50, 0x4b, 0x03, 0x04], // xlsx
  heic: [0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x68, 0x65, 0x69, 0x63],
};
const binGen = (kind: keyof typeof MAGIC): Gen => (r) => {
  const len = Math.floor(r() * 4096);
  const b = new Uint8Array(MAGIC[kind]!.length + len);
  b.set(MAGIC[kind]!);
  for (let i = MAGIC[kind]!.length; i < b.length; i++) b[i] = Math.floor(r() * 256);
  return b;
};

export const PARSERS: readonly ParserCase[] = [
  {
    name: 'OCR 사업자등록증 문자 파서 parseBizCert',
    module: '@sax/engine/bizcert',
    export: 'parseBizCert',
    input: textGen,
    check: (o) => (o && typeof o === 'object' && 'fields' in o ? null : '결과에 fields 없음'),
    owner: 'M5-1(지금 돈다)',
  },
  {
    name: '문서 메타 추출 extractDocMeta(민원증명 PDF 글자)',
    module: '@sax/engine/docmeta',
    export: 'extractDocMeta',
    input: textGen,
    // 추출 결과는 스키마 검사기를 통과해야 한다(검사기가 거부하는 결과를 내면 화면·저장에 들어갈 수 있다).
    check: (o, m) => (typeof m.validateDocMeta !== 'function' || (m.validateDocMeta as (v: unknown) => unknown)(o) ? null : 'validateDocMeta가 거부하는 결과'),
    owner: 'M5-1(지금 돈다)',
  },
  // TODO(M6-12): docparse 트랙(M6-4 이미지·M6-5 엑셀) PR이 머지되면 module·export를 실제 이름으로 맞춘다.
  { name: '이미지 파서(PNG)', module: '@sax/docparse/image', export: 'parseImage', input: binGen('png'), owner: 'M6-12 ← docparse M6-4' },
  { name: '이미지 파서(JPEG)', module: '@sax/docparse/image', export: 'parseImage', input: binGen('jpeg'), owner: 'M6-12 ← docparse M6-4' },
  { name: '이미지 파서(HEIC)', module: '@sax/docparse/image', export: 'parseImage', input: binGen('heic'), owner: 'M6-12 ← docparse M6-4' },
  { name: '엑셀 파서(xlsx zip)', module: '@sax/docparse/xlsx', export: 'parseXlsx', input: binGen('zip'), owner: 'M6-12 ← docparse M6-5' },
];

async function load(c: ParserCase): Promise<{ fn: (x: unknown) => unknown; mod: Record<string, unknown> } | null> {
  try {
    const mod = (await import(c.module)) as Record<string, unknown>;
    const fn = mod[c.export];
    return typeof fn === 'function' ? { fn: fn as (x: unknown) => unknown, mod } : null;
  } catch {
    return null;
  }
}

describe('M6-12 파서 퍼징 하네스', async () => {
  const loaded = await Promise.all(PARSERS.map(load));
  PARSERS.forEach((c, idx) => {
    const l = loaded[idx];
    const iter = Math.min(FUZZ_ITER, 200);
    it(`${c.name}: ${iter}회 멈춤 없음·결과 검사 (씨앗 ${FUZZ_SEED})`, { skip: l ? false : `${c.module}#${c.export} 없음 — ${c.owner}` }, async () => {
      const r = rng(FUZZ_SEED + idx);
      const limit = c.perCallMs ?? 5_000;
      let threw = 0;
      for (let i = 0; i < iter; i++) {
        const x = c.input(r);
        const t = performance.now();
        let out: unknown;
        try {
          out = await l!.fn(x);
        } catch {
          threw++;
          continue;
        } finally {
          const ms = performance.now() - t;
          assert.ok(ms < limit, `${c.name} 회차 ${i}: ${ms.toFixed(0)}ms > ${limit}ms (입력 길이 ${x.length})`);
        }
        const bad = c.check?.(out, l!.mod);
        assert.equal(bad ?? null, null, `${c.name} 회차 ${i}: ${bad}`);
      }
      // 거부(예외)는 정상이지만 전부 예외면 생성기가 파서 앞단에서 막히는 것이다.
      assert.ok(threw < iter, `${c.name}: 모든 입력에서 예외`);
    });
  });

  it.todo('숨김 텍스트·인젝션 회귀(흰 글자·0pt·화면 밖·주석 레이어 PDF, 숨김 시트·셀 주석 엑셀)를 injection.sec.ts 코퍼스에 추가 — M6-12');
  it.todo('파서 라이브러리를 ADR-028 의존성 갱신 목록에 등록 — M6-12(docparse 의존성 확정 뒤)');
});
