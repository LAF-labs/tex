// @sax/docparse: 사용자가 넣는 파일(증명서 PDF, 종이 증빙 사진, 정산 엑셀, 4대보험 고지내역)을 읽는 계약과 규칙 파서.
// - parse(bytes, kind, host): 공개 인터페이스. host는 docparse 샌드박스(apps/desktop/src/docparse.ts의 sandboxHost)
// - schema/*.json: 샌드박스 출력·결과 계약. 결과에 판정은 없다(추출값·신뢰도·경고)
// - Electron 의존은 없다. 샌드박스 안에서 도는 순수 모듈은 ./sandbox(dist/sandbox/*.js를 샌드박스가 싣는다)
export * from './errors.ts';
export * from './manual.ts';
export { ACCEPTS, parse } from './parse.ts';
export { parseInsuranceNotice } from './insurance.ts';
export { parseReceipt, type ReceiptInput } from './receipt.ts';
export { parseSettlement } from './settlement.ts';
export { PARSE_RESULT_SCHEMA, parseOutcomeErrors, SANDBOX_OUTPUT_SCHEMA, validateParseOutcome, validateSandboxOutput, type SandboxOp } from './schema.ts';
export { shortId, STORED_DOC_TYPE, storedFileName } from './storage.ts';
export * from './types.ts';
export { imageInfo, MAX_INPUT_BYTES, SANDBOX_ERRORS, sniffFormat, type Cell, type ImageInfo, type SheetTable } from './sandbox/index.ts';
