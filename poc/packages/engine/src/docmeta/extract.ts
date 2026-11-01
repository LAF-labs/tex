// 홈택스 민원증명 PDF 텍스트 → 메타(S4). 입력은 docparse 샌드박스가 낸 텍스트(제3자 내용)이고, 규칙으로만 읽는다.
// 서식 근거: 납세증명서 = 국세징수법 시행규칙 별지 제94호, 사업자등록증명 = 국세청 민원사무처리규정 별지 제5호.
// 서식 라벨은 글자 사이를 띄워 인쇄되므로 라벨은 공백을 지운 사본에서 찾고, 값은 원문에서 읽는다.
// 못 뽑은 칸은 비워 두고 이유를 남긴다. 값을 짐작해 채우지 않는다(사용자 확인으로 넘긴다).
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
  /** 정하지 못했지만 사용자에게 먼저 보여 줄 후보 */
  suggested?: string;
}

export interface DocMetaExtract {
  extractor: 'docmeta-v1';
  kind: DetectedKind;
  docType: DocType | null;
  /** YYYY-MM-DD */
  issuedOn: Field;
  /** 문서에 적힌 유효기간 끝 날짜(납세증명서만). 범위 검사는 validity.ts가 한다. */
  validUntil: Field;
  /** '○○세무서장' */
  issuer: Field;
  /** 발급번호 4-3-4-3 */
  docNo: Field;
  /** 대상 사업자등록번호(숫자 10자리) */
  subjectBizNo: Field;
  /** 값은 있지만 라벨에 묶이지 않은 추정으로 얻은 칸(사용자 확인 없이 만료일을 확정하지 않는다) */
  uncertain: Array<'issuedOn'>;
  /** doc_meta_check_v1 후보(날짜 앞뒤 40자 문맥, 마스킹, 최대 8개). 모델은 부르지 않는다. */
  candidates: DocMetaObservation['candidates'];
}

const ok = (value: string): Field => ({ value, reason: null });
const miss = (reason: FieldReason, suggested?: string): Field => (suggested === undefined ? { value: null, reason } : { value: null, reason, suggested });

/** 공백을 지운 사본과 원문 위치 대응표 */
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

/** 라벨이 이보다 많이 나오면 앞의 것만 본다(실제 서식은 한두 번이다. 반복을 채운 텍스트로 엔진을 붙잡지 못하게). */
const MAX_LABEL_HITS = 50;

/** 공백 무시 라벨 위치: 원문에서 라벨이 시작·끝나는 곳 */
function findLabel(c: Compact, label: string): Array<{ start: number; end: number }> {
  const out: Array<{ start: number; end: number }> = [];
  for (let i = c.s.indexOf(label); i >= 0 && out.length < MAX_LABEL_HITS; i = c.s.indexOf(label, i + 1)) out.push({ start: c.at[i]!, end: c.at[i + label.length - 1]! + 1 });
  return out;
}

/** 위치 뒤 짧은 창. 값은 라벨 바로 뒤에 있으므로 남은 텍스트 전체를 자르지 않는다(입력 길이의 제곱 비용 방지). */
const ahead = (t: string, pos: number, n: number) => t.slice(pos, pos + n);

// 앞뒤에 숫자·영문이 붙으면 날짜로 보지 않는다(OCR이 '30일'을 '3O일'로 읽으면 3일로 잘리지 않고 못 찾음이 된다).
const DATE_SRC = String.raw`(?<![\dA-Za-z])((?:19|20)\d{2})\s*(?:년|[.\-/])\s*(\d{1,2})\s*(?:월|[.\-/])\s*(\d{1,2})(?![\dA-Za-z])(?:\s*일|\s*\.)?`;
/** 기간 표기 구분자: ~ ∼ 〜(NFKC가 바꾸지 않는다) - – — 부터 */
const RANGE_SEP = String.raw`(?:[~∼〜\-–—]|부터)`;
const RANGE_AFTER = new RegExp(String.raw`^\s*${RANGE_SEP}\s*`);
const RANGE_BEFORE = new RegExp(String.raw`${RANGE_SEP}\s*$`);
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

/** pos 바로 뒤(공백·쌍점·닫는 괄호만 사이에 두고) 오는 날짜 */
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
  // OCR은 글자 사이를 넓힌 제목을 자주 놓친다. 본문 문구(국세징수법·체납, 증명 문구·사업자등록일)로도 알아본다.
  const national = (has(c, '납세증명서') || (has(c, '국세징수법') && has(c, '체납'))) && (has(c, '세무서장') || has(c, '국세징수법'));
  const bizReg = has(c, '사업자등록증명') || (has(c, '사업자등록일') && has(c, '증명합니다') && has(c, '세무서장'));
  if (national && bizReg) return 'ambiguous';
  if (national) return 'national_tax_cert';
  if (bizReg) return 'biz_registration_cert';
  if (has(c, '사업자등록증')) return 'biz_registration';
  return 'unknown';
}

/** 날짜 앞(최대 12자)에 이 라벨이 붙어 있으면 발급일이 아니다. 시각이 붙은 날짜(출력 시각)·기간 표기의 양 끝도 아니다. */
const NOT_ISSUE_LABELS = ['출력일시', '출력일', '인쇄일시', '인쇄일', '일시', '납부기한', '개업일', '연월일', '등록일', '접수일', '유효기간', '기간', '폐업일', '휴업', '개정', '시행'];

function isIssueLike(t: string, h: DateHit): boolean {
  const before = t.slice(Math.max(0, h.start - 12), h.start).replace(/\s/g, '').replace(/[:<([]+$/, '');
  if (NOT_ISSUE_LABELS.some((l) => before.endsWith(l))) return false;
  if (/^\s*\d{1,2}:\d{2}/.test(ahead(t, h.end, 16))) return false;
  if (RANGE_AFTER.test(ahead(t, h.end, 16)) || RANGE_BEFORE.test(t.slice(Math.max(0, h.start - 4), h.start))) return false;
  return true;
}

function pickDate(hits: DateHit[]): Field {
  if (!hits.length) return miss('not_found');
  const valid = [...new Set(hits.map((h) => h.iso).filter((v): v is string => v !== null))];
  if (!valid.length) return miss('unparseable');
  if (valid.length === 1) return ok(valid[0]!);
  return miss('ambiguous', valid[valid.length - 1]);
}

/**
 * 발급일: '증명합니다' 뒤 맺음 부분(담당부서·세무서장 줄)의 날짜, 없으면 '발급일' 라벨 바로 뒤.
 * 둘 다 없을 때만 '세무서장' 앞 200자에서 찾고, 그 값은 라벨에 묶이지 않았으므로 불확실(uncertain)로 둔다.
 */
function issuedOn(t: string, c: Compact, issuerAt: number | null): { field: Field; uncertain: boolean } {
  const closes = findLabel(c, '증명합니다');
  if (closes.length) {
    const f = pickDate(allDates(t).filter((h) => h.start >= closes[closes.length - 1]!.end && isIssueLike(t, h)));
    if (f.reason !== 'not_found') return { field: f, uncertain: false };
  }
  const labelled = pickDate(['발급일자', '발급일', '발행일'].flatMap((l) => findLabel(c, l)).map((p) => dateRightAfter(t, p.end)).filter((h): h is DateHit => h !== null));
  if (labelled.reason !== 'not_found' || issuerAt === null) return { field: labelled, uncertain: false };
  const near = pickDate(allDates(t).filter((h) => h.start >= issuerAt - 200 && h.start < issuerAt + 40 && isIssueLike(t, h)));
  return { field: near, uncertain: near.value !== null };
}

/** 유효기간: 라벨 바로 뒤 날짜. 'A ~ B'면 끝 날짜. 'A부터 30일간'처럼 끝을 못 읽으면 정하지 않는다. */
function validUntil(t: string, c: Compact): Field {
  const hits: DateHit[] = [];
  for (const p of findLabel(c, '유효기간')) {
    const first = dateRightAfter(t, p.end);
    if (!first) continue;
    const range = RANGE_AFTER.exec(ahead(t, first.end, 16));
    const second = range ? dateRightAfter(t, first.end + range[0].length) : null;
    if (range && !second) return miss('ambiguous', first.iso ?? undefined);
    hits.push(second ?? first);
  }
  return pickDate(hits);
}

/** 발급기관: '세무서장' 바로 앞 이름(붙어 있거나, 한 글자씩 띄운 글자). 세무서 이름은 2~4자이고 부서·날짜 글자(실·과·팀·일)로 끝나지 않는다. */
function issuer(t: string, c: Compact): { field: Field; at: number | null } {
  const names = new Set<string>();
  let at: number | null = null;
  for (const p of findLabel(c, '세무서장')) {
    at = p.start;
    const before = t.slice(Math.max(0, p.start - 30), p.start);
    // 붙은 글자('가나세무서장'), 띄운 낱글자('가 나 세 무 서 장'), 둘이 섞인 OCR('마 바 사세 무 서 장')
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
  if (!/^[가-힣]{2,4}$/.test(name) || /[실과팀일]$/.test(name)) return { field: miss(name ? 'ambiguous' : 'unparseable'), at };
  return { field: ok(`${name}세무서장`), at };
}

const DOCNO = /^([0-9A-Z]{4})\s*-?\s*(\d{3})\s*-?\s*(\d{4})\s*-?\s*(\d{3})(?!\d)/;
/** 한국어 OCR은 첫 칸의 영문 T를 'ㅠ'로 읽는다. 발급번호 자리에서만 되돌린다. */
const ocrDocNo = (s: string) => s.replace(/^[ㅠㅜᅲᅮ](?=\s*\d{3}\s*-)/, 'T'); // ㅠ·ㅜ, NFKC를 거치면 ᅲ·ᅮ

function docNo(t: string, c: Compact): Field {
  const found = new Set<string>();
  for (const p of findLabel(c, '발급번호')) {
    const gap = /^[\s:_|.ㆍ]*/.exec(ahead(t, p.end, 24))![0].length; // OCR이 표 선을 _·|로 읽는다
    const m = DOCNO.exec(ocrDocNo(ahead(t, p.end + gap, 40)).replace(/^T\s+/, 'T'));
    if (m) found.add(`${m[1]}-${m[2]}-${m[3]}-${m[4]}`);
  }
  if (!found.size) for (const m of t.matchAll(/(?<![0-9A-Z-])([0-9A-Z]{4})-(\d{3})-(\d{4})-(\d{3})(?![\d-])/g)) found.add(`${m[1]}-${m[2]}-${m[3]}-${m[4]}`);
  if (!found.size) return miss('not_found');
  return found.size === 1 ? ok([...found][0]!) : miss('ambiguous');
}

// OCR이 숫자 사이에 공백을 넣기도 한다('100-31-6 7606'). 체크섬이 잘못 붙은 번호를 걸러 낸다.
const BIZNO = /(?<!\d)(\d(?: ?\d){2})\s*-\s*(\d ?\d)\s*-\s*(\d(?: ?\d){4})(?!\d)|(?<!\d)(\d{10})(?!\d)/;

function subjectBizNo(t: string, c: Compact): Field {
  const values = new Set<string>();
  // 납세증명서는 '주민등록번호(사업자등록번호)', 사업자등록증명은 '사업자등록번호'. 라벨 뒤 80자 안의 첫 번호.
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

/** doc_meta_check_v1 후보: 날짜 일치 지점 ±40자 문맥을 마스킹해 최대 8개(D04 §3). */
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
