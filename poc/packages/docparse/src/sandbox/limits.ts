/** 입력 바이트 상한(main이 먼저 자르고, 샌드박스도 다시 본다). */
export const MAX_INPUT_BYTES = 15 * 1024 * 1024;

export const ZIP_LIMITS = {
  maxEntries: 2000,
  maxEntryBytes: 64 * 1024 * 1024,
  maxTotalBytes: 160 * 1024 * 1024,
  maxRatio: 250,
} as const;

export const SHEET_LIMITS = {
  maxSheets: 32,
  maxRows: 20_000,
  maxCols: 256,
  maxCells: 600_000,
  maxCellChars: 4000,
  maxSharedStrings: 400_000,
  maxXmlDepth: 64,
} as const;

export const IMAGE_LIMITS = {
  maxPixels: 50_000_000,
  maxSide: 12_000,
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
  'cert_invalid',
] as const;
export type SandboxErrorCode = (typeof SANDBOX_ERRORS)[number];

export class SandboxError extends Error {
  readonly code: SandboxErrorCode;
  constructor(code: SandboxErrorCode) {
    super(code);
    this.code = code;
  }
}
