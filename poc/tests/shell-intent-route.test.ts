// 대화 의도(M4-3 ③, intent-route.ts): 엔진 intent.resolve 응답 검사·작업 → 화면 해석·오프라인 대체(명령 없음·시간 초과·모양 다름).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { describe, it } from 'node:test';
import { INTENT_DICT } from '../packages/engine/src/l0/rules.ts';
import { ADVICE_TEXT, engineIntentResolver, INTENT_PLAYBOOKS, INTENT_UNAVAILABLE_TEXT, parseRoute, routed } from '../apps/desktop/src/intent-route.ts';
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
  it('되묻기·안내 문구(shell-model interpret)도 금지 표현이 없고, 제품 화면에 "데모"라고 하지 않는다', () => {
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
  it('명령 없음·판정 불가·모양 다름·시간 초과는 판정 못 함(이유 코드만)', async () => {
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

describe('오프라인 해석 없음·로그인 먼저(사용자 결정 2026-11-10)', () => {
  const src = fs.readFileSync(new URL('../apps/desktop/src/shell-app.ts', import.meta.url), 'utf8');
  const send = src.slice(src.indexOf("'request.send': async"), src.indexOf("'draft.update':"));
  it('제품: 판정을 못 하면 정규식으로 의도를 고르지 않고 unavailable(연결 안 됨)을 돌려준다. 되묻던 것은 그대로', () => {
    const product = send.slice(send.indexOf('const r = await intent.resolve(text);'));
    assert.ok(product.length > 0);
    assert.match(product, /if \(!r\.route\) return \{ kind: 'unavailable', text: INTENT_UNAVAILABLE_TEXT, retry: true, via: 'model', note: null, sent: sentFromGateway\(gwIssuedSince\(mark\)\) \};/);
    // 판정이 없을 때 interpret(정규식 의도)로 가는 줄이 없다
    const before = product.slice(0, product.indexOf('const to = routed('));
    assert.doesNotMatch(before, /interpret\(/);
    assert.doesNotMatch(src, /advice-words|offlineAdviceMentioned/);
    assert.match(INTENT_UNAVAILABLE_TEXT, /연결하지 못했어요/);
  });
  it('정규식 해석은 시연(fixture)이 해석기를 바꿔 끼우지 않았을 때만', () => {
    assert.match(send, /if \(fixture && !opts\.intent\) return setupGate\(local\) \?\? finishReply\(interpret\(text, vat, profile, runs, local\), 'offline', null, \[\]\);/);
  });
  it('제품은 로그인(PC 등록) 전에 대화·약관 다음 온보딩 답을 받지 않는다(account_required). 시연은 계정 없이', () => {
    assert.match(src, /const loginRequired = !fixture;/);
    assert.match(send, /if \(!termsOk\(\)\) throw new Error\('onboarding_terms'\);\s*await needLogin\(\);/);
    const reply = src.slice(src.indexOf("'onboarding.reply': async"), src.indexOf("'clipboard.copy'"));
    assert.match(reply, /if \(p\.step !== 'terms'\) await needLogin\(\);/);
    assert.ok(reply.indexOf('needLogin') < reply.indexOf('onb.answer'));
  });
  it('렌더러: 제목줄 해석 표시 없음, 연결 안 됨에 [다시 시도], 로그인 화면은 약관 뒤·로그인 전 닫을 수 없음', () => {
    const shell = fs.readFileSync(new URL('../apps/desktop/static/shell/shell.js', import.meta.url), 'utf8');
    assert.doesNotMatch(shell, /오프라인 해석|모델 해석|tb-interp/);
    assert.match(shell, /r\.kind === 'unavailable'/);
    assert.match(shell, /'data-act': 'intent-retry'/);
    assert.match(shell, /function loginGate\(\) \{\s*if \(!state\.boot\?\.loginRequired\) return false;\s*if \(state\.onb && state\.onb\.consents\?\.terms\?\.choice !== 'agreed'\) return false;/);
    assert.match(shell, /onClose: loginGate\(\) && state\.login\.screen !== 'reset_done' \? null : closeLogin,/);
    const onb = fs.readFileSync(new URL('../apps/desktop/static/shell/shell-onboarding.js', import.meta.url), 'utf8');
    assert.doesNotMatch(onb, /모델 없이|'decline'/);
  });
});
