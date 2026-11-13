// 폰 연결 e2e(S-03, remote-pairing.ts·pair-window.ts): 로그인 → 설정 > 기기 연결 [폰 연결] → main 소유 창(QR, 화면 캡처 차단) → 폰(MobilePairing)이 찍고
// 폰의 6자리를 그 창에 넣는다 → 폰이 계정 서비스 서명 acctClaim을 검증한다. 계정·릴레이는 메모리 가짜, 금고 키는 소프트 키.
// QR은 실제 인코더(qrcode-generator)로 main이 만든 이미지다. 폰 대신 창에 그려진 <img>를 캔버스로 읽어 jsQR(개발용)로 푼다.
// 실행: electron apps/desktop/e2e-dist/shell-pair-e2e.js. 앱 폴더·키체인·네트워크를 쓰지 않는다.
import './os-guard.js'; // 실제 Finder·브라우저·대화상자를 띄우지 않는다(맨 먼저)
import { randomBytes } from 'node:crypto';
import { rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { app, BrowserWindow } from 'electron';

import {
  AIK_PURPOSES,
  b64,
  ed25519Keygen,
  fromB64,
  MemoryRelay,
  MobilePairing,
  sha256Hash,
  signAcctClaim,
  softNoiseStatic,
  softSigner,
  toHex,
  uuid4,
  VD_PURPOSES,
  verifyDeviceList,
  x25519Keygen,
  x25519Public,
  type DesktopKeys,
} from '@sax/remote';
import type { AccountClient, CloudPorts, RelayHttpClient } from '../dist/remote-ports.js';
import { registerShellSchemes, startShell, type Shell } from '../dist/shell-app.js';
import { DEMO_DEV } from '../dist/demo-dev.js';

// jsQR(개발용, devDependencies): CJS라 require로 부른다
const jsQR = createRequire(import.meta.url)('jsqr') as (d: Uint8ClampedArray, w: number, h: number) => { data: string } | null;

registerShellSchemes();
const USER_DATA = path.join(app.getPath('temp'), `sax-e2e-pair-${process.pid}`);
app.setPath('userData', USER_DATA);
process.once('exit', () => rmSync(USER_DATA, { recursive: true, force: true, maxRetries: 2 }));
app.on('window-all-closed', () => {});

const RELAY_HOST = 'relay.sax.test';
const EMAIL = 'owner@gyeonbon-test.example';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const results: Array<{ name: string; ok: boolean; detail?: unknown }> = [];
const check = (name: string, ok: boolean, detail?: unknown) => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : ` ${JSON.stringify(detail)}`}`);
};
let S: Shell | undefined;
const js = <T = unknown>(code: string, w: BrowserWindow = S!.win): Promise<T> => w.webContents.executeJavaScript(code) as Promise<T>;
async function until(what: string, fn: () => Promise<boolean> | boolean, ms = 10_000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return true;
    await sleep(25);
  }
  console.log(`  (timeout: ${what})`);
  return false;
}
async function press(sel: string, w: BrowserWindow = S!.win) {
  w.webContents.sendInputEvent({ type: 'mouseUp', x: 1, y: 1, button: 'left', clickCount: 1 });
  await sleep(30);
  const ok = await js<boolean>(`(() => { const b = document.querySelector(${JSON.stringify(sel)}); if (!b || b.disabled) return false; b.click(); return true; })()`, w);
  if (!ok) throw new Error(`no button ${sel}`);
}
const type = (sel: string, v: string, w: BrowserWindow = S!.win) => js(`(() => { const i = document.querySelector(${JSON.stringify(sel)}); i.value = ${JSON.stringify(v)}; i.dispatchEvent(new Event('input')); })()`, w);

const claimKey = ed25519Keygen();
const relay = new MemoryRelay();
relay.tokenHash = (t) => toHex(sha256Hash(t));

function fakeCloud() {
  const calls: string[] = [];
  let aikPub: string | null = null;
  let deviceList: unknown = null;
  const fail = (code: string) => Object.assign(new Error(code), { code });
  const account: AccountClient = {
    startEmailCode: async () => (calls.push('code'), { loginId: 'L1', expiresInSec: 600 }),
    verifyEmailCode: async (_l, code) => {
      if (code !== '123456') throw fail('account.code_invalid');
      return { session: 'sxs1.fake', expiresInSec: 3600 };
    },
    passwordLogin: async () => {
      throw Object.assign(new Error('account.credentials_invalid'), { code: 'account.credentials_invalid' });
    },
    logout: async () => {},
    me: async () => ({ email: EMAIL, hasPassword: false, reauthUntil: null, authMethod: 'email_code' }),
    setPassword: async () => {
      throw fail('net.not_in_e2e');
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
    startPasswordReset: async () => {
      throw fail('net.not_in_e2e');
    },
    verifyPasswordReset: async () => {
      throw fail('net.not_in_e2e');
    },
    refresh: async () => {
      throw fail('account.unauthorized');
    },
    revokeRefresh: async () => {},
    logoutAll: async () => {
      throw fail('net.not_in_e2e');
    },
    deviceList: async () => ({ aikPub, deviceList: deviceList as never }),
    pinFirstDesktop: async (_s, b) => {
      const l = verifyDeviceList(b.deviceList, fromB64(b.aikPub));
      if (!l.ok) throw fail('account.aik_signature_invalid');
      aikPub = b.aikPub;
      deviceList = b.deviceList;
      return { deviceId: l.devices[0]!.deviceId };
    },
    deviceToken: async () => (calls.push('token'), { token: `sxd1.${'a'.repeat(43)}`, expiresAt: Date.now() + 900_000, scopes: ['devlist'] }),
    acctClaim: async (auth) => {
      const h = await auth('GET', 'https://account.test.invalid/v1/acct-claim');
      calls.push(h.Authorization?.startsWith('DPoP ') ? 'claim' : 'claim_noauth');
      const now = Date.now();
      return JSON.parse(Buffer.from(signAcctClaim(claimKey.secretKey, { account_id: 'acc-1', email: EMAIL, aik_pub: aikPub!, iat: now, exp: now + 600_000 }), 'base64').toString('utf8'));
    },
    enrollPhone: async () => void calls.push('enroll'),
    putDeviceList: async (_a, l) => {
      const v = verifyDeviceList(l, fromB64(aikPub!));
      calls.push(v.ok ? 'devlist' : 'devlist_bad');
      deviceList = l;
    },
  };
  const relayHttp: RelayHttpClient = {
    createRoom: async () => (calls.push('room'), { expiresAt: Date.now() + 120_000 }),
    registerMailbox: async (_a, id, r, w) => {
      calls.push('mailbox');
      relay.registerMailbox(id, toHex(sha256Hash(r)), toHex(sha256Hash(w)));
    },
    deleteMailbox: async () => void calls.push('mailbox_delete'),
  };
  const cloud: CloudPorts = { account, relay: relayHttp, relayHost: RELAY_HOST, insecureLocal: true, openSocket: () => { throw new Error('no sockets in e2e'); } };
  return { cloud, calls };
}

function softKeys(): DesktopKeys {
  const k = () => new Uint8Array(randomBytes(32));
  const kv = k();
  return { noise: softNoiseStatic(k()), vd: softSigner(k(), VD_PURPOSES), aik: softSigner(k(), AIK_PURPOSES), kvPublic: () => x25519Public(kv) };
}

async function main() {
  const { cloud, calls } = fakeCloud();
  S = await startShell({
    dev: DEMO_DEV,
    width: 1280,
    height: 820,
    show: false,
    remote: { cloud, keys: async () => softKeys(), relayClient: relay },
  });
  S.win.webContents.on('console-message', (e) => {
    if (e.level === 'error') console.log(`  [renderer] ${e.message}`);
  });
  await S.ready;
  await until('renderer ready', async () => (await js('document.body.dataset.ready')) === '1');

  // 로그인(첫 PC 등록)
  await js(`document.querySelector('#rail [data-view="settings"]').click()`);
  await until('settings', async () => js<boolean>(`!!document.querySelector('[data-set-tab=devices]')`));
  await js(`document.querySelector('[data-set-tab=devices]').click()`);
  await until('card', async () => js<boolean>(`!!document.querySelector('[data-act=account-login]')`));
  await press('[data-act=account-login]');
  await until('login', async () => js<boolean>(`!!document.querySelector('.acct-email')`));
  await type('.acct-email', EMAIL);
  // 로그인(A-01): 이메일 → [계속] → 비밀번호 화면의 [이메일 코드로 로그인] → 코드 받기 → 6자리(다 넣으면 바로 확인)
  await press('[data-act=account-next]');
  await until('pw', async () => js<boolean>(`!!document.querySelector('[data-act=account-code-login]')`));
  await press('[data-act=account-code-login]');
  await until('code email', async () => js<boolean>(`!!document.querySelector('[data-act=account-send]')`));
  await press('[data-act=account-send]');
  await until('code', async () => js<boolean>(`!!document.querySelector('.acct-code')`));
  await type('.acct-code', '123456');
  check('로그인 끝: 연결된 폰 0대', await until('signed in', async () => js<boolean>(`document.querySelector('[data-account-phones]')?.dataset.accountPhones === '0'`)));

  // [폰 연결] → main 소유 창
  await press('[data-act=pair-open]');
  const pw = () => BrowserWindow.getAllWindows().find((w) => w !== S!.win && w.getTitle() === '폰 연결') ?? null;
  check('폰 연결 창이 따로 뜬다', await until('pair window', () => !!pw()));
  const w = pw()!;
  check('QR 단계(main이 만든 SVG data URL 이미지)', await until('qr', async () => (await js<string>(`document.body.dataset.pair ?? ''`, w)) === 'waiting_phone' && (await js<boolean>(`(() => { const i = document.querySelector('img.qr'); return !!i && i.complete && i.naturalWidth > 0 && i.src.startsWith('data:image/svg+xml;base64,'); })()`, w))));
  check('창에 SVG 요소를 넣지 않는다(이미지로만)', (await js<number>(`document.querySelectorAll('svg').length`, w)) === 0);
  // 폰 카메라 대신: 화면에 그려진 이미지를 캔버스에 옮겨 읽는다
  const px = await js<{ w: number; d: number[] }>(`(() => { const i = document.querySelector('img.qr'); const n = 400; const c = document.createElement('canvas'); c.width = c.height = n; const g = c.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, n, n); g.imageSmoothingEnabled = false; g.drawImage(i, 0, 0, n, n); return { w: n, d: Array.from(g.getImageData(0, 0, n, n).data) }; })()`, w);
  const qrText = jsQR(Uint8ClampedArray.from(px.d), px.w, px.w)?.data ?? null;
  check('그려진 QR을 다시 읽는다', !!qrText && qrText.length > 20);
  check('셸 렌더러에는 QR 글자가 없다', !!qrText && !(await js<string>(`document.documentElement.outerHTML`)).includes(qrText!));
  check('창 페이지에도 QR 글자는 없다(이미지만)', !(await js<string>(`document.documentElement.outerHTML`, w)).includes(qrText!));

  // 폰: QR을 찍고 룸에 들어간다
  const phoneS = x25519Keygen();
  const phone = new MobilePairing({
    keys: { noise: softNoiseStatic(phoneS.secretKey), vmPub: ed25519Keygen().publicKey, kmPub: x25519Keygen().publicKey, deviceId: uuid4(), name: '사장님 폰', platform: 'android' },
    accountKeys: [claimKey.publicKey],
    relayAllowlist: [RELAY_HOST],
    pairOkTimeoutMs: 20_000,
  });
  check('폰이 QR을 읽는다', phone.scan(qrText!), phone.failure);
  const run = phone.run(await relay.joinRoom(phone.roomId, 'mobile'));
  check('6자리 단계(폰 이름)', await until('sas', async () => (await js<string>(`document.body.dataset.pair ?? ''`, w)) === 'awaiting_sas' && (await js<string>(`document.querySelector('[data-pair-phone]')?.textContent ?? ''`, w)) === '사장님 폰'));
  await type('#sas', phone.sas === '000000' ? '111111' : '000000', w);
  await press('[data-act=pair-submit]', w);
  check('틀린 6자리: 남은 횟수', await until('wrong', async () => (await js<string>(`document.querySelector('[data-pair-error]')?.dataset.pairError ?? ''`, w)) === 'pair.sas_wrong' && (await js<string>(`document.querySelector('[data-pair-error]').textContent`, w)).includes('2번 남음')));
  await type('#sas', phone.sas!, w);
  await press('[data-act=pair-submit]', w);
  check('연결했어요', await until('paired', async () => (await js<string>(`document.body.dataset.pair ?? ''`, w)) === 'paired'));
  const m = await run;
  check('폰: 계정 서비스 서명 acctClaim 검증 → 저장 전 확인 화면에 계정 이메일', m?.identity.account.email === EMAIL, phone.failure);
  check('폰: 같은 AIK', !!m && b64(m.aikPub) === (await import('node:fs')).readFileSync(path.join(S.fixture!.root, 'userData', 'remote-identity.json'), 'utf8').match(/"aikPub":"([^"]+)"/)![1]);
  check('PC 7단계 순서(룸 → 대리 등록 → 목록 → 우편함 → acctClaim)', JSON.stringify(calls.filter((c) => c !== 'token')) === JSON.stringify(['code', 'room', 'enroll', 'devlist', 'mailbox', 'claim']), calls);
  check('셸 계정 줄: 연결된 폰 1대', await until('phones 1', async () => js<boolean>(`document.querySelector('[data-account-phones]')?.dataset.accountPhones === '1'`)));
  await press('[data-act=pair-close]', w);
  check('창 닫기', await until('closed', () => !pw()));
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
