// 폰 대화 실모델 평가 도구(tests/chat-eval/phone.ts)의 배선 시험. 가짜 상류(--fake)로 돈다: 키도 네트워크도 쓰지 않는다.
// 보는 것: 폰 대화 코어 → PhoneGateway → 평가 도구의 게이트웨이 자리 → (가짜) 상류로 한 턴이 돌고, 화면 기준 채점과 보고서가 나온다.
// 실제 모델 결과는 여기서 보지 않는다(맥북에서 한두 사례씩 돌린다).
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { promisify } from 'node:util';
import { PHONE_CASES } from './chat-eval/phone-cases.ts';

const run = promisify(execFile);
const TOOL = path.join(import.meta.dirname, 'chat-eval/phone.ts');
const node = (args: string[]) => run(process.execPath, ['--conditions=development', TOOL, ...args], { env: { PATH: process.env.PATH ?? '' }, timeout: 60_000 });

describe('폰 대화 평가 도구(chat-eval 폰 방식)', () => {
  it('가짜 상류로 한 사례가 끝까지 돈다: 가린 글만 나가고, 카드가 생기고, 보고서에 호출·화면 문장·채점이 남는다', async () => {
    const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'chat-eval-phone-'));
    try {
      const out = path.join(dir, 'report.json');
      const r = await node(['--fake', '--only=p-issue-basic', '--show-input', `--out=${out}`]);
      assert.match(r.stdout, /PASS \[1\] p-issue-basic/);
      assert.match(r.stdout, /사용자: \[NAME_\d+\] \[AMT_\d+\] 세금계산서 끊어줘/);
      const sent = r.stdout.slice(r.stdout.indexOf('[모델에 보낸 글'), r.stdout.indexOf('[보낸 글 끝]'));
      assert.ok(sent.includes('[사실]') && !sent.includes('한빛상사') && !sent.includes('110만'), sent);
      const report = JSON.parse(fs.readFileSync(out, 'utf8')) as { summary: { pass: number; all: number }; cases: Array<{ turns: Array<{ tools: string[]; created: Array<{ name: string; amount: number }>; calls: unknown[] }> }> };
      assert.deepEqual([report.summary.pass, report.summary.all], [1, 1]);
      const turn = report.cases[0]!.turns[0]!;
      assert.deepEqual([turn.tools, turn.created.map((d) => [d.name, d.amount]), turn.calls.length], [['invoice_draft'], [['한빛상사', 1_100_000]], 2]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('사례를 고르지 않으면 돌리지 않는다(한두 사례씩 돌리는 도구다). 없는 사례 이름도 거절한다', async () => {
    for (const args of [['--fake'], ['--fake', '--only=없는사례']]) {
      const r = await node(args).then(() => null, (e: { code?: number; stderr?: string }) => e);
      assert.equal(r?.code, 2, JSON.stringify(args));
    }
    const list = await node(['--list']);
    assert.equal(list.stdout.trim().split('\n').length, PHONE_CASES.length);
  });

  it('사례 ID는 겹치지 않는다', () => {
    assert.equal(new Set(PHONE_CASES.map((c) => c.id)).size, PHONE_CASES.length);
  });
});
