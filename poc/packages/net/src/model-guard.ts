// D04 §8 BYOK 로컬 검사 4종(B-21). 게이트웨이가 하는 검사를 공급사 직결 전에 egress에서 다시 한다.
// (1) 앱 내장 번들 다이제스트 허용 목록 (2) gateway-request.schema.json 검증 (3) 실행당 예산 (4) 2차 PII 트립와이어.
// 하나라도 실패하면 호출하지 않는다. 실패 기록은 코드·카운트만(본문 무저장, D09·D16).
import fs from 'node:fs';
import { createRequire } from 'node:module';
import type { RedactedText } from '@sax/redaction';
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

export type GuardCode = 'bundle_not_allowlisted' | 'schema_rejected' | 'input_too_large' | 'budget_exceeded' | 'pii_tripwire' | 'image_rejected';

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
}

/** D04 §4 selector_repair 턴 상한(첫 호출 포함) */
const L2_MAX_TURNS = 3;

/** l2Calls = 새 L2(replay 없는 호출) 수, l2Turns = 이어지는 턴(replay 있는 호출) 수. 둘은 따로 예산과 비교한다. */
export interface L2Usage {
  l1: number;
  l2Calls: number;
  l2Turns: number;
}

// gateway-request.schema.json 규칙 (6): 주민번호·사업자번호·카드·계좌. 마스킹을 통과한 텍스트에 다시 돌린다.
const TRIPWIRE: RegExp[] = [
  /(?<!\d)\d{6}-?[1-8]\d{6}(?!\d)/,
  /(?<!\d)\d{3}-?\d{2}-?\d{5}(?!\d)/,
  /(?<!\d)\d{4}[- ]?\d{4}[- ]?\d{4}[- ]?\d{4}(?!\d)/,
  /(?<!\d)\d{10,14}(?!\d)/,
  /(?<!\d)\d{2,6}-\d{2,6}-\d{2,7}(?:-\d{1,3})?(?!\d)/,
];

export function piiTripwire(text: string): boolean {
  const t = text.normalize('NFKC').replace(/[\u200B-\u200D\u2060\uFEFF]/g, '').replace(/[\u2010-\u2015\u2212]/g, '-');
  return TRIPWIRE.some((re) => re.test(t));
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
  private readonly used = new Map<string, L2Usage>();
  /** 거부 카운트만(본문·식별자 없음). */
  readonly refusals: Partial<Record<GuardCode, number>> = {};

  constructor(cfg: ModelGuardConfig) {
    this.allow = new Map(cfg.bundles.map((b) => [`${b.id}@${b.digest}`, b]));
    this.budget = cfg.budget ?? { l1: 12, l2: 2 };
  }

  private fail(code: GuardCode): never {
    this.refusals[code] = (this.refusals[code] ?? 0) + 1;
    throw new ModelGuardError(code);
  }

  /** 4종 검사를 모두 통과하면 예산 1회를 소비한다. providerBody는 공급사로 실제 나갈 본문(이미지 금지 검사용). */
  check(surface: 'decide', body: GatewayDecideBody, providerBody: unknown): void;
  check(surface: 'respond', body: GatewayRespondBody, providerBody: unknown): void;
  check(surface: 'decide' | 'respond', body: GatewayDecideBody | GatewayRespondBody, providerBody: unknown): void {
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
    const u = this.used.get(body.runToken) ?? { l1: 0, l2Calls: 0, l2Turns: 0 };
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
    this.used.set(body.runToken, u);
  }

  usage(runToken: string): L2Usage {
    return { ...(this.used.get(runToken) ?? { l1: 0, l2Calls: 0, l2Turns: 0 }) };
  }
}
