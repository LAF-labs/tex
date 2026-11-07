// ADR-039 fixture 포털 H-01 패키지(엔진 M2-3 PR-A2): 골든 s10~s35 + 가짜 H-01 페이지 셀렉터. RunService IR 전환 골든 대조(PR-C)의 입력이다.
// - 정적: 개발 조건 로더(서명·결속·V-01~V-25·V-03m·V-03n·V-04a·V-22·V-23a)를 통과하고, 골든과의 차이는 FIXTURE_SUBSTITUTIONS뿐이다.
// - 화면: 가짜 페이지(금고 중계 + Chrome headless, 127.0.0.1)에서 모든 셀렉터가 정확히 한 요소로 풀리고 R-A1(역할·이름)을 통과한다.
// 실제 포털 접속 없음.
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { connectRunBrowser, fixturePortal, PlaywrightPageReader, type RunBrowser } from '@sax/engine';
import { FIXTURE_PORTAL, resolveTarget, validatePackage, type loadPackage, type PackageFiles, type Step } from '@sax/engine/core';
import { startH01Fixture, type H01Fixture } from '../apps/desktop/src/h01-fixture.ts';
import { bundleOutcomes, h01, signPackage } from './core-fixtures.ts';
import { startHarness, type Harness } from './harness.ts';
import { FIXTURE_STEP_IDS, FIXTURE_SUBSTITUTIONS, fixtureId, h01FixtureFiles, h01FixtureLookupDefs, h01FixtureLookupFiles, loadH01Fixture } from './h01-fixture-package.ts';

const ORIGIN = 'http://127.0.0.1:4100';
const without = (s: Step, keys: readonly string[]) => Object.fromEntries(Object.entries(s).filter(([k]) => !keys.includes(k)));
/** 골든 스텝에 id 접두·origin만 바꾼 모양(대조 기준). */
const renamed = (s: Step, origin: string) =>
  JSON.parse(JSON.stringify(s).replaceAll('"https://hometax.go.kr', `"${origin}`).replace(/"(hometax\.invoice\.[A-Za-z0-9_.]+)"/g, (_, id: string) => `"${fixtureId(id)}"`)) as Step;

describe('fixture H-01 패키지: 정적(ADR-039)', () => {
  it('조회 패키지 2개와 발급 패키지가 개발 조건 로더를 통과한다(127.0.0.1·[::1])', () => {
    for (const origin of [ORIGIN, 'http://[::1]:4100']) {
      const r = loadH01Fixture(origin);
      assert.equal(r.pkg.files.manifest.portal, FIXTURE_PORTAL);
      assert.equal(r.pkg.files.manifest.kind, 'playbook');
      assert.deepEqual([...r.lookups.keys()], ['fixture.invoice.lookup', 'fixture.invoice.email_status']);
      assert.deepEqual(r.pkg.lookupDigests, [...r.lookups.values()].map((l) => l.manifestDigest));
    }
  });

  it('스텝은 골든 s10~s35 순서 그대로이고, 다른 곳은 FIXTURE_SUBSTITUTIONS(s21 signFlow·expectConfirm, s30 failSignals)뿐이다', () => {
    const g = h01().playbook.steps;
    const f = h01FixtureFiles(ORIGIN).playbook.steps;
    const from = g.findIndex((s) => s.id === 's10');
    const to = g.findIndex((s) => s.id === 's35');
    assert.deepEqual(f.map((s) => s.id), g.slice(from, to + 1).map((s) => s.id));
    assert.deepEqual([...FIXTURE_STEP_IDS], f.map((s) => s.id));
    for (const s of f) {
      const gs = renamed(g.find((x) => x.id === s.id)!, ORIGIN);
      const subs = FIXTURE_SUBSTITUTIONS[s.id] ?? [];
      assert.deepEqual(without(s, subs), without(gs, subs), s.id);
      // 바꾼다고 적은 필드는 실제로 다르다(목록이 낡지 않게).
      for (const k of subs) assert.notDeepEqual((s as Record<string, unknown>)[k], (gs as Record<string, unknown>)[k], `${s.id}.${k}`);
    }
  });

  it('s10·s11 URL은 가짜 페이지 발급 화면, s30 실패 신호는 fixturePortal.failureSignal', () => {
    const p = fixturePortal(ORIGIN);
    const steps = h01FixtureFiles(ORIGIN).playbook.steps;
    const at = (id: string) => steps.find((s) => s.id === id) as Step & { url?: string; failSignals?: unknown };
    assert.equal(at('s10').url, `${ORIGIN}${p.issueForm}`);
    assert.equal(at('s11').url, `${ORIGIN}${p.issueForm}`);
    assert.deepEqual(at('s30').failSignals, p.failureSignal);
  });

  it('셀렉터는 H01Runner fixturePortal과 같은 css·역할·이름이고, 골든의 fieldKey·inputType·commits를 지킨다', () => {
    const p = fixturePortal(ORIGIN);
    const g = h01().selectors.entries;
    const sel = h01FixtureFiles(ORIGIN).selectors.entries;
    const keys = Object.keys(sel);
    assert.equal(keys.length, 16);
    const byCss = new Map(Object.values(p.selectors).map((e) => [e.css, e]));
    for (const k of keys) {
      const e = sel[k]!;
      const css = e.candidates.find((c) => c.kind === 'css');
      assert.ok(css && css.kind === 'css', k);
      const pe = byCss.get(css.value);
      assert.ok(pe, `${k} ${css.value}`);
      assert.equal(e.role, pe.role, k);
      assert.equal(e.namePattern, pe.name, k);
      assert.equal(e.commits, pe.commits, k);
      assert.equal(e.commitEffect, pe.commitEffect, k);
      const ge = g[k.replace(/^fixture\.invoice\./, 'hometax.invoice.')]!;
      assert.equal(e.fieldKey, ge.fieldKey, k);
      if (k !== 'fixture.invoice.form.receiptType') assert.equal(e.inputType, ge.inputType, k);
    }
    assert.equal(sel['fixture.invoice.form.root']!.landmark, 'fixture.invoice.form.root');
  });

  it('조회 정의(PopupLookupPort)는 fixturePortal invoiceLookup·mailLookup이고 manifest.lookupsUsed id와 같다', () => {
    const p = fixturePortal(ORIGIN);
    const defs = h01FixtureLookupDefs(ORIGIN);
    assert.deepEqual(defs.get('fixture.invoice.lookup'), p.invoiceLookup);
    assert.deepEqual(defs.get('fixture.invoice.email_status'), p.mailLookup);
    assert.deepEqual(h01FixtureFiles(ORIGIN).manifest.lookupsUsed.map((l) => l.id), [...defs.keys()]);
    const verifies = h01FixtureFiles(ORIGIN).playbook.steps.flatMap((s) => (s.type === 'verify' ? [s.lookup.playbook] : []));
    assert.deepEqual(verifies, [...defs.keys()]);
  });

  it('실제 포털 URL을 섞으면 V-25로 거부한다(fixture 패키지에 https)', () => {
    const files: PackageFiles = h01FixtureFiles(ORIGIN);
    const s10 = files.playbook.steps.find((s) => s.id === 's10') as Step & { url: string };
    s10.url = 'https://hometax.go.kr/invoice/issue';
    const lookups = h01FixtureLookupFiles(ORIGIN);
    const v = validatePackage(files, { bundles: bundleOutcomes(), lookups });
    assert.ok(v.some((x) => x.rule === 'V-25' && x.step === 's10'), JSON.stringify(v));
  });

  it('제품 로더(dist)는 이 패키지를 loader.fixture_package로 거부한다(결정 2 ②)', async () => {
    const dist = (await import(new URL('../packages/engine/dist/core/loader.js', import.meta.url).href)) as { loadPackage: typeof loadPackage };
    const { keys, lookups } = loadH01Fixture(ORIGIN);
    const files = h01FixtureFiles(ORIGIN);
    const raw = signPackage(files, keys.pkg.slice(0, 2), files.manifest.lookupsUsed.map((l) => lookups.get(l.id)!.manifestDigest));
    const { BUNDLE_ALLOWLIST } = await import('@sax/model');
    const r = dist.loadPackage(raw, {
      roots: keys.roots, revoked: new Set(), bundleAllowlist: BUNDLE_ALLOWLIST, bundles: bundleOutcomes(), installedLookups: lookups,
      storedVersion: null, installedDigest: null, hold: false, policyFresh: true, now: Date.now(),
    });
    assert.equal(r.ok ? 'ok' : r.code, 'loader.fixture_package');
  });
});

describe('fixture H-01 패키지: 가짜 페이지에서 셀렉터 해석(금고 중계 + Chrome)', () => {
  let h: Harness;
  let fx: H01Fixture;
  let run: RunBrowser;
  before(async () => {
    fx = await startH01Fixture({ registry: { '2208162517': '가상거래처' }, supplier: { bizNo: '1234567890', name: '가상공급자' } });
    h = await startHarness();
    run = await connectRunBrowser(h.client);
  });
  after(async () => {
    await run?.browser.close().catch(() => {});
    await h?.close();
    await fx?.close();
  });

  it('발급 화면의 셀렉터 16개가 모두 정확히 한 요소로 풀리고 역할·이름(R-A1)이 맞다', async () => {
    const { pkg } = loadH01Fixture(fx.origin);
    await run.page.goto(`${fx.origin}/invoice/issue`, { waitUntil: 'load' });
    const reader = new PlaywrightPageReader(run.page);
    try {
      const misses: string[] = [];
      for (const k of Object.keys(pkg.selectors.entries)) {
        const r = await resolveTarget(reader, pkg.selectors, k);
        if (!r.ok) misses.push(`${k}:${r.code}`);
      }
      assert.deepEqual(misses, []);
    } finally {
      await reader.release();
    }
  });

  it('css 후보가 없어져도 role 후보로 같은 요소에 닿는다(두 번째 길)', async () => {
    const { pkg } = loadH01Fixture(fx.origin);
    await run.page.goto(`${fx.origin}/invoice/issue`, { waitUntil: 'load' });
    const reader = new PlaywrightPageReader(run.page);
    try {
      const dict = structuredClone(pkg.selectors);
      for (const e of Object.values(dict.entries)) e.candidates = e.candidates.filter((c) => c.kind === 'role');
      const misses: string[] = [];
      for (const k of Object.keys(dict.entries)) {
        const r = await resolveTarget(reader, dict, k);
        if (!r.ok) misses.push(`${k}:${r.code}`);
      }
      assert.deepEqual(misses, []);
    } finally {
      await reader.release();
    }
  });
});
