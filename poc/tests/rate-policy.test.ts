// PoC-10(Mac 선행분): 요청률 정책(D03 §7) 단위 시험. 브라우저 없이 카운터·상한·쿨다운·시계 역행·차단 신호 사전을 본다.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { EventEmitter } from 'node:events';
import { FIXTURE_POLICY, HOMETAX_POLICY, kstDay, matchSignal, policyFor, RateGuard, SIGNAL_DICT, SignalWatch, type Clock, type RatePolicy } from '@sax/engine';
import type { Page } from 'playwright-core';
import { openDatabase, RateRepo, type Db } from '@sax/db';

const T = Date.parse('2026-11-02T14:59:50Z'); // KST 23:59:50
const H = 3_600_000;

/** 벽시계와 단조 시계를 함께 움직이는 시험 시계. back()은 벽시계만 되돌린다. */
function testClock(start = T) {
  let wall = start;
  let mono = 0;
  const clock: Clock = { wall: () => wall, mono: () => mono };
  return {
    clock,
    tick(ms: number) {
      wall += ms;
      mono += ms;
    },
    back(ms: number) {
      wall -= ms;
    },
    /** 앱 재시작: 단조 시계가 0부터 다시 간다. */
    restart() {
      mono = 0;
    },
    get wall() {
      return wall;
    },
  };
}

describe('요청률 정책(D03 §7)', () => {
  let dir: string;
  const dbs: Db[] = [];
  before(async () => {
    dir = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'sax-rate-'));
  });
  after(async () => {
    for (const d of dbs) d.close();
    await fs.rm(dir, { recursive: true, force: true });
  });
  const freshDb = () => {
    const db = openDatabase(path.join(dir, `${dbs.length}.sqlite`), new Uint8Array(randomBytes(32)));
    dbs.push(db);
    return db;
  };
  const guard = (policy: RatePolicy = HOMETAX_POLICY, start = T) => {
    const db = freshDb();
    const c = testClock(start);
    return { db, c, g: new RateGuard(db, 'hometax', policy, c.clock), repo: new RateRepo(db) };
  };

  it('내장 정책 값은 §7 예시(interactive·limits.hometax·run·cooldown) 그대로, 가짜 페이지는 지연·분당 네비게이션만 다르다', () => {
    assert.deepEqual(HOMETAX_POLICY, {
      pace: { stepDelayMs: [800, 2500], afterNavSettleMs: [600, 1500], slowFactor: 1.5 },
      limits: { runsPerDayPerProfile: 40, irreversiblePerDayPerProfile: 30, runsPerLoginSession: 15, navigationsPerMin: 12, loginsPerDay: 6, concurrent: 1 },
      run: { maxActuationsPerRun: 150, maxWallClockMs: 1_800_000 },
      cooldown: { onBlockSignalHours: 24, positiveDetectionsForCooldown: 2 },
    });
    assert.ok(Object.isFrozen(HOMETAX_POLICY.limits) && Object.isFrozen(HOMETAX_POLICY.pace.stepDelayMs));
    assert.deepEqual({ ...FIXTURE_POLICY, pace: HOMETAX_POLICY.pace, limits: { ...FIXTURE_POLICY.limits, navigationsPerMin: 12 } }, HOMETAX_POLICY);
    // PoC 빌드는 위험 수용서 상한으로 좁힌다(ADR-025). D03 §7 값은 HOMETAX_POLICY에 그대로 남는다.
    assert.deepEqual(policyFor('hometax'), { ...HOMETAX_POLICY, limits: { ...HOMETAX_POLICY.limits, runsPerDayPerProfile: 20, irreversiblePerDayPerProfile: 1, loginsPerDay: 3 }, cooldown: { ...HOMETAX_POLICY.cooldown, positiveDetectionsForCooldown: 1 } });
    for (const kind of ['gov24', 'wetax', 'Hometax', '']) assert.throws(() => policyFor(kind), /policy\.portal_mode_denied/, `${kind}: 내장 정책이 없는 포털은 자동화하지 않는다`);
  });

  it('하루 실행 상한은 KST 날짜 기준: 23:59에 20회(PoC 상한) 차면 거부, 00:00(KST)이면 다시 된다. 증가는 커밋된 뒤 남는다', () => {
    const { g, c, repo } = guard(policyFor('hometax'));
    assert.equal(kstDay(T), '2026-11-02');
    for (let i = 0; i < 20; i++) g.admit('p1', { irreversible: false });
    assert.throws(() => g.admit('p1', { irreversible: false }), /policy\.runs_per_day/);
    assert.equal(repo.count('hometax', 'p1', 'runs_day', '2026-11-02'), 20, '거부된 시도는 세지 않는다');
    g.admit('p2', { irreversible: false }); // 프로필별
    c.tick(10_000); // KST 00:00
    assert.equal(kstDay(c.wall), '2026-11-03');
    g.admit('p1', { irreversible: false });
    assert.equal(repo.count('hometax', 'p1', 'runs_day', '2026-11-03'), 1);
  });

  it('하루 비가역 상한: 시작 때 여유를 보고, armed 때 증가한다(PoC 상한 1회 뒤 거부)', () => {
    const { g, repo } = guard(policyFor('hometax'));
    g.countCommit('p1');
    assert.throws(() => g.countCommit('p1'), /policy\.irreversible_per_day/);
    assert.throws(() => g.admit('p1', { irreversible: true }), /policy\.irreversible_per_day/);
    g.admit('p1', { irreversible: false }); // 조회성 실행은 비가역 여유를 보지 않는다
    assert.equal(repo.count('hometax', 'p1', 'irreversible_day', '2026-11-02'), 1);
    assert.equal(repo.sum('hometax', '', 'navigations_min', '2026-11-02T00:00:00', '2026-11-02T23:59:59'), 1, '발급 버튼 클릭은 네비게이션으로도 센다');
  });

  it('분당 네비게이션은 최근 60초 합: 12회 차면 기다리고, 가장 오래된 것이 60초를 벗어나면 다시 된다', () => {
    const { g, c } = guard();
    for (let i = 0; i < 6; i++) g.countNavigation();
    c.tick(30_000);
    for (let i = 0; i < 6; i++) g.countNavigation();
    assert.equal(g.navigationWaitMs(), 1_000);
    c.tick(29_000); // 처음 6회에서 59초
    assert.equal(g.navigationWaitMs(), 1_000, '분 경계가 아니라 60초 창');
    c.tick(1_000);
    assert.equal(g.navigationWaitMs(), 0);
  });

  it('차단 신호 연속 2회면 24시간 쿨다운(시작·로그인 거부), 깨끗한 실행이 끼면 연속이 끊긴다', () => {
    const { g, c } = guard();
    assert.equal(g.positive('fixture.block.url'), false);
    g.clean();
    assert.equal(g.positive('http.429'), false, '사이에 깨끗한 실행이 있었다');
    assert.equal(g.status('p1').blockStreak, 1);
    assert.equal(g.positive('http.429'), true);
    assert.throws(() => g.admit('p1', { irreversible: false }), /policy\.cooldown/);
    assert.throws(() => g.beforeLogin(), /policy\.cooldown/);
    assert.equal(g.status('p1').cooldownUntil, new Date(c.wall + 24 * H).toISOString());
    c.tick(24 * H - 1_000);
    assert.throws(() => g.admit('p1', { irreversible: false }), /policy\.cooldown/);
    c.tick(1_000);
    g.admit('p1', { irreversible: false });
    assert.equal(g.status('p1').cooldownUntil, null);
    assert.equal(g.positive('http.429'), true, '쿨다운 뒤에도 깨끗한 실행 전까지는 연속이 이어진다(보수 쪽)');
  });

  it('추가 인증 연속 횟수는 깨끗한 실행에서 0이 된다', () => {
    const { g } = guard();
    assert.equal(g.extraAuth(), 1);
    assert.equal(g.extraAuth(), 2);
    g.clean();
    assert.equal(g.extraAuth(), 1);
  });

  it('시계 역행: 유효 시각은 뒤로 가지 않아 날짜 버킷·쿨다운이 풀리지 않고, 보수 모드(지연 1.5배, 상한 절반)가 재시작 뒤에도 이어진다', () => {
    const { db, g, c, repo } = guard(HOMETAX_POLICY, T + 20_000); // KST 11-03 00:00:10
    for (let i = 0; i < 20; i++) g.admit('p1', { irreversible: false });
    assert.equal(g.clock().conservative, false);
    c.back(H); // 11-02 23:00:10(KST)로 되돌림
    const k = g.clock();
    assert.equal(k.conservative, true);
    assert.ok(k.now >= T + 20_000, '유효 시각은 마지막으로 본 시각보다 앞이다');
    assert.throws(() => g.admit('p1', { irreversible: false }), /policy\.runs_per_day/, '상한 40의 절반(20)이고 버킷은 11-03 그대로');
    assert.equal(repo.count('hometax', 'p1', 'runs_day', '2026-11-02'), 0, '전날 버킷이 새로 열리지 않았다');
    assert.equal(g.delay([1_000, 1_000], true), 1_500);
    assert.equal(g.cap(HOMETAX_POLICY.limits.navigationsPerMin, true), 6);
    // 재시작(단조 시계 0부터, 벽시계는 여전히 뒤)
    c.restart();
    const g2 = new RateGuard(db, 'hometax', HOMETAX_POLICY, c.clock);
    assert.equal(g2.clock().conservative, true);
    assert.equal(g2.status('p1').conservative, true);
    // 역행 중 유효 시각은 절반 속도로 간다: 역행한 만큼(1시간) 지나도 아직 보수 모드, 두 배가 지나면 벽시계가 따라잡는다
    c.tick(H + 5_000);
    assert.equal(g2.clock().conservative, true);
    c.tick(H);
    const caught = g2.clock();
    assert.equal(caught.conservative, false);
    assert.equal(caught.now, c.wall, '따라잡은 뒤에는 벽시계 그대로');
  });

  it('로그인 상한(PoC-3 로그인이 부른다): 하루 6회, 세션당 실행 15회, 새 로그인이 세션을 다시 연다', () => {
    const { g } = guard();
    for (let i = 0; i < 6; i++) {
      g.beforeLogin();
      g.loginSucceeded('p1');
    }
    assert.throws(() => g.beforeLogin(), /policy\.logins_per_day/);
    for (let i = 1; i < 15; i++) g.continueSession('p1'); // 로그인한 실행이 1회째
    assert.throws(() => g.continueSession('p1'), /policy\.runs_per_session/);
    g.loginSucceeded('p1');
    g.continueSession('p1');
  });

  it('캡차 횟수는 10분 버킷에 남고 오늘 합으로 본다', () => {
    const { g, c } = guard(HOMETAX_POLICY, T + 20_000);
    g.captcha();
    c.tick(15 * 60_000);
    g.captcha();
    g.captcha();
    assert.equal(g.status('p1').captchaToday, 3);
  });

  it('새로고침이 이어지는 화면에서도 idle()은 끝난다(그 뒤 시작된 확인은 기다리지 않는다)', async () => {
    const page = Object.assign(new EventEmitter(), {
      context: () => new EventEmitter(),
      isClosed: () => false,
      frames: () => [{ url: () => 'http://127.0.0.1:9/notice', evaluate: () => new Promise((r) => setTimeout(() => r({ text: '', status: 200 }), 50)) }],
    });
    const watch = new SignalWatch(page as unknown as Page, { dict: SIGNAL_DICT.fixture, portalHost: () => true, onHit: () => {}, onDialog: () => {}, mono: () => performance.now() });
    const reload = setInterval(() => page.emit('domcontentloaded'), 20); // 확인(50ms)보다 잦은 새로고침
    try {
      await new Promise((r) => setTimeout(r, 60));
      const done = await Promise.race([watch.idle().then(() => 'idle'), new Promise((r) => setTimeout(() => r('hang'), 1_000))]);
      assert.equal(done, 'idle');
    } finally {
      clearInterval(reload);
      watch.detach();
    }
  });

  it('차단 신호 사전: NFKC·제로폭·공백을 무시하고, 한 화면에 여럿이면 차단이 먼저다', () => {
    const fx = SIGNAL_DICT.fixture;
    assert.deepEqual(matchSignal(fx, { text: '안내\n비정상적인  접근이\u200b감지되어 이용이\t제한되었습니다.' }), { kind: 'block', id: 'fixture.block.text' });
    assert.deepEqual(matchSignal(fx, { url: 'http://127.0.0.1:9/notice/blocked?x=1' }), { kind: 'block', id: 'fixture.block.url' });
    assert.equal(matchSignal(fx, { url: 'http://127.0.0.1:9/notice/blockedness' }), null);
    assert.deepEqual(matchSignal(fx, { url: 'http://127.0.0.1:9/auth/captcha', text: '비정상적인 접근이 감지되어 이용이 제한되었습니다' }), { kind: 'block', id: 'fixture.block.text' });
    assert.equal(matchSignal(fx, { text: '전자세금계산서 건별발급' }), null);
    // 홈택스: 근거 있는 것은 NetFunnel 대기열 문구뿐이다(차단 아님). 차단·추가 인증·캡차는 PoC-3에서 채운다.
    const ht = SIGNAL_DICT.hometax;
    assert.deepEqual(matchSignal(ht, { text: '서비스 접속대기 중입니다. 예상대기시간 : 3초' }), { kind: 'busy', id: 'hometax.netfunnel.wait' });
    assert.deepEqual(matchSignal(ht, { text: '접속대기 중입니다.' }), { kind: 'busy', id: 'hometax.netfunnel.wait' }, '모바일 스킨 문구');
    assert.deepEqual([...new Set(ht.map((e) => e.kind))], ['busy']);
    for (const e of [...ht, ...fx]) assert.ok(e.source.length > 0 && (e.url || e.text), e.id);
  });
});
