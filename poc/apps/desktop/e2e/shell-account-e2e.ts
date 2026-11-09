// 계정 로그인 e2e(A-01, remote-account.ts): 설정 > 기기 연결 → [로그인] → 이메일 → 6자리 → 첫 PC 등록. 실제 렌더러·preload·main 처리기.
// 계정 서비스는 메모리 가짜(코드 123456, AIK 서명 목록을 실제로 검증한다), 금고 키는 소프트 키다. 실제 계정 서비스 경로는 tests/shell-remote-account.test.ts.
// 실행: electron apps/desktop/e2e-dist/shell-account-e2e.js. 앱 폴더·키체인·네트워크를 쓰지 않는다.
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { app, nativeTheme } from 'electron';
import { AIK_PURPOSES, fromB64, softNoiseStatic, softSigner, VD_PURPOSES, verifyDeviceList, x25519Public, type DesktopKeys } from '@sax/remote';
import type { AccountClient, CloudPorts } from '../dist/remote-ports.js';
import { registerShellSchemes, startShell, type Shell } from '../dist/shell-app.js';
import { DEMO_DEV } from '../dist/demo-dev.js';

registerShellSchemes();
// SAX_E2E_THEME=light|dark: 스크린샷을 캔버스와 같은 테마로 찍는다(기본은 시스템)
if (process.env.SAX_E2E_THEME === 'light' || process.env.SAX_E2E_THEME === 'dark') nativeTheme.themeSource = process.env.SAX_E2E_THEME;
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
const screen = () => js<string | null>(`document.querySelector('[data-acct-screen]')?.dataset.acctScreen ?? null`);
/** SAX_E2E_SHOTS=<폴더>면 화면마다 실제 창을 찍어 둔다(캔버스 v60과 눈으로 맞춰 보는 용도). */
async function shot(name: string) {
  const dir = process.env.SAX_E2E_SHOTS;
  if (!dir) return;
  mkdirSync(dir, { recursive: true });
  await sleep(120);
  writeFileSync(path.join(dir, `${name}.png`), (await S!.win.webContents.capturePage()).toPNG());
}
const loginStep = () => js<string | null>(`document.querySelector('[data-account-login]')?.dataset.accountLogin ?? null`);
const callErr = (m: string, p: unknown) => js<string>(`window.sax.call(${JSON.stringify(m)}, ${JSON.stringify(p)}).then(() => 'ok', (e) => String(e.message).replace(/^.*Error: /, ''))`);

const PASSWORD = 'mangwon-kimchi-12';

/** 메모리 계정 서비스: 코드 123456, 비밀번호 PASSWORD. /v1/aik는 AIK 서명 첫 목록을 실제로 검증한다. */
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
    passwordLogin: async (email, password) => {
      calls.push('password');
      // 틀림·없는 계정·잠금은 서버가 같은 응답을 준다(ADR-038 (d)).
      if (email !== 'owner@gyeonbon-test.example' || password !== PASSWORD) throw fail('account.credentials_invalid');
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
  check('로그인 화면(이메일): 전체 화면', await until('login email', async () => (await screen()) === 'email' && (await loginStep()) === 'signed_out'));
  check('화면이 열리면 앱 틀은 inert', await js<boolean>(`document.querySelector('#app').inert === true`));
  await shot('a01-email');
  check('패스키 버튼은 데스크톱 패스키가 되기 전까지 없다(명세 §8 G7)', !(await js<boolean>(`!!document.querySelector('[data-act=account-passkey]')`)));
  await press('[data-act=account-signup]');
  check('[계정 만들기] → 계정 만들기 화면(이메일 → 코드 받기)', await until('signup', async () => (await screen()) === 'signup' && js<boolean>(`document.querySelector('#acct-title').textContent === '계정 만들기' && !!document.querySelector('[data-act=account-send]')`)));
  await shot('a01-signup');
  await press('[data-act=account-to-login]');
  await until('back to email', async () => (await screen()) === 'email');
  await type('.acct-email', 'bad');
  await press('[data-act=account-next]');
  check('이메일 모양 오류 문구(서버 부르지 않음)', await until('email err', async () => js<boolean>(`document.querySelector('.acct-err')?.textContent.includes('이메일 형식') === true`)) && acct.calls.length === 0);
  await press('[data-act=account-signup]');
  check('다른 화면으로 가면 앞 화면 오류는 지운다', await until('signup clean', async () => (await screen()) === 'signup' && !(await js<boolean>(`!!document.querySelector('.acct-err')`))));
  await press('[data-act=account-to-login]');
  await until('back to email 2', async () => (await screen()) === 'email');
  await type('.acct-email', 'owner@gyeonbon-test.example');
  await press('[data-act=account-next]');
  check('비밀번호 화면(이메일 칩)', await until('pw', async () => (await screen()) === 'password' && (await js<string>(`document.querySelector('[data-acct-email]').textContent`)) === 'owner@gyeonbon-test.example'));
  check('비밀번호 화면에 이전 오류 없음', !(await js<boolean>(`!!document.querySelector('.acct-err')`)));
  await type('.acct-password', 'not-the-password-1');
  await press('.acct-eye');
  const shown = await js<string>(`document.querySelector('.acct-password').type + '|' + document.querySelector('.acct-password').value`);
  await press('.acct-eye');
  const hidden = await js<string>(`document.querySelector('.acct-password').type`);
  check('보기 → 글자 보임(넣은 값 그대로), 다시 → 가림', shown === 'text|not-the-password-1' && hidden === 'password', { shown, hidden });
  await shot('a01-password');
  await press('[data-act=account-password]');
  check('틀린 비밀번호: 같은 안내 + 안에 [이메일 코드로 로그인]', await until('wrong pw', async () => js<boolean>(`(() => { const a = document.querySelector('[data-acct-wrong]'); return !!a && a.textContent.includes('이메일 또는 비밀번호가 맞지 않아요') && !!a.querySelector('[data-act=account-code-from-wrong]'); })()`)));
  check('보낸 뒤 비밀번호 칸은 비고, 화면 어디에도 비밀번호가 없다', (await js<string>(`document.querySelector('.acct-password').value`)) === '' && !(await js<string>(`document.body.innerHTML`)).includes('not-the-password-1'));
  check('틀린 칸 표시', await js<boolean>(`document.querySelector('.acct-password').classList.contains('is-bad')`));
  await shot('a01-wrong');
  await press('[data-act=account-code-from-wrong]');
  check('안내에서 바로 코드: 코드 6자리 화면(받는 주소 표시)', await until('code', async () => (await screen()) === 'code' && (await loginStep()) === 'code_sent' && (await js<string>(`document.querySelector('[data-acct-to]').textContent`)) === 'owner@gyeonbon-test.example'));
  check('남은 시간 m:ss', /^\d+:\d\d$/.test(await js<string>(`document.querySelector('[data-acct-left]')?.textContent ?? ''`)));
  await type('.acct-code', '48');
  check('칸 여섯 개에 넣은 숫자', (await js<string>(`[...document.querySelectorAll('.acct-cell')].map((c) => c.textContent).join('')`)) === '48');
  await shot('a01-code');
  await type('.acct-code', '000000');
  check('틀린 코드 문구, 코드 화면 유지, 칸 비움', await until('wrong', async () => (await screen()) === 'code' && js<boolean>(`document.querySelector('.acct-err')?.textContent.includes('코드가 맞지 않아요') === true && document.querySelector('.acct-code').value === ''`)));
  await press('[data-act=account-back]');
  check('[뒤로] → 이메일 코드로 로그인 화면', await until('code email', async () => (await screen()) === 'code_email' && (await loginStep()) === 'signed_out'));
  await shot('a01-code-email');
  await press('[data-act=account-send]');
  await until('code again', async () => (await screen()) === 'code');
  await type('.acct-code', '123456');
  check('6자리를 다 넣으면 바로 확인 → 등록 끝: 화면이 닫히고 계정 줄에 이메일', await until('signed in', async () => (await loginStep()) === null && js<boolean>(`document.querySelector('[data-account]')?.dataset.account === 'signed_in' && document.querySelector('[data-account-email]').textContent === 'owner@gyeonbon-test.example'`)));
  check('계정 호출 순서(비밀번호 → 코드 → 확인 → 코드 → 확인 → 목록 → AIK 고정 → 로그아웃)', JSON.stringify(acct.calls) === JSON.stringify(['password', 'code', 'verify', 'code', 'verify', 'list', 'aik', 'logout']), acct.calls);
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
