// 셸 문서함 e2e(PoC-8 후속): 데모 셸의 문서함에서 PDF 가져오기 → docparse 샌드박스 → 셸 엔진(fixture 모드, 임시 앱 폴더)의 보관함
// → 목록·만료 출처·확인 필요 → 문서 패널에서 확인(후보 넣기, 바뀐 칸만 보냄). 열기 암호 흐름, 중복·실패·다른 화면에 있을 때,
// 렌더러가 대화상자 없이 가져오기를 부르는 경로도 본다. PDF 열기는 OS 뷰어를 띄우지 않게 바꿔 끼운다.
// 실행: electron apps/desktop/dist/shell-docs-e2e.js → reports/raw/poc-8-shell-docs.json, reports/raw/poc-8/shell-docs.png. 앱 폴더·키체인을 쓰지 않는다(fixture 모드).
import { rmSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { app, BrowserWindow, dialog, shell as desktop } from 'electron';
import { formatBizNo } from '@sax/db';
import { appPaths } from '@sax/platform';
import type { EngineHost } from './engine-host.ts';
import { DEMO_PROFILE } from './fixture-mode.ts';
import { registerShellSchemes, startShell, type Shell } from './shell-app.ts';
import { engineDocsProvider, type DocsProvider } from './shell-docs.ts';
import { encryptedTestPdf, syntheticCerts } from './synthetic-certs.ts';
import { importPdf, type EngineCall } from './vault-import.ts';

registerShellSchemes();
// 시험용 앱 폴더(데모 공급자 폴더 이름 sax-shell-docs-*와 겹치지 않게). 끝나면 지운다.
const USER_DATA = path.join(app.getPath('temp'), `sax-e2e-docs-${process.pid}`);
app.setPath('userData', USER_DATA);
process.once('exit', () => rmSync(USER_DATA, { recursive: true, force: true, maxRetries: 2 }));
app.on('window-all-closed', () => {});

const OUT = path.resolve(import.meta.dirname, '../../../reports/raw');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const results: Array<{ name: string; ok: boolean; detail?: unknown }> = [];
const check = (name: string, ok: boolean, detail?: unknown) => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : ` ${JSON.stringify(detail)}`}`);
};
let S: Shell | undefined;
const js = <T = unknown>(code: string): Promise<T> => S!.win.webContents.executeJavaScript(code) as Promise<T>;
async function until(what: string, fn: () => Promise<boolean>, ms = 60_000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return true;
    await sleep(50);
  }
  console.log(`  (timeout: ${what})`);
  return false;
}

async function htmlToPdf(html: string): Promise<Buffer> {
  const w = new BrowserWindow({ show: false, webPreferences: { sandbox: true, javascript: false } });
  try {
    await w.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
    return Buffer.from(await w.webContents.printToPDF({ pageSize: 'A4', printBackground: true, preferCSSPageSize: true }));
  } finally {
    w.destroy();
  }
}

/** 파일 고르기 대화상자를 정해진 파일로 바꾼다. delay만큼 기다렸다 돌려주고, 'throw'면 대화상자가 실패한다. */
function pickNext(file: string | null | 'throw', delay = 0): void {
  dialog.showOpenDialog = (async () => {
    await sleep(delay);
    if (file === 'throw') throw new Error('dialog_failed');
    return file ? { canceled: false, filePaths: [file] } : { canceled: true, filePaths: [] };
  }) as typeof dialog.showOpenDialog;
}

type DocRow = { id: string; name: string; issuedOn: string | null; expiresOn: string | null; vault?: { expirySource: string | null; needsUser: boolean; reasons: string[]; subjectMismatch: boolean; suggested: { validUntil?: string } } };
const listDocs = () => js<DocRow[]>(`window.sax.call('docs.list')`);
const rowText = (id: string) => js<string>(`document.querySelector('[data-doc-row="${id}"]')?.textContent ?? ''`);
const toastText = () => js<string>(`(() => { const t = document.querySelector('#toast'); return t && !t.hidden ? t.textContent : ''; })()`);
const busy = () => js<boolean>(`document.querySelector('[data-act=doc-import]')?.disabled ?? false`);
/** 메인 창에 실제 입력 하나(main의 before-mouse-event가 본다). 짝 없는 mouseUp이라 아무것도 누르지 않는다. 대화상자·뷰어는 3초 안의 입력 뒤에만 열린다(ADR-027 결정 8). */
const gesture = () => S!.win.webContents.sendInputEvent({ type: 'mouseUp', x: 1, y: 1, button: 'left', clickCount: 1 });
const importClick = async () => {
  gesture();
  await sleep(30);
  await js(`document.querySelector('#toast').hidden = true; document.querySelector('[data-act=doc-import]').click()`);
  await until('import done', async () => !(await busy()));
};
/** 가져오기 뒤 새로 생긴 서류(목록에 없던 id) */
async function importNew(file: string): Promise<DocRow | undefined> {
  const before = new Set((await listDocs()).map((d) => d.id));
  pickNext(file);
  await importClick();
  return (await listDocs()).find((d) => !before.has(d.id));
}
const review = (id: string, sel: string) => `document.querySelector('[data-doc-review="${id}"] ${sel}')`;
/** 확인 구역을 만든 직후에는 확인 버튼이 잠시 꺼져 있다. 켜지면 누른다. */
async function confirmWhenReady(id: string, clicks = 1): Promise<void> {
  await until('confirm enabled', async () => js<boolean>(`${review(id, '[data-act=doc-confirm]')}?.disabled === false`), 5000);
  await js(`(() => { const b = ${review(id, '[data-act=doc-confirm]')}; for (let i = 0; i < ${clicks}; i++) b.click(); })()`);
}

async function main(): Promise<void> {
  const tmp = await fs.mkdtemp(path.join(app.getPath('temp'), 'sax-e2e-docs-files-'));
  const mine = DEMO_PROFILE.bizNo; // fixture 엔진의 내 사업장
  const certs = syntheticCerts();
  const taxes = certs.filter((c) => c.kind === 'national_tax_cert');
  const bizs = certs.filter((c) => c.kind === 'biz_registration_cert');
  const tax = taxes[0]!;
  const biz = bizs[0]!;
  const asMine = (html: string, bizNo: string) => html.replace(formatBizNo(bizNo), formatBizNo(mine));
  // 납세증명서는 데모 사업장 번호로(대상 일치), 사업자등록증명은 다른 번호 그대로(다른 사업자 → 확인 필요).
  // amb: 유효기간 줄이 둘(서로 다른 날짜) → 엔진은 발급일 이후 가장 이른 문서 후보를 잠정 만료일로(규칙 30일보다 이르므로), 확인 필요.
  const AMB_VALID = '2026-10-20';
  const files = { tax: path.join(tmp, 'tax.pdf'), biz: path.join(tmp, 'biz.pdf'), amb: path.join(tmp, 'amb.pdf'), biz2: path.join(tmp, 'biz2.pdf'), locked: path.join(tmp, 'locked.pdf') };
  await fs.writeFile(files.tax, await htmlToPdf(asMine(tax.html, tax.expected.bizNo!)));
  await fs.writeFile(files.biz, await htmlToPdf(biz.html));
  const ambHtml = asMine(tax.html, tax.expected.bizNo!).replace('<tr><th>증명서의 유효기간을 정한 사유</th>', '<tr><th>유효기간</th><td colspan="2">2026년 10월 20일</td></tr><tr><th>증명서의 유효기간을 정한 사유</th>');
  if (ambHtml === asMine(tax.html, tax.expected.bizNo!)) throw new Error('amb html unchanged');
  await fs.writeFile(files.amb, await htmlToPdf(ambHtml));
  await fs.writeFile(files.biz2, await htmlToPdf(asMine(bizs[1]!.html, bizs[1]!.expected.bizNo!)));
  await fs.writeFile(files.locked, encryptedTestPdf('shell-pw', 'owner', 'PASSWORD PROTECTED SHELL DOCUMENT FOR THE DOCS VIEW TEST'));

  // 데모 공급자를 직접 넘기고, 셸이 보내는 수정 칸을 적는다(바뀐 칸만 보내는지)
  // 셸 엔진(fixture 모드: 임시 앱 폴더의 DB·보관함)을 쓰는 공급자를 감싸 넘긴다. 엔진 호스트는 startShell 안에서 생기므로 나중에 잇는다.
  let host: EngineHost | null = null;
  const engine: EngineCall = (m, p) => host!.rpc(m, p);
  const base = engineDocsProvider(engine, importPdf);
  let vaultDir = '';
  const patches: Array<Record<string, unknown>> = [];
  const seens: unknown[] = [];
  const pickIds: string[] = [];
  const docs: DocsProvider = {
    ...base,
    importPdf: async (params) => {
      const r = await base.importPdf(params);
      const pickId = (r as { pickId?: string } | null)?.pickId;
      if (pickId) pickIds.push(pickId);
      return r;
    },
    update: (id, patch, seen) => {
      patches.push(Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)));
      seens.push(seen);
      return base.update(id, patch, seen);
    },
    // 'evil': 보관함 경로가 PDF가 아닌 경우(main이 열지 않아야 한다)
    filePath: (id) => (id === 'evil' ? Promise.resolve(path.join(vaultDir, 'evil.app')) : base.filePath(id)),
  };
  const opened: string[] = [];
  desktop.openPath = (async (p: string) => (opened.push(p), '')) as typeof desktop.openPath;

  S = await startShell({ width: 1280, height: 820, show: false, docs });
  host = S.host;
  vaultDir = appPaths(S.fixture!.root).vault;
  await S.ready;
  await until('shell ready', async () => (await js<string>(`document.body.dataset.ready ?? ''`)) === '1', 15_000);
  const mockCount = (await listDocs()).length;
  await js(`document.querySelector('#rail [data-view=docs]').click()`);
  await until('docs view', async () => js<boolean>(`!!document.querySelector('[data-act=doc-import]')`), 5000);

  const noPick = await js<string>(`window.sax.call('docs.import', {}).then(() => 'ok', (e) => String(e.message).replace(/^.*Error: /, ''))`);
  check('렌더러가 pick 없이 부르면 대화상자를 열지 않고 거부한다', noPick === 'bad_request', noPick);
  const noGesture = await js<string>(`window.sax.call('docs.import', { pick: true }).then(() => 'ok', (e) => String(e.message).replace(/^.*Error: /, ''))`);
  check('실제 입력 없이 온 pick은 대화상자를 열지 않는다(gesture_required)', noGesture === 'gesture_required', noGesture);
  pickNext(null, 400);
  gesture();
  await sleep(30);
  const twice = await js<string[]>(`Promise.all([1, 2].map(() => window.sax.call('docs.import', { pick: true }).then(() => 'ok', (e) => String(e.message).replace(/^.*Error: /, ''))))`);
  check('가져오기는 한 번에 하나(겹친 호출은 busy)', twice.includes('ok') && twice.includes('busy'), twice);

  pickNext(null);
  await importClick();
  check('고르기를 취소하면 아무것도 넣지 않는다', (await listDocs()).length === mockCount);

  pickNext('throw', 300);
  gesture();
  await sleep(30);
  await js(`document.querySelector('[data-act=doc-import]').click()`);
  check('가져오는 동안 가져오기 버튼을 막는다', await busy());
  await until('dialog failed', async () => !(await busy()));
  check('대화상자가 실패하면 알리고 버튼이 다시 열린다', (await listDocs()).length === mockCount && !(await busy()) && (await toastText()) !== '', await toastText());

  const t = await importNew(files.tax);
  check('납세증명서: 보관함에 들어가고 문서에서 읽은 만료일, 확인 필요 없음', !!t && t.issuedOn === tax.expected.issuedOn && t.expiresOn === tax.expected.validUntil && t.vault!.expirySource === 'document' && !t.vault!.needsUser, t);
  check('목록 행: 만료 D-n 옆에 출처(문서)', !!t && (await rowText(t.id)).includes('문서'), t && (await rowText(t.id)));
  check('가져온 서류의 패널이 열리고 확인 구역이 보인다', !!t && (await js<boolean>(`document.querySelector('[data-doc-review="${t.id}"]')?.offsetParent != null`)));

  const n0 = (await listDocs()).length;
  pickNext(files.tax);
  await importClick();
  check('같은 파일을 다시 가져오면 중복을 알리고 늘지 않는다', (await listDocs()).length === n0 && /이미 보관함에/.test(await toastText()), await toastText());

  const b = await importNew(files.biz);
  check('사업자등록증명(다른 사업자): 90일 추정, 확인 필요(subject_mismatch)', !!b && b.vault!.expirySource === 'rule' && b.vault!.needsUser && b.vault!.reasons.includes('subject_mismatch'), b);
  check('목록 행: 확인 필요 표시와 추정 표시', !!b && /확인 필요/.test(await rowText(b.id)) && /추정/.test(await rowText(b.id)), b && (await rowText(b.id)));
  check('확인 필요 서류가 목록 맨 위', (await js<string>(`document.querySelector('section[data-view=docs] tbody tr')?.getAttribute('data-doc-row') ?? ''`)) === b?.id);
  await js(`document.querySelector('[data-doc-row="${b!.id}"]').click()`);
  await until('review panel', async () => js<boolean>(`!!${review(b!.id, '[data-act=doc-confirm]')}`), 5000);
  check('확인 구역을 연 직후에는 확인 버튼이 잠시 꺼져 있다', await js<boolean>(`${review(b!.id, '[data-act=doc-confirm]')}.disabled`));
  await confirmWhenReady(b!.id);
  await until('confirmed', async () => !(await listDocs()).find((d) => d.id === b!.id)?.vault?.needsUser, 5000);
  const b2 = (await listDocs()).find((d) => d.id === b!.id);
  check('문서 패널에서 바꾸지 않고 확인하면 확인함(대상 표시는 남음)', !!b2 && !b2.vault!.needsUser && b2.vault!.expirySource === 'user' && b2.vault!.subjectMismatch, b2);
  check('바꾸지 않은 확인은 빈 수정으로 보낸다', JSON.stringify(patches.at(-1)) === '{}', patches.at(-1));
  await until('row updated', async () => !/확인 필요/.test(await rowText(b!.id)), 5000);
  check('목록 행에서 확인 필요가 사라지고 확인함 표시', /확인함/.test(await rowText(b!.id)) && !/확인 필요/.test(await rowText(b!.id)), await rowText(b!.id));

  const a = await importNew(files.amb);
  check('유효기간 줄이 둘인 납세증명서: 규칙보다 이른 문서 후보를 잠정 만료일로(짧은 쪽), 확인 필요', !!a && a.expiresOn === AMB_VALID && a.vault!.expirySource === 'document' && a.vault!.needsUser && a.vault!.reasons.includes('valid_until_ambiguous') && a.vault!.suggested.validUntil === AMB_VALID, a);
  check('목록 행: 확인 필요 서류의 만료일은 추정', !!a && /추정/.test(await rowText(a.id)), a && (await rowText(a.id)));
  const field = (f: string) => js<string>(`${review(a!.id, `[data-field=${f}]`)}?.value ?? ''`);
  const setField = (f: string, v: string) => js(`(() => { const i = ${review(a!.id, `[data-field=${f}]`)}; i.value = '${v}'; i.dispatchEvent(new Event('input')); })()`);

  // 두 번 누르기: 발급일을 고쳐 확인을 연달아 누르고, 응답 뒤 새로 그린 확인 버튼도 바로 누른다 → 한 번만 보내고 재계산 값은 확인 필요로 남는다
  await setField('issuedOn', '2026-10-02');
  const p0 = patches.length;
  await confirmWhenReady(a!.id, 2);
  // 첫 클릭이 보낸 것이어야 한다(다른 서류의 직전 저장이 이 서류의 클릭을 막지 않는다)
  const firstSent = await until('saved once', async () => patches.length > p0 && (await listDocs()).find((d) => d.id === a!.id)?.issuedOn === '2026-10-02', 3000);
  await js(`${review(a!.id, '[data-act=doc-confirm]')}.click()`);
  await sleep(300);
  const a1 = (await listDocs()).find((d) => d.id === a!.id);
  check('확인을 두 번 눌러도 한 번만 보내고, 바로 다음 클릭은 받지 않는다(재계산 값이 확인되지 않음)', firstSent && patches.length === p0 + 1 && JSON.stringify(patches.at(-1)) === JSON.stringify({ issuedOn: '2026-10-02' }) && !!a1 && a1.issuedOn === '2026-10-02' && a1.vault!.needsUser, { firstSent, sent: patches.slice(p0), a1 });
  check('보낼 때 화면이 보여 준 값(seen)을 붙인다', JSON.stringify(seens.at(-1)) === JSON.stringify({ docType: 'national_tax_cert', issuedOn: a!.issuedOn, expiresOn: AMB_VALID }), seens.at(-1));
  const stale = await js<string>(`window.sax.call('docs.update', { id: '${a!.id}', patch: {}, seen: ${JSON.stringify({ docType: 'national_tax_cert', issuedOn: a!.issuedOn, expiresOn: AMB_VALID })} }).then(() => 'ok', (e) => String(e.message).replace(/^.*Error: /, ''))`);
  const noSeen = await js<string>(`window.sax.call('docs.update', { id: '${a!.id}', patch: {} }).then(() => 'ok', (e) => String(e.message).replace(/^.*Error: /, ''))`);
  check('옛 화면 값으로 보낸 확인은 stale, 본 값 없이 보내면 seen_required', stale === 'stale' && noSeen === 'seen_required', { stale, noSeen });

  // 후보: 칸 값이 문서 후보와 다르면(칸이 차 있어도) 보여 주고, 후보 넣기로 칸에 넣는다
  await setField('expiresOn', '2026-10-25');
  await js(`(() => { const s = ${review(a!.id, '[data-field=docType]')}; s.dispatchEvent(new Event('change')); })()`);
  const hint = await js<string>(`${review(a!.id, '[data-doc-hint]')}?.textContent ?? ''`);
  check('만료일 칸이 차 있어도 문서 후보와 다르면 후보를 보여 준다', (await field('expiresOn')) === '2026-10-25' && hint.includes(AMB_VALID), { hint });
  // 입력 중인 값은 다시 그려도 남는다(요소가 바뀌었는지 표시로 확인)
  await js(`${review(a!.id, '[data-field=issuedOn]')}.dataset.old = '1'`);
  await setField('issuedOn', '2026-10-03');
  await js(`${review(a!.id, '[data-field=docType]')}.dispatchEvent(new Event('change'))`);
  check('다시 그려도 입력 중인 발급일이 남는다', (await js<boolean>(`!${review(a!.id, '[data-field=issuedOn]')}.dataset.old`)) && (await field('issuedOn')) === '2026-10-03');
  // 저장값이 있는 날짜 칸을 비운 채(입력하다 만 날짜가 다시 그려져 빈칸이 된 경우 포함) 누르면 보내지 않는다
  await setField('issuedOn', '');
  await js(`${review(a!.id, '[data-field=docType]')}.dispatchEvent(new Event('change'))`);
  await sleep(800); // 저장 직후 확인을 받지 않는 시간이 지난 뒤
  const p1 = patches.length;
  await js(`document.querySelector('#toast').hidden = true; ${review(a!.id, '[data-act=doc-confirm]')}.click()`);
  await sleep(200);
  check('빈 발급일 칸으로는 확인하지 않는다(기존 값이 확인되지 않음)', patches.length === p1 && /발급일을 넣어/.test(await toastText()), await toastText());
  await setField('issuedOn', '2026-10-02');
  await js(`${review(a!.id, '[data-act=doc-use-suggested]')}.click()`);
  check('후보 넣기 → 만료일 칸이 문서 후보로 바뀌고 힌트가 사라진다', (await field('expiresOn')) === AMB_VALID && !(await js<boolean>(`!!${review(a!.id, '[data-doc-hint]')}`)));
  await confirmWhenReady(a!.id);
  await until('amb confirmed', async () => !(await listDocs()).find((d) => d.id === a!.id)?.vault?.needsUser, 5000);
  const a2 = (await listDocs()).find((d) => d.id === a!.id);
  check('바꾼 칸 없이 확인하면 문서 후보 날짜가 확인함이 된다(빈 수정)', !!a2 && a2.expiresOn === AMB_VALID && !a2.vault!.needsUser && a2.vault!.expirySource === 'user' && JSON.stringify(patches.at(-1)) === '{}', { a2, patch: patches.at(-1) });

  // 사업자등록증명 b: 만료일 없음 → 납세증명서로 바꾸면 만료일 칸이 다시 열리고 지우지 않는다. 다른 서류로 옮기면 입력을 버린다.
  await js(`document.querySelector('[data-doc-row="${b!.id}"]').click()`);
  const rb = (sel: string) => review(b!.id, sel);
  await js(`(() => { const c = ${rb('[data-field=noExpiry]')}; c.checked = true; c.dispatchEvent(new Event('change')); })()`);
  const disabledOn = await js<boolean>(`${rb('[data-field=expiresOn]')}.disabled`);
  await js(`(() => { const s = ${rb('[data-field=docType]')}; s.value = 'national_tax_cert'; s.dispatchEvent(new Event('change')); })()`);
  const asTax = await js<{ check: boolean; disabled: boolean }>(`({ check: !!${rb('[data-field=noExpiry]')}, disabled: ${rb('[data-field=expiresOn]')}.disabled })`);
  await js(`(() => { const s = ${rb('[data-field=docType]')}; s.value = 'biz_registration_cert'; s.dispatchEvent(new Event('change')); })()`);
  check('만료일 없음 뒤 납세증명서로 바꾸면 만료일 칸이 열리고, 되돌려도 만료일 없음은 꺼져 있다', disabledOn && !asTax.check && !asTax.disabled && !(await js<boolean>(`${rb('[data-field=noExpiry]')}.checked`)), { disabledOn, asTax });
  await js(`(() => { const i = ${rb('[data-field=expiresOn]')}; i.value = '2026-12-01'; i.dispatchEvent(new Event('input')); })()`);
  await js(`document.querySelector('[data-doc-row="${t!.id}"]').click()`);
  await js(`document.querySelector('[data-doc-row="${b!.id}"]').click()`);
  check('다른 서류로 옮겼다 오면 버린 입력이 되살아나지 않는다', (await js<string>(`${rb('[data-field=expiresOn]')}.value`)) === b2!.expiresOn, await js<string>(`${rb('[data-field=expiresOn]')}.value`));
  await js(`(() => { const i = ${rb('[data-field=expiresOn]')}; i.value = '2026-12-01'; i.dispatchEvent(new Event('input')); })()`);
  await confirmWhenReady(b!.id);
  await until('b expiry set', async () => (await listDocs()).find((d) => d.id === b!.id)?.expiresOn === '2026-12-01', 5000);
  check('바뀐 칸(만료일)만 보낸다', JSON.stringify(patches.at(-1)) === JSON.stringify({ expiresOn: '2026-12-01' }), patches.at(-1));
  // 패널이 열린 채 다른 곳에서 서류가 바뀌면: 확인은 stale로 거부되고, 목록을 다시 읽어 새 값을 보여 주며 확인 버튼은 잠시 꺼진다
  const bNow = (await listDocs()).find((d) => d.id === b!.id)!;
  await base.update(b!.id, { expiresOn: '2026-12-02' }, { docType: 'biz_registration_cert', issuedOn: bNow.issuedOn, expiresOn: bNow.expiresOn });
  await js(`document.querySelector('#toast').hidden = true`);
  await confirmWhenReady(b!.id);
  await until('stale shown', async () => /바뀌었어요/.test(await toastText()), 5000);
  await until('stale refreshed', async () => (await js<string>(`${rb('[data-field=expiresOn]')}?.value ?? ''`)) === '2026-12-02', 5000);
  const afterStale = await js<{ value: string; disabled: boolean }>(`({ value: ${rb('[data-field=expiresOn]')}.value, disabled: ${rb('[data-act=doc-confirm]')}.disabled })`);
  const bAfter = (await listDocs()).find((d) => d.id === b!.id)!;
  check('다른 곳에서 바뀐 서류의 확인은 stale: 알리고 새 값을 보여 주며 바로 확인되지 않는다', afterStale.value === '2026-12-02' && afterStale.disabled && bAfter.expiresOn === '2026-12-02', { afterStale, bAfter: bAfter.expiresOn });
  await js(`document.querySelector('[data-doc-row="${a!.id}"]').click()`);

  gesture();
  await sleep(30);
  await js(`${review(a!.id, '[data-act=doc-open]')}.click()`);
  await until('opened', async () => opened.length > 0, 5000);
  check('PDF 열기: main이 보관함 파일을 연다', opened.length === 1 && path.dirname(opened[0]!) === vaultDir, opened);
  const openErr = await js<string>(`window.sax.call('docs.open', { id: 'nope' }).then(() => 'ok', (e) => String(e.message).replace(/^.*Error: /, ''))`);
  check('없는 서류 열기는 거부(not_found)', openErr === 'not_found', openErr);
  const evil = await js<string>(`window.sax.call('docs.open', { id: 'evil' }).then(() => 'ok', (e) => String(e.message).replace(/^.*Error: /, ''))`);
  check('보관함 경로가 PDF가 아니면 열지 않는다', evil === 'open_failed' && opened.length === 1, { evil, opened });

  // 읽는 동안 다른 화면으로 가면 끝나도 문서함·서류 패널로 끌고 오지 않는다
  const nBefore = (await listDocs()).length;
  pickNext(files.biz2, 400);
  gesture();
  await sleep(30);
  await js(`document.querySelector('#toast').hidden = true; document.querySelector('[data-act=doc-import]').click()`);
  await js(`document.querySelector('#rail [data-view=chat]').click()`);
  await until('away import', async () => (await listDocs()).length === nBefore + 1, 30_000);
  await until('away toast', async () => /문서함에서 볼 수 있어요/.test(await toastText()), 5000);
  const away = await js<{ on: string | null; review: boolean }>(`({ on: document.querySelector('#rail .is-on')?.getAttribute('data-view') ?? null, review: !!document.querySelector('[data-doc-review]') })`);
  check('다른 화면에 있을 때 끝나면 알리기만 한다', away.on === 'chat' && !away.review && /문서함에서 볼 수 있어요/.test(await toastText()), { away, toast: await toastText() });
  await js(`document.querySelector('#rail [data-view=docs]').click()`);
  await until('docs view again', async () => js<boolean>(`!!document.querySelector('[data-act=doc-import]')`), 5000);

  pickNext(files.locked);
  await importClick();
  check('열기 암호 PDF: 암호 줄이 뜬다', await js<boolean>(`!!document.querySelector('[data-doc-password]')`));
  const pending = pickIds.at(-1);
  pickNext(null);
  await importClick();
  const dropped = await js<string>(`window.sax.call('docs.import', { pickId: '${pending}', password: 'shell-pw' }).then(() => 'ok', (e) => String(e.message).replace(/^.*Error: /, ''))`);
  check('암호를 묻는 중에 새로 가져오기를 누르면 묻던 파일은 그만둔다(main도 버림)', !(await js<boolean>(`!!document.querySelector('[data-doc-password]')`)) && !!pending && dropped === 'pick_expired', { pending, dropped });
  pickNext(files.locked);
  await importClick();
  await js(`(() => { const i = document.querySelector('.doc-pw'); i.value = 'wrong'; i.dispatchEvent(new Event('input')); document.querySelector('[data-act=doc-password]').click(); })()`);
  await until('wrong pw', async () => js<boolean>(`/맞지 않아요/.test(document.querySelector('[data-doc-password]')?.textContent ?? '')`), 30_000);
  check('틀린 암호 → 다시 묻고 넣었던 암호는 비운다', await js<boolean>(`/맞지 않아요/.test(document.querySelector('[data-doc-password]')?.textContent ?? '') && document.querySelector('.doc-pw').value === ''`));
  const before = (await listDocs()).length;
  const locked = await js<{ open: boolean; cancel: boolean }>(
    `(() => { const i = document.querySelector('.doc-pw'); i.value = 'shell-pw'; i.dispatchEvent(new Event('input')); document.querySelector('[data-act=doc-password]').click(); return { open: document.querySelector('[data-act=doc-password]')?.disabled, cancel: document.querySelector('[data-act=doc-password-cancel]')?.disabled }; })()`,
  );
  check('암호로 읽는 동안 열기·그만두기를 막는다', locked.open === true && locked.cancel === true, locked);
  await until('locked imported', async () => (await listDocs()).length === before + 1, 60_000);
  check('맞는 암호 → 보관하고 암호 줄이 사라진다', (await listDocs()).length === before + 1 && !(await js<boolean>(`!!document.querySelector('[data-doc-password]')`)));

  const vaultFiles = await fs.readdir(vaultDir);
  check('보관함 파일 5개, 이름에 PII 없음', vaultFiles.length === 5 && vaultFiles.every((f) => /^(national_tax_cert|biz_registration_cert|other)_\d{8}_[0-9A-Z]{4}\.pdf$/.test(f)), vaultFiles);
  const sweepDocs = await js<string>(`window.sax.call('docs.update', { id: 'run-x', patch: {} }).then(() => 'ok', (e) => String(e.message).replace(/^.*Error: /, ''))`);
  check('없는 서류 수정은 거부(not_found)', sweepDocs === 'not_found', sweepDocs);

  await js(`document.querySelector('[data-doc-row="${a!.id}"]').click()`);
  await sleep(300);
  await fs.mkdir(path.join(OUT, 'poc-8'), { recursive: true });
  await fs.writeFile(path.join(OUT, 'poc-8', 'shell-docs.png'), (await S!.win.webContents.capturePage()).toPNG());
  const final = (await listDocs()).filter((d) => d.vault);
  await fs.writeFile(
    path.join(OUT, 'poc-8-shell-docs.json'),
    JSON.stringify({ checks: results, docs: final.map((d) => ({ name: d.name, issuedOn: d.issuedOn, expiresOn: d.expiresOn, vault: { expirySource: d.vault!.expirySource, needsUser: d.vault!.needsUser, reasons: d.vault!.reasons } })) }, null, 2),
  );
  await fs.rm(tmp, { recursive: true, force: true });
}

app.whenReady().then(async () => {
  try {
    await main();
  } catch (e) {
    check('e2e 예외 없음', false, (e as Error).stack);
  }
  // 엔진이 끝난 뒤 fixture 임시 앱 폴더(DB·보관함 사본)를 지운다
  await S?.close().catch(() => {});
  app.exit(results.length && results.every((r) => r.ok) ? 0 : 1);
});
