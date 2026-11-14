// 홈택스 사용량 상한(대표 결정 2026-11-12): 시범 상한이 없어도 평소 사용은 막히지 않고, 새 상한에 닿으면 사람이 읽는 문구로 거절한다.
// 브라우저 없이 실제 SQLite와 고정 시계로 RunService 시작·RateGuard를 본다. 페이지는 열리지 않는다.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { BizVerifier, DataService, fixturePortal, policyFor, RateGuard, RunEnd, RunService, type Clock, type PortalConfig, type RunEvent } from '@sax/engine';
import { GateRepo, Ledger, openDatabase, RunRepo, type Db } from '@sax/db';
import { Egress } from '@sax/net';
import { FileEventLog } from '@sax/platform';
import { NOTE } from '../apps/desktop/src/shell-runs.ts';

/** 월말 KST 12:00. */
const CLOCK: Clock = { wall: () => Date.parse('2026-11-30T03:00:00Z'), mono: () => 0 };
const PORTAL: PortalConfig = { ...fixturePortal('http://127.0.0.1:9'), kind: 'hometax', verify: { minElapsedMs: 60_000, lookups: 2, intervalMs: 10_000, maxMs: 300_000 } };

describe('홈택스 사용량 상한(대표 결정 2026-11-12)', () => {
  let dir: string;
  const dbs: Db[] = [];
  before(async () => {
    dir = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'sax-caps-'));
  });
  after(async () => {
    for (const d of dbs) d.close();
    await fs.rm(dir, { recursive: true, force: true });
  });

  /** 내장 홈택스 정책으로 도는 RunService(받은 정책 없음). guard는 같은 DB·시계의 카운터를 실제 실행처럼 올린다. */
  const setup = () => {
    const db = openDatabase(path.join(dir, `${dbs.length}.sqlite`), new Uint8Array(randomBytes(32)));
    dbs.push(db);
    const data = new DataService(db, new BizVerifier(new Egress()));
    data.profiles.upsert({ kind: 'business', displayName: '가나다', bizNo: '1234567891', corpNo: null, repName: '김가나', bizType: null, bizItem: null, address: null, email: null, signMethod: 'simple_auth' });
    const profileId = data.profiles.byKind('business')!.id;
    const cp = data.counterparties.create({ bizNo: '2148651233', name: 'A상사', email: null }).id;
    const log = new FileEventLog(null, 'engine');
    const guard = new RateGuard(db, 'hometax', policyFor('hometax'), CLOCK);
    const service = () => new RunService({ engine: 'h01', db, data, ledgerKey: new Uint8Array(32), portal: PORTAL, clock: CLOCK, log, page: () => Promise.reject(new Error('no page')), postGate: () => {} });
    let n = 0;
    /** 발급 준비 한 번. 시작했으면 실행이 끝날 때까지 기다린다. 거절이면 RunEnd를 던진다. */
    const start = async (runs: RunService) => {
      const runId = `cap-${++n}`;
      const ended = new Promise<RunEvent>((r) => runs.on('event', (e: RunEvent) => e.runId === runId && e.type === 'end' && r(e)));
      runs.start({ runId, counterpartyId: cp, supply: 1000, tax: 100, itemName: '납품' });
      return ended;
    };
    return { db, profileId, guard, service, start, refused: () => log.lines.filter((l) => l.includes('run.policy_refused')) };
  };

  it('누적 실발급 3건이 있어도 4건째 발급을 시작한다', async () => {
    const s = setup();
    const ledger = new Ledger(s.db);
    const gates = new GateRepo(s.db);
    new RunRepo(s.db).create({ id: 'past', playbookId: 'p', playbookVersion: '1', packageDigest: 'd', profileId: s.profileId, trigger: 'local', inputsHash: 'i' });
    for (const [i, state] of (['committed', 'in_doubt', 'committed'] as const).entries()) {
      gates.open(`q${i}`, 'past');
      gates.decide(`q${i}`, 'approved', 'local');
      ledger.consumeAndArm(`q${i}`, { intentId: `I${i}`, stepId: 's21', runId: 'past', businessKey: `bk${i}`, playbookId: 'p', inputsHash: 'i', packageDigest: 'd', actionHash: 'a', deviceId: 'dv', cpBizNoHmac: 'h', recipientEmailHmac: null });
      ledger.resolve(`I${i}`, 's21', state, null, state === 'committed' ? `APP-${i}` : null);
    }
    await s.start(s.service());
    assert.deepEqual(s.refused(), []);
  });

  it('같은 프로필이 오늘 1건 발급한 뒤 2건째 발급을 시작한다', async () => {
    const s = setup();
    s.guard.countCommit(s.profileId);
    await s.start(s.service());
    assert.deepEqual(s.refused(), []);
    assert.equal(s.guard.status(s.profileId).irreversibleToday, 1);
  });

  it('하루 4번째 홈택스 로그인을 거절하지 않는다', () => {
    const { guard, profileId } = setup();
    for (let i = 0; i < 4; i++) {
      guard.beforeLogin();
      guard.loginSucceeded(profileId);
    }
  });

  it('하루 발급 50건에 닿으면 51건째 시작을 거절하고, 사람이 읽는 문구가 있다', async () => {
    const s = setup();
    for (let i = 0; i < 50; i++) s.guard.countCommit(s.profileId);
    const refusal = await s.start(s.service()).then(() => null, (e: unknown) => e);
    assert.ok(refusal instanceof RunEnd);
    assert.equal(refusal.code, 'policy.irreversible_per_day');
    assert.equal(s.refused().length, 1);
    assert.match(NOTE[refusal.code]!, /^오늘 홈택스 발급 건수 상한에 닿아 멈췄어요\. 아무것도 발급하지 않았어요\. 내일 다시 할 수 있어요\.$/);
  });

  it('새 상한(실행 100·로그인 12·세션당 30)에 닿으면 거절하고, 문구에 지난 시범 숫자가 없다', () => {
    const { guard, profileId } = setup();
    const refusal = (f: () => void) => {
      try {
        f();
      } catch (e) {
        if (e instanceof RunEnd) return e.code;
        throw e;
      }
      return null;
    };
    for (let i = 0; i < 100; i++) assert.equal(refusal(() => guard.admit(profileId, { irreversible: false })), null, `실행 ${i + 1}번째`);
    assert.equal(refusal(() => guard.admit(profileId, { irreversible: false })), 'policy.runs_per_day');
    for (let i = 0; i < 12; i++) {
      assert.equal(refusal(() => guard.beforeLogin()), null, `로그인 ${i + 1}번째`);
      guard.loginSucceeded(profileId);
    }
    assert.equal(refusal(() => guard.beforeLogin()), 'policy.logins_per_day');
    for (let i = 1; i < 30; i++) assert.equal(refusal(() => guard.continueSession(profileId)), null, `세션 실행 ${i + 1}번째`);
    assert.equal(refusal(() => guard.continueSession(profileId)), 'policy.runs_per_session');
    for (const code of ['policy.runs_per_day', 'policy.logins_per_day', 'policy.runs_per_session', 'policy.irreversible_per_day']) {
      assert.match(NOTE[code] ?? '', /상한|다 써서/, code);
      assert.doesNotMatch(NOTE[code]!, /시범|\d/, `${code}: 숫자는 보수 모드에서 절반이 되므로 넣지 않는다`);
    }
  });
});
