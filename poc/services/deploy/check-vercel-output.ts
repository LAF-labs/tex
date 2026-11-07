// `vercel build` 결과 점검(배포 전, 로컬). 함수 묶음에 빠진 모듈·데이터 파일이 없는지 실제로 띄워 본다.
// - .vercel/output/functions/api/*.func를 저장소 밖 임시 폴더로 복사하고, .vc-config.json filePathMap의 심볼릭 링크(pnpm 작업공간·의존성)를
//   배포 때처럼 되살린다. 그 폴더에는 위쪽 node_modules가 없어서, 묶음에 없는 파일은 그대로 ERR_MODULE_NOT_FOUND·ENOENT로 드러난다.
// - 함수마다 진입점(handler)을 import하고 요청을 보내 조립(네 서비스 build)까지 거친다. 공개 함수 sax는 계정·게이트웨이·릴레이·푸시 라우터,
//   내부 함수는 서명 없음 401, 정리 함수는 CRON_SECRET으로 200을 기대한다.
// - 레지스트리 함수 둘은 구성 없음(서명 의식 전) 503과, 이 스크립트가 만든 시험 trust(무작위 공개키)·메모리 저장소로 로그 헤드 200·재서명 cron 200을 본다.
// - env 값은 이 스크립트가 만든 시험용 무작위 값이고, DB는 미리 마이그레이션한 sqlite 파일이다. 메일·결제·모델·NTS·푸시는 mock이라 외부 송신이 없다.
// 사용(깨끗한 사본에서 vercel build를 한 뒤): cd poc && node --conditions=development services/deploy/check-vercel-output.ts <사본 루트>
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MIGRATIONS_DIR as ACCOUNT_MIGRATIONS } from '../account/src/index.ts';
import { MIGRATIONS_DIR as GATEWAY_MIGRATIONS } from '../gateway/src/index.ts';
import { MIGRATIONS_DIR as PUSH_MIGRATIONS } from '../push/src/index.ts';
import { MIGRATIONS_DIR as RELAY_MIGRATIONS } from '../relay/src/index.ts';
import { LOG_MIGRATIONS_DIR as REGISTRY_MIGRATIONS } from '../registry/src/index.ts';
import { LIMITS_MIGRATIONS_DIR, ed25519Private, ed25519RawPublic, migrate, openSqlite } from '../shared/src/index.ts';

interface Probe {
  method: string;
  /** 함수 경로(`/api/…?__p=…`). `public`이 있으면 그 공개 경로에 vercel.json 재작성을 플랫폼처럼 적용한 값을 쓴다 */
  path?: string;
  /** 공개 경로(`/registry/log/head.json` 등): 재작성 → 이 함수여야 한다 */
  public?: string;
  headers?: Record<string, string>;
  body?: unknown;
  /** 기대 상태 코드 */
  status: number;
}

const hex = () => randomBytes(32).toString('hex');

interface Rewrite {
  source: string;
  destination: string;
}

/**
 * vercel.json 재작성을 플랫폼처럼 적용한다(첫 일치). 소스 매개변수(`:path*`·`:id`)를 목적지에 치환하고, 플랫폼이 하는 대로 같은 이름으로
 * 쿼리에 다시 붙인 뒤 원래 쿼리를 잇는다(2026-11-06 운영 확인: `/registry/log/head.json` → `/api/registry?__p=/registry/log/head.json&path=head.json`).
 * 외부 목적지(https://)거나 일치가 없으면 null.
 */
export function rewriteLikeVercel(rewrites: readonly Rewrite[], publicUrl: string): string | null {
  const u = new URL(publicUrl, 'https://tax.check.invalid');
  for (const r of rewrites) {
    const names: string[] = [];
    const re = new RegExp(
      `^${r.source
        .replace(/[.]/g, '\\.')
        .replace(/\/:([a-z]+)\*/g, (_, n: string) => (names.push(n), '(?:/(.*))?'))
        .replace(/\/:([a-z]+)/g, (_, n: string) => (names.push(n), '/([^/]+)'))}$`,
    );
    const m = re.exec(u.pathname);
    if (!m) continue;
    if (/^https?:/.test(r.destination)) return null;
    const vals = Object.fromEntries(names.map((n, i) => [n, m[i + 1] ?? '']));
    const dest = r.destination.replace(/:([a-z]+)\*?/g, (_, n: string) => vals[n] ?? '');
    const extra = names.map((n) => `${n}=${encodeURIComponent(vals[n]!)}`);
    const orig = u.search.slice(1);
    const q = [...extra, ...(orig ? [orig] : [])].join('&');
    return q ? `${dest}${dest.includes('?') ? '&' : '?'}${q}` : dest;
  }
  return null;
}

/** 묶음 하나를 임시 폴더로 복사하고 filePathMap 링크를 되살린다. 돌려주는 값은 복사본 경로와 진입점 상대 경로 */
export function materialize(funcDir: string, root: string, into: string): { dir: string; handler: string } {
  const cfg = JSON.parse(fs.readFileSync(path.join(funcDir, '.vc-config.json'), 'utf8')) as { handler: string; filePathMap?: Record<string, string> };
  fs.cpSync(funcDir, into, { recursive: true, verbatimSymlinks: true });
  for (const [inFunc, src] of Object.entries(cfg.filePathMap ?? {})) {
    const from = path.join(root, src);
    const at = path.join(into, inFunc);
    fs.mkdirSync(path.dirname(at), { recursive: true });
    if (fs.existsSync(at)) continue;
    const st = fs.lstatSync(from);
    if (st.isSymbolicLink()) fs.symlinkSync(fs.readlinkSync(from), at);
    else fs.cpSync(from, at, { recursive: true });
  }
  return { dir: into, handler: cfg.handler };
}

/** 함수 env(서비스 접두 + 공통). 시험용 값만 */
async function testEnv(dbDir: string): Promise<Record<string, string>> {
  const file = (svc: string) => path.join(dbDir, `${svc}.db`);
  for (const [svc, mig] of [['account', ACCOUNT_MIGRATIONS], ['gateway', GATEWAY_MIGRATIONS], ['relay', RELAY_MIGRATIONS], ['push', PUSH_MIGRATIONS], ['registry', REGISTRY_MIGRATIONS]] as const) {
    const db = openSqlite(file(svc));
    await migrate(db, svc, mig);
    await migrate(db, 'limits', LIMITS_MIGRATIONS_DIR);
    await db.close();
  }
  const seed = hex();
  const origin = 'https://tax.check.invalid';
  return {
    CRON_SECRET: hex(),
    INTERNAL_CALL_KEY: hex(),
    TOKEN_PUBLIC_KEYS: `k1:${ed25519RawPublic(ed25519Private(Buffer.from(seed, 'hex'))).toString('base64')}`,
    ACCOUNT__SAX_SQLITE_FILE: file('account'),
    ACCOUNT__TOKEN_SIGNING_SEED: seed,
    ACCOUNT__CODE_MAC_KEY: hex(),
    ACCOUNT__LIMIT_ID_KEY: hex(),
    ACCOUNT__ACCOUNT_PUBLIC_ORIGIN: origin,
    ACCOUNT__WEBAUTHN_RP_ID: 'tax.check.invalid',
    ACCOUNT__WEBAUTHN_ORIGINS: origin,
    ACCOUNT__BILLING_RETURN_URL: `${origin}/done`,
    ACCOUNT__PG_PROVIDER: 'mock',
    ACCOUNT__MAIL_PROVIDER: 'mock',
    GATEWAY__SAX_SQLITE_FILE: file('gateway'),
    GATEWAY__GATEWAY_PUBLIC_ORIGIN: origin,
    GATEWAY__RUN_TOKEN_SEED: hex(),
    GATEWAY__LIMIT_ID_KEY: hex(),
    GATEWAY__CACHE_KEY_SECRET: hex(),
    GATEWAY__SAFETY_ID_KEY: hex(),
    GATEWAY__REPLAY_TAG_KEY: hex(),
    GATEWAY__RUN_SCOPE_KEY: hex(),
    GATEWAY__GW_PROVIDER: 'mock',
    GATEWAY__NTS_PROVIDER: 'mock',
    GATEWAY__MODEL_DECIDE: 'm-decide',
    GATEWAY__MODEL_RESPOND: 'm-respond',
    RELAY__SAX_SQLITE_FILE: file('relay'),
    RELAY__QUEUE_KEY: hex(),
    RELAY__LIMIT_ID_KEY: hex(),
    RELAY__RELAY_PUBLIC_ORIGIN: origin,
    PUSH__SAX_SQLITE_FILE: file('push'),
    PUSH__PUSH_TOKEN_KEY: hex(),
    PUSH__LIMIT_ID_KEY: hex(),
    PUSH__PUSH_PUBLIC_ORIGIN: origin,
    PUSH__PUSH_PROVIDER: 'mock',
  };
}

/** 레지스트리 시험 구성: 역할마다 무작위 키의 공개키(trust), 타임스탬프 시드, 메모리 저장소 + 미리 마이그레이션한 sqlite */
function registryEnv(dbDir: string): Record<string, string> {
  const pub = (seedHex: string) => ed25519RawPublic(ed25519Private(Buffer.from(seedHex, 'hex'))).toString('base64');
  const keys = (role: string, n: number) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`${role}-${i}`, pub(hex())]));
  const ts = hex();
  const trust = { keyEpoch: 1, keys: { root: keys('root', 3), package: keys('package', 3), policy: keys('policy', 3), timestamp: { 'timestamp-0': pub(ts) }, emergency: keys('emergency', 1), release: keys('release', 1) } };
  return {
    REGISTRY__TRUST_ROOT_JSON: JSON.stringify(trust),
    REGISTRY__REGISTRY_LOG_SIGNING_KEY: ts,
    REGISTRY__REGISTRY_ADMIN_TOKEN: hex(),
    REGISTRY__REGISTRY_STORE: 'memory',
    REGISTRY__SAX_SQLITE_FILE: path.join(dbDir, 'registry.db'),
  };
}

// 복사본 안에서 도는 코드: 진입점 import → 로컬 HTTP → 요청들. 결과는 상태 코드 목록(JSON 한 줄)
const CHILD = `
import http from 'node:http';
import { pathToFileURL } from 'node:url';
const probes = JSON.parse(process.env.CHECK_PROBES);
const fn = (await import(pathToFileURL(process.env.CHECK_HANDLER).href)).default;
const server = http.createServer((q, r) => void fn(q, r).catch((e) => { console.error(e); r.statusCode = 599; r.end(); }));
await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
const out = [];
for (const p of probes) {
  const r = await fetch('http://127.0.0.1:' + server.address().port + p.path, { method: p.method, headers: { 'content-type': 'application/json', ...(p.headers ?? {}) }, body: p.body === undefined ? undefined : JSON.stringify(p.body) });
  out.push(r.status);
}
server.close();
console.log(JSON.stringify(out));
process.exit(0);
`;

/** 함수 하나 점검. 실패면 이유(오류 첫 줄들)를 돌려준다 */
function runFunction(dir: string, handler: string, env: Record<string, string>, probes: Probe[]): string | null {
  // CHECK_NODE: 묶음을 돌릴 node 실행 파일(배포 런타임과 같은 주 버전으로 돌려 볼 때). 없으면 지금 node
  const r = spawnSync(process.env.CHECK_NODE || process.execPath, ['--input-type=module', '-e', CHILD], {
    cwd: dir,
    // 사용자 env(실제 키 등)는 넘기지 않는다
    env: { PATH: process.env.PATH ?? '', NODE_ENV: 'production', ...env, CHECK_HANDLER: path.join(dir, handler), CHECK_PROBES: JSON.stringify(probes) },
    encoding: 'utf8',
    timeout: 60_000,
  });
  const last = r.stdout.trim().split('\n').at(-1) ?? '';
  let got: number[] | null = null;
  try {
    got = JSON.parse(last) as number[];
  } catch {
    got = null;
  }
  const errLines = (r.stderr ?? '').split('\n').filter((l) => /Error|Cannot find|ENOENT|ERR_/.test(l)).slice(0, 6).join('\n');
  if (!got) return `진입점을 띄우지 못했다 (exit ${r.status})\n${errLines}`;
  const bad = probes.map((p, i) => (got[i] === p.status ? null : `${p.method} ${p.public ?? p.path} → ${got[i]} (기대 ${p.status})`)).filter(Boolean);
  return bad.length ? `${bad.join('\n')}\n${errLines}` : null;
}

export async function checkVercelOutput(root: string): Promise<{ name: string; error: string | null }[]> {
  const fnRoot = path.join(root, '.vercel', 'output', 'functions', 'api');
  const rewrites = (JSON.parse(fs.readFileSync(path.join(root, 'poc', 'services', 'deploy', 'vercel', 'vercel.json'), 'utf8')) as { rewrites: Rewrite[] }).rewrites;
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'sax-vercel-check-'));
  try {
    fs.mkdirSync(path.join(work, 'db'));
    const env = await testEnv(path.join(work, 'db'));
    const reg = registryEnv(path.join(work, 'db'));
    const cron = { authorization: `Bearer ${env.CRON_SECRET}` };
    // 이름 → [함수, 추가 env, 요청들]. 레지스트리는 구성 없음·시험 구성 두 번
    const checks: Record<string, [string, Record<string, string>, Probe[]]> = {
      sax: ['sax', {}, [
        { method: 'POST', path: '/api/sax?__p=/v1/auth/code', body: { email: 'check@example.com' }, status: 200 },
        { method: 'GET', path: '/api/sax?__p=/v1/me', status: 401 },
        { method: 'POST', path: '/api/sax?__p=/v1/run-tokens', body: {}, status: 401 },
        { method: 'POST', path: '/api/sax?__p=/v1/mailboxes', body: {}, status: 401 },
        { method: 'PUT', path: '/api/sax?__p=/v1/push-token', body: {}, status: 401 },
        { method: 'GET', path: '/api/sax?__p=/internal/v1/devices/x', status: 404 },
        // 공개 경로 → 재작성(플랫폼이 붙이는 path 매개변수 포함)
        { method: 'GET', public: '/v1/me', status: 401 },
        { method: 'GET', public: '/v1/mailboxes/mb-x/envelopes?since=0', status: 401 },
        // 페퍼 없음: 비밀번호 경로만 닫힌다. 갱신은 열려 있다(형식 오류 400, 모르는 토큰 401)
        { method: 'POST', public: '/v1/auth/password', body: { email: 'check@example.com', password: 'x' }, status: 404 },
        { method: 'POST', public: '/v1/auth/refresh', body: { refreshToken: 'x' }, status: 400 },
        { method: 'POST', public: '/v1/auth/refresh', body: { refreshToken: 'sxa1.' + 'A'.repeat(43) }, status: 401 },
      ]],
      // ADR-038: 묶음 안에서 argon2id(Node 내장)와 흔한 비밀번호 목록(data/common-passwords.txt.gz)이 실제로 돈다
      'sax(비밀번호)': ['sax', { ACCOUNT__PASSWORD_PEPPER_KEYS: `k1:${hex()}` }, [
        { method: 'POST', public: '/v1/auth/password', body: { email: 'check@example.com', password: 'correct horse battery' }, status: 401 },
        { method: 'PUT', public: '/v1/password', body: { password: 'correct horse battery' }, status: 401 },
        { method: 'POST', public: '/v1/auth/password/reset', body: { email: 'check@example.com' }, status: 200 },
      ]],
      internal: ['internal', {}, [
        { method: 'GET', path: '/api/internal?__p=/internal/v1/devices/dev-x', status: 401 },
        { method: 'GET', public: '/api/internal/internal/v1/devices/dev-x', status: 401 },
      ]],
      cron: ['cron', {}, [
        { method: 'GET', path: '/api/cron', headers: cron, status: 200 },
        { method: 'GET', path: '/api/cron', status: 401 },
      ]],
      'registry(구성 없음)': ['registry', {}, [
        { method: 'GET', path: '/api/registry?__p=/registry/log/head.json', status: 503 },
        { method: 'GET', public: '/registry/log/head.json', status: 503 },
        { method: 'GET', path: '/api/registry?__p=/registry/status.json', status: 404 },
      ]],
      registry: ['registry', reg, [
        { method: 'GET', path: '/api/registry?__p=/registry/log/head.json', status: 200 },
        // 재작성 경로(운영 400 request.param_rejected 회귀): 헤드 200, 빈 로그 항목 404
        { method: 'GET', public: '/registry/log/head.json', status: 200 },
        { method: 'GET', public: '/registry/log/entries/0.json', status: 404 },
        { method: 'PUT', path: '/api/registry?__p=/admin/v1/status', body: {}, status: 401 },
        { method: 'GET', path: '/api/registry?__p=/policy/current.json', status: 404 },
      ]],
      'registry-cron(구성 없음)': ['registry-cron', {}, [{ method: 'GET', path: '/api/registry-cron', headers: cron, status: 503 }]],
      'registry-cron': ['registry-cron', reg, [
        { method: 'GET', path: '/api/registry-cron', status: 401 },
        { method: 'GET', path: '/api/registry-cron', headers: cron, status: 200 },
      ]],
    };
    const out: { name: string; error: string | null }[] = [];
    const made = new Map<string, { dir: string; handler: string }>();
    for (const [name, [func, extra, probes]] of Object.entries(checks)) {
      const funcDir = path.join(fnRoot, `${func}.func`);
      if (!fs.existsSync(funcDir)) {
        out.push({ name, error: `${func}.func가 없다(vercel build를 먼저)` });
        continue;
      }
      if (!made.has(func)) made.set(func, materialize(funcDir, root, path.join(work, `${func}.func`)));
      const m = made.get(func)!;
      const resolved: Probe[] = [];
      let bad: string | null = null;
      for (const p of probes) {
        if (!p.public) {
          resolved.push(p);
          continue;
        }
        const to = rewriteLikeVercel(rewrites, p.public);
        if (!to || !to.startsWith(`/api/${func}?`)) bad = `${p.public} → ${to ?? '재작성 없음'} (기대 /api/${func})`;
        else resolved.push({ ...p, path: to });
      }
      out.push({ name, error: bad ?? runFunction(m.dir, m.handler, { ...env, ...extra }, resolved) });
    }
    // 런타임: 계정 묶음은 node:crypto argon2(Node 24.7+)를 쓴다. .vc-config.json 런타임 주 버전이 24 미만이면 실패.
    // 24.x의 부 버전은 여기서 알 수 없다: 배포 뒤 스모크(README 5절, 비밀번호 401·cron의 account.argon2_probe_ms)가 실제 런타임 확인이다
    for (const func of ['sax', 'internal', 'cron']) {
      const cfgFile = path.join(fnRoot, `${func}.func`, '.vc-config.json');
      if (!fs.existsSync(cfgFile)) continue;
      const runtime = String((JSON.parse(fs.readFileSync(cfgFile, 'utf8')) as { runtime?: string }).runtime ?? '');
      const major = Number(/^nodejs(\d+)\.x$/.exec(runtime)?.[1] ?? 0);
      out.push({ name: `${func}(런타임 ${runtime || '?'})`, error: major >= 24 ? null : `argon2id에는 Node 24.7+가 필요하다(지금 ${runtime || '알 수 없음'})` });
    }
    // 어느 묶음에도 네이티브 애드온(.node)이 없다. 계정은 argon2id가 node:crypto 내장이고(ADR-038), 레지스트리는 엔진 코어 경유로 @sax/db의
    // better-sqlite3 JS만 따라온다(애드온은 생성자에서만 읽는데 레지스트리는 열지 않는다). prebuild는 vercel.json excludeFiles로 뺀다
    for (const [func, m] of made) {
      const natives = (fs.readdirSync(m.dir, { recursive: true }) as string[]).filter((f) => f.endsWith('.node'));
      out.push({ name: `${func}(네이티브 없음)`, error: natives.length ? natives.slice(0, 5).join(', ') : null });
    }
    return out;
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  const root = path.resolve(process.argv[2] ?? '..');
  const res = await checkVercelOutput(root);
  const nodeV = spawnSync(process.env.CHECK_NODE || process.execPath, ['-v'], { encoding: 'utf8' }).stdout.trim();
  process.stdout.write(`묶음을 돌린 node: ${nodeV}${process.env.CHECK_NODE ? ' (CHECK_NODE)' : ''}\n`);
  for (const r of res) process.stdout.write(`${r.error ? '✖' : '✔'} api/${r.name}${r.error ? `\n${r.error}` : ''}\n`);
  process.exitCode = res.every((r) => !r.error) ? 0 : 1;
}
