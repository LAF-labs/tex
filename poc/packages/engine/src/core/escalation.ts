// 발급 사다리 칸 표(2026-11-16 대표 지시 "가장 싸고 빠른 길부터"). 홈택스 자동 칸(issue/routes.ts hometax.auto) 안에서 막힌 스텝 하나가
// 사람에게 가기 전에 내려가는 순서와 칸마다의 비용·시간 추정이다. 순서는 core/fallback.ts FallbackChain.recover가 집행하고,
// 이 표는 예행 보고서(rehearsal.ts)의 추정 금액과 설계 문서(D03 §4.3)가 쓴다. 금액은 원(KRW), 추정이다(실측으로 고친다).
export interface RungCost {
  id: string;
  /** 한 번(걸음·호출)당 원. 0 = 모델 없음. */
  krw: number;
  /** 사람이 읽는 시간 근거 */
  time: string;
  /** 근거 */
  basis: string;
}

export const ESCALATION: readonly RungCost[] = [
  { id: 'script', krw: 0, time: '스텝당 1초 안팎', basis: '서명 패키지 선택자' },
  { id: 'heal', krw: 0, time: '0초(시작 때 첫 후보로 둠)', basis: '앞 실행이 고친 선택자 기억(core/heal-memory.ts)' },
  { id: 'retry', krw: 0, time: '재시도 3번, 대상 대기 포함 수십 초', basis: '패키지 recovery·정책 stepMax' },
  { id: 'replay', krw: 0, time: '걸음당 1초 안팎', basis: '앞 실행에서 에이전트·화면 보기가 넘긴 길(run/agent-path.ts)' },
  { id: 'refind', krw: 0, time: '1초 안팎', basis: '패키지 role·label 후보' },
  { id: 'locate', krw: 3, time: '호출당 3~10초, 스텝당 2번까지', basis: 'selector_repair(respond 모델, DeepSeek 단가 추정 2~4원)' },
  { id: 'checkpoint', krw: 0, time: '앞 체크포인트부터 다시(수십 초)', basis: '체크포인트 재진입, 실행당 체크포인트마다 1번' },
  { id: 'judge', krw: 11, time: '호출당 5~50초', basis: 'page_judge(jev-router, 대표 실측 걸음당 약 11원)' },
  { id: 'agent', krw: 11, time: '걸음당 5~50초, 25걸음까지', basis: 'browser_agent(jev-router, 걸음당 약 11원)' },
  { id: 'vision', krw: 25, time: '걸음당 5~50초, 12걸음까지', basis: 'computer_use(가린 사진 1장 + 글, 비전 모델 단가 추정, 실측 전)' },
  { id: 'human', krw: 0, time: '사장님 차례(분 단위)', basis: '사람 대기(핸드오프), 그다음 칸은 홈택스 직접 발급 → API' },
];

/** 같은 실행의 L1 decide(안전 판정, gpt-6-luna Decisions) 호출당 원(추정 0.26원). 일 한도를 넘어도 안전 판정은 간다(PR #384). */
export const DECIDE_KRW = 0.26;

/** 저널 이벤트 → 칸(예행 보고서의 추정 금액). */
export const COST_EVENTS: Readonly<Record<string, string>> = {
  'locate.asked': 'locate',
  'judge.applied': 'judge',
  'judge.dialog': 'judge',
  'agent.action': 'agent',
  'computer_use.action': 'vision',
};

/** 저널 이벤트 수로 이 실행의 AI 비용(원, 추정). */
export function estimateKrw(counts: Readonly<Record<string, number>>): number {
  let krw = (counts.decide ?? 0) * DECIDE_KRW;
  for (const r of ESCALATION) krw += (counts[r.id] ?? 0) * r.krw;
  return Math.round(krw * 100) / 100;
}
