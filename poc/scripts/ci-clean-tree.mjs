// 테스트 뒤 작업 트리가 깨끗한지 본다(RETRO A-09, B-01). 시험이 추적 파일을 고치면 이름을 찍고 1로 끝난다.
// 측정 산출물은 tests/measure-out.ts로 reports/raw/.local/(gitignore) 또는 SAX_MEASURE_DIR에 써야 한다.
// 사용: node scripts/ci-clean-tree.mjs [--warn]   (--warn: 찍기만 하고 0으로 끝난다. 로컬 확인용, CI는 쓰지 않는다 — measure-out 넷 머지 뒤 2026-11-07)
import { execFileSync } from 'node:child_process';
import path from 'node:path';

const repo = path.resolve(import.meta.dirname, '..', '..');
const out = execFileSync('git', ['status', '--porcelain=v1', '--untracked-files=all'], { cwd: repo, encoding: 'utf8' });
const dirty = out.split('\n').filter(Boolean);
if (!dirty.length) {
  console.log('작업 트리 깨끗함');
  process.exit(0);
}
const warn = process.argv.includes('--warn');
console.log(`${warn ? '경고' : '실패'}: 시험이 작업 트리를 바꿨다(${dirty.length}개). tests/measure-out.ts를 쓰도록 고쳐야 한다.`);
for (const l of dirty) console.log(`  ${l}`);
if (process.env.GITHUB_ACTIONS) {
  for (const l of dirty) console.log(`::${warn ? 'warning' : 'error'} file=${l.slice(3)}::시험 실행 뒤 바뀐 파일(측정 산출물 격리, RETRO A-09)`);
}
process.exit(warn ? 0 : 1);
