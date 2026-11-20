import './os-guard.js';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { app, protocol } from 'electron';
import { decideExpiry, extractDocMeta, l0ShadowPick, readScore, validateDocMeta, worthOcr, type DocMetaExtract } from '@sax/engine/docmeta';
import { DOCPARSE_SCHEME, DocparseError, parsePdfInSandbox, type PdfExtractRun } from '../dist/docparse.js';

protocol.registerSchemesAsPrivileged([{ scheme: DOCPARSE_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true } }]);
app.setPath('userData', path.join(app.getPath('temp'), `sax-poc8-measure-${process.pid}`));
app.on('window-all-closed', () => {});

type LabelType = 'national_tax_cert' | 'biz_registration_cert' | 'other';
interface Label {
  file: string;
  docType: LabelType | null;
  issuedOn: string | null;
  validUntil: string | null;
  docNo?: string | null;
  bizNo?: string | null;
}

const REPO = path.resolve(import.meta.dirname, '../../../..');

function insideGitWorkTree(dir: string): boolean {
  try {
    return execFileSync('git', ['-C', dir, 'rev-parse', '--is-inside-work-tree'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() === 'true';
  } catch {
    return path.resolve(dir).startsWith(REPO + path.sep);
  }
}

async function readPasswordFromStdin(): Promise<string | undefined> {
  if (!process.argv.includes('--password-stdin')) return undefined;
  let buf = '';
  for await (const chunk of process.stdin) {
    buf += String(chunk);
    if (buf.includes('\n')) break;
  }
  return buf.split('\n')[0]!.replace(/\r$/, '') || undefined;
}

async function readLikeApp(bytes: Uint8Array, password: string | undefined): Promise<{ run: PdfExtractRun; meta: DocMetaExtract; ocrGrade: boolean }> {
  const x = await parsePdfInSandbox(bytes, { password });
  const first = validateDocMeta(extractDocMeta(x.text));
  if (!first) throw new Error('schema');
  if (x.ocrConfidence !== null || !worthOcr(first, x.text)) return { run: x, meta: first, ocrGrade: x.ocrConfidence !== null || x.scanned };
  const y = await parsePdfInSandbox(bytes, { password, forceOcr: true }).catch(() => null);
  if (!y) return { run: x, meta: first, ocrGrade: x.scanned };
  const second = validateDocMeta(extractDocMeta(y.text));
  if (!second) throw new Error('schema');
  if (readScore(first) >= readScore(second)) return { run: x, meta: first, ocrGrade: x.scanned };
  return { run: { ...y, ms: x.ms + y.ms }, meta: second, ocrGrade: true };
}

const failCode = (e: unknown) => (e instanceof DocparseError ? e.code : e instanceof Error ? e.message.slice(0, 40) : 'error');

async function main(): Promise<number> {
  const args = process.argv.slice(2).filter((a) => !a.startsWith('--'));
  const dir = args[0] ? path.resolve(args[0]) : '';
  if (!dir) {
    console.error('사용법: electron apps/desktop/e2e-dist/poc8-measure.js <git 작업 폴더 밖 폴더> [--draft] [--password-stdin]');
    return 2;
  }
  if (insideGitWorkTree(dir)) {
    console.error('실물 서류는 git 작업 폴더 밖에 두세요(커밋 방지).');
    return 2;
  }
  const password = await readPasswordFromStdin();
  const today = process.env.SAX_POC8_TODAY ?? new Date(Date.now() + 9 * 3_600_000).toISOString().slice(0, 10);

  if (process.argv.includes('--draft')) {
    const files = (await fs.readdir(dir)).filter((f) => f.toLowerCase().endsWith('.pdf')).sort();
    const out: Label[] = [];
    for (const file of files) out.push({ file, docType: null, issuedOn: null, validUntil: null, docNo: null, bizNo: null });
    await fs.writeFile(path.join(dir, 'labels.draft.json'), JSON.stringify(out, null, 2));
    console.log(`정답 틀 ${out.length}건을 폴더의 labels.draft.json에 썼습니다. PDF를 보고 종류·날짜·번호를 채워 labels.json으로 저장하세요.`);
    return 0;
  }

  const labels = JSON.parse(await fs.readFile(path.join(dir, 'labels.json'), 'utf8')) as Label[];
  const unlabeled = labels.findIndex((l) => !['national_tax_cert', 'biz_registration_cert', 'other'].includes(l.docType as string));
  if (unlabeled >= 0) {
    console.error(`#${unlabeled + 1}의 종류(docType)를 채우세요.`);
    return 2;
  }
  const rows: Array<Record<string, unknown>> = [];
  for (const [i, l] of labels.entries()) {
    const row: Record<string, unknown> = { n: i + 1, docType: l.docType };
    rows.push(row);
    const r = await fs
      .readFile(path.join(dir, l.file))
      .then((b) => readLikeApp(new Uint8Array(b), password))
      .catch((e: unknown) => failCode(e));
    if (typeof r === 'string') {
      Object.assign(row, { error: r, coreOk: false, silentWrong: false });
      continue;
    }
    const { run, meta, ocrGrade } = r;
    const expiry = decideExpiry(meta, today);
    const typeOk = (meta.docType ?? 'other') === l.docType;
    const issuedOk = l.docType === 'other' || meta.issuedOn.value === l.issuedOn;
    const validOk = l.docType === 'national_tax_cert' ? meta.validUntil.value === l.validUntil && expiry.source === 'document' && expiry.expiresOn === l.validUntil : true;
    const coreOk = typeOk && issuedOk && validOk;
    const needsUser = expiry.needsUser || ocrGrade;
    const l0Issued = l0ShadowPick(meta, 'issued_on');
    const l0Valid = l0ShadowPick(meta, 'valid_until');
    Object.assign(row, {
      textLayer: run.hasTextLayer,
      scanned: run.scanned,
      ocrConfidence: run.ocrConfidence,
      pages: run.pages,
      ms: run.ms,
      peakMemoryMb: Math.round(run.peakMemoryKb / 1024),
      typeOk,
      issuedOk,
      validOk,
      coreOk,
      needsUser,
      silentWrong: !coreOk && !needsUser,
      reasons: { issuedOn: meta.issuedOn.reason, validUntil: meta.validUntil.reason, expiry: expiry.reasons },
      docNoOk: l.docNo == null ? null : meta.docNo.value === l.docNo,
      bizNoOk: l.bizNo == null ? null : meta.subjectBizNo.value === l.bizNo,
      issuerFound: meta.issuer.value !== null,
      l0: { issuedAnswered: l0Issued !== null, issuedOk: l0Issued === null ? null : l0Issued === l.issuedOn, validAnswered: l0Valid !== null, validOk: l0Valid === null ? null : l0Valid === l.validUntil },
    });
  }
  const target = rows.filter((r) => r.docType === 'national_tax_cert' || r.docType === 'biz_registration_cert');
  const other = rows.filter((r) => r.docType === 'other');
  const core = target.filter((r) => r.coreOk).length;
  const silent = rows.filter((r) => r.silentWrong).length;
  const ms = rows.map((r) => r.ms).filter((x): x is number => typeof x === 'number').sort((a, b) => a - b);
  const enough = target.length >= 20 && target.some((r) => r.docType === 'national_tax_cert') && target.some((r) => r.docType === 'biz_registration_cert');
  const summary = {
    measuredAt: new Date().toISOString(),
    platform: process.platform,
    samples: rows.length,
    target: target.length,
    byType: { national_tax_cert: rows.filter((r) => r.docType === 'national_tax_cert').length, biz_registration_cert: rows.filter((r) => r.docType === 'biz_registration_cert').length, other: other.length },
    coreOk: core,
    otherClassifiedOk: `${other.filter((r) => r.typeOk).length}/${other.length}`,
    silentWrong: silent,
    acceptance: !enough ? `표본 부족(두 종류 합 ${target.length}/20, 두 종류 모두 필요)` : core >= Math.ceil(target.length * 0.95) && silent === 0 ? 'pass' : 'fail',
    needsUser: rows.filter((r) => r.needsUser).length,
    textLayer: rows.filter((r) => r.textLayer === true && !r.scanned && r.ocrConfidence == null).length,
    ocr: rows.filter((r) => r.ocrConfidence != null).length,
    scanned: rows.filter((r) => r.scanned).length,
    errors: rows.filter((r) => r.error).map((r) => r.error),
    msMedian: ms[Math.floor(ms.length / 2)] ?? null,
    msMax: ms[ms.length - 1] ?? null,
    rows,
  };
  for (const r of rows) console.log(`#${r.n} ${r.docType} ${r.coreOk ? 'ok  ' : r.silentWrong ? 'SILENT-WRONG' : 'FAIL'} ${r.error ?? `종류 ${r.typeOk} 발급일 ${r.issuedOk} 유효기간 ${r.validOk} 확인필요 ${r.needsUser} ${r.ocrConfidence != null ? 'OCR' : r.scanned ? '스캔층' : '텍스트'} ${r.ms}ms`}`);
  console.log(`두 종류 ${target.length}건 중 종류·발급일·유효기간 모두 맞음 ${core}건, 확인 없이 틀림 ${silent}건 → ${summary.acceptance}`);
  await fs.writeFile(path.join(REPO, 'poc/reports/raw/poc-8-real.json'), JSON.stringify(summary, null, 2));
  return summary.acceptance === 'pass' ? 0 : 1;
}

app.whenReady().then(async () => {
  let code = 1;
  try {
    code = await main();
  } catch (e) {
    console.error(failCode(e));
  }
  app.exit(code);
});
