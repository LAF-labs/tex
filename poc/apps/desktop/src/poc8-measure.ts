// PoC-8 실물 측정: 사람이 저장소 밖 폴더에 둔 홈택스 민원증명 PDF(납세증명서·사업자등록증명)를 docparse 샌드박스로 읽고
// 사람이 쓴 정답(labels.json)과 비교한다. 합격 기준은 "20건 중 19건"(종류·발급일·유효기간이 모두 맞은 건).
//
// 실행(빌드 뒤):
//   electron apps/desktop/dist/poc8-measure.js <폴더> --draft   → <폴더>/labels.draft.json(추출값 초안). 사람이 고쳐 labels.json으로 저장
//   electron apps/desktop/dist/poc8-measure.js <폴더>           → 비교 결과. 저장소에는 값 없는 요약(reports/raw/poc-8-real.json)만 쓴다
// 열기 암호가 걸린 PDF는 SAX_POC8_PDF_PASSWORD 환경 변수로 준다(파일에 쓰지 않는다).
//
// labels.json: [{ "file": "a.pdf", "docType": "national_tax_cert" | "biz_registration_cert" | "other",
//                 "issuedOn": "YYYY-MM-DD", "validUntil": "YYYY-MM-DD" | null, "docNo"?: "XXXX-XXX-XXXX-XXX", "bizNo"?: "숫자 10자리" }]
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { app, protocol } from 'electron';
import { decideExpiry, extractDocMeta, l0ShadowPick, validateDocMeta } from '@sax/engine/docmeta';
import { DOCPARSE_SCHEME, DocparseError, parsePdfInSandbox } from './docparse.ts';

protocol.registerSchemesAsPrivileged([{ scheme: DOCPARSE_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true } }]);
app.setPath('userData', path.join(app.getPath('temp'), `sax-poc8-measure-${process.pid}`));
app.on('window-all-closed', () => {});

interface Label {
  file: string;
  docType: 'national_tax_cert' | 'biz_registration_cert' | 'other';
  issuedOn: string | null;
  validUntil: string | null;
  docNo?: string;
  bizNo?: string;
}

const REPO = path.resolve(import.meta.dirname, '../../../..');
const TODAY_OVERRIDE = process.env.SAX_POC8_TODAY; // 오래된 샘플의 발급일이 '미래'로 걸리지 않게(기본은 오늘)

/** git 작업 폴더 안이면 거부한다(이 저장소든 다른 체크아웃이든 실수로 커밋될 수 있다). */
function insideGitWorkTree(dir: string): boolean {
  try {
    return execFileSync('git', ['-C', dir, 'rev-parse', '--is-inside-work-tree'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() === 'true';
  } catch {
    return path.resolve(dir).startsWith(REPO + path.sep);
  }
}

async function main(): Promise<number> {
  const args = process.argv.slice(2).filter((a) => !a.startsWith('--'));
  const draft = process.argv.includes('--draft');
  const dir = args[0] ? path.resolve(args[0]) : '';
  if (!dir) {
    console.error('사용법: electron apps/desktop/dist/poc8-measure.js <저장소 밖 폴더> [--draft]');
    return 2;
  }
  if (insideGitWorkTree(dir)) {
    console.error('실물 서류는 git 작업 폴더 밖에 두세요(커밋 방지).');
    return 2;
  }
  const files = (await fs.readdir(dir)).filter((f) => f.toLowerCase().endsWith('.pdf')).sort();
  const password = process.env.SAX_POC8_PDF_PASSWORD || undefined;
  const today = TODAY_OVERRIDE ?? new Date(Date.now() + 9 * 3_600_000).toISOString().slice(0, 10);

  if (draft) {
    const out: Label[] = [];
    for (const file of files) {
      const r = await parsePdfInSandbox(new Uint8Array(await fs.readFile(path.join(dir, file))), { password }).catch((e: unknown) => (e instanceof Error ? e : new Error(String(e))));
      if (r instanceof Error) {
        out.push({ file, docType: 'other', issuedOn: null, validUntil: null });
        console.log(`${file}: 읽기 실패 ${r instanceof DocparseError ? r.code : r.message}`);
        continue;
      }
      const m = extractDocMeta(r.text);
      out.push({ file, docType: m.docType ?? 'other', issuedOn: m.issuedOn.value ?? m.issuedOn.suggested ?? null, validUntil: m.validUntil.value ?? m.validUntil.suggested ?? null, docNo: m.docNo.value ?? undefined, bizNo: m.subjectBizNo.value ?? undefined });
    }
    await fs.writeFile(path.join(dir, 'labels.draft.json'), JSON.stringify(out, null, 2));
    console.log(`초안 ${out.length}건: ${path.join(dir, 'labels.draft.json')} — PDF를 직접 보고 값을 고친 뒤 labels.json으로 저장하세요.`);
    return 0;
  }

  const labels = JSON.parse(await fs.readFile(path.join(dir, 'labels.json'), 'utf8')) as Label[];
  const rows: Array<Record<string, unknown>> = [];
  let i = 0;
  for (const l of labels) {
    i++;
    const row: Record<string, unknown> = { n: i, docType: l.docType };
    rows.push(row);
    const r = await parsePdfInSandbox(new Uint8Array(await fs.readFile(path.join(dir, l.file))), { password }).catch((e: unknown) => (e instanceof Error ? e : new Error(String(e))));
    if (r instanceof Error) {
      Object.assign(row, { error: r instanceof DocparseError ? r.code : 'error', coreOk: false });
      continue;
    }
    const meta = validateDocMeta(extractDocMeta(r.text));
    if (!meta) {
      Object.assign(row, { error: 'schema', coreOk: false });
      continue;
    }
    const expiry = decideExpiry(meta, today);
    const typeOk = (meta.docType ?? 'other') === l.docType;
    const issuedOk = meta.issuedOn.value === l.issuedOn;
    const validOk = l.docType === 'national_tax_cert' ? meta.validUntil.value === l.validUntil && expiry.expiresOn === l.validUntil : true;
    Object.assign(row, {
      textLayer: r.hasTextLayer,
      ocrConfidence: r.ocrConfidence,
      pages: r.pages,
      ms: r.ms,
      peakMemoryMb: Math.round(r.peakMemoryKb / 1024),
      typeOk,
      issuedOk,
      validOk,
      coreOk: typeOk && issuedOk && validOk,
      needsUser: expiry.needsUser || !r.hasTextLayer,
      reasons: { issuedOn: meta.issuedOn.reason, validUntil: meta.validUntil.reason, expiry: expiry.reasons },
      docNoOk: l.docNo === undefined ? null : meta.docNo.value === l.docNo,
      bizNoOk: l.bizNo === undefined ? null : meta.subjectBizNo.value === l.bizNo,
      issuerFound: meta.issuer.value !== null,
      l0: { issued: l0ShadowPick(meta, 'issued_on'), valid: l0ShadowPick(meta, 'valid_until') },
    });
    // L0 그림자: 값 대신 답했는지·맞았는지만 남긴다
    const l0 = row.l0 as { issued: string | null; valid: string | null };
    row.l0 = { issuedAnswered: l0.issued !== null, issuedOk: l0.issued === null ? null : l0.issued === l.issuedOn, validAnswered: l0.valid !== null, validOk: l0.valid === null ? null : l0.valid === l.validUntil };
  }
  const n = rows.length;
  const core = rows.filter((r) => r.coreOk).length;
  const ms = rows.map((r) => r.ms as number).filter((x) => typeof x === 'number').sort((a, b) => a - b);
  const summary = {
    measuredAt: new Date().toISOString(),
    platform: process.platform,
    samples: n,
    byType: Object.fromEntries(['national_tax_cert', 'biz_registration_cert', 'other'].map((t) => [t, rows.filter((r) => r.docType === t).length])),
    coreOk: core,
    acceptance: n >= 20 ? (core >= Math.ceil(n * 0.95) ? 'pass' : 'fail') : `표본 부족(${n}/20)`,
    textLayer: rows.filter((r) => r.textLayer === true).length,
    ocr: rows.filter((r) => r.textLayer === false).length,
    errors: rows.filter((r) => r.error).map((r) => r.error),
    msMedian: ms[Math.floor(ms.length / 2)] ?? null,
    msMax: ms[ms.length - 1] ?? null,
    rows, // 순번·참거짓·코드만. 파일명·추출값은 남기지 않는다
  };
  for (const r of rows) console.log(`#${r.n} ${r.docType} ${r.coreOk ? 'ok  ' : 'FAIL'} ${r.error ?? `종류 ${r.typeOk} 발급일 ${r.issuedOk} 유효기간 ${r.validOk} ${r.textLayer ? '텍스트' : 'OCR'} ${r.ms}ms`}`);
  console.log(`종류·발급일·유효기간 모두 맞음 ${core}/${n} → ${summary.acceptance}`);
  await fs.writeFile(path.join(REPO, 'poc/reports/raw/poc-8-real.json'), JSON.stringify(summary, null, 2));
  return summary.acceptance === 'pass' ? 0 : 1;
}

app.whenReady().then(async () => {
  let code = 1;
  try {
    code = await main();
  } catch (e) {
    console.error((e as Error).message);
  }
  app.exit(code);
});
