// 계좌 자동조회 CODEF 원천(엔진): 모의 게이트웨이 + 모의 CODEF HTTP 서버(URL 인코딩 JSON). 실제 CODEF·은행을 부르지 않는다. 값은 모두 가짜다.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import { ColumnCipher, openDatabase, ProfileRepo, syntheticBizNo, type Db } from '@sax/db';
import { Egress, EgressError, decodeCodefBody, encodeCodefBody } from '../packages/net/src/index.ts';
import { bankServicePort, CODEF_SOURCE_CODES, CodefClient, CodefError, codefFailResult, CodefLink, codefTxnSource, memoryCodefStore, type CodefBankPort, type CodefEvent, type CodefSealPort, type SealResult } from '../packages/engine/src/codef/index.ts';
import { BankService, type RefreshJob } from '../packages/engine/src/bank/service.ts';
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
  scenario: { createCode?: string; createAsErrorList?: string; createByType?: Partial<Record<'B' | 'P', string>>; needWithdraw?: string; needWithdrawPass?: boolean; smsCode?: string; txnCode?: string; tokenExpiredOnce?: boolean; deleteFails?: boolean } = {};
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
      const entry = (body.accountList as Array<Record<string, unknown>>)?.[0] ?? {};
      const t = String(entry.clientType) as 'B' | 'P';
      // 우리은행 개인 뱅킹처럼 출금계좌번호를 요구한다(실기기 2026-11-19: CF-12401, 안내문에 commWithdrawAccountNo)
      if (t === 'P' && this.scenario.needWithdraw && entry.withdrawAccountNo !== this.scenario.needWithdraw) {
        return { result: { code: 'CF-12401', message: '로그인 파라미터가 누락되었습니다.', extraMessage: 'commWithdrawAccountNo' }, data: {} };
      }
      // 그다음 출금계좌 비밀번호(실기기 03:45: reqWithdrawAccountPass)
      if (t === 'P' && this.scenario.needWithdrawPass && typeof entry.withdrawAccountPassword !== 'string') {
        return { result: { code: 'CF-12401', message: '로그인 파라미터가 누락되었습니다.', extraMessage: 'reqWithdrawAccountPass' }, data: {} };
      }
      const byType = this.scenario.createByType?.[t];
      if (byType) return ok({ connectedId: '', successList: [], errorList: [{ code: byType, message: 'x', organization: '0020' }] });
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
      // 은행이 SMS 추가 인증을 요구한다(CODEF 개인 보유계좌 추가인증 출력부). 2차 요청의 번호가 맞아야 계좌를 준다
      if (this.scenario.smsCode && !(body.is2Way === true && body.smsAuthNo === this.scenario.smsCode && (body.twoWayInfo as { jti?: string })?.jti === 'jti0000000001')) {
        return { result: { code: 'CF-03002', message: '추가 인증 필요' }, data: { continue2Way: true, method: 'smsAuthNo', jobIndex: 0, threadIndex: 0, jti: 'jti0000000001', twoWayTimestamp: 1763500000000, extraInfo: { reqSMSAuthNo: '' } } };
      }
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

const ME = syntheticBizNo(70);
const BUYER = syntheticBizNo(71);
const opened: Array<{ db: Db; dir: string }> = [];

/**
 * 실제 돈 맞추기(BankService, 임시 DB) + 모의 CODEF. bank: false는 엔진 DB 전(bank_not_ready), 'no_consent'는 받을 돈 동의 전.
 * 받을 돈 건 하나(가나상사 1,100,000원)를 먼저 넣어 둔다. 모의 CODEF 첫 거래(가나상사 입금 1,100,000원)와 맞는다.
 */
async function setup(o: { remember?: boolean; seal?: CodefSealPort; bank?: false | 'no_consent'; dailyCalls?: number } = {}) {
  const events: CodefEvent[] = [];
  let clock = Date.parse('2026-11-12T03:00:00Z');
  /** [최신화] 쿨다운(15분)을 넘기려고 시계를 민다 */
  const tick = (ms = 20 * 60_000) => void (clock += ms);
  const seal = (o.seal as ReturnType<typeof fakeSeal>) ?? fakeSeal({ remember: o.remember });
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'sax-codef-'));
  const db = openDatabase(path.join(dir, 'db.sqlite'), new Uint8Array(randomBytes(32)));
  opened.push({ db, dir });
  const pid = new ProfileRepo(db).upsert({ kind: 'business', displayName: '하늘상회', bizNo: ME, corpNo: null, repName: '김하늘', bizType: null, bizItem: null, address: null, email: null, signMethod: null }).id;
  const svc = new BankService(db, new ColumnCipher(new Uint8Array(randomBytes(32))), new Uint8Array(randomBytes(32)), { vaultDir: path.join(dir, 'vault'), now: () => new Date(clock) });
  const call = <T = unknown>(m: string, p: Record<string, unknown> = {}) => svc.handle(m, { profileId: pid, ...p }) as Promise<T>;
  if (o.bank !== 'no_consent') await call('bank.consent', { version: '09-v1' });
  if (o.bank !== 'no_consent') await call('bank.importInvoices', { rows: [{ approvalNo: '202610204100000010000000', writtenOn: '2026-10-20', supplierBizNo: ME, buyerBizNo: BUYER, buyerName: '가나상사', total: 1_100_000, supply: 1_000_000, tax: 100_000 }] });
  const port: CodefBankPort = bankServicePort(svc, db);
  const store = memoryCodefStore();
  const mk = (st = store) => new CodefLink({ client: new CodefClient({ egress: egress() }), seal, store: st, bank: () => (o.bank === false ? null : port), onEvent: (e) => events.push(e), now: () => new Date(clock), dailyCalls: o.dailyCalls });
  const link = mk();
  svc.registerSource(codefTxnSource(link));
  /** 받을 돈 최신화가 끝날 때까지 */
  const settle = async (accountId: string): Promise<RefreshJob> => {
    for (let i = 0; i < 200; i++) {
      const j = await call<RefreshJob | null>('db.query.bank.refreshStatus', { accountId });
      if (j && (j.state === 'done' || j.state === 'failed')) return j;
      await new Promise((r) => setTimeout(r, 5));
    }
    throw new Error('refresh did not settle');
  };
  const account = (id: string) => svc.repo.account(id)!;
  return { link, mk, seal, store, events, tick, svc, call, pid, settle, account };
}

beforeEach(() => {
  mock.calls = [];
  mock.scenario = {};
  mock.live.clear();
  gwMode = 'ok';
});
afterEach(() => {
  for (const x of opened.splice(0)) {
    x.db.close();
    fs.rmSync(x.dir, { recursive: true, force: true });
  }
});

const paths = () => mock.calls.map((x) => x.path.replace(/^\/v1\/kr\/bank\/[bp]\/account\//, ''));

describe('CODEF 원천: 연결 → 계좌 고르기 → 받을 돈', () => {
  it('인증서 하나·비밀번호 한 번으로 보유계좌를 보이고, 고르면 받을 돈 계좌로 잇고 같은 connectedId로 첫 조회 → 넣기 → 맞추기 → 삭제', async () => {
    const { link, seal, events, store, settle, call, account } = await setup();
    const c = await link.connect({ certId: CERT, bank: '0020', clientType: 'B' });
    assert.equal(c.bankName, '우리은행');
    assert.deepEqual(c.accounts.map((a) => [a.last4, a.usable]), [['6789', true], ['8777', false]]);
    assert.ok(!JSON.stringify(c).includes(FAKE_ACCOUNT), '화면 응답에 전체 계좌번호가 없다');
    const create = mock.calls.find((x) => x.path === '/v1/account/create')!;
    assert.equal(create.auth, `Bearer ${FAKE_TOKEN}`);
    assert.deepEqual(create.body, { accountList: [{ countryCode: 'KR', businessType: 'BK', clientType: 'B', organization: '0020', loginType: '0', certType: '1', derFile: 'RkFLRS1ERVI=', keyFile: 'RkFLRS1LRVk=', password: 'RkFLRS1SU0E=' }] });
    assert.equal(mock.live.size, 1, '고르기 전에는 남아 있다');

    const r = await link.choose({ sessionId: c.sessionId, key: 'a0' });
    assert.equal(r.last4, '6789');
    const job = await settle(r.accountId);
    assert.equal(job.state, 'done', JSON.stringify(job));
    assert.equal(seal.asks, 1, '첫 조회는 비밀번호를 다시 묻지 않는다');
    assert.deepEqual(paths(), ['/v1/account/create', 'account-list', 'transaction-list', '/v1/account/delete'], '등록 한 번으로 보유계좌·거래내역, 그 뒤 삭제');
    assert.equal(mock.live.size, 0);
    const tx = mock.calls.find((x) => x.path.endsWith('/transaction-list'))!;
    assert.equal(tx.body.account, FAKE_ACCOUNT);
    assert.equal(tx.body.endDate, '20261112');
    assert.equal(tx.body.startDate, '20260814', '돈 맞추기가 정한 첫 기간(90일)');
    assert.deepEqual(job.result, { rows: 2, newCount: 2, duplicateCount: 0, match: { auto: 0, review: 1, unknown: 0 } });

    const acct = account(r.accountId);
    assert.deepEqual([acct.linkState, acct.linkProvider, acct.last4, acct.bank], ['auto_connected', 'codef', '6789', '우리은행']);
    const o = await call<{ review: Array<{ payer: string | null; amount: number; accountLast4: string; candidates: Array<{ cpName: string | null; total: number }> }> }>('db.query.bank.overview');
    assert.deepEqual(o.review.map((t) => [t.payer, t.amount, t.accountLast4, t.candidates[0]?.cpName, t.candidates[0]?.total]), [['가나상사', 1_100_000, '6789', '가나상사', 1_100_000]], '가나상사 입금이 받을 돈 건의 후보로 들어왔다');
    assert.ok(!JSON.stringify(store.get()).includes('cid'), '연결 상태에 connectedId가 남지 않는다');
    assert.deepEqual([events.some((e) => e.phase === 'accounts'), events.at(-1)?.phase], [true, 'done']);
    assert.equal(link.status().connected, true);
  });

  it('파일로 먼저 넣은 같은 번호의 계좌가 있으면 그 계좌를 잇는다(새로 만들지 않음)', async () => {
    const { link, call, settle } = await setup();
    const a = await call<{ id: string }>('bank.addAccount', { bank: '우리은행', number: FAKE_ACCOUNT, alias: '주거래' });
    const c = await link.connect({ certId: CERT });
    const r = await link.choose({ sessionId: c.sessionId, key: 'a0' });
    assert.equal(r.accountId, a.id);
    await settle(r.accountId);
    assert.equal((await call<unknown[]>('db.query.bank.accounts')).length, 1);
  });

  it('받을 돈 [최신화]는 원천으로 다시 등록 → 거래내역 → 삭제, 같은 줄은 다시 들어가지 않는다', async () => {
    const { link, seal, tick, call, settle } = await setup();
    const c = await link.connect({ certId: CERT });
    const r = await link.choose({ sessionId: c.sessionId, key: 'a0' });
    await settle(r.accountId);
    tick();
    mock.txns.push({ resAccountTrDate: '20261112', resAccountTrTime: '101500', resAccountOut: '0', resAccountIn: '550000', resAfterTranBalance: '5617000', resAccountDesc1: '다라상회', resAccountDesc2: '', resAccountDesc3: '', resAccountDesc4: '' });
    mock.calls = [];
    await call('bank.refresh', { accountId: r.accountId });
    const j = await settle(r.accountId);
    mock.txns.pop();
    assert.equal(j.state, 'done', JSON.stringify(j));
    assert.equal(j.result!.newCount, 1);
    assert.equal(seal.asks, 2, '기억하지 않았으면 최신화마다 묻는다');
    assert.deepEqual(paths(), ['/v1/account/create', 'transaction-list', '/v1/account/delete']);
    assert.equal(mock.live.size, 0);
  });

  it('[이 PC에 기억]을 골랐으면 최신화는 창 없이, [연결 해제]는 기억한 비밀번호를 지우고 계좌를 파일만으로', async () => {
    const { link, seal, tick, call, settle, account } = await setup({ remember: true });
    const c = await link.connect({ certId: CERT });
    const r = await link.choose({ sessionId: c.sessionId, key: 'a0' });
    await settle(r.accountId);
    tick();
    assert.deepEqual(await link.refresh(), { started: true });
    assert.equal((await settle(r.accountId)).state, 'done');
    assert.equal(seal.asks, 1);
    const d = await link.disconnect();
    assert.equal(d.disconnected, true);
    assert.equal(seal.forgets, 1);
    assert.equal(link.status().connected, false);
    assert.equal(account(r.accountId).linkState, 'file_only', '계좌·거래는 두고 연결만 끊는다');
    await assert.rejects(call('bank.refresh', { accountId: r.accountId }), (e: unknown) => (e as { code?: string }).code === 'source.not_linked');
  });

  it('토큰 만료(CF-09992)면 토큰을 다시 받고 한 번만 다시 부른다', async () => {
    const { link } = await setup();
    const before = tokenCalls;
    mock.scenario.tokenExpiredOnce = true;
    await link.connect({ certId: CERT });
    assert.equal(tokenCalls - before, 2);
    await link.cancel();
    assert.equal(mock.live.size, 0, '[취소]는 고르기 전 connectedId를 지운다');
  });

  it('지우기가 실패하면 적어 두고 [연결 해제] 때 다시 지운다', async () => {
    const { link, store, settle } = await setup();
    const c = await link.connect({ certId: CERT });
    mock.scenario.deleteFails = true;
    const r = await link.choose({ sessionId: c.sessionId, key: 'a0' });
    await settle(r.accountId);
    assert.equal(store.get().orphans.length, 1);
    assert.equal(link.status().cleanupPending, 1);
    mock.scenario.deleteFails = false;
    const d = await link.disconnect();
    assert.equal(d.cleanupPending, 0);
    assert.equal(mock.live.size, 0);
  });
});

describe('CODEF 원천: 앱이 꺼져도 CODEF에 계정이 남지 않는다', () => {
  it('엔진 DB 전(bank_not_ready)·받을 돈 동의 전이면 CODEF를 부르기 전에 멈춘다', async () => {
    const a = await setup({ bank: false });
    await assert.rejects(a.link.connect({ certId: CERT }), (e: unknown) => (e as CodefError).code === 'bank_not_ready');
    const b = await setup({ bank: 'no_consent' });
    await assert.rejects(b.link.connect({ certId: CERT }), (e: unknown) => (e as CodefError).code === 'bank_consent_required');
    assert.equal(mock.calls.length, 0);
    assert.equal(a.seal.asks + b.seal.asks, 0, '비밀번호도 묻지 않는다');
  });

  it('고르기 전에 앱이 꺼지면 다음 실행의 sweep이 지운다', async () => {
    const s = await setup();
    await s.link.connect({ certId: CERT });
    assert.equal(mock.live.size, 1);
    assert.equal(s.link.status().cleanupPending, 0, '고르기 대기 중인 것은 정리 대기로 세지 않는다');
    const next = s.mk();
    assert.equal(next.status().cleanupPending, 1, '꺼지기 전 만든 connectedId가 PC DB에 적혀 있다');
    await next.sweep();
    assert.equal(mock.live.size, 0);
    assert.equal(next.status().cleanupPending, 0);
  });

  it('최신화 중에 삭제가 실패하고 앱이 꺼져도 다음 실행의 sweep이 지운다', async () => {
    const s = await setup();
    const c = await s.link.connect({ certId: CERT });
    const r = await s.link.choose({ sessionId: c.sessionId, key: 'a0' });
    await s.settle(r.accountId);
    s.tick();
    mock.scenario.txnCode = 'CF-12100';
    mock.scenario.deleteFails = true;
    await s.call('bank.refresh', { accountId: r.accountId });
    assert.equal((await s.settle(r.accountId)).code, 'source.bank_error');
    mock.scenario = {};
    await s.mk().sweep();
    assert.equal(mock.live.size, 0);
  });

  it('다른 일이 고르기 대기 중인 connectedId를 지우지 않는다', async () => {
    const s = await setup();
    const c = await s.link.connect({ certId: CERT });
    const r = await s.link.choose({ sessionId: c.sessionId, key: 'a0' });
    await s.settle(r.accountId);
    const c2 = await s.link.connect({ certId: CERT });
    await s.link.sweep();
    assert.equal(mock.live.size, 1);
    await s.link.cancel();
    assert.equal(mock.live.size, 0);
    assert.ok(c2.sessionId);
  });

  it('계좌를 골랐는데 최신화를 시작하지 못하면 connectedId를 바로 지운다', async () => {
    const s = await setup();
    const c = await s.link.connect({ certId: CERT });
    const orig = s.svc.handle.bind(s.svc);
    s.svc.handle = (m: string, p: Record<string, unknown>) => (m === 'bank.refresh' ? Promise.reject(new Error('boom')) : orig(m, p));
    await s.link.choose({ sessionId: c.sessionId, key: 'a0' });
    assert.equal(mock.live.size, 0);
    assert.equal(s.link.status().cleanupPending, 0);
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
    ['CF-12831', 'identity_required', 'createCode'],
    ['CF-12811', 'banking_kind', 'createCode'],
    ['CF-12812', 'not_enrolled', 'createCode'],
    ['CF-12100', 'bank_error', 'createCode'],
    ['CF-55555', 'rejected', 'createCode'],
  ];
  for (const [cf, code, how] of cases) {
    it(`${cf} → ${code}`, async () => {
      const { link, events } = await setup();
      mock.scenario[how] = cf;
      await assert.rejects(link.connect({ certId: CERT }), (e: unknown) => e instanceof CodefError && e.code === code && e.cf === cf);
      const last = { ...events.at(-1)! };
      delete last.hint;
      assert.deepEqual(last, { phase: 'error', code, cf });
      assert.equal(mock.live.size, 0);
    });
  }

  it('비밀번호가 틀렸고 기억해 둔 것을 썼으면 기억을 지운다', async () => {
    const { link, seal, tick, call, settle } = await setup({ remember: true });
    const c = await link.connect({ certId: CERT });
    const r = await link.choose({ sessionId: c.sessionId, key: 'a0' });
    await settle(r.accountId);
    tick();
    mock.scenario.createCode = 'CF-12801';
    await call('bank.refresh', { accountId: r.accountId });
    assert.equal((await settle(r.accountId)).code, 'source.login_failed');
    assert.equal(seal.forgets, 1);
  });

  it('첫 조회가 실패해도 connectedId는 지우고, 받을 돈 계좌는 자동 오류로', async () => {
    const { link, settle, account } = await setup();
    const c = await link.connect({ certId: CERT });
    mock.scenario.txnCode = 'CF-01004';
    const r = await link.choose({ sessionId: c.sessionId, key: 'a0' });
    const j = await settle(r.accountId);
    assert.deepEqual([j.state, j.code], ['failed', 'source.bank_busy']);
    assert.equal(mock.live.size, 0);
    assert.deepEqual([account(r.accountId).linkState, account(r.accountId).linkError], ['auto_error', 'source.bank_busy']);
  });

  it('금고 창 취소·인증서 없음·서버 꺼짐', async () => {
    await assert.rejects((await setup({ seal: fakeSeal({ result: { ok: false, reason: 'cancelled' } }) })).link.connect({ certId: CERT }), (e: unknown) => (e as CodefError).code === 'cancelled');
    await assert.rejects((await setup({ seal: fakeSeal({ result: { ok: false, reason: 'not_found' } }) })).link.connect({ certId: CERT }), (e: unknown) => (e as CodefError).code === 'cert_missing');
    assert.equal(mock.calls.length, 0, '봉인 실패면 CODEF를 부르지 않는다');
    gwMode = 'off';
    await assert.rejects(new CodefClient({ egress: egress() }).token(), (e: unknown) => (e as CodefError).code === 'codef_off');
    gwMode = 'ok';
  });
});

const fetchOf = (link: CodefLink, accountId: string) =>
  codefTxnSource(link).fetch({ id: accountId, profileId: 'p1', bank: '우리은행', number: FAKE_ACCOUNT, last4: '6789' }, { from: '2026-11-01', to: '2026-11-12' }, {});
const sourceCode = (code: string) => (e: unknown) => e instanceof SourceError && e.code === code;

async function connected(o: Parameters<typeof setup>[0] = {}) {
  const s = await setup(o);
  const c = await s.link.connect({ certId: CERT });
  const r = await s.link.choose({ sessionId: c.sessionId, key: 'a0' });
  await s.settle(r.accountId);
  return { ...s, accountId: r.accountId };
}

describe('CODEF 원천: 호출 아끼기(데모 하루 100회)', () => {
  it('[최신화]는 15분 안에 다시 하지 않는다(CODEF를 부르지 않음)', async () => {
    const { link, tick, accountId } = await connected();
    const n = mock.calls.length;
    await assert.rejects(link.refresh(), (e: unknown) => (e as CodefError).code === 'too_soon');
    await assert.rejects(fetchOf(link, accountId), sourceCode('source.too_soon'));
    assert.equal(mock.calls.length, n);
    tick();
    await fetchOf(link, accountId);
  });

  it('하루 상한에 닿으면 daily_limit, 이미 만든 connectedId 삭제는 상한과 상관없이 한다', async () => {
    const { link, settle, call } = await setup({ dailyCalls: 2 });
    const c = await link.connect({ certId: CERT });
    const r = await link.choose({ sessionId: c.sessionId, key: 'a0' });
    assert.equal((await settle(r.accountId)).code, 'source.daily_limit', '등록·보유계좌 2회 뒤 거래내역에서 막힌다');
    assert.equal(mock.live.size, 0, '삭제는 상한에 막히지 않는다');
    assert.equal(link.status().callsLeft, 0);
    await assert.rejects(link.connect({ certId: CERT }), (e: unknown) => (e as CodefError).code === 'daily_limit');
    await assert.rejects(link.refresh(), (e: unknown) => (e as CodefError).code === 'daily_limit');
    void call;
  });

  it('같은 인증서 비밀번호가 하루 3번 틀리면 그날은 보내지 않는다', async () => {
    const { link } = await setup();
    mock.scenario.createCode = 'CF-12801';
    for (let i = 0; i < 3; i++) await assert.rejects(link.connect({ certId: CERT }), (e: unknown) => (e as CodefError).code === 'password_wrong');
    const n = mock.calls.length;
    await assert.rejects(link.connect({ certId: CERT }), (e: unknown) => (e as CodefError).code === 'password_retry_limit');
    assert.equal(mock.calls.length, n, 'CODEF를 부르지 않는다');
  });

  it('[연결 해제]해도 그날 비밀번호 상한은 그대로다', async () => {
    const { link, tick, accountId } = await connected();
    mock.scenario.createCode = 'CF-12801';
    for (let i = 0; i < 3; i++) {
      tick();
      await assert.rejects(fetchOf(link, accountId), sourceCode('source.login_failed'));
    }
    await link.disconnect();
    const n = mock.calls.length;
    await assert.rejects(link.connect({ certId: CERT }), (e: unknown) => (e as CodefError).code === 'password_retry_limit');
    assert.equal(mock.calls.length, n, '해제 뒤에도 CODEF를 부르지 않는다');
  });

  it('은행 잠김(CF-12802)도 [연결 해제]로 풀리지 않는다', async () => {
    const { link, tick, accountId } = await connected();
    tick();
    mock.scenario.createCode = 'CF-12802';
    await assert.rejects(fetchOf(link, accountId), sourceCode('source.login_locked'));
    await link.disconnect();
    await assert.rejects(link.connect({ certId: CERT }), (e: unknown) => (e as CodefError).code === 'password_retry_limit');
  });
});

describe('CODEF 원천 어댑터(bank/source.ts TxnSource)', () => {
  it('연결한 계좌의 기간을 가져와 SourceRow로(비고1~4 순서, 비고1 = payer, sourceId null), 진행 requested→waiting→running→done, 조회 뒤 connectedId 삭제', async () => {
    const { link, tick, accountId } = await connected();
    tick();
    const src = codefTxnSource(link);
    assert.equal(src.kind, 'auto');
    assert.equal(src.provider, 'codef');
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

  it('실패는 SourceError(원천 코드), 연결 안 된 계좌는 source.not_linked', async () => {
    const { link, tick, accountId } = await connected();
    await assert.rejects(fetchOf(link, 'nope'), sourceCode('source.not_linked'));
    tick();
    mock.scenario.createCode = 'CF-12806';
    const prog: SourceProgress[] = [];
    await assert.rejects(
      codefTxnSource(link).fetch({ id: accountId, profileId: 'p1', bank: '우리은행', number: FAKE_ACCOUNT, last4: '6789' }, { from: '2026-11-01', to: '2026-11-12' }, { onProgress: (p) => prog.push(p) }),
      sourceCode('source.cert_expired'),
    );
    assert.deepEqual(prog.at(-1), { state: 'failed', code: 'source.cert_expired' });
    for (const v of Object.values(CODEF_SOURCE_CODES)) assert.match(v, /^source\.[a-z_]+$/);
    assert.equal(CODEF_SOURCE_CODES.two_way_required, 'source.needs_user');
    assert.equal(CODEF_SOURCE_CODES.password_wrong, 'source.login_failed');
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

describe('CODEF: 기업·개인 뱅킹을 사람이 고르지 않는다(대표 2026-11-19)', () => {
  const creates = () => mock.calls.filter((c) => c.path === '/v1/account/create').map((c) => String((c.body.accountList as Array<Record<string, unknown>>)[0]!.clientType));
  it('개인 뱅킹이 안 되면 같은 비밀번호로 기업 뱅킹을 해 보고 되는 쪽 계좌를 보여 준다(금고 창은 한 번)', async () => {
    const { link, seal, events } = await setup();
    mock.scenario.createByType = { P: 'CF-12805' };
    const r = await link.connect({ certId: CERT });
    assert.deepEqual(creates(), ['P', 'B']);
    assert.equal(r.accounts.length, 2);
    assert.equal(seal.asks, 1);
    assert.ok(events.some((e) => e.phase === 'next_banking' && e.clientType === 'P' && e.cf === 'CF-12805'), '넘어간 뱅킹의 거절도 남는다');
    assert.ok(mock.calls.some((c) => c.path === '/v1/kr/bank/b/account/account-list'));
  });
  it('개인 뱅킹이 되면 기업 뱅킹은 부르지 않는다(기업 뱅킹이 본인인증을 요구해도 사장님은 모른다)', async () => {
    const { link } = await setup();
    mock.scenario.createByType = { B: 'CF-12831' };
    const r = await link.connect({ certId: CERT });
    assert.deepEqual(creates(), ['P']);
    assert.equal(r.accounts.length, 2);
  });
  it('둘 다 안 되면 사람이 할 일이 분명한 쪽(본인인증)을 그 뱅킹과 함께 알린다', async () => {
    const { link } = await setup();
    mock.scenario.createByType = { P: 'CF-12401', B: 'CF-12831' };
    await assert.rejects(link.connect({ certId: CERT }), (e: unknown) => e instanceof CodefError && e.code === 'identity_required' && e.clientType === 'B');
    assert.deepEqual(creates(), ['P', 'B']);
  });
  it('비밀번호가 틀리면 다른 뱅킹을 해 보지 않는다(인증서 잠김 방지)', async () => {
    const { link } = await setup();
    mock.scenario.createByType = { P: 'CF-12801' };
    await assert.rejects(link.connect({ certId: CERT }), (e: unknown) => e instanceof CodefError && e.code === 'password_wrong');
    assert.deepEqual(creates(), ['P']);
  });
  it('화면이 하나를 정해 보내면 그것만 한다', async () => {
    const { link } = await setup();
    await link.connect({ certId: CERT, clientType: 'P' });
    assert.deepEqual(creates(), ['P']);
  });
});

describe('CODEF: 은행 SMS 추가 인증을 카드 안 칸 하나로(2-way)', () => {
  it('보유계좌가 SMS를 요구하면 sms 단계로 멈추고, 번호가 맞으면 계좌를 보여 준다. 번호는 어디에도 남지 않는다', async () => {
    const { link, store, events } = await setup();
    mock.scenario.smsCode = '482913';
    const r = await link.connect({ certId: CERT });
    assert.equal(r.step, 'sms');
    assert.equal(r.accounts.length, 0);
    assert.equal(mock.live.size, 1, '번호를 기다리는 동안 connectedId를 붙잡아 둔다');
    // 틀린 번호: 은행이 다시 요구한다 → 같은 sms 단계
    const again = await link.sms({ sessionId: r.sessionId, code: '000000' });
    assert.equal(again.step, 'sms');
    const ok = await link.sms({ sessionId: again.sessionId, code: '482 913' });
    assert.equal(ok.step, undefined);
    assert.equal(ok.accounts.length, 2);
    const last = mock.calls.filter((c) => c.path.endsWith('/account-list')).at(-1)!;
    assert.equal(last.body.is2Way, true);
    assert.deepEqual(last.body.twoWayInfo, { jobIndex: 0, threadIndex: 0, jti: 'jti0000000001', twoWayTimestamp: 1763500000000 });
    assert.ok(events.some((e) => e.phase === 'sms'));
    assert.doesNotMatch(JSON.stringify({ store: store.get(), events, status: link.status() }), /482913|482 913/);
  });
  it('세션이 다르거나 번호 모양이 아니면 받지 않고, 세 번 틀리면 붙잡은 connectedId를 지운다', async () => {
    const { link } = await setup();
    mock.scenario.smsCode = '482913';
    let r = await link.connect({ certId: CERT, clientType: 'P' });
    await assert.rejects(link.sms({ sessionId: 'nope', code: '482913' }), (e: unknown) => e instanceof CodefError && e.code === 'session_lost');
    await assert.rejects(link.sms({ sessionId: r.sessionId, code: 'abc' }), (e: unknown) => e instanceof CodefError && e.code === 'sms_wrong');
    for (let i = 0; i < 3; i++) r = await link.sms({ sessionId: r.sessionId, code: '111111' });
    await assert.rejects(link.sms({ sessionId: r.sessionId, code: '111111' }), (e: unknown) => e instanceof CodefError && e.code === 'sms_wrong');
    assert.equal(mock.live.size, 0);
  });
});

describe('CODEF: 뱅킹 순서는 고객 데이터로(대표 2026-11-19 "모든 고객을 상정해야지")', async () => {
  const { bankingOrder } = await import('../packages/engine/src/codef/link.ts');
  it('법인 사업장은 기업 뱅킹만, 개인사업자는 인증서 종류로 순서를 정한다', () => {
    assert.deepEqual(bankingOrder({ corporate: true, prefer: 'P' }), ['B']);
    assert.deepEqual(bankingOrder({ corporate: false, prefer: 'B' }), ['B', 'P']);
    assert.deepEqual(bankingOrder({ corporate: false, prefer: 'P' }), ['P', 'B']);
    assert.deepEqual(bankingOrder({ corporate: false }), ['P', 'B'], '모르면 개인 먼저(1인 사업자는 개인 뱅킹으로 사업자 계좌를 본다)');
    assert.deepEqual(bankingOrder({ explicit: 'B', corporate: false, prefer: 'P' }), ['B']);
  });
  it('시작할 때 순서를 로그 이벤트로 남긴다', async () => {
    const { link, events } = await setup();
    await link.connect({ certId: CERT, prefer: 'B' });
    assert.ok(events.some((e) => e.phase === 'order' && e.order === 'BP'));
  });
});

describe('CODEF: 은행이 출금계좌번호를 요구하면(우리은행 개인 뱅킹 CF-12401 commWithdrawAccountNo)', () => {
  const creates = () => mock.calls.filter((c) => c.path === '/v1/account/create').map((c) => (c.body.accountList as Array<Record<string, unknown>>)[0]!);
  it('모르면 계좌번호 한 칸을 묻는다(기업 뱅킹 본인인증보다 먼저)', async () => {
    const { link } = await setup();
    mock.scenario.needWithdraw = FAKE_ACCOUNT;
    mock.scenario.createByType = { B: 'CF-12831' };
    await assert.rejects(link.connect({ certId: CERT }), (e: unknown) => e instanceof CodefError && e.code === 'withdraw_account_required' && e.clientType === 'P');
  });
  it('기업 뱅킹 본인인증도 함께 알리고(also), 마지막 뱅킹의 거절도 로그에 남는다(2026-11-19 실기기: 라프·우리은행)', async () => {
    const { link, events } = await setup();
    mock.scenario.needWithdraw = FAKE_ACCOUNT;
    mock.scenario.createByType = { B: 'CF-12831' };
    let caught: CodefError | null = null;
    await link.connect({ certId: CERT }).catch((e: unknown) => void (caught = e as CodefError));
    const e = caught as CodefError | null;
    assert.ok(e instanceof CodefError);
    assert.equal(e.code, 'withdraw_account_required');
    assert.deepEqual(e.also, { clientType: 'B', code: 'identity_required' });
    assert.ok(events.some((x) => x.phase === 'next_banking' && x.clientType === 'P' && x.code === 'withdraw_account_required'));
    assert.ok(events.some((x) => x.phase === 'banking_failed' && x.clientType === 'B' && x.cf === 'CF-12831'), '마지막 뱅킹(기업)의 거절도 남는다');
    // 화면으로 가는 결과에는 코드만(값·빠진 키·단서 없음)
    const r = codefFailResult(e);
    assert.deepEqual(r, { ok: false, code: 'withdraw_account_required', cf: 'CF-12401', clientType: 'P', also: { clientType: 'B', code: 'identity_required' } });
  });
  it('다른 뱅킹의 실패가 사람이 할 일이 아니면 also를 붙이지 않는다', async () => {
    const { link } = await setup();
    mock.scenario.needWithdraw = FAKE_ACCOUNT;
    mock.scenario.createByType = { B: 'CF-12100' };
    await assert.rejects(link.connect({ certId: CERT }), (e: unknown) => e instanceof CodefError && e.code === 'withdraw_account_required' && e.also === null);
  });
  it('사람이 넣은 계좌번호로 같은 비밀번호로 이어 간다(금고 창 한 번)', async () => {
    const { link, seal } = await setup();
    mock.scenario.needWithdraw = FAKE_ACCOUNT;
    const r = await link.connect({ certId: CERT, withdrawAccount: '1002-123-456789' });
    assert.equal(r.accounts.length, 2);
    assert.equal(seal.asks, 1);
    assert.equal(creates().at(-1)!.commWithdrawAccountNo, FAKE_ACCOUNT);
  });
  it('넣은 번호로도 같은 요구면 계좌번호를 다시 묻는다(기업 뱅킹 본인인증 안내가 덮지 않는다)', async () => {
    const { link } = await setup();
    mock.scenario.needWithdraw = '9999999999';
    mock.scenario.createByType = { B: 'CF-12831' };
    await assert.rejects(link.connect({ certId: CERT, withdrawAccount: FAKE_ACCOUNT }), (e: unknown) => e instanceof CodefError && e.code === 'withdraw_account_required' && e.param === 'retried');
  });
  it('계좌 비밀번호도 요구하면 금고 창(계좌 비밀번호 모드)에서 받아 감싸 보낸다', async () => {
    const fields: Array<string | undefined> = [];
    const base = fakeSeal();
    const seal = { ...base, async seal(p: { certId: string; publicKey: string; mode: 'ask' | 'auto'; field?: 'account' }) { fields.push(p.field); return base.seal(p); } };
    const { link } = await setup({ seal });
    mock.scenario.needWithdraw = FAKE_ACCOUNT;
    mock.scenario.needWithdrawPass = true;
    const r = await link.connect({ certId: CERT, withdrawAccount: FAKE_ACCOUNT });
    assert.equal(r.accounts.length, 2);
    assert.deepEqual(fields, [undefined, 'account'], '인증서 비밀번호 한 번, 계좌 비밀번호 한 번');
    assert.equal(typeof creates().at(-1)!.withdrawAccountPassword, 'string');
  });
  it('받을 돈에 넣어 둔 같은 은행 계좌가 있으면 묻지 않고 쓴다', async () => {
    const { link, call } = await setup();
    await call('bank.addAccount', { bank: '0020', number: FAKE_ACCOUNT, alias: null });
    mock.scenario.needWithdraw = FAKE_ACCOUNT;
    const r = await link.connect({ certId: CERT });
    assert.equal(r.accounts.length, 2);
    assert.equal(creates().at(-1)!.commWithdrawAccountNo, FAKE_ACCOUNT);
  });
});

describe('CODEF CF-12401(로그인 파라미터 누락): 빠진 키 이름만 고른다', async () => {
  const { missingParamOf } = await import('../packages/engine/src/codef/client.ts');
  it('단서는 CODEF 안내문 단어만, 숫자는 지운다', async () => {
    const { hintOf } = await import('../packages/engine/src/codef/client.ts');
    assert.equal(hintOf('로그인 파라미터가 누락되었습니다. [birthDate] 900101 id'), 'birthDate_id');
    assert.equal(hintOf('로그인 파라미터가 누락되었습니다.'), null);
    assert.equal(hintOf(''), null);
  });
  it('원문에서 계정 등록 키 이름만, 값·다른 글자는 버린다', () => {
    assert.equal(missingParamOf('로그인 파라미터가 누락되었습니다. birthDate'), 'birthDate');
    assert.equal(missingParamOf('필수 파라미터 누락 [identity] 홍길동 900101'), 'identity');
    assert.equal(missingParamOf('누락: id, birthDate'), 'birthDate_id');
    assert.equal(missingParamOf('로그인 파라미터가 누락되었습니다. 생년월일을 입력하세요'), 'birthDate');
    assert.equal(missingParamOf('주민등록번호(사업자번호) 누락'), 'identity');
    assert.equal(missingParamOf('로그인 파라미터가 누락되었습니다.'), 'other');
    assert.equal(missingParamOf(undefined), null);
  });
});
