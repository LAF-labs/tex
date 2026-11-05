// 승격 조건 자동 점검(ADR-035 결정 1.3, W-11).
//   (가) PR 본문 "D-xx → 시험 이름" 표가 가리키는 시험이 저장소에 있는지 본다. 시험이 통제를 증명하는지는 사람이 본다(RETRO B-11).
//   (라) `// PoC 폐기 대상` 표지가 첫 줄에 있는 파일을 제품 진입점이 import하지 않는지 본다(정적 import 그래프).
//
// 사용:
//   node scripts/ci-promotion-check.mjs [--pr <번호> | --body-file <파일> | --body-env <변수>] [--require-table] [--entry <경로>]... [--json]
//   본문 원천이 없으면 (가)는 건너뛰고 (라)만 본다. CI는 pull_request 본문을 환경 변수로 넘긴다(식에 직접 넣지 않는다).
//
// 표 형식(PR 본문, 열 이름은 자유. 첫 칸이 AUDIT-D ID, 둘째 칸에 백틱 시험 참조가 하나 이상):
//   | 통제 | 시험 |
//   |---|---|
//   | D-17(N-12) | `tests/vault-relay.test.ts > 누출 스캐너` |
//   | D-33(N-51) | `packages/vault/test/relay.test.ts` `tests/x.test.ts > 쿠키` |
//   시험 참조 = `<poc/ 또는 저장소 기준 경로>[ > <it·test·describe 이름의 일부>]`
//
// 끝 코드: 0 통과, 1 위반, 2 사용법 오류.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const POC = path.resolve(import.meta.dirname, '..');
const REPO = path.resolve(POC, '..');
const MARKER = '// PoC 폐기 대상';
/** 제품 진입점(ADR-025 결정 8: 실비밀 진입점은 하드닝된 셸 하나 + 그것이 띄우는 금고·엔진 프로세스). 있는 것만 본다. */
export const DEFAULT_ENTRIES = [
  'apps/desktop/src/shell.ts',
  'packages/vault/src/entry.ts',
  'packages/engine/src/entry.ts',
  'apps/mobile/src/index.ts',
  'apps/mobile/App.tsx',
  'services/*/src/index.ts',
  'services/*/src/main.ts',
  'services/*/src/server.ts',
];

// ───────────── (가) 표 ─────────────

/** PR 본문에서 "D-xx → 시험" 행을 뽑는다. 머리 행에 "시험"·"test"가 있는 표만 본다(08 화면 ID D-01 등을 쓰는 다른 표와 섞지 않는다). */
export function parsePromotionTable(body) {
  const rows = [];
  const cellsOf = (line) => line.replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
  const lines = body.split(/\r?\n/).map((l) => l.trim());
  let inTable = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.startsWith('|')) {
      inTable = false;
      continue;
    }
    // 머리 행 + 구분 행(|---|)이면 새 표
    if (/^\|?\s*:?-{3,}/.test(lines[i + 1] ?? '') && !/^\|?\s*:?-{3,}/.test(line)) {
      inTable = cellsOf(line).some((c) => /시험|test/i.test(c));
      i++;
      continue;
    }
    if (!inTable) continue;
    const cells = cellsOf(line);
    if (cells.length < 2) continue;
    const id = /^\**(D-\d{2})(\([^)]*\))?\**$/.exec(cells[0]);
    if (!id) continue;
    const refs = [...cells.slice(1).join(' ').matchAll(/`([^`]+)`/g)].map((m) => m[1].trim()).filter((r) => /\.(test|sec)\.(ts|mjs|js|tsx)\b/.test(r));
    rows.push({ id: id[1], label: cells[0].replace(/\*/g, ''), refs });
  }
  return rows;
}

/** 본문에 언급됐지만 표에 없는 AUDIT-D ID(경고). 08 화면 ID(D-01 문서함 등)와 섞일 수 있어 N-xx가 붙은 것만 본다. */
export function mentionedIds(body) {
  return [...new Set([...body.matchAll(/\b(D-\d{2})\(N-\d{2}\)/g)].map((m) => m[1]))];
}

/** D19 §3.5 표: ID → 단계. */
export function auditDIndex(repo = REPO) {
  const f = path.join(repo, 'sovereign-ax/design/19-attack-surface.md');
  const idx = new Map();
  if (!fs.existsSync(f)) return idx;
  const text = fs.readFileSync(f, 'utf8');
  const start = text.indexOf('### 3.5');
  const end = text.indexOf('\n### ', start + 1);
  for (const line of text.slice(start, end < 0 ? undefined : end).split('\n')) {
    const m = /^\| (D-\d{2})\((N-\d{2})\) \|[^|]*\|[^|]*\|[^|]*\| ([^|]*) \|/.exec(line);
    if (m) idx.set(m[1], { n: m[2], stage: m[3].trim() });
  }
  return idx;
}

const TEST_CALL = /\b(?:it|test|describe|suite)(?:\.(?:only|skip|todo))?\s*\(\s*(['"`])((?:\\.|(?!\1).)*)\1/g;

/** 시험 참조 하나를 확인한다. */
export function checkRef(ref, roots = [POC, REPO]) {
  const [file, ...nameParts] = ref.split(/\s+>\s+/);
  const name = nameParts.join(' > ').trim();
  const abs = roots.map((r) => path.resolve(r, file.trim())).find((p) => fs.existsSync(p) && fs.statSync(p).isFile());
  if (!abs) return { ref, ok: false, problem: '파일 없음' };
  const rel = path.relative(REPO, abs);
  if (rel.startsWith('..')) return { ref, ok: false, problem: '저장소 밖 경로' };
  if (!name) return { ref, ok: true, file: rel };
  const src = fs.readFileSync(abs, 'utf8');
  const names = [...src.matchAll(TEST_CALL)].map((m) => m[2]);
  const hit = names.find((n) => n.includes(name));
  if (!hit) return { ref, ok: false, file: rel, problem: `이름이 "${name}"을 포함하는 it·test·describe 없음` };
  // B-11: 소스 grep 시험은 증거가 아니다. 이름이 걸린 시험의 skip·todo는 따로 알린다.
  const todo = new RegExp(`\\b(?:it|test|describe)\\.(?:skip|todo)\\s*\\(\\s*(['"\`])${escapeRe(hit)}\\1`).test(src);
  return { ref, ok: !todo, file: rel, test: hit, problem: todo ? 'skip·todo 시험' : undefined };
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function checkTable(body, { requireTable = false } = {}) {
  const rows = parsePromotionTable(body);
  const idx = auditDIndex();
  const problems = [];
  const warnings = [];
  const results = rows.map((r) => {
    const known = idx.get(r.id);
    if (idx.size && !known) problems.push(`${r.label}: D19 §3.5에 없는 AUDIT-D ID`);
    if (!r.refs.length) problems.push(`${r.label}: 시험 참조(백틱 경로) 없음`);
    const refs = r.refs.map((x) => checkRef(x));
    for (const x of refs) if (!x.ok) problems.push(`${r.label}: ${x.ref} — ${x.problem}`);
    return { ...r, stage: known?.stage, refs };
  });
  if (!rows.length && requireTable) problems.push('PR 본문에 "D-xx → 시험 이름" 표가 없다(ADR-035 결정 1.3 (가))');
  const tabled = new Set(rows.map((r) => r.id));
  for (const id of mentionedIds(body)) if (!tabled.has(id)) warnings.push(`${id}: 본문에 언급됐지만 표에 시험이 없다`);
  return { rows: results, problems, warnings };
}

// ───────────── (라) 폐기 표지 ─────────────

export function hasMarker(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return false;
  }
  const lines = text.split(/\r?\n/);
  const first = lines[0]?.startsWith('#!') ? lines[1] : lines[0];
  return (first ?? '').trimStart().startsWith(MARKER);
}

/** 워크스페이스 패키지 이름 → { dir, exports }. */
function workspacePackages() {
  const map = new Map();
  for (const group of ['packages', 'apps', 'services', 'tests']) {
    const base = path.join(POC, group);
    if (!fs.existsSync(base)) continue;
    const dirs = group === 'tests' ? [base] : fs.readdirSync(base).map((d) => path.join(base, d));
    for (const dir of dirs) {
      const pj = path.join(dir, 'package.json');
      if (!fs.existsSync(pj)) continue;
      const pkg = JSON.parse(fs.readFileSync(pj, 'utf8'));
      if (pkg.name) map.set(pkg.name, { dir, pkg });
    }
  }
  return map;
}

function pickExport(target) {
  if (typeof target === 'string') return target;
  if (target && typeof target === 'object') return target.development ?? target.types ?? target.import ?? target.default ?? null;
  return null;
}

/** dist/x.js → src/x.ts 같은 빌드 산출물 경로를 소스로 되돌린다. */
function toSource(abs) {
  const cands = [abs];
  if (/\.(m?js)$/.test(abs)) cands.push(abs.replace(/\.m?js$/, '.ts'), abs.replace(/\.m?js$/, '.tsx'));
  const distIdx = abs.split(path.sep).lastIndexOf('dist');
  if (distIdx >= 0) {
    const parts = abs.split(path.sep);
    parts[distIdx] = 'src';
    const s = parts.join(path.sep);
    cands.push(s.replace(/\.m?js$/, '.ts'), s.replace(/\.m?js$/, '.tsx'), s);
  }
  for (const c of [...cands, ...cands.map((c) => path.join(c, 'index.ts'))]) if (fs.existsSync(c) && fs.statSync(c).isFile()) return c;
  return null;
}

export function resolveImport(spec, fromFile, pkgs) {
  if (spec.startsWith('.') || spec.startsWith('/')) return toSource(path.resolve(path.dirname(fromFile), spec));
  const m = /^(@[^/]+\/[^/]+|[^@/][^/]*)(\/.*)?$/.exec(spec);
  if (!m) return null;
  const ws = pkgs.get(m[1]);
  if (!ws) return null; // node: 내장·외부 의존성
  const sub = m[2] ? `.${m[2]}` : '.';
  const exp = ws.pkg.exports;
  let target = null;
  if (exp && typeof exp === 'object' && !Array.isArray(exp) && Object.keys(exp).some((k) => k.startsWith('.'))) target = pickExport(exp[sub]);
  else if (sub === '.') target = pickExport(exp) ?? ws.pkg.main ?? 'src/index.ts';
  if (!target) target = sub === '.' ? 'src/index.ts' : `src/${sub.slice(2)}.ts`;
  return toSource(path.resolve(ws.dir, target));
}

/** 런타임 import 목록(type 전용 import·export는 지워지므로 뺀다). */
export function importsOf(src) {
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1');
  const out = [];
  for (const m of code.matchAll(/\b(import|export)\s+(type\s+)?([^'";]*?)\s*from\s*['"]([^'"]+)['"]/g)) {
    if (m[2]) continue;
    // import { type A, type B } from 'x' 처럼 전부 type이면 지워진다
    const braces = /^\{([\s\S]*)\}$/.exec(m[3].trim());
    if (braces && braces[1].split(',').map((s) => s.trim()).filter(Boolean).every((s) => s.startsWith('type '))) continue;
    out.push(m[4]);
  }
  for (const m of code.matchAll(/\bimport\s*['"]([^'"]+)['"]/g)) out.push(m[1]);
  for (const m of code.matchAll(/\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g)) out.push(m[1]);
  for (const m of code.matchAll(/\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g)) out.push(m[1]);
  return out;
}

function expandEntries(entries) {
  const out = [];
  for (const e of entries) {
    if (!e.includes('*')) {
      const abs = path.resolve(POC, e);
      if (fs.existsSync(abs)) out.push(abs);
      continue;
    }
    const [head, tail] = e.split('*');
    const base = path.resolve(POC, head);
    if (!fs.existsSync(base)) continue;
    for (const d of fs.readdirSync(base)) {
      const abs = path.join(base, d + tail);
      if (fs.existsSync(abs)) out.push(abs);
    }
  }
  return out;
}

/** 진입점에서 닿는 파일 중 폐기 표지가 있는 것과 그 경로(체인). */
export function checkMarkers(entries = DEFAULT_ENTRIES) {
  const pkgs = workspacePackages();
  const roots = expandEntries(entries);
  const parent = new Map();
  const seen = new Set();
  const queue = [];
  for (const r of roots) {
    seen.add(r);
    queue.push(r);
  }
  while (queue.length) {
    const f = queue.shift();
    if (!/\.(m?[jt]sx?)$/.test(f)) continue;
    let src;
    try {
      src = fs.readFileSync(f, 'utf8');
    } catch {
      continue;
    }
    for (const spec of importsOf(src)) {
      const to = resolveImport(spec, f, pkgs);
      if (!to || seen.has(to) || to.includes(`${path.sep}node_modules${path.sep}`)) continue;
      seen.add(to);
      parent.set(to, f);
      queue.push(to);
    }
  }
  const chain = (f) => {
    const c = [f];
    while (parent.has(c[0])) c.unshift(parent.get(c[0]));
    return c.map((x) => path.relative(POC, x));
  };
  const reached = [...seen].filter(hasMarker).map((f) => ({ file: path.relative(POC, f), chain: chain(f) }));
  return { entries: roots.map((r) => path.relative(POC, r)), files: seen.size, reached };
}

/** poc/ 아래 표지 파일 전체(git 추적 기준). */
export function markedFiles() {
  let list;
  try {
    list = execFileSync('git', ['ls-files', '-z', '--', '.'], { cwd: POC, encoding: 'utf8' }).split('\0').filter(Boolean);
  } catch {
    return [];
  }
  return list.filter((f) => /\.(m?[jt]sx?)$/.test(f) && hasMarker(path.join(POC, f)));
}

// ───────────── CLI ─────────────

function readBody(args) {
  const i = (k) => args.indexOf(k);
  if (i('--body-file') >= 0) return fs.readFileSync(args[i('--body-file') + 1], 'utf8');
  if (i('--body-env') >= 0) return process.env[args[i('--body-env') + 1]] ?? '';
  if (i('--pr') >= 0) {
    const n = args[i('--pr') + 1];
    if (!/^\d+$/.test(n ?? '')) throw new Error('--pr 다음에는 번호');
    return execFileSync('gh', ['pr', 'view', n, '--json', 'body', '-q', '.body'], { cwd: REPO, encoding: 'utf8' });
  }
  return null;
}

function main(args) {
  let body;
  try {
    body = readBody(args);
  } catch (e) {
    console.error(String(e instanceof Error ? e.message : e));
    return 2;
  }
  const entries = args.flatMap((a, k) => (a === '--entry' ? [args[k + 1]] : []));
  const table = body === null ? null : checkTable(body, { requireTable: args.includes('--require-table') });
  const markers = checkMarkers(entries.length ? entries : DEFAULT_ENTRIES);
  const allMarked = markedFiles();
  const failed = (table?.problems.length ?? 0) + markers.reached.length > 0;
  if (args.includes('--json')) {
    console.log(JSON.stringify({ table, markers, marked: allMarked, ok: !failed }, null, 2));
    return failed ? 1 : 0;
  }
  const gh = !!process.env.GITHUB_ACTIONS;
  console.log('## 승격 조건 자동 점검(ADR-035 결정 1.3)\n');
  if (!table) console.log('(가) 본문 원천 없음 — 건너뜀');
  else {
    console.log(`(가) D-xx → 시험 표: ${table.rows.length}행`);
    for (const r of table.rows) {
      console.log(`  ${r.label}${r.stage ? ` [${r.stage}]` : ''}`);
      for (const x of r.refs) console.log(`    ${x.ok ? '✔' : '✖'} ${x.ref}${x.test ? ` → "${x.test}"` : ''}${x.problem ? ` — ${x.problem}` : ''}`);
    }
    for (const p of table.problems) console.log(`  ✖ ${p}`);
    for (const w of table.warnings) console.log(`  ⚠ ${w}`);
    if (gh) for (const p of table.problems) console.log(`::error title=승격 조건 (가)::${p}`);
    if (gh) for (const w of table.warnings) console.log(`::warning title=승격 조건 (가)::${w}`);
  }
  console.log(`\n(라) 폐기 표지: 진입점 ${markers.entries.length}개(${markers.entries.join(', ')})에서 ${markers.files}개 파일, 표지 파일 전체 ${allMarked.length}개`);
  if (!markers.reached.length) console.log('  ✔ 진입점이 표지 파일을 import하지 않음');
  for (const r of markers.reached) {
    console.log(`  ✖ ${r.file}\n      ${r.chain.join(' → ')}`);
    if (gh) console.log(`::error file=poc/${r.file},title=승격 조건 (라)::제품 진입점이 PoC 폐기 대상 파일을 import한다: ${r.chain.join(' → ')}`);
  }
  console.log(failed ? '\n결과: 위반' : '\n결과: 통과');
  return failed ? 1 : 0;
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('ci-promotion-check.mjs')) process.exit(main(process.argv.slice(2)));
