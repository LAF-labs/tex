// remote-envelope.schema.json(D08 정본)에서 검증기 코드를 미리 만든다(Ajv standalone).
// 폰(Hermes)은 런타임 코드 생성(new Function)을 쓰지 않으므로 생성된 코드를 저장소에 둔다.
// 스키마를 고치면: pnpm --filter @sax/remote gen:schema. tests/remote-envelope.test.ts가 최신인지 확인한다.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
export const SCHEMA_PATH = path.resolve(here, '../../../../sovereign-ax/design/schemas/remote-envelope.schema.json');
export const OUT_PATH = path.resolve(here, '../src/schema.gen.ts');

/** 스키마에서 b64·b64key32를 참조하는 속성 이름을 모은다(CBOR 바이트열로 보낼 필드). */
export function binaryKeys(schema) {
  const bin = new Set();
  const other = new Set();
  const isB64 = (s) => s && typeof s === 'object' && (s.$ref === '#/$defs/b64' || s.$ref === '#/$defs/b64key32');
  const walk = (s) => {
    if (!s || typeof s !== 'object') return;
    if (Array.isArray(s)) return s.forEach(walk);
    if (s.properties) {
      for (const [k, v] of Object.entries(s.properties)) {
        if (isB64(v) || (v && v.type === 'array' && isB64(v.items))) bin.add(k);
        else if (v && (v.type || v.enum || v.const !== undefined || v.$ref)) other.add(k);
      }
    }
    for (const v of Object.values(s)) walk(v);
  };
  walk(schema);
  const clash = [...bin].filter((k) => other.has(k));
  if (clash.length) throw new Error(`binary/non-binary key name clash: ${clash.join(', ')}`);
  return [...bin].sort();
}

export function generate() {
  const Ajv2020 = require('ajv/dist/2020').default;
  const standalone = require('ajv/dist/standalone').default;
  const schema = JSON.parse(fs.readFileSync(SCHEMA_PATH, 'utf8'));
  const ajv = new Ajv2020({ allErrors: false, strict: false, code: { source: true, esm: true, lines: false } });
  const validate = ajv.compile(schema);
  // ajv 런타임 require를 없애 의존 없는 ESM으로 만든다(Metro·Node 공용). 남은 require가 있으면 실패한다.
  const code = standalone(ajv, validate).replace('require("ajv/dist/runtime/ucs2length").default', '__ucs2length');
  if (/\brequire\(/.test(code)) throw new Error('standalone code still has require()');
  const keys = binaryKeys(schema);
  const types = schema.properties.type.enum;
  return [
    '/* eslint-disable */',
    '// @ts-nocheck',
    '// 생성 파일: packages/remote/scripts/gen-validator.mjs. 손으로 고치지 않는다. 정본은 sovereign-ax/design/schemas/remote-envelope.schema.json.',
    `export const SCHEMA_ID = ${JSON.stringify(schema.$id)};`,
    `export const SCHEMA_TITLE = ${JSON.stringify(schema.title)};`,
    `export const MESSAGE_TYPES = ${JSON.stringify(types)};`,
    `export const BINARY_KEYS = ${JSON.stringify(keys)};`,
    'const __ucs2length = (str) => { let n = 0; for (const _ of str) n++; return n; };',
    code.replace(/^"use strict";/, ''),
    '',
  ].join('\n');
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(here, 'gen-validator.mjs')) {
  fs.writeFileSync(OUT_PATH, generate());
  console.log(`wrote ${path.relative(process.cwd(), OUT_PATH)}`);
}
