import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import type { Server } from 'node:http';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { Logger, TokenIssuer, TokenVerifier, createServer, ed25519RawPublic, listen, migrate, openSqlite, type Sql } from '../services/shared/src/index.ts';
import { AccountService, BILLING, MIGRATIONS_DIR, MockBillingGateway, MockMailSender, TossPaymentGateway, accountRouter, addMonthKst, buildAccount, tossEndpointAllowed } from '../services/account/src/index.ts';
import { Clock, D, H, client, edKey, internalAuth } from './services-kit.ts';

const ORIGIN = 'https://account.test.invalid';

interface Env {
  clock: Clock;
  db: Sql;
  mail: MockMailSender;
  pg: MockBillingGateway;
  svc: AccountService;
  server: Server;
  req: ReturnType<typeof client>;
  events: string[];
  flush: () => Promise<void>;
}

async function start(): Promise<Env> {
  const clock = new Clock();
  const db = openSqlite();
  await migrate(db, 'account', MIGRATIONS_DIR);
  const mail = new MockMailSender();
  const pg = new MockBillingGateway(ORIGIN);
  const signKey = edKey().priv;
  const events: string[] = [];
  const deferred: Array<() => Promise<void>> = [];
  const svc = new AccountService({
    db,
    mail,
    payments: pg,
    billingKeySealKey: randomBytes(32),
    tokens: new TokenIssuer('k1', signKey),
    codeMacKey: randomBytes(32),
    rp: { rpId: 'account.test.invalid', origins: [ORIGIN] },
    publicOrigin: ORIGIN,
    billingReturnUrl: 'https://app.test.invalid/billing/done',
    onEvent: (n) => void events.push(n),
    defer: (t) => void deferred.push(t),
    now: clock.now,
  });
  const router = accountRouter({ svc, verifier: new TokenVerifier({ k1: ed25519RawPublic(signKey) }), publicOrigin: ORIGIN, internal: internalAuth() });
  const server = createServer(router, { logger: new Logger('account', () => undefined, clock.now) });
  return { clock, db, mail, pg, svc, server, req: client(await listen(server)), events, flush: async () => { while (deferred.length) await deferred.shift()!(); } };
}

const bearer = (s: string) => ({ authorization: `Bearer ${s}` });

async function login(e: Env, email: string, o: { trial?: boolean } = {}): Promise<string> {
  const s = await e.req('POST', '/v1/auth/code', { body: { email } });
  const v = await e.req('POST', '/v1/auth/code/verify', { body: { loginId: s.json.loginId, code: e.mail.lastCode(email) } });
  if (!o.trial) await e.db.run('UPDATE accounts SET created_at = $2 WHERE email = $1 AND created_at > $2', [email, e.clock.now() - 40 * D]);
  return v.json.session as string;
}

async function subscribe(e: Env, s: string, authKey = 'auth_ok'): Promise<{ ref: string; done: Awaited<ReturnType<Env['req']>> }> {
  const c = await e.req('POST', '/v1/billing/checkout', { headers: bearer(s) });
  assert.equal(c.status, 200, c.text);
  const url = new URL(c.json.checkoutUrl as string);
  assert.equal(url.origin + url.pathname, `${ORIGIN}/v1/billing/card`);
  const ref = url.searchParams.get('ref')!;
  const page = await e.req('GET', `/v1/billing/card?ref=${ref}`);
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-type')!, /^text\/html/);
  assert.match(page.headers.get('content-security-policy')!, /default-src 'none'/);
  assert.ok(page.text.includes(`data-success="${ORIGIN}/v1/billing/card/success"`));
  const done = await e.req('GET', `/v1/billing/card/success?customerKey=${ref}&authKey=${authKey}`);
  return { ref, done };
}

const sub = async (e: Env, s: string) => (await e.req('GET', '/v1/billing/subscription', { headers: bearer(s) })).json.subscription as Record<string, unknown>;
const st = async (e: Env, ref: string) => {
  const r = await e.db.one<{ status: string; renew_at: number | null }>('SELECT status, renew_at FROM subscriptions WHERE pg_customer_ref = $1', [ref]);
  return { status: r!.status, renewAt: r!.renew_at === null ? null : Number(r!.renew_at) };
};

describe('카드 정기결제(빌링키 PG)', () => {
  let e: Env;
  beforeEach(async () => (e = await start()));
  afterEach(() => e.server.close());

  it('카드 등록 → 첫 달 19,900원 청구 → active, 한 달 뒤 갱신일. 빌링키는 봉인 저장(평문 없음)', async () => {
    const s = await login(e, 'toss@example.com');
    const t0 = e.clock.now();
    const { ref, done } = await subscribe(e, s);
    assert.equal(done.status, 200, done.text);
    assert.ok(done.text.includes('구독을 시작했어요'));
    assert.ok(done.text.includes('https://app.test.invalid/billing/done'));
    assert.deepEqual((await sub(e, s)), { plan: 'standard', status: 'active', renewAt: addMonthKst(t0), amountKrw: 19900, period: 'month', refund: { amountKrw: 19900, refundableUntil: t0 + 7 * D } });
    assert.equal(e.pg.charges.length, 1);
    assert.equal(e.pg.charges[0]!.amountKrw, 19900);
    assert.deepEqual((await e.req('GET', '/v1/me', { headers: bearer(s) })).json.consents, ['terms-2026-11-30']);
    assert.equal(e.pg.charges[0]!.customerKey, ref);
    assert.match(e.pg.charges[0]!.orderId, /^[A-Za-z0-9_-]{6,64}$/);
    const row = await e.db.one<{ billing_key_sealed: Buffer }>('SELECT billing_key_sealed FROM subscriptions WHERE pg_customer_ref = $1', [ref]);
    assert.ok(!Buffer.from(row!.billing_key_sealed).toString('latin1').includes('bk_'));
    const again = await e.req('GET', `/v1/billing/card/success?customerKey=${ref}&authKey=auth_ok`);
    assert.ok(again.text.includes('구독 중이에요'));
    assert.equal(e.pg.charges.length, 1);
    assert.equal((await e.req('GET', `/v1/billing/card?ref=${ref}`)).status, 404);

    e.clock.advance(20 * D);
    assert.deepEqual(await e.svc.chargeDue(), { paid: 0, declined: 0, uncertain: 0 });
    e.clock.t = addMonthKst(t0) + H;
    assert.deepEqual(await e.svc.chargeDue(), { paid: 1, declined: 0, uncertain: 0 });
    assert.equal((await st(e, ref)).renewAt, addMonthKst(addMonthKst(t0)));
    assert.deepEqual(await e.svc.chargeDue(), { paid: 0, declined: 0, uncertain: 0 });
    assert.equal(e.pg.charges.length, 2);
    assert.notEqual(e.pg.charges[0]!.orderId, e.pg.charges[1]!.orderId);

    await e.svc.cancelSubscription({ accountId: (await e.db.one<{ account_id: string }>('SELECT account_id FROM subscriptions WHERE pg_customer_ref = $1', [ref]))!.account_id });
    const after = await st(e, ref);
    assert.deepEqual([after.status, after.renewAt], ['canceled', addMonthKst(addMonthKst(t0))]);
    e.clock.advance(40 * D);
    assert.deepEqual(await e.svc.chargeDue(), { paid: 0, declined: 0, uncertain: 0 });
    const r = await e.db.one<{ billing_key_sealed: Buffer | null }>('SELECT billing_key_sealed FROM subscriptions WHERE pg_customer_ref = $1', [ref]);
    assert.equal(r!.billing_key_sealed, null);
  });

  it('결과를 모르면(네트워크·5xx) 같은 주문번호로 다시 묻는다: 임대 안에는 다시 청구하지 않음', async () => {
    const s = await login(e, 'uncertain@example.com');
    e.pg.next.push({ ok: false, uncertain: true, code: 'network' });
    const { ref, done } = await subscribe(e, s);
    assert.equal(done.status, 202);
    assert.equal((await st(e, ref)).status, 'pending');
    const first = e.pg.charges.at(-1)!.orderId;
    assert.deepEqual(await e.svc.chargeDue(), { paid: 0, declined: 0, uncertain: 0 });
    e.clock.advance(BILLING.chargeLeaseMs + 1);
    assert.deepEqual(await e.svc.chargeDue(), { paid: 1, declined: 0, uncertain: 0 });
    assert.equal(e.pg.charges.at(-1)!.orderId, first);
    assert.equal((await st(e, ref)).status, 'active');
  });

  it('첫 결제 거절: 빌링키를 지우고 자동 재시도하지 않는다. 다른 카드로 다시 등록하면 새 주문번호', async () => {
    const s = await login(e, 'declined@example.com');
    e.pg.next.push({ ok: false, uncertain: false, code: 'REJECT_CARD_COMPANY' });
    const { ref, done } = await subscribe(e, s);
    assert.equal(done.status, 402);
    assert.equal((await st(e, ref)).status, 'pending');
    const n = e.pg.charges.length;
    e.clock.advance(2 * D);
    await e.svc.chargeDue();
    assert.equal(e.pg.charges.length, n);
    const declinedOrder = e.pg.charges.at(-1)!.orderId;
    const again = await e.req('GET', `/v1/billing/card/success?customerKey=${ref}&authKey=auth_2`);
    assert.equal(again.status, 200);
    assert.notEqual(e.pg.charges.at(-1)!.orderId, declinedOrder);
    assert.equal((await st(e, ref)).status, 'active');
  });

  it('갱신 실패: past_due → 하루 뒤 재시도, 세 번 실패하면 해지', async () => {
    const s = await login(e, 'pastdue@example.com');
    const { ref } = await subscribe(e, s);
    const due = (await st(e, ref)).renewAt as number;
    e.clock.t = due + 1;
    for (let i = 0; i < 3; i++) e.pg.next.push({ ok: false, uncertain: false, code: 'EXCEED_MAX_AMOUNT' });
    assert.equal((await e.svc.chargeDue()).declined, 1);
    assert.equal((await st(e, ref)).status, 'past_due');
    await e.svc.chargeDue();
    assert.equal(e.pg.charges.filter((c) => c.customerKey === ref).length, 2);
    e.clock.advance(BILLING.retryAfterMs + 1);
    await e.svc.chargeDue();
    e.clock.advance(BILLING.retryAfterMs + 1);
    await e.svc.chargeDue();
    assert.equal((await st(e, ref)).status, 'canceled');
    assert.ok(e.events.includes('account.billing_canceled_after_failures'));
    assert.equal(e.pg.charges.filter((c) => c.customerKey === ref).length, 4);
  });

  it('연체 중 새 카드 등록은 밀린 기간을 바로 청구해 active', async () => {
    const s = await login(e, 'recard@example.com');
    const { ref } = await subscribe(e, s);
    const due = (await st(e, ref)).renewAt as number;
    e.clock.t = due + 1;
    e.pg.next.push({ ok: false, uncertain: false, code: 'INVALID_CARD_EXPIRATION' });
    await e.svc.chargeDue();
    assert.equal((await st(e, ref)).status, 'past_due');
    const declinedOrder = e.pg.charges.at(-1)!.orderId;
    const s2 = await login(e, 'recard@example.com');
    const { done } = await subscribe(e, s2, 'auth_new');
    assert.equal(done.status, 200);
    assert.deepEqual([(await st(e, ref)).status, (await st(e, ref)).renewAt], ['active', addMonthKst(due)]);
    assert.notEqual(e.pg.charges.at(-1)!.orderId, declinedOrder);
  });

  it('창·돌아옴 입력 검증: 모르는 참조·잘못된 authKey·발급 실패는 고정 문구, 실패 코드는 이벤트 이름에만', async () => {
    assert.equal((await e.req('GET', '/v1/billing/card?ref=cus_nope')).status, 404);
    assert.equal((await e.req('GET', '/v1/billing/card/success?customerKey=cus_nope&authKey=x')).status, 400);
    const s = await login(e, 'bad@example.com');
    const { done } = await subscribe(e, s, 'bad');
    assert.equal(done.status, 400);
    const f = await e.req('GET', '/v1/billing/card/fail?code=PAY_PROCESS_CANCELED&message=%3Cscript%3E');
    assert.ok(f.text.includes('카드 등록을 취소했어요'));
    assert.ok(!f.text.includes('<script>'));
    assert.ok(e.events.includes('account.billing_card_fail.PAY_PROCESS_CANCELED'));
    assert.equal((await e.req('POST', '/v1/billing/webhook', { raw: '{}' })).json.error, 'account.billing_signature_invalid');
  });
});

describe('청약철회 환불·유료 기능 권리(체험 1달)', () => {
  let e: Env;
  beforeEach(async () => (e = await start()));
  afterEach(() => e.server.close());

  const accountOf = async (ref: string) => (await e.db.one<{ account_id: string }>('SELECT account_id FROM subscriptions WHERE pg_customer_ref = $1', [ref]))!.account_id;
  const session = async (ref: string) => ({ accountId: await accountOf(ref) });

  it('탈퇴 요청: 구독을 끝내고 저장한 빌링키를 바로 지운다(행 삭제는 7일 유예 뒤), 그 뒤 청구 없음', async () => {
    const s = await login(e, 'leave@example.com');
    const { ref } = await subscribe(e, s);
    const n = e.pg.charges.length;
    assert.equal((await e.req('POST', '/v1/account/delete-request', { headers: bearer(s) })).status, 202);
    const r = await e.db.one<{ status: string; billing_key_sealed: Buffer | null }>('SELECT status, billing_key_sealed FROM subscriptions WHERE pg_customer_ref = $1', [ref]);
    assert.deepEqual([r!.status, r!.billing_key_sealed], ['canceled', null]);
    e.clock.advance(40 * D);
    await e.svc.chargeDue();
    assert.equal(e.pg.charges.length, n);
  });

  it('결제 당일 철회는 전액, 구독은 바로 끝나고 접수 메일. 같은 결제를 두 번 환불하지 않는다', async () => {
    const s = await login(e, 'refund@example.com');
    const { ref } = await subscribe(e, s);
    const sub0 = (await e.req('GET', '/v1/billing/subscription', { headers: bearer(s) })).json.subscription as { refund: { amountKrw: number; refundableUntil: number } };
    assert.equal(sub0.refund.amountKrw, 19900);
    assert.equal(sub0.refund.refundableUntil, e.clock.now() + 7 * D);
    const r = await e.req('POST', '/v1/billing/refund', { headers: bearer(s) });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.amountKrw, 19900);
    assert.equal(e.pg.refunds.length, 1);
    assert.equal(e.pg.refunds[0]!.paymentKey, `pay_${e.pg.charges[0]!.orderId}`);
    assert.deepEqual(await st(e, ref), { status: 'canceled', renewAt: e.clock.now() });
    assert.equal((await e.req('POST', '/v1/billing/refund', { headers: bearer(s) })).json.error, 'account.refund_unavailable');
    await e.flush();
    await e.svc.drainNotices();
    assert.ok(e.mail.outbox.some((m) => m.to === 'refund@example.com' && m.kind === 'subscription_refunded'));
  });

  it('사흘 쓰고 철회하면 쓴 날만큼 빼고, 7일이 지나면 철회할 수 없다. PG 실패면 되돌려 다시 할 수 있다', async () => {
    const s = await login(e, 'prorate@example.com');
    const { ref } = await subscribe(e, s);
    const renew = (await st(e, ref)).renewAt!;
    const periodDays = Math.round((renew - e.clock.now()) / D);
    e.clock.advance(3 * D + H);
    e.pg.nextRefund.push({ ok: false, uncertain: true, code: 'network' });
    await assert.rejects(e.svc.refundSubscription(await session(ref)), /account.refund_failed/);
    const r = await e.svc.refundSubscription(await session(ref));
    assert.equal(r.amountKrw, 19900 - Math.ceil((19900 * 3) / periodDays));
    assert.equal(e.pg.refunds[0]!.idempotencyKey, e.pg.refunds[1]!.idempotencyKey);

    const s2 = await login(e, 'late@example.com');
    const { ref: ref2 } = await subscribe(e, s2);
    e.clock.advance(7 * D);
    await assert.rejects(e.svc.refundSubscription(await session(ref2)), /account.refund_unavailable/);
  });

  it('체험 중 첫 구독: 오늘은 결제 없음, 체험 끝나는 날 첫 결제, 7일 전 전환 안내 한 번, 체험 중 해지하면 결제 없음', async () => {
    const s = await login(e, 'trialsub@example.com', { trial: true });
    const t0 = e.clock.now();
    const trialEnd = addMonthKst(t0);
    const c = await e.req('POST', '/v1/billing/checkout', { headers: bearer(s) });
    const ref = new URL(c.json.checkoutUrl as string).searchParams.get('ref')!;
    const page = await e.req('GET', `/v1/billing/card?ref=${ref}`);
    assert.ok(page.text.includes(`data-trial="${trialEnd}"`));
    const done = await e.req('GET', `/v1/billing/card/success?customerKey=${ref}&authKey=auth_ok`);
    assert.equal(done.status, 200);
    assert.ok(done.text.includes('카드를 등록했어요'));
    assert.equal(e.pg.charges.length, 0);
    assert.deepEqual(await st(e, ref), { status: 'active', renewAt: trialEnd });
    assert.deepEqual((await e.req('GET', '/v1/me', { headers: bearer(s) })).json.consents, ['terms-2026-11-30']);
    e.clock.t = trialEnd - 8 * D;
    assert.equal(await e.svc.trialConversionNotices(), 0);
    e.clock.t = trialEnd - 6 * D;
    assert.equal(await e.svc.trialConversionNotices(), 1);
    assert.equal(await e.svc.trialConversionNotices(), 0);
    await e.flush();
    await e.svc.drainNotices();
    assert.ok(e.mail.outbox.some((m) => m.to === 'trialsub@example.com' && m.kind === 'trial_converting'));
    e.clock.t = trialEnd + H;
    assert.equal((await e.svc.chargeDue()).paid, 1);
    assert.equal(e.pg.charges[0]!.amountKrw, 19900);
    assert.deepEqual(await st(e, ref), { status: 'active', renewAt: addMonthKst(trialEnd) });
    const r = await e.svc.refundSubscription({ accountId: (await e.db.one<{ account_id: string }>('SELECT account_id FROM subscriptions WHERE pg_customer_ref = $1', [ref]))!.account_id });
    assert.equal(r.amountKrw, 19900);

    const s2 = await login(e, 'trialcancel@example.com', { trial: true });
    const c2 = await e.req('POST', '/v1/billing/checkout', { headers: bearer(s2) });
    const ref2 = new URL(c2.json.checkoutUrl as string).searchParams.get('ref')!;
    await e.req('GET', `/v1/billing/card/success?customerKey=${ref2}&authKey=auth_ok`);
    assert.equal((await e.req('POST', '/v1/billing/cancel', { headers: bearer(s2) })).status, 204);
    e.clock.advance(60 * D);
    await e.svc.chargeDue();
    assert.equal(e.pg.charges.filter((x) => x.customerKey === ref2).length, 0);
  });

  it('권리: 가입 뒤 1달 체험 → 끝나면 none, 구독하면 paid(갱신일까지), 해지해도 갱신일까지 paid', async () => {
    const s = await login(e, 'ent@example.com', { trial: true });
    const t0 = e.clock.now();
    const ent = await e.req('GET', '/v1/billing/entitlement', { headers: bearer(s) });
    assert.deepEqual(ent.json, { state: 'trial', until: addMonthKst(t0), trialMonths: 1 });
    assert.deepEqual((await e.req('GET', '/v1/me', { headers: bearer(s) })).json.entitlement, { state: 'trial', until: addMonthKst(t0) });
    e.clock.t = addMonthKst(t0);
    const s2 = await login(e, 'ent@example.com', { trial: true });
    assert.equal((await e.req('GET', '/v1/billing/entitlement', { headers: bearer(s2) })).json.state, 'none');
    const { ref } = await subscribe(e, s2);
    const renew = (await st(e, ref)).renewAt!;
    assert.deepEqual(await e.svc.entitlement(await accountOf(ref)), { state: 'paid', until: renew });
    await e.svc.cancelSubscription(await session(ref));
    assert.deepEqual(await e.svc.entitlement(await accountOf(ref)), { state: 'paid', until: renew });
    e.clock.t = renew + 1;
    assert.equal((await e.svc.entitlement(await accountOf(ref))).state, 'none');
    await e.flush();
    await e.svc.drainNotices();
    assert.ok(e.mail.outbox.some((m) => m.to === 'ent@example.com' && m.kind === 'subscription_canceled'));
  });

  it('갱신 결제 실패는 알림 메일, 유예(3일) 안에서는 계속 쓸 수 있고 세 번 실패하면 끝 메일', async () => {
    const s = await login(e, 'fail@example.com');
    const { ref } = await subscribe(e, s);
    const renew = (await st(e, ref)).renewAt!;
    e.clock.t = renew + 1;
    for (let i = 0; i < 3; i++) e.pg.next.push({ ok: false, uncertain: false, code: 'REJECT_CARD_COMPANY' });
    await e.svc.chargeDue();
    assert.equal((await e.svc.entitlement(await accountOf(ref))).state, 'paid');
    e.clock.advance(D + 1);
    await e.svc.chargeDue();
    e.clock.advance(D + 1);
    await e.svc.chargeDue();
    await e.flush();
    await e.svc.drainNotices();
    const kinds = e.mail.outbox.filter((m) => m.to === 'fail@example.com').map((m) => m.kind);
    assert.deepEqual(kinds.filter((k) => k === 'payment_failed').length, 2);
    assert.ok(kinds.includes('subscription_ended'));
  });
});

describe('한 달 뒤(KST 달력)', () => {
  it('말일 보정·연말', () => {
    const kst = (y: number, m: number, d: number) => Date.UTC(y, m - 1, d, 1) - 9 * H;
    assert.equal(addMonthKst(kst(2026, 1, 31)), kst(2026, 2, 28));
    assert.equal(addMonthKst(kst(2028, 1, 31)), kst(2028, 2, 29));
    assert.equal(addMonthKst(kst(2026, 12, 15)), kst(2027, 1, 15));
    const t = Date.UTC(2026, 10, 30, 16);
    assert.equal(addMonthKst(t), Date.UTC(2026, 11, 31, 16));
  });
});

describe('토스페이먼츠 어댑터(가짜 fetch)', () => {
  const CK = 'test_ck_D5GePWvyJnrK0W0k6q8gLzN97Eoq';
  const SK = 'test_sk_zXLkKEypNArWmo50nX3lmeaxYG5R';
  const calls: Array<{ url: string; init: RequestInit }> = [];
  let reply: () => Response = () => new Response('{}', { status: 200 });
  const fetchFn = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return reply();
  }) as unknown as typeof fetch;
  const toss = () => new TossPaymentGateway({ clientKey: CK, secretKey: SK, publicOrigin: ORIGIN, fetchFn });

  it('키 검사: 형식·종류(결제위젯 키 거부)·테스트/라이브 섞임', () => {
    assert.throws(() => new TossPaymentGateway({ clientKey: '', secretKey: SK, publicOrigin: ORIGIN }), /config_TOSS_CLIENT_KEY/);
    assert.throws(() => new TossPaymentGateway({ clientKey: CK, secretKey: 'live_sk_zXLkKEypNArWmo50nX3lmeaxYG5R', publicOrigin: ORIGIN }), /config_TOSS_KEY_MODE/);
    assert.throws(() => new TossPaymentGateway({ clientKey: 'test_gck_D5GePWvyJnrK0W0k6q8gLzN97Eoq', secretKey: 'test_gsk_zXLkKEypNArWmo50nX3lmeaxYG5R', publicOrigin: ORIGIN }), /config_TOSS_KEY_KIND/);
    assert.equal(toss().mode, 'test');
  });

  it('허용 목록: 토스 API의 빌링 두 경로만', () => {
    assert.ok(tossEndpointAllowed('https://api.tosspayments.com/v1/billing/authorizations/issue'));
    assert.ok(tossEndpointAllowed('https://api.tosspayments.com/v1/billing/abc_DEF-123='));
    assert.ok(!tossEndpointAllowed('https://api.tosspayments.com/v1/payments/confirm'));
    assert.ok(!tossEndpointAllowed('https://evil.example/v1/billing/x'));
    assert.ok(!tossEndpointAllowed('https://api.tosspayments.com/v1/billing/x?y=1'));
  });

  it('빌링키 발급: Basic 인증(시크릿 키:), 본문 authKey·customerKey만, 리디렉션 따르지 않음', async () => {
    reply = () => Response.json({ billingKey: 'bk_123', customerKey: 'cus_aaaaaaaaaaaaaaaaaaaaaaaa' });
    calls.length = 0;
    const r = await toss().billing.issueBillingKey({ authKey: 'ak', customerKey: 'cus_aaaaaaaaaaaaaaaaaaaaaaaa' });
    assert.deepEqual(r, { billingKey: 'bk_123' });
    assert.equal(calls[0]!.url, 'https://api.tosspayments.com/v1/billing/authorizations/issue');
    const h = calls[0]!.init.headers as Record<string, string>;
    assert.equal(h.authorization, `Basic ${Buffer.from(`${SK}:`).toString('base64')}`);
    assert.equal(calls[0]!.init.redirect, 'manual');
    assert.deepEqual(JSON.parse(calls[0]!.init.body as string), { authKey: 'ak', customerKey: 'cus_aaaaaaaaaaaaaaaaaaaaaaaa' });
    reply = () => Response.json({ billingKey: 'bk_123', customerKey: 'cus_other' });
    assert.equal(await toss().billing.issueBillingKey({ authKey: 'ak', customerKey: 'cus_aaaaaaaaaaaaaaaaaaaaaaaa' }), null);
  });

  it('청구: 멱등 키 = 주문번호, DONE·금액 일치만 성공, 5xx·처리 중·네트워크는 결과 모름, 카드 사유는 거절', async () => {
    const o = { billingKey: 'bk_1', customerKey: 'cus_x', orderId: 'order-1', amountKrw: 19900, orderName: '구독' };
    calls.length = 0;
    reply = () => Response.json({ status: 'DONE', orderId: 'order-1', totalAmount: 19900 });
    assert.deepEqual(await toss().billing.charge(o), { ok: true });
    assert.equal(calls[0]!.url, 'https://api.tosspayments.com/v1/billing/bk_1');
    assert.equal((calls[0]!.init.headers as Record<string, string>)['idempotency-key'], 'order-1');
    assert.deepEqual(JSON.parse(calls[0]!.init.body as string), { customerKey: 'cus_x', amount: 19900, orderId: 'order-1', orderName: '구독' });
    reply = () => Response.json({ status: 'DONE', orderId: 'order-1', totalAmount: 100 });
    assert.equal((await toss().billing.charge(o)).ok, false);
    reply = () => Response.json({ code: 'FAILED_INTERNAL_SYSTEM_PROCESSING' }, { status: 500 });
    assert.deepEqual(await toss().billing.charge(o), { ok: false, uncertain: true, code: 'FAILED_INTERNAL_SYSTEM_PROCESSING' });
    reply = () => Response.json({ code: 'IDEMPOTENT_REQUEST_PROCESSING' }, { status: 409 });
    assert.equal((await toss().billing.charge(o) as { uncertain: boolean }).uncertain, true);
    reply = () => Response.json({ code: 'REJECT_CARD_COMPANY', message: '카드사 거절' }, { status: 400 });
    assert.deepEqual(await toss().billing.charge(o), { ok: false, uncertain: false, code: 'REJECT_CARD_COMPANY' });
    reply = () => Response.json({ code: 'UNAUTHORIZED_KEY' }, { status: 401 });
    assert.equal((await toss().billing.charge(o) as { uncertain: boolean }).uncertain, true);
    reply = () => {
      throw new Error('timeout');
    };
    assert.deepEqual(await toss().billing.charge(o), { ok: false, uncertain: true, code: 'network' });
  });

  it('카드 등록 창: 토스 SDK·customerKey·돌아올 주소, 값은 스크립트 안 JSON으로만(태그 깨기 불가)', () => {
    const html = toss().billing.cardPage({ customerKey: 'cus_</script>', successUrl: `${ORIGIN}/v1/billing/card/success`, failUrl: `${ORIGIN}/v1/billing/card/fail`, amountKrw: 19900, nonce: 'n1' });
    assert.ok(html.includes('https://js.tosspayments.com/v2/standard'));
    assert.ok(html.includes('requestBillingAuth'));
    assert.ok(html.includes(CK));
    assert.ok(!html.includes(SK));
    assert.ok(!html.includes('cus_</script>'));
    assert.ok(html.includes('매월 19,900원 (부가세 포함)'));
    const trial = toss().billing.cardPage({ customerKey: 'cus_x', successUrl: 's', failUrl: 'f', amountKrw: 19900, nonce: 'n1', trialEndsAt: Date.UTC(2026, 11, 9, 15) });
    for (const w of ['오늘은 결제되지 않아요', '2026년 12월 10일', '카드 등록하기(오늘 결제 없음)', '체험 중 해지하면 결제가 없어요']) assert.ok(trial.includes(w), w);
    for (const w of ['자동 갱신', '해지', '청약철회', '결제 실패', 'https://tax.laf-co.com/terms', 'https://tax.laf-co.com/privacy', 'id="go" type="button" disabled']) assert.ok(html.includes(w), w);
  });

  it('기동 설정: PG_PROVIDER=toss는 TOSS 키 둘과 BILLING_KEY_SEAL_KEY(다른 비밀과 다른 값)가 있어야 한다', async () => {
    const hex = () => randomBytes(32).toString('hex');
    const base = { SAX_SQLITE_FILE: ':memory:', TOKEN_SIGNING_SEED: hex(), CODE_MAC_KEY: hex(), LIMIT_ID_KEY: hex(), INTERNAL_CALL_KEY: hex(), ACCOUNT_PUBLIC_ORIGIN: ORIGIN, WEBAUTHN_RP_ID: 'account.test.invalid', WEBAUTHN_ORIGINS: ORIGIN, BILLING_RETURN_URL: 'https://app.test.invalid/done', MAIL_PROVIDER: 'mock', PG_PROVIDER: 'toss' };
    await assert.rejects(buildAccount({ ...base, TOSS_CLIENT_KEY: CK, TOSS_SECRET_KEY: SK }), /config_BILLING_KEY_SEAL_KEY/);
    await assert.rejects(buildAccount({ ...base, TOSS_CLIENT_KEY: CK, TOSS_SECRET_KEY: SK, BILLING_KEY_SEAL_KEY: base.CODE_MAC_KEY }), /config_BILLING_KEY_SEAL_KEY/);
    await assert.rejects(buildAccount({ ...base, BILLING_KEY_SEAL_KEY: hex() }), /config_TOSS_CLIENT_KEY/);
    await assert.rejects(buildAccount({ ...base, PG_PROVIDER: 'nicepay' }), /config_provider/);
    const b = await buildAccount({ ...base, TOSS_CLIENT_KEY: CK, TOSS_SECRET_KEY: SK, BILLING_KEY_SEAL_KEY: hex() });
    await b.db.close();
  });
});
