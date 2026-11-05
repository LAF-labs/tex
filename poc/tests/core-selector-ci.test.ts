// D02 §6.3 셀렉터 CI SV-01~06, §2.2 핫픽스 적격 조건(E-03)과 CE-15, D03 §7.1 DENY_ACTION_NAME 정규화.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { applyHotfix, denyKey, hotfixEligibilityViolations, ineligibleEntries, isDenyActionName, selectorCi, sv06, validatePackage, type Hotfix, type Recording } from '@sax/engine/core';
import { bundleOutcomes, h01, lookups } from './core-fixtures.ts';

const bundles = bundleOutcomes();
const F = 'hometax.invoice.form.root';

/** 골든 사전을 그대로 녹화 DOM으로 만든다: 항목마다 요소 하나, 이름은 namePattern의 본문. */
function recordingOf(p = h01()): Recording {
  const sel = p.selectors;
  const uid = (k: string) => `u:${k}`;
  const elements = Object.entries(sel.entries).map(([k, e]) => ({ uid: uid(k), role: e.role, name: e.namePattern.slice(1, -1), frame: e.frame, landmark: k === e.landmark ? null : uid(e.landmark) }));
  return { elements, resolved: Object.fromEntries(Object.keys(sel.entries).map((k) => [k, uid(k)])), har: [{ method: 'POST', path: '/wqAction.do', params: { actionId: 'ATEETBDA001R01' }, afterClick: uid('hometax.invoice.form.issueButton') }] };
}
const rules = (v: Array<{ rule: string }>) => new Set(v.map((x) => x.rule));

describe('셀렉터 CI SV-01~06', () => {
  it('골든 H-01 사전과 녹화는 통과', () => assert.deepEqual(selectorCi(h01().selectors, recordingOf()), []));
  it('SV-01 비커밋 항목이 발급 버튼과 같은 요소로 해석', () => {
    const rec = recordingOf();
    rec.resolved['hometax.invoice.form.lookupCounterpart'] = rec.resolved['hometax.invoice.form.issueButton']!;
    assert.ok(rules(selectorCi(h01().selectors, rec)).has('SV-01'));
  });
  it('SV-02 커밋 요청을 만든 요소가 commits:false', () => {
    const rec = recordingOf();
    rec.har[0]!.afterClick = 'u:hometax.invoice.form.lookupCounterpart';
    assert.ok(rules(selectorCi(h01().selectors, rec)).has('SV-02'));
  });
  it('SV-02 "확인" 버튼이 commits:false인데 reviewNote 없음', () => {
    const p = h01();
    delete p.selectors.entries['hometax.captcha.submit']!.reviewNote;
    assert.ok(rules(selectorCi(p.selectors, recordingOf(p))).has('SV-02'));
  });
  it('SV-03 커밋 랜드마크 안 fieldKey 없는 입력 요소', () => {
    const rec = recordingOf();
    rec.elements.push({ uid: 'u:stray', role: 'textbox', name: '숨은 칸', frame: 'main', landmark: `u:${F}` });
    assert.ok(rules(selectorCi(h01().selectors, rec)).has('SV-03'));
  });
  it('SV-04 namePattern이 랜드마크 안 둘에 맞음', () => {
    const rec = recordingOf();
    rec.elements.push({ uid: 'u:dup', role: 'button', name: '발급하기', frame: 'main', landmark: `u:${F}` });
    assert.ok(rules(selectorCi(h01().selectors, rec)).has('SV-04'));
  });
  it('SV-05 닫기 요소 이름이 "확 인"(공백·제로폭)', () => {
    const p = h01();
    p.selectors.entries['hometax.popup.close'] = { candidates: [{ kind: 'css', value: '#close' }], role: 'button', namePattern: '^닫기$', frame: 'main', landmark: F, commits: false, closeAffordance: true, lastVerified: '2026-11-01' };
    const rec = recordingOf(p);
    rec.elements.find((e) => e.uid === 'u:hometax.popup.close')!.name = '확​ 인';
    assert.ok(rules(selectorCi(p.selectors, rec)).has('SV-05'));
  });
  it('SV-06 commitEndpoints 합집합이 비면 auto·assisted 불가', () => {
    assert.deepEqual(sv06([], 'postprocess'), []);
    assert.ok(rules(sv06([], 'auto')).has('SV-06'));
    assert.ok(rules(sv06([], 'assisted')).has('SV-06'));
    assert.deepEqual(sv06(h01().selectors.commitEndpoints, 'auto'), []);
  });
  it('DENY_ACTION_NAME: NFKC·제로폭·공백 제거 뒤 적용', () => {
    assert.equal(denyKey('확​ 인'), '확인');
    assert.ok(isDenyActionName('ＯＫ'));
    assert.ok(isDenyActionName('다 음'));
    assert.equal(isDenyActionName('닫기'), false);
    assert.equal(isDenyActionName('X'), false);
  });
});

describe('핫픽스 적격 조건(E-03)·CE-15', () => {
  const hf = (entries: Hotfix['entries']): Hotfix => ({ appliesTo: { id: 'hometax.invoice.issue', version: '2.1.0', packageDigest: '0'.repeat(64) }, version: 1, monotonic: 1, keyEpoch: 1, issuedAt: '2026-11-01T00:00:00+09:00', expiresAt: '2026-11-08T00:00:00+09:00', entries, signatures: [] });
  const cand = [{ kind: 'css' as const, value: '#btnIssue' }];
  it('참조 집합: 커밋·랜드마크·조건식·decide.scope·signFlow 항목은 불가', () => {
    const bad = ineligibleEntries(h01(), { bundles, lookups: lookups() });
    assert.equal(bad.get('hometax.invoice.form.issueButton'), 'commits');
    assert.equal(bad.get(F), 'landmark');
    assert.equal(bad.get('hometax.invoice.form.counterpartName'), 'field_key');
    assert.equal(bad.get('hometax.nav.home'), 'cond');
    assert.equal(bad.get('hometax.invoice.sign.confirmButton'), 'commits');
    assert.equal(bad.has('hometax.login.simpleAuthButton'), false);
    assert.equal(bad.has('hometax.invoice.form.lookupCounterpart'), false);
  });
  it('CE-15 commits:true 항목·랜드마크 항목 변경은 거부', () => {
    const v = hotfixEligibilityViolations(hf({ 'hometax.invoice.form.issueButton': { candidates: cand }, [F]: { candidates: cand } }), h01(), { bundles, lookups: lookups() });
    assert.equal(v.length, 2);
    assert.ok(v.every((x) => x.rule === 'HF-ELIGIBLE'));
  });
  it('CE-15 비커밋 항목 후보를 발급 버튼으로 바꾸면 SV-01(핫픽스 CI)이 잡는다', () => {
    const p = h01();
    const fix = hf({ 'hometax.invoice.form.lookupCounterpart': { candidates: cand } });
    assert.deepEqual(hotfixEligibilityViolations(fix, p, { bundles, lookups: lookups() }), []);
    const patched = applyHotfix(p.selectors, fix);
    const rec = recordingOf(p);
    rec.resolved['hometax.invoice.form.lookupCounterpart'] = rec.resolved['hometax.invoice.form.issueButton']!; // 패치된 후보가 녹화에서 발급 버튼으로 해석
    assert.ok(rules(selectorCi(patched, rec)).has('SV-01'));
    assert.deepEqual(validatePackage({ ...p, selectors: patched }, { bundles, lookups: lookups() }), []); // 정적 규칙만으로는 못 잡는다: SV·R-A2가 막는다
  });
  it('조회 패키지 핫픽스는 항상 거부', () => {
    const lp = lookups().get('hometax.invoice.lookup')!;
    assert.equal(hotfixEligibilityViolations(hf({ 'hometax.lookup.searchKey': { candidates: cand } }), lp)[0]!.rule, 'HF-LOOKUP');
  });
  it('commitEndpointsAdd는 추가만', () => {
    const p = h01();
    const fix = { ...hf({}), commitEndpointsAdd: [{ match: { method: 'POST' as const, pathPattern: '^/x$' }, effect: 'issue_document' as const, maxRequests: 1 }] };
    assert.equal(applyHotfix(p.selectors, fix).commitEndpoints.length, p.selectors.commitEndpoints.length + 1);
    assert.equal(p.selectors.commitEndpoints.length, 1);
  });
});
