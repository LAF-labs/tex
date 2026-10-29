// S9 스크립트 모의 모드: 키 없이 같은 어댑터·egress 경로로 끝까지 돌고, 결과 파일에 키가 남지 않는다.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { it } from 'node:test';

it('scripts/s9-decisions.ts --mock: 측정 항목이 모두 채워지고 비용 상한 안', () => {
  const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sax-s9-')), 's9.json');
  const env = { ...process.env, OPENAI_API_KEY: 'sk-should-not-be-used-or-written' };
  const r = spawnSync(process.execPath, ['--conditions=development', 'scripts/s9-decisions.ts', '--mock', '--reps=2', `--out=${out}`], { cwd: path.resolve(import.meta.dirname, '..'), env, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const raw = fs.readFileSync(out, 'utf8');
  assert.doesNotMatch(raw, /sk-should-not-be-used/);
  const d = JSON.parse(raw);
  assert.equal(d.mode, 'mock');
  assert.equal(d.cache.length, 3);
  assert.ok(d.cache[1].cachedTokens > 0);
  assert.equal(d.refusal.screens, 20);
  assert.deepEqual(d.latency.map((l: { questions: number }) => l.questions), [2, 5, 10]);
  assert.ok(d.rateLimit.headerNames.includes('x-ratelimit-remaining-requests'));
  assert.deepEqual([d.replay.turn1.status, d.replay.turn2.status], ['completed', 'completed']);
  assert.ok(d.calls.costUsd < 2);
  assert.deepEqual(d.errors, []);
});
