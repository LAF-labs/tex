// D06 마스킹 최소판(PoC-7). 정규화 → 엔티티 탐지 → 토큰 치환 → SCREEN_DATA 구분자.
// PoC 범위 밖(D06 전체판 몫): 접근성 트리 절단·숨김 텍스트 제거, 인접 노드 결합 탐지, 주소 사전, 한글 숫자 사본 탐지, 이미지.
// 패턴은 공격적으로, 배제는 "확실히 아닌 것"만(D06 §4 마지막 줄).
import { mint, type RedactedText } from './redacted.ts';

export type RedactionCtx = { runId: string } | { chatSessionId: string };

export type EntityKind = 'APPROVAL' | 'CARD' | 'RRN' | 'CORPNO' | 'DLN' | 'BIZNO' | 'PHONE' | 'EMAIL' | 'ACCT' | 'AMT' | 'NAME';

export interface RedactionStats {
  bytes: number;
  replaced: number;
  byKind: Partial<Record<EntityKind, number>>;
}

export interface ApplyOptions {
  /** 번들 needsAmounts:true 호출만 금액 원값을 유지한다(D06 §4 ③). */
  needsAmounts?: boolean;
  /** 'screen'이면 <<<SCREEN_DATA … SCREEN_DATA>>>로 감싼다(D06 §3). */
  frame?: 'screen' | 'none';
}

export interface ApplyResult {
  redacted: RedactedText;
  map: TokenMap;
  stats: RedactionStats;
}

const D = '(?<!\\d)';
const E = '(?!\\d)';
// 순서가 우선순위다: 긴·구체적 형식이 먼저.
const PATTERNS: Array<[EntityKind, RegExp]> = [
  ['APPROVAL', new RegExp(`${D}\\d{8}-\\d{8}-\\d{8}${E}`, 'g')],
  ['CARD', new RegExp(`${D}\\d{4}[- ]?(?:\\d{4}|\\*{4})[- ]?(?:\\d{4}|\\*{4})[- ]?\\d{4}${E}`, 'g')],
  ['RRN', new RegExp(`${D}\\d{6}-?[1-8]\\d{6}${E}`, 'g')],
  ['CORPNO', new RegExp(`${D}\\d{6}-\\d{7}${E}`, 'g')],
  ['DLN', new RegExp(`${D}\\d{2}-\\d{2}-\\d{6}-\\d{2}${E}`, 'g')],
  ['BIZNO', new RegExp(`${D}\\d{3}-?\\d{2}-?\\d{5}${E}`, 'g')],
  ['PHONE', new RegExp(`(?:\\+82[- ]?|${D}0)(?:10|1[16789]|2|[3-6][1-5]|70)[- ]?\\d{3,4}[- ]?\\d{4}${E}`, 'g')],
  ['EMAIL', /[\p{L}\p{N}._%+-]+@[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)+/gu],
  // 계좌: 구분자 없는 10~14자리, 또는 구분자 포함 10~14자리(D06 §4 보수적)
  ['ACCT', new RegExp(`${D}(?:\\d{10,14}|\\d{2,6}-\\d{2,6}-\\d{2,7}(?:-\\d{1,3})?)${E}`, 'g')],
];
const AMOUNT = /(?<![\d,])(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?\s*(?:[천백십]?만|억|천)?\s*원|(?<![\d,])\d{1,3}(?:,\d{3})+(?![\d,])|[일이삼사오육칠팔구십백천만억]{2,}\s*원/gu;

function normalize(text: string): string {
  return text
    .normalize('NFKC')
    .replace(/[\u200B-\u200D\u2060\uFEFF]/g, '')
    .replace(/[\u2010-\u2015\u2212]/g, '-');
}

function escapeFrame(text: string): string {
  return text.replace(/<{3,}/g, '‹‹').replace(/>{3,}/g, '››').replace(/SCREEN_DATA/gi, 'SCREEN-DATA');
}

/** 실행(또는 대화 세션) 범위 토큰 맵. 같은 값은 같은 번호(D06 §4). 종료 시 폐기한다. */
export class TokenMap {
  readonly ctx: RedactionCtx;
  private readonly byValue = new Map<string, string>();
  private readonly byToken = new Map<string, string>();
  private readonly counters = new Map<EntityKind, number>();

  constructor(ctx: RedactionCtx) {
    this.ctx = ctx;
  }

  token(kind: EntityKind, value: string): string {
    const key = `${kind}\u0000${value}`;
    const hit = this.byValue.get(key);
    if (hit) return hit;
    const n = (this.counters.get(kind) ?? 0) + 1;
    this.counters.set(kind, n);
    const t = `[${kind}_${n}]`;
    this.byValue.set(key, t);
    this.byToken.set(t, value);
    return t;
  }

  has(token: string): boolean {
    return this.byToken.has(token);
  }

  get size(): number {
    return this.byToken.size;
  }

  clear(): void {
    this.byValue.clear();
    this.byToken.clear();
    this.counters.clear();
  }
}

export interface RedactorOptions {
  /** 사용자 사전(상호·대표자·거래처 이름). 실행 중 등재도 add()로. */
  names?: Iterable<string>;
}

export class Redactor {
  readonly map: TokenMap;
  private readonly names = new Set<string>();

  constructor(ctx: RedactionCtx, opts: RedactorOptions = {}) {
    this.map = new TokenMap(ctx);
    for (const n of opts.names ?? []) this.addName(n);
  }

  /** D06 §4 ② 실행 중 사전 등재. */
  addName(name: string): void {
    const n = normalize(name).trim();
    if (n.length >= 2) this.names.add(n);
  }

  apply(text: string, opts: ApplyOptions = {}): ApplyResult {
    const byKind: RedactionStats['byKind'] = {};
    let replaced = 0;
    const sub = (kind: EntityKind) => (m: string) => {
      byKind[kind] = (byKind[kind] ?? 0) + 1;
      replaced++;
      return this.map.token(kind, m);
    };
    let out = normalize(text);
    // 이름은 숫자 패턴보다 먼저(이름 안 숫자 없음), 긴 이름부터.
    for (const name of [...this.names].sort((a, b) => b.length - a.length)) {
      if (out.includes(name)) out = out.split(name).join(sub('NAME')(name));
    }
    for (const [kind, re] of PATTERNS) out = out.replace(re, sub(kind));
    if (!opts.needsAmounts) out = out.replace(AMOUNT, sub('AMT'));
    if ((opts.frame ?? 'screen') === 'screen') out = `<<<SCREEN_DATA\n${escapeFrame(out)}\nSCREEN_DATA>>>`;
    return { redacted: mint(out), map: this.map, stats: { bytes: Buffer.byteLength(out, 'utf8'), replaced, byKind } };
  }
}

/** D06 §8 apply(): 일회성 맵으로 마스킹한다. 실행 범위 일관성이 필요하면 Redactor를 쓴다. */
export function apply(text: string, ctx: RedactionCtx, opts: ApplyOptions & RedactorOptions = {}): ApplyResult {
  return new Redactor(ctx, opts).apply(text, opts);
}
