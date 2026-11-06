// 시연 씨앗 e2e(pnpm demo의 견본 데이터): 거래처 9곳·지난 발급 14건(상태 섞임), 문서함 견본 증명서 5장이 실제 가져오기 길로 들어감
// (정상·임박·만료·추정·확인 필요), 목업 서류·지난 발급본 견본 PDF 열기, 거래처 추가·수정, 발급 인증 기본 바꾸기, 화면의 추가 폼.
// 실행: electron apps/desktop/e2e-dist/demo-seed-e2e.js. PDF 열기는 OS 뷰어를 띄우지 않게 바꿔 끼운다. fixture 모드라 앱 폴더·키체인을 쓰지 않는다.
import { readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { app, shell as desktop } from 'electron';
import { syntheticBizNo } from '@sax/db';
import { registerShellSchemes, startShell, type Shell } from '../dist/shell-app.js';
import { DEMO_DEV } from '../dist/demo-dev.js';
import { dayOffset } from '../dist/shell-mock.js';

registerShellSchemes();
const USER_DATA = path.join(app.getPath('temp'), `sax-e2e-seed-${process.pid}`);
app.setPath('userData', USER_DATA);
process.once('exit', () => rmSync(USER_DATA, { recursive: true, force: true, maxRetries: 2 }));
app.on('window-all-closed', () => {});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const results: Array<{ name: string; ok: boolean }> = [];
const check = (name: string, ok: boolean, detail?: unknown) => {
  results.push({ name, ok });
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : ` ${JSON.stringify(detail)}`}`);
};
let S: Shell | undefined;
const js = <T = unknown>(code: string): Promise<T> => S!.win.webContents.executeJavaScript(code) as Promise<T>;
/** 렌더러 호출(셸 페이지의 sax.call). 실패는 오류 코드 문자열로. */
const call = <T = unknown>(method: string, params: Record<string, unknown> = {}) =>
  js<T | string>(`window.sax.call(${JSON.stringify(method)}, ${JSON.stringify(params)}).catch((e) => 'ERR:' + String(e.message).replace(/^.*Error: /, ''))`);
const gesture = () => S!.win.webContents.sendInputEvent({ type: 'mouseUp', x: 1, y: 1, button: 'left', clickCount: 1 });
async function until(what: string, fn: () => Promise<boolean>, ms = 60_000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return true;
    await sleep(100);
  }
  console.log(`  (timeout: ${what})`);
  return false;
}

interface ShellDoc {
  id: string;
  name: string;
  kind: string;
  docName: string;
  expiresOn: string | null;
  vault?: { expirySource: string | null; needsUser: boolean; docType: string };
}

async function main(): Promise<void> {
  const opened: string[] = [];
  desktop.openPath = (async (p: string) => (opened.push(p), '')) as typeof desktop.openPath;
  S = await startShell({ dev: DEMO_DEV, show: false, demoSeed: true });
  await S.ready;
  await until('boot', async () => js<boolean>(`!!document.querySelector('#titlebar .tb-co')`));

  const boot = (await call<{ history: Array<{ status: string; who: string }> | null; counterparties: unknown[] }>('shell.bootstrap')) as { history: Array<{ status: string; who: string }>; counterparties: unknown[] };
  check('견본 거래처 9곳(기본 3 + 견본 6)', boot.counterparties.length === 9, boot.counterparties.length);
  const st = new Set(boot.history?.map((x) => x.status));
  check('지난 발급 14건, 완료·확인 필요·중지가 섞임', boot.history?.length === 14 && st.has('done') && st.has('attention') && st.has('stopped'), boot.history?.length);
  check('제목줄에 견본 데이터 표시', (await js<string>(`document.querySelector('.mock-badge')?.textContent ?? ''`)).includes('견본'));

  const listDocs = async () => (await call<ShellDoc[]>('docs.list')) as ShellDoc[];
  // 씨앗 끝: 보관함 증명서 5장 + 견본 PDF(지난 발급본 13장, 목업 서류 2장)
  await until('seed fill', async () => S!.store.files.size >= 15 && (await listDocs()).filter((d) => d.vault).length >= 5, 90_000);
  const docs = await listDocs();
  const vault = docs.filter((d) => d.vault);
  const today = dayOffset(0);
  const taxes = vault.filter((d) => d.vault!.docType === 'national_tax_cert');
  check('견본 증명서 5장이 보관함에 들어감(가져오기 길)', vault.length === 5, vault.map((d) => d.name));
  check('납세증명서 정상(D-26)·임박(D-4)·만료가 문서에서 읽힘', taxes.length === 3 && taxes.some((d) => d.expiresOn === dayOffset(26)) && taxes.some((d) => d.expiresOn === dayOffset(4)) && taxes.some((d) => !!d.expiresOn && d.expiresOn < today) && taxes.every((d) => d.vault!.expirySource === 'document'), taxes.map((d) => [d.expiresOn, d.vault]));
  check('사업자등록증명은 규칙 추정, 지방세 납세증명은 확인 필요', vault.some((d) => d.vault!.docType === 'biz_registration_cert' && d.vault!.expirySource === 'rule') && vault.some((d) => d.vault!.needsUser), vault.map((d) => d.vault));
  const invoices = docs.filter((d) => d.kind === '세금계산서');
  check('지난 발급본(완료·확인 필요 13건)이 문서함 세금계산서로', invoices.length === 13, invoices.length);

  gesture();
  await sleep(30);
  check('지난 발급본 견본 PDF 열기', (await call('docs.open', { id: invoices[0]!.id })) !== null && opened.length === 1 && readFileSync(opened[0]!).subarray(0, 5).toString() === '%PDF-', opened);
  gesture();
  await sleep(30);
  await call('docs.open', { id: vault[0]!.id });
  check('보관함 견본 증명서 열기', opened.length === 2 && opened[1]!.endsWith('.pdf'), opened);
  const reveal = desktop.showItemInFolder;
  const revealed: string[] = [];
  desktop.showItemInFolder = (p: string) => void revealed.push(p);
  gesture();
  await sleep(30);
  await call('docs.reveal', { id: invoices[0]!.id });
  desktop.showItemInFolder = reveal;
  check('폴더 열기(Finder에서 보여 주기)', revealed[0] === opened[0], revealed);

  const bizNo = syntheticBizNo(777);
  const made = (await call<{ id: string; counterparties: Array<{ id: string; name: string; item: string }> }>('counterparty.save', { name: '견본테스트상회', bizNo, rep: '홍견본', email: 'test@gyeonbon-test.example', item: '시험 품목' })) as { id: string; counterparties: Array<{ id: string; name: string; item: string }> };
  check('거래처 추가(데모 DB)', made.counterparties?.length === 10 && made.counterparties.some((c) => c.id === made.id && c.item === '시험 품목'), made);
  const upd = (await call<{ counterparties: Array<{ id: string; name: string }> }>('counterparty.save', { id: made.id, name: '견본테스트상회(수정)', rep: '홍견본', email: 'test@gyeonbon-test.example', item: '시험 품목' })) as { counterparties: Array<{ id: string; name: string }> };
  check('거래처 수정', upd.counterparties?.find((c) => c.id === made.id)?.name === '견본테스트상회(수정)', upd);
  check('틀린 사업자번호·중복은 거부', (await call('counterparty.save', { name: 'x', bizNo: '1234567890' })) === 'ERR:invalid_biz_no' && (await call('counterparty.save', { name: 'x', bizNo })) === 'ERR:duplicate_biz_no');
  const auth = (await call<{ profiles: { business: { auth: string } } }>('auth.setDefault', { kind: 'card' })) as { profiles: { business: { auth: string } } };
  check('발급 인증 기본 바꾸기(데모 DB)', auth.profiles?.business.auth === '보안카드', auth);
  await call('auth.setDefault', { kind: 'simple' });

  // 화면: 거래처 화면의 [거래처 추가] → 폼 → [추가]
  await js(`document.querySelector('#rail [data-view="cps"], #rail button[aria-label="거래처"]')?.click()`);
  await until('cps view', async () => js<boolean>(`!!document.querySelector('[data-act=cp-add]')`), 5_000);
  await js(`document.querySelector('[data-act=cp-add]').click()`);
  await until('form', async () => js<boolean>(`!!document.querySelector('.cp-form')`), 5_000);
  await js(`(() => { const f = document.querySelector('.cp-form'); f.name.value = '견본화면상사'; f.bizNo.value = ${JSON.stringify(syntheticBizNo(778))}; f.email.value = 'ui@gyeonbon-test.example'; f.requestSubmit(); })()`);
  check('화면에서 거래처 추가 → 상세 패널·목록', await until('cp added', async () => js<boolean>(`document.querySelector('[data-panel-cp] .sx-card-title')?.textContent === '견본화면상사' && [...document.querySelectorAll('[data-cp-row]')].length === 11`), 5_000));
}

app.whenReady().then(async () => {
  try {
    await main();
  } catch (e) {
    check('e2e 예외 없음', false, (e as Error).stack);
  }
  await S?.close().catch(() => {});
  app.exit(results.length && results.every((r) => r.ok) ? 0 : 1);
});
