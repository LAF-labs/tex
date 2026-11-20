import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { piiTripwire } from '@sax/net';
import { buildCorpus } from './fixtures/redaction-corpus.ts';
import { measure } from './fixtures/redaction-measure.ts';

describe('마스킹 코퍼스(D06 §7)', () => {
  for (const seed of [undefined, 7]) {
    it(`10,000건 누락 0, 출력 트립와이어 0 (seed ${seed ?? 'default'})`, () => {
      const m = measure(10_000, seed);
      assert.equal(m.total, 10_000);
      assert.equal(m.miss, 0, JSON.stringify(m.misses.slice(0, 5), null, 1));
      assert.equal(m.tripwireAfter, 0);
      assert.ok(m.rows.length >= 120, `종류×변형 ${m.rows.length}`);
      assert.deepEqual(m.benign.changed, []);
    });
  }

  it('코퍼스 원문의 숫자형 식별자는 트립와이어가 잡는다(마스킹 우회 시 egress가 막는다)', () => {
    const corpus = buildCorpus(2_000);
    let raw = 0;
    let caught = 0;
    for (const c of corpus) {
      if (!c.text || !['RRN', 'BIZNO', 'CARD', 'ACCT', 'CORPNO'].includes(c.kind)) continue;
      raw++;
      if (piiTripwire(c.text)) caught++;
    }
    assert.ok(raw > 400, String(raw));
    assert.equal(caught, raw);
  });

  it('시드가 같으면 같은 코퍼스(회귀 비교 가능)', () => {
    assert.deepEqual(buildCorpus(50).map((c) => c.value), buildCorpus(50).map((c) => c.value));
  });
});
