// node --test 실행기: 모든 *.test.ts를 development 조건(소스 직접 실행)으로 돌린다.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const files = [];
const walk = (d) => {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === 'dist' || e.name.startsWith('.')) continue;
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p);
    else if (e.name.endsWith('.test.ts')) files.push(path.relative(root, p));
  }
};
walk(root);
const filter = process.argv.slice(2);
const chosen = filter.length ? files.filter((f) => filter.some((x) => f.includes(x))) : files;
const r = spawnSync(process.execPath, ['--conditions=development', '--test', '--test-concurrency=1', ...chosen], { cwd: root, stdio: 'inherit' });
process.exit(r.status ?? 1);
