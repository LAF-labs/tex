import { EMAIL_RE, hasKoreanDigit, koreanDigitCopy, numericSpans, type EntityKind } from './entities.ts';
import type { TokenMap } from './apply.ts';
import { normalizeForDetection, normalizeForRedaction } from './normalize.ts';

export interface DetokenizeSpec {
  recordFields?: readonly string[];
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
  const t = normalizeForRedaction(normalizeForDetection(s)).replace(TOKEN_RE, ' ');
  const out = numericSpans(t).map((x) => t.slice(x.start, x.end).replace(/\D/g, ''));
  if (hasKoreanDigit(t)) {
    const k = koreanDigitCopy(t);
    for (const x of numericSpans(k)) out.push(k.slice(x.start, x.end).replace(/\D/g, ''));
  }
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
