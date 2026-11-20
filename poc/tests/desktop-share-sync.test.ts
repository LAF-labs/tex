import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, it } from 'node:test';
import {
  AIK_PURPOSES, CTX, VM_PURPOSES, addDevice, deriveShareKey, deriveShareSignSeed, ed25519Keygen, ed25519Public, hkdfSha256, initialDeviceList, newShareRowId, openShareRow, randomBytes,
  revokeDevice, sealShareRow, shareEpoch, softSigner, x25519Keygen, type DeviceListJson, type ShareRowCore, type ShareRowWire, type ShareSign,
} from '@sax/remote';
import type { DeviceAuth, SharePage, ShareServerRow, ShareVault } from '../apps/desktop/src/remote-ports.ts';
import { SHARE_PULL_PAGES, ShareSync, type ShareDevice, type ShareInRow, type ShareOutItem, type ShareStore } from '../apps/desktop/src/share-sync.ts';

const fail = (code: string): never => {
  throw Object.assign(new Error(code), { code });
};

class FakeServer {
  rows: ShareServerRow[] = [];
  next = 1;
  epoch = 0;
  calls: string[] = [];
  failNext: Record<string, string[]> = {};
  pageRows = 200;
  #maybeFail(op: string): void {
    const code = this.failNext[op]?.shift();
    if (code) fail(code);
  }
  client() {
    return {
      putShareRow: async (auth: DeviceAuth, row: ShareRowWire & { taskId?: string }): Promise<{ seq: number }> => {
        this.calls.push(`put:${row.kind}`);
        const h = await auth('PUT', 'u');
        this.#maybeFail('put');
        const dup = this.rows.find((r) => r.rowId === row.rowId);
        if (dup) return dup.body === row.body && dup.epoch === row.epoch ? { seq: dup.seq } : fail('account.share_row_conflict');
        if (row.epoch < this.epoch) fail('account.share_epoch_stale');
        this.epoch = Math.max(this.epoch, row.epoch);
        const seq = this.next++;
        this.rows.push({ seq, rowId: row.rowId, kind: row.kind, epoch: row.epoch, deviceId: h.dev ?? randomUUID(), at: 1, body: row.body });
        return { seq };
      },
      shareRows: async (auth: DeviceAuth, after: number): Promise<SharePage> => {
        this.calls.push(`rows:${after}`);
        await auth('GET', 'u');
        this.#maybeFail('rows');
        const all = this.rows.filter((r) => r.seq > after);
        return { rows: all.slice(0, this.pageRows), head: this.next - 1, epoch: this.epoch, more: all.length > this.pageRows };
      },
    };
  }
}

class MemStore implements ShareStore {
  out: ShareOutItem[] = [];
  sentLog: Array<[string, number | null]> = [];
  droppedLog: Array<[string, string]> = [];
  at = 0;
  got = new Map<string, ShareInRow>();
  async pending(limit: number) {
    return this.out.slice(0, limit);
  }
  async sent(rowId: string, seq: number | null) {
    this.sentLog.push([rowId, seq]);
    this.out = this.out.filter((i) => i.rowId !== rowId);
  }
  async dropped(rowId: string, reason: string) {
    this.droppedLog.push([rowId, reason]);
    this.out = this.out.filter((i) => i.rowId !== rowId);
  }
  async cursor() {
    return this.at;
  }
  async apply(rows: ShareInRow[], cursor: number) {
    for (const r of rows) if (!this.got.has(r.row.row_id)) this.got.set(r.row.row_id, r);
    this.at = cursor;
  }
}

const issueBody = (n: number) => ({ doc: 'tax_invoice' as const, approvalNo: `2026111741000000${String(n).padStart(8, '0')}`, writtenOn: '2026-11-17', buyerBizNo: '1234567890', buyerName: '가나다상사', supply: 1_000_000, tax: 100_000, how: 'app' as const });
const issueItem = (n: number): ShareOutItem => ({ rowId: newShareRowId(), kind: 'issue', at: 1_800_000_000_000 + n, body: issueBody(n) });

async function account(o: { phone?: boolean } = {}) {
  const rk = randomBytes(32);
  const aik = softSigner(hkdfSha256(rk, 'aik', 32), AIK_PURPOSES);
  const ws = softSigner(deriveShareSignSeed(rk), [CTX.share]);
  const pcId = randomUUID();
  const entry = (deviceId: string, role: 'desktop' | 'mobile', signPub: Uint8Array) => ({ deviceId, role, noisePub: x25519Keygen().publicKey, signPub, registeredAt: 1 });
  let list: DeviceListJson = await initialDeviceList(aik, entry(pcId, 'desktop', ed25519Keygen().publicKey));
  const phoneKey = ed25519Keygen();
  const phoneId = randomUUID();
  const vm = softSigner(phoneKey.secretKey, VM_PURPOSES);
  const phoneSign: ShareSign = (m) => vm.sign(CTX.share, m);
  const addPhone = async () => void (list = await addDevice(aik, list, entry(phoneId, 'mobile', phoneKey.publicKey)));
  if (o.phone !== false) await addPhone();
  const handed: Uint8Array[] = [];
  const vaultCalls: string[] = [];
  const vault: ShareVault = {
    key: async (epoch) => {
      vaultCalls.push(`key:${epoch}`);
      const key = deriveShareKey(rk, epoch);
      handed.push(key);
      return { key, signPub: ed25519Public(deriveShareSignSeed(rk)) };
    },
    sign: async (msg) => {
      vaultCalls.push('sign');
      return ws.sign(CTX.share, msg);
    },
  };
  let cleared = 0;
  const dev: ShareDevice = {
    deviceId: pcId,
    get deviceList() {
      return list;
    },
    auth: async () => ({ dev: pcId }),
    clearToken: () => void cleared++,
  };
  const keys = { sharePub: ed25519Public(deriveShareSignSeed(rk)), mobileSignPub: (id: string) => (id === phoneId ? phoneKey.publicKey : null) };
  return {
    rk, aik, pcId, phoneId, phoneSign, vault, vaultCalls, handed, dev, keys, addPhone,
    get list() {
      return list;
    },
    set list(l: DeviceListJson) {
      list = l;
    },
    get cleared() {
      return cleared;
    },
    key: (e: number) => deriveShareKey(rk, e),
  };
}

const taskRow = (a: Awaited<ReturnType<typeof account>>, epoch = 0): ShareRowCore<'task'> => ({
  v: 1, row_id: newShareRowId(), kind: 'task', epoch, at: 1_800_000_000_500, dev: a.phoneId, by: 'mobile',
  body: { do: 'tax_invoice.issue', buyerBizNo: '1234567890', supply: 500_000, tax: 50_000, item: '11월 용역' },
});
async function serverPut(s: FakeServer, wire: ShareRowWire, deviceId: string) {
  await s.client().putShareRow(async () => ({ dev: deviceId }), wire);
}

describe('계정 공유 기록 동기화: 올리기와 받기', () => {
  it('기기가 하나뿐이거나 로그인 전이면 서버도 금고도 부르지 않는다. 밀린 줄은 그대로 남는다', async () => {
    const a = await account({ phone: false });
    const s = new FakeServer();
    const store = new MemStore();
    store.out.push(issueItem(1));
    const logs: string[] = [];
    const sync = new ShareSync({ client: s.client(), device: () => a.dev, vault: async () => a.vault, store, log: (n) => logs.push(n) });
    assert.deepEqual(await sync.sync(), { state: 'not_needed', pulled: 0, applied: 0, rejected: {}, pushed: 0, dropped: 0, parties: 0 });
    assert.equal((await new ShareSync({ client: s.client(), device: () => null, vault: async () => a.vault, store }).sync()).state, 'not_needed');
    assert.equal((await new ShareSync({ client: null, device: () => a.dev, vault: async () => a.vault, store }).sync()).state, 'not_needed');
    assert.deepEqual([s.calls, a.vaultCalls, store.out.length, logs], [[], [], 1, []]);
    await a.addPhone();
    assert.deepEqual(await sync.sync(), { state: 'ok', pulled: 0, applied: 0, rejected: {}, pushed: 1, dropped: 0, parties: 0 });
    assert.equal(store.out.length, 0);
  });

  it('올린 줄은 계정 키로 봉인되고 금고(Ws)가 서명한다. 받은 줄은 서명을 확인한 것만 넣고, 쓴 키는 지운다', async () => {
    const a = await account();
    const s = new FakeServer();
    const store = new MemStore();
    const mine = [issueItem(1), { rowId: newShareRowId(), kind: 'self', at: 5, body: { bizNo: '1112233334', name: '율무상회' } } satisfies ShareOutItem];
    store.out.push(...mine);
    const task = taskRow(a);
    await serverPut(s, await sealShareRow(a.key(0), task, a.phoneSign), a.phoneId);
    const logs: Array<[string, Record<string, unknown>]> = [];
    const sync = new ShareSync({ client: s.client(), device: () => a.dev, vault: async () => a.vault, store, log: (n, d) => logs.push([n, d]) });
    const r = await sync.sync();
    assert.deepEqual(r, { state: 'ok', pulled: 1, applied: 1, rejected: {}, pushed: 2, dropped: 0, parties: 0 });
    assert.deepEqual([...store.got.values()].map((x) => [x.seq, x.row]), [[1, task]]);
    assert.deepEqual(store.sentLog, [[mine[0]!.rowId, 2], [mine[1]!.rowId, 3]]);
    const up = s.rows.find((x) => x.rowId === mine[0]!.rowId)!;
    assert.ok(!up.body.includes('1234567890'));
    const opened = openShareRow(a.key(0), up, a.keys);
    assert.ok(opened.ok && opened.row.by === 'desktop' && opened.row.dev === a.pcId && opened.row.at === mine[0]!.at);
    assert.deepEqual(opened.ok && opened.row.body, mine[0]!.body);
    assert.ok(a.handed.length >= 1 && a.handed.every((k) => k.every((b) => b === 0)));
    assert.deepEqual(logs.map(([n, d]) => [n, d.result, d.pulled, d.applied, d.pushed]), [['main.share_sync', 'ok', 1, 1, 2]]);
    assert.ok(!JSON.stringify(logs).includes('1234567890') && !JSON.stringify(logs).includes(mine[0]!.rowId));
    assert.deepEqual(await sync.sync(), { state: 'ok', pulled: 2, applied: 2, rejected: {}, pushed: 0, dropped: 0, parties: 0 });
    assert.equal(store.at, 3);
    assert.deepEqual(await sync.sync(), { state: 'ok', pulled: 0, applied: 0, rejected: {}, pushed: 0, dropped: 0, parties: 0 });
  });

  it('서버가 바꾼 줄·지어낸 줄·끊긴 폰의 줄은 넣지 않고 이유별로 센다. 커서는 넘어간다', async () => {
    const a = await account();
    const s = new FakeServer();
    const store = new MemStore();
    const good = taskRow(a);
    const goodWire = await sealShareRow(a.key(0), good, a.phoneSign);
    await serverPut(s, goodWire, a.phoneId);
    const forged: ShareRowCore<'issue'> = { v: 1, row_id: newShareRowId(), kind: 'issue', epoch: 0, at: 9, dev: a.pcId, by: 'desktop', body: issueBody(7) };
    await serverPut(s, await sealShareRow(a.key(0), forged, a.phoneSign), a.phoneId);
    await serverPut(s, { ...goodWire, rowId: newShareRowId() }, a.phoneId);
    const other = await sealShareRow(a.key(0), taskRow(a), a.phoneSign);
    await serverPut(s, { ...other, kind: 'party' }, a.phoneId);
    const stranger = softSigner(ed25519Keygen().secretKey, [CTX.share]);
    await serverPut(s, await sealShareRow(a.key(0), { ...taskRow(a), dev: randomUUID() }, (m) => stranger.sign(CTX.share, m)), a.phoneId);
    await serverPut(s, { rowId: newShareRowId(), kind: 'issue', epoch: 0, body: 'A'.repeat(728) }, a.phoneId);
    const sync = new ShareSync({ client: s.client(), device: () => a.dev, vault: async () => a.vault, store });
    const r = await sync.sync();
    assert.deepEqual(r, { state: 'ok', pulled: 6, applied: 1, rejected: { signature: 1, key: 3, signer: 1 }, pushed: 0, dropped: 0, parties: 0 });
    assert.deepEqual([...store.got.keys()], [good.row_id]);
    assert.equal(store.at, 6);
  });

  it('한 번에 받는 양을 넘으면 이어서 받는다. 쪽 수 상한에서 멈추고 다음 동기화가 잇는다', async () => {
    const a = await account();
    const s = new FakeServer();
    s.pageRows = 2;
    const store = new MemStore();
    for (let i = 0; i < 5; i++) await serverPut(s, await sealShareRow(a.key(0), taskRow(a), a.phoneSign), a.phoneId);
    const sync = new ShareSync({ client: s.client(), device: () => a.dev, vault: async () => a.vault, store });
    assert.deepEqual(await sync.sync(), { state: 'ok', pulled: 5, applied: 5, rejected: {}, pushed: 0, dropped: 0, parties: 0 });
    assert.deepEqual(s.calls.filter((c) => c.startsWith('rows:')), ['rows:0', 'rows:2', 'rows:4']);
    s.pageRows = 1;
    const store2 = new MemStore();
    for (let i = 0; i < SHARE_PULL_PAGES; i++) await serverPut(s, await sealShareRow(a.key(0), taskRow(a), a.phoneSign), a.phoneId);
    const sync2 = new ShareSync({ client: s.client(), device: () => a.dev, vault: async () => a.vault, store: store2 });
    assert.equal((await sync2.sync()).pulled, SHARE_PULL_PAGES);
    assert.equal((await sync2.sync()).pulled, 5);
    assert.equal(store2.got.size, SHARE_PULL_PAGES + 5);
  });
});

describe('계정 공유 기록 동기화: 다시 하기와 실패', () => {
  it('응답이 끊겨 다시 올린 줄은 서버가 "이미 있다"고 답하고, 올린 것으로 친다(봉인은 매번 달라서 같은 내용으로 보이지 않는다)', async () => {
    const a = await account();
    const s = new FakeServer();
    const store = new MemStore();
    const item = issueItem(1);
    store.out.push(item);
    const client = s.client();
    let cut = true;
    const flaky = {
      ...client,
      putShareRow: async (auth: DeviceAuth, row: ShareRowWire & { taskId?: string }) => {
        const r = await client.putShareRow(auth, row);
        if (cut) {
          cut = false;
          fail('net.network');
        }
        return r;
      },
    };
    const sync = new ShareSync({ client: flaky, device: () => a.dev, vault: async () => a.vault, store });
    assert.deepEqual(await sync.sync(), { state: 'failed', code: 'net.network', pulled: 0, applied: 0, rejected: {}, pushed: 0, dropped: 0, parties: 0 });
    assert.equal(store.out.length, 1);
    const r = await sync.sync();
    assert.deepEqual([r.state, r.pushed, r.pulled], ['ok', 1, 1]);
    assert.deepEqual(store.sentLog, [[item.rowId, null]]);
    assert.equal(s.rows.length, 1);
  });

  it('다른 PC가 기기를 끊어 세대가 올랐으면 목록을 다시 받아 새 세대로 올린다. 못 받으면 실패로 남기고 줄은 그대로 둔다', async () => {
    const a = await account();
    const s = new FakeServer();
    const store = new MemStore();
    const p2 = randomUUID();
    a.list = await addDevice(a.aik, a.list, { deviceId: p2, role: 'mobile', noisePub: x25519Keygen().publicKey, signPub: ed25519Keygen().publicKey, registeredAt: 2 });
    const newer = await revokeDevice(a.aik, a.list, a.phoneId);
    s.epoch = 1;
    store.out.push(issueItem(1));
    const stuck = new ShareSync({ client: s.client(), device: () => a.dev, vault: async () => a.vault, store });
    assert.deepEqual([(await stuck.sync()).code, store.out.length, s.rows.length], ['account.share_epoch_stale', 1, 0]);
    let refreshed = 0;
    const sync = new ShareSync({ client: s.client(), device: () => a.dev, vault: async () => a.vault, store, refreshDeviceList: async () => void (refreshed++, (a.list = newer)) });
    const r = await sync.sync();
    assert.deepEqual([r.state, r.pushed, refreshed, shareEpoch(a.list)], ['ok', 1, 1, 1]);
    assert.equal(s.rows[0]!.epoch, 1);
    assert.deepEqual(openShareRow(a.key(0), s.rows[0]!, a.keys), { ok: false, reason: 'key' });
    assert.equal(openShareRow(a.key(1), s.rows[0]!, a.keys).ok, true);
  });

  it('다른 PC가 붙인 폰의 줄: 모르는 서명자면 목록을 한 번 다시 받고 그 쪽을 다시 연다', async () => {
    const a = await account({ phone: false });
    const s = new FakeServer();
    const store = new MemStore();
    a.list = await addDevice(a.aik, a.list, { deviceId: randomUUID(), role: 'desktop', noisePub: x25519Keygen().publicKey, signPub: ed25519Keygen().publicKey, registeredAt: 2 });
    const before = a.list;
    await a.addPhone();
    const withPhone = a.list;
    a.list = before;
    const task = taskRow(a);
    await serverPut(s, await sealShareRow(a.key(0), task, a.phoneSign), a.phoneId);
    let refreshed = 0;
    const sync = new ShareSync({ client: s.client(), device: () => a.dev, vault: async () => a.vault, store, refreshDeviceList: async () => void (refreshed++, (a.list = withPhone)) });
    assert.deepEqual(await sync.sync(), { state: 'ok', pulled: 1, applied: 1, rejected: {}, pushed: 0, dropped: 0, parties: 0 });
    assert.equal(refreshed, 1);
    const store2 = new MemStore();
    a.list = before;
    const sync2 = new ShareSync({ client: s.client(), device: () => a.dev, vault: async () => a.vault, store: store2, refreshDeviceList: async () => {} });
    assert.deepEqual(await sync2.sync(), { state: 'ok', pulled: 1, applied: 0, rejected: { signer: 1 }, pushed: 0, dropped: 0, parties: 0 });
  });

  it('서버가 이미 받은 순번보다 낮은 끝을 말하면(되감기) 멈추고 커서를 내리지 않는다', async () => {
    const a = await account();
    const s = new FakeServer();
    const store = new MemStore();
    store.at = 9;
    store.out.push(issueItem(1));
    const logs: string[] = [];
    const sync = new ShareSync({ client: s.client(), device: () => a.dev, vault: async () => a.vault, store, log: (n) => logs.push(n) });
    const r = await sync.sync();
    assert.deepEqual([r.state, r.code, store.at, store.out.length, s.rows.length], ['failed', 'share.head_regressed', 9, 1, 0]);
    assert.deepEqual(logs, ['main.share_head_regressed', 'main.share_sync']);
  });

  it('모양이 규칙 밖인 줄과 이미 끝난 일의 결과는 버리고 다음 줄로 간다. 서버 오류는 멈추고 다음에 다시 한다', async () => {
    const a = await account();
    const s = new FakeServer();
    const store = new MemStore();
    const bad: ShareOutItem = { rowId: newShareRowId(), kind: 'issue', at: 1, body: { ...issueBody(1), buyerBizNo: '123' } };
    const result: ShareOutItem = { rowId: newShareRowId(), kind: 'task_result', at: 2, body: { taskRow: newShareRowId(), outcome: 'cancelled' }, taskId: newShareRowId() };
    const good = issueItem(2);
    const later = issueItem(3);
    store.out.push(bad, result, good, later);
    s.failNext.put = ['account.task_not_claimed', '', 'policy.rate_limited'];
    const sync = new ShareSync({ client: s.client(), device: () => a.dev, vault: async () => a.vault, store });
    const r = await sync.sync();
    assert.deepEqual([r.state, r.code, r.pushed, r.dropped], ['failed', 'policy.rate_limited', 1, 2]);
    assert.deepEqual(store.droppedLog, [[bad.rowId, 'shape'], [result.rowId, 'account.task_not_claimed']]);
    assert.deepEqual(store.out.map((i) => i.rowId), [later.rowId]);
    assert.equal((await sync.sync()).pushed, 1);
  });

  it('토큰이 만료돼 401이면 토큰을 버리고 한 번만 다시 한다. 금고가 실패하면 줄을 버리지 않는다', async () => {
    const a = await account();
    const s = new FakeServer();
    const store = new MemStore();
    store.out.push(issueItem(1));
    s.failNext.rows = ['account.unauthorized'];
    s.failNext.put = ['account.unauthorized'];
    const sync = new ShareSync({ client: s.client(), device: () => a.dev, vault: async () => a.vault, store });
    assert.deepEqual([(await sync.sync()).pushed, a.cleared], [1, 2]);
    s.failNext.rows = ['account.unauthorized', 'account.unauthorized'];
    assert.deepEqual([(await sync.sync()).code, a.cleared], ['account.unauthorized', 3]);
    store.out.push(issueItem(2));
    const broken: ShareVault = { key: a.vault.key, sign: async () => fail('vault.locked') };
    const sync2 = new ShareSync({ client: s.client(), device: () => a.dev, vault: async () => broken, store });
    const r = await sync2.sync();
    assert.deepEqual([r.state, r.code, r.dropped, store.out.length], ['failed', 'vault.locked', 0, 1]);
    const [x, y] = await Promise.all([sync.sync(), sync.sync()]);
    assert.deepEqual([x.pushed, y.pushed], [1, 0]);
  });
});
