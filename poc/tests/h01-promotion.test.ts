// h01 공용 부분 이동(ADR-035 승격 점검 (라), 팀장 결정 2026-11-07 (가)): 제품 모듈은 h01을 import하지 않고,
// h01에 남은 것은 PoC 실행기(runner.ts)·PoC 플레이북(playbook.ts)뿐이다. 그 둘은 RunService IR 전환 PR까지 runs.ts가 쓴다.
// 음성 시험: h01/runner.ts 첫 줄에 '// PoC 폐기 대상' 표지를 잠시 붙이면 점검(라)가 제품 진입점 → runs.ts → runner.ts를 실제로 잡는다.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
// @ts-expect-error 타입 선언 없는 .mjs 스크립트
import * as pc from '../scripts/ci-promotion-check.mjs';

const POC = path.resolve(import.meta.dirname, '..');
const SRC = path.join(POC, 'packages/engine/src');
const ENTRY = 'packages/engine/src/entry.ts';

/** 파일 첫 줄에 표지를 붙인 채로 f를 돌리고, 끝나면 바이트 그대로 되돌린다. */
function withMarker<T>(file: string, f: () => T): T {
  const orig = fs.readFileSync(file);
  fs.writeFileSync(file, Buffer.concat([Buffer.from('// PoC 폐기 대상: 시험용 임시 표지\n'), orig]));
  try {
    return f();
  } finally {
    fs.writeFileSync(file, orig);
  }
}

describe('h01 공용 부분 이동(승격 점검 (라))', () => {
  it('h01에는 PoC 실행기·플레이북만 남는다', () => {
    assert.deepEqual(fs.readdirSync(path.join(SRC, 'h01')).sort(), ['playbook.ts', 'runner.ts']);
  });

  it('h01 밖 엔진 소스에서 h01을 import하는 곳은 runs.ts(RunService)와 공개 index.ts뿐이다', () => {
    const users: string[] = [];
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) {
          if (e.name !== 'h01') walk(p);
        } else if (/\.ts$/.test(e.name) && /from '\.{1,2}\/(?:\.\.\/)*h01\//.test(fs.readFileSync(p, 'utf8'))) users.push(path.relative(SRC, p).split(path.sep).join('/'));
      }
    };
    walk(SRC);
    assert.deepEqual(users.sort(), ['index.ts', 'runs.ts']);
  });

  it('음성: runner.ts에 표지를 붙이면 점검(라)가 제품 진입점 → runs.ts → runner.ts를 잡는다', () => {
    const runner = path.join(SRC, 'h01/runner.ts');
    const r = withMarker(runner, () => pc.checkMarkers([ENTRY]));
    assert.equal(r.reached.length, 1);
    assert.equal(r.reached[0].file, 'packages/engine/src/h01/runner.ts');
    assert.deepEqual(r.reached[0].chain.slice(0, 2), [ENTRY, 'packages/engine/src/runs.ts']);
    assert.equal(pc.checkMarkers([ENTRY]).reached.length, 0, '표지를 되돌리면 통과');
  });

  it('음성: 옮긴 공용 모듈(signals·portal·run-end·aria-tree)은 h01을 거치지 않는다: playbook.ts에 표지를 붙여도 체인에 공용 모듈이 없다', () => {
    const r = withMarker(path.join(SRC, 'h01/playbook.ts'), () => pc.checkMarkers([ENTRY]));
    assert.ok(r.reached.length >= 1);
    for (const x of r.reached) {
      assert.ok(x.chain.includes('packages/engine/src/runs.ts'), x.chain.join(' → '));
      for (const m of ['signals.ts', 'portal.ts', 'run-end.ts', 'driver/aria-tree.ts', 'enforcer.ts', 'policy.ts', 'driver/reader.ts'])
        assert.ok(!x.chain.slice(0, -1).includes(`packages/engine/src/${m}`), `${m}가 h01로 가는 체인에 있다: ${x.chain.join(' → ')}`);
    }
  });
});
