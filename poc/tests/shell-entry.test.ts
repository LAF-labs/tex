// ADR-035 W-7·#76 인계 ③: 제품 진입점(shell.ts, app-identity entry)은 가짜 홈택스·시연·e2e 코드에 닿지 않는다.
// package-win이 dist에서 같은 이름 규칙(DEV_ONLY_RE)으로 devOnlyIncluded를 적는다. 여기서는 소스의 값 import(타입 import 제외)를 따라간다.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { BUILD_WARN_TEXT, isBuildInfo, isTestBuild, packagedProblems } from '../apps/desktop/src/harden.ts';

const SRC = path.join(import.meta.dirname, '../apps/desktop/src');
const DEV_ONLY_RE = /(^|[-/])(demo|e2e|measure|fixture|smoke|synthetic|mock)([-.]|$)|poc\d+-measure/;
/** 제품 진입점에 남는 개발 전용 이름(없어야 한다). 견본은 시연 연결(ShellDev.sample, demo-dev.ts)로만 온다(WIN-REALDEVICE §10.2). */
const STAND_INS: string[] = [];

/** 값 import만 따라간다(import type·export type은 지워져 dist에 남지 않는다). */
function reach(entry: string): string[] {
  const seen = new Set<string>();
  const walk = (f: string) => {
    if (seen.has(f)) return;
    seen.add(f);
    const s = fs.readFileSync(f, 'utf8');
    for (const m of s.matchAll(/^(?:import|export)\s+(?!type\s)[^;]*?from\s+'(\.[^']+)'|^import\s+'(\.[^']+)'|import\(\s*'(\.[^']+)'\s*\)/gm)) {
      const p = path.resolve(path.dirname(f), (m[1] ?? m[2] ?? m[3])!);
      if (fs.existsSync(p)) walk(p);
    }
  };
  walk(path.join(SRC, entry));
  return [...seen].map((f) => path.basename(f)).sort();
}

describe('제품 진입점(W-7)', () => {
  it('shell.ts는 개발 전용 이름에 닿지 않는다(mock·fixture·h01-fixture·synthetic-certs·demo-* 없음): 설치본 배지는 "미서명 빌드" 하나', () => {
    const files = reach('shell.ts');
    assert.ok(files.includes('shell-app.ts') && files.includes('approval-bar.ts'));
    assert.deepEqual(files.filter((f) => DEV_ONLY_RE.test(f)), STAND_INS);
  });

  it('시연 진입점은 개발 연결(DEMO_DEV)을 넘기고, 제품 shell-app은 개발 모듈을 타입으로만 안다', () => {
    const demo = reach('demo-shell.ts');
    for (const f of ['demo-dev.ts', 'fixture-mode.ts', 'h01-fixture.ts', 'demo-seed.ts', 'demo-model.ts']) assert.ok(demo.includes(f), f);
    const app = fs.readFileSync(path.join(SRC, 'shell-app.ts'), 'utf8');
    for (const m of ['fixture-mode', 'demo-model', 'demo-seed']) assert.match(app, new RegExp(`^import type \\{[^}]*\\} from './${m}\\.ts';$`, 'm'), m);
    assert.match(app, /if \(!opts\.engine && !opts\.dev\) throw new Error\('shell\.no_portal'\)/);
  });
});

describe('설치본 자기 점검(packagedProblems, #76 인계 ①)', () => {
  const LAD = 'C:\\Users\\kim\\AppData\\Local';
  const info = { productName: 'SovereignAX', version: '0.1.0', channel: 'beta', signing: 'azure', commit: 'abc', devOnlyIncluded: [] as string[] };
  const ok = { isPackaged: true, appPath: `${LAD}\\Programs\\SovereignAX\\resources\\app.asar`, execPath: `${LAD}\\Programs\\SovereignAX\\SovereignAX.exe`, localAppData: LAD, buildInfo: info, platform: 'win32' as const };

  it('macOS 시험 빌드(.app/Contents/Resources/app.asar)는 asar로 본다, LOCALAPPDATA가 없으니 설치 위치는 보지 않는다', () => {
    const mac = { isPackaged: true, appPath: '/Applications/SovereignAX.app/Contents/Resources/app.asar', execPath: '/Applications/SovereignAX.app/Contents/MacOS/SovereignAX', localAppData: '', buildInfo: { ...info, signing: 'unsigned' }, platform: 'darwin' as const };
    assert.deepEqual(packagedProblems(mac), ['warn:unsigned_build']);
    assert.deepEqual(packagedProblems({ ...mac, appPath: '/Applications/SovereignAX.app/Contents/Resources/app' }), ['fatal:not_asar', 'warn:unsigned_build']);
  });

  it('정상 설치본은 문제 없음, 개발 실행은 늘 통과', () => {
    assert.deepEqual(packagedProblems(ok), []);
    assert.deepEqual(packagedProblems({ ...ok, isPackaged: false, appPath: '/x', buildInfo: null }), []);
    assert.deepEqual(packagedProblems({ ...ok, execPath: ok.execPath.toUpperCase(), appPath: ok.appPath.toLowerCase() }), [], 'Windows 경로는 대소문자를 가리지 않는다');
  });

  it('fatal: asar 밖 로드, 데이터 루트 안 설치, build-info 없음·모양 틀림', () => {
    assert.deepEqual(packagedProblems({ ...ok, appPath: `${LAD}\\Programs\\SovereignAX\\resources\\app` }), ['fatal:not_asar']);
    const inData = `${LAD}\\SovereignAX\\bin\\SovereignAX.exe`;
    assert.ok(packagedProblems({ ...ok, execPath: inData }).includes('fatal:install_in_data_root'));
    assert.ok(!packagedProblems({ ...ok, execPath: `${LAD}\\SovereignAXOld\\SovereignAX.exe` }).includes('fatal:install_in_data_root'), '이름 앞부분만 같은 폴더는 아니다');
    assert.deepEqual(packagedProblems({ ...ok, buildInfo: null }), ['fatal:build_info_missing']);
    assert.deepEqual(packagedProblems({ ...ok, buildInfo: { ...info, signing: 'maybe' } }), ['fatal:build_info_missing']);
    assert.ok(!isBuildInfo({ ...info, devOnlyIncluded: [1] }));
  });

  it('warn: 예상 밖 설치 위치, 미서명, 개발용 코드 포함(배지 문구가 있다)', () => {
    assert.deepEqual(packagedProblems({ ...ok, execPath: 'D:\\Apps\\SovereignAX\\SovereignAX.exe', appPath: 'D:\\Apps\\SovereignAX\\resources\\app.asar' }), ['warn:install_unexpected']);
    assert.deepEqual(packagedProblems({ ...ok, buildInfo: { ...info, signing: 'unsigned', devOnlyIncluded: ['dist/shell-mock.js'] } }), ['warn:unsigned_build', 'warn:dev_code_included']);
    for (const w of ['unsigned_build', 'dev_code_included', 'install_unexpected']) assert.ok(BUILD_WARN_TEXT[w], w);
    assert.equal(BUILD_WARN_TEXT.unsigned_build, '미서명 빌드');
  });

  it('실계정 시험 빌드 칸(testBuild): 없으면 제품 빌드, true면 배지, 불리언이 아니면 build-info 모양 틀림', () => {
    assert.equal(isTestBuild(info), false, '칸이 생기기 전 build-info는 제품 빌드');
    assert.equal(isTestBuild({ ...info, testBuild: false }), false);
    assert.equal(isTestBuild({ ...info, testBuild: true }), true);
    for (const bad of ['true', 1, null]) {
      assert.equal(isTestBuild({ ...info, testBuild: bad }), false);
      assert.deepEqual(packagedProblems({ ...ok, buildInfo: { ...info, testBuild: bad } }), ['fatal:build_info_missing']);
    }
    assert.equal(isTestBuild(null), false);
    assert.equal(isTestBuild({ testBuild: true }), false, '모양이 틀린 build-info는 시험 빌드로 보지 않는다(fail-closed)');
    assert.deepEqual(packagedProblems({ ...ok, buildInfo: { ...info, testBuild: true } }), ['warn:test_build']);
    assert.deepEqual(packagedProblems({ ...ok, buildInfo: { ...info, testBuild: false } }), []);
    assert.equal(BUILD_WARN_TEXT.test_build, '실계정 시험 빌드');
  });

  it('package-win: --test-build이면 build-info testBuild=true이고 배포 가능 판정을 막는다', () => {
    const src = fs.readFileSync(path.join(SRC, '../../../scripts/package-win.mjs'), 'utf8');
    assert.match(src, /'test-build': \{ type: 'boolean' \}/);
    assert.match(src, /testBuild: args\['test-build'\] === true,/);
    // 판정은 release-readiness.mjs로 옮겼다(채널별 판정표 시험은 release-readiness.test.ts). package-win은 testBuild를 넘긴다.
    assert.match(src, /judgeReadiness\(\{[^)]*testBuild: buildInfo\.testBuild/);
    const judge = fs.readFileSync(path.join(SRC, '../../../scripts/release-readiness.mjs'), 'utf8');
    assert.match(judge, /if \(f\.testBuild\) blockers\.push\(\{ code: 'test_build'/);
  });

  it('제품 진입점이 점검을 데이터 루트 준비 전에 하고, fatal이면 열지 않으며 warn은 배지로 넘긴다', () => {
    const src = fs.readFileSync(path.join(SRC, 'shell.ts'), 'utf8');
    assert.ok(src.indexOf('packagedProblems(') < src.indexOf('prepareLayout(root)'));
    assert.match(src, /if \(problems\.some\(\(p\) => p\.startsWith\('fatal:'\)\)\) \{[\s\S]*?app\.exit\(1\);/);
    assert.match(src, /startShell\(\{ engine: \{ portal: \{ kind: 'hometax' \} \}, buildBadges, remote: productRemote\(\{ isPackaged: app\.isPackaged, env: process\.env \}\) \}\)/);
  });
});
