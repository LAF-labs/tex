// 거래내역 원천(09 §3.2, 대표 결정 2026-11-12): 파일 | 자동 연결(지금 구현: CODEF 공동인증서 로그인, 세션 codef-link).
// 원천 이름을 화면·상태 값에 박지 않는다: 종류는 file | auto, 자동 연결의 공급자는 provider 문자열(예: 'codef')로만 둔다.
// 원천은 (계좌, 기간)을 받아 거래 행 목록을 돌려준다. 수집이 비동기(요청 → 상태 조회 → 결과)일 수 있어 진행 상태를 onProgress로 낸다.
// 행마다 원천 고유 id(공급자가 주는 거래 고유번호, 없으면 null)가 있으면 그것으로 중복을 거른다(없으면 일시·방향·금액·잔액·입금자 + 순번 줄 열쇠).
// 원천이 실패해도 이미 들인 행과 파일 원천은 그대로다(실패는 그 계좌의 연결 상태 'error'와 코드로만 남는다).
// 원천 구현은 엔진 프로세스 안에서 BankService.registerSource로 꽂는다(파일 원천은 main이 docparse로 읽어 bank.importTxns로 넣으므로 여기 구현이 없다).

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
  /** 원천 고유 id(공급자 거래 고유번호). 있으면 이것으로 중복 제거(같은 공급자 안에서). 없으면 null(줄 열쇠로 거른다) */
  sourceId: string | null;
  /** 'YYYY-MM-DD' | 'YYYY-MM-DD HH:MM' | 'YYYY-MM-DD HH:MM:SS' */
  occurredAt: string;
  /** 입금액(원, 없으면 0) */
  deposit: number;
  /** 출금액(원, 없으면 0) */
  withdrawal: number;
  balance: number | null;
  /** 적요 칸들(공급자 비고 칸 순서 그대로, 예: CODEF resAccountDesc1~4). 은행마다 입금자명 칸이 다르다 */
  remarks: Array<string | null>;
  /** 원천 쪽 메모(있으면) */
  memo: string | null;
  /** 원천이 입금자명 칸을 안다면 그 값(은행별 칸 지도). 없으면 remarks의 첫 비지 않은 칸을 입금자로 본다 */
  payer?: string | null;
}

export type SourceProgress =
  | { state: 'requested'; jobs?: number }
  | { state: 'waiting' | 'running'; done?: number; jobs?: number }
  | { state: 'done'; rows: number }
  | { state: 'failed'; code: string };

export interface SourceFetchResult {
  rows: SourceRow[];
  /** 실제로 조회한 기간(원천이 줄였으면 줄인 기간) */
  range: SourceRange;
}

export interface TxnSource {
  readonly kind: 'auto';
  /** 공급자 이름(기록용, 예: 'codef'). 화면에는 쓰지 않는다 */
  readonly provider: string;
  /** 거래 행 수집. 실패는 SourceError(code)로 던진다. signal이 끊기면 멈춘다 */
  fetch(account: SourceAccount, range: SourceRange, opts: { onProgress?: (p: SourceProgress) => void; signal?: AbortSignal }): Promise<SourceFetchResult>;
}

/** 원천 실패. code는 짧은 코드(예: source.not_linked, source.login_failed, source.cert_expired, source.unsupported_bank, source.rate_limited, source.needs_user). 메시지에 값을 넣지 않는다 */
export class SourceError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(code);
    this.code = code;
  }
}
