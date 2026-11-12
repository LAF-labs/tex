// electron-builder 설정(D14 M4-9, D11 §4 퓨즈·자동 업데이트 행, D07 §1.1, ADR-028). scripts/package-win.mjs가 부른다.
// 설정은 값만 만든다: 파일을 읽고 쓰는 일·서명 여부 판정은 스크립트가 한다.
//
// 설치: NSIS 사용자별(관리자 권한 없음) → %LOCALAPPDATA%\Programs\<installDirName>. 데이터는 앱이 %LOCALAPPDATA%\SovereignAX\ 아래에 따로 둔다
// (D07 §1.1, @sax/platform defaultAppRoot). 두 폴더를 나눠 설치·제거·업데이트가 데이터 폴더(DACL = 소유자 + SYSTEM)를 건드리지 않게 한다.
// 순서: 퓨즈 → ASAR 무결성 → 서명(D11 §4). electron-builder는 electronFuses를 패키징 직후, 서명 전에 적용하고
// EnableEmbeddedAsarIntegrityValidation이 켜져 있으면 asar 헤더 해시를 실행 파일 리소스에 넣는다.
import path from 'node:path';

/** 서명 환경 변수 이름(값은 CI 시크릿, 저장소에 넣지 않는다). SIGNING-SETUP.md와 같다. */
export const SIGNING_ENV = {
  endpoint: 'SAX_AZSIGN_ENDPOINT',
  account: 'SAX_AZSIGN_ACCOUNT',
  profile: 'SAX_AZSIGN_PROFILE',
  publisher: 'SAX_AZSIGN_PUBLISHER',
  // Microsoft Entra ID 앱 등록(서비스 주체). electron-builder가 Invoke-TrustedSigning에 그대로 넘긴다
  tenant: 'AZURE_TENANT_ID',
  client: 'AZURE_CLIENT_ID',
  secret: 'AZURE_CLIENT_SECRET',
};

/**
 * 서명 설정 판정: 모든 값이 있고 Windows 호스트일 때만 Artifact Signing으로 서명한다(Invoke-TrustedSigning은 Windows PowerShell 모듈).
 * 하나라도 없으면 미서명 빌드다. 미서명 빌드는 베타 배포 불가(release-readiness.json).
 */
export function signingFrom(env, platform) {
  const v = Object.fromEntries(Object.entries(SIGNING_ENV).map(([k, name]) => [k, env[name] ?? '']));
  const missing = Object.entries(SIGNING_ENV).filter(([k]) => !v[k]).map(([, name]) => name);
  if (missing.length) return { mode: 'unsigned', reason: 'signing_env_missing', missing };
  if (platform !== 'win32') return { mode: 'unsigned', reason: 'signing_needs_windows_host', missing: [] };
  return {
    mode: 'azure',
    azureSignOptions: {
      publisherName: v.publisher,
      endpoint: v.endpoint,
      codeSigningAccountName: v.account,
      certificateProfileName: v.profile,
      fileDigest: 'SHA256',
      timestampRfc3161: 'http://timestamp.acs.microsoft.com',
      timestampDigest: 'SHA256',
    },
  };
}

/**
 * macOS Developer ID 서명·공증 입력(값은 저장소·로그에 넣지 않는다). SIGNING-SETUP.md §6과 같다.
 * - 신원: 빌드 Mac 키체인의 "Developer ID Application: <이름> (<팀 ID>)"(scripts/package-win.mjs가 `security find-identity -v -p codesigning`으로 이름만 읽는다).
 *   여럿이면 SAX_MAC_IDENTITY(이름·팀 ID 일부)로 고른다.
 * - 공증: `xcrun notarytool store-credentials <프로필>`로 키체인에 저장해 둔 프로필 이름(SAX_NOTARY_PROFILE). Apple ID·앱 암호·팀 ID는 받지 않는다.
 */
export const MAC_SIGNING_ENV = {
  identity: 'SAX_MAC_IDENTITY',
  notaryProfile: 'SAX_NOTARY_PROFILE',
};

export const DEVELOPER_ID_PREFIX = 'Developer ID Application: ';

/** 키체인 코드 서명 신원 이름(`security find-identity -v -p codesigning`의 따옴표 안). 개인키·인증서 내용은 읽지 않는다. */
export const parseIdentities = (out) => [...out.matchAll(/^\s*\d+\)\s+[0-9A-F]{40}\s+"([^"]+)"/gm)].map((m) => m[1]);

/**
 * macOS 서명 판정: macOS 호스트에 Developer ID Application 신원이 정확히 하나면 Developer ID 서명 + 하드닝 런타임.
 * - 공증 프로필 이름도 있으면 공증·스테이플까지(notarize: true).
 * - 없으면(또는 이름이 틀리면) 서명만 하고 공증·스테이플은 건너뛴다(notarize: false, reason notarize_skipped·notary_profile_bad_name, 팀장 지시 2026-11-12).
 *   이 Mac에서 빌드해 격리 속성이 없는 앱은 그대로 실행되고, 지정 요구사항이 팀 ID 기준이라 새 판에서도 키체인 허용 창이 다시 뜨지 않는다.
 *   내려받은 사본은 공증이 없어 Gatekeeper가 막는다(고객 배포는 공증 판).
 * - 신원이 없거나 여럿이면 애드혹('-')이고 빌드는 실패하지 않는다(reason으로 알린다).
 * 애드혹 빌드는 지정 요구사항이 cdhash라 빌드마다 키체인 허용 창이 다시 뜨고, 받은 dmg는 Gatekeeper가 막는다(CUSTOMER-DIST §2).
 * @param {{ env: Record<string, string | undefined>, platform: string, identities: string[] }} o identities: 키체인 신원 이름 전체(접두어 포함)
 */
export function macSigningFrom({ env, platform, identities }) {
  if (platform !== 'darwin') return { mode: 'unsigned', reason: 'mac_signing_needs_mac_host' };
  const want = (env[MAC_SIGNING_ENV.identity] ?? '').trim();
  const ids = [...new Set(identities.filter((n) => n.startsWith(DEVELOPER_ID_PREFIX)))].filter((n) => !want || n.includes(want));
  if (!ids.length) return { mode: 'unsigned', reason: 'developer_id_missing' };
  if (ids.length > 1) return { mode: 'unsigned', reason: 'developer_id_ambiguous', candidates: ids.length };
  const name = ids[0].slice(DEVELOPER_ID_PREFIX.length);
  const team = /\(([A-Z0-9]{10})\)$/.exec(name)?.[1] ?? null;
  // electron-builder는 접두어 없는 이름을 받는다(macCodeSign checkPrefix)
  const signed = { mode: 'developer_id', identity: name, fullName: ids[0], teamId: team };
  const profile = (env[MAC_SIGNING_ENV.notaryProfile] ?? '').trim();
  if (!profile) return { ...signed, notarize: false, notaryProfile: null, reason: 'notarize_skipped' };
  // 프로필 이름은 notarytool 인자로만 쓴다: 셸 글자 없이
  if (!/^[A-Za-z0-9_.-]{1,64}$/.test(profile)) return { ...signed, notarize: false, notaryProfile: null, reason: 'notary_profile_bad_name' };
  return { ...signed, notarize: true, notaryProfile: profile };
}

/** 앱 안에 넣지 않는 것(ADR-035 W-7, RETRO B-05): 타입·소스·지도 파일과 다른 OS 네이티브 바이너리. 데모·e2e·실측 파일은 스크립트가 도달성으로 거른다. */
export const EXCLUDE = [
  '!**/*.ts',
  '!**/*.d.ts',
  '!**/*.map',
  '!**/*.tsbuildinfo',
  '!**/tsconfig*.json',
  // TS 소스는 앱과 작업 공간 패키지(@sax/*)에서만 뺀다. 런타임은 dist다. node_modules 전체의 src/를 빼면 실행 코드가 src/ 아래인
  // 의존성(debug·tesseract.js의 main, officecrypto-tool의 ./src)이 빠져 엔진이 import 단계에서 끝난다(Windows 실기기 설치본 첫 실행, WIN-REALDEVICE §7).
  '!src/**',
  '!node_modules/@sax/*/src/**',
  '!**/{test,tests,__tests__,e2e,fixtures,example,examples,docs}/**',
  '!**/*.{md,markdown}',
  '!**/{LICENSE,LICENSE.*,license,CHANGELOG*,README*}',
  // pdfjs의 node 캔버스(@napi-rs/canvas)는 docparse가 렌더러 샌드박스에서 돌아 쓰지 않는다(D11 §4 프로세스 행)
  '!node_modules/@napi-rs/canvas*/**',
  // better-sqlite3 미리 빌드: 대상 OS·CPU 것만(아래 makeConfig가 대상에 맞춰 바꾼다. 기본 Windows x64)
  '!node_modules/better-sqlite3-multiple-ciphers/prebuilds/!(win32-x64.node)',
  '!node_modules/better-sqlite3-multiple-ciphers/{deps,src}/**',
  // 이 설정 폴더 자신(pnpm deploy가 스테이지로 복사한다)
  '!build/**',
  '!pnpm-lock.yaml',
  '!pnpm-workspace.yaml',
];

/**
 * @param {object} o
 * @param {object} o.identity build/app-identity.json
 * @param {string} o.version 앱 버전(semver)
 * @param {string} o.buildDir apps/desktop/build 절대 경로
 * @param {string} o.outDir 산출물 폴더
 * @param {ReturnType<typeof signingFrom> | ReturnType<typeof macSigningFrom>} o.signing
 * @param {string | null} o.icon icon.ico 경로(없으면 Electron 기본 아이콘)
 * @param {{ os: string, cpu: string }} [o.target] 대상(기본 Windows x64). macOS는 arm64 .dmg(Developer ID가 없으면 애드혹)
 */
export function makeConfig({ identity, version, buildDir, outDir, signing, icon, target = { os: 'win32', cpu: 'x64' } }) {
  const signed = signing.mode === 'azure';
  const macSigned = signing.mode === 'developer_id';
  const prebuild = `${target.os}-${target.cpu}.node`;
  return {
    appId: identity.appId,
    productName: identity.productName,
    copyright: identity.copyright,
    directories: { output: outDir, buildResources: buildDir },
    // 스테이지 package.json을 덮는다(스테이지 = pnpm deploy 결과, scripts/package-win.mjs).
    // name = installDirName: 원클릭 사용자별 NSIS는 설치 폴더 이름을 productName이 아니라 name에서 가져온다
    // (app-builder-lib getWindowsInstallationDirName: oneClick·perMachine 아님 → sanitizedName). 예전 'sovereign-ax'면
    // %LOCALAPPDATA%\Programs\sovereign-ax에 깔려 앱이 "예상 밖 설치 위치" 배지를 띄웠다(Windows 실기기 #166).
    extraMetadata: { name: identity.installDirName, productName: identity.productName, version, main: identity.entry, description: identity.description, author: identity.companyName },
    files: ['**/*', ...EXCLUDE.map((x) => x.replace('!(win32-x64.node)', `!(${prebuild})`))],
    asar: true,
    // .node는 asar 안에서 dlopen할 수 없다
    asarUnpack: ['**/*.node'],
    // 네이티브 모듈은 미리 빌드된 win32-x64 바이너리를 쓴다(macOS에서 Windows용으로 컴파일하지 않는다)
    npmRebuild: false,
    nodeGypRebuild: false,
    buildDependenciesFromSource: false,
    includePdb: false,
    electronLanguages: ['ko', 'en-US'],
    electronFuses: {
      runAsNode: false,
      enableCookieEncryption: true,
      enableNodeOptionsEnvironmentVariable: false,
      enableNodeCliInspectArguments: false,
      enableEmbeddedAsarIntegrityValidation: true,
      onlyLoadAppFromAsar: true,
      loadBrowserProcessSpecificV8Snapshot: false,
      grantFileProtocolExtraPrivileges: false,
    },
    // macOS: Apple Silicon(arm64)만(대표 결정 2026-11-11, Intel Mac 미지원).
    // Developer ID 신원·공증 프로필이 없으면 애드혹: 받은 .dmg는 Gatekeeper가 막아 고객이 [그래도 열기]를 눌러야 한다(sovereign-ax/install-guide).
    mac: {
      target: [{ target: 'dmg', arch: ['arm64'] }],
      // 애드혹 서명('-'): Apple Silicon은 서명이 깨진 실행 파일을 띄우자마자 죽인다(퓨즈·asar 무결성을 쓴 뒤 서명이 맞지 않으면 exit 137).
      identity: macSigned ? signing.identity : '-',
      // 공증은 하드닝 런타임을 요구한다. 권한은 entitlements.mac.plist(V8·WebAssembly JIT만). 금고·엔진 utilityProcess(Helper 앱)도 같은 권한을 받는다.
      hardenedRuntime: macSigned,
      entitlements: macSigned ? path.join(buildDir, 'entitlements.mac.plist') : undefined,
      entitlementsInherit: macSigned ? path.join(buildDir, 'entitlements.mac.plist') : undefined,
      // 앱 공증·스테이플: 스크립트가 APPLE_KEYCHAIN_PROFILE(= SAX_NOTARY_PROFILE)을 넘긴다. dmg 서명·공증·스테이플은 스크립트가 따로 한다
      notarize: macSigned && signing.notarize === true,
      gatekeeperAssess: false,
      category: 'public.app-category.business',
      artifactName: `${identity.installDirName}-\${version}-arm64.\${ext}`,
    },
    win: {
      target: [{ target: 'nsis', arch: ['x64'] }],
      icon: icon ?? undefined,
      legalTrademarks: identity.companyName,
      requestedExecutionLevel: 'asInvoker',
      // 서명이 없으면 서명만 끄고 리소스(이름·버전·아이콘)는 그대로 넣는다
      signExecutable: signed,
      azureSignOptions: signed ? signing.azureSignOptions : undefined,
      // electron-updater의 서명 주체 DN 검사(2차 방어, ADR-028 결정 2). 미서명 빌드는 검사할 주체가 없다
      verifyUpdateCodeSignature: signed,
    },
    nsis: {
      oneClick: true,
      perMachine: false,
      allowElevation: false,
      packElevateHelper: false,
      allowToChangeInstallationDirectory: false,
      // 데이터 폴더(%LOCALAPPDATA%\SovereignAX)는 제거해도 남긴다(서류 보관함·DB, D07 §1.1)
      deleteAppDataOnUninstall: false,
      runAfterFinish: true,
      createDesktopShortcut: true,
      createStartMenuShortcut: true,
      shortcutName: identity.displayName,
      uninstallDisplayName: identity.displayName,
      artifactName: `${identity.installDirName}-Setup-\${version}.\${ext}`,
      include: path.join(buildDir, 'installer.nsh'),
      // 블록맵 차등 다운로드는 쓰지 않는다: 서명된 매니페스트(latest.json)가 다루지 않는 파일이라 전체 sha512 검증만 둔다
      differentialPackage: false,
      unicode: true,
      warningsAsErrors: true,
    },
    // latest.yml은 레지스트리가 서명된 latest.json에서만 만든다(services/registry API.md). 여기서 게시하지 않는다
    publish: null,
    // 빌드 뒤 latest.yml을 만들지 않게(게시 설정 없음과 함께)
    generateUpdatesFilesForAllChannels: false,
    detectUpdateChannel: false,
  };
}
