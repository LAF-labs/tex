// 샌드박스 안 파서의 상한과 실패 코드. 상한은 정상 서류의 수십 배로 두고, 넘으면 읽지 않고 코드로 끝낸다(M6-12 "거부해야 하는 것").

/** 입력 바이트 상한(main이 먼저 자르고, 샌드박스도 다시 본다). */
export const MAX_INPUT_BYTES = 15 * 1024 * 1024;

export const ZIP_LIMITS = {
  /** 중앙 디렉터리 항목 수. xlsx는 보통 20개 안팎이다. */
  maxEntries: 2000,
  /** 한 항목을 풀었을 때 바이트 상한(머리에 적힌 크기가 거짓이어도 푸는 도중에 끊는다). */
  maxEntryBytes: 64 * 1024 * 1024,
  /** 이 작업에서 푼 바이트 합 상한. */
  maxTotalBytes: 160 * 1024 * 1024,
  /** 압축률 상한(풀린 크기 / 압축 크기). 정상 시트 XML은 10~30배다. */
  maxRatio: 250,
} as const;

export const SHEET_LIMITS = {
  maxSheets: 32,
  maxRows: 20_000,
  maxCols: 256,
  maxCells: 600_000,
  maxCellChars: 4000,
  maxSharedStrings: 400_000,
  /** XML 요소 깊이 상한(중첩 폭탄). */
  maxXmlDepth: 64,
} as const;

export const IMAGE_LIMITS = {
  /** 디코드 전에 머리로 본 화소 수 상한(디코드 폭탄). 폰 카메라 48MP까지. */
  maxPixels: 50_000_000,
  maxSide: 12_000,
  /** OCR에 넘기는 긴 변. 영수증 글자 높이 30px 안팎이 되게. */
  ocrMaxSide: 2400,
} as const;

/** 샌드박스가 낼 수 있는 실패 코드(main은 이 목록 밖의 값을 schema로 본다). */
export const SANDBOX_ERRORS = [
  'password_required',
  'password_incorrect',
  'invalid_pdf',
  'worker_failed',
  'parse_failed',
  'render_failed',
  'ocr_failed',
  'input_size',
  'unsupported_format',
  'image_too_large',
  'image_decode_failed',
  'zip_invalid',
  'zip_unsupported',
  'zip_bomb',
  'xml_invalid',
  'xml_doctype',
  'sheet_too_large',
  'sheet_invalid',
  'text_decode_failed',
] as const;
export type SandboxErrorCode = (typeof SANDBOX_ERRORS)[number];

export class SandboxError extends Error {
  readonly code: SandboxErrorCode;
  constructor(code: SandboxErrorCode) {
    super(code);
    this.code = code;
  }
}
