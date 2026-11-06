// 스키마 10종(D02 §2 7종 + 레지스트리 status·폐기 목록 + 데이터 패키지 기술자, M1-4·M6-10)의 Ajv 2020 검증기. 레지스트리 CI와 엔진이 같은 함수를 쓴다(D02 §1).
// 스키마 파일은 packages/engine/schemas에 있는 설계 정본(sovereign-ax/design/schemas)의 사본이다(동일성은 테스트가 확인).
import fs from 'node:fs';
import ajv2020 from 'ajv/dist/2020.js';
import type { ErrorObject, ValidateFunction } from 'ajv';
import type { Violation } from './types.ts';

export const SCHEMA_NAMES = ['playbook-ir', 'manifest', 'selectors', 'bundle', 'policy', 'hotfix', 'gateway-request', 'status', 'revoked_keys', 'data_descriptor'] as const;
export type SchemaName = (typeof SCHEMA_NAMES)[number];

const BASE = 'https://sovereign-ax.dev/schemas/';
const DATE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
// RFC 3339 date-time(오프셋 필수).
const DATE_TIME = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])T([01]\d|2[0-3]):[0-5]\d:([0-5]\d|60)(\.\d+)?(Z|[+-]([01]\d|2[0-3]):[0-5]\d)$/;

export function schemaPath(name: SchemaName): URL {
  return new URL(`../../schemas/${name}.schema.json`, import.meta.url);
}

type AjvCtor = typeof import('ajv').default;
let compiled: Map<SchemaName, ValidateFunction> | null = null;

function validators(): Map<SchemaName, ValidateFunction> {
  if (compiled) return compiled;
  const Ajv2020 = ajv2020.default as AjvCtor;
  // strict: 모르는 키워드·형식은 컴파일 오류. strictTypes는 oneOf 가지마다 type을 반복하지 않는 스키마 관례 때문에 끈다.
  const ajv = new Ajv2020({ allErrors: true, strict: true, strictTypes: false, strictRequired: false, allowUnionTypes: true });
  ajv.addFormat('date', DATE);
  ajv.addFormat('date-time', DATE_TIME);
  for (const n of SCHEMA_NAMES) ajv.addSchema(JSON.parse(fs.readFileSync(schemaPath(n), 'utf8')) as object);
  compiled = new Map(SCHEMA_NAMES.map((n) => [n, ajv.getSchema(`${BASE}${n}.schema.json`)!] as const));
  return compiled;
}

const describe = (e: ErrorObject) => {
  const p = e.params as Record<string, unknown> | undefined;
  const name = p?.additionalProperty ?? p?.unevaluatedProperty ?? p?.missingProperty;
  return `${e.instancePath || '/'} ${e.keyword}${name !== undefined ? `(${String(name)})` : ''}`;
};

/** 스키마 적합성(V-01 앞부분). 오류는 경로·키워드만 담는다(값 없음, D03 §9 원칙). */
export function schemaViolations(name: SchemaName, doc: unknown, rule = 'V-01'): Violation[] {
  const v = validators().get(name)!;
  if (v(doc)) return [];
  // oneOf 가지마다 나오는 중복을 줄인다.
  const seen = new Set<string>();
  const out: Violation[] = [];
  for (const e of v.errors ?? []) {
    const m = `${name}: ${describe(e)}`;
    if (seen.has(m)) continue;
    seen.add(m);
    out.push({ rule, message: m });
    if (out.length >= 20) break;
  }
  return out;
}

export function isValid(name: SchemaName, doc: unknown): boolean {
  return validators().get(name)!(doc) === true;
}
