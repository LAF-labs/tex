// 민원증명(H-03·H-04·H-08·H-09) 제품 실행 경로(RunService.startCert, engine 'ir'). 가짜 민원증명 페이지(tests/cert-fixture.ts)에서
// 시작 → 칸 채움 → readback → 승인 카드(cert.confirm, docType cert) → 승인 → 접수 → 처리결과 조회 verify → 원장 committed까지 서류마다 돈다.
// 거부·시간 초과·개인사업자 로그인·입력 빠짐·같은 의도 두 번·조회 불가(in_doubt)도 본다.
// 실제 포털 접속 없음: 금고는 프로세스 안(시험 정책 127.0.0.1)·헤드리스 Chrome, 모델 없음(decide는 고정 판정기), PDF는 가짜 포트. 모든 값은 가상이다.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import {
  BizVerifier, certInputs, connectRunBrowser, recordCertInputs, runHistory, DataService, fixturePortal, gateSelfCheck, RunEnd, RunService,
  type CertStartParams, type GatePortMessage, type GateRequest, type IrPackage, type LocalApproval, type RunEvent, type RunServiceDeps,
} from '@sax/engine';
import { fixtureOriginGrant, type PdfPort } from '@sax/engine/core';
import { ColumnCipher, openDatabase, type Db } from '@sax/db';
import { Egress } from '@sax/net';
import { FileEventLog } from '@sax/platform';
import type { Page } from 'playwright-core';
import { CERT_DOC_NAME, startCertFixture, type CertFixture } from './cert-fixture.ts';
import { CERT_PRODUCT_IDS, fixtureCertId, loadCertFixtures, type CertCode } from './cert-fixture-package.ts';
import { startHarness, type Harness } from './harness.ts';

const SUPPLIER = { bizNo: '1234567891', name: '가나다컴퍼니' };
const ID = (c: CertCode) => fixtureCertId(CERT_PRODUCT_IDS[c]);

/** 서류별 입력(패키지 선언 키). 모두 가상 값이다. */
const INPUTS: Readonly<Record<CertCode, Record<string, string>>> = {
  'H-03': { purpose: '금융기관제출용', submitTo: '금융기관', rrnDisclosure: '비공개' },
  'H-04': { purpose: '금융기관 제출', submitTo: '금융기관' },
  'H-08': { purpose: '대출용', submitTo: '금융기관', periodStartYear: '2025', periodStartHalf: '1기', periodEndYear: '2025', periodEndHalf: '2기', openDate: '2020-03-02' },
  'H-09': { purpose: '입찰, 계약용', submitTo: '관공서', fiscalYear: '2024' },
};
/** 승인 카드 4칸(certDoc·certPurpose·certSubmitTo·rrnDisclosure)에 기대하는 값. */
const CARD: Readonly<Record<CertCode, [string, string, string, string]>> = {
  'H-03': [CERT_DOC_NAME['H-03'], '금융기관제출용', '금융기관', '비공개'],
  'H-04': [CERT_DOC_NAME['H-04'], '금융기관 제출', '금융기관', '공개안함'],
  'H-08': [CERT_DOC_NAME['H-08'], '대출용', '금융기관', '비공개'],
  'H-09': [CERT_DOC_NAME['H-09'], '입찰, 계약용', '관공서', '비공개'],
};

describe('민원증명 제품 실행(run.startCert, 가짜 민원증명 페이지)', () => {
  let fx: CertFixture;
  let h: Harness;
  let page: Page | null = null;
  let dir: string;
  let db: Db;
  let data: DataService;
  let pkgs: Map<string, IrPackage>;
  const log = new FileEventLog(null, 'engine');
  const events: RunEvent[] = [];
  const gateMsgs: GatePortMessage[] = [];
  const traces = new Map<string, string[]>();
  const ledgerKey = new Uint8Array(randomBytes(32));
  let n = 0;
  let runs: RunService;

  const svc = (over: Partial<RunServiceDeps> = {}) => {
    const r = new RunService({
      db, data, ledgerKey, portal: fixturePortal(fx.origin), log, engine: 'ir',
      page: async () => (page && !page.isClosed() ? page : (page = (await connectRunBrowser(h.client)).page)),
      postGate: (m) => gateMsgs.push(m),
      trace: (runId, e) => traces.set(runId, [...(traces.get(runId) ?? []), `${e.name}:${e.stepId}${e.code ? `:${e.code}` : ''}`]),
      certSource: (id) => {
        const ir = pkgs.get(id);
        return ir ? { ok: true, ir } : { ok: false, code: 'cert.unknown_doc' };
      },
      ...over,
    });
    r.on('event', (e: RunEvent) => events.push(e));
    return r;
  };

  const next = <T>(pred: () => T | undefined, ms = 30_000): Promise<T> =>
    new Promise((resolve, reject) => {
      const until = Date.now() + ms;
      const tick = () => {
        const v = pred();
        if (v !== undefined) return resolve(v);
        if (Date.now() > until) return reject(new Error('timeout'));
        setTimeout(tick, 50);
      };
      tick();
    });
  const gateFor = (runId: string, nth = 0) => next(() => (gateMsgs.filter((m) => m.t === 'gate.request' && m.req.runId === runId)[nth] as { req: GateRequest } | undefined)?.req);
  const endOf = (runId: string) => next(() => events.find((e) => e.runId === runId && e.type === 'end') as Extract<RunEvent, { type: 'end' }> | undefined, 60_000);
  const approval = (req: GateRequest): LocalApproval => ({
    v: 2, runId: req.runId, gateStepId: req.gateStepId, reqId: req.reqId, approvalNonce: req.approvalNonce, actionHash: req.actionHash, exp: Date.now() + 120_000, presence: 'click', mac: 'not-verified-in-phase1',
  });
  const card = (req: GateRequest) => Object.fromEntries(req.fields.map((f) => [f.fieldKey, f.value]));
  const start = (r: RunService, c: CertCode, inputs: Record<string, string> = INPUTS[c]) => {
    const runId = `cert-${++n}`;
    r.startCert({ runId, playbookId: ID(c), inputs });
    return runId;
  };

  before(async () => {
    fx = await startCertFixture({ supplier: SUPPLIER });
    h = await startHarness();
    const loaded = loadCertFixtures(fx.origin);
    const p = fixturePortal(fx.origin);
    const pdf: PdfPort = {
      print: async () => ({ ok: true, fileId: 'b'.repeat(32) }),
      armDownload: async () => ({ armed: true }),
      awaitDownload: async () => ({ ok: true, fileId: 'b'.repeat(32) }),
      disarmDownload: async () => {},
      store: async () => ({ ok: true, documentId: 'doc-cert' }),
    };
    pkgs = new Map([...loaded.docs].map(([id, pkg]) => [id, {
      pkg, lookupPackages: loaded.lookups, fixtureGrant: fixtureOriginGrant(pkg), pdf,
      verifyTiming: { minElapsedMs: p.verify.minElapsedMs, lookups: p.verify.lookups, maxMs: p.verify.maxMs },
      // 모델 없음: form_ready는 늘 "보이는 오류 없음"
      judge: { decide: async () => ({ outcome: 'no_visible_error', confidence: 1, raw: {}, usage: { input_tokens: 0, output_tokens: 0 }, refusals: [], rule: 3, provider: 'openai', model: 'fixture', l0Only: true, injectionHit: false, shadow: [] }) as never },
    } satisfies IrPackage]));
    dir = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'sax-cert-run-'));
    db = openDatabase(path.join(dir, 'db.sqlite'), new Uint8Array(randomBytes(32)));
    data = new DataService(db, new BizVerifier(new Egress()));
    data.profiles.upsert({ kind: 'business', displayName: SUPPLIER.name, bizNo: SUPPLIER.bizNo, corpNo: null, repName: '김가나', bizType: null, bizItem: null, address: null, email: null, signMethod: 'simple_auth' });
    runs = svc();
  });

  after(async () => {
    const id = runs?.activeRunId;
    if (id) {
      try {
        runs.stop(id);
      } catch { /* 커밋 구간 */ }
      await endOf(id).catch(() => {});
    }
    await page?.context().browser()?.close().catch(() => {});
    await h?.close();
    await fx?.close();
    db?.close();
    if (dir) await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  /** 실패 진단(값 없는 궤적만). 그 실행을 멈춰 다음 시험이 busy로 막히지 않게 한다. */
  const diag = async (r: RunService, runId: string) => {
    console.error(runId, JSON.stringify({ events: events.filter((x) => x.runId === runId), journal: r.inspect(runId).journal, steps: traces.get(runId) }));
    try {
      r.stop(runId);
    } catch { /* 커밋 구간 */ }
    await endOf(runId).catch(() => {});
  };

  for (const c of ['H-03', 'H-04', 'H-08', 'H-09'] as const) {
    it(`${c}: 시작 → 칸 채움 → 승인 카드(cert, 4칸) → 승인 → 접수 → 처리결과 조회 → 원장 committed`, async () => {
      const posts = fx.posts();
      const runId = start(runs, c);
      try {
        const req = await gateFor(runId);
        assert.equal(req.docType, 'cert');
        assert.equal(gateSelfCheck(req), null);
        const f = card(req);
        assert.deepEqual([f.certDoc, f.certPurpose, f.certSubmitTo, f.rrnDisclosure], CARD[c]);
        // 첫 신청: 예약 키(중복 경고) 없음, H-01 거래처 키($first.*)도 없음
        assert.deepEqual(req.fields.map((x) => x.fieldKey), ['certDoc', 'certPurpose', 'certSubmitTo', 'rrnDisclosure']);
        assert.equal(fx.posts(), posts, '승인 전에는 접수하지 않는다');
        assert.deepEqual(runs.answer(approval(req)), { ok: true });
        const end = await endOf(runId);
        assert.deepEqual([end.status, end.code], ['success', undefined]);
        assert.equal(end.mailConfirmed, undefined, '민원증명은 메일 확인이 없다');
        const rec = fx.records.at(-1)!;
        assert.equal(end.approvalNo, rec.receiptNo, '접수번호가 결과·원장 verify_ref로 묶인다');
        assert.equal(rec.docName, CERT_DOC_NAME[c]);
        assert.equal(fx.posts(), posts + 1);
        const ins = runs.inspect(runId);
        assert.equal(ins.ledger, 'committed');
        for (const t of ['gate.requested', 'gate.approved', 'ledger.armed', 'ledger.committed']) assert.ok(ins.journal.includes(t), t);
        const row = db.prepare('SELECT playbook_id, verify_ref, recipient_email_hmac FROM irreversible_log WHERE run_id = ?').get(runId) as { playbook_id: string; verify_ref: string; recipient_email_hmac: string | null };
        assert.deepEqual([row.playbook_id, row.verify_ref, row.recipient_email_hmac], [ID(c), rec.receiptNo, null]);
        // 진행 단계: H-01과 같은 이름(양식 → 입력 → 대조 → 승인 → 제출 → 확인)
        const phases = events.filter((e) => e.runId === runId && e.type === 'phase' && e.state === 'now').map((e) => (e as { phase: string }).phase);
        assert.deepEqual(phases, ['login', 'form', 'input', 'readback', 'gate', 'sign', 'verify']);
      } catch (e) {
        await diag(runs, runId);
        throw e;
      }
    });
  }

  it('H-03 값이 화면에 그대로 들어갔다(select는 코드 값, 라디오 묶음은 고른 것)', () => {
    const rec = fx.records.find((r) => r.doc === 'H-03')!;
    assert.deepEqual([rec.values.lang, rec.values.purpose, rec.values.submitTo, rec.values.rrn, rec.values.receive, rec.values.copies], ['0', '07', '01', '1', '01', '01']);
  });

  it('같은 날 같은 서류·같은 입력 두 번째: 카드에 $dup.businessKey=committed → [중지]하면 접수하지 않는다', async () => {
    const posts = fx.posts();
    const runId = start(runs, 'H-03');
    const req = await gateFor(runId);
    assert.equal(card(req)['$dup.businessKey'], 'committed');
    assert.equal(gateSelfCheck(req), null);
    assert.deepEqual(runs.stop(runId), { stopped: true });
    const end = await endOf(runId);
    assert.deepEqual([end.status, end.code], ['stopped', 'gate.stopped']);
    assert.equal(fx.posts(), posts);
    assert.equal(runs.inspect(runId).ledger, null);
  });

  it('용도가 다르면 다른 업무 키(중복 경고 없음). 승인 대기 시간이 지나면 expired, 접수 없음', async () => {
    const r = svc({ gateWaitMs: 400 });
    const posts = fx.posts();
    const runId = `cert-${++n}`;
    r.startCert({ runId, playbookId: ID('H-03'), inputs: { ...INPUTS['H-03'], purpose: '대출용' } });
    const req = await gateFor(runId);
    assert.equal(card(req)['$dup.businessKey'], undefined);
    const end = await endOf(runId);
    assert.deepEqual([end.status, end.code], ['expired', 'gate.expired']);
    assert.equal(fx.posts(), posts);
    assert.equal(r.inspect(runId).ledger, null);
  });

  it('개인사업자(사업자 인증서) 로그인: 메뉴 차단 알림에서 portal.personal_login_required로 멈추고 게이트를 열지 않는다(H-04·H-03)', async () => {
    fx.knobs.personal = true;
    try {
      for (const c of ['H-04', 'H-03'] as const) {
        const posts = fx.posts();
        const gates = gateMsgs.length;
        const runId = start(runs, c);
        const end = await endOf(runId);
        assert.deepEqual([end.status, end.code], ['failed', 'portal.personal_login_required'], c);
        assert.equal(gateMsgs.length, gates, c);
        assert.equal(fx.posts(), posts, c);
        assert.equal(runs.inspect(runId).ledger, null, c);
      }
    } finally {
      fx.knobs.personal = false;
    }
  });

  it('접수 실패 문구(명시적 실패 신호)면 not_committed → 양식부터 다시 채워 두 번째 승인 카드(직전 시도 발급 안 됨)', async () => {
    fx.knobs.failIssue = true;
    const runId = start(runs, 'H-09', { ...INPUTS['H-09'], fiscalYear: '2023' });
    try {
      const req = await gateFor(runId);
      assert.deepEqual(runs.answer(approval(req)), { ok: true });
      const again = await gateFor(runId, 1);
      fx.knobs.failIssue = false;
      assert.equal(card(again)['$dup.priorNotCommitted'], 'true');
      assert.equal(card(again)['$dup.businessKey'], 'not_committed');
      assert.deepEqual(runs.stop(runId), { stopped: true });
      const end = await endOf(runId);
      assert.equal(end.status, 'stopped');
      assert.equal(runs.inspect(runId).ledger, 'not_committed');
    } catch (e) {
      await diag(runs, runId);
      throw e;
    } finally {
      fx.knobs.failIssue = false;
    }
  });

  it('접수 뒤 처리결과 조회가 안 되면 in_doubt(중복 위험을 숨기지 않는다). 다음 같은 신청 카드는 $dup.businessKey=in_doubt', async () => {
    const runId = start(runs, 'H-08', { ...INPUTS['H-08'], purpose: '수금용' });
    try {
      const req = await gateFor(runId);
      fx.knobs.lookupDown = true;
      assert.deepEqual(runs.answer(approval(req)), { ok: true });
      const end = await endOf(runId);
      fx.knobs.lookupDown = false;
      assert.equal(end.status, 'in_doubt');
      assert.equal(runs.inspect(runId).ledger, 'in_doubt');
      const second = start(runs, 'H-08', { ...INPUTS['H-08'], purpose: '수금용' });
      const req2 = await gateFor(second);
      assert.equal(card(req2)['$dup.businessKey'], 'in_doubt');
      runs.stop(second);
      await endOf(second);
    } catch (e) {
      await diag(runs, runId);
      throw e;
    } finally {
      fx.knobs.lookupDown = false;
    }
  });

  it('실행 이력: 민원증명 입력 요약(선택값만, 컬럼 키로 봉인)이 이력에 서류 id·원장·접수번호와 같이 나온다', () => {
    const cipher = new ColumnCipher(new Uint8Array(randomBytes(32)));
    const row0 = runHistory(db, cipher, 200).find((r) => r.playbookId === ID('H-03') && r.ledger === 'committed')!;
    assert.ok(row0);
    recordCertInputs(db, cipher, row0.runId, { certDoc: '사업자등록증명', certLanguage: '한글', ...INPUTS['H-03'] });
    const row = runHistory(db, cipher, 200).find((r) => r.runId === row0.runId)!;
    assert.deepEqual(row.certInputs, { certDoc: '사업자등록증명', certLanguage: '한글', ...INPUTS['H-03'] });
    assert.equal(row.approvalNo, fx.records.find((r) => r.doc === 'H-03')!.receiptNo);
    assert.deepEqual([row.counterpartyId, row.supply, row.tax], [null, null, null]);
    // 다른 키로는 읽지 못한다(봉인), 모양이 다른 요약은 쓰지 않는다
    assert.equal(runHistory(db, new ColumnCipher(new Uint8Array(randomBytes(32))), 200).find((r) => r.runId === row0.runId)!.certInputs, null);
    recordCertInputs(db, cipher, row0.runId, { 'bad key': 'x' });
    assert.ok(runHistory(db, cipher, 200).find((r) => r.runId === row0.runId)!.certInputs);
  });

  it('입력·프로필·서류 검사: 브라우저를 열기 전에 사람 말로 옮길 수 있는 코드로 거절한다', () => {
    const refuse = (p: Partial<CertStartParams>, code: string, r = runs) => {
      assert.throws(() => r.startCert({ runId: `bad-${++n}`, playbookId: ID('H-03'), inputs: INPUTS['H-03'], ...p } as CertStartParams), (e: unknown) => e instanceof RunEnd && e.code === code, code);
    };
    refuse({ inputs: { submitTo: '금융기관' } }, 'input.missing');
    refuse({ inputs: { ...INPUTS['H-03'], purpose: '아무 용도' } }, 'cert.input_invalid');
    refuse({ inputs: { ...INPUTS['H-03'], purpose: '대출용‮' } }, 'cert.input_invalid');
    refuse({ inputs: { ...INPUTS['H-03'], rrn: '900101-1234567' } }, 'cert.input_unknown');
    refuse({ inputs: { ...INPUTS['H-03'], certDoc: '납세증명서' } }, 'cert.input_invalid');
    refuse({ playbookId: ID('H-08'), inputs: { purpose: '대출용', submitTo: '금융기관' } }, 'input.missing');
    refuse({ playbookId: 'fixture.cert.nope' }, 'package.not_loaded');
    refuse({ playbookId: 'Hometax/../x' }, 'package.not_loaded');
    refuse({ runId: 'bad id' }, 'bad_run_id');
    refuse({}, 'package.not_loaded', svc({ engine: 'h01' }));
    refuse({}, 'package.not_loaded', svc({ certSource: undefined }));
    // 입력 값은 엔진 로그에 남지 않는다(입력 이름·코드만)
    assert.deepEqual(certInputs({ a: { type: 'enum', values: ['x'], required: true } }, { a: ' x ' }), { ok: true, inputs: { a: 'x' } });
    assert.deepEqual(certInputs({ a: { type: 'counterparty', required: true } }, {}), { ok: false, code: 'cert.input_invalid', field: 'a' });
    // 사업자번호·발급 인증이 없으면 시작하지 않는다
    const prof = data.profiles.byKind('business')!;
    data.profiles.upsert({ ...prof, signMethod: null });
    try {
      refuse({}, 'profile_missing');
    } finally {
      data.profiles.upsert({ ...prof });
    }
    assert.equal(runs.activeRunId, null);
  });
});
