// 패키징 설정(D14 M4-9): 서명 판정(미서명 = 베타 불가), 퓨즈(D11 §4), 사용자별 설치(D07 §1.1), 게시 없음. 실제 빌드는 pnpm package:win.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
// @ts-expect-error 설정은 .mjs(타입 없음)
import { EXCLUDE, makeConfig, SIGNING_ENV, signingFrom } from '../apps/desktop/build/electron-builder.config.mjs';

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
