// 게시본 H-01(hometax.invoice.issue)의 첫 스텝 s0는 session 체크포인트다. 제품 run.start는 이동 없이 금고가 about:blank로 연 탭에서 시작한다.
// 가짜 H-01 패키지 앞에 같은 모양의 s0를 붙여 빈 탭에서 RunService(IR)를 돌리면 게이트까지 가야 한다(2026-11-11 고침 전에는 s0에서 step.assert_failed 핸드오프).
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { it } from 'node:test';
import { BizVerifier, connectRunBrowser, DataService, fixturePortal, RunService, type GatePortMessage, type IrPackage, type RunEvent } from '@sax/engine';
import { fixtureOriginGrant } from '@sax/engine/core';
import { openDatabase } from '@sax/db';
import { Egress } from '@sax/net';
import { FileEventLog } from '@sax/platform';
import { startH01Fixture } from '../apps/desktop/src/h01-fixture.ts';
import { startHarness } from './harness.ts';
import { h01FixtureLookupDefs, loadH01Fixture } from './h01-fixture-package.ts';

it('첫 스텝 session 체크포인트(s0): about:blank 탭에서 시작해도 url로 한 번 가서 게이트까지 간다', async () => {
  const fx = await startH01Fixture({ registry: { '2148651233': 'A상사' }, supplier: { bizNo: '1234567891', name: '가나다컴퍼니' } });
  const h = await startHarness();
  const dir = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'sax-s0-'));
  const db = openDatabase(path.join(dir, 'db.sqlite'), new Uint8Array(randomBytes(32)));
  let runs: RunService | null = null;
  let close: (() => Promise<void>) | null = null;
  try {
    const { pkg } = loadH01Fixture(fx.origin);
    const files = pkg.files as unknown as { playbook: { steps: unknown[] } };
    files.playbook.steps.unshift({ id: 's0', type: 'checkpoint', name: 'session', expect: { exists: 'fixture.invoice.form.root' }, url: `${fx.origin}/invoice/issue`, sessionRequired: true, reentry: 'reload' });
    const p = fixturePortal(fx.origin);
    const ir: IrPackage = {
      pkg, lookupDefs: h01FixtureLookupDefs(fx.origin), fixtureGrant: fixtureOriginGrant(pkg), verifyTiming: { minElapsedMs: p.verify.minElapsedMs, lookups: p.verify.lookups, maxMs: p.verify.maxMs },
      judge: { decide: async () => ({ outcome: 'no_visible_error', confidence: 1, raw: {}, usage: { input_tokens: 0, output_tokens: 0 }, refusals: [], rule: 3, provider: 'openai', model: 'fixture', l0Only: true, injectionHit: false, shadow: [] }) as never },
    };
    const data = new DataService(db, new BizVerifier(new Egress()));
    data.profiles.upsert({ kind: 'business', displayName: '가나다컴퍼니', bizNo: '1234567891', corpNo: null, repName: '김', bizType: null, bizItem: null, address: null, email: null, signMethod: 'simple_auth' });
    const cp = data.counterparties.create({ bizNo: '2148651233', name: 'A상사', email: 'tax@asangsa.example' }).id;
    const rb = await connectRunBrowser(h.client);
    close = () => rb.browser.close().catch(() => {});
    assert.equal(rb.page.url(), 'about:blank');
    const events: RunEvent[] = [];
    const gm: GatePortMessage[] = [];
    runs = new RunService({ db, data, ledgerKey: new Uint8Array(randomBytes(32)), portal: p, log: new FileEventLog(null, 'engine'), page: async () => rb.page, postGate: (m) => gm.push(m), engine: 'ir', irSource: () => ({ ok: true, ir }) });
    runs.on('event', (e: RunEvent) => events.push(e));
    const ended = () => events.some((e) => e.type === 'end' || e.type === 'handoff');
    runs.start({ runId: 'r1', counterpartyId: cp, supply: 100000, tax: 10000, itemName: '경영 컨설팅' });
    for (let i = 0; i < 300 && !ended() && !gm.length; i++) await new Promise((r) => setTimeout(r, 100));
    assert.equal(gm.length, 1, `게이트 요청이 와야 한다: ${JSON.stringify(events.filter((e) => e.type !== 'phase'))}`);
    const journal = runs.inspect('r1').journal;
    assert.ok(!journal.includes('portal.unknown_screen'), journal.join(','));
    runs.stop('r1');
    for (let i = 0; i < 100 && !ended(); i++) await new Promise((r) => setTimeout(r, 100));
    assert.ok(ended(), '중지 뒤 실행이 끝나야 한다');
  } finally {
    // 실패(핸드오프)로 끝나도 사람 차례 타이머가 남지 않게 끈다.
    try {
      runs?.stop('r1');
    } catch {
      /* 이미 끝남 */
    }
    await close?.();
    db.close();
    await h.close();
    await fx.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});
