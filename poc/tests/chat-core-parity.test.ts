import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { describe, it } from 'node:test';
import { Tiktoken } from 'js-tiktoken/lite';
import o200k from 'js-tiktoken/ranks/o200k_base';
import {
  CHAT_PHONE_MAX_TURNS,
  CHAT_PHONE_TOOLS,
  PHONE_PREFIX_EST_TOKENS,
  PHONE_TOOL_ARGS,
  estimateTokens,
  kstDate,
  validPhoneToolCall,
  won,
} from '@sax/chat-core';
import * as engine from '@sax/engine';
import { CHAT_DIGEST, CHAT_PHONE, toolsetPrefix } from '@sax/model';
import { Redactor, utf8Length, wasMinted } from '@sax/redaction';

const Ajv2020 = (createRequire(new URL('../packages/model/package.json', import.meta.url))('ajv/dist/2020.js') as { default: new (o: { strict: boolean }) => { compile(schema: object): (v: unknown) => boolean } }).default;

describe('chat-core: 순수 TS(폰에 그대로 들어간다)', () => {
  it('@sax/redaction·@sax/chat-core 소스에 Node 전용 API가 없다(tsconfig types: []가 컴파일에서 막고, 여기서 한 번 더 본다)', () => {
    for (const dir of ['../packages/redaction/src/', '../packages/chat-core/src/']) {
      for (const f of fs.readdirSync(new URL(dir, import.meta.url))) {
        const src = fs.readFileSync(new URL(dir + f, import.meta.url), 'utf8');
        assert.doesNotMatch(src, /from 'node:|\bBuffer\.|\bprocess\.|require\(/, `${dir}${f}`);
      }
    }
    for (const p of ['../packages/redaction/tsconfig.json', '../packages/chat-core/tsconfig.json']) {
      assert.deepEqual((JSON.parse(fs.readFileSync(new URL(p, import.meta.url), 'utf8')) as { compilerOptions: { types: string[] } }).compilerOptions.types, [], p);
    }
  });

  it('utf8Length는 Buffer.byteLength와 같다(한글·이모지·짝 없는 서로게이트)', () => {
    for (const s of ['', 'abc', '한빛전자에 55만원', '😀 발급 ✓', 'a\ud83dz', '\udc00끝', '﷽', 'ß→€', '[NAME_1]에 [AMT_2]']) assert.equal(utf8Length(s), Buffer.byteLength(s, 'utf8'), JSON.stringify(s));
  });

  it('발급 영수증(wasMinted)은 순수 JS 해시로도 그대로 돈다', () => {
    const red = new Redactor({ chatSessionId: 'chat_parity' });
    const out = red.apply('사업자번호 123-45-67890으로 55만원', { frame: 'none' }).redacted;
    assert.ok(wasMinted(out));
    assert.ok(!wasMinted(`${out} `));
    assert.ok(!out.includes('123-45-67890'));
  });
});

describe('chat-core: 금액·날짜 표기와 엔진 재수출', () => {
  it('금액·날짜 표기', () => {
    for (const n of [1, 9, 10, 11, 1000, 1100, 550000, 605000, 999999, 1234567, 33_000_000]) assert.equal(won(n), `${n.toLocaleString('en-US')}원`);
    assert.equal(kstDate(Date.UTC(2026, 10, 15, 14, 59)), '2026-11-15');
    assert.equal(kstDate(Date.UTC(2026, 10, 15, 15, 0)), '2026-11-16');
  });

  it('엔진이 다시 내보내는 규칙은 chat-core의 것 그대로다(PC와 폰이 같은 함수)', async () => {
    const core = await import('@sax/chat-core');
    for (const k of ['chatInput', 'chatMaskSpans', 'emailFragmentRes', 'gluedName', 'numberShaped', 'parseKrw', 'typoAliases', 'unsafeText', 'chatAdviceMentioned', 'chatSecretShaped'] as const) {
      assert.equal((engine as Record<string, unknown>)[k], (core as Record<string, unknown>)[k], k);
    }
  });
});

describe('chat-core: 툴셋 정의와 같은 판정', () => {
  it('턴 상한은 게이트웨이 툴셋과 같다', () => {
    assert.equal(CHAT_PHONE_MAX_TURNS, CHAT_PHONE.maxTurns);
  });

  it('도구 인자 검사(PHONE_TOOL_ARGS)는 표의 JSON 스키마(Ajv)와 같은 판정이다', () => {
    const ajv = new Ajv2020({ strict: false });
    const samples: unknown[] = [
      {},
      { counterparty: null },
      { counterparty: '[NAME_1]' },
      { counterparty: 3 },
      { counterparty: '[NAME_1]', extra: 1 },
      { counterparty: '[NAME_1]', amount: null, vat: null, item: null },
      { counterparty: '[NAME_1]', amount: '[AMT_1]', vat: 'separate', item: '컨설팅' },
      { counterparty: '[NAME_1]', amount: '{r1.first.supply}', vat: 'included', item: null },
      { counterparty: '[NAME_1]', amount: 550000, vat: null, item: null },
      { counterparty: '[NAME_1]', amount: null, vat: 'both', item: null },
      { counterparty: null, amount: null, vat: null, item: null },
      { counterparty: '[NAME_1]', amount: null, vat: null },
      { draft: 'd1' },
      { draft: 1 },
      { draft: 'd1', amount: '[AMT_1]', vat: null, item: null },
      { draft: 'd1', amount: null, vat: 'included', item: '자문' },
      { draft: 'd1', amount: null, vat: null, item: 7 },
      { draft: null, amount: null, vat: null, item: null },
    ];
    for (const t of CHAT_PHONE_TOOLS) {
      const v = ajv.compile(t.parameters);
      for (const s of samples) assert.equal(PHONE_TOOL_ARGS[t.name](s as Record<string, unknown>), v(s), `${t.name} ${JSON.stringify(s)}`);
    }
    assert.equal(validPhoneToolCall('sales_summary', { month_offset: 0 }), false, '폰에 없는 도구');
    assert.equal(validPhoneToolCall('invoice_draft', ['x']), false);
    assert.equal(validPhoneToolCall('invoice_history', { counterparty: 'x'.repeat(401) }), false, '너무 긴 인자');
  });

  it('토큰 추정은 BPE 토크나이저보다 작지 않고(상한을 넘기지 않게) 두 배를 넘지 않는다', () => {
    const enc = new Tiktoken(o200k);
    const samples = [
      toolsetPrefix(CHAT_PHONE),
      toolsetPrefix(CHAT_DIGEST),
      '[요약]\n[NAME_1]에 매달 [AMT_1] 세금계산서를 끊는다. 부가세는 별도다.\n[앞 대화]\n사용자: [NAME_1]에 지난번이랑 같은 금액으로 끊어줘\n앱: [NAME_1] 카드를 만들었어요. 맡기면 PC를 켰을 때 시작해요.',
      'invoice_history([NAME_1]) = {"ref":"r5","status":"ok","fields":["date","supply","total","counterparty","approvalNo"],"needs":null}',
      '화면: 카드 d7(세금계산서, 거래처 [NAME_2], 금액 있음, 부가세 별도, 품목 있음)\n사용자: 그거 55만원으로 바꿔줘 please asap',
    ];
    for (const s of samples) {
      const real = enc.encode(s).length;
      const est = estimateTokens(s);
      assert.ok(est >= real, `추정 ${est} < 실제 ${real}: ${s.slice(0, 30)}`);
      assert.ok(est <= real * 2, `추정 ${est} > 실제 ${real}의 두 배: ${s.slice(0, 30)}`);
    }
  });

  it('머리말 + 도구 정의 + 출력 스키마의 추정 토큰은 PHONE_PREFIX_EST_TOKENS 안이다(컨텍스트 상한 계산의 고정 몫)', () => {
    const fixed = estimateTokens(toolsetPrefix(CHAT_PHONE)) + estimateTokens(JSON.stringify(CHAT_PHONE.tools)) + estimateTokens(JSON.stringify(CHAT_PHONE.output));
    assert.ok(fixed <= PHONE_PREFIX_EST_TOKENS, `${fixed} > ${PHONE_PREFIX_EST_TOKENS}`);
    assert.ok(fixed >= PHONE_PREFIX_EST_TOKENS * 0.7, `상수가 너무 크다: ${fixed} vs ${PHONE_PREFIX_EST_TOKENS}`);
  });
});
