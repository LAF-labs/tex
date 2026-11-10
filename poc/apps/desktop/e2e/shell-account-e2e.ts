// 계정 로그인 e2e(A-01, remote-account.ts): 설정 > 기기 연결 → [로그인] → 이메일 → 6자리 → 첫 PC 등록. 실제 렌더러·preload·main 처리기.
// 계정 서비스는 메모리 가짜(코드 123456, AIK 서명 목록을 실제로 검증한다)를 localhost HTTP로 띄우고(fake-account-http.ts), 셸은 제품 클라이언트
// (cloudPorts)와 제품 Egress 허용 목록으로 거기에 닿는다. 금고 키는 소프트 키다. 실제 계정 서비스 경로는 tests/shell-remote-account.test.ts.
// 실행: electron apps/desktop/e2e-dist/shell-account-e2e.js. 앱 폴더·키체인·네트워크를 쓰지 않는다.
// SAX_E2E_ACCOUNT=hint이면 로그아웃 상태 대화의 로그인 안내(한 번)와 제목줄 [로그인]을 본다.
// SAX_E2E_ACCOUNT=signup이면 계정 만들기 → 비밀번호 만들기(인계 명세 §3), reset이면 비밀번호 찾기(§4)를 돈다(셸은 프로세스에 하나라 따로 띄운다).
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { app, nativeTheme } from 'electron';
import { AIK_PURPOSES, fromB64, softNoiseStatic, softSigner, VD_PURPOSES, verifyDeviceList, x25519Public, type DesktopKeys } from '@sax/remote';
import { Egress } from '@sax/net';
import type { AccountClient } from '../dist/remote-ports.js';
import { cloudPorts } from '../dist/remote-cloud.js';
import { serveAccount } from './fake-account-http.js';
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

/** 서버 목록에만 있다고 치는 비밀번호(앱 번들 목록에는 없다): 서버 거부 문구를 보는 데 쓴다. */
const SERVER_ONLY_BREACHED = 'gwangjang-bindae-3';

/** 메모리 계정 서비스: 코드 123456, 비밀번호 PASSWORD. /v1/aik는 AIK 서명 첫 목록을 실제로 검증한다. hasPassword가 거짓이면 계정 만들기 뒤 비밀번호 단계가 뜬다. */
function fakeAccount(o: { hasPassword?: boolean } = {}) {
  const calls: string[] = [];
  let hasPw = o.hasPassword ?? true;
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
    me: async () => (calls.push('me'), { email: 'owner@gyeonbon-test.example', hasPassword: hasPw, reauthUntil: null, authMethod: 'email_code' }),
    setPassword: async (_s, password) => {
      calls.push('setPassword');
      if (password === SERVER_ONLY_BREACHED) throw fail('account.password_breached');
      if (password !== PASSWORD) throw fail('account.password_too_short');
      hasPw = true;
      return {};
    },
    deletePassword: async () => {
      throw fail('net.not_in_e2e');
    },
    startReauth: async () => {
      throw fail('net.not_in_e2e');
    },
    verifyReauth: async () => {
      throw fail('net.not_in_e2e');
    },
    startPasswordReset: async () => (calls.push('reset'), { resetId: 'R1', expiresInSec: 600 }),
    verifyPasswordReset: async (_r, code, password) => {
      calls.push('resetVerify');
      if (code !== '654321') throw fail('account.code_invalid');
      if (password === SERVER_ONLY_BREACHED) throw fail('account.password_breached');
      return { session: 'sxs1.fake', expiresInSec: 3600 };
    },
    refresh: async () => {
      throw fail('account.unauthorized');
    },
    revokeRefresh: async () => {},
    logoutAll: async () => {
      throw fail('net.not_in_e2e');
    },
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
  // 제품 클라이언트 + 제품 Egress(허용 목록 그대로). 개발 origin(127.0.0.1)만 cloudDevLocal로 연다.
  const front = await serveAccount(acct.client);
  const egress = new Egress({ cloudDevLocal: true });
  const cloud = cloudPorts({ egress, env: 'dev', dev: { accountOrigin: front.origin, relayHost: '127.0.0.1:9' } });
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
  check(
    '계정 호출은 제품 클라이언트·제품 Egress 허용 목록을 지나 앞단에 닿았다(비밀번호 로그인 포함, #224 결함 재발 방지)',
    front.hits.includes('POST /v1/auth/password') && egress.audit.some((x) => x.dest === 'cloud' && x.path === 'auth.password' && x.status === 401) && egress.audit.every((x) => x.dest === 'cloud') && JSON.stringify(egress.audit).indexOf('gyeonbon') < 0,
    { hits: front.hits, audit: egress.audit },
  );
  const idFile = path.join(S.fixture!.root, 'userData', 'remote-identity.json');
  const found = existsSync(idFile) ? idFile : null;
  const raw = found ? readFileSync(found, 'utf8') : '';
  check('신원 파일: 고정한 deviceId, 세션 없음', !!found && JSON.parse(raw).deviceId === acct.pinned()?.deviceId && !raw.includes('sxs1'), found);
  check('렌더러에 세션·토큰 없음', !(await js<string>(`document.body.innerHTML`)).includes('sxs1'));
  check('로그인한 뒤에는 코드 보내기를 받지 않는다', (await (async () => (S!.win.webContents.sendInputEvent({ type: 'mouseUp', x: 1, y: 1, button: 'left', clickCount: 1 }), await sleep(30), callErr('account.sendCode', { email: 'x@gyeonbon-test.example' })))()) === 'account_signed_in');
}

/** 계정 만들기 → 코드 → 비밀번호 만들기(인계 명세 §3 pw·shown·common·mine, §3.2 거부 문구). 새 셸·새 금고 키·비밀번호 없는 계정. */
async function signup() {
  const acct = fakeAccount({ hasPassword: false });
  const keys = softKeys();
  const front = await serveAccount(acct.client);
  const egress = new Egress({ cloudDevLocal: true });
  const cloud = cloudPorts({ egress, env: 'dev', dev: { accountOrigin: front.origin, relayHost: '127.0.0.1:9' } });
  S = await startShell({ dev: DEMO_DEV, width: 1280, height: 820, show: false, remote: { cloud, keys: async () => keys } });
  await S.ready;
  await until('renderer ready 2', async () => (await js('document.body.dataset.ready')) === '1');
  await js(`document.querySelector('#rail [data-view="settings"]').click()`);
  await until('settings 2', async () => js<boolean>(`!!document.querySelector('[data-set-tab=devices]')`));
  await js(`document.querySelector('[data-set-tab=devices]').click()`);
  await until('account card 2', async () => js<boolean>(`document.querySelector('[data-account]')?.dataset.account === 'signed_out'`));
  await press('[data-act=account-login]');
  await until('login 2', async () => (await screen()) === 'email');
  await press('[data-act=account-signup]');
  await until('signup 2', async () => (await screen()) === 'signup');
  await type('.acct-email', 'owner@gyeonbon-test.example');
  await press('[data-act=account-send]');
  await until('code 2', async () => (await screen()) === 'code');
  await type('.acct-code', '123456');
  check('계정 만들기 → 코드 → 비밀번호 만들기 화면(제목·부제·[나중에])', await until('signup pw', async () => (await screen()) === 'signup_pw' && (await loginStep()) === 'set_password' && js<boolean>(`document.querySelector('#acct-title').textContent === '비밀번호 만들기' && document.querySelector('.acct-head p').textContent === '다음부터 메일을 열지 않고 로그인해요' && !!document.querySelector('[data-act=account-skip-password]')`)));
  check('새 비밀번호 칸: new-password, 가림, 확인 칸 없음', await js<boolean>(`(() => { const i = document.querySelectorAll('.acct-password'); return i.length === 1 && i[0].autocomplete === 'new-password' && i[0].type === 'password'; })()`));
  const rules = () => js<string>(`[...document.querySelectorAll('[data-rule]')].map((r) => r.dataset.rule + ':' + r.className.replace('acct-rule is-', '')).join(',')`);
  const made = () => js<boolean>(`document.querySelector('[data-act=account-set-password]').disabled`);
  const warn = () => js<string>(`(() => { const w = document.querySelector('[data-acct-pw-warn]'); return w.hidden ? '' : w.textContent; })()`);
  check('처음: 조건 3줄 모두 아직, [만들기] 꺼짐', (await rules()) === 'len:wait,common:wait,identity:wait' && (await made()));
  await shot('a01-signup-pw');
  await type('.acct-password', 'short1');
  check('10자 미만: 세 줄 모두 아직(목록·이름 결과를 미리 보이지 않는다)', (await rules()) === 'len:wait,common:wait,identity:wait' && (await made()) && (await warn()) === '');
  await type('.acct-password', '1234567890');
  check('흔한 비밀번호: 2줄 어긋남 + 경고 줄 + 칸 테두리, [만들기] 꺼짐', (await rules()) === 'len:ok,common:bad,identity:ok' && (await made()) && (await warn()) === '많이 쓰이거나 이미 알려진 비밀번호예요. 다른 비밀번호를 써 주세요' && (await js<boolean>(`document.querySelector('.acct-password').classList.contains('is-bad')`)));
  await shot('a01-signup-pw-common');
  await type('.acct-password', 'my-owner-pass-9');
  check('이메일 로컬 부분이 들어감: 3줄 어긋남 + 이메일 문구', (await rules()) === 'len:ok,common:ok,identity:bad' && (await made()) && (await warn()) === '이메일 주소가 들어간 비밀번호는 쓸 수 없어요');
  await shot('a01-signup-pw-mine');
  await type('.acct-password', 'Sovereign-pass-1');
  check('서비스 이름이 들어감: 서비스 문구', (await rules()) === 'len:ok,common:ok,identity:bad' && (await warn()) === '서비스 이름이 들어간 비밀번호는 쓸 수 없어요');
  await type('.acct-password', SERVER_ONLY_BREACHED);
  check('세 줄 모두 맞음: [만들기] 켜짐, 경고 없음', (await rules()) === 'len:ok,common:ok,identity:ok' && !(await made()) && (await warn()) === '');
  await press('.acct-eye');
  check('보기 토글: 글자 보임(넣은 값 그대로), 줄 상태 유지', (await js<string>(`document.querySelector('.acct-password').type + '|' + document.querySelector('.acct-password').value`)) === `text|${SERVER_ONLY_BREACHED}` && (await rules()) === 'len:ok,common:ok,identity:ok');
  await shot('a01-signup-pw-shown');
  await press('.acct-eye');
  await press('[data-act=account-set-password]');
  check(
    '서버 거부(목록): 같은 화면에 문구, 칸은 비우고 다시 채우지 않는다, 화면에 비밀번호 없음',
    await until('server breached', async () => (await screen()) === 'signup_pw' && (await warn()) === '많이 쓰이거나 이미 알려진 비밀번호예요. 다른 비밀번호를 써 주세요' && (await js<string>(`document.querySelector('.acct-password').value`)) === ''),
  );
  check('보낸 비밀번호는 렌더러 어디에도 없다', !(await js<string>(`document.body.innerHTML + JSON.stringify(window.history.state ?? null)`)).includes(SERVER_ONLY_BREACHED));
  await type('.acct-password', PASSWORD);
  await press('[data-act=account-set-password]');
  check('만들기 → 화면이 닫히고 로그인 상태(계정 줄에 이메일)', await until('pw set', async () => (await loginStep()) === null && js<boolean>(`document.querySelector('[data-account]')?.dataset.account === 'signed_in'`)));
  check('계정 호출 순서(코드 → 확인 → 목록 → AIK → me → 만들기 ×2 → 로그아웃)', JSON.stringify(acct.calls) === JSON.stringify(['code', 'verify', 'list', 'aik', 'me', 'setPassword', 'setPassword', 'logout']), acct.calls);
  check('비밀번호 만들기도 제품 Egress 허용 목록을 지났다(GET /v1/me, PUT /v1/password)', front.hits.includes('GET /v1/me') && front.hits.includes('PUT /v1/password') && egress.audit.some((x) => x.path === 'password.put' && x.status === 204) && !JSON.stringify(egress.audit).includes(PASSWORD), { hits: front.hits });
  front.close();
}

/** 비밀번호 찾기(인계 명세 §4): 틀린 비밀번호 안내의 [비밀번호 찾기] → 이메일 → 코드 6자리(서버 검증 없음) → 새 비밀번호 → 바꿈 끝 → [계속]. */
async function reset() {
  const acct = fakeAccount();
  const keys = softKeys();
  const front = await serveAccount(acct.client);
  const egress = new Egress({ cloudDevLocal: true });
  const cloud = cloudPorts({ egress, env: 'dev', dev: { accountOrigin: front.origin, relayHost: '127.0.0.1:9' } });
  S = await startShell({ dev: DEMO_DEV, width: 1280, height: 820, show: false, remote: { cloud, keys: async () => keys } });
  await S.ready;
  await until('renderer ready 3', async () => (await js('document.body.dataset.ready')) === '1');
  await js(`document.querySelector('#rail [data-view="settings"]').click()`);
  await until('settings 3', async () => js<boolean>(`!!document.querySelector('[data-set-tab=devices]')`));
  await js(`document.querySelector('[data-set-tab=devices]').click()`);
  await until('account card 3', async () => js<boolean>(`document.querySelector('[data-account]')?.dataset.account === 'signed_out'`));
  await press('[data-act=account-login]');
  await until('login 3', async () => (await screen()) === 'email');
  await type('.acct-email', 'owner@gyeonbon-test.example');
  await press('[data-act=account-next]');
  await until('pw 3', async () => (await screen()) === 'password');
  check('비밀번호 화면: [이메일 코드로 로그인] · [비밀번호 찾기]', await js<boolean>(`!!document.querySelector('[data-act=account-code-login]') && !!document.querySelector('[data-act=account-reset]')`));
  await type('.acct-password', 'not-the-password-1');
  await press('[data-act=account-password]');
  await until('wrong 3', async () => js<boolean>(`!!document.querySelector('[data-acct-wrong]')`));
  check('틀린 비밀번호 안내 아래에도 [비밀번호 찾기]', await js<boolean>(`!!document.querySelector('[data-act=account-reset]')`));
  await press('[data-act=account-reset]');
  check('비밀번호 찾기 화면(제목·부제, 이메일 그대로)', await until('reset email', async () => (await screen()) === 'reset_email' && js<boolean>(`document.querySelector('#acct-title').textContent === '비밀번호 찾기' && document.querySelector('.acct-head p').textContent === '가입한 이메일로 코드를 보내요' && document.querySelector('.acct-email').value === 'owner@gyeonbon-test.example'`)));
  await shot('a01-reset-email');
  await press('[data-act=account-reset-send]');
  check('코드 받기 → 코드 6자리(받는 주소·남은 시간)', await until('reset code', async () => (await screen()) === 'reset_code' && (await loginStep()) === 'reset_code' && (await js<string>(`document.querySelector('[data-acct-to]').textContent`)) === 'owner@gyeonbon-test.example' && /^\d+:\d\d$/.test(await js<string>(`document.querySelector('[data-acct-left]')?.textContent ?? ''`))));
  await shot('a01-reset-code');
  const before = acct.calls.length;
  await type('.acct-code', '111111');
  check('6자리를 받으면 서버를 부르지 않고 새 비밀번호 화면(이메일 표시)', await until('reset new', async () => (await screen()) === 'reset_new' && js<boolean>(`document.querySelector('#acct-title').textContent === '새 비밀번호' && document.querySelector('[data-acct-to]').textContent === 'owner@gyeonbon-test.example'`)) && acct.calls.length === before);
  check('새 비밀번호 칸: new-password, 조건 3줄, [바꾸기] 꺼짐', await js<boolean>(`document.querySelector('.acct-password').autocomplete === 'new-password' && document.querySelectorAll('[data-rule]').length === 3 && document.querySelector('[data-act=account-reset-finish]').disabled`));
  await type('.acct-password', PASSWORD);
  await shot('a01-reset-new');
  await press('[data-act=account-reset-finish]');
  check(
    '틀린 코드: 코드 화면으로 돌아가 문구, 칸 비움, 새 비밀번호도 지움',
    await until('reset wrong code', async () => (await screen()) === 'reset_code' && js<boolean>(`document.querySelector('.acct-err')?.textContent.includes('코드가 맞지 않아요') === true && document.querySelector('.acct-code').value === ''`)) && !(await js<string>(`document.body.innerHTML`)).includes(PASSWORD),
  );
  await type('.acct-code', '654321');
  await until('reset new 2', async () => (await screen()) === 'reset_new');
  await type('.acct-password', SERVER_ONLY_BREACHED);
  await press('[data-act=account-reset-finish]');
  check('정책 거부: 새 비밀번호 화면에 남아 문구, 칸 비움', await until('reset breached', async () => (await screen()) === 'reset_new' && js<boolean>(`(() => { const w = document.querySelector('[data-acct-pw-warn]'); return !w.hidden && w.textContent === '많이 쓰이거나 이미 알려진 비밀번호예요. 다른 비밀번호를 써 주세요' && document.querySelector('.acct-password').value === ''; })()`)));
  await type('.acct-password', PASSWORD);
  await press('[data-act=account-reset-finish]');
  check(
    '바꿈 끝 화면: 제목, 두 줄(다른 곳 로그인 끝·금고와 기기 연결 그대로), [계속]에 포커스',
    await until('reset done', async () => (await screen()) === 'reset_done' && js<boolean>(`document.querySelector('#acct-title').textContent === '비밀번호를 바꿨어요' && document.querySelector('.acct-box').textContent === '다른 곳의 로그인은 모두 끝났어요금고와 기기 연결은 그대로예요' && document.activeElement?.dataset.act === 'account-reset-done'`)),
    await js(`({ s: document.querySelector('[data-acct-screen]')?.dataset.acctScreen, step: document.querySelector('[data-account-login]')?.dataset.accountLogin, t: document.querySelector('#acct-title')?.textContent, box: document.querySelector('.acct-box')?.textContent, f: document.activeElement?.outerHTML.slice(0, 80) })`),
  );
  await shot('a01-reset-done');
  await press('[data-act=account-reset-done]');
  check('[계속] → 닫히고 로그인 상태', await until('reset closed', async () => (await loginStep()) === null && js<boolean>(`document.querySelector('[data-account]')?.dataset.account === 'signed_in'`)));
  check('계정 호출 순서(비밀번호 → 재설정 코드 → 바꾸기 ×3 → 목록 → AIK → 로그아웃)', JSON.stringify(acct.calls) === JSON.stringify(['password', 'reset', 'resetVerify', 'resetVerify', 'resetVerify', 'list', 'aik', 'logout']), acct.calls);
  check('재설정도 제품 Egress 허용 목록을 지났다(auth.reset·auth.resetVerify), 기록에 이메일·비밀번호 없음', egress.audit.some((x) => x.path === 'auth.reset') && egress.audit.some((x) => x.path === 'auth.resetVerify' && x.status === 200) && !/gyeonbon|kimchi|bindae/.test(JSON.stringify(egress.audit)), egress.audit);
  check('렌더러에 세션·비밀번호 없음', !/sxs1|kimchi|bindae/.test(await js<string>(`document.body.innerHTML`)));
  front.close();
}

/** 로그아웃 상태: 대화가 오프라인 해석이면 한 번만 [로그인]을 안내하고, 제목줄 "오프라인 해석"을 누르면 로그인 창이 열린다. 로그인하면 거둔다. */
async function hint() {
  const acct = fakeAccount();
  const keys = softKeys();
  const front = await serveAccount(acct.client);
  const egress = new Egress({ cloudDevLocal: true });
  const cloud = cloudPorts({ egress, env: 'dev', dev: { accountOrigin: front.origin, relayHost: '127.0.0.1:9' } });
  S = await startShell({ dev: DEMO_DEV, width: 1280, height: 820, show: false, remote: { cloud, keys: async () => keys } });
  await S.ready;
  await until('renderer ready 4', async () => (await js('document.body.dataset.ready')) === '1');
  check('기동: 제목줄은 "오프라인 해석 · 로그인" 버튼', await until('tb login', async () => js<boolean>(`!!document.querySelector('[data-act=interp-login]')`)));
  const send = (text: string) => js(`(() => { const t = document.querySelector('#composer'); t.value = ${JSON.stringify(text)}; t.dispatchEvent(new Event('input')); document.querySelector('.sx-send').click(); })()`);
  const cp = await js<string>(`(async () => (await window.sax.call('counterparties.list', {}))[0]?.name ?? '')()`);
  await send(`세금계산서 1000원 ${cp}에 끊자`);
  check('로그아웃 상태 요청: 대화에 로그인 안내 한 번 + [로그인]', await until('hint', async () => js<boolean>(`document.querySelectorAll('[data-login-hint]').length === 1 && !!document.querySelector('[data-login-hint] [data-act=hint-login]') && document.querySelector('[data-login-hint]').textContent.includes('로그인하면 문장을 더 잘 알아들어요')`)));
  await until('idle', async () => js<boolean>(`!document.querySelector('#composer').disabled`), 5_000);
  await sleep(300);
  await send('세금계산서');
  await sleep(1_500);
  check('두 번째 요청에는 다시 안내하지 않는다', (await js<number>(`document.querySelectorAll('[data-login-hint]').length`)) === 1);
  await press('[data-act=interp-login]');
  check('제목줄 [로그인] → 로그인 화면', await until('login from tb', async () => (await screen()) === 'email'));
  await type('.acct-email', 'owner@gyeonbon-test.example');
  await press('[data-act=account-next]');
  await until('pw hint', async () => (await screen()) === 'password');
  await type('.acct-password', PASSWORD);
  await press('[data-act=account-password]');
  check('로그인하면 제목줄 [로그인]을 거두고 "오프라인 해석" 글자로', await until('tb after login', async () => (await loginStep()) === null && js<boolean>(`!document.querySelector('[data-act=interp-login]') && !!document.querySelector('span.tb-interp')`)));
  front.close();
}

app.whenReady().then(async () => {
  try {
    if (process.env.SAX_E2E_ACCOUNT === 'signup') await signup();
    else if (process.env.SAX_E2E_ACCOUNT === 'reset') await reset();
    else if (process.env.SAX_E2E_ACCOUNT === 'hint') await hint();
    else await main();
  } catch (e) {
    check('e2e 예외 없음', false, (e as Error).stack);
  }
  await S?.close().catch(() => {});
  console.log(`${results.filter((r) => r.ok).length}/${results.length} ok`);
  app.exit(results.length && results.every((r) => r.ok) ? 0 : 1);
});
