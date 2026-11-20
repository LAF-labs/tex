export type DocparseErrorCode =
  | 'input_size'
  | 'not_pdf'
  | 'unsupported_format'
  | 'wrong_kind'
  | 'format_not_recognized'
  | 'session_failed'
  | 'timeout'
  | 'memory_limit'
  | 'renderer_gone'
  | 'schema'
  | 'password_required'
  | 'password_incorrect'
  | 'invalid_pdf'
  | 'worker_failed'
  | 'parse_failed'
  | 'render_failed'
  | 'ocr_failed'
  | 'image_too_large'
  | 'image_decode_failed'
  | 'zip_invalid'
  | 'zip_unsupported'
  | 'zip_bomb'
  | 'xml_invalid'
  | 'xml_doctype'
  | 'sheet_too_large'
  | 'sheet_invalid'
  | 'text_decode_failed';

export class DocparseError extends Error {
  readonly code: string;
  readonly detail: string | undefined;
  constructor(code: DocparseErrorCode | (string & {}), detail?: string) {
    super(code);
    this.code = code;
    this.detail = detail;
  }
}
