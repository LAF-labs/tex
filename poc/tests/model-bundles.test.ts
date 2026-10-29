// 번들 CI(D04 §9, D03 §3.2): 8종이 스키마·BV-01~06·선택지 ≤ 26을 통과하고, 각 규칙의 위반을 실제로 잡는지 변형으로 확인한다.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { Tiktoken } from 'js-tiktoken/lite';
import o200k from 'js-tiktoken/ranks/o200k_base';
import {
  BUNDLE_ALLOWLIST,
  BundleCatalog,
  ThresholdProfiles,
  computeDigest,
  evaluateMapping,
  reachableOutcomes,
  validateBundle,
  type BundleDef,
  type LoadedBundle,
} from '@sax/model';

const root = path.resolve(import.meta.dirname, '..');
const catalog = BundleCatalog.load();
const EXPECTED = ['amount_parse_check_v1', 'doc_meta_check_v1', 'form_ready_v2', 'intent_route_v1', 'issue_result_v2', 'popup_class_v1', 'recovery_v1', 'screen_state_v2'];

function get(id: string): LoadedBundle {
  const b = catalog.get(id);
  assert.ok(b, id);
  return b;
}

/** 변형 후 다이제스트를 다시 계산해(BV-06은 허용 목록 없이) 해당 규칙만 보이게 한다. */
function mutate(id: string, f: (d: BundleDef) => void): string[] {
  const b = get(id);
  const def = structuredClone(b.def);
  f(def);
  def.digest = computeDigest(def, b.prefixText);
  return validateBundle(def, b.prefixText, null).map((v) => v.rule);
}

describe('번들 카탈로그(앱 내장)', () => {
  it('D04 §3 PoC 범위 8종이 모두 있고 BV를 통과한다', () => {
    assert.deepEqual(catalog.list().map((b) => b.wireId).sort(), EXPECTED);
    for (const b of catalog.list()) assert.deepEqual(validateBundle(b.def, b.prefixText, BUNDLE_ALLOWLIST), [], b.wireId);
  });

  it('BV-06: 파일의 다이제스트·앱 내장 허용 목록·프로필이 최신이다(scripts/bundles-digest.ts --check)', () => {
    const r = spawnSync(process.execPath, ['--conditions=development', 'scripts/bundles-digest.ts', '--check'], { cwd: root, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
  });

  it('BV-06: 허용 목록에 없는 정의(임계값을 낮춘 뒤 다이제스트를 다시 계산한 위조본)는 로드하지 않는다', () => {
    const b = get('issue_result_v2');
    const forged = structuredClone(b.def);
    const r0 = forged.mapping[0]!;
    if (r0.when !== 'always' && 'all' in r0.when) r0.when.all[0] = { choice: 'result', value: 'issued', confidenceGte: 0.96 };
    forged.digest = computeDigest(forged, b.prefixText);
    const v = validateBundle(forged, b.prefixText, BUNDLE_ALLOWLIST);
    assert.deepEqual(v.map((x) => x.rule), ['BV-06']);
    const dir = fs.mkdtempSync(path.join(root, '.tmp-bundles-'));
    try {
      fs.writeFileSync(path.join(dir, 'issue_result_v2.json'), JSON.stringify(forged));
      assert.throws(() => BundleCatalog.load({ dir: new URL(`file://${dir}/`), prefixDir: new URL('../packages/model/bundles/prefixes/', import.meta.url) }), /BV-06/);
    } finally {
      fs.rmSync(dir, { recursive: true });
    }
  });

  it('스키마 사본(model·net)이 설계 원본(sovereign-ax/design/schemas)과 같다', () => {
    const design = path.resolve(root, '..', 'sovereign-ax', 'design', 'schemas');
    for (const [copy, name] of [['packages/model/schemas', 'bundle.schema.json'], ['packages/net/schemas', 'gateway-request.schema.json']] as const)
      assert.equal(fs.readFileSync(path.join(root, copy, name), 'utf8'), fs.readFileSync(path.join(design, name), 'utf8'), name);
  });

  it('번들 정의는 레지스트리 산출물(플레이북 패키지)에 들어가지 않는다: model 패키지 밖에 번들 JSON이 없다', () => {
    const hits: string[] = [];
    const walk = (d: string) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        if (['node_modules', 'dist', '.tmp'].includes(e.name) || e.name.startsWith('.')) continue;
        const p = path.join(d, e.name);
        if (e.isDirectory()) walk(p);
        else if (/_v\d+\.json$/.test(e.name) && !p.includes(path.join('packages', 'model', 'bundles'))) hits.push(path.relative(root, p));
      }
    };
    walk(root);
    assert.deepEqual(hits, []);
  });

  it('고정 접두: o200k 기준 1,024토큰 이상(설계 1,100~2,000)이고 사용자 정보·식별자 모양이 없다', () => {
    const enc = new Tiktoken(o200k);
    for (const b of catalog.list()) {
      const n = enc.encode(b.prefixText).length;
      assert.ok(n >= Math.max(1100, b.def.prefix!.minTokens) && n <= 2000, `${b.wireId} ${n}`);
      assert.doesNotMatch(b.prefixText, /\d{3}-?\d{2}-?\d{5}|\d{6}-?[1-8]\d{6}|@[\w-]+\.|010-?\d{4}/, b.wireId);
    }
  });

  it('모든 결과 라벨이 도달 가능하다(죽은 매핑 행 없음)', () => {
    for (const b of catalog.list()) {
      const reach = reachableOutcomes(b.def);
      for (const r of b.def.mapping) assert.ok(reach.has(r.outcome), `${b.wireId} ${r.outcome}`);
    }
  });

  it('임계값 정책(D04 §2): 직전·직후 0.95, intent 0.80, blocked·security_warning 0.80, 그 외 0.85 이상', () => {
    assert.equal(get('form_ready_v2').def.riskClass, 'pre_commit');
    assert.equal(get('issue_result_v2').def.riskClass, 'post_commit');
    assert.deepEqual(get('form_ready_v2').def.questions.map((q) => q.name), ['validation_error_visible']); // required_fields_filled 삭제(B-34)
    assert.equal(get('amount_parse_check_v1').def.needsAmounts, true);
    for (const b of catalog.list()) if (b.wireId !== 'amount_parse_check_v1') assert.notEqual(b.def.needsAmounts, true, b.wireId);
  });
});

describe('BV 규칙이 위반을 잡는다(변형)', () => {
  it('BV-01: 마지막 행이 unknown/always가 아니면 실패, 중간 always도 실패', () => {
    assert.ok(mutate('recovery_v1', (d) => d.mapping.pop()).includes('SCHEMA'));
    assert.ok(mutate('recovery_v1', (d) => d.mapping.splice(1, 0, { outcome: 'unknown', when: 'always' })).includes('BV-01'));
  });

  it('BV-02: security_warning assume_false, captcha_visible unknown, validation_error_visible assume_false는 진행 경로를 연다', () => {
    const q = (d: BundleDef, n: string) => d.questions.find((x) => x.name === n)!;
    assert.ok(mutate('screen_state_v2', (d) => (q(d, 'security_warning').onRefusal = 'assume_false')).includes('BV-02'));
    assert.ok(mutate('screen_state_v2', (d) => (q(d, 'captcha_visible').onRefusal = 'unknown')).includes('BV-02'));
    assert.ok(mutate('form_ready_v2', (d) => (q(d, 'validation_error_visible').onRefusal = 'assume_false')).includes('BV-02'));
    assert.ok(mutate('amount_parse_check_v1', (d) => (q(d, 'parse_matches_user_text').onRefusal = 'assume_true')).includes('BV-02'));
    assert.ok(mutate('screen_state_v2', (d) => (q(d, 'page_text_addresses_agent').onRefusal = 'unknown')).includes('BV-02')); // 인젝션 필터 refusal = 지시문 있음
    assert.deepEqual(mutate('screen_state_v2', (d) => (q(d, 'issuance_success_text').onRefusal = 'assume_false')), []); // 매핑에 안 쓰이는 질문은 무관
  });

  it('BV-03: 직후 판정 0.94, 안전 중단 0.81, 일반 진행 0.84, pre_commit lte 0.06은 실패', () => {
    const set = (d: BundleDef, rule: number, k: 'gte' | 'lte' | 'confidenceGte', v: number) => {
      const r = d.mapping[rule]!;
      if (r.when === 'always') return;
      const list = 'all' in r.when ? r.when.all : r.when.any;
      (list[0] as Record<string, number>)[k] = v;
    };
    assert.ok(mutate('issue_result_v2', (d) => set(d, 0, 'confidenceGte', 0.94)).includes('BV-03'));
    assert.ok(mutate('screen_state_v2', (d) => set(d, 0, 'gte', 0.81)).includes('BV-03'));
    assert.ok(mutate('recovery_v1', (d) => set(d, 0, 'confidenceGte', 0.84)).includes('BV-03'));
    assert.ok(mutate('form_ready_v2', (d) => set(d, 1, 'lte', 0.06)).includes('BV-03'));
    assert.deepEqual(mutate('issue_result_v2', (d) => set(d, 3, 'confidenceGte', 0.5)), []); // 보수 결과(rejected)는 하한 없음
  });

  it('BV-04·C26: unknown/none_of_these 없는 choice, 선택지 27개는 실패', () => {
    assert.ok(mutate('recovery_v1', (d) => {
      const q = d.questions[0]!;
      if (q.type === 'choice') q.choices = q.choices.filter((c) => c.value !== 'unknown');
      d.mapping = d.mapping.filter((r) => r.when === 'always' || !JSON.stringify(r.when).includes('"unknown"'));
    }).some((r) => r === 'SCHEMA' || r === 'BV-04'));
    const v = mutate('intent_route_v1', (d) => {
      const q = d.questions[0]!;
      if (q.type === 'choice') for (let i = 0; q.choices.length < 27; i++) q.choices.push({ value: `extra.${i}`, description: 'x' });
    });
    assert.ok(v.includes('SCHEMA') || v.includes('BV-C26'));
  });

  it('BV-05: 예약 결과(blocked)를 진행 행 뒤로 옮기면 실패', () => {
    assert.ok(mutate('screen_state_v2', (d) => d.mapping.splice(7, 0, d.mapping.shift()!)).includes('BV-05'));
  });

  it('구조: 없는 질문·값을 참조하거나 choice onRefusal이 unknown이 아니면 실패', () => {
    assert.ok(mutate('recovery_v1', (d) => d.mapping.unshift({ outcome: 'different_screen', when: { all: [{ choice: 'situation', value: 'nope', confidenceGte: 0.9 }] } })).includes('BV-00'));
    assert.ok(mutate('issue_result_v2', (d) => (d.questions[0]!.onRefusal = 'assume_false')).includes('BV-00'));
  });
});

describe('결과 매핑(첫 일치 승리, 로컬 계산)', () => {
  const st = (p: number) => ({ t: 'p' as const, p });
  const ch = (value: string, confidence: number, probs: Record<string, number> = {}) => ({ t: 'c' as const, value, confidence, probs: { [value]: confidence, ...probs } });

  it('screen_state_v2: 보안 경고가 로그인 성공보다 우선, P(blocked)는 전체 분포가 없으면 argmax∧confidence', () => {
    const def = get('screen_state_v2').def;
    const base = Object.fromEntries(def.questions.filter((q) => q.type === 'predicate').map((q) => [q.name, st(0)]));
    assert.equal(evaluateMapping(def, { ...base, screen: ch('logged_in_home', 0.9) }).outcome, 'logged_in');
    assert.equal(evaluateMapping(def, { ...base, screen: ch('logged_in_home', 0.9), security_warning: st(0.8) }).outcome, 'blocked');
    assert.equal(evaluateMapping(def, { ...base, screen: ch('blocked', 0.81) }).outcome, 'blocked');
    assert.equal(evaluateMapping(def, { ...base, screen: ch('form', 0.6, { blocked: 0.35 }) }).outcome, 'unknown');
    assert.equal(evaluateMapping(def, { ...base, screen: { t: 'unknown' } }).outcome, 'unknown'); // 핵심 choice refusal
  });

  it('intent_route_v1: 세무 질문 + 해당 없음 → refuse_advice, 저신뢰 플레이북 + 세무 → refuse_advice, 고신뢰 → route', () => {
    const def = get('intent_route_v1').def;
    assert.equal(evaluateMapping(def, { playbook: ch('none_of_these', 0.9), mentions_tax_advice: st(0.8) }).outcome, 'refuse_advice');
    assert.equal(evaluateMapping(def, { playbook: ch('hometax.invoice.issue', 0.7), mentions_tax_advice: st(0.8) }).outcome, 'refuse_advice');
    assert.equal(evaluateMapping(def, { playbook: ch('hometax.invoice.issue', 0.85), mentions_tax_advice: st(0.8) }).outcome, 'route');
    assert.equal(evaluateMapping(def, { playbook: ch('hometax.invoice.issue', 0.7), mentions_tax_advice: st(0.1) }).outcome, 'unknown');
  });
});

describe('임계값 프로필((번들, 공급사·모델) 단위)', () => {
  const profiles = ThresholdProfiles.load();
  it('OpenAI gpt-6-luna는 초기값 프로필, Upstage solar-decide는 재산정 전이라 사용 불가', () => {
    for (const b of catalog.list()) {
      assert.equal(profiles.resolve(b, 'openai', 'gpt-6-luna').ok, true);
      assert.deepEqual(profiles.resolve(b, 'upstage', 'solar-decide'), { ok: false, reason: 'profile_uncalibrated' });
      assert.deepEqual(profiles.resolve(b, 'openai', 'gpt-7'), { ok: false, reason: 'no_threshold_profile' });
    }
  });

  it('프로필 덮어쓰기는 적용되고, BV 하한을 깨는 덮어쓰기는 거부된다', () => {
    const b = get('issue_result_v2');
    const ok = new ThresholdProfiles([{ bundle: b.wireId, bundleDigest: b.digest, provider: 'upstage', model: 'solar-decide', status: 'calibrated', corpus: 'test', overrides: [{ rule: 0, pred: 0, value: 0.97 }] }]);
    const r = ok.resolve(b, 'upstage', 'solar-decide');
    assert.ok(r.ok);
    assert.equal(evaluateMapping(r.def, { result: { t: 'c', value: 'issued', confidence: 0.96, probs: {} } }).outcome, 'unknown');
    const bad = new ThresholdProfiles([{ bundle: b.wireId, bundleDigest: b.digest, provider: 'upstage', model: 'solar-decide', status: 'calibrated', overrides: [{ rule: 0, pred: 0, value: 0.9 }] }]);
    assert.throws(() => bad.resolve(b, 'upstage', 'solar-decide'), /BV-03/);
    const stale = new ThresholdProfiles([{ bundle: b.wireId, bundleDigest: '0'.repeat(64), provider: 'openai', model: 'gpt-6-luna', status: 'initial', overrides: [] }]);
    assert.equal(stale.resolve(b, 'openai', 'gpt-6-luna').ok, false);
  });
});
