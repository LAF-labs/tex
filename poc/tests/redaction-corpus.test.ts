// D06 §7 합성 코퍼스(10,000건 × 시드 2개): 식별자 누락 0, 마스킹 출력은 egress 트립와이어에 걸리지 않음, 정상 문구 과치환 0.
// 측정표는 node --conditions=development scripts/redaction-corpus.ts 로 다시 만든다(reports/M1-5.md).
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
