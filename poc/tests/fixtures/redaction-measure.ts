import { Redactor, koreanDigitCopy, normalizeForDetection, piiTripwireSafe } from './redaction-measure-deps.ts';
import { BENIGN, buildCorpus, type CorpusItem, type Kind, type Variant } from './redaction-corpus.ts';

export interface Row {
  kind: Kind;
  variant: Variant;
  n: number;
  miss: number;
  tripwire: number;
}

export interface Measure {
  total: number;
  miss: number;
  tripwireAfter: number;
  rows: Row[];
  misses: Array<{ id: number; kind: Kind; variant: Variant; out: string }>;
  benign: { n: number; changed: string[] };
}

const DATE_PREFIX = /(?:19|20)\d{2}[-./](?:0?[1-9]|1[0-2])[-./](?:0?[1-9]|[12]\d|3[01])(?!\d)(?: \d{2}:\d{2}(?::\d{2})?)?/g;

function skeleton(s: string): string {
  return koreanDigitCopy(normalizeForDetection(s).replace(/\[[A-Z]+_\d+\]/g, ' ').replace(DATE_PREFIX, ' ')).replace(/\D/g, '');
}

function leaked(item: CorpusItem, out: string): boolean {
  if (item.leaks.digits) {
    const d = item.leaks.digits;
    const sk = skeleton(out);
    const w = Math.min(5, d.length);
    for (let i = 0; i + w <= d.length; i++) if (sk.includes(d.slice(i, i + w))) return true;
  }
  const norm = normalizeForDetection(out).toLowerCase();
  for (const s of item.leaks.substrings ?? []) if (s && norm.includes(normalizeForDetection(s).toLowerCase())) return true;
  return false;
}

export function run(item: CorpusItem): string {
  const r = new Redactor({ runId: `c${item.id}` });
  if (item.tree) return r.applyTree(item.tree, { maxBytes: 6144 }).redacted;
  return r.apply(item.text!).redacted;
}

export function measure(n = 10_000, seed?: number): Measure {
  const corpus = buildCorpus(n, seed);
  const rows = new Map<string, Row>();
  const misses: Measure['misses'] = [];
  let tripwireAfter = 0;
  for (const item of corpus) {
    const key = `${item.kind}/${item.variant}`;
    const row = rows.get(key) ?? rows.set(key, { kind: item.kind, variant: item.variant, n: 0, miss: 0, tripwire: 0 }).get(key)!;
    row.n++;
    const out = run(item);
    if (leaked(item, out)) {
      row.miss++;
      if (misses.length < 50) misses.push({ id: item.id, kind: item.kind, variant: item.variant, out });
    }
    if (piiTripwireSafe(out)) {
      row.tripwire++;
      tripwireAfter++;
    }
  }
  const changed: string[] = [];
  for (const b of BENIGN) {
    const out = new Redactor({ runId: 'benign' }).apply(b, { frame: 'none' }).redacted;
    if (out !== normalizeForDetection(b)) changed.push(`${b} → ${out}`);
  }
  const list = [...rows.values()];
  return { total: corpus.length, miss: list.reduce((a, r) => a + r.miss, 0), tripwireAfter, rows: list, misses, benign: { n: BENIGN.length, changed } };
}

export function markdown(m: Measure): string {
  const kinds = [...new Set(m.rows.map((r) => r.kind))];
  const variants = [...new Set(m.rows.map((r) => r.variant))];
  const head = `| 종류 | ${variants.join(' | ')} | 합계 | 누락 |`;
  const sep = `|${'---|'.repeat(variants.length + 3)}`;
  const body = kinds.map((k) => {
    const cells = variants.map((v) => {
      const r = m.rows.find((x) => x.kind === k && x.variant === v);
      return r ? `${r.n - r.miss}/${r.n}` : '—';
    });
    const rs = m.rows.filter((x) => x.kind === k);
    return `| ${k} | ${cells.join(' | ')} | ${rs.reduce((a, r) => a + r.n, 0)} | ${rs.reduce((a, r) => a + r.miss, 0)} |`;
  });
  return [head, sep, ...body].join('\n');
}
