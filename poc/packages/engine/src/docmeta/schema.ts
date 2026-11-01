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
    suggested: { type: 'string', maxLength: 40 },
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
  required: ['extractor', 'kind', 'docType', 'issuedOn', 'validUntil', 'issuer', 'docNo', 'subjectBizNo', 'candidates'],
  properties: {
    extractor: { const: 'docmeta-v1' },
    kind: { enum: ['national_tax_cert', 'biz_registration_cert', 'localtax_cert', 'biz_registration', 'closure_cert', 'english_cert', 'ambiguous', 'unknown'] },
    docType: { enum: ['national_tax_cert', 'biz_registration_cert', null] },
    issuedOn: field(ISO_DATE),
    validUntil: field(ISO_DATE),
    issuer: field('^[가-힣]{1,5}세무서장$'),
    docNo: field('^[0-9A-Z]{4}-\\d{3}-\\d{4}-\\d{3}$'),
    subjectBizNo: field('^\\d{10}$'),
    candidates: {
      type: 'array',
      maxItems: 8,
      items: { type: 'object', additionalProperties: false, required: ['date', 'context'], properties: { date: { type: 'string', pattern: ISO_DATE }, context: { type: 'string', maxLength: 400 } } },
    },
  },
} as const;

let validator: ValidateFunction | null = null;

/** 스키마 위반이면 null. 엔진은 null이면 저장하지 않고 schema 오류로 끝낸다. */
export function validateDocMeta(v: unknown): DocMetaExtract | null {
  if (!validator) {
    const Ajv = createRequire(import.meta.url)('ajv') as typeof import('ajv').default;
    validator = new Ajv({ allErrors: false, strict: false }).compile(DOC_META_SCHEMA);
  }
  return validator(v) ? (v as DocMetaExtract) : null;
}
