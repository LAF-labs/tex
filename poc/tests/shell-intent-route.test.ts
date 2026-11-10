// 대화 의도(M4-3 ③, intent-route.ts): 엔진 intent.resolve 응답 검사·작업 → 화면 해석·오프라인 대체(명령 없음·시간 초과·모양 다름).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { describe, it } from 'node:test';
import { INTENT_DICT } from '../packages/engine/src/l0/rules.ts';
import { ADVICE_TEXT, engineIntentResolver, INTENT_PLAYBOOKS, parseRoute, routed } from '../apps/desktop/src/intent-route.ts';
import type { Parsed } from '../apps/desktop/src/shell-mock.ts';

const local: Parsed = { intent: 'other', counterparties: ['A상사'], amount: 3_300_000, vat: null, item: null };

describe('intent.resolve 응답 → IntentRoute', () => {
  it('선택지는 intent_route_v1 번들의 choices(none_of_these 제외)와 같고, L0 사전 ID는 모두 그 안에 있다', () => {
    const b = JSON.parse(fs.readFileSync(new URL('../packages/model/bundles/intent_route_v1.json', import.meta.url), 'utf8')) as { questions: Array<{ name: string; choices?: Array<{ value: string }> }> };
    const choices = b.questions.find((q) => q.name === 'playbook')!.choices!.map((c) => c.value).filter((v) => v !== 'none_of_these');
    assert.deepEqual([...INTENT_PLAYBOOKS].sort(), choices.sort());
    for (const [id] of INTENT_DICT) assert.ok((INTENT_PLAYBOOKS as readonly string[]).includes(id), id);
  });
  it('맞는 모양만 받는다', () => {
    assert.deepEqual(parseRoute({ outcome: 'route', playbook: 'hometax.invoice.issue', adviceMentioned: false, via: 'l0' }), { outcome: 'route', playbook: 'hometax.invoice.issue', adviceMentioned: false, via: 'l0' });
    assert.deepEqual(parseRoute({ outcome: 'refuse_advice', via: 'model' }), { outcome: 'refuse_advice', via: 'model' });
    assert.deepEqual(parseRoute({ outcome: 'unknown', via: 'model', extra: 1 }), { outcome: 'unknown', via: 'model' });
    for (const bad of [
      null, [], 'route', {},
      { outcome: 'route', playbook: 'run.start', adviceMentioned: false, via: 'model' },
      { outcome: 'route', playbook: 'hometax.invoice.issue', via: 'model' },
      { outcome: 'route', playbook: 'none_of_these', adviceMentioned: false, via: 'model' },
      { outcome: 'refuse_advice', via: 'l0' }, // 세무 질문 판정은 모델 필수(L0 표 mode none)
      { outcome: 'route', playbook: 'hometax.invoice.issue', adviceMentioned: false, via: 'gateway' },
      { outcome: 'issue', via: 'model' },
    ])
      assert.equal(parseRoute(bad), null, JSON.stringify(bad));
  });
});

describe('작업 → 화면 해석(인자는 로컬 파서 그대로)', () => {
  it('세금계산서 발급 → invoice, 로컬 인자 유지', () => {
    assert.deepEqual(routed({ outcome: 'route', playbook: 'hometax.invoice.issue', adviceMentioned: false, via: 'model' }, local), { parsed: { ...local, intent: 'invoice' }, note: null });
  });
  it('세무 질문이 섞이면 작업은 그대로, 고정 문구를 같이', () => {
    const r = routed({ outcome: 'route', playbook: 'hometax.invoice.issue', adviceMentioned: true, via: 'model' }, local);
    assert.deepEqual(r, { parsed: { ...local, intent: 'invoice' }, note: ADVICE_TEXT });
  });
  it('세무 상담 거절 → 고정 문구만', () => {
    assert.deepEqual(routed({ outcome: 'refuse_advice', via: 'model' }, local), { say: ADVICE_TEXT, note: null });
  });
  it('등본·초본은 로컬 파서가 초본을 알면 초본', () => {
    const r = routed({ outcome: 'route', playbook: 'gov24.resident.copy', adviceMentioned: false, via: 'l0' }, { ...local, intent: 'resident_abstract' });
    assert.equal('parsed' in r && r.parsed.intent, 'resident_abstract');
    const c = routed({ outcome: 'route', playbook: 'gov24.resident.copy', adviceMentioned: false, via: 'l0' }, local);
    assert.equal('parsed' in c && c.parsed.intent, 'resident_copy');
  });
  it('증명서 계열 → cert, 화면만 여는 작업·조회 → 곧 안내(실행·계산 없음), 모름 → other', () => {
    for (const p of ['hometax.cert.business', 'hometax.cert.taxpayment', 'gov24.nhis.eligibility', 'fourins.paid.cert'] as const) {
      const r = routed({ outcome: 'route', playbook: p, adviceMentioned: false, via: 'model' }, local);
      assert.equal('parsed' in r && r.parsed.intent, 'cert', p);
    }
    for (const p of ['payroll.ledger', 'bundle.monthly', 'hometax.card.refresh', 'hometax.invoice.list', 'hometax.invoice.amend', 'query.documents'] as const) {
      const r = routed({ outcome: 'route', playbook: p, adviceMentioned: false, via: 'model' }, local);
      assert.ok('say' in r && r.say.includes('곧 이 대화에서'), p);
    }
    assert.deepEqual(routed({ outcome: 'unknown', via: 'model' }, local), { parsed: { ...local, intent: 'other' }, note: null });
  });
  it('화면 문구에 세무사법 금지 표현이 없다(D11 §8.1)', () => {
    const all = [ADVICE_TEXT, ...INTENT_PLAYBOOKS.map((p) => routed({ outcome: 'route', playbook: p, adviceMentioned: false, via: 'model' }, local)).flatMap((r) => ('say' in r ? [r.say] : []))].join('\n');
    for (const bad of ['세금신고 대행', '절세', '기장대행', '세무대리', '환급 보장', '대신 처리']) assert.ok(!all.includes(bad), bad);
  });
  it('오프라인(정규식) 안내 문구도 금지 표현이 없고, 제품 화면에 "데모"라고 하지 않는다', () => {
    const src = fs.readFileSync(new URL('../apps/desktop/src/shell-model.ts', import.meta.url), 'utf8');
    const says = [...src.matchAll(/kind: 'say', text: '([^']+)'/g)].map((m) => m[1]!);
    assert.ok(says.length >= 4, String(says.length));
    for (const t of says) {
      assert.ok(!t.includes('데모'), t);
      for (const bad of ['세금신고 대행', '절세', '기장대행', '세무대리', '환급 보장', '대신 처리']) assert.ok(!t.includes(bad), `${bad}: ${t}`);
    }
  });
});

describe('engineIntentResolver: 엔진 rpc 위', () => {
  it('엔진에 명령을 그대로 보내고 결과를 검사한다', async () => {
    const calls: Array<[string, unknown]> = [];
    const r = engineIntentResolver(async (m, p) => (calls.push([m, p]), { outcome: 'route', playbook: 'hometax.invoice.issue', adviceMentioned: false, via: 'l0' }));
    assert.deepEqual(await r.resolve('A상사 330만원'), { route: { outcome: 'route', playbook: 'hometax.invoice.issue', adviceMentioned: false, via: 'l0' }, fallback: null });
    assert.deepEqual(calls, [['intent.resolve', { text: 'A상사 330만원' }]]);
  });
  it('명령 없음·판정 불가·모양 다름·시간 초과는 오프라인(이유 코드만)', async () => {
    const err = (m: string) => engineIntentResolver(async () => Promise.reject(new Error(m)));
    assert.deepEqual(await err('unknown_method').resolve('x'), { route: null, fallback: 'unknown_method' });
    assert.deepEqual(await err('decide.unavailable').resolve('x'), { route: null, fallback: 'decide.unavailable' });
    assert.deepEqual(await err('boom: A상사 3,300,000').resolve('x'), { route: null, fallback: 'error' }, '메시지(값)는 옮기지 않는다');
    assert.deepEqual(await engineIntentResolver(async () => ({ outcome: 'issue' })).resolve('x'), { route: null, fallback: 'shape' });
    const t0 = Date.now();
    assert.deepEqual(await engineIntentResolver(() => new Promise(() => {}), 50).resolve('x'), { route: null, fallback: 'timeout' });
    assert.ok(Date.now() - t0 < 1_000);
  });
});
