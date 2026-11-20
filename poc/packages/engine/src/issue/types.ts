import type { LedgerRow, LedgerState } from '@sax/db';

/** 경로 id. 표의 순서가 사다리 순서다(routes.ts ROUTES). API 칸은 하나이고 칸 안에서 원천(팝빌·CODEF)을 고른다(부장 조정 2026-11-12). */
export type RouteId = 'hometax.auto' | 'hometax.manual' | 'api';

/** API 칸의 원천. 팝빌이 연결돼 있으면 팝빌, 아니면 CODEF. 원천 사이 넘어가기는 없다. */
export type ApiProvider = 'popbill' | 'codef';

export interface RouteSpec {
  id: RouteId;
  kind: 'portal' | 'human' | 'api';
  costKrw: number | null;
  costBasis: string;
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
  runId?: string;
}

/** 칸 하나가 끝난 모양. 발급 여부는 담지 않는다(사다리가 원장으로 본다). */
export interface AttemptEnd {
  code?: string;
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
  provider: ApiProvider | null;
  costKrw: number | null;
  costBasis: string;
  reasonCode: string;
  nothingIssued: true;
}

/** 칸이 사다리에 묻는 것. 사다리가 사장님 답을 기다린다. */
export interface RungIo {
  askHuman(): Promise<'issued' | 'cannot'>;
  journal(type: string, payload?: Record<string, string | number | boolean>): void;
}

export interface Rung {
  readonly route: RouteSpec;
  available(): { ok: true } | { ok: false; code: string };
  quote?(): { provider: ApiProvider; costKrw: number | null; costBasis: string };
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
