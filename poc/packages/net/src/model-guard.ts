// D04 §8 BYOK 로컬 검사 4종(B-21). 게이트웨이가 하는 검사를 공급사 직결 전에 egress에서 다시 한다.
// (1) 앱 내장 번들 다이제스트 허용 목록 (2) gateway-request.schema.json 검증 (3) 실행당 예산 (4) 2차 PII 트립와이어.
// 하나라도 실패하면 호출하지 않는다. 실패 기록은 코드·카운트만(본문 무저장, D09·D16).
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
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
  toolset: 'selector_repair' | 'summarize' | 'intent_fill' | 'query_parse';
  messages: Array<{ role: 'user'; content: Array<{ type: 'input_text'; text: RedactedText }> }>;
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
  /** 마스킹 계층이 발급하지 않은 텍스트(브랜드 단언 우회, D06 §8 런타임 확인) */
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

/** 로컬 실행 토큰 수명. 만료 전에는 같은 범위로 재발급하지 않는다. */
const RUN_TOKEN_TTL_MS = 2 * 60 * 60 * 1000;

export class ModelGuardError extends Error {
  readonly code: GuardCode;
  constructor(code: GuardCode) {
    super(code);
    this.code = code;
  }
}

export interface ModelGuardConfig {
  /** 앱 바이너리에 내장된 목록(BV-06). 앱 업데이트로만 바뀐다. */
  bundles: readonly BundleAllowEntry[];
  /** D04 §6: L1 ≤ 12, L2 ≤ 2 */
  budget?: { l1: number; l2: number };
  /** 보안 거부(SECURITY_GUARD_CODES)마다 코드만 알린다. 본문·식별자 없음. */
  onSecurity?: (code: GuardCode, surface: 'decide' | 'respond') => void;
}

/** D04 §4 selector_repair 턴 상한(첫 호출 포함) */
const L2_MAX_TURNS = 3;

/** l2Calls = 새 L2(replay 없는 호출) 수, l2Turns = 이어지는 턴(replay 있는 호출) 수. 둘은 따로 예산과 비교한다. */
export interface L2Usage {
  l1: number;
  l2Calls: number;
  l2Turns: number;
}

// gateway-request.schema.json 규칙 (6): 주민번호·사업자번호·카드·계좌(+법인번호). 마스킹을 통과한 텍스트에 다시 돌린다.
// 규칙 원천은 @sax/redaction entities.ts 하나다(트립와이어가 잡는 것은 마스킹이 먼저 잡는다). 한글 숫자 사본도 본다.
export function piiTripwire(text: string): boolean {
  return identifierTripwire(normalizeForRedaction(text)) !== null;
}

let validators: { decide: ValidateFunction; respond: ValidateFunction } | null = null;

function loadValidators(): NonNullable<typeof validators> {
  if (validators) return validators;
  // src·dist 모두 패키지 루트 한 단계 아래라 같은 상대 경로로 닿는다.
  const schema = JSON.parse(fs.readFileSync(new URL('../schemas/gateway-request.schema.json', import.meta.url), 'utf8')) as { $defs: Record<string, object> };
  const Ajv2020 = createRequire(import.meta.url)('ajv/dist/2020') as typeof import('ajv').default;
  const ajv = new Ajv2020({ allErrors: false, strict: false });
  ajv.addSchema(schema);
  const id = 'https://sovereign-ax.dev/schemas/gateway-request.schema.json';
  validators = { decide: ajv.getSchema(`${id}#/$defs/decide`)!, respond: ajv.getSchema(`${id}#/$defs/respond`)! };
  return validators;
}

function hasImage(v: unknown): boolean {
  if (Array.isArray(v)) return v.some(hasImage);
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    if (o.type === 'input_image' || o.type === 'input_file' || 'image_url' in o) return true;
    return Object.values(o).some(hasImage);
  }
  return false;
}

export class ModelGuard {
  private readonly allow: Map<string, BundleAllowEntry>;
  private readonly budget: { l1: number; l2: number };
  /** 예산은 범위 키(run:/chat:)에 묶는다. 토큰을 새로 받아도 같은 범위면 같은 예산이다. */
  private readonly used = new Map<string, L2Usage>();
  private readonly tokens = new Map<string, { scope: string; expiresAt: number }>();
  private readonly active = new Map<string, string>();
  private readonly now: () => number;
  private readonly onSecurity: ModelGuardConfig['onSecurity'];
  private surface: 'decide' | 'respond' = 'decide';
  /** 거부 카운트만(본문·식별자 없음). */
  readonly refusals: Partial<Record<GuardCode, number>> = {};

  constructor(cfg: ModelGuardConfig, now: () => number = Date.now) {
    this.allow = new Map(cfg.bundles.map((b) => [`${b.id}@${b.digest}`, b]));
    this.budget = cfg.budget ?? { l1: 12, l2: 2 };
    this.now = now;
    this.onSecurity = cfg.onSecurity;
  }

  /**
   * BYOK 경로의 실행 토큰(게이트웨이 runToken 대신, D04 §8 (3)). 범위당 하나만 발급하고 만료·endRun 전에는 재발급을 거부한다.
   * 예산은 토큰이 아니라 범위에 쌓이므로 재발급해도 초기화되지 않는다.
   */
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

  /** 실행 종료: 토큰을 폐기한다(예산 기록은 남긴다). */
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

  /**
   * 게이트웨이 경로의 로컬 검사(D04 §7 앞단): 스키마·앱 내장 번들 허용 목록·입력 한도·이미지 금지·트립와이어·발급 영수증.
   * 실행 예산은 게이트웨이가 서명한 runToken으로 서버가 집행하므로 여기서 세지 않는다.
   */
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
      for (const m of b.messages) for (const c of m.content) texts.push(c.text);
      for (const r of b.replay ?? []) if ('output' in r) texts.push(r.output);
    }
    if (hasImage(providerBody)) this.fail('image_rejected');
    if (texts.some(piiTripwire)) this.fail('pii_tripwire');
    if (!texts.every(wasMinted)) this.fail('unminted_text');
  }

  /** BYOK 검사 4종(+ 이미지·발급 영수증)을 모두 통과하면 예산 1회를 소비한다. providerBody는 공급사로 실제 나갈 본문. */
  check(surface: 'decide', body: GatewayDecideBody, providerBody: unknown): void;
  check(surface: 'respond', body: GatewayRespondBody, providerBody: unknown): void;
  check(surface: 'decide' | 'respond', body: GatewayDecideBody | GatewayRespondBody, providerBody: unknown): void {
    if (surface === 'decide') this.inspect('decide', body as GatewayDecideBody, providerBody);
    else this.inspect('respond', body as GatewayRespondBody, providerBody);
    const scope = this.scopeOf(body.runToken);
    if (!scope) this.fail('run_token_unknown');
    const u = this.used.get(scope) ?? { l1: 0, l2Calls: 0, l2Turns: 0 };
    if (surface === 'decide') {
      if (u.l1 >= this.budget.l1) this.fail('budget_exceeded');
      u.l1++;
    } else if (!(body as GatewayRespondBody).replay?.length) {
      // "L2 ≤ 2회(턴 포함 토큰 상한 별도)"(D04 §6): replay 없는 호출이 새 L2 1회다.
      if (u.l2Calls >= this.budget.l2) this.fail('budget_exceeded');
      u.l2Calls++;
    } else {
      // 이어지는 턴: 열린 L2가 있어야 하고, 실행 전체에서 L2 × (턴 상한 − 1)까지.
      if (u.l2Calls === 0 || u.l2Turns >= this.budget.l2 * (L2_MAX_TURNS - 1)) this.fail('budget_exceeded');
      u.l2Turns++;
    }
    this.used.set(scope, u);
  }

  usage(runToken: string): L2Usage {
    const scope = this.tokens.get(runToken)?.scope;
    return { ...((scope && this.used.get(scope)) || { l1: 0, l2Calls: 0, l2Turns: 0 }) };
  }
}
