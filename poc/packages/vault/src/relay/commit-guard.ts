// R-C1 커밋 본문 대조(D05 §3.3, D03 §5.4, ADR-005 v3 결정 10, B-03·E-02).
// 엔진은 커밋 엔드포인트를 Fetch로 가로채고(요청 단계), 무장할 때 commitGuard.arm으로 기대 해시를 보낸다.
// 금고는 엔진행 Fetch.requestPaused를 줄(순서 큐)에서 잡아 그 요청 본문을 같은 규칙으로 해시해 비교한다.
// - 일치: 본문을 지운 이벤트를 엔진에 넘긴다(엔진이 이어서 continueRequest).
// - 불일치: 금고가 Fetch.failRequest로 막고 이벤트는 넘기지 않는다.
// - opaque(평문 형식 아님·본문 없음): 이벤트를 그대로(본문은 지우고) 넘긴다. 대조 못 함(D03 §5.4 잔여 위험).
// 결과는 엔진 이벤트 commit.body_compared{intentId, stepId, match}로만 알린다. 본문·값은 로그·이벤트에 남기지 않는다.
import type { EventLog } from '@sax/platform';
import { COMMIT_ARM_TTL_MS, commitExpectedHash, type CommitArmParams, type CommitArmResult, type CommitBodyComparedEvent, type CommitMatch } from '../protocol.ts';
import { urlAllowed } from './policy.ts';

type Json = Record<string, unknown>;

const RUN_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const STEP_ID_RE = /^[A-Za-z0-9._:-]{1,128}$/;
const FIELD_KEY_RE = /^[A-Za-z0-9_.-]{1,64}$/;
const METHOD_RE = /^[A-Z]{3,7}$/;
const HASH_RE = /^[0-9a-f]{64}$/;
/** bodyFieldMap 항목 수·경로 길이·endpoint 길이 상한. */
export const COMMIT_FIELD_MAX = 64;
const PATH_MAX = 256;
const ENDPOINT_MAX = 2048;
/** 대조할 본문 최대 크기(이보다 크면 opaque). */
export const COMMIT_BODY_MAX = 1_048_576;

interface Arm {
  p: CommitArmParams;
  method: string;
  re: RegExp;
  timer: ReturnType<typeof setTimeout>;
}

export interface CommitGuardOptions {
  log: EventLog;
  allowedHosts: string[];
  /** 결과 이벤트(엔진 포트). */
  emit: (data: CommitBodyComparedEvent) => void;
  /** 금고 연결로 보내는 CDP 명령(엔진 세션 ID 그대로). */
  send: (method: string, params: Json, sessionId: string) => Promise<Json>;
  /** 노출된 타깃인가. */
  exposed: (targetId: string) => boolean;
  ttlMs?: number;
}

export type PausedDecision = 'pass' | 'hide' | 'drop';

/** Fetch urlPattern(`*` 임의 문자열, `?` 한 글자, `\`는 다음 글자 그대로) → 정규식. */
export function urlPatternToRegExp(pattern: string): RegExp {
  let out = '';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]!;
    if (c === '\\' && i + 1 < pattern.length) out += escapeRe(pattern[++i]!);
    else if (c === '*') out += '.*';
    else if (c === '?') out += '.';
    else out += escapeRe(c);
  }
  return new RegExp(`^${out}$`, 's');
}

function escapeRe(c: string): string {
  return /[.*+?^${}()|[\]\\/]/.test(c) ? `\\${c}` : c;
}

/** commitGuard.arm 인자 검사. 맞으면 null, 아니면 거부 사유. */
export function checkArmParams(x: unknown, allowedHosts: string[]): CommitArmResult['reason'] | null {
  if (!x || typeof x !== 'object') return 'bad_params';
  const p = x as Record<string, unknown>;
  if (typeof p.runId !== 'string' || !RUN_ID_RE.test(p.runId)) return 'bad_params';
  if (typeof p.intentId !== 'string' || !STEP_ID_RE.test(p.intentId)) return 'bad_params';
  if (typeof p.stepId !== 'string' || !STEP_ID_RE.test(p.stepId)) return 'bad_params';
  if (typeof p.targetId !== 'string' || p.targetId.length === 0 || p.targetId.length > 64) return 'bad_params';
  if (p.method !== undefined && (typeof p.method !== 'string' || !METHOD_RE.test(p.method))) return 'bad_params';
  if (typeof p.expectedHash !== 'string' || !HASH_RE.test(p.expectedHash)) return 'bad_params';
  const map = p.bodyFieldMap;
  if (!map || typeof map !== 'object' || Array.isArray(map)) return 'bad_params';
  const entries = Object.entries(map as Record<string, unknown>);
  if (entries.length === 0 || entries.length > COMMIT_FIELD_MAX) return 'bad_params';
  for (const [k, v] of entries) {
    if (!FIELD_KEY_RE.test(k) || typeof v !== 'string' || v.length === 0 || v.length > PATH_MAX) return 'bad_params';
  }
  if (typeof p.endpoint !== 'string' || p.endpoint.length === 0 || p.endpoint.length > ENDPOINT_MAX) return 'bad_params';
  // 패턴의 스킴·호스트는 와일드카드 없이 고정이어야 한다(호스트 와일드카드로 허용 목록을 넘지 못하게).
  const m = /^(https?):\/\/([^/*?\\]+)\//.exec(p.endpoint);
  if (!m || !urlAllowed(`${m[1]}://${m[2]}/`, allowedHosts)) return 'endpoint_not_allowed';
  return null;
}

// ───────────────────────── 본문 해석 ─────────────────────────

export type BodyValues = { kind: 'values'; values: Record<string, string> } | { kind: 'opaque' } | { kind: 'mismatch'; why: 'parse' | 'missing' };

/** 평문 형식 판정. form·json·xml만 대조한다. */
export function bodyFormat(contentType: string | undefined): 'form' | 'json' | 'xml' | null {
  const ct = (contentType ?? '').split(';')[0]!.trim().toLowerCase();
  if (ct === 'application/x-www-form-urlencoded') return 'form';
  if (ct === 'application/json' || /^application\/[a-z0-9.+-]+\+json$/.test(ct)) return 'json';
  if (ct === 'application/xml' || ct === 'text/xml' || /^application\/[a-z0-9.+-]+\+xml$/.test(ct)) return 'xml';
  return null;
}

/**
 * 본문에서 bodyFieldMap 값을 꺼낸다. 평문 형식이 아니거나 본문이 비면 opaque.
 * 선언된 형식인데 해석이 안 되거나 필드가 없으면(또는 form 같은 이름이 둘 이상이면) mismatch(막는다, fail-closed).
 */
export function extractCommitValues(contentType: string | undefined, body: string | null, map: Record<string, string>): BodyValues {
  const fmt = bodyFormat(contentType);
  if (!fmt || body === null || body.length === 0) return { kind: 'opaque' };
  const values: Record<string, string> = {};
  if (fmt === 'form') {
    const q = new URLSearchParams(body);
    for (const [k, name] of Object.entries(map)) {
      const all = q.getAll(name);
      if (all.length !== 1) return { kind: 'mismatch', why: 'missing' };
      values[k] = all[0]!;
    }
    return { kind: 'values', values };
  }
  if (fmt === 'json') {
    let doc: unknown;
    try {
      doc = JSON.parse(body);
    } catch {
      return { kind: 'mismatch', why: 'parse' };
    }
    for (const [k, path] of Object.entries(map)) {
      const v = jsonAt(doc, path);
      if (v === undefined) return { kind: 'mismatch', why: 'missing' };
      values[k] = v;
    }
    return { kind: 'values', values };
  }
  const tree = parseXml(body);
  if (!tree) return { kind: 'mismatch', why: 'parse' };
  for (const [k, path] of Object.entries(map)) {
    if (!path.startsWith('xml:/')) return { kind: 'mismatch', why: 'missing' };
    const v = xmlAt(tree, path.slice(5).split('/'));
    if (v === undefined) return { kind: 'mismatch', why: 'missing' };
    values[k] = v;
  }
  return { kind: 'values', values };
}

/** `a.b[0].c` 경로의 스칼라 값(문자열·숫자·불리언)을 문자열로. 없거나 객체면 undefined. */
export function jsonAt(doc: unknown, path: string): string | undefined {
  const re = /([^.[\]]+)|\[(\d+)\]|(\.)/g;
  const steps: Array<string | number> = [];
  let rebuilt = '';
  let m: RegExpExecArray | null;
  let expectKey = true;
  while ((m = re.exec(path))) {
    rebuilt += m[0];
    if (m[3]) {
      if (expectKey) return undefined;
      expectKey = true;
    } else if (m[1] !== undefined) {
      if (!expectKey) return undefined;
      steps.push(m[1]);
      expectKey = false;
    } else {
      if (steps.length === 0 && expectKey) return undefined;
      steps.push(Number(m[2]));
      expectKey = false;
    }
  }
  if (rebuilt !== path || expectKey || steps.length === 0) return undefined;
  let cur: unknown = doc;
  for (const s of steps) {
    if (typeof s === 'number') {
      if (!Array.isArray(cur) || s >= cur.length) return undefined;
      cur = cur[s];
    } else {
      if (!cur || typeof cur !== 'object' || Array.isArray(cur) || !Object.hasOwn(cur, s)) return undefined;
      cur = (cur as Record<string, unknown>)[s];
    }
  }
  if (typeof cur === 'string') return cur;
  if (typeof cur === 'number' && Number.isFinite(cur)) return String(cur);
  if (typeof cur === 'boolean') return String(cur);
  return undefined;
}

interface XmlNode {
  name: string;
  children: XmlNode[];
  text: string[];
}

const XML_ENTITIES: Record<string, string> = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };

/** 텍스트의 엔티티를 푼다(기본 5개·숫자 참조만). 맨 & 나 모르는 엔티티는 형식 오류(null). */
function decodeXml(s: string): string | null {
  let bad = false;
  const out = s.replace(/&([^;&\s]*);?/g, (all, ent: string) => {
    if (!all.endsWith(';')) {
      bad = true;
      return '';
    }
    if (ent.startsWith('#')) {
      const cp = /^#x[0-9a-fA-F]{1,6}$/.test(ent) ? parseInt(ent.slice(2), 16) : /^#\d{1,7}$/.test(ent) ? parseInt(ent.slice(1), 10) : NaN;
      if (!Number.isInteger(cp) || cp <= 0 || cp > 0x10ffff) {
        bad = true;
        return '';
      }
      return String.fromCodePoint(cp);
    }
    const v = XML_ENTITIES[ent];
    if (v === undefined) bad = true;
    return v ?? '';
  });
  return bad ? null : out;
}

/** 최소 XML 해석기: 요소·텍스트·CDATA만. DOCTYPE(엔티티 정의)은 받지 않는다. 형식이 틀리면 null. */
export function parseXml(src: string): XmlNode | null {
  const root: XmlNode = { name: '#doc', children: [], text: [] };
  const stack: XmlNode[] = [root];
  let i = 0;
  while (i < src.length) {
    const lt = src.indexOf('<', i);
    const textEnd = lt === -1 ? src.length : lt;
    if (textEnd > i) {
      const raw = src.slice(i, textEnd);
      const top = stack[stack.length - 1]!;
      if (top === root) {
        if (raw.trim()) return null; // 루트 밖 텍스트
      } else {
        const t = decodeXml(raw);
        if (t === null) return null;
        top.text.push(t);
      }
    }
    if (lt === -1) break;
    if (src.startsWith('<!--', lt)) {
      const e = src.indexOf('-->', lt + 4);
      if (e === -1) return null;
      i = e + 3;
    } else if (src.startsWith('<![CDATA[', lt)) {
      const e = src.indexOf(']]>', lt + 9);
      if (e === -1 || stack.length === 1) return null;
      stack[stack.length - 1]!.text.push(src.slice(lt + 9, e));
      i = e + 3;
    } else if (src.startsWith('<?', lt)) {
      const e = src.indexOf('?>', lt + 2);
      if (e === -1) return null;
      i = e + 2;
    } else if (src.startsWith('<!', lt)) {
      return null; // DOCTYPE 등
    } else {
      const e = findTagEnd(src, lt + 1);
      if (e === -1) return null;
      const inner = src.slice(lt + 1, e);
      i = e + 1;
      if (inner.startsWith('/')) {
        const name = inner.slice(1).trim();
        const top = stack.pop();
        if (!top || top === root || top.name !== name) return null;
        continue;
      }
      const selfClose = inner.endsWith('/');
      const m = /^([A-Za-z_][\w.:-]*)(\s[\s\S]*)?$/.exec(selfClose ? inner.slice(0, -1) : inner);
      if (!m) return null;
      const parent = stack[stack.length - 1]!;
      if (parent === root && root.children.length) return null; // 루트 요소는 하나
      const node: XmlNode = { name: m[1]!, children: [], text: [] };
      parent.children.push(node);
      if (!selfClose) stack.push(node);
    }
  }
  if (stack.length !== 1 || root.children.length !== 1) return null;
  return root;
}

function findTagEnd(src: string, from: number): number {
  let q: string | null = null;
  for (let j = from; j < src.length; j++) {
    const c = src[j];
    if (q) {
      if (c === q) q = null;
    } else if (c === '"' || c === "'") q = c;
    else if (c === '>') return j;
    else if (c === '<') return -1;
  }
  return -1;
}

const localName = (n: string) => n.slice(n.indexOf(':') + 1);

/** `xml:/root/a/b`의 잎 요소 텍스트. 같은 경로가 둘 이상이거나 자식 요소가 있으면 undefined. */
export function xmlAt(doc: XmlNode, segs: string[]): string | undefined {
  if (segs.length === 0 || segs.some((s) => !s)) return undefined;
  let level: XmlNode[] = doc.children;
  let hit: XmlNode | undefined;
  for (const s of segs) {
    const found = level.filter((c) => localName(c.name) === s);
    if (found.length !== 1) return undefined;
    hit = found[0]!;
    level = hit.children;
  }
  // 대조 필드는 잎 요소만(자식 요소가 섞인 요소는 텍스트 순서가 모호하다).
  if (!hit || hit.children.length) return undefined;
  return hit.text.join('');
}

// ───────────────────────── 무장·대조 ─────────────────────────

export class CommitGuard {
  private readonly arms = new Map<string, Arm>();
  /** 금고가 막은 요청(Fetch requestId). 엔진이 이어서 continue·fulfill하지 못하게 한다. */
  readonly blocked = new Set<string>();
  private readonly o: CommitGuardOptions;

  constructor(opts: CommitGuardOptions) {
    this.o = opts;
  }

  arm(x: unknown): CommitArmResult {
    const reason = checkArmParams(x, this.o.allowedHosts);
    if (reason) {
      this.o.log.event('vault.commit_arm_refused', { reason });
      return { armed: false, reason };
    }
    const p = x as CommitArmParams;
    if (!this.o.exposed(p.targetId)) return { armed: false, reason: 'target_not_exposed' };
    const key = armKey(p);
    if (this.arms.has(key) || [...this.arms.values()].some((a) => a.p.targetId === p.targetId)) return { armed: false, reason: 'already_armed' };
    const params: CommitArmParams = { ...p, bodyFieldMap: { ...p.bodyFieldMap } };
    const timer = setTimeout(() => this.finish(key, 'expired'), this.o.ttlMs ?? COMMIT_ARM_TTL_MS);
    timer.unref?.();
    this.arms.set(key, { p: params, method: p.method ?? 'POST', re: urlPatternToRegExp(p.endpoint), timer });
    this.o.log.event('vault.commit_armed', { fields: Object.keys(p.bodyFieldMap).length });
    return { armed: true };
  }

  disarm(x: unknown): void {
    const p = x as { intentId?: unknown; stepId?: unknown } | undefined;
    const key = `${String(p?.intentId)}|${String(p?.stepId)}`;
    const a = this.arms.get(key);
    if (!a) return;
    clearTimeout(a.timer);
    this.arms.delete(key);
  }

  /** run.end: 그 run의 무장을 알림 없이 푼다. */
  clearRun(runId: string): void {
    for (const [k, a] of this.arms) {
      if (a.p.runId !== runId) continue;
      clearTimeout(a.timer);
      this.arms.delete(k);
    }
  }

  shutdown(): void {
    for (const a of this.arms.values()) clearTimeout(a.timer);
    this.arms.clear();
    this.blocked.clear();
  }

  get armedCount(): number {
    return this.arms.size;
  }

  /** 이 타깃의 이 요청이 무장 대상인가(Network.requestWillBeSent 본문 지우기에도 쓴다). */
  armedFor(targetId: string, url: string, method: string): boolean {
    return !!this.find(targetId, url, method);
  }

  private find(targetId: string, url: string, method: string): [string, Arm] | undefined {
    for (const e of this.arms) if (e[1].p.targetId === targetId && e[1].method === method && e[1].re.test(url)) return e;
    return undefined;
  }

  /**
   * 엔진행 Fetch.requestPaused(요청 단계). 무장 대상이 아니면 pass. 대상이면 비교해
   * 일치·opaque는 hide(본문 지우고 넘김), 불일치는 금고가 failRequest로 막고 drop.
   */
  async onPaused(targetId: string, sessionId: string, p: Json): Promise<PausedDecision> {
    if (p.responseStatusCode !== undefined || p.responseErrorReason !== undefined) return 'pass';
    const req = (p.request ?? {}) as Json;
    const hit = this.find(targetId, String(req.url ?? ''), String(req.method ?? ''));
    if (!hit) return 'pass';
    const [key, a] = hit;
    // 한 무장에 한 요청. 비교 전에 지워 같은 무장으로 두 번 대조하지 않는다.
    clearTimeout(a.timer);
    this.arms.delete(key);
    const body = await this.bodyOf(req, p, sessionId);
    const got = extractCommitValues(headerOf(req.headers, 'content-type'), body, a.p.bodyFieldMap);
    let match: CommitMatch;
    if (got.kind === 'opaque') match = 'opaque';
    else if (got.kind === 'mismatch') match = false;
    else match = commitExpectedHash(got.values, a.p.bodyFieldMap) === a.p.expectedHash;
    this.o.log.event('vault.commit_compared', { match, ...(got.kind === 'mismatch' ? { why: got.why } : {}) });
    if (match === false) {
      const requestId = String(p.requestId);
      this.blocked.add(requestId);
      try {
        await this.o.send('Fetch.failRequest', { requestId, errorReason: 'BlockedByClient' }, sessionId);
      } catch (e) {
        this.o.log.event('vault.commit_block_failed', { error: (e as Error).message.slice(0, 80) });
      }
      this.o.emit({ intentId: a.p.intentId, stepId: a.p.stepId, match });
      return 'drop';
    }
    this.o.emit({ intentId: a.p.intentId, stepId: a.p.stepId, match });
    return 'hide';
  }

  private finish(key: string, match: CommitMatch): void {
    const a = this.arms.get(key);
    if (!a) return;
    this.arms.delete(key);
    this.o.log.event('vault.commit_compared', { match });
    this.o.emit({ intentId: a.p.intentId, stepId: a.p.stepId, match });
  }

  /** 요청 본문(UTF-8). postDataEntries → postData → (너무 커서 빠졌으면) Network.getRequestPostData. 못 읽거나 이진이면 null. */
  private async bodyOf(req: Json, p: Json, sessionId: string): Promise<string | null> {
    const entries = req.postDataEntries as Array<{ bytes?: unknown }> | undefined;
    if (Array.isArray(entries) && entries.length) {
      const parts: Buffer[] = [];
      for (const e of entries) {
        if (typeof e?.bytes !== 'string') return null;
        parts.push(Buffer.from(e.bytes, 'base64'));
      }
      return utf8(Buffer.concat(parts));
    }
    if (typeof req.postData === 'string') return req.postData.length > COMMIT_BODY_MAX ? null : req.postData;
    if (req.hasPostData === true && typeof p.networkId === 'string') {
      try {
        const r = await this.o.send('Network.getRequestPostData', { requestId: p.networkId }, sessionId);
        if (typeof r.postData !== 'string') return null;
        return r.base64Encoded === true ? utf8(Buffer.from(r.postData, 'base64')) : r.postData.length > COMMIT_BODY_MAX ? null : r.postData;
      } catch {
        return null;
      }
    }
    return null;
  }
}

function armKey(p: { intentId: string; stepId: string }): string {
  return `${p.intentId}|${p.stepId}`;
}

function utf8(b: Buffer): string | null {
  if (b.length > COMMIT_BODY_MAX) return null;
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(b);
  } catch {
    return null;
  }
}

function headerOf(headers: unknown, name: string): string | undefined {
  if (!headers || typeof headers !== 'object') return undefined;
  for (const [k, v] of Object.entries(headers as Record<string, unknown>)) if (k.toLowerCase() === name && typeof v === 'string') return v;
  return undefined;
}
