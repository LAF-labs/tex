// 사업자등록 진위확인 프록시(D09 §4.1, C-25, D-51(N-81)). 공공데이터포털 국세청 사업자등록정보 API(status).
// 번호는 메모리로만 통과한다. 계정과 묶지 않고, 로그·DB·메트릭에 쓰지 않는다. 서비스 키는 환경 변수(ENV.md).

export interface BizStatus {
  b_no: string;
  /** 01 계속, 02 휴업, 03 폐업, '' 미등록 */
  b_stt_cd: string;
  /** 과세 유형 코드 */
  tax_type_cd: string;
  /** 폐업일 YYYYMMDD 또는 '' */
  end_dt: string;
}

export interface BizStatusSource {
  status(bNos: string[]): Promise<BizStatus[]>;
}

export class NtsUnavailable extends Error {}

const str = (v: unknown) => (typeof v === 'string' ? v.replace(/[^0-9A-Za-z]/g, '').slice(0, 16) : '');

/** 공공데이터포털 nts-businessman/v1/status. 응답에서 정해진 필드만 골라 돌려준다(공급처의 다른 필드를 흘리지 않는다). */
export class OdcloudNtsSource implements BizStatusSource {
  private readonly o: { serviceKey: string; baseUrl: string; fetchFn: typeof fetch; timeoutMs: number };
  constructor(o: { serviceKey: string; baseUrl?: string; fetchFn?: typeof fetch; timeoutMs?: number }) {
    this.o = { serviceKey: o.serviceKey, baseUrl: o.baseUrl ?? 'https://api.odcloud.kr/api/nts-businessman/v1', fetchFn: o.fetchFn ?? fetch, timeoutMs: o.timeoutMs ?? 10_000 };
  }
  async status(bNos: string[]): Promise<BizStatus[]> {
    let res: Response;
    try {
      res = await this.o.fetchFn(`${this.o.baseUrl}/status?serviceKey=${encodeURIComponent(this.o.serviceKey)}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ b_no: bNos }),
        redirect: 'error',
        signal: AbortSignal.timeout(this.o.timeoutMs),
      });
    } catch {
      throw new NtsUnavailable();
    }
    if (res.status !== 200) throw new NtsUnavailable();
    const d = (await res.json().catch(() => null)) as { data?: Array<Record<string, unknown>> } | null;
    if (!d || !Array.isArray(d.data)) throw new NtsUnavailable();
    return d.data.map((x) => ({ b_no: str(x.b_no), b_stt_cd: str(x.b_stt_cd), tax_type_cd: str(x.tax_type_cd), end_dt: str(x.end_dt) }));
  }
}

/** 모의 원천: 끝자리 0이면 폐업, 9이면 미등록, 나머지 계속. 받은 번호를 어디에도 남기지 않는다(호출 수만). */
export class MockNtsSource implements BizStatusSource {
  calls = 0;
  status(bNos: string[]): Promise<BizStatus[]> {
    this.calls++;
    return Promise.resolve(
      bNos.map((b) => (b.endsWith('9') ? { b_no: b, b_stt_cd: '', tax_type_cd: '', end_dt: '' } : b.endsWith('0') ? { b_no: b, b_stt_cd: '03', tax_type_cd: '01', end_dt: '20260101' } : { b_no: b, b_stt_cd: '01', tax_type_cd: '01', end_dt: '' })),
    );
  }
}
