import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { promisify } from 'node:util';
import { ACTS, DOMAINS, ROUTE_CASES, routeCaseProblems } from './chat-eval/route/cases.ts';
import { scoreRoute, type RouteRow } from './chat-eval/route/score.ts';

const run = promisify(execFile);
const TOOL = path.join(import.meta.dirname, 'chat-eval/route/run.ts');
const node = (args: string[]) => run(process.execPath, ['--conditions=development', TOOL, ...args], { env: { PATH: process.env.PATH ?? '' }, timeout: 60_000 });
const OPTS = { fineAct: true, domain: true, corrects: true, advice: true };
const perfect = (): RouteRow[] => ROUTE_CASES.map((c) => ({ id: c.id, act: { got: c.act, conf: 0.95 }, domain: { got: c.domain, conf: 0.95 }, corrects: c.corrects ? 0.9 : 0.1, advice: c.advice ? 0.9 : 0.1, ms: 400, inputTokens: 3000 }));

describe('대화 판정 평가 A층', () => {
  it('라벨 세트: 300건 이상, 라벨 규칙을 지키고, 모든 act·domain과 정정·폰·세무 섞임 사례가 있다', () => {
    assert.ok(ROUTE_CASES.length >= 300, String(ROUTE_CASES.length));
    assert.deepEqual(routeCaseProblems(), []);
    for (const a of ACTS) assert.ok(ROUTE_CASES.some((c) => c.act === a), a);
    for (const d of DOMAINS) assert.ok(ROUTE_CASES.some((c) => c.domain === d), d);
    assert.ok(ROUTE_CASES.filter((c) => c.corrects).length >= 20);
    assert.ok(ROUTE_CASES.filter((c) => c.ctx.device === 'phone').length >= 20);
    assert.ok(ROUTE_CASES.some((c) => c.act === 'task' && c.advice));
    assert.ok(ROUTE_CASES.some((c) => c.act === 'task' && !c.corrects && (c.ctx.cards.length || c.ctx.pending)));
  });

  it('채점: 다 맞으면 관문 셋을 지나고, 발급 요청을 잡담으로 확신하면 놓침, 확신이 낮으면 unsure로 센다', () => {
    const s = scoreRoute(ROUTE_CASES, perfect(), OPTS);
    assert.deepEqual([s.joint, s.gate.issueMiss, s.gate.falseOpen, s.sure?.unsure, s.corrects?.accuracy], [1, 0, 0, 0, 1]);
    const issue = ROUTE_CASES.find((c) => c.act === 'task' && c.domain === 'invoice')!;
    const small = ROUTE_CASES.find((c) => c.act === 'smalltalk')!;
    const rows = perfect().map((r) => (r.id === issue.id ? { ...r, act: { got: 'smalltalk', conf: 0.9 } } : r.id === small.id ? { ...r, act: { got: 'task', conf: 0.5 } } : r));
    const t = scoreRoute(ROUTE_CASES, rows, OPTS);
    assert.ok(t.gate.issueMiss! > 0);
    assert.equal(t.gate.falseOpen, 0);
    assert.ok(t.sure!.unsure! > 0);
  });

  it('러너: --estimate는 모델 없이 세 대상의 예상 비용을, --fake는 배선과 보고서를 낸다', async () => {
    for (const target of ['draft', 'intent', 'agent']) {
      const r = await node([`--target=${target}`, '--estimate']);
      const e = JSON.parse(r.stdout) as { calls: number; usd: number };
      assert.equal(e.calls, ROUTE_CASES.length);
      assert.ok(e.usd > 0 && e.usd < 2, `${target} ${e.usd}`);
    }
    const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'chat-eval-route-'));
    try {
      const out = path.join(dir, 'r.json');
      await node(['--target=draft', '--fake', '--limit=5', `--out=${out}`]);
      const rep = JSON.parse(fs.readFileSync(out, 'utf8')) as { summary: { model: string; score: { n: number; errors: number } }; rows: RouteRow[] };
      assert.deepEqual([rep.summary.model, rep.summary.score.n, rep.summary.score.errors, rep.rows.length], ['fake', 5, 0, 5]);
      assert.deepEqual([rep.rows[0]!.act, rep.rows[0]!.domain, rep.rows[0]!.corrects, rep.rows[0]!.advice], [{ got: 'task', conf: 0.9 }, { got: 'invoice', conf: 0.9 }, 0.1, 0.05]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
