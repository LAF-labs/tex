// `vercel build` 결과 점검(배포 전, 로컬). 함수 묶음에 빠진 모듈·데이터 파일이 없는지 실제로 띄워 본다.
// - .vercel/output/functions/api/*.func를 저장소 밖 임시 폴더로 복사하고, .vc-config.json filePathMap의 심볼릭 링크(pnpm 작업공간·의존성)를
//   배포 때처럼 되살린다. 그 폴더에는 위쪽 node_modules가 없어서, 묶음에 없는 파일은 그대로 ERR_MODULE_NOT_FOUND·ENOENT로 드러난다.
// - 함수마다 진입점(handler)을 import하고 요청을 보내 조립(네 서비스 build)까지 거친다. 공개 함수 sax는 계정·게이트웨이·릴레이·푸시 라우터,
//   내부 함수는 서명 없음 401, 정리 함수는 CRON_SECRET으로 200을 기대한다.
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
import { LIMITS_MIGRATIONS_DIR, ed25519Private, ed25519RawPublic, migrate, openSqlite } from '../shared/src/index.ts';

interface Probe {
  method: string;
  path: string;
  headers?: Record<string, string>;
  body?: unknown;
  /** 기대 상태 코드 */
  status: number;
}

const hex = () => randomBytes(32).toString('hex');

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
  for (const [svc, mig] of [['account', ACCOUNT_MIGRATIONS], ['gateway', GATEWAY_MIGRATIONS], ['relay', RELAY_MIGRATIONS], ['push', PUSH_MIGRATIONS]] as const) {
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
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', CHILD], {
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
  const bad = probes.map((p, i) => (got[i] === p.status ? null : `${p.method} ${p.path} → ${got[i]} (기대 ${p.status})`)).filter(Boolean);
  return bad.length ? `${bad.join('\n')}\n${errLines}` : null;
}

export async function checkVercelOutput(root: string): Promise<{ name: string; error: string | null }[]> {
  const fnRoot = path.join(root, '.vercel', 'output', 'functions', 'api');
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'sax-vercel-check-'));
  try {
    fs.mkdirSync(path.join(work, 'db'));
    const env = await testEnv(path.join(work, 'db'));
    const probes: Record<string, Probe[]> = {
      sax: [
        { method: 'POST', path: '/api/sax?__p=/v1/auth/code', body: { email: 'check@example.com' }, status: 200 },
        { method: 'GET', path: '/api/sax?__p=/v1/me', status: 401 },
        { method: 'POST', path: '/api/sax?__p=/v1/run-tokens', body: {}, status: 401 },
        { method: 'POST', path: '/api/sax?__p=/v1/mailboxes', body: {}, status: 401 },
        { method: 'PUT', path: '/api/sax?__p=/v1/push-token', body: {}, status: 401 },
        { method: 'GET', path: '/api/sax?__p=/internal/v1/devices/x', status: 404 },
      ],
      internal: [{ method: 'GET', path: '/api/internal?__p=/internal/v1/devices/dev-x', status: 401 }],
      cron: [
        { method: 'GET', path: '/api/cron', headers: { authorization: `Bearer ${env.CRON_SECRET}` }, status: 200 },
        { method: 'GET', path: '/api/cron', status: 401 },
      ],
    };
    const out: { name: string; error: string | null }[] = [];
    for (const name of Object.keys(probes)) {
      const funcDir = path.join(fnRoot, `${name}.func`);
      if (!fs.existsSync(funcDir)) {
        out.push({ name, error: `${name}.func가 없다(vercel build를 먼저)` });
        continue;
      }
      const m = materialize(funcDir, root, path.join(work, `${name}.func`));
      out.push({ name, error: runFunction(m.dir, m.handler, env, probes[name]!) });
    }
    return out;
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  const root = path.resolve(process.argv[2] ?? '..');
  const res = await checkVercelOutput(root);
  for (const r of res) process.stdout.write(`${r.error ? '✖' : '✔'} api/${r.name}${r.error ? `\n${r.error}` : ''}\n`);
  process.exitCode = res.every((r) => !r.error) ? 0 : 1;
}
