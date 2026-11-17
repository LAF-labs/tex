// 발급 잠금(ADR-048 결정 7): main 쪽 IssueLockHost(apps/desktop/src/issue-lock-host.ts)와 엔진 쪽 포트(packages/engine/src/issue-lock.ts).
// 계정 서비스는 대역이다(서버 규칙은 services-account.test.ts). 엔진이 언제 묻는지는 h01-golden.test.ts·run-controller.test.ts에 있다.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { VD_PURPOSES, addDevice, ed25519Keygen, initialDeviceList, softSigner, AIK_PURPOSES, uuid4, x25519Keygen, type DeviceListJson } from '../packages/remote/src/index.ts';
import { ISSUE_LOCK_MAX_HOLD_MS, ISSUE_LOCK_RENEW_MS, IssueLockHost, isIssueLockMessage, issueLockNeeded, issueLockResponder, type IssueLockDevice, type IssueLockResult } from '../apps/desktop/src/issue-lock-host.ts';
import { portIssueLock } from '../packages/engine/src/issue-lock.ts';
import type { PortLike } from '../packages/platform/src/index.ts';

const fail = (code: string): never => {
  throw Object.assign(new Error(code), { code });
};

async function lists(): Promise<{ one: DeviceListJson; two: DeviceListJson; onePhone: DeviceListJson }> {
  const aik = softSigner(ed25519Keygen().secretKey, AIK_PURPOSES);
  const dev = (role: 'desktop' | 'mobile') => ({ deviceId: uuid4(), role, noisePub: x25519Keygen().publicKey, signPub: softSigner(ed25519Keygen().secretKey, VD_PURPOSES).publicKey, registeredAt: 1 });
  const one = await initialDeviceList(aik, dev('desktop'));
  return { one, two: await addDevice(aik, one, dev('desktop')), onePhone: await addDevice(aik, one, dev('mobile')) };
}

/** 계정 서비스 발급 잠금 대역: 계정에 하나, 다른 기기가 잡고 있으면 account.issue_locked. */
function server() {
  const st = { holder: null as string | null, lockId: null as string | null, seq: 0, down: false, unauthorized: 0, calls: [] as string[] };
  const gate = (name: string) => {
    st.calls.push(name);
    if (st.down) fail('account.unavailable');
    if (st.unauthorized > 0) {
      st.unauthorized--;
      fail('account.unauthorized');
    }
  };
  const client = {
    acquireIssueLock: async () => {
      gate('acquire');
      if (st.holder && st.holder !== 'me') fail('account.issue_locked');
      st.holder = 'me';
      st.lockId = `lock-${++st.seq}`.padEnd(24, '0');
      return { lockId: st.lockId, expiresAt: 90_000 };
    },
    renewIssueLock: async (_a: unknown, lockId: string) => {
      gate('renew');
      if (st.holder !== 'me' || st.lockId !== lockId) fail('account.issue_lock_lost');
      return { expiresAt: 90_000 };
    },
    releaseIssueLock: async (_a: unknown, lockId: string) => {
      gate('release');
      if (st.holder === 'me' && st.lockId === lockId) st.holder = st.lockId = null;
    },
  };
  return { st, client };
}

function mk(list: DeviceListJson | null, o: { client?: ReturnType<typeof server>['client'] | null } = {}) {
  const srv = server();
  let now = 1_000_000;
  const ticks: Array<() => void> = [];
  let stops = 0;
  const dev = { list, cleared: 0, throws: false };
  const logs: string[] = [];
  const blocked: boolean[] = [];
  const host = new IssueLockHost({
    client: o.client === undefined ? srv.client : o.client,
    device: async (): Promise<IssueLockDevice | null> => {
      if (dev.throws) throw new Error('identity');
      return dev.list ? { deviceId: 'd1', deviceList: dev.list, auth: async () => ({}), clearToken: () => void dev.cleared++ } : null;
    },
    now: () => now,
    timers: { every: (ms, fn) => (assert.equal(ms, ISSUE_LOCK_RENEW_MS), ticks.push(fn), () => void (stops++, ticks.splice(ticks.indexOf(fn), 1))) },
    log: (_n, d) => void logs.push(`${String(d.op)}:${String(d.result)}`),
    onBlocked: (b) => void blocked.push(b),
  });
  let id = 0;
  const ask = (t: 'lock.acquire' | 'lock.renew') => host.handle({ t, id: ++id }) as Promise<Extract<IssueLockResult, { t: 'lock.result' }>>;
  const answer = async (t: 'lock.acquire' | 'lock.renew') => {
    const r = await ask(t);
    return r.ok ? (r.held ? 'held' : 'not_needed') : r.code;
  };
  return { srv, host, dev, logs, blocked, ticks, answer, advance: (ms: number) => void (now += ms), stops: () => stops };
}

describe('발급 잠금(main): 누가 잡아야 하나', () => {
  it('이 PC의 기기 목록에 PC가 2대 이상일 때만. 폰은 세지 않는다', async () => {
    const l = await lists();
    assert.deepEqual([issueLockNeeded(l.one), issueLockNeeded(l.onePhone), issueLockNeeded(l.two)], [false, false, true]);
  });

  it('PC 한 대 계정·로그인 전·계정 연결 없는 실행은 서버를 부르지 않고 통과한다', async () => {
    const l = await lists();
    for (const h of [mk(l.one), mk(l.onePhone), mk(null), mk(l.two, { client: null })]) {
      assert.equal(await h.answer('lock.acquire'), 'not_needed');
      assert.equal(await h.answer('lock.renew'), 'not_needed');
      await h.host.handle({ t: 'lock.release' });
      assert.deepEqual(h.srv.st.calls, []);
      assert.equal(h.host.held, false);
    }
  });

  it('계정을 읽지 못하면(예외) 통과시키지 않는다', async () => {
    const h = mk((await lists()).two);
    h.dev.throws = true;
    assert.equal(await h.answer('lock.acquire'), 'issue.lock_unavailable');
    assert.equal(await h.answer('lock.renew'), 'issue.lock_unavailable');
  });
});

describe('발급 잠금(main): PC 2대 이상', () => {
  it('잡기 → 30초마다 갱신 → 커밋 직전 갱신은 서버가 받아 줘야 한다 → 놓기', async () => {
    const h = mk((await lists()).two);
    assert.equal(await h.answer('lock.acquire'), 'held');
    assert.equal(h.host.held, true);
    assert.equal(h.ticks.length, 1);
    h.ticks[0]!();
    await new Promise((r) => setImmediate(r));
    assert.equal(await h.answer('lock.renew'), 'held');
    assert.equal(await h.host.handle({ t: 'lock.release' }), null);
    assert.deepEqual(h.srv.st.calls, ['acquire', 'renew', 'renew', 'release']);
    assert.deepEqual([h.host.held, h.srv.st.holder, h.ticks.length], [false, null, 0]);
    // 놓은 뒤 커밋 직전 갱신이 오면(쉬었다가 게이트를 거치지 않고 온 경우) 누르지 못하게 한다
    assert.equal(await h.answer('lock.renew'), 'issue.lock_lost');
    assert.ok(!JSON.stringify(h.logs).includes('lock-'), '잠금 값은 기록하지 않는다');
  });

  it('다른 PC가 잡고 있으면 issue.locked_elsewhere(화면에 알린다), 풀리면 잡는다', async () => {
    const h = mk((await lists()).two);
    h.srv.st.holder = 'other';
    assert.equal(await h.answer('lock.acquire'), 'issue.locked_elsewhere');
    assert.equal(await h.answer('lock.acquire'), 'issue.locked_elsewhere');
    assert.deepEqual(h.blocked, [true]);
    assert.equal(h.host.held, false);
    h.srv.st.holder = null;
    assert.equal(await h.answer('lock.acquire'), 'held');
    assert.deepEqual(h.blocked, [true, false]);
  });

  it('서버에 닿지 못하면 issue.lock_unavailable: 잡기도, 커밋 직전 갱신도 통과시키지 않는다', async () => {
    const h = mk((await lists()).two);
    h.srv.st.down = true;
    assert.equal(await h.answer('lock.acquire'), 'issue.lock_unavailable');
    h.srv.st.down = false;
    assert.equal(await h.answer('lock.acquire'), 'held');
    h.srv.st.down = true;
    assert.equal(await h.answer('lock.renew'), 'issue.lock_unavailable');
    assert.equal(h.host.held, true, '서버에 살아 있을 수 있으니 값은 둔다');
    h.srv.st.down = false;
    assert.equal(await h.answer('lock.renew'), 'held');
  });

  it('잠금이 만료돼 다른 PC로 넘어갔으면 커밋 직전 갱신이 issue.lock_lost. 다시 잡으려 하면 locked_elsewhere', async () => {
    const h = mk((await lists()).two);
    assert.equal(await h.answer('lock.acquire'), 'held');
    h.srv.st.holder = 'other';
    assert.equal(await h.answer('lock.renew'), 'issue.lock_lost');
    assert.equal(h.host.held, false);
    assert.equal(await h.answer('lock.acquire'), 'issue.locked_elsewhere');
    // 30초 갱신이 먼저 알아채도 같다
    const h2 = mk((await lists()).two);
    await h2.answer('lock.acquire');
    h2.srv.st.holder = 'other';
    h2.ticks[0]!();
    await new Promise((r) => setImmediate(r));
    assert.equal(h2.host.held, false);
    assert.ok(h2.logs.includes('hold:issue.lock_lost'));
  });

  it('기기 토큰이 만료됐으면(401) 토큰을 버리고 한 번 다시 한다', async () => {
    const h = mk((await lists()).two);
    h.srv.st.unauthorized = 1;
    assert.equal(await h.answer('lock.acquire'), 'held');
    assert.equal(h.dev.cleared, 1);
    assert.deepEqual(h.srv.st.calls, ['acquire', 'acquire']);
  });

  it('20분 넘게 잡고 있으면 더 갱신하지 않는다(멈춘 실행이 다른 PC를 계속 막지 않는다). 커밋 직전 갱신은 그래도 서버에 묻는다', async () => {
    const h = mk((await lists()).two);
    await h.answer('lock.acquire');
    h.advance(ISSUE_LOCK_MAX_HOLD_MS + 1);
    const before = h.srv.st.calls.length;
    h.ticks[0]!();
    await new Promise((r) => setImmediate(r));
    assert.equal(h.srv.st.calls.length, before, '서버를 부르지 않았다');
    assert.equal(h.ticks.length, 0);
    assert.ok(h.logs.includes('hold:max_hold'));
    // 서버 잠금이 그 사이 풀려 다른 PC가 잡았다
    h.srv.st.holder = 'other';
    assert.equal(await h.answer('lock.renew'), 'issue.lock_lost');
    // 다시 잡으면 20분을 새로 센다
    h.srv.st.holder = null;
    assert.equal(await h.answer('lock.acquire'), 'held');
    assert.equal(h.ticks.length, 1);
  });

  it('승인을 기다리는 사이 PC가 한 대에서 두 대가 됐으면 커밋 직전에 막는다(잠금 없이 왔다). 두 대에서 한 대가 됐으면 놓고 통과한다', async () => {
    const l = await lists();
    const h = mk(l.one);
    assert.equal(await h.answer('lock.acquire'), 'not_needed');
    h.dev.list = l.two;
    assert.equal(await h.answer('lock.renew'), 'issue.lock_lost');
    assert.equal(await h.answer('lock.acquire'), 'held');
    h.dev.list = l.one;
    assert.equal(await h.answer('lock.acquire'), 'not_needed');
    assert.deepEqual([h.host.held, h.srv.st.holder], [false, null], '들고 있던 잠금은 놓았다');
  });

  it('엔진이 죽으면 main이 놓는다. 놓지 못해도 조용히 끝난다(서버 잠금은 90초 뒤 풀린다)', async () => {
    const h = mk((await lists()).two);
    await h.answer('lock.acquire');
    h.srv.st.down = true;
    await h.host.release();
    assert.equal(h.host.held, false);
    assert.ok(h.logs.includes('release:failed'));
    await h.host.release();
  });

  it('모양이 틀린 메시지에는 답하지 않는다', async () => {
    const h = mk((await lists()).two);
    for (const m of [null, 1, {}, { t: 'lock.acquire' }, { t: 'lock.acquire', id: -1 }, { t: 'lock.acquire', id: 1.5 }, { t: 'lock.renew', id: '1' }, { t: 'gw.auth', id: 1 }]) assert.equal(await h.host.handle(m), null);
    assert.deepEqual(h.srv.st.calls, []);
  });
});

describe('발급 잠금: auth 포트 양쪽', () => {
  /** 엔진 쪽 포트와 main 쪽 응답기를 한 줄로 잇는다. */
  function wire(handler: () => ((m: unknown) => Promise<IssueLockResult | null>) | null) {
    let toEngine: (m: unknown) => void = () => {};
    const sent: unknown[] = [];
    const respond = issueLockResponder(handler, (r) => toEngine(r));
    const port: PortLike = {
      postMessage: (m) => {
        sent.push(m);
        if (isIssueLockMessage(m)) respond(m);
      },
      onMessage: (fn) => void (toEngine = fn),
      close: () => {},
    };
    return { port, sent, push: (m: unknown) => toEngine(m) };
  }

  it('엔진 포트 ↔ main 응답기: 잡기·갱신·놓기', async () => {
    const h = mk((await lists()).two);
    const w = wire(() => (m) => h.host.handle(m));
    const lock = portIssueLock(w.port);
    assert.deepEqual(await lock.acquire(), { ok: true });
    assert.deepEqual(await lock.renew(), { ok: true });
    lock.release();
    await h.host.release();
    assert.deepEqual(h.srv.st.calls, ['acquire', 'renew', 'release']);
    h.srv.st.holder = 'other';
    assert.deepEqual(await lock.acquire(), { ok: false, code: 'issue.locked_elsewhere' });
    assert.deepEqual(await lock.renew(), { ok: false, code: 'issue.lock_lost' });
    assert.ok(w.sent.every((m) => Object.keys(m as object).every((k) => k === 't' || k === 'id')), '엔진은 이름과 번호만 보낸다');
  });

  it('main에 답하는 쪽이 아직 없거나 던지면 issue.lock_unavailable(엔진은 승인을 열지 않는다)', async () => {
    const none = portIssueLock(wire(() => null).port);
    assert.deepEqual(await none.acquire(), { ok: false, code: 'issue.lock_unavailable' });
    assert.deepEqual(await none.renew(), { ok: false, code: 'issue.lock_unavailable' });
    const throws = portIssueLock(wire(() => async () => Promise.reject(new Error('x'))).port);
    assert.deepEqual(await throws.acquire(), { ok: false, code: 'issue.lock_unavailable' });
  });

  it('엔진 포트: 답이 없으면 시간 초과로 issue.lock_unavailable, 모양이 틀린 답·모르는 코드도 같다. 닫히면 기다리던 것도 끝난다', async () => {
    let toEngine: (m: unknown) => void = () => {};
    const sent: Array<{ t: string; id: number }> = [];
    const port: PortLike = { postMessage: (m) => void sent.push(m as { t: string; id: number }), onMessage: (fn) => void (toEngine = fn), close: () => {} };
    const lock = portIssueLock(port, { timeoutMs: 30 });
    assert.deepEqual(await lock.acquire(), { ok: false, code: 'issue.lock_unavailable' });
    for (const bad of [{ ok: true }, { ok: true, held: 'yes' }, { ok: false }, { ok: false, code: 'gateway.unavailable' }, { ok: 'true', held: true }]) {
      const p = lock.acquire();
      toEngine({ t: 'lock.result', id: sent.at(-1)!.id, ...bad });
      assert.deepEqual(await p, { ok: false, code: 'issue.lock_unavailable' }, JSON.stringify(bad));
    }
    // 늦은 답·다른 번호는 버린다
    toEngine({ t: 'lock.result', id: sent[0]!.id, ok: true, held: true });
    const p = lock.renew();
    toEngine({ t: 'lock.result', id: sent.at(-1)!.id + 100, ok: true, held: true });
    toEngine({ t: 'gw.auth.result', id: sent.at(-1)!.id, headers: {} });
    toEngine({ t: 'lock.result', id: sent.at(-1)!.id, ok: true, held: false });
    assert.deepEqual(await p, { ok: true }, '잠금이 필요 없는 PC(held:false)도 통과');
    const waiting = lock.acquire();
    lock.close();
    assert.deepEqual(await waiting, { ok: false, code: 'issue.lock_unavailable' });
    assert.deepEqual(await lock.acquire(), { ok: false, code: 'issue.lock_unavailable' });
    const n = sent.length;
    lock.release();
    assert.equal(sent.length, n, '닫힌 뒤에는 보내지 않는다');
  });
});

describe('발급 잠금: 배선(소스 검사)', () => {
  const read = (p: string) => fs.readFileSync(path.join(import.meta.dirname, '..', p), 'utf8');

  it('main: auth 포트의 lock.*은 게이트웨이 인증 줄과 따로 답하고, 셸이 계정 기기 세션으로 답하는 쪽을 붙인다. 엔진이 죽으면 놓는다', () => {
    const host = read('apps/desktop/src/engine-host.ts');
    assert.match(host, /this\.authPort\.on\('message', \(e\) => \(isIssueLockMessage\(e\.data\) \? onLock\(e\.data\) : void onAuth\(e\.data\)\)\);/);
    const shell = read('apps/desktop/src/shell-app.ts');
    assert.match(shell, /const issueLock = new IssueLockHost\(\{\s*client: opts\.remote\?\.keys \? \(opts\.remote\.cloud\?\.account \?\? null\) : null,\s*device: async \(\) => \{\s*await accountInit\(\);\s*return account\.device\(\);/);
    assert.match(shell, /host\.setIssueLock\(\(m\) => issueLock\.handle\(m\)\);/);
    assert.match(shell, /host\.on\('exit', \(\) => void issueLock\.release\(\)\);/);
  });

  it('엔진: 제품 기동은 auth 포트로 잠금 포트를 만들어 RunService에 넘기고, IR 세금계산서 발급(예행 아님)만 쓴다', () => {
    const entry = read('packages/engine/src/entry.ts');
    assert.match(entry, /const issueLock = auth \? portIssueLock\(auth\) : null;/);
    assert.match(entry, /\.\.\.\(issueLock \? \{ issueLock \} : \{\}\),/);
    const runs = read('packages/engine/src/runs.ts');
    assert.match(runs, /\.\.\.\(this\.d\.issueLock && !a\.rehearsal \? \{ issueLock: this\.d\.issueLock \} : \{\}\),/);
    const ir = read('packages/engine/src/run/service-ir.ts');
    assert.match(ir, /const lock = kind === 'invoice' \? i\.issueLock : undefined;/);
    // 기준선보다 먼저 잡는다
    assert.match(ir, /const locked = await this\.takeIssueLock\(clock\);\s*if \(!locked\.ok\) return locked;\s*return takeBaseline\(verifyDeps, ir, g\);/);
  });

  it('잠금 코드는 다른 발급 길로 넘어가지 않고(stop), 재시도 없이 사람 차례다(handoff)', async () => {
    const { branchOf } = await import('../packages/engine/src/issue/routes.ts');
    const { FORCED_STOPS } = await import('../packages/engine/src/core/interp.ts');
    for (const code of ['issue.locked_elsewhere', 'issue.lock_unavailable', 'issue.lock_lost', 'commit.precheck_failed']) {
      assert.equal(branchOf(code), 'stop', code);
      assert.equal(FORCED_STOPS.get(code), 'handoff', code);
    }
  });

  it('화면 문구: 잠금 차례에는 [이어서]만 있다([직접 발급함] 없음), 기다리는 동안의 한 줄이 있다', async () => {
    const { handoffTurn, NOTE } = await import('../apps/desktop/src/shell-runs.ts');
    for (const code of ['issue.locked_elsewhere', 'issue.lock_unavailable', 'issue.lock_lost', 'commit.precheck_failed']) {
      const t = handoffTurn('gate', code);
      assert.equal(t.kind, 'login', code);
      assert.match(t.note, /\[이어서\]/);
      assert.ok(NOTE[code], code);
    }
    assert.equal(NOTE['issue.locked_elsewhere'], '다른 PC에서 발급 중이에요. 끝나면 이어서 할게요.');
    assert.equal(handoffTurn('gate', 'issue.locked_elsewhere').text, '다른 PC에서 발급 중이에요');
  });
});
