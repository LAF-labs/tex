import { isValidBizNo } from '@sax/db';
import { apply } from '@sax/redaction';
import type { DocMetaObservation } from '../l0/observation.ts';

export const DOC_TYPES = ['national_tax_cert', 'biz_registration_cert'] as const;
export type DocType = (typeof DOC_TYPES)[number];
/** 판별 결과. 지원하는 두 종류 밖은 이유로만 남긴다(지방세 납세증명은 W-01, 등록증은 bizcert OCR 경로). */
export type DetectedKind = DocType | 'localtax_cert' | 'biz_registration' | 'closure_cert' | 'english_cert' | 'ambiguous' | 'unknown';
export type FieldReason = 'not_found' | 'unparseable' | 'ambiguous' | 'checksum_failed' | 'not_applicable' | 'unsupported_doc';

export interface Field {
  value: string | null;
  reason: FieldReason | null;
  suggested?: string;
  options?: string[];
}

export interface DocMetaExtract {
  extractor: 'docmeta-v1';
  kind: DetectedKind;
  docType: DocType | null;
  issuedOn: Field;
  validUntil: Field;
  issuer: Field;
  docNo: Field;
  subjectBizNo: Field;
  uncertain: Array<'issuedOn'>;
  candidates: DocMetaObservation['candidates'];
}

const ok = (value: string): Field => ({ value, reason: null });
const miss = (reason: FieldReason, suggested?: string): Field => (suggested === undefined ? { value: null, reason } : { value: null, reason, suggested });

interface Compact {
  s: string;
  at: number[];
}

function compact(t: string): Compact {
  let s = '';
  const at: number[] = [];
  for (let i = 0; i < t.length; i++) {
    if (/\s/.test(t[i]!)) continue;
    s += t[i];
    at.push(i);
  }
  return { s, at };
}

const MAX_LABEL_HITS = 50;

function findLabel(c: Compact, label: string): Array<{ start: number; end: number }> {
  const out: Array<{ start: number; end: number }> = [];
  for (let i = c.s.indexOf(label); i >= 0 && out.length < MAX_LABEL_HITS; i = c.s.indexOf(label, i + 1)) out.push({ start: c.at[i]!, end: c.at[i + label.length - 1]! + 1 });
  return out;
}

const ahead = (t: string, pos: number, n: number) => t.slice(pos, pos + n);

const DATE_SRC = String.raw`(?<![\dA-Za-z])((?:19|20)\d{2})\s*(?:년|[.\-/])\s*(\d{1,2})\s*(?:월|[.\-/])\s*(\d{1,2})(?![\dA-Za-z\u1100-\u11FF\u3131-\u318E])(?!\s?\d\s*일)(?:\s*일|\s*\.)?`;
const RANGE_SEP = String.raw`(?:[~∼〜\-–—]|부터)`;
const RANGE_AFTER = new RegExp(String.raw`^[ \t]*${RANGE_SEP}[ \t]*`);
const RANGE_JOIN = new RegExp(String.raw`^[ \t]*${RANGE_SEP}[ \t]*$`);
const OPEN_RANGE_AFTER = /^[ \t]*(?:부터|[~∼〜])/;
const DATE_AT = new RegExp(`^${DATE_SRC}`);

interface DateHit {
  iso: string | null;
  start: number;
  end: number;
}

function toIso(y: string, m: string, d: string): string | null {
  const [yy, mm, dd] = [Number(y), Number(m), Number(d)];
  const t = new Date(Date.UTC(yy, mm - 1, dd));
  if (t.getUTCFullYear() !== yy || t.getUTCMonth() !== mm - 1 || t.getUTCDate() !== dd) return null;
  return `${y}-${String(mm).padStart(2, '0')}-${String(dd).padStart(2, '0')}`;
}

function allDates(t: string): DateHit[] {
  return [...t.matchAll(new RegExp(DATE_SRC, 'g'))].map((m) => ({ iso: toIso(m[1]!, m[2]!, m[3]!), start: m.index, end: m.index + m[0].length }));
}

function dateRightAfter(t: string, pos: number): DateHit | null {
  const gap = /^[\s:)]*/.exec(ahead(t, pos, 24))![0].length;
  const m = DATE_AT.exec(ahead(t, pos + gap, 40));
  if (!m) return null;
  const start = pos + gap;
  return { iso: toIso(m[1]!, m[2]!, m[3]!), start, end: start + m[0].length };
}

const has = (c: Compact, label: string) => c.s.includes(label);

function classify(c: Compact): DetectedKind {
  if (/certificateof(taxpayment|businessregistration)/i.test(c.s)) return 'english_cert';
  if (has(c, '지방세납세증명') || (has(c, '지방세') && has(c, '납세증명') && !has(c, '세무서장'))) return 'localtax_cert';
  if ((has(c, '휴업') || has(c, '폐업')) && has(c, '사실증명')) return 'closure_cert';
  const national = (has(c, '납세증명서') || (has(c, '국세징수법') && has(c, '체납'))) && (has(c, '세무서장') || has(c, '국세징수법'));
  const bizReg = has(c, '사업자등록증명') || (has(c, '사업자등록일') && has(c, '증명합니다') && has(c, '세무서장'));
  if (national && bizReg) return 'ambiguous';
  if (national) return 'national_tax_cert';
  if (bizReg) return 'biz_registration_cert';
  if (has(c, '사업자등록증')) return 'biz_registration';
  return 'unknown';
}

const NOT_ISSUE_LABELS = ['출력일시', '출력일', '인쇄일시', '인쇄일', '일시', '납부기한', '개업일', '연월일', '등록일', '접수일', '유효기간', '기간', '폐업일', '휴업', '개정', '시행'];

function issueLike(t: string, hits: DateHit[]): DateHit[] {
  const ranged = new Set<number>();
  for (let i = 1; i < hits.length; i++) {
    if (RANGE_JOIN.test(t.slice(hits[i - 1]!.end, hits[i]!.start))) ranged.add(i - 1).add(i);
  }
  return hits.filter((h, i) => {
    if (ranged.has(i)) return false;
    const before = t.slice(Math.max(0, h.start - 12), h.start).replace(/\s/g, '').replace(/[:<([]+$/, '');
    if (NOT_ISSUE_LABELS.some((l) => before.endsWith(l))) return false;
    const after = ahead(t, h.end, 16);
    return !/^\s*\d{1,2}:\d{2}/.test(after) && !OPEN_RANGE_AFTER.test(after);
  });
}

function pickDate(hits: DateHit[]): Field {
  if (!hits.length) return miss('not_found');
  const valid = [...new Set(hits.map((h) => h.iso).filter((v): v is string => v !== null))].sort();
  if (!valid.length) return miss('unparseable');
  if (valid.length === 1 && hits.every((h) => h.iso !== null)) return ok(valid[0]!);
  const f = miss('ambiguous', valid[0]);
  return valid.length > 1 ? { ...f, options: valid.slice(0, 8) } : f;
}

function issuedOn(t: string, c: Compact, issuerAt: number | null): { field: Field; uncertain: boolean } {
  const closes = findLabel(c, '증명합니다');
  if (closes.length) {
    const f = pickDate(issueLike(t, allDates(t)).filter((h) => h.start >= closes[closes.length - 1]!.end));
    if (f.reason !== 'not_found') return { field: f, uncertain: false };
  }
  const labelled = pickDate(['발급일자', '발급일', '발행일'].flatMap((l) => findLabel(c, l)).map((p) => dateRightAfter(t, p.end)).filter((h): h is DateHit => h !== null));
  if (labelled.reason !== 'not_found' || issuerAt === null) return { field: labelled, uncertain: false };
  const near = pickDate(issueLike(t, allDates(t)).filter((h) => h.start >= issuerAt - 200 && h.start < issuerAt + 40));
  return { field: near, uncertain: near.value !== null };
}

function validUntil(t: string, c: Compact): Field {
  const hits: DateHit[] = [];
  for (const p of findLabel(c, '유효기간')) {
    const first = dateRightAfter(t, p.end);
    if (!first) continue;
    const range = RANGE_AFTER.exec(ahead(t, first.end, 16));
    const second = range ? dateRightAfter(t, first.end + range[0].length) : null;
    if (range && !second) return miss('ambiguous');
    const next = second ? null : allDates(ahead(t, first.end, 24))[0];
    if (next && ahead(t, first.end, next.start).replace(/\s/g, '').length <= 2) return miss('ambiguous');
    hits.push(second ?? first);
  }
  return pickDate(hits);
}

const NOT_OFFICE = /(봉사실|민원실|상담실|담당|[과팀일])$/;
function issuer(t: string, c: Compact): { field: Field; at: number | null } {
  const names = new Set<string>();
  let at: number | null = null;
  for (const p of findLabel(c, '세무서장')) {
    at = p.start;
    const before = t.slice(Math.max(0, p.start - 30), p.start);
    const attached = /([가-힣]+)$/.exec(before)?.[1] ?? '';
    const tokens = before.slice(0, before.length - attached.length).trim().split(/\s+/);
    let name = attached;
    if (!attached && /^[가-힣]{2,}$/.test(tokens[tokens.length - 1] ?? '')) name = tokens.pop()!;
    else for (let i = tokens.length - 1; i >= 0 && /^[가-힣]$/.test(tokens[i]!); i--) name = tokens[i] + name;
    names.add(name);
  }
  if (!names.size) return { field: miss('not_found'), at };
  const list = [...names];
  if (list.length > 1) return { field: miss('ambiguous'), at };
  const name = list[0]!;
  if (!/^[가-힣]{2,4}$/.test(name) || NOT_OFFICE.test(name)) return { field: miss(name ? 'ambiguous' : 'unparseable'), at };
  return { field: ok(`${name}세무서장`), at };
}

const DOCNO = /^([0-9A-Z]{4})\s*-?\s*(\d{3})\s*-?\s*(\d{4})\s*-?\s*(\d{3})(?!\d)/;
const ocrDocNo = (s: string) => s.replace(/^[ㅠㅜᅲᅮ](?=\s*\d{3}\s*-)/, 'T');

function docNo(t: string, c: Compact): Field {
  const found = new Set<string>();
  for (const p of findLabel(c, '발급번호')) {
    const gap = /^[\s:_|.ㆍ]*/.exec(ahead(t, p.end, 24))![0].length;
    const m = DOCNO.exec(ocrDocNo(ahead(t, p.end + gap, 40)).replace(/^T\s+/, 'T'));
    if (m) found.add(`${m[1]}-${m[2]}-${m[3]}-${m[4]}`);
  }
  if (!found.size) for (const m of t.matchAll(/(?<![0-9A-Z-])([0-9A-Z]{4})-(\d{3})-(\d{4})-(\d{3})(?![\d-])/g)) found.add(`${m[1]}-${m[2]}-${m[3]}-${m[4]}`);
  if (!found.size) return miss('not_found');
  return found.size === 1 ? ok([...found][0]!) : miss('ambiguous');
}

const BIZNO = /(?<!\d)(\d(?: ?\d){2})\s*-\s*(\d ?\d)\s*-\s*(\d(?: ?\d){4})(?!\d)|(?<!\d)(\d{10})(?!\d)/;

function subjectBizNo(t: string, c: Compact): Field {
  const values = new Set<string>();
  for (const p of findLabel(c, '사업자등록번호')) {
    const m = BIZNO.exec(ahead(t, p.end, 80));
    if (m) values.add((m[4] ?? `${m[1]}${m[2]}${m[3]}`).replace(/ /g, ''));
  }
  if (!values.size) return miss('not_found');
  const list = [...values];
  const valid = list.filter(isValidBizNo);
  if (valid.length === 1) return ok(valid[0]!);
  if (valid.length > 1) return miss('ambiguous');
  return miss('checksum_failed', list[0]);
}

const CTX = 40;
const MAX_CANDIDATES = 8;

function candidates(t: string): DocMetaObservation['candidates'] {
  const out: DocMetaObservation['candidates'] = [];
  for (const h of allDates(t)) {
    if (!h.iso) continue;
    if (out.length >= MAX_CANDIDATES) break;
    const context = apply(t.slice(Math.max(0, h.start - CTX), h.end + CTX), { runId: 'docmeta' }, { frame: 'none' }).redacted;
    out.push({ date: h.iso, context: context.replace(/\s+/g, ' ').trim() });
  }
  return out;
}

export function extractDocMeta(text: string): DocMetaExtract {
  const t = text.normalize('NFKC');
  const c = compact(t);
  const kind = classify(c);
  const docType = (DOC_TYPES as readonly string[]).includes(kind) ? (kind as DocType) : null;
  const cands = candidates(t);
  if (!docType) {
    const u = miss('unsupported_doc');
    return { extractor: 'docmeta-v1', kind, docType: null, issuedOn: u, validUntil: u, issuer: u, docNo: u, subjectBizNo: u, uncertain: [], candidates: cands };
  }
  const iss = issuer(t, c);
  const issued = issuedOn(t, c, iss.at);
  return {
    extractor: 'docmeta-v1',
    kind,
    docType,
    issuedOn: issued.field,
    validUntil: docType === 'national_tax_cert' ? validUntil(t, c) : miss('not_applicable'),
    issuer: iss.field,
    docNo: docNo(t, c),
    subjectBizNo: subjectBizNo(t, c),
    uncertain: issued.uncertain ? ['issuedOn'] : [],
    candidates: cands,
  };
}
