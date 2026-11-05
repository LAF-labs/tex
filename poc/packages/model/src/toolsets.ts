// L2 툴셋 정의(D04 §4). effort·max_output_tokens·도구·출력 스키마는 툴셋이 정하고 클라이언트 필드가 아니다(B-20).
// PoC-7 범위: selector_repair(S9 store:false 재생 측정)와 query_parse. summarize·intent_fill은 PoC-9 이후.
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

const DIR = new URL('../toolsets/', import.meta.url);

export function toolsetPrefix(t: ToolsetDef): string {
  const common = fs.readFileSync(new URL('../bundles/prefixes/_common.ko.txt', import.meta.url), 'utf8').trim();
  return `${common}\n\n${fs.readFileSync(new URL(`${t.prefixKey}.ko.txt`, DIR), 'utf8').trim()}`;
}

/**
 * 툴셋 해시(게이트웨이 /v1/respond 응답 toolsetDigest와 같은 정의, services/gateway/API.md):
 * sha256(정규 JSON({prefix, tools, output, effort, maxOutputTokens})). 게이트웨이가 다른 툴셋 정의로 불렀는지 대조한다.
 */
export function toolsetDigest(t: ToolsetDef): string {
  return createHash('sha256').update(canonicalJson({ prefix: toolsetPrefix(t), tools: t.tools, output: t.output, effort: t.effort, maxOutputTokens: t.maxOutputTokens })).digest('hex');
}
