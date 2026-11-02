// 보관함 앱 스모크(PoC-8, 수동 실행): 실제 Electron 앱의 개발 콘솔에서 PDF 가져오기 → docparse 샌드박스 → 엔진 등록 → 목록·만료 표시.
// 임시 앱 폴더(macOS HOME, Windows LOCALAPPDATA)를 쓰므로 실제 앱 폴더·DB는 건드리지 않는다. DB 키는 OS 키체인의 같은 항목을 쓴다
// (macOS는 HOME을 바꾸면 기본 키체인을 못 찾으므로 임시 HOME에 실제 Library/Keychains 링크를 둔다).
// 실행: pnpm build && node --conditions=development tests/vault-smoke.ts  → reports/raw/poc-8-vault-smoke.json, reports/raw/poc-8/vault-panel.png
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { _electron as electron, chromium } from 'playwright-core';
import { encryptedTestPdf, syntheticCerts } from '../apps/desktop/src/synthetic-certs.ts';

// 실제 경로로: macOS 임시 폴더는 /var 링크 아래라, 앱이 루트 경로의 링크를 거부한다(D07 §1.1).
const tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'sax-vault-smoke-')));
if (process.platform === 'darwin') {
  await fs.mkdir(path.join(tmp, 'Library'));
  await fs.symlink(path.join(os.homedir(), 'Library', 'Keychains'), path.join(tmp, 'Library', 'Keychains'));
}
const env: Record<string, string> = { ...(process.env as Record<string, string>), ...(process.platform === 'win32' ? { LOCALAPPDATA: tmp } : { HOME: tmp }) };
const root = process.platform === 'win32' ? path.join(tmp, 'SovereignAX') : path.join(tmp, 'Library', 'Application Support', 'SovereignAX');
const out: Record<string, unknown> = {};
const failures: string[] = [];
const expect = (name: string, ok: boolean) => {
  if (!ok) failures.push(name);
};
const certs = syntheticCerts();
const tax = certs.find((c) => c.kind === 'national_tax_cert')!;
const biz = certs.find((c) => c.kind === 'biz_registration_cert')!;

// 시험 PDF: 텍스트 PDF 2건(납세·등록증명), 그림 PDF 1건(OCR), 열기 암호 PDF 1건
const files = { tax: path.join(tmp, 'tax.pdf'), biz: path.join(tmp, 'biz.pdf'), image: path.join(tmp, 'image.pdf'), locked: path.join(tmp, 'locked.pdf') };
const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  const page = await browser.newPage();
  for (const [c, f] of [[tax, files.tax], [biz, files.biz]] as const) {
    await page.setContent(c.html);
    await page.evaluate(() => document.fonts.ready);
    await fs.writeFile(f, await page.pdf({ format: 'A4', printBackground: true, preferCSSPageSize: true }));
  }
  // 그림 PDF: 같은 납세증명서를 약 290dpi로 찍어 그림 한 장으로(텍스트 층 없음 → OCR)
  const shotPage = await browser.newPage({ viewport: { width: 794, height: 1123 }, deviceScaleFactor: 3 });
  await shotPage.setContent(tax.html);
  // 글꼴을 다 불러온 뒤 찍는다(3회 중 1회, 찍은 그림의 OCR이 종류를 못 알아본 적이 있다. 글꼴이 덜 그려진 화면으로 보인다)
  await shotPage.evaluate(() => document.fonts.ready);
  const png = await shotPage.screenshot();
  await page.setContent(`<!doctype html><style>@page{size:A4;margin:0}body{margin:0}img{width:210mm;height:297mm;display:block}</style><img src="data:image/png;base64,${png.toString('base64')}">`);
  await fs.writeFile(files.image, await page.pdf({ format: 'A4', printBackground: true, preferCSSPageSize: true }));
  await fs.writeFile(files.locked, encryptedTestPdf('smoke-pw', 'owner', 'PASSWORD PROTECTED SMOKE DOCUMENT FOR THE VAULT PANEL'));
} finally {
  await browser.close();
}

const electronPath = (await import('electron')).default as unknown as string;
const app = await electron.launch({ executablePath: electronPath, args: [path.resolve(import.meta.dirname, '../apps/desktop')], env, timeout: 30_000 });
const proc = app.process();
try {
  // 메인 창에는 승인 바(WebContentsView, ADR-021)도 붙어 있어 첫 페이지가 바일 수 있다. 개발 콘솔 페이지를 주소로 고른다.
  const isApp = (p: { url(): string }) => p.url().startsWith('sax-app://app/app.html');
  const win = app.windows().find(isApp) ?? (await app.waitForEvent('window', { predicate: isApp, timeout: 30_000 }));
  const call = (m: string, p: Record<string, unknown> = {}) => win.evaluate(([m, p]) => (window as unknown as { sax: { call(m: string, p: unknown): Promise<unknown> } }).sax.call(m, p), [m, p] as const);
  let status: { engine?: { db?: boolean } } = {};
  let last: unknown = null;
  for (let i = 0; i < 80 && !status.engine?.db; i++) {
    status = (await call('app.status').catch((e: Error) => ((last = e.message), {}))) as typeof status;
    await new Promise((r) => setTimeout(r, 250));
  }
  out.dbReady = !!status.engine?.db;
  if (!out.dbReady) throw new Error(`엔진 DB가 열리지 않음(키체인·앱 폴더 확인): ${JSON.stringify(status)} ${String(last ?? '')}`);
  // 파일 고르기 대화상자를 정해진 파일로 바꾼다(main 프로세스 안).
  const pickNext = (file: string) => app.evaluate(({ dialog }, f) => {
    dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [f] })) as typeof dialog.showOpenDialog;
  }, file);
  const importVia = async (file: string) => {
    await pickNext(file);
    await win.click('#v-import');
    await win.waitForFunction(() => !/읽는 중/.test(document.querySelector('#v-msg')?.textContent ?? ''), null, { timeout: 120_000 });
    return win.textContent('#v-msg');
  };
  out.formsHiddenAtStart = !(await win.isVisible('#v-password')) && !(await win.isVisible('#v-edit'));
  out.beforeProfile = await importVia(files.tax);
  await call('profile.upsert', { kind: 'business', displayName: '스모크 사업자', bizNo: tax.expected.bizNo });
  out.tax = await importVia(files.tax);
  out.taxAgain = await importVia(files.tax);
  out.biz = await importVia(files.biz);
  out.image = await importVia(files.image);
  out.locked = await importVia(files.locked);
  out.passwordFormShown = await win.isVisible('#v-password');
  await win.fill('#v-password input[name=password]', 'wrong');
  await win.click('#v-password button:not([type])');
  await win.waitForFunction(() => /암호가 맞지 않습니다/.test(document.querySelector('#v-msg')?.textContent ?? ''), null, { timeout: 60_000 });
  out.lockedWrong = await win.textContent('#v-msg');
  await win.fill('#v-password input[name=password]', 'smoke-pw');
  await win.click('#v-password button:not([type])');
  await win.waitForFunction(() => /보관함에 넣었습니다/.test(document.querySelector('#v-msg')?.textContent ?? ''), null, { timeout: 60_000 });
  out.lockedOk = await win.textContent('#v-msg');
  out.passwordFormHiddenAfter = !(await win.isVisible('#v-password'));
  out.rendererImportRefused = await call('document.import', { bytes: new Uint8Array([37, 80, 68, 70, 45]), extract: {} }).then(() => 'accepted', (e: Error) => e.message.replace(/^Error invoking remote method 'sax': /, ''));
  const list = (await call('db.query.documents.list')) as Array<Record<string, unknown>>;
  out.list = list.map((d) => ({ docType: d.docType, issuedOn: d.issuedOn, expiresOn: d.expiresOn, expirySource: d.expirySource, needsUser: d.needsUser, reasons: d.reasons, textSource: d.textSource, subjectMismatch: d.subjectMismatch }));
  await win.waitForFunction((n) => document.querySelectorAll('#v-list tr').length === n, list.length);
  out.rows = await win.$$eval('#v-list tr', (trs) => trs.map((tr) => [...tr.querySelectorAll('td')].slice(0, 6).map((td) => td.textContent)));
  // 화면 확인 경로: 다른 사업자로 확인 필요인 사업자등록증명을 '확인' → 아무것도 바꾸지 않고 저장 → 확인함
  const bizRow = (out.list as Array<Record<string, unknown>>).findIndex((d) => d.docType === 'biz_registration_cert');
  await win.click(`#v-list tr:nth-child(${bizRow + 1}) button`);
  await win.click('#v-edit button[type=submit]');
  await win.waitForFunction((i) => !/확인 필요/.test(document.querySelectorAll('#v-list tr')[i]?.textContent ?? '확인 필요'), bizRow, { timeout: 10_000 });
  const after = ((await call('db.query.documents.list')) as Array<Record<string, unknown>>).find((d) => d.docType === 'biz_registration_cert')!;
  out.bizConfirmed = { needsUser: after.needsUser, expirySource: after.expirySource, subjectMismatch: after.subjectMismatch };
  const section = await win.$('section:has(#v-list)');
  await fs.mkdir(path.resolve(import.meta.dirname, '../reports/raw/poc-8'), { recursive: true });
  await section?.screenshot({ path: path.resolve(import.meta.dirname, '../reports/raw/poc-8/vault-panel.png') });
} finally {
  await Promise.race([app.close(), new Promise((r) => setTimeout(r, 10_000))]);
  if (proc.exitCode === null) proc.kill(); // 닫기가 멈추면 스모크가 띄운 앱만 끈다
}
out.vaultFiles = (await fs.readdir(path.join(root, 'vault'))).map((f) => f.replace(/_[0-9A-Z]{4}\.pdf$/, '_XXXX.pdf')).sort();
const list = (out.list ?? []) as Array<Record<string, unknown>>;
const textTax = list.find((d) => d.docType === 'national_tax_cert' && d.textSource === 'text');
const ocrTax = list.find((d) => d.docType === 'national_tax_cert' && d.textSource === 'ocr');
expect('엔진 DB 열림', out.dbReady === true);
expect('처음에 암호·수정 줄은 숨김', out.formsHiddenAtStart === true);
expect('사업자 프로필 없음 안내', String(out.beforeProfile).includes('내 사업장'));
expect('텍스트 PDF 보관', String(out.tax).includes('보관함에 넣었습니다') && String(out.tax).includes('텍스트'));
expect('같은 파일 다시 → 중복 안내', String(out.taxAgain).includes('이미 있는 파일'));
expect('그림 PDF → OCR', String(out.image).includes('OCR'));
expect('열기 암호 요청·틀린 암호 안내·맞는 암호로 보관', out.passwordFormShown === true && String(out.lockedWrong).includes('맞지 않습니다') && String(out.lockedOk).includes('보관함에 넣었습니다') && out.passwordFormHiddenAfter === true);
expect('렌더러의 document.import 거부', String(out.rendererImportRefused).includes('unknown_method'));
expect('텍스트 납세증명: 문서에서 읽은 만료일, 확인 필요 없음', !!textTax && textTax.expirySource === 'document' && textTax.needsUser === false);
expect('OCR 납세증명: 확인 필요(read_by_ocr)', !!ocrTax && ocrTax.needsUser === true && (ocrTax.reasons as string[]).includes('read_by_ocr'));
expect('다른 사업자 서류를 화면에서 확인하면 확인함(대상 표시는 남음)', JSON.stringify(out.bizConfirmed) === JSON.stringify({ needsUser: false, expirySource: 'user', subjectMismatch: true }));
expect('파일 4개, 이름에 PII 없음', (out.vaultFiles as string[]).length === 4 && (out.vaultFiles as string[]).every((f) => /^(national_tax_cert|biz_registration_cert|other)_\d{8}_XXXX\.pdf$/.test(f)));
out.failures = failures;
console.log(JSON.stringify(out, null, 2));
await fs.writeFile(path.resolve(import.meta.dirname, '../reports/raw/poc-8-vault-smoke.json'), JSON.stringify(out, null, 2));
await fs.rm(tmp, { recursive: true, force: true });
if (failures.length) {
  console.error(`실패 ${failures.length}건: ${failures.join(' / ')}`);
  process.exit(1);
}
