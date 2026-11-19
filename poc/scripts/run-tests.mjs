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
// 기본은 파일 하나씩(로컬 개발 기본값). CI는 SAX_TEST_CONCURRENCY로 파일 병렬, SAX_TEST_SHARD=i/n으로 잡을 나눈다.
const concurrency = process.env.SAX_TEST_CONCURRENCY || '1';
// 잡 나누기는 node --test-shard(파일 순번)가 아니라 파일별 시간(tests/test-durations.json, Windows CI 실측 초)으로
// 가장 긴 파일부터 가장 가벼운 잡에 넣는다. 표에 없는 파일은 2초로 친다. 표가 낡아도 균형만 조금 틀어질 뿐 모든 파일은 한 잡에서 돈다.
// 표 갱신: node scripts/test-durations.mjs <Windows 잡 로그…>
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
// 파일 없이 node --test를 부르면 기본 탐색으로 전부 돈다. 빈 잡은 그냥 끝낸다.
if (!run.length) process.exit(0);
// 시험이 다 끝났는데 열린 핸들(닫지 못한 서버 등)로 파일이 안 끝나 잡 전체가 타임아웃까지 멈추지 않게 강제 종료하고,
// 시험 하나가 멈춰도 상한(기본 10분)에서 실패로 끝낸다.
const timeout = ['--test-force-exit', `--test-timeout=${process.env.SAX_TEST_TIMEOUT_MS || 600000}`];
const r = spawnSync(process.execPath, ['--conditions=development', '--test', `--test-concurrency=${concurrency}`, ...timeout, ...run], { cwd: root, stdio: 'inherit' });
process.exit(r.status ?? 1);
