import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import ajv2020 from 'ajv/dist/2020.js';
import { identifierTripwire, normalizeForRedaction, wasMinted, type RedactedText } from '@sax/redaction';
import type { ValidateFunction } from 'ajv';

export interface BundleAllowEntry {
  id: string;
  digest: string;
  maxInputBytes: number;
}

export interface GatewayDecideBody {
  bundleId: string;
  bundleDigest: string;
  input: RedactedText;
  runToken: string;
}

export interface GatewayRespondBody {
  toolset: 'selector_repair' | 'summarize' | 'intent_fill' | 'query_parse' | 'chat_reply' | 'chat_agent' | 'page_judge' | 'browser_agent' | 'computer_use' | 'chat_phone' | 'chat_digest' | 'decision_pick';
  messages: Array<{ role: 'user'; content: Array<{ type: 'input_text'; text: RedactedText } | { type: 'input_image'; image_url: string }> }>;
  replay?: Array<{ item: object; tag: string } | { type: 'function_call_output'; call_id: string; output: RedactedText }>;
  runToken: string;
}

export type GuardCode =
  | 'bundle_not_allowlisted'
  | 'schema_rejected'
  | 'input_too_large'
  | 'budget_exceeded'
  | 'pii_tripwire'
  | 'image_rejected'
  | 'unminted_text'
  | 'run_token_unknown'
  | 'run_token_reissue';

/** 보안 이벤트로 올리는 거부(D06 §4 egress 트립와이어). 나머지 거부는 카운트만. */
export const SECURITY_GUARD_CODES: ReadonlySet<GuardCode> = new Set(['pii_tripwire', 'image_rejected', 'unminted_text']);

/**
 * 예산 경계. 플레이북 실행은 runId(원장의 실행 ID), 실행 밖 대화 호출은 chatSessionId(D04 §1).
 * runId 자체를 지어내는 것은 막지 못한다(BYOK 로컬 검사는 엔진 버그·루프에 대한 방어이고, runId 원천은 원장이다).
 */
export type RunScope = { runId: string } | { chatSessionId: string };

const RUN_TOKEN_TTL_MS = 2 * 60 * 60 * 1000;

export class ModelGuardError extends Error {
  readonly code: GuardCode;
  constructor(code: GuardCode) {
    super(code);
    this.code = code;
  }
}

export interface ModelGuardConfig {
  bundles: readonly BundleAllowEntry[];
  budget?: { l1: number; l2: number; agent?: number };
  onSecurity?: (code: GuardCode, surface: 'decide' | 'respond') => void;
}

const L2_MAX_TURNS = 3;

/** l2Calls = 새 L2(replay 없는 호출) 수, l2Turns = 이어지는 턴(replay 있는 호출) 수. 둘은 따로 예산과 비교한다. */
export interface L2Usage {
  l1: number;
  l2Calls: number;
  l2Turns: number;
  agent: number;
}

const AGENT_TOOLSETS: ReadonlySet<string> = new Set(['page_judge', 'browser_agent', 'computer_use', 'decision_pick']);
/**
 * 화면 사진은 computer_use 툴셋의 메시지에만, 요청당 한 장, 가린 JPEG data URL로만(대표 결정 2026-11-16, B-18 예외).
 * 상한은 @sax/model MASKED_SHOT_MAX_BYTES와 같다(tests/computer-use-guard.test.ts가 대조).
 */
export const SHOT_TOOLSET = 'computer_use';
export const SHOT_MAX_BYTES = 900_000;
const SHOT_RE = /^data:image\/jpeg;base64,[A-Za-z0-9+/]+={0,2}$/;
/** 실행당 판정·에이전트 호출 상한(에이전트 25걸음 + 판정 몇 번). */
export const AGENT_CALLS_PER_RUN = 32;

export function piiTripwire(text: string): boolean {
  return identifierTripwire(normalizeForRedaction(text)) !== null;
}

let validators: { decide: ValidateFunction; respond: ValidateFunction } | null = null;

function loadValidators(): NonNullable<typeof validators> {
  if (validators) return validators;
  const schema = JSON.parse(fs.readFileSync(new URL('../schemas/gateway-request.schema.json', import.meta.url), 'utf8')) as { $defs: Record<string, object> };
  const Ajv2020 = ajv2020.default as typeof import('ajv').default;
  const ajv = new Ajv2020({ allErrors: false, strict: false });
  ajv.addSchema(schema);
  const id = 'https://sovereign-ax.dev/schemas/gateway-request.schema.json';
  validators = { decide: ajv.getSchema(`${id}#/$defs/decide`)!, respond: ajv.getSchema(`${id}#/$defs/respond`)! };
  return validators;
}

function hasImage(v: unknown): boolean {
  return imageCount(v) > 0;
}

function imageCount(v: unknown, depth = 0): number {
  if (depth > 32) return 1;
  if (Array.isArray(v)) return v.reduce((n: number, x) => n + imageCount(x, depth + 1), 0);
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    if (o.type === 'input_image' || o.type === 'input_file' || 'image_url' in o || 'file_data' in o) return 1;
    return Object.values(o).reduce((n: number, x) => n + imageCount(x, depth + 1), 0);
  }
  return 0;
}

export class ModelGuard {
  private readonly allow: Map<string, BundleAllowEntry>;
  private readonly budget: { l1: number; l2: number; agent: number };
  private readonly used = new Map<string, L2Usage>();
  private readonly tokens = new Map<string, { scope: string; expiresAt: number }>();
  private readonly active = new Map<string, string>();
  private readonly now: () => number;
  private readonly onSecurity: ModelGuardConfig['onSecurity'];
  private surface: 'decide' | 'respond' = 'decide';
  readonly refusals: Partial<Record<GuardCode, number>> = {};

  constructor(cfg: ModelGuardConfig, now: () => number = Date.now) {
    this.allow = new Map(cfg.bundles.map((b) => [`${b.id}@${b.digest}`, b]));
    this.budget = { l1: cfg.budget?.l1 ?? 12, l2: cfg.budget?.l2 ?? 2, agent: cfg.budget?.agent ?? AGENT_CALLS_PER_RUN };
    this.now = now;
    this.onSecurity = cfg.onSecurity;
  }

  issueRunToken(scope: RunScope): string {
    const key = 'runId' in scope ? `run:${scope.runId}` : `chat:${scope.chatSessionId}`;
    const cur = this.active.get(key);
    if (cur && (this.tokens.get(cur)?.expiresAt ?? 0) > this.now()) this.fail('run_token_reissue');
    if (cur) this.tokens.delete(cur);
    const token = `local.${randomBytes(24).toString('base64url')}`;
    this.tokens.set(token, { scope: key, expiresAt: this.now() + RUN_TOKEN_TTL_MS });
    this.active.set(key, token);
    return token;
  }

  endRun(scope: RunScope): void {
    const key = 'runId' in scope ? `run:${scope.runId}` : `chat:${scope.chatSessionId}`;
    const cur = this.active.get(key);
    if (cur) this.tokens.delete(cur);
    this.active.delete(key);
  }

  private scopeOf(runToken: string): string | null {
    const t = this.tokens.get(runToken);
    return t && t.expiresAt > this.now() ? t.scope : null;
  }

  private fail(code: GuardCode): never {
    this.refusals[code] = (this.refusals[code] ?? 0) + 1;
    if (SECURITY_GUARD_CODES.has(code)) this.onSecurity?.(code, this.surface);
    throw new ModelGuardError(code);
  }

  inspect(surface: 'decide', body: GatewayDecideBody, providerBody?: unknown): void;
  inspect(surface: 'respond', body: GatewayRespondBody, providerBody?: unknown): void;
  inspect(surface: 'decide' | 'respond', body: GatewayDecideBody | GatewayRespondBody, providerBody: unknown = body): void {
    this.surface = surface;
    const v = loadValidators();
    if (!v[surface](body)) this.fail('schema_rejected');
    const texts: string[] = [];
    if (surface === 'decide') {
      const b = body as GatewayDecideBody;
      const entry = this.allow.get(`${b.bundleId}@${b.bundleDigest}`);
      if (!entry) this.fail('bundle_not_allowlisted');
      if (Buffer.byteLength(b.input, 'utf8') > entry.maxInputBytes) this.fail('input_too_large');
      texts.push(b.input);
    } else {
      const b = body as GatewayRespondBody;
      let shots = 0;
      for (const m of b.messages) {
        for (const c of m.content) {
          if (c.type === 'input_text') {
            texts.push(c.text);
            continue;
          }
          if (b.toolset !== SHOT_TOOLSET || typeof c.image_url !== 'string' || c.image_url.length > SHOT_MAX_BYTES || !SHOT_RE.test(c.image_url)) this.fail('image_rejected');
          shots++;
        }
      }
      for (const r of b.replay ?? []) if ('output' in r) texts.push(r.output);
      if (shots > 1 || hasImage(b.replay ?? [])) this.fail('image_rejected');
      if (imageCount(providerBody) !== shots) this.fail('image_rejected');
      if (texts.some(piiTripwire)) this.fail('pii_tripwire');
      if (!texts.every(wasMinted)) this.fail('unminted_text');
      return;
    }
    if (hasImage(providerBody)) this.fail('image_rejected');
    if (texts.some(piiTripwire)) this.fail('pii_tripwire');
    if (!texts.every(wasMinted)) this.fail('unminted_text');
  }

  check(surface: 'decide', body: GatewayDecideBody, providerBody: unknown): void;
  check(surface: 'respond', body: GatewayRespondBody, providerBody: unknown): void;
  check(surface: 'decide' | 'respond', body: GatewayDecideBody | GatewayRespondBody, providerBody: unknown): void {
    if (surface === 'decide') this.inspect('decide', body as GatewayDecideBody, providerBody);
    else this.inspect('respond', body as GatewayRespondBody, providerBody);
    const scope = this.scopeOf(body.runToken);
    if (!scope) this.fail('run_token_unknown');
    const u = this.used.get(scope) ?? { l1: 0, l2Calls: 0, l2Turns: 0, agent: 0 };
    if (surface === 'respond' && AGENT_TOOLSETS.has((body as GatewayRespondBody).toolset)) {
      if (u.agent >= this.budget.agent) this.fail('budget_exceeded');
      u.agent++;
    } else if (surface === 'decide') {
      if (u.l1 >= this.budget.l1) this.fail('budget_exceeded');
      u.l1++;
    } else if (!(body as GatewayRespondBody).replay?.length) {
      if (u.l2Calls >= this.budget.l2) this.fail('budget_exceeded');
      u.l2Calls++;
    } else {
      if (u.l2Calls === 0 || u.l2Turns >= this.budget.l2 * (L2_MAX_TURNS - 1)) this.fail('budget_exceeded');
      u.l2Turns++;
    }
    this.used.set(scope, u);
  }

  usage(runToken: string): L2Usage {
    const scope = this.tokens.get(runToken)?.scope;
    return { ...((scope && this.used.get(scope)) || { l1: 0, l2Calls: 0, l2Turns: 0, agent: 0 }) };
  }
}
