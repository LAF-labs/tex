// 데몬 스케줄러(D10 §3): 주입 시계, 실행 창·지터, 기동 유예, 같은 알림 하루 1회, 하루 상한, 실패 1회 재시도·백오프,
// 시계 역행 가드, 스냅숏 재조회 간격(ADR-023), 정책·status 신선도 판정(D12 §4), notify만(run 항상 false).
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { POLICY_POLL_MIN } from '@sax/engine/core';
import {
  CLOCK_ROLLBACK_TOLERANCE_MS,
  DAEMON_MAX_NOTIFICATIONS_PER_DAY,
  DAEMON_SNAPSHOT_REFRESH_MIN,
  DAEMON_TICK_MS,
  DaemonScheduler,
  daemonGate,
  DEFAULT_WINDOW,
  fireMinute,
  inWindow,
  MemoryStateStore,
  parseWindow,
  type DaemonNotification,
  type DaemonSnapshot,
  type ProfileSnapshot,
} from '@sax/daemon';

const kst = (s: string) => Date.parse(`${s}+09:00`);
const MIN = 60_000;

class FakeClock {
  t: number;
  constructor(s: string) {
    this.t = kst(s);
  }
  now() {
    return this.t;
  }
  set(s: string) {
    this.t = kst(s);
  }
  add(ms: number) {
    this.t += ms;
  }
}

const doc = (id: string, docType: string, expiresAt: string) => ({ id, docType, displayName: docType, issuedAt: '2026-11-01', expiresAt, meta: null });
const profile = (o: Partial<ProfileSnapshot> = {}): ProfileSnapshot => ({
  profileId: 'p1',
  documents: [doc('d1', 'national_tax_cert', '2026-11-30')],
  validityRules: [],
  schedules: [],
  settings: { reminderDay: 5, halfYearWithholding: false },
  // 꾸러미는 보냈고 카드도 최신화했다: 이 파일은 서류 알림 하나로 스케줄러 규칙을 본다
  bundleSentPeriods: ['2026-10'],
  missing: null,
  cardFetchedOn: '2026-11-02',
  ...o,
});
const policy = (expiresAt = '2026-12-31T00:00:00Z', jitter = 0) => ({ expiresAt, daemon: { windowJitterMin: jitter, gapBetweenRunsMin: [5, 15] as [number, number], startupGraceMin: 10, retryAfterMin: 30, autoAllowed: false as const } });
const snapshot = (o: Partial<DaemonSnapshot> = {}): DaemonSnapshot => ({ policy: policy(), status: { issuedAt: '2026-11-23T00:00:00Z', expiresAt: '2026-11-25T00:00:00Z' }, profiles: [profile()], ...o });

function rig(opts: { at: string; snap?: () => DaemonSnapshot; deliver?: (n: DaemonNotification) => void; store?: MemoryStateStore; maxPerDay?: number }) {
  const clock = new FakeClock(opts.at);
  const out: DaemonNotification[] = [];
  let loads = 0;
  const source = {
    snapshot: async () => {
      loads++;
      return (opts.snap ?? (() => snapshot()))();
    },
  };
  const sink = {
    deliver: (n: DaemonNotification) => {
      opts.deliver?.(n);
      out.push(n);
    },
  };
  const s = new DaemonScheduler({ clock, source, sink, store: opts.store, maxPerDay: opts.maxPerDay });
  return { clock, out, s, loads: () => loads };
}

describe('실행 창과 지터', () => {
  it('창: 요일·시작 포함·끝 제외(한국 시간)', () => {
    const w = parseWindow('{"days":[1,2,3,4,5],"from":"09:00","to":"18:00"}')!;
    assert.equal(inWindow(w, kst('2026-11-23T09:00:00')), true); // 월요일
    assert.equal(inWindow(w, kst('2026-11-23T08:59:59')), false);
    assert.equal(inWindow(w, kst('2026-11-23T17:59:59')), true);
    assert.equal(inWindow(w, kst('2026-11-23T18:00:00')), false);
    assert.equal(inWindow(w, kst('2026-11-22T10:00:00')), false); // 일요일
    assert.equal(inWindow(DEFAULT_WINDOW, kst('2026-11-22T10:00:00')), true); // 기본 창은 매일
  });
  it('창 형식 검사: 끝 ≤ 시작, 요일 범위 밖, 깨진 JSON은 null. 24:00 허용', () => {
    assert.equal(parseWindow('{"days":[1],"from":"18:00","to":"09:00"}'), null);
    assert.equal(parseWindow('{"days":[7],"from":"09:00","to":"10:00"}'), null);
    assert.equal(parseWindow('{"days":[],"from":"09:00","to":"10:00"}'), null);
    assert.equal(parseWindow('nope'), null);
    assert.deepEqual(parseWindow('{"days":[0],"from":"00:00","to":"24:00"}'), { days: [0], fromMin: 0, toMin: 1440 });
  });
  it('지터: 창 시작 + [0, 2×지터] 안의 결정적 값, 창 끝 1분 전을 넘지 않는다', () => {
    const w = { days: [0, 1, 2, 3, 4, 5, 6], fromMin: 540, toMin: 1080 };
    const seen = new Set<number>();
    for (let i = 0; i < 200; i++) {
      const m = fireMinute(w, `k${i}`, '2026-11-23', 30);
      assert.ok(m >= 540 && m <= 600, String(m));
      seen.add(m);
      assert.equal(fireMinute(w, `k${i}`, '2026-11-23', 30), m); // 같은 키·날이면 같은 값
    }
    assert.ok(seen.size > 20, '키마다 퍼진다');
    assert.equal(fireMinute(w, 'k', '2026-11-23', 0), 540);
    assert.equal(fireMinute({ ...w, fromMin: 540, toMin: 545 }, 'k1', '2026-11-23', 30) <= 544, true);
  });
  it('창 밖이면 미루고 창이 열리면 낸다(지터 시각 전에는 내지 않는다)', async () => {
    const jitterSnap = () => snapshot({ policy: policy(undefined, 30) });
    const r = rig({ at: '2026-11-23T07:00:00', snap: jitterSnap });
    r.clock.add(11 * MIN);
    let t = await r.s.tick();
    assert.deepEqual(t.deferred, [{ id: 'doc.expiring:d1:2026-11-30:7', reason: 'window' }]);
    const fire = fireMinute(DEFAULT_WINDOW, 'doc.expiring:d1:2026-11-30:7', '2026-11-23', 30);
    r.clock.set(`2026-11-23T${String(Math.floor((fire - 1) / 60)).padStart(2, '0')}:${String((fire - 1) % 60).padStart(2, '0')}:00`);
    t = await r.s.tick();
    assert.equal(t.delivered.length, 0);
    r.clock.add(MIN);
    t = await r.s.tick();
    assert.equal(t.delivered.length, 1);
  });
});

describe('기동 유예와 억제', () => {
  it('기동 뒤 startupGraceMin(10분) 동안은 내지 않는다', async () => {
    const r = rig({ at: '2026-11-23T10:00:00' });
    assert.equal((await r.s.tick()).status, 'startup_grace');
    r.clock.add(9 * MIN + 59_000);
    assert.equal((await r.s.tick()).status, 'startup_grace');
    r.clock.add(1000);
    const t = await r.s.tick();
    assert.equal(t.status, 'ok');
    assert.equal(t.delivered.length, 1);
  });
  it('같은 알림은 한 번만: 같은 날 다시 틱해도, 다음 날에도 같은 단계는 다시 내지 않는다', async () => {
    const r = rig({ at: '2026-11-23T10:00:00' });
    r.clock.add(10 * MIN);
    await r.s.tick();
    r.clock.add(MIN);
    await r.s.tick();
    r.clock.set('2026-11-24T10:00:00');
    await r.s.tick();
    assert.deepEqual(r.out.map((n) => n.id), ['doc.expiring:d1:2026-11-30:7']);
    r.clock.set('2026-11-29T10:00:00');
    await r.s.tick();
    assert.deepEqual(r.out.map((n) => n.id), ['doc.expiring:d1:2026-11-30:7', 'doc.expiring:d1:2026-11-30:1']);
  });
  it('같은 주제(같은 서류)는 하루 1회: 만료일을 고쳐 id가 바뀌어도 그날은 미룬다', async () => {
    let exp = '2026-11-30';
    const r = rig({ at: '2026-11-23T10:00:00', snap: () => snapshot({ profiles: [profile({ documents: [doc('d1', 'national_tax_cert', exp)] })] }) });
    r.clock.add(10 * MIN);
    await r.s.tick();
    exp = '2026-11-29';
    r.s.requestReload();
    r.clock.add(MIN);
    const t = await r.s.tick();
    assert.deepEqual(t.deferred, [{ id: 'doc.expiring:d1:2026-11-29:7', reason: 'subject_today' }]);
    r.clock.set('2026-11-24T10:00:00');
    assert.equal((await r.s.tick()).delivered[0]?.id, 'doc.expiring:d1:2026-11-29:7');
  });
  it('하루 상한: 넘친 알림은 버리지 않고 다음 날 낸다', async () => {
    const docs = Array.from({ length: 7 }, (_, i) => doc(`d${i}`, `type${i}`, '2026-11-30'));
    const r = rig({ at: '2026-11-23T10:00:00', snap: () => snapshot({ profiles: [profile({ documents: docs })] }) });
    r.clock.add(10 * MIN);
    const t = await r.s.tick();
    assert.equal(t.delivered.length, DAEMON_MAX_NOTIFICATIONS_PER_DAY);
    assert.equal(t.deferred.filter((d) => d.reason === 'daily_cap').length, 2);
    r.clock.set('2026-11-24T10:00:00');
    assert.equal((await r.s.tick()).delivered.length, 2);
  });
  it('억제 기록은 저장소로 이어진다(재기동 뒤에도 다시 울리지 않는다)', async () => {
    const store = new MemoryStateStore();
    const a = rig({ at: '2026-11-23T10:00:00', store });
    a.clock.add(10 * MIN);
    await a.s.tick();
    const b = rig({ at: '2026-11-23T12:00:00', store });
    b.clock.add(10 * MIN);
    const t = await b.s.tick();
    assert.equal(t.delivered.length, 0);
    assert.equal(b.out.length, 0);
  });
});

describe('실패 처리', () => {
  it('출력 실패: retryAfterMin(30분) 뒤 1회 재시도, 두 번 실패하면 그날은 그만, 다음 날 다시', async () => {
    let fail = true;
    const r = rig({
      at: '2026-11-23T10:00:00',
      deliver: () => {
        if (fail) throw new Error('os');
      },
    });
    r.clock.add(10 * MIN);
    let t = await r.s.tick();
    assert.deepEqual(t.failed, [{ id: 'doc.expiring:d1:2026-11-30:7', attempts: 1 }]);
    r.clock.add(29 * MIN);
    t = await r.s.tick();
    assert.deepEqual(t.deferred, [{ id: 'doc.expiring:d1:2026-11-30:7', reason: 'retry_wait' }]);
    r.clock.add(MIN);
    t = await r.s.tick();
    assert.deepEqual(t.failed, [{ id: 'doc.expiring:d1:2026-11-30:7', attempts: 2 }]);
    r.clock.add(60 * MIN);
    t = await r.s.tick();
    assert.equal(t.deferred[0]?.reason, 'retry_wait');
    fail = false;
    r.clock.set('2026-11-24T10:00:00');
    t = await r.s.tick();
    assert.equal(t.delivered.length, 1);
  });
  it('스냅숏 실패: 마지막 스냅숏을 쓰고 30분 → 60분 백오프, 두 번 연속 실패면 daemon.snapshot_failed', async () => {
    let fail = false;
    const r = rig({
      at: '2026-11-23T10:00:00',
      snap: () => {
        if (fail) throw new Error('ipc');
        return snapshot();
      },
    });
    await r.s.tick();
    assert.equal(r.loads(), 1);
    fail = true;
    r.clock.add(DAEMON_SNAPSHOT_REFRESH_MIN * MIN);
    let t = await r.s.tick();
    assert.equal(r.loads(), 2);
    assert.equal(t.status, 'ok'); // 마지막 스냅숏으로 계속
    assert.equal(t.cause, null);
    r.clock.add(29 * MIN);
    await r.s.tick();
    assert.equal(r.loads(), 2);
    r.clock.add(MIN);
    t = await r.s.tick();
    assert.equal(r.loads(), 3);
    assert.equal(t.cause, 'daemon.snapshot_failed');
    r.clock.add(59 * MIN);
    await r.s.tick();
    assert.equal(r.loads(), 3);
    r.clock.add(MIN);
    fail = false;
    t = await r.s.tick();
    assert.equal(r.loads(), 4);
    assert.equal(t.cause, null);
  });
  it('스냅숏을 한 번도 못 읽으면 no_snapshot', async () => {
    const r = rig({
      at: '2026-11-23T10:00:00',
      snap: () => {
        throw new Error('x');
      },
    });
    assert.equal((await r.s.tick()).status, 'no_snapshot');
  });
  it('틱이 겹치면 두 번째는 busy(출력이 느려도 중복으로 내지 않는다)', async () => {
    let release!: () => void;
    const clock = new FakeClock('2026-11-23T10:20:00');
    const out: string[] = [];
    const s = new DaemonScheduler({
      clock,
      source: { snapshot: async () => snapshot() },
      sink: { deliver: (n) => new Promise<void>((res) => ((release = res), out.push(n.id))) },
    });
    clock.add(10 * MIN);
    const first = s.tick();
    const second = await s.tick();
    assert.equal(second.status, 'busy');
    await new Promise((r) => setImmediate(r));
    release();
    await first;
    assert.equal(out.length, 1);
  });
});

describe('시계 가드와 재조회 간격', () => {
  it('허용 폭(5분) 넘게 뒤로 가면 아무것도 내지 않는다. 시계가 따라오면 다시 돈다', async () => {
    const r = rig({ at: '2026-11-23T10:00:00' });
    r.clock.add(10 * MIN);
    await r.s.tick();
    r.clock.set('2026-11-22T10:20:00'); // 하루 뒤로
    assert.equal((await r.s.tick()).status, 'clock_rollback');
    assert.equal(r.out.length, 1);
    r.clock.set('2026-11-23T10:10:00');
    r.clock.add(-CLOCK_ROLLBACK_TOLERANCE_MS + 1000); // 허용 폭 안
    assert.notEqual((await r.s.tick()).status, 'clock_rollback');
  });
  it('시계 역행으로 하루 1회 억제를 되감을 수 없다(저장된 lastSeenAt 기준)', async () => {
    const store = new MemoryStateStore();
    const a = rig({ at: '2026-11-29T10:00:00', store });
    a.clock.add(10 * MIN);
    await a.s.tick();
    const b = rig({ at: '2026-11-23T10:00:00', store });
    b.clock.add(10 * MIN);
    assert.equal((await b.s.tick()).status, 'clock_rollback');
    assert.equal(b.out.length, 0);
  });
  it(`스냅숏은 ${POLICY_POLL_MIN}분(ADR-023 POLICY_POLL_MIN)마다 다시 읽고, 절전 복귀(틱 사이 3분 넘음)·requestReload면 바로`, async () => {
    assert.equal(DAEMON_SNAPSHOT_REFRESH_MIN, POLICY_POLL_MIN);
    const r = rig({ at: '2026-11-23T10:00:00' });
    await r.s.tick();
    for (let i = 0; i < POLICY_POLL_MIN - 1; i++) {
      r.clock.add(DAEMON_TICK_MS);
      await r.s.tick();
    }
    assert.equal(r.loads(), 1);
    r.clock.add(DAEMON_TICK_MS);
    await r.s.tick();
    assert.equal(r.loads(), 2);
    r.clock.add(4 * MIN); // 절전 복귀
    await r.s.tick();
    assert.equal(r.loads(), 3);
    r.clock.add(DAEMON_TICK_MS);
    r.s.requestReload();
    await r.s.tick();
    assert.equal(r.loads(), 4);
  });
  it('start()는 1분 틱을 걸고 멈출 수 있다(주입 타이머)', () => {
    const calls: Array<[string, number?]> = [];
    const r = rig({ at: '2026-11-23T10:00:00' });
    const stop = r.s.start({ setInterval: (_f, ms) => (calls.push(['set', ms]), 7), clearInterval: (h) => void calls.push(['clear', h as number]) });
    stop();
    assert.deepEqual(calls, [['set', DAEMON_TICK_MS], ['clear', 7]]);
  });
});

describe('데몬 상태 판정(D12 §4, Phase 1 notify만)', () => {
  const now = Date.parse('2026-11-23T01:00:00Z');
  it('정책·status 신선하면 사유는 phase1_notify_only 하나, run은 항상 false', () => {
    const g = daemonGate(snapshot(), now);
    assert.deepEqual(g, { notify: true, run: false, policy: 'fresh', status: 'fresh', reasons: ['daemon.phase1_notify_only'] });
  });
  it('정책 만료(stale)·status 72시간 초과(daemon_stop)면 사유를 더하지만 알림은 계속한다(포털 접속이 없다)', async () => {
    const g = daemonGate(snapshot({ policy: policy('2026-11-20T00:00:00Z'), status: { issuedAt: '2026-11-19T00:00:00Z', expiresAt: '2026-11-21T00:00:00Z' } }), now);
    assert.equal(g.policy, 'stale');
    assert.equal(g.status, 'daemon_stop');
    assert.deepEqual(g.reasons, ['daemon.phase1_notify_only', 'daemon.policy_stale', 'daemon.status_stale']);
    const r = rig({ at: '2026-11-23T10:00:00', snap: () => snapshot({ policy: null, status: null }) });
    r.clock.add(10 * MIN);
    const t = await r.s.tick();
    assert.equal(t.gate?.policy, 'none');
    assert.equal(t.delivered.length, 1);
  });
});
