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

/** allOf의 {if type, then {properties {body}}}에서 body 스키마를 $defs로 올린 사본. 뜻은 같고 생성 코드만 함수로 나뉜다. */
export function splitBodies(schema) {
  const out = structuredClone(schema);
  out.allOf.forEach((entry, i) => {
    const body = entry?.then?.properties?.body;
    if (!body || typeof body !== 'object' || body.$ref) return;
    const name = `__body${i}`;
    if (out.$defs[name]) throw new Error(`$defs name clash: ${name}`);
    out.$defs[name] = body;
    entry.then.properties.body = { $ref: `#/$defs/${name}` };
  });
  return out;
}

export function generate() {
  const Ajv2020 = require('ajv/dist/2020').default;
  const standalone = require('ajv/dist/standalone').default;
  const schema = JSON.parse(fs.readFileSync(SCHEMA_PATH, 'utf8'));
  const ajv = new Ajv2020({ allErrors: false, strict: false, inlineRefs: false, code: { source: true, esm: true, lines: false } });
  const validate = ajv.compile(splitBodies(schema));
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
