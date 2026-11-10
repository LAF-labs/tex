// 제품 경로 기동 e2e(수동 실행, CI 아님): 제품 진입점과 같은 엔진 모드(utilityProcess 금고·OS 키체인·실제 엔진) + 운영 클라우드(tax.laf-co.com)로
// 임시 앱 폴더에서 셸을 띄워, 설치본이 홈 화면까지 가는 길을 본다(팀장 지시 2026-11-10 ③).
// - 운영 레지스트리 동기화(인덱스·정책·H-01 패키지) → 레지스트리 상태 fresh·홈택스 상한
// - 견본 데이터 없음(대화·표시·사업장), 온보딩부터
// - 계정 비밀번호 로그인이 제품 Egress로 운영 계정 서비스에 닿는다(없는 계정 → 같은 안내)
// 홈택스·정부24에는 접속하지 않는다(실행 시작 전에서 멈춘다). 비밀을 저장하지 않는다.
// 키체인: 금고는 기존 db-key를 읽기만 한다(없으면 새로 만들지만, 이미 DB가 있는 앱 폴더의 키를 덮지 않는다, 금고 N-30). 임시 앱 폴더는 끝나면 지운다.
// 실행: electron apps/desktop/e2e-dist/shell-product-e2e.js → 요약을 표준 출력에.
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { app } from 'electron';
import { appPaths, prepareLayout } from '@sax/platform';
import { productRemote } from '../dist/remote-wiring.js';
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
  S = await startShell({ engine: { root: ROOT, portal: { kind: 'hometax' } }, remote: productRemote({ isPackaged: false, env: {} }), show: false, daemon: false });
  await S.ready;
  await until('renderer ready', async () => (await js('document.body.dataset.ready')) === '1', 60_000);
  check(`엔진·금고 기동 → 첫 화면(${Math.round((Date.now() - t0) / 100) / 10}초)`, (await js('document.body.dataset.ready')) === '1');
  check('견본 표시 없음("견본 데이터 · PoC 데모")', !(await js<string>(`document.querySelector('#titlebar').textContent`)).includes('견본 데이터'));
  check('견본 사업장 없음(제목줄 "내 사업장")', (await js<string>(`document.querySelector('.tb-co').textContent`)).includes('내 사업장'));
  check('견본 대화 없음(가나다컴퍼니·B상사 없음)', !/가나다컴퍼니|B상사/.test(await js<string>(`document.body.textContent`)));
  check('사업자 프로필이 없으면 온보딩부터', await until('onboarding', async () => js<boolean>(`!!document.querySelector('[data-onboarding]')`)));
  check('개발용 코드·미서명 배지는 개발 실행에서 없음(설치본 자기 점검만)', (await js<number>(`document.querySelectorAll('[data-build-badge]').length`)) === 0);

  // 레지스트리: 기동 때 기다리지 않고 동기화한다. 결과는 main 로그(결과 코드만)와 엔진 상태로 본다.
  check('기동 동기화가 운영 레지스트리에서 H-01 패키지를 받았다(main.registry_sync h01=accepted)', await until('registry sync', async () => /main\.registry_sync.*"why":"boot".*"h01":"accepted"/.test(mainLog()), 60_000), mainLog().split('\n').filter((l) => l.includes('registry')).slice(-3));
  const st = (await S.host.rpc('db.query.registry.status', {})) as { freshness?: string; portalModeCeiling?: Record<string, string>; killPlaybooks?: string[] };
  check('레지스트리 상태 fresh, 홈택스 상한 auto, 정지 목록 없음', st.freshness === 'fresh' && st.portalModeCeiling?.hometax === 'auto' && (st.killPlaybooks ?? []).length === 0, st);

  // 계정: 제품 클라이언트·Egress로 운영 계정 서비스에 닿는다. 없는 계정이면 같은 안내(만들지 않는다).
  await js(`document.querySelector('#rail [data-view="settings"]').click()`);
  await until('settings', async () => js<boolean>(`!!document.querySelector('[data-set-tab=devices]')`));
  await js(`document.querySelector('[data-set-tab=devices]').click()`);
  check('설정 > 기기 연결: 로그인 전', await until('account card', async () => js<boolean>(`document.querySelector('[data-account]')?.dataset.account === 'signed_out'`)));
  await press('[data-act=account-login]');
  await until('login', async () => js<boolean>(`document.querySelector('[data-acct-screen]')?.dataset.acctScreen === 'email'`));
  await type('.acct-email', `nobody-${Date.now()}@example.com`);
  await press('[data-act=account-next]');
  await until('pw', async () => js<boolean>(`document.querySelector('[data-acct-screen]')?.dataset.acctScreen === 'password'`));
  await type('.acct-password', 'not-a-real-password-1');
  await press('[data-act=account-password]');
  const wrong = await until('wrong', async () => js<boolean>(`!!document.querySelector('[data-acct-wrong]')`), 30_000);
  check('비밀번호 로그인이 운영 계정 서비스까지 가서 같은 안내(account.credentials_invalid)', wrong, await js(`document.querySelector('.acct-err, [data-acct-wrong]')?.textContent ?? null`));
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
