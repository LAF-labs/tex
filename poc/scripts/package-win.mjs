// Windows NSIS 설치본 만들기(D14 M4-9). 실행: cd poc/apps/desktop && pnpm package:win (또는 poc에서 node scripts/package-win.mjs).
// macOS·Linux에서도 돈다: 그때는 서명 없는 설치본("미서명 빌드")이 나온다. beta 채널은 미서명 빌드를 배포한다(stable은 불가, scripts/release-readiness.mjs). 서명은 Windows 러너 + Artifact Signing 시크릿에서만.
//
// 순서: tsc 빌드 → pnpm deploy(잠금 파일 고정, win32-x64 선택 의존성, 평평한 node_modules) → 앱 dist를 진입점 도달성으로 줄이기 →
// build-info.json → electron-builder(퓨즈 → asar 무결성 → 서명) → 보고서(크기·해시·포함 파일)와 배포 가능 판정(release-readiness.json).
//
// --mac: macOS universal(Apple Silicon·Intel 한 파일) .dmg(처음 설치)와 .zip(자동 업데이트)(팀장 지시 2026-11-10, 팀원 Mac 칩을 몰라 universal 부장 지시 2026-11-14). 기본 출력 poc/.tmp/package-mac.
//        키체인에 Developer ID Application 신원이 하나 있고 SAX_NOTARY_PROFILE(notarytool 키체인 프로필 이름)이 있으면
//        앱 서명(하드닝 런타임)·공증·스테이플 → dmg 서명·공증·스테이플 → spctl 확인. 하나라도 없으면 애드혹(SIGNING-SETUP.md §6).
//        배포 판정은 Windows 베타 기준이라 참고만.
// 설치본 옆에 <설치본>.sha256(sha256sum 형식 한 줄)을 쓴다. 고객에게 설치본과 함께 준다(sovereign-ax/install-guide/CUSTOMER-DIST.md §3).
// 인자: --out <폴더>(기본 poc/.tmp/package-win), --skip-build, --entry dist/shell.js(app-identity.json 값을 덮음),
//       --test-build(실계정 시험 빌드: build-info testBuild=true, 업데이트 투명성 확인 끄기·로컬 피드 SAX_UPDATE_FEED를 받는다, 배포 불가)
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

const { values: args } = parseArgs({ options: { out: { type: 'string' }, 'skip-build': { type: 'boolean' }, entry: { type: 'string' }, 'test-build': { type: 'boolean' }, mac: { type: 'boolean' } } });
/** 대상 OS·CPU(pnpm deploy 선택 의존성·네이티브 미리 빌드·electron-builder 대상) */
const TARGET = args.mac ? { os: 'darwin', cpus: ['arm64', 'x64'], arch: 'universal', name: 'mac' } : { os: 'win32', cpus: ['x64'], arch: 'x64', name: 'win' };
const OUT = path.resolve(args.out ?? path.join(POC, `.tmp/package-${TARGET.name}`));
const STAGE = path.join(OUT, 'stage');
const DIST = path.join(OUT, 'dist');
const MAC_APP_DIR = `mac-${TARGET.arch}`;

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
/** 출력을 읽는 실행(macOS 서명 도구). 실패하면 던진다. 출력에는 비밀이 없다(신원 이름·제출 ID·상태). */
const capture = (cmd, argv) => {
  const r = spawnSync(cmd, argv, { cwd: POC, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`${cmd} ${argv[0]} → ${r.status}: ${(r.stderr || r.stdout || '').trim().slice(-400)}`);
  return r.stdout;
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
  const { makeConfig, signingFrom, macSigningFrom, parseIdentities } = await import('./../apps/desktop/build/electron-builder.config.mjs');
  // macOS: 키체인 Developer ID 신원 + 공증 프로필이 있으면 서명·공증, 아니면 애드혹
  const signing =
    TARGET.os === 'darwin'
      ? macSigningFrom({ env: process.env, platform: process.platform, identities: process.platform === 'darwin' ? parseIdentities(capture('security', ['find-identity', '-v', '-p', 'codesigning'])) : [] })
      : signingFrom(process.env, process.platform);
  if (TARGET.os === 'darwin') {
    if (signing.mode !== 'developer_id') console.log(`macOS 서명: 애드혹(${signing.reason})`);
    else console.log(`macOS 서명: Developer ID (${signing.teamId ?? '팀 ID 모름'}), ${signing.notarize ? `공증 프로필 ${signing.notaryProfile}` : `공증 생략(${signing.reason})`}`);
  }
  // electron-builder 앱 공증은 이 환경 변수로 키체인 프로필을 쓴다(값이 아니라 프로필 이름)
  if (signing.mode === 'developer_id' && signing.notarize) process.env.APPLE_KEYCHAIN_PROFILE = signing.notaryProfile;

  if (!args['skip-build']) run('pnpm', ['build']);
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });
  // 잠금 파일 그대로, 운영 의존성만, win32-x64 선택 의존성(@napi-rs/keyring 등), 설치 스크립트 없이(네이티브는 미리 빌드)
  run('pnpm', ['--filter', '@sax/desktop', 'deploy', '--prod', `--os=${TARGET.os}`, ...TARGET.cpus.map((c) => `--cpu=${c}`), '--ignore-scripts', '--config.node-linker=hoisted', STAGE]);

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
  const targets = TARGET.os === 'darwin' ? builder.Platform.MAC.createTarget(['dmg', 'zip'], builder.Arch.universal) : builder.Platform.WINDOWS.createTarget('nsis', builder.Arch.x64);
  await builder.build({ projectDir: STAGE, targets, config, publish: 'never' });
  const macCheck = signing.mode !== 'developer_id' ? null : signing.notarize ? notarizeDmg(signing) : verifySignedApp(signing);

  // 보고서
  const exe = fs.readdirSync(DIST).find((f) => f.endsWith(TARGET.os === 'darwin' ? '.dmg' : '.exe'));
  if (!exe) throw new Error(`설치본(${TARGET.os === 'darwin' ? '.dmg' : '.exe'})이 없다`);
  const exePath = path.join(DIST, exe);
  const bytes = fs.readFileSync(exePath);
  const unpacked = TARGET.os === 'darwin' ? path.join(DIST, MAC_APP_DIR, `${identity.productName}.app`) : path.join(DIST, 'win-unpacked');
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
  // 자동 업데이트 파일(릴리스 매니페스트 files[0]): mac은 zip, Windows는 설치본 그대로
  const updFile = TARGET.os === 'darwin' ? fs.readdirSync(DIST).find((f) => f.endsWith('.zip')) : exe;
  if (!updFile) throw new Error('업데이트 zip이 없다');
  const updBytes = updFile === exe ? bytes : fs.readFileSync(path.join(DIST, updFile));
  const report = {
    buildInfo,
    installer: { file: exe, size: bytes.byteLength, sha512: createHash('sha512').update(bytes).digest('base64'), sha256: createHash('sha256').update(bytes).digest('hex') },
    update: { file: updFile, size: updBytes.byteLength, sha512: createHash('sha512').update(updBytes).digest('base64') },
    unpackedSize: sizeOf(unpacked),
    asar: { size: fs.statSync(asarPath).size, files: asarFiles.length, byTop: Object.fromEntries(Object.entries(asarTop).sort((a, b) => b[1] - a[1])) },
    asarUnpacked: unpackedFiles,
    fuses: fuseState,
    appDist: { included, removed: removed.sort() },
    readiness,
    ...(macCheck ? { mac: macCheck } : {}),
  };
  fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  fs.writeFileSync(path.join(OUT, 'release-readiness.json'), JSON.stringify(readiness, null, 2) + '\n');
  fs.writeFileSync(path.join(OUT, 'asar-files.txt'), asarFiles.join('\n') + '\n');
  // 고객 전달용 해시 파일(`shasum -a 256 -c`·PowerShell Get-FileHash로 대조)
  fs.writeFileSync(`${exePath}.sha256`, `${report.installer.sha256}  ${exe}\n`);

  console.log(`\n설치본: ${rel(exePath)} (${mb(bytes.byteLength)})`);
  if (updFile !== exe) console.log(`업데이트 파일: ${rel(path.join(DIST, updFile))} (${mb(updBytes.byteLength)})`);
  console.log(`sha256: ${report.installer.sha256}`);
  console.log(`asar: ${mb(report.asar.size)}, 파일 ${report.asar.files}개, 압축 해제 ${mb(report.unpackedSize)}`);
  console.log(`앱 dist: 포함 ${included.length}개, 제외 ${removed.length}개`);
  const unsignedNote = signing.mode === 'unsigned' ? '  ← 미서명 빌드' : '';
  if (TARGET.os === 'darwin') {
    const how = signing.mode !== 'developer_id' ? '애드혹 서명(Gatekeeper가 막는다)' : signing.notarize ? `Developer ID 서명·공증(spctl ${macCheck?.spctl})` : 'Developer ID 서명만(공증 생략: 이 Mac에서 빌드한 앱은 실행, 내려받은 사본은 Gatekeeper가 막는다)';
    console.log(`macOS: ${how}`);
  }
  if (readiness.betaDistributable) console.log(`베타 배포 가능(${identity.channel})${unsignedNote}`);
  else console.log(`베타 배포 불가: ${readiness.blockers.map((b) => b.code).join(', ')}${unsignedNote}`);
  console.log(`보고서: ${rel(path.join(OUT, 'report.json'))}`);
}

/** Developer ID 서명만(공증 생략) 빌드의 확인: 서명·봉인, 팀 ID, 하드닝 런타임. 실패하면 던진다. */
function verifySignedApp(signing) {
  const app = path.join(DIST, MAC_APP_DIR, 'SovereignAX.app');
  capture('codesign', ['--verify', '--deep', '--strict', app]);
  // codesign -dv는 결과를 stderr에 쓴다
  const info = spawnSync('codesign', ['-dv', app], { encoding: 'utf8' }).stderr;
  const team = /TeamIdentifier=(\S+)/.exec(info)?.[1] ?? null;
  if (signing.teamId && team !== signing.teamId) throw new Error(`앱 팀 ID가 다르다: ${team}`);
  if (!/flags=0x[0-9a-f]*\(runtime\)/.test(info)) throw new Error('하드닝 런타임 플래그가 없다');
  return { signing: 'developer_id', teamId: team, notarized: false, reason: signing.reason, codesignVerify: 'ok', hardenedRuntime: true };
}

/**
 * Developer ID 빌드의 dmg: 서명(타임스탬프) → notarytool 제출·대기(키체인 프로필) → 스테이플 → 확인.
 * 앱 자체는 electron-builder가 이미 공증·스테이플했다. 받은 dmg를 열 때도 오프라인으로 공증이 확인되게 dmg에도 붙인다.
 */
function notarizeDmg(signing) {
  const dmg = fs.readdirSync(DIST).find((f) => f.endsWith('.dmg'));
  if (!dmg) throw new Error('dmg가 없다');
  const file = path.join(DIST, dmg);
  const app = path.join(DIST, MAC_APP_DIR, 'SovereignAX.app');
  capture('codesign', ['--sign', signing.fullName, '--timestamp', file]);
  const sub = JSON.parse(capture('xcrun', ['notarytool', 'submit', file, '--keychain-profile', signing.notaryProfile, '--wait', '--output-format', 'json']));
  if (sub.status !== 'Accepted') throw new Error(`dmg 공증 실패: ${sub.status} (제출 ID ${sub.id}, xcrun notarytool log ${sub.id} --keychain-profile ${signing.notaryProfile})`);
  capture('xcrun', ['stapler', 'staple', file]);
  capture('xcrun', ['stapler', 'validate', file]);
  // spctl은 결과를 stderr에 쓴다
  const assess = spawnSync('spctl', ['--assess', '--type', 'execute', '-vv', app], { encoding: 'utf8' });
  const spctl = /accepted/.test(assess.stderr) ? 'accepted' : 'rejected';
  if (spctl !== 'accepted') throw new Error(`spctl이 앱을 받지 않는다: ${assess.stderr.trim().slice(-300)}`);
  return { signing: 'developer_id', teamId: signing.teamId, notarized: true, dmgNotarization: sub.id, stapled: true, spctl, source: /source=([^\n]+)/.exec(assess.stderr)?.[1] ?? null };
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
