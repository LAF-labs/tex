// 대화 에이전트 툴셋 chat_agent(D04 §4): 손으로 맞추는 목록 대조(툴셋 id·스키마 열거·게이트웨이 등록·머리말), 발급 도구 없음, 슬롯 문법.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { AGENT_ASKS, AGENT_REPLY_KINDS, CHAT_AGENT, CHAT_AGENT_TOOLS, SLOT_FIELDS, SLOT_POSITIONS, TOOLSET_IDS, slotPattern, toolsetPrefix } from '@sax/model';
import { gatewayToolsets } from '../services/gateway/src/index.ts';

const root = path.resolve(import.meta.dirname, '..');
const schemaEnum = (rel: string) => (JSON.parse(fs.readFileSync(path.join(root, rel), 'utf8')) as { $defs: { respond: { properties: { toolset: { enum: string[] } } } } }).$defs.respond.properties.toolset.enum;

type Strict = { type: string; properties: Record<string, unknown>; required: string[]; additionalProperties: boolean };
const assertStrict = (s: Strict, label: string) => {
  assert.equal(s.type, 'object', label);
  assert.equal(s.additionalProperties, false, label);
  assert.deepEqual([...s.required].sort(), Object.keys(s.properties).sort(), `${label}: 모든 칸 required`);
};

describe('chat_agent 툴셋 등록(목록 대조)', () => {
  it('gateway-request 스키마(설계 정본·net·engine 사본)의 toolset 열거가 TOOLSET_IDS와 같다', () => {
    for (const rel of ['../sovereign-ax/design/schemas/gateway-request.schema.json', 'packages/net/schemas/gateway-request.schema.json', 'packages/engine/schemas/gateway-request.schema.json']) assert.deepEqual(schemaEnum(rel), [...TOOLSET_IDS], rel);
  });

  it('게이트웨이 툴셋은 모두 TOOLSET_IDS 안에 있고, chat_agent는 로컬 정의 그대로다', () => {
    const gw = gatewayToolsets();
    for (const id of gw.keys()) assert.ok((TOOLSET_IDS as readonly string[]).includes(id), id);
    assert.equal(gw.get('chat_agent'), CHAT_AGENT);
    for (const [id, t] of gw) assert.equal(t.id, id);
  });

  it('도구·출력 스키마는 strict 모양(additionalProperties false, 모든 칸 required), 출력 열거는 표에서 나온다', () => {
    assert.deepEqual(CHAT_AGENT.tools.map((t) => t.name), CHAT_AGENT_TOOLS.map((t) => t.name));
    for (const t of CHAT_AGENT.tools) assertStrict(t.parameters as Strict, t.name);
    const out = CHAT_AGENT.output.schema as Strict & { properties: { kind: { enum: string[] }; show: { maxItems: number }; ask: { enum: unknown[] } } };
    assertStrict(out, 'output');
    assert.deepEqual(Object.keys(out.properties).sort(), ['ask', 'kind', 'show', 'text']);
    assert.deepEqual(out.properties.kind.enum, [...AGENT_REPLY_KINDS]);
    assert.deepEqual(out.properties.ask.enum, [...AGENT_ASKS, null]);
    assert.equal(out.properties.show.maxItems, 3);
    assert.deepEqual([CHAT_AGENT.effort, CHAT_AGENT.maxOutputTokens, CHAT_AGENT.maxTurns, CHAT_AGENT.commonPrefix], ['low', 4000, 4, false]);
  });
});

describe('chat_agent 발급 도구 없음', () => {
  it('어떤 도구 이름도 발급·전송·승인·제출·준비가 아니다', () => {
    for (const t of CHAT_AGENT_TOOLS) assert.doesNotMatch(t.name, /issue|send|approve|submit|prepare/, t.name);
  });
});

describe('chat_agent 머리말', () => {
  const p = toolsetPrefix(CHAT_AGENT);

  it('모든 도구 이름·슬롯 위치·슬롯 칸을 적는다', () => {
    for (const w of [...CHAT_AGENT_TOOLS.map((t) => t.name), ...SLOT_POSITIONS, ...SLOT_FIELDS]) assert.ok(p.includes(w), w);
  });

  it('공통 판정기 머리말이 없고, 세무 판단·데이터 규칙·발급 버튼·슬롯 예시를 적는다', () => {
    assert.doesNotMatch(p, /판정기다/);
    assert.match(p, /# 세무 판단/);
    assert.match(p, /kind tax_advice/);
    assert.match(p, /# 데이터 규칙/);
    assert.match(p, /발급·전송 도구는 없다/);
    assert.match(p, /\[홈택스에서 준비\]/);
    const examples = [...p.matchAll(/\{r\d+\.[a-z]+\.[a-z]+\}/g)].map((m) => m[0]);
    assert.ok(examples.length >= 2);
    for (const s of examples) assert.match(s, slotPattern, s);
  });
});

describe('결과 슬롯 문법', () => {
  it('{r<N>.first|last.<칸>}만 맞는다', () => {
    for (const ok of ['{r1.first.supply}', '{r12.last.date}', '{r3.first.counterparty}', '{r3.last.total}']) assert.match(ok, slotPattern, ok);
    for (const bad of ['{r1.middle.supply}', '{d1.first.supply}', '{r1.first.amount}', 'r1.first.supply', '{r0.first.date}', '{r1.first.supply}x', '{ r1.first.supply}']) assert.doesNotMatch(bad, slotPattern, bad);
  });
});
