import fs from 'node:fs';
import ajv2020 from 'ajv/dist/2020.js';
import type { ErrorObject, ValidateFunction } from 'ajv';
import type { Violation } from './types.ts';

export const SCHEMA_NAMES = ['playbook-ir', 'manifest', 'selectors', 'bundle', 'policy', 'hotfix', 'gateway-request', 'status', 'revoked_keys', 'data_descriptor'] as const;
export type SchemaName = (typeof SCHEMA_NAMES)[number];

const BASE = 'https://sovereign-ax.dev/schemas/';
const DATE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
const DATE_TIME = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])T([01]\d|2[0-3]):[0-5]\d:([0-5]\d|60)(\.\d+)?(Z|[+-]([01]\d|2[0-3]):[0-5]\d)$/;

export function schemaPath(name: SchemaName): URL {
  return new URL(`../../schemas/${name}.schema.json`, import.meta.url);
}

type AjvCtor = typeof import('ajv').default;
let compiled: Map<SchemaName, ValidateFunction> | null = null;

function validators(): Map<SchemaName, ValidateFunction> {
  if (compiled) return compiled;
  const Ajv2020 = ajv2020.default as AjvCtor;
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
