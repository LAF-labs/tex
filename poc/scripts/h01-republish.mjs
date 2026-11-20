import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline/promises';
import { pathToFileURL } from 'node:url';

const POC = path.resolve(import.meta.dirname, '..');
export const H01_DIR = 'packages/engine/playbooks/hometax.invoice.issue';
export const LOOKUP_DIRS = ['packages/engine/playbooks/hometax.invoice.lookup', 'packages/engine/playbooks/hometax.invoice.email_status'];
export const SOURCES = [...LOOKUP_DIRS, H01_DIR];
const TRUST = 'services/registry/ceremony/keyepoch-1/trust-root.json';
const REGISTRY = 'https://tax.laf-co.com';
const PUBLISH = ['--conditions=development', 'services/registry/src/publish/cli.ts'];
const SIGN_PREFIX = 'node --conditions=development services/registry/src/ceremony/cli.ts sign ';

const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

export function semverGreater(a, b) {
  const x = SEMVER.exec(a);
  const y = SEMVER.exec(b);
  if (!x || !y) throw new Error(`h01.version_invalid ${a} ${b}`);
  for (let i = 1; i <= 3; i++) if (Number(x[i]) !== Number(y[i])) return Number(x[i]) > Number(y[i]);
  return false;
}

export function bumpTopVersion(text, version) {
  const before = JSON.parse(text);
  if (typeof before.version !== 'string') throw new Error('h01.version_missing');
  const indent = /^\{\r?\n([ \t]+)"/.exec(text)?.[1];
  if (!indent) throw new Error('h01.format_unknown');
  const re = new RegExp(`^${indent}"version": "[^"]*"`, 'm');
  const out = text.replace(re, `${indent}"version": "${version}"`);
  const after = JSON.parse(out);
  if (after.version !== version) throw new Error('h01.bump_failed');
  return out;
}

export function bumpLookupsUsed(text, id, version) {
  const re = new RegExp(`("id": "${id.replaceAll('.', '\\.')}",\\r?\\n[ \\t]+"version": ")[^"]*(")`);
  if (!re.test(text)) throw new Error(`h01.lookup_missing ${id}`);
  const out = text.replace(re, `$1${version}$2`);
  const m = JSON.parse(out);
  if (m.lookupsUsed?.find((l) => l.id === id)?.version !== version) throw new Error('h01.bump_failed');
  return out;
}

export function signLines(output) {
  return output
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.startsWith(SIGN_PREFIX));
}

export function signParts(cmd) {
  const arg = (k) => {
    const m = new RegExp(`--${k} ('((?:[^']|'\\\\'')*)'|(\\S+))`).exec(cmd);
    if (!m) return null;
    return m[2] !== undefined ? m[2].replaceAll("'\\''", "'") : m[3];
  };
  return { kind: arg('kind'), keyId: arg('key-id'), confirm: arg('confirm'), out: arg('out') };
}

function parseArgs(argv) {
  const o = { version: null, lookups: null, work: null, registry: REGISTRY, dryRun: false, yes: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') o.dryRun = true;
    else if (a === '--yes') o.yes = true;
    else if (a === '--work' || a === '--registry' || a === '--lookups') {
      const v = argv[++i];
      if (!v || v.startsWith('--')) throw new Error(`h01.usage ${a} 값 없음`);
      o[a.slice(2)] = v;
    } else if (!a.startsWith('--') && !o.version) o.version = a;
    else throw new Error(`h01.usage ${a}`);
  }
  if (!o.version || !SEMVER.exec(o.version) || (o.lookups && !SEMVER.exec(o.lookups))) throw new Error('h01.usage: node scripts/h01-republish.mjs <새 판, 예 2.1.1> [--lookups 조회 판] [--dry-run] [--work 폴더] [--yes]');
  return o;
}

const say = (l) => process.stdout.write(`${l}\n`);

function publish(args) {
  const r = spawnSync(process.execPath, [...PUBLISH, ...args], { cwd: POC, encoding: 'utf8', stdio: ['inherit', 'pipe', 'inherit'] });
  process.stdout.write(r.stdout ?? '');
  if (r.status !== 0) throw new Error(`h01.step_failed publish ${args[0]} (위 오류 코드: PUBLISH-H01.md "실패하면")`);
  return r.stdout ?? '';
}

function signAll(cmds, label) {
  let n = 0;
  for (const [i, c] of cmds.entries()) {
    const p = signParts(c);
    if (p.out && fs.existsSync(p.out)) {
      say(`  ${label} ${i + 1}/${cmds.length} ${p.kind} ${p.keyId}: 이미 서명함`);
      continue;
    }
    say(`\n${label} ${i + 1}/${cmds.length}: ${p.kind} ${p.keyId}. Touch ID 창의 확인 코드가 ${p.confirm} 인지 보고 누른다`);
    const r = spawnSync('/bin/sh', ['-c', c], { cwd: POC, stdio: 'inherit' });
    if (r.status !== 0) throw new Error(`h01.step_failed sign ${p.kind} ${p.keyId}. 같은 명령을 다시 치면 여기서 이어진다`);
    n++;
  }
  return n;
}

async function confirm(q, yes) {
  if (yes) return;
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const a = (await rl.question(`${q} [Enter = 계속, n = 멈춤] `)).trim().toLowerCase();
    if (a === 'n' || a === 'no') throw new Error('h01.stopped 사용자가 멈췄다');
  } finally {
    rl.close();
  }
}

function bumpSources(version, lookups) {
  const changed = [];
  if (lookups) {
    changed.push(...bumpDirs(LOOKUP_DIRS, lookups));
    const mf = path.join(POC, H01_DIR, 'manifest.json');
    let text = fs.readFileSync(mf, 'utf8');
    for (const d of LOOKUP_DIRS) text = bumpLookupsUsed(text, path.basename(d), lookups);
    fs.writeFileSync(mf, text);
  }
  changed.push(...bumpDirs([H01_DIR], version));
  return changed;
}

function bumpDirs(dirs, version) {
  const files = dirs.flatMap((d) => ['manifest.json', 'playbook.json'].map((f) => path.join(POC, d, f)));
  const changed = [];
  for (const f of files) {
    const text = fs.readFileSync(f, 'utf8');
    const cur = JSON.parse(text).version;
    if (cur === version) continue;
    if (!semverGreater(version, cur)) throw new Error(`h01.version_not_greater ${path.basename(f)} 지금 ${cur}, 새 판은 그보다 높아야 한다`);
    fs.writeFileSync(f, bumpTopVersion(text, version));
    changed.push(`${path.relative(POC, f)} ${cur} → ${version}`);
  }
  return changed;
}

export async function main(argv) {
  const o = parseArgs(argv);
  if (process.platform === 'win32') throw new Error('h01.mac_only 서명(Touch ID)은 서명 의식을 한 맥에서만 한다');
  const work = path.resolve(o.work ?? path.join(os.homedir(), 'sax-publish', `h01-${o.version}${o.dryRun ? '-dry' : ''}`));
  const changed = bumpSources(o.version, o.lookups);
  say(changed.length ? `판 올림: ${changed.join(', ')}` : `판: 소스가 이미 ${o.version}`);

  const base = ['--trust', TRUST, '--work', work];
  if (o.dryRun) {
    publish(['dry-run', '--registry', o.registry, ...base, ...SOURCES]);
    say(`\ndry-run 끝(운영에 쓰지 않음). 운영 게시: node scripts/h01-republish.mjs ${o.version}`);
    return 0;
  }

  const prepLog = `${work}.prepare.txt`;
  let prep;
  if (fs.existsSync(path.join(work, 'plan.json')) && fs.existsSync(prepLog)) {
    say(`이어 하기: ${work}(prepare 건너뜀)`);
    prep = fs.readFileSync(prepLog, 'utf8');
  } else {
    if (fs.existsSync(work)) throw new Error(`h01.work_exists ${work}: prepare 기록이 없다. --work로 새 폴더를 준다`);
    prep = publish(['prepare', '--registry', o.registry, ...base, ...SOURCES]);
    fs.writeFileSync(prepLog, prep, { flag: 'wx' });
  }
  if (/지금 인덱스 monotonic 없음/.test(prep)) throw new Error('h01.first_publish 운영에 인덱스가 아직 없다. 첫 게시는 PUBLISH-H01.md 절차로 한다');
  const pkgSigns = signLines(prep);
  if (pkgSigns.some((c) => signParts(c).kind !== 'manifest')) {
    throw new Error('h01.unexpected_docs prepare가 패키지 밖의 서명을 요구한다. PUBLISH-H01.md 절차로 한다');
  }
  if (!pkgSigns.length) throw new Error('h01.nothing_to_sign 바뀐 패키지가 없다(같은 내용이 이미 게시됨)');
  await confirm(`\n위 확인 코드로 패키지 서명 ${pkgSigns.length}번(Touch ID)을 한다.`, o.yes);
  signAll(pkgSigns, '패키지 서명');

  const asmLog = `${work}.assemble.txt`;
  let asm;
  if (fs.existsSync(path.join(work, 'assembled.json')) && fs.existsSync(asmLog)) asm = fs.readFileSync(asmLog, 'utf8');
  else {
    asm = publish(['assemble', '--trust', TRUST, '--work', work]);
    fs.writeFileSync(asmLog, asm, { flag: 'wx' });
  }
  const idxSigns = signLines(asm);
  if (idxSigns.length !== 2 || idxSigns.some((c) => signParts(c).kind !== 'index')) throw new Error('h01.unexpected_assemble 인덱스 서명 2줄이 아니다');
  signAll(idxSigns, '인덱스 서명');

  if (fs.existsSync(path.join(work, 'record.json'))) {
    say(`이미 게시함: ${path.join(work, 'record.json')}`);
  } else {
    await confirm(`\n운영(${o.registry})에 게시한다. 다음에 운영자 토큰을 묻는다.`, o.yes);
    const r = spawnSync(process.execPath, [...PUBLISH, 'push', '--trust', TRUST, '--work', work], { cwd: POC, stdio: 'inherit' });
    if (r.status !== 0) throw new Error('h01.step_failed push (위 오류 코드: PUBLISH-H01.md "실패하면". 네트워크 오류면 같은 명령을 다시 친다)');
  }
  say(`\n끝: hometax.invoice.issue@${o.version} 게시. 기록 ${path.join(work, 'record.json')}`);
  if (changed.length) say(`판 올림을 커밋한다: ${changed.map((c) => c.split(' ')[0]).join(' ')}`);
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (e) => {
      process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`);
      process.exit(1);
    },
  );
}
