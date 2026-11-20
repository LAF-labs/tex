import './os-guard.js';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { app } from 'electron';
import { appPaths, prepareLayout } from '@sax/platform';
import { Egress } from '@sax/net';
import { productRemote } from '../dist/remote-wiring.js';
import { engineIntentResolver, type IntentResolver } from '../dist/intent-route.js';
import { cloudPorts } from '../dist/remote-cloud.js';
import { serveAccount } from './fake-account-http.js';
import { fakeAccount, PASSWORD, softKeys } from './fake-account.js';
import { registerShellSchemes, startShell, type Shell } from '../dist/shell-app.js';

registerShellSchemes();
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
  let routeInvoice = false;
  const intent: IntentResolver = {
    resolve: (t) => (routeInvoice ? Promise.resolve({ route: { outcome: 'route', playbook: 'hometax.invoice.issue', adviceMentioned: false, via: 'model' }, fallback: null }) : engineIntentResolver((m, p) => S!.host.rpc(m, p)).resolve(t)),
  };
  S = await startShell({ engine: { root: ROOT, portal: { kind: 'hometax' } }, remote, show: false, daemon: false, ...(loginMode ? { intent } : {}) });
  const setRoute = (v: boolean) => (routeInvoice = v);
  await S.ready;
  await until('renderer ready', async () => (await js('document.body.dataset.ready')) === '1', 60_000);
  check(`엔진·금고 기동 → 첫 화면(${Math.round((Date.now() - t0) / 100) / 10}초)`, (await js('document.body.dataset.ready')) === '1');
  check('견본 표시 없음("견본 데이터 · PoC 데모")', !(await js<string>(`document.querySelector('#titlebar').textContent`)).includes('견본 데이터'));
  check('견본 사업장 없음(제목줄 "내 사업장")', (await js<string>(`document.querySelector('.tb-co').textContent`)).includes('내 사업장'));
  check('견본 대화 없음(가나다컴퍼니·B상사 없음)', !/가나다컴퍼니|B상사/.test(await js<string>(`document.body.textContent`)));
  check('제목줄에 "null" 같은 빈 값 글자가 없다', !/null|undefined/.test(await js<string>(`document.querySelector('#titlebar').innerText`)), await js<string>(`document.querySelector('#titlebar').innerText`));
  check('창 제목은 "소버린 AX"(PoC 데모 표시 없음)', S!.win.getTitle() === '소버린 AX', S!.win.getTitle());
  check('제목줄에 검색 칸·고정 상태(금고 열림·폰 연결 안 됨)가 없다', await js<boolean>(`!document.querySelector('#titlebar .sx-search') && !/금고 열림|폰 연결 안 됨/.test(document.querySelector('#titlebar').textContent)`));
  check('약관 카드 안내문에 내부 코드(F-06)가 없다', await until('terms text', async () => js<boolean>(`(() => { const c = document.querySelector('[data-consent]'); return !!c && c.textContent.includes('곧 여기서 열어 볼 수 있어요') && !/F-06이 확정/.test(c.innerText); })()`)));
  check('약관 카드의 "F-06 초안 전 문구" 배지는 설치본에서 보이지 않는다(문구는 그대로)', await until('terms', async () => js<boolean>(`(() => { const c = document.querySelector('[data-consent]'); const d = c?.querySelector('.onb-draft'); return !!c && c.querySelectorAll('li').length > 0 && (!d || getComputedStyle(d).display === 'none'); })()`)));
  check('사업자 프로필이 없으면 온보딩부터', await until('onboarding', async () => js<boolean>(`!!document.querySelector('[data-onboarding]')`)));
  check('개발용 코드·미서명 배지는 개발 실행에서 없음(설치본 자기 점검만)', (await js<number>(`document.querySelectorAll('[data-build-badge]').length`)) === 0);

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
    check('기동 동기화가 운영 레지스트리에서 H-01 패키지를 받았다(main.registry_sync h01=accepted)', await until('registry sync', async () => /main\.registry_sync.*"why":"boot".*"h01":"accepted"/.test(mainLog()), 60_000), mainLog().split('\n').filter((l) => l.includes('registry')).slice(-3));
    const st = (await S.host.rpc('db.query.registry.status', {})) as { freshness?: string; portalModeCeiling?: Record<string, string>; killPlaybooks?: string[] };
    check('레지스트리 상태 fresh, 홈택스 상한 auto, 정지 목록 없음', st.freshness === 'fresh' && st.portalModeCeiling?.hometax === 'auto' && (st.killPlaybooks ?? []).length === 0, st);
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

  await type('.acct-email', 'owner@gyeonbon-test.example');
  await press('[data-act=account-next]');
  await until('pw', async () => (await acctScreen()) === 'password');
  await type('.acct-password', PASSWORD);
  await press('[data-act=account-password]');
  check('로그인·PC 등록 → 로그인 화면이 걷히고 O-01 환영', await until('signed in', async () => (await acctScreen()) === null && (await onbStep()) === 'welcome' && !(await js<boolean>(`document.querySelector('#app').inert`)), 30_000));

  await press('[data-onb=number]');
  await until('biz-number', async () => (await onbStep()) === 'biz-number');
  await js(`(() => { const i = document.querySelector('[data-onb-step=biz-number] input'); i.value = '123-45-67891'; })()`);
  await press('[data-onb=submit]');
  check(
    'O-02 상호가 비면 "상호를 넣어 주세요" + [맞습니다] 없이 [고칠게요]',
    await until('name first', async () => (await onbStep()) === 'biz-confirm' && js<boolean>(`(() => { const c = [...document.querySelectorAll('[data-onb-step=biz-confirm]')].pop(); return c.textContent.includes('상호가 비어 있어요') && !c.querySelector('[data-onb=confirm-unverified]') && !!c.querySelector('[data-onb=edit]'); })()`)),
  );
  check('상호 없이 [맞습니다]를 보내도 main이 거부(name_required)', (await js<string>(`window.sax.call('onboarding.reply', { step: 'biz-confirm', choice: 'confirm_unverified' }).then(() => 'ok', (e) => String(e.message).replace(/^.*Error: /, ''))`)) === 'name_required');
  await press('[data-onb=edit]');
  await until('onb edit', async () => js<boolean>(`!!document.querySelector('[data-onb-step=biz-confirm] form [name=name]')`));
  await js(`(() => { const f = [...document.querySelectorAll('[data-onb-step=biz-confirm] form')].pop(); f.name.value = '견본첫상사'; })()`);
  await press('[data-onb=save]');
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

  await say('세금계산서 1000원 인스피릿에 끊자');
  check(
    '모델에 닿지 못하면 카드 없이 "연결하지 못했어요" + [다시 시도]',
    await until('unavailable', async () => js<boolean>(`(() => { const b = [...document.querySelectorAll('[data-intent-unavailable]')].pop(); return !!b && b.textContent.includes('연결하지 못했어요') && !!b.querySelector('[data-act=intent-retry]') && !document.querySelector('[data-run]'); })()`), 15_000),
  );
  check('main 로그: 오프라인 경로가 아니라 unavailable', /main\.interpret.*"path":"unavailable\./.test(mainLog()) && !/offline/.test(mainLog().split('\n').filter((l) => l.includes('main.interpret')).join('\n')), mainLog().split('\n').filter((l) => l.includes('main.interpret')).slice(-2));
  check('제목줄에 해석 경로 표시가 없다', !(await js<string>(`document.querySelector('#titlebar').textContent`)).includes('해석'));

  setRoute(true);
  for (const [st, sel] of [['telemetry', '[data-onb=off]'], ['tasks', '[data-onb=later]'], ['summary', '[data-onb=ok]'], ['first', '[data-onb=later]']] as const) {
    await until(st, async () => (await onbStep()) === st);
    await press(sel);
  }
  await until('onb done', async () => js<boolean>(`!document.querySelector('[data-onb-step]')`));
  check('제목줄 프로필 이름은 상호(번호 아님)', (await js<string>(`document.querySelector('.tb-co').textContent`)).includes('견본첫상사'), await js<string>(`document.querySelector('.tb-co').textContent`));
  const runCount = () => js<number>(`document.querySelectorAll('[data-run]').length`);
  await say('세금계산서 1000원 인스피릿에 끊자');
  check(
    '발급 인증이 빠졌으면 카드를 만들지 않고 무엇이 빠졌는지 + [발급 인증 고르기]',
    await until('setup needed', async () => js<boolean>(`(() => { const b = [...document.querySelectorAll('[data-setup-needed]')].pop(); return !!b && b.dataset.setupNeeded === 'auth' && b.textContent.includes('발급할 때 쓸 인증') && !!b.querySelector('[data-act=setup-auth]'); })()`)),
  );
  check('카드·실행 없음', (await runCount()) === 0 && !/멈췄어요\(/.test(await js<string>(`document.body.textContent`)));
  await press('[data-act=setup-auth]');
  check('[발급 인증 고르기] → 대화 끝에 O-03 발급 인증만 다시 묻는다', await until('reopen auth', async () => (await onbStep()) === 'auth'));
  await press('[data-onb=simple]');
  check('인증을 고르면 동의를 다시 묻지 않고 요약', await until('redo summary', async () => (await onbStep()) === 'summary'));
  await press('[data-onb=ok]');
  await until('redo done', async () => js<boolean>(`!document.querySelector('[data-onb-step]')`));
  await say('세금계산서 1000원 인스피릿에 끊자');
  check('등록을 마치면 같은 요청이 검사를 지나 다음 질문(거래처)으로 간다(장부가 비면 [거래처 추가])', await until('ask cp', async () => js<boolean>(`(() => { const a = [...document.querySelectorAll('.sx-thread .sx-app')].pop(); return !!a && (a.textContent.includes('어느 거래처에 발급할까요') || (a.textContent.includes('먼저 거래처를 추가해 주세요') && !!a.querySelector('[data-act=ask-cp-add]'))); })()`)));
  check('그 사이 실행은 시작되지 않았다(카드는 [홈택스에서 준비]를 눌러야 시작)', (await runCount()) === 0 && !/main\.run_end/.test(mainLog()));

  await press('[data-act=ask-cp-add]');
  const formOpen = await until('ask cp form', async () => js<boolean>(`!!document.querySelector('section[data-view=cps]') && !!document.querySelector('[data-panel-cp-edit=new] form')`), 5_000);
  await js(`(() => { const f = document.querySelector('[data-panel-cp-edit=new] form'); f.querySelector('[name=name]').value = '견본무품목상사'; f.querySelector('[name=bizNo]').value = '101-01-11113'; f.querySelector('[name=email]').value = 'noitem@gyeonbon-test.example'; })()`);
  await press('[data-panel-cp-edit=new] [data-act=cp-save]');
  const back = await until('back to chat', async () => (await js<string>(`document.querySelector('#composer')?.value ?? ''`)) === '견본무품목상사', 8_000);
  check('[거래처 추가] → 거래처 화면의 추가 폼 → [추가] → 대화로 돌아와 입력창에 그 이름(보내지 않음)', formOpen && back && (await runCount()) === 0, { formOpen, composer: await js<string>(`document.querySelector('#composer')?.value ?? ''`) });
  const saved = (await js<Array<{ id: string; name: string }>>(`window.sax.call('counterparties.list', {})`)).find((c) => c.name === '견본무품목상사');
  await say('견본무품목상사에 1000원 세금계산서 끊어 줘');
  check('품목 없는 거래처 → 카드 없이 "어떤 품목으로 발급할까요?"', !!saved?.id && (await until('ask item', async () => js<boolean>(`[...document.querySelectorAll('.sx-thread .sx-app')].pop()?.textContent.includes('어떤 품목으로 발급할까요') ?? false`))) && (await runCount()) === 0);
  await say('컨설팅 용역');
  check('답 → 그 품목의 카드, [홈택스에서 준비]가 켜져 있다', await until('item card', async () => js<boolean>(`(() => { const c = [...document.querySelectorAll('[data-run]')].pop(); return !!c && c.querySelector('[data-draft-item]')?.dataset.draftItem === '컨설팅 용역' && !c.querySelector('[data-act=prepare]').disabled; })()`)));
  await js(`[...document.querySelectorAll('[data-run]')].pop().querySelector('[data-act=cancel]').click()`);
  await until('cancel', async () => js<boolean>(`[...document.querySelectorAll('[data-run]')].pop()?.dataset.status === 'stopped'`), 5_000);

  const business = async () => ((await S!.host.rpc('db.query.profiles.list')) as Array<{ kind: string; displayName: string; bizNo: string; repName: string | null; bizType: string | null; address: string | null; signMethod: string | null }>).find((x) => x.kind === 'business')!;
  await js(`(document.querySelector('#rail [data-view="settings"]')?.click(), setTimeout(() => document.querySelector('[data-set-tab="biz"]')?.click(), 50))`);
  check('내 사업장: 저장된 개인 프로필이 없으면 "개인 · 개인" 카드가 없다', await until('no personal', async () => js<boolean>(`!!document.querySelector('section[data-view=biz]') && !document.querySelector('[data-personal-card]') && !document.querySelector('section[data-view=biz]').textContent.includes('개인 · 개인')`), 5_000));
  check('내 사업장: [수정]과 발급 인증 [바꾸기]', await until('biz view', async () => js<boolean>(`!!document.querySelector('[data-biz-card=view] [data-act=biz-edit]') && [...document.querySelectorAll('[data-biz-card=view] .sx-copy')].some((b) => b.textContent === '바꾸기')`), 5_000));
  await sleep(3_100);
  check('실제 입력 없이 저장하면 거부(gesture_required)', (await js<string>(`window.sax.call('profile.edit', { fields: { rep: '박다라' } }).then(() => 'ok', (e) => String(e.message).replace(/^.*Error: /, ''))`)) === 'gesture_required');
  await press('[data-act=biz-edit]');
  await until('form', async () => js<boolean>(`!!document.querySelector('[data-biz-form]')`), 5_000);
  check('폼은 지금 값으로 채워져 있다(번호 000-00-00000)', (await js<string>(`document.querySelector('[data-biz-form] [name=bizNo]').value`)) === '123-45-67891');
  await type('[data-biz-form] [name=name]', '견본고침상사');
  await type('[data-biz-form] [name=rep]', '박다라');
  await type('[data-biz-form] [name=bizType]', '서비스');
  await type('[data-biz-form] [name=address]', '서울시 가상구 견본로 1');
  check('번호를 바꾸지 않으면 홈택스 사업자 안내가 없다', await js<boolean>(`document.querySelector('[data-bizno-note]').hidden`));
  await press('[data-act=biz-save]');
  check('[저장] → 보기 카드에 고친 값, DB에도(발급 인증 그대로)', await until('saved', async () => js<boolean>(`!!document.querySelector('[data-biz-card=view]') && document.querySelector('section[data-view=biz]').textContent.includes('박다라') && document.querySelector('section[data-view=biz]').textContent.includes('서울시 가상구 견본로 1')`), 5_000) && (await business()).repName === '박다라' && (await business()).signMethod === 'simple_auth', { db: await business(), view: await js(`document.querySelector('#center')?.innerText`) });
  check('고친 상호가 제목줄에 바로 보인다', (await js<string>(`document.querySelector('.tb-co').textContent`)).includes('견본고침상사'), await js<string>(`document.querySelector('.tb-co').textContent`));
  check('main 로그에는 고친 칸 이름만(값 없음)', /main\.profile_edit.*"fields":"name\.rep\.bizType\.address"/.test(mainLog()) && !/박다라|견본로/.test(mainLog()));
  await press('[data-act=biz-edit]');
  await until('form 2', async () => js<boolean>(`!!document.querySelector('[data-biz-form]')`), 5_000);
  await type('[data-biz-form] [name=bizNo]', '220-81-62517');
  check('번호를 바꾸면 한 줄 안내(홈택스에 로그인한 사업자와 달라질 수 있어요)', await js<boolean>(`(() => { const n = document.querySelector('[data-bizno-note]'); return !n.hidden && n.textContent.includes('홈택스에 로그인한 사업자와 달라질 수 있어요'); })()`));
  await press('[data-act=biz-save]');
  check('조회하지 못하면 저장하지 않고 [맞습니다]·[다시 조회]', await until('confirm', async () => js<boolean>(`!!document.querySelector('[data-biz-confirm=unknown] [data-act=biz-confirm-unverified]') && !!document.querySelector('[data-act=biz-recheck]')`), 5_000) && (await business()).bizNo === '1234567891');
  await press('[data-act=biz-confirm-unverified]');
  check('[맞습니다] → 새 번호로 저장', await until('saved no', async () => (await business()).bizNo === '2208162517' && js<boolean>(`!!document.querySelector('[data-biz-card=view]')`), 5_000), await business());
  await js(`document.querySelector('#rail [data-view="activity"], #rail button[aria-label="활동 기록"]')?.click()`);
  check('활동 기록에 "내 사업장 수정 · 사업자번호", "… 상호·대표자·업태·주소"', await until('activity', async () => js<boolean>(`(() => { const t = document.querySelector('section[data-view=activity]')?.textContent ?? ''; return t.includes('내 사업장 수정 · 사업자번호') && t.includes('내 사업장 수정 · 상호·대표자·업태·주소'); })()`), 5_000), await js(`document.querySelector('#center')?.innerText`));
  const edits = readFileSync(path.join(paths.userData, 'profile-edits.json'), 'utf8');
  check('고친 기록 파일에 값이 없다', !/박다라|견본|2208162517|서울/.test(edits) && edits.includes('"bizNo"'), edits);
  await js(`(document.querySelector('#rail [data-view="settings"]')?.click(), setTimeout(() => document.querySelector('[data-set-tab="biz"]')?.click(), 50))`);
  await until('biz view 2', async () => js<boolean>(`!!document.querySelector('[data-biz-card=view]')`), 5_000);
  S!.win.webContents.sendInputEvent({ type: 'mouseUp', x: 1, y: 1, button: 'left', clickCount: 1 });
  await sleep(30);
  await js(`[...document.querySelectorAll('[data-biz-card=view] .sx-copy')].find((b) => b.textContent === '바꾸기').click()`);
  check('[바꾸기] → 대화 끝에 O-03 발급 인증', await until('reopen auth 2', async () => (await onbStep()) === 'auth'));
  await press('[data-onb=later]');
  await until('redo done 2', async () => js<boolean>(`!document.querySelector('[data-onb-step]')`) );
  check('[나중에] → 그 전 인증 그대로(간편인증), 할 일 없음', (await business()).signMethod === 'simple_auth' && (await business()).bizNo === '2208162517' && !(await js<boolean>(`!!document.querySelector('[data-setup-needed]:last-of-type [data-act=setup-auth]')`)));

  await js(`document.querySelector('#rail [data-view="settings"]')?.click()`);
  await until('settings', async () => js<boolean>(`!!document.querySelector('[data-set-tab=devices]')`), 5_000);
  await js(`document.querySelector('[data-set-tab=devices]').click()`);
  check('설정 > 계정: 로그인한 이메일과 [로그아웃]', await until('account card', async () => js<boolean>(`document.querySelector('[data-account-email]')?.textContent === 'owner@gyeonbon-test.example' && !!document.querySelector('[data-act=account-signout]')`), 10_000));
  await press('[data-act=account-signout]');
  check('[로그아웃] → 닫을 수 없는 로그인 화면(이메일 칸은 채워져 있다)', await until('login again', async () => (await acctScreen()) === 'email' && js<boolean>(`document.querySelector('#app').inert && document.querySelector('.acct-email')?.value === 'owner@gyeonbon-test.example'`), 10_000));
  check('로그아웃 뒤 신원 파일이 없다', !existsSync(path.join(paths.userData, 'remote-identity.json')));
  check('로그아웃 뒤 대화는 main이 받지 않는다(account_required)', (await js<string>(`window.sax.call('request.send', { text: '세금계산서 1000원 끊자', vat: null }).then(() => 'ok', (e) => String(e.message).replace(/^.*Error: /, ''))`)) === 'account_required');
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
