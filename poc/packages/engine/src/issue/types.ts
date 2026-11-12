// 발급 사다리 계약(D03 §4.2, 대표 지시 2026-11-12 "가장 빠르고 싼 길부터, 마지막에 연결된 API").
// 사다리는 칸이 끝날 때마다 실행의 자기 보고가 아니라 원장(같은 발급 키의 행)으로 다음 길을 정한다.
import type { LedgerRow, LedgerState } from '@sax/db';

/** 경로 id. 표의 순서가 사다리 순서다(routes.ts ROUTES). API 칸은 하나이고 칸 안에서 원천(팝빌·CODEF)을 고른다(부장 조정 2026-11-12). */
export type RouteId = 'hometax.auto' | 'hometax.manual' | 'api';

/** API 칸의 원천. 팝빌이 연결돼 있으면 팝빌, 아니면 CODEF. 원천 사이 넘어가기는 없다. */
export type ApiProvider = 'popbill' | 'codef';

export interface RouteSpec {
  id: RouteId;
  kind: 'portal' | 'human' | 'api';
  /** 건당 비용(원). null = 미확인. 0 = 무료. */
  costKrw: number | null;
  costBasis: string;
  /** 사람이 읽는 속도 근거(측정·추정 표시 포함). */
  speed: string;
  ownerDoes: string;
  needs: readonly string[];
}

/** 같은 건 식별 키. 사장님이 초안을 확정할 때 한 번 만든 ULID(26자 Crockford). parseIssueKey로만 만든다. */
export type IssueKey = string & { readonly __issueKey: true };

const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/;
export function parseIssueKey(v: unknown): IssueKey | null {
  return typeof v === 'string' && ULID.test(v) ? (v as IssueKey) : null;
}

/** 사다리가 받는 발급 요청(RunService.start와 같은 초안 값 + 발급 키). */
export interface IssueRequest {
  issueKey: IssueKey;
  counterpartyId: string;
  supply: number;
  tax: number;
  itemName: string;
  email?: string | null;
}

/** 칸 하나가 끝난 모양. 발급 여부는 담지 않는다(사다리가 원장으로 본다). */
export interface AttemptEnd {
  code?: string;
  /** 멈춘 스텝 id(홈택스 칸). 발급 화면 이후 사람 대기 시간 초과를 가른다. */
  stoppedAtStep?: string;
}

/** 다음 길로 가도 되는 실패(fallthrough)와 안 되는 실패(stop). routes.ts END_BRANCH 표 하나가 정한다. */
export type Branch = 'fallthrough' | 'stop';

declare const VERDICT: unique symbol;
/**
 * 칸이 끝난 뒤의 판정. verdict.ts verdictOf만 만든다(모듈 밖에서 만들 수 없다).
 * - issued: 같은 키에 committed 행이 있다.
 * - held: 같은 키에 미종결 행이 있다(발급목록 대조·증언 전까지 다음 길 없음).
 * - not_issued: 행이 없거나 모두 not_committed. branch가 다음 길 여부다.
 */
export type Verdict = { readonly [VERDICT]: true } & (
  | { kind: 'issued'; route: RouteId | null; ref: string | null }
  | { kind: 'held'; state: Exclude<LedgerState, 'committed' | 'not_committed'> }
  | { kind: 'not_issued'; branch: Branch; code: string }
);

export type Fallthrough = Extract<Verdict, { kind: 'not_issued' }> & { branch: 'fallthrough' };

declare const CONSENT: unique symbol;
/** 유료 칸의 동의 근거. ladder.ts만 만든다(사장님 [동의하고 발급] 뒤). 그 키·그 칸에 한 번. reqId는 게이트 표에 approved로 남아 원장 무장이 소비한다. */
export type ConsentToken = { readonly [CONSENT]: true; issueKey: IssueKey; route: RouteId; reqId: string };

export interface ConsentCard {
  issueKey: IssueKey;
  route: RouteId;
  /** 고른 원천(API 칸). */
  provider: ApiProvider | null;
  costKrw: number | null;
  costBasis: string;
  /** 앞 칸이 끝난 코드(사장님 문구는 화면이 고른다). */
  reasonCode: string;
  /** 원장으로 확인했다: 이 키로 발급된 것도, 결과를 모르는 것도 없다. */
  nothingIssued: true;
}

/** 칸이 사다리에 묻는 것. 사다리가 사장님 답을 기다린다. */
export interface RungIo {
  /** 홈택스 직접 칸: [발급했어요] = issued, [못 해요] = cannot. */
  askHuman(): Promise<'issued' | 'cannot'>;
  journal(type: string, payload?: Record<string, string | number | boolean>): void;
}

export interface Rung {
  readonly route: RouteSpec;
  /** 연결이 없으면 건너뛴다(code api.not_connected 등). 건너뛴 칸은 원장 행을 만들지 않는다. */
  available(): { ok: true } | { ok: false; code: string };
  /** 유료 칸의 동의 카드 값(고른 원천과 그 요금). 없으면 경로 표의 값을 쓴다. */
  quote?(): { provider: ApiProvider; costKrw: number | null; costBasis: string };
  /** 칸 하나를 끝까지 돈다. 유료 칸(costKrw !== 0)은 consent가 반드시 있다. */
  run(req: IssueRequest, io: RungIo, consent: ConsentToken | null): Promise<AttemptEnd>;
}

export type LadderState =
  | { s: 'running'; route: RouteId }
  | { s: 'consent'; card: ConsentCard }
  | { s: 'human'; route: RouteId }
  | { s: 'issued'; route: RouteId | null; ref: string | null }
  | { s: 'held'; state: LedgerState }
  | { s: 'stopped'; route: RouteId | null; code: string }
  | { s: 'exhausted'; tried: Array<{ route: RouteId; code: string }> };

export type LadderEvent = { issueKey: IssueKey; state: LadderState };

/** 같은 키의 원장 행(경로 무관). Ledger.byIssueKey. */
export type IssueRows = readonly LedgerRow[];
