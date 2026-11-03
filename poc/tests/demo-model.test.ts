// 시연 전용 채팅 해석(demo-model.ts): 플래그·키 읽기, 응답 검증, 실패 시 null(정규식으로 감)과 잠시 끄기,
// egress 데모 목적지는 demoModel일 때만 열림. 모의 OpenRouter는 127.0.0.1 서버다.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { Egress, EgressError } from '@sax/net';
import { DEFAULT_MODEL, DemoModel, demoModelConfig, mergeParsed, requestBody, toParsed } from '../apps/desktop/src/demo-model.ts';
import { interpret, parseRegex, type Counterparty, type Drafts, type Parsed, type RunView, type VatMode } from '../apps/desktop/src/shell-mock.ts';

const NAMES = ['A상사', 'B상사', 'C테크'];
const reply = (o: unknown) => ({ choices: [{ message: { content: typeof o === 'string' ? o : JSON.stringify(o) } }] });
const OK = { intent: 'invoice', counterparties: ['B상사'], amount: 5_500_000, vat: 'included', item: '유지보수' };

describe('demo-model 설정', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sax-demo-model-'));
  const file = path.join(dir, '.env.local');
  after(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('플래그가 없으면 null이고, 키 변수는 그래도 지운다', () => {
    const env: NodeJS.ProcessEnv = { OPENROUTER_API_KEY: 'sk-test', OPENROUTER_MODEL: 'x/y' };
    assert.equal(demoModelConfig(env, file), null);
    assert.equal(env.OPENROUTER_API_KEY, undefined);
    assert.equal(env.OPENROUTER_MODEL, undefined);
  });

  it('플래그 + 환경 변수 키, 모델 기본값', () => {
    const env: NodeJS.ProcessEnv = { SAX_DEMO_MODEL: 'openrouter', OPENROUTER_API_KEY: 'sk-test' };
    assert.deepEqual(demoModelConfig(env, file), { key: 'sk-test', model: DEFAULT_MODEL });
    assert.equal(env.OPENROUTER_API_KEY, undefined);
  });

  it('.env.local에서 두 이름만 읽는다(export·따옴표·주석), 이상한 모델 ID는 기본값', () => {
    fs.writeFileSync(file, '# 주석\nexport OPENROUTER_API_KEY="sk-file"\nOPENROUTER_MODEL=upstage/solar-mini4\nOTHER=1\n');
    assert.deepEqual(demoModelConfig({ SAX_DEMO_MODEL: 'openrouter' }, file), { key: 'sk-file', model: 'upstage/solar-mini4' });
    fs.writeFileSync(file, "OPENROUTER_API_KEY='sk-file'\nOPENROUTER_MODEL=$(rm -rf ~)\n");
    assert.deepEqual(demoModelConfig({ SAX_DEMO_MODEL: 'openrouter' }, file), { key: 'sk-file', model: DEFAULT_MODEL });
  });

  it('홈택스 모드(allowed=false)면 플래그·키가 있어도 null이고 키 변수는 지운다', () => {
    const env: NodeJS.ProcessEnv = { SAX_DEMO_MODEL: 'openrouter', OPENROUTER_API_KEY: 'sk-test' };
    assert.equal(demoModelConfig(env, file, false), null);
    assert.equal(env.OPENROUTER_API_KEY, undefined);
  });

  it('키가 없거나 비었으면 null', () => {
    fs.writeFileSync(file, 'OPENROUTER_API_KEY=\n');
    assert.equal(demoModelConfig({ SAX_DEMO_MODEL: 'openrouter' }, file), null);
    assert.equal(demoModelConfig({ SAX_DEMO_MODEL: 'openrouter' }, path.join(dir, 'none')), null);
  });
});

describe('demo-model 응답 검증', () => {
  it('맞는 응답은 그대로, 목록에 없는 거래처는 뺀다', () => {
    assert.deepEqual(toParsed(reply(OK), NAMES), OK);
    assert.deepEqual(toParsed(reply({ ...OK, counterparties: ['B상사', 'Z물산', 'B상사'] }), NAMES)?.counterparties, ['B상사']);
    assert.deepEqual(toParsed(reply('```json\n' + JSON.stringify(OK) + '\n```'), NAMES), OK);
  });

  it('틀리면 null: 의도·금액 범위·부가세 값·JSON 깨짐·내용 없음', () => {
    for (const bad of [{ ...OK, intent: 'pay' }, { ...OK, amount: 0 }, { ...OK, amount: 1.5 }, { ...OK, amount: 2e12 }, { ...OK, amount: '550만원' }, { ...OK, vat: '포함' }, { ...OK, counterparties: 'B상사' }])
      assert.equal(toParsed(reply(bad), NAMES), null, JSON.stringify(bad));
    assert.equal(toParsed(reply('{"intent":'), NAMES), null);
    assert.equal(toParsed({ choices: [] }, NAMES), null);
    assert.equal(toParsed(null, NAMES), null);
  });

  it('품목은 짧은 한 줄만(제어 문자·40자 초과는 버림)', () => {
    assert.equal(toParsed(reply({ ...OK, item: '  교육 용역 ' }), NAMES)?.item, '교육 용역');
    assert.equal(toParsed(reply({ ...OK, item: 'a\nb' }), NAMES)?.item, null);
    assert.equal(toParsed(reply({ ...OK, item: '가'.repeat(41) }), NAMES)?.item, null);
  });

  it('요청 본문에는 문장과 거래처 이름만 들어간다', () => {
    const b = requestBody(DEFAULT_MODEL, 'B상사에 550만원', NAMES);
    assert.deepEqual(JSON.parse(b.messages[1]!.content), { sentence: 'B상사에 550만원', counterparties: NAMES });
    assert.equal(b.response_format.json_schema.strict, true);
  });
});

describe('demo-model 송신', () => {
  let server: http.Server;
  let origin = '';
  let mode: 'ok' | 'bad' | 'slow' | '500' = 'ok';
  const seen: Array<{ url: string; auth: string; body: Record<string, unknown> }> = [];
  before(async () => {
    server = http.createServer((req, res) => {
      let s = '';
      req.on('data', (c) => (s += c));
      req.on('end', () => {
        seen.push({ url: req.url ?? '', auth: String(req.headers.authorization), body: JSON.parse(s) });
        if (mode === 'slow') return void setTimeout(() => res.end(JSON.stringify(reply(OK))), 500);
        if (mode === '500') return void res.writeHead(500).end('{}');
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(reply(mode === 'bad' ? { intent: 'x' } : OK)));
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });
  after(() => server.close());
  const model = (timeoutMs = 2_000) => new DemoModel({ key: 'sk-test', model: DEFAULT_MODEL }, new Egress({ demoModel: true, timeoutMs, testOrigins: { openrouter: origin }, env: {} }));

  it('맞는 응답이면 Parsed, 경로·인증 헤더가 맞다', async () => {
    mode = 'ok';
    seen.length = 0;
    assert.deepEqual(await model().parse('B상사에 오백오십만 원, 부가세 포함', NAMES), OK);
    assert.equal(seen[0]!.url, '/api/v1/chat/completions');
    assert.equal(seen[0]!.auth, 'Bearer sk-test');
  });

  it('스키마 불일치는 null이지만 끄지 않는다', async () => {
    const m = model();
    mode = 'bad';
    assert.equal(await m.parse('x', NAMES), null);
    mode = 'ok';
    assert.deepEqual(await m.parse('x', NAMES), OK);
  });

  it('HTTP 오류·시간 초과면 null이고, 잠시 모델을 건너뛴다(서버에 안 감)', async () => {
    const m = model(100);
    mode = 'slow';
    const t0 = performance.now();
    assert.equal(await m.parse('x', NAMES), null);
    assert.ok(performance.now() - t0 < 400);
    mode = 'ok';
    seen.length = 0;
    assert.equal(await m.parse('x', NAMES), null);
    assert.equal(seen.length, 0);
    const m2 = model();
    mode = '500';
    assert.equal(await m2.parse('x', NAMES), null);
  });

  it('demoModel이 꺼진 egress는 openrouter를 거부한다', async () => {
    await assert.rejects(new Egress({ testOrigins: { openrouter: origin }, env: {} }).postJson('openrouter', '/api/v1/chat/completions', {}), (e: unknown) => e instanceof EgressError && e.code === 'destination_not_allowed');
    await assert.rejects(new Egress({ demoModel: true, testOrigins: { openrouter: origin }, env: {} }).postJson('openrouter', '/api/v1/models', {}), (e: unknown) => e instanceof EgressError && e.code === 'path_not_allowed');
  });
});

describe('모델이 뽑은 구조로 interpret', () => {
  const CPS = NAMES.map((name, i) => ({ id: `cp-${i}`, name, bizNo: String(i), rep: '', email: '', item: '지난 품목', status: '', checkedOn: '', lastIssuedOn: null })) as Counterparty[];
  const drafts = () => {
    const made: Array<{ cp: string; amount: number; vat: VatMode | null; item?: string | null }> = [];
    const d: Drafts = {
      pending: { cp: null, asked: null, amount: null },
      counterparties: CPS,
      createDraft: (cp, amount, vat, item) => (made.push({ cp: cp.name, amount, vat, item }), { id: 'r' } as RunView),
    };
    return { d, made };
  };
  const P = (o: Partial<Parsed>): Parsed => ({ intent: 'other', counterparties: [], amount: null, vat: null, item: null, ...o });

  it('품목·부가세 포함을 초안에 넘기고, 화면의 부가세 선택이 먼저다', () => {
    const { d, made } = drafts();
    assert.equal(interpret('x', null, 'business', d, P({ intent: 'invoice', counterparties: ['B상사'], amount: 5_500_000, vat: 'included', item: '유지보수' })).kind, 'draft');
    interpret('x', 'separate', 'business', d, P({ intent: 'invoice', counterparties: ['B상사'], amount: 5_500_000, vat: 'included' }));
    assert.deepEqual(made, [{ cp: 'B상사', amount: 5_500_000, vat: 'included', item: '유지보수' }, { cp: 'B상사', amount: 5_500_000, vat: 'separate', item: null }]);
  });

  it('되묻기에 금액만 답해도 이어진다(의도 other)', () => {
    const { d, made } = drafts();
    assert.equal(interpret('x', null, 'business', d, P({ intent: 'invoice', counterparties: ['A상사'] })).kind, 'say');
    assert.equal(interpret('x', null, 'business', d, P({ amount: 3_300_000 })).kind, 'draft');
    assert.equal(made[0]!.cp, 'A상사');
  });

  it('정규식도 부가세 포함·별도를 문장에서 읽는다', () => {
    assert.equal(parseRegex('B상사 330만원 부가세 포함 세금계산서', CPS).vat, 'included');
    assert.equal(parseRegex('B상사 330만원 VAT별도 세금계산서', CPS).vat, 'separate');
    assert.equal(parseRegex('B상사 330만원 세금계산서', CPS).vat, null);
  });
});

describe('모델 값과 정규식 값 합치기', () => {
  const CPS = NAMES.map((name, i) => ({ id: `cp-${i}`, name, bizNo: String(i), rep: '', email: '', item: '', status: '', checkedOn: '', lastIssuedOn: null })) as Counterparty[];
  const m = (o: Partial<Parsed>): Parsed => ({ intent: 'invoice', counterparties: [], amount: null, vat: null, item: null, ...o });
  const merge = (text: string, o: Partial<Parsed>) => mergeParsed(m(o), parseRegex(text, CPS), text);

  it('한글 금액·품목·부가세는 모델 값을 쓴다', () => {
    assert.deepEqual(merge('B상사 유지보수비 오백오십만 원, 부가세 포함으로 계산서', { counterparties: ['B상사'], amount: 5_500_000, vat: 'included', item: '유지보수비' }), m({ counterparties: ['B상사'], amount: 5_500_000, vat: 'included', item: '유지보수비' }));
  });

  it('문장에 없는 거래처, 금액 단어 없는 금액은 버리고, 숫자 금액은 정규식이 먼저', () => {
    assert.deepEqual(merge('330만원', { intent: 'other', counterparties: ['B상사'], amount: 330 }), m({ intent: 'other', amount: 3_300_000 }));
    assert.equal(merge('A상사 계산서', { counterparties: ['A상사'], amount: 1_000_000 }).amount, null);
    assert.equal(merge('만들어 줘', { intent: 'other', amount: 10_000 }).amount, null);
  });

  it('정규식이 일부러 비운 금액("330", "1억 2천")은 모델로 채우지 않는다', () => {
    assert.equal(merge('330', { intent: 'other', amount: 3_300_000 }).amount, null);
    assert.equal(merge('A상사 1억 2천 계산서', { counterparties: ['A상사'], amount: 120_000_000 }).amount, null);
  });

  it('정규식이 알아본 의도가 먼저(신고 거절은 모델에 달리지 않는다)', () => {
    assert.equal(merge('부가세 신고도 해 줘', { intent: 'invoice' }).intent, 'filing');
    assert.equal(merge('계산서 하나 발행해 줘', { intent: 'other' }).intent, 'invoice');
    assert.equal(merge('B상사에 하나 발행해 줘', { intent: 'invoice' }).intent, 'invoice');
  });

  it('부가세는 문장에 그 말이 있을 때만, 품목은 문장에 그대로 있고 금액·거래처·계산서가 아닐 때만', () => {
    assert.equal(merge('A상사 330만원 계산서', { vat: 'included' }).vat, null);
    assert.equal(merge('A상사 330만원 계산서, 포함으로', { vat: 'included' }).vat, 'included');
    for (const item of ['세금계산서', '메일', '330만원', 'A상사', '컨설팅'])
      assert.equal(merge('A상사에 330만원 세금계산서 끊고 메일 보내 줘', { counterparties: ['A상사'], item }).item, null, item);
    assert.equal(merge('B상사 유지보수비 오백오십만 원 계산서', { item: '유지보수비' }).item, '유지보수비');
    assert.equal(merge('77만원', { intent: 'other', item: '77만원' }).item, null);
  });
});
