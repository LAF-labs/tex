// L0 규칙이 보는 로컬 관측. 모델로 보내지 않는다. 화면 관측은 금고 중계 필터를 지난 접근성 트리(값 없음, D06 §4)다.

export interface ObsNode {
  role: string;
  name: string;
  /** required, invalid, disabled, checked … */
  states?: string[];
  /** dialog·alertdialog 아래 노드 */
  inDialog?: boolean;
}

export interface ScreenObservation {
  kind: 'screen';
  url: string;
  title: string;
  nodes: ObsNode[];
  /**
   * recovery_v1: 실패한 스텝이 기대한 화면(체크포인트에서 기록). screenParams는 화면 식별 쿼리 파라미터의 기대값이다
   * (홈택스 WebSquare는 pathname이 늘 /websquare/websquare.html이고 화면 ID가 w2xPath 쿼리에 있다).
   */
  expected?: { urlPath: string; heading: string; screenParams?: Record<string, string> };
  /** 화면 식별 쿼리 파라미터 이름(포털별 셀렉터 사전이 정한다). 없으면 PORTAL_SCREEN_ID_PARAMS 기본값 */
  screenIdParams?: string[];
}

export interface IntentObservation {
  kind: 'intent';
  text: string;
}

export interface AmountObservation {
  kind: 'amount';
  userText: string;
  parse: { vatMode: 'included' | 'excluded'; supply: number; tax: number; total: number };
}

export interface DocMetaObservation {
  kind: 'doc_meta';
  docType: string;
  /** 규칙 추출기가 만든 후보(최대 8개, 날짜 ±40자 문맥) */
  candidates: Array<{ date: string; context: string }>;
}

export type Observation = ScreenObservation | IntentObservation | AmountObservation | DocMetaObservation;

const DIALOG_ROLES = new Set(['dialog', 'alertdialog', 'alert']);

/** 화면 관측의 보이는 텍스트 한 덩어리(정규화). 페이지 제목 포함. */
export function screenText(o: ScreenObservation): string {
  return [o.title, ...o.nodes.map((n) => n.name)].join('\n').normalize('NFKC');
}

/** 대화상자 서브트리 텍스트만(대화상자 노드 이름 + 그 안의 노드). 페이지 제목·본문은 넣지 않는다. */
export function dialogText(o: ScreenObservation): string {
  return o.nodes
    .filter((n) => n.inDialog || DIALOG_ROLES.has(n.role))
    .map((n) => n.name)
    .join('\n')
    .normalize('NFKC');
}

export function dialogs(o: ScreenObservation): ObsNode[] {
  return o.nodes.filter((n) => DIALOG_ROLES.has(n.role));
}

/**
 * 포털별 화면 식별 쿼리 파라미터 기본값. 원천은 포털 셀렉터 사전(매니페스트)이어야 하는데 스키마에 자리가 없어
 * PoC는 여기 둔다(보드 PoC-7 질문). 관측이 screenIdParams를 주면 그것을 쓴다.
 */
export const PORTAL_SCREEN_ID_PARAMS: Record<string, string[]> = {
  'hometax.go.kr': ['w2xPath'],
  'www.hometax.go.kr': ['w2xPath'],
};

/** 화면 동일성 비교 키: pathname + 화면 식별 쿼리 파라미터(허용 목록만) + 첫 heading. 식별 파라미터 목록을 모르면 null. */
export function sameScreen(o: ScreenObservation, expected: NonNullable<ScreenObservation['expected']>): boolean | null {
  const u = new URL(o.url);
  const ids = o.screenIdParams ?? PORTAL_SCREEN_ID_PARAMS[u.hostname];
  if (!ids && u.search) return null;
  const heading = o.nodes.find((n) => n.role === 'heading')?.name.trim() ?? '';
  if (u.pathname !== expected.urlPath || heading !== expected.heading) return false;
  return (ids ?? []).every((p) => (u.searchParams.get(p) ?? null) === (expected.screenParams?.[p] ?? null));
}
