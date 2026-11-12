// 지난 실행 보기(U5): 엔진 실행 이력 한 줄 → 활동 기록의 지난 실행(종류·문구). 원장이 먼저다.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { RunHistoryRow } from '@sax/engine';
import { pastRun, pastRuns } from '../apps/desktop/src/run-history.ts';

const UNSURE = '발급됐는지 확인하지 못했어요. 홈택스 발급목록을 직접 확인해 주세요. 다시 발급하지 마세요.';
const BEFORE_GATE = '승인 전에 앱이 꺼져 멈췄어요. 아무것도 발급하지 않았어요.';

const row = (o: Partial<RunHistoryRow> = {}): RunHistoryRow => ({
  runId: 'r1',
  playbookId: 'hometax.invoice.issue',
  status: 'success',
  code: null,
  startedAt: '2026-11-11T15:30:00.000Z',
  finishedAt: '2026-11-11T15:32:00.000Z',
  ledger: 'committed',
  approvalNo: '20261112-41000012-00000123',
  documentId: 'doc-1',
  gated: true,
  counterpartyId: 'cp-a',
  counterpartyName: 'A상사',
  supply: 1_000_000,
  tax: 100_000,
  ...o,
});

describe('지난 실행 판정 표(원장 먼저)', () => {
  it('원장 committed → 발급 완료, 승인번호·PDF·합계, KST 날짜·시각', () => {
    assert.deepEqual(pastRun(row()), {
      runId: 'r1', kind: 'issued', who: 'A상사', supply: 1_000_000, tax: 100_000, total: 1_100_000,
      day: '2026-11-12', time: '00:30', approvalNo: '20261112-41000012-00000123', documentId: 'doc-1', note: null,
    });
  });

  it('원장 in_doubt(그리고 기동 뒤엔 나오지 않을 armed·dispatched·observed_manual) → 확인 필요 문구, 승인번호·PDF 없음', () => {
    for (const ledger of ['in_doubt', 'armed', 'dispatched', 'observed_manual', 'some_new_state']) {
      const p = pastRun(row({ ledger, status: 'in_doubt', approvalNo: 'x', documentId: 'y' }));
      assert.deepEqual({ kind: p.kind, note: p.note, approvalNo: p.approvalNo, documentId: p.documentId }, { kind: 'unsure', note: UNSURE, approvalNo: null, documentId: null }, ledger);
    }
  });

  it('원장 not_committed → 발급 안 됨', () => {
    const p = pastRun(row({ ledger: 'not_committed', status: 'failed', code: 'pre_dispatch_mismatch', approvalNo: null, documentId: null }));
    assert.equal(p.kind, 'not_issued');
    assert.match(p.note!, /아무것도 발급되지 않았어요/);
  });

  it('원장 없음 + interrupted + 승인 카드까지 감 → 승인 전에 멈춤', () => {
    const p = pastRun(row({ ledger: null, status: 'interrupted', gated: true, approvalNo: null, documentId: null }));
    assert.deepEqual({ kind: p.kind, note: p.note }, { kind: 'stopped_before_gate', note: BEFORE_GATE });
  });

  it('원장 없음 + interrupted + 승인 카드 전 → 발급 안 됨, 앱이 꺼져 멈춤', () => {
    const p = pastRun(row({ ledger: null, status: 'interrupted', gated: false }));
    assert.equal(p.kind, 'not_issued');
    assert.match(p.note!, /앱이 꺼져 멈췄어요\. 아무것도 발급하지 않았어요/);
  });

  it('원장 없음 + 그 밖 → 발급 안 됨, 끝 코드는 사용자 문구로', () => {
    const p = pastRun(row({ ledger: null, status: 'stopped', code: 'gate.expired' }));
    assert.deepEqual({ kind: p.kind, note: p.note }, { kind: 'not_issued', note: '승인을 기다리다 시간이 지나 멈췄어요. 홈택스에는 아무것도 발급되지 않았어요.' });
  });

  it('모르는 끝 코드는 코드를 보이지 않고 일반 문구', () => {
    const p = pastRun(row({ ledger: null, status: 'failed', code: 'engine.brand_new_code' }));
    assert.equal(p.kind, 'not_issued');
    assert.ok(!p.note!.includes('engine.brand_new_code') && !p.note!.includes('brand_new'), p.note!);
    assert.match(p.note!, /아무것도 발급하지 않았어요/);
  });

  it('원장이 먼저: committed면 실행 상태가 interrupted·stopped여도 발급, in_doubt면 success여도 확인 필요', () => {
    assert.equal(pastRun(row({ status: 'interrupted', gated: true })).kind, 'issued');
    const stopped = pastRun(row({ status: 'stopped', code: 'run.stopped' }));
    assert.equal(stopped.kind, 'issued');
    assert.equal(stopped.note, null, '발급된 실행에 "아무것도 발급되지 않았어요"를 붙이지 않는다');
    assert.equal(pastRun(row({ ledger: 'in_doubt', status: 'success' })).kind, 'unsure');
  });

  it('발급 뒤 단계 코드(PDF 못 받음)는 발급 완료에 문구로 붙는다', () => {
    const p = pastRun(row({ status: 'completed_with_issues', code: 'save_pdf.failed', documentId: null }));
    assert.equal(p.kind, 'issued');
    assert.match(p.note!, /발급은 완료되었어요.*PDF는 받지 못했어요/);
  });

  it('입력 요약을 못 읽으면 거래처·금액은 비운다', () => {
    const p = pastRun(row({ counterpartyName: null, supply: null, tax: null }));
    assert.deepEqual({ who: p.who, total: p.total }, { who: null, total: null });
  });

  it('세금계산서 발급이 아닌 실행은 활동 기록에 넣지 않는다', () => {
    const out = pastRuns([row({ runId: 'a' }), row({ runId: 'b', playbookId: 'hometax.cert.taxpayment' }), row({ runId: 'c', ledger: null, status: 'interrupted' })]);
    assert.deepEqual(out.map((p) => [p.runId, p.kind]), [['a', 'issued'], ['c', 'stopped_before_gate']]);
  });
});
