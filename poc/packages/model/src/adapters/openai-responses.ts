import { createHmac, randomBytes } from 'node:crypto';
import ajv2020 from 'ajv/dist/2020.js';
import OpenAI from 'openai';
import type { ValidateFunction } from 'ajv';
import { GatewayError, ModelGuardError, isRespondResponse, type Egress, type GatewayRespondBody } from '@sax/net';
import type { GatewayTaggedItem, RedactedReplayItem, RespondRequest, RespondResult, ToolCall } from '../contract.ts';
import { ZERO_USAGE } from '../contract.ts';
import { canonicalJson } from '../bundle/digest.ts';
import { toolsetDigest, toolsetPrefix, type ToolsetDef } from '../toolsets.ts';
import { errorView, rateLimitHeaders } from './openai-decisions.ts';
import { DEFAULT_RETRY, withRetry, type RetryPolicy } from './retry.ts';
import { AdapterError } from './types.ts';

export const TERRA = 'gpt-6.1-terra';

export interface OpenAIResponsesOptions {
  apiKey?: string;
  transport?: 'byok' | 'gateway';
  egress: Egress;
  model?: string;
  retry?: RetryPolicy;
  timeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

const Ajv2020 = ajv2020.default as typeof import('ajv').default;

export class OpenAIResponsesAdapter {
  readonly model: string;
  readonly lastRateLimit: Record<string, string> = {};
  private readonly client: OpenAI | null;
  private readonly egress: Egress;
  private readonly opts: OpenAIResponsesOptions;
  private readonly tagKey = randomBytes(32);
  private readonly ajv = new Ajv2020({ strict: false });
  private readonly validators = new Map<string, ValidateFunction>();

  constructor(opts: OpenAIResponsesOptions) {
    this.opts = opts;
    this.egress = opts.egress;
    this.model = opts.model ?? TERRA;
    if (opts.transport !== 'gateway' && !opts.apiKey) throw new Error('OpenAIResponsesAdapter: byok transport needs apiKey');
    this.client = opts.transport === 'gateway' ? null : new OpenAI({ apiKey: opts.apiKey, organization: null, project: null, fetch: opts.egress.providerFetch, maxRetries: 0, timeout: opts.timeoutMs ?? 60_000 });
  }

  private tag(runToken: string, item: object): string {
    return createHmac('sha256', this.tagKey).update(runToken).update('\u0000').update(canonicalJson(item)).digest('hex');
  }

  private tagged(runToken: string, item: object): GatewayTaggedItem {
    return { item, tag: this.tag(runToken, item) } as GatewayTaggedItem;
  }

  private validator(key: string, schema: object): ValidateFunction {
    let v = this.validators.get(key);
    if (!v) {
      v = this.ajv.compile(schema);
      this.validators.set(key, v);
    }
    return v;
  }

  buildRequest(t: ToolsetDef, req: RespondRequest): Record<string, unknown> {
    const replay = req.replay.map((r) => (r.kind === 'model_output' ? r.item.item : { type: 'function_call_output', call_id: r.callId, output: r.output }));
    return {
      model: this.model,
      store: false,
      include: ['reasoning.encrypted_content'],
      reasoning: { effort: t.effort },
      max_output_tokens: t.maxOutputTokens,
      parallel_tool_calls: false,
      prompt_cache_options: { mode: 'explicit' },
      prompt_cache_key: `sax:t:${t.id}`,
      input: [{ role: 'developer', content: [{ type: 'input_text', text: toolsetPrefix(t), prompt_cache_breakpoint: { mode: 'explicit' } }] }, ...req.messages, ...replay],
      ...(t.tools.length ? { tools: t.tools.map((x) => ({ type: 'function', name: x.name, strict: true, parameters: x.parameters })) } : {}),
      text: { format: { type: 'json_schema', name: t.output.name, strict: true, schema: t.output.schema } },
    };
  }

  async respond(t: ToolsetDef, req: RespondRequest): Promise<RespondResult> {
    const fail = (reason: string): RespondResult => ({ status: 'incomplete', toolCalls: [], replay: [], usage: ZERO_USAGE, reason });
    if (t.id !== req.toolset) return fail('toolset_mismatch');
    const turns = req.replay.filter((r) => r.kind === 'model_output' && (r.item.item as { type?: string }).type !== 'reasoning').length;
    if (turns >= t.maxTurns) return fail('turn_limit');
    const viaGateway = this.opts.transport === 'gateway';
    if (!viaGateway) for (const r of req.replay) if (r.kind === 'model_output' && r.item.tag !== this.tag(req.runToken, r.item.item)) return fail('replay_tag_mismatch');
    const body = this.buildRequest(t, req);
    const gateway: GatewayRespondBody = {
      toolset: req.toolset,
      messages: req.messages,
      replay: req.replay.map((r) => (r.kind === 'model_output' ? { item: r.item.item, tag: r.item.tag } : { type: 'function_call_output' as const, call_id: r.callId, output: r.output })),
      runToken: req.runToken,
    };
    let data: { status?: string; output?: Array<Record<string, unknown>>; usage?: Record<string, unknown> };
    let gatewayTags: string[] | null = null;
    if (viaGateway) {
      let r: unknown;
      try {
        r = await this.egress.toGateway({ surface: 'respond', body: gateway });
      } catch (e) {
        if (e instanceof GatewayError) return fail(`gateway:${e.code.slice('gateway.'.length)}`);
        if (e instanceof ModelGuardError) return fail(`guard:${e.code}`);
        return fail('provider:egress');
      }
      if (!isRespondResponse(r)) return fail('gateway:bad_response');
      if (r.toolsetDigest !== toolsetDigest(t)) return fail('toolset_digest_mismatch');
      data = { status: r.status, output: r.output.map((o) => o.item), usage: r.usage };
      gatewayTags = r.output.map((o) => o.tag);
    } else {
      let res;
      try {
        res = await this.egress.toModel({ surface: 'respond', dest: 'openai', path: '/v1/responses', gateway, providerBody: body }, (headers) =>
          withRetry(() => this.client!.responses.create(body as never, { headers }).withResponse(), errorView, { policy: this.opts.retry ?? DEFAULT_RETRY, sleep: this.opts.sleep }),
        );
      } catch (e) {
        const v = e instanceof AdapterError ? e : errorView(e);
        return fail(`provider:${v instanceof AdapterError ? v.code : 'unavailable'}`);
      }
      Object.assign(this.lastRateLimit, rateLimitHeaders(res.value.response.headers));
      data = res.value.data as unknown as typeof data;
    }
    const u = (data.usage ?? {}) as { input_tokens?: number; output_tokens?: number; input_tokens_details?: { cached_tokens?: number; cache_write_tokens?: number } };
    const d = viaGateway ? undefined : u.input_tokens_details;
    const usage = { inputTokens: u.input_tokens ?? 0, cachedTokens: d?.cached_tokens ?? 0, cacheWriteTokens: d?.cache_write_tokens ?? 0, outputTokens: u.output_tokens ?? 0 };
    const items = data.output ?? [];
    const replay: RedactedReplayItem[] = items.map((item, i) => ({ kind: 'model_output', item: gatewayTags ? ({ item, tag: gatewayTags[i]! } as GatewayTaggedItem) : this.tagged(req.runToken, item) }));
    const toolCalls: ToolCall[] = [];
    let output: unknown;
    let refused = false;
    for (const item of items) {
      if (item.type === 'function_call') {
        const def = t.tools.find((x) => x.name === item.name);
        let args: unknown;
        try {
          args = JSON.parse(String(item.arguments));
        } catch {
          return { ...fail('tool_call_rejected'), usage };
        }
        if (!def || !this.validator(`${t.id}:${def.name}`, def.parameters)(args)) return { ...fail('tool_call_rejected'), usage };
        toolCalls.push({ callId: String(item.call_id), name: def.name, arguments: args });
      } else if (item.type === 'message') {
        for (const c of (item.content as Array<Record<string, unknown>>) ?? []) {
          if (c.type === 'refusal') refused = true;
          if (c.type === 'output_text') {
            try {
              output = JSON.parse(String(c.text));
            } catch {
              return { ...fail('output_schema_mismatch'), usage };
            }
            if (!this.validator(`${t.id}:out`, t.output.schema)(output)) return { ...fail('output_schema_mismatch'), usage };
          }
        }
      } else if (item.type !== 'reasoning') {
        return { ...fail('unexpected_item'), usage };
      }
    }
    if (refused) return { status: 'refusal', toolCalls: [], replay: [], usage };
    if (data.status !== 'completed') return { status: 'incomplete', toolCalls: [], replay: [], usage, reason: 'provider_incomplete' };
    return { status: 'completed', output, toolCalls, replay, usage };
  }
}
