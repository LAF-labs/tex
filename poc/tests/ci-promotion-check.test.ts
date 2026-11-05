// scripts/ci-promotion-check.mjs: ADR-035 결정 1.3 (가) 표 → 시험 존재, (라) 폐기 표지 import 금지.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
// @ts-expect-error 타입 선언 없는 .mjs 스크립트
import * as pc from '../scripts/ci-promotion-check.mjs';

const POC = path.resolve(import.meta.dirname, '..');

describe('승격 점검 (가): D-xx → 시험 표', () => {
  const body = [
    '## 승격 조건',
    '| 통제 | 시험 |',
    '|---|---|',
    '| D-17(N-12) | `tests/vault-relay.test.ts > 누출 스캐너` |',
    '| **D-33(N-51)** | `tests/vault-relay.test.ts` `tests/없는.test.ts` |',
    '| D-14(N-23) | `tests/vault-relay.test.ts > 이런 이름은 없다` |',
    '| D-99(N-99) | `tests/vault-relay.test.ts` |',
    '| D-12(N-18) | 시험 없음 |',
    '| D-01 문서함 | 첫 칸이 ID만이 아니면 무시 |',
    '',
    '| 화면 | 상태 |',
    '|---|---|',
    '| D-04 | 시험 열이 없는 표는 무시(08 화면 ID) |',
    '본문 언급: D-28(N-43)도 고쳤다.',
  ].join('\n');

  it('행을 뽑고 백틱 시험 참조만 모은다', () => {
    const rows = pc.parsePromotionTable(body);
    assert.deepEqual(rows.map((r: { id: string }) => r.id), ['D-17', 'D-33', 'D-14', 'D-99', 'D-12']);
    assert.deepEqual(rows[1].refs, ['tests/vault-relay.test.ts', 'tests/없는.test.ts']);
    assert.deepEqual(rows[4].refs, []);
  });

  it('있는 파일·이름은 통과, 없는 파일·이름·참조 없음·D19에 없는 ID는 위반, 표 밖 언급은 경고', () => {
    const r = pc.checkTable(body);
    const ok = r.rows.find((x: { id: string }) => x.id === 'D-17').refs[0];
    assert.equal(ok.ok, true);
    assert.match(ok.test, /누출 스캐너/);
    assert.equal(r.rows.find((x: { id: string }) => x.id === 'D-17').stage, 'PoC/P1');
    const p = r.problems.join('\n');
    assert.match(p, /D-33\(N-51\): tests\/없는\.test\.ts — 파일 없음/);
    assert.match(p, /D-14\(N-23\): .* 이름이 "이런 이름은 없다"/);
    assert.match(p, /D-99\(N-99\): D19 §3\.5에 없는/);
    assert.match(p, /D-12\(N-18\): 시험 참조\(백틱 경로\) 없음/);
    assert.deepEqual(r.warnings, ['D-28: 본문에 언급됐지만 표에 시험이 없다']);
  });

  it('표가 없으면 --require-table일 때만 위반', () => {
    assert.equal(pc.checkTable('표 없음').problems.length, 0);
    assert.match(pc.checkTable('표 없음', { requireTable: true }).problems[0], /표가 없다/);
  });

  it('skip·todo 시험은 증거가 아니다', async () => {
    const dir = await fs.mkdtemp(path.join(POC, 'tests', '.tmp-pc-'));
    try {
      const f = path.join(dir, 'x.test.ts');
      await fs.writeFile(f, `it.todo('나중에 할 통제');\nit('있는 통제', () => {});\n`);
      const rel = path.relative(POC, f);
      assert.equal(pc.checkRef(`${rel} > 있는 통제`).ok, true);
      const t = pc.checkRef(`${rel} > 나중에`);
      assert.equal(t.ok, false);
      assert.match(t.problem, /skip·todo/);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('저장소 밖 경로는 거부', () => {
    const r = pc.checkRef(path.join(os.tmpdir(), 'x.test.ts'));
    assert.equal(r.ok, false);
  });
});

describe('승격 점검 (라): 폐기 표지', () => {
  it('import 추출: type 전용은 빼고 정적·동적·재수출·부수효과 import는 넣는다', () => {
    const src = [
      "import type { A } from './a.ts';",
      "import { type B, type C } from './bc.ts';",
      "import { type D, e } from './de.ts';",
      "import f from '../f.js';",
      "export * from './g.ts';",
      "export type { H } from './h.ts';",
      "import './side.ts';",
      "const m = await import('./dyn.ts');",
      "// import x from './commented.ts';",
      "/* import y from './block.ts'; */",
      "const url = 'https://example.com/x'; import z from './z.ts';",
      'import {',
      '  multi,',
      "} from '@sax/engine/core';",
    ].join('\n');
    assert.deepEqual(pc.importsOf(src).sort(), ['../f.js', './de.ts', './dyn.ts', './g.ts', './side.ts', './z.ts', '@sax/engine/core'].sort());
  });

  it('워크스페이스 패키지는 exports의 development 조건(소스)으로 푼다', () => {
    const r = pc.checkMarkers(['packages/engine/src/core/index.ts']);
    assert.ok(r.files > 3);
    const shell = pc.checkMarkers(['apps/desktop/src/shell.ts']);
    assert.ok(shell.files > 20, `셸에서 닿는 파일 ${shell.files}`);
  });

  it('진입점에서 닿는 표지 파일은 체인과 함께 잡고, 닿지 않는 표지 파일은 통과', async () => {
    const dir = await fs.mkdtemp(path.join(POC, 'tests', '.tmp-pc-'));
    try {
      await fs.writeFile(path.join(dir, 'entry.ts'), "import { a } from './mid.ts';\nexport const x = a;\n");
      await fs.writeFile(path.join(dir, 'mid.ts'), "export { a } from './old.ts';\n");
      await fs.writeFile(path.join(dir, 'old.ts'), '// PoC 폐기 대상: W-1 개발 콘솔\nexport const a = 1;\n');
      await fs.writeFile(path.join(dir, 'lonely.ts'), '// PoC 폐기 대상\nexport const b = 2;\n');
      await fs.writeFile(path.join(dir, 'late.ts'), 'export const c = 3;\n// PoC 폐기 대상(첫 줄이 아님)\n');
      const r = pc.checkMarkers([path.join(dir, 'entry.ts')]);
      assert.equal(r.reached.length, 1);
      assert.match(r.reached[0].file, /old\.ts$/);
      assert.deepEqual(r.reached[0].chain.map((c: string) => path.basename(c)), ['entry.ts', 'mid.ts', 'old.ts']);
      assert.equal(pc.hasMarker(path.join(dir, 'late.ts')), false);
      assert.equal(pc.checkMarkers([path.join(dir, 'late.ts')]).reached.length, 0);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('현재 main의 제품 진입점은 표지 파일을 import하지 않는다', () => {
    assert.deepEqual(pc.checkMarkers().reached, []);
  });
});
