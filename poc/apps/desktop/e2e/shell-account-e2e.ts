// 계정 로그인 e2e(A-01, remote-account.ts): 설정 > 기기 연결 → [로그인] → 이메일 → 6자리 → 첫 PC 등록. 실제 렌더러·preload·main 처리기.
// 계정 서비스는 메모리 가짜(코드 123456, AIK 서명 목록을 실제로 검증한다), 금고 키는 소프트 키다. 실제 계정 서비스 경로는 tests/shell-remote-account.test.ts.
// 실행: electron apps/desktop/e2e-dist/shell-account-e2e.js. 앱 폴더·키체인·네트워크를 쓰지 않는다.
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { app } from 'electron';
import { AIK_PURPOSES, fromB64, softNoiseStatic, softSigner, VD_PURPOSES, verifyDeviceList, x25519Public, type DesktopKeys } from '@sax/remote';
import type { AccountClient, CloudPorts } from '../dist/remote-ports.js';
import { registerShellSchemes, startShell, type Shell } from '../dist/shell-app.js';
import { DEMO_DEV } from '../dist/demo-dev.js';

registerShellSchemes();
const USER_DATA = path.join(app.getPath('temp'), `sax-e2e-acct-${process.pid}`);
app.setPath('userData', USER_DATA);
process.once('exit', () => rmSync(USER_DATA, { recursive: true, force: true, maxRetries: 2 }));
app.on('window-all-closed', () => {});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const results: Array<{ name: string; ok: boolean; detail?: unknown }> = [];
const check = (name: string, ok: boolean, detail?: unknown) => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : ` ${JSON.stringify(detail)}`}`);
};
let S: Shell | undefined;
const js = <T = unknown>(code: string): Promise<T> => S!.win.webContents.executeJavaScript(code) as Promise<T>;
async function until(what: string, fn: () => Promise<boolean>, ms = 10_000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return true;
    await sleep(25);
  }
  console.log(`  (timeout: ${what})`);
  return false;
}
async function press(sel: string) {
  S!.win.webContents.sendInputEvent({ type: 'mouseUp', x: 1, y: 1, button: 'left', clickCount: 1 });
  await sleep(30);
  const ok = await js<boolean>(`(() => { const b = document.querySelector(${JSON.stringify(sel)}); if (!b || b.disabled) return false; b.click(); return true; })()`);
  if (!ok) throw new Error(`no button ${sel}`);
}
const type = (sel: string, v: string) => js(`(() => { const i = document.querySelector(${JSON.stringify(sel)}); i.value = ${JSON.stringify(v)}; i.dispatchEvent(new Event('input')); })()`);
const loginStep = () => js<string | null>(`document.querySelector('[data-account-login]')?.dataset.accountLogin ?? null`);
const callErr = (m: string, p: unknown) => js<string>(`window.sax.call(${JSON.stringify(m)}, ${JSON.stringify(p)}).then(() => 'ok', (e) => String(e.message).replace(/^.*Error: /, ''))`);

/** 메모리 계정 서비스: 코드 123456. /v1/aik는 AIK 서명 첫 목록을 실제로 검증한다. */
function fakeAccount() {
  const calls: string[] = [];
  let pinned: { aikPub: string; deviceId: string } | null = null;
  const fail = (code: string) => Object.assign(new Error(code), { code });
  const client: AccountClient = {
    startEmailCode: async () => (calls.push('code'), { loginId: 'L1', expiresInSec: 600 }),
    verifyEmailCode: async (_l, code) => {
      calls.push('verify');
      if (code !== '123456') throw fail('account.code_invalid');
      return { session: 'sxs1.fake', expiresInSec: 3600 };
    },
    logout: async () => void calls.push('logout'),
    deviceList: async () => (calls.push('list'), { aikPub: null, deviceList: null }),
    pinFirstDesktop: async (_s, b) => {
      calls.push('aik');
      const l = verifyDeviceList(b.deviceList, fromB64(b.aikPub));
      if (!l.ok || l.devices.length !== 1) throw fail('account.aik_signature_invalid');
      pinned = { aikPub: b.aikPub, deviceId: l.devices[0]!.deviceId };
      return { deviceId: pinned.deviceId };
    },
    deviceToken: async () => {
      throw fail('net.not_in_e2e');
    },
    acctClaim: async () => {
      throw fail('net.not_in_e2e');
    },
    enrollPhone: async () => {},
    putDeviceList: async () => {},
  };
  return { client, calls, pinned: () => pinned };
}

function softKeys(): DesktopKeys {
  const k = () => new Uint8Array(randomBytes(32));
  const kv = k();
  return { noise: softNoiseStatic(k()), vd: softSigner(k(), VD_PURPOSES), aik: softSigner(k(), AIK_PURPOSES), kvPublic: () => x25519Public(kv) };
}

async function main() {
  const acct = fakeAccount();
  const keys = softKeys();
  const cloud = { account: acct.client, relay: null, relayHost: 'localhost', insecureLocal: true, openSocket: () => null } as unknown as CloudPorts;
  S = await startShell({ dev: DEMO_DEV, width: 1280, height: 820, show: false, remote: { cloud, keys: async () => keys } });
  S.win.webContents.on('console-message', (e) => {
    if (e.level === 'error') console.log(`  [renderer] ${e.message}`);
  });
  await S.ready;
  await until('renderer ready', async () => (await js('document.body.dataset.ready')) === '1');

  await sleep(3_100);
  check('코드 보내기는 실제 입력 뒤에만', (await callErr('account.sendCode', { email: 'a@gyeonbon-test.example' })) === 'gesture_required');

  await js(`document.querySelector('#rail [data-view="settings"]').click()`);
  await until('settings', async () => js<boolean>(`!!document.querySelector('[data-set-tab=devices]')`));
  await js(`document.querySelector('[data-set-tab=devices]').click()`);
  check('설정 > 기기 연결: 로그인 전', await until('account card', async () => js<boolean>(`document.querySelector('[data-account]')?.dataset.account === 'signed_out'`)));
  await press('[data-act=account-login]');
  check('로그인 창(이메일)', await until('login email', async () => (await loginStep()) === 'signed_out'));
  check('창이 열리면 앱 틀은 inert', await js<boolean>(`document.querySelector('#app').inert === true`));
  await type('.acct-email', 'bad');
  await press('[data-act=account-send]');
  check('이메일 모양 오류 문구', await until('email err', async () => js<boolean>(`document.querySelector('[data-account-login] .sx-note')?.textContent.includes('이메일 형식') === true`)));
  await type('.acct-email', 'owner@gyeonbon-test.example');
  await press('[data-act=account-send]');
  check('코드 넣기 단계(받는 주소 표시)', await until('code', async () => (await loginStep()) === 'code_sent' && (await js<string>(`document.querySelector('[data-acct-to]').textContent`)) === 'owner@gyeonbon-test.example'));
  await type('.acct-code', '000000');
  await press('[data-act=account-verify]');
  check('틀린 코드 문구, 코드 단계 유지', await until('wrong', async () => (await loginStep()) === 'code_sent' && js<boolean>(`document.querySelector('[data-account-login] .sx-note')?.textContent.includes('코드가 맞지 않아요') === true`)));
  await type('.acct-code', '123456');
  await press('[data-act=account-verify]');
  check('등록 끝: 창이 닫히고 계정 줄에 이메일', await until('signed in', async () => (await loginStep()) === null && js<boolean>(`document.querySelector('[data-account]')?.dataset.account === 'signed_in' && document.querySelector('[data-account-email]').textContent === 'owner@gyeonbon-test.example'`)));
  check('계정 호출 순서(코드 → 확인 → 목록 → AIK 고정 → 로그아웃)', JSON.stringify(acct.calls) === JSON.stringify(['code', 'verify', 'verify', 'list', 'aik', 'logout']), acct.calls);
  const idFile = path.join(S.fixture!.root, 'userData', 'remote-identity.json');
  const found = existsSync(idFile) ? idFile : null;
  const raw = found ? readFileSync(found, 'utf8') : '';
  check('신원 파일: 고정한 deviceId, 세션 없음', !!found && JSON.parse(raw).deviceId === acct.pinned()?.deviceId && !raw.includes('sxs1'), found);
  check('렌더러에 세션·토큰 없음', !(await js<string>(`document.body.innerHTML`)).includes('sxs1'));
  check('로그인한 뒤에는 코드 보내기를 받지 않는다', (await (async () => (S!.win.webContents.sendInputEvent({ type: 'mouseUp', x: 1, y: 1, button: 'left', clickCount: 1 }), await sleep(30), callErr('account.sendCode', { email: 'x@gyeonbon-test.example' })))()) === 'account_signed_in');
}

app.whenReady().then(async () => {
  try {
    await main();
  } catch (e) {
    check('e2e 예외 없음', false, (e as Error).stack);
  }
  await S?.close().catch(() => {});
  console.log(`${results.filter((r) => r.ok).length}/${results.length} ok`);
  app.exit(results.length && results.every((r) => r.ok) ? 0 : 1);
});
