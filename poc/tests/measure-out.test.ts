// tests/measure-out.ts: 기본 출력은 gitignore된 reports/raw/.local/, 추적 경로는 명시 플래그로만(RETRO A-09).
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { appendMeasure, COMMITTED_DIR, LOCAL_DIR, measurePath, measureRoot, writeMeasure } from './measure-out.ts';

describe('측정 산출물 출력 위치', () => {
  it('기본은 .local, SAX_MEASURE_DIR은 그 경로, SAX_MEASURE_COMMIT=1만 추적 경로', () => {
    assert.equal(measureRoot({}), LOCAL_DIR);
    assert.equal(measureRoot({ SAX_MEASURE_DIR: '/x/y' }), path.resolve('/x/y'));
    assert.equal(measureRoot({ SAX_MEASURE_COMMIT: '1', SAX_MEASURE_DIR: '/x/y' }), COMMITTED_DIR);
    assert.equal(measureRoot({ SAX_MEASURE_COMMIT: 'true' }), LOCAL_DIR);
  });

  it('기본 출력 폴더는 git이 무시한다', () => {
    const probe = path.join(LOCAL_DIR, 'probe.json');
    // 무시되지 않으면 git check-ignore가 1로 끝나 예외가 난다.
    assert.doesNotThrow(() => execFileSync('git', ['check-ignore', '-q', probe], { cwd: path.dirname(COMMITTED_DIR), stdio: 'pipe' }));
  });

  it('이름이 출력 폴더 밖을 가리키면 거부', () => {
    assert.throws(() => measurePath('../x.json', {}), /밖/);
    assert.throws(() => measurePath('/etc/passwd', { SAX_MEASURE_DIR: '/tmp/m' }), /밖/);
    assert.throws(() => measurePath('', {}), /밖/);
    assert.equal(measurePath('poc-6/shell/a.json', {}), path.join(LOCAL_DIR, 'poc-6', 'shell', 'a.json'));
  });

  it('jsonl은 프로세스에서 처음 쓸 때 비운다(누적 없음), JSON은 덮어쓴다', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sax-measure-'));
    // SAX_MEASURE_COMMIT가 켜져 있으면 추적 경로가 이기므로(위치 규칙 1) 시험 동안 끈다.
    const prev = process.env.SAX_MEASURE_DIR;
    const prevCommit = process.env.SAX_MEASURE_COMMIT;
    delete process.env.SAX_MEASURE_COMMIT;
    process.env.SAX_MEASURE_DIR = dir;
    try {
      await fs.writeFile(path.join(dir, 'a.jsonl'), 'old\n');
      await appendMeasure('a.jsonl', { n: 1 });
      await appendMeasure('a.jsonl', { n: 2 });
      assert.equal(await fs.readFile(path.join(dir, 'a.jsonl'), 'utf8'), '{"n":1}\n{"n":2}\n');
      await writeMeasure('sub/b.json', { v: 1 });
      await writeMeasure('sub/b.json', { v: 2 });
      assert.deepEqual(JSON.parse(await fs.readFile(path.join(dir, 'sub', 'b.json'), 'utf8')), { v: 2 });
    } finally {
      if (prev === undefined) delete process.env.SAX_MEASURE_DIR;
      else process.env.SAX_MEASURE_DIR = prev;
      if (prevCommit !== undefined) process.env.SAX_MEASURE_COMMIT = prevCommit;
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
