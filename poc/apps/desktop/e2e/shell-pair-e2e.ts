// 폰 연결 e2e(S-03, remote-pairing.ts·pair-window.ts): 로그인 → 설정 > 기기 연결 [폰 연결] → main 소유 창(QR, 화면 캡처 차단) → 폰(MobilePairing)이 찍고
// 폰의 6자리를 그 창에 넣는다 → 폰이 계정 서비스 서명 acctClaim을 검증한다. 계정·릴레이는 메모리 가짜, 금고 키는 소프트 키.
// 실행: electron apps/desktop/e2e-dist/shell-pair-e2e.js. 앱 폴더·키체인·네트워크를 쓰지 않는다.
import { randomBytes } from 'node:crypto';
import { rmSync } from 'node:fs';
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
    logout: async () => {},
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
  let qrText: string | null = null;
  S = await startShell({
    dev: DEMO_DEV,
    width: 1280,
    height: 820,
    show: false,
    remote: { cloud, keys: async () => softKeys(), qr: (t) => ((qrText = t), Array.from({ length: 21 }, (_, y) => Array.from({ length: 21 }, (_, x) => (x + y) % 3 === 0))), relayClient: relay },
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
  await press('[data-act=account-send]');
  await until('code', async () => js<boolean>(`!!document.querySelector('.acct-code')`));
  await type('.acct-code', '123456');
  await press('[data-act=account-verify]');
  check('로그인 끝: 연결된 폰 0대', await until('signed in', async () => js<boolean>(`document.querySelector('[data-account-phones]')?.dataset.accountPhones === '0'`)));

  // [폰 연결] → main 소유 창
  await press('[data-act=pair-open]');
  const pw = () => BrowserWindow.getAllWindows().find((w) => w !== S!.win && w.getTitle() === '폰 연결') ?? null;
  check('폰 연결 창이 따로 뜬다', await until('pair window', () => !!pw()));
  const w = pw()!;
  check('QR 단계(칸 행렬로 그린 SVG)', await until('qr', async () => (await js<string>(`document.body.dataset.pair ?? ''`, w)) === 'waiting_phone' && (await js<number>(`document.querySelectorAll('svg.qr rect').length`, w)) > 50));
  check('셸 렌더러에는 QR 글자가 없다', !!qrText && !(await js<string>(`document.documentElement.outerHTML`)).includes(qrText!));
  check('창 페이지에도 QR 글자는 없다(칸만)', !(await js<string>(`document.documentElement.outerHTML`, w)).includes(qrText!));

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
