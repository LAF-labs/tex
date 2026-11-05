// S7 회귀 스크립트(D04 §9, D14 M3-7)가 모의 모드에서 끝까지 돌고 게이트 판정을 내는지 확인한다.
// 정확도 수치 자체는 모의 서버의 키워드 응답이라 의미가 없다(실측은 키가 있을 때 scripts/s7-regression.ts).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

const root = new URL('..', import.meta.url).pathname;

describe('S7 회귀 스크립트(모의)', () => {
  it('결과 라벨별 라운드 로빈 표본, 게이트 판정, 의도 구간은 모의에서 생략', () => {
    const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 's7-')), 's7.json');
    const env = { ...process.env };
    delete env.OPENAI_API_KEY;
    const r = spawnSync(process.execPath, ['--conditions=development', 'scripts/s7-regression.ts', '--mock', '--n=21', '--gate', `--out=${out}`], { cwd: root, env, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    const j = JSON.parse(fs.readFileSync(out, 'utf8'));
    assert.equal(j.mode, 'mock');
    assert.equal(j.bundle, 'screen_state_v2');
    assert.equal(j.n, 21);
    assert.equal(j.pass, true);
    assert.equal(Object.keys(j.confusion).length, 7, '결과 라벨 7종이 모두 표본에 든다');
    assert.ok(j.recall.blocked !== null && j.recall.captcha !== null);
    assert.equal(j.intent, null);
    assert.equal(j.costUsd < 0.5, true);
  });
});
