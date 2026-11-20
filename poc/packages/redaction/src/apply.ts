import { mint, type RedactedText } from './redacted.ts';
import {
  ADDRESS_RE,
  AMOUNT_RE,
  EMAIL_RE,
  NAME_AFTER_RE,
  NAME_LABEL_RE,
  NAME_STOPWORDS,
  PASSPORT_RE,
  hasKoreanDigit,
  koreanDigitCopy,
  numericSpans,
  type EntityKind,
  type Span,
} from './entities.ts';
import { normalizeForRedaction, utf8Length } from './normalize.ts';
import { RedactionError, lineText, renderTree, type A11yLine, type A11yNode, type RenderOptions, type RenderStats } from './tree.ts';

export { normalizeForDetection } from './normalize.ts';
export type { EntityKind };

export type RedactionCtx = { runId: string } | { chatSessionId: string };

export interface RedactionStats {
  bytes: number;
  replaced: number;
  byKind: Partial<Record<EntityKind, number>>;
  joined?: number;
  tree?: RenderStats;
}

export interface ApplyOptions {
  needsAmounts?: boolean;
  frame?: 'screen' | 'none';
}

export interface ApplyResult {
  redacted: RedactedText;
  map: TokenMap;
  stats: RedactionStats;
}

const FRAME_OPEN = '<<<SCREEN_DATA';
const FRAME_CLOSE = 'SCREEN_DATA>>>';

/** 본문 속 구분자(또는 정규화 변형)를 이스케이프한다(D06 §3 spotlighting). 입력은 이미 정규화된 텍스트다. */
export function escapeFrame(text: string): string {
  return text.replace(/<{3,}/g, '‹‹').replace(/>{3,}/g, '››').replace(/SCREEN[\s_-]*DATA/gi, 'SCREEN-DATA');
}

const NUMERIC_KINDS = new Set<EntityKind>(['APPROVAL', 'CARD', 'RRN', 'CORPNO', 'DLN', 'BIZNO', 'NHIS', 'PHONE', 'ACCT']);

function canonical(kind: EntityKind, value: string): string {
  if (NUMERIC_KINDS.has(kind)) return koreanDigitCopy(value).replace(/[^\d*]/g, '');
  if (kind === 'EMAIL') return value.toLowerCase();
  return value.replace(/\s+/g, ' ').trim();
}

/** 실행(또는 대화 세션) 범위 토큰 맵. 같은 값은 같은 번호(D06 §4). 종료 시 폐기한다. */
export class TokenMap {
  readonly ctx: RedactionCtx;
  private readonly byValue = new Map<string, string>();
  private readonly byToken = new Map<string, string>();
  private readonly records = new Map<string, string>();
  private readonly counters = new Map<EntityKind, number>();

  constructor(ctx: RedactionCtx) {
    this.ctx = ctx;
  }

  token(kind: EntityKind, value: string): string {
    const key = `${kind}\u0000${canonical(kind, value)}`;
    const hit = this.byValue.get(key);
    if (hit) return hit;
    const n = (this.counters.get(kind) ?? 0) + 1;
    this.counters.set(kind, n);
    const t = `[${kind}_${n}]`;
    this.byValue.set(key, t);
    this.byToken.set(t, value);
    return t;
  }

  bindRecord(token: string, recordId: string): void {
    const cur = this.records.get(token);
    if (cur !== undefined && cur !== recordId) throw new Error('token_bound_to_other_record');
    this.records.set(token, recordId);
  }

  has(token: string): boolean {
    return this.byToken.has(token);
  }

  valueOf(token: string): string | undefined {
    return this.byToken.get(token);
  }

  recordOf(token: string): string | undefined {
    return this.records.get(token);
  }

  get size(): number {
    return this.byToken.size;
  }

  clear(): void {
    this.byValue.clear();
    this.byToken.clear();
    this.records.clear();
    this.counters.clear();
  }
}

export interface RedactorOptions {
  names?: Iterable<string>;
}

/** D06 §4 ② 실행 중 등재 레코드: 거래처 상호·대표자·이메일·사업자번호. */
export interface RecordEntry {
  recordId: string;
  names?: string[];
  emails?: string[];
  bizNos?: string[];
}

const ESCAPE_RE = /[.*+?^${}()|[\]\\]/g;

/**
 * 호출자가 더하는 마스킹 구간(정규화된 텍스트 기준). 기본 규칙 뒤에 돌고 겹치면 기본 규칙이 이긴다.
 * 가리는 구간만 더할 수 있다(기본 규칙이 가린 것을 풀 수 없다). 대화 에이전트 경로가 단위 없는 금액·이름 변형에 쓴다(PR #296 판정 ②).
 */
export type SpanFinder = (normalized: string) => Span[];

export class Redactor {
  readonly map: TokenMap;
  private readonly names = new Set<string>();
  private readonly variants = new Set<string>();
  private nameRe: RegExp | null = null;
  private readonly finders: SpanFinder[] = [];

  constructor(ctx: RedactionCtx, opts: RedactorOptions = {}) {
    this.map = new TokenMap(ctx);
    for (const n of opts.names ?? []) this.addName(n);
  }

  addSpanFinder(f: SpanFinder): void {
    this.finders.push(f);
  }

  addName(name: string, opts: { variant?: boolean } = {}): void {
    const n = normalizeForRedaction(name).replace(/\s+/g, ' ').trim();
    if ([...n].length < 2) return;
    if (!this.names.has(n)) {
      this.names.add(n);
      if (opts.variant) this.variants.add(n);
      this.nameRe = null;
    } else if (!opts.variant && this.variants.delete(n)) this.nameRe = null;
  }

  addRecord(r: RecordEntry): void {
    for (const n of r.names ?? []) {
      this.addName(n);
      this.map.bindRecord(this.map.token('NAME', normalizeForRedaction(n).replace(/\s+/g, ' ').trim()), r.recordId);
    }
    for (const e of r.emails ?? []) this.map.bindRecord(this.map.token('EMAIL', normalizeForRedaction(e).trim()), r.recordId);
    for (const b of r.bizNos ?? []) this.map.bindRecord(this.map.token('BIZNO', normalizeForRedaction(b).trim()), r.recordId);
  }

  private dictRe(): RegExp | null {
    if (!this.names.size) return null;
    if (!this.nameRe) {
      const len = (n: string) => [...n.replace(/ /g, '')].length;
      const alts = [...this.names]
        .sort((a, b) => len(b) - len(a) || Number(this.variants.has(a)) - Number(this.variants.has(b)))
        .map((n) => n.replace(ESCAPE_RE, '\\$&').replace(/ /g, '\\s?'));
      this.nameRe = new RegExp(alts.join('|'), 'gu');
    }
    return this.nameRe;
  }

  spans(t: string, opts: ApplyOptions): Span[] {
    const out: Span[] = [];
    const add = (start: number, end: number, kind: EntityKind) => {
      if (end <= start || out.some((s) => start < s.end && end > s.start)) return;
      out.push({ start, end, kind });
    };
    const re = this.dictRe();
    if (re) for (const m of t.matchAll(re)) add(m.index!, m.index! + m[0].length, 'NAME');
    for (const s of numericSpans(t)) add(s.start, s.end, s.kind);
    if (hasKoreanDigit(t)) {
      const copy = koreanDigitCopy(t);
      for (const s of numericSpans(copy)) if (hasKoreanDigit(t.slice(s.start, s.end))) add(s.start, s.end, s.kind);
    }
    for (const m of t.matchAll(EMAIL_RE)) add(m.index!, m.index! + m[0].length, 'EMAIL');
    for (const m of t.matchAll(PASSPORT_RE)) add(m.index!, m.index! + m[0].length, 'PASSPORT');
    for (const m of t.matchAll(ADDRESS_RE)) add(m.index!, m.index! + m[0].replace(/\s+$/, '').length, 'ADDR');
    for (const r of [NAME_LABEL_RE, NAME_AFTER_RE]) {
      for (const m of t.matchAll(r)) {
        const name = m[1]!;
        if (NAME_STOPWORDS.has(name)) continue;
        const start = m.index! + m[0].indexOf(name);
        add(start, start + name.length, 'NAME');
      }
    }
    if (!opts.needsAmounts) for (const m of t.matchAll(AMOUNT_RE)) add(m.index!, m.index! + m[0].length, 'AMT');
    for (const f of this.finders) for (const s of f(t)) if (!(s.kind === 'AMT' && opts.needsAmounts)) add(s.start, s.end, s.kind);
    return out.sort((a, b) => a.start - b.start);
  }

  private replace(t: string, spans: Span[], byKind: RedactionStats['byKind']): { text: string; replaced: number } {
    let text = '';
    let at = 0;
    for (const s of spans) {
      text += t.slice(at, s.start) + this.map.token(s.kind, t.slice(s.start, s.end));
      at = s.end;
      byKind[s.kind] = (byKind[s.kind] ?? 0) + 1;
    }
    return { text: text + t.slice(at), replaced: spans.length };
  }

  private finish(body: string, byKind: RedactionStats['byKind'], replaced: number, opts: ApplyOptions, extra: Partial<RedactionStats> = {}): ApplyResult {
    const out = (opts.frame ?? 'screen') === 'screen' ? `${FRAME_OPEN}\n${escapeFrame(body)}\n${FRAME_CLOSE}` : escapeFrame(body);
    return { redacted: mint(out), map: this.map, stats: { bytes: utf8Length(out), replaced, byKind, ...extra } };
  }

  apply(text: string, opts: ApplyOptions = {}): ApplyResult {
    const byKind: RedactionStats['byKind'] = {};
    const t = normalizeForRedaction(text);
    const { text: body, replaced } = this.replace(t, this.spans(t, opts), byKind);
    return this.finish(body, byKind, replaced, opts);
  }

  applyTree(root: A11yNode, opts: ApplyOptions & RenderOptions): ApplyResult {
    let budget = opts.maxBytes - (FRAME_OPEN.length + FRAME_CLOSE.length + 2);
    for (let attempt = 0; attempt < 6; attempt++) {
      const { lines, stats: tree } = renderTree(root, { ...opts, maxBytes: Math.max(64, budget) });
      const byKind: RedactionStats['byKind'] = {};
      let replaced = 0;
      const joined = this.joinAdjacent(lines, opts, byKind);
      replaced += joined;
      for (const l of lines) {
        if (!l.name || /^\[[A-Z]+_\d+\]$/.test(l.name)) continue;
        const t = normalizeForRedaction(l.name);
        const r = this.replace(t, this.spans(t, opts), byKind);
        l.name = r.text;
        replaced += r.replaced;
      }
      const res = this.finish(lines.map(lineText).join('\n'), byKind, replaced, opts, { joined, tree });
      if (res.stats.bytes <= opts.maxBytes) return res;
      budget -= res.stats.bytes - opts.maxBytes + 64;
    }
    throw new RedactionError('size_unreachable');
  }

  private joinAdjacent(lines: A11yLine[], opts: ApplyOptions, byKind: RedactionStats['byKind']): number {
    const groups = new Map<number, A11yLine[]>();
    for (const l of lines) if (l.name && l.fold === undefined && l.rows === undefined) (groups.get(l.group) ?? groups.set(l.group, []).get(l.group)!).push(l);
    let n = 0;
    for (const members of groups.values()) {
      if (members.length < 2) continue;
      const parts = members.map((l) => normalizeForRedaction(l.name));
      for (const sep of ['', ' ']) {
        const bounds: number[] = [];
        let joined = '';
        for (const p of parts) {
          bounds.push(joined.length);
          joined += (joined ? sep : '') + p;
        }
        bounds.push(joined.length + 1);
        const copy = hasKoreanDigit(joined) ? koreanDigitCopy(joined) : joined;
        for (const s of numericSpans(copy)) {
          const idx = members.map((_, i) => i).filter((i) => s.start < bounds[i + 1]! - (i + 1 < members.length && sep ? 1 : 0) && s.end > bounds[i]!);
          if (idx.length < 2) continue;
          const tok = this.map.token(s.kind, copy.slice(s.start, s.end));
          for (const i of idx) {
            if (members[i]!.name !== tok) n++;
            members[i]!.name = tok;
          }
          byKind[s.kind] = (byKind[s.kind] ?? 0) + 1;
        }
        for (let i = 0; i < members.length; i++) parts[i] = normalizeForRedaction(members[i]!.name);
      }
    }
    void opts;
    return n;
  }
}

/** D06 §8 apply(): 일회성 맵으로 마스킹한다. 실행 범위 일관성이 필요하면 Redactor를 쓴다. */
export function apply(text: string, ctx: RedactionCtx, opts: ApplyOptions & RedactorOptions = {}): ApplyResult {
  return new Redactor(ctx, opts).apply(text, opts);
}
