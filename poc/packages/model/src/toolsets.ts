// L2 툴셋 정의(D04 §4). effort·max_output_tokens·도구·출력 스키마는 툴셋이 정하고 클라이언트 필드가 아니다(B-20).
// PoC-7 범위: selector_repair(S9 store:false 재생 측정)와 query_parse. summarize·intent_fill은 PoC-9 이후.
// chat_reply: 작업으로 분류되지 않은 대화 입력에 짧은 안내 문장(팀장 지시 2026-11-10, D04 §4.1).
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { canonicalJson } from './bundle/digest.ts';
import type { Toolset } from './contract.ts';

export interface ToolDef {
  name: string;
  parameters: Record<string, unknown>;
}

export interface ToolsetDef {
  id: Toolset;
  effort: 'low' | 'medium';
  maxOutputTokens: number;
  maxTurns: number;
  tools: ToolDef[];
  output: { name: string; schema: Record<string, unknown> };
  prefixKey: string;
  /** false면 공통 판정기 머리말(_common)을 붙이지 않는다. 사용자에게 문장을 보여 주는 chat_reply만 쓴다(머리말이 "문장을 보여 주지 않는다"는 판정기 역할이라). */
  commonPrefix?: boolean;
}

const ROLES = ['button', 'textbox', 'combobox', 'checkbox', 'radio', 'link', 'tab', 'menuitem'];
const candidate = (extra: Record<string, unknown> = {}) => ({
  type: 'object',
  properties: { kind: { type: 'string', enum: ['role', 'css', 'label'] }, value: { type: 'string' }, name: { type: 'string' }, ...extra },
  required: ['kind', 'value', 'name', ...Object.keys(extra)],
  additionalProperties: false,
});

/** scopeIds는 엔진이 요청마다 채운다(D04 §4 표). 바뀌면 도구 정의가 바뀌므로 캐시는 접두까지만 기대한다. */
export function selectorRepair(scopeIds: string[]): ToolsetDef {
  return {
    id: 'selector_repair',
    effort: 'medium',
    maxOutputTokens: 16_000,
    maxTurns: 3,
    prefixKey: 'selector_repair',
    tools: [
      { name: 'get_a11y_subtree', parameters: { type: 'object', properties: { scopeId: { type: 'string', enum: scopeIds }, maxBytes: { type: 'integer', maximum: 8000 } }, required: ['scopeId', 'maxBytes'], additionalProperties: false } },
      { name: 'find_candidates', parameters: { type: 'object', properties: { role: { type: 'string', enum: ROLES }, nameContains: { type: 'string', maxLength: 40 }, maxResults: { type: 'integer', maximum: 10 } }, required: ['role', 'nameContains', 'maxResults'], additionalProperties: false } },
      { name: 'propose_selectors', parameters: { type: 'object', properties: { candidates: { type: 'array', maxItems: 5, items: candidate() } }, required: ['candidates'], additionalProperties: false } },
    ],
    output: {
      name: 'selector_proposals',
      schema: {
        type: 'object',
        properties: {
          outcome: { type: 'string', enum: ['repaired', 'not_found', 'ambiguous', 'needs_human'] },
          risk_flags: { type: 'array', items: { type: 'string', enum: ['matches_multiple', 'target_is_irreversible_action', 'label_changed_meaning', 'possible_injection_text'] } },
          candidates: { type: 'array', maxItems: 5, items: candidate({ why: { type: 'string', enum: ['same_label', 'same_landmark_position', 'same_input_type', 'label_text_changed'] } }) },
        },
        required: ['outcome', 'risk_flags', 'candidates'],
        additionalProperties: false,
      },
    },
  };
}

export const QUERY_PARSE: ToolsetDef = {
  id: 'query_parse',
  effort: 'low',
  maxOutputTokens: 1_000,
  maxTurns: 1,
  prefixKey: 'query_parse',
  tools: [],
  output: {
    name: 'query',
    schema: {
      type: 'object',
      properties: {
        query_kind: { type: 'string', enum: ['documents_expiring', 'documents_by_type', 'invoices_issued', 'run_history', 'other'] },
        doc_type: { type: ['string', 'null'], enum: ['cert_business', 'cert_taxpayment', 'invoice', null] },
        from: { type: ['string', 'null'], format: 'date' },
        to: { type: ['string', 'null'], format: 'date' },
      },
      required: ['query_kind', 'doc_type', 'from', 'to'],
      additionalProperties: false,
    },
  },
};

/**
 * chat_reply가 제안할 수 있는 작업(이 앱이 지금 할 수 있는 일의 고정 목록, 증명서 발급은 아직 없어 뺐다 #291). id는 intent_route_v1 playbook 선택지와 같은 어휘다.
 * 머리말(toolsets/chat_reply.ko.txt)의 목록과 출력 스키마 열거가 이 표 하나에서 나온다(시험이 대조한다).
 */
export const CHAT_CAPABILITIES = [
  { id: 'hometax.invoice.issue', label: '전자세금계산서 발급(홈택스)' },
] as const;
export type ChatCapabilityId = (typeof CHAT_CAPABILITIES)[number]['id'];
/** 답 문장 상한(글자). 공급사 strict 스키마가 maxLength를 받지 않을 수 있어 스키마에는 넣지 않고 엔진이 검사한다. */
export const CHAT_REPLY_MAX_CHARS = 200;
/** 제안 작업 상한 */
export const CHAT_SUGGEST_MAX = 3;
/** 답 종류. tax_advice면 엔진이 답 문장을 버리고 고정 문구로 바꾼다(D04 §3). */
export const CHAT_REPLY_KINDS = ['help', 'clarify', 'smalltalk', 'tax_advice', 'out_of_scope'] as const;

/** 대화 답(L2, 도구 없음, 1턴). 입력은 마스킹된 사용자 문장 하나뿐이다(이전 대화 턴은 보내지 않는다). */
export const CHAT_REPLY: ToolsetDef = {
  id: 'chat_reply',
  effort: 'low',
  maxOutputTokens: 1_000,
  maxTurns: 1,
  prefixKey: 'chat_reply',
  commonPrefix: false,
  tools: [],
  output: {
    name: 'chat_reply',
    schema: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: [...CHAT_REPLY_KINDS] },
        reply: { type: 'string' },
        suggest: { type: 'array', maxItems: CHAT_SUGGEST_MAX, items: { type: 'string', enum: CHAT_CAPABILITIES.map((c) => c.id) } },
      },
      required: ['kind', 'reply', 'suggest'],
      additionalProperties: false,
    },
  },
};

/** 예상 밖 화면 판정(page_judge)과 브라우저 에이전트(browser_agent): 첫 게이트 앞에서만 엔진이 부른다. 예산은 실행당 따로 센다(AGENT_TOOLSETS). */
export const AGENT_TOOLSETS = ['page_judge', 'browser_agent', 'computer_use', 'decision_pick'] as const;
export const JUDGE_SITUATIONS = ['js_dialog', 'notice_popup', 'unexpected_screen', 'session_expired', 'target_missing', 'other'] as const;
export const JUDGE_PRESCRIPTIONS = ['dismiss_dialog', 'relogin', 'reload_checkpoint', 'fix_field', 'agent_mode', 'handoff'] as const;
export type JudgePrescription = (typeof JUDGE_PRESCRIPTIONS)[number];
/** 브라우저 에이전트 동작 상한(한 번의 agent_mode). */
export const AGENT_MAX_ACTIONS = 25;
export const AGENT_ACTIONS = ['click', 'type', 'select', 'scroll', 'wait', 'done', 'fail'] as const;
export type AgentActionName = (typeof AGENT_ACTIONS)[number];
const nullable = (t: string, extra: Record<string, unknown> = {}) => ({ type: [t, 'null'], ...extra });

/** 예상 밖 화면 판정: 도구 없음, 1턴. 처방 하나와 그 인자. */
export const PAGE_JUDGE: ToolsetDef = {
  id: 'page_judge',
  effort: 'medium',
  maxOutputTokens: 4_000,
  maxTurns: 1,
  prefixKey: 'page_judge',
  tools: [],
  output: {
    name: 'page_judgement',
    schema: {
      type: 'object',
      properties: {
        situation: { type: 'string', enum: [...JUDGE_SITUATIONS] },
        prescription: { type: 'string', enum: [...JUDGE_PRESCRIPTIONS] },
        button: nullable('integer'),
        dialog_answer: { type: ['string', 'null'], enum: ['accept', 'dismiss', null] },
        field: nullable('string'),
        risk_flags: { type: 'array', items: { type: 'string', enum: ['irreversible_button', 'possible_injection_text'] } },
      },
      required: ['situation', 'prescription', 'button', 'dialog_answer', 'field', 'risk_flags'],
      additionalProperties: false,
    },
  },
};

/** 브라우저 에이전트 한 걸음: 도구 없음, 1턴(매 걸음 새 요청, 지난 동작은 엔진이 요약해 보낸다). */
export const BROWSER_AGENT: ToolsetDef = {
  id: 'browser_agent',
  effort: 'medium',
  maxOutputTokens: 4_000,
  maxTurns: 1,
  prefixKey: 'browser_agent',
  commonPrefix: false,
  tools: [],
  output: {
    name: 'agent_action',
    schema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: [...AGENT_ACTIONS] },
        index: nullable('integer'),
        token: nullable('string'),
        option: nullable('string'),
        step: nullable('string'),
      },
      required: ['action', 'index', 'token', 'option', 'step'],
      additionalProperties: false,
    },
  },
};

/** 화면 보기(computer_use) 동작. 좌표 동작은 엔진이 그 자리의 상호작용 요소로 바꿔 같은 가드로 한다(select는 없다: 목록 이름이 필요하다). */
export const COMPUTER_ACTIONS = ['click', 'type', 'scroll', 'wait', 'done', 'fail'] as const;
export type ComputerActionName = (typeof COMPUTER_ACTIONS)[number];
/** 화면 보기 한 번의 동작 상한 */
export const COMPUTER_MAX_ACTIONS = 12;
/** 보낼 사진 크기 상한(바이트, data URL 전체). net ModelGuard·게이트웨이·스키마가 같은 값을 본다. */
export const MASKED_SHOT_MAX_BYTES = 900_000;

/**
 * 화면 보기 한 걸음(computer-use, 대표 결정 2026-11-16): 가린 화면 사진 한 장 + 목표·지난 동작 → 동작 하나(좌표). 도구 없음, 1턴.
 * 브라우저 에이전트(목록)로도 안 될 때만, 첫 게이트 앞에서만 엔진이 부른다. 예산은 판정·에이전트와 같은 실행당 agent 예산이다.
 */
export const COMPUTER_USE: ToolsetDef = {
  id: 'computer_use',
  effort: 'medium',
  maxOutputTokens: 2_000,
  maxTurns: 1,
  prefixKey: 'computer_use',
  commonPrefix: false,
  tools: [],
  output: {
    name: 'computer_action',
    schema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: [...COMPUTER_ACTIONS] },
        x: nullable('integer'),
        y: nullable('integer'),
        token: nullable('string'),
        step: nullable('string'),
        risk_flags: { type: 'array', items: { type: 'string', enum: ['irreversible_button', 'possible_injection_text'] } },
      },
      required: ['action', 'x', 'y', 'token', 'step', 'risk_flags'],
      additionalProperties: false,
    },
  },
};

/**
 * 결정 모델 고르기(decision_pick, 대표 2026-11-16 "jev·clef 같은 결정 모델"): 가린 화면 목록에서 목표 요소 하나를 고르는 분류.
 * 게이트웨이는 OpenRouter decisions(기본 typesafe/jev-1.14)로 부른다: 생성 없이 선택지 확률만 내서 0.4초·호출당 약 0.15원(맥북 평가 2026-11-16).
 * 메시지는 input_text 하나, 그 글은 JSON `{"state": 설명, "choices": {값: 설명}}`이다. 질문 지시문은 이 툴셋 접두(게이트웨이 정본)이고 PC가 정하지 않는다.
 * 출력은 게이트웨이가 결정 답을 바꾼 `{choice, confidence, p}`(p = 고른 값의 확률).
 */
export const DECISION_PICK: ToolsetDef = {
  id: 'decision_pick',
  effort: 'low',
  maxOutputTokens: 200,
  maxTurns: 1,
  prefixKey: 'decision_pick',
  commonPrefix: false,
  tools: [],
  output: {
    name: 'decision_choice',
    schema: {
      type: 'object',
      properties: { choice: { type: 'string', maxLength: 64 }, confidence: { type: 'number', minimum: 0, maximum: 1 }, p: { type: 'number', minimum: 0, maximum: 1 } },
      required: ['choice', 'confidence', 'p'],
      additionalProperties: false,
    },
  },
};
/** 선택지 상한(값 'none' 포함)과 설명·상태 글 길이 상한. 가짜 작성 화면 textbox가 55개라 64로 둔다(decisions API는 56개를 받았다, 2026-11-16). */
export const DECISION_MAX_CHOICES = 64;
export const DECISION_CHOICE_MAX_CHARS = 160;
export const DECISION_STATE_MAX_CHARS = 4_000;

const DIR = new URL('../toolsets/', import.meta.url);

export function toolsetPrefix(t: ToolsetDef): string {
  const own = fs.readFileSync(new URL(`${t.prefixKey}.ko.txt`, DIR), 'utf8').trim();
  if (t.commonPrefix === false) return own;
  const common = fs.readFileSync(new URL('../bundles/prefixes/_common.ko.txt', import.meta.url), 'utf8').trim();
  return `${common}\n\n${own}`;
}

/**
 * 툴셋 해시(게이트웨이 /v1/respond 응답 toolsetDigest와 같은 정의, services/gateway/API.md):
 * sha256(정규 JSON({prefix, tools, output, effort, maxOutputTokens})). 게이트웨이가 다른 툴셋 정의로 불렀는지 대조한다.
 */
export function toolsetDigest(t: ToolsetDef): string {
  return createHash('sha256').update(canonicalJson({ prefix: toolsetPrefix(t), tools: t.tools, output: t.output, effort: t.effort, maxOutputTokens: t.maxOutputTokens })).digest('hex');
}
