// 서류 데몬 배선(daemon-host.ts, D10 §3 notify, M4-8): 엔진 daemon.snapshot → 스케줄러 → OS 알림. Electron 없이(알림·시계·타이머 주입).
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import type { DaemonSnapshot, ProfileSnapshot } from '@sax/daemon';
import { FileDaemonStateStore, startDaemonHost } from '../apps/desktop/src/daemon-host.ts';

const kst = (s: string) => Date.parse(`${s}+09:00`);
const MIN = 60_000;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sax-daemon-host-'));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));
const file = () => path.join(tmp, `${randomBytes(4).toString('hex')}/daemon-state.json`);

const doc = (id: string, docType: string, expiresAt: string) => ({ id, docType, displayName: '가나다컴퍼니 납세증명', issuedAt: '2026-11-01', expiresAt, meta: null });
const profile = (o: Partial<ProfileSnapshot> = {}): ProfileSnapshot => ({
  profileId: 'p1',
  documents: [doc('d1', 'national_tax_cert', '2026-11-30')],
  validityRules: [],
  schedules: [],
  settings: { reminderDay: 5, halfYearWithholding: false },
  bundleSentPeriods: ['2026-10'],
  missing: null,
  cardFetchedOn: '2026-11-02',
  ...o,
});
const snapshot = (): DaemonSnapshot => ({
  policy: { expiresAt: '2026-12-31T00:00:00Z', daemon: { windowJitterMin: 0, gapBetweenRunsMin: [5, 15], startupGraceMin: 10, retryAfterMin: 30, autoAllowed: false } },
  status: { issuedAt: '2026-11-23T00:00:00Z', expiresAt: '2026-11-25T00:00:00Z' },
  profiles: [profile()],
});

function rig(o: { rpc?: (m: string) => Promise<unknown>; show?: (t: { title: string; body: string }, onClick: () => void) => void; stateFile?: string } = {}) {
  let t = kst('2026-11-23T10:00:00');
  const shown: Array<{ title: string; body: string; click: () => void }> = [];
  const logs: Array<[string, unknown]> = [];
  const calls: string[] = [];
  const opened: string[] = [];
  const delivered: string[] = [];
  const ticks: Array<() => void> = [];
  const host = startDaemonHost({
    rpc: async (m) => {
      calls.push(m);
      return o.rpc ? o.rpc(m) : snapshot();
    },
    show: o.show ?? ((text, click) => void shown.push({ ...text, click })),
    onDelivered: (n) => delivered.push(n.kind),
    onOpen: (n) => opened.push(n.kind),
    stateFile: o.stateFile ?? file(),
    log: (n, d) => void logs.push([n, d]),
    clock: { now: () => t },
    timers: { setInterval: (f) => (ticks.push(f), ticks.length), clearInterval: () => void ticks.splice(0) },
  });
  return { host, shown, logs, calls, opened, delivered, ticks, add: (ms: number) => (t += ms) };
}

describe('서류 데몬 배선', () => {
  it('엔진 daemon.snapshot → 기동 유예 뒤 OS 알림(고정 문구·숫자·서류 종류 이름만) → 판 다시 그리기, 누르면 창을 앞으로', async () => {
    const r = rig();
    assert.equal((await r.host.tick()).status, 'startup_grace');
    r.add(10 * MIN);
    const t = await r.host.tick();
    assert.equal(t.status, 'ok');
    assert.deepEqual(r.calls.filter((m) => m !== 'daemon.snapshot'), [], '엔진에는 읽기 전용 질의 하나만');
    assert.deepEqual(r.shown.map((s) => [s.title, s.body]), [['서류 만료가 다가와요', '납세증명서(국세) · 7일 뒤 만료돼요']]);
    assert.ok(!JSON.stringify(r.shown).includes('가나다컴퍼니'), '문서 표시 이름(상호 등)은 알림에 넣지 않는다');
    assert.deepEqual(r.delivered, ['doc.expiring']);
    r.shown[0]!.click();
    assert.deepEqual(r.opened, ['doc.expiring']);
    assert.deepEqual(r.logs, [['main.daemon_notified', { kind: 'doc.expiring' }]], '로그에는 종류만(문서 id·profileId 없음)');
    assert.equal(r.ticks.length, 1, '1분 틱이 걸려 있다');
    r.host.stop();
    assert.equal(r.ticks.length, 0);
  });

  it('엔진이 아직 daemon.snapshot을 모르면(M2-5 전) 아무것도 내지 않고, 연달아 실패하면 원인 코드를 한 번만 남긴다', async () => {
    const r = rig({ rpc: async () => Promise.reject(new Error('unknown_method')) });
    for (let i = 0; i < 6; i++) {
      r.add(300 * MIN);
      assert.equal((await r.host.tick()).status, 'no_snapshot');
    }
    assert.equal(r.shown.length, 0);
    assert.deepEqual(r.logs, [['daemon.snapshot_failed', undefined]]);
  });

  it('응답 모양이 틀리면 스냅숏 실패로 본다', async () => {
    const r = rig({ rpc: async () => ({ profiles: 'nope' }) });
    r.add(20 * MIN);
    assert.equal((await r.host.tick()).status, 'no_snapshot');
  });

  it('억제 기록은 파일에 남아 다시 켜도 같은 알림을 두 번 내지 않는다(값 없음: id·날짜·시각만)', async () => {
    const stateFile = file();
    const a = rig({ stateFile });
    a.add(10 * MIN);
    await a.host.tick();
    a.host.stop();
    const saved = fs.readFileSync(stateFile, 'utf8');
    assert.ok(!saved.includes('가나다') && !saved.includes('national_tax_cert 납세'), saved);
    const b = rig({ stateFile });
    b.add(11 * MIN);
    await b.host.tick();
    assert.equal(b.shown.length, 0, '같은 날 같은 알림은 다시 내지 않는다');
  });

  it('알림을 띄우지 못하면(지원 안 함) 스케줄러가 실패로 세고 다시 시도한다', async () => {
    let n = 0;
    const r = rig({
      show: () => {
        n++;
        throw new Error('notify_unsupported');
      },
    });
    r.add(10 * MIN);
    const t = await r.host.tick();
    assert.equal(t.failed.length, 1);
    r.add(31 * MIN);
    await r.host.tick();
    assert.equal(n, 2);
  });

  it('깨진 억제 기록 파일은 빈 상태로 시작한다', () => {
    const f = file();
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, '{"v":1,"delivered":3}');
    assert.equal(new FileDaemonStateStore(f).load(), null);
    fs.writeFileSync(f, 'not json');
    assert.equal(new FileDaemonStateStore(f).load(), null);
  });

  it('셸: 제품만 데몬을 켜고(fixture는 끔), 절전 복귀에 다시 읽고, 닫을 때 멈춘다', () => {
    const src = fs.readFileSync(path.resolve(import.meta.dirname, '../apps/desktop/src/shell-app.ts'), 'utf8');
    assert.match(src, /if \(!fixture && opts\.daemon !== false\) \{\s*daemon = startDaemonHost\(/);
    assert.match(src, /powerMonitor\.on\('resume', onResume\)/);
    assert.match(src, /daemon\?\.stop\(\);\s*powerMonitor\.removeListener\('resume', onResume\);/);
    assert.match(src, /new Notification\(\{ title: t\.title, body: t\.body \}\)/);
  });
});
