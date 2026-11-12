// H-01 사람 속도 리허설 e2e(수동 실행, CI 아님, 부장 지시 2026-11-11). 제품 화면·main 처리기·실제 엔진으로 가짜 홈택스에서 발급을 끝까지 밟는다.
// 동작 사이에 사람처럼 쉬고(SAX_REH_PACE ms, 기본 6000), 값은 붙여 넣고(insertText: 키 입력 없음), 클릭은 버튼 자리의 실제 마우스 입력으로 한다.
// 제품 경로와 다른 점(정직하게): 금고는 OS 키체인 대신 시험 정책 금고(127.0.0.1만, 임시 루트의 파일 키), 홈택스 대신 가짜 H-01 페이지(로그인 없음),
// 계정은 localhost 메모리 가짜, 모델 해석은 엔진 대신 대역(세금계산서 문장 → H-01, 나머지 unknown). 견본 사업장·거래처·서류는 넣지 않는다(빈 DB에서 온보딩).
// 실제 홈택스·정부24·운영 서버에 닿지 않는다. 사용자 앱 폴더·키체인을 쓰지 않는다.
// 찾은 문제는 REPRO 줄로 남긴다(재현되면 REPRO, 고쳐졌으면 FIXED). 하네스가 깨지면(FAIL) 끝 코드 1.
// 실행: electron apps/desktop/e2e-dist/shell-rehearsal-e2e.js
//   SAX_REH_PHASE=main(기본): 온보딩 → 거래처 → 되묻기 → 카드 → 실행 → 승인 → 발급 → 보관함 → 틀리기 → 승인 대기에서 앱을 끈다(정리 없이 끝)
//   SAX_REH_PHASE=restart SAX_REH_ROOT=<main이 찍은 루트>: 같은 루트로 다시 켜서 재시작 뒤 상태를 본다(끝나면 루트를 지운다)
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { app } from 'electron';
import { FileEventLog, prepareLayout } from '@sax/platform';
import { Egress } from '@sax/net';
import { RELAY_DENIED_METHODS, RELAY_DOMAIN_METHOD_ALLOWLIST, Vault, type KeyStore } from '@sax/vault';
import { CONSENT_CONFIG } from '../dist/onboarding.js';
import { cloudPorts } from '../dist/remote-cloud.js';
import { emptyDocStore, QUICK, REMINDER_DAY_DEFAULT } from '../dist/shell-model.js';
import { startH01Fixture } from '../dist/h01-fixture.js';
import { DEMO_DEV } from '../dist/demo-dev.js';
import type { IntentResolver } from '../dist/intent-route.js';
import type { ChatResponder } from '../dist/chat-reply.js';
import type { FixtureMode } from '../dist/fixture-mode.js';
import { registerShellSchemes, startShell, type Shell, type ShellDev } from '../dist/shell-app.js';
import { serveAccount } from './fake-account-http.js';
import { fakeAccount, PASSWORD, softKeys } from './fake-account.js';

registerShellSchemes();
app.on('window-all-closed', () => {});

const PHASE = process.env.SAX_REH_PHASE === 'restart' ? 'restart' : 'main';
const PACE = Number(process.env.SAX_REH_PACE ?? 6000);
const ROOT = process.env.SAX_REH_ROOT ?? mkdtempSync(path.join(realpathSync(os.tmpdir()), 'sax-rehearsal-'));
if (PHASE === 'restart') process.once('exit', () => rmSync(ROOT, { recursive: true, force: true, maxRetries: 2 }));
// 정리 없이 끈 실행 Chrome(임시 루트 프로필)이 남지 않게 끝날 때 그 루트를 쓰는 프로세스만 끈다.
else process.once('exit', () => spawnSync('pkill', ['-f', path.join(ROOT, '')]));

/** 가상 사업자(체크섬만 맞는 값). 가짜 페이지의 공급자와 같아야 s19c가 지난다. */
const ME = { bizNo: '1234567891', bizNoText: '123-45-67891', name: '가나다컴퍼니' };
/** 가짜 사업자 조회 대장. 등록증으로 채우는 거래처(견본상사)와 직접 넣는 거래처(A상사). */
const CERT_CP = { name: '견본상사', bizNo: '3148601237', rep: '이견본', bizType: '도매', bizItem: '사무용품', address: '서울특별시 견본구 시험로 34', email: '' };
const TYPED_CP = { name: 'A상사', bizNo: '2148651233', bizNoText: '214-86-51233', email: 'tax@asangsa.example', item: '경영 컨설팅' };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** 사람이 화면을 읽고 다음 동작을 고르는 시간. */
const human = (k = 1) => sleep(Math.round(PACE * k));
const results: Array<{ name: string; ok: boolean; detail?: unknown }> = [];
const check = (name: string, ok: boolean, detail?: unknown) => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : ` ${JSON.stringify(detail)}`}`);
};
const repros: Array<{ id: string; reproduced: boolean; detail?: unknown }> = [];
/** 찾은 문제 재현. reproduced = 문제가 지금도 보인다. */
const repro = (id: string, reproduced: boolean, detail?: unknown) => {
  repros.push({ id, reproduced, detail });
  console.log(`${reproduced ? 'REPRO' : 'FIXED'} ${id}${detail === undefined ? '' : ` ${JSON.stringify(detail)}`}`);
};
/** 화면에서 본 문구(보고서 근거). */
const seen: Array<{ at: string; text: string }> = [];

let S: Shell | undefined;
const wc = () => S!.win.webContents;
const js = <T = unknown>(code: string): Promise<T> => wc().executeJavaScript(code) as Promise<T>;
async function until(what: string, fn: () => Promise<boolean> | boolean, ms = 20_000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await Promise.resolve(fn()).catch(() => false)) return true;
    await sleep(100);
  }
  console.log(`  (timeout: ${what})`);
  return false;
}

/**
 * 사람 클릭: 버튼 가운데에 실제 마우스 입력(mouseDown·mouseUp). 숨은 창이라 입력이 DOM 클릭이 되지 않으면 같은 순간에 DOM 클릭을 대신 낸다
 * (main이 본 실제 입력 시각은 mouseUp 그대로라 결속 판정은 사람 클릭과 같다).
 */
async function tap(sel: string): Promise<void> {
  if (sel.includes('[data-act=prepare]')) prepareCount++;
  const r = await js<{ x: number; y: number } | null>(`(() => { const b = [...document.querySelectorAll(${JSON.stringify(sel)})].filter((x) => x.offsetParent !== null || x.getClientRects().length).pop(); if (!b || b.disabled) return null; b.scrollIntoView({ block: 'center' }); const r = b.getBoundingClientRect(); window.__tapped = 0; b.addEventListener('click', () => (window.__tapped = 1), { once: true }); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; })()`);
  if (!r) throw new Error(`no button ${sel}`);
  wc().sendInputEvent({ type: 'mouseDown', x: r.x, y: r.y, button: 'left', clickCount: 1 });
  wc().sendInputEvent({ type: 'mouseUp', x: r.x, y: r.y, button: 'left', clickCount: 1 });
  await sleep(60);
  if (!(await js<number>('window.__tapped'))) {
    wc().sendInputEvent({ type: 'mouseUp', x: 1, y: 1, button: 'left', clickCount: 1 });
    await sleep(20);
    await js(`[...document.querySelectorAll(${JSON.stringify(sel)})].filter((x) => !x.disabled).pop()?.click()`);
  }
}
/** 붙여 넣기: 칸에 초점을 두고 글자를 한 번에 넣는다(키 입력 사건 없음, IME 확정·⌘V 메뉴와 같다). */
async function paste(sel: string, text: string, clear = true): Promise<void> {
  const ok = await js<boolean>(`(() => { const i = [...document.querySelectorAll(${JSON.stringify(sel)})].pop(); if (!i) return false; i.focus(); if (${clear}) { i.select?.(); } return true; })()`);
  if (!ok) throw new Error(`no field ${sel}`);
  wc().insertText(text);
  await sleep(50);
}
/** 수식키 없는 Enter(지금 초점 칸에서). */
async function enter(): Promise<void> {
  wc().sendInputEvent({ type: 'keyDown', keyCode: 'Enter' });
  wc().sendInputEvent({ type: 'char', keyCode: '\r' });
  wc().sendInputEvent({ type: 'keyUp', keyCode: 'Enter' });
  await sleep(80);
}
const lastApp = () => js<string>(`[...document.querySelectorAll('.sx-thread .sx-app')].pop()?.textContent ?? ''`);
const toast = () => js<string>(`(() => { const t = document.getElementById('toast'); return t && !t.hidden ? t.textContent : ''; })()`);
const onbStep = () => js<string | null>(`[...document.querySelectorAll('[data-onb-step]')].pop()?.dataset.onbStep ?? null`);
const acctScreen = () => js<string | null>(`document.querySelector('[data-acct-screen]')?.dataset.acctScreen ?? null`);
const lastRunId = () => js<string | null>(`[...document.querySelectorAll('[data-run]')].pop()?.dataset.run ?? null`);
const runStatus = (id: string) => S!.runs.get(id)?.status;
const cardText = (id: string) => js<string>(`document.querySelector('[data-run="${id}"]')?.innerText ?? ''`);
/** 화면 문구를 남기고, 내부 코드·영어 식별자·빈 값 글자를 찾는다. */
const CODE_RE = /\b[a-z]+(?:[._][a-z0-9]+)+\b|\bnull\b|\bundefined\b|\bNaN\b|\[object/g;
const ALLOWED = new Set(['asangsa.example', 'gyeonbon-test.example', 'tax@asangsa.example']);
async function look(at: string, sel = '#app'): Promise<string[]> {
  const text = await js<string>(`document.querySelector(${JSON.stringify(sel)})?.innerText ?? ''`);
  seen.push({ at, text: text.slice(-1500) });
  return [...new Set(text.match(CODE_RE) ?? [])].filter((m) => !ALLOWED.has(m) && !/\.example$/.test(m) && !/^\d/.test(m));
}

// ---- 하네스: 영속 루트 위 시험 정책 금고 + 가짜 H-01 페이지 ----

/** 임시 루트의 파일 키(재시작 뒤에도 같은 DB 키). OS 키체인을 쓰지 않는다. */
class FileKeyStore implements KeyStore {
  private readonly file: string;
  constructor(file: string) {
    this.file = file;
  }
  private load(): Record<string, string> {
    return existsSync(this.file) ? (JSON.parse(readFileSync(this.file, 'utf8')) as Record<string, string>) : {};
  }
  async get(name: string, bytes: number): Promise<Uint8Array | null> {
    const v = this.load()[name];
    if (!v) return null;
    const k = Buffer.from(v, 'hex');
    if (k.length !== bytes) throw new Error('vault.keystore_mismatch');
    return new Uint8Array(k);
  }
  async create(name: string, bytes: number): Promise<Uint8Array> {
    const k = randomBytes(bytes);
    writeFileSync(this.file, JSON.stringify({ ...this.load(), [name]: k.toString('hex') }), { mode: 0o600 });
    return new Uint8Array(k);
  }
}

let fx: Awaited<ReturnType<typeof startH01Fixture>> | undefined;
async function rehearsalFixture(): Promise<FixtureMode> {
  const { paths } = await prepareLayout(ROOT);
  const vault = new Vault({
    paths,
    log: new FileEventLog(paths.logs, 'vault'),
    keyStore: new FileKeyStore(path.join(ROOT, 'e2e-keys.json')),
    policy: {
      allowedHosts: ['127.0.0.1'],
      secretHosts: { cert_password: ['127.0.0.1'], portal_password: ['127.0.0.1'], security_card: ['127.0.0.1'] },
      domainMethods: RELAY_DOMAIN_METHOD_ALLOWLIST,
      deniedMethods: RELAY_DENIED_METHODS,
      keyDelayMs: 5,
      typistInput: 'insertText',
    },
    testChromeArgs: ['--headless=new', '--use-mock-keychain'],
  });
  fx = await startH01Fixture({ registry: { [CERT_CP.bizNo]: CERT_CP.name, [TYPED_CP.bizNo]: TYPED_CP.name }, supplier: { bizNo: ME.bizNo, name: ME.name } });
  return {
    root: ROOT,
    vault,
    portal: { kind: 'fixture', origin: fx.origin },
    fixture: fx,
    itemHints: {},
    // 견본 사업장·거래처를 넣지 않는다(빈 DB에서 온보딩, 제품과 같다)
    seed: async () => {},
    async close() {
      await vault.shutdown().catch(() => {});
      await fx!.close();
    },
  };
}

/** 제품과 같은 빈 자리: 견본 서류·대화·꾸러미 없음. 온보딩 바깥 일은 제품 어댑터와 같은 답(진위확인 조회 불가, 금고 등록 창 없음). */
const DEV: ShellDev = {
  ...DEMO_DEV,
  startFixture: rehearsalFixture,
  sample: {
    store: emptyDocStore,
    profiles: { business: { kind: 'business', name: '내 사업장', email: '', auth: '' }, personal: { kind: 'personal', name: '개인', email: '', auth: '' } },
    timeline: () => [],
    quick: QUICK.filter((q) => q.label === '세금계산서 발급' || q.soon),
    bundle: () => null as never,
    settings: { reminderDay: REMINDER_DAY_DEFAULT, cardFetchedOn: null },
    g24Candidates: () => [],
    onboarding: () => ({
      recognizeBizCert: async () => ({ ...CERT_CP, bizNo: ME.bizNo, name: ME.name, email: '' }),
      checkBizNo: async () => ({ status: 'unknown', label: '조회하지 못했어요', taxType: null, source: '국세청 조회' }),
      registerSecrets: async () => ({ ok: false, reason: 'unavailable' }),
      consentConfig: async () => structuredClone(CONSENT_CONFIG),
      findCerts: async () => [],
    }),
    cpCert: { ...CERT_CP },
  },
};

/** 모델 해석 대역: 엔진 L0·모델처럼 세금계산서 문장은 H-01로, 나머지는 unknown. offline이면 게이트웨이에 닿지 못한 것(decide.unavailable). */
let offline = false;
const intent: IntentResolver = {
  resolve: async (t) => {
    if (offline) return { route: null, fallback: 'decide.unavailable' };
    return /계산서/.test(t) ? { route: { outcome: 'route', playbook: 'hometax.invoice.issue', adviceMentioned: false, via: 'model' }, fallback: null } : { route: { outcome: 'unknown', via: 'model' }, fallback: null };
  },
};
const chat: ChatResponder = { respond: async () => (offline ? { error: 'chat.unavailable' } : { reply: { reply: '세금계산서나 증명서를 말해 주세요.', suggest: [], filtered: null } }) } as ChatResponder;

// ---- 승인 카드(main 소유 뷰) 입력 ----
const barWc = () => S!.bar.view.webContents;
const barCenter = (k: 'approve' | 'stop') => {
  const t = S!.bar.snapshot().targets[k];
  return { x: Math.floor(t.x + t.width / 2), y: Math.floor(t.y + t.height / 2) };
};
function barClick(k: 'approve' | 'stop'): void {
  const p = barCenter(k);
  barWc().sendInputEvent({ type: 'mouseEnter', x: p.x, y: p.y });
  barWc().sendInputEvent({ type: 'mouseMove', x: p.x, y: p.y, movementX: 3, movementY: 1 });
  barWc().sendInputEvent({ type: 'mouseDown', x: p.x, y: p.y, button: 'left', clickCount: 1 });
  barWc().sendInputEvent({ type: 'mouseUp', x: p.x, y: p.y, button: 'left', clickCount: 1 });
}
let prepareCount = 0;
const armed = () => S!.bar.snapshot().visible && S!.bar.snapshot().armed && S!.bar.snapshot().committed?.mode === 'armed';

async function say(text: string): Promise<void> {
  await paste('#composer', text);
  await human(0.5);
  await enter();
}

async function boot(onboarding: boolean): Promise<void> {
  const front = await serveAccount(fakeAccount().client);
  const keys = softKeys();
  const remote = { cloud: cloudPorts({ egress: new Egress({ cloudDevLocal: true }), env: 'dev', dev: { accountOrigin: front.origin, relayHost: '127.0.0.1:9' } }), keys: async () => keys };
  S = await startShell({ dev: DEV, remote, intent, chat, show: false, daemon: false, onboarding, demoSeed: false });
  await S.ready;
  await until('renderer ready', async () => (await js('document.body.dataset.ready')) === '1', 60_000);
}

// ---- 1부: 처음 켜서 발급까지 ----
async function mainPhase(): Promise<void> {
  console.log(`root ${ROOT}`);
  await boot(true);
  check('빈 DB: 온보딩부터(약관 카드)', await until('terms', async () => js<boolean>(`!!document.querySelector('[data-consent]')`)));
  await human();
  await tap('[data-onb=agree]');
  // fixture 모드는 로그인을 요구하지 않는다(loginRequired = 엔진 모드). 로그인 화면은 shell-product-e2e(SAX_E2E_PRODUCT=login)가 본다.
  if (await until('login', async () => (await acctScreen()) === 'email', 3_000)) {
    await human();
    await paste('.acct-email', 'owner@gyeonbon-test.example');
    await human(0.5);
    await enter();
    const pwShown = await until('pw', async () => (await acctScreen()) === 'password', 8_000);
    check('이메일 칸에서 Enter → 비밀번호 화면', pwShown, await acctScreen());
    if (!pwShown) await tap('[data-act=account-next]');
    await human();
    await paste('.acct-password', PASSWORD);
    await human(0.5);
    await enter();
    const signedIn = await until('signed in', async () => (await acctScreen()) === null, 15_000);
    check('비밀번호 칸에서 Enter → 로그인', signedIn, { screen: await acctScreen(), toast: await toast() });
    if (!signedIn) await tap('[data-act=account-password]');
  } else console.log('  (fixture: 로그인 화면 없음, 로그인은 shell-product-e2e가 본다)');
  check('O-01 환영', await until('welcome', async () => (await onbStep()) === 'welcome'), await onbStep());
  console.log('  look(login):', await look('login'));

  // O-02 사업자: 번호를 붙여 넣고 한참 뒤 Enter
  await human();
  await tap('[data-onb=number]');
  await until('biz-number', async () => (await onbStep()) === 'biz-number');
  await paste('[data-onb-step=biz-number] input', ME.bizNoText);
  await human(1.5);
  await enter();
  check('번호 붙여 넣고 9초 뒤 Enter → O-02 확인 카드', await until('biz-confirm', async () => (await onbStep()) === 'biz-confirm'), { step: await onbStep(), toast: await toast() });
  await human();
  await tap('[data-onb=edit]');
  await until('edit form', async () => js<boolean>(`!!document.querySelector('[data-onb-step=biz-confirm] form [name=name]')`));
  await paste('[data-onb-step=biz-confirm] form [name=name]', ME.name);
  await human();
  await tap('[data-onb=save]');
  await until('confirm unverified', async () => js<boolean>(`!![...document.querySelectorAll('[data-onb=confirm-unverified]')].pop()`));
  console.log('  look(biz-confirm):', await look('biz-confirm', '[data-onboarding]'));
  await human();
  await tap('[data-onb=confirm-unverified]');
  check('[맞습니다] → O-03 발급 인증', await until('auth', async () => (await onbStep()) === 'auth'));
  await human();
  await tap('[data-onb=simple]');
  check('간편인증 → ② 모델 동의', await until('model', async () => (await onbStep()) === 'model'), await onbStep());
  await human(1.5);
  await tap('[data-onb=agree]');
  await until('telemetry', async () => (await onbStep()) === 'telemetry');
  await human(0.5);
  await tap('[data-onb=off]');
  await until('tasks', async () => (await onbStep()) === 'tasks');
  await human(0.5);
  await tap('[data-task="H-01"]');
  await human(0.5);
  await tap('[data-onb=submit]');
  check('할 일(세금계산서) → O-05 거래처', await until('counterparties', async () => (await onbStep()) === 'counterparties'), await onbStep());
  console.log('  look(counterparties):', await look('onb-counterparties', '[data-onboarding]'));
  // O-05를 [나중에]로 건너뛴다(거래처 없이 끝낸다)
  await human();
  await tap('[data-onb=later]');
  await until('summary', async () => (await onbStep()) === 'summary');
  console.log('  look(summary):', await look('onb-summary', '[data-onboarding]'));
  await human();
  await tap('[data-onb=ok]');
  await until('first', async () => (await onbStep()) === 'first');
  await human();
  await tap('[data-onb=invoice]');
  await until('onb done', async () => js<boolean>(`!document.querySelector('[data-onb-step]')`));
  const filled = await js<string>(`document.querySelector('#composer').value`);
  check('[세금계산서 1건 발급] → 입력창에 "세금계산서 "가 채워진다(보내지 않음)', filled.startsWith('세금계산서'), filled);
  // 거래처 없이 발급 요청: 되묻기에 후보가 없고, 장부에 없는 이름으로 답하면?
  await human();
  await paste('#composer', '세금계산서 발급해 줘');
  await human(0.5);
  await enter();
  await until('ask cp 0', async () => /어느 거래처|거래처를 추가/.test(await lastApp()), 8_000);
  const noCpAsk = await lastApp();
  const chips0 = await js<number>(`document.querySelectorAll('#quick [data-fill]').length`);
  repro('F-no-cp-ask: 거래처가 하나도 없는데 "어느 거래처에 발급할까요?"만 묻고 거래처를 추가하라는 말·버튼이 없다', chips0 === 0 && !/추가|등록/.test(noCpAsk), { noCpAsk, chips0 });
  await human();
  await say('인스피릿');
  await sleep(1500);
  const unknownCp = await lastApp();
  repro('F-unknown-cp-answer: 장부에 없는 거래처 이름으로 답하면 되묻기가 끊기고 일반 응대로 간다(거래처를 추가하라는 안내 없음)', !/추가|등록|장부에 없/.test(unknownCp), unknownCp);
  seen.push({ at: 'unknown-cp', text: unknownCp });
  const todo = await js<string>(`document.querySelector('[data-board]')?.innerText ?? ''`);
  seen.push({ at: 'board-after-onb', text: todo });

  // 거래처 화면: 등록증으로 채우기(품목 없음) + 직접 입력(마지막 칸 Enter)
  await human();
  await tap('#rail [data-view=cps]');
  await until('cps view', async () => js<boolean>(`!!document.querySelector('[data-act=cp-add]')`));
  await human();
  await tap('[data-act=cp-add]');
  await until('cp form', async () => js<boolean>(`!!document.querySelector('[data-panel-cp-edit] form')`));
  await human(0.5);
  await tap('[data-act=cp-cert]');
  await until('cert filled', async () => (await js<string>(`document.querySelector('[data-panel-cp-edit] [name=name]').value`)) === CERT_CP.name, 8_000);
  const certForm = await js<Record<string, string>>(`Object.fromEntries([...document.querySelectorAll('[data-panel-cp-edit] input')].map((i) => [i.name, i.value]))`);
  repro('F-cp-cert-item: 등록증으로 채워도 저장 품목·이메일은 빈 칸(등록증의 종목도 품목 후보로 오지 않는다)', !certForm.item && !certForm.email, certForm);
  // 종목 후보(F-15)를 지우고 추가한다: 저장 품목 없는 거래처로 F-01 경로(품목 되묻기)를 본다
  if (certForm.item) {
    await human(0.5);
    await js(`(() => { const i = document.querySelector('[data-panel-cp-edit] [name=item]'); i.value = ''; i.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  }
  await human(1.5);
  await tap('[data-act=cp-save]');
  check('등록증 거래처 추가(품목 비움)', await until('cp saved', async () => S!.runs.counterparties.some((c) => c.bizNo === CERT_CP.bizNo)), await toast());
  await human();
  await tap('[data-act=cp-add]');
  await until('cp form 2', async () => js<boolean>(`!!document.querySelector('[data-panel-cp-edit=new] form')`));
  for (const [k, v] of [['name', TYPED_CP.name], ['bizNo', TYPED_CP.bizNoText], ['email', TYPED_CP.email], ['item', TYPED_CP.item]] as const) {
    await paste(`[data-panel-cp-edit=new] [name=${k}]`, v);
    await human(0.3);
  }
  await human();
  await enter();
  check('직접 입력 거래처: 마지막 칸에서 Enter → 추가', await until('cp saved 2', async () => S!.runs.counterparties.some((c) => c.bizNo === TYPED_CP.bizNo), 8_000), await toast());
  await human();
  await tap('#rail [data-view=chat]');
  await sleep(300);

  // 되묻기: "세금계산서 발급해 줘" → 거래처 칩 → 금액
  await human();
  await say('세금계산서 발급해 줘');
  check('되묻기: 어느 거래처', await until('ask cp', async () => (await lastApp()).includes('어느 거래처')), await lastApp());
  await human();
  await tap(`#quick [data-fill="${CERT_CP.name}"]`);
  await human(0.5);
  await enter();
  check('거래처 칩 → Enter → 금액 되묻기', await until('ask amount', async () => (await lastApp()).includes('얼마를')), await lastApp());
  await human();
  const before = await lastRunId();
  await say('55만원');
  // F-01 고친 뒤: 저장 품목이 없으면 카드 전에 품목을 묻는다 → 답하면 그 품목으로 카드
  const askedItem = await until('ask item', async () => (await lastApp()).includes('어떤 품목으로'), 5_000);
  if (askedItem) {
    seen.push({ at: 'ask-item', text: await lastApp() });
    await human();
    await say('사무용품');
  }
  check('금액 → (품목 되묻기 →) 확인 카드', await until('draft', async () => !!(await lastRunId()) && (await lastRunId()) !== before));
  const idNoItem = (await lastRunId())!;
  const noItemCard = await cardText(idNoItem);
  console.log('  look(card no item):', await look('card-no-item', `[data-run="${idNoItem}"]`));
  repro('F-item-empty-card: 품목 없는 거래처면 카드 품목이 빈 칸인데 카드에서 품목을 고칠 길이 없다', S!.runs.get(idNoItem)?.item === '' && !/품목 (수정|고치기)|품목·이메일 고치기/.test(noItemCard), noItemCard.slice(0, 300));
  // 카드에서 금액 고치기(붙여 넣고 Enter)
  await human();
  await tap(`[data-run="${idNoItem}"] button:not([data-act])`);
  const editing = await until('amount edit', async () => js<boolean>(`!!document.querySelector('[data-run="${idNoItem}"] input')`), 5_000);
  if (editing) {
    await paste(`[data-run="${idNoItem}"] input`, '60만원');
    await human(0.5);
    await enter();
    check('카드 금액 수정: "60만원" → 공급가 600,000', await until('amount', () => S!.runs.get(idNoItem)?.supply === 600_000, 5_000), S!.runs.get(idNoItem));
  } else check('카드에 [금액 수정]이 있다', false);
  // 카드를 10초 읽고 [홈택스에서 준비]
  await human(1.7);
  await tap(`[data-run="${idNoItem}"] [data-act=prepare]`);
  await until('ended', () => !['draft', 'preparing'].includes(runStatus(idNoItem) ?? 'draft'), 20_000);
  const itemEnd = await cardText(idNoItem);
  console.log('  look(item_missing):', await look('card-item-missing', `[data-run="${idNoItem}"]`));
  repro('F-item-missing-block: 품목 없는 거래처는 [홈택스에서 준비]가 "품목이 비어 있어 시작하지 않았어요"로 끝나고 다음 할 일(거래처에서 품목 넣기)·버튼이 없다', /품목이 비어/.test(itemEnd) && !/거래처|저장 품목/.test(itemEnd.replace(CERT_CP.name, '')), { status: runStatus(idNoItem), text: itemEnd.slice(0, 300), posts: fx!.posts() });
  // 고친 뒤에는 답한 품목으로 승인 대기까지 간다: 처음 쓴 품목이 저장 품목으로 남았는지 보고 승인 카드 [중지](발급 없음)
  if (runStatus(idNoItem) === 'waiting') {
    check('답한 품목으로 승인 대기, 처음 쓴 품목은 그 거래처의 저장 품목으로', await until('item kept', () => S!.runs.counterparties.find((c) => c.bizNo === CERT_CP.bizNo)?.item === '사무용품', 5_000), S!.runs.get(idNoItem)?.notices);
    await until('armed item', () => armed(), 10_000);
    await human();
    barClick('stop');
    check('승인 카드 [중지] → 발급 없음', await until('stopped item', () => runStatus(idNoItem) === 'stopped' && !S!.bar.snapshot().visible, 10_000) && fx!.posts() === 0, { status: runStatus(idNoItem), posts: fx!.posts() });
  }

  // 거래처에 품목을 넣고 다시
  await human();
  await tap('#rail [data-view=cps]');
  await until('cps', async () => js<boolean>(`!!document.querySelector('[data-cp-row]')`));
  const certId = S!.runs.counterparties.find((c) => c.bizNo === CERT_CP.bizNo)!.id;
  await tap(`[data-cp-row="${certId}"]`);
  await human(0.5);
  await tap('[data-act=cp-edit]');
  await until('cp edit', async () => js<boolean>(`!!document.querySelector('[data-panel-cp-edit="${certId}"] [name=item]')`));
  await paste(`[data-panel-cp-edit="${certId}"] [name=item]`, '사무용품');
  await human();
  await tap('[data-act=cp-save]');
  await until('item saved', () => S!.runs.counterparties.find((c) => c.id === certId)?.item === '사무용품', 8_000);
  await human();
  await tap('#rail [data-view=chat]');
  await human(0.5);
  const id1 = await draftOf(`${CERT_CP.name}에 55만원 세금계산서`);
  await human(1.7);
  await tap(`[data-run="${id1}"] [data-act=prepare]`);
  check('[홈택스에서 준비] → 준비 중', await until('preparing', () => ['preparing', 'waiting'].includes(runStatus(id1) ?? ''), 5_000), { status: runStatus(id1), toast: await toast() });
  console.log('  look(preparing):', await look('card-preparing', `[data-run="${id1}"]`));
  check('승인 대기 + 승인 카드', await until('waiting', () => runStatus(id1) === 'waiting' && armed(), 30_000), { status: runStatus(id1), bar: S!.bar.snapshot().visible });
  const barText = await barWc().executeJavaScript('document.body.innerText').catch(() => '') as string;
  seen.push({ at: 'approval-card', text: barText });
  console.log('  approval card:', barText.replace(/\s+/g, ' ').slice(0, 300));
  // 홈택스 Chrome에서 채운 칸을 8초 보고 돌아와 승인(창 활성화 뒤 클릭)
  await human(1.4);
  S!.win.emit('blur');
  await human(0.5);
  S!.win.emit('focus');
  await sleep(400);
  barClick('approve');
  check('승인 → 발급 → 발급 확인', await until('done', () => runStatus(id1) === 'done', 40_000), { status: runStatus(id1), card: await cardText(id1) });
  const doneText = await cardText(id1);
  console.log('  look(done):', await look('card-done', `[data-run="${id1}"]`));
  check('가짜 페이지 발급 1건, 승인번호가 카드에 보인다', fx!.posts() === 1 && !!fx!.issued.at(-1) && doneText.includes(fx!.issued.at(-1)!.approvalNo), { posts: fx!.posts(), doneText: doneText.slice(0, 300) });
  // 보관함·활동 기록
  await human();
  await tap('#rail [data-view=docs]');
  await sleep(500);
  const docsText = await js<string>(`document.querySelector('#center')?.innerText ?? ''`);
  seen.push({ at: 'docs', text: docsText.slice(0, 1200) });
  check('보관함에 세금계산서 줄', docsText.includes(`세금계산서 · ${CERT_CP.name}`), docsText.slice(0, 300));
  const docRow = await js<string | null>(`document.querySelector('[data-doc-row="d-${id1}"]') ? 'yes' : null`);
  if (docRow) {
    await tap(`[data-doc-row="d-${id1}"]`);
    await sleep(300);
    const panel = await js<string>(`document.querySelector('#panel')?.innerText ?? ''`);
    seen.push({ at: 'doc-panel', text: panel });
    await human(0.5);
    // F-04(화면): PDF가 이 PC에 없으면 [열기]를 두지 않고 홈택스 발급목록 안내만 둔다. [열기]가 있으면 눌러 본다.
    const hasOpen = await js<boolean>(`!!document.querySelector('#panel [data-act=doc-open]')`);
    let openToast = '';
    if (hasOpen) {
      await tap('#panel [data-act=doc-open]');
      await sleep(800);
      openToast = await toast();
    }
    repro('F-invoice-open: 앱이 발급한 세금계산서 [열기]를 누르면 PDF가 없어 열리지 않는다(발급 PDF 보관 없음)', hasOpen && /없|못/.test(openToast), hasOpen ? openToast : panel.slice(0, 300));
    await human(0.5);
    await js(`[...document.querySelectorAll('#panel button')].find((b) => b.textContent === '메일로 보내기')?.click()`);
    await sleep(300);
    const mailToast = await toast();
    repro('F-mock-text: 보관함 [메일로 보내기]가 설치본에서 "목업: 메일을 보내지 않아요"를 보인다(개발 용어)', /목업/.test(mailToast), mailToast);
  }
  await human(0.5);
  await tap('#rail [data-view=activity]');
  await sleep(500);
  const actText = await js<string>(`document.querySelector('#center')?.innerText ?? ''`);
  seen.push({ at: 'activity', text: actText.slice(0, 1500) });
  console.log('  look(activity):', await look('activity', '#center'));
  check('활동 기록에 발급이 보인다', /세금계산서/.test(actText) && actText.includes(CERT_CP.name), actText.slice(0, 400));

  // 같은 요청 두 번: 중복 경고 → 승인 카드 [중지](거절)
  await human();
  await tap('#rail [data-view=chat]');
  const id2 = await draftOf(`${CERT_CP.name}에 55만원 세금계산서`);
  const dupDraft = await cardText(id2);
  repro('F-dup-draft: 같은 건을 방금 발급했는데 확인 카드(초안)에는 중복 표시가 없다(승인 카드에서야 보인다)', !/이미|중복|같은 건/.test(dupDraft), dupDraft.slice(0, 200));
  await human();
  await tap(`[data-run="${id2}"] [data-act=prepare]`);
  await until('dup waiting', () => runStatus(id2) === 'waiting' && armed(), 30_000);
  const dupAction = S!.bar.snapshot().action;
  check('중복: 승인 카드 동작 글자가 "그래도 한 번 더 발급"', dupAction === '그래도 한 번 더 발급', dupAction);
  // 실행 중 다른 요청
  await human(0.5);
  const idBusy = await draftOf(`${TYPED_CP.name}에 33만원 세금계산서`);
  await human(0.5);
  await tap(`[data-run="${idBusy}"] [data-act=prepare]`);
  await sleep(300);
  const busyToast = await toast();
  check('승인 대기 중 다른 건 준비 → 초안 그대로', runStatus(idBusy) === 'draft', { status: runStatus(idBusy), busyToast });
  if (!/진행 중/.test(busyToast)) repro('F-prepare-throttle: 1분에 [홈택스에서 준비] 3번(또는 승인 카드 없이 끝난 실행 3번 연속) 뒤에는 이유·기다릴 시간 없이 "잠시 뒤 다시 눌러 주세요."만 뜬다', /잠시 뒤/.test(busyToast), { busyToast, prepares: prepareCount });
  await human();
  barClick('stop');
  await until('stopped', () => runStatus(id2) === 'stopped', 10_000);
  const stopText = await cardText(id2);
  console.log('  look(stopped):', await look('card-stopped', `[data-run="${id2}"]`));
  check('승인 카드 [중지] → 중지, 발급 POST 그대로 1건, "아무것도 발급하지 않았어요"', fx!.posts() === 1 && /아무것도 발급(하지 않았|되지 않았)/.test(stopText), { posts: fx!.posts(), stopText: stopText.slice(0, 300) });
  // 방금 막혔던 다른 건을 다시 준비할 수 있다
  await human();
  await tap(`[data-run="${idBusy}"] [data-act=prepare]`);
  for (let i = 0; i < 7 && runStatus(idBusy) === 'draft' && /잠시 뒤|초 뒤에 다시/.test(await toast()); i++) {
    // 사람은 "잠시 뒤"를 보고 기다렸다 다시 누른다(10초씩)
    console.log(`  (prepare throttled, wait 10s #${i + 1})`);
    await sleep(10_000);
    await tap(`[data-run="${idBusy}"] [data-act=prepare]`);
    await sleep(300);
  }
  check('끝난 뒤 다른 건 준비가 된다', await until('busy prepared', () => ['preparing', 'waiting'].includes(runStatus(idBusy) ?? ''), 5_000), { status: runStatus(idBusy), toast: await toast() });
  await until('busy waiting', () => runStatus(idBusy) === 'waiting' && armed(), 30_000);
  // 네트워크 끊김(게이트웨이): 실행 중에 새 요청 → 연결 안 됨 + [다시 시도]
  offline = true;
  await human(0.5);
  await say(`${TYPED_CP.name}에 10만원 세금계산서`);
  const off = await until('unavailable', async () => js<boolean>(`!![...document.querySelectorAll('[data-intent-unavailable]')].pop()`), 8_000);
  const offText = await js<string>(`[...document.querySelectorAll('[data-intent-unavailable]')].pop()?.innerText ?? ''`);
  check('게이트웨이 불가 → 연결하지 못했어요 + [다시 시도]', off, offText);
  seen.push({ at: 'offline', text: offText });
  offline = false;
  await human();
  await tap('[data-act=intent-retry]');
  check('[다시 시도] → 초안 카드', await until('retry draft', async () => S!.runs.list().some((r) => r.status === 'draft' && r.counterparty.bizNo === TYPED_CP.bizNo && r.supply === 100_000), 8_000), await lastApp());

  // 승인 대기 중에 앱을 끈다(정리 없이): 재시작 단계가 이어서 본다
  writeFileSync(path.join(ROOT, 'rehearsal-main.json'), JSON.stringify({ waitingRun: idBusy, issuedRun: id1, approvalNo: fx!.issued.at(-1)?.approvalNo ?? null, posts: fx!.posts(), issued: fx!.issued.length, results, repros, seen }, null, 1));
  console.log(`main: 승인 대기(${idBusy})에서 앱을 끈다. 다음: SAX_REH_PHASE=restart SAX_REH_ROOT=${ROOT}`);
}

/** 문장을 보내 초안 카드 id를 받는다. */
async function draftOf(text: string): Promise<string> {
  const before = await lastRunId();
  await say(text);
  await until('draft', async () => !!(await lastRunId()) && (await lastRunId()) !== before, 8_000);
  return (await lastRunId())!;
}

/** SAX_REH_OUT이 있으면 그 폴더에 지금 창을 PNG로 남긴다(PR 전후 캡처용). */
async function snap(name: string): Promise<void> {
  const out = process.env.SAX_REH_OUT;
  if (out) writeFileSync(path.join(out, `${name}.png`), (await S!.win.webContents.capturePage()).toPNG());
}

// ---- 2부: 승인 대기에서 끈 앱을 다시 켠다 ----
async function restartPhase(): Promise<void> {
  const prev = JSON.parse(readFileSync(path.join(ROOT, 'rehearsal-main.json'), 'utf8')) as { waitingRun: string; issuedRun: string; approvalNo: string | null };
  await boot(false);
  await sleep(1500);
  const home = await js<string>(`document.querySelector('#app')?.innerText ?? ''`);
  seen.push({ at: 'restart-home', text: home.slice(0, 1500) });
  console.log('  look(restart):', await look('restart-home'));
  check('재시작: 로그인 화면 없이 바로 쓴다(로그인 상태 유지)', (await acctScreen()) === null, await acctScreen());
  check('재시작: 사업자·거래처가 남아 있다', home.includes(ME.name) && S!.runs.counterparties.length === 2, { cps: S!.runs.counterparties.length });
  repro('F-restart-lost-run: 승인 대기에서 앱을 끄고 켜면 그 실행 카드·안내가 없다(무엇이 됐는지 화면이 말하지 않는다)', !(await js<boolean>(`!!document.querySelector('[data-run]')`)) && !/승인 대기|발급하지 않았|멈췄/.test(home), home.slice(0, 300));
  repro('F-restart-lost-thread: 재시작하면 대화·발급 결과 카드가 모두 사라진다', !(await js<boolean>(`!!document.querySelector('.sx-thread [data-run], .sx-thread .sx-user')`)), null);
  const ins = (await S!.host.rpc('run.inspect', { runId: prev.waitingRun }).catch((e: Error) => ({ error: e.message }))) as { ledger?: string | null; journal?: string[]; error?: string };
  check('엔진: 끊긴 승인 대기는 발급되지 않은 채(원장 committed 아님)', ins.ledger !== 'committed', ins);
  console.log('  engine inspect(waiting run):', JSON.stringify({ ledger: ins.ledger, journal: ins.journal?.slice(-6), error: ins.error }));
  await human(0.5);
  await tap('#rail [data-view=activity]');
  await sleep(500);
  const act = await js<string>(`document.querySelector('#center')?.innerText ?? ''`);
  seen.push({ at: 'restart-activity', text: act.slice(0, 1500) });
  await snap('restart-01-activity');
  const cutRow = await js<string>(`document.querySelector('[data-act-row="past-${prev.waitingRun}"]')?.innerText ?? ''`);
  const issuedRow = await js<string>(`document.querySelector('[data-act-row="past-${prev.issuedRun}"]')?.innerText ?? ''`);
  repro('F-restart-activity: 재시작 뒤 활동 기록에 끊긴 실행(승인 대기 중 종료)이 남지 않는다', !cutRow, act.slice(0, 400));
  check('재시작 활동 기록: 승인 대기에서 끊긴 실행은 "승인 전에 멈춤", 앞서 발급한 건은 "완료"', cutRow.includes(TYPED_CP.name) && cutRow.includes('승인 전에 멈춤') && issuedRow.includes(CERT_CP.name) && issuedRow.includes('완료'), { cutRow, issuedRow });
  check('재시작 활동 기록에 내부 코드·빈 값 글자가 없다', (await look('restart-activity', '#center')).length === 0, await look('restart-activity', '#center'));
  await tap(`[data-act-row="past-${prev.waitingRun}"]`);
  await sleep(300);
  const cutPanel = await js<string>(`document.querySelector('[data-panel-act="past-${prev.waitingRun}"]')?.innerText ?? ''`);
  const cutButtons = await js<string[]>(`[...document.querySelectorAll('[data-panel-act="past-${prev.waitingRun}"] button')].map((b) => b.textContent)`);
  seen.push({ at: 'restart-cut-panel', text: cutPanel });
  await snap('restart-02-cut-panel');
  check('끊긴 실행 패널: "승인 전에 앱이 꺼져 멈췄어요. 아무것도 발급하지 않았어요." 다시 준비·승인 버튼 없음', cutPanel.includes('승인 전에 앱이 꺼져 멈췄어요. 아무것도 발급하지 않았어요.') && !cutButtons.some((b) => /준비|승인|발급/.test(b ?? '')), { cutPanel, cutButtons });
  await tap(`[data-act-row="past-${prev.issuedRun}"]`);
  await sleep(300);
  const issuedPanel = await js<string>(`document.querySelector('[data-panel-act="past-${prev.issuedRun}"]')?.innerText ?? ''`);
  seen.push({ at: 'restart-issued-panel', text: issuedPanel });
  await snap('restart-03-issued-panel');
  // fixture 실행은 보관함에 발급 PDF를 넣지 않는다(documentId 없음). 그래서 [PDF 열기] 대신 홈택스 발급목록 안내가 보여야 한다.
  check('발급 건 패널: 승인번호 [복사], PDF가 없으면 홈택스 발급목록 안내', !!prev.approvalNo && issuedPanel.includes(prev.approvalNo) && issuedPanel.includes('복사') && issuedPanel.includes('홈택스 발급목록에서 확인할 수 있어요'), { issuedPanel, approvalNo: prev.approvalNo });
  await tap('#rail [data-view=docs]');
  await sleep(500);
  const docs = await js<string>(`document.querySelector('#center')?.innerText ?? ''`);
  repro('F-restart-docs: 재시작하면 앱이 발급한 세금계산서가 보관함에서 사라진다', !docs.includes(`세금계산서 · ${CERT_CP.name}`), docs.slice(0, 300));
}

app.whenReady().then(async () => {
  app.setPath('userData', path.join(ROOT, 'userData-electron'));
  try {
    if (PHASE === 'main') await mainPhase();
    else await restartPhase();
  } catch (e) {
    check('리허설 예외 없음', false, (e as Error).stack);
  }
  const out = process.env.SAX_REH_OUT;
  if (out) writeFileSync(path.join(out, `rehearsal-${PHASE}.json`), JSON.stringify({ results, repros, seen }, null, 1));
  console.log(`${results.filter((r) => r.ok).length}/${results.length} ok · REPRO ${repros.filter((r) => r.reproduced).length} · FIXED ${repros.filter((r) => !r.reproduced).length}`);
  // main은 정리 없이 끈다(승인 대기 중 강제 종료). restart는 정상 종료.
  if (PHASE === 'restart') {
    await S?.close().catch(() => {});
    rmSync(ROOT, { recursive: true, force: true, maxRetries: 2 });
  }
  else await fx?.close().catch(() => {});
  app.exit(results.length && results.every((r) => r.ok) ? 0 : 1);
});
