// 추출 결과 JSON Schema. 저장 전에 통과해야 한다(형식이 어긋난 값이 DB·화면으로 가지 않게).
import { createRequire } from 'node:module';
import type { ValidateFunction } from 'ajv';
import type { DocMetaExtract } from './extract.ts';

const ISO_DATE = '^(19|20)\\d{2}-(0[1-9]|1[0-2])-(0[1-9]|[12]\\d|3[01])$';
const REASONS = ['not_found', 'unparseable', 'ambiguous', 'checksum_failed', 'not_applicable', 'unsupported_doc'];

const field = (pattern: string) => ({
  type: 'object',
  additionalProperties: false,
  required: ['value', 'reason'],
  properties: {
    value: { anyOf: [{ type: 'string', pattern }, { type: 'null' }] },
    reason: { anyOf: [{ enum: REASONS }, { type: 'null' }] },
    // 날짜 칸의 후보는 날짜 형식, 그 밖(체크섬이 틀린 사업자번호 등)은 짧은 글자
    suggested: { type: 'string', maxLength: 40, pattern: pattern === ISO_DATE ? ISO_DATE : '^[0-9A-Z가-힣-]{1,40}$' },
  },
  // 값이 있으면 이유가 없고, 값이 없으면 이유가 있다
  oneOf: [
    { properties: { value: { type: 'string' }, reason: { type: 'null' } }, not: { required: ['suggested'] } },
    { properties: { value: { type: 'null' }, reason: { enum: REASONS } } },
  ],
});

export const DOC_META_SCHEMA = {
  $id: 'https://sovereign-ax.local/schemas/docmeta-extract-v1.json',
  type: 'object',
  additionalProperties: false,
  required: ['extractor', 'kind', 'docType', 'issuedOn', 'validUntil', 'issuer', 'docNo', 'subjectBizNo', 'uncertain', 'candidates'],
  properties: {
    extractor: { const: 'docmeta-v1' },
    kind: { enum: ['national_tax_cert', 'biz_registration_cert', 'localtax_cert', 'biz_registration', 'closure_cert', 'english_cert', 'ambiguous', 'unknown'] },
    docType: { enum: ['national_tax_cert', 'biz_registration_cert', null] },
    issuedOn: field(ISO_DATE),
    validUntil: field(ISO_DATE),
    issuer: field('^[가-힣]{2,4}세무서장$'),
    docNo: field('^[0-9A-Z]{4}-\\d{3}-\\d{4}-\\d{3}$'),
    subjectBizNo: field('^\\d{10}$'),
    uncertain: { type: 'array', maxItems: 1, uniqueItems: true, items: { enum: ['issuedOn'] } },
    candidates: {
      type: 'array',
      maxItems: 8,
      items: { type: 'object', additionalProperties: false, required: ['date', 'context'], properties: { date: { type: 'string', pattern: ISO_DATE }, context: { type: 'string', maxLength: 400 } } },
    },
  },
  allOf: [
    // 종류를 정했으면 판별 결과와 같다. 못 정했으면 모든 칸이 unsupported_doc
    { if: { properties: { docType: { type: 'string' } } }, then: { properties: { kind: { const: { $data: '1/docType' } } } } },
    {
      if: { properties: { docType: { type: 'null' } } },
      then: { properties: Object.fromEntries(['issuedOn', 'validUntil', 'issuer', 'docNo', 'subjectBizNo'].map((k) => [k, { properties: { value: { type: 'null' }, reason: { const: 'unsupported_doc' } } }])) },
    },
    // 사업자등록증명에는 유효기간 칸이 없다
    { if: { properties: { docType: { const: 'biz_registration_cert' } } }, then: { properties: { validUntil: { properties: { value: { type: 'null' }, reason: { const: 'not_applicable' } } } } } },
  ],
} as const;

let validator: ValidateFunction | null = null;

/** 스키마 위반이면 null. 엔진은 null이면 저장하지 않고 schema 오류로 끝낸다. */
export function validateDocMeta(v: unknown): DocMetaExtract | null {
  if (!validator) {
    const Ajv = createRequire(import.meta.url)('ajv') as typeof import('ajv').default;
    validator = new Ajv({ allErrors: false, strict: false, $data: true }).compile(DOC_META_SCHEMA);
  }
  return validator(v) ? (v as DocMetaExtract) : null;
}
