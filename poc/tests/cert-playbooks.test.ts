// 홈택스 즉시발급 민원증명(H-03·H-08·H-09, ADR-018 결정 2) 패키지: 공유 템플릿(scripts/playbooks/hometax-certificate.ts) → 제품 원본(packages/engine/playbooks).
// 정적 검증기(V-01~V-25) 통과, 저장된 JSON = 템플릿 결과, 서류별 차이는 입력·셀렉터뿐, fixture 포털 변형이 개발 로더를 통과하고 제품 로더는 거부한다(ADR-039).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { APPROVAL_SUMMARIES, FIXTURE_PORTAL, buildCfg, commitWindow, irreversibleSteps, loadPackage, validatePackage, type LoadedPackage, type LoaderContext, type PackageFiles, type Step } from '@sax/engine/core';
import { FIELD_KEYS, type GateField } from '@sax/engine/gate';
import { BUNDLE_ALLOWLIST } from '@sax/model';
import { CARD_ROWS, CERT_IRREVERSIBLE_TEXT, CERT_SUMMARY_LABELS, certGateText, summarizeCert } from '../apps/desktop/src/approval-gate.ts';
import { certOutputs } from '../scripts/gen-cert-playbooks.ts';
import { CERT_DOCS, certPackage, LOOKUP_ID } from '../scripts/playbooks/hometax-certificate.ts';
import { bundleOutcomes, loadPkg, signPackage, testKeys } from './core-fixtures.ts';

const ROOT = path.resolve(import.meta.dirname, '..');
const DIR = path.join(ROOT, 'packages/engine/playbooks');
const bundles = bundleOutcomes();
/** 발급 확인 조회: H-04(LAF-labs/tex#247)가 만든 공유 IR 조회 패키지(저장소 원본) */
const issuedList = (): PackageFiles => loadPkg(LOOKUP_ID);
const lookupMap = () => new Map([[LOOKUP_ID, issuedList()]]);
const stepsOf = (p: PackageFiles) => p.playbook.steps as (Step & Record<string, unknown>)[];

describe('즉시발급 민원증명 패키지: 정적', () => {
  it('서류 3종이 공유 조회(hometax.cert.issued_list)와 함께 정적 검증기(V-01~V-25)를 통과한다', () => {
    assert.deepEqual(validatePackage(issuedList(), { bundles }), []);
    for (const d of CERT_DOCS) assert.deepEqual(validatePackage(certPackage(d), { bundles, lookups: lookupMap() }), [], d.code);
  });

  it('저장소의 원본(packages/engine/playbooks)은 템플릿 결과와 같다(손으로 고치지 않는다: node scripts/gen-cert-playbooks.ts)', () => {
    for (const [rel, text] of certOutputs()) assert.equal(fs.readFileSync(path.join(DIR, rel), 'utf8'), text, rel);
    for (const d of CERT_DOCS) assert.deepEqual(loadPkg(d.id), certPackage(d));
  });

  it('흐름은 하나다: 서류마다 다른 스텝은 들어가는 길(s10*: 직접 주소 또는 메뉴)과 서류별 칸(s16*·s18*)뿐이고, 다른 셀렉터는 메뉴·양식 제목·제출 버튼·서류별 칸뿐이다', () => {
    const [h03, ...rest] = CERT_DOCS.map(certPackage);
    const shared = (p: PackageFiles) => stepsOf(p).filter((s) => !/^s1[068][a-z]?$/.test(s.id) || s.id === 's10x').map((s) => {
      const c = structuredClone(s) as Record<string, unknown>;
      if (s.id === 's19a' || s.id === 's19b' || s.id === 's19f' || s.id === 's32') return { id: s.id, type: s.type };
      return c;
    });
    for (const p of rest) assert.deepEqual(shared(p), shared(h03!));
    const docKeys = (d: (typeof CERT_DOCS)[number]) => new Set(d.fields.map((f) => `hometax.cert.form.${f.input}`));
    const base = new Set(Object.keys(h03!.selectors.entries));
    for (const [i, p] of rest.entries()) {
      const keys = new Set(Object.keys(p.selectors.entries));
      assert.deepEqual([...keys].filter((k) => !base.has(k)).sort(), [...docKeys(CERT_DOCS[i + 1]!)].sort());
      for (const k of base) {
        if (['hometax.cert.menu.doc', 'hometax.cert.form.root', 'hometax.cert.form.issueButton'].includes(k)) continue;
        assert.deepEqual(p.selectors.entries[k], h03!.selectors.entries[k], k);
      }
    }
  });

  it('비가역은 발급 버튼 하나(issue_document): W(s21) = {s20, s21}, 게이트가 지배하고, 다른 셀렉터는 커밋하지 않는다', () => {
    for (const d of CERT_DOCS) {
      const p = certPackage(d);
      assert.deepEqual(p.manifest.effects, ['issue_document']);
      const commits = Object.entries(p.selectors.entries).filter(([, e]) => e.commits).map(([k, e]) => [k, e.commitEffect]);
      assert.deepEqual(commits, [['hometax.cert.form.issueButton', 'issue_document']]);
      const pre = buildCfg(p.playbook);
      const irreversible = irreversibleSteps(p.selectors, pre.info);
      assert.deepEqual([...irreversible], ['s21']);
      const cfg = buildCfg(p.playbook, { irreversible });
      assert.deepEqual([...commitWindow(cfg, 's20', 's21')].sort(), ['s20', 's21']);
      assert.ok(cfg.dom.get('s21')!.has('s20'));
    }
  });

  it('게이트 앞에서 신청인(= 내 사업자)·용도·제출처·주민번호 공개 여부·서류별 칸을 입력과 대조하고, 주민번호는 기본으로 가린다', () => {
    for (const d of CERT_DOCS) {
      const p = certPackage(d);
      const s = (id: string) => stepsOf(p).find((x) => x.id === id)!;
      assert.deepEqual(s('s19c').cond, { readbackEquals: { fieldKey: 'supplierBizNo', ref: '$profile.bizNo' } });
      const eq = (s('s19f').cond as { all: Array<{ readbackEquals: { fieldKey: string } }> }).all.map((c) => c.readbackEquals.fieldKey);
      assert.deepEqual(eq, ['certDoc', 'certLanguage', 'certPurpose', 'certSubmitTo', 'rrnDisclosure', ...d.fields.filter((f) => !/Date$/.test(f.fieldKey)).map((f) => f.fieldKey)]);
      assert.deepEqual((p.playbook.inputs as Record<string, { values?: string[]; default?: string }>).certDoc, { type: 'enum', values: [d.name], default: d.name });
      assert.deepEqual((p.playbook.inputs as Record<string, { default?: string }>).rrnDisclosure!.default, '비공개');
      assert.equal(s('s32').docType, d.docType);
      // 발급 안 됨이면 홈 체크포인트로 돌아가 다시 채우고 새 승인을 받는다
      assert.equal((s('s30').on as { not_committed: string }).not_committed, 's10');
    }
  });

  it('세 서류가 H-04와 같은 조회 패키지(hometax.cert.issued_list)를 참조만 한다(이 템플릿은 조회 패키지를 만들지 않는다)', () => {
    for (const d of CERT_DOCS) {
      const p = certPackage(d);
      assert.deepEqual(p.manifest.lookupsUsed.map((x) => x.id), [LOOKUP_ID]);
      const v = stepsOf(p).find((x) => x.id === 's30') as { lookup: { playbook: string; match: Record<string, string>; bind: Record<string, string> } };
      assert.deepEqual([v.lookup.playbook, v.lookup.match, v.lookup.bind], [LOOKUP_ID, { certDoc: '$readback.certDoc' }, { approvalNo: 'issueNo' }]);
    }
    assert.ok(![...certOutputs().keys()].some((k) => k.startsWith(`${LOOKUP_ID}/`)));
  });

  it('캡처(2026-11-10) 반영: 메뉴 직접 주소·제출 버튼(H-03 작성완료, H-08 신청하기)·선택지·H-08 과세기간과 발급희망개업일자, 개인사업자 로그인 차단 알림이면 멈춘다', () => {
    const [h03, h08, h09] = CERT_DOCS.map(certPackage);
    const s10 = (p: PackageFiles) => stepsOf(p).find((x) => x.id === 's10')!;
    assert.match(s10(h03!).url as string, /tm3lIdx=4315010800$/);
    assert.match(s10(h08!).url as string, /tm3lIdx=4315010500$/);
    assert.equal(s10(h09!).url, 'https://hometax.go.kr/', 'H-09는 메뉴 코드를 몰라 메뉴로 들어간다');
    const btn = (p: PackageFiles) => p.selectors.entries['hometax.cert.form.issueButton']!;
    assert.deepEqual([btn(h03!).namePattern, btn(h03!).candidates[0]], ['^작성완료$', { kind: 'css', value: '#mf_txppWframe_btn_wrtCmpl' }]);
    assert.deepEqual([btn(h08!).namePattern, btn(h08!).candidates[0]], ['^신청하기$', { kind: 'css', value: '#mf_txppWframe_btn_apln' }]);
    const inputs = h03!.playbook.inputs as Record<string, { values?: string[] }>;
    assert.ok(inputs.purpose!.values!.includes('금융기관제출용') && inputs.submitTo!.values!.includes('금융기관'));
    assert.deepEqual(h03!.selectors.entries['hometax.cert.form.receiveMethod']!.allowedConstants, ['인터넷발급(프린터출력)']);
    for (const k of ['periodStartYear', 'periodStartHalf', 'periodEndYear', 'periodEndHalf', 'openDate']) assert.ok(k in (h08!.playbook.inputs as object), k);
    assert.equal(h08!.selectors.entries['hometax.cert.form.openDate']!.candidates[0]!.kind === 'css' && (h08!.selectors.entries['hometax.cert.form.openDate']!.candidates[0] as { value: string }).value, '#mf_txppWframe_sbx_bmanOfbDt');
    // 발급희망개업일자(날짜형)는 따로 입력 대조(V-03j′)
    assert.deepEqual(stepsOf(h08!).find((x) => x.id === 's18a')!.cond, { readbackEquals: { fieldKey: 'bizOpenDate', ref: '$inputs.openDate' } });
    for (const p of [h03!, h08!, h09!]) {
      const x = stepsOf(p).find((s) => s.id === 's10x')!;
      assert.deepEqual([x.code, x.onFail], ['portal.personal_login_required', { retry: 0, then: 'abort' }]);
      assert.ok(new RegExp(p.strings['cert.block.personalOnly']!).test('레이어 팝업 레이어팝업시작 알림 해당 화면은 개인사업자는 이용할 수 없습니다. 레이어팝업끝'));
    }
  });

  it('캡처 목록(CAPTURE-hometax-cert.md)은 모르는 셀렉터마다 한 줄이고, 발급 버튼·로그인 수단·조회 표가 들어 있다', () => {
    const md = certOutputs().get('CAPTURE-hometax-cert.md')!;
    for (const k of ['hometax.cert.form.issueButton', 'hometax.login.simpleAuthButton', 'hometax.cert.form.docName', 'hometax.cert.alert', 'hometax.cert.form.fiscalYear']) assert.ok(md.includes(`\`${k}\``), k);
  });
});

/** 제품 원본 → fixture 포털 변형(ADR-039): origin·id·포털만 바꾼다. 흐름·셀렉터 의미는 그대로 */
function toFixture(files: PackageFiles, origin: string): PackageFiles {
  const host = new URL(origin).hostname;
  const text = JSON.stringify(files).replaceAll('https://hometax.go.kr', origin).replaceAll('"hometax.cert.', '"fixture.cert.').replaceAll('"hometax.', '"fixture.');
  const f = JSON.parse(text) as PackageFiles;
  f.manifest.portal = FIXTURE_PORTAL;
  f.manifest.domains = [host];
  f.playbook.portal = FIXTURE_PORTAL;
  f.selectors.portal = FIXTURE_PORTAL;
  return f;
}

describe('승인 카드(팀장 결정 2026-11-09): 요약 표·fieldKey 닫힌 목록·카드 라벨', () => {
  it('엔진 승인 바 요약 표 cert.confirm = 서류·사용 용도·제출처·주민번호 공개 여부(H-04와 공통), 네 칸은 fieldKey 닫힌 목록(B-24)과 remote-envelope 스키마에 있다', () => {
    assert.deepEqual(APPROVAL_SUMMARIES.get('cert.confirm'), ['certDoc', 'certPurpose', 'certSubmitTo', 'rrnDisclosure']);
    const schema = JSON.parse(fs.readFileSync(path.join(ROOT, '../sovereign-ax/design/schemas/remote-envelope.schema.json'), 'utf8')) as unknown;
    const enums = JSON.stringify(schema);
    for (const k of APPROVAL_SUMMARIES.get('cert.confirm')!) {
      assert.ok((FIELD_KEYS as readonly string[]).includes(k), k);
      assert.ok(enums.includes(`"${k}"`), k);
    }
    // 세 서류의 게이트 앞 readback이 요약 칸을 모두 담는다
    for (const d of CERT_DOCS) {
      const rb = (certPackage(d).playbook.steps.find((x) => x.id === 's19b') as { fields: string[] }).fields;
      for (const k of APPROVAL_SUMMARIES.get('cert.confirm')!) assert.ok(rb.includes(k), `${d.code} ${k}`);
    }
  });

  it('데스크톱 카드: 「서류」「사용 용도」「제출처」「주민번호 공개」 4줄(CARD_ROWS.cert), 비가역 한 줄, 빈 값·위험 문자·중복 키는 무장하지 않는다', () => {
    const fields = [{ fieldKey: 'certDoc', value: '사업자등록증명' }, { fieldKey: 'certPurpose', value: '금융기관 제출용' }, { fieldKey: 'certSubmitTo', value: 'OO은행' }, { fieldKey: 'rrnDisclosure', value: '비공개' }] as GateField[];
    const rows = summarizeCert({ fields });
    assert.ok(Array.isArray(rows));
    assert.deepEqual(rows.map((r) => [r.label, r.pieces.map((p) => p.text).join('')]), [['서류', '사업자등록증명'], ['사용 용도', '금융기관 제출용'], ['제출처', 'OO은행'], ['주민번호 공개', '비공개']]);
    assert.equal(rows.length, CARD_ROWS.cert);
    assert.deepEqual(CERT_SUMMARY_LABELS.map(([k]) => k), APPROVAL_SUMMARIES.get('cert.confirm'));
    assert.equal(CERT_IRREVERSIBLE_TEXT, '발급하면 홈택스 발급 이력에 남습니다. 되돌릴 수 없어요.');
    assert.deepEqual(certGateText('사업자등록증명', '승인하고 발급'), { title: '사업자등록증명', chip: '승인 대기', action: '승인하고 발급', irreversible: CERT_IRREVERSIBLE_TEXT, stop: '중지' });
    assert.deepEqual(summarizeCert({ fields: fields.slice(1) }), { reason: 'missing', label: '서류' });
    assert.deepEqual(summarizeCert({ fields: [fields[0]!, { fieldKey: 'certPurpose', value: '용도\u202e' }, ...fields.slice(2)] as GateField[] }), { reason: 'unsafe', label: '사용 용도' });
    assert.deepEqual(summarizeCert({ fields: [...fields, fields[0]!] }), { reason: 'duplicate' });
    const dup = summarizeCert({ fields: [...fields, { fieldKey: '$dup.businessKey', value: 'committed' }] as GateField[] });
    assert.ok(Array.isArray(dup) && dup[0]!.flag === '이미 발급됨(승인번호 있음)' && dup[0]!.tone === 'attention');
  });
});

describe('즉시발급 민원증명 패키지: fixture 포털 변형(ADR-039)', () => {
  const ORIGIN = 'http://127.0.0.1:4100';
  const keys = testKeys();
  const two = keys.pkg.slice(0, 2);
  const ctx = (installedLookups: ReadonlyMap<string, LoadedPackage>, approvalSummaries: ReadonlyMap<string, readonly string[]> = APPROVAL_SUMMARIES): LoaderContext => ({
    roots: keys.roots, revoked: new Set(), bundleAllowlist: BUNDLE_ALLOWLIST, bundles, installedLookups, storedVersion: null, installedDigest: null, hold: false, policyFresh: true, now: Date.now(),
    approvalSummaries,
  });

  it('시험 키로 서명한 fixture 변형(공유 조회 + 서류 3종)이 개발 조건 로더를 통과한다', () => {
    const lr = loadPackage(signPackage(toFixture(issuedList(), ORIGIN), two), ctx(new Map()));
    assert.ok(lr.ok, lr.ok ? '' : `${lr.code} ${JSON.stringify(lr.violations)}`);
    const lookups = new Map([['fixture.cert.issued_list', lr.pkg]]);
    for (const d of CERT_DOCS) {
      const files = toFixture(certPackage(d), ORIGIN);
      const r = loadPackage(signPackage(files, two, [lr.pkg.manifestDigest]), ctx(lookups));
      assert.ok(r.ok, r.ok ? '' : `${d.code}: ${r.code} ${JSON.stringify(r.violations)}`);
      assert.equal(r.pkg.files.manifest.portal, FIXTURE_PORTAL);
      assert.deepEqual(r.pkg.lookupDigests, [lr.pkg.manifestDigest]);
    }
  });

  it('cert.confirm 요약 칸이 앱 내장 표에 없으면 LOADER-8로 거부한다(표가 로드 조건이다)', () => {
    const lr = loadPackage(signPackage(toFixture(issuedList(), ORIGIN), two), ctx(new Map()));
    assert.ok(lr.ok);
    const without = new Map([...APPROVAL_SUMMARIES].filter(([k]) => k !== 'cert.confirm'));
    const r = loadPackage(signPackage(toFixture(certPackage(CERT_DOCS[0]!), ORIGIN), two, [lr.pkg.manifestDigest]), ctx(new Map([['fixture.cert.issued_list', lr.pkg]]), without));
    assert.equal(r.ok ? 'ok' : r.code, 'loader.approval_summary_missing');
  });

  it('제품 로더(dist)는 fixture 변형을 loader.fixture_package로, 서명 전 제품 원본을 registry.signature_insufficient로 거부한다', async () => {
    const dist = (await import(new URL('../packages/engine/dist/core/loader.js', import.meta.url).href)) as typeof import('../packages/engine/src/core/loader.ts');
    const lr = dist.loadPackage(signPackage(toFixture(issuedList(), ORIGIN), two), ctx(new Map()));
    assert.equal(lr.ok ? 'ok' : lr.code, 'loader.fixture_package');
    const bytes = (o: unknown) => Buffer.from(JSON.stringify(o), 'utf8');
    for (const f of CERT_DOCS.map(certPackage)) {
      const r = dist.loadPackage({ manifest: bytes(f.manifest), playbook: bytes(f.playbook), selectors: bytes(f.selectors), strings: bytes(f.strings) }, ctx(new Map()));
      assert.equal(r.ok ? 'ok' : r.code, 'registry.signature_insufficient', f.manifest.id);
    }
  });
});
