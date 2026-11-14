// 모델 게이트웨이 본체(D09 §3, D04 §7, gateway-request.schema.json 규칙 (1)~(7)).
// 본문은 메모리에서만 다룬다: DB에는 계량(계정·월·토큰·비용), 35일 호출 기록(본문 없음), 계정 없는 운영 통계, 실행 예산 카운터만 쓴다.
import fs from 'node:fs';
import ajv2020 from 'ajv/dist/2020.js';
import type { KeyObject } from 'node:crypto';
import type { ValidateFunction } from 'ajv';
import { AGENT_TOOLSETS, BROWSER_AGENT, CHAT_AGENT, CHAT_REPLY, PAGE_JUDGE, QUERY_PARSE, canonicalJson, selectorRepair, toolsetPrefix, type BundleCatalog, type LoadedBundle, type ToolsetDef } from '@sax/model';
import { piiTripwire } from '@sax/net';
import {
  b64u,
  canonical,
  ed25519RawPublic,
  fail,
  fromB64u,
  hmacHex,
  jcs,
  kstDay,
  kstMonth,
  memoryLimits,
  randomToken,
  safeEqual,
  sha256hex,
  signCtx,
  verifyCtx,
  type DeviceClaims,
  type Limits,
  type Sql,
} from '@sax/svc-shared';
import { GATEWAY, ZERO_PRICES, type Prices } from './constants.ts';
import { ProviderError, type ModelProvider, type ProviderUsage } from './providers.ts';
import { NtsUnavailable, type BizStatus, type BizStatusSource } from './nts.ts';

const Ajv2020 = ajv2020.default as typeof import('ajv').default;
const SCHEMA_ID = 'https://sovereign-ax.dev/schemas/gateway-request.schema.json';

/** 정본 스키마는 packages/net/schemas 한 곳(B-20). 게이트웨이는 그 파일을 그대로 읽는다(사본 없음). */
export function loadRequestValidators(): { decide: ValidateFunction; respond: ValidateFunction } {
  const netEntry = new URL(import.meta.resolve('@sax/net'));
  const schema = JSON.parse(fs.readFileSync(new URL('../schemas/gateway-request.schema.json', netEntry), 'utf8')) as object;
  const ajv = new Ajv2020({ allErrors: false, strict: false });
  ajv.addSchema(schema);
  return { decide: ajv.getSchema(`${SCHEMA_ID}#/$defs/decide`)!, respond: ajv.getSchema(`${SCHEMA_ID}#/$defs/respond`)! };
}

/**
 * 게이트웨이 툴셋. selector_repair의 scopeId 열거는 엔진이 요청마다 채우는데 gateway-request 스키마에 scopeIds 필드가 없어
 * 게이트웨이는 형식 제한(영숫자 64자)으로 대신한다. 엔진은 로컬 툴셋 정의(열거 포함)로 도구 호출을 다시 검증한다(C-24).
 * summarize·intent_fill은 packages/model에 정의가 없어 아직 받지 않는다(400).
 * chat_reply(대화 짧은 응대, 팀장 지시 2026-11-10)는 도구 없이 1턴이고 대화 범위(chatSessionId) 예산 l2PerChat을 쓴다.
 * chat_agent(대화 에이전트, 2026-11-12)는 도구 6개·4턴이고 같은 대화 범위 예산을 쓴다. 발급·전송 도구는 없다.
 * page_judge·browser_agent(예상 밖 화면 판정·브라우저 에이전트, 2026-11-13)는 도구 없이 1턴이고 실행 범위의 따로 된 예산(agentPerRun)과
 * 따로 된 모델(models.agent)을 쓴다. 엔진은 첫 게이트 앞에서만 부른다.
 */
/** 판정·에이전트 기본 모델: OpenRouter 라우터 typesafe/jev-router(요청마다 모델·추론 강도를 고른다, tools·structured_outputs, 2026-11-13 목록). 공급자 고정 없이 부른다(RespondSpec.unpinned). */
export const DEFAULT_AGENT_MODEL = 'typesafe/jev-router';

export function gatewayToolsets(): Map<string, ToolsetDef> {
  const sr = selectorRepair(['x']);
  for (const t of sr.tools) {
    const props = (t.parameters as { properties: Record<string, unknown> }).properties;
    if (props.scopeId) props.scopeId = { type: 'string', pattern: '^[A-Za-z0-9_.-]{1,64}$' };
  }
  return new Map<string, ToolsetDef>([
    [sr.id, sr],
    [QUERY_PARSE.id, QUERY_PARSE],
    [CHAT_REPLY.id, CHAT_REPLY],
    [CHAT_AGENT.id, CHAT_AGENT],
    [PAGE_JUDGE.id, PAGE_JUDGE],
    [BROWSER_AGENT.id, BROWSER_AGENT],
  ]);
}

function hasImage(v: unknown, depth = 0): boolean {
  if (depth > 32) return true;
  if (Array.isArray(v)) return v.some((x) => hasImage(x, depth + 1));
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    if (o.type === 'input_image' || o.type === 'input_file' || 'image_url' in o || 'file_data' in o) return true;
    return Object.values(o).some((x) => hasImage(x, depth + 1));
  }
  return false;
}

export interface RunClaims {
  v: 1;
  typ: 'run';
  acc: string;
  dev: string;
  /** 범위 해시(run_scopes.scope_hash) */
  sh: string;
  k: 'run' | 'chat';
  iat: number;
  exp: number;
}

export interface DeviceSuspender {
  suspend(deviceId: string): Promise<void>;
}

export interface GatewayDeps {
  db: Sql;
  provider: ModelProvider;
  catalog: BundleCatalog;
  toolsets?: Map<string, ToolsetDef>;
  /** runToken 서명 키(Ed25519, 게이트웨이만) */
  runKey: KeyObject;
  /** 캐시 키 HMAC 비밀(prompt_cache_key) */
  cacheSecret: Buffer;
  /** K_sid(safety_identifier) */
  sidKey: Buffer;
  /** replay 태그 키(gw_key) */
  tagKey: Buffer;
  /** 실행 범위 해시 키 */
  scopeKey: Buffer;
  /** agent: 예상 밖 화면 판정·브라우저 에이전트(page_judge·browser_agent) 모델. 없으면 DEFAULT_AGENT_MODEL. */
  models: { decide: string; respond: string; agent?: string };
  monthlyTokens?: number;
  prices?: Prices;
  nts: BizStatusSource;
  suspender?: DeviceSuspender;
  /** 한도 카운터·키 솔트. 배포는 DB(`sqlLimits`, 인스턴스 공유), 없으면 메모리(단일 인스턴스) */
  limits?: Limits;
  /** 운영 이벤트(카운트만) */
  onEvent?: (event: string) => void;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

type Who = Pick<DeviceClaims, 'acc' | 'dev'>;

export class GatewayService {
  readonly now: () => number;
  private readonly d: GatewayDeps;
  private readonly v = loadRequestValidators();
  private readonly toolsets: Map<string, ToolsetDef>;
  private readonly runPub: Buffer;
  /** 자동 정지 요청이 진행 중인 기기(같은 폭주에서 중복 요청 방지). 끝나면 지운다: 재활성화 뒤 다시 폭주하면 다시 정지한다. */
  private readonly suspending = new Set<string>();
  /** 한도 카운터(라우터도 같은 것을 쓴다). 키는 당일 솔트 HMAC만 */
  readonly limits: Limits;

  constructor(d: GatewayDeps) {
    this.d = d;
    this.now = d.now ?? Date.now;
    this.toolsets = d.toolsets ?? gatewayToolsets();
    this.runPub = ed25519RawPublic(d.runKey);
    this.limits = d.limits ?? memoryLimits(this.now);
  }

  private event(e: string): void {
    this.d.onEvent?.(e);
  }

  // ---------- runToken(D04 §7 POST /v1/run-tokens) ----------

  async issueRunToken(who: Who, scope: { runId: string } | { chatSessionId: string }): Promise<{ runToken: string; expiresAt: number; budget: { l1: number; l2: number } }> {
    const k: 'run' | 'chat' = 'runId' in scope ? 'run' : 'chat';
    const id = 'runId' in scope ? scope.runId : scope.chatSessionId;
    // 범위 키는 계정에 묶는다(다른 계정이 같은 runId를 써도 예산이 섞이지 않는다). 원문 ID는 저장하지 않는다.
    const sh = hmacHex(this.d.scopeKey, 'SAX-run-scope-v1', '\u0000', who.acc, '\u0000', k, '\u0000', id).slice(0, 32);
    const now = this.now();
    const exp = now + GATEWAY.runTokenTtlMs;
    await this.d.db.run('INSERT INTO run_scopes (scope_hash, kind, l1, l2_calls, l2_turns, expires_at) VALUES ($1, $2, 0, 0, 0, $3) ON CONFLICT (scope_hash) DO UPDATE SET expires_at = $3', [sh, k, exp]);
    const claims: RunClaims = { v: 1, typ: 'run', acc: who.acc, dev: who.dev, sh, k, iat: now, exp };
    const runToken = `sxr1.${b64u(Buffer.from(jcs(claims)))}.${b64u(signCtx('SAX-run-token-v1', claims, this.d.runKey))}`;
    return { runToken, expiresAt: exp, budget: k === 'run' ? { l1: GATEWAY.l1PerRun, l2: GATEWAY.l2PerRun } : { l1: GATEWAY.l1PerChat, l2: GATEWAY.l2PerChat } };
  }

  /** 서명·만료·기기 결속. 다른 기기·계정의 runToken은 쓸 수 없다. */
  verifyRunToken(token: string, who: Who): RunClaims {
    const parts = token.split('.');
    if (parts.length !== 3 || parts[0] !== 'sxr1') fail('gateway.run_token_invalid');
    let claims: RunClaims;
    try {
      claims = JSON.parse(fromB64u(parts[1]!).toString('utf8')) as RunClaims;
    } catch {
      return fail('gateway.run_token_invalid');
    }
    if (!claims || typeof claims !== 'object' || !canonical(claims, parts[1]!)) fail('gateway.run_token_invalid');
    if (!verifyCtx('SAX-run-token-v1', claims, this.runPub, fromB64u(parts[2]!))) fail('gateway.run_token_invalid');
    if (claims.v !== 1 || claims.typ !== 'run' || claims.exp <= this.now() || claims.acc !== who.acc || claims.dev !== who.dev) fail('gateway.run_token_invalid');
    return claims;
  }

  // ---------- 공통 ----------

  private async tokensThisMonth(acc: string): Promise<number> {
    const r = await this.d.db.one<{ t: number }>('SELECT input_tokens + output_tokens AS t FROM usage_monthly WHERE account_id = $1 AND month = $2', [acc, kstMonth(this.now())]);
    return Number(r?.t ?? 0);
  }

  /** 월 회전 safety_identifier = hex(HMAC(K_sid, accountId ‖ yyyymm))[:32] (D04 §7, KST 월) */
  safetyId(acc: string): string {
    return hmacHex(this.d.sidKey, acc, kstMonth(this.now())).slice(0, 32);
  }

  /** prompt_cache_key = acct:<HMAC(server_secret, accountId)>:b:<bundleId> | :t:<toolset> (규칙 (4)) */
  cacheKey(acc: string, kind: 'b' | 't', id: string): string {
    return `acct:${hmacHex(this.d.cacheSecret, acc).slice(0, 32)}:${kind}:${id}`;
  }

  /** replay 태그 = HMAC(gw_key, accountId ‖ deviceId ‖ runToken ‖ item) */
  tag(who: Who, runToken: string, item: unknown): string {
    return hmacHex(this.d.tagKey, who.acc, '\u0000', who.dev, '\u0000', runToken, '\u0000', canonicalJson(item));
  }

  /**
   * 트립와이어·거절은 기기별로 센다(1시간 고정 창, DB 카운터라 인스턴스가 여럿이어도 합산). 임계값에 닿으면 계정 서비스에 기기 자동 정지를 요청한다(계정 정지 전 알림).
   * 카운터는 임계값 + 1에서 멈추므로 정지 요청이 실패하면 다음 위반에서 다시 시도한다.
   */
  private async abuseHit(dev: string): Promise<void> {
    const key = `abuse:${await this.limits.idSalt('gw-abuse').hash(dev)}`;
    const h = await this.limits.limiter.hit(key, GATEWAY.abuseThreshold, GATEWAY.abuseWindowMs);
    if (h.n >= GATEWAY.abuseThreshold && !this.suspending.has(dev) && this.d.suspender) {
      this.suspending.add(dev);
      this.event('auto_suspend');
      try {
        await this.d.suspender.suspend(dev);
        await this.limits.limiter.reset(key, GATEWAY.abuseWindowMs); // 정지됨: 창을 비운다(재활성화 뒤에는 처음부터 다시 센다)
      } catch {
        // 계정 서비스 장애: 창은 그대로 두고 다음 위반에서 다시 시도
      } finally {
        this.suspending.delete(dev);
      }
    }
  }

  private async withRetry<T>(fn: () => Promise<T>, retries: number = GATEWAY.providerRetries): Promise<T> {
    const sleep = this.d.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    for (let i = 0; ; i++) {
      try {
        return await fn();
      } catch (e) {
        if (!(e instanceof ProviderError) || !e.retryable || i >= retries) fail('gateway.upstream_error');
        await sleep(GATEWAY.backoffBaseMs * 2 ** i + Math.floor(Math.random() * GATEWAY.backoffBaseMs));
      }
    }
  }

  /** 계량 분리(C-23): (1) 계정·월 합계 (2) 계정 없는 운영 통계 (3) 35일 호출 기록. 본문·캐시 적중 여부는 클라이언트에 주지 않는다. */
  private async meter(who: Who, surface: string, usage: ProviderUsage | null, outcome: string, latencyMs: number, kind: 'decide' | 'respond'): Promise<void> {
    const now = this.now();
    const p = this.d.prices ?? ZERO_PRICES;
    await this.d.db.run('INSERT INTO ops_stats (day, surface, outcome, n, latency_ms_sum) VALUES ($1, $2, $3, 1, $4) ON CONFLICT (day, surface, outcome) DO UPDATE SET n = ops_stats.n + 1, latency_ms_sum = ops_stats.latency_ms_sum + $4', [
      kstDay(now),
      surface,
      outcome,
      Math.max(0, Math.round(latencyMs)),
    ]);
    if (!usage) return;
    const cost = Math.round(((kind === 'decide' ? p.decideIn : p.respondIn) * usage.inputTokens + (kind === 'decide' ? p.decideOut : p.respondOut) * usage.outputTokens) / 1_000_000);
    await this.d.db.tx(async (q) => {
      await q.run(
        'INSERT INTO usage_monthly (account_id, month, input_tokens, output_tokens, cost_micro_usd) VALUES ($1, $2, $3, $4, $5) ON CONFLICT (account_id, month) DO UPDATE SET input_tokens = usage_monthly.input_tokens + $3, output_tokens = usage_monthly.output_tokens + $4, cost_micro_usd = usage_monthly.cost_micro_usd + $5',
        [who.acc, kstMonth(now), usage.inputTokens, usage.outputTokens, cost],
      );
      await q.run('INSERT INTO call_records (call_id, account_id, device_id, at, surface, input_tokens, output_tokens) VALUES ($1, $2, $3, $4, $5, $6, $7)', [randomToken(16), who.acc, who.dev, now, surface, usage.inputTokens, usage.outputTokens]);
    });
  }

  /** 예산 1회 소비(트랜잭션). 공급사 호출 전에 소비한다(실패해도 되돌리지 않는다: 재시도 폭주 방지). */
  private async consume(sh: string, k: 'run' | 'chat', what: 'l1' | 'l2_new' | 'l2_turn' | 'agent', maxTurns: number): Promise<void> {
    await this.d.db.tx(async (q) => {
      const r = await q.one<{ l1: number; l2_calls: number; l2_turns: number; agent_calls: number; expires_at: number }>(`SELECT l1, l2_calls, l2_turns, agent_calls, expires_at FROM run_scopes WHERE scope_hash = $1${q.forUpdate}`, [sh]);
      if (!r) fail('gateway.run_token_invalid');
      if (what === 'agent') {
        // 판정·에이전트는 실행 범위에서만, 따로 센다(대화 범위로는 부를 수 없다)
        if (k !== 'run' || r!.agent_calls >= GATEWAY.agentPerRun) fail('gateway.run_budget_exceeded');
        await q.run('UPDATE run_scopes SET agent_calls = agent_calls + 1 WHERE scope_hash = $1', [sh]);
        return;
      }
      const l1Max = k === 'run' ? GATEWAY.l1PerRun : GATEWAY.l1PerChat;
      const l2Max = k === 'run' ? GATEWAY.l2PerRun : GATEWAY.l2PerChat;
      if (what === 'l1') {
        if (r!.l1 >= l1Max) fail('gateway.run_budget_exceeded');
        await q.run('UPDATE run_scopes SET l1 = l1 + 1 WHERE scope_hash = $1', [sh]);
      } else if (what === 'l2_new') {
        if (r!.l2_calls >= l2Max) fail('gateway.run_budget_exceeded');
        await q.run('UPDATE run_scopes SET l2_calls = l2_calls + 1 WHERE scope_hash = $1', [sh]);
      } else {
        // 이어지는 턴: 열린 L2가 있어야 하고 범위 전체에서 L2 × (턴 상한 − 1)까지(packages/net ModelGuard와 같은 규칙)
        if (r!.l2_calls === 0 || r!.l2_turns >= l2Max * (maxTurns - 1)) fail('gateway.run_budget_exceeded');
        await q.run('UPDATE run_scopes SET l2_turns = l2_turns + 1 WHERE scope_hash = $1', [sh]);
      }
    });
  }

  // ---------- POST /v1/decide ----------

  async decide(who: Who, body: unknown): Promise<{ model: string; answers: unknown; usage: { input_tokens: number; output_tokens: number }; questionsDigest: string }> {
    if (!this.v.decide(body)) fail('gateway.param_rejected');
    const b = body as { bundleId: string; bundleDigest: string; input: string; runToken: string };
    const bundle: LoadedBundle | undefined = this.d.catalog.get(b.bundleId);
    // 규칙 (2): bundleId@digest가 게이트웨이 번들 집합에 있어야 한다(배포 불일치 감지, 무결성 장치 아님 C-24)
    if (!bundle || !safeEqual(bundle.digest, b.bundleDigest)) fail('gateway.digest_mismatch');
    if (Buffer.byteLength(b.input, 'utf8') > bundle!.def.maxInputBytes) fail('gateway.param_rejected');
    if (piiTripwire(b.input)) {
      this.event('pii_tripwire');
      await this.abuseHit(who.dev);
      fail('gateway.pii_tripwire');
    }
    const rt = this.verifyRunToken(b.runToken, who);
    const used = await this.tokensThisMonth(who.acc);
    const limit = this.d.monthlyTokens ?? GATEWAY.monthlyTokensDefault;
    // 100%를 넘어도 L1은 유지(L2만 중단), 하드 상한(2배) 이후에는 안전 판정 번들만 낮은 속도로(D04 §6 "월 한도 100% 이후 'L1 유지'")
    if (used >= limit * GATEWAY.hardCapMultiplier) {
      if (bundle!.def.riskClass !== 'safety') fail('gateway.quota_exceeded');
      const cap = await this.limits.limiter.hit(`cap:${await this.limits.idSalt('gw-limit').hash(who.acc)}`, GATEWAY.safetyAfterCapPerMinute, 60_000);
      if (!cap.ok) fail('gateway.quota_exceeded');
    }
    await this.consume(rt.sh, rt.k, 'l1', 1);
    const started = this.now();
    let res;
    try {
      res = await this.withRetry(() =>
        this.d.provider.decide({
          model: this.d.models.decide,
          prefix: bundle!.prefixText,
          input: b.input,
          questions: bundle!.def.questions,
          cacheKey: this.cacheKey(who.acc, 'b', bundle!.wireId),
          safetyId: this.safetyId(who.acc),
        }),
      );
    } catch (e) {
      await this.meter(who, bundle!.wireId, null, 'upstream_error', this.now() - started, 'decide');
      throw e;
    }
    const refused = Array.isArray(res.answers) && res.answers.some((a) => (a as { type?: string })?.type === 'refusal');
    if (refused) await this.abuseHit(who.dev);
    await this.meter(who, bundle!.wireId, res.usage, refused ? 'refusal' : 'ok', this.now() - started, 'decide');
    return {
      model: res.model,
      answers: res.answers,
      usage: { input_tokens: res.usage.inputTokens, output_tokens: res.usage.outputTokens },
      // 공급사로 보낸 질문 목록의 해시. 클라이언트가 로컬 번들과 대조한다(악의적 게이트웨이는 이것도 속일 수 있다, D11)
      questionsDigest: sha256hex(canonicalJson(bundle!.def.questions)),
    };
  }

  // ---------- POST /v1/respond ----------

  async respond(
    who: Who,
    body: unknown,
  ): Promise<{ model: string; status: string; output: Array<{ item: unknown; tag: string }>; usage: { input_tokens: number; output_tokens: number }; toolsetDigest: string }> {
    if (!this.v.respond(body)) fail('gateway.param_rejected');
    const b = body as {
      toolset: string;
      messages: Array<{ role: 'user'; content: Array<{ type: 'input_text'; text: string }> }>;
      replay?: Array<{ item: Record<string, unknown>; tag: string } | { type: 'function_call_output'; call_id: string; output: string }>;
      runToken: string;
    };
    // 규칙 (7): Phase 1 이미지 입력 없음. replay의 item은 스키마가 열어 둔 객체라 여기서 다시 본다.
    if (hasImage(b.replay)) fail('gateway.param_rejected');
    const t = this.toolsets.get(b.toolset);
    if (!t) fail('gateway.param_rejected');
    const rt = this.verifyRunToken(b.runToken, who);
    const replay = b.replay ?? [];
    const callIds = new Set<string>();
    let turns = 0;
    for (const r of replay) {
      if ('item' in r) {
        if (!safeEqual(r.tag, this.tag(who, b.runToken, r.item))) fail('gateway.param_rejected');
        if (r.item.type === 'function_call' && typeof r.item.call_id === 'string') callIds.add(r.item.call_id);
        if (r.item.type !== 'reasoning') turns++;
      } else if (!callIds.has(r.call_id)) {
        fail('gateway.param_rejected');
      }
    }
    if (turns >= t!.maxTurns) fail('gateway.run_budget_exceeded');
    const texts = [...b.messages.flatMap((m) => m.content.map((c) => c.text)), ...replay.flatMap((r) => ('output' in r ? [r.output] : []))];
    if (texts.some((x) => piiTripwire(x))) {
      this.event('pii_tripwire');
      await this.abuseHit(who.dev);
      fail('gateway.pii_tripwire');
    }
    // 월 100%에서 L2 중단(D04 §6)
    if ((await this.tokensThisMonth(who.acc)) >= (this.d.monthlyTokens ?? GATEWAY.monthlyTokensDefault)) fail('gateway.quota_exceeded');
    const agent = (AGENT_TOOLSETS as readonly string[]).includes(t!.id);
    await this.consume(rt.sh, rt.k, agent ? 'agent' : replay.length ? 'l2_turn' : 'l2_new', t!.maxTurns);
    const input: unknown[] = [...b.messages, ...replay.map((r) => ('item' in r ? r.item : { type: 'function_call_output', call_id: r.call_id, output: r.output }))];
    const started = this.now();
    let res;
    try {
      // 판정·에이전트(추론 모델)는 함수 상한(60초) 안에서 한 번만 50초 기다린다(30초 × 재시도 3번은 상한을 넘겨 클라이언트에 시간 초과로 보였다).
      res = await this.withRetry(() =>
        this.d.provider.respond({
          ...(agent ? { timeoutMs: GATEWAY.agentUpstreamTimeoutMs } : {}),
          model: agent ? (this.d.models.agent ?? DEFAULT_AGENT_MODEL) : this.d.models.respond,
          prefix: toolsetPrefix(t!),
          effort: t!.effort,
          maxOutputTokens: t!.maxOutputTokens,
          tools: t!.tools,
          output: t!.output,
          input,
          cacheKey: this.cacheKey(who.acc, 't', t!.id),
          safetyId: this.safetyId(who.acc),
          ...(agent ? { unpinned: true as const } : {}),
        }),
      agent ? 0 : GATEWAY.providerRetries,
      );
    } catch (e) {
      await this.meter(who, t!.id, null, 'upstream_error', this.now() - started, 'respond');
      throw e;
    }
    const refused = res.output.some((i) => i.type === 'message' && Array.isArray(i.content) && (i.content as Array<{ type?: string }>).some((c) => c?.type === 'refusal'));
    if (refused) await this.abuseHit(who.dev);
    await this.meter(who, t!.id, res.usage, refused ? 'refusal' : res.status === 'completed' ? 'ok' : 'incomplete', this.now() - started, 'respond');
    return {
      model: res.model,
      status: res.status,
      output: res.output.map((item) => ({ item, tag: this.tag(who, b.runToken, item) })),
      usage: { input_tokens: res.usage.inputTokens, output_tokens: res.usage.outputTokens },
      toolsetDigest: sha256hex(canonicalJson({ prefix: toolsetPrefix(t!), tools: t!.tools, output: t!.output, effort: t!.effort, maxOutputTokens: t!.maxOutputTokens })),
    };
  }

  // ---------- 진위확인 프록시(D09 §4.1) ----------

  /** 번호는 메모리로만 통과한다. 이 메서드는 계정을 받지 않는다(한도는 앱 계층의 메모리 카운터). */
  async bizStatus(bNos: string[]): Promise<{ data: BizStatus[] }> {
    if (bNos.length < 1 || bNos.length > GATEWAY.bizPerRequest || !bNos.every((b) => /^[0-9]{10}$/.test(b))) fail('gateway.param_rejected');
    try {
      return { data: await this.d.nts.status(bNos) };
    } catch (e) {
      if (e instanceof NtsUnavailable) fail('gateway.upstream_error');
      throw e;
    }
  }

  async sweep(): Promise<void> {
    const now = this.now();
    await this.d.db.run('DELETE FROM call_records WHERE at <= $1', [now - GATEWAY.callRecordRetentionDays * 24 * 3600_000]);
    await this.d.db.run('DELETE FROM run_scopes WHERE expires_at <= $1', [now]);
    await this.limits.limiter.sweep();
  }
}
