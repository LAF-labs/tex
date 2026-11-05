// docparse e2e(Electron): 합성 서류 PDF → 샌드박스(pdf.js, 텍스트 층이 없으면 OCR) → 메타 규칙(S4) → 기대값 비교, S13b 측정(PoC-8).
// M1-8 자기 점검(창 안 송신 0·eval 0), M6-4 합성 영수증 사진 → 샌드박스 OCR → 규칙 정확도 표, M6-5 표 파일, M6-12 시드 코퍼스(거부·무시·송신 0).
// 실행: pnpm build && electron apps/desktop/dist/docparse-e2e.js. 결과 JSON은 SAX_E2E_OUT(없으면 임시 폴더)에 쓴다(측정 산출물은 커밋하지 않는다).
// SAX_DOCPARSE_E2E=receipts|sheets|seeds|all(기본 all, PoC-8 서류 부분 포함). 앱 폴더·키체인을 쓰지 않는다.
import dgram from 'node:dgram';
import fs from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { app, BrowserWindow, protocol, session } from 'electron';
import { decideExpiry, extractDocMeta, validateDocMeta, type DocMetaExtract } from '@sax/engine/docmeta';
import { CANARY, receiptHtml, seedCorpus, syntheticReceipts, deliveryXlsx, healthNoticeXlsx, marketCsv, pensionNoticeCsv, type SyntheticReceipt } from '@sax/docparse/fixtures';
import type { ReceiptResult } from '@sax/docparse';
import { createDocparseWindow, DOCPARSE_SCHEME, DocparseError, ocrImageInSandbox, parseInSandbox, parsePdfInSandbox, readSheetInSandbox, type OcrModel, type PdfExtractRun, type PdfOptions } from './docparse.ts';
import { addDays, breakToUnicode, encryptedTestPdf, multiPageHtml, scannedTestPdf, syntheticCerts, type SyntheticCert } from './synthetic-certs.ts';

protocol.registerSchemesAsPrivileged([{ scheme: DOCPARSE_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true } }]);
app.setPath('userData', path.join(app.getPath('temp'), `sax-poc8-e2e-${process.pid}`));
app.on('window-all-closed', () => {}); // 창이 모두 닫혀도 e2e가 끝날 때까지 유지

/** 만료 판단 기준일(합성 발급일은 모두 이보다 앞이다) */
const TODAY = '2026-11-01';
const results: Array<{ name: string; ok: boolean; detail?: unknown }> = [];
const check = (name: string, ok: boolean, detail?: unknown) => results.push({ name, ok, detail });

async function htmlToPdf(html: string): Promise<Uint8Array> {
  const w = new BrowserWindow({ show: false, webPreferences: { sandbox: true, javascript: false } });
  try {
    await w.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
    return new Uint8Array(await w.webContents.printToPDF({ pageSize: 'A4', printBackground: true, preferCSSPageSize: true }));
  } finally {
    w.destroy();
  }
}

/** 서류를 약 290dpi로 찍는다. 스캔처럼 0.6° 기울인다. */
async function capture(html: string): Promise<Electron.NativeImage> {
  const zoom = 3;
  const w = new BrowserWindow({ show: false, width: 794 * zoom, height: 1123 * zoom, webPreferences: { offscreen: true, javascript: false, zoomFactor: zoom } });
  try {
    await w.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html.replace('</style>', 'html{transform:rotate(0.6deg)}</style>')));
    await new Promise((r) => setTimeout(r, 300));
    return await w.webContents.capturePage();
  } finally {
    w.destroy();
  }
}

/** 그림 한 장짜리 PDF(텍스트 층 없음 = 스캔·이미지 인쇄 흉내). */
async function htmlToImagePdf(html: string): Promise<Uint8Array> {
  const png = (await capture(html)).toPNG();
  return htmlToPdf(`<!doctype html><style>@page{size:A4;margin:0}body{margin:0}img{width:210mm;height:297mm;display:block}</style><img src="data:image/png;base64,${png.toString('base64')}">`);
}

/**
 * docparse 창 안에서 하는 송신 시험(D17 §2 "docparse 렌더러의 네트워크 요청 0"). 실제 docparse 페이지(CSP 있음)와
 * CSP 없는 data: 페이지 두 곳에서 fetch·WebSocket·WebRTC(STUN UDP, TURN TCP)를 시도하고 로컬 리스너에 닿은 수를 센다.
 */
async function egressProbe(): Promise<Record<string, unknown>> {
  const udp = dgram.createSocket('udp4');
  let udpHits = 0;
  udp.on('message', () => udpHits++);
  await new Promise<void>((r) => udp.bind(0, '127.0.0.1', r));
  let tcpHits = 0;
  const tcp = net.createServer((sock) => {
    tcpHits++;
    sock.destroy();
  });
  await new Promise<void>((r) => tcp.listen(0, '127.0.0.1', r));
  const udpPort = udp.address().port;
  const tcpPort = (tcp.address() as net.AddressInfo).port;
  const probe = `(async () => {
    const r = {};
    r.fetch = await fetch('http://127.0.0.1:${tcpPort}/').then(() => 'sent', () => 'blocked');
    r.ws = await new Promise((res) => { try { const w = new WebSocket('ws://127.0.0.1:${tcpPort}/'); w.onopen = () => res('open'); w.onerror = () => res('blocked'); setTimeout(() => res('timeout'), 1500); } catch { res('blocked'); } });
    try {
      const pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:127.0.0.1:${udpPort}' }, { urls: 'turn:127.0.0.1:${tcpPort}?transport=tcp', username: 'u', credential: 'p' }] });
      pc.createDataChannel('x');
      await pc.setLocalDescription(await pc.createOffer());
      await new Promise((res) => setTimeout(res, 2500));
      pc.close();
      r.rtc = 'tried';
    } catch (e) { r.rtc = 'error ' + String(e).slice(0, 40); }
    return r;
  })()`;
  const out: Record<string, unknown> = {};
  const win = await createDocparseWindow();
  try {
    await win.loadURL(`${DOCPARSE_SCHEME}://app/index.html`);
    out.page = await win.webContents.executeJavaScript(probe);
    await win.loadURL('data:text/html,<p>probe</p>');
    out.dataPage = await win.webContents.executeJavaScript(probe);
  } finally {
    win.destroy();
    await new Promise((r) => setTimeout(r, 300));
    udp.close();
    tcp.close();
  }
  return { ...out, udpHits, tcpHits };
}

type FieldName = 'issuedOn' | 'validUntil' | 'issuer' | 'docNo' | 'subjectBizNo';
const FIELD_EXPECT: Record<FieldName, keyof SyntheticCert['expected']> = { issuedOn: 'issuedOn', validUntil: 'validUntil', issuer: 'issuer', docNo: 'docNo', subjectBizNo: 'bizNo' };

interface SampleResult {
  id: string;
  flavor: 'text' | 'image' | 'broken_tounicode';
  hasTextLayer: boolean;
  ocrConfidence: number | null;
  ms: number;
  timing: PdfExtractRun['timing'];
  peakMemoryKb: number;
  kind: string;
  /** 서류 종류·발급일·만료일이 모두 맞는가(합격 판정 단위) */
  coreOk: boolean;
  fields: Record<string, boolean>;
  mismatches: Record<string, { got: string | null; want: string | null; reason: string | null }>;
}

function compare(c: SyntheticCert, meta: DocMetaExtract): Pick<SampleResult, 'coreOk' | 'fields' | 'mismatches' | 'kind'> {
  const fields: Record<string, boolean> = { docType: meta.docType === c.expected.docType };
  const mismatches: SampleResult['mismatches'] = {};
  if (!fields.docType) mismatches.docType = { got: meta.docType, want: c.expected.docType, reason: meta.kind };
  if (c.expected.docType) {
    for (const [f, e] of Object.entries(FIELD_EXPECT) as Array<[FieldName, keyof SyntheticCert['expected']]>) {
      const want = c.expected[e] as string | null;
      fields[f] = meta[f].value === want;
      if (!fields[f]) mismatches[f] = { got: meta[f].value ?? meta[f].suggested ?? null, want, reason: meta[f].reason };
    }
    const expiry = decideExpiry(meta, TODAY);
    const wantExpiry = c.expected.validUntil ?? addDays(c.expected.issuedOn!, 89);
    fields.expiresOn = expiry.expiresOn === wantExpiry && !expiry.needsUser;
    if (!fields.expiresOn) mismatches.expiresOn = { got: expiry.expiresOn, want: wantExpiry, reason: expiry.reasons.join(',') || null };
  }
  const coreOk = fields.docType! && (!c.expected.docType || (fields.issuedOn! && fields.expiresOn!));
  return { coreOk, fields, mismatches, kind: meta.kind };
}

async function runSample(c: SyntheticCert, flavor: SampleResult['flavor'], pdf: Uint8Array): Promise<SampleResult> {
  const r = await parsePdfInSandbox(pdf);
  // 규칙을 고칠 때 추출 원문을 본다(합성 자료라 가짜 값뿐). 저장소 밖 폴더를 준다.
  if (process.env.SAX_POC8_DUMP) {
    await fs.writeFile(path.join(process.env.SAX_POC8_DUMP, `${c.id}.${flavor}.txt`), r.text);
    await fs.writeFile(path.join(process.env.SAX_POC8_DUMP, `${c.id}.${flavor}.pdf`), pdf);
  }
  const meta = validateDocMeta(extractDocMeta(r.text));
  if (!meta) throw new Error(`schema ${c.id}`);
  return { id: c.id, flavor, hasTextLayer: r.hasTextLayer, ocrConfidence: r.ocrConfidence, ms: r.ms, timing: r.timing, peakMemoryKb: r.peakMemoryKb, ...compare(c, meta) };
}

const errCode = (p: Promise<unknown>) => p.then(() => 'ok', (e: unknown) => (e instanceof DocparseError ? e.code : (e as Error).message));

function stats(xs: number[]): { n: number; median: number; p90: number; max: number } {
  const s = [...xs].sort((a, b) => a - b);
  const q = (p: number) => s[Math.min(s.length - 1, Math.floor(p * s.length))] ?? 0;
  return { n: s.length, median: q(0.5), p90: q(0.9), max: s[s.length - 1] ?? 0 };
}

async function certificates(): Promise<Record<string, unknown>> {
  // 세션 준비(죽은 프록시)가 한 번 실패해도 다음 작업은 다시 준비해 성공한다(스킴 처리기를 두 번 걸지 않는다). 첫 docparse 작업보다 먼저 한다.
  const proto = Object.getPrototypeOf(session.fromPartition('sax-docparse')) as { setProxy: (c: unknown) => Promise<void> };
  const realSetProxy = proto.setProxy;
  let failOnce = true;
  proto.setProxy = function (this: unknown, c: unknown) {
    if (failOnce) {
      failOnce = false;
      return Promise.reject(new Error('proxy down'));
    }
    return realSetProxy.call(this, c);
  };
  const firstPdf = await htmlToPdf(syntheticCerts()[0]!.html);
  const firstTry = await errCode(parsePdfInSandbox(firstPdf));
  const secondTry = await errCode(parsePdfInSandbox(firstPdf));
  proto.setProxy = realSetProxy;
  check('세션 준비가 한 번 실패하면 창을 띄우지 않고(session_failed), 다음 작업은 다시 준비해 성공한다', firstTry === 'session_failed' && secondTry === 'ok', { firstTry, secondTry });

  const samples: SampleResult[] = [];
  let brokenReplaced = 0;
  for (const c of syntheticCerts()) {
    const textPdf = await htmlToPdf(c.html);
    samples.push(await runSample(c, 'text', textPdf));
    const broken = breakToUnicode(textPdf);
    brokenReplaced += broken.replaced;
    if (broken.replaced) samples.push(await runSample(c, 'broken_tounicode', broken.pdf));
    samples.push(await runSample(c, 'image', await htmlToImagePdf(c.html)));
  }
  for (const flavor of ['text', 'broken_tounicode', 'image'] as const) {
    const xs = samples.filter((s) => s.flavor === flavor);
    const core = xs.filter((s) => s.coreOk).length;
    check(`합성 ${flavor}: 종류·발급일·만료일 ${core}/${xs.length}`, xs.length > 0 && core === xs.length, xs.filter((s) => !s.coreOk).map((s) => ({ id: s.id, mismatches: s.mismatches })));
  }
  const text = samples.filter((s) => s.flavor === 'text');
  check('합성 text: 발급기관·발급번호·사업자번호까지 전부 일치', text.every((s) => Object.values(s.fields).every(Boolean)), text.filter((s) => !Object.values(s.fields).every(Boolean)).map((s) => ({ id: s.id, mismatches: s.mismatches })));
  check('text PDF는 텍스트 층으로 읽는다(OCR 안 함)', text.every((s) => s.hasTextLayer && s.ocrConfidence === null));
  check('그림 PDF(붉은 직인·0.6° 기울기)는 텍스트 층 없음으로 보고 OCR로 읽는다', samples.filter((s) => s.flavor === 'image').every((s) => !s.hasTextLayer && s.ocrConfidence !== null));
  check('ToUnicode를 끊은 PDF: 깨진 텍스트 층을 쓰지 않는다(OCR로 넘어가거나 정상 복원)', samples.filter((s) => s.flavor === 'broken_tounicode').every((s) => s.coreOk), { replacedKeys: brokenReplaced, viaOcr: samples.filter((s) => s.flavor === 'broken_tounicode' && !s.hasTextLayer).length });

  // S13b: 5쪽 문서(작업당 ≤ 3초, 앞 5쪽만)
  const seven = await htmlToPdf(multiPageHtml(7));
  const multi = await parsePdfInSandbox(seven);
  check('7쪽 문서는 앞 5쪽만 읽는다', multi.pages === 5 && multi.totalPages === 7, { pages: multi.pages, totalPages: multi.totalPages });
  check('S13b 5쪽 텍스트 추출 ≤ 3초(작업당)', multi.ms <= 3000, { ms: multi.ms, timing: multi.timing, peakMemoryKb: multi.peakMemoryKb });
  const multiMeta = extractDocMeta(multi.text);
  const first = syntheticCerts()[0]!.expected;
  check('여러 쪽 문서도 같은 값으로 추출한다', multiMeta.docType === 'national_tax_cert' && multiMeta.issuedOn.value === first.issuedOn && multiMeta.validUntil.value === first.validUntil, { issuedOn: multiMeta.issuedOn, validUntil: multiMeta.validUntil });

  // 스캐너·복합기의 '검색 가능 PDF': 그림 위 보이지 않는 글자 층은 원본 텍스트로 믿지 않는다(scanned)
  const shot = await capture(syntheticCerts()[0]!.html);
  const size = shot.getSize();
  const scannedPdf = scannedTestPdf(shot.toJPEG(80), size.width, size.height, 'SYNTHETIC SCANNED CERTIFICATE WITH AN INVISIBLE OCR TEXT LAYER 2026');
  const scanned = await parsePdfInSandbox(scannedPdf, { ocrPages: 0 });
  check('보이지 않는 글자 층(렌더 모드 3)은 scanned로 알린다', scanned.hasTextLayer && scanned.scanned && scanned.ocrConfidence === null, { hasTextLayer: scanned.hasTextLayer, scanned: scanned.scanned });
  const plain = await parsePdfInSandbox(await htmlToPdf(syntheticCerts()[0]!.html));
  check('보통 텍스트 PDF는 scanned가 아니다', !plain.scanned);
  const forced = await parsePdfInSandbox(await htmlToPdf(syntheticCerts()[8]!.html), { forceOcr: true });
  const forcedMeta = extractDocMeta(forced.text);
  check('forceOcr: 텍스트 층이 있어도 OCR로 다시 읽는다(엔진의 다시 읽기 요청)', forced.hasTextLayer && forced.ocrConfidence !== null && forcedMeta.docType === 'biz_registration_cert' && forcedMeta.issuedOn.value === syntheticCerts()[8]!.expected.issuedOn, { ocrConfidence: forced.ocrConfidence, docType: forcedMeta.docType, issuedOn: forcedMeta.issuedOn });

  // 암호 PDF: 권한 암호만이면 그냥 열리고, 열기 암호는 코드로 묻는다(암호는 저장하지 않는다)
  const body = 'PASSWORD PROTECTED SYNTHETIC CERTIFICATE 2026 FOR DOCPARSE TEST';
  const locked = encryptedTestPdf('test1234', 'owner-pw', body);
  const noOcr: PdfOptions = { ocrPages: 0 };
  check('열기 암호 PDF: 암호 없이 → password_required', (await errCode(parsePdfInSandbox(locked, noOcr))) === 'password_required');
  check('열기 암호 PDF: 틀린 암호 → password_incorrect', (await errCode(parsePdfInSandbox(locked, { ...noOcr, password: 'nope' }))) === 'password_incorrect');
  const opened = await parsePdfInSandbox(locked, { ...noOcr, password: 'test1234' });
  check('열기 암호 PDF: 맞는 암호 → 본문', opened.text.includes('PASSWORD PROTECTED'), opened.text.slice(0, 80));
  const ownerOnly = await parsePdfInSandbox(encryptedTestPdf('', 'owner-pw', body), noOcr);
  check('권한 암호만 걸린 PDF는 암호 없이 열린다', ownerOnly.text.includes('PASSWORD PROTECTED'));

  // 잘못된 입력·상한
  const textPdf = await htmlToPdf(syntheticCerts()[0]!.html);
  check('빈 입력 거부', (await errCode(parsePdfInSandbox(new Uint8Array(0)))) === 'input_size');
  check('PDF 머리 없는 입력 거부', (await errCode(parsePdfInSandbox(new TextEncoder().encode('not a pdf at all')))) === 'not_pdf');
  const cut = await errCode(parsePdfInSandbox(textPdf.slice(0, Math.floor(textPdf.length / 3))));
  check('잘린 PDF는 코드로 끝난다(창 파기)', ['ok', 'invalid_pdf', 'parse_failed'].includes(cut), cut);
  check('시간 상한 초과 → timeout(창 파기)', (await errCode(parsePdfInSandbox(textPdf, { timeoutMs: 1 }))) === 'timeout');
  check('메모리 상한 초과 → memory_limit(창 파기)', (await errCode(parsePdfInSandbox(textPdf, { memoryLimitKb: 1 }))) === 'memory_limit');
  // 작업 도중(OCR 중)에 상한을 넘겨도 끊고 창을 파기한다: 창은 0.1초 안에 뜨고 OCR은 1초 넘게 걸린다(약 600MB)
  const imagePdf = await htmlToImagePdf(syntheticCerts()[0]!.html);
  check('OCR 도중 시간 상한 → timeout', (await errCode(parsePdfInSandbox(imagePdf, { timeoutMs: 700 }))) === 'timeout');
  check('OCR 도중 메모리 상한(300MB) → memory_limit', (await errCode(parsePdfInSandbox(imagePdf, { memoryLimitKb: 300_000 }))) === 'memory_limit');
  const pair = await Promise.all([parsePdfInSandbox(textPdf), parsePdfInSandbox(textPdf)]);
  check('동시 작업 두 개는 서로 다른 창에서 끝난다', pair.every((r) => r.hasTextLayer && r.text === pair[0]!.text));
  check('작업 뒤 docparse 창이 남지 않는다', BrowserWindow.getAllWindows().length === 0, BrowserWindow.getAllWindows().length);
  const blockedFetch = await session.fromPartition('sax-docparse').fetch('https://example.com/').then((r) => `status ${r.status}`, (e: Error) => `blocked: ${e.message.slice(0, 60)}`);
  check('docparse 파티션 외부 네트워크 차단(main 쪽 세션 fetch)', blockedFetch.startsWith('blocked'), blockedFetch);
  const egress = await egressProbe();
  const sent = (o: unknown) => Object.values(o as Record<string, string>).some((v) => v === 'sent' || v === 'open');
  check('docparse 창 안 송신 0: fetch·WebSocket 막힘, WebRTC STUN(UDP)·TURN(TCP)이 리스너에 닿지 않음', !sent(egress.page) && !sent(egress.dataPage) && egress.udpHits === 0 && egress.tcpHits === 0, egress);

  const s13b = Object.fromEntries(
    (['text', 'broken_tounicode', 'image'] as const).map((f) => {
      const xs = samples.filter((s) => s.flavor === f);
      return [f, { ms: stats(xs.map((s) => s.ms)), peakMemoryMb: stats(xs.map((s) => Math.round(s.peakMemoryKb / 1024))), ocrConfidence: f === 'text' ? null : stats(xs.map((s) => s.ocrConfidence ?? 0)), coreOk: `${xs.filter((s) => s.coreOk).length}/${xs.length}` }];
    }),
  );
  return { s13b, fivePages: { ms: multi.ms, timing: multi.timing, peakMemoryKb: multi.peakMemoryKb }, samples };
}

/** M1-8 자기 점검: docparse 창 안에서 eval·Function·문자열 setTimeout이 CSP로 막힌다(eval 0) */
async function selfCheck(): Promise<Record<string, unknown>> {
  const win = await createDocparseWindow();
  try {
    await win.loadURL(`${DOCPARSE_SCHEME}://app/index.html`);
    const r = (await win.webContents.executeJavaScript(`(() => {
      const t = (f) => { try { f(); return 'ran'; } catch (e) { return e && e.name === 'EvalError' ? 'blocked' : 'error ' + (e && e.name); } };
      return { eval: t(() => (0, eval)('1+1')), fn: t(() => new Function('return 1')()), wasm: typeof WebAssembly === 'object', node: typeof require === 'undefined' && typeof process === 'undefined' };
    })()`)) as Record<string, unknown>;
    check('자기 점검: docparse 창에서 eval·new Function이 막힌다(CSP, eval 0), Node 전역 없음', r.eval === 'blocked' && r.fn === 'blocked' && r.node === true && r.wasm === true, r);
    return r;
  } finally {
    win.destroy();
  }
}

/** 영수증 그림(JPEG). 기울기·바랜 글씨를 섞는다 */
async function receiptJpeg(r: SyntheticReceipt, k: number): Promise<Uint8Array> {
  const html = receiptHtml(r, { tilt: [0, 0.8, -0.6, 1.5][k % 4], faded: k % 3 === 2 });
  const w = new BrowserWindow({ show: false, width: 640, height: 1100, webPreferences: { offscreen: true, javascript: false, zoomFactor: 1.5 } });
  try {
    await w.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
    await new Promise((res) => setTimeout(res, 200));
    return new Uint8Array((await w.webContents.capturePage()).toJPEG(82));
  } finally {
    w.destroy();
  }
}

const RECEIPT_FIELDS = ['amount', 'issuedOn', 'merchant', 'bizNo'] as const;

function receiptScore(r: ReceiptResult, e: SyntheticReceipt['expected']): Record<(typeof RECEIPT_FIELDS)[number], boolean> {
  return { amount: r.amount.value === e.amount, issuedOn: r.issuedOn.value === e.issuedOn, merchant: r.merchant.value === e.merchant, bizNo: r.merchantBizNo.value === e.bizNo };
}

/** M6-4 정확도 표: 합성 24장 × OCR 모델 2종. 칸별 일치율, 잘못 읽은 값의 신뢰도(높은데 틀리면 위험) */
async function receipts(): Promise<Record<string, unknown>> {
  const R = syntheticReceipts();
  const images = await Promise.all(R.map((r, k) => receiptJpeg(r, k)));
  const table: Record<string, unknown> = {};
  for (const model of ['tessdata', 'best_int'] as OcrModel[]) {
    const rows: Array<Record<string, unknown>> = [];
    for (let k = 0; k < R.length; k++) {
      const r = R[k]!;
      const t0 = Date.now();
      try {
        const out = await parseInSandbox(images[k]!, 'receipt', { today: '2026-11-05', model });
        const res = out.result as ReceiptResult;
        const sc = receiptScore(res, r.expected);
        const wrongConf = RECEIPT_FIELDS.filter((f) => !sc[f]).map((f) => (f === 'bizNo' ? res.merchantBizNo : res[f]).confidence);
        rows.push({ id: r.id, layout: r.layout, ms: Date.now() - t0, ocr: out.source.ocrConfidence, ...sc, confidence: out.confidence, needsManual: out.needsManual, maxWrongConf: wrongConf.length ? Math.max(...wrongConf) : null, got: { amount: res.amount.value, issuedOn: res.issuedOn.value, merchant: res.merchant.value, bizNo: res.merchantBizNo.value }, ...(process.env.SAX_E2E_TEXT ? { text: out.text } : {}) });
      } catch (e) {
        rows.push({ id: r.id, layout: r.layout, error: e instanceof DocparseError ? e.code : String(e) });
      }
    }
    const rate = (f: string) => rows.filter((x) => x[f] === true).length;
    const all = rows.filter((x) => RECEIPT_FIELDS.every((f) => x[f] === true)).length;
    const ms = rows.map((x) => (x.ms as number) ?? 0);
    const wrongHigh = rows.filter((x) => typeof x.maxWrongConf === 'number' && (x.maxWrongConf as number) >= 0.8).length;
    table[model] = { n: rows.length, amount: rate('amount'), issuedOn: rate('issuedOn'), merchant: rate('merchant'), bizNo: rate('bizNo'), allFour: all, wrongButConfident: wrongHigh, ms: stats(ms), rows };
    console.log(`receipts[${model}] n=${rows.length} 금액 ${rate('amount')} 날짜 ${rate('issuedOn')} 상호 ${rate('merchant')} 사업자번호 ${rate('bizNo')} 넷 다 ${all} 틀렸는데 신뢰도≥0.8 ${wrongHigh} ms중앙 ${stats(ms).median}`);
  }
  // 사진 기본 모델(best_int)로 판정한다. tessdata 표는 비교용
  const best = table.best_int as { amount: number; issuedOn: number; n: number; wrongButConfident: number };
  check(`M6-4 합성 영수증 ${R.length}장(사진 OCR): 금액·날짜 각 80% 이상`, best.amount >= 0.8 * best.n && best.issuedOn >= 0.8 * best.n, { amount: best.amount, issuedOn: best.issuedOn });
  check('M6-4 틀린 칸의 신뢰도가 0.8 이상인 영수증은 2장 이하(높은 신뢰도로 틀리지 않는다)', best.wrongButConfident <= 2, best.wrongButConfident);
  // 폰 사진 경로(M7-4): 같은 parse(receipt) 입구에 EXIF 없는 JPEG을 넣는다. PNG도 같은 길
  const png = await (async () => {
    const w = new BrowserWindow({ show: false, width: 640, height: 1100, webPreferences: { offscreen: true, javascript: false, zoomFactor: 1.5 } });
    try {
      await w.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(receiptHtml(R[0]!)));
      await new Promise((res) => setTimeout(res, 200));
      return new Uint8Array((await w.webContents.capturePage()).toPNG());
    } finally {
      w.destroy();
    }
  })();
  const p = await parseInSandbox(png, 'receipt', { today: '2026-11-05' });
  check('PNG 영수증도 같은 길(형식은 머리로 고른다)', p.source.format === 'png' && (p.result as ReceiptResult).amount.value === R[0]!.expected.amount, p.result);
  const raw = await ocrImageInSandbox(images[0]!, { mode: 'photo' });
  check('그림 OCR 출력: 줄마다 신뢰도, text는 줄을 이은 것, EXIF 없음(합성 JPEG)', raw.lines.length > 5 && raw.text === raw.lines.map((l) => l.text).join('\n') && raw.exif === false, { lines: raw.lines.length, exif: raw.exif });
  return table;
}

/** M6-5 표 파일: 샌드박스에서 읽은 결과가 Node에서 읽은 것과 같고, 규칙까지 통과한다 */
async function sheets(): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  for (const fx of [deliveryXlsx(), marketCsv()]) {
    const r = await parseInSandbox(await fx.bytes, 'settlement', { expectedChannel: fx.expected.channel });
    const res = r.result as { totals: { gross: number | null; payout: number | null }; rows: unknown[] };
    out[fx.name] = { warnings: r.warnings, totals: res.totals };
    check(`M6-5 ${fx.name}(샌드박스): 줄 ${fx.expected.rows}·매출·정산 합계`, res.rows.length === fx.expected.rows && res.totals.gross === fx.expected.gross && res.totals.payout === fx.expected.payout, res.totals);
  }
  for (const fx of [healthNoticeXlsx(), pensionNoticeCsv()]) {
    const r = await parseInSandbox(await fx.bytes, 'insurance_notice');
    const res = r.result as { rows: Array<{ name: string; employee: number | null }>; month: { value: string | null } };
    out[fx.name] = { warnings: r.warnings, rows: res.rows.length };
    check(`M6-5 ${fx.name}(샌드박스): 직원·보험 ${fx.expected.rows.length}줄, 고지 년월`, res.rows.length === fx.expected.rows.length && res.month.value === fx.expected.month && !JSON.stringify(r).includes('123456'), { rows: res.rows.length, month: res.month });
  }
  const t = await readSheetInSandbox(await deliveryXlsx().bytes);
  check('표 작업 시간 ≤ 3초, 메모리 ≤ 900MB(창 생성부터)', t.ms <= 3000 && t.peakMemoryKb <= 900_000, { ms: t.ms, peakMemoryMb: Math.round(t.peakMemoryKb / 1024) });
  return out;
}

/** M6-12 시드 코퍼스를 실제 샌드박스에: 거부 코드, 무시 경고, 표지 문자열 없음, 시드가 가리키는 주소로 송신 0 */
async function seeds(): Promise<Record<string, unknown>> {
  let hits = 0;
  const tcp = net.createServer((sock) => {
    hits++;
    sock.destroy();
  });
  await new Promise<void>((r) => tcp.listen(0, '127.0.0.1', r));
  const port = (tcp.address() as net.AddressInfo).port;
  const retarget = (b: Uint8Array) => {
    const s = Buffer.from(b).toString('latin1');
    return s.includes('127.0.0.1:9/') ? new Uint8Array(Buffer.from(s.replaceAll('127.0.0.1:9/', `127.0.0.1:${port}/`), 'latin1')) : b;
  };
  const rows: Array<Record<string, unknown>> = [];
  try {
    for (const seed of seedCorpus()) {
      const bytes = retarget(await seed.bytes());
      const kind = seed.target === 'sheet' ? 'settlement' : seed.target === 'pdf' ? 'certificate' : 'receipt';
      let got: string;
      let leaked = false;
      let warnings: string[] = [];
      try {
        if (seed.target === 'sheet' && 'ignore' in seed.expect) {
          const sh = await readSheetInSandbox(bytes);
          leaked = seed.name !== 'csv-formula-injection.csv' && JSON.stringify(sh.sheets).includes(CANARY);
          warnings = Object.entries(sh.flags).filter(([, v]) => v).map(([k]) => k);
          got = 'ok';
        } else {
          const r = await parseInSandbox(bytes, kind, { today: '2026-11-05' });
          leaked = JSON.stringify(r).includes(CANARY);
          warnings = r.warnings;
          got = 'ok';
        }
      } catch (e) {
        got = e instanceof DocparseError ? e.code : `throw:${(e as Error).message}`;
      }
      const ok = 'reject' in seed.expect ? seed.expect.reject.includes(got) : (got === 'ok' || seed.target === 'pdf') && !leaked;
      rows.push({ name: seed.name, got, ok, leaked, warnings });
    }
    await new Promise((r) => setTimeout(r, 500));
  } finally {
    tcp.close();
  }
  const bad = rows.filter((r) => !r.ok);
  check(`M6-12 시드 ${rows.length}개: 거부할 것은 코드로, 무시할 것은 표지 없이`, bad.length === 0, bad);
  check('M6-12 시드가 가리키는 주소(PDF 자바스크립트·URI·외부 연결·XXE)로 송신 0', hits === 0, hits);
  check('시드 뒤 docparse 창이 남지 않는다', BrowserWindow.getAllWindows().length === 0, BrowserWindow.getAllWindows().length);
  return { rows, hits };
}

async function main(): Promise<void> {
  const part = process.env.SAX_DOCPARSE_E2E ?? 'all';
  const report: Record<string, unknown> = { platform: process.platform, arch: process.arch, electron: process.versions.electron, chrome: process.versions.chrome, today: TODAY };
  // 서류 부분이 맨 앞이다: 첫 docparse 작업 전에 세션 준비 실패를 흉내 낸다
  if (part === 'all') Object.assign(report, await certificates());
  report.self = await selfCheck();
  if (part === 'all' || part === 'receipts') report.receipts = await receipts();
  if (part === 'all' || part === 'sheets') report.sheets = await sheets();
  if (part === 'all' || part === 'seeds') report.seeds = await seeds();
  const dir = process.env.SAX_E2E_OUT ?? app.getPath('temp');
  const out = path.join(dir, 'docparse-e2e.json');
  await fs.writeFile(out, JSON.stringify({ ...report, checks: results }, null, 2));
  console.log(`report: ${out}`);
}

app.whenReady().then(async () => {
  try {
    await main();
  } catch (e) {
    check('e2e 예외 없음', false, (e as Error).stack);
  }
  for (const r of results) console.log(`${r.ok ? 'ok  ' : 'FAIL'} ${r.name}${r.ok ? '' : ` ${JSON.stringify(r.detail)}`}`);
  app.exit(results.length && results.every((r) => r.ok) ? 0 : 1);
});
