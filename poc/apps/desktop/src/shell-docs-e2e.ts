// 셸 문서함 e2e(PoC-8 후속): 데모 셸의 문서함에서 PDF 가져오기 → docparse 샌드박스 → 보관함(데모 공급자 = 엔진 DocumentService)
// → 목록·만료 출처·확인 필요 → 문서 패널에서 확인. 열기 암호 흐름, 렌더러가 대화상자 없이 가져오기를 부르는 경로도 본다.
// 실행: electron apps/desktop/dist/shell-docs-e2e.js → reports/raw/poc-8-shell-docs.json, reports/raw/poc-8/shell-docs.png. 앱 폴더·키체인을 쓰지 않는다.
import fs from 'node:fs/promises';
import path from 'node:path';
import { app, BrowserWindow, dialog } from 'electron';
import { formatBizNo } from '@sax/db';
import { registerShellSchemes, startShell, type Shell } from './shell-app.ts';
import { PROFILES } from './shell-mock.ts';
import { encryptedTestPdf, syntheticCerts } from './synthetic-certs.ts';

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

/** 파일 고르기 대화상자를 정해진 파일로 바꾼다(다음 한 번). */
function pickNext(file: string | null): void {
  dialog.showOpenDialog = (async () => (file ? { canceled: false, filePaths: [file] } : { canceled: true, filePaths: [] })) as typeof dialog.showOpenDialog;
}

type DocRow = { id: string; name: string; issuedOn: string | null; expiresOn: string | null; vault?: { expirySource: string | null; needsUser: boolean; reasons: string[]; subjectMismatch: boolean } };
const listDocs = () => js<DocRow[]>(`window.sax.call('docs.list')`);
const rowText = (id: string) => js<string>(`document.querySelector('[data-doc-row="${id}"]')?.textContent ?? ''`);
const importClick = async () => {
  await js(`document.querySelector('[data-act=doc-import]').click()`);
  await until('import done', async () => !(await js<boolean>(`document.querySelector('[data-act=doc-import]')?.disabled ?? false`)));
};

async function main(): Promise<void> {
  const tmp = await fs.mkdtemp(path.join(app.getPath('temp'), 'sax-shell-docs-files-'));
  const mine = PROFILES.business.bizNo!;
  const certs = syntheticCerts();
  const tax = certs.find((c) => c.kind === 'national_tax_cert')!;
  const biz = certs.find((c) => c.kind === 'biz_registration_cert')!;
  // 납세증명서는 데모 사업장 번호로(대상 일치), 사업자등록증명은 다른 번호 그대로(다른 사업자 → 확인 필요)
  const files = { tax: path.join(tmp, 'tax.pdf'), biz: path.join(tmp, 'biz.pdf'), locked: path.join(tmp, 'locked.pdf') };
  await fs.writeFile(files.tax, await htmlToPdf(tax.html.replace(formatBizNo(tax.expected.bizNo!), formatBizNo(mine))));
  await fs.writeFile(files.biz, await htmlToPdf(biz.html));
  await fs.writeFile(files.locked, encryptedTestPdf('shell-pw', 'owner', 'PASSWORD PROTECTED SHELL DOCUMENT FOR THE DOCS VIEW TEST'));

  S = startShell({ speed: 20, width: 1280, height: 820, show: false });
  await S.ready;
  await until('shell ready', async () => (await js<string>(`document.body.dataset.ready ?? ''`)) === '1', 15_000);
  const mockCount = (await listDocs()).length;
  await js(`document.querySelector('[data-view=docs]').click()`);
  await until('docs view', async () => js<boolean>(`!!document.querySelector('[data-act=doc-import]')`), 5000);

  const noPick = await js<string>(`window.sax.call('docs.import', {}).then(() => 'ok', (e) => String(e.message).replace(/^.*Error: /, ''))`);
  check('렌더러가 pick 없이 부르면 대화상자를 열지 않고 거부한다', noPick === 'bad_request', noPick);

  pickNext(null);
  await importClick();
  check('고르기를 취소하면 아무것도 넣지 않는다', (await listDocs()).length === mockCount);

  pickNext(files.tax);
  await importClick();
  let docs = await listDocs();
  const t = docs.find((d) => d.vault && d.name === '납세증명서(국세)');
  check('납세증명서: 보관함에 들어가고 문서에서 읽은 만료일, 확인 필요 없음', !!t && t.issuedOn === tax.expected.issuedOn && t.expiresOn === tax.expected.validUntil && t.vault!.expirySource === 'document' && !t.vault!.needsUser, t);
  check('목록 행: 만료 D-n 옆에 출처(문서)', !!t && (await rowText(t.id)).includes('문서'), t && (await rowText(t.id)));
  check('가져온 서류의 패널이 열리고 확인 구역이 보인다', !!t && (await js<boolean>(`!!document.querySelector('[data-doc-review="${t?.id}"]')`)));

  pickNext(files.biz);
  await importClick();
  docs = await listDocs();
  const b = docs.find((d) => d.vault && d.name === '사업자등록증명');
  check('사업자등록증명(다른 사업자): 90일 추정, 확인 필요(subject_mismatch)', !!b && b.vault!.expirySource === 'rule' && b.vault!.needsUser && b.vault!.reasons.includes('subject_mismatch'), b);
  check('목록 행: 확인 필요 표시와 추정 표시', !!b && /확인 필요/.test(await rowText(b.id)) && /추정/.test(await rowText(b.id)), b && (await rowText(b.id)));
  check('확인 필요 서류가 목록 맨 위', (await js<string>(`document.querySelector('[data-view=docs] tbody tr')?.getAttribute('data-doc-row') ?? ''`)) === b?.id);
  await js(`document.querySelector('[data-doc-row="${b!.id}"]').click()`);
  await until('review panel', async () => js<boolean>(`!!document.querySelector('[data-doc-review="${b!.id}"] [data-act=doc-confirm]')`), 5000);
  await js(`document.querySelector('[data-doc-review="${b!.id}"] [data-act=doc-confirm]').click()`);
  await until('confirmed', async () => !(await listDocs()).find((d) => d.id === b!.id)?.vault?.needsUser, 5000);
  const b2 = (await listDocs()).find((d) => d.id === b!.id);
  check('문서 패널에서 바꾸지 않고 확인하면 확인함(대상 표시는 남음)', !!b2 && !b2.vault!.needsUser && b2.vault!.expirySource === 'user' && b2.vault!.subjectMismatch, b2);
  await until('row updated', async () => !/확인 필요/.test(await rowText(b!.id)), 5000);
  check('목록 행에서 확인 필요가 사라지고 확인함 표시', /확인함/.test(await rowText(b!.id)) && !/확인 필요/.test(await rowText(b!.id)), await rowText(b!.id));

  pickNext(files.locked);
  await importClick();
  check('열기 암호 PDF: 암호 줄이 뜬다', await js<boolean>(`!!document.querySelector('[data-doc-password]')`));
  await js(`(() => { const i = document.querySelector('.doc-pw'); i.value = 'wrong'; document.querySelector('[data-act=doc-password]').click(); })()`);
  await until('wrong pw', async () => js<boolean>(`/맞지 않아요/.test(document.querySelector('[data-doc-password]')?.textContent ?? '')`), 30_000);
  check('틀린 암호 → 다시 묻는다', await js<boolean>(`/맞지 않아요/.test(document.querySelector('[data-doc-password]')?.textContent ?? '')`));
  const before = (await listDocs()).length;
  await js(`(() => { const i = document.querySelector('.doc-pw'); i.value = 'shell-pw'; document.querySelector('[data-act=doc-password]').click(); })()`);
  await until('locked imported', async () => (await listDocs()).length === before + 1, 60_000);
  check('맞는 암호 → 보관하고 암호 줄이 사라진다', (await listDocs()).length === before + 1 && !(await js<boolean>(`!!document.querySelector('[data-doc-password]')`)));

  const vaultFiles = await fs.readdir(path.join(app.getPath('userData'), 'docs-demo', 'vault'));
  check('데모 보관함 파일 3개, 이름에 PII 없음', vaultFiles.length === 3 && vaultFiles.every((f) => /^(national_tax_cert|biz_registration_cert|other)_\d{8}_[0-9A-Z]{4}\.pdf$/.test(f)), vaultFiles);
  const sweepDocs = await js<string>(`window.sax.call('docs.update', { id: 'run-x', patch: {} }).then(() => 'ok', (e) => String(e.message).replace(/^.*Error: /, ''))`);
  check('없는 서류 수정은 거부(not_found)', sweepDocs === 'not_found', sweepDocs);

  await js(`document.querySelector('[data-doc-row="${t!.id}"]').click()`);
  await sleep(300);
  await fs.mkdir(path.join(OUT, 'poc-8'), { recursive: true });
  await fs.writeFile(path.join(OUT, 'poc-8', 'shell-docs.png'), (await S.win.webContents.capturePage()).toPNG());
  await fs.writeFile(path.join(OUT, 'poc-8-shell-docs.json'), JSON.stringify({ checks: results, docs: (await listDocs()).map((d) => ({ name: d.name, issuedOn: d.issuedOn, expiresOn: d.expiresOn, vault: d.vault ? { expirySource: d.vault.expirySource, needsUser: d.vault.needsUser, reasons: d.vault.reasons } : null })) }, null, 2));
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
