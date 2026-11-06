// 금고 PDF 저장(save_pdf 금고 쪽, D05 §3.3, ADR-025, 팀장 결정 2026-11-06).
// 엔진의 직접 printToPDF·다운로드 설정은 거부하고, 금고가 자기 세션에서 인쇄하거나 무장된 다운로드 1건만 staging에 받는다.
// 엔진에는 fileId만 간다(바이트·원래 파일 이름 없음). 크기 초과·비PDF는 staging에 아무것도 남기지 않는다.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';
import { checkPdfBytes, PDF_FILE_ID_RE, PDF_MAX_BYTES, RPC_BY_PORT, stagedPdfPath, type PdfPrintResult } from '@sax/vault';
import { startHarness, type Harness } from './harness.ts';
import { RawEngine, sleep } from './raw-engine.ts';

const enc = (s: string) => new TextEncoder().encode(s);
const MINI_PDF = '%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n';
/** 원래 파일 이름(PII 흉내). staging·엔진·로그 어디에도 나오면 안 된다. */
const ORIGINAL_NAME = 'hong-gildong-invoice-20261106.pdf';

describe('PDF 검사·경로(단위)', () => {
  it('checkPdfBytes: 정상·빈 것·상한 초과·머리 없음·잘림(%%EOF 없음)', () => {
    assert.equal(checkPdfBytes(enc(MINI_PDF)), 'ok');
    assert.equal(checkPdfBytes(enc('%PDF-2.0\n%%EOF')), 'ok');
    assert.equal(checkPdfBytes(new Uint8Array(0)), 'empty');
    assert.equal(checkPdfBytes(enc(MINI_PDF), 10), 'too_large');
    assert.equal(checkPdfBytes(enc('<!doctype html><html>%PDF-1.4 %%EOF</html>')), 'not_pdf', '앞에 다른 것이 있으면 PDF가 아니다');
    assert.equal(checkPdfBytes(enc('%PDF-1.4\n1 0 obj')), 'not_pdf', '잘린 파일');
    assert.equal(checkPdfBytes(enc('%PDF-x\n%%EOF')), 'not_pdf');
    assert.equal(PDF_MAX_BYTES, 15 * 1024 * 1024);
  });

  it('stagedPdfPath: 32 hex만, 경로 탈출·다른 모양은 거부', () => {
    assert.match(stagedPdfPath('/s', 'a'.repeat(32)), /a{32}\.pdf$/);
    for (const bad of ['../x', 'A'.repeat(32), 'a'.repeat(31), `${'a'.repeat(32)}/..`, '']) assert.throws(() => stagedPdfPath('/s', bad), /bad_file_id/, bad);
  });

  it('엔진 포트에만 pdf.print·download.arm·download.disarm이 있다', () => {
    for (const m of ['pdf.print', 'download.arm', 'download.disarm']) {
      assert.ok(RPC_BY_PORT.engine.includes(m), m);
      assert.ok(!RPC_BY_PORT.control.includes(m) && !RPC_BY_PORT.secretInput.includes(m), m);
    }
  });
});

interface Site {
  origin: string;
  close(): Promise<void>;
}

/** 다운로드 흉내 서버(127.0.0.1). /fake.pdf는 Content-Type만 PDF이고 내용은 HTML이다. */
async function startSite(): Promise<Site> {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    const attach = (type: string, body: string) => {
      res.writeHead(200, { 'content-type': type, 'content-disposition': `attachment; filename="${ORIGINAL_NAME}"` });
      res.end(body);
    };
    switch (url.pathname) {
      case '/doc':
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(`<!doctype html><html><head><meta charset="utf-8"><title>doc</title></head><body>
<h1>전자세금계산서</h1><p>${'공급가액 1,000,000원 '.repeat(40)}</p>
<a id="pdf" href="/real.pdf">pdf</a> <a id="fake" href="/fake.pdf">fake</a> <a id="big" href="/big.pdf">big</a>
</body></html>`);
        return;
      case '/real.pdf':
        return attach('application/pdf', MINI_PDF);
      case '/fake.pdf':
        return attach('application/pdf', '<!doctype html><html><body>not a pdf</body></html>');
      case '/big.pdf':
        return attach('application/pdf', '%PDF-1.4\n' + 'x'.repeat(16 * 1024) + '\n%%EOF\n');
      default:
        res.writeHead(404);
        res.end();
    }
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return {
    origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

async function stagingNames(h: Harness): Promise<string[]> {
  return (await fs.readdir(h.paths.staging)).sort();
}

async function clearStaging(h: Harness): Promise<void> {
  for (const n of await fs.readdir(h.paths.staging)) await fs.rm(`${h.paths.staging}/${n}`, { force: true });
}

/**
 * 엔진·control IPC에 PDF 바이트가 없고, 엔진은 Page.download* 이벤트(guid·원래 파일 이름)를 받지 않는다.
 * 로그에는 바이트·원래 파일 이름·화면 글자가 없다(⑦). 응답 헤더(Content-Disposition)는 엔진이 원래 보는 Network 이벤트에 있다.
 */
function assertNothingLeaked(h: Harness, eng: RawEngine): void {
  const ipc = JSON.stringify(h.capture);
  for (const needle of ['%PDF', 'JVBERi']) assert.ok(!ipc.includes(needle), `IPC에 ${needle}`);
  assert.deepEqual(eng.events.filter((e) => String(e.method).startsWith('Page.download')), [], '엔진이 Page.download* 이벤트를 받았다');
  const logs = h.log.lines.join('\n');
  for (const needle of ['%PDF', ORIGINAL_NAME, 'hong-gildong', '공급가액', '/real.pdf']) assert.ok(!logs.includes(needle), `로그에 ${needle}`);
}

describe('금고 PDF 저장(실제 Chrome)', () => {
  let site: Site;
  let h: Harness;
  let eng: RawEngine;
  let sid: string;
  let targetId: string;

  before(async () => {
    site = await startSite();
    h = await startHarness({ pdf: { maxBytes: 4096, armTtlMs: 1500 } });
    eng = new RawEngine(h.client);
    await h.client.rpc('browser.launch');
    ({ sessionId: sid, targetId } = await eng.attachRunPage());
    await eng.navigate(sid, `${site.origin}/doc`);
  });

  after(async () => {
    await h?.close();
    await site?.close();
  });

  it('거부: 엔진의 Page.printToPDF·Page/Browser.setDownloadBehavior는 중계가 막는다', async () => {
    const print = await eng.tryCall('Page.printToPDF', {}, sid);
    assert.equal(print.ok, false);
    assert.equal((await eng.tryCall('Page.setDownloadBehavior', { behavior: 'allow', downloadPath: '/tmp' }, sid)).ok, false);
    assert.equal((await eng.tryCall('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: '/tmp' })).ok, false);
    assert.deepEqual(await stagingNames(h), []);
  });

  it('정상 인쇄: staging에 무작위 이름·사용자 전용 권한으로 두고 엔진에는 fileId만 준다', async () => {
    await clearStaging(h);
    const big = await startHarness({ pdf: { armTtlMs: 1500 } });
    try {
      const e2 = new RawEngine(big.client);
      await big.client.rpc('browser.launch');
      const run = await e2.attachRunPage();
      await e2.navigate(run.sessionId, `${site.origin}/doc`);
      const ev = big.client.once('download.completed', () => true, 20_000);
      const r = await big.client.rpc<PdfPrintResult>('pdf.print', { runId: 'r1', targetId: run.targetId });
      assert.equal(r.ok, true);
      const fileId = (r as { fileId: string }).fileId;
      assert.match(fileId, PDF_FILE_ID_RE);
      assert.deepEqual(Object.keys(r).sort(), ['fileId', 'ok'], '결과에 바이트·경로가 없다');
      assert.deepEqual(await ev, { fileId });
      assert.deepEqual(await stagingNames(big), [`${fileId}.pdf`]);
      const file = stagedPdfPath(big.paths.staging, fileId);
      const bytes = new Uint8Array(await fs.readFile(file));
      assert.equal(checkPdfBytes(bytes), 'ok');
      if (process.platform !== 'win32') assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
      assertNothingLeaked(big, e2);
      assert.ok(big.log.lines.some((l) => l.includes('vault.pdf_saved')));
    } finally {
      await big.close();
    }
  });

  it('크기 초과: 인쇄 결과가 상한을 넘으면 too_large, staging에 남지 않는다', async () => {
    await clearStaging(h);
    const r = await h.client.rpc<PdfPrintResult>('pdf.print', { runId: 'r1', targetId });
    assert.deepEqual(r, { ok: false, reason: 'too_large' });
    assert.deepEqual(await stagingNames(h), []);
  });

  it('인자·타깃 검사: 노출 안 된 타깃·틀린 runId는 거부', async () => {
    assert.deepEqual(await h.client.rpc('pdf.print', { runId: 'r1', targetId: 'NOPE' }), { ok: false, reason: 'target_not_exposed' });
    assert.deepEqual(await h.client.rpc('pdf.print', { runId: '../x', targetId }), { ok: false, reason: 'bad_params' });
    assert.deepEqual(await h.client.rpc('download.arm', { runId: 'r1', targetId: 'NOPE' }), { armed: false, reason: 'target_not_exposed' });
  });

  it('무장한 다운로드: PDF면 무작위 이름으로 받고 download.completed{fileId}만 낸다(원래 이름 없음)', async () => {
    await clearStaging(h);
    assert.deepEqual(await h.client.rpc('download.arm', { runId: 'r1', targetId }), { armed: true });
    assert.deepEqual(await h.client.rpc('download.arm', { runId: 'r1', targetId }), { armed: false, reason: 'already_armed' });
    const ev = h.client.once('download.completed', () => true, 20_000);
    await eng.evaluate(sid, `document.getElementById('pdf').click()`);
    const { fileId } = (await ev) as { fileId: string };
    assert.match(fileId, PDF_FILE_ID_RE);
    assert.deepEqual(await stagingNames(h), [`${fileId}.pdf`]);
    assert.equal(await fs.readFile(stagedPdfPath(h.paths.staging, fileId), 'latin1'), MINI_PDF);
    assertNothingLeaked(h, eng);
  });

  it('비PDF 거부: Content-Type이 PDF여도 내용이 아니면 not_pdf, staging에 남지 않는다', async () => {
    await clearStaging(h);
    assert.deepEqual(await h.client.rpc('download.arm', { runId: 'r1', targetId }), { armed: true });
    const ev = h.client.once('download.failed', () => true, 20_000);
    await eng.evaluate(sid, `document.getElementById('fake').click()`);
    assert.deepEqual(await ev, { reason: 'not_pdf' });
    await sleep(200);
    assert.deepEqual(await stagingNames(h), []);
  });

  it('다운로드 크기 초과: 받는 중 상한을 넘으면 취소하고 too_large', async () => {
    await clearStaging(h);
    assert.deepEqual(await h.client.rpc('download.arm', { runId: 'r1', targetId }), { armed: true });
    const ev = h.client.once('download.failed', () => true, 20_000);
    await eng.evaluate(sid, `document.getElementById('big').click()`);
    assert.deepEqual(await ev, { reason: 'too_large' });
    await sleep(300);
    assert.deepEqual(await stagingNames(h), []);
  });

  it('무장 없는 다운로드는 취소하고 지운다(엔진 이벤트 없음), 무장은 시간이 지나면 expired', async () => {
    await clearStaging(h);
    const events: unknown[] = [];
    const off1 = h.client.on('download.completed', (d) => events.push(d));
    const off2 = h.client.on('download.failed', (d) => events.push(d));
    await eng.evaluate(sid, `document.getElementById('pdf').click()`);
    await sleep(1000);
    assert.deepEqual(events, []);
    assert.deepEqual(await stagingNames(h), []);
    assert.ok(h.log.lines.some((l) => l.includes('vault.download_unexpected')));
    off1();
    off2();
    assert.deepEqual(await h.client.rpc('download.arm', { runId: 'r1', targetId }), { armed: true });
    assert.deepEqual(await h.client.once('download.failed', () => true, 5000), { reason: 'expired' });
  });
});
