// 계좌 자동조회 CODEF 원천(엔진): 모의 게이트웨이 + 모의 CODEF HTTP 서버(URL 인코딩 JSON). 실제 CODEF·은행을 부르지 않는다. 값은 모두 가짜다.
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, beforeEach, describe, it } from 'node:test';
import { Egress, EgressError, decodeCodefBody, encodeCodefBody } from '../packages/net/src/index.ts';
import { CODEF_SOURCE_CODES, CodefClient, CodefError, CodefLink, codefRows, codefTxnSource, memoryBankSink, memoryCodefStore, type CodefEvent, type CodefSealPort, type SealResult } from '../packages/engine/src/codef/index.ts';
import { SourceError, type SourceProgress } from '../packages/engine/src/bank/source.ts';

const FAKE_ACCOUNT = '1002123456789';
const FAKE_TOKEN = 'fake-codef-token-0000000001';

interface Call {
  path: string;
  auth: string;
  body: Record<string, unknown>;
}

/** 모의 CODEF: 계정 등록·삭제·보유계좌·거래내역. scenario로 오류 갈래를 고른다 */
class MockCodef {
  calls: Call[] = [];
  scenario: { createCode?: string; createAsErrorList?: string; txnCode?: string; tokenExpiredOnce?: boolean; deleteFails?: boolean } = {};
  live = new Set<string>();
  private n = 0;
  txns: Array<Record<string, string>> = [
    { resAccountTrDate: '20261110', resAccountTrTime: '093001', resAccountOut: '0', resAccountIn: '1100000', resAfterTranBalance: '5100000', resAccountDesc1: '가나상사', resAccountDesc2: '타행이체', resAccountDesc3: '', resAccountDesc4: '' },
    { resAccountTrDate: '20261111', resAccountTrTime: '140000', resAccountOut: '33000', resAccountIn: '0', resAfterTranBalance: '5067000', resAccountDesc1: '', resAccountDesc2: '카드', resAccountDesc3: '통신비', resAccountDesc4: '' },
  ];
  handle(path: string, auth: string, body: Record<string, unknown>): { result: { code: string; message: string }; data: unknown } {
    this.calls.push({ path, auth, body });
    const ok = (data: unknown) => ({ result: { code: 'CF-00000', message: '성공' }, data });
    const err = (code: string) => ({ result: { code, message: 'x' }, data: {} });
    if (this.scenario.tokenExpiredOnce) {
      this.scenario.tokenExpiredOnce = false;
      return err('CF-09992');
    }
    if (path === '/v1/account/create') {
      if (this.scenario.createCode) return err(this.scenario.createCode);
      if (this.scenario.createAsErrorList) return ok({ connectedId: '', successList: [], errorList: [{ code: this.scenario.createAsErrorList, message: 'x', organization: '0020' }] });
      const id = `cid${String(++this.n).padStart(10, '0')}`;
      this.live.add(id);
      return ok({ connectedId: id, successList: [{ code: 'CF-00000', organization: '0020' }], errorList: [] });
    }
    if (path === '/v1/account/delete') {
      if (this.scenario.deleteFails) return err('CF-09999');
      const id = String(body.connectedId);
      if (!this.live.delete(id)) return err('CF-04019');
      return ok({ connectedId: id });
    }
    if (!this.live.has(String(body.connectedId))) return err('CF-04019');
    if (path.endsWith('/account-list')) {
      return ok({ resDepositTrust: [
        { resAccount: FAKE_ACCOUNT, resAccountDisplay: '1002-123-456789', resAccountName: '기업자유예금', resAccountNickName: '', resAccountBalance: '5067000', resAccountDeposit: '11' },
        { resAccount: '1002999888777', resAccountDisplay: '1002-999-888777', resAccountName: '정기예금', resAccountBalance: '1000000', resAccountDeposit: '12' },
      ] });
    }
    if (path.endsWith('/transaction-list')) {
      if (this.scenario.txnCode) return err(this.scenario.txnCode);
      return ok({ resAccount: FAKE_ACCOUNT, commStartDate: String(body.startDate), commEndDate: String(body.endDate), resTrHistoryList: this.txns });
    }
    return err('CF-00007');
  }
}

let server: http.Server;
let gw: http.Server;
let codefOrigin = '';
let gwOrigin = '';
const mock = new MockCodef();
let tokenCalls = 0;
let gwMode: 'ok' | 'off' = 'ok';

before(async () => {
  server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const body = decodeCodefBody(raw) as Record<string, unknown>;
      const out = mock.handle(req.url ?? '', String(req.headers.authorization ?? ''), body ?? {});
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(encodeCodefBody(out));
    });
  });
  gw = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      if (req.url !== '/v1/codef/token') return void (res.writeHead(404), res.end());
      tokenCalls++;
      if (gwMode === 'off') return void (res.writeHead(503, { 'content-type': 'application/json' }), res.end('{"error":"gateway.codef_off"}'));
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ accessToken: FAKE_TOKEN, expiresAt: new Date(Date.now() + 86_400_000).toISOString(), env: 'sandbox', publicKey: 'FAKE-PUBLIC-KEY' }));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  await new Promise<void>((r) => gw.listen(0, '127.0.0.1', r));
  codefOrigin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  gwOrigin = `http://127.0.0.1:${(gw.address() as AddressInfo).port}`;
});
after(() => {
  server.close();
  gw.close();
});

function egress(): Egress {
  return new Egress({
    testOrigins: { codef: codefOrigin, gateway: gwOrigin },
    gateway: { auth: { headers: async () => ({ authorization: 'DPoP test', dpop: 'proof' }) }, bundles: [] },
    env: {},
  });
}

/** 가짜 금고: 감싼 로그인을 돌려준다. asks는 창을 연 횟수(기억해 두면 auto는 창 없음) */
function fakeSeal(o: { remember?: boolean; result?: SealResult } = {}): CodefSealPort & { asks: number; forgets: number; remembered: boolean } {
  const s = {
    asks: 0,
    forgets: 0,
    remembered: false,
    async seal(p: { certId: string; publicKey: string; mode: 'ask' | 'auto' }): Promise<SealResult> {
      assert.equal(p.publicKey, 'FAKE-PUBLIC-KEY');
      if (o.result) return o.result;
      const used = p.mode === 'auto' && s.remembered;
      if (!used) {
        s.asks++;
        if (o.remember) s.remembered = true;
      }
      return { ok: true, derFile: 'RkFLRS1ERVI=', keyFile: 'RkFLRS1LRVk=', password: 'RkFLRS1SU0E=', remembered: s.remembered };
    },
    async cancel() {},
    async forget() {
      s.forgets++;
      s.remembered = false;
    },
  };
  return s;
}

const CERT = '0123456789abcdef';

function setup(o: { remember?: boolean; seal?: CodefSealPort; sink?: boolean; dailyCalls?: number } = {}) {
  const events: CodefEvent[] = [];
  let clock = Date.parse('2026-11-12T03:00:00Z');
  /** [최신화] 쿨다운(15분)을 넘기려고 시계를 민다 */
  const tick = (ms = 20 * 60_000) => void (clock += ms);
  const seal = (o.seal as ReturnType<typeof fakeSeal>) ?? fakeSeal({ remember: o.remember });
  const sink = memoryBankSink();
  const store = memoryCodefStore();
  const link = new CodefLink({ client: new CodefClient({ egress: egress() }), seal, store, sink: () => (o.sink === false ? null : sink), onEvent: (e) => events.push(e), now: () => new Date(clock), dailyCalls: o.dailyCalls });
  return { link, seal, sink, store, events, tick };
}

beforeEach(() => {
  mock.calls = [];
  mock.scenario = {};
  mock.live.clear();
  gwMode = 'ok';
});

describe('CODEF 원천: 연결 → 계좌 고르기 → 최신화', () => {
  it('인증서 하나·비밀번호 한 번으로 보유계좌를 보이고, 고르면 첫 조회 뒤 CODEF 계정을 지운다', async () => {
    const { link, seal, sink, events, store, tick } = setup();
    const c = await link.connect({ certId: CERT, bank: '0020', clientType: 'B' });
    assert.equal(c.bankName, '우리은행');
    assert.deepEqual(c.accounts.map((a) => [a.last4, a.usable]), [['6789', true], ['8777', false]]);
    assert.ok(!JSON.stringify(c).includes(FAKE_ACCOUNT), '화면 응답에 전체 계좌번호가 없다');
    assert.equal(seal.asks, 1);
    // 계정 등록 요청: 기업·인증서 로그인·der/key·감싼 비밀번호, Bearer 토큰
    const create = mock.calls.find((x) => x.path === '/v1/account/create')!;
    assert.equal(create.auth, `Bearer ${FAKE_TOKEN}`);
    assert.deepEqual(create.body, { accountList: [{ countryCode: 'KR', businessType: 'BK', clientType: 'B', organization: '0020', loginType: '0', certType: '1', derFile: 'RkFLRS1ERVI=', keyFile: 'RkFLRS1LRVk=', password: 'RkFLRS1SU0E=' }] });
    assert.ok(mock.calls.some((x) => x.path === '/v1/kr/bank/b/account/account-list'));
    assert.equal(mock.live.size, 1, '고르기 전에는 남아 있다');

    const r = await link.choose({ sessionId: c.sessionId, key: 'a0' });
    assert.equal(r.newCount, 2);
    assert.equal(mock.live.size, 0, '첫 조회 뒤 connectedId 삭제');
    const tx = mock.calls.find((x) => x.path === '/v1/kr/bank/b/account/transaction-list')!;
    assert.equal(tx.body.account, FAKE_ACCOUNT);
    assert.equal(tx.body.endDate, '20261112');
    assert.equal(tx.body.startDate, '20260814');
    const rows = [...sink.rows.values()][0]!;
    assert.deepEqual(rows.map((x) => [x.occurredAt, x.direction, x.amount, x.payer]), [['2026-11-10 09:30:01', 'in', 1100000, '가나상사'], ['2026-11-11 14:00:00', 'out', 33000, '통신비']]);
    assert.ok(rows.every((x) => /^codef:[0-9a-f]{32}$/.test(x.rowKey)));
    const st = link.status();
    assert.equal(st.connected, true);
    assert.equal(st.last4, '6789');
    assert.ok(!JSON.stringify(store.get()).includes('cid'), '연결 상태에 connectedId가 남지 않는다');
    assert.ok(events.some((e) => e.phase === 'fetching') && events.at(-1)?.phase === 'done');

    // [최신화]: 다시 등록 → 조회 → 삭제. 같은 줄은 다시 들어가지 않는다(줄 열쇠), 새 줄만
    tick();
    mock.txns.push({ resAccountTrDate: '20261112', resAccountTrTime: '101500', resAccountOut: '0', resAccountIn: '550000', resAfterTranBalance: '5617000', resAccountDesc1: '다라상회', resAccountDesc2: '', resAccountDesc3: '', resAccountDesc4: '' });
    const r2 = await link.refresh();
    assert.equal(r2.rowCount, 3);
    assert.equal(r2.newCount, 1);
    assert.equal(mock.live.size, 0);
    assert.equal(seal.asks, 2, '기억하지 않았으면 [최신화]마다 묻는다');
    const tx2 = mock.calls.filter((x) => x.path.endsWith('/transaction-list')).at(-1)!;
    assert.equal(tx2.body.startDate, '20261108', '마지막 날 3일 전부터 겹쳐 받는다');
    mock.txns.pop();
  });

  it('[이 PC에 기억]을 골랐으면 [최신화]는 창 없이, [연결 해제]는 기억한 비밀번호를 지운다', async () => {
    const { link, seal, tick } = setup({ remember: true });
    const c = await link.connect({ certId: CERT });
    await link.choose({ sessionId: c.sessionId, key: 'a0' });
    tick();
    await link.refresh();
    assert.equal(seal.asks, 1);
    const d = await link.disconnect();
    assert.equal(d.disconnected, true);
    assert.equal(seal.forgets, 1);
    assert.equal(link.status().connected, false);
  });

  it('토큰 만료(CF-09992)면 토큰을 다시 받고 한 번만 다시 부른다', async () => {
    const { link } = setup();
    const before = tokenCalls;
    mock.scenario.tokenExpiredOnce = true;
    await link.connect({ certId: CERT });
    assert.equal(tokenCalls - before, 2);
    await link.cancel();
    assert.equal(mock.live.size, 0, '[취소]는 고르기 전 connectedId를 지운다');
  });

  it('지우기가 실패하면 적어 두고 [연결 해제] 때 다시 지운다', async () => {
    const { link, store } = setup();
    const c = await link.connect({ certId: CERT });
    mock.scenario.deleteFails = true;
    await link.choose({ sessionId: c.sessionId, key: 'a0' });
    assert.equal(store.get().orphans.length, 1);
    assert.equal(link.status().cleanupPending, 1);
    mock.scenario.deleteFails = false;
    const d = await link.disconnect();
    assert.equal(d.cleanupPending, 0);
    assert.equal(mock.live.size, 0);
  });
});

describe('CODEF 원천: 앱이 꺼져도 CODEF에 계정이 남지 않는다', () => {
  it('저장소가 아직 없으면(bank_not_ready) 고르기에서 바로 지운다', async () => {
    const s = setup({ sink: false });
    const c = await s.link.connect({ certId: CERT });
    await assert.rejects(s.link.choose({ sessionId: c.sessionId, key: 'a0' }), (e: unknown) => (e as CodefError).code === 'bank_not_ready');
    assert.equal(mock.live.size, 0, 'CODEF 계정이 남지 않는다');
    assert.equal(s.link.status().cleanupPending, 0);
  });

  it('고르기 전에 앱이 꺼지면 다음 실행의 sweep이 지운다', async () => {
    const s = setup();
    await s.link.connect({ certId: CERT });
    assert.equal(mock.live.size, 1);
    assert.equal(s.link.status().cleanupPending, 0, '고르기 대기 중인 것은 정리 대기로 세지 않는다');
    const next = new CodefLink({ client: new CodefClient({ egress: egress() }), seal: fakeSeal(), store: s.store, sink: () => s.sink });
    assert.equal(next.status().cleanupPending, 1, '꺼지기 전 만든 connectedId가 PC DB에 적혀 있다');
    await next.sweep();
    assert.equal(mock.live.size, 0);
    assert.equal(next.status().cleanupPending, 0);
  });

  it('[최신화] 중에 앱이 꺼져도 다음 실행의 sweep이 지운다', async () => {
    const s = setup();
    const c = await s.link.connect({ certId: CERT });
    await s.link.choose({ sessionId: c.sessionId, key: 'a0' });
    s.tick();
    mock.scenario.txnCode = 'CF-12100';
    mock.scenario.deleteFails = true;
    await assert.rejects(s.link.refresh());
    mock.scenario = {};
    const next = new CodefLink({ client: new CodefClient({ egress: egress() }), seal: fakeSeal(), store: s.store, sink: () => s.sink });
    await next.sweep();
    assert.equal(mock.live.size, 0);
  });

  it('다른 조회가 고르기 대기 중인 connectedId를 지우지 않는다', async () => {
    const s = setup();
    const c = await s.link.connect({ certId: CERT });
    await s.link.choose({ sessionId: c.sessionId, key: 'a0' });
    s.tick();
    const c2 = await s.link.connect({ certId: CERT });
    await s.link.sweep();
    assert.equal(mock.live.size, 1);
    await s.link.choose({ sessionId: c2.sessionId, key: 'a0' });
    assert.equal(mock.live.size, 0);
  });
});

describe('CODEF 원천: 오류 갈래(사람 말 코드)', () => {
  const cases: Array<[string, string, 'createCode' | 'createAsErrorList']> = [
    ['CF-12801', 'password_wrong', 'createCode'],
    ['CF-12856', 'password_locked', 'createAsErrorList'],
    ['CF-12806', 'cert_expired', 'createCode'],
    ['CF-12805', 'cert_not_registered', 'createAsErrorList'],
    ['CF-12810', 'cert_kind', 'createCode'],
    ['CF-03002', 'two_way_required', 'createCode'],
    ['CF-12100', 'bank_error', 'createCode'],
    ['CF-55555', 'rejected', 'createCode'],
  ];
  for (const [cf, code, how] of cases) {
    it(`${cf} → ${code}`, async () => {
      const { link, events } = setup();
      mock.scenario[how] = cf;
      await assert.rejects(link.connect({ certId: CERT }), (e: unknown) => e instanceof CodefError && e.code === code && e.cf === cf);
      assert.deepEqual(events.at(-1), { phase: 'error', code, cf });
      assert.equal(mock.live.size, 0);
    });
  }

  it('비밀번호가 틀렸고 기억해 둔 것을 썼으면 기억을 지운다', async () => {
    const { link, seal, tick } = setup({ remember: true });
    const c = await link.connect({ certId: CERT });
    await link.choose({ sessionId: c.sessionId, key: 'a0' });
    tick();
    mock.scenario.createCode = 'CF-12801';
    await assert.rejects(link.refresh(), (e: unknown) => e instanceof CodefError && e.code === 'password_wrong');
    assert.equal(seal.forgets, 1);
  });

  it('거래내역 조회가 실패해도 connectedId는 지운다', async () => {
    const { link } = setup();
    const c = await link.connect({ certId: CERT });
    mock.scenario.txnCode = 'CF-01004';
    await assert.rejects(link.choose({ sessionId: c.sessionId, key: 'a0' }), (e: unknown) => e instanceof CodefError && e.code === 'bank_busy');
    assert.equal(mock.live.size, 0);
  });

  it('금고 창 취소·인증서 없음·서버 꺼짐·저장소 없음', async () => {
    await assert.rejects(setup({ seal: fakeSeal({ result: { ok: false, reason: 'cancelled' } }) }).link.connect({ certId: CERT }), (e: unknown) => (e as CodefError).code === 'cancelled');
    await assert.rejects(setup({ seal: fakeSeal({ result: { ok: false, reason: 'not_found' } }) }).link.connect({ certId: CERT }), (e: unknown) => (e as CodefError).code === 'cert_missing');
    assert.equal(mock.calls.length, 0, '봉인 실패면 CODEF를 부르지 않는다');
    gwMode = 'off';
    await assert.rejects(new CodefClient({ egress: egress() }).token(), (e: unknown) => (e as CodefError).code === 'codef_off');
    gwMode = 'ok';
    const s = setup({ sink: false });
    const c = await s.link.connect({ certId: CERT });
    await assert.rejects(s.link.choose({ sessionId: c.sessionId, key: 'a0' }), (e: unknown) => (e as CodefError).code === 'bank_not_ready');
    await s.link.cancel();
  });
});

describe('CODEF 원천: 호출 아끼기(데모 하루 100회)', () => {
  it('[최신화]는 15분 안에 다시 하지 않는다(CODEF를 부르지 않음), 비밀번호 다시 넣기(ask)는 된다', async () => {
    const { link, tick } = setup();
    const c = await link.connect({ certId: CERT });
    await link.choose({ sessionId: c.sessionId, key: 'a0' });
    const n = mock.calls.length;
    await assert.rejects(link.refresh(), (e: unknown) => (e as CodefError).code === 'too_soon');
    assert.equal(mock.calls.length, n);
    await link.refresh({ ask: true });
    tick();
    await link.refresh();
  });

  it('하루 상한에 닿으면 daily_limit, 이미 만든 connectedId 삭제는 상한과 상관없이 한다', async () => {
    const { link } = setup({ dailyCalls: 2 });
    // create(1) + account-list(2) → 3번째(조회 없음)… 보유계좌까지는 되고, 고르기의 거래내역에서 막힌다
    const c = await link.connect({ certId: CERT });
    await assert.rejects(link.choose({ sessionId: c.sessionId, key: 'a0' }), (e: unknown) => (e as CodefError).code === 'daily_limit');
    assert.equal(mock.live.size, 0, '삭제는 상한에 막히지 않는다');
    assert.equal(link.status().callsLeft, 0);
    await assert.rejects(link.connect({ certId: CERT }), (e: unknown) => (e as CodefError).code === 'daily_limit');
  });

  it('같은 인증서 비밀번호가 하루 3번 틀리면 그날은 보내지 않는다, 맞으면 센 것을 지운다', async () => {
    const { link } = setup();
    mock.scenario.createCode = 'CF-12801';
    for (let i = 0; i < 3; i++) await assert.rejects(link.connect({ certId: CERT }), (e: unknown) => (e as CodefError).code === 'password_wrong');
    const n = mock.calls.length;
    await assert.rejects(link.connect({ certId: CERT }), (e: unknown) => (e as CodefError).code === 'password_retry_limit');
    assert.equal(mock.calls.length, n, 'CODEF를 부르지 않는다');
  });

  it('[연결 해제]해도 그날 비밀번호 상한은 그대로다', async () => {
    const { link, tick } = setup();
    const c = await link.connect({ certId: CERT });
    await link.choose({ sessionId: c.sessionId, key: 'a0' });
    mock.scenario.createCode = 'CF-12801';
    for (let i = 0; i < 3; i++) {
      tick();
      await assert.rejects(link.refresh({ ask: true }), (e: unknown) => (e as CodefError).code === 'password_wrong');
    }
    await link.disconnect();
    const n = mock.calls.length;
    await assert.rejects(link.connect({ certId: CERT }), (e: unknown) => (e as CodefError).code === 'password_retry_limit');
    assert.equal(mock.calls.length, n, '해제 뒤에도 CODEF를 부르지 않는다');
  });

  it('은행 잠김(CF-12802)도 [연결 해제]로 풀리지 않는다', async () => {
    const { link } = setup();
    const c = await link.connect({ certId: CERT });
    await link.choose({ sessionId: c.sessionId, key: 'a0' });
    mock.scenario.createCode = 'CF-12802';
    await assert.rejects(link.refresh({ ask: true }), (e: unknown) => (e as CodefError).code === 'password_locked');
    await link.disconnect();
    await assert.rejects(link.connect({ certId: CERT }), (e: unknown) => (e as CodefError).code === 'password_retry_limit');
  });
});

describe('CODEF 원천 어댑터(bank/source.ts TxnSource)', () => {
  it('연결한 계좌의 기간을 가져와 SourceRow로(비고1~4 순서, 비고1 = payer, sourceId null), 진행 requested→waiting→running→done, 조회 뒤 connectedId 삭제', async () => {
    const { link, tick, store } = setup();
    const c = await link.connect({ certId: CERT });
    await link.choose({ sessionId: c.sessionId, key: 'a0' });
    tick();
    const src = codefTxnSource(link);
    assert.equal(src.kind, 'auto');
    assert.equal(src.provider, 'codef');
    const accountId = store.get().link!.accountId;
    const prog: SourceProgress[] = [];
    const r = await src.fetch({ id: accountId, profileId: 'p1', bank: '우리은행', number: FAKE_ACCOUNT, last4: '6789' }, { from: '2026-11-01', to: '2026-11-12' }, { onProgress: (p) => prog.push(p) });
    assert.deepEqual(prog.map((p) => p.state), ['requested', 'waiting', 'running', 'done']);
    assert.deepEqual(r.range, { from: '2026-11-01', to: '2026-11-12' });
    assert.deepEqual(r.rows[0], { sourceId: null, occurredAt: '2026-11-10 09:30:01', deposit: 1100000, withdrawal: 0, balance: 5100000, remarks: ['가나상사', '타행이체', null, null], memo: null, payer: '가나상사' });
    assert.equal(r.rows[1]!.payer, null);
    assert.equal(mock.live.size, 0);
    const tx = mock.calls.filter((x) => x.path.endsWith('/transaction-list')).at(-1)!;
    assert.deepEqual([tx.body.startDate, tx.body.endDate, tx.body.account], ['20261101', '20261112', FAKE_ACCOUNT]);
  });

  it('실패는 SourceError(원천 코드), 연결 안 된 계좌는 source.not_linked, 15분 안 다시는 source.rate_limited', async () => {
    const { link, tick, store } = setup();
    const src = codefTxnSource(link);
    const acct = (id: string) => ({ id, profileId: 'p1', bank: '우리은행', number: FAKE_ACCOUNT, last4: '6789' });
    const range = { from: '2026-11-01', to: '2026-11-12' };
    await assert.rejects(src.fetch(acct('nope'), range, {}), (e: unknown) => e instanceof SourceError && e.code === 'source.not_linked');
    const c = await link.connect({ certId: CERT });
    await link.choose({ sessionId: c.sessionId, key: 'a0' });
    const id = store.get().link!.accountId;
    await assert.rejects(src.fetch(acct(id), range, {}), (e: unknown) => (e as SourceError).code === 'source.rate_limited');
    tick();
    mock.scenario.createCode = 'CF-12806';
    const prog: SourceProgress[] = [];
    await assert.rejects(src.fetch(acct(id), range, { onProgress: (p) => prog.push(p) }), (e: unknown) => (e as SourceError).code === 'source.cert_expired');
    assert.deepEqual(prog.at(-1), { state: 'failed', code: 'source.cert_expired' });
    // 표: 모든 실패 갈래에 원천 코드가 있다
    for (const v of Object.values(CODEF_SOURCE_CODES)) assert.match(v, /^source\.[a-z_]+$/);
    assert.equal(CODEF_SOURCE_CODES.two_way_required, 'source.needs_user');
    assert.equal(CODEF_SOURCE_CODES.password_wrong, 'source.login_failed');
  });
});

describe('CODEF 거래 줄 열쇠', () => {
  it('같은 거래는 같은 열쇠, 같은 값 두 줄은 순번으로 나뉜다, 모양이 틀린 줄은 건너뛴다', () => {
    const t = { date: '20261110', time: '093001', out: 0, in: 1000, balance: 5000, desc1: 'A', desc2: '', desc3: '', desc4: '', counterAccount: '' };
    const a = codefRows([t, { ...t }, { ...t, in: 0 }, { ...t, date: '2026-11' }]);
    assert.equal(a.rows.length, 2);
    assert.equal(a.skipped, 2);
    assert.notEqual(a.rows[0]!.rowKey, a.rows[1]!.rowKey);
    assert.deepEqual(codefRows([t, { ...t }]).rows.map((r) => r.rowKey), a.rows.map((r) => r.rowKey));
  });
});

describe('Egress.toCodef: 고정 목적지·경로·헤더', () => {
  it('목록 밖 경로·환경·토큰 모양은 보내지 않고, 감사 기록에는 본문·토큰이 없다', async () => {
    const e = egress();
    await assert.rejects(e.toCodef({ env: 'sandbox', path: '/v1/kr/card/p/account/approval-list' as never, body: {}, accessToken: FAKE_TOKEN }), (x: unknown) => (x as EgressError).code === 'path_not_allowed');
    await assert.rejects(e.toCodef({ env: 'staging' as never, path: '/v1/account/list', body: {}, accessToken: FAKE_TOKEN }), (x: unknown) => (x as EgressError).code === 'destination_not_allowed');
    await assert.rejects(e.toCodef({ env: 'sandbox', path: '/v1/account/list', body: {}, accessToken: 'bad\r\ntoken-xxxxxxxxxx' }), (x: unknown) => (x as EgressError).code === 'header_not_allowed');
    const r = await e.toCodef({ env: 'sandbox', path: '/v1/account/list', body: { connectedId: 'x' }, accessToken: FAKE_TOKEN });
    assert.equal((r.json as { result: { code: string } }).result.code, 'CF-04019');
    assert.deepEqual(e.audit, [{ dest: 'codef', path: '/v1/account/list', status: 200 }]);
    const tampered = new Egress({ testOrigins: { codef: codefOrigin }, env: { NODE_TLS_REJECT_UNAUTHORIZED: '0' } });
    await assert.rejects(tampered.toCodef({ env: 'sandbox', path: '/v1/account/list', body: {}, accessToken: FAKE_TOKEN }), (x: unknown) => (x as EgressError).code === 'egress_env_tampered');
  });

  it('codefToken 게이트웨이 호출은 빈 본문만', async () => {
    await assert.rejects(egress().toGateway({ surface: 'codefToken', body: { x: 1 } as never }), (x: unknown) => (x as EgressError).code === 'path_not_allowed');
  });
});
