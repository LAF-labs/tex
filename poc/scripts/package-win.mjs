// Windows NSIS 설치본 만들기(D14 M4-9). 실행: cd poc/apps/desktop && pnpm package:win (또는 poc에서 node scripts/package-win.mjs).
// macOS·Linux에서도 돈다: 그때는 서명 없는 설치본("미서명 빌드", 베타 배포 불가)이 나온다. 서명은 Windows 러너 + Artifact Signing 시크릿에서만.
//
// 순서: tsc 빌드 → pnpm deploy(잠금 파일 고정, win32-x64 선택 의존성, 평평한 node_modules) → 앱 dist를 진입점 도달성으로 줄이기 →
// build-info.json → electron-builder(퓨즈 → asar 무결성 → 서명) → 보고서(크기·해시·포함 파일)와 배포 가능 판정(release-readiness.json).
//
// 인자: --out <폴더>(기본 poc/.tmp/package-win), --skip-build, --entry dist/shell.js(app-identity.json 값을 덮음)
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { parseArgs } from 'node:util';

const POC = path.resolve(import.meta.dirname, '..');
const DESKTOP = path.join(POC, 'apps/desktop');
const BUILD = path.join(DESKTOP, 'build');

const { values: args } = parseArgs({ options: { out: { type: 'string' }, 'skip-build': { type: 'boolean' }, entry: { type: 'string' } } });
const OUT = path.resolve(args.out ?? path.join(POC, '.tmp/package-win'));
const STAGE = path.join(OUT, 'stage');
const DIST = path.join(OUT, 'dist');

/** 앱에 들어가면 베타 배포를 막는 파일(ADR-035 W-7, RETRO B-05): 데모·e2e·실측·가짜 포털·목업. 도달하지 않으면 지운다. */
const DEV_ONLY_RE = /(^|[-/])(demo|e2e|measure|fixture|smoke|synthetic|mock)([-.]|$)|poc\d+-measure/;

const run = (cmd, argv, cwd = POC) => {
  const r = spawnSync(cmd, argv, { cwd, stdio: 'inherit', env: process.env });
  if (r.status !== 0) throw new Error(`${cmd} ${argv.join(' ')} → ${r.status}`);
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
  const { makeConfig, signingFrom } = await import('./../apps/desktop/build/electron-builder.config.mjs');
  const signing = signingFrom(process.env, process.platform);

  if (!args['skip-build']) run('pnpm', ['build']);
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });
  // 잠금 파일 그대로, 운영 의존성만, win32-x64 선택 의존성(@napi-rs/keyring 등), 설치 스크립트 없이(네이티브는 미리 빌드)
  run('pnpm', ['--filter', '@sax/desktop', 'deploy', '--prod', '--os=win32', '--cpu=x64', '--ignore-scripts', '--config.node-linker=hoisted', STAGE]);

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
  };
  fs.writeFileSync(path.join(STAGE, 'build-info.json'), JSON.stringify(buildInfo, null, 2) + '\n');

  const icon = fs.existsSync(path.join(BUILD, 'icons/icon.ico')) ? path.join(BUILD, 'icons/icon.ico') : null;
  const require = createRequire(path.join(DESKTOP, 'package.json'));
  const builder = require('electron-builder');
  // 스테이지에는 devDependency electron이 없다: 데스크톱 패키지에 설치된 정확한 버전을 넘긴다(Electron zip은 electron-builder가 받아 sha256을 확인한다)
  const electronVersion = JSON.parse(fs.readFileSync(require.resolve('electron/package.json'), 'utf8')).version;
  const config = { ...makeConfig({ identity, version, buildDir: BUILD, outDir: DIST, signing, icon }), electronVersion };
  await builder.build({ projectDir: STAGE, targets: builder.Platform.WINDOWS.createTarget('nsis', builder.Arch.x64), config, publish: 'never' });

  // 보고서
  const exe = fs.readdirSync(DIST).find((f) => f.endsWith('.exe'));
  if (!exe) throw new Error('설치본(.exe)이 없다');
  const exePath = path.join(DIST, exe);
  const bytes = fs.readFileSync(exePath);
  const unpacked = path.join(DIST, 'win-unpacked');
  const asarPath = path.join(unpacked, 'resources/app.asar');
  const libRequire = createRequire(createRequire(require.resolve('electron-builder')).resolve('app-builder-lib'));
  const asar = libRequire('@electron/asar');
  const asarFiles = asar.listPackage(asarPath, { isPack: false }).map((f) => f.replaceAll('\\', '/'));
  const asarTop = {};
  for (const f of asarFiles) {
    const st = asar.statFile(asarPath, f.replace(/^\//, ''), false);
    if (!st || !('size' in st) || st.size === undefined) continue;
    const parts = f.split('/').filter(Boolean);
    const key = parts[0] === 'node_modules' ? parts.slice(0, parts[1]?.startsWith('@') ? 3 : 2).join('/') : parts[0];
    asarTop[key] = (asarTop[key] ?? 0) + st.size;
  }
  const unpackedDir = path.join(unpacked, 'resources/app.asar.unpacked');
  const unpackedFiles = fs.existsSync(unpackedDir) ? walk(unpackedDir).map((f) => path.relative(unpackedDir, f).replaceAll('\\', '/')) : [];
  // 퓨즈 읽어 확인(D11 §4 퓨즈 행). 다르면 빌드 실패
  const fuses = libRequire('@electron/fuses');
  const wire = await fuses.getCurrentFuseWire(path.join(unpacked, `${identity.productName}.exe`));
  const fuseState = {};
  for (const [i, name] of Object.entries(fuses.FuseV1Options)) if (!Number.isNaN(Number(i)) && wire[i] !== undefined) fuseState[name] = String.fromCharCode(wire[i]) === '1';
  const FUSES_WANT = { RunAsNode: false, EnableCookieEncryption: true, EnableNodeOptionsEnvironmentVariable: false, EnableNodeCliInspectArguments: false, EnableEmbeddedAsarIntegrityValidation: true, OnlyLoadAppFromAsar: true, GrantFileProtocolExtraPrivileges: false };
  const fuseBad = Object.entries(FUSES_WANT).filter(([k, v]) => fuseState[k] !== v).map(([k]) => k);
  if (fuseBad.length) throw new Error(`퓨즈가 D11 §4와 다르다: ${fuseBad.join(', ')}`);
  const blockers = [];
  if (signing.mode !== 'azure') blockers.push({ code: 'unsigned_build', detail: signing.reason, missing: signing.missing });
  if (!identity.publisherName) blockers.push({ code: 'publisher_dn_unset', detail: 'app-identity.json publisherName(서명 주체 CN, 출시 전 고정)' });
  if (devOnly.length) blockers.push({ code: 'dev_only_code_included', detail: 'ADR-035 W-7: 진입점이 데모·e2e·가짜 포털 코드에 닿는다', files: devOnly });
  if (outside.length) blockers.push({ code: 'runtime_reads_outside_app', detail: '설치본에 없는 저장소 경로를 런타임에 읽는다(ADR-028 결정 7 tokens.gen.ts)', files: outside });
  blockers.push({ code: 'windows_run_unverified', detail: 'Windows 실기기 설치·실행 검증 보류' });
  const readiness = { betaDistributable: blockers.length === 0, signed: signing.mode === 'azure', blockers };
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

  console.log(`\n설치본: ${rel(exePath)} (${mb(bytes.byteLength)})`);
  console.log(`sha256: ${report.installer.sha256}`);
  console.log(`asar: ${mb(report.asar.size)}, 파일 ${report.asar.files}개, 압축 해제 ${mb(report.unpackedSize)}`);
  console.log(`앱 dist: 포함 ${included.length}개, 제외 ${removed.length}개`);
  if (readiness.betaDistributable) console.log('베타 배포 가능');
  else console.log(`베타 배포 불가: ${blockers.map((b) => b.code).join(', ')}${signing.mode === 'azure' ? '' : '  ← 미서명 빌드'}`);
  console.log(`보고서: ${rel(path.join(OUT, 'report.json'))}`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
