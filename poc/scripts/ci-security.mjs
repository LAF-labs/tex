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
const r = spawnSync(process.execPath, ['--conditions=development', '--test', '--test-concurrency=1', '--test-timeout=120000', ...chosen], { cwd: root, stdio: 'inherit' });
process.exit(r.status ?? 1);
