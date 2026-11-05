// M1-1 린트 경계: 위반 예제 파일(tests/fixtures/lint-violations/*.ts.txt)을 머리말 경로에 있는 것처럼 검사해
// 우회 import(D01 §3)·공급사 SDK(ADR-015)·비밀 직렬화(D05 §2)·RedactedText 단언(D06 §8)을 규칙별 개수까지 잡는지 본다.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { ESLint } from 'eslint';
import { isSecretName, words } from '../eslint-rules/no-secret-stringify.mjs';

const root = path.resolve(import.meta.dirname, '..');
const dir = path.join(root, 'tests/fixtures/lint-violations');

interface Case {
  file: string;
  as: string;
  expect: Record<string, number>;
  source: string;
}

function readCases(): Case[] {
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.ts.txt'))
    .sort()
    .map((file) => {
      const source = fs.readFileSync(path.join(dir, file), 'utf8');
      const as = /^\/\/ as: (\S+)$/m.exec(source)?.[1];
      const ex = /^\/\/ expect: (.+)$/m.exec(source)?.[1]?.trim();
      assert.ok(as && ex, `${file}: 머리말(as·expect)`);
      const expect: Record<string, number> = {};
      if (ex !== 'none')
        for (const part of ex.split(',')) {
          const [rule, n] = part.trim().split('=');
          expect[rule!] = Number(n);
        }
      return { file, as, expect, source };
    });
}

function count(messages: ESLint.LintResult['messages']): Record<string, number> {
  const out: Record<string, number> = {};
  for (const m of messages) {
    const k = m.ruleId ?? `fatal:${m.message}`;
    out[k] = (out[k] ?? 0) + 1;
  }
  return out;
}

describe('M1-1 린트 경계(위반 예제)', () => {
  const cases = readCases();
  const eslint = new ESLint({ cwd: root });

  it('예제가 충분하다: 송신 우회·SDK·비밀 직렬화·브랜드 단언·정상 경로', () => {
    assert.ok(cases.length >= 10, String(cases.length));
    const rules = new Set(cases.flatMap((c) => Object.keys(c.expect)));
    for (const r of ['no-restricted-imports', 'no-restricted-globals', 'no-restricted-syntax', 'sax/no-secret-stringify']) assert.ok(rules.has(r), r);
    assert.ok(cases.some((c) => !Object.keys(c.expect).length), '오류 없는 정상 예제');
  });

  for (const c of cases) {
    it(`${c.file} → ${c.as}`, async () => {
      const [r] = await eslint.lintText(c.source, { filePath: path.join(root, c.as) });
      assert.deepEqual(count(r!.messages), c.expect, JSON.stringify(r!.messages.map((m) => [m.line, m.ruleId, m.message])));
    });
  }

  it('예제 파일은 eslint . 대상이 아니다(.txt), 실제 저장소 파일은 오류 0', async () => {
    assert.equal(await eslint.isPathIgnored(path.join(dir, 'secret-stringify.ts.txt')), true, '.txt는 설정 밖');
    const results = await eslint.lintFiles(['packages/model/src', 'packages/net/src', 'packages/redaction/src']);
    const errors = results.flatMap((r) => r.messages.map((m) => `${path.relative(root, r.filePath)}:${m.line} ${m.ruleId}`));
    assert.deepEqual(errors, []);
    assert.ok(!results.some((r) => r.filePath.endsWith('.txt')));
  });

  it('비밀 이름 판정: 값 이름만 잡고 메타 이름은 통과', () => {
    assert.deepEqual(words('certPasswordBytes'), ['cert', 'password', 'bytes']);
    assert.deepEqual(words('OTP_value'), ['otp', 'value']);
    for (const n of ['secret', 'certPassword', 'secretBytes', 'pin', 'passwordValue', 'otpText', 'SECRET_BUF']) assert.equal(isSecretName(n), true, n);
    for (const n of ['secretKind', 'secretTitle', 'passwordField', 'SecretWindow', 'pinned', 'spinner', 'secretSlot', 'kind', 'bytes']) assert.equal(isSecretName(n), false, n);
  });
});
