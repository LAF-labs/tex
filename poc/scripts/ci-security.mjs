// 보안 스위트 실행기(D14 M5-1, D13 §1 "전용 스위트, 릴리스 필수"). tests/security/**/*.sec.ts를 development 조건으로 돌린다.
// pnpm test(*.test.ts)와 분리한다: 퍼징·실브라우저 누출 시험이 길고, 릴리스 게이트로 따로 본다.
// 사용: node scripts/ci-security.mjs [이름 일부...]   환경 변수: SAX_FUZZ_ITER(기본 300), SAX_FUZZ_SEED
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const dir = path.join(root, 'tests', 'security');
const files = [];
const walk = (d) => {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p);
    else if (e.name.endsWith('.sec.ts')) files.push(path.relative(root, p));
  }
};
if (fs.existsSync(dir)) walk(dir);
const filter = process.argv.slice(2);
const chosen = (filter.length ? files.filter((f) => filter.some((x) => f.includes(x))) : files).sort();
if (!chosen.length) {
  console.error('보안 스위트 파일 없음');
  process.exit(1);
}
const r = spawnSync(process.execPath, ['--conditions=development', '--test', '--test-concurrency=1', ...chosen], { cwd: root, stdio: 'inherit' });
process.exit(r.status ?? 1);
