// 제품 경로 기동 e2e(수동 실행, CI 아님): 제품 진입점과 같은 엔진 모드(utilityProcess 금고·OS 키체인·실제 엔진) + 운영 클라우드(tax.laf-co.com)로
// 임시 앱 폴더에서 셸을 띄워, 설치본이 홈 화면까지 가는 길을 본다(팀장 지시 2026-11-10 ③).
// - 운영 레지스트리 동기화(인덱스·정책·H-01 패키지) → 레지스트리 상태 fresh·홈택스 상한
// - 견본 데이터 없음(대화·표시·사업장), 온보딩부터
// - 로그인이 먼저(사용자 결정 2026-11-10): 약관 동의 뒤 닫을 수 없는 로그인 화면, 그 전에는 대화를 받지 않는다(account_required)
// - 계정 비밀번호 로그인이 제품 Egress로 운영 계정 서비스에 닿는다(없는 계정 → 같은 안내)
// SAX_E2E_PRODUCT=login이면 계정 서비스만 localhost 메모리 가짜(e2e/fake-account.ts)로 바꿔 로그인까지 하고, 그 뒤 온보딩 O-02와
// 오프라인 해석 없음(게이트웨이에 닿지 못하면 정규식 카드 대신 연결 안 됨 + [다시 시도])을 본다(셸은 프로세스에 하나라 따로 띄운다).
// 홈택스·정부24에는 접속하지 않는다(실행 시작 전에서 멈춘다). 비밀을 저장하지 않는다.
// 키체인: 금고는 기존 db-key를 읽기만 한다(없으면 새로 만들지만, 이미 DB가 있는 앱 폴더의 키를 덮지 않는다, 금고 N-30). 임시 앱 폴더는 끝나면 지운다.
// 실행: electron apps/desktop/e2e-dist/shell-product-e2e.js → 요약을 표준 출력에.
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { app } from 'electron';
import { appPaths, prepareLayout } from '@sax/platform';
import { Egress } from '@sax/net';
import { productRemote } from '../dist/remote-wiring.js';
import { cloudPorts } from '../dist/remote-cloud.js';
import { serveAccount } from './fake-account-http.js';
import { fakeAccount, PASSWORD, softKeys } from './fake-account.js';
import { registerShellSchemes, startShell, type Shell } from '../dist/shell-app.js';

registerShellSchemes();
// macOS의 tmpdir는 링크(/var → /private/var)라 앱 폴더 검사가 거부한다. 실제 경로로 만든다.
const ROOT = mkdtempSync(path.join(realpathSync(os.tmpdir()), 'sax-product-e2e-'));
process.once('exit', () => rmSync(ROOT, { recursive: true, force: true, maxRetries: 2 }));
app.on('window-all-closed', () => {});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const results: Array<{ name: string; ok: boolean; detail?: unknown }> = [];
const check = (name: string, ok: boolean, detail?: unknown) => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : ` ${JSON.stringify(detail)}`}`);
};
let S: Shell | undefined;
const js = <T = unknown>(code: string): Promise<T> => S!.win.webContents.executeJavaScript(code) as Promise<T>;
async function until(what: string, fn: () => Promise<boolean>, ms = 20_000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn().catch(() => false)) return true;
    await sleep(100);
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
const mainLog = () => {
  try {
    return readFileSync(path.join(appPaths(ROOT).logs, 'main.log'), 'utf8');
  } catch {
    return '';
  }
};

async function main() {
  const prepared = await prepareLayout(ROOT);
  check('임시 앱 폴더를 사용자 전용으로 준비', prepared.root.ok, prepared.root);
  const paths = appPaths(ROOT);
  app.setPath('userData', paths.userData);
  app.setPath('logs', paths.logs);
  const t0 = Date.now();
  const loginMode = process.env.SAX_E2E_PRODUCT === 'login';
  const remote = loginMode
    ? await (async () => {
        const front = await serveAccount(fakeAccount().client);
        const keys = softKeys();
        return { cloud: cloudPorts({ egress: new Egress({ cloudDevLocal: true }), env: 'dev', dev: { accountOrigin: front.origin, relayHost: '127.0.0.1:9' } }), keys: async () => keys };
      })()
    : productRemote({ isPackaged: false, env: {} });
  S = await startShell({ engine: { root: ROOT, portal: { kind: 'hometax' } }, remote, show: false, daemon: false });
  await S.ready;
  await until('renderer ready', async () => (await js('document.body.dataset.ready')) === '1', 60_000);
  check(`엔진·금고 기동 → 첫 화면(${Math.round((Date.now() - t0) / 100) / 10}초)`, (await js('document.body.dataset.ready')) === '1');
  check('견본 표시 없음("견본 데이터 · PoC 데모")', !(await js<string>(`document.querySelector('#titlebar').textContent`)).includes('견본 데이터'));
  check('견본 사업장 없음(제목줄 "내 사업장")', (await js<string>(`document.querySelector('.tb-co').textContent`)).includes('내 사업장'));
  check('견본 대화 없음(가나다컴퍼니·B상사 없음)', !/가나다컴퍼니|B상사/.test(await js<string>(`document.body.textContent`)));
  check('제목줄에 "null" 같은 빈 값 글자가 없다', !/null|undefined/.test(await js<string>(`document.querySelector('#titlebar').innerText`)), await js<string>(`document.querySelector('#titlebar').innerText`));
  check('창 제목은 "소버린 AX"(PoC 데모 표시 없음)', S!.win.getTitle() === '소버린 AX', S!.win.getTitle());
  const mac = process.platform === 'darwin';
  check(`검색 단축키 표시는 ${mac ? '⌘K' : 'Ctrl K'}`, (await js<string>(`document.querySelector('.sx-kbd').textContent`)) === (mac ? '⌘K' : 'Ctrl K'));
  S!.win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'K', modifiers: [mac ? 'meta' : 'control'] });
  S!.win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'K', modifiers: [mac ? 'meta' : 'control'] });
  check('검색 단축키를 누르면 같은 안내', await until('search toast', async () => js<boolean>(`!document.querySelector('#toast').hidden && document.querySelector('#toast').textContent === '검색은 곧 지원해요'`), 3_000));
  check('약관 카드의 "F-06 초안 전 문구" 배지는 설치본에서 보이지 않는다(문구는 그대로)', await until('terms', async () => js<boolean>(`(() => { const c = document.querySelector('[data-consent]'); const d = c?.querySelector('.onb-draft'); return !!c && c.querySelectorAll('li').length > 0 && (!d || getComputedStyle(d).display === 'none'); })()`)));
  check('사업자 프로필이 없으면 온보딩부터', await until('onboarding', async () => js<boolean>(`!!document.querySelector('[data-onboarding]')`)));
  check('개발용 코드·미서명 배지는 개발 실행에서 없음(설치본 자기 점검만)', (await js<number>(`document.querySelectorAll('[data-build-badge]').length`)) === 0);

  // 로그인이 먼저다(사용자 결정 2026-11-10): 약관 동의 → 닫을 수 없는 로그인 화면. 그 전에는 대화를 받지 않는다.
  const onbStep = () => js<string | null>(`[...document.querySelectorAll('[data-onb-step]')].pop()?.dataset.onbStep ?? null`);
  const acctScreen = () => js<string | null>(`document.querySelector('[data-acct-screen]')?.dataset.acctScreen ?? null`);
  check('약관 동의 전에는 로그인 화면이 없다(약관이 먼저)', (await js<boolean>(`!document.querySelector('[data-acct-screen]')`)));
  await press('[data-onb=agree]');
  check('약관 동의 → 로그인 화면(닫기 없음, "먼저 로그인" 안내)', await until('login gate', async () => (await acctScreen()) === 'email' && js<boolean>(`!!document.querySelector('[data-login-gate]') && !document.querySelector('[data-act=account-back]') && document.querySelector('#app').inert`)));
  await js(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
  await sleep(100);
  check('Esc로도 닫히지 않는다', (await acctScreen()) === 'email');
  check('로그인 전 대화는 main이 받지 않는다(account_required)', (await js<string>(`window.sax.call('request.send', { text: '세금계산서 1000원 끊자', vat: null }).then(() => 'ok', (e) => String(e.message).replace(/^.*Error: /, ''))`)) === 'account_required');
  check('로그인 전 오프라인 해석 길로 가지 않았다(main.interpret 없음)', !/main\.interpret/.test(mainLog()));

  if (!loginMode) {
    // 레지스트리: 기동 때 기다리지 않고 동기화한다. 결과는 main 로그(결과 코드만)와 엔진 상태로 본다.
    check('기동 동기화가 운영 레지스트리에서 H-01 패키지를 받았다(main.registry_sync h01=accepted)', await until('registry sync', async () => /main\.registry_sync.*"why":"boot".*"h01":"accepted"/.test(mainLog()), 60_000), mainLog().split('\n').filter((l) => l.includes('registry')).slice(-3));
    const st = (await S.host.rpc('db.query.registry.status', {})) as { freshness?: string; portalModeCeiling?: Record<string, string>; killPlaybooks?: string[] };
    check('레지스트리 상태 fresh, 홈택스 상한 auto, 정지 목록 없음', st.freshness === 'fresh' && st.portalModeCeiling?.hometax === 'auto' && (st.killPlaybooks ?? []).length === 0, st);
    // 계정: 제품 클라이언트·Egress로 운영 계정 서비스에 닿는다. 없는 계정이면 같은 안내(만들지 않는다).
    await type('.acct-email', `nobody-${Date.now()}@example.com`);
    await press('[data-act=account-next]');
    await until('pw', async () => (await acctScreen()) === 'password');
    await type('.acct-password', 'not-a-real-password-1');
    await press('[data-act=account-password]');
    const wrong = await until('wrong', async () => js<boolean>(`!!document.querySelector('[data-acct-wrong]')`), 30_000);
    check('로그인 화면의 비밀번호 로그인이 운영 계정 서비스까지 가서 같은 안내(account.credentials_invalid)', wrong, await js(`document.querySelector('.acct-err, [data-acct-wrong]')?.textContent ?? null`));
    check('틀린 로그인 뒤에도 로그인 화면이 막고 있다', (await acctScreen()) === 'password' && (await js<boolean>(`document.querySelector('#app').inert`)));
    return;
  }

  // (login) 가짜 계정 서비스로 비밀번호 로그인 → 첫 PC 등록 → 화면이 걷히고 온보딩이 이어진다
  await type('.acct-email', 'owner@gyeonbon-test.example');
  await press('[data-act=account-next]');
  await until('pw', async () => (await acctScreen()) === 'password');
  await type('.acct-password', PASSWORD);
  await press('[data-act=account-password]');
  check('로그인·PC 등록 → 로그인 화면이 걷히고 O-01 환영', await until('signed in', async () => (await acctScreen()) === null && (await onbStep()) === 'welcome' && !(await js<boolean>(`document.querySelector('#app').inert`)), 30_000));

  // 온보딩 O-02: 제품은 상태조회가 없어 확인 불가다. 그 사실을 보이고 [맞습니다]로만 확정한다(팀장 결정 2026-11-10).
  await press('[data-onb=number]');
  await until('biz-number', async () => (await onbStep()) === 'biz-number');
  await js(`(() => { const i = document.querySelector('[data-onb-step=biz-number] input'); i.value = '123-45-67891'; })()`);
  await press('[data-onb=submit]');
  check(
    'O-02 확인 불가: "국세청 확인을 하지 못했습니다" + [맞습니다], 확인됐다고 보이지 않음',
    await until('biz-confirm', async () => (await onbStep()) === 'biz-confirm' && js<boolean>(`(() => { const c = [...document.querySelectorAll('[data-onb-step=biz-confirm]')].pop(); return c.textContent.includes('국세청 확인을 하지 못했습니다. 번호가 맞는지 확인해 주세요.') && c.textContent.includes('조회하지 못했어요') && !!c.querySelector('[data-onb=confirm-unverified]') && !c.querySelector('[data-onb=confirm]'); })()`)),
  );
  await press('[data-onb=confirm-unverified]');
  check('[맞습니다] → O-03 발급 인증', await until('auth', async () => (await onbStep()) === 'auth'));
  await press('[data-onb=later]');
  check('② 모델 동의: 버튼은 [동의하고 계속] 하나', await until('model', async () => (await onbStep()) === 'model' && (await js<string>(`[...document.querySelector('[data-consent="consent.model"]').querySelectorAll('button')].map((b) => b.textContent).join()`)) === '동의하고 계속'));

  const say = (t: string) => js(`(() => { const t = document.querySelector('#composer'); t.value = ${JSON.stringify(t)}; t.dispatchEvent(new Event('input')); document.querySelector('.sx-send').click(); })()`);
  await say('세금계산서 1000원 인스피릿에 끊자');
  check('② 동의 전 대화 → 동의가 먼저라는 안내(모델로 보내지 않음)', await until('consent first', async () => js<boolean>(`[...document.querySelectorAll('.sx-thread .sx-app')].pop()?.textContent.includes('모델 처리에 동의하면') ?? false`)));
  await press('[data-onb=agree]');
  await until('telemetry', async () => (await onbStep()) === 'telemetry');

  // 오프라인 해석 없음: 이 e2e는 게이트웨이 기기 토큰을 받지 못한다(가짜 계정) → 엔진 decide.unavailable → 정규식 카드 대신 연결 안 됨 + [다시 시도]
  await say('세금계산서 1000원 인스피릿에 끊자');
  check(
    '모델에 닿지 못하면 카드 없이 "연결하지 못했어요" + [다시 시도]',
    await until('unavailable', async () => js<boolean>(`(() => { const b = [...document.querySelectorAll('[data-intent-unavailable]')].pop(); return !!b && b.textContent.includes('연결하지 못했어요') && !!b.querySelector('[data-act=intent-retry]') && !document.querySelector('[data-run]'); })()`), 15_000),
  );
  check('main 로그: 오프라인 경로가 아니라 unavailable', /main\.interpret.*"path":"unavailable\./.test(mainLog()) && !/offline/.test(mainLog().split('\n').filter((l) => l.includes('main.interpret')).join('\n')), mainLog().split('\n').filter((l) => l.includes('main.interpret')).slice(-2));
  check('제목줄에 해석 경로 표시가 없다', !(await js<string>(`document.querySelector('#titlebar').textContent`)).includes('해석'));
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
