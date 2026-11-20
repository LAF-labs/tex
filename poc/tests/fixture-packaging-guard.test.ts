import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { BUNDLE_ALLOWLIST } from '@sax/model';
import { bundleOutcomes, h01, lookups } from './core-fixtures.ts';
import { sampleKeys } from './registry-samples.ts';
// @ts-expect-error 설정은 .mjs(타입 없음)
import { EXCLUDE } from '../apps/desktop/build/electron-builder.config.mjs';

const POC = path.join(import.meta.dirname, '..');
const read = (p: string) => fs.readFileSync(path.join(POC, p), 'utf8');

function devOnlyRe(): RegExp {
  const m = /const DEV_ONLY_RE = \/(.+)\/([a-z]*);/.exec(read('scripts/package-win.mjs'));
  assert.ok(m, 'package-win.mjs에 DEV_ONLY_RE가 없다(포장 판정이 바뀌었으면 ADR-039 결정 4를 함께 고친다)');
  return new RegExp(m[1]!, m[2]);
}

function walk(dir: string, out: string[] = []): string[] {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name !== 'node_modules' && e.name !== 'dist') walk(p, out);
    } else out.push(p);
  }
  return out;
}

function productPackages(): Map<string, string> {
  const dirs = new Map<string, string>();
  for (const root of ['packages', 'apps', 'services']) {
    for (const d of fs.readdirSync(path.join(POC, root))) {
      const pj = path.join(POC, root, d, 'package.json');
      if (fs.existsSync(pj)) dirs.set((JSON.parse(fs.readFileSync(pj, 'utf8')) as { name: string }).name, path.join(root, d));
    }
  }
  dirs.set('@sax/tests', 'tests');
  const out = new Map<string, string>();
  const stack = ['@sax/desktop'];
  while (stack.length) {
    const n = stack.pop()!;
    if (out.has(n) || !dirs.has(n)) continue;
    out.set(n, dirs.get(n)!);
    const deps = (JSON.parse(read(`${dirs.get(n)}/package.json`)) as { dependencies?: Record<string, string> }).dependencies ?? {};
    for (const [dep, v] of Object.entries(deps)) if (v.startsWith('workspace:')) stack.push(dep);
  }
  return out;
}

const BUILDS_FIXTURE = /\bportal['"]?\s*[:=]\s*['"]fixture['"]|\.portal\s*=\s*FIXTURE_PORTAL/;

describe('ADR-039 결정 4 포장 가드(2차 방어)', () => {
  it('DEV_ONLY_RE는 fixture 모듈 이름을 잡고 제품 모듈은 잡지 않는다', () => {
    const re = devOnlyRe();
    for (const f of ['h01-fixture.js', 'fixture-package.js', 'h01-fixture-ir.js']) assert.ok(re.test(f), f);
    for (const f of ['loader.js', 'validate.js', 'registry-sync.js', 'portal.js']) assert.ok(!re.test(f), f);
  });

  it('제품 소스에서 fixture 패키지를 만드는 모듈은 이름이 DEV_ONLY_RE에 걸린다(진입점에서 닿으면 dev_only_code_included)', () => {
    const re = devOnlyRe();
    const offenders: string[] = [];
    for (const [, dir] of productPackages()) {
      for (const f of walk(path.join(POC, dir, 'src'))) {
        if (!/\.(ts|mts|js|mjs)$/.test(f) || /\.test\.ts$/.test(f)) continue;
        if (!BUILDS_FIXTURE.test(fs.readFileSync(f, 'utf8'))) continue;
        const js = path.basename(f).replace(/\.m?ts$/, '.js');
        if (!re.test(js)) offenders.push(path.relative(POC, f));
      }
    }
    assert.deepEqual(offenders, [], 'fixture 패키지를 만드는 코드는 파일 이름에 fixture를 넣는다(ADR-039 결정 4)');
  });

  it('@sax/tests(tests/fixtures의 IR 패키지)는 데스크톱 앱의 운영 의존(전이)에 없다', () => {
    const prod = productPackages();
    assert.ok(prod.has('@sax/engine') && prod.has('@sax/desktop'));
    assert.ok(!prod.has('@sax/tests'), [...prod.keys()].join(','));
  });

  it('제품 소스는 tests/ 아래를 import하지 않는다', () => {
    const offenders: string[] = [];
    for (const [, dir] of productPackages()) {
      for (const f of walk(path.join(POC, dir, 'src'))) {
        if (!/\.(ts|mts|js|mjs)$/.test(f) || /\.test\.ts$/.test(f)) continue;
        if (/from\s+['"][^'"]*\/tests\/|import\(\s*['"][^'"]*\/tests\//.test(fs.readFileSync(f, 'utf8'))) offenders.push(path.relative(POC, f));
      }
    }
    assert.deepEqual(offenders, []);
  });

  it('설치본은 TS 소스·fixtures·tests 폴더를 빼므로 제품 엔진은 dist로만 돈다(FIXTURE_LOAD_ALLOWED 거짓)', () => {
    const ex = EXCLUDE as string[];
    assert.ok(ex.includes('!**/*.ts'));
    assert.ok(ex.includes('!node_modules/@sax/*/src/**'));
    const dirs = ex.find((p) => p.startsWith('!**/{') && p.endsWith('}/**'));
    assert.ok(dirs, 'test·fixtures 폴더 제외 패턴');
    const names = dirs.slice(4, -4).split(',');
    for (const n of ['tests', 'fixtures']) assert.ok(names.includes(n), n);
  });

  it('tests/fixtures 아래 fixture 포털 IR 패키지는 fixtures 폴더 안에만 있다', () => {
    for (const f of walk(path.join(POC, 'tests'))) {
      if (!f.endsWith('manifest.json')) continue;
      const m = JSON.parse(fs.readFileSync(f, 'utf8')) as { portal?: string };
      if (m.portal === 'fixture') assert.ok(path.relative(POC, f).split(path.sep).includes('fixtures'), path.relative(POC, f));
    }
  });

  it('제품 플레이북 원본(packages/engine/playbooks)은 실제 포털 패키지만, 서명 전이라 제품 로더가 받지 않고, 제품 소스는 이 폴더를 읽지 않는다', async () => {
    const dir = path.join(POC, 'packages/engine/playbooks');
    const ids = fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort();
    assert.deepEqual(ids, ['hometax.cert.biz_registration', 'hometax.cert.financial_statements', 'hometax.cert.issued_list', 'hometax.cert.taxpayment', 'hometax.cert.vat_tax_base', 'hometax.invoice.email_status', 'hometax.invoice.issue', 'hometax.invoice.lookup']);
    for (const id of ids) {
      const m = JSON.parse(fs.readFileSync(path.join(dir, id, 'manifest.json'), 'utf8')) as { id: string; portal: string };
      assert.equal(m.id, id, '폴더 이름 = 패키지 id');
      assert.notEqual(m.portal, 'fixture', `${id}: fixture 포털 패키지는 tests/에만 둔다`);
    }
    const dist = (await import(new URL('../packages/engine/dist/core/loader.js', import.meta.url).href)) as typeof import('../packages/engine/src/core/loader.ts');
    const bytes = (o: unknown) => Buffer.from(JSON.stringify(o), 'utf8');
    const raw = (f: ReturnType<typeof h01>) => ({ manifest: bytes(f.manifest), playbook: bytes(f.playbook), selectors: bytes(f.selectors), strings: bytes(f.strings) });
    const ctx = { roots: sampleKeys().roots, revoked: new Set<string>(), bundleAllowlist: BUNDLE_ALLOWLIST, bundles: bundleOutcomes(), installedLookups: new Map(), storedVersion: null, installedDigest: null, hold: false, policyFresh: false, now: Date.now() };
    for (const f of [h01(), ...lookups().values()]) {
      const r = dist.loadPackage(raw(f), ctx);
      assert.equal(r.ok ? 'ok' : r.code, 'registry.signature_insufficient', f.manifest.id);
    }
    const offenders: string[] = [];
    for (const [, d] of productPackages()) {
      for (const f of walk(path.join(POC, d, 'src'))) {
        if (!/\.(ts|mts|js|mjs)$/.test(f) || /\.test\.ts$/.test(f)) continue;
        if (/['"`][^'"`\n]*playbooks\//.test(fs.readFileSync(f, 'utf8'))) offenders.push(path.relative(POC, f));
      }
    }
    assert.deepEqual(offenders, []);
  });
});
