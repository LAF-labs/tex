export interface ObsNode {
  role: string;
  name: string;
  states?: string[];
  inDialog?: boolean;
}

export interface ScreenObservation {
  kind: 'screen';
  url: string;
  title: string;
  nodes: ObsNode[];
  expected?: { urlPath: string; heading: string; screenParams?: Record<string, string> };
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
