import {
  ACTIVE_WINDOW_DENY_PREFIXES,
  PORTAL_ETLD1,
  RELAY_DENIED_METHODS,
  RELAY_DOMAIN_METHOD_ALLOWLIST,
  TAINT_RUNTIME_DENY_PATTERNS,
} from '../constants.ts';

/** 중계 정책. 앱은 constants.ts 값만 쓰고(defaultRelayPolicy), 테스트는 origin 목록만 바꿔 주입한다. */
export interface RelayPolicy {
  /** 엔진에 노출하는 타깃의 허용 호스트(eTLD+1 또는 정확한 호스트). */
  allowedHosts: string[];
  /** 비밀 종류별 허용 호스트. */
  secretHosts: Record<string, string[]>;
  domainMethods: Record<string, string[] | '*'>;
  deniedMethods: Set<string>;
  keyDelayMs: number;
  typistInput: 'insertText' | 'keyEvents';
}

export function defaultRelayPolicy(secretOrigins: Record<string, string[]>, keyDelayMs: number, typistInput: 'insertText' | 'keyEvents'): RelayPolicy {
  return {
    typistInput,
    allowedHosts: [...PORTAL_ETLD1],
    secretHosts: secretOrigins,
    domainMethods: RELAY_DOMAIN_METHOD_ALLOWLIST,
    deniedMethods: RELAY_DENIED_METHODS,
    keyDelayMs,
  };
}

export function hostAllowed(host: string, allowed: string[]): boolean {
  const h = host.toLowerCase();
  return allowed.some((a) => h === a || h.endsWith('.' + a));
}

/** 노출 타깃이 머물 수 있는 URL. about:blank와 Chrome 오류 페이지는 내용이 없으므로 허용한다. */
export function urlAllowed(url: string, allowed: string[]): boolean {
  if (url === '' || url === 'about:blank' || url.startsWith('chrome-error://')) return true;
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return false;
  // http는 테스트 픽스처(127.0.0.1)에서만 의미가 있다. 내장 목록(hometax.go.kr)은 https로만 쓴다.
  if (u.protocol === 'http:' && !['127.0.0.1', 'localhost'].includes(u.hostname)) return false;
  return hostAllowed(u.hostname, allowed);
}

export type SessionState = {
  /** 비밀 창 활성 상태(D05 §3.5 ①). */
  active: boolean;
  /** 비밀 창 오염 상태(활성 포함, 다음 문서 커밋까지). */
  tainted: boolean;
};

export type Verdict = { ok: true } | { ok: false; reason: string };

const OK: Verdict = { ok: true };
const deny = (reason: string): Verdict => ({ ok: false, reason });

/** 엔진이 page·자식 세션에 보낸 명령 판정(기본 거부). 루트(브라우저) 명령은 relay.ts의 가상 루트가 처리한다. */
export function checkSessionCommand(
  method: string,
  params: Record<string, unknown> | undefined,
  state: SessionState,
  policy: RelayPolicy,
  taintedRequests: ReadonlySet<string>,
): Verdict {
  if (policy.deniedMethods.has(method)) return deny('denied_method');
  const [domain, name] = method.split('.', 2) as [string, string | undefined];
  const rule = policy.domainMethods[domain];
  if (!rule || !name) return deny('domain_not_allowed');
  if (rule !== '*' && !rule.includes(name)) return deny('method_not_allowed');

  if (state.active && ACTIVE_WINDOW_DENY_PREFIXES.some((p) => method === p || method.startsWith(p))) return deny('secret_window_active');

  if (state.tainted || state.active) {
    if (method === 'Page.captureScreenshot' || method === 'Page.startScreencast') return deny('secret_window_tainted');
    if (method === 'Runtime.evaluate' || method === 'Runtime.callFunctionOn') {
      // Playwright의 callFunctionOn은 범용 래퍼이고 실제 코드는 문자열 인자로 간다(S6b). 인자 문자열까지 본다.
      const args = Array.isArray(params?.arguments) ? (params.arguments as Array<{ value?: unknown }>).map((a) => (typeof a.value === 'string' ? a.value : '')) : [];
      const code = [String(params?.expression ?? params?.functionDeclaration ?? ''), ...args].join('\n');
      if (TAINT_RUNTIME_DENY_PATTERNS.some((re) => re.test(code))) return deny('secret_window_tainted');
    }
  }
  if ((method === 'Network.getRequestPostData' || method === 'Fetch.getRequestPostData') && taintedRequests.has(String(params?.requestId))) {
    return deny('tainted_request_body');
  }
  if (method === 'Page.navigate' && !urlAllowed(String(params?.url ?? ''), policy.allowedHosts)) return deny('origin_not_allowed');
  if (method === 'Target.setAutoAttach' && params?.flatten !== true) return deny('flatten_required');
  return OK;
}
