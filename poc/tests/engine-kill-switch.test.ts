// 서버 긴급 정지(레지스트리 status의 killPlaybooks·portalModeCeiling)를 실행에 반영한다(팀장 결정 2026-11-09 ④).
// D03 §2(Running 진입 확인·정지 하향 행), §3.1(status 소비), §7.1(조회와 적용: 커밋 구간 안에서는 새 값을 적용하지 않는다), §12(실효 수준), ADR-023 결정 5·6.
// 실제 포털 접속 없음: 금고는 프로세스 안(시험 정책 127.0.0.1)·헤드리스 Chrome, 가짜 H-01 페이지, 모델 없음.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { BizVerifier, connectRunBrowser, DataService, fixturePortal, RunEnd, RunService, type GatePortMessage, type GateRequest, type IrPackage, type LocalApproval, type RunEvent } from '@sax/engine';
import { effectiveMode, fixtureOriginGrant, runPermit, type PdfPort, type PermitStatus } from '@sax/engine/core';
import { openDatabase, type Db } from '@sax/db';
import { Egress } from '@sax/net';
import { FileEventLog } from '@sax/platform';
import type { Page } from 'playwright-core';
import { startH01Fixture, type H01Fixture } from '../apps/desktop/src/h01-fixture.ts';
import { startHarness, type Harness } from './harness.ts';
import { h01FixtureLookupDefs, loadH01Fixture } from './h01-fixture-package.ts';

const SUPPLIER = { bizNo: '1234567891', name: '가나다컴퍼니' };
const A = { bizNo: '2148651233', name: 'A상사', email: 'tax@asangsa.example' };

describe('runPermit: 실효 수준(내장 상한 ∧ status 상한)과 killPlaybooks (D03 §3.1·§12)', () => {
  const st = (o: Partial<PermitStatus> = {}): PermitStatus => ({ portalModeCeiling: {}, killPlaybooks: [], ...o });
  it('status가 없거나 비어 있으면 홈택스는 auto(내장 상한)', () => {
    assert.deepEqual(runPermit(null, 'hometax', 'hometax.invoice.issue'), { ok: true, mode: 'auto' });
    assert.deepEqual(runPermit(st(), 'hometax', 'hometax.invoice.issue'), { ok: true, mode: 'auto' });
  });
  it('status 상한은 하향만: postprocess면 거부·hardStop, assisted면 거부(Chrome은 닫지 않음), auto여도 내장 postprocess 포털은 못 올린다', () => {
    assert.deepEqual(runPermit(st({ portalModeCeiling: { hometax: 'postprocess' } }), 'hometax', 'x.y'), { ok: false, code: 'policy.portal_mode_denied', mode: 'postprocess', hardStop: true });
    assert.deepEqual(runPermit(st({ portalModeCeiling: { hometax: 'assisted' } }), 'hometax', 'x.y'), { ok: false, code: 'policy.portal_mode_denied', mode: 'assisted', hardStop: false });
    assert.equal(effectiveMode(st({ portalModeCeiling: { gov24: 'auto' } }), 'gov24'), 'postprocess');
    assert.equal(runPermit(st({ portalModeCeiling: { gov24: 'auto' } }), 'gov24', 'gov24.x').ok, false);
  });
  it('다른 포털의 상한은 이 포털에 영향이 없다', () => {
    assert.equal(runPermit(st({ portalModeCeiling: { wetax: 'postprocess' } }), 'hometax', 'x.y').ok, true);
  });
  it('kill은 그 플레이북 id만, 수준과 무관하게 거부·hardStop', () => {
    assert.deepEqual(runPermit(st({ killPlaybooks: ['hometax.invoice.issue'] }), 'hometax', 'hometax.invoice.issue'), { ok: false, code: 'policy.playbook_killed', mode: 'auto', hardStop: true });
    assert.equal(runPermit(st({ killPlaybooks: ['hometax.invoice.issue'] }), 'hometax', 'hometax.invoice.lookup').ok, true);
  });
});

type Engine = 'h01' | 'ir';
const PLAYBOOK: Record<Engine, string> = { h01: 'hometax.invoice.issue', ir: 'fixture.invoice.issue' };

describe('긴급 정지 배선: RunService(H01·IR) 시작 거부·실행 중 정지·커밋 구간 (팀장 결정 2026-11-09 ④)', () => {
  let fx: H01Fixture;
  let h: Harness;
  let page: Page | null = null;
  let ir: IrPackage;
  const log = new FileEventLog(null, 'engine');
  let n = 0;

  interface Side {
    runs: RunService;
    db: Db;
    dir: string;
    cp: string;
    events: RunEvent[];
    gateMsgs: GatePortMessage[];
    steps: Map<string, string[]>;
    /** 이 값으로 허가를 계산한다(시험이 바꾼다). */
    status: PermitStatus;
    /** 스텝이 시작될 때 부른다(시험이 status를 바꾸는 자리). */
    onStep: ((stepId: string) => void) | null;
    pages: number;
    closes: number;
  }
  const sides = {} as Record<Engine, Side>;
  const CLEAR: PermitStatus = { portalModeCeiling: {}, killPlaybooks: [] };

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
  const gateFor = (s: Side, runId: string) => next(() => (s.gateMsgs.find((m) => m.t === 'gate.request' && m.req.runId === runId) as { req: GateRequest } | undefined)?.req);
  const endOf = (s: Side, runId: string) => next(() => s.events.find((e) => e.runId === runId && e.type === 'end') as Extract<RunEvent, { type: 'end' }> | undefined, 60_000);
  const approval = (req: GateRequest): LocalApproval => ({
    v: 2, runId: req.runId, gateStepId: req.gateStepId, reqId: req.reqId, approvalNonce: req.approvalNonce, actionHash: req.actionHash, exp: Date.now() + 120_000, presence: 'click', mac: 'not-verified-in-phase1',
  });

  async function setup(engine: Engine): Promise<Side> {
    const dir = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), `sax-kill-${engine}-`));
    const db = openDatabase(path.join(dir, 'db.sqlite'), new Uint8Array(randomBytes(32)));
    const data = new DataService(db, new BizVerifier(new Egress()));
    data.profiles.upsert({ kind: 'business', displayName: SUPPLIER.name, bizNo: SUPPLIER.bizNo, corpNo: null, repName: '김가나', bizType: null, bizItem: null, address: null, email: null, signMethod: 'simple_auth' });
    const s: Side = { runs: null as never, db, dir, cp: data.counterparties.create({ ...A }).id, events: [], gateMsgs: [], steps: new Map(), status: CLEAR, onStep: null, pages: 0, closes: 0 };
    s.runs = new RunService({
      db, data, ledgerKey: new Uint8Array(randomBytes(32)), portal: fixturePortal(fx.origin), log,
      page: async () => {
        s.pages++;
        return page && !page.isClosed() ? page : (page = (await connectRunBrowser(h.client)).page);
      },
      postGate: (m) => s.gateMsgs.push(m),
      ...(engine === 'ir' ? { engine: 'ir' as const, ir } : { engine: 'h01' as const }),
      // 제품 entry와 같이 fixture 포털에도 홈택스 상한을 적용한다.
      permit: (id) => runPermit(s.status, 'hometax', id),
      closeBrowser: async () => void s.closes++,
      trace: (runId, e) => {
        if (e.name !== 'step.started') return;
        const t = s.steps.get(runId) ?? [];
        if (t.at(-1) !== e.stepId) t.push(e.stepId);
        s.steps.set(runId, t);
        s.onStep?.(e.stepId);
      },
    });
    s.runs.on('event', (e: RunEvent) => s.events.push(e));
    return s;
  }

  before(async () => {
    fx = await startH01Fixture({ registry: { [A.bizNo]: A.name }, supplier: SUPPLIER });
    h = await startHarness();
    const { pkg } = loadH01Fixture(fx.origin);
    const p = fixturePortal(fx.origin);
    const pdf: PdfPort = {
      print: async () => ({ ok: true, fileId: 'a'.repeat(32) }),
      armDownload: async () => ({ armed: true }),
      awaitDownload: async () => ({ ok: true, fileId: 'a'.repeat(32) }),
      disarmDownload: async () => {},
      store: async () => ({ ok: true, documentId: 'doc-1' }),
    };
    ir = {
      pkg, lookupDefs: h01FixtureLookupDefs(fx.origin), fixtureGrant: fixtureOriginGrant(pkg), pdf,
      verifyTiming: { minElapsedMs: p.verify.minElapsedMs, lookups: p.verify.lookups, maxMs: p.verify.maxMs },
      judge: { decide: async () => ({ outcome: 'no_visible_error', confidence: 1, raw: {}, usage: { input_tokens: 0, output_tokens: 0 }, refusals: [], rule: 3, provider: 'openai', model: 'fixture', l0Only: true, injectionHit: false, shadow: [] }) as never },
    };
    sides.h01 = await setup('h01');
    sides.ir = await setup('ir');
  });

  after(async () => {
    for (const s of Object.values(sides)) {
      const id = s.runs.activeRunId;
      if (id) {
        try {
          s.runs.stop(id);
        } catch { /* 커밋 구간 */ }
        await endOf(s, id).catch(() => {});
      }
    }
    await page?.context().browser()?.close().catch(() => {});
    await h.close();
    await fx.close();
    for (const s of Object.values(sides)) {
      s.db.close();
      await fs.rm(s.dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });

  /** 실행을 시작하고 끝까지 본다. drive는 게이트 요청을 받아 승인·하향 등을 한다(null이면 게이트를 기다리지 않는다). */
  async function scenario(e: Engine, drive: ((req: GateRequest, runId: string, s: Side) => Promise<void>) | null, prep: (s: Side) => void = () => {}) {
    const s = sides[e];
    s.status = CLEAR;
    s.onStep = null;
    prep(s);
    const runId = `${e}-kill-${++n}`;
    const posts = fx.posts();
    const closes = s.closes;
    try {
      s.runs.start({ runId, counterpartyId: s.cp, supply: 1_000_000 + n, tax: 100_000, itemName: '경영 컨설팅' });
      if (drive) await drive(await gateFor(s, runId), runId, s);
      const end = await endOf(s, runId);
      const ins = s.runs.inspect(runId);
      return { end, ledger: ins.ledger, journal: ins.journal, steps: s.steps.get(runId) ?? [], posts: fx.posts() - posts, closed: s.gateMsgs.filter((m) => m.t === 'gate.closed' && m.runId === runId).map((m) => (m as { reason: string }).reason), closes: s.closes - closes };
    } finally {
      s.status = CLEAR;
      s.onStep = null;
    }
  }

  for (const e of ['h01', 'ir'] as const) {
    it(`[${e}] 시작 전 kill·postprocess 상한이면 브라우저를 열기 전에 거부한다(요청률 카운터·실행 행 없음)`, () => {
      const s = sides[e];
      const pages = s.pages;
      for (const [status, code] of [
        [{ portalModeCeiling: {}, killPlaybooks: [PLAYBOOK[e]] }, 'policy.playbook_killed'],
        [{ portalModeCeiling: { hometax: 'postprocess' }, killPlaybooks: [] }, 'policy.portal_mode_denied'],
        [{ portalModeCeiling: { hometax: 'assisted' }, killPlaybooks: [] }, 'policy.portal_mode_denied'],
      ] as const) {
        s.status = status;
        const runId = `${e}-refused-${++n}`;
        assert.throws(() => s.runs.start({ runId, counterpartyId: s.cp, supply: 1_000, tax: 100, itemName: '경영 컨설팅' }), (x: unknown) => x instanceof RunEnd && x.code === code);
        assert.equal(s.runs.activeRunId, null);
        assert.equal(s.db.prepare('SELECT count(*) AS n FROM runs WHERE id = ?').get(runId)?.n, 0, '실행 행 없음');
      }
      s.status = CLEAR;
      assert.equal(s.pages, pages, '브라우저를 열지 않았다');
    });

    it(`[${e}] 승인 대기 중 kill(동기화 뒤 recheckPermit): 게이트를 닫고 제출 0, 원장 없음, handoff·policy.playbook_killed, 자동화 Chrome을 닫는다`, async () => {
      const o = await scenario(e, async (_req, _runId, s) => {
        s.status = { portalModeCeiling: {}, killPlaybooks: [PLAYBOOK[e]] };
        s.runs.recheckPermit();
      });
      assert.equal(o.end.status, 'handoff');
      assert.equal(o.end.code, 'policy.playbook_killed');
      assert.equal(o.posts, 0);
      assert.equal(o.ledger, null);
      assert.equal(o.closed.length, 1);
      assert.equal(o.closes, 1);
      assert.ok(o.journal.includes('run.downgraded'));
    });

    it(`[${e}] 실행 중 kill(알림 없이 status만 바뀜): 다음 스텝 전에 멈춘다. 게이트를 열지 않는다`, async () => {
      const o = await scenario(e, null, (s) => {
        s.onStep = (id) => {
          if (id === 's12') s.status = { portalModeCeiling: {}, killPlaybooks: [PLAYBOOK[e]] };
        };
      });
      assert.equal(o.end.status, 'handoff');
      assert.equal(o.end.code, 'policy.playbook_killed');
      assert.equal(o.steps.at(-1), 's12', `s12 다음 스텝은 시작하지 않는다: ${o.steps.join(',')}`);
      assert.equal(o.posts, 0);
      assert.equal(o.ledger, null);
      assert.equal(o.closes, 1);
    });

    it(`[${e}] 실행 중 assisted 하향: 멈추지만 Chrome은 닫지 않는다(hardStop 아님)`, async () => {
      const o = await scenario(e, null, (s) => {
        s.onStep = (id) => {
          if (id === 's12') s.status = { portalModeCeiling: { hometax: 'assisted' }, killPlaybooks: [] };
        };
      });
      assert.equal(o.end.status, 'handoff');
      assert.equal(o.end.code, 'policy.portal_mode_denied');
      assert.equal(o.posts, 0);
      assert.equal(o.closes, 0);
    });
  }

  it('[ir] 커밋 구간(verify 스텝) 중 kill: verify까지 마치고 원장 committed, 그 뒤 사후 스텝(PDF·메일)은 하지 않는다 → completed_with_issues·policy.playbook_killed', async () => {
    const o = await scenario('ir', async (req, _runId, s) => {
      s.onStep = (id) => {
        if (id === 's30') {
          s.status = { portalModeCeiling: {}, killPlaybooks: [PLAYBOOK.ir] };
          s.runs.recheckPermit();
        }
      };
      assert.deepEqual(s.runs.answer(approval(req)), { ok: true });
    });
    assert.equal(o.posts, 1, '발급 요청은 한 번');
    assert.equal(o.ledger, 'committed');
    assert.equal(o.end.status, 'completed_with_issues');
    assert.equal(o.end.code, 'policy.playbook_killed');
    assert.ok(o.end.approvalNo, '승인번호는 그대로 알린다');
    assert.ok(o.steps.includes('s30'), 'verify는 했다');
    for (const id of ['s32', 's33', 's34', 's35']) assert.ok(!o.steps.includes(id), `${id}는 하지 않는다: ${o.steps.join(',')}`);
    assert.equal(o.closes, 1);
  });

  it('[h01] 커밋 구간 중 kill: 무장 뒤라 기록만 하고 verify·메일 확인까지 끝낸다(H01은 PR-D2에서 빠진다)', async () => {
    const o = await scenario('h01', async (req, _runId, s) => {
      s.onStep = (id) => {
        if (id === 's30') {
          s.status = { portalModeCeiling: {}, killPlaybooks: [PLAYBOOK.h01] };
          s.runs.recheckPermit();
        }
      };
      assert.deepEqual(s.runs.answer(approval(req)), { ok: true });
    });
    assert.equal(o.posts, 1);
    assert.equal(o.ledger, 'committed');
    assert.equal(o.end.status, 'success');
    assert.ok(o.journal.includes('run.downgrade_deferred'));
    assert.equal(o.closes, 1, '실행이 끝난 뒤 자동화 Chrome을 닫는다');
  });
});

describe('제품 entry 배선(서버 긴급 정지)', () => {
  it('RunService에 레지스트리 status 허가·Chrome 닫기를 주고, 레지스트리 명령(동기화) 뒤 진행 중 실행을 다시 본다', async () => {
    const src = await fs.readFile(new URL('../packages/engine/src/entry.ts', import.meta.url), 'utf8');
    assert.match(src, /permit: \(id\) => runPermit\(registry\?\.status\(\) \?\? null, 'hometax', id\)/);
    assert.match(src, /closeBrowser: \(\) => slot\.close\(\)/);
    assert.match(src, /const r = await registry\.handle\(method\);\s*\/\/[^\n]*\n\s*runs\?\.recheckPermit\(\);/);
  });
});
