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

/** 앱 안에 넣지 않는 것(ADR-035 W-7, RETRO B-05): 타입·소스·지도 파일과 다른 OS 네이티브 바이너리. 데모·e2e·실측 파일은 스크립트가 도달성으로 거른다. */
export const EXCLUDE = [
  '!**/*.ts',
  '!**/*.d.ts',
  '!**/*.map',
  '!**/*.tsbuildinfo',
  '!**/tsconfig*.json',
  '!**/src/**',
  '!**/{test,tests,__tests__,e2e,fixtures,example,examples,docs}/**',
  '!**/*.{md,markdown}',
  '!**/{LICENSE,LICENSE.*,license,CHANGELOG*,README*}',
  // pdfjs의 node 캔버스(@napi-rs/canvas)는 docparse가 렌더러 샌드박스에서 돌아 쓰지 않는다(D11 §4 프로세스 행)
  '!node_modules/@napi-rs/canvas*/**',
  // better-sqlite3 미리 빌드: Windows x64만
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
 * @param {ReturnType<typeof signingFrom>} o.signing
 * @param {string | null} o.icon icon.ico 경로(없으면 Electron 기본 아이콘)
 */
export function makeConfig({ identity, version, buildDir, outDir, signing, icon }) {
  const signed = signing.mode === 'azure';
  return {
    appId: identity.appId,
    productName: identity.productName,
    copyright: identity.copyright,
    directories: { output: outDir, buildResources: buildDir },
    // 스테이지 package.json을 덮는다(스테이지 = pnpm deploy 결과, scripts/package-win.mjs)
    extraMetadata: { name: 'sovereign-ax', productName: identity.productName, version, main: identity.entry, description: identity.description, author: identity.companyName },
    files: ['**/*', ...EXCLUDE],
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
