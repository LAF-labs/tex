// S6e 화면 확인(수동 실행, Windows): 금고와 같은 방식(Preferences·Local State 기록, 허용 인자 3개, 헤드풀)으로 Chrome을 띄워
// 로그인·주소·카드 폼을 CDP 입력 이벤트로 채워 제출하고, 저장 제안·자동완성 팝업이 뜨는지 본다.
// 대조군은 아무것도 기록하지 않은 새 프로필이다. 저장 제안은 브라우저 UI라 CDP 스크린샷에 안 잡혀 창을 OS로 캡처한다(s6e-capture.ps1).
// 실행: node --conditions=development tests/s6e-screen.ts <출력 폴더>
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { promisify } from 'node:util';
import { windowsTool } from '@sax/platform';
import { REQUIRED_LOCAL_STATE, REQUIRED_PREFERENCES, findInstalledChrome, launchChrome, verifyProfileSettings, writeProfileSettings } from '@sax/vault';

const run = promisify(execFile);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const outDir = path.resolve(process.argv[2] ?? 's6e-out');
await fs.mkdir(outDir, { recursive: true });

// 폼 값은 이 시험용 합성 값이다(실제 계정·주소·카드 아님). 카드 번호는 카드사 공개 시험 번호.
const page = (t: string, body: string) => `<!doctype html><html><head><meta charset="utf-8"><title>${t}</title></head><body style="font:16px sans-serif;padding:24px">${body}</body></html>`;
const input = (id: string, ac: string, type = 'text') => `<p><label>${id} <input id="${id}" name="${id}" type="${type}" autocomplete="${ac}"></label></p>`;
const PAGES: Record<string, string> = {
  '/login': page('S6e login', `<form method="POST" action="/done">${input('user', 'username')}${input('pw', 'current-password', 'password')}${input('memo', 'off')}<button id="go">로그인</button></form>`),
  '/address': page('S6e address', `<form method="POST" action="/done">${input('name', 'name')}${input('street', 'address-line1')}${input('city', 'address-level2')}${input('state', 'address-level1')}${input('zip', 'postal-code')}${input('country', 'country')}${input('tel', 'tel')}${input('email', 'email')}<button id="go">저장</button></form>`),
  '/card': page('S6e card', `<form method="POST" action="/done">${input('ccname', 'cc-name')}${input('ccnum', 'cc-number')}${input('ccmonth', 'cc-exp-month')}${input('ccyear', 'cc-exp-year')}${input('csc', 'cc-csc')}<button id="go">결제 정보 저장</button></form>`),
  '/done': page('S6e done', '<p id="done">done</p>'),
};
const STEPS: Array<{ name: string; path: string; fill: Array<[string, string]> }> = [
  { name: 'login', path: '/login', fill: [['user', 's6e-user'], ['pw', 's6e-Test-pw-7351'], ['memo', 's6e-memo']] },
  { name: 'address', path: '/address', fill: [['name', 'Sax Test'], ['street', '123 Test St'], ['city', 'Springfield'], ['state', 'IL'], ['zip', '62701'], ['country', 'US'], ['tel', '217-555-0100'], ['email', 's6e@example.com']] },
  { name: 'card', path: '/card', fill: [['ccname', 'Sax Test'], ['ccnum', '4111111111111111'], ['ccmonth', '12'], ['ccyear', '2030'], ['csc', '123']] },
];

const server = http.createServer((req, res) => {
  req.resume();
  req.on('end', () => {
    const body = PAGES[new URL(req.url ?? '/', 'http://x').pathname];
    res.writeHead(body ? 200 : 404, { 'content-type': 'text/html; charset=utf-8' });
    res.end(body ?? '');
  });
});
await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

const exe = findInstalledChrome();
if (!exe) throw new Error('Chrome not found');

interface Win { class: string; title: string; left: number; top: number; width: number; height: number; file: string }
async function capture(pid: number, name: string): Promise<Win[]> {
  const ps = windowsTool('WindowsPowerShell\\v1.0\\powershell.exe');
  const script = path.join(import.meta.dirname, 's6e-capture.ps1');
  const { stdout } = await run(ps, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, '-ProcessId', String(pid), '-OutPrefix', path.join(outDir, name)]);
  return JSON.parse(stdout.trim() || '[]') as Win[];
}

// Chrome 종료 뒤 프로필 DB의 행 수. 저장 제안을 누르지 않으므로 주소·카드·로그인은 둘 다 0이어야 하고,
// 단일 칸 자동완성 기록(autofill 표)은 자동완성이 켜진 프로필에서만 제출 때 저절로 쌓인다.
function countRows(file: string, tables: string[]): Record<string, number | null> {
  const out: Record<string, number | null> = {};
  let db: DatabaseSync | null = null;
  try {
    db = new DatabaseSync(file, { readOnly: true });
    const have = new Set((db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>).map((r) => r.name));
    for (const t of tables) out[t] = have.has(t) ? Number((db.prepare(`SELECT count(*) AS n FROM "${t}"`).get() as { n: number }).n) : null;
  } catch {
    for (const t of tables) out[t] = null;
  } finally {
    db?.close();
  }
  return out;
}

async function readJson(file: string): Promise<Record<string, unknown>> {
  return JSON.parse(await fs.readFile(file, 'utf8').catch(() => '{}')) as Record<string, unknown>;
}
const getPath = (o: unknown, dotted: string) => dotted.split('.').reduce<unknown>((c, k) => (c && typeof c === 'object' ? (c as Record<string, unknown>)[k] : undefined), o);

async function runProfile(kind: 'vault' | 'control') {
  const profileDir = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), `sax-s6e-${kind}-`));
  if (kind === 'vault') await writeProfileSettings(profileDir);
  const chrome = await launchChrome({ executable: exe!, profileDir });
  const { conn } = chrome;
  const result: Record<string, unknown> = { kind, args: chrome.args.map((a) => a.split('=')[0]) };
  const waitEvent = (method: string, sessionId: string, ms = 15_000) =>
    new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => {
        conn.off('message', on);
        reject(new Error(`timeout ${method}`));
      }, ms);
      const on = (m: { method?: string; sessionId?: string }) => {
        if (m.method !== method || m.sessionId !== sessionId) return;
        clearTimeout(t);
        conn.off('message', on);
        resolve();
      };
      conn.on('message', on);
    });
  try {
    result.version = ((await conn.send('Browser.getVersion')) as { product?: string }).product;
    const steps: Record<string, unknown> = {};
    for (const step of STEPS) {
      // 단계마다 새 탭에서 한다. 저장 제안 말풍선은 탭에 붙어 있어 탭을 닫아야 다음 단계 캡처에 섞이지 않는다.
      const { targetId } = (await conn.send('Target.createTarget', { url: 'about:blank' })) as { targetId: string };
      const { sessionId } = (await conn.send('Target.attachToTarget', { targetId, flatten: true })) as { sessionId: string };
      const s = (m: string, p: Record<string, unknown> = {}) => conn.send(m, p, sessionId);
      const evalValue = async <T>(expression: string) => ((await s('Runtime.evaluate', { expression, returnByValue: true })) as { result: { value: T } }).result.value;
      const { windowId } = (await conn.send('Browser.getWindowForTarget', { targetId })) as { windowId: number };
      await conn.send('Browser.setWindowBounds', { windowId, bounds: { left: 80, top: 80, width: 1000, height: 760 } });
      await s('Page.enable');
      await s('Emulation.setFocusEmulationEnabled', { enabled: true });
      const goto = async (url: string) => {
        const loaded = waitEvent('Page.loadEventFired', sessionId);
        await s('Page.navigate', { url });
        await loaded;
        await s('Page.bringToFront');
      };
      const click = async (id: string) => {
        const [x, y] = await evalValue<[number, number]>(`(b => [b.x + b.width / 2, b.y + b.height / 2])(document.getElementById(${JSON.stringify(id)}).getBoundingClientRect())`);
        for (const type of ['mousePressed', 'mouseReleased']) await s('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 });
      };
      // 막 그려진 페이지에서는 첫 클릭이 가끔 빠진다(실측). 초점이 실제로 옮겨졌는지 보고 다시 누른다.
      const focus = async (id: string) => {
        for (let i = 0; i < 10; i++) {
          await click(id);
          if ((await evalValue<string>('document.activeElement?.id ?? ""')) === id) return;
          await sleep(200);
        }
        throw new Error(`cannot focus ${id}`);
      };
      await goto(origin + step.path);
      for (const [id, value] of step.fill) {
        await focus(id);
        await s('Input.insertText', { text: value });
      }
      const lens = await evalValue<number[]>(`${JSON.stringify(step.fill.map(([id]) => id))}.map((id) => document.getElementById(id).value.length)`);
      if (lens.join() !== step.fill.map(([, v]) => v.length).join()) throw new Error(`${step.name}: fill mismatch ${lens.join()}`);
      for (let i = 0; ; i++) {
        const submitted = waitEvent('Page.loadEventFired', sessionId, 3000);
        await click('go');
        try {
          await submitted;
          break;
        } catch (e) {
          if (i >= 4) throw e;
        }
      }
      await sleep(2500);
      const afterSubmit = await capture(chrome.proc.pid!, `${kind}-${step.name}-submit`);
      // 같은 폼을 다시 열고 첫 칸을 눌러 자동완성 목록이 뜨는지 본다.
      await goto(origin + step.path);
      await focus(step.fill[0]![0]);
      await sleep(1500);
      const refill = await capture(chrome.proc.pid!, `${kind}-${step.name}-refill`);
      steps[step.name] = { afterSubmit, refill };
      await conn.send('Target.closeTarget', { targetId });
    }
    result.steps = steps;
  } finally {
    await chrome.close();
  }
  const prefs = await readJson(path.join(profileDir, 'Default', 'Preferences'));
  const localState = await readJson(path.join(profileDir, 'Local State'));
  result.prefsAfterExit = Object.fromEntries(REQUIRED_PREFERENCES.map(([k]) => [k, getPath(prefs, k) ?? null]));
  result.localStateAfterExit = Object.fromEntries(REQUIRED_LOCAL_STATE.map(([k]) => [k, getPath(localState, k) ?? null]));
  result.verifyMismatch = await verifyProfileSettings(profileDir);
  result.webData = countRows(path.join(profileDir, 'Default', 'Web Data'), ['autofill', 'local_addresses', 'addresses', 'credit_cards']);
  result.loginData = countRows(path.join(profileDir, 'Default', 'Login Data'), ['logins']);
  await fs.rm(profileDir, { recursive: true, force: true });
  return result;
}

const out = { at: new Date().toISOString(), runs: [] as unknown[] };
try {
  for (const kind of ['vault', 'control'] as const) out.runs.push(await runProfile(kind));
} finally {
  server.close();
}
await fs.writeFile(path.join(outDir, 's6e.json'), JSON.stringify(out, null, 2) + '\n');
console.log(JSON.stringify(out, null, 2));
