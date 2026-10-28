// 엔진의 단일 송신 모듈(D01 §3 TB-2 → TB-4/5). 목적지는 내장 허용 목록만, 경로도 고정한다.
// PoC 범위: 공공데이터포털 국세청 사업자등록정보(H-05, 사용자 자기 키 D09 §4.1 (b)).

export interface Destination {
  origin: string;
  paths: string[];
}

export const DESTINATIONS = {
  odcloud: { origin: 'https://api.odcloud.kr', paths: ['/api/nts-businessman/v1/status', '/api/nts-businessman/v1/validate'] },
} as const satisfies Record<string, Destination>;

export type DestinationName = keyof typeof DESTINATIONS;

export interface EgressOptions {
  /** 테스트 전용: 목적지 origin을 로컬 모의 서버로 바꾼다. 앱 진입점은 쓰지 않는다. */
  testOrigins?: Partial<Record<DestinationName, string>>;
  timeoutMs?: number;
}

export interface EgressResponse {
  status: number;
  json: unknown;
}

export class EgressError extends Error {
  readonly code: 'destination_not_allowed' | 'path_not_allowed' | 'timeout' | 'network' | 'bad_response';
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

  constructor(opts: EgressOptions = {}) {
    this.opts = opts;
  }

  async postJson(dest: DestinationName, path: string, body: unknown, headers: Record<string, string> = {}): Promise<EgressResponse> {
    const d = DESTINATIONS[dest] as Destination | undefined;
    if (!d) throw new EgressError('destination_not_allowed');
    if (!d.paths.includes(path)) throw new EgressError('path_not_allowed');
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
