// 사업자등록증 읽기(M4-3, 08 §4 O-02, ADR-014). 사용자가 고른 파일만 → docparse 샌드박스(PDF 글자 층·그림 OCR) → 엔진 bizcert.parse(텍스트만) → 입력 후보.
// - 결과는 후보다. 온보딩 [이 정보가 맞나요?]에서 사용자가 확인·수정한 뒤에만 저장한다(체크섬이 틀린 번호는 조회하지 않는다, onboarding.ts setBiz).
// - main은 파일을 해석하지 않는다(형식은 앞 바이트만 본다). 글자·필드·경로는 로그에 남기지 않는다. 로그는 형식·결과 코드·빈 칸 수만.
// - 거래처 등록증 입력(같은 길)도 이 함수를 쓴다.
import { BIZ_FIELD_MAX, type BizFields } from './onboarding.ts';

export type BizCertFormat = 'pdf' | 'png' | 'jpeg';

export interface BizCertReadPorts {
  /** 파일 고르기 → 바이트(일반 파일, 15MB까지). 고르지 않으면 null. */
  pick(): Promise<Uint8Array | null>;
  /** PDF → 글자(샌드박스). forceOcr이면 글자 층이 있어도 OCR로 읽는다. */
  pdfText(bytes: Uint8Array, o: { forceOcr: boolean }): Promise<string>;
  /** 그림 → 글자(샌드박스 OCR, 증명서 모드). */
  imageText(bytes: Uint8Array): Promise<string>;
  /** 엔진 main 전용 bizcert.parse({text}) */
  parse(text: string): Promise<unknown>;
  log?: (name: string, data: Record<string, string | number>) => void;
}

/** 앞 바이트로만 고른다(확장자는 보지 않는다). */
export function bizCertFormat(b: Uint8Array): BizCertFormat | null {
  if (b.length >= 5 && Buffer.from(b.subarray(0, Math.min(b.length, 1024))).indexOf('%PDF-') >= 0) return 'pdf';
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a) return 'png';
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpeg';
  return null;
}

const FIELD_OF = { name: 'name', bizNo: 'bizNo', rep: 'repName', bizType: 'bizType', bizItem: 'bizItem', address: 'address' } as const;

/** 엔진 응답(BizCertParse) → 온보딩 칸. 모양이 틀리면 null. 문자열이 아닌 칸은 비운다. 상한을 넘으면 자른다(입력 폼과 같은 상한). */
export function bizFieldsOf(r: unknown): BizFields | null {
  const f = (r as { fields?: unknown } | null)?.fields;
  if (typeof f !== 'object' || f === null || Array.isArray(f)) return null;
  const src = f as Record<string, unknown>;
  const val = (k: keyof typeof FIELD_OF) => {
    const v = src[FIELD_OF[k]];
    // 제어 문자(줄바꿈 포함)는 공백으로: 한 줄 입력 칸에 들어간다
    return typeof v === 'string' ? [...v].map((c) => (c.charCodeAt(0) < 0x20 || c.charCodeAt(0) === 0x7f ? ' ' : c)).join('').trim().slice(0, BIZ_FIELD_MAX[k]) : '';
  };
  return { name: val('name'), bizNo: val('bizNo').replace(/\D/g, ''), rep: val('rep'), bizType: val('bizType'), bizItem: val('bizItem'), address: val('address'), email: '' };
}

/** 쓸 만한가: 상호나 사업자번호 하나는 있어야 한다(없으면 사업자번호 입력으로 넘어간다). */
const usable = (b: BizFields | null): b is BizFields => !!b && (b.name !== '' || b.bizNo.length === 10);
const blanks = (b: BizFields) => (['name', 'bizNo', 'rep', 'bizType', 'bizItem', 'address'] as const).filter((k) => !b[k]).length;
const codeOf = (e: unknown) => {
  const c = (e as { code?: unknown } | null)?.code;
  const m = (e as Error | null)?.message;
  const s = typeof c === 'string' ? c : typeof m === 'string' ? m : 'failed';
  return /^[a-z_]{1,40}$/.test(s) ? s : 'failed';
};

/**
 * 고르기 → 읽기 → 후보. 못 읽으면 null(온보딩은 "등록증을 읽지 못했어요. 사업자번호로 입력해 주세요"로 이어 간다).
 * PDF는 글자 층을 먼저 보고, 거기서 상호·번호를 못 뽑으면 OCR로 한 번 더 읽는다(스캔 PDF·그림만 든 PDF).
 */
export async function readBizCert(p: BizCertReadPorts): Promise<BizFields | null> {
  const log = p.log ?? (() => {});
  let bytes: Uint8Array | null;
  try {
    bytes = await p.pick();
  } catch (e) {
    log('main.bizcert_read', { result: codeOf(e) });
    return null;
  }
  if (!bytes) return null;
  const format = bizCertFormat(bytes);
  if (!format) {
    bytes.fill(0);
    log('main.bizcert_read', { result: 'bad_format' });
    return null;
  }
  const fieldsOf = async (text: string) => (text.trim() ? bizFieldsOf(await p.parse(text)) : null);
  try {
    let got: BizFields | null;
    let via = format === 'pdf' ? 'text' : 'ocr';
    if (format === 'pdf') {
      got = await fieldsOf(await p.pdfText(bytes, { forceOcr: false }));
      if (!usable(got)) {
        via = 'ocr';
        got = await fieldsOf(await p.pdfText(bytes, { forceOcr: true }));
      }
    } else got = await fieldsOf(await p.imageText(bytes));
    if (!usable(got)) {
      log('main.bizcert_read', { format, via, result: 'unreadable' });
      return null;
    }
    log('main.bizcert_read', { format, via, result: 'ok', blanks: blanks(got) });
    return got;
  } catch (e) {
    log('main.bizcert_read', { format, result: codeOf(e) });
    return null;
  } finally {
    bytes.fill(0);
  }
}
