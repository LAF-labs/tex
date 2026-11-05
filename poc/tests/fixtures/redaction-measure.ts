// 마스킹 코퍼스 측정: 항목마다 새 Redactor로 마스킹하고 원값이 출력에 남는지(누락) 본다. 표는 reports/M1-5.md에 붙인다.
// 숫자형 누락 = 출력의 숫자 골격(토큰 제거, 전각·한글 숫자를 아라비아로, 보이지 않는 문자 제거 뒤 숫자만)에 원값 숫자 중
// 연속 5자리 이상(짧으면 전체)이 남음. 문자형 누락 = 지정 부분 문자열이 정규화 출력에 남음.
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

// 코퍼스가 일부러 붙인 날짜·시각 머리(구분자 있는 형식)는 골격에서 뺀다. 원값은 이 형식으로 나오지 않는다.
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
