import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { GatewayJudgeModel, GatewayLocateModel, GatewayVisionModel, RehearsalReport, type LocateResponder } from '@sax/engine';
import { ESCALATION, estimateKrw } from '@sax/engine/core';
import type { MaskedShot, RunToken } from '@sax/model';
import { Redactor } from '@sax/redaction';

describe('계정 AI 한도와 칸 비용', () => {
  it('한 칸이 daily_limit을 받으면 같은 실행의 다른 유료 칸은 부르지 않는다(한 번만 저널)', async () => {
    const calls: string[] = [];
    const responder: LocateResponder = {
      async respond(t) {
        calls.push(t.id);
        return { status: 'incomplete', toolCalls: [], replay: [], usage: { inputTokens: 0, outputTokens: 0 }, reason: 'gateway:daily_limit' } as never;
      },
    };
    const journal: Array<[string, unknown]> = [];
    const day = { spent: false };
    const redactor = new Redactor({ runId: 'r1' });
    const base = { responder, redactor, runToken: async () => 'rt' as RunToken, journal: (t: string, p?: unknown) => void journal.push([t, p]) };
    const judge = new GatewayJudgeModel({ ...base, budget: { spent: false, day } });
    const locate = new GatewayLocateModel({ ...base, budget: { spent: false, day } });
    const vision = new GatewayVisionModel({ ...base, budget: { spent: false, day } });
    assert.equal(await judge.judge({ stepId: 's1', step: 'fill x', cause: 'step.selector_miss', dialog: null, lastNotice: null, screen: [], fields: [] }), null);
    assert.equal(day.spent, true);
    assert.equal(await locate.propose({ stepId: 's1', key: 'k', purpose: 'fill', role: 'textbox', namePattern: '^a$', describe: 'k', listing: [{ n: 1, name: 'a', id: null }], rejected: [] }), null);
    assert.equal(await vision.next({ goal: [], history: [], shot: { url: 'data:image/jpeg;base64,AA' as MaskedShot, width: 10, height: 10 } }), null);
    assert.deepEqual(calls, ['page_judge']);
    assert.equal(journal.filter(([t]) => t === 'ai.account_limit').length, 1);
    assert.ok(journal.some(([t, p]) => t === 'locate.unavailable' && (p as { cause: string }).cause === 'account_limit'));
  });

  it('칸 표: 0원 칸(기억·재시도·다시 걷기·다시 찾기)이 유료 칸보다 앞이고, 사람이 끝', () => {
    const ids = ESCALATION.map((r) => r.id);
    const firstPaid = ESCALATION.findIndex((r) => r.krw > 0);
    for (const free of ['script', 'heal', 'retry', 'replay', 'refind']) assert.ok(ids.indexOf(free) < firstPaid, free);
    assert.deepEqual(ids.slice(-1), ['human']);
    const paid = ESCALATION.filter((r) => r.krw > 0).map((r) => r.krw);
    assert.deepEqual(paid, [...paid].sort((a, b) => a - b), '유료 칸은 싼 것부터');
  });

  it('예행 보고서: 칸 단가로 추정 금액(est_krw)', () => {
    const r = new RehearsalReport('local:x', () => 0);
    for (const t of ['locate.asked', 'judge.applied', 'agent.action', 'agent.action', 'computer_use.action', 'decide.result', 'heal.seeded', 'agentpath.replayed']) r.journal(t);
    const f = r.fields('r1', { status: 'success' });
    assert.equal(f.est_krw, estimateKrw({ locate: 1, judge: 1, agent: 2, vision: 1, decide: 1 }));
    assert.equal(f.heal, 1);
    assert.equal(f.replay, 1);
    assert.ok(Number(f.est_krw) > 0);
  });
});
