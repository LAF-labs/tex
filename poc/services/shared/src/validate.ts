// JSON Schema 검증(ajv, 저장소가 이미 고정한 8.20.0). 스키마 밖 필드는 모두 거부(additionalProperties:false를 스키마가 갖는다).
import ajv2020 from 'ajv/dist/2020.js';
import type { ValidateFunction } from 'ajv';
import { fail, type ErrorCode } from './errors.ts';

const Ajv2020 = ajv2020.default as typeof import('ajv').default;
const ajv = new Ajv2020({ allErrors: false, strict: false });

export type Schema = Record<string, unknown>;

/** 검증기. 실패하면 code(기본 request.param_rejected)로 던진다. 오류 상세는 응답·로그에 남기지 않는다. */
export function validator<T>(schema: Schema, code: ErrorCode = 'request.param_rejected'): (v: unknown) => T {
  const fn: ValidateFunction = ajv.compile(schema);
  return (v: unknown) => {
    if (!fn(v)) fail(code);
    return v as T;
  };
}

/** 여러 $defs를 가진 외부 스키마 파일(gateway-request 등)에서 한 정의의 검증기를 만든다. */
export function validatorFor<T>(schema: Schema & { $id: string }, pointer: string, code: ErrorCode = 'request.param_rejected'): (v: unknown) => T {
  if (!ajv.getSchema(schema.$id)) ajv.addSchema(schema);
  const fn = ajv.getSchema(`${schema.$id}${pointer}`);
  if (!fn) throw new Error(`schema_pointer ${pointer}`);
  return (v: unknown) => {
    if (!fn(v)) fail(code);
    return v as T;
  };
}

// 자주 쓰는 조각
export const S = {
  b64key32: { type: 'string', pattern: '^[A-Za-z0-9+/]{43}=?$' },
  b64sig: { type: 'string', pattern: '^[A-Za-z0-9+/]{86}(==)?$' },
  uuid4: { type: 'string', pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' },
  hex32: { type: 'string', pattern: '^[0-9a-f]{32}$' },
  hex64: { type: 'string', pattern: '^[0-9a-f]{64}$' },
  token: { type: 'string', pattern: '^[A-Za-z0-9_-]{43}$' },
  epochMs: { type: 'integer', minimum: 0, maximum: 8_640_000_000_000_000 },
} as const;
