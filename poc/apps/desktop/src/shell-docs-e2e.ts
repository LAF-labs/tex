// 셸 문서함 e2e(PoC-8 후속): 데모 셸의 문서함에서 PDF 가져오기 → docparse 샌드박스 → 보관함(데모 공급자 = 엔진 DocumentService)
// → 목록·만료 출처·확인 필요 → 문서 패널에서 확인(후보 넣기, 바뀐 칸만 보냄). 열기 암호 흐름, 중복·실패·다른 화면에 있을 때,
// 렌더러가 대화상자 없이 가져오기를 부르는 경로도 본다. PDF 열기는 OS 뷰어를 띄우지 않게 바꿔 끼운다.
// 실행: electron apps/desktop/dist/shell-docs-e2e.js → reports/raw/poc-8-shell-docs.json, reports/raw/poc-8/shell-docs.png. 앱 폴더·키체인을 쓰지 않는다.
import fs from 'node:fs/promises';
import path from 'node:path';
import { app, BrowserWindow, dialog, shell as desktop } from 'electron';
import { formatBizNo } from '@sax/db';
import { registerShellSchemes, startShell, type Shell } from './shell-app.ts';
import { demoDocsProvider, type DocsProvider } from './shell-docs.ts';
import { PROFILES } from './shell-mock.ts';
import { encryptedTestPdf, syntheticCerts } from './synthetic-certs.ts';
import { importPdf } from './vault-import.ts';

registerShellSchemes();
app.setPath('userData', path.join(app.getPath('temp'), `sax-shell-docs-e2e-${process.pid}`));
app.on('window-all-closed', () => {});

const OUT = path.resolve(import.meta.dirname, '../../../reports/raw');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const results: Array<{ name: string; ok: boolean; detail?: unknown }> = [];
const check = (name: string, ok: boolean, detail?: unknown) => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : ` ${JSON.stringify(detail)}`}`);
};
let S: Shell;
const js = <T = unknown>(code: string): Promise<T> => S.win.webContents.executeJavaScript(code) as Promise<T>;
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
const importClick = async () => {
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

async function main(): Promise<void> {
  const tmp = await fs.mkdtemp(path.join(app.getPath('temp'), 'sax-shell-docs-files-'));
  const mine = PROFILES.business.bizNo!;
  const certs = syntheticCerts();
  const taxes = certs.filter((c) => c.kind === 'national_tax_cert');
  const bizs = certs.filter((c) => c.kind === 'biz_registration_cert');
  const tax = taxes[0]!;
  const biz = bizs[0]!;
  const asMine = (html: string, bizNo: string) => html.replace(formatBizNo(bizNo), formatBizNo(mine));
  // 납세증명서는 데모 사업장 번호로(대상 일치), 사업자등록증명은 다른 번호 그대로(다른 사업자 → 확인 필요).
  // amb: 유효기간 줄이 둘(서로 다른 날짜) → 엔진은 30일 규칙으로 두고 확인 필요, 문서의 가장 이른 날짜를 후보로 준다.
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
  const demo = demoDocsProvider({ profile: PROFILES.business, importer: importPdf });
  const patches: Array<Record<string, unknown>> = [];
  const docs: DocsProvider = {
    ...demo,
    update: (id, patch) => {
      patches.push(Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)));
      return demo.update(id, patch);
    },
  };
  const opened: string[] = [];
  desktop.openPath = (async (p: string) => (opened.push(p), '')) as typeof desktop.openPath;

  S = startShell({ speed: 20, width: 1280, height: 820, show: false, docs });
  await S.ready;
  await until('shell ready', async () => (await js<string>(`document.body.dataset.ready ?? ''`)) === '1', 15_000);
  const mockCount = (await listDocs()).length;
  await js(`document.querySelector('#rail [data-view=docs]').click()`);
  await until('docs view', async () => js<boolean>(`!!document.querySelector('[data-act=doc-import]')`), 5000);

  const noPick = await js<string>(`window.sax.call('docs.import', {}).then(() => 'ok', (e) => String(e.message).replace(/^.*Error: /, ''))`);
  check('렌더러가 pick 없이 부르면 대화상자를 열지 않고 거부한다', noPick === 'bad_request', noPick);

  pickNext(null);
  await importClick();
  check('고르기를 취소하면 아무것도 넣지 않는다', (await listDocs()).length === mockCount);

  pickNext('throw', 300);
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
  await js(`${review(b!.id, '[data-act=doc-confirm]')}.click()`);
  await until('confirmed', async () => !(await listDocs()).find((d) => d.id === b!.id)?.vault?.needsUser, 5000);
  const b2 = (await listDocs()).find((d) => d.id === b!.id);
  check('문서 패널에서 바꾸지 않고 확인하면 확인함(대상 표시는 남음)', !!b2 && !b2.vault!.needsUser && b2.vault!.expirySource === 'user' && b2.vault!.subjectMismatch, b2);
  check('바꾸지 않은 확인은 빈 수정으로 보낸다', JSON.stringify(patches.at(-1)) === '{}', patches.at(-1));
  await until('row updated', async () => !/확인 필요/.test(await rowText(b!.id)), 5000);
  check('목록 행에서 확인 필요가 사라지고 확인함 표시', /확인함/.test(await rowText(b!.id)) && !/확인 필요/.test(await rowText(b!.id)), await rowText(b!.id));

  const a = await importNew(files.amb);
  const ruleExpiry = a?.expiresOn;
  check('유효기간 줄이 둘인 납세증명서: 30일 규칙 추정, 확인 필요, 문서 후보는 가장 이른 날짜', !!a && a.vault!.expirySource === 'rule' && a.vault!.needsUser && a.vault!.reasons.includes('valid_until_ambiguous') && a.vault!.suggested.validUntil === AMB_VALID && !!ruleExpiry && ruleExpiry !== AMB_VALID, a);
  check('목록 행: 확인 필요 서류의 만료일은 추정', !!a && /추정/.test(await rowText(a.id)), a && (await rowText(a.id)));
  const hint = await js<string>(`${review(a!.id, '[data-doc-hint]')}?.textContent ?? ''`);
  const filled = await js<string>(`${review(a!.id, '[data-field=expiresOn]')}?.value ?? ''`);
  check('만료일 칸이 규칙 날짜로 차 있어도 문서 후보를 보여 준다', filled === ruleExpiry && hint.includes(AMB_VALID), { filled, hint });
  // 입력 중인 값은 다시 그려도 남는다(종류를 같은 값으로 바꿔 다시 그리게 한다)
  await js(`(() => { const i = ${review(a!.id, '[data-field=issuedOn]')}; i.value = '2026-10-02'; i.dispatchEvent(new Event('input')); const s = ${review(a!.id, '[data-field=docType]')}; s.dispatchEvent(new Event('change')); })()`);
  check('다시 그려도 입력 중인 발급일이 남는다', (await js<string>(`${review(a!.id, '[data-field=issuedOn]')}.value`)) === '2026-10-02');
  await js(`(() => { const i = ${review(a!.id, '[data-field=issuedOn]')}; i.value = '${a!.issuedOn}'; i.dispatchEvent(new Event('input')); })()`);
  await js(`${review(a!.id, '[data-act=doc-use-suggested]')}.click()`);
  check('후보 넣기 → 만료일 칸이 문서 후보로 바뀌고 힌트가 사라진다', (await js<string>(`${review(a!.id, '[data-field=expiresOn]')}.value`)) === AMB_VALID && !(await js<boolean>(`!!${review(a!.id, '[data-doc-hint]')}`)));
  await js(`${review(a!.id, '[data-act=doc-confirm]')}.click()`);
  await until('amb confirmed', async () => !(await listDocs()).find((d) => d.id === a!.id)?.vault?.needsUser, 5000);
  const a2 = (await listDocs()).find((d) => d.id === a!.id);
  check('확인하면 문서 후보 날짜가 확인함으로 저장된다', !!a2 && a2.expiresOn === AMB_VALID && a2.vault!.expirySource === 'user' && !a2.vault!.needsUser, a2);
  check('바뀐 칸(만료일)만 보낸다', JSON.stringify(patches.at(-1)) === JSON.stringify({ expiresOn: AMB_VALID }), patches.at(-1));

  await js(`${review(a!.id, '[data-act=doc-open]')}.click()`);
  await until('opened', async () => opened.length > 0, 5000);
  check('PDF 열기: main이 보관함 파일을 연다', opened.length === 1 && path.dirname(opened[0]!) === path.join(demo.dir, 'vault'), opened);
  const openErr = await js<string>(`window.sax.call('docs.open', { id: 'nope' }).then(() => 'ok', (e) => String(e.message).replace(/^.*Error: /, ''))`);
  check('없는 서류 열기는 거부(not_found)', openErr === 'not_found', openErr);

  // 읽는 동안 다른 화면으로 가면 끝나도 문서함·서류 패널로 끌고 오지 않는다
  const nBefore = (await listDocs()).length;
  pickNext(files.biz2, 400);
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

  const vaultFiles = await fs.readdir(path.join(demo.dir, 'vault'));
  check('데모 보관함 파일 5개, 이름에 PII 없음', vaultFiles.length === 5 && vaultFiles.every((f) => /^(national_tax_cert|biz_registration_cert|other)_\d{8}_[0-9A-Z]{4}\.pdf$/.test(f)), vaultFiles);
  const sweepDocs = await js<string>(`window.sax.call('docs.update', { id: 'run-x', patch: {} }).then(() => 'ok', (e) => String(e.message).replace(/^.*Error: /, ''))`);
  check('없는 서류 수정은 거부(not_found)', sweepDocs === 'not_found', sweepDocs);

  await js(`document.querySelector('[data-doc-row="${a!.id}"]').click()`);
  await sleep(300);
  await fs.mkdir(path.join(OUT, 'poc-8'), { recursive: true });
  await fs.writeFile(path.join(OUT, 'poc-8', 'shell-docs.png'), (await S.win.webContents.capturePage()).toPNG());
  const final = (await listDocs()).filter((d) => d.vault);
  demo.close?.();
  check('공급자를 닫으면 데모 폴더(DB·PDF 사본)를 지운다', !(await fs.access(demo.dir).then(() => true, () => false)), demo.dir);
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
  app.exit(results.length && results.every((r) => r.ok) ? 0 : 1);
});
