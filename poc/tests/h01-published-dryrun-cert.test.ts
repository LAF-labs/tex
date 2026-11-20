import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { BizVerifier, connectRunBrowser, DataService, fixturePortal, RunService, type GatePortMessage, type IrPackage, type RunEvent, type SecretVault } from '@sax/engine';
import { fixtureOriginGrant, type PdfPort } from '@sax/engine/core';
import { openDatabase } from '@sax/db';
import { Egress } from '@sax/net';
import { FileEventLog } from '@sax/platform';
import { startHarness } from './harness.ts';
import { h01FixtureLookupDefs } from './h01-fixture-package.ts';
import { loadPublishedDryRun, startLoginFixture, type LoginFixture } from './h01-published-dryrun.ts';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const PDF: PdfPort = {
  print: async () => ({ ok: true, fileId: 'a'.repeat(32) }),
  armDownload: async () => ({ armed: false, reason: 'n/a' }),
  awaitDownload: async () => ({ ok: false, reason: 'n/a' }),
  disarmDownload: async () => {},
  store: async () => ({ ok: true, documentId: 'doc-1' }),
};

class FakeVault implements SecretVault {
  calls: string[] = [];
  async rpc<T>(m: string): Promise<T> {
    this.calls.push(m);
    return { ok: false, reason: 'not_found' } as T;
  }
  on() {
    return () => {};
  }
}

type Handoff = { phase: string; code?: string };
type Human = (h: Handoff, x: { fx: LoginFixture; resume: () => { ok: boolean }; click: (css: string) => Promise<void>; waitFor: (css: string) => Promise<void> }) => Promise<void>;

async function certRun(o: { loggedIn?: boolean; human: Human; maxMs?: number }) {
  const fx = await startLoginFixture({ loggedIn: o.loggedIn });
  const h = await startHarness();
  const dir = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'sax-dry-cert-'));
  const db = openDatabase(path.join(dir, 'db.sqlite'), new Uint8Array(randomBytes(32)));
  const events: RunEvent[] = [];
  const gm: GatePortMessage[] = [];
  const steps: string[] = [];
  const vault = new FakeVault();
  let gateHook: () => void = () => {};
  try {
    const { pkg } = loadPublishedDryRun(fx.origin);
    const p = fixturePortal(fx.origin);
    const judge = {
      decide: async (bundle: string) => {
        const outcome = bundle.startsWith('screen_state') ? (fx.state.loggedIn ? 'logged_in' : fx.state.pending ? 'mfa_pending' : 'login_required') : 'no_visible_error';
        return { outcome, confidence: 1, raw: {}, usage: { input_tokens: 0, output_tokens: 0 }, refusals: [], rule: 3, provider: 'openai', model: 'fixture', l0Only: true, injectionHit: false, shadow: [] } as never;
      },
    };
    const rb = await connectRunBrowser(h.client);
    const ir: IrPackage = {
      pkg, lookupDefs: h01FixtureLookupDefs(fx.origin), fixtureGrant: fixtureOriginGrant(pkg), verifyTiming: { minElapsedMs: p.verify.minElapsedMs, lookups: p.verify.lookups, maxMs: p.verify.maxMs }, judge, pdf: PDF,
      secret: { vault, targetId: () => 'T1' },
    };
    const data = new DataService(db, new BizVerifier(new Egress()));
    data.profiles.upsert({ kind: 'business', displayName: '가나다컴퍼니', bizNo: '1234567891', corpNo: null, repName: '김', bizType: null, bizItem: null, address: null, email: null, signMethod: 'cert' });
    const cp = data.counterparties.create({ bizNo: '2148651233', name: 'A상사', email: 'tax@asangsa.example' }).id;
    const runs = new RunService({
      db, data, ledgerKey: new Uint8Array(randomBytes(32)), portal: p, log: new FileEventLog(null, 'engine'), page: async () => rb.page,
      postGate: (m) => (gm.push(m), m.t === 'gate.request' && gateHook()), engine: 'ir', irSource: () => ({ ok: true, ir }),
      trace: (_r: string, t: { name: string; stepId: string; code?: string }) => {
        if (t.name === 'step.finished') steps.push(t.code ? `${t.stepId}!${t.code}` : t.stepId);
      },
    } as never);
    const x = {
      fx, resume: () => runs.resume('r1'),
      click: async (css: string) => void (await rb.page.click(css, { timeout: 10_000 })),
      waitFor: async (css: string) => void (await rb.page.waitForSelector(css, { timeout: 30_000 })),
    };
    const humanErrors: unknown[] = [];
    let turn: Promise<void> = Promise.resolve();
    let ended!: () => void;
    const end = new Promise<void>((r) => (ended = r));
    runs.on('event', (e: RunEvent) => {
      events.push(e);
      if (e.type === 'end') ended();
      if (e.type === 'handoff') turn = turn.then(() => o.human(e as Handoff, x)).catch((err) => void humanErrors.push(err));
    });
    const answerGate = () => {
      const g = gm.find((m) => m.t === 'gate.request');
      if (!g || g.t !== 'gate.request') return;
      const q = g.req;
      runs.answer({ v: 2, runId: q.runId, gateStepId: q.gateStepId, reqId: q.reqId, approvalNonce: q.approvalNonce, actionHash: q.actionHash, exp: Date.now() + 120_000, presence: 'click', mac: 'not-verified-in-phase1' });
    };
    gateHook = () => queueMicrotask(answerGate);
    runs.start({ runId: 'r1', counterpartyId: cp, supply: 100000, tax: 10000, itemName: '경영 컨설팅' });
    let cap: NodeJS.Timeout | undefined;
    await Promise.race([end, new Promise<void>((r) => (cap = setTimeout(r, o.maxMs ?? 240_000)))]);
    clearTimeout(cap);
    await turn;
    if (humanErrors.length) throw humanErrors[0];
    const journal = runs.inspect('r1').journal;
    try {
      runs.stop('r1');
    } catch {
      /* 끝남 */
    }
    await rb.browser.close().catch(() => {});
    return { end: events.find((e) => e.type === 'end') as { status?: string; code?: string } | undefined, events, journal, steps, posts: fx.inner.posts(), signs: fx.state.signs, vault };
  } finally {
    db.close();
    await h.close();
    await fx.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
}

const handoffs = (events: RunEvent[]) => events.filter((e) => e.type === 'handoff').map((e) => `${(e as { phase: string }).phase}:${(e as { code?: string }).code ?? ''}`);

describe('게시본 H-01 건조 실행: 공동인증서 사람 차례(B1·B2)', () => {
  it('B1 로그인(s4 sign cert → human:secret): 바로 끝나지 않고 사람 대기(login, human.cert_waiting). 사람이 인증서 창에서 끝내고 [다 했어요]면 체크포인트부터 로그인 확인 → 발급까지', async () => {
    const o = await certRun({
      human: async (h, { fx, resume, click, waitFor }) => {
        if (h.phase === 'login' && h.code === 'human.cert_waiting') {
          fx.completeLogin();
          await waitFor('a[href="/logout"]');
          assert.equal(resume().ok, true);
        } else if (h.phase === 'sign' && h.code === 'sign.waiting') {
          await click('#btnSign');
          for (let i = 0; i < 100 && fx.state.signs === 0; i++) await sleep(100);
          assert.equal(resume().ok, true);
        }
      },
    });
    const show = `end=${JSON.stringify(o.end)} handoffs=${handoffs(o.events).join(' ')} steps=${o.steps.join(' ')} journal=${o.journal.join(',')}`;
    assert.equal(o.end?.status, 'success', show);
    assert.deepEqual(handoffs(o.events), ['login:human.cert_waiting', 'sign:sign.waiting'], show);
    assert.ok(!o.journal.includes('human.secret_ttl'), '바로 시간 초과로 끝나지 않는다');
    assert.ok(o.journal.includes('human.secret_manual'), show);
    assert.ok(o.journal.includes('run.resumed'), show);
    assert.deepEqual([o.posts, o.signs], [1, 1], '발급 POST·서명 각 1번(엔진은 서명 버튼을 누르지 않았다)');
    assert.deepEqual(o.vault.calls, [], '칸이 사전에 없으면 금고 창을 부르지 않는다(값은 엔진에 오지 않는다)');
  });

  it('B2 발급 서명(s21 signFlow cert human:secret): 바로 verify로 가지 않고 서명 차례(sign.waiting)를 기다린다. [다 했어요] 뒤 verify가 발급을 확인한다', async () => {
    const o = await certRun({
      loggedIn: true,
      human: async (h, { fx, resume, click }) => {
        if (h.phase !== 'sign') return;
        await click('#btnSign');
        for (let i = 0; i < 100 && fx.state.signs === 0; i++) await sleep(100);
        assert.equal(resume().ok, true);
      },
    });
    const show = `end=${JSON.stringify(o.end)} handoffs=${handoffs(o.events).join(' ')} steps=${o.steps.join(' ')} journal=${o.journal.join(',')}`;
    assert.equal(o.end?.status, 'success', show);
    assert.deepEqual(handoffs(o.events), ['sign:sign.waiting'], show);
    assert.ok(o.journal.includes('sign.turn_opened'), show);
    assert.deepEqual([o.posts, o.signs], [1, 1], show);
  });
});
