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
const concurrency = process.env.SAX_TEST_CONCURRENCY || '1';
const pick = (list, spec) => {
  const m = /^(\d+)\/(\d+)$/.exec(spec);
  if (!m || +m[1] < 1 || +m[1] > +m[2]) throw new Error(`SAX_TEST_SHARD=${spec}: i/n 꼴이어야 한다`);
  const [i, n] = [+m[1], +m[2]];
  let w = {};
  try {
    w = JSON.parse(fs.readFileSync(path.join(root, 'tests', 'test-durations.json'), 'utf8'));
  } catch {
    // 표가 없으면 모두 같은 무게
  }
  const norm = (f) => f.split(path.sep).join('/');
  const weight = (f) => w[norm(f)] ?? 2;
  const load = Array(n).fill(0);
  const out = [];
  for (const f of [...list].sort((a, b) => weight(b) - weight(a) || (norm(a) < norm(b) ? -1 : 1))) {
    const k = load.indexOf(Math.min(...load));
    load[k] += weight(f);
    if (k === i - 1) out.push(f);
  }
  console.log(`잡 ${i}/${n}: 파일 ${out.length}개, 예상 ${load[i - 1]}초(합, 동시 실행 전)`);
  return out;
};
const run = process.env.SAX_TEST_SHARD ? pick(chosen, process.env.SAX_TEST_SHARD) : chosen;
if (!run.length) process.exit(0);
const timeout = ['--test-force-exit', `--test-timeout=${process.env.SAX_TEST_TIMEOUT_MS || 600000}`];
const r = spawnSync(process.execPath, ['--conditions=development', '--test', `--test-concurrency=${concurrency}`, ...timeout, ...run], { cwd: root, stdio: 'inherit' });
process.exit(r.status ?? 1);
