// D06 §8 역치환 규칙(B-19). fail-closed: 맵 밖 토큰이 하나라도 있으면 결과 전체를 버린다(부분 역치환 없음).
// 식별자형 칸(거래처·이메일·사업자번호)은 토큰이 가리키는 로컬 레코드 ID로만 채운다(값을 끼우지 않는다).
// 모델 출력의 리터럴 식별자는 사용자의 원문 문장에 그대로 있던 경우를 빼고 거부한다. 한 입력 객체 안 토큰은 같은 레코드여야 한다.
import { EMAIL_RE, numericSpans, type EntityKind } from './entities.ts';
import type { TokenMap } from './apply.ts';
import { normalizeForDetection } from './normalize.ts';

export interface DetokenizeSpec {
  /** 레코드 ID로 채울 칸 이름(객체 키). 값은 토큰 하나여야 하고 결과는 { recordId }가 된다. */
  recordFields?: readonly string[];
  /** 사용자가 직접 쓴 원문(리터럴 식별자 허용 판단용). 저장하지 않는다. */
  userText?: string;
}

export type DetokenizeResult = { ok: true; value: unknown } | { ok: false; reason: 'unknown_token' | 'literal_identifier' | 'mixed_records' | 'record_field_invalid' };

export const TOKEN_RE = /\[([A-Z]+)_(\d+)\]/g;

type Fail = Extract<DetokenizeResult, { ok: false }>['reason'];

class Stop extends Error {
  readonly reason: Fail;
  constructor(reason: Fail) {
    super(reason);
    this.reason = reason;
  }
}

function literalIdentifiers(s: string): string[] {
  const t = normalizeForDetection(s).replace(TOKEN_RE, ' ');
  const out = numericSpans(t).map((x) => t.slice(x.start, x.end).replace(/\D/g, ''));
  for (const m of t.matchAll(EMAIL_RE)) out.push(m[0].toLowerCase());
  return out;
}

export function detokenize(output: unknown, map: TokenMap, spec: DetokenizeSpec = {}): DetokenizeResult {
  const recordFields = new Set(spec.recordFields ?? []);
  const user = spec.userText ? normalizeForDetection(spec.userText) : '';
  const userIds = new Set(literalIdentifiers(user));
  const visitString = (s: string): string => {
    for (const lit of literalIdentifiers(s)) if (!userIds.has(lit)) throw new Stop('literal_identifier');
    return s.replace(TOKEN_RE, (tok) => {
      const v = map.valueOf(tok);
      if (v === undefined) throw new Stop('unknown_token');
      return v;
    });
  };
  const visit = (v: unknown): unknown => {
    if (typeof v === 'string') return visitString(v);
    if (Array.isArray(v)) return v.map(visit);
    if (v && typeof v === 'object') {
      const o = v as Record<string, unknown>;
      const out: Record<string, unknown> = {};
      const records = new Set<string>();
      for (const [k, x] of Object.entries(o)) {
        if (recordFields.has(k)) {
          if (typeof x !== 'string' || !/^\[[A-Z]+_\d+\]$/.test(x.trim())) throw new Stop('record_field_invalid');
          if (!map.has(x.trim())) throw new Stop('unknown_token');
          const rid = map.recordOf(x.trim());
          if (rid === undefined) throw new Stop('record_field_invalid');
          records.add(rid);
          out[k] = { recordId: rid };
        } else out[k] = visit(x);
      }
      // 같은 객체의 다른 칸(일반 문자열)에 든 레코드 토큰도 결속을 본다.
      for (const [k, x] of Object.entries(o)) {
        if (recordFields.has(k) || typeof x !== 'string') continue;
        for (const m of x.matchAll(TOKEN_RE)) {
          const rid = map.recordOf(m[0]);
          if (rid !== undefined) records.add(rid);
        }
      }
      if (records.size > 1) throw new Stop('mixed_records');
      return out;
    }
    return v;
  };
  try {
    return { ok: true, value: visit(output) };
  } catch (e) {
    if (e instanceof Stop) return { ok: false, reason: e.reason };
    throw e;
  }
}

export type { EntityKind };
