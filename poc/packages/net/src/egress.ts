import { createHash, randomUUID } from 'node:crypto';
import { GATEWAY_ORIGIN, GATEWAY_PATHS, GatewayError, gatewayErrorOf, type EgressSecurityEvent, type GatewayAuth } from './gateway.ts';
import { CODEF_MAX_BODY, CODEF_MAX_BYTES, CODEF_ORIGINS, CODEF_TIMEOUT_MS, CODEF_TOKEN_RE, decodeCodefBody, encodeCodefBody, isCodefEnv, isCodefPath, type CodefEnv, type CodefPath } from './codef.ts';
import { CLOUD_MAX_BODY, cloudHeaders, cloudMaxBytes, cloudRequestCheck, cloudSocketCheck, type CloudMethod } from './cloud.ts';
import { ModelGuard, type BundleAllowEntry, type GatewayDecideBody, type GatewayRespondBody, type GuardCode, type ModelGuardConfig } from './model-guard.ts';

export interface Destination {
  origin: string;
  paths: string[];
}

export const DESTINATIONS = {
  odcloud: { origin: 'https://api.odcloud.kr', paths: ['/api/nts-businessman/v1/status', '/api/nts-businessman/v1/validate'] },
  openai: { origin: 'https://api.openai.com', paths: ['/v1/decisions', '/v1/responses'] },
} as const satisfies Record<string, Destination>;

export type DestinationName = keyof typeof DESTINATIONS;

/**
 * 레지스트리 origin(앱 내장 상수, 팀장 결정 2026-11-06). 실물이 다른 저장소(Supabase Storage 등)에 있어도 이 origin 아래 재작성으로 두고,
 * 클라이언트에는 다른 도메인을 넣지 않는다. 게이트웨이와 같은 origin이다.
 */
export const REGISTRY_ORIGIN = 'https://tax.laf-co.com';
/** 릴리스 채널(packages/updater CHANNELS와 같다, D09 §8.6) */
export const REGISTRY_CHANNELS = ['stable', 'beta', 'hotfix'] as const;
/** 레지스트리 응답 상한(매니페스트·status·폐기 키·로그 헤드·항목·증명·인덱스는 작다) */
export const REGISTRY_MAX_BYTES = 1024 * 1024;
/** `.sxp` 패키지 응답 상한(엔진 SXP_MAX_BYTES·인덱스 항목 size 상한과 같다, D09 §8) */
export const REGISTRY_PACKAGE_MAX_BYTES = 16 * 1024 * 1024;
const PACKAGE_PATH = /^\/packages\/[a-z0-9]+(\.[a-z0-9_-]+)+@(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})\.sxp$/;

const DEC = '(0|[1-9][0-9]{0,14})';
const REGISTRY_ROUTES: ReadonlyArray<{ path: RegExp; query: Readonly<Record<string, RegExp>> }> = [
  { path: new RegExp(`^/releases/(${REGISTRY_CHANNELS.join('|')})/latest\\.json$`), query: {} },
  { path: /^\/registry\/status\.json$/, query: {} },
  { path: /^\/registry\/revoked_keys\.json$/, query: {} },
  { path: /^\/policy\/current\.json$/, query: {} },
  { path: /^\/registry\/stable\/index\.json$/, query: {} },
  { path: PACKAGE_PATH, query: {} },
  { path: /^\/registry\/log\/head\.json$/, query: {} },
  { path: new RegExp(`^/registry/log/entries/${DEC}\\.json$`), query: {} },
  { path: /^\/registry\/log\/proof\/inclusion$/, query: { leaf: /^[0-9a-f]{64}$/, size: new RegExp(`^${DEC}$`) } },
  { path: /^\/registry\/log\/proof\/consistency$/, query: { from: new RegExp(`^${DEC}$`), to: new RegExp(`^${DEC}$`) } },
];

/**
 * 레지스트리 GET 대상(경로 + 쿼리, origin 없이)이 허용 목록에 맞는지 본다. 정규화 우회(`..`, 퍼센트 인코딩, 중복 슬래시)·조각·
 * 다른 origin·추가·중복·빠진 쿼리 키를 모두 거부한다.
 */
export function registryTargetAllowed(target: string): boolean {
  if (typeof target !== 'string' || !target.startsWith('/') || target.startsWith('//') || target.length > 512) return false;
  if (!/^[A-Za-z0-9/_.?=&@-]+$/.test(target)) return false;
  let url: URL;
  try {
    url = new URL(target, REGISTRY_ORIGIN);
  } catch {
    return false;
  }
  if (url.origin !== REGISTRY_ORIGIN || url.hash || url.pathname + url.search !== target) return false;
  const route = REGISTRY_ROUTES.find((r) => r.path.test(url.pathname));
  if (!route) return false;
  const keys = [...url.searchParams.keys()];
  const want = Object.keys(route.query);
  if (keys.length !== want.length || new Set(keys).size !== keys.length) return false;
  if (want.length === 0) return url.search === '';
  for (const k of want) {
    const v = url.searchParams.get(k);
    if (v === null || !route.query[k]!.test(v)) return false;
  }
  return true;
}

const SLOW_TOOLSETS: ReadonlySet<string> = new Set(['page_judge', 'browser_agent']);
export const SLOW_TOOLSET_TIMEOUT_MS = 55_000;

export interface GatewayConfig {
  auth: GatewayAuth;
  bundles: readonly BundleAllowEntry[];
  timeoutMs?: number;
}

export type GatewayCall =
  | { surface: 'decide'; body: GatewayDecideBody }
  | { surface: 'respond'; body: GatewayRespondBody }
  | { surface: 'runTokens'; body: { runId: string } | { chatSessionId: string } }
  | { surface: 'codefToken'; body: Record<string, never> };

/** toCodef() 요청. 토큰은 게이트웨이 /v1/codef/token에서 받은 것, env도 그 응답의 값이다 */
export interface CodefRequest {
  env: CodefEnv;
  path: CodefPath;
  body: object;
  accessToken: string;
}

export interface EgressOptions {
  testOrigins?: Partial<Record<string, string>>;
  timeoutMs?: number;
  codefTimeoutMs?: number;
  modelGuard?: ModelGuardConfig;
  gateway?: GatewayConfig;
  onSecurityEvent?: (e: EgressSecurityEvent) => void;
  env?: NodeJS.ProcessEnv;
  cloudDevLocal?: boolean;
}

/** cloud() 요청. url은 공개 주소 전체(DPoP htu와 같은 값), body는 JSON 문자열(GET·DELETE는 없음) */
export interface CloudRequest {
  method: CloudMethod;
  url: string;
  headers?: Record<string, string>;
  body?: string;
}

/** TLS 신뢰를 바꾸는 환경 변수 이름(N-23). 보이면 모델·odcloud 요청을 보내지 않는다. */
export function tlsEnvTampered(env: NodeJS.ProcessEnv): string[] {
  const out: string[] = [];
  if (env.NODE_EXTRA_CA_CERTS !== undefined) out.push('NODE_EXTRA_CA_CERTS');
  if (env.NODE_TLS_REJECT_UNAUTHORIZED === '0') out.push('NODE_TLS_REJECT_UNAUTHORIZED');
  return out;
}

/** SDK에 넘기는 fetch. toModel()이 발급한 일회 티켓 헤더가 없으면 거부한다. */
export type ProviderFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export type ModelEgressRequest =
  | { surface: 'decide'; dest: 'openai'; path: '/v1/decisions'; gateway: GatewayDecideBody; providerBody: object }
  | { surface: 'respond'; dest: 'openai'; path: '/v1/responses'; gateway: GatewayRespondBody; providerBody: object };

export const TICKET_HEADER = 'x-sax-egress-ticket';
const TICKET_MAX_USES = 3;

interface Ticket {
  dest: keyof typeof DESTINATIONS;
  path: string;
  bodyHash: string;
  uses: number;
}

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

export interface EgressResponse {
  status: number;
  json: unknown;
}

/** 레지스트리 바이트 응답(getRegistryBytes). 304면 body 없음. 본문·ETag는 비신뢰 값이다(검증은 엔진 수용 함수·로더). */
export interface RegistryBytesResponse {
  status: number;
  body?: Uint8Array;
  etag?: string;
}

const ETAG = /^(W\/)?"[\x21\x23-\x7e]{1,124}"$/;

export class EgressError extends Error {
  readonly code: 'destination_not_allowed' | 'path_not_allowed' | 'header_not_allowed' | 'timeout' | 'network' | 'bad_response' | 'egress_env_tampered';
  readonly status?: number;
  constructor(code: EgressError['code'], status?: number) {
    super(code);
    this.code = code;
    this.status = status;
  }
}

export class Egress {
  protected readonly opts: EgressOptions;
  readonly audit: Array<{ dest: string; path: string; status: number | 'error' }> = [];

  readonly modelAudit: Array<{ dest: string; path: string; status: number | 'error'; ms: number; rateLimit: Record<string, string> }> = [];
  readonly guard: ModelGuard | null;
  readonly gatewayGuard: ModelGuard | null;
  readonly securityEvents: EgressSecurityEvent[] = [];
  private readonly tickets = new Map<string, Ticket>();
  readonly envTampered: readonly string[];

  constructor(opts: EgressOptions = {}) {
    this.opts = opts;
    const security = (path: EgressSecurityEvent['path']) => (code: GuardCode, surface: 'decide' | 'respond') => {
      const e: EgressSecurityEvent = { code: `egress.${code}` as EgressSecurityEvent['code'], surface, path };
      this.securityEvents.push(e);
      opts.onSecurityEvent?.(e);
    };
    this.guard = opts.modelGuard ? new ModelGuard({ ...opts.modelGuard, onSecurity: opts.modelGuard.onSecurity ?? security('byok') }) : null;
    this.gatewayGuard = opts.gateway ? new ModelGuard({ bundles: opts.gateway.bundles, onSecurity: security('gateway') }) : null;
    this.envTampered = tlsEnvTampered(opts.env ?? process.env);
  }

  async toGateway(req: GatewayCall): Promise<unknown> {
    if (this.envTampered.length) throw new EgressError('egress_env_tampered');
    const gw = this.opts.gateway;
    if (!gw || !this.gatewayGuard) throw new EgressError('destination_not_allowed');
    if (req.surface === 'decide') this.gatewayGuard.inspect('decide', req.body);
    else if (req.surface === 'respond') this.gatewayGuard.inspect('respond', req.body);
    const path = GATEWAY_PATHS[req.surface];
    if (req.surface === 'runTokens') {
      const scope = req.body as { runId?: unknown; chatSessionId?: unknown };
      const id = Object.keys(scope).length === 1 ? (scope.runId ?? scope.chatSessionId) : undefined;
      if (typeof id !== 'string' || !/^[A-Za-z0-9_.-]{8,64}$/.test(id)) throw new EgressError('path_not_allowed');
    }
    if (req.surface === 'codefToken' && (typeof req.body !== 'object' || req.body === null || Object.keys(req.body).length !== 0)) throw new EgressError('path_not_allowed');
    const body = JSON.stringify(req.body);
    const bodySha256 = sha256(body);
    const timeoutMs = req.surface === 'respond' && SLOW_TOOLSETS.has(req.body.toolset) ? Math.max(gw.timeoutMs ?? 0, SLOW_TOOLSET_TIMEOUT_MS) : gw.timeoutMs;
    try {
      return await this.gatewayOnce(gw, path, body, bodySha256, timeoutMs);
    } catch (e) {
      if (!(e instanceof GatewayError) || e.code !== 'gateway.unauthorized' || !gw.auth.invalidate) throw e;
      gw.auth.invalidate();
      return await this.gatewayOnce(gw, path, body, bodySha256, timeoutMs);
    }
  }

  private async gatewayOnce(gw: GatewayConfig, path: string, body: string, bodySha256: string, timeoutMs = gw.timeoutMs): Promise<unknown> {
    const auth = await gw.auth.headers({ method: 'POST', url: GATEWAY_ORIGIN + path, bodySha256 });
    const origin = this.opts.testOrigins?.gateway ?? GATEWAY_ORIGIN;
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs ?? 20_000);
    const started = performance.now();
    try {
      const res = await fetch(origin + path, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json', ...auth },
        body,
        signal: ctl.signal,
        redirect: 'error',
      });
      this.modelAudit.push({ dest: 'gateway', path, status: res.status, ms: performance.now() - started, rateLimit: {} });
      const text = await res.text();
      let json: unknown = null;
      try {
        json = text ? JSON.parse(text) : null;
      } catch {
        throw new GatewayError(res.ok ? 'gateway.bad_response' : 'gateway.unavailable', res.status);
      }
      if (!res.ok) throw gatewayErrorOf(res.status, json);
      return json;
    } catch (e) {
      if (e instanceof GatewayError) throw e;
      this.modelAudit.push({ dest: 'gateway', path, status: 'error', ms: performance.now() - started, rateLimit: {} });
      throw new GatewayError((e as Error).name === 'AbortError' ? 'gateway.timeout' : 'gateway.unavailable');
    } finally {
      clearTimeout(timer);
    }
  }

  async toModel<T>(req: ModelEgressRequest, send: (headers: Record<string, string>) => Promise<T>): Promise<T> {
    if (this.envTampered.length) throw new EgressError('egress_env_tampered');
    if (!this.guard) throw new EgressError('destination_not_allowed');
    if (req.surface === 'decide') this.guard.check('decide', req.gateway, req.providerBody);
    else this.guard.check('respond', req.gateway, req.providerBody);
    const d = DESTINATIONS[req.dest] as Destination;
    if (!d.paths.includes(req.path)) throw new EgressError('path_not_allowed');
    const id = randomUUID();
    this.tickets.set(id, { dest: req.dest, path: req.path, bodyHash: sha256(JSON.stringify(req.providerBody)), uses: 0 });
    try {
      return await send({ [TICKET_HEADER]: id });
    } finally {
      this.tickets.delete(id);
    }
  }

  readonly providerFetch: ProviderFetch = async (input, init = {}) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    const headers = new Headers(init.headers);
    const id = headers.get(TICKET_HEADER);
    headers.delete(TICKET_HEADER);
    const t = id ? this.tickets.get(id) : undefined;
    if (!t) throw new EgressError('destination_not_allowed');
    if (this.envTampered.length) throw new EgressError('egress_env_tampered');
    const d = DESTINATIONS[t.dest] as Destination;
    if (url.origin !== d.origin) throw new EgressError('destination_not_allowed');
    if (url.pathname !== t.path || url.search) throw new EgressError('path_not_allowed');
    if (typeof init.body !== 'string' || sha256(init.body) !== t.bodyHash) throw new EgressError('path_not_allowed');
    if (++t.uses > TICKET_MAX_USES) throw new EgressError('path_not_allowed');
    const origin = this.opts.testOrigins?.[t.dest] ?? d.origin;
    const started = performance.now();
    try {
      const res = await fetch(origin + t.path, { ...init, headers, redirect: 'error' });
      const rateLimit: Record<string, string> = {};
      res.headers.forEach((v, k) => {
        if (k.startsWith('x-ratelimit-') || k === 'retry-after' || k === 'retry-after-ms') rateLimit[k] = v;
      });
      this.modelAudit.push({ dest: t.dest, path: t.path, status: res.status, ms: performance.now() - started, rateLimit });
      return res;
    } catch (e) {
      this.modelAudit.push({ dest: t.dest, path: t.path, status: 'error', ms: performance.now() - started, rateLimit: {} });
      throw e;
    }
  };

  protected destinationOf(dest: string): Destination | undefined {
    return Object.hasOwn(DESTINATIONS, dest) ? (DESTINATIONS[dest as DestinationName] as Destination) : undefined;
  }

  async getRegistry(target: string): Promise<EgressResponse> {
    if (!registryTargetAllowed(target)) throw new EgressError('path_not_allowed');
    if (this.envTampered.length) throw new EgressError('egress_env_tampered');
    const path = new URL(target, REGISTRY_ORIGIN).pathname;
    const origin = this.opts.testOrigins?.registry ?? REGISTRY_ORIGIN;
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), this.opts.timeoutMs ?? 10_000);
    try {
      const res = await fetch(origin + target, { method: 'GET', headers: { accept: 'application/json' }, signal: ctl.signal, redirect: 'error' });
      this.audit.push({ dest: 'registry', path, status: res.status });
      const len = Number(res.headers.get('content-length') ?? '0');
      if (len > REGISTRY_MAX_BYTES) {
        await res.body?.cancel();
        throw new EgressError('bad_response', res.status);
      }
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length > REGISTRY_MAX_BYTES) throw new EgressError('bad_response', res.status);
      let json: unknown = null;
      try {
        json = buf.length ? JSON.parse(buf.toString('utf8')) : null;
      } catch {
        if (res.ok) throw new EgressError('bad_response', res.status);
      }
      return { status: res.status, json };
    } catch (e) {
      if (e instanceof EgressError) throw e;
      this.audit.push({ dest: 'registry', path, status: 'error' });
      throw new EgressError((e as Error).name === 'AbortError' ? 'timeout' : 'network');
    } finally {
      clearTimeout(timer);
    }
  }

  async getRegistryBytes(target: string, o: { etag?: string } = {}): Promise<RegistryBytesResponse> {
    if (!registryTargetAllowed(target)) throw new EgressError('path_not_allowed');
    if (this.envTampered.length) throw new EgressError('egress_env_tampered');
    const path = new URL(target, REGISTRY_ORIGIN).pathname;
    const max = PACKAGE_PATH.test(path) ? REGISTRY_PACKAGE_MAX_BYTES : REGISTRY_MAX_BYTES;
    const origin = this.opts.testOrigins?.registry ?? REGISTRY_ORIGIN;
    const headers: Record<string, string> = { accept: PACKAGE_PATH.test(path) ? 'application/octet-stream' : 'application/json' };
    if (typeof o.etag === 'string' && ETAG.test(o.etag)) headers['if-none-match'] = o.etag;
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), this.opts.timeoutMs ?? (max === REGISTRY_MAX_BYTES ? 10_000 : 60_000));
    try {
      const res = await fetch(origin + target, { method: 'GET', headers, signal: ctl.signal, redirect: 'error' });
      this.audit.push({ dest: 'registry', path, status: res.status });
      const tag = res.headers.get('etag');
      const etag = tag && ETAG.test(tag) ? tag : undefined;
      if (res.status !== 200) {
        await res.body?.cancel();
        return { status: res.status, ...(etag && res.status === 304 ? { etag } : {}) };
      }
      const len = Number(res.headers.get('content-length') ?? '0');
      if (len > max) {
        await res.body?.cancel();
        throw new EgressError('bad_response', res.status);
      }
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length > max) throw new EgressError('bad_response', res.status);
      return { status: 200, body: new Uint8Array(buf), ...(etag ? { etag } : {}) };
    } catch (e) {
      if (e instanceof EgressError) throw e;
      this.audit.push({ dest: 'registry', path, status: 'error' });
      throw new EgressError((e as Error).name === 'AbortError' ? 'timeout' : 'network');
    } finally {
      clearTimeout(timer);
    }
  }

  async cloud(req: CloudRequest): Promise<EgressResponse> {
    const check = cloudRequestCheck(req.method, req.url);
    if (check === 'origin') throw new EgressError('destination_not_allowed');
    if (check === 'path') throw new EgressError('path_not_allowed');
    if (check.kind === 'dev' && !this.opts.cloudDevLocal) throw new EgressError('destination_not_allowed');
    const headers = cloudHeaders(req.headers);
    if (!headers) throw new EgressError('header_not_allowed');
    const hasBody = req.method === 'POST' || req.method === 'PUT';
    if (hasBody !== (req.body !== undefined)) throw new EgressError('path_not_allowed');
    if (req.body !== undefined) {
      if (typeof req.body !== 'string' || Buffer.byteLength(req.body) > CLOUD_MAX_BODY) throw new EgressError('path_not_allowed');
      try {
        JSON.parse(req.body);
      } catch {
        throw new EgressError('path_not_allowed');
      }
    }
    if (this.envTampered.length) throw new EgressError('egress_env_tampered');
    const u = new URL(req.url);
    const target = check.kind === 'prod' && this.opts.testOrigins?.cloud ? this.opts.testOrigins.cloud + u.pathname : req.url;
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), this.opts.timeoutMs ?? 10_000);
    try {
      const res = await fetch(target, {
        method: req.method,
        headers: { accept: 'application/json', ...(req.body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
        body: req.body,
        signal: ctl.signal,
        redirect: 'error',
      });
      this.audit.push({ dest: 'cloud', path: check.route, status: res.status });
      const maxBytes = cloudMaxBytes(check.route);
      if (Number(res.headers.get('content-length') ?? '0') > maxBytes) {
        await res.body?.cancel();
        throw new EgressError('bad_response', res.status);
      }
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length > maxBytes) throw new EgressError('bad_response', res.status);
      let json: unknown = null;
      try {
        json = buf.length ? JSON.parse(buf.toString('utf8')) : null;
      } catch {
        if (res.ok) throw new EgressError('bad_response', res.status);
      }
      return { status: res.status, json };
    } catch (e) {
      if (e instanceof EgressError) throw e;
      this.audit.push({ dest: 'cloud', path: check.route, status: 'error' });
      throw new EgressError((e as Error).name === 'AbortError' ? 'timeout' : 'network');
    } finally {
      clearTimeout(timer);
    }
  }

  openCloudSocket(url: string, headers?: Record<string, string>): WebSocket {
    const check = cloudSocketCheck(url);
    if (!check) throw new EgressError('path_not_allowed');
    if (check.kind === 'dev' && !this.opts.cloudDevLocal) throw new EgressError('destination_not_allowed');
    const h = cloudHeaders(headers);
    if (!h) throw new EgressError('header_not_allowed');
    if (this.envTampered.length) throw new EgressError('egress_env_tampered');
    const target = check.kind === 'prod' && this.opts.testOrigins?.cloudWs ? this.opts.testOrigins.cloudWs + new URL(url).pathname : url;
    this.audit.push({ dest: 'cloud.ws', path: check.route, status: 101 });
    return new WebSocket(target, (Object.keys(h).length ? { headers: h } : undefined) as never);
  }

  async toCodef(req: CodefRequest): Promise<EgressResponse> {
    if (!isCodefEnv(req.env)) throw new EgressError('destination_not_allowed');
    if (!isCodefPath(req.path)) throw new EgressError('path_not_allowed');
    if (typeof req.accessToken !== 'string' || !CODEF_TOKEN_RE.test(req.accessToken)) throw new EgressError('header_not_allowed');
    if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) throw new EgressError('path_not_allowed');
    const body = encodeCodefBody(req.body);
    if (Buffer.byteLength(body) > CODEF_MAX_BODY) throw new EgressError('path_not_allowed');
    if (this.envTampered.length) throw new EgressError('egress_env_tampered');
    const origin = this.opts.testOrigins?.codef ?? CODEF_ORIGINS[req.env];
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), this.opts.codefTimeoutMs ?? CODEF_TIMEOUT_MS);
    try {
      const res = await fetch(origin + req.path, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json', authorization: `Bearer ${req.accessToken}` },
        body,
        signal: ctl.signal,
        redirect: 'error',
      });
      this.audit.push({ dest: 'codef', path: req.path, status: res.status });
      if (Number(res.headers.get('content-length') ?? '0') > CODEF_MAX_BYTES) {
        await res.body?.cancel();
        throw new EgressError('bad_response', res.status);
      }
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length > CODEF_MAX_BYTES) throw new EgressError('bad_response', res.status);
      const json = decodeCodefBody(buf.toString('utf8'));
      if (json === null && res.ok) throw new EgressError('bad_response', res.status);
      return { status: res.status, json };
    } catch (e) {
      if (e instanceof EgressError) throw e;
      this.audit.push({ dest: 'codef', path: req.path, status: 'error' });
      throw new EgressError((e as Error).name === 'AbortError' ? 'timeout' : 'network');
    } finally {
      clearTimeout(timer);
    }
  }

  async postJson(dest: DestinationName, path: string, body: unknown, headers: Record<string, string> = {}): Promise<EgressResponse> {
    const d = this.destinationOf(dest);
    if (!d) throw new EgressError('destination_not_allowed');
    if (!d.paths.includes(path)) throw new EgressError('path_not_allowed');
    if (this.envTampered.length) throw new EgressError('egress_env_tampered');
    const origin = this.opts.testOrigins?.[dest] ?? d.origin;
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), this.opts.timeoutMs ?? 10_000);
    try {
      const res = await fetch(origin + path, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json', ...headers },
        body: JSON.stringify(body),
        signal: ctl.signal,
        redirect: 'error',
      });
      this.audit.push({ dest, path, status: res.status });
      const text = await res.text();
      let json: unknown = null;
      try {
        json = text ? JSON.parse(text) : null;
      } catch {
        if (res.ok) throw new EgressError('bad_response', res.status);
      }
      return { status: res.status, json };
    } catch (e) {
      if (e instanceof EgressError) throw e;
      this.audit.push({ dest, path, status: 'error' });
      throw new EgressError((e as Error).name === 'AbortError' ? 'timeout' : 'network');
    } finally {
      clearTimeout(timer);
    }
  }
}
