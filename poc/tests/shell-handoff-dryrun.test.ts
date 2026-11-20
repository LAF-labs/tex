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
import { HANDOFF_END_NEXT, HANDOFF_LOGIN, NOTE, ShellRuns, SIGN_BY_AUTH, STOP_AFTER_SIGN_NOTE } from '../apps/desktop/src/shell-runs.ts';
import type { Counterparty, RunView } from '../apps/desktop/src/shell-model.ts';
import { startHarness } from './harness.ts';
import { h01FixtureLookupDefs } from './h01-fixture-package.ts';
import { loadPublishedDryRun, startLoginFixture, type StepPatch } from './h01-published-dryrun.ts';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const PDF: PdfPort = {
  print: async () => ({ ok: true, fileId: 'a'.repeat(32) }),
  armDownload: async () => ({ armed: false, reason: 'n/a' }),
  awaitDownload: async () => ({ ok: false, reason: 'n/a' }),
  disarmDownload: async () => {},
  store: async () => ({ ok: true, documentId: 'doc-1' }),
};
const S5_SHORT: StepPatch = (s) => void (s.timeoutMs = 1500);
const PUSH_SHORT: StepPatch = (s) => void ((s.signFlow as { maxWaitMs: number }).maxWaitMs = 10_000);

class EngineHost extends EventEmitter {
  runs!: RunService;
  calls: string[] = [];
  async control(): Promise<unknown> {
    return {};
  }
  async rpc(m: string, p: Record<string, unknown>): Promise<unknown> {
    this.calls.push(m);
    const id = String(p.runId);
    if (m === 'run.start') return this.runs.start({ runId: id, counterpartyId: String(p.counterpartyId), supply: Number(p.supply), tax: Number(p.tax), itemName: String(p.itemName) });
    if (m === 'run.resume') return this.runs.resume(id);
    if (m === 'run.manualDone') return this.runs.manualDone(id);
    if (m === 'run.stop') return this.runs.stop(id);
    throw new Error(`unknown ${m}`);
  }
}

async function until(f: () => boolean, ms: number): Promise<boolean> {
  const t0 = Date.now();
  while (!f() && Date.now() - t0 < ms) await sleep(100);
  return f();
}

interface Rig {
  fx: Awaited<ReturnType<typeof startLoginFixture>>;
  host: EngineHost;
  shell: ShellRuns;
  cp: Counterparty;
  gates: GatePortMessage[];
  seen: Array<{ status: RunView['status']; kind?: string }>;
  close(): Promise<void>;
}

async function rig(o: { loggedIn: boolean; deps?: Record<string, unknown> }): Promise<Rig> {
  const fx = await startLoginFixture({ loggedIn: o.loggedIn });
  const h = await startHarness();
  const dir = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'sax-shell-handoff-'));
  const db = openDatabase(path.join(dir, 'db.sqlite'), new Uint8Array(randomBytes(32)));
  const host = new EngineHost();
  const { pkg } = loadPublishedDryRun(fx.origin, { s5: S5_SHORT, s21: PUSH_SHORT });
  const p = fixturePortal(fx.origin);
  const judge = {
    decide: async (bundle: string) => {
      const outcome = bundle.startsWith('screen_state') ? (fx.state.loggedIn ? 'logged_in' : fx.state.captcha ? 'captcha' : fx.state.pending ? 'mfa_pending' : 'login_required') : 'no_visible_error';
      return { outcome, confidence: 1, raw: {}, usage: { input_tokens: 0, output_tokens: 0 }, refusals: [], rule: 3, provider: 'openai', model: 'fixture', l0Only: true, injectionHit: false, shadow: [] } as never;
    },
  };
  const ir: IrPackage = { pkg, lookupDefs: h01FixtureLookupDefs(fx.origin), fixtureGrant: fixtureOriginGrant(pkg), verifyTiming: { minElapsedMs: p.verify.minElapsedMs, lookups: p.verify.lookups, maxMs: p.verify.maxMs }, judge, pdf: PDF };
  const data = new DataService(db, new BizVerifier(new Egress()));
  data.profiles.upsert({ kind: 'business', displayName: '가나다컴퍼니', bizNo: '1234567891', corpNo: null, repName: '김', bizType: null, bizItem: null, address: null, email: null, signMethod: 'simple_auth' });
  const cpId = data.counterparties.create({ bizNo: '2148651233', name: 'A상사', email: 'tax@asangsa.example' }).id;
  const rb = await connectRunBrowser(h.client);
  const gates: GatePortMessage[] = [];
  host.runs = new RunService({
    db, data, ledgerKey: new Uint8Array(randomBytes(32)), portal: p, log: new FileEventLog(null, 'engine'), page: async () => rb.page,
    postGate: (m: GatePortMessage) => {
      gates.push(m);
      if (m.t === 'gate.request') host.emit('gate', m.req);
      if (m.t === 'gate.closed') host.emit('gate-closed', { runId: m.runId, reqId: m.reqId, reason: m.reason });
    },
    engine: 'ir', irSource: () => ({ ok: true, ir }), ...o.deps,
  } as never);
  host.runs.on('event', (e: RunEvent) => host.emit('run', e));
  const cp: Counterparty = { id: cpId, name: 'A상사', bizNo: '2148651233', rep: '', email: 'tax@asangsa.example', item: '경영 컨설팅', status: '계속사업자', checkedOn: '', lastIssuedOn: null };
  const shell = new ShellRuns(host as never, { counterparties: () => [cp], auth: () => '사업자 간편인증' });
  const seen: Rig['seen'] = [];
  shell.on('update', (r: RunView) => seen.push({ status: r.status, kind: r.handoff?.kind }));
  return {
    fx, host, shell, cp, gates, seen,
    close: async () => {
      for (const r of shell.list()) {
        try {
          host.runs.stop(r.id);
        } catch {
          /* 끝남 */
        }
      }
      await sleep(300);
      await rb.browser.close().catch(() => {});
      db.close();
      await h.close();
      await fx.close();
      await fs.rm(dir, { recursive: true, force: true });
    },
  };
}

function approve(x: Rig, runId: string): void {
  const g = x.gates.find((m) => m.t === 'gate.request' && m.req.runId === runId);
  assert.ok(g && g.t === 'gate.request');
  x.shell.approved(runId);
  const q = g.req;
  assert.deepEqual(x.host.runs.answer({ v: 2, runId: q.runId, gateStepId: q.gateStepId, reqId: q.reqId, approvalNonce: q.approvalNonce, actionHash: q.actionHash, exp: Date.now() + 120_000, presence: 'click', mac: 'not-verified-in-phase1' }), { ok: true });
}

describe('사람 차례 → 셸 카드(게시본 건조 실행, 실제 엔진)', () => {
  it('로그인 대기 → [이어서] → 승인 → 서명 차례 → 엔진이 스스로 넘어가 발급 완료. 사람 차례 동안 카드는 끝나지 않는다', { timeout: 120_000 }, async () => {
    const x = await rig({ loggedIn: false });
    try {
      const d = x.shell.createDraft(x.cp, 100_000, null);
      await x.shell.prepare(d.id);
      const r = () => x.shell.get(d.id)!;
      assert.ok(await until(() => r().status === 'turn', 30_000), `로그인 차례가 오지 않음: ${r().status} ${r().stoppedNote ?? ''}`);
      assert.deepEqual([r().handoff?.kind, r().handoff?.afterGate, r().turn?.text, r().turn?.note], ['login', false, HANDOFF_LOGIN.text, HANDOFF_LOGIN.note]);
      x.fx.completeLogin();
      x.fx.state.signDelayMs = 13_000;
      await x.shell.resume(d.id);
      assert.equal(r().status, 'preparing');
      assert.ok(await until(() => r().status === 'waiting', 40_000), `승인 대기가 오지 않음: ${r().status}`);
      approve(x, d.id);
      assert.ok(await until(() => r().status === 'turn' && r().handoff?.kind === 'sign', 40_000), `서명 차례가 오지 않음: ${r().status} ${r().handoff?.kind}`);
      assert.deepEqual([r().handoff?.afterGate, r().turn?.text], [true, SIGN_BY_AUTH['사업자 간편인증']!.text]);
      await assert.rejects(x.shell.manualDone(d.id), /sign\.turn_resume_only/);
      assert.ok(await until(() => r().status === 'done', 60_000), `발급 완료가 오지 않음: ${r().status} ${r().stoppedNote ?? ''}`);
      assert.ok(r().result?.approvalNo);
      assert.deepEqual([x.fx.inner.posts(), x.fx.state.signs], [1, 1]);
      const firstDone = x.seen.findIndex((s) => s.status === 'done');
      assert.ok(!x.seen.slice(0, firstDone).some((s) => ['stopped', 'attention'].includes(s.status)), JSON.stringify(x.seen.map((s) => s.status)));
      assert.ok(x.seen.some((s) => s.kind === 'login') && x.seen.some((s) => s.kind === 'sign'));
      assert.ok(x.host.calls.includes('run.resume'));
    } finally {
      await x.close();
    }
  });

  it('서명 차례 [중지]: 바로 끝나지 않고 확인 중(발급목록) → 끝. 서명하지 않았고 발급 요청을 다시 보내지 않는다', { timeout: 120_000 }, async () => {
    const x = await rig({ loggedIn: true });
    try {
      x.fx.state.signDelayMs = 60_000;
      const d = x.shell.createDraft(x.cp, 100_000, null);
      await x.shell.prepare(d.id);
      const r = () => x.shell.get(d.id)!;
      assert.ok(await until(() => r().status === 'waiting', 40_000), `승인 대기가 오지 않음: ${r().status}`);
      approve(x, d.id);
      assert.ok(await until(() => r().status === 'turn' && r().handoff?.kind === 'sign', 40_000), `서명 차례가 오지 않음: ${r().status}`);
      await x.shell.stop(d.id);
      assert.deepEqual([r().status, r().steps[6]!.state, (r().notices ?? []).includes(STOP_AFTER_SIGN_NOTE)], ['issuing', 'now', true]);
      assert.ok(await until(() => ['done', 'attention', 'stopped'].includes(r().status), 60_000), `끝나지 않음: ${r().status}`);
      assert.notEqual(r().status, 'done');
      assert.equal(x.fx.state.signs, 0);
    } finally {
      await x.close();
    }
  });

  it('사람 차례 상한(run.handoff_timeout): 끝 문구 + "아무것도 발급하지 않았어요" + [다시 준비]', { timeout: 120_000 }, async () => {
    const x = await rig({ loggedIn: false, deps: { handoffCapMs: 2000 } });
    try {
      const d = x.shell.createDraft(x.cp, 100_000, null);
      await x.shell.prepare(d.id);
      const r = () => x.shell.get(d.id)!;
      assert.ok(await until(() => r().status === 'attention', 40_000), `끝나지 않음: ${r().status}`);
      assert.deepEqual([r().handoffEnd, r().redo, r().inDoubt], [true, true, false]);
      assert.equal(r().stoppedNote, `${NOTE['run.handoff_timeout']} 아무것도 발급하지 않았어요. ${HANDOFF_END_NEXT}`);
      assert.equal(x.fx.inner.posts(), 0);
    } finally {
      await x.close();
    }
  });
});
