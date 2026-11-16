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
const shard = process.env.SAX_TEST_SHARD ? [`--test-shard=${process.env.SAX_TEST_SHARD}`] : [];
// 시험이 다 끝났는데 열린 핸들(닫지 못한 서버 등)로 파일이 안 끝나 잡 전체가 타임아웃까지 멈추지 않게 강제 종료하고,
// 시험 하나가 멈춰도 상한(기본 10분)에서 실패로 끝낸다.
const timeout = ['--test-force-exit', `--test-timeout=${process.env.SAX_TEST_TIMEOUT_MS || 600000}`];
const r = spawnSync(process.execPath, ['--conditions=development', '--test', `--test-concurrency=${concurrency}`, ...timeout, ...shard, ...chosen], { cwd: root, stdio: 'inherit' });
process.exit(r.status ?? 1);
