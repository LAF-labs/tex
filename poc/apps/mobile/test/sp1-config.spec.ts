// SP-1(Phase 1 범위): 폰 키 ThisDeviceOnly·백업 제외, 사진 보호, OTA 없음을 빌드 설정과 소스에서 기계로 확인한다.
// 기기에서의 확인(키체인 속성·파일 보호 등급·백업 복원 뒤 키 없음)은 docs/sp1-key-backup.md 절차와 앱의 진단 보고로 한다.
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { RELAY_ALLOWLIST, resolveDevConfig } from '../src/devhost.ts';

const root = join(import.meta.dirname, '..');
const app = JSON.parse(readFileSync(join(root, 'app.json'), 'utf8')).expo;
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const plugin = (name: string) => app.plugins.find((p: unknown) => (Array.isArray(p) ? p[0] : p) === name);
const src = (f: string) => readFileSync(join(root, f), 'utf8');
function walk(d: string): string[] {
  return readdirSync(d).flatMap((n) => {
    const p = join(d, n);
    return statSync(p).isDirectory() ? walk(p) : /\.(ts|tsx)$/.test(n) ? [p] : [];
  });
}
const appSources = [...walk(join(root, 'src')), join(root, 'App.tsx')].map((f) => ({ f, s: readFileSync(f, 'utf8') }));

describe('SP-1 키 저장', () => {
  it('실기기·릴리스는 WHEN_PASSCODE_SET_THIS_DEVICE_ONLY + 생체, 시뮬레이터 개발만 WHEN_UNLOCKED_THIS_DEVICE_ONLY', () => {
    const k = src('src/keyring.ts');
    assert.match(k, /keychainAccessible: SecureStore\.WHEN_PASSCODE_SET_THIS_DEVICE_ONLY,\s*requireAuthentication: true/);
    assert.match(k, /if \(DEV_LOCAL\) return \{[^}]*WHEN_UNLOCKED_THIS_DEVICE_ONLY/);
    assert.match(src('src/config.ts'), /resolveDevConfig\(\{ isDev: __DEV__, isDevice: Device\.isDevice,/);
    assert.match(src('src/config.ts'), /DEV_LOCAL: boolean = DEV\.devLocal;/);
    // 시뮬레이터 개발 빌드만 완화. 실기기 개발 빌드·릴리스는 늘 거짓(#124).
    assert.equal(resolveDevConfig({ isDev: true, isDevice: false, envHost: undefined }).devLocal, true);
    for (const e of [{ isDev: true, isDevice: true }, { isDev: false, isDevice: false }, { isDev: false, isDevice: true }]) {
      assert.equal(resolveDevConfig({ ...e, envHost: 'mac.local:8787' }).devLocal, false, JSON.stringify(e));
    }
  });
  it('ThisDeviceOnly가 아닌 키체인 등급을 어디에서도 쓰지 않는다', () => {
    for (const { f, s } of appSources) {
      assert.doesNotMatch(s, /SecureStore\.(AFTER_FIRST_UNLOCK|WHEN_UNLOCKED|ALWAYS)\b(?!_THIS_DEVICE_ONLY)/, f);
    }
  });
  it('deviceId는 D08 페어링 msg3가 요구하는 UUID v4로 만든다', () => {
    assert.match(src('src/keyring.ts'), /deviceId: uuid4\(\)/);
  });
  it('키를 담는 SecureStore 호출은 keyring.ts뿐이다', () => {
    for (const { f, s } of appSources) if (!f.endsWith('keyring.ts')) assert.doesNotMatch(s, /SecureStore\./, f);
  });
  it('Android: allowBackup=false, secure-store 백업 규칙 끔, 전부 제외 규칙 플러그인', () => {
    assert.equal(app.android.allowBackup, false);
    assert.deepEqual(plugin('expo-secure-store')[1].configureAndroidBackup, false);
    assert.ok(plugin('./plugins/with-no-backup.cjs'));
    const req = createRequire(import.meta.url);
    const p = req(join(root, 'plugins/with-no-backup.cjs'));
    assert.equal(typeof p, 'function');
    const text = src('plugins/with-no-backup.cjs');
    for (const d of ['root', 'file', 'database', 'sharedpref', 'external', 'device_root']) assert.ok(text.includes(`'${d}'`), d);
    assert.match(text, /<cloud-backup[\s\S]*<device-transfer>/);
  });
});

describe('사진 보호(ADR-034 결정 9·D07)', () => {
  it('iOS 기본 파일 보호 등급 Complete, 파일 공유 끔', () => {
    assert.equal(app.ios.entitlements['com.apple.developer.default-data-protection'], 'NSFileProtectionComplete');
    assert.equal(app.ios.infoPlist.UIFileSharingEnabled, false);
  });
  it('갤러리·사진 앱 권한과 의존성이 없다', () => {
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    for (const d of ['expo-media-library', 'expo-image-picker', 'expo-document-picker', '@react-native-camera-roll/camera-roll']) assert.equal(deps[d], undefined, d);
    const json = JSON.stringify(app);
    assert.doesNotMatch(json, /NSPhotoLibrary(Add)?UsageDescription/);
    for (const perm of ['READ_MEDIA_IMAGES', 'READ_EXTERNAL_STORAGE', 'WRITE_EXTERNAL_STORAGE', 'RECORD_AUDIO']) assert.ok(app.android.blockedPermissions.includes(`android.permission.${perm}`), perm);
    assert.equal(plugin('expo-camera')[1].microphonePermission, false);
  });
  it('소스에 갤러리 저장·가져오기 호출이 없다', () => {
    for (const { f, s } of appSources) assert.doesNotMatch(s, /saveToLibrary|launchImageLibrary|MediaLibrary|CameraRoll|pickFileAsync/, f);
  });
  it('보관 파일은 봉인 후 보호 지정(writeProtected), 보호 불가면 거부', () => {
    const files = src('src/storage/files.ts');
    assert.match(files, /if \(!SaxNative\) throw new ProtectionError\(\)/);
    assert.match(files, /if \(!p\.excludedFromBackup\) throw new ProtectionError\(\)/);
    const ob = src('src/storage/outbox.ts');
    // 사진은 봉인한 바이트만 writeProtected로 쓴다
    assert.match(ob, /const box = sealOutboxFile\(liveKey\(this\.#key\), `\$\{id\}\.p`, photo\);[\s\S]*?writeProtected\(PHOTO\(id\), box\)/);
    assert.doesNotMatch(ob, /\.write\(/);
  });
  it('네이티브 모듈은 백업 제외와 Complete 보호를 함께 건다', () => {
    const sw = src('modules/sax-native/ios/SaxNativeModule.swift');
    assert.match(sw, /isExcludedFromBackup = true/);
    assert.match(sw, /FileProtectionType\.complete/);
  });
});

describe('업데이트 채널(ADR-028, D01 §6)', () => {
  it('OTA 없음: expo-updates 미사용, updates.enabled=false', () => {
    assert.equal(app.updates.enabled, false);
    assert.equal({ ...pkg.dependencies }['expo-updates'], undefined);
  });
  it('릴레이 허용 목록은 바이너리 내장값', () => {
    assert.match(src('src/devhost.ts'), /RELAY_ALLOWLIST: readonly string\[\] = \['relay\.tex\.laf-co\.com'\]/);
    assert.deepEqual(resolveDevConfig({ isDev: false, isDevice: true, envHost: 'evil.local:8787' }).relayAllowlist, RELAY_ALLOWLIST);
    assert.match(src('src/config.ts'), /relayAllowlist = \(\): readonly string\[\] => DEV\.relayAllowlist;/);
  });
});

describe('로그 금지(규칙 ⑤)', () => {
  it('앱 소스에 console 호출이 없다', () => {
    for (const { f, s } of appSources) assert.doesNotMatch(s, /console\.(log|info|warn|error|debug)/, f);
  });
});
