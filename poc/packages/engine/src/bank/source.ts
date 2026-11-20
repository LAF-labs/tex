
export type TxnSourceKind = 'file' | 'auto';

/** 계좌의 원천 연결 상태: 파일만 / 자동 연결됨 / 자동 오류 */
export type SourceLinkState = 'file_only' | 'auto_connected' | 'auto_error';

/** 원천에 넘기는 계좌. number는 계좌번호 전체(숫자만): 자동 조회 요청에 필요하다. 로그·이벤트에 쓰지 않는다. 로그인 정보(connectedId 등)는 원천이 금고에서 따로 갖는다 */
export interface SourceAccount {
  id: string;
  profileId: string;
  bank: string;
  number: string;
  last4: string;
}

/** 'YYYY-MM-DD'부터 'YYYY-MM-DD'까지(양끝 포함, 한국 날짜) */
export interface SourceRange {
  from: string;
  to: string;
}

/** 원천이 돌려주는 거래 행 하나 */
export interface SourceRow {
  sourceId: string | null;
  occurredAt: string;
  deposit: number;
  withdrawal: number;
  balance: number | null;
  remarks: Array<string | null>;
  memo: string | null;
  payer?: string | null;
}

export type SourceProgress =
  | { state: 'requested'; jobs?: number }
  | { state: 'waiting' | 'running'; done?: number; jobs?: number }
  | { state: 'done'; rows: number }
  | { state: 'failed'; code: string };

export interface SourceFetchResult {
  rows: SourceRow[];
  range: SourceRange;
}

export interface TxnSource {
  readonly kind: 'auto';
  readonly provider: string;
  fetch(account: SourceAccount, range: SourceRange, opts: { onProgress?: (p: SourceProgress) => void; signal?: AbortSignal }): Promise<SourceFetchResult>;
}

/**
 * 원천 실패. code는 짧은 코드(예: source.not_linked, source.login_failed, source.cert_expired, source.unsupported_bank, source.rate_limited, source.needs_user). 메시지에 값을 넣지 않는다.
 * source.too_soon은 실패가 아니라 "방금 가져왔다"이다: 원천을 부르지 않았고, retryAt(ISO) 뒤에 다시 가져올 수 있다.
 * source.daily_limit도 실패가 아니라 "오늘은 다 가져왔다"이다(원천의 하루 상한). 둘 다 연결 상태를 오류로 바꾸지 않는다.
 */
export class SourceError extends Error {
  readonly code: string;
  readonly retryAt: string | null;
  constructor(code: string, retryAt: string | null = null) {
    super(code);
    this.code = code;
    this.retryAt = retryAt;
  }
}
