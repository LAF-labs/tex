// H-04 납세증명서(국세) 발급 패키지(ADR-018 Phase 1 코어, 02 §5.1·§10, D02): 제품 원본 packages/engine/playbooks/hometax.cert.taxpayment와
// 조회 하위 패키지 hometax.cert.issued_list(민원신청 처리결과). 셀렉터는 실기기 캡처 전이다(playbooks/README.md "캡처 필요").
// - 정적 검증(스키마 + V-01~V-25)·로더(서명 2-of-3, 조회 결속, 승인 바 요약 표)를 통과한다.
// - 가짜 화면 리플레이: 양식 → readback → 사업자·입력 대조 → 게이트, 발급 확인 뒤 출력 → PDF 저장. 실제 포털 접속 없음.
// - 로그인·인증서 비밀은 금고 경로다: sign(then human:secret)만, secret_fill·타이피스트 입력 없음(인증서 비밀번호는 사용자가 직접, ADR-020 결정 2).
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { BUNDLE_ALLOWLIST } from '@sax/model';
import {
  BASIC_HANDLERS, buildCfg, Interpreter, loadPackage, newScope, semanticViolations, stepEnv, validatePackage,
  type Handler, type LoadedPackage, type LoaderContext, type PackageFiles, type Resolved, type SelectorDict,
} from '@sax/engine/core';
import { FakeAct, FakeClock, FakePage, type FEl } from './core-page-fakes.ts';
import { bundleOutcomes, loadPkg, signPackage, testKeys } from './core-fixtures.ts';

const ID = 'hometax.cert.taxpayment';
const LK = 'hometax.cert.issued_list';
const h04 = (): PackageFiles => structuredClone(loadPkg(ID));
const lookup = (): PackageFiles => structuredClone(loadPkg(LK));
const LOOKUPS = () => new Map([[LK, lookup()]]);
const BUNDLES = bundleOutcomes();
const step = (p: PackageFiles, id: string) => p.playbook.steps.find((s) => s.id === id)!;

describe('H-04 정적 검증', () => {
  it('조회 패키지(kind lookup, effects 없음, V-22)와 H-04 패키지에 위반이 없다', () => {
    assert.deepEqual(validatePackage(lookup(), { bundles: BUNDLES }), []);
    assert.deepEqual(validatePackage(h04(), { bundles: BUNDLES, lookups: LOOKUPS() }), []);
  });

  it('비가역은 신청하기(submit) 하나이고 게이트 s20이 허가한다. 그 효과는 issue_document뿐이다', () => {
    const { analysis } = semanticViolations(h04(), { bundles: BUNDLES, lookups: LOOKUPS() });
    assert.deepEqual([...analysis.irreversible], ['s21']);
    assert.equal(analysis.gateOf.get('s21'), 's20');
    assert.deepEqual(h04().manifest.effects, ['issue_document']);
    assert.deepEqual(h04().playbook.effects, ['issue_document']);
  });

  it('로그인·인증서 비밀은 금고 경로만: sign(then human:secret), secret_fill·비밀 칸·fill 상수 비밀 없음', () => {
    const p = h04();
    const sign = step(p, 's4');
    assert.deepEqual(sign, { id: 's4', type: 'sign', method: '$profile.signMethod', then: ['human:secret'] });
    assert.equal(p.playbook.steps.filter((s) => s.type === 'secret_fill').length, 0, '보안카드는 민원증명 로그인에 없다(02 §5.1)');
    assert.equal(Object.values(p.selectors.entries).filter((e) => e.secretKind || e.inputType === 'password').length, 0, '비밀 칸은 포털 인증서 창(금고 비밀 창 b)에 있고 이 사전에 없다');
  });

  it('주민등록번호는 공개하지 않는다(최소 노출 상수, V-21), 사업자 대조는 $profile.bizNo(V-12: business만)', () => {
    const p = h04();
    assert.deepEqual(step(p, 's14'), { id: 's14', type: 'select', target: 'hometax.cert.taxpayment.form.residentNoDisclosure', option: '공개안함' });
    assert.deepEqual(p.playbook.profileKinds, ['business']);
    const bad = h04();
    bad.playbook.profileKinds = ['business', 'personal'];
    bad.manifest.profileKinds = ['business', 'personal'];
    assert.ok(validatePackage(bad, { bundles: BUNDLES, lookups: LOOKUPS() }).some((v) => v.rule === 'V-12'));
  });

  it('반례: 게이트 앞 readback이 신청 양식 칸(주민번호 공개여부)을 빠뜨리면 V-03j', () => {
    const p = h04();
    const rb = step(p, 's19b') as { fields: string[] };
    rb.fields = rb.fields.filter((f) => f !== 'rrnDisclosure');
    assert.ok(validatePackage(p, { bundles: BUNDLES, lookups: LOOKUPS() }).some((v) => v.rule === 'V-03j'));
  });

  it('반례: 게이트를 빼면 V-03a, verify 기준선이 없으면 V-04', () => {
    const noGate = h04();
    noGate.playbook.steps = noGate.playbook.steps.filter((s) => s.id !== 's20');
    assert.ok(validatePackage(noGate, { bundles: BUNDLES, lookups: LOOKUPS() }).some((v) => v.rule === 'V-03a'));
    const noBase = h04();
    (step(noBase, 's30') as { lookup: { baseline: string } }).lookup.baseline = 'none';
    assert.ok(validatePackage(noBase, { bundles: BUNDLES, lookups: LOOKUPS() }).some((v) => v.rule === 'V-04'));
  });

  it('최상위 끝은 end(s34)이고 모든 스텝이 진입점에서 닿는다(V-11)', () => {
    const cfg = buildCfg(h04().playbook);
    assert.deepEqual(cfg.problems, []);
    assert.equal(step(h04(), 's34').type, 'end');
  });
});

describe('H-04 로더(D03 §3.1)', () => {
  const K = testKeys();
  const two = K.pkg.slice(0, 2);
  const ctx = (o: Partial<LoaderContext> = {}): LoaderContext => ({
    roots: K.roots, revoked: new Set(), bundleAllowlist: BUNDLE_ALLOWLIST, bundles: BUNDLES, installedLookups: new Map(),
    storedVersion: null, installedDigest: null, hold: false, policyFresh: true, now: Date.parse('2026-11-09T12:00:00+09:00'), ...o,
  });
  const installed = (): Map<string, LoadedPackage> => {
    const r = loadPackage(signPackage(lookup(), two), ctx());
    assert.ok(r.ok, r.ok ? '' : r.code);
    return new Map([[LK, r.pkg]]);
  };
  // 앱 내장 승인 바 요약 표(ADR-021)의 민원증명 공통 카드 cert.confirm(팀장 결정 2026-11-09: H-03·08·09와 같은 카드, 요약 4칸).
  // 표 항목은 데이터 세션 PR이 넣는다. 이 PR에서는 주입한다.
  const SUMMARY = new Map([['cert.confirm', ['certDoc', 'certPurpose', 'certSubmitTo', 'rrnDisclosure']]]);

  it('서명 2-of-3·조회 결속·정적 검증·요약 표를 통과한다', () => {
    const lk = installed();
    const r = loadPackage(signPackage(h04(), two, [lk.get(LK)!.manifestDigest]), ctx({ installedLookups: lk, approvalSummaries: SUMMARY }));
    assert.equal(r.ok ? 'ok' : r.code, 'ok');
  });

  it('지금 앱 내장 표에는 H-04 카드가 없다: loader.approval_summary_missing(엔진 후속 전까지 제품이 로드하지 않는다)', () => {
    const lk = installed();
    const r = loadPackage(signPackage(h04(), two, [lk.get(LK)!.manifestDigest]), ctx({ installedLookups: lk }));
    assert.equal(r.ok ? 'ok' : r.code, 'loader.approval_summary_missing');
  });

  it('조회 패키지가 설치되지 않았으면 loader.lookup_mismatch', () => {
    const r = loadPackage(signPackage(h04(), two), ctx({ approvalSummaries: SUMMARY }));
    assert.equal(r.ok ? 'ok' : r.code, 'loader.lookup_mismatch');
  });
});

// ---- 가짜 화면 리플레이 ----

/** 사전 항목마다 요소 하나: id = 사전 키, 역할·이름 = 첫 role 후보, 부모 = landmark. */
function screenOf(dict: SelectorDict): FEl[] {
  return Object.entries(dict.entries).map(([k, e]) => {
    const role = e.candidates.find((c) => c.kind === 'role') as { role: string; name: string } | undefined;
    return { id: k, role: e.role, name: role?.name ?? '', ...(e.landmark !== k ? { parent: e.landmark } : {}) };
  });
}

/** 포털이 고른 값을 DOM 값·접근성 값·보이는 글자에 같이 반영하는 가짜 조작기. stuck이면 그 칸은 선택을 무시한다(포털 미반영). */
class SelectAct extends FakeAct {
  stuck = new Set<string>();
  private p: FakePage;
  constructor(p: FakePage) {
    super(p);
    this.p = p;
  }
  override async select(t: Resolved, option: string) {
    const r = await super.select(t, option);
    const e = this.p.els.get(t.el.ref)!;
    if (this.stuck.has(t.key)) e.value = e.a11y ?? '';
    e.a11y = e.value;
    e.text = e.value;
    return r;
  }
}

const INPUTS = { purpose: '대금수령', submitTo: '금융기관' };
const PROFILE = { bizNo: '1068114550', signMethod: 'cert' };
/** 신청 양식에 포털이 미리 채워 보여 주는 값(fieldKey → 화면 문자열). */
const PREFILLED: Record<string, string> = { supplierBizNo: '106-81-14550', applicantName: '주식회사 보내는곳', certDoc: '납세증명서(국세완납증명)', certPurpose: '', certSubmitTo: '', rrnDisclosure: '', copies: '1' };

function h04Run(o: { screen?: Partial<Record<string, string>>; stuck?: string[]; inputs?: Record<string, unknown> } = {}) {
  const pkg = h04();
  const clock = new FakeClock();
  const page = new FakePage(clock, screenOf(pkg.selectors));
  const screen = { ...PREFILLED, ...o.screen };
  for (const [k, e] of Object.entries(pkg.selectors.entries)) {
    if (!e.fieldKey) continue;
    const el = page.els.get(k)!;
    el.value = screen[e.fieldKey] ?? '';
    el.text = el.value;
    el.a11y = el.value;
  }
  const act = new SelectAct(page);
  for (const k of o.stuck ?? []) act.stuck.add(k);
  const scope = newScope({ inputs: o.inputs ?? INPUTS, profile: PROFILE, intentId: 'intent-1' });
  const env = stepEnv({ page, act, clock, dict: pkg.selectors, strings: pkg.strings, scope, domains: pkg.manifest.domains, irreversible: new Set(['s21']), defaultTimeoutMs: 1000, pollMs: 100 });
  let card: Record<string, string> | 'none' = 'none';
  const saved: string[] = [];
  // 체크포인트·번들 판정·게이트·PDF 저장은 실행기 몫(D03)이라 여기서는 흉내만 낸다: 양식 준비됨, 게이트에서 카드를 찍고 멈춤.
  const checkpoint: Handler<'checkpoint'> = async () => ({ t: 'next' });
  const decide: Handler<'decide'> = async (s) => ({ t: 'jump', to: s.on.no_visible_error ?? s.on.logged_in! });
  // 게이트 카드 = 게이트 앞 readback이 고정한 값(D02 V-03h). 엔진 readbackCard는 H-01 13칸 전용이라 여기서는 고정값을 그대로 본다(후속).
  const gate: Handler<'gate'> = async (_s, e) => {
    card = Object.fromEntries(e.scope.readback);
    return { t: 'jump', to: 'abort' };
  };
  const savePdf: Handler<'save_pdf'> = async (s) => {
    saved.push(s.docType);
    return { t: 'next' };
  };
  const events: string[] = [];
  const it = new Interpreter(pkg.playbook, { ...BASIC_HANDLERS, checkpoint, decide, gate, save_pdf: savePdf }, env, { retries: { stepMax: 2, backoff: 'equal_jitter', baseMs: 1000, capMs: 8000 }, retryFloorMs: 800, random: () => 0.5 }, {
    event: (n, d) => n === 'step.finished' && events.push(`${d.stepId}${d.code ? `:${d.code}` : ''}`),
  });
  return { page, act, it, events, card: () => card, saved };
}

describe('H-04 리플레이(가짜 화면): 양식 → readback → 대조 → 게이트', () => {
  it('용도·제출처를 고르고 주민번호 비공개로 두면 게이트에 닿고, 카드는 되읽은 7칸이다(요약 4칸 certDoc·certPurpose·certSubmitTo·rrnDisclosure 포함)', async () => {
    const r = h04Run();
    assert.deepEqual(await r.it.run('s10'), { t: 'abort', at: 's20', code: null });
    assert.deepEqual(r.events, ['s10', 's11', 's12', 's13', 's14', 's19', 's19a', 's19b', 's19c', 's19d', 's19f', 's20']);
    assert.deepEqual(r.card(), { supplierBizNo: '1068114550', applicantName: '주식회사 보내는곳', certDoc: '납세증명서(국세완납증명)', certPurpose: '대금수령', certSubmitTo: '금융기관', rrnDisclosure: '공개안함', copies: '1' });
    assert.ok(!r.act.log.some((l) => l.startsWith('click hometax.cert.taxpayment.form.applyButton')), '게이트 전에 신청하기를 누르지 않는다');
  });

  it('다른 사업자 세션(신청인 사업자번호 ≠ 프로필)이면 s19c assert.supplier_mismatch로 중단, 게이트에 닿지 않는다', async () => {
    const r = h04Run({ screen: { supplierBizNo: '220-81-62517' } });
    assert.deepEqual(await r.it.run('s10'), { t: 'abort', at: 's19c', code: 'assert.supplier_mismatch' });
    assert.equal(r.card(), 'none');
  });

  it('다른 민원 양식(민원명이 납세증명서가 아님)이면 s19d에서 중단, 게이트에 닿지 않는다', async () => {
    const r = h04Run({ screen: { certDoc: '사업자등록증명' } });
    assert.deepEqual(await r.it.run('s10'), { t: 'abort', at: 's19d', code: 'assert.input_mismatch' });
    assert.equal(r.card(), 'none');
  });

  it('포털이 사용용도 선택을 반영하지 않으면(이전 값 남음) s19f assert.input_mismatch로 중단, 게이트에 닿지 않는다', async () => {
    const r = h04Run({ screen: { certPurpose: '기타' }, stuck: ['hometax.cert.taxpayment.form.purpose'] });
    assert.deepEqual(await r.it.run('s10'), { t: 'abort', at: 's19f', code: 'assert.input_mismatch' });
    assert.equal(r.card(), 'none');
  });

  it('제출처가 비어 있으면(포털이 선택을 지움) 게이트 앞에서 멈춘다', async () => {
    const r = h04Run({ stuck: ['hometax.cert.taxpayment.form.submitTo'] });
    const out = await r.it.run('s10');
    assert.notEqual(out.t, 'end');
    assert.ok('at' in out && ['s19a', 's19f'].includes(out.at as string), JSON.stringify(out));
    assert.equal(r.card(), 'none');
  });
});

describe('H-04 리플레이: 발급 확인 뒤 출력 → PDF 저장', () => {
  it('s31 출력 → s32 문서 화면 대기 → s33 save_pdf(national_tax_cert) → s34 success', async () => {
    const r = h04Run();
    assert.deepEqual(await r.it.run('s31'), { t: 'end', at: 's34', status: 'success' });
    assert.deepEqual(r.saved, ['national_tax_cert']);
    assert.ok(r.act.log.includes('click hometax.cert.taxpayment.result.printButton'));
  });
});
