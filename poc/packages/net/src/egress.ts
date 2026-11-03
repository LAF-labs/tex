// 엔진의 단일 송신 모듈(D01 §3 TB-2 → TB-4/5). 목적지는 내장 허용 목록만, 경로도 고정한다.
// PoC 범위: 공공데이터포털 국세청 사업자등록정보(H-05, 사용자 자기 키 D09 §4.1 (b)),
// 모델 공급사 직결(BYOK, D04 §8). 모델 송신은 toModel()의 로컬 검사 4종을 통과한 요청만 나간다.
import { createHash, randomUUID } from 'node:crypto';
import { ModelGuard, type GatewayDecideBody, type GatewayRespondBody, type ModelGuardConfig } from './model-guard.ts';

export interface Destination {
  origin: string;
  paths: string[];
}

export const DESTINATIONS = {
  odcloud: { origin: 'https://api.odcloud.kr', paths: ['/api/nts-businessman/v1/status', '/api/nts-businessman/v1/validate'] },
  openai: { origin: 'https://api.openai.com', paths: ['/v1/decisions', '/v1/responses'] },
} as const satisfies Record<string, Destination>;

/**
 * 시연 전용 목적지(SAX_DEMO_MODEL=openrouter, fixture 모드만). 클라이언트가 공급사 키를 들고 직접 부르는 D04 예외라
 * EgressOptions.demoModel이 켜진 Egress에서만 열린다. 근거·범위: reports/demo-meeting.md §예외.
 */
export const DEMO_DESTINATIONS = {
  openrouter: { origin: 'https://openrouter.ai', paths: ['/api/v1/chat/completions'] },
} as const satisfies Record<string, Destination>;

export type DestinationName = keyof typeof DESTINATIONS | keyof typeof DEMO_DESTINATIONS;

export interface EgressOptions {
  /** 테스트 전용: 목적지 origin을 로컬 모의 서버로 바꾼다. 앱 진입점은 쓰지 않는다. */
  testOrigins?: Partial<Record<DestinationName, string>>;
  timeoutMs?: number;
  /** 모델 송신 검사 설정. 없으면 toModel()은 항상 거부한다. */
  modelGuard?: ModelGuardConfig;
  /** 시험용: process.env 대신 볼 환경. */
  env?: NodeJS.ProcessEnv;
  /** 시연 전용 목적지(DEMO_DESTINATIONS)를 postJson에 연다. 앱 진입점은 fixture 모드 시연 플래그일 때만 켠다. */
  demoModel?: boolean;
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
/** 어댑터 재시도(최초 1 + 재시도 2, D04 §1)까지 같은 티켓을 쓴다. */
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

export class EgressError extends Error {
  readonly code: 'destination_not_allowed' | 'path_not_allowed' | 'timeout' | 'network' | 'bad_response' | 'egress_env_tampered';
  readonly status?: number;
  constructor(code: EgressError['code'], status?: number) {
    super(code);
    this.code = code;
    this.status = status;
  }
}

export class Egress {
  private readonly opts: EgressOptions;
  /** 진단용: 목적지·경로·상태코드만(본문·헤더 없음). */
  readonly audit: Array<{ dest: string; path: string; status: number | 'error' }> = [];

  /** 모델 송신 진단: 목적지·경로·상태·지연·레이트 리밋 헤더만(본문 없음). */
  readonly modelAudit: Array<{ dest: string; path: string; status: number | 'error'; ms: number; rateLimit: Record<string, string> }> = [];
  readonly guard: ModelGuard | null;
  private readonly tickets = new Map<string, Ticket>();
  /** egress.env_tampered: 생성 때 본 TLS 변조 변수 이름(값 없음). 비어 있지 않으면 모든 송신을 거부한다. */
  readonly envTampered: readonly string[];

  constructor(opts: EgressOptions = {}) {
    this.opts = opts;
    this.guard = opts.modelGuard ? new ModelGuard(opts.modelGuard) : null;
    this.envTampered = tlsEnvTampered(opts.env ?? process.env);
  }

  /**
   * 모델 호출의 유일한 입구. 검사 4종(model-guard.ts)을 통과하면 이 본문에만 쓸 수 있는 티켓을 발급하고
   * send(티켓 헤더)를 실행한다. send 안의 SDK 호출은 providerFetch로만 나간다.
   */
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

  /** OpenAI SDK의 fetch 옵션으로 넘긴다. 티켓의 목적지·경로·본문 해시가 모두 맞아야 나간다. */
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

  async postJson(dest: DestinationName, path: string, body: unknown, headers: Record<string, string> = {}): Promise<EgressResponse> {
    const d = (Object.hasOwn(DESTINATIONS, dest) ? DESTINATIONS[dest as keyof typeof DESTINATIONS] : this.opts.demoModel && Object.hasOwn(DEMO_DESTINATIONS, dest) ? DEMO_DESTINATIONS[dest as keyof typeof DEMO_DESTINATIONS] : undefined) as Destination | undefined;
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
