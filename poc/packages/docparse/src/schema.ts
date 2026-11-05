// schema/*.json 검증기(ajv). 샌드박스 출력은 main이 쓰기 전에, parse 결과는 내보내기 전에 통과해야 한다.
import fs from 'node:fs';
import { createRequire } from 'node:module';
import type { ValidateFunction } from 'ajv';
import { DOC_META_SCHEMA } from '@sax/engine/docmeta';
import type { ImageOcr, ParseOutcome, PdfExtract, SheetOutput } from './types.ts';

const load = (name: string) => JSON.parse(fs.readFileSync(new URL(`../schema/${name}`, import.meta.url), 'utf8')) as { $id: string };

export const SANDBOX_OUTPUT_SCHEMA = load('sandbox-output.schema.json');
export const PARSE_RESULT_SCHEMA = load('parse-result.schema.json');

type Ajv = import('ajv').default;
let ajv: Ajv | null = null;
const cache = new Map<string, ValidateFunction>();

function validator(ref: string): ValidateFunction {
  let v = cache.get(ref);
  if (v) return v;
  if (!ajv) {
    const AjvCtor = createRequire(import.meta.url)('ajv') as typeof import('ajv').default;
    ajv = new AjvCtor({ allErrors: false, strict: false, $data: true });
    ajv.addSchema(DOC_META_SCHEMA as object);
    ajv.addSchema(SANDBOX_OUTPUT_SCHEMA);
    ajv.addSchema(PARSE_RESULT_SCHEMA);
  }
  v = ajv.getSchema(ref);
  if (!v) throw new Error(`schema ${ref}`);
  cache.set(ref, v);
  return v;
}

export type SandboxOp = 'pdf' | 'image' | 'sheet' | 'legacyOcr' | 'error';
type SandboxShape = { pdf: PdfExtract; image: ImageOcr; sheet: SheetOutput; legacyOcr: { text: string; confidence: number }; error: { error: string } };

/** 샌드박스 출력 검증. 통과하면 같은 값, 아니면 null(main은 schema 오류로 끝낸다). */
export function validateSandboxOutput<K extends SandboxOp>(op: K, v: unknown): SandboxShape[K] | null {
  return validator(`${SANDBOX_OUTPUT_SCHEMA.$id}#/definitions/${op}`)(v) ? (v as SandboxShape[K]) : null;
}

export function validateParseOutcome(v: unknown): ParseOutcome | null {
  return validator(PARSE_RESULT_SCHEMA.$id)(v) ? (v as ParseOutcome) : null;
}

/** 검증 실패 이유(테스트·개발용, 값은 넣지 않고 경로·키워드만) */
export function parseOutcomeErrors(v: unknown): string[] {
  const f = validator(PARSE_RESULT_SCHEMA.$id);
  return f(v) ? [] : (f.errors ?? []).map((e) => `${e.instancePath || '/'}:${e.keyword}`);
}
