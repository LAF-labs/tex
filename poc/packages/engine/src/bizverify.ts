import { EgressError, type Egress } from '@sax/net';

// H-05 사업자등록 상태조회·진위확인(공공데이터포털 국세청 API). 사용자 자기 서비스 키(D09 §4.1 (b)).
// PoC는 비밀을 저장하지 않으므로 키는 실행 중 메모리에만 둔다(D05 §2 BYOK: egress 메모리, 엔진 안).
// 키는 쿼리스트링이 아니라 Authorization 헤더(Infuser)로 보낸다(URL·접근 로그에 키가 남지 않게).

export interface BizStatus {
  bizNo: string;
  /** 01 계속, 02 휴업, 03 폐업, '' 미등록 */
  statusCode: '01' | '02' | '03' | '';
  status: string;
  taxType: string;
  closedAt: string | null;
}

export interface ValidateInput {
  bizNo: string;
  /** 개업일자 YYYYMMDD */
  startDate: string;
  /** 대표자 성명 */
  repName: string;
  /** 상호(선택) */
  name?: string;
}

export interface ValidateResult {
  bizNo: string;
  valid: boolean;
  /** 01 확인, 02 불일치 */
  validCode: string;
  message: string | null;
  status: BizStatus | null;
}

export class BizVerifyError extends Error {
  readonly code: 'no_key' | 'unauthorized' | 'quota' | 'upstream' | 'network' | 'bad_request';
  constructor(code: BizVerifyError['code']) {
    super(code);
    this.code = code;
  }
}

type Json = Record<string, unknown>;

const toStatus = (r: Json): BizStatus => ({
  bizNo: String(r.b_no ?? ''),
  statusCode: String(r.b_stt_cd ?? '') as BizStatus['statusCode'],
  status: String(r.b_stt ?? ''),
  taxType: String(r.tax_type ?? ''),
  closedAt: r.end_dt ? String(r.end_dt) : null,
});

export class BizVerifier {
  private readonly egress: Egress;
  private key: string | null = null;

  constructor(egress: Egress) {
    this.egress = egress;
  }

  setServiceKey(key: string | null): void {
    this.key = key && key.trim() ? key.trim() : null;
  }

  get hasKey(): boolean {
    return this.key !== null;
  }

  private headers(): Record<string, string> {
    if (!this.key) throw new BizVerifyError('no_key');
    return { authorization: `Infuser ${this.key}` };
  }

  private async call(path: '/api/nts-businessman/v1/status' | '/api/nts-businessman/v1/validate', body: Json): Promise<Json[]> {
    let res;
    try {
      res = await this.egress.postJson('odcloud', path, body, this.headers());
    } catch (e) {
      if (e instanceof BizVerifyError) throw e;
      throw new BizVerifyError(e instanceof EgressError && e.code === 'bad_response' ? 'upstream' : 'network');
    }
    if (res.status === 401 || res.status === 403) throw new BizVerifyError('unauthorized');
    if (res.status === 429) throw new BizVerifyError('quota');
    if (res.status === 400 || res.status === 413) throw new BizVerifyError('bad_request');
    if (res.status !== 200) throw new BizVerifyError('upstream');
    const data = (res.json as Json | null)?.data;
    if (!Array.isArray(data)) throw new BizVerifyError('upstream');
    return data as Json[];
  }

  /** 상태조회(요청당 최대 100건, 게이트웨이 경로는 ≤10이지만 자기 키는 포털 한도를 따른다). */
  async status(bizNos: string[]): Promise<BizStatus[]> {
    const b_no = bizNos.map((b) => b.replace(/\D/g, ''));
    if (b_no.length === 0 || b_no.length > 100) throw new BizVerifyError('bad_request');
    return (await this.call('/api/nts-businessman/v1/status', { b_no })).map(toStatus);
  }

  /** 진위확인. */
  async validate(input: ValidateInput): Promise<ValidateResult> {
    const business = [{
      b_no: input.bizNo.replace(/\D/g, ''),
      start_dt: input.startDate.replace(/\D/g, ''),
      p_nm: input.repName.trim(),
      ...(input.name ? { b_nm: input.name.trim() } : {}),
    }];
    const [r] = await this.call('/api/nts-businessman/v1/validate', { businesses: business });
    if (!r) throw new BizVerifyError('upstream');
    return {
      bizNo: String(r.b_no ?? business[0]!.b_no),
      valid: r.valid === '01',
      validCode: String(r.valid ?? ''),
      message: r.valid_msg ? String(r.valid_msg) : null,
      status: r.status ? toStatus(r.status as Json) : null,
    };
  }
}
