// Electron e2e: docparse 샌드박스 OCR·공동인증서 certInfo. 앱 폴더·키체인을 쓰지 않는다.
// 승인 바(ADR-021) e2e는 shell-e2e.ts(PoC-9)로 옮겼다.
// 실행: electron apps/desktop/e2e-dist/ocr-e2e.js (옛 src/e2e.ts, 개발 콘솔 삭제 W-1 때 옮겼다)
import './os-guard.js'; // 실제 Finder·브라우저·대화상자를 띄우지 않는다(맨 먼저)
import fs from 'node:fs/promises';
import path from 'node:path';
import { app, BrowserWindow, protocol, session } from 'electron';
import { parseBizCert } from '@sax/engine/bizcert';
import { readBizCert } from '../dist/bizcert-read.js';
import { certInfoInSandbox, DOCPARSE_SCHEME, ocrImageInSandbox, ocrInSandbox, parsePdfInSandbox } from '../dist/docparse.js';

protocol.registerSchemesAsPrivileged([{ scheme: DOCPARSE_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true } }]);
app.setPath('userData', path.join(app.getPath('temp'), `sax-e2e-${process.pid}`));
app.on('window-all-closed', () => {}); // 창이 모두 닫혀도 e2e가 끝날 때까지 유지

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const results: Array<{ name: string; ok: boolean; detail?: unknown }> = [];
const check = (name: string, ok: boolean, detail?: unknown) => results.push({ name, ok, detail });

async function docparseTests(): Promise<void> {
  // 등록증 이미지를 숨김 창에서 그려 캡처한다(테스트 입력 생성용).
  const w = new BrowserWindow({ show: false, width: 1000, height: 760, webPreferences: { offscreen: true } });
  const html = `<!doctype html><meta charset="utf-8"><body style="font-family:'Apple SD Gothic Neo','Malgun Gothic',sans-serif;font-size:24px;padding:40px;background:#fff">
<h1 style="text-align:center;letter-spacing:12px">사업자등록증</h1><p style="text-align:center">(일반과세자)</p><p style="text-align:center">등록번호 : 220-81-62517</p>
<p>상 호 : 마바사상회</p><p>대 표 자 : 최마바</p><p>개 업 연 월 일 : 2021 년 06 월 30 일</p><p>사업장 소재지 : 부산광역시 해운대구 센텀로 5</p></body>`;
  await w.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
  await sleep(300);
  const png = (await w.webContents.capturePage()).toPNG();
  const pdf = await w.webContents.printToPDF({});
  w.destroy();
  const ocr = await ocrInSandbox(new Uint8Array(png));
  const parsed = parseBizCert(ocr.text);
  check('docparse 샌드박스 OCR(kor) → 등록번호·대표자·개업일', parsed.fields.repName === '최마바' && parsed.fields.openDate === '20210630' && (parsed.fields.bizNo === '2208162517' || parsed.bizNoSuggestions.includes('2208162517')), { ms: ocr.ms, confidence: ocr.confidence, fields: parsed.fields });
  // 온보딩 O-02 경로(M4-3): 고른 파일(그림·글자 층 PDF) → 실제 샌드박스 → bizcert.parse와 같은 해석 → 온보딩 칸
  const logs: unknown[] = [];
  const read = (bytes: Buffer) =>
    readBizCert({
      pick: async () => new Uint8Array(bytes),
      pdfText: async (b, o) => (await parsePdfInSandbox(b, { ocrPages: 1, forceOcr: o.forceOcr })).text,
      imageText: async (b) => (await ocrImageInSandbox(b, { mode: 'document' })).text,
      parse: async (text) => parseBizCert(text),
      log: (n, d) => logs.push([n, d]),
    });
  const fromPng = await read(png);
  check('O-02 등록증 그림 → 샌드박스 OCR(증명서 모드) → 상호·대표자·주소', fromPng?.rep === '최마바' && /마바사/.test(fromPng.name) && /해운대구/.test(fromPng.address), { fields: fromPng, logs: logs.slice() });
  const fromPdf = await read(pdf);
  check('O-02 등록증 PDF(글자 층) → 샌드박스 → 번호·상호·대표자 정확', fromPdf?.bizNo === '2208162517' && fromPdf.name === '마바사상회' && fromPdf.rep === '최마바', { fields: fromPdf, log: logs.at(-1) });
  check('O-02 로그는 형식·경로 코드만(글자·값 없음)', !JSON.stringify(logs).includes('마바사') && !JSON.stringify(logs).includes('2208162517'), logs);
  const ses = session.fromPartition('sax-docparse');
  const net = await ses.fetch('https://example.com/').then((r) => `status ${r.status}`, (e: Error) => `blocked: ${e.message.slice(0, 60)}`);
  check('docparse 파티션 외부 네트워크 차단', net.startsWith('blocked'), net);
  const bad = await ocrInSandbox(new Uint8Array(0)).then(() => 'accepted', (e: Error) => e.message);
  check('빈 입력 거부', bad === 'input_size', bad);
}

// ── 공동인증서 certInfo(샌드박스, #95). 합성 DER: 서명은 검증하지 않으므로 빈 서명 비트열이면 된다 ──
const len = (n: number) => (n < 0x80 ? [n] : n < 0x100 ? [0x81, n] : [0x82, n >> 8, n & 0xff]);
const T = (tag: number, ...body: Uint8Array[]) => {
  const v = Buffer.concat(body);
  return new Uint8Array(Buffer.concat([Buffer.from([tag, ...len(v.length)]), v]));
};
const seq = (...b: Uint8Array[]) => T(0x30, ...b);
const set = (...b: Uint8Array[]) => T(0x31, ...b);
function oid(s: string): Uint8Array {
  const a = s.split('.').map(Number);
  const out = [a[0]! * 40 + a[1]!];
  for (const x of a.slice(2)) {
    const enc = [x & 0x7f];
    for (let v = x >>> 7; v > 0; v >>>= 7) enc.unshift((v & 0x7f) | 0x80);
    out.push(...enc);
  }
  return T(0x06, Buffer.from(out));
}
const atv = (o: string, v: Uint8Array) => set(seq(oid(o), v));
const utf8s = (s: string) => T(0x0c, Buffer.from(s, 'utf8'));
const printable = (s: string) => T(0x13, Buffer.from(s, 'latin1'));
const utc = (s: string) => T(0x17, Buffer.from(s, 'latin1'));
const ED25519 = seq(oid('1.3.101.112'));
function syntheticCert(): Uint8Array {
  const name = (cn: Uint8Array) => seq(atv('2.5.4.6', printable('kr')), atv('2.5.4.10', printable('yessign')), atv('2.5.4.3', cn));
  const spki = seq(ED25519, T(0x03, Buffer.from([0]), Buffer.alloc(32, 7)));
  const tbs = seq(T(0xa0, T(0x02, Buffer.from([2]))), T(0x02, Buffer.from([0x01, 0x23])), ED25519, name(printable('TEST-yessignCA Class 2')), seq(utc('260102030405Z'), utc('270102235959Z')), name(utf8s('TEST홍길동()0001234567890123')), spki);
  return seq(tbs, ED25519, T(0x03, Buffer.from([0]), Buffer.alloc(64)));
}

async function certInfoTests(): Promise<void> {
  const codeOf = (p: Promise<unknown>) => p.then(() => 'ok', (e: Error & { code?: string }) => e.code ?? e.message);
  const der = syntheticCert();
  const info = await certInfoInSandbox(der);
  check('certInfo: 샌드박스가 읽은 고정 4필드(주체·발급자 RFC 4514, 유효기간 UTC)', info.subject === 'CN=TEST홍길동()0001234567890123,O=yessign,C=kr' && info.issuer === 'CN=TEST-yessignCA Class 2,O=yessign,C=kr' && info.notBefore === '2026-01-02T03:04:05Z' && info.notAfter === '2027-01-02T23:59:59Z' && Object.keys(info).length === 4, info);
  const sizes = { 0: await codeOf(certInfoInSandbox(new Uint8Array(0))), 1: await codeOf(certInfoInSandbox(new Uint8Array([0x30]))), 8192: await codeOf(certInfoInSandbox(new Uint8Array(8192).fill(0x30))), 8193: await codeOf(certInfoInSandbox(new Uint8Array(8193))) };
  check('certInfo 크기 경계: 0·8193바이트는 샌드박스에 가기 전 input_size, 1·8192바이트는 샌드박스가 읽고 cert_invalid', sizes[0] === 'input_size' && sizes[8193] === 'input_size' && sizes[1] === 'cert_invalid' && sizes[8192] === 'cert_invalid', sizes);
  const tail = new Uint8Array([...der, 0]);
  check('certInfo: 뒤에 덧붙인 바이트·잘린 DER은 cert_invalid', (await codeOf(certInfoInSandbox(tail))) === 'cert_invalid' && (await codeOf(certInfoInSandbox(der.slice(0, der.length - 5)))) === 'cert_invalid');
}

app.whenReady().then(async () => {
  try {
    await docparseTests();
    await certInfoTests();
  } catch (e) {
    check('e2e 예외 없음', false, (e as Error).stack);
  }
  const out = path.resolve(import.meta.dirname, '../../../reports/raw/e2e-desktop.json');
  await fs.mkdir(path.dirname(out), { recursive: true });
  await fs.writeFile(out, JSON.stringify(results, null, 2));
  for (const r of results) console.log(`${r.ok ? 'ok  ' : 'FAIL'} ${r.name}`);
  app.exit(results.every((r) => r.ok) ? 0 : 1);
});
