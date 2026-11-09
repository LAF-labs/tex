// 계정 갱신 토큰 보관(ADR-038 (f) 자동 로그인, D05 §2, 팀장 결정 2026-11-09). Chrome·OS 키체인 없이 모의 백엔드로 돈다.
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import {
  accountRefreshItem, accountRefreshKekItem, HumanSecretVault, MemoryItemStore, MemoryWrapper, MockHello, scanDir, UnavailableHello,
  type KeychainBackend,
} from '@sax/vault';
import { startHarness, type Harness } from './harness.ts';

class Log {
  readonly lines: string[] = [];
  event(name: string, fields?: Record<string, unknown>): void {
    this.lines.push(JSON.stringify({ e: name, ...fields }));
  }
}

/** 고장을 끼울 수 있는 키체인 항목 저장소. */
class FlakyItems extends MemoryItemStore {
  failSet: ((name: string) => boolean) | null = null;
  failDelete: ((name: string) => boolean) | null = null;
  override async set(name: string, value: Uint8Array): Promise<void> {
    if (this.failSet?.(name)) throw new Error('keychain write failed');
    return super.set(name, value);
  }
  override async delete(name: string): Promise<boolean> {
    if (this.failDelete?.(name)) throw new Error('keychain delete failed');
    return super.delete(name);
  }
}

const tok = (c: string) => `sxa1.${c.repeat(43)}`;
const T1 = tok('A');
const T2 = tok('B');
const T3 = tok('C');

function setup(opts: { wrapper?: MemoryWrapper; hello?: boolean } = {}) {
  const log = new Log();
  const items = new FlakyItems();
  const backend: KeychainBackend = { items, wrapper: opts.wrapper ?? new MemoryWrapper(), hello: opts.hello ? new MockHello() : new UnavailableHello() };
  const v = new HumanSecretVault({ backend, log });
  v.lock.reportIdle(0);
  return { v, a: v.account, items, log, backend };
}

const dataKeys = (items: MemoryItemStore) => [...items.items.keys()].filter((k) => k.startsWith('account/')).sort();

describe('계정 갱신 토큰: 읽기·쓰기·지우기', () => {
  it('없으면 missing, 쓰면 같은 값을 읽는다', async () => {
    const { a } = setup();
    assert.deepEqual(await a.read(), { ok: false, reason: 'missing' });
    assert.deepEqual(await a.write(T1), { ok: true });
    assert.deepEqual(await a.read(), { ok: true, token: T1 });
  });

  it('회전 쓰기: 새 값을 다른 칸에 쓰고 옛 칸을 지운다(칸 하나만 남는다)', async () => {
    const { a, items } = setup();
    await a.write(T1);
    assert.deepEqual(dataKeys(items), [accountRefreshItem('a')]);
    await a.write(T2);
    assert.deepEqual(dataKeys(items), [accountRefreshItem('b')]);
    assert.ok(!items.items.has(accountRefreshKekItem('a')), '옛 칸의 KEK도 지운다');
    await a.write(T3);
    assert.deepEqual(dataKeys(items), [accountRefreshItem('a')]);
    assert.deepEqual(await a.read(), { ok: true, token: T3 });
  });

  it('키체인에는 암호문만 있다(토큰 평문 없음)', async () => {
    const { a, items } = setup();
    await a.write(T1);
    for (const [, val] of items.items) assert.doesNotMatch(Buffer.from(val).toString('latin1'), /sxa1\./);
  });

  it('토큰 모양이 틀리면 bad_params로 받지 않고, 오류에 값이 없다', async () => {
    const { a, items } = setup();
    for (const bad of ['', 'sxa1.short', `sxa2.${'A'.repeat(43)}`, `${T1}x`, `${T1}\n`, 123 as unknown as string, `sxa1.${'+'.repeat(43)}`]) {
      await assert.rejects(a.write(bad), (e: Error) => e.message === 'bad_params');
    }
    assert.deepEqual(dataKeys(items), []);
  });

  it('지우기: 두 칸·KEK를 모두 지우고, 없으면 false', async () => {
    const { a, items } = setup();
    assert.equal(await a.forget(), false);
    await a.write(T1);
    assert.equal(await a.forget(), true);
    assert.deepEqual([...items.items.keys()].filter((k) => k.includes('account/')), []);
    assert.deepEqual(await a.read(), { ok: false, reason: 'missing' });
  });

  it('동시에 와도 하나씩 처리한다(마지막 쓰기가 남는다)', async () => {
    const { a, items } = setup();
    await Promise.all([a.write(T1), a.write(T2), a.write(T3)]);
    assert.deepEqual(await a.read(), { ok: true, token: T3 });
    assert.equal(dataKeys(items).length, 1);
  });
});

describe('계정 갱신 토큰: 회전 쓰기는 원자적이다', () => {
  it('새 칸 암호문 쓰기가 실패하면 옛 값이 남고 반쯤 쓴 칸은 지운다', async () => {
    const { a, items, log } = setup();
    await a.write(T1);
    items.failSet = (n) => n === accountRefreshItem('b');
    assert.deepEqual(await a.write(T2), { ok: false, reason: 'write_failed' });
    assert.deepEqual(await a.read(), { ok: true, token: T1 });
    assert.ok(!items.items.has(accountRefreshKekItem('b')), '반쯤 쓴 새 칸의 KEK를 남기지 않는다');
    assert.ok(log.lines.includes('{"e":"vault.account_refresh_write_failed"}'));
    items.failSet = null;
    assert.deepEqual(await a.write(T2), { ok: true });
    assert.deepEqual(await a.read(), { ok: true, token: T2 });
  });

  it('새 칸 KEK 쓰기가 실패해도 옛 값이 남는다', async () => {
    const { a, items } = setup();
    await a.write(T1);
    items.failSet = (n) => n === accountRefreshKekItem('b');
    assert.deepEqual(await a.write(T2), { ok: false, reason: 'write_failed' });
    assert.deepEqual(await a.read(), { ok: true, token: T1 });
  });

  it('기기 결박 래핑이 안 되면(네이티브 헬퍼 없음) 쓰지 않고 옛 값이 남는다', async () => {
    const w = new MemoryWrapper();
    const { a } = setup({ wrapper: w });
    await a.write(T1);
    const wrap = w.wrap.bind(w);
    w.wrap = async () => {
      throw new Error('vault.native_helper_missing');
    };
    assert.deepEqual(await a.write(T2), { ok: false, reason: 'kek_unavailable' });
    w.wrap = wrap;
    assert.deepEqual(await a.read(), { ok: true, token: T1 });
  });

  it('되읽은 값이 다르면(쓰기가 조용히 깨짐) 실패로 보고 옛 값이 남는다', async () => {
    const { a, items } = setup();
    await a.write(T1);
    const set = items.set.bind(items);
    items.set = async (n, v) => set(n, n === accountRefreshItem('b') ? Uint8Array.from(v).map((x, i) => (i === v.length - 1 ? x ^ 1 : x)) : v);
    assert.deepEqual(await a.write(T2), { ok: false, reason: 'write_failed' });
    assert.deepEqual(await a.read(), { ok: true, token: T1 });
    assert.ok(!items.items.has(accountRefreshItem('b')));
  });

  it('옛 칸을 지우다 끊기면 두 칸이 남아도 세대가 큰 새 값을 읽고, 다음 쓰기가 정리한다', async () => {
    const { a, items } = setup();
    await a.write(T1);
    items.failDelete = (n) => n === accountRefreshItem('a');
    assert.deepEqual(await a.write(T2), { ok: true });
    assert.equal(dataKeys(items).length, 2);
    assert.deepEqual(await a.read(), { ok: true, token: T2 });
    items.failDelete = null;
    assert.deepEqual(await a.write(T3), { ok: true });
    assert.deepEqual(dataKeys(items), [accountRefreshItem('a')]);
    assert.deepEqual(await a.read(), { ok: true, token: T3 });
  });

  it('다른 기기(다른 래핑 키)로 옮긴 항목은 kek_unavailable, 깨진 암호문은 corrupt', async () => {
    const one = setup();
    await one.a.write(T1);
    const moved = setup({ wrapper: MemoryWrapper.otherDevice() });
    for (const [k, v] of one.items.items) moved.items.items.set(k, v);
    assert.deepEqual(await moved.a.read(), { ok: false, reason: 'kek_unavailable' });

    const { a, items, log } = setup();
    await a.write(T1);
    const blob = items.items.get(accountRefreshItem('a'))!;
    blob[blob.length - 1]! ^= 1;
    assert.deepEqual(await a.read(), { ok: false, reason: 'corrupt' });
    assert.ok(log.lines.includes('{"e":"vault.account_refresh_corrupt"}'));
    // 깨진 칸 위에 새로 쓰면 다시 쓸 수 있다.
    assert.deepEqual(await a.write(T2), { ok: true });
    assert.deepEqual(await a.read(), { ok: true, token: T2 });
  });

  it('칸 자리를 바꿔 붙인 항목(a의 암호문을 b에)은 풀리지 않는다', async () => {
    const { a, items } = setup();
    await a.write(T1);
    items.items.set(accountRefreshItem('b'), items.items.get(accountRefreshItem('a'))!);
    items.items.set(accountRefreshKekItem('b'), items.items.get(accountRefreshKekItem('a'))!);
    items.items.delete(accountRefreshItem('a'));
    // KEK 래핑이 칸 이름에 묶여 있어 KEK부터 풀리지 않는다.
    assert.deepEqual(await a.read(), { ok: false, reason: 'kek_unavailable' });
  });
});

describe('계정 갱신 토큰: 금고 잠금', () => {
  it('Windows 잠금이면 읽지도 쓰지도 않고, 지우기는 된다. 잠금 해제 뒤 다시 읽는다', async () => {
    const { v, a } = setup();
    await a.write(T1);
    v.lock.sessionEvent('lock-screen');
    assert.deepEqual(await a.read(), { ok: false, reason: 'vault_locked' });
    assert.deepEqual(await a.write(T2), { ok: false, reason: 'vault_locked' });
    v.lock.sessionEvent('unlock-screen');
    assert.deepEqual(await a.read(), { ok: true, token: T1 });
    v.lock.sessionEvent('lock-screen');
    assert.equal(await a.forget(), true);
  });

  it('유휴 보고 전(기동 직후)은 잠김: main은 로그인 화면으로 간다', async () => {
    const log = new Log();
    const v = new HumanSecretVault({ backend: { items: new MemoryItemStore(), wrapper: new MemoryWrapper(), hello: new UnavailableHello() }, log });
    assert.deepEqual(await v.account.read(), { ok: false, reason: 'vault_locked' });
    v.lock.reportIdle(0);
    assert.deepEqual(await v.account.read(), { ok: false, reason: 'missing' });
  });

  it('엄격 모드는 Hello 확인 전까지 잠김', async () => {
    const { v, a } = setup({ hello: true });
    await a.write(T1);
    v.lock.setStrict(true);
    assert.deepEqual(await a.read(), { ok: false, reason: 'vault_locked' });
    v.lock.helloConfirmed();
    assert.deepEqual(await a.read(), { ok: true, token: T1 });
  });
});

describe('계정 갱신 토큰: 사이트 비밀과 따로다', () => {
  it('secret.list에 나오지 않고, 사이트 비밀 삭제·엄격 모드 전환과 섞이지 않는다', async () => {
    const { v, a } = setup({ hello: true });
    await v.store('portal_password', 'business', [{ field: 'pw', bytes: new TextEncoder().encode('TEST-PW-site01') }], { version: 't06-v1' });
    await a.write(T1);
    assert.deepEqual((await v.list()).map((s) => s.kind), ['portal_password']);
    assert.equal(await v.forget('portal_password', 'business'), true);
    assert.deepEqual(await a.read(), { ok: true, token: T1 });
    await v.store('portal_password', 'business', [{ field: 'pw', bytes: new TextEncoder().encode('TEST-PW-site01') }], { version: 't06-v1' });
    assert.equal(await a.forget(), true);
    assert.equal(await v.has('portal_password', 'business'), true, '계정 토큰 지우기는 사이트 비밀을 건드리지 않는다');
  });
});

describe('계정 갱신 토큰: 로그는 이벤트 이름만', () => {
  it('쓰기·지우기·실패 로그에 필드가 없다(값·길이·해시 없음)', async () => {
    const { a, items, log } = setup();
    await a.write(T1);
    await a.read();
    items.failSet = (n) => n.startsWith('account/');
    await a.write(T2);
    items.failSet = null;
    await a.forget();
    const mine = log.lines.filter((l) => l.includes('account_refresh'));
    assert.deepEqual(mine, [
      '{"e":"vault.account_refresh_stored"}',
      '{"e":"vault.account_refresh_write_failed"}',
      '{"e":"vault.account_refresh_forgotten"}',
    ]);
    assert.doesNotMatch(log.lines.join('\n'), /sxa1|AAAA|BBBB|"len|"bytes|"hash/);
  });
});

describe('계정 갱신 토큰: 포트', () => {
  let h: Harness;
  before(async () => {
    h = await startHarness();
    await h.control.rpc('session.idle', { idleSec: 0 });
  });
  after(async () => {
    await h.close();
  });

  it('control(main) 포트에서 읽기·쓰기·지우기가 된다', async () => {
    assert.deepEqual(await h.control.rpc('account.refresh.read', {}), { ok: false, reason: 'missing' });
    assert.deepEqual(await h.control.rpc('account.refresh.write', { token: T1 }), { ok: true });
    assert.deepEqual(await h.control.rpc('account.refresh.write', { token: T2 }), { ok: true });
    assert.deepEqual(await h.control.rpc('account.refresh.read', {}), { ok: true, token: T2 });
    assert.deepEqual(await h.control.rpc('secret.list'), [], '사이트 비밀 목록에 없다');
    await assert.rejects(h.control.rpc('account.refresh.write', { token: 'nope' }), /^Error: vault: bad_params$/);
    await assert.rejects(h.control.rpc('account.refresh.write', {}), /bad_params/);
    assert.deepEqual(await h.control.rpc('account.refresh.forget', {}), { removed: true });
    assert.deepEqual(await h.control.rpc('account.refresh.read', {}), { ok: false, reason: 'missing' });
  });

  it('engine 포트·비밀 입력 포트는 거부한다(vault.rpc_denied), 값을 건네지 않는다', async () => {
    await h.control.rpc('account.refresh.write', { token: T3 });
    for (const m of ['account.refresh.read', 'account.refresh.write', 'account.refresh.forget']) {
      await assert.rejects(h.client.rpc(m, { token: T1 }), /denied/, m);
      const port = h.secretPort({ mode: 'store', kind: 'portal_password', scope: 'business', notice: { version: 't06-v1' } });
      await assert.rejects(port.rpc(m, { token: T1 }), /denied/, m);
      assert.ok(h.log.lines.some((l) => l.includes('"vault.rpc_denied"') && l.includes(m) && l.includes('"engine"')));
    }
    // 엔진이 지우거나 바꾸지 못했다.
    assert.deepEqual(await h.control.rpc('account.refresh.read', {}), { ok: true, token: T3 });
    // 엔진 포트 IPC 어디에도 토큰이 없다.
    assert.deepEqual(h.capture.scan([T3]).filter((f) => f.source.startsWith('ipc.engine')), []);
    await h.control.rpc('account.refresh.forget', {});
  });

  it('금고가 잠기면(session.event lock-screen) control도 읽지 못하고, 지우기는 된다', async () => {
    await h.control.rpc('account.refresh.write', { token: T1 });
    await h.control.rpc('session.event', { kind: 'lock-screen' });
    assert.deepEqual(await h.control.rpc('account.refresh.read', {}), { ok: false, reason: 'vault_locked' });
    assert.deepEqual(await h.control.rpc('account.refresh.write', { token: T2 }), { ok: false, reason: 'vault_locked' });
    assert.deepEqual(await h.control.rpc('account.refresh.forget', {}), { removed: true });
    await h.control.rpc('session.event', { kind: 'unlock-screen' });
    assert.deepEqual(await h.control.rpc('account.refresh.read', {}), { ok: false, reason: 'missing' });
  });

  it('금고 로그 폴더에 토큰이 없다', async () => {
    assert.deepEqual((await scanDir(h.paths.logs, [T1, T2, T3])).findings, []);
  });
});
