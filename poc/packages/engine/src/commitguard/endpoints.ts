// 커밋 가드의 요청 분류(D03 §5.4, D02 §2.1 commitEndpoints·knownEndpoints).
// - 합집합: 같은 포털의 설치된 모든 패키지 commitEndpoints + 적용된 핫픽스 commitEndpointsAdd(추가만).
// - 분류는 메서드 + (선택적 host) + 경로(RE2) + 선택적 액션 파라미터. 쿼리에서 먼저 찾고, 없으면 form 본문에서 찾는다.
//   무장된 요청의 본문은 금고가 지워 엔진에 오지 않으므로(R-C1 ⑤), 액션 파라미터를 확인할 수 없으면 커밋으로 본다(보수적).
// - R-C3: 어디에도 없는 요청은 경로 모양만 남긴다(본문·쿼리 없음, 숫자는 {n}).
import { compileRe2 } from '../core/re2.ts';
import type { CommitEndpoint, Effect, EndpointMatch, SelectorDict } from '../core/types.ts';
import { hostAllowed } from '../core/validate.ts';

export interface GuardRequest {
  url: string;
  method: string;
  /** form 본문(평문이고 엔진에 온 경우만). 무장된 커밋 요청은 금고가 지워 null이다. */
  postData?: string | null;
  contentType?: string;
}

export type Classified = { kind: 'commit'; index: number; endpoint: CommitEndpoint } | { kind: 'known' } | { kind: 'unclassified'; pathPattern: string } | { kind: 'outside' };

/** 같은 포털 패키지들의 commitEndpoints 합집합(같은 항목은 한 번). 순서는 먼저 온 패키지부터. */
export function endpointUnion(dicts: readonly Pick<SelectorDict, 'commitEndpoints'>[], hotfixAdds: readonly CommitEndpoint[] = []): CommitEndpoint[] {
  const out: CommitEndpoint[] = [];
  const seen = new Set<string>();
  for (const ce of [...dicts.flatMap((d) => d.commitEndpoints), ...hotfixAdds]) {
    const k = endpointKey(ce);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(structuredClone(ce));
  }
  return out;
}

export function knownUnion(dicts: readonly Pick<SelectorDict, 'knownEndpoints'>[]): EndpointMatch[] {
  const out: EndpointMatch[] = [];
  const seen = new Set<string>();
  for (const m of dicts.flatMap((d) => d.knownEndpoints)) {
    const k = matchKey(m);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(structuredClone(m));
  }
  return out;
}

const matchKey = (m: EndpointMatch) => JSON.stringify([m.method, m.host ?? null, m.pathPattern, m.actionParam?.name ?? null, m.actionParam?.value ?? null]);
const endpointKey = (c: CommitEndpoint) =>
  JSON.stringify([matchKey(c.match), c.effect, c.maxRequests, c.encoding ?? null, c.bodyFieldMap ? Object.entries(c.bodyFieldMap).sort(([a], [b]) => (a < b ? -1 : 1)) : null]);

/** 컴파일한 분류기. 패턴은 로더가 V-01(RE2)로 이미 확인했다. */
export class EndpointClassifier {
  private readonly commits: Array<{ endpoint: CommitEndpoint; re: RegExp }>;
  private readonly known: Array<{ m: EndpointMatch; re: RegExp }>;
  private readonly domains: readonly string[];

  constructor(commits: readonly CommitEndpoint[], known: readonly EndpointMatch[], domains: readonly string[]) {
    this.commits = commits.map((endpoint) => ({ endpoint, re: compileRe2(endpoint.match.pathPattern) }));
    this.known = known.map((m) => ({ m, re: compileRe2(m.pathPattern) }));
    this.domains = domains;
  }

  get size(): number {
    return this.commits.length;
  }

  classify(r: GuardRequest): Classified {
    let u: URL;
    try {
      u = new URL(r.url);
    } catch {
      return { kind: 'outside' };
    }
    if (!hostAllowed(u.hostname, this.domains)) return { kind: 'outside' };
    const method = r.method.toUpperCase();
    for (let i = 0; i < this.commits.length; i++) {
      const c = this.commits[i]!;
      if (c.endpoint.match.method === method && hostMatches(c.endpoint.match, u) && c.re.test(u.pathname) && paramMatches(c.endpoint.match, u, r, true)) return { kind: 'commit', index: i, endpoint: c.endpoint };
    }
    for (const k of this.known) if (k.m.method === method && hostMatches(k.m, u) && k.re.test(u.pathname) && paramMatches(k.m, u, r, false)) return { kind: 'known' };
    return { kind: 'unclassified', pathPattern: pathShape(u.pathname) };
  }
}

/** host가 있으면 요청 URL host(소문자, 포트 포함)가 정확히 같아야 한다(IR rev v1.3.5). 같은 경로가 여러 호스트에 있을 때(홈택스 wqAction.do) 가른다. */
function hostMatches(m: EndpointMatch, u: URL): boolean {
  return m.host === undefined || u.host.toLowerCase() === m.host.toLowerCase();
}

/**
 * 액션 파라미터 확인. 쿼리 → form 본문 순. 어디서도 확인할 수 없으면(본문이 없거나 평문 form이 아님)
 * 커밋 항목은 일치로(보수적), 알려진 항목은 불일치로 본다.
 */
function paramMatches(m: EndpointMatch, u: URL, r: GuardRequest, conservative: boolean): boolean {
  const ap = m.actionParam;
  if (!ap) return true;
  const q = u.searchParams.getAll(ap.name);
  if (q.length) return q.length === 1 && q[0] === ap.value;
  const ct = (r.contentType ?? '').split(';')[0]!.trim().toLowerCase();
  if (typeof r.postData === 'string' && r.postData.length && ct === 'application/x-www-form-urlencoded') {
    const b = new URLSearchParams(r.postData).getAll(ap.name);
    if (b.length) return b.length === 1 && b[0] === ap.value;
    return false;
  }
  return conservative;
}

/** R-C3 경로 모양: 숫자 연속은 {n}, 120자 상한. 쿼리·본문은 넣지 않는다. */
export function pathShape(path: string): string {
  return path.replace(/\d+/g, '{n}').slice(0, 120);
}

/**
 * RE2 경로 패턴 → Fetch urlPattern 경로 부분(금고 commitGuard.arm의 endpoint, R-C1).
 * 받는 것: `^/`로 시작, 이스케이프한 기호 글자, `.`(한 글자), `.*`·`.+`·`[^/]*`·`[^/]+`(→ `*`), 끝의 `$`.
 * 그 밖(선택·묶음·문자 집합·반복)은 null(무장 거부, fail-closed). 쿼리가 붙을 수 있어 끝은 언제나 `*`다.
 * 액션 파라미터가 있으면 `*이름=값*`을 붙여 같은 경로의 다른 액션을 금고가 대조하지 않게 좁힌다(S1에서 쿼리 위치 확인).
 * 변환은 원래 패턴보다 넓을 수만 있다. 넓어서 엉뚱한 요청을 대조하면 불일치로 막힌다(안전한 쪽).
 */
export function pathGlob(m: EndpointMatch): string | null {
  let s = m.pathPattern;
  if (!s.startsWith('^/')) return null;
  s = s.slice(1);
  if (s.endsWith('$') && !s.endsWith('\\$')) s = s.slice(0, -1);
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (c === '\\') {
      const n = s[++i];
      if (n === undefined || /[A-Za-z0-9]/.test(n)) return null;
      out += globLit(n);
    } else if (s.startsWith('.*', i) || s.startsWith('.+', i)) {
      out += '*';
      i += 1;
    } else if (s.startsWith('[^/]*', i) || s.startsWith('[^/]+', i)) {
      out += '*';
      i += 4;
    } else if (c === '.') out += '?';
    else if ('[](){}|?*+^$'.includes(c)) return null;
    else out += globLit(c);
  }
  out += '*';
  if (m.actionParam) out += `${globStr(m.actionParam.name)}=${globStr(m.actionParam.value)}*`;
  return out;
}

const globLit = (c: string): string => (c === '*' || c === '?' || c === '\\' ? `\\${c}` : c);
const globStr = (s: string): string => [...s].map(globLit).join('');

/** 이 효과의 R-C1 대상(본문 대조) 엔드포인트. 둘 이상이면 금고가 타깃당 하나만 무장하므로 고를 수 없다. */
export function rc1Candidates(endpoints: readonly CommitEndpoint[], effect: Effect): number[] {
  const out: number[] = [];
  endpoints.forEach((e, i) => {
    if (e.effect === effect && e.bodyFieldMap && Object.keys(e.bodyFieldMap).length && e.encoding !== 'opaque') out.push(i);
  });
  return out;
}
