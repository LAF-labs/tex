// 폰 대화 툴셋 chat_phone·chat_digest(ADR-047): 손으로 맞추는 목록 대조(툴셋 id·게이트웨이 등록·머리말), 발급 도구 없음, PC 툴셋과 같은 문법.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  AGENT_ASKS,
  AGENT_REPLY_KINDS,
  CHAT_AGENT,
  CHAT_AGENT_TOOLS,
  CHAT_DIGEST,
  CHAT_DIGEST_MAX_CHARS,
  CHAT_PHONE,
  CHAT_PHONE_TOOLS,
  PHONE_COPY_STATES,
  PHONE_OMITTED_TOOLS,
  PHONE_ONLY_TOOLSETS,
  PHONE_REPLY_KINDS,
  PHONE_TOOLSETS,
  PHONE_TOOL_STATUSES,
  SLOT_FIELDS,
  SLOT_POSITIONS,
  TOOLSET_IDS,
  slotPattern,
  toolsetDigest,
  toolsetPrefix,
} from '@sax/model';
import { gatewayToolsets, toolsetAllowed } from '../services/gateway/src/index.ts';

type Strict = { type: string; properties: Record<string, unknown>; required: string[]; additionalProperties: boolean };
const assertStrict = (s: Strict, label: string) => {
  assert.equal(s.type, 'object', label);
  assert.equal(s.additionalProperties, false, label);
  assert.deepEqual([...s.required].sort(), Object.keys(s.properties).sort(), `${label}: 모든 칸 required`);
};

describe('폰 대화 툴셋 등록(목록 대조)', () => {
  it('두 툴셋 모두 TOOLSET_IDS와 게이트웨이에 있고, 게이트웨이는 로컬 정의 그대로 쓴다', () => {
    const gw = gatewayToolsets();
    for (const id of PHONE_TOOLSETS) assert.ok((TOOLSET_IDS as readonly string[]).includes(id), id);
    assert.equal(gw.get('chat_phone'), CHAT_PHONE);
    assert.equal(gw.get('chat_digest'), CHAT_DIGEST);
    assert.notEqual(toolsetDigest(CHAT_PHONE), toolsetDigest(CHAT_AGENT));
  });

  it('역할별 툴셋: 폰은 PHONE_TOOLSETS만, 데스크톱은 폰 전용을 뺀 전부', () => {
    for (const id of TOOLSET_IDS) {
      assert.equal(toolsetAllowed('mobile', id), (PHONE_TOOLSETS as readonly string[]).includes(id), `mobile ${id}`);
      assert.equal(toolsetAllowed('desktop', id), !(PHONE_ONLY_TOOLSETS as readonly string[]).includes(id), `desktop ${id}`);
    }
    for (const bad of [undefined, null, 7, {}, ['chat_phone']]) assert.equal(toolsetAllowed('mobile', bad), false);
    assert.deepEqual([...PHONE_ONLY_TOOLSETS], ['chat_phone']);
  });

  it('chat_phone 도구는 chat_agent 표에서 폰에 없는 것만 뺀 것이다(이름·인자 모양이 PC와 같다)', () => {
    const pc = new Map(CHAT_AGENT_TOOLS.map((t) => [t.name as string, t.parameters]));
    assert.deepEqual(CHAT_PHONE_TOOLS.map((t) => t.name), CHAT_AGENT_TOOLS.map((t) => t.name as string).filter((n) => !(PHONE_OMITTED_TOOLS as readonly string[]).includes(n)));
    for (const t of CHAT_PHONE.tools) {
      assertStrict(t.parameters as Strict, t.name);
      assert.deepEqual(t.parameters, pc.get(t.name), t.name);
    }
    assert.equal(CHAT_PHONE.tools.length, 5);
  });

  it('출력 스키마는 strict이고 PC 답 종류에 defer만 더한다. chat_digest는 summary 한 칸', () => {
    const out = CHAT_PHONE.output.schema as Strict & { properties: { kind: { enum: string[] }; show: { maxItems: number }; ask: { enum: unknown[] } } };
    assertStrict(out, 'chat_phone output');
    assert.deepEqual(out.properties.kind.enum, [...AGENT_REPLY_KINDS, 'defer']);
    assert.deepEqual([...PHONE_REPLY_KINDS], [...AGENT_REPLY_KINDS, 'defer']);
    assert.deepEqual(out.properties.ask.enum, [...AGENT_ASKS, null]);
    assert.equal(out.properties.show.maxItems, 3);
    assert.deepEqual([CHAT_PHONE.effort, CHAT_PHONE.maxOutputTokens, CHAT_PHONE.maxTurns, CHAT_PHONE.commonPrefix], ['low', 4000, 4, false]);
    assertStrict(CHAT_DIGEST.output.schema as Strict, 'chat_digest output');
    assert.deepEqual(Object.keys((CHAT_DIGEST.output.schema as Strict).properties), ['summary']);
    assert.deepEqual([CHAT_DIGEST.tools.length, CHAT_DIGEST.maxTurns, CHAT_DIGEST.commonPrefix], [0, 1, false]);
  });
});

describe('폰 대화: 발급·실행 도구 없음', () => {
  it('어떤 도구 이름도 발급·전송·승인·제출·준비·맡기기가 아니다', () => {
    for (const t of CHAT_PHONE_TOOLS) assert.doesNotMatch(t.name, /issue|send|approve|submit|prepare|queue|run|start/, t.name);
  });
});

describe('chat_phone 머리말', () => {
  const p = toolsetPrefix(CHAT_PHONE);

  it('모든 도구 이름·status·슬롯 위치·슬롯 칸·답 종류·되묻기 칸·사본 상태·입력 묶음을 적는다', () => {
    for (const w of [...CHAT_PHONE_TOOLS.map((t) => t.name), ...PHONE_TOOL_STATUSES, ...SLOT_POSITIONS, ...SLOT_FIELDS, 'sum.supply', 'sum.total', 'count', ...PHONE_REPLY_KINDS, ...AGENT_ASKS, ...PHONE_COPY_STATES]) assert.ok(p.includes(w), w);
    for (const block of ['[요약]', '[앞 대화]', '[사실]', '[지금]', '사본:', '(PC에서)']) assert.ok(p.includes(block), block);
  });

  it('폰에 없는 도구는 도구로 적지 않고, PC가 꺼져 있음·맡기기·defer·세무 판단·데이터 규칙을 적는다', () => {
    for (const t of PHONE_OMITTED_TOOLS) assert.ok(!p.includes(t), t);
    assert.doesNotMatch(p, /판정기다/);
    assert.match(p, /PC는 꺼져 있다/);
    assert.match(p, /발급·전송 도구는 없다/);
    assert.match(p, /kind defer/);
    assert.match(p, /# 세무 판단/);
    assert.match(p, /kind tax_advice/);
    assert.match(p, /# 데이터 규칙/);
    const examples = [...p.matchAll(/\{r\d+\.[a-z]+(?:\.[a-z]+)?\}/g)].map((m) => m[0]);
    assert.ok(examples.length >= 3);
    for (const s of examples) assert.match(s, slotPattern, s);
  });
});

describe('chat_digest 머리말', () => {
  const p = toolsetPrefix(CHAT_DIGEST);

  it('입력 묶음·글자 상한·토큰 규칙·데이터 규칙을 적고, 발급했다고 적지 말라고 한다', () => {
    for (const w of ['[앞 요약]', '[대화]', '(PC에서)', '(폰에서)', `${CHAT_DIGEST_MAX_CHARS}자`, '[NAME_1]', '# 데이터 규칙', 'summary']) assert.ok(p.includes(w), w);
    assert.match(p, /발급했다고 적지 않는다/);
    assert.doesNotMatch(p, /판정기다/);
  });
});
