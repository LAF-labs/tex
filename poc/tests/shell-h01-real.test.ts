// H-01 실화면 패키지 2.2.0(제품 원본, #281) + 가짜 홈택스(tests/hometax-fake.ts)를 데스크톱 ShellRuns 경로로 돌린다(부장 지시 2026-11-12).
// 데스크톱이 엔진에 넘기는 run.start 값(engine entry가 그대로 RunService.start로 넘김)이 2.2.0 입력(품목 행·공급가액·세액·이메일 두 칸·작성일(日)·
// 공급받는자 성명·사업장)과 발급 인증(methodTargets)으로 이어져 홈택스 칸에 들어가는지, 사람 몫(로그인·인증서 비밀번호)을 카드가 바로 말하는지 본다.
// 실제 홈택스에 접속하지 않는다.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { BizVerifier, connectRunBrowser, DataService, fixturePortal, RunService, type GatePortMessage, type IrPackage, type RunEvent } from '@sax/engine';
import { fixtureOriginGrant, type PdfPort } from '@sax/engine/core';
import { openDatabase } from '@sax/db';
import { Egress } from '@sax/net';
import { FileEventLog } from '@sax/platform';
import { LOGIN_NOW, ShellRuns, SIGN_BY_AUTH } from '../apps/desktop/src/shell-runs.ts';
import { SIGN_LABEL, type Counterparty } from '../apps/desktop/src/shell-model.ts';
import { startHarness } from './harness.ts';
import { startHometaxFake, kstToday } from './hometax-fake.ts';
import { loadReal } from './h01-real-dryrun.ts';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(fn: () => boolean, ms: number, tick?: () => void): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    tick?.();
    if (fn()) return true;
    await sleep(100);
  }
  return fn();
}
const PDF: PdfPort = {
  print: async () => ({ ok: true, fileId: 'a'.repeat(32) }),
  armDownload: async () => ({ armed: false, reason: 'n/a' }),
  awaitDownload: async () => ({ ok: false, reason: 'n/a' }),
  disarmDownload: async () => {},
  store: async () => ({ ok: true, documentId: 'doc-1' }),
};

/** engine entry와 같게 run.* 파라미터를 그대로 RunService로 넘긴다(데스크톱이 보내는 모양 그대로). */
class EngineHost extends EventEmitter {
  runs!: RunService;
  starts: Array<Record<string, unknown>> = [];
  async control(): Promise<unknown> {
    return {};
  }
  async rpc(m: string, p: Record<string, unknown>): Promise<unknown> {
    const id = String(p.runId);
    if (m === 'run.start') {
      this.starts.push(p);
      return this.runs.start(p as never);
    }
    if (m === 'run.resume') return this.runs.resume(id);
    if (m === 'run.manualDone') return this.runs.manualDone(id);
    if (m === 'run.stop') return this.runs.stop(id);
    throw new Error(`unknown ${m}`);
  }
}

describe('H-01 2.2.0 실화면 패키지 ← 데스크톱 입력(가짜 홈택스, 실제 엔진)', () => {
  it('로그아웃 시작 · 공동·금융인증서: 로그인 안내 → 로그인 → 승인 → 서명 단계 안내 → 인증서 [확인] → 발급 완료. 홈택스 칸에 장부·초안 값이 2.2.0 모양으로 들어간다', { timeout: 150_000 }, async () => {
    const fx = await startHometaxFake({ renderDelayMs: 600, loggedIn: false });
    const h = await startHarness();
    const dir = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'sax-shell-real-'));
    const db = openDatabase(path.join(dir, 'db.sqlite'), new Uint8Array(randomBytes(32)));
    const rb = await connectRunBrowser(h.client);
    const host = new EngineHost();
    const gates: GatePortMessage[] = [];
    try {
      const { pkg, lookups } = loadReal(fx.origin, new URL(fx.teetOrigin).host);
      const base = fixturePortal(fx.origin);
      const portal = { ...base, verify: { ...base.verify, maxMs: 25_000, intervalMs: 300 } };
      const ir: IrPackage = { pkg, lookupPackages: lookups, fixtureGrant: fixtureOriginGrant(pkg), verifyTiming: { minElapsedMs: 600, lookups: 2, maxMs: 25_000 }, pdf: PDF };
      const data = new DataService(db, new BizVerifier(new Egress()));
      // 온보딩의 공동인증서·금융인증서는 signMethod 'cert'(AUTH_SIGN_METHOD) → 2.2.0 methodTargets.cert
      data.profiles.upsert({ kind: 'business', displayName: '가나다컴퍼니', bizNo: '1234567891', corpNo: null, repName: '김대표', bizType: null, bizItem: null, address: null, email: null, signMethod: 'cert' } as never);
      const cpId = data.counterparties.create({ bizNo: '2148651233', name: '에이상사', repName: '이대표', address: '부산광역시 가짜구 1', email: 'old@asangsa.example' }).id;
      host.runs = new RunService({
        db, data, ledgerKey: new Uint8Array(randomBytes(32)), portal, log: new FileEventLog(null, 'engine'), page: async () => rb.page,
        postGate: (m: GatePortMessage) => {
          gates.push(m);
          if (m.t === 'gate.request') host.emit('gate', m.req);
          if (m.t === 'gate.closed') host.emit('gate-closed', { runId: m.runId, reqId: m.reqId, reason: m.reason });
        },
        engine: 'ir', irSource: () => ({ ok: true, ir }),
      } as never);
      host.runs.on('event', (e: RunEvent) => host.emit('run', e));
      const cp: Counterparty = { id: cpId, name: '에이상사', bizNo: '2148651233', rep: '이대표', email: 'old@asangsa.example', item: '경영 컨설팅', status: '계속사업자', checkedOn: '', lastIssuedOn: null };
      const shell = new ShellRuns(host as never, { counterparties: () => [cp], auth: () => SIGN_LABEL.cert });
      const d = shell.createDraft(cp, 1_234_000, null);
      shell.updateDraft(d.id, { item: '경영 컨설팅 11월', email: 'Tax.Team@asangsa.example' });
      const r = () => shell.get(d.id)!;
      await shell.prepare(d.id);
      // 데스크톱이 넘긴 값(engine entry가 그대로 받는다)
      assert.deepEqual(host.starts[0], { runId: d.id, counterpartyId: cpId, supply: r().supply, tax: r().tax, itemName: '경영 컨설팅 11월', email: 'Tax.Team@asangsa.example' });
      // 1) 로그인 단계: 엔진이 로그인 화면을 열고 기다리는 동안 카드는 할 일을 바로 보인다(로그인 차례 handoff는 10분 뒤에야 온다)
      assert.deepEqual([r().status, r().steps[0]!.state, r().steps[0]!.note], ['preparing', 'now', LOGIN_NOW]);
      assert.ok(await until(() => fx.state.lastScreen?.screen === 'login', 30_000), '로그인 화면이 열리지 않음');
      await sleep(fx.knobs.renderDelayMs + 800);
      assert.equal(r().status, 'preparing', '사람이 로그인하는 동안 실행은 끝나지 않는다');
      fx.login();
      // 2) 게이트 → 승인(바 대신 엔진에 직접)
      assert.ok(await until(() => r().status === 'waiting', 60_000), `승인 대기가 오지 않음: ${r().status} ${r().stoppedNote ?? ''}`);
      const g = gates.find((m) => m.t === 'gate.request');
      assert.ok(g && g.t === 'gate.request');
      const f = new Map(g.req.fields.map((x) => [x.fieldKey, x.value]));
      assert.deepEqual([f.get('counterpartBizNo'), f.get('counterpartName'), f.get('itemName'), f.get('supplyAmount'), f.get('taxAmount'), f.get('counterpartEmail'), f.get('issueDate')], ['2148651233', '에이상사', '경영 컨설팅 11월', String(r().supply), String(r().tax), 'Tax.Team@asangsa.example', kstToday()]);
      shell.approved(d.id);
      const q = g.req;
      assert.deepEqual(host.runs.answer({ v: 2, runId: q.runId, gateStepId: q.gateStepId, reqId: q.reqId, approvalNonce: q.approvalNonce, actionHash: q.actionHash, exp: Date.now() + 120_000, presence: 'click', mac: 'not-verified-in-phase1' }), { ok: true });
      // 3) 서명 단계: 엔진이 인증유형 창에서 공동·금융인증서를 고르고 인증서 창을 연다. 카드는 바로 "인증서 비밀번호를 직접 넣어 주세요"
      assert.ok(await until(() => fx.state.stage === 'cert', 40_000), `인증서 창이 열리지 않음: ${fx.state.stage}`);
      assert.deepEqual([r().status, r().steps[5]!.state, r().steps[5]!.note], ['issuing', 'now', SIGN_BY_AUTH[SIGN_LABEL.cert]!.now]);
      await sleep(1500);
      fx.cert('confirm'); // 사람이 홈택스 인증서 창에 비밀번호를 넣고 [확인]
      assert.ok(await until(() => ['done', 'attention', 'stopped'].includes(r().status), 60_000), `끝나지 않음: ${r().status}`);
      assert.equal(r().status, 'done', `${r().stoppedNote ?? ''} ${JSON.stringify(host.runs.inspect(d.id).journal.slice(-8))}`);
      assert.ok(r().result?.approvalNo);
      // 4) 홈택스(가짜)에 들어간 값: 거래처 성명은 장부 대표자, 이메일은 두 칸으로 나뉘어 다시 합쳐진다, 작성일은 오늘
      assert.equal(fx.state.invoices.length, 1);
      const inv = fx.state.invoices[0]!;
      assert.deepEqual(
        [inv.dmnrTxprDscmNo.replace(/\D/g, ''), inv.tnmNm, inv.rprsFnm, inv.lsatNm, inv.sumSplCftStr.replace(/\D/g, ''), inv.sumTxamtStr.replace(/\D/g, ''), inv.dmnrEmail, inv.wrtDt.replace(/\D/g, '')],
        ['2148651233', '에이상사', '이대표', '경영 컨설팅 11월', String(r().supply), String(r().tax), 'Tax.Team@asangsa.example', kstToday().replace(/\D/g, '')],
      );
      const acts = fx.requests().map((x) => x.actionId).filter(Boolean);
      assert.deepEqual(acts.filter((a) => /^ATEETBAA002C0[458]$/.test(a!)), ['ATEETBAA002C04', 'ATEETBAA002C05', 'ATEETBAA002C08'], JSON.stringify(acts));
    } finally {
      try {
        for (const x of [host.runs?.activeRunId].filter(Boolean)) host.runs.stop(x as string);
      } catch {
        /* 끝남 */
      }
      await sleep(300);
      await rb.browser.close().catch(() => {});
      db.close();
      await h.close();
      await fx.close();
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
