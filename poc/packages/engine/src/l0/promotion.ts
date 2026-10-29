// L0 승격 기준(D13 S-L0): 규칙 정확도 ≥ 99.5%인 질문만 L0로 보낸다(모델 대신 규칙 답을 쓴다).
// 정확도 = 규칙이 답한 표본 중 라벨과 맞은 비율(기권 표본은 모델로 가므로 분모에서 뺀다). 기권률은 따로 보고한다.
// 근거 코퍼스는 라벨된 실화면(홈택스, PoC-3 이후)·실문장이어야 하고, 질문당 답한 표본 n ≥ 300(R8 §7 S-L0).
// 합성 코퍼스 수치는 규칙 논리 검증용이며 승격 근거가 아니다. 승격 목록은 앱과 함께 배포된다(규칙 변경 = 앱 업데이트).
import fs from 'node:fs';

export const PROMOTION_MIN_ACCURACY = 0.995;
export const PROMOTION_MIN_N = 300;

export interface L0Measurement {
  bundle: string;
  question: string;
  corpus: { id: string; kind: 'synthetic' | 'labeled_real'; n: number };
  /** 규칙이 답한 표본 수와 그중 정답 수 */
  answered: number;
  correct: number;
  measuredAt: string;
}

export function accuracy(m: L0Measurement): number {
  return m.answered ? m.correct / m.answered : 0;
}

export function qualifies(m: L0Measurement): boolean {
  return m.corpus.kind === 'labeled_real' && m.answered >= PROMOTION_MIN_N && accuracy(m) >= PROMOTION_MIN_ACCURACY;
}

/** `${bundle}.${question}` 집합. 측정 파일에 있어도 기준을 넘지 못하면 들어가지 않는다. */
export function promotedSet(ms: L0Measurement[]): Set<string> {
  return new Set(ms.filter(qualifies).map((m) => `${m.bundle}.${m.question}`));
}

export function loadPromotions(file: URL = new URL('../../l0-promotions.json', import.meta.url)): Set<string> {
  return promotedSet(JSON.parse(fs.readFileSync(file, 'utf8')) as L0Measurement[]);
}
