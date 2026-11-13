// 앱 업데이트 배선(update-host.ts·update-electron.ts, D14 M4-9, ADR-028, D11 §4): packages/updater README "배선 순서" 1~5단계.
// Electron 없이: 원천·설치기(electron-updater 모양 가짜)·시계·타이머를 주입한다. 키는 updater-verify.test.ts와 같은 시드 규칙(release-1 = 0x61).
import assert from 'node:assert/strict';
import { createHash, createPrivateKey, createPublicKey, randomBytes, sign } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { jcs, type FeedInfo, type ReleaseManifest, type Revocation, type Transparency, type TrustRoot, type VerifiedRelease } from '../packages/updater/src/index.ts';
import { electronInstaller, feedUrl, type AppUpdaterLike } from '../apps/desktop/src/update-electron.ts';
import { pickInstaller, startUpdateHost, updatePolicy, UpdaterStateFile, type UpdateHostOptions, type UpdateInstaller } from '../apps/desktop/src/update-host.ts';

const PKCS8_ED25519 = Buffer.from('302e020100300506032b657004220420', 'hex');
const seedKey = (byte: number) => createPrivateKey({ key: Buffer.concat([PKCS8_ED25519, Buffer.alloc(32, byte)]), format: 'der', type: 'pkcs8' });
const pubB64 = (byte: number) => (createPublicKey(seedKey(byte)).export({ format: 'der', type: 'spki' }) as Buffer).subarray(12).toString('base64');
const TRUST: TrustRoot = { keyEpoch: 1, keys: { release: { 'release-1': pubB64(0x61) } } };
const FRESH: Revocation = { keyIds: new Set(), fresh: true };
const NOW = Date.parse('2026-11-06T06:00:00Z');
const DAY = 24 * 3600_000;
const sha512 = (b: Uint8Array) => createHash('sha512').update(b).digest('base64');
const INSTALLER = Buffer.from('MZ fake installer bytes for shell-updater test');

function manifest(version = '1.2.0', over: Partial<ReleaseManifest> = {}, signer = 0x61): ReleaseManifest {
  const u = {
    channel: 'stable' as const,
    version,
    releaseDate: '2026-11-05T00:00:00.000Z',
    expiresAt: '2026-11-12T00:00:00.000Z',
    rolloutPercent: 100,
    files: [{ url: `SovereignAX-Setup-${version}.exe`, sha512: sha512(INSTALLER), size: INSTALLER.byteLength }],
    ...over,
  };
  return { ...u, signature: { keyId: 'release-1', alg: 'ed25519', sig: sign(null, Buffer.from(jcs(u), 'utf8'), seedKey(signer)).toString('base64url') } } as ReleaseManifest;
}
const feedOf = (m: ReleaseManifest): FeedInfo => ({ version: m.version, files: m.files.map((f) => ({ url: f.url, sha512: f.sha512, size: f.size })), path: m.files[0]!.url, sha512: m.files[0]!.sha512 });

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sax-updater-host-'));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));
const dir = () => {
  const d = path.join(tmp, randomBytes(4).toString('hex'));
  fs.mkdirSync(d, { recursive: true });
  return d;
};

interface Rig {
  opts: UpdateHostOptions;
  calls: string[];
  logs: Array<[string, Record<string, unknown> | undefined]>;
  stale: number;
  set(o: Partial<{ doc: unknown; feed: FeedInfo | null; bytes: Buffer; transparency: Transparency; revocation: Revocation; latestFails: boolean; registryFails: boolean; idle: { runActive: boolean; commitZone: boolean; daemonRunning: boolean } }>): void;
  now: { t: number };
}

function rig(over: Partial<UpdateHostOptions> = {}, stateDir = dir()): Rig {
  const m = manifest();
  const st = { doc: m as unknown, feed: feedOf(m) as FeedInfo | null, bytes: INSTALLER, transparency: 'verified' as Transparency, revocation: FRESH, latestFails: false, registryFails: false, idle: { runActive: false, commitZone: false, daemonRunning: false } };
  const calls: string[] = [];
  const logs: Rig['logs'] = [];
  const now = { t: NOW };
  const r: Rig = {
    calls,
    logs,
    stale: 0,
    now,
    set: (o) => Object.assign(st, o),
    opts: undefined as unknown as UpdateHostOptions,
  };
  const installer: UpdateInstaller = {
    async check() {
      calls.push('check');
      return st.feed;
    },
    async download() {
      calls.push('download');
      const d = path.join(stateDir, 'pending');
      fs.mkdirSync(d, { recursive: true });
      const f = path.join(d, (st.doc as ReleaseManifest).files?.[0]?.url ?? 'x.exe');
      fs.writeFileSync(f, st.bytes);
      return [f, `${f}.blockmap`];
    },
    async discard(f) {
      calls.push(`discard:${path.basename(f)}`);
      fs.rmSync(f, { force: true });
    },
    install() {
      calls.push('install');
    },
  };
  r.opts = {
    sources: {
      latest: async (ch) => {
        calls.push(`latest:${ch}`);
        if (st.latestFails) throw new Error('net');
        return Buffer.from(JSON.stringify(st.doc));
      },
      registry: async () => {
        if (st.registryFails) throw new Error('engine');
        return { trust: TRUST, revocation: st.revocation };
      },
      transparency: async () => {
        calls.push('transparency');
        return st.transparency;
      },
    },
    installer,
    channel: 'stable',
    installedVersion: '1.1.0',
    stateFile: path.join(stateDir, 'updater-state.json'),
    policy: { requireTransparency: true },
    idle: () => st.idle,
    onStale: () => r.stale++,
    log: (n, d) => logs.push([n, d]),
    now: () => now.t,
    timers: { setInterval: () => 0, clearInterval: () => {} },
    ...over,
  };
  return r;
}
const readState = (r: Rig) => JSON.parse(fs.readFileSync(r.opts.stateFile, 'utf8'));

describe('update-host: 배선 순서 1~5', () => {
  it('검증 통과 → 피드 대조 → 받기 → sha512 재확인 → 관문 → 설치(한 번)', async () => {
    const r = rig();
    const h = startUpdateHost(r.opts);
    const out = await h.check();
    assert.deepEqual(out, { result: 'downloaded', installed: true });
    assert.deepEqual(r.calls, ['latest:stable', 'transparency', 'check', 'download', 'install']);
    const s = readState(r);
    assert.equal(s.channels.stable.highestSeen.version, '1.2.0');
    assert.equal(s.channels.stable.lastSuccessAt, NOW);
    // 설치를 시작한 뒤에는 다시 확인·설치하지 않는다
    assert.deepEqual(await h.check(), { result: 'busy' });
    assert.equal(h.tryInstall(), false);
    assert.equal(r.calls.filter((c) => c === 'install').length, 1);
  });

  it('투명성 미확인(기본 정책) → 보류, 설치기에 닿지 않고 마지막 성공 시각을 올리지 않는다', async () => {
    const r = rig();
    r.set({ transparency: 'unverified' });
    const out = await startUpdateHost(r.opts).check();
    assert.deepEqual(out, { result: 'hold', code: 'update.transparency_unverified', security: false });
    assert.deepEqual(r.calls, ['latest:stable', 'transparency']);
    const s = readState(r);
    assert.equal(s.channels.stable.lastSuccessAt, null);
    assert.equal(s.channels.stable.highestSeen.version, '1.2.0');
  });

  it('투명성 헤드 불일치 → registry.head_mismatch 보류', async () => {
    const r = rig();
    r.set({ transparency: 'head_mismatch' });
    const out = await startUpdateHost(r.opts).check();
    assert.equal(out.result, 'hold');
    assert.equal((out as { code: string }).code, 'registry.head_mismatch');
    assert.ok(!r.calls.includes('check'));
  });

  it('투명성은 검증을 통과한 더 높은 버전에만 묻는다(위조·최신이면 묻지 않음)', async () => {
    const forged = rig();
    forged.set({ doc: manifest('1.2.0', {}, 0x62) });
    const o1 = await startUpdateHost(forged.opts).check();
    assert.equal((o1 as { code: string }).code, 'registry.signature_insufficient');
    assert.ok(!forged.calls.includes('transparency'));
    const same = rig({ installedVersion: '1.2.0' });
    assert.deepEqual(await startUpdateHost(same.opts).check(), { result: 'none', reason: 'up_to_date' });
    assert.ok(!same.calls.includes('transparency'));
  });

  it('시험 빌드 정책(requireTransparency false)은 투명성 없이 받는다', async () => {
    const r = rig({ policy: { requireTransparency: false } });
    r.set({ transparency: 'unverified' });
    const out = await startUpdateHost(r.opts).check();
    assert.deepEqual(out, { result: 'downloaded', installed: true });
    assert.ok(!r.calls.includes('transparency'));
  });

  it('원천 실패(latest.json·엔진 폐기 목록) → source_failed, 상태 그대로, 설치기 없음', async () => {
    for (const k of ['latestFails', 'registryFails'] as const) {
      const r = rig();
      const before = new UpdaterStateFile(r.opts.stateFile).load();
      r.set({ [k]: true });
      assert.deepEqual(await startUpdateHost(r.opts).check(), { result: 'source_failed' });
      assert.deepEqual(readState(r), before);
      assert.ok(!r.calls.includes('check'));
    }
  });

  it('폐기 목록이 낡았다 → registry.revocation_stale 보류', async () => {
    const r = rig();
    r.set({ revocation: { keyIds: new Set(), fresh: false } });
    const out = await startUpdateHost(r.opts).check();
    assert.equal((out as { code: string }).code, 'registry.revocation_stale');
    assert.ok(!r.calls.includes('check'));
  });

  it('electron-updater가 읽은 latest.yml이 다르면 받지 않는다(update.feed_mismatch, 보안 이벤트)', async () => {
    const r = rig();
    const m = manifest();
    r.set({ feed: { ...feedOf(m), sha512: sha512(Buffer.from('other')), files: [{ url: m.files[0]!.url, sha512: sha512(Buffer.from('other')), size: 5 }] } });
    assert.deepEqual(await startUpdateHost(r.opts).check(), { result: 'feed_mismatch' });
    assert.ok(!r.calls.includes('download'));
    assert.deepEqual(r.logs.find(([n]) => n === 'main.update_held')?.[1], { code: 'update.feed_mismatch', security: true });
    // 새 버전이 없다고 하면(null) 같은 판정
    const r2 = rig();
    r2.set({ feed: null });
    assert.deepEqual(await startUpdateHost(r2.opts).check(), { result: 'feed_mismatch' });
  });

  it('받은 설치본 sha512가 다르면 받은 파일을 모두 지우고 설치하지 않는다. 다음 확인은 처음부터', async () => {
    const r = rig();
    r.set({ bytes: Buffer.alloc(INSTALLER.byteLength, 0x41) });
    const h = startUpdateHost(r.opts);
    assert.deepEqual(await h.check(), { result: 'bad_download', code: 'update.digest_mismatch' });
    assert.ok(!r.calls.includes('install'));
    assert.deepEqual(r.calls.filter((c) => c.startsWith('discard:')), ['discard:SovereignAX-Setup-1.2.0.exe', 'discard:SovereignAX-Setup-1.2.0.exe.blockmap']);
    assert.ok(!fs.existsSync(path.join(path.dirname(r.opts.stateFile), 'pending', 'SovereignAX-Setup-1.2.0.exe')));
    assert.equal(h.tryInstall(), false);
    r.set({ bytes: INSTALLER });
    assert.deepEqual(await h.check(), { result: 'downloaded', installed: true });
  });

  it('잘린 설치본은 size_mismatch(보안 이벤트 아님)', async () => {
    const r = rig();
    r.set({ bytes: INSTALLER.subarray(0, 10) });
    assert.deepEqual(await startUpdateHost(r.opts).check(), { result: 'bad_download', code: 'update.size_mismatch' });
    assert.deepEqual(r.logs.find(([n]) => n === 'main.update_held')?.[1], { code: 'update.size_mismatch', security: false });
  });

  it('실행 중·커밋 구간·데몬 실행 중에는 설치를 미루고, 유휴가 되면 한 번 설치한다', async () => {
    for (const busy of [{ runActive: true }, { commitZone: true }, { daemonRunning: true }]) {
      const r = rig();
      r.set({ idle: { runActive: false, commitZone: false, daemonRunning: false, ...busy } });
      const h = startUpdateHost(r.opts);
      assert.deepEqual(await h.check(), { result: 'downloaded', installed: false });
      assert.ok(r.logs.some(([n]) => n === 'main.update_install_deferred'));
      // 미룬 동안의 주기 확인은 다시 받지 않는다
      assert.deepEqual(await h.check(), { result: 'downloaded', installed: false });
      assert.equal(r.calls.filter((c) => c === 'download').length, 1);
      r.set({ idle: { runActive: false, commitZone: false, daemonRunning: false } });
      assert.equal(h.tryInstall(), true);
      assert.equal(h.tryInstall(), false);
      assert.equal(r.calls.filter((c) => c === 'install').length, 1);
    }
  });

  it('본 최고 버전은 재기동 뒤에도 남아 되감기를 막는다(registry.version_rollback)', async () => {
    const d = dir();
    const r1 = rig({ installedVersion: '1.3.0' }, d);
    r1.set({ doc: manifest('1.3.0') });
    assert.deepEqual(await startUpdateHost(r1.opts).check(), { result: 'none', reason: 'up_to_date' });
    const r2 = rig({ installedVersion: '1.1.0' }, d);
    r2.set({ doc: manifest('1.2.0') });
    const out = await startUpdateHost(r2.opts).check();
    assert.deepEqual(out, { result: 'hold', code: 'registry.version_rollback', security: true });
    assert.equal(readState(r2).channels.stable.highestSeen.version, '1.3.0');
  });

  it('확인이 겹치면 두 번째는 busy', async () => {
    const r = rig();
    const h = startUpdateHost(r.opts);
    const [a, b] = await Promise.all([h.check(), h.check()]);
    assert.deepEqual(b, { result: 'busy' });
    assert.equal(a.result, 'downloaded');
    assert.equal(r.calls.filter((c) => c.startsWith('latest:')).length, 1);
  });

  it('14일 동안 확인 성공이 없으면 알림, 하루 한 번까지', async () => {
    const r = rig();
    r.set({ latestFails: true });
    const h = startUpdateHost(r.opts);
    await h.check();
    assert.equal(r.stale, 0);
    r.now.t = NOW + 15 * DAY;
    await h.check();
    await h.check();
    assert.equal(r.stale, 1);
    r.now.t = NOW + 16 * DAY + 1;
    await h.check();
    assert.equal(r.stale, 2);
    // 확인에 성공하면(최신) 다시 조용하다
    r.now.t += 2 * DAY;
    const fresh = manifest('1.2.0', { releaseDate: new Date(r.now.t - DAY).toISOString(), expiresAt: new Date(r.now.t + DAY).toISOString() });
    const r2 = rig({ installedVersion: '1.2.0', now: () => r.now.t, stateFile: r.opts.stateFile });
    r2.set({ doc: fresh });
    assert.deepEqual(await startUpdateHost(r2.opts).check(), { result: 'none', reason: 'up_to_date' });
    assert.equal(r2.stale, 0);
  });

  it('로그에는 결과·코드만(버전·경로·설치 id 없음)', async () => {
    const r = rig();
    r.set({ bytes: Buffer.alloc(3) });
    await startUpdateHost(r.opts).check();
    const s = JSON.stringify(r.logs);
    const st = readState(r);
    for (const bad of ['1.2.0', 'SovereignAX-Setup', tmp, st.installId]) assert.ok(!s.includes(bad), bad);
  });

  it('주기 타이머: 15분 확인 + 1분 설치 재시도, stop이 둘 다 끈다', () => {
    const set: number[] = [];
    const cleared: unknown[] = [];
    const r = rig({ timers: { setInterval: (_f, ms) => (set.push(ms), set.length), clearInterval: (h) => void cleared.push(h) } });
    startUpdateHost(r.opts).stop();
    assert.deepEqual(set, [15 * 60_000, 60_000]);
    assert.deepEqual(cleared, [1, 2]);
  });

  it('pickInstaller: 설치본 이름이 같은 파일, 없으면 첫 파일', () => {
    const f = { url: 'a.exe', sha512: '', size: 1 };
    assert.equal(pickInstaller(['/x/a.exe.blockmap', '/x/a.exe'], f), '/x/a.exe');
    assert.equal(pickInstaller(['/x/b.exe'], f), '/x/b.exe');
    assert.equal(pickInstaller([], f), null);
  });
});

describe('update-host: 정책·상태 파일', () => {
  it('제품 빌드는 투명성 끄기 설정을 무시하고 경고를 남긴다. 시험 빌드만 끌 수 있다', () => {
    const logs: string[] = [];
    const log = (n: string) => void logs.push(n);
    assert.deepEqual(updatePolicy({ testBuild: false, setting: { requireTransparency: false }, log }), { requireTransparency: true });
    assert.deepEqual(logs, ['main.update_policy_ignored']);
    assert.deepEqual(updatePolicy({ testBuild: true, setting: { requireTransparency: false }, log }), { requireTransparency: false });
    assert.deepEqual(updatePolicy({ testBuild: true }), { requireTransparency: true });
    assert.deepEqual(updatePolicy({ testBuild: true, setting: { requireTransparency: 'false' } }), { requireTransparency: true });
    assert.deepEqual(updatePolicy({ testBuild: false, setting: null }), { requireTransparency: true });
  });

  it('상태 파일: 없으면 만든다, 설치 id·처음 시각이 기동마다 같다, 깨졌으면 새로 시작하고 로그', () => {
    const f = path.join(dir(), 'updater-state.json');
    const a = new UpdaterStateFile(f, () => 1000).load();
    const b = new UpdaterStateFile(f, () => 2000).load();
    assert.equal(a.installId, b.installId);
    assert.equal(b.installedAt, 1000);
    assert.match(a.installId, /^[0-9a-f-]{36}$/);
    for (const bad of ['{', JSON.stringify({ ...a, channels: { stable: { highestSeen: { version: '1.0', filesDigest: 'x' }, lastSuccessAt: null } } }), JSON.stringify({ ...a, channels: { nightly: { highestSeen: null, lastSuccessAt: null } } }), JSON.stringify({ ...a, v: 2 })]) {
      fs.writeFileSync(f, bad);
      const logs: string[] = [];
      const c = new UpdaterStateFile(f, () => 3000).load((n) => void logs.push(n));
      assert.equal(logs[0], 'main.update_state_reset');
      assert.notEqual(c.installId, a.installId);
      assert.deepEqual(c.channels, {});
    }
  });
});

describe('update-electron: electron-updater 어댑터', () => {
  const fake = () => {
    const calls: unknown[] = [];
    const u: AppUpdaterLike = {
      autoDownload: true,
      autoInstallOnAppQuit: true,
      allowDowngrade: true,
      allowPrerelease: true,
      disableDifferentialDownload: false,
      setFeedURL: (o) => void calls.push(['feed', o]),
      checkForUpdates: async () => ({ updateInfo: { version: '1.2.0', files: [] }, isUpdateAvailable: true }),
      downloadUpdate: async () => ['/p/a.exe'],
      quitAndInstall: (...a) => void calls.push(['quit', ...a]),
    };
    return { u, calls };
  };

  class Base {
    readonly runtime: unknown;
    constructor(runtime: unknown) {
      this.runtime = runtime;
    }
  }
  const verified = (m: ReleaseManifest): VerifiedRelease => ({ manifest: m, releaseKeyId: 'release-1', rootKeyIds: [] });
  type Feed = { getLatestVersion(): Promise<FeedInfo>; resolveFiles(i: FeedInfo): Array<{ url: URL; info: unknown }> };
  const feedOfCall = (calls: unknown[]) => {
    const o = (calls[0] as [string, { updateProvider: new (cfg: unknown, u: unknown, r: unknown) => Feed }])[1];
    return new o.updateProvider(o, null, {});
  };

  it('자동 받기·종료 시 설치·다운그레이드·사전 릴리스·차등 받기를 끄고, 검증한 매니페스트만 공급자로 넘긴다', async () => {
    const { u, calls } = fake();
    const ins = electronInstaller(u, { origin: 'https://registry.example.test', channel: 'beta', Provider: Base });
    assert.deepEqual([u.autoDownload, u.autoInstallOnAppQuit, u.allowDowngrade, u.allowPrerelease, u.disableDifferentialDownload], [false, false, false, false, true]);
    const cfg = (calls[0] as [string, Record<string, unknown>])[1];
    assert.equal(cfg.provider, 'custom');
    assert.equal(cfg.url, 'https://registry.example.test/releases/beta/');
    const feed = feedOfCall(calls);
    await assert.rejects(feed.getLatestVersion(), /update.no_verified_release/);
    const m = manifest('1.2.0');
    assert.deepEqual(await ins.check(verified(m)), { version: '1.2.0', files: [] });
    assert.deepEqual(await feed.getLatestVersion(), { ...feedOf(m), releaseDate: m.releaseDate });
    assert.deepEqual(
      feed.resolveFiles(await feed.getLatestVersion()).map((f) => f.url.href),
      [`https://registry.example.test/releases/beta/${m.files[0]!.url}`],
    );
    assert.deepEqual(await ins.download(), ['/p/a.exe']);
    ins.install();
    assert.deepEqual(calls[1], ['quit', true, true]);
  });

  it('새 버전이 없다는 응답은 null', async () => {
    const { u } = fake();
    u.checkForUpdates = async () => ({ updateInfo: { version: '1.1.0', files: [] }, isUpdateAvailable: false });
    assert.equal(await electronInstaller(u, { origin: 'https://r.example.test', channel: 'stable', Provider: Base }).check(verified(manifest())), null);
    u.checkForUpdates = async () => null;
    assert.equal(await electronInstaller(u, { origin: 'https://r.example.test', channel: 'stable', Provider: Base }).check(verified(manifest())), null);
  });

  it('피드 origin은 https·경로 없음만, 시험 빌드 loopback만 http://127.0.0.1', () => {
    assert.equal(feedUrl('https://r.example.test', 'stable'), 'https://r.example.test/releases/stable/');
    for (const bad of ['http://r.example.test', 'http://127.0.0.1:8082', 'https://r.example.test/x', 'https://r.example.test/?a=1', 'https://u:p@r.example.test', 'file:///etc']) {
      assert.throws(() => feedUrl(bad, 'stable'), /update.feed_origin_invalid/, bad);
    }
    assert.equal(feedUrl('http://127.0.0.1:8082', 'stable', { loopback: true }), 'http://127.0.0.1:8082/releases/stable/');
    for (const bad of ['http://localhost:8082', 'http://10.0.0.1:8082', 'http://127.0.0.1:8082/x']) {
      assert.throws(() => feedUrl(bad, 'stable', { loopback: true }), /update.feed_origin_invalid/, bad);
    }
  });

  it('discard는 파일이 없어도 던지지 않는다', async () => {
    const { u } = fake();
    const ins = electronInstaller(u, { origin: 'https://r.example.test', channel: 'stable', Provider: Base });
    const f = path.join(dir(), 'gone.exe');
    fs.writeFileSync(f, 'x');
    await ins.discard(f);
    assert.ok(!fs.existsSync(f));
    await ins.discard(f);
  });
});

describe('셸 배선(소스 검사)', () => {
  const src = (f: string) => fs.readFileSync(path.join(import.meta.dirname, '../apps/desktop/src', f), 'utf8');
  it('설치본·엔진 모드·원천이 있을 때만 켠다, electron-updater는 그때만 동적으로 불러온다', () => {
    const s = src('shell-app.ts');
    assert.match(s, /if \(!fixture && app\.isPackaged && opts\.update\) updater = await startAppUpdater\(opts\.update\);/);
    assert.match(s, /await import\('electron-updater'\)/);
    assert.doesNotMatch(s, /from 'electron-updater'/);
    assert.match(s, /updatePolicy\(\{ testBuild: w\.testBuild, setting: w\.setting/);
    assert.match(s, /commitZone: bar\.visible \|\| list\.some\(\(r\) => r\.status === 'issuing' \|\| r\.inDoubt === true\)/);
    assert.match(s, /updater\?\.stop\(\);/);
    assert.match(s, /void updater\?\.check\(\);/);
  });
  it('update-host는 Electron·electron-updater·네트워크를 직접 쓰지 않는다', () => {
    for (const f of ['update-host.ts', 'update-electron.ts']) {
      const s = src(f);
      assert.doesNotMatch(s, /from 'electron'|from 'electron-updater'|from 'node:(net|http|https|tls)'|fetch\(/, f);
    }
  });
  it('제품 진입점은 업데이트를 넘기고, 로컬 피드는 실계정 시험 빌드만 읽는다', () => {
    const s = src('shell.ts');
    assert.match(s, /update: updateWiring\(\)/);
    assert.match(s, /const feed = testBuild \? process\.env\.SAX_UPDATE_FEED : undefined;/);
    assert.match(s, /if \(!feed\) return \{ channel, origin: REGISTRY_ORIGIN, egress: new Egress\(\{ env: process\.env \}\), testBuild \};/);
  });
});
