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

  const boot = (await call('shell.bootstrap')) as { past: Array<{ kind: string; who: string; note: string | null }>; counterparties: unknown[] };
  check('견본 거래처 9곳(기본 3 + 견본 6)', boot.counterparties.length === 9, boot.counterparties.length);
  const kinds = new Set(boot.past.map((x) => x.kind));
  check('지난 발급 14건(PastRun), 발급·발급 안 함이 섞이고 메일 미확인 문구가 있다', boot.past.length === 14 && kinds.has('issued') && kinds.has('not_issued') && boot.past.some((x) => x.kind === 'issued' && /메일발송목록/.test(x.note ?? '')), boot.past.length);
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

  await js(`document.querySelector('#rail [data-view="activity"]').click()`);
  await until('activity', async () => js<boolean>(`!!document.querySelector('[data-act-row="past-h0"]')`), 5_000);
  const actRows = await js<number>(`document.querySelectorAll('[data-act-row^="past-"]').length`);
  await js(`document.querySelector('[data-act-row="past-h0"]').click()`);
  await until('past panel', async () => js<boolean>(`!!document.querySelector('[data-panel-act="past-h0"]')`), 5_000);
  const pastPanel = await js<string>(`document.querySelector('[data-panel-act="past-h0"]').innerText`);
  const opens = opened.length;
  gesture();
  await sleep(30);
  await js(`document.querySelector('[data-panel-act="past-h0"] [data-act=past-pdf]')?.click()`);
  await until('past pdf', async () => opened.length > opens, 3_000);
  check('활동 기록: 지난 발급 14줄, 지난 발급 패널에 승인번호 [복사]·[PDF 열기](문서함과 같은 길)', actRows === 14 && /20\d{6}-41000012-00000123/.test(pastPanel) && pastPanel.includes('복사') && opened.at(-1) === S!.store.files.get('d-h0'), { actRows, pastPanel, opened });
  await js(`document.querySelector('#rail [data-view="chat"]').click()`);

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
  await js(`(() => { const f = document.querySelector('.cp-form'); f.name.value = '견본화면상사'; f.bizNo.value = ${JSON.stringify(syntheticBizNo(778))}; f.email.value = 'ui@gyeonbon-test.example'; f.item.value = '화면 품목'; f.requestSubmit(); })()`);
  check('화면에서 거래처 추가 → 상세 패널·목록', await until('cp added', async () => js<boolean>(`document.querySelector('[data-panel-cp] .sx-card-title')?.textContent === '견본화면상사' && [...document.querySelectorAll('[data-cp-row]')].length === 11`), 5_000));
  // 저장 품목 칸 = 엔진 저장 품목의 첫 품목(#144). 다시 읽어도(목록 새로 고침) 같은 값, 비우면 없어진다.
  const uiCp = ((await call<Array<{ id: string; name: string; item: string }>>('counterparties.list', {})) as Array<{ id: string; name: string; item: string }>).find((c) => c.name === '견본화면상사');
  const panelItem = await js<boolean>(`document.querySelector('[data-panel-cp]')?.textContent.includes('화면 품목')`);
  const cleared = (await call<{ counterparties: Array<{ id: string; item: string }> }>('counterparty.save', { id: uiCp?.id, name: '견본화면상사', email: 'ui@gyeonbon-test.example', item: '' })) as { counterparties: Array<{ id: string; item: string }> };
  check('저장 품목: 폼 칸 → 엔진 저장 품목 첫 이름(목록·상세 패널), 비우면 없음', uiCp?.item === '화면 품목' && panelItem && cleared.counterparties.find((c) => c.id === uiCp?.id)?.item === '', { uiCp, panelItem });

  // [등록증으로 채우기](M4-3 O-05): 실제 입력 없이 부르면 gesture_required, 누르면 시연 등록증 후보가 칸에 들어간다(주소는 오지 않는다)
  await sleep(3_100);
  check('등록증 읽기는 실제 입력 뒤에만', (await call('counterparty.readCert', {})) === 'ERR:gesture_required');
  await js(`document.querySelector('[data-act=cp-add]').click()`);
  await until('form 2', async () => js<boolean>(`!!document.querySelector('.cp-form [data-act=cp-cert]')`), 5_000);
  gesture();
  await sleep(30);
  await js(`document.querySelector('.cp-form [data-act=cp-cert]').click()`);
  const filled = await until('cert filled', async () => js<boolean>(`(() => { const f = document.querySelector('.cp-form'); return f.name.value === '견본상사' && f.bizNo.value === '314-86-01237' && f.rep.value === '이견본'; })()`), 5_000);
  check('등록증으로 채우기 → 상호·번호·대표자 후보', filled);
  await js(`document.querySelector('.cp-form').requestSubmit()`);
  check('등록증 후보로 추가', await until('cp cert added', async () => js<boolean>(`document.querySelector('[data-panel-cp] .sx-card-title')?.textContent === '견본상사' && [...document.querySelectorAll('[data-cp-row]')].length === 12`), 5_000));
  const row = ((await S!.host.rpc('db.query.counterparties.list')) as Array<{ bizNo: string; source: string; address: string | null }>).find((c) => c.bizNo === '3148601237');
  check('등록증으로 넣은 거래처는 source ocr·주소(main이 든 값)', row?.source === 'ocr' && row.address === '서울특별시 견본구 시험로 34', row);

  // 내 사업장(D-03) 고치기: 온보딩 기록이 없는 기존 프로필(!onb)도 고친다. [파일에서 읽기]는 온보딩 O-02와 같은 등록증 읽기(시연 등록증).
  const biz = async () => ((await S!.host.rpc('db.query.profiles.list')) as Array<{ kind: string; displayName: string; bizNo: string; repName: string | null; bizType: string | null; bizItem: string | null; address: string | null; signMethod: string | null }>).find((x) => x.kind === 'business')!;
  const before = await biz();
  await js(`document.querySelector('#rail [data-view="biz"], #rail button[aria-label="내 사업장"]')?.click()`);
  check('내 사업장(온보딩 기록 없음): [수정]은 있고 [바꾸기](온보딩 대화)는 없다', await until('biz view', async () => js<boolean>(`!!document.querySelector('[data-biz-card=view] [data-act=biz-edit]') && ![...document.querySelectorAll('[data-biz-card=view] .sx-copy')].some((b) => b.textContent === '바꾸기')`), 5_000));
  await sleep(3_100);
  check('파일에서 읽기도 실제 입력 뒤에만', (await call('profile.readCert', {})) === 'ERR:gesture_required');
  gesture();
  await sleep(30);
  await js(`document.querySelector('[data-act=biz-edit]').click()`);
  await until('biz form', async () => js<boolean>(`!!document.querySelector('[data-biz-form] [data-act=biz-cert]')`), 5_000);
  await js(`(() => { const f = document.querySelector('[data-biz-form]'); for (const k of ['bizType', 'bizItem', 'address']) { f[k].value = ''; f[k].dispatchEvent(new Event('input')); } })()`);
  gesture();
  await sleep(30);
  await js(`document.querySelector('[data-act=biz-cert]').click()`);
  const bizFilled = await until('biz cert filled', async () => js<boolean>(`(() => { const f = document.querySelector('[data-biz-form]'); return !!f && f.bizType.value === '서비스업' && f.bizItem.value === '경영 컨설팅' && f.address.value === '서울특별시 가나구 다라로 12, 3층' && f.bizNo.value === '123-45-67891'; })()`), 5_000);
  check('[파일에서 읽기] → 업태·종목·주소·번호가 칸에 들어간다(아직 저장 안 함)', bizFilled && (await biz()).address === before.address);
  await js(`(() => { const f = document.querySelector('[data-biz-form]'); f.rep.value = '김가나다'; f.rep.dispatchEvent(new Event('input')); })()`);
  gesture();
  await sleep(30);
  await js(`document.querySelector('[data-act=biz-save]').click()`);
  const saved = await until('biz saved', async () => (await biz()).repName === '김가나다' && js<boolean>(`!!document.querySelector('[data-biz-card=view]')`), 5_000);
  const after = await biz();
  check('[저장] → 대표자·등록증 칸 저장, 번호·발급 인증 그대로', saved && after.address === '서울특별시 가나구 다라로 12, 3층' && after.bizType === '서비스업' && after.bizNo === before.bizNo && after.signMethod === before.signMethod, { before, after });
  check('틀린 번호는 main이 거부', (gesture(), await sleep(30), await call('profile.edit', { fields: { bizNo: '123-45-67890' } })) === 'ERR:bad_biz_no');
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
