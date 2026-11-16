// 폰 대화 끝에서 끝(ADR-047): PhoneChat → PhoneGateway(HTTP·기기 토큰·DPoP) → 실제 게이트웨이 서비스 → 모의 공급사.
// 계정 서비스가 준 폰 토큰(chat 범위)으로 실행 토큰을 받고, 도구 왕복을 replay 태그로 잇고, 공급사에는 가린 글만 간다. 공급사는 모의다(모의 기준).
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import type { Server } from 'node:http';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { PhoneChat, PhoneGateway, type PhoneCopy, type PhoneTurnResult } from '@sax/chat-core';
import { BundleCatalog, CHAT_DIGEST, CHAT_PHONE, toolsetPrefix } from '@sax/model';
import { Logger, createServer, listen, migrate, openSqlite, type Sql } from '../services/shared/src/index.ts';
import { GatewayService, MIGRATIONS_DIR, MockNtsSource, MockProvider, gatewayRouter, type RespondSpec } from '../services/gateway/src/index.ts';
import { edKey } from './services-kit.ts';
import { accountStack, signedDesktop, signedPhone, type Signed, type Stack } from './services-stack.ts';

const GW = 'https://gw.test.invalid';

/** 호출마다 다음 출력을 내는 모의 공급사 */
class ScriptedProvider extends MockProvider {
  queue: Array<Array<Record<string, unknown>>> = [];
  readonly specs: RespondSpec[] = [];
  override respond(s: RespondSpec) {
    this.specs.push(s);
    const next = this.queue.shift();
    if (next) this.respondOutput = next;
    return super.respond(s);
  }
}

const fnCall = (id: string, name: string, args: object) => [{ type: 'function_call', call_id: id, name, arguments: JSON.stringify(args) }];
const message = (o: object) => [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(o) }] }];

const COPY = (asOf: number): PhoneCopy => ({
  asOf,
  profile: { id: 'p1', name: '율무상회', bizNo: '123-45-67890' },
  counterparties: [{ id: 'c1', name: '한빛전자', email: 'tax@hanbit.example', bizNo: '220-81-62517', item: '컨설팅' }],
  issued: [{ counterpartyId: 'c1', counterparty: '한빛전자', date: '2026-11-03', total: 1100000 }],
  receivables: [],
});

interface Env {
  s: Stack;
  db: Sql;
  provider: ScriptedProvider;
  server: Server;
  pc: Signed;
  phone: Awaited<ReturnType<typeof signedPhone>>;
  gateway: PhoneGateway;
  chat: PhoneChat;
  saved: () => string | null;
}

async function start(): Promise<Env> {
  const s = await accountStack();
  const db = openSqlite();
  await migrate(db, 'gateway', MIGRATIONS_DIR);
  const provider = new ScriptedProvider();
  const svc = new GatewayService({
    db,
    provider,
    catalog: BundleCatalog.load(),
    runKey: edKey().priv,
    cacheSecret: randomBytes(32),
    sidKey: randomBytes(32),
    tagKey: randomBytes(32),
    scopeKey: randomBytes(32),
    models: { decide: 'model-decide', respond: 'model-respond' },
    nts: new MockNtsSource(),
    suspender: { suspend: async (id) => void (await s.svc.autoSuspend(id)) },
    now: s.clock.now,
    sleep: async () => undefined,
  });
  const server = createServer(gatewayRouter({ svc, verifier: s.verifier, directory: s.directory, publicOrigin: GW }), { logger: new Logger('gateway', () => undefined, s.clock.now) });
  const base = await listen(server);
  const pc = await signedDesktop(s, 'phonechat@example.com');
  const phone = await signedPhone(s, pc);
  const gateway = new PhoneGateway({
    origin: GW,
    // 시험에서는 공개 origin을 로컬 서버로 돌린다. DPoP의 htu는 공개 origin 그대로다.
    fetch: (url, init) => fetch(url.replace(GW, base), init),
    authHeaders: async (method, url) => phone.headers(method, GW, url.slice(GW.length), await phone.token()),
  });
  let saved: string | null = null;
  let id = 0;
  const chat = new PhoneChat({
    model: gateway,
    store: { load: async () => saved, save: async (d) => void (saved = d) },
    copy: () => COPY(s.clock.now() - 60_000),
    now: s.clock.now,
    newId: () => `01KB${String(++id).padStart(22, '0')}`,
    randomHex: () => randomBytes(16).toString('hex'),
  });
  return { s, db, provider, server, pc, phone, gateway, chat, saved: () => saved };
}

const reply = (r: PhoneTurnResult) => {
  assert.equal(r.kind, 'reply', JSON.stringify(r));
  return r as Extract<PhoneTurnResult, { kind: 'reply' }>;
};

describe('폰 대화 끝에서 끝: 폰 코어 → 게이트웨이(chat 범위) → 모의 공급사', () => {
  let e: Env;
  beforeEach(async () => (e = await start()));
  afterEach(() => (e.server.close(), e.s.close()));

  it('카드 만들기 한 턴: 머리말은 게이트웨이가 넣고, 공급사에는 토큰만 가고, 도구 왕복은 태그 붙은 replay로 이어진다', async () => {
    e.provider.queue = [fnCall('call_a', 'invoice_draft', { counterparty: '[NAME_1]', amount: '[AMT_1]', vat: 'separate', item: null }), message({ kind: 'did', text: '[NAME_1] 카드를 만들었어요. 맡기면 PC를 켰을 때 시작해요.', show: [], ask: null })];
    const r = reply(await e.chat.send('한빛전자(220-81-62517)에 55만원 세금계산서 끊어줘'));
    assert.equal(r.text, '한빛전자 카드를 만들었어요. 맡기면 PC를 켰을 때 시작해요.');
    const card = r.show.find((x) => x.type === 'card');
    assert.ok(card && card.type === 'card');
    assert.deepEqual([card.draft.amount, card.draft.vat, card.draft.item], [550000, 'separate', '컨설팅']);
    assert.equal(e.provider.specs.length, 2);
    const [first, second] = e.provider.specs as [RespondSpec, RespondSpec];
    assert.equal(first.prefix, toolsetPrefix(CHAT_PHONE));
    assert.deepEqual(first.tools.map((t) => t.name), CHAT_PHONE.tools.map((t) => t.name));
    const sent = JSON.stringify(e.provider.responds);
    for (const raw of ['한빛전자', '220-81-62517', '55만원', '550000', '1100000', '1,100,000', 'hanbit', '율무상회']) assert.ok(!sent.includes(raw), `공급사에 원값이 나갔다: ${raw}`);
    assert.match(JSON.stringify(first.input), /사용자: \[NAME_1\]\(\[BIZNO_\d\]\)에 \[AMT_1\] 세금계산서 끊어줘/);
    // 둘째 호출: 첫 출력(function_call)과 폰이 답한 도구 결과가 이어진다
    const input = second.input as Array<Record<string, unknown>>;
    assert.deepEqual(input.slice(-2).map((x) => x.type), ['function_call', 'function_call_output']);
    assert.match(String(input.at(-1)!.output), /^\{"ref":"d\d+","status":"card_shown","fields":null,"needs":null\}$/);
    // 계량: 폰 기기 이름으로, 표면은 chat_phone
    const rows = await e.db.all<{ device_id: string; surface: string }>('SELECT device_id, surface FROM call_records ORDER BY at');
    assert.deepEqual(rows.map((x) => [x.device_id === e.phone.d.id, x.surface]), [[true, 'chat_phone'], [true, 'chat_phone']]);
    const usage = await e.gateway.usage();
    assert.ok(usage && usage.usedKrw > 0 && usage.limitKrw > 0 && usage.tier === 'trial', JSON.stringify(usage));
  });

  it('요약(chat_digest)도 같은 길로 간다: 21턴째 뒤에 오래된 턴을 접는 호출이 한 번 나간다', async () => {
    e.provider.respondOutput = message({ kind: 'smalltalk', text: '네.', show: [], ask: null });
    for (let i = 1; i <= 20; i++) {
      reply(await e.chat.send(`한빛전자 ${'가'.repeat(i)}`));
      // 계정 단위 분당 L2 한도(10회)에 닿지 않게 사람이 말하는 간격으로 보낸다
      e.s.clock.advance(20_000);
    }
    e.provider.queue = [message({ kind: 'smalltalk', text: '네.', show: [], ask: null }), message({ summary: '[NAME_1] 이야기를 나눴다.' }), message({ kind: 'smalltalk', text: '네.', show: [], ask: null })];
    reply(await e.chat.send('한빛전자 마지막'));
    reply(await e.chat.send('이어서'));
    const digest = e.provider.specs.filter((x) => x.prefix === toolsetPrefix(CHAT_DIGEST));
    assert.equal(digest.length, 1);
    assert.equal(digest[0]!.tools.length, 0);
    assert.match(JSON.stringify(e.provider.specs.at(-1)!.input), /\[요약\]\\n\(그 뒤 폰에서\) \[NAME_1\] 이야기를 나눴다\./);
    assert.ok(!JSON.stringify(e.provider.responds).includes('한빛전자'));
  });

  it('폰을 정지하면 받아 둔 토큰이 있어도 바로 끊긴다(chat.device_suspended), 공급사가 실패하면 다시 시도할 수 있는 오류', async () => {
    e.provider.respondOutput = message({ kind: 'smalltalk', text: '네.', show: [], ask: null });
    reply(await e.chat.send('안녕'));
    e.provider.failures = ['fatal'];
    const f = await e.chat.send('안녕하세요');
    assert.deepEqual([f.kind, f.kind === 'unavailable' && [f.code, f.retry]], ['unavailable', ['chat.unavailable', true]]);
    const token = await e.phone.token();
    await e.s.db.run("UPDATE devices SET state = 'suspended' WHERE device_id = $1", [e.phone.d.id]);
    const held = new PhoneGateway({ origin: GW, fetch: (url, init) => fetch(url.replace(GW, `http://127.0.0.1:${(e.server.address() as { port: number }).port}`), init), authHeaders: async (method, url) => e.phone.headers(method, GW, url.slice(GW.length), token) });
    await assert.rejects(held.runToken(`chat_${randomBytes(16).toString('hex')}`), { code: 'chat.device_suspended' });
    const before = e.provider.specs.length;
    const r = await new PhoneChat({ model: held, store: { load: async () => null, save: async () => undefined }, copy: () => null, now: e.s.clock.now, newId: () => '01KB0000000000000000000099', randomHex: () => randomBytes(16).toString('hex') }).send('안녕');
    assert.deepEqual([r.kind, r.kind === 'unavailable' && r.code], ['unavailable', 'chat.device_suspended']);
    assert.equal(e.provider.specs.length, before, '정지 뒤에는 공급사를 부르지 않는다');
  });

  it('분당 한도(계정 단위 L2 10회)에 닿으면 chat.rate_limited로 알리고, 시간이 지나면 다시 된다', async () => {
    e.provider.respondOutput = message({ kind: 'smalltalk', text: '네.', show: [], ask: null });
    let last: PhoneTurnResult | null = null;
    for (let i = 1; i <= 11; i++) last = await e.chat.send(`안녕 ${'가'.repeat(i)}`);
    assert.deepEqual([last!.kind, last!.kind === 'unavailable' && [last!.code, last!.retry]], ['unavailable', ['chat.rate_limited', true]]);
    e.s.clock.advance(61_000);
    reply(await e.chat.send('다시 안녕'));
    assert.equal((await e.chat.messages()).length, 22, '막힌 턴은 기록하지 않는다');
  });

  it('마스킹 계층을 지나지 않은 글은 게이트웨이로 보내지 않는다', async () => {
    const rt = await e.gateway.runToken(`chat_${randomBytes(16).toString('hex')}`);
    const r = await e.gateway.respond({ toolset: 'chat_phone', text: '한빛전자에 55만원' as never, replay: [], runToken: rt });
    assert.deepEqual(r, { status: 'error', code: 'chat.unavailable' });
    assert.equal(e.provider.specs.length, 0);
  });
});
