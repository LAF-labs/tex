// ADR-039 fixture 포털 H-01 패키지 빌더(엔진 M2-3 PR-A2). RunService IR 전환 골든 대조(PR-C)가 이 패키지로 IR 조율기를 돌린다.
// - 원천은 둘이다. 스텝은 골든 IR(tests/fixtures/core/h01/playbook.json) s10~s35를 그대로 쓴다. 셀렉터·조회 화면·실패 신호는
//   H01Runner가 가짜 H-01 페이지에서 쓰는 fixturePortal(origin)에서 가져온다. 그래서 두 실행기가 같은 화면 정의를 본다.
// - 가짜 페이지 포트가 시험마다 달라서 패키지는 저장소에 서명된 채로 두지 않고, 시험 중에 만들어 시험 키로 서명한다(ADR-039 결정 3).
// - 골든과 다른 곳은 FIXTURE_SUBSTITUTIONS에 적은 것뿐이다. 시험(h01-fixture-package.test.ts)이 그 밖의 차이가 없는지 본다.
import { fixturePortal, type LookupDef, type PortalConfig, type SelectorKey } from '@sax/engine';
import { FIXTURE_PORTAL, loadPackage, type LoadedPackage, type LoaderContext, type PackageFiles, type SelectorEntry, type Step } from '@sax/engine/core';
import { BUNDLE_ALLOWLIST } from '@sax/model';
import { bundleOutcomes, h01, signPackage, testKeys, type TestKeys } from './core-fixtures.ts';

/** 골든에서 가져오는 스텝 범위. 로그인(s0~s6)·캡차(s90~s93)는 뺀다: 가짜 페이지는 세션이 있다고 본다(H01Runner와 같음). */
export const FIXTURE_STEP_IDS = ['s10', 's11', 's12', 's13', 's14', 's15', 's16', 's17', 's18', 's19', 's19a', 's19b', 's19c', 's19d', 's19f', 's19e', 's20', 's21', 's30', 's32', 's32b', 's33', 's34', 's35'] as const;

/** 골든 스텝 중 가짜 페이지에 맞춰 바꾸는 필드(스텝 id → 바뀌는 키, 점으로 하위 키). 이 밖은 골든과 같다(id 접두·URL origin 제외). */
export const FIXTURE_SUBSTITUTIONS: Readonly<Record<string, readonly string[]>> = {
  // 가짜 페이지에는 전자서명 창·확인 대화상자가 없다(H01Runner도 signFlow 없이 발급 버튼만 누른다).
  s21: ['signFlow', 'expectConfirm'],
  // 실패 신호는 가짜 페이지 문구(fixturePortal.failureSignal)다.
  // 부재 판정 시간은 스키마 하한(30초) 때문에 패키지에서 바꾸지 않는다. 실행할 때 fixture 허가 뒤에서만 주입한다(IrPackage.verifyTiming).
  s30: ['failSignals'],
};

/** 골든 셀렉터 id(hometax.invoice.form.*) → fixturePortal 키. 골든 s10~s35가 쓰는 항목 전부다. */
const SELECTOR_MAP: Readonly<Record<string, SelectorKey>> = {
  'form.root': 'form.root',
  'form.supplierBizNo': 'form.supplierBizNo',
  'form.supplierName': 'form.supplierName',
  'form.counterpartBizNo': 'form.counterpartBizNo',
  'form.lookupCounterpart': 'form.lookupCounterpart',
  'form.counterpartName': 'form.counterpartName',
  'form.counterpartEmail': 'form.counterpartEmail',
  'form.item1.name': 'form.itemName',
  'form.itemCount': 'form.itemCount',
  'form.item1.supply': 'form.supplyAmount',
  'form.item1.tax': 'form.taxAmount',
  'form.totalAmount': 'form.totalAmount',
  'form.issueDate': 'form.issueDate',
  'form.remark': 'form.remark',
  'form.receiptType': 'form.receiptType',
  'form.issueButton': 'form.issueButton',
};

const GOLDEN_ORIGIN = 'https://hometax.go.kr';
const GOLDEN_PREFIX = 'hometax.invoice.';
const PREFIX = 'fixture.invoice.';
const LOOKUP_IDS: Readonly<Record<string, string>> = { 'hometax.invoice.lookup': 'fixture.invoice.lookup', 'hometax.invoice.email_status': 'fixture.invoice.email_status' };

/** 골든 id → fixture id(셀렉터·조회 패키지). 모르는 id는 그대로(정적 검증 V-02·V-22가 잡는다). */
export const fixtureId = (id: string) => LOOKUP_IDS[id] ?? (id.startsWith(GOLDEN_PREFIX) ? PREFIX + id.slice(GOLDEN_PREFIX.length) : id);

/** `^리터럴$` 패턴 → 접근성 이름(role 후보용). 정규식 문자가 섞이면 실패로 알린다. */
function literalName(pattern: string): string {
  const m = /^\^([^\\.*+?()[\]{}|^$]*)\$$/.exec(pattern);
  if (!m) throw new Error(`fixture 셀렉터 이름 패턴이 리터럴이 아님: ${pattern}`);
  return m[1]!;
}

const LAST_VERIFIED = '2026-11-07';

/** 골든 항목의 inputType·fieldKey·allowedConstants·reviewNote는 두고, 역할·이름·후보·랜드마크만 가짜 페이지 값으로 바꾼다. */
function fixtureEntry(golden: SelectorEntry, p: PortalConfig, key: SelectorKey): SelectorEntry {
  const e = p.selectors[key];
  const out: SelectorEntry = {
    ...structuredClone(golden),
    // H01Runner처럼 css(#id)로 먼저 찾고 역할·이름은 R-A1로 확인한다. role 후보는 css가 바뀌었을 때의 두 번째 길이다.
    candidates: [{ kind: 'css', value: e.css }, { kind: 'role', role: e.role, name: literalName(e.name) }],
    role: e.role,
    namePattern: e.name,
    frame: 'main',
    landmark: e.landmark ? PREFIX + e.landmark : PREFIX + key,
    lastVerified: LAST_VERIFIED,
  };
  if (key === 'form.receiptType') {
    // 가짜 페이지는 라디오가 아니라 select(combobox "영수/청구")다.
    out.inputType = 'select';
  }
  if (key === 'form.lookupCounterpart') out.reviewNote = { by: 'engine-core', reason: '거래처 조회(/api/cp), 커밋 엔드포인트 요청 없음' };
  return out;
}

/** 골든 스텝 → fixture 스텝(id 접두·URL origin, FIXTURE_SUBSTITUTIONS). */
function fixtureStep(s: Step, origin: string, p: PortalConfig): Step {
  const json = JSON.stringify(s)
    .replaceAll(`"${GOLDEN_ORIGIN}`, `"${origin}`)
    .replace(/"(hometax\.invoice\.[A-Za-z0-9_.]+)"/g, (_, id: string) => `"${fixtureId(id)}"`);
  const out = JSON.parse(json) as Step & Record<string, unknown>;
  if (out.type === 'submit') {
    delete out.signFlow;
    delete out.expectConfirm;
  }
  if (out.type === 'verify' && out.id === 's30') out.failSignals = p.failureSignal.map((f) => ({ css: f.css, text: f.text }));
  return out;
}

/** 가짜 H-01 페이지(origin = startH01Fixture().origin)용 발급 패키지 파일(서명 전). */
export function h01FixtureFiles(origin: string): PackageFiles {
  const p = fixturePortal(origin);
  const g = h01();
  const steps = FIXTURE_STEP_IDS.map((id) => {
    const s = g.playbook.steps.find((x) => x.id === id);
    if (!s) throw new Error(`골든에 ${id}가 없음`);
    return fixtureStep(s, origin, p);
  });
  const entries: Record<string, SelectorEntry> = {};
  for (const [gid, key] of Object.entries(SELECTOR_MAP)) {
    const golden = g.selectors.entries[GOLDEN_PREFIX + gid];
    if (!golden) throw new Error(`골든 셀렉터 ${gid}가 없음`);
    entries[PREFIX + gid] = fixtureEntry(golden, p, key);
  }
  const strings = { ...g.strings };
  for (const k of ['captcha.prompt', 'hometax.login.successMarker', 'confirm.issue']) delete strings[k];
  strings['invoice.emailNotConfirmed'] = '발급은 완료되었습니다. 메일 발송은 메일발송목록에서 확인해 주세요';
  return {
    manifest: {
      ...g.manifest,
      id: 'fixture.invoice.issue',
      portal: FIXTURE_PORTAL,
      domains: [new URL(origin).hostname === '[::1]' ? '[::1]' : '127.0.0.1'],
      // screen_state는 로그인·캡차 decide(s2·s6·s93)만 쓴다.
      bundlesUsed: g.manifest.bundlesUsed.filter((b) => b.id === 'form_ready'),
      lookupsUsed: g.manifest.lookupsUsed.map((l) => ({ ...l, id: fixtureId(l.id) })),
      createdAt: '2026-11-07T00:00:00+09:00',
    },
    playbook: { ...g.playbook, id: 'fixture.invoice.issue', portal: FIXTURE_PORTAL, steps },
    selectors: {
      portal: FIXTURE_PORTAL,
      entries,
      // 가짜 페이지의 발급은 문서 POST(form)다. 본문 대조(R-C1 bodyFieldMap)는 두지 않는다(H01Runner도 하지 않는다).
      commitEndpoints: [{ match: { method: 'POST', pathPattern: '^/invoice/issue$' }, effect: 'issue_document', maxRequests: 1, encoding: 'form' }],
      knownEndpoints: [
        { method: 'GET', pathPattern: '^/invoice/(issue|list)$' },
        { method: 'GET', pathPattern: '^/mail/list$' },
        { method: 'GET', pathPattern: '^/api/(cp|knob)$' },
      ],
    },
    strings,
  };
}

/** 조회 하위 패키지 2개(V-22 정적 검증용). 실제 조회는 PopupLookupPort가 h01FixtureLookupDefs로 한다(H01Runner.lookup과 같음). */
export function h01FixtureLookupFiles(origin: string): Map<string, PackageFiles> {
  const p = fixturePortal(origin);
  const host = new URL(origin).hostname === '[::1]' ? '[::1]' : '127.0.0.1';
  const one = (id: string, def: LookupDef, table: { css: string; name: string }): PackageFiles => ({
    manifest: {
      id, version: '1.0.0', kind: 'lookup', portal: FIXTURE_PORTAL, title: 'lookup.title', profileKinds: ['business'], engineRange: '>=1.0.0 <2.0.0', domains: [host],
      effects: [], bundlesUsed: [], lookupsUsed: [], contentDigests: { playbook: '0'.repeat(64), selectors: '0'.repeat(64), strings: '0'.repeat(64) },
      createdAt: '2026-11-07T00:00:00+09:00', signatures: [],
    },
    playbook: {
      ir: 2, id, version: '1.0.0', portal: FIXTURE_PORTAL, profileKinds: ['business'], effects: [], inputs: { key: { type: 'string', required: true } },
      steps: [
        { id: 's0', type: 'goto', url: `${origin}${def.path}` },
        { id: 's1', type: 'wait', for: 'selector', value: `${id}.rows` },
        { id: 's2', type: 'extract', name: 'rows', from: { a11y: { target: `${id}.rows` } } },
        { id: 's3', type: 'end', status: 'success' },
      ],
      postconditions: [],
    } as unknown as PackageFiles['playbook'],
    selectors: {
      portal: FIXTURE_PORTAL,
      entries: {
        [`${id}.rows`]: {
          candidates: [{ kind: 'css', value: table.css }, { kind: 'role', role: 'table', name: table.name }],
          role: 'table', namePattern: `^${table.name}$`, frame: 'main', landmark: `${id}.rows`, commits: false, lastVerified: LAST_VERIFIED,
        },
      },
      commitEndpoints: [],
      knownEndpoints: [{ method: 'GET', pathPattern: `^${def.path}$` }],
    },
    strings: { 'lookup.title': '조회' },
  });
  return new Map([
    ['fixture.invoice.lookup', one('fixture.invoice.lookup', p.invoiceLookup, { css: '#invoice-list', name: '발급목록' })],
    ['fixture.invoice.email_status', one('fixture.invoice.email_status', p.mailLookup, { css: '#mail-list', name: '메일발송목록' })],
  ]);
}

/** verify.lookup.playbook → 조회 화면 정의(PopupLookupPort defs). */
export function h01FixtureLookupDefs(origin: string): Map<string, LookupDef> {
  const p = fixturePortal(origin);
  return new Map([['fixture.invoice.lookup', p.invoiceLookup], ['fixture.invoice.email_status', p.mailLookup]]);
}

export interface LoadedFixture {
  pkg: LoadedPackage;
  lookups: Map<string, LoadedPackage>;
  keys: TestKeys;
}

/** 시험 키로 서명하고 개발 조건 로더(FIXTURE_LOAD_ALLOWED)로 로드한다. 실패면 던진다. */
export function loadH01Fixture(origin: string, o: { keys?: TestKeys; now?: number } = {}): LoadedFixture {
  const keys = o.keys ?? testKeys();
  const two = keys.pkg.slice(0, 2);
  const ctx = (installedLookups: ReadonlyMap<string, LoadedPackage>): LoaderContext => ({
    roots: keys.roots, revoked: new Set(), bundleAllowlist: BUNDLE_ALLOWLIST, bundles: bundleOutcomes(), installedLookups,
    storedVersion: null, installedDigest: null, hold: false, policyFresh: true, now: o.now ?? Date.now(),
  });
  const lookups = new Map<string, LoadedPackage>();
  for (const [id, files] of h01FixtureLookupFiles(origin)) {
    const r = loadPackage(signPackage(files, two), ctx(new Map()));
    if (!r.ok) throw new Error(`fixture 조회 패키지 ${id}: ${r.code} ${JSON.stringify(r.violations)}`);
    lookups.set(id, r.pkg);
  }
  const files = h01FixtureFiles(origin);
  const r = loadPackage(signPackage(files, two, files.manifest.lookupsUsed.map((l) => lookups.get(l.id)?.manifestDigest ?? '0'.repeat(64))), ctx(lookups));
  if (!r.ok) throw new Error(`fixture 발급 패키지: ${r.code} ${JSON.stringify(r.violations)}`);
  return { pkg: r.pkg, lookups, keys };
}
