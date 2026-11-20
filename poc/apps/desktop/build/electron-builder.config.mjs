import path from 'node:path';

export const SIGNING_ENV = {
  endpoint: 'SAX_AZSIGN_ENDPOINT',
  account: 'SAX_AZSIGN_ACCOUNT',
  profile: 'SAX_AZSIGN_PROFILE',
  publisher: 'SAX_AZSIGN_PUBLISHER',
  tenant: 'AZURE_TENANT_ID',
  client: 'AZURE_CLIENT_ID',
  secret: 'AZURE_CLIENT_SECRET',
};

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

const MAC_SIGNING_ENV = {
  identity: 'SAX_MAC_IDENTITY',
  notaryProfile: 'SAX_NOTARY_PROFILE',
};

const DEVELOPER_ID_PREFIX = 'Developer ID Application: ';

export const parseIdentities = (out) => [...out.matchAll(/^\s*\d+\)\s+[0-9A-F]{40}\s+"([^"]+)"/gm)].map((m) => m[1]);

export function macSigningFrom({ env, platform, identities }) {
  if (platform !== 'darwin') return { mode: 'unsigned', reason: 'mac_signing_needs_mac_host' };
  const want = (env[MAC_SIGNING_ENV.identity] ?? '').trim();
  const ids = [...new Set(identities.filter((n) => n.startsWith(DEVELOPER_ID_PREFIX)))].filter((n) => !want || n.includes(want));
  if (!ids.length) return { mode: 'unsigned', reason: 'developer_id_missing' };
  if (ids.length > 1) return { mode: 'unsigned', reason: 'developer_id_ambiguous', candidates: ids.length };
  const name = ids[0].slice(DEVELOPER_ID_PREFIX.length);
  const team = /\(([A-Z0-9]{10})\)$/.exec(name)?.[1] ?? null;
  const signed = { mode: 'developer_id', identity: name, fullName: ids[0], teamId: team };
  const profile = (env[MAC_SIGNING_ENV.notaryProfile] ?? '').trim();
  if (!profile) return { ...signed, notarize: false, notaryProfile: null, reason: 'notarize_skipped' };
  if (!/^[A-Za-z0-9_.-]{1,64}$/.test(profile)) return { ...signed, notarize: false, notaryProfile: null, reason: 'notary_profile_bad_name' };
  return { ...signed, notarize: true, notaryProfile: profile };
}

export const EXCLUDE = [
  '!**/*.ts',
  '!**/*.d.ts',
  '!**/*.map',
  '!**/*.tsbuildinfo',
  '!**/tsconfig*.json',
  '!src/**',
  '!node_modules/@sax/*/src/**',
  '!**/{test,tests,__tests__,e2e,fixtures,example,examples,docs}/**',
  '!**/*.{md,markdown}',
  '!**/{LICENSE,LICENSE.*,license,CHANGELOG*,README*}',
  '!node_modules/@napi-rs/canvas*/**',
  '!node_modules/better-sqlite3-multiple-ciphers/prebuilds/!(win32-x64.node)',
  '!node_modules/better-sqlite3-multiple-ciphers/{deps,src}/**',
  '!build/**',
  '!pnpm-lock.yaml',
  '!pnpm-workspace.yaml',
];

export function makeConfig({ identity, version, buildDir, outDir, signing, icon, target = { os: 'win32', cpus: ['x64'], arch: 'x64' } }) {
  const signed = signing.mode === 'azure';
  const macSigned = signing.mode === 'developer_id';
  const prebuild = target.cpus.map((c) => `${target.os}-${c}.node`).join('|');
  return {
    appId: identity.appId,
    productName: identity.productName,
    copyright: identity.copyright,
    directories: { output: outDir, buildResources: buildDir },
    extraMetadata: { name: identity.installDirName, productName: identity.productName, version, main: identity.entry, description: identity.description, author: identity.companyName },
    files: ['**/*', ...EXCLUDE.map((x) => x.replace('!(win32-x64.node)', `!(${prebuild})`))],
    asar: true,
    asarUnpack: ['**/*.node'],
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
    mac: {
      target: [
        { target: 'dmg', arch: [target.arch] },
        { target: 'zip', arch: [target.arch] },
      ],
      identity: macSigned ? signing.identity : '-',
      hardenedRuntime: macSigned,
      entitlements: macSigned ? path.join(buildDir, 'entitlements.mac.plist') : undefined,
      entitlementsInherit: macSigned ? path.join(buildDir, 'entitlements.mac.plist') : undefined,
      notarize: macSigned && signing.notarize === true,
      gatekeeperAssess: false,
      category: 'public.app-category.business',
      artifactName: `${identity.installDirName}-\${version}-${target.arch}.\${ext}`,
      x64ArchFiles: 'Contents/Resources/app.asar.unpacked/**/*.node',
    },
    win: {
      target: [{ target: 'nsis', arch: ['x64'] }],
      icon: icon ?? undefined,
      legalTrademarks: identity.companyName,
      requestedExecutionLevel: 'asInvoker',
      signExecutable: signed,
      azureSignOptions: signed ? signing.azureSignOptions : undefined,
      verifyUpdateCodeSignature: signed,
    },
    nsis: {
      oneClick: true,
      perMachine: false,
      allowElevation: false,
      packElevateHelper: false,
      allowToChangeInstallationDirectory: false,
      deleteAppDataOnUninstall: false,
      runAfterFinish: true,
      createDesktopShortcut: true,
      createStartMenuShortcut: true,
      shortcutName: identity.displayName,
      uninstallDisplayName: identity.displayName,
      artifactName: `${identity.installDirName}-Setup-\${version}.\${ext}`,
      include: path.join(buildDir, 'installer.nsh'),
      differentialPackage: false,
      unicode: true,
      warningsAsErrors: true,
    },
    publish: { provider: 'generic', url: 'https://tax.laf-co.com/releases/stable/' },
    generateUpdatesFilesForAllChannels: false,
    detectUpdateChannel: false,
  };
}
