import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { LocateResponder } from '@sax/engine';
import type { PackageFiles } from '@sax/engine/core';
import type { Db } from '@sax/db';
import { realDryRun, type Outcome } from './h01-real-dryrun.ts';

const KEY = 'hometax.invoice.form.item1.name';
const REAL_ID = 'mf_txppWframe_genEtxivLsatTop_0_edtLsatNmTop';
const show = (o: Outcome) => `${o.end?.status}/${o.end?.code} steps=${o.steps.join(',')} journal=${o.journal.join(',')}`;

const drift = (files: PackageFiles) => {
  files.selectors.entries[KEY]!.candidates = [{ kind: 'css', value: '#mf_txppWframe_genEtxivLsatTop_0_edtLsatNmTopOld' }];
};

function fakeGateway(): LocateResponder & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async respond(t, req) {
      calls.push(t.id);
      const usage = { inputTokens: 1, outputTokens: 1 };
      if (t.id !== 'selector_repair') return { status: 'incomplete', toolCalls: [], replay: [], usage, reason: 'test:off' } as never;
      const text = String((req.messages[0]!.content[0] as { text: string }).text);
      const line = text.split('\n').find((l) => l.includes('edtLsatNmTop'));
      const id = line?.match(/#(\S+)/)?.[1];
      if (!id) return { status: 'completed', output: { outcome: 'not_found', risk_flags: [], candidates: [] }, toolCalls: [], replay: [], usage } as never;
      return { status: 'completed', output: { outcome: 'repaired', risk_flags: [], candidates: [{ kind: 'css', value: `#${id}`, name: '' }] }, toolCalls: [], replay: [], usage } as never;
    },
  };
}

const HEAL_ROW = 'heal.v1.hometax.invoice.issue';

describe('발급 사다리 0원 칸: 고친 선택자 기억(가짜 홈택스 예행)', () => {
  it('1회차 모델로 고침 → 기억, 2회차 같은 어긋남은 모델 0번·폴백 0번으로 끝까지', async (t) => {
    let saved: string | undefined;
    const g1 = fakeGateway();
    const t1 = Date.now();
    const o1 = await realDryRun({
      loggedIn: true, patchIssue: drift, locate: g1, maxMs: 300_000,
      afterRun: (db: Db) => {
        saved = db.prepare('SELECT value_json FROM settings WHERE key = ?').pluck().get(HEAL_ROW) as string | undefined;
      },
    });
    assert.equal(o1.end?.status, 'success', show(o1));
    assert.ok(o1.journal.includes('locate.found'), show(o1));
    assert.ok(o1.journal.includes('heal.learned'), show(o1));
    assert.ok(g1.calls.filter((c) => c === 'selector_repair').length >= 1);
    assert.ok(saved && JSON.parse(saved).entries[KEY].cand.value === `#${REAL_ID}`, saved);

    const ms1 = Date.now() - t1;
    const g2 = fakeGateway();
    const t2 = Date.now();
    const o2 = await realDryRun({
      loggedIn: true, patchIssue: drift, locate: g2, maxMs: 300_000,
      beforeRun: (db: Db) => void db.prepare('INSERT INTO settings (key, value_json) VALUES (?, ?)').run(HEAL_ROW, saved!),
    });
    const ms2 = Date.now() - t2;
    t.diagnostic(`1회차 ${ms1}ms(재시도 3번 + 위치 찾기 1번), 2회차 ${ms2}ms(기억)`);
    assert.equal(o2.end?.status, 'success', show(o2));
    assert.ok(ms2 < ms1, `2회차가 더 빠르다: ${ms1} → ${ms2}`);
    assert.ok(o2.journal.includes('heal.seeded'), show(o2));
    assert.deepEqual(g2.calls, [], '2회차 모델 호출 없음');
    for (const ev of ['locate.asked', 'fallback.refind', 'fallback.checkpoint', 'judge.applied']) assert.ok(!o2.journal.includes(ev), `${ev} 없음: ${show(o2)}`);
    assert.ok(!o2.steps.some((s) => s.includes('!')), `실패한 스텝 없음: ${o2.steps.join(',')}`);
  });
});
