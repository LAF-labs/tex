// Windows NSIS 설치본 만들기(D14 M4-9). 실행: cd poc/apps/desktop && pnpm package:win (또는 poc에서 node scripts/package-win.mjs).
// macOS·Linux에서도 돈다: 그때는 서명 없는 설치본("미서명 빌드")이 나온다. beta 채널은 미서명 빌드를 배포한다(stable은 불가, scripts/release-readiness.mjs). 서명은 Windows 러너 + Artifact Signing 시크릿에서만.
//
// 순서: tsc 빌드 → pnpm deploy(잠금 파일 고정, win32-x64 선택 의존성, 평평한 node_modules) → 앱 dist를 진입점 도달성으로 줄이기 →
// build-info.json → electron-builder(퓨즈 → asar 무결성 → 서명) → 보고서(크기·해시·포함 파일)와 배포 가능 판정(release-readiness.json).
//
// --mac: macOS .dmg(팀장 지시 2026-11-10). --arch arm64(기본, Apple Silicon)|x64(Intel). 기본 출력 poc/.tmp/package-mac(x64는 package-mac-x64).
//        서명 환경(SAX_MAC_IDENTITY·APPLE_API_KEY·APPLE_API_KEY_ID·APPLE_API_ISSUER)이 다 있으면 Developer ID 서명 + 공증, 없으면 애드혹.
//        배포 판정은 Windows 베타 기준이라 참고만.
// 설치본 옆에 <설치본>.sha256(sha256sum 형식 한 줄)을 쓴다. 고객에게 설치본과 함께 준다(sovereign-ax/install-guide/CUSTOMER-DIST.md §3).
// 인자: --out <폴더>(기본 poc/.tmp/package-win), --skip-build, --entry dist/shell.js(app-identity.json 값을 덮음),
//       --test-build(실계정 시험 빌드: build-info testBuild=true, 업데이트 투명성 확인을 설정으로 끌 수 있다, 배포 불가)
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { readiness as judgeReadiness, readWinReport } from './release-readiness.mjs';

const POC = path.resolve(import.meta.dirname, '..');
const DESKTOP = path.join(POC, 'apps/desktop');
const BUILD = path.join(DESKTOP, 'build');

const { values: args } = parseArgs({ options: { out: { type: 'string' }, 'skip-build': { type: 'boolean' }, entry: { type: 'string' }, 'test-build': { type: 'boolean' }, mac: { type: 'boolean' }, arch: { type: 'string' } } });
/** 대상 OS·CPU(pnpm deploy 선택 의존성·네이티브 미리 빌드·electron-builder 대상) */
const MAC_ARCH = args.arch ?? 'arm64';
if (!args.mac && args.arch) throw new Error('--arch는 --mac과 함께만 쓴다(Windows는 x64 하나)');
if (MAC_ARCH !== 'arm64' && MAC_ARCH !== 'x64') throw new Error(`--arch는 arm64 또는 x64: ${MAC_ARCH}`);
const TARGET = args.mac ? { os: 'darwin', cpu: MAC_ARCH, name: MAC_ARCH === 'arm64' ? 'mac' : 'mac-x64' } : { os: 'win32', cpu: 'x64', name: 'win' };
const OUT = path.resolve(args.out ?? path.join(POC, `.tmp/package-${TARGET.name}`));
const STAGE = path.join(OUT, 'stage');
const DIST = path.join(OUT, 'dist');

/** 앱에 들어가면 베타 배포를 막는 파일(ADR-035 W-7, RETRO B-05): 데모·e2e·실측·가짜 포털·목업. 도달하지 않으면 지운다. */
const DEV_ONLY_RE = /(^|[-/])(demo|e2e|measure|fixture|smoke|synthetic|mock)([-.]|$)|poc\d+-measure/;

// Windows의 pnpm은 대개 pnpm.cmd(npm 전역 설치·corepack 심)라 셸 없이 띄우면 ENOENT(status null)로 끝난다(WIN-REALDEVICE §7).
// .cmd는 셸로만 띄울 수 있다(Node CVE-2024-27980 이후). 인자는 고정 문자열과 경로뿐이라 공백·따옴표만 감싼다.
const quoteWin = (a) => (/[\s"]/.test(a) ? `"${a.replace(/"/g, '""')}"` : a);
const run = (cmd, argv, cwd = POC) => {
  const viaShell = process.platform === 'win32' && cmd === 'pnpm';
  const r = viaShell
    ? spawnSync([cmd, ...argv].map(quoteWin).join(' '), { cwd, stdio: 'inherit', env: process.env, shell: true })
    : spawnSync(cmd, argv, { cwd, stdio: 'inherit', env: process.env });
  if (r.status !== 0) throw new Error(`${cmd} ${argv.join(' ')} → ${r.status}${r.error ? ` (${r.error.code})` : ''}`);
};
const git = (...a) => spawnSync('git', a, { cwd: POC, encoding: 'utf8' }).stdout.trim();
const rel = (p) => path.relative(POC, p);

function semverOk(v) {
  return /^\d{1,6}\.\d{1,6}\.\d{1,6}$/.test(v);
}

/** dist 안 상대 import(정적·동적·re-export) 도달 집합. tsc 출력은 './x.js' 꼴이다 */
function reachable(distDir, entry) {
  const seen = new Set();
  const stack = [path.join(distDir, path.relative('dist', entry))];
  const RE = /(?:import|export)\s[^'"]*?from\s*['"](\.[^'"]+)['"]|import\s*\(\s*['"](\.[^'"]+)['"]\s*\)|import\s+['"](\.[^'"]+)['"]/g;
  while (stack.length) {
    const f = stack.pop();
    if (seen.has(f) || !fs.existsSync(f)) continue;
    seen.add(f);
    const src = fs.readFileSync(f, 'utf8');
    for (const m of src.matchAll(RE)) stack.push(path.resolve(path.dirname(f), m[1] ?? m[2] ?? m[3]));
  }
  return seen;
}

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

const sizeOf = (p) => walk(p).reduce((n, f) => n + fs.statSync(f).size, 0);
const mb = (n) => `${(n / 1024 / 1024).toFixed(1)} MB`;

async function main() {
  const identity = JSON.parse(fs.readFileSync(path.join(BUILD, 'app-identity.json'), 'utf8'));
  if (args.entry) identity.entry = args.entry;
  const desktopPkg = JSON.parse(fs.readFileSync(path.join(DESKTOP, 'package.json'), 'utf8'));
  const version = process.env.SAX_APP_VERSION ?? desktopPkg.version;
  if (!semverOk(version)) throw new Error(`앱 버전이 semver(x.y.z)가 아니다: ${version}`);
  const { makeConfig, signingFrom, macSigningFrom } = await import('./../apps/desktop/build/electron-builder.config.mjs');
  // macOS: Developer ID 서명 환경이 다 있으면 서명·공증, 아니면 애드혹(Apple 개발자 계정 전까지)
  const signing = TARGET.os === 'darwin' ? macSigningFrom(process.env, process.platform) : signingFrom(process.env, process.platform);

  if (!args['skip-build']) run('pnpm', ['build']);
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });
  // 잠금 파일 그대로, 운영 의존성만, win32-x64 선택 의존성(@napi-rs/keyring 등), 설치 스크립트 없이(네이티브는 미리 빌드)
  run('pnpm', ['--filter', '@sax/desktop', 'deploy', '--prod', `--os=${TARGET.os}`, `--cpu=${TARGET.cpu}`, '--ignore-scripts', '--config.node-linker=hoisted', STAGE]);

  // 앱 dist를 진입점에서 닿는 파일로 줄인다
  const stageDist = path.join(STAGE, 'dist');
  const keep = reachable(stageDist, identity.entry);
  if (!keep.size) throw new Error(`진입점이 없다: ${identity.entry}`);
  const removed = [];
  for (const f of walk(stageDist)) {
    const js = f.replace(/\.(d\.ts|js\.map)$/, '.js');
    if (!keep.has(js)) {
      fs.rmSync(f);
      if (f.endsWith('.js')) removed.push(path.relative(STAGE, f));
    }
  }
  const included = [...keep].map((f) => path.relative(STAGE, f)).sort();
  const devOnly = included.filter((f) => DEV_ONLY_RE.test(path.basename(f)));
  // 앱 밖 경로를 런타임에 읽는 코드(설치본에는 그 파일이 없다)
  const outside = included.filter((f) => /sovereign-ax\/design-system|\.\.\/\.\.\/\.\.\/\.\./.test(fs.readFileSync(path.join(STAGE, f), 'utf8')));

  const commit = git('rev-parse', 'HEAD');
  const dirty = git('status', '--porcelain').length > 0;
  const buildInfo = {
    productName: identity.productName,
    version,
    channel: identity.channel,
    entry: identity.entry,
    commit,
    dirty,
    builtAt: new Date().toISOString(),
    // 앱이 읽어 "미서명 빌드" 표시·자기 점검에 쓴다(데스크톱 트랙 제안, apps/desktop/build/README.md)
    signing: signing.mode,
    devOnlyIncluded: devOnly,
    // 실계정 시험 빌드(팀장 결정 11-05). 앱은 이 칸이 true일 때만 업데이트 투명성 확인 끄기 설정을 받는다(harden isTestBuild)
    testBuild: args['test-build'] === true,
  };
  fs.writeFileSync(path.join(STAGE, 'build-info.json'), JSON.stringify(buildInfo, null, 2) + '\n');

  const icon = fs.existsSync(path.join(BUILD, 'icons/icon.ico')) ? path.join(BUILD, 'icons/icon.ico') : null;
  const require = createRequire(path.join(DESKTOP, 'package.json'));
  const builder = require('electron-builder');
  // 스테이지에는 devDependency electron이 없다: 데스크톱 패키지에 설치된 정확한 버전을 넘긴다(Electron zip은 electron-builder가 받아 sha256을 확인한다)
  const electronVersion = JSON.parse(fs.readFileSync(require.resolve('electron/package.json'), 'utf8')).version;
  const config = { ...makeConfig({ identity, version, buildDir: BUILD, outDir: DIST, signing, icon, target: TARGET }), electronVersion };
  const targets = TARGET.os === 'darwin' ? builder.Platform.MAC.createTarget('dmg', builder.Arch[TARGET.cpu]) : builder.Platform.WINDOWS.createTarget('nsis', builder.Arch.x64);
  await builder.build({ projectDir: STAGE, targets, config, publish: 'never' });

  // 보고서
  const exe = fs.readdirSync(DIST).find((f) => f.endsWith(TARGET.os === 'darwin' ? '.dmg' : '.exe'));
  if (!exe) throw new Error(`설치본(${TARGET.os === 'darwin' ? '.dmg' : '.exe'})이 없다`);
  const exePath = path.join(DIST, exe);
  const bytes = fs.readFileSync(exePath);
  // electron-builder 출력 폴더: arm64는 mac-arm64, x64는 mac
  const unpacked = TARGET.os === 'darwin' ? path.join(DIST, TARGET.cpu === 'arm64' ? 'mac-arm64' : 'mac', `${identity.productName}.app`) : path.join(DIST, 'win-unpacked');
  const resources = TARGET.os === 'darwin' ? path.join(unpacked, 'Contents/Resources') : path.join(unpacked, 'resources');
  const asarPath = path.join(resources, 'app.asar');
  const libRequire = createRequire(createRequire(require.resolve('electron-builder')).resolve('app-builder-lib'));
  const asar = libRequire('@electron/asar');
  // listPackage는 Windows에서 `\` 경로를 준다. 보고서에는 `/`로 쓰지만 statFile은 path.sep으로 나누므로 원래 경로로 묻는다(WIN-REALDEVICE §7).
  const asarRaw = asar.listPackage(asarPath, { isPack: false });
  const asarFiles = asarRaw.map((f) => f.replaceAll('\\', '/'));
  const asarTop = {};
  for (const [i, f] of asarFiles.entries()) {
    const st = asar.statFile(asarPath, asarRaw[i].replace(/^[\\/]/, ''), false);
    if (!st || !('size' in st) || st.size === undefined) continue;
    const parts = f.split('/').filter(Boolean);
    const key = parts[0] === 'node_modules' ? parts.slice(0, parts[1]?.startsWith('@') ? 3 : 2).join('/') : parts[0];
    asarTop[key] = (asarTop[key] ?? 0) + st.size;
  }
  const unpackedDir = path.join(resources, 'app.asar.unpacked');
  const unpackedFiles = fs.existsSync(unpackedDir) ? walk(unpackedDir).map((f) => path.relative(unpackedDir, f).replaceAll('\\', '/')) : [];
  // 퓨즈 읽어 확인(D11 §4 퓨즈 행). 다르면 빌드 실패
  const fuses = libRequire('@electron/fuses');
  const wire = await fuses.getCurrentFuseWire(TARGET.os === 'darwin' ? path.join(unpacked, 'Contents/MacOS', identity.productName) : path.join(unpacked, `${identity.productName}.exe`));
  const fuseState = {};
  for (const [i, name] of Object.entries(fuses.FuseV1Options)) if (!Number.isNaN(Number(i)) && wire[i] !== undefined) fuseState[name] = String.fromCharCode(wire[i]) === '1';
  const FUSES_WANT = { RunAsNode: false, EnableCookieEncryption: true, EnableNodeOptionsEnvironmentVariable: false, EnableNodeCliInspectArguments: false, EnableEmbeddedAsarIntegrityValidation: true, OnlyLoadAppFromAsar: true, GrantFileProtocolExtraPrivileges: false };
  const fuseBad = Object.entries(FUSES_WANT).filter(([k, v]) => fuseState[k] !== v).map(([k]) => k);
  if (fuseBad.length) throw new Error(`퓨즈가 D11 §4와 다르다: ${fuseBad.join(', ')}`);
  // 판정은 scripts/release-readiness.mjs(채널별 판정표 시험: tests/release-readiness.test.ts, SIGNING-SETUP.md §4)
  const readiness = judgeReadiness({ channel: identity.channel, signing, publisherName: identity.publisherName, devOnly, outside, testBuild: buildInfo.testBuild, winReport: readWinReport() });
  const report = {
    buildInfo,
    installer: { file: exe, size: bytes.byteLength, sha512: createHash('sha512').update(bytes).digest('base64'), sha256: createHash('sha256').update(bytes).digest('hex') },
    unpackedSize: sizeOf(unpacked),
    asar: { size: fs.statSync(asarPath).size, files: asarFiles.length, byTop: Object.fromEntries(Object.entries(asarTop).sort((a, b) => b[1] - a[1])) },
    asarUnpacked: unpackedFiles,
    fuses: fuseState,
    appDist: { included, removed: removed.sort() },
    readiness,
  };
  fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  fs.writeFileSync(path.join(OUT, 'release-readiness.json'), JSON.stringify(readiness, null, 2) + '\n');
  fs.writeFileSync(path.join(OUT, 'asar-files.txt'), asarFiles.join('\n') + '\n');
  // 고객 전달용 해시 파일(`shasum -a 256 -c`·PowerShell Get-FileHash로 대조)
  fs.writeFileSync(`${exePath}.sha256`, `${report.installer.sha256}  ${exe}\n`);

  console.log(`\n설치본: ${rel(exePath)} (${mb(bytes.byteLength)})`);
  console.log(`sha256: ${report.installer.sha256}`);
  console.log(`asar: ${mb(report.asar.size)}, 파일 ${report.asar.files}개, 압축 해제 ${mb(report.unpackedSize)}`);
  console.log(`앱 dist: 포함 ${included.length}개, 제외 ${removed.length}개`);
  const unsignedNote = signing.mode === 'unsigned' ? '  ← 미서명 빌드' : '';
  if (TARGET.os === 'darwin') console.log(`macOS ${TARGET.cpu}: ${signing.mode === 'developer_id' ? 'Developer ID 서명·공증' : '애드혹 서명(Gatekeeper가 막는다)'}`);
  if (readiness.betaDistributable) console.log(`베타 배포 가능(${identity.channel})${unsignedNote}`);
  else console.log(`베타 배포 불가: ${readiness.blockers.map((b) => b.code).join(', ')}${unsignedNote}`);
  console.log(`보고서: ${rel(path.join(OUT, 'report.json'))}`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
