// 패키징 설정(D14 M4-9): 서명 판정(미서명 = 베타 불가), 퓨즈(D11 §4), 사용자별 설치(D07 §1.1), 게시 없음. 실제 빌드는 pnpm package:win.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { test } from 'node:test';
// @ts-expect-error 설정은 .mjs(타입 없음)
import { EXCLUDE, MAC_SIGNING_ENV, macSigningFrom, makeConfig, SIGNING_ENV, signingFrom } from '../apps/desktop/build/electron-builder.config.mjs';
import { packagedProblems } from '../apps/desktop/src/harden.ts';

const BUILD = path.join(import.meta.dirname, '../apps/desktop/build');
const identity = JSON.parse(fs.readFileSync(path.join(BUILD, 'app-identity.json'), 'utf8'));
const FULL = Object.fromEntries(Object.values(SIGNING_ENV as Record<string, string>).map((k) => [k, `v-${k}`]));

test('서명 판정: 시크릿이 하나라도 없거나 Windows가 아니면 미서명', () => {
  const none = signingFrom({}, 'win32');
  assert.equal(none.mode, 'unsigned');
  assert.equal(none.missing.length, 7);
  const partial = Object.fromEntries(Object.entries(FULL).filter(([k]) => k !== 'AZURE_CLIENT_SECRET'));
  assert.deepEqual(signingFrom(partial, 'win32').missing, ['AZURE_CLIENT_SECRET']);
  assert.deepEqual(signingFrom(FULL, 'darwin'), { mode: 'unsigned', reason: 'signing_needs_windows_host', missing: [] });
  const ok = signingFrom(FULL, 'win32');
  assert.equal(ok.mode, 'azure');
  assert.equal(ok.azureSignOptions.publisherName, 'v-SAX_AZSIGN_PUBLISHER');
  assert.equal(ok.azureSignOptions.endpoint, 'v-SAX_AZSIGN_ENDPOINT');
});

test('설정: 퓨즈·asar·사용자별 NSIS·게시 없음·미서명이면 서명과 DN 검사를 끈다', () => {
  const c = makeConfig({ identity, version: '1.2.3', buildDir: BUILD, outDir: '/tmp/out', signing: signingFrom({}, 'darwin'), icon: null });
  assert.deepEqual(c.electronFuses, {
    runAsNode: false,
    enableCookieEncryption: true,
    enableNodeOptionsEnvironmentVariable: false,
    enableNodeCliInspectArguments: false,
    enableEmbeddedAsarIntegrityValidation: true,
    onlyLoadAppFromAsar: true,
    loadBrowserProcessSpecificV8Snapshot: false,
    grantFileProtocolExtraPrivileges: false,
  });
  assert.equal(c.asar, true);
  assert.deepEqual(c.asarUnpack, ['**/*.node']);
  assert.equal(c.nsis.perMachine, false);
  assert.equal(c.nsis.allowElevation, false);
  assert.equal(c.nsis.allowToChangeInstallationDirectory, false);
  assert.equal(c.nsis.deleteAppDataOnUninstall, false);
  assert.equal(c.nsis.differentialPackage, false);
  assert.equal(c.win.requestedExecutionLevel, 'asInvoker');
  assert.equal(c.win.signExecutable, false);
  assert.equal(c.win.verifyUpdateCodeSignature, false);
  assert.equal(c.win.azureSignOptions, undefined);
  assert.equal(c.publish, null);
  assert.equal(c.extraMetadata.version, '1.2.3');
  assert.equal(c.extraMetadata.main, identity.entry);
  const signed = makeConfig({ identity, version: '1.2.3', buildDir: BUILD, outDir: '/tmp/out', signing: signingFrom(FULL, 'win32'), icon: null });
  assert.equal(signed.win.signExecutable, true);
  assert.equal(signed.win.verifyUpdateCodeSignature, true);
});

test('설치 폴더: 원클릭 사용자별 NSIS가 고르는 폴더 이름이 installDirName이다(harden.ts·installer.nsh·README가 기대하는 %LOCALAPPDATA%\\Programs\\SovereignAX)', () => {
  const c = makeConfig({ identity, version: '1.2.3', buildDir: BUILD, outDir: '/tmp/out', signing: signingFrom({}, 'darwin'), icon: null });
  assert.equal(c.nsis.oneClick, true);
  assert.equal(c.nsis.perMachine, false);
  assert.equal(c.extraMetadata.name, identity.installDirName);
  assert.equal(identity.installDirName, identity.productName, 'harden.ts는 Programs\\<productName>을 기대한다');
  // electron-builder가 실제로 쓰는 함수로 확인한다(NsisTarget: APP_FILENAME = getWindowsInstallationDirName(appInfo, !oneClick || perMachine)).
  const req = createRequire(createRequire(path.join(import.meta.dirname, '../apps/desktop/package.json')).resolve('electron-builder'));
  const lib = createRequire(req.resolve('app-builder-lib'));
  const { getWindowsInstallationDirName } = lib('./targets/targetUtil.js') as { getWindowsInstallationDirName: (a: object, b: boolean) => string };
  const { sanitizeFileName } = createRequire(lib.resolve('builder-util'))('builder-util/out/filename') as { sanitizeFileName: (s: string) => string };
  const appInfo = { productFilename: sanitizeFileName(c.productName), sanitizedName: sanitizeFileName(c.extraMetadata.name) };
  assert.equal(getWindowsInstallationDirName(appInfo, !c.nsis.oneClick || c.nsis.perMachine), identity.installDirName);
});

test('제외 목록: 소스·지도·시험·다른 OS 네이티브', () => {
  for (const p of ['!**/*.ts', '!**/*.map', '!src/**', '!node_modules/@sax/*/src/**', '!build/**', '!node_modules/@napi-rs/canvas*/**']) assert.ok((EXCLUDE as string[]).includes(p), p);
  // 실행 코드가 src/ 아래인 의존성(debug·tesseract.js main, officecrypto-tool ./src)을 지우면 설치본 엔진이 import에서 끝난다
  assert.ok(!(EXCLUDE as string[]).some((p) => p === '!**/src/**' || p === '!node_modules/**/src/**'), 'node_modules 전체 src 제외 금지');
});

test('설치 경로: 설치 폴더 이름이 데이터 루트 이름과 같아도 경로는 Programs 아래로 나뉜다(installer.nsh가 데이터 루트 안 설치를 막는다)', () => {
  assert.equal(identity.productName, identity.installDirName);
  const nsh = fs.readFileSync(path.join(BUILD, 'installer.nsh'), 'utf8');
  assert.match(nsh, /\$LOCALAPPDATA\\SovereignAX/);
  assert.match(nsh, /!macro customInit/);
  assert.match(nsh, /Quit/);
});

// ── macOS 배포(고객 PoC, CUSTOMER-DIST §2): Intel·Apple Silicon 따로, Developer ID 서명·공증은 환경이 다 있을 때만 ──

const MAC_FULL = Object.fromEntries(Object.values(MAC_SIGNING_ENV as Record<string, string>).map((k) => [k, `v-${k}`]));

test('macOS 서명 판정: 값이 하나라도 없거나 Mac이 아니면 애드혹(unsigned), 다 있으면 developer_id', () => {
  const none = macSigningFrom({}, 'darwin');
  assert.equal(none.mode, 'unsigned');
  assert.deepEqual(none.missing, ['SAX_MAC_IDENTITY', 'APPLE_API_KEY', 'APPLE_API_KEY_ID', 'APPLE_API_ISSUER']);
  const partial = Object.fromEntries(Object.entries(MAC_FULL).filter(([k]) => k !== 'APPLE_API_ISSUER'));
  assert.deepEqual(macSigningFrom(partial, 'darwin').missing, ['APPLE_API_ISSUER']);
  assert.deepEqual(macSigningFrom(MAC_FULL, 'win32'), { mode: 'unsigned', reason: 'mac_signing_needs_mac_host', missing: [] });
  assert.deepEqual(macSigningFrom(MAC_FULL, 'darwin'), { mode: 'developer_id', identity: 'v-SAX_MAC_IDENTITY' });
});

test('macOS 설정: 대상 CPU로 dmg를 만들고 파일 이름에 CPU가 들어간다, 애드혹은 하드닝·공증 없음', () => {
  for (const cpu of ['arm64', 'x64']) {
    const c = makeConfig({ identity, version: '1.2.3', buildDir: BUILD, outDir: '/tmp/out', signing: macSigningFrom({}, 'darwin'), icon: null, target: { os: 'darwin', cpu } });
    assert.deepEqual(c.mac.target, [{ target: 'dmg', arch: [cpu] }]);
    assert.equal(c.mac.identity, '-', '애드혹: 퓨즈·asar 무결성 뒤 서명이 맞아야 Apple Silicon이 띄운다');
    assert.equal(c.mac.hardenedRuntime, false);
    assert.equal(c.mac.notarize, false);
    assert.equal(c.mac.entitlements, undefined);
    assert.equal(c.mac.artifactName, `${identity.installDirName}-\${version}-\${arch}.\${ext}`);
  }
});

test('macOS 설정: Developer ID면 그 인증서로 서명, 하드닝 런타임·JIT 권한·공증', () => {
  const c = makeConfig({ identity, version: '1.2.3', buildDir: BUILD, outDir: '/tmp/out', signing: macSigningFrom(MAC_FULL, 'darwin'), icon: null, target: { os: 'darwin', cpu: 'arm64' } });
  assert.equal(c.mac.identity, 'v-SAX_MAC_IDENTITY');
  assert.equal(c.mac.hardenedRuntime, true);
  assert.equal(c.mac.notarize, true);
  assert.equal(c.mac.entitlements, path.join(BUILD, 'entitlements.mac.plist'));
  const ent = fs.readFileSync(c.mac.entitlements, 'utf8');
  assert.match(ent, /com\.apple\.security\.cs\.allow-jit<\/key>\s*<true\/>/);
  assert.doesNotMatch(ent, /<key>com\.apple\.security\.cs\.disable-library-validation<\/key>/, '네이티브 모듈은 같은 인증서로 서명된다');
  assert.equal(c.win.signExecutable, false, 'macOS 서명이 Windows 서명을 켜지 않는다');
});

test('설치본 자기 점검: Developer ID 빌드는 "미서명 빌드" 배지가 없다, 애드혹은 있다', () => {
  const base = { productName: 'SovereignAX', version: '0.1.9', channel: 'beta', commit: 'abc', devOnlyIncluded: [] as string[] };
  const mac = { isPackaged: true, appPath: '/Applications/SovereignAX.app/Contents/Resources/app.asar', execPath: '/Applications/SovereignAX.app/Contents/MacOS/SovereignAX', localAppData: '', platform: 'darwin' as const };
  assert.deepEqual(packagedProblems({ ...mac, buildInfo: { ...base, signing: 'developer_id' } }), []);
  assert.deepEqual(packagedProblems({ ...mac, buildInfo: { ...base, signing: 'unsigned' } }), ['warn:unsigned_build']);
  assert.deepEqual(packagedProblems({ ...mac, buildInfo: { ...base, signing: 'notarized' } }), ['fatal:build_info_missing'], '모르는 서명 값은 받지 않는다');
});

test('패키징 스크립트: macOS --arch(arm64|x64), electron-builder 출력 폴더(mac-arm64|mac), 설치본 옆 .sha256', () => {
  const src = fs.readFileSync(path.join(import.meta.dirname, '../scripts/package-win.mjs'), 'utf8');
  assert.match(src, /arch: \{ type: 'string' \}/);
  assert.match(src, /TARGET\.cpu === 'arm64' \? 'mac-arm64' : 'mac'/);
  assert.match(src, /builder\.Arch\[TARGET\.cpu\]/);
  assert.match(src, /`\$\{exePath\}\.sha256`/);
  const pkg = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, '../apps/desktop/package.json'), 'utf8'));
  assert.equal(pkg.scripts['package:mac:x64'], 'node ../../scripts/package-win.mjs --mac --arch x64');
});
