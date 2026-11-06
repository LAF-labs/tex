// S7 회귀 스크립트(D04 §9, D14 M3-7)가 모의 모드에서 끝까지 돌고 게이트 판정을 내는지 확인한다.
// 정확도 수치 자체는 모의 서버의 키워드 응답이라 의미가 없다(실측은 키가 있을 때 scripts/s7-regression.ts).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));

describe('S7 회귀 스크립트(모의)', () => {
  const run = (n: number) => {
    const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 's7-')), 's7.json');
    const env = { ...process.env };
    delete env.OPENAI_API_KEY;
    delete env.OPENROUTER_API_KEY;
    // --gate 없이: 모의 답의 합격 여부는 의미가 없고, 판정 계산만 본다.
    const r = spawnSync(process.execPath, ['--conditions=development', 'scripts/s7-regression.ts', '--mock', `--n=${n}`, `--out=${out}`], { cwd: root, env, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    return JSON.parse(fs.readFileSync(out, 'utf8'));
  };

  it('결과 라벨별 라운드 로빈 표본, 게이트 판정, 의도 구간은 모의에서 생략', () => {
    const j = run(21);
    assert.equal(j.mode, 'mock');
    assert.equal(j.bundle, 'screen_state_v2');
    assert.equal(j.n, 21);
    assert.equal(j.pass, j.accuracy >= 0.98 && j.recall.blocked >= 0.99 && j.recall.captcha >= 0.99, '게이트 = 정확도 ≥ 98%, blocked·captcha 재현율 ≥ 99%');
    assert.equal(Object.keys(j.confusion).length, 7, '결과 라벨 7종이 모두 표본에 든다');
    assert.ok(j.recall.blocked !== null && j.recall.captcha !== null);
    assert.equal(j.intent, null);
    assert.equal(j.costUsd < 0.5, true);
  });

  it('결과 칸 안에서 템플릿을 번갈아 뽑아 기본 100장이 이 번들의 템플릿을 모두 덮는다', () => {
    const j = run(100);
    assert.equal(j.n, 100);
    assert.equal(j.templates.sampled, j.templates.total);
  });
});
