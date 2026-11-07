// RETRO A-14 공급망: 루트 pnpm 작업 공간의 package.json 의존성은 정확 버전(1.2.3, 1.2.3-rc.1) 또는 workspace:*만 쓴다.
// 범위(^·~·>=·*·x·latest·태그)가 다시 들어오면 잠금 파일을 새로 풀 때 검토 안 된 판이 들어올 수 있다. minimumReleaseAge(pnpm-workspace.yaml)와 짝.
// apps/mobile은 루트 작업 공간·잠금 파일 밖이다(pnpm-workspace.yaml '!apps/mobile', Expo SDK가 ~ 범위를 쓴다). 폰 앱 트랙 몫으로 따로 둔다.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

const root = path.resolve(import.meta.dirname, '../..');
const FIELDS = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'] as const;
const EXACT = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;
const okSpec = (v: string) => EXACT.test(v) || v === 'workspace:*';

function manifests(): string[] {
  const out = execFileSync('git', ['ls-files', '--', 'package.json', '*/package.json'], { cwd: root, encoding: 'utf8' });
  return out.split('\n').filter(Boolean).filter((f) => !f.startsWith('apps/mobile/') && !f.includes('node_modules/'));
}

describe('A-14 의존성 정확 버전', () => {
  it('판정 함수 대조: 범위·태그는 거부, 정확 버전·workspace:*만 통과', () => {
    for (const v of ['^1.0.0', '~1.2.3', '>=1.0.0', '*', '1.x', '1', '1.2', 'latest', 'next', '1.0.0 - 2.0.0', 'workspace:^', 'github:a/b', 'file:../x']) assert.equal(okSpec(v), false, v);
    for (const v of ['1.2.3', '45.1.0', '1.0.0-rc.1', 'workspace:*']) assert.equal(okSpec(v), true, v);
  });

  it('루트 작업 공간 package.json에 범위 지정 의존성이 없다', () => {
    const files = manifests();
    assert.ok(files.includes('package.json'), '루트 package.json을 찾지 못함');
    assert.ok(files.length > 5, `package.json이 너무 적다(${files.length})`);
    const bad: string[] = [];
    for (const f of files) {
      const p = JSON.parse(fs.readFileSync(path.join(root, f), 'utf8')) as Record<string, Record<string, string> | undefined>;
      for (const k of FIELDS) for (const [n, v] of Object.entries(p[k] ?? {})) if (!okSpec(v)) bad.push(`${f} ${k} ${n}@${v}`);
    }
    assert.deepEqual(bad, [], '정확 버전으로 고정한다(잠금 파일이 해석한 판, RETRO A-14)');
  });
});
