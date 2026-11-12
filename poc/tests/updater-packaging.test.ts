// 패키징 설정(D14 M4-9): 서명 판정(미서명 = 베타 불가), 퓨즈(D11 §4), 사용자별 설치(D07 §1.1), 게시 없음. 실제 빌드는 pnpm package:win.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { test } from 'node:test';
// @ts-expect-error 설정은 .mjs(타입 없음)
import { EXCLUDE, macSigningFrom, makeConfig, parseIdentities, SIGNING_ENV, signingFrom } from '../apps/desktop/build/electron-builder.config.mjs';
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

// ── macOS 배포(고객 PoC, CUSTOMER-DIST §2): Apple Silicon만, Developer ID 서명·공증은 키체인 신원 + notarytool 프로필이 있을 때만 ──

const DEV_ID = 'Developer ID Application: Example Name (ABCDE12345)';
const FIND_IDENTITY = `  1) ${'A'.repeat(40)} "Apple Development: someone@example.com (ZZZZZ99999)"\n  2) ${'B'.repeat(40)} "${DEV_ID}"\n     2 valid identities found\n`;

test('키체인 신원 읽기: find-identity 출력의 따옴표 안 이름만', () => {
  assert.deepEqual(parseIdentities(FIND_IDENTITY), ['Apple Development: someone@example.com (ZZZZZ99999)', DEV_ID]);
  assert.deepEqual(parseIdentities('     0 valid identities found\n'), []);
});

test('macOS 서명 판정: Mac·Developer ID 하나·공증 프로필이 다 있어야 developer_id, 아니면 애드혹(이유 코드)', () => {
  const ids = parseIdentities(FIND_IDENTITY);
  const env = { SAX_NOTARY_PROFILE: 'sax-notary' };
  assert.deepEqual(macSigningFrom({ env, platform: 'darwin', identities: ids }), { mode: 'developer_id', identity: 'Example Name (ABCDE12345)', fullName: DEV_ID, teamId: 'ABCDE12345', notaryProfile: 'sax-notary' });
  assert.equal(macSigningFrom({ env, platform: 'win32', identities: ids }).reason, 'mac_signing_needs_mac_host');
  assert.equal(macSigningFrom({ env, platform: 'darwin', identities: ['Apple Development: x (ZZZZZ99999)'] }).reason, 'developer_id_missing', 'Apple Development 신원으로는 배포 서명하지 않는다');
  assert.equal(macSigningFrom({ env: {}, platform: 'darwin', identities: ids }).reason, 'notary_profile_unset');
  assert.equal(macSigningFrom({ env: { SAX_NOTARY_PROFILE: 'x; rm -rf ~' }, platform: 'darwin', identities: ids }).reason, 'notary_profile_bad_name');
  const two = [...ids, 'Developer ID Application: Other (QQQQQ11111)'];
  assert.equal(macSigningFrom({ env, platform: 'darwin', identities: two }).reason, 'developer_id_ambiguous');
  assert.equal(macSigningFrom({ env: { ...env, SAX_MAC_IDENTITY: 'QQQQQ11111' }, platform: 'darwin', identities: two }).identity, 'Other (QQQQQ11111)', 'SAX_MAC_IDENTITY로 고른다');
});

test('macOS 설정: 애드혹은 arm64 dmg·하드닝·공증 없음', () => {
  const c = makeConfig({ identity, version: '1.2.3', buildDir: BUILD, outDir: '/tmp/out', signing: macSigningFrom({ env: {}, platform: 'darwin', identities: [] }), icon: null, target: { os: 'darwin', cpu: 'arm64' } });
  assert.deepEqual(c.mac.target, [{ target: 'dmg', arch: ['arm64'] }], 'Intel Mac 미지원(대표 결정 2026-11-11)');
  assert.equal(c.mac.identity, '-', '애드혹: 퓨즈·asar 무결성 뒤 서명이 맞아야 Apple Silicon이 띄운다');
  assert.equal(c.mac.hardenedRuntime, false);
  assert.equal(c.mac.notarize, false);
  assert.equal(c.mac.entitlements, undefined);
});

test('macOS 설정: Developer ID면 접두어 없는 신원으로 서명, 하드닝 런타임·JIT 권한(Helper 포함)·공증', () => {
  const signing = macSigningFrom({ env: { SAX_NOTARY_PROFILE: 'sax-notary' }, platform: 'darwin', identities: [DEV_ID] });
  const c = makeConfig({ identity, version: '1.2.3', buildDir: BUILD, outDir: '/tmp/out', signing, icon: null, target: { os: 'darwin', cpu: 'arm64' } });
  assert.equal(c.mac.identity, 'Example Name (ABCDE12345)', 'electron-builder는 "Developer ID Application:" 접두어를 거부한다');
  assert.equal(c.mac.hardenedRuntime, true);
  assert.equal(c.mac.notarize, true);
  assert.equal(c.mac.entitlements, path.join(BUILD, 'entitlements.mac.plist'));
  assert.equal(c.mac.entitlementsInherit, c.mac.entitlements, '금고·엔진 utilityProcess(Helper)도 같은 권한');
  const ent = fs.readFileSync(c.mac.entitlements, 'utf8');
  const keys = [...ent.matchAll(/<key>([^<]+)<\/key>\s*<true\/>/g)].map((m) => m[1]).sort();
  assert.deepEqual(keys, ['com.apple.security.cs.allow-jit', 'com.apple.security.cs.allow-unsigned-executable-memory'], '권한은 JIT 둘만(라이브러리 검증 끄기·샌드박스 없음)');
  assert.equal(c.win.signExecutable, false, 'macOS 서명이 Windows 서명을 켜지 않는다');
});

test('설치본 자기 점검: Developer ID 빌드는 "미서명 빌드" 배지가 없다, 애드혹은 있다', () => {
  const base = { productName: 'SovereignAX', version: '0.1.9', channel: 'beta', commit: 'abc', devOnlyIncluded: [] as string[] };
  const mac = { isPackaged: true, appPath: '/Applications/SovereignAX.app/Contents/Resources/app.asar', execPath: '/Applications/SovereignAX.app/Contents/MacOS/SovereignAX', localAppData: '', platform: 'darwin' as const };
  assert.deepEqual(packagedProblems({ ...mac, buildInfo: { ...base, signing: 'developer_id' } }), []);
  assert.deepEqual(packagedProblems({ ...mac, buildInfo: { ...base, signing: 'unsigned' } }), ['warn:unsigned_build']);
  assert.deepEqual(packagedProblems({ ...mac, buildInfo: { ...base, signing: 'notarized' } }), ['fatal:build_info_missing'], '모르는 서명 값은 받지 않는다');
});

test('패키징 스크립트: 공증 프로필은 이름만 넘기고, dmg 서명·공증·스테이플 뒤에 해시를 잰다, 설치본 옆 .sha256', () => {
  const src = fs.readFileSync(path.join(import.meta.dirname, '../scripts/package-win.mjs'), 'utf8');
  assert.match(src, /process\.env\.APPLE_KEYCHAIN_PROFILE = signing\.notaryProfile/);
  assert.match(src, /'notarytool', 'submit', file, '--keychain-profile', signing\.notaryProfile, '--wait'/);
  assert.doesNotMatch(src, /--apple-id|--password|APPLE_APP_SPECIFIC_PASSWORD/, '자격 값은 스크립트에 없다');
  assert.ok(src.indexOf('notarizeDmg(signing)') < src.indexOf('const bytes = fs.readFileSync(exePath)'), '스테이플이 dmg를 바꾸므로 해시는 그 뒤');
  assert.match(src, /`\$\{exePath\}\.sha256`/);
  assert.doesNotMatch(src, /--arch/, 'Intel Mac 빌드 옵션 없음');
});

test('macOS 신원 고르기: 팀 ID를 하드코딩하지 않고 Developer ID Application 신원의 괄호 값을 쓴다(Apple Development 신원의 괄호 값은 개인 식별자)', () => {
  const out = `  1) ${'C'.repeat(40)} "Apple Development: yanggyun kim (BKDQVFVVU2)"\n  2) ${'D'.repeat(40)} "Developer ID Application: yanggyun kim (JA55KTZH34)"\n     2 valid identities found\n`;
  const s = macSigningFrom({ env: { SAX_NOTARY_PROFILE: 'sax-notary' }, platform: 'darwin', identities: parseIdentities(out) });
  assert.equal(s.mode, 'developer_id');
  assert.equal(s.identity, 'yanggyun kim (JA55KTZH34)');
  assert.equal(s.teamId, 'JA55KTZH34');
  const cfg = fs.readFileSync(path.join(BUILD, 'electron-builder.config.mjs'), 'utf8');
  assert.doesNotMatch(cfg, /JA55KTZH34|BKDQVFVVU2/, '설정에 팀 ID가 없다');
});
