import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import {
  HumanSecretVault, itemName, keychainBackend, MemoryItemStore, MemoryWrapper, MockHello, SessionLock, UnavailableHello, WindowsNativeWrapper,
  open, seal, slotName, type KeychainBackend,
} from '@sax/vault';
import { fakeRelay } from './fake-relay.ts';
import { startHarness, type Harness } from './harness.ts';

class Log {
  readonly lines: string[] = [];
  event(name: string, fields?: Record<string, unknown>): void {
    this.lines.push(JSON.stringify({ e: name, ...fields }));
  }
  has(name: string): boolean {
    return this.lines.some((l) => l.includes(`"${name}"`));
  }
}

function clock(start = 1_000_000) {
  let t = start;
  return { now: () => t, tick: (ms: number) => (t += ms) };
}

const enc = (s: string) => new TextEncoder().encode(s);
const dec = (b: Uint8Array) => new TextDecoder().decode(b);

const pwEntry = (value = 'TEST-PW-value001') => [{ field: 'pw' as const, bytes: enc(value) }];
const readText = (r: Awaited<ReturnType<HumanSecretVault['readOne']>>) => (r.ok ? dec(r.bytes) : null);

async function plantRetiredCard(items: MemoryItemStore, scope: 'business' | 'personal' = 'business', rows = 30) {
  const raw = await items.get('index/human');
  const idx = raw ? (JSON.parse(dec(raw)) as unknown[]) : [];
  const cells = Array.from({ length: rows }, (_, i) => `securitycard/${scope}/${i + 1}`);
  idx.push({ v: 1, kind: 'security_card', scope, cells, tier: 'memory', hello: true, suspect: false });
  await items.set('index/human', enc(JSON.stringify(idx)));
  for (const n of [...cells, `kek/securitycard/${scope}/device`, `kek/securitycard/${scope}/hello`, `consent/securitycard/${scope}`]) await items.set(n, enc('OLD-CARD-BLOB'));
}

function setup(opts: { hello?: boolean; wrapper?: MemoryWrapper } = {}) {
  const c = clock();
  const log = new Log();
  const items = new MemoryItemStore();
  const hello = opts.hello ? new MockHello() : new UnavailableHello();
  const backend: KeychainBackend = { items, wrapper: opts.wrapper ?? new MemoryWrapper(), hello };
  const v = new HumanSecretVault({ backend, log, now: c.now });
  v.lock.reportIdle(0);
  return { v, c, log, items, hello, backend };
}

describe('세션 잠금(SessionLock): Windows 세션 추종', () => {
  it('유휴 보고 전·보고가 끊기면 잠김(idle_unknown, fail-closed)', () => {
    const c = clock();
    const l = new SessionLock({ now: c.now });
    assert.deepEqual(l.check(), { open: false, reason: 'idle_unknown', helloCanOpen: false });
    l.reportIdle(10);
    assert.equal(l.check().open, true);
    c.tick(121_000);
    assert.equal((l.check() as { reason: string }).reason, 'idle_unknown');
  });

  it('잠금·절전·사용자 전환·원격 전환이면 즉시 잠그고 onLock, unlock-screen이면 프롬프트 없이 다시 연다', () => {
    for (const kind of ['lock-screen', 'suspend', 'session-switch', 'remote-switch'] as const) {
      const c = clock();
      const l = new SessionLock({ now: c.now });
      const locks: string[] = [];
      l.onLock = (r) => locks.push(r);
      l.reportIdle(0);
      assert.equal(l.check().open, true);
      assert.deepEqual(l.sessionEvent(kind), { open: false, reason: 'session_locked', helloCanOpen: false });
      assert.deepEqual(locks, ['session_locked']);
      assert.equal(l.sessionEvent('resume').open, false, 'resume만으로는 열지 않는다');
      assert.equal(l.helloConfirmed().open, false, '세션이 잠기면 Hello로도 열지 않는다');
      assert.equal(l.sessionEvent('unlock-screen').open, true);
    }
  });

  it('유휴 900초면 잠기고, 활동이 돌아와도 Hello 또는 Windows 잠금·해제로만 다시 연다', () => {
    const c = clock();
    const l = new SessionLock({ now: c.now });
    l.reportIdle(899);
    assert.equal(l.check().open, true);
    c.tick(2_000);
    assert.equal((l.check() as { reason: string }).reason, 'idle');
    l.reportIdle(0);
    assert.deepEqual(l.check(), { open: false, reason: 'idle', helloCanOpen: true });
    assert.equal(l.helloConfirmed().open, true);
    l.reportIdle(950);
    l.reportIdle(1);
    assert.equal(l.check().open, false);
    l.sessionEvent('lock-screen');
    assert.equal(l.sessionEvent('unlock-screen').open, true);
  });

  it('유휴 보고가 끊긴 사이 상한을 넘겼으면 새 보고가 0이어도 프롬프트 없이 열지 않는다', () => {
    const c = clock();
    const l = new SessionLock({ now: c.now });
    l.reportIdle(0);
    c.tick(901_000);
    assert.deepEqual(l.reportIdle(0), { open: false, reason: 'idle', helloCanOpen: true });
  });

  it('유휴 보고가 120초 넘게 끊겼다 다시 오면(900초 미만이어도) 프롬프트 없이 열지 않는다', () => {
    const c = clock();
    const l = new SessionLock({ now: c.now });
    l.reportIdle(0);
    c.tick(119_000);
    assert.equal(l.reportIdle(0).open, true, '120초 안 공백은 이어진다');
    c.tick(121_000);
    assert.deepEqual(l.reportIdle(0), { open: false, reason: 'idle_unknown', helloCanOpen: true });
    assert.equal(l.helloConfirmed().open, true, 'Hello로 다시 연다');
    c.tick(200_000);
    l.reportIdle(0);
    assert.equal(l.sessionEvent('unlock-screen').open, true, 'Windows 잠금 해제로도 다시 연다');
  });

  it('열린 지 28800초면 잠긴다(max_open)', () => {
    const c = clock();
    const l = new SessionLock({ now: c.now });
    for (let i = 0; i < 960; i++) {
      l.reportIdle(0);
      c.tick(30_000);
    }
    l.reportIdle(0);
    assert.deepEqual(l.check(), { open: false, reason: 'max_open', helloCanOpen: true });
  });

  it('엄격 모드: Hello 확인 뒤 300초만 열리고 실행이 끝나면 즉시 잠근다', () => {
    const c = clock();
    const l = new SessionLock({ now: c.now });
    l.reportIdle(0);
    l.setStrict(true);
    assert.deepEqual(l.check(), { open: false, reason: 'strict', helloCanOpen: true });
    assert.equal(l.helloConfirmed().open, true);
    for (let i = 0; i < 9; i++) {
      c.tick(30_000);
      l.reportIdle(0);
    }
    c.tick(29_000);
    l.reportIdle(0);
    assert.equal(l.check().open, true, '299초');
    c.tick(2_000);
    l.reportIdle(0);
    assert.equal(l.check().open, false);
    l.helloConfirmed();
    l.runEnded();
    assert.equal(l.check().open, false);
  });
});

describe('사람 비밀 저장소(HumanSecretVault)', () => {
  it('칸 단위 항목 이름, 칸마다 AES-GCM(AAD=항목 이름), 평문은 저장소 어디에도 없다', async () => {
    const { v, items } = setup();
    const consent = await v.store('portal_password', 'business', pwEntry('TEST-PW-plain001'), { version: 't06-v1' });
    await v.store('cert_password', 'business', pwEntry('TEST-PW-cert0001'), { version: 't06-v1' });
    assert.equal(consent.items, 1);
    assert.equal(consent.tier, 'memory');
    assert.equal(consent.via, 'T-06');
    assert.ok(items.items.has('portal/business/pw') && items.items.has('cert/business/pw'));
    assert.ok(items.items.has('kek/portal/business/device'));
    assert.ok(!items.items.has('kek/portal/business/hello'), 'Hello 없는 PC는 사본이 없다');
    const all = Buffer.concat([...items.items.values()].map((b) => Buffer.from(b)));
    for (const s of ['TEST-PW-plain001', 'TEST-PW-cert0001']) assert.equal(all.includes(Buffer.from(s)), false, '평문이 저장소에 없다');
    assert.doesNotMatch(JSON.stringify(await v.consent('portal_password', 'business')), /TEST-PW/);
    items.items.set('cert/business/pw', items.items.get('portal/business/pw')!);
    assert.deepEqual(await v.readOne('cert_password', 'business', { field: 'pw' }), { ok: false, reason: 'corrupt' });
    assert.equal(readText(await v.readOne('portal_password', 'business', { field: 'pw' })), 'TEST-PW-plain001');
  });

  it('저장 후 넘긴 바이트는 0으로 덮인다, 잘못된 칸·중복·크기는 거부', async () => {
    const { v } = setup();
    const entries = pwEntry();
    await v.store('portal_password', 'business', entries, { version: 'v1' });
    for (const e of entries) assert.ok(e.bytes.every((b) => b === 0));
    const bad = [
      () => v.store('portal_password', 'business', [{ field: 'pw', bytes: enc('1') }, { field: 'pw', bytes: enc('2') }], { version: 'v1' }),
      () => v.store('portal_password', 'business', [{ field: 'pw', bytes: new Uint8Array(257) }], { version: 'v1' }),
      () => v.store('portal_password', 'business', [], { version: 'v1' }),
      () => v.store('security_card' as never, 'business', pwEntry(), { version: 'v1' }),
      () => v.store('portal_password', 'business', [{ row: 1, bytes: enc('1') } as never], { version: 'v1' }),
      () => v.store('portal_password', 'business', [{ field: 'id' as never, bytes: enc('me') }], { version: 'v1' }),
      () => v.store('portal_password', 'business', [{ field: 'id' as never, bytes: enc('me') }, { field: 'pw', bytes: enc('x') }], { version: 'v1' }),
      () => v.store('cert_password', 'business', [{ row: 1, bytes: enc('x') } as never], { version: 'v1' }),
      () => v.store('portal_password', '../x', [{ field: 'pw', bytes: enc('x') }], { version: 'v1' }),
    ];
    for (const f of bad) await assert.rejects(f());
    assert.equal(itemName('portal_password', 'business', { field: 'pw' }), 'portal/business/pw');
    assert.equal(slotName('portal_password', 'personal'), 'portal/personal');
    assert.equal(slotName('cert_password', 'business'), 'cert/business');
  });

  it('다른 기기(다른 래핑 키)에서는 같은 저장소 사본을 열 수 없다', async () => {
    const a = setup();
    await a.v.store('portal_password', 'business', [{ field: 'pw', bytes: enc('TEST-PW-123456') }], { version: 'v1' });
    const copy = new MemoryItemStore();
    for (const [k, val] of a.items.items) copy.items.set(k, val);
    const c = clock();
    const other = new HumanSecretVault({ backend: { items: copy, wrapper: MemoryWrapper.otherDevice(), hello: new UnavailableHello() }, log: new Log(), now: c.now });
    other.lock.reportIdle(0);
    assert.deepEqual(await other.readOne('portal_password', 'business', { field: 'pw' }), { ok: false, reason: 'kek_unavailable' });
  });

  it('잠기면 메모리의 슬롯 KEK를 지우고 꺼내지 않는다, Windows 잠금 해제 뒤 다시 꺼낸다', async () => {
    const { v, log } = setup();
    await v.store('portal_password', 'business', pwEntry(),{ version: 'v1' });
    assert.ok((await v.readOne('portal_password', 'business', { field: 'pw' })).ok);
    v.lock.sessionEvent('lock-screen');
    assert.ok(log.has('vault.locked'));
    assert.deepEqual(await v.readOne('portal_password', 'business', { field: 'pw' }), { ok: false, reason: 'vault_locked' });
    v.lock.sessionEvent('unlock-screen');
    assert.ok((await v.readOne('portal_password', 'business', { field: 'pw' })).ok);
  });

  it('유휴 잠금 뒤 Hello PC는 한 번의 프롬프트(작업명·포털명)로 다시 연다, 취소하면 닫힌 채', async () => {
    const { v, c, hello } = setup({ hello: true });
    await v.store('portal_password', 'business', pwEntry(),{ version: 'v1' });
    assert.ok((await v.consent('portal_password', 'business'))!.helloCopy);
    c.tick(901_000);
    v.lock.reportIdle(0);
    assert.deepEqual(await v.readOne('portal_password', 'business', { field: 'pw' }), { ok: false, reason: 'vault_locked' });
    (hello as MockHello).next = 'cancel';
    assert.deepEqual(await v.unlockWithHello({ task: '세금계산서 발급', portal: '홈택스' }), { ok: false, presence: false, reason: 'hello_cancelled' });
    (hello as MockHello).next = 'approve';
    assert.deepEqual(await v.unlockWithHello({ task: '세금계산서 발급', portal: '홈택스' }), { ok: true, presence: true });
    assert.deepEqual((hello as MockHello).prompts.at(-1), { task: '세금계산서 발급', portal: '홈택스' });
    assert.ok((await v.readOne('portal_password', 'business', { field: 'pw' })).ok);
  });

  it('Hello 없는 PC: 유휴 잠금 뒤 vault.unlock은 hello_unavailable, Windows 잠금·해제로만', async () => {
    const { v, c } = setup();
    await v.store('portal_password', 'business', pwEntry(),{ version: 'v1' });
    c.tick(901_000);
    v.lock.reportIdle(0);
    assert.equal((await v.unlockWithHello({ task: 't', portal: 'p' })).reason, 'hello_unavailable');
    v.lock.sessionEvent('lock-screen');
    v.lock.sessionEvent('unlock-screen');
    assert.ok((await v.readOne('portal_password', 'business', { field: 'pw' })).ok);
  });

  it('엄격 모드: 기기 사본(무프롬프트)을 지우고 발급마다 Hello, Hello 없는 슬롯이 있으면 켜지 않는다', async () => {
    const noHello = setup();
    await noHello.v.store('portal_password', 'business', pwEntry(),{ version: 'v1' });
    assert.deepEqual(await noHello.v.setStrict(true), { ok: false, reason: 'hello_unavailable' });

    const { v, items } = setup({ hello: true });
    await v.store('portal_password', 'business', pwEntry(),{ version: 'v1' });
    assert.deepEqual(await v.setStrict(true), { ok: true });
    assert.ok(!items.items.has('kek/portal/business/device'));
    assert.deepEqual(await v.readOne('portal_password', 'business', { field: 'pw' }), { ok: false, reason: 'vault_locked' });
    assert.equal((await v.unlockWithHello({ task: 't', portal: 'p' })).ok, true);
    assert.ok((await v.readOne('portal_password', 'business', { field: 'pw' })).ok);
    v.lock.runEnded();
    assert.deepEqual(await v.readOne('portal_password', 'business', { field: 'pw' }), { ok: false, reason: 'vault_locked' });
    assert.deepEqual(await v.setStrict(false), { ok: false, reason: 'unlock_required' });
    await v.unlockWithHello({ task: 't', portal: 'p' });
    assert.deepEqual(await v.setStrict(false), { ok: true });
    assert.ok(items.items.has('kek/portal/business/device'));
  });

  it('금고가 닫혀 있으면(잠금 사유 무관) 저장하지 않는다: idle_unknown·유휴·엄격 모드 Hello 전', async () => {
    const c = clock();
    const v = new HumanSecretVault({ backend: { items: new MemoryItemStore(), wrapper: new MemoryWrapper(), hello: new MockHello() }, log: new Log(), now: c.now });
    await assert.rejects(v.store('portal_password', 'business', pwEntry(),{ version: 'v1' }), /vault_locked/, '첫 유휴 보고 전');
    v.lock.reportIdle(0);
    c.tick(901_000);
    v.lock.reportIdle(0);
    await assert.rejects(v.store('portal_password', 'business', pwEntry(),{ version: 'v1' }), /vault_locked/, '유휴 잠금 뒤');
    v.lock.sessionEvent('unlock-screen');
    assert.deepEqual(await v.setStrict(true), { ok: true });
    const entries = pwEntry();
    await assert.rejects(v.store('portal_password', 'business', entries, { version: 'v1' }), /vault_locked/, '엄격 모드 Hello 전');
    assert.ok(entries[0]!.bytes.every((b) => b === 0), '거부해도 넘긴 바이트는 지운다');
    assert.equal(await v.has('portal_password', 'business'), false);
  });

  it('엄격 모드는 재시작 뒤에도 이어진다: 기기 사본이 없으니 Hello로만 연다', async () => {
    const s1 = setup({ hello: true });
    await s1.v.store('portal_password', 'business', pwEntry(),{ version: 'v1' });
    assert.deepEqual(await s1.v.setStrict(true), { ok: true });
    const c = clock();
    const v2 = new HumanSecretVault({ backend: s1.backend, log: new Log(), now: c.now });
    assert.deepEqual(v2.lock.reportIdle(0), { open: false, reason: 'startup', helloCanOpen: false });
    assert.equal(v2.lock.sessionEvent('unlock-screen').open, false);
    await v2.ready();
    assert.deepEqual(v2.lock.check(), { open: false, reason: 'strict', helloCanOpen: true });
    assert.equal(v2.lock.strict, true);
    assert.deepEqual(await v2.readOne('portal_password', 'business', { field: 'pw' }), { ok: false, reason: 'vault_locked' });
    assert.equal((await v2.unlockWithHello({ task: 't', portal: 'p' })).ok, true);
    assert.ok((await v2.readOne('portal_password', 'business', { field: 'pw' })).ok);
    assert.deepEqual(await v2.setStrict(false), { ok: true });
    const v3 = new HumanSecretVault({ backend: s1.backend, log: new Log(), now: c.now });
    await v3.ready();
    assert.equal(v3.lock.strict, false, '끈 것도 이어진다');
  });

  it('다시 등록 중 키체인 쓰기가 실패하면 옛 슬롯을 그대로 되돌린다', async () => {
    const s = setup();
    await s.v.store('portal_password', 'business', [{ field: 'pw', bytes: enc('TEST-PW-old0001') }], { version: 'v1' });
    const realSet = s.items.set.bind(s.items);
    let failOnce = true;
    s.items.set = async (name, value) => {
      if (name === 'portal/business/pw' && failOnce) {
        failOnce = false;
        throw new Error('keychain_write_failed');
      }
      return realSet(name, value);
    };
    await assert.rejects(s.v.store('portal_password', 'business', [{ field: 'pw', bytes: enc('TEST-PW-new0002') }], { version: 'v2' }), /keychain_write_failed/);
    s.items.set = realSet;
    const r = await s.v.readOne('portal_password', 'business', { field: 'pw' });
    assert.ok(r.ok);
    assert.equal(dec((r as { bytes: Uint8Array }).bytes), 'TEST-PW-old0001');
    assert.equal((await s.v.consent('portal_password', 'business'))!.noticeVersion, 'v1');
  });

  it('다시 등록 중 옛 슬롯 지우기(색인 저장)가 실패해도 옛 슬롯을 되돌린다', async () => {
    const s = setup();
    await s.v.store('cert_password', 'business', pwEntry('TEST-PW-oldcert1'), { version: 'v1' });
    const realSet = s.items.set.bind(s.items);
    let failOnce = true;
    s.items.set = async (name, value) => {
      if (name === 'index/human' && failOnce) {
        failOnce = false;
        throw new Error('keychain_write_failed');
      }
      return realSet(name, value);
    };
    await assert.rejects(s.v.store('cert_password', 'business', pwEntry('TEST-PW-newcert2'), { version: 'v2' }), /keychain_write_failed/);
    s.items.set = realSet;
    assert.equal(readText(await s.v.readOne('cert_password', 'business', { field: 'pw' })), 'TEST-PW-oldcert1');
    assert.equal((await s.v.consent('cert_password', 'business'))!.noticeVersion, 'v1');
  });

  it('색인 읽기가 한 번 실패해도(키체인 일시 오류) 실패를 캐시하지 않고 다음 연산에서 다시 읽는다', async () => {
    const items = new MemoryItemStore();
    const realGet = items.get.bind(items);
    let fails = 2;
    items.get = async (name) => {
      if (name === 'index/human' && fails > 0) {
        fails--;
        throw new Error('keychain_read_failed');
      }
      return realGet(name);
    };
    const c = clock();
    const s = { v: new HumanSecretVault({ backend: { items, wrapper: new MemoryWrapper(), hello: new UnavailableHello() }, log: new Log(), now: c.now }) };
    s.v.lock.reportIdle(0);
    await s.v.ready();
    await assert.rejects(s.v.store('portal_password', 'business', [{ field: 'pw', bytes: enc('TEST-PW-retry001') }], { version: 'v1' }), /keychain_read_failed/);
    await s.v.store('portal_password', 'business', [{ field: 'pw', bytes: enc('TEST-PW-retry002') }], { version: 'v1' });
    const r = await s.v.readOne('portal_password', 'business', { field: 'pw' });
    assert.ok(r.ok);
    assert.equal(dec((r as { bytes: Uint8Array }).bytes), 'TEST-PW-retry002');
  });

  it('첫 실행(설정·색인 항목 없음 → null)은 엄격 모드가 아니고 저장·읽기가 된다', async () => {
    const s = setup();
    await s.v.ready();
    assert.equal(s.v.lock.strict, false);
    await s.v.store('portal_password', 'business', [{ field: 'pw', bytes: enc('TEST-PW-first001') }], { version: 'v1' });
    assert.ok((await s.v.readOne('portal_password', 'business', { field: 'pw' })).ok);
  });

  it('색인에만 Hello 사본이 있고 항목이 없으면 프롬프트 없이 presence를 주지 않는다', async () => {
    const { v, c, hello, items } = setup({ hello: true });
    await v.store('portal_password', 'business', pwEntry(),{ version: 'v1' });
    c.tick(901_000);
    v.lock.reportIdle(0);
    await items.delete('kek/portal/business/hello');
    const before = (hello as MockHello).prompts.length;
    assert.deepEqual(await v.unlockWithHello({ task: 't', portal: 'p' }), { ok: false, presence: false, reason: 'no_stored_secret' });
    assert.equal((hello as MockHello).prompts.length, before);
    assert.deepEqual(await v.readOne('portal_password', 'business', { field: 'pw' }), { ok: false, reason: 'vault_locked' });
  });

  it('인증 실패 1회 뒤 suspect: 다시 등록하기 전에는 꺼내지 않는다', async () => {
    const { v, log } = setup();
    await v.store('portal_password', 'business', [{ field: 'pw', bytes: enc('TEST-PW-123456') }], { version: 'v1' });
    assert.equal(await v.markSuspect('portal_password', 'business'), true);
    assert.ok(log.has('vault.credential_suspect'));
    assert.deepEqual(await v.readOne('portal_password', 'business', { field: 'pw' }), { ok: false, reason: 'credential_suspect' });
    assert.equal((await v.list())[0]!.suspect, true);
    await v.store('portal_password', 'business', [{ field: 'pw', bytes: enc('TEST-PW-654321') }], { version: 'v1' });
    const r = await v.readOne('portal_password', 'business', { field: 'pw' });
    assert.ok(r.ok);
    assert.equal(dec((r as { bytes: Uint8Array }).bytes), 'TEST-PW-654321');
  });

  it('forget은 칸·KEK·동의 레코드를 모두 지우고 목록에서 빠진다', async () => {
    const { v, items } = setup({ hello: true });
    await v.store('cert_password', 'business', pwEntry('TEST-PW-cert0001'), { version: 'v1' });
    await v.store('portal_password', 'business', [{ field: 'pw', bytes: enc('TEST-PW-123456') }], { version: 'v1' });
    assert.equal((await v.list()).length, 2);
    assert.equal(await v.forget('cert_password', 'business'), true);
    assert.ok(![...items.items.keys()].some((k) => k.includes('cert/')));
    assert.deepEqual((await v.list()).map((s) => s.kind), ['portal_password']);
    assert.equal(await v.has('cert_password', 'business'), false);
  });

  it('옛 판이 남긴 보안카드 슬롯은 기동 때 한 번 지우고 칸 수만 남긴다(대표 결정 2026-11-19 지원 안 함)', async () => {
    const s = setup();
    await s.v.store('portal_password', 'business', pwEntry('TEST-PW-keep0001'), { version: 'v1' });
    await plantRetiredCard(s.items, 'business', 30);
    await plantRetiredCard(s.items, 'personal', 35);
    const log = new Log();
    const v2 = new HumanSecretVault({ backend: s.backend, log, now: clock().now });
    v2.lock.reportIdle(0);
    await v2.list();
    assert.deepEqual(log.lines.map((l) => JSON.parse(l) as Record<string, unknown>).filter((l) => l.e === 'vault.card_purged'), [{ e: 'vault.card_purged', items: 65 }]);
    assert.ok(![...s.items.items.keys()].some((k) => k.includes('securitycard')), '칸·KEK 사본·동의 레코드가 없다');
    assert.doesNotMatch(dec(s.items.items.get('index/human')!), /security_card/, '색인에서도 빠진다');
    assert.ok(!log.lines.some((l) => l.includes('OLD-CARD') || l.includes('securitycard/')), '로그에 값·칸 이름이 없다');
    assert.deepEqual((await v2.list()).map((x) => x.kind), ['portal_password']);
    assert.equal(readText(await v2.readOne('portal_password', 'business', { field: 'pw' })), 'TEST-PW-keep0001');
    const log3 = new Log();
    await new HumanSecretVault({ backend: s.backend, log: log3, now: clock().now }).list();
    assert.ok(!log3.has('vault.card_purged') && !log3.has('vault.card_purge_failed'));
  });

  it('보안카드 슬롯을 지우다 키체인이 실패하면 색인을 그대로 두고 다음 기동에 다시 지운다', async () => {
    const s = setup();
    await plantRetiredCard(s.items);
    const realDelete = s.items.delete.bind(s.items);
    s.items.delete = async (name) => {
      if (name === 'securitycard/business/7') throw new Error('keychain_delete_failed');
      return realDelete(name);
    };
    const log = new Log();
    const v2 = new HumanSecretVault({ backend: s.backend, log, now: clock().now });
    assert.deepEqual(await v2.list(), [], '지원하지 않는 종류는 목록에 없다');
    assert.ok(log.has('vault.card_purge_failed') && !log.has('vault.card_purged'));
    assert.match(dec(s.items.items.get('index/human')!), /security_card/, '색인은 그대로(다시 지울 단서)');
    s.items.delete = realDelete;
    const log3 = new Log();
    await new HumanSecretVault({ backend: s.backend, log: log3, now: clock().now }).list();
    assert.ok(log3.has('vault.card_purged'));
    assert.ok(![...s.items.items.keys()].some((k) => k.includes('securitycard')));
  });

  it('기기 결박 래핑이 안 되면(Windows 네이티브 헬퍼 없음) 저장하지 않고 반쯤 쓴 슬롯도 남기지 않는다', async () => {
    const items = new MemoryItemStore();
    const v = new HumanSecretVault({ backend: { items, wrapper: new WindowsNativeWrapper('tpm', null), hello: new UnavailableHello() }, log: new Log() });
    v.lock.reportIdle(0);
    await assert.rejects(v.store('portal_password', 'business', pwEntry(), { version: 'v1' }), /native_helper_missing/);
    assert.equal(items.items.size, 0);
    const be = keychainBackend('win32', null);
    assert.equal(be.wrapper.tier, 'dpapi');
  });

  it('봉투 형식: 판 바이트·변조 거부', () => {
    const k = new Uint8Array(32).fill(7);
    const b = seal(k, enc('x'), 'a');
    assert.equal(b[0], 1);
    assert.equal(dec(open(k, b, 'a')), 'x');
    assert.throws(() => open(k, b, 'b'), /item_corrupt/);
    const t = Uint8Array.from(b);
    t[t.length - 1]! ^= 1;
    assert.throws(() => open(k, t, 'a'), /item_corrupt/);
  });
});

describe('금고 포트 연결: 등록 창 저장·control 세션 추종·인증 실패', () => {
  let h: Harness;
  before(async () => {
    h = await startHarness();
    await h.control.rpc('session.idle', { idleSec: 0 });
  });
  after(async () => {
    await h.close();
  });

  const storeBind = { mode: 'store' as const, kind: 'cert_password' as const, scope: 'business' as const, notice: { version: 't06-v1' } };

  it('store 결속 포트로 한 번 저장하고, 결과·목록에 값이 없다', async () => {
    const port = h.secretPort(storeBind);
    const r = await port.rpc<{ handle: unknown; tier: string; consent: { items: number } }>('secret.store', { entries: pwEntry('TEST-PW-port0001') });
    assert.deepEqual(r.handle, { kind: 'cert_password', scope: 'business' });
    assert.equal(r.consent.items, 1);
    await assert.rejects(port.rpc('secret.store', { entries: pwEntry() }), /denied/, '한 포트에 한 번');
    const list = await h.control.rpc<Array<Record<string, unknown>>>('secret.list');
    assert.equal(list.length, 1);
    assert.doesNotMatch(JSON.stringify(list) + JSON.stringify(r), /TEST-PW/);
    assert.equal(await h.control.rpc('secret.has', { kind: 'cert_password', scope: 'business' }), true);
  });

  it('잘못된 칸 모양(칸 번호)은 거부하고 저장하지 않는다, 보안카드 결속은 붙이지 않는다', async () => {
    const port = h.secretPort({ ...storeBind, scope: 'personal' });
    await assert.rejects(port.rpc('secret.store', { entries: [{ row: 1, bytes: enc('1234') }] }), /bad_cell/);
    assert.equal(await h.control.rpc('secret.has', { kind: 'cert_password', scope: 'personal' }), false);
    await assert.rejects(h.control.rpc('secret.has', { kind: 'security_card', scope: 'business' }), /bad_params/);
  });

  it('포털 등록 창: 아이디는 저장하지 않고 secret.store 결과로 돌려준다(비밀 아님, ADR-035)', async () => {
    const itemKeys = () => [...(h.vault.human as unknown as { b: { items: MemoryItemStore } }).b.items.items.keys()];
    const portalBind = { mode: 'store' as const, kind: 'portal_password' as const, scope: 'business' as const, notice: { version: 't06-v1' } };
    const r = await h.secretPort(portalBind).rpc<{ portalLoginId?: string; consent: { items: number } }>('secret.store', {
      entries: [{ field: 'pw', bytes: enc('TEST-PW-login01') }], portalLoginId: ' user-login1 ',
    });
    assert.equal(r.portalLoginId, 'user-login1');
    assert.equal(r.consent.items, 1);
    assert.deepEqual(itemKeys().filter((k) => k.startsWith('portal/')), ['portal/business/pw']);
    const blobs = (h.vault.human as unknown as { b: { items: MemoryItemStore } }).b.items.items;
    for (const [, val] of blobs) assert.doesNotMatch(Buffer.from(val).toString('latin1'), /user-login1/);
    await assert.rejects(h.secretPort({ ...portalBind, scope: 'personal' }).rpc('secret.store', { entries: [{ field: 'id', bytes: enc('user-login1') }] }), /bad_cell/);
    for (const [bind, id] of [
      [portalBind, 'a b'], [portalBind, 'a\u0000'], [portalBind, 'x'.repeat(65)], [portalBind, 123], [portalBind, ''],
      [storeBind, 'user-login1'],
    ] as const) {
      await assert.rejects(h.secretPort({ ...bind, scope: 'personal' }).rpc('secret.store', { entries: pwEntry('TEST-PW-login02'), portalLoginId: id }), /bad_login_id/);
    }
    assert.equal(await h.control.rpc('secret.has', { kind: 'portal_password', scope: 'personal' }), false);
    assert.equal(await h.control.rpc('secret.has', { kind: 'cert_password', scope: 'personal' }), false);
    assert.equal(await h.control.rpc('secret.forget', { kind: 'portal_password', scope: 'business' }), true);
  });

  it('run.begin의 profile로 run 동안 scope를 고정한다: 다른 scope 입력은 denied, run 중 프로필 바꾸기는 거부(Q-2)', async () => {
    assert.deepEqual(await h.control.rpc('run.begin', { runId: 'rp1', trigger: 'local', profile: 'business' }), {});
    const fill = (scope: string) => h.client.rpc('typist.fill', {
      runId: 'rp1', targetId: 'RUN', frame: 'main', element: '#pw',
      secret: { kind: 'portal_password', scope }, slot: { secretKind: 'portal_password', purpose: 'login' },
    });
    assert.deepEqual(await fill('personal'), { ok: false, reason: 'denied' });
    await assert.rejects(h.control.rpc('run.begin', { runId: 'rp1', trigger: 'local', profile: 'personal' }), /profile_locked/);
    await assert.rejects(h.control.rpc('run.begin', { runId: 'rp2', trigger: 'local', profile: '../x' }), /bad_profile/);
    assert.deepEqual(await h.control.rpc('run.end', { runId: 'rp1' }), {});
    assert.deepEqual(await h.control.rpc('run.begin', { runId: 'rp1', trigger: 'local', profile: 'personal' }), {}, 'run이 끝나면 다음 run은 다른 프로필');
    assert.deepEqual(await h.control.rpc('run.end', { runId: 'rp1' }), {});
  });

  it('control 세션 이벤트: 유휴 보고 전 잠김 → 보고 → 열림 → lock-screen이면 vault.state{open:false}', async () => {
    const states: unknown[] = [];
    const off = h.control.on('vault.state', (d) => void states.push(d));
    assert.deepEqual(await h.control.rpc('session.idle', { idleSec: 3 }), { open: true });
    assert.deepEqual(await h.control.rpc('session.event', { kind: 'lock-screen' }), { open: false, reason: 'session_locked' });
    await new Promise((r) => setTimeout(r, 20));
    assert.deepEqual(states.at(-1), { open: false, reason: 'session_locked' });
    assert.deepEqual(await h.control.rpc('session.event', { kind: 'unlock-screen' }), { open: true });
    await assert.rejects(h.control.rpc('session.event', { kind: 'reboot' }), /bad_params/);
    assert.equal((await h.control.rpc<{ reason: string }>('vault.unlock', { reason: 'idle', task: 't', portal: 'p' })).reason, 'hello_unavailable');
    off();
  });

  it('기동 중(설정 읽는 동안) session.idle은 startup, 다 읽으면 control에 실제 vault.state를 한 번 보낸다', async () => {
    const items = new MemoryItemStore();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const realGet = items.get.bind(items);
    items.get = async (name) => {
      if (name === 'settings/strict') await gate;
      return realGet(name);
    };
    const human = new HumanSecretVault({ backend: { items, wrapper: new MemoryWrapper(), hello: new UnavailableHello() }, log: new Log() });
    const h2 = await startHarness({ human });
    try {
      const states: unknown[] = [];
      h2.control.on('vault.state', (d) => void states.push(d));
      assert.deepEqual(await h2.control.rpc('session.idle', { idleSec: 0 }), { open: false, reason: 'startup' });
      release();
      await human.ready();
      await new Promise((r) => setTimeout(r, 20));
      assert.deepEqual(states.at(-1), { open: true });
    } finally {
      await h2.close();
    }
  });

  it('설정을 다 읽은 뒤에 붙은 control 포트에도 실제 vault.state를 한 번 보낸다', async () => {
    const human = new HumanSecretVault({ backend: { items: new MemoryItemStore(), wrapper: new MemoryWrapper(), hello: new UnavailableHello() }, log: new Log() });
    await human.ready();
    const h2 = await startHarness({ human });
    try {
      const st = await h2.control.once('vault.state');
      assert.deepEqual(st, { open: false, reason: 'idle_unknown' }, '유휴 보고 전');
    } finally {
      await h2.close();
    }
  });

  it('typist.authFailed(엔진) → suspect + control secret.suspect, forget(control)으로 지운다', async () => {
    await h.secretPort({ mode: 'store', kind: 'portal_password', scope: 'business', notice: { version: 't06-v1' } }).rpc('secret.store', { entries: pwEntry('TEST-PW-suspect1') });
    const got = h.control.once('secret.suspect');
    assert.deepEqual(await h.client.rpc('typist.authFailed', { runId: 'r1', kind: 'portal_password', scope: 'business' }), {});
    assert.deepEqual(await got, { kind: 'portal_password', scope: 'business' });
    assert.deepEqual(await h.client.rpc('typist.authFailed', { runId: 'r1', kind: 'cert_password', scope: 'business' }), {});
    await assert.rejects(h.client.rpc('typist.authFailed', { runId: 'r1', kind: 'other', scope: 'business' }), /bad_params/);
    assert.equal(await h.control.rpc('secret.forget', { kind: 'portal_password', scope: 'business' }), true);
    await h.control.rpc('secret.forget', { kind: 'cert_password', scope: 'business' });
    assert.deepEqual(await h.control.rpc('secret.list'), []);
  });
});

describe('타이피스트가 저장된 사람 비밀을 칸 하나씩 쓴다', () => {
  async function withStored() {
    const s = setup();
    await s.v.store('portal_password', 'business', [{ field: 'pw', bytes: enc('TEST-PW-stored01') }], { version: 'v1' });
    const reads: string[] = [];
    const f = await fakeRelay({
      ops: {
        stored: (kind, scope) => {
          reads.push(`${kind}/${scope}`);
          return s.v.readOne(kind as 'portal_password', scope as 'business', { field: 'pw' });
        },
      },
    });
    return { ...s, f, reads };
  }
  const req = (over: Record<string, unknown> = {}) => ({
    runId: 'r1', targetId: 'RUN', frame: 'main', element: '#pw',
    secret: { kind: 'portal_password', scope: 'business' }, slot: { secretKind: 'portal_password' as const, purpose: 'login' as const }, ...over,
  });

  it('1회용 값이 없으면 저장된 pw를 넣고, 요청된 칸만 읽는다', async () => {
    const { f, reads } = await withStored();
    assert.deepEqual(await f.ops.fill(req()), { ok: true });
    assert.equal(f.page.value, 'TEST-PW-stored01');
    assert.deepEqual(reads, ['portal_password/business']);
  });

  it('보안카드는 넣지 않는다(대표 결정 2026-11-19 지원 안 함): 저장값을 읽지도 않는다', async () => {
    const { f, reads } = await withStored();
    assert.deepEqual(await f.ops.fill(req({ secret: { kind: 'security_card', scope: 'business' }, slot: { secretKind: 'security_card' as never, purpose: 'sign' } })), { ok: false, reason: 'denied' });
    assert.equal(f.page.value, '');
    assert.deepEqual(reads, []);
  });

  it('금고가 잠겼으면 vault_locked, suspect면 credential_suspect로 입력하지 않는다', async () => {
    const a = await withStored();
    a.v.lock.sessionEvent('lock-screen');
    assert.deepEqual(await a.f.ops.fill(req()), { ok: false, reason: 'vault_locked' });
    assert.equal(a.f.page.value, '');
    const b = await withStored();
    await b.v.markSuspect('portal_password', 'business');
    assert.deepEqual(await b.f.ops.fill(req()), { ok: false, reason: 'credential_suspect' });
  });

  it('daemon 실행·시작 게이트 없는 remote 실행은 저장 비밀을 읽지도 않는다', async () => {
    const { f, reads } = await withStored();
    f.ops.runTriggers.set('r1', 'daemon');
    assert.deepEqual(await f.ops.fill(req()), { ok: false, reason: 'denied' });
    f.ops.runTriggers.set('r1', 'remote');
    assert.deepEqual(await f.ops.fill(req()), { ok: false, reason: 'denied' });
    assert.deepEqual(reads, []);
  });
});
