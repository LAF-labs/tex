// 발급 결과 PDF 보관(2026-11-11 리허설 F-04): save_pdf(H-01 s32) → 금고 staging → 보관함 실행 산출물(tax_invoice, run_id).
// - DocumentService.importRunArtifact: 글자를 읽지 않고 넣는다. 재시작(새 서비스·같은 DB) 뒤에도 목록·파일 경로가 그대로다.
// - VaultPdfPort.store(artifact): staging 파일을 읽어 산출물로 넣고 staging을 지운다.
// - IR 실행(가짜 H-01 페이지): 포트가 있으면 s32가 artifact.saved로 지나 메일 확인(s33)까지 가고, 없으면 engine.unhandled_step으로 끝났다.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { BizVerifier, connectRunBrowser, DataService, fixturePortal, recordRunInputs, RunService, runHistory, VaultPdfPort, type GatePortMessage, type GateRequest, type IrPackage, type PdfVault, type RunEvent } from '@sax/engine';
import { fixtureOriginGrant, type PdfPort } from '@sax/engine/core';
import { ColumnCipher, openDatabase, ValidationError, type Db } from '@sax/db';
import { Egress } from '@sax/net';
import { FileEventLog } from '@sax/platform';
import type { Page } from 'playwright-core';
import { startH01Fixture, type H01Fixture } from '../apps/desktop/src/h01-fixture.ts';
import { startHarness, type Harness } from './harness.ts';
import { h01FixtureLookupDefs, loadH01Fixture } from './h01-fixture-package.ts';

const PDF = new TextEncoder().encode('%PDF-1.7\n1 0 obj<<>>endobj\n%%EOF\n');
const SUPPLIER = { bizNo: '1234567891', name: '가나다컴퍼니' };
const fid = () => randomBytes(16).toString('hex');

async function tmp(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), prefix));
}
function openData(dir: string, key: Uint8Array): { db: Db; data: DataService } {
  const db = openDatabase(path.join(dir, 'db.sqlite'), key);
  return { db, data: new DataService(db, new BizVerifier(new Egress()), { vaultDir: path.join(dir, 'vault') }) };
}
const business = (data: DataService) =>
  data.profiles.upsert({ kind: 'business', displayName: SUPPLIER.name, bizNo: SUPPLIER.bizNo, corpNo: null, repName: '김가나', bizType: null, bizItem: null, address: null, email: null, signMethod: 'simple_auth' });

describe('DocumentService.importRunArtifact(실행 산출물)', () => {
  let dir: string;
  const key = new Uint8Array(randomBytes(32));
  before(async () => {
    dir = await tmp('sax-artifact-');
  });
  after(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('전자세금계산서로 넣고(source app, 확인 필요 없음, 만료 없음) 재시작 뒤에도 목록·파일이 남는다', async () => {
    let { db, data } = openData(dir, key);
    business(data);
    const v = await data.documents.importRunArtifact(PDF, { runId: 'run-1', docType: 'tax_invoice' });
    assert.equal(v.docType, 'tax_invoice');
    assert.equal(v.displayName, '전자세금계산서');
    assert.equal(v.source, 'app');
    assert.equal(v.needsUser, false);
    assert.equal(v.expiresOn, null);
    assert.match(v.issuedOn ?? '', /^\d{4}-\d{2}-\d{2}$/);
    const file = await data.documents.filePath(v.id);
    assert.match(path.basename(file), /^tax_invoice_\d{8}_[0-9A-Z]{4}\.pdf$/, '파일 이름에 거래처·승인번호가 없다(V-23)');
    db.close();
    // 재시작: 같은 DB·같은 보관함
    ({ db, data } = openData(dir, key));
    const list = data.documents.list();
    assert.deepEqual(list.map((d) => [d.id, d.docType, d.source]), [[v.id, 'tax_invoice', 'app']]);
    assert.deepEqual(await fs.readFile(await data.documents.filePath(v.id)), Buffer.from(PDF));
    const row = db.prepare('SELECT run_id FROM documents WHERE id = ?').get(v.id) as { run_id: string };
    assert.equal(row.run_id, 'run-1', '실행과 잇는다');
    // 같은 파일이면 새 줄을 만들지 않는다
    assert.equal((await data.documents.importRunArtifact(PDF, { runId: 'run-1', docType: 'tax_invoice' })).duplicate, true);
    assert.equal(data.documents.list().length, 1);
    db.close();
  });

  it('고칠 칸이 없다(app_document), 종류·바이트·실행 id를 검사한다', async () => {
    const { db, data } = openData(dir, key);
    const v = data.documents.list()[0]!;
    assert.throws(() => data.documents.update(v.id, { issuedOn: '2026-01-01' }, { docType: v.docType, issuedOn: v.issuedOn, expiresOn: v.expiresOn }), (e: unknown) => e instanceof ValidationError && e.code === 'app_document');
    const code = (p: Promise<unknown>) => p.then(() => 'ok', (e: ValidationError) => e.code);
    assert.equal(await code(data.documents.importRunArtifact(PDF, { runId: 'run-2', docType: 'national_tax_cert' })), 'invalid_doc_type');
    assert.equal(await code(data.documents.importRunArtifact(new TextEncoder().encode('not a pdf'), { runId: 'run-2', docType: 'tax_invoice' })), 'not_pdf');
    assert.equal(await code(data.documents.importRunArtifact(PDF, { runId: '', docType: 'tax_invoice' })), 'bad_run');
    db.close();
  });
});

describe('VaultPdfPort.store(artifact)', () => {
  it('staging 파일을 산출물로 넣고 지운다. 글자 추출·사용자 가져오기를 부르지 않는다', async () => {
    const staging = await tmp('sax-staging-');
    try {
      const fileId = fid();
      await fs.writeFile(path.join(staging, `${fileId}.pdf`), PDF);
      const got: Array<{ runId: string; docType: string; bytes: number }> = [];
      const vault: PdfVault = { rpc: async () => ({}) as never, on: () => () => {} };
      const port = new VaultPdfPort({
        vault, targetId: () => 't1', staging,
        documents: { import: async () => assert.fail('사용자 가져오기를 부르지 않는다') },
        extract: async () => assert.fail('추출하지 않는다'),
        artifact: async (b, o) => (got.push({ ...o, bytes: b.length }), { id: 'doc-9' }),
      });
      assert.deepEqual(await port.store({ runId: 'r1', stepId: 's32', fileId, docType: 'tax_invoice' }), { ok: true, documentId: 'doc-9' });
      assert.deepEqual(got, [{ runId: 'r1', docType: 'tax_invoice', bytes: PDF.length }]);
      await assert.rejects(fs.stat(path.join(staging, `${fileId}.pdf`)), 'staging을 지운다');
    } finally {
      await fs.rm(staging, { recursive: true, force: true });
    }
  });
});

describe('IR 실행 + save_pdf 포트(가짜 H-01 페이지)', () => {
  let fx: H01Fixture;
  let h: Harness;
  let page: Page | null = null;
  let dir: string;
  let db: Db;
  let data: DataService;
  let cp: string;
  let ir: IrPackage;
  const cipher = new ColumnCipher(new Uint8Array(randomBytes(32)));
  const ledgerKey = new Uint8Array(randomBytes(32));
  before(async () => {
    fx = await startH01Fixture({ registry: { '2148651233': 'A상사' }, supplier: SUPPLIER });
    h = await startHarness();
    dir = await tmp('sax-artifact-ir-');
    ({ db, data } = openData(dir, new Uint8Array(randomBytes(32))));
    business(data);
    cp = data.counterparties.create({ bizNo: '2148651233', name: 'A상사', email: 'tax@asangsa.example' }).id;
    const { pkg } = loadH01Fixture(fx.origin);
    const p = fixturePortal(fx.origin);
    ir = {
      pkg, lookupDefs: h01FixtureLookupDefs(fx.origin), fixtureGrant: fixtureOriginGrant(pkg),
      verifyTiming: { minElapsedMs: p.verify.minElapsedMs, lookups: p.verify.lookups, maxMs: p.verify.maxMs },
      judge: { decide: async () => ({ outcome: 'no_visible_error', confidence: 1, raw: {}, usage: { input_tokens: 0, output_tokens: 0 }, refusals: [], rule: 3, provider: 'openai', model: 'fixture', l0Only: true, injectionHit: false, shadow: [] }) as never },
    };
  });
  after(async () => {
    await page?.context().browser()?.close().catch(() => {});
    await h.close();
    await fx.close();
    db.close();
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  const service = (events: RunEvent[], gm: GatePortMessage[], pdf?: PdfPort) => {
    const runs = new RunService({
      db, data, ledgerKey, portal: fixturePortal(fx.origin), log: new FileEventLog(null, 'engine'),
      page: async () => (page && !page.isClosed() ? page : (page = (await connectRunBrowser(h.client)).page)),
      postGate: (m) => gm.push(m), engine: 'ir', irSource: () => ({ ok: true, ir: { ...ir, ...(pdf ? { pdf } : {}) } }),
    });
    runs.on('event', (e: RunEvent) => events.push(e));
    return runs;
  };
  const wait = async <T>(f: () => T | undefined): Promise<T> => {
    for (let i = 0; i < 600; i++) {
      const v = f();
      if (v) return v;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error('timeout');
  };
  /** entry.ts run.start와 같다: 시작한 뒤 입력 요약을 봉인해 둔다. */
  const start = (runs: RunService, runId: string, supply: number) => {
    runs.start({ runId, counterpartyId: cp, supply, tax: supply / 10, itemName: '경영 컨설팅' });
    recordRunInputs(db, cipher, runId, { counterpartyId: cp, supply, tax: supply / 10 });
  };

  async function issue(runId: string, supply: number, pdf: PdfPort | undefined): Promise<Extract<RunEvent, { type: 'end' }>> {
    const events: RunEvent[] = [];
    const gm: GatePortMessage[] = [];
    const runs = new RunService({
      db, data, ledgerKey, portal: fixturePortal(fx.origin), log: new FileEventLog(null, 'engine'),
      page: async () => (page && !page.isClosed() ? page : (page = (await connectRunBrowser(h.client)).page)),
      postGate: (m) => gm.push(m), engine: 'ir', irSource: () => ({ ok: true, ir: { ...ir, ...(pdf ? { pdf } : {}) } }),
    });
    runs.on('event', (e: RunEvent) => events.push(e));
    start(runs, runId, supply);
    const req = await wait(() => (gm.find((m) => m.t === 'gate.request') as { req: GateRequest } | undefined)?.req);
    assert.deepEqual(runs.answer({ v: 2, runId: req.runId, gateStepId: req.gateStepId, reqId: req.reqId, approvalNonce: req.approvalNonce, actionHash: req.actionHash, exp: Date.now() + 120_000, presence: 'click', mac: 'not-verified-in-phase1' }), { ok: true });
    return wait(() => events.find((e): e is Extract<RunEvent, { type: 'end' }> => e.type === 'end'));
  }

  it('포트가 없으면(0.1.8 제품 엔진) 발급 뒤 s32가 engine.unhandled_step, 메일 확인을 건너뛴다', async () => {
    const end = await issue('nopdf-1', 100_000, undefined);
    assert.equal(end.status, 'completed_with_issues');
    assert.equal(end.code, 'engine.unhandled_step');
    assert.equal(end.mailConfirmed, false);
    assert.ok(end.approvalNo);
  });

  it('VaultPdfPort(artifact)면 s32가 보관함에 넣고 메일 확인까지 성공, 보관함 줄은 그 실행 id', async () => {
    const staging = path.join(dir, 'staging');
    await fs.mkdir(staging, { recursive: true });
    const vault: PdfVault = {
      // 금고 pdf.print 대역: 지금 탭을 인쇄했다고 치고 staging에 PDF를 둔다(실제 인쇄는 vault-pdf-save 시험이 본다)
      rpc: async <T>(method: string) => {
        assert.equal(method, 'pdf.print');
        const fileId = fid();
        await fs.writeFile(path.join(staging, `${fileId}.pdf`), PDF);
        return { ok: true, fileId } as T;
      },
      on: () => () => {},
    };
    const pdf = new VaultPdfPort({ vault, targetId: () => 't1', staging, documents: data.documents, artifact: (b, o) => data.documents.importRunArtifact(b, o) });
    const end = await issue('pdf-1', 200_000, pdf);
    assert.equal(end.status, 'success', JSON.stringify(end));
    assert.equal(end.mailConfirmed, true);
    const docs = data.documents.list().filter((d) => d.docType === 'tax_invoice');
    assert.equal(docs.length, 1);
    assert.equal((db.prepare('SELECT run_id FROM documents WHERE id = ?').get(docs[0]!.id) as { run_id: string }).run_id, 'pdf-1');
    assert.deepEqual(await fs.readdir(staging), [], 'staging을 비운다');
  });

  it('발급 뒤 PDF만 실패(금고 거부·응답 없음)하면 발급·원장·승인번호는 그대로, 실행은 completed_with_issues', async () => {
    const hung: PdfVault = { rpc: () => new Promise<never>(() => {}), on: () => () => {} };
    const refused: PdfVault = { rpc: async <T>() => ({ ok: false, reason: 'secret_window_open' }) as T, on: () => () => {} };
    for (const [name, vault, more] of [['refused', refused, {}], ['hung', hung, { printTimeoutMs: 300 }]] as const) {
      const pdf = new VaultPdfPort({ vault, targetId: () => 't1', staging: path.join(dir, 'staging'), documents: data.documents, artifact: (b, o) => data.documents.importRunArtifact(b, o), ...more });
      const t0 = Date.now();
      const end = await issue(`pdffail-${name}`, 400_000 + (name === 'hung' ? 1 : 0) * 10_000, pdf);
      assert.equal(end.status, 'completed_with_issues', `${name} ${JSON.stringify(end)}`);
      assert.ok(end.approvalNo, `${name}: 승인번호가 남는다`);
      const h = runHistory(db, cipher).find((r) => r.runId === `pdffail-${name}`)!;
      assert.equal(h.ledger, 'committed', name);
      assert.equal(h.documentId, null, name);
      assert.ok(Date.now() - t0 < 30_000, `${name}: 상한 안에 끝난다`);
      console.log(`  ${name}: end code ${end.code}`);
    }
  });

  it('실행 이력: 발급·보관한 실행, 포트 없던 실행, 승인 대기에서 끊긴 실행(재시작)을 DB에서 다시 읽는다', async () => {
    // 승인 대기까지 간 뒤 앱이 꺼졌다: 새 RunService(같은 DB)가 기동 복구로 interrupted·게이트 만료
    const gm: GatePortMessage[] = [];
    const cutEvents: RunEvent[] = [];
    const runs = service(cutEvents, gm);
    start(runs, 'cut-1', 300_000);
    await wait(() => gm.find((m) => m.t === 'gate.request'));
    service([], []);
    const rows = runHistory(db, cipher);
    const by = new Map(rows.map((r) => [r.runId, r]));
    const cut = by.get('cut-1')!;
    assert.deepEqual(
      { status: cut.status, gated: cut.gated, ledger: cut.ledger, approvalNo: cut.approvalNo, documentId: cut.documentId, name: cut.counterpartyName, supply: cut.supply, tax: cut.tax },
      { status: 'interrupted', gated: true, ledger: null, approvalNo: null, documentId: null, name: 'A상사', supply: 300_000, tax: 30_000 },
    );
    const done = by.get('pdf-1')!;
    assert.equal(done.status, 'success');
    assert.equal(done.ledger, 'committed');
    assert.match(done.approvalNo ?? '', /^\d{8}-\d{8}-\d{8}$/);
    assert.equal(done.documentId, data.documents.list().find((d) => d.docType === 'tax_invoice')!.id);
    assert.equal(by.get('nopdf-1')!.code, 'engine.unhandled_step');
    assert.equal(rows[0]!.runId, 'cut-1', '최근 실행부터');
    // 다른 키로는 입력 요약을 읽지 않는다(값 없이 상태만)
    const other = runHistory(db, new ColumnCipher(new Uint8Array(randomBytes(32)))).find((r) => r.runId === 'cut-1')!;
    assert.equal(other.counterpartyName, null);
    assert.equal(other.supply, null);
    // 시험 프로세스 안에서는 앞 서비스의 실행이 아직 승인을 기다린다(실제로는 프로세스가 끝났다). 멈춰 타이머·탭을 닫는다.
    runs.stop('cut-1');
    await wait(() => cutEvents.find((e) => e.type === 'end'));
  });
});

describe('셸: 발급 PDF 줄과 PDF만 실패한 결과 문구', () => {
  it('보관함의 tax_invoice는 확인 칸 없는 앱 발급 세금계산서(실행 id 포함)', async () => {
    const { toShellDoc } = await import('../apps/desktop/src/shell-docs.ts');
    const d = toShellDoc({ id: 'doc-1', displayName: '전자세금계산서', docType: 'tax_invoice', issuedOn: '2026-11-11', expiresOn: null, runId: 'run-1', source: 'app' } as never);
    assert.deepEqual({ kind: d.kind, source: d.source, vault: d.vault, runId: d.runId }, { kind: '세금계산서', source: '앱이 발급', vault: undefined, runId: 'run-1' });
  });

  it('save_pdf.failed로 끝나면 완료 카드에 "발급은 완료, PDF는 못 받음, 다시 발급하지 마세요"', async () => {
    const { EventEmitter } = await import('node:events');
    const { NOTE, ShellRuns } = await import('../apps/desktop/src/shell-runs.ts');
    const { interpret } = await import('../apps/desktop/src/shell-model.ts');
    const host = Object.assign(new EventEmitter(), { control: async () => ({}), rpc: async () => ({}) });
    const cps = [{ id: 'cp-a', name: 'A상사', bizNo: '2148651233', rep: '', email: '', item: '경영 컨설팅', status: '계속사업자', checkedOn: '', lastIssuedOn: null }];
    const runs = new ShellRuns(host, { counterparties: () => cps, auth: () => '' });
    const r = interpret('A상사에 10만원 세금계산서', null, 'business', runs);
    assert.ok(r.kind === 'draft');
    await runs.prepare(r.run.id);
    host.emit('run', { runId: r.run.id, type: 'end', status: 'completed_with_issues', code: 'save_pdf.failed', approvalNo: '20261111-41000012-00000123', mailConfirmed: false });
    const v = runs.get(r.run.id)!;
    assert.equal(v.status, 'done');
    assert.ok(v.warnings.includes(NOTE['save_pdf.failed']!));
    assert.match(NOTE['save_pdf.failed']!, /발급은 완료.*PDF.*받지 못했/);
    assert.doesNotMatch(NOTE['save_pdf.failed']!, /아무것도 발급하지 않았/);
  });
});
