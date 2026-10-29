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
  /** recovery_v1: 실패한 스텝이 기대한 화면(체크포인트 랜드마크) */
  expected?: { urlPath: string; heading: string };
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

/** 화면 관측의 보이는 텍스트 한 덩어리(정규화). */
export function screenText(o: ScreenObservation, onlyDialog = false): string {
  return [o.title, ...o.nodes.filter((n) => !onlyDialog || n.inDialog || n.role === 'alert').map((n) => n.name)].join('\n').normalize('NFKC');
}

export function dialogs(o: ScreenObservation): ObsNode[] {
  return o.nodes.filter((n) => n.role === 'dialog' || n.role === 'alertdialog' || n.role === 'alert');
}
