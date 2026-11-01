// PoC-8 e2e: 합성 서류 PDF → docparse 샌드박스(pdf.js, 텍스트 층이 없으면 OCR) → 메타 규칙(S4) → 기대값 비교, S13b 측정.
// 실행: electron apps/desktop/dist/docparse-e2e.js → reports/raw/poc-8-docparse.json. 앱 폴더·키체인을 쓰지 않는다.
import dgram from 'node:dgram';
import fs from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { app, BrowserWindow, protocol, session } from 'electron';
import { decideExpiry, extractDocMeta, validateDocMeta, type DocMetaExtract } from '@sax/engine/docmeta';
import { createDocparseWindow, DOCPARSE_SCHEME, DocparseError, parsePdfInSandbox, type PdfExtractRun, type PdfOptions } from './docparse.ts';
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

async function main(): Promise<void> {
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
  const out = path.resolve(import.meta.dirname, '../../../reports/raw/poc-8-docparse.json');
  await fs.writeFile(out, JSON.stringify({ platform: process.platform, arch: process.arch, electron: process.versions.electron, chrome: process.versions.chrome, today: TODAY, s13b, fivePages: { ms: multi.ms, timing: multi.timing, peakMemoryKb: multi.peakMemoryKb }, checks: results, samples }, null, 2));
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
