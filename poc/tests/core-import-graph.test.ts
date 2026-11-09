// 엔진 코어(dist/core) import 그래프 가드: 코어는 @sax/db·better-sqlite3를 값으로 가져오지 않는다.
// @sax/engine/core는 클라우드 레지스트리 함수(services/registry)도 쓴다. 코어가 @sax/db를 값으로 가져오면 그 묶음에 네이티브 모듈이 실린다
// (#193은 vercel excludeFiles로 막았고, 이 시험이 근본 정리를 지킨다). 타입 import는 빌드에서 지워져 dist에 남지 않는다.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { LedgerError } from '@sax/db';
import { ledgerRejection } from '@sax/engine/core';

const DIST = path.resolve(import.meta.dirname, '../packages/engine/dist/core');
const SRC = path.resolve(import.meta.dirname, '../packages/engine/src/core');
/** 코어가 가져와도 되는 바깥 모듈(node: 내장 밖). 늘리려면 레지스트리 묶음에 실려도 되는지 먼저 본다. */
const ALLOWED_BARE = new Set(['ajv/dist/2020.js']);
const SPEC = /(?:import|export)\s[^'"]*?from\s*['"]([^'"]+)['"]|import\s*\(\s*['"]([^'"]+)['"]\s*\)|^\s*import\s*['"]([^'"]+)['"]/gm;

function bareImports(dir: string, ext: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith(ext) && !x.endsWith('.d.ts'))) {
    const text = fs.readFileSync(path.join(dir, f), 'utf8');
    for (const m of text.matchAll(SPEC)) {
      const spec = m[1] ?? m[2] ?? m[3]!;
      if (spec.startsWith('.') || spec.startsWith('node:')) continue;
      out.set(spec, [...(out.get(spec) ?? []), f]);
    }
  }
  return out;
}

describe('엔진 코어 import 그래프(레지스트리 묶음 네이티브 없음)', () => {
  it('제품 dist/core의 바깥 import는 허용 목록뿐이다(@sax/db·better-sqlite3 없음)', () => {
    const bare = bareImports(DIST, '.js');
    assert.ok(fs.readdirSync(DIST).some((f) => f === 'index.js'), 'dist가 빌드돼 있다');
    assert.deepEqual([...bare.keys()].filter((k) => !ALLOWED_BARE.has(k)), [], JSON.stringify(Object.fromEntries(bare)));
  });

  it('소스 core의 @sax/db import는 모두 import type이다', () => {
    const bad: string[] = [];
    for (const f of fs.readdirSync(SRC).filter((x) => x.endsWith('.ts'))) {
      for (const line of fs.readFileSync(path.join(SRC, f), 'utf8').split('\n')) if (/from '@sax\/db'/.test(line) && !/^\s*import type /.test(line)) bad.push(`${f}: ${line.trim()}`);
    }
    assert.deepEqual(bad, []);
  });

  it('원장 거절은 값 import 없이 같은 코드로 알아본다(ledgerRejection)', () => {
    assert.equal(ledgerRejection(new LedgerError('gate_not_approved')), 'gate_not_approved');
    assert.equal(ledgerRejection(new LedgerError('ledger_armed')), 'ledger_armed');
    assert.equal(ledgerRejection(new Error('ledger_armed')), null, 'code 없음');
    assert.equal(ledgerRejection(Object.assign(new Error('x'), { code: 'ledger_armed' })), null, 'message ≠ code');
    assert.equal(ledgerRejection(Object.assign(new Error('token.forged'), { code: 'token.forged' })), null, '원장 코드 아님');
    assert.equal(ledgerRejection({ code: 'ledger_armed', message: 'ledger_armed' }), null, 'Error 아님');
  });
});
