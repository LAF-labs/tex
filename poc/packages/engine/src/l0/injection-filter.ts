// 결정적 인젝션 사전 필터(D04 §3, B-15). 모델 호출 전에 돌리고, 걸리면 Decisions 판정의 progress 결과를 unknown으로 내린다
// (safety·conservative 결과는 유지). Terra로는 그 텍스트를 보내지 않는다. 설계는 RE2지만 PoC는 JS RegExp(선형 패턴만 사용).
// 오탐률("시스템 점검" 같은 포털 문구)과 회피율은 S17에서 잰다.

const KEYWORDS = /무시|지시|명령|시스템|프롬프트|에이전트|\bAI\b|assistant|ignore|instruction|developer/i;
const ROLE_TAG = /<\/?\s*(system|assistant|developer|user)\s*>|^\s*(system|assistant|developer)\s*:|\[\s*(system|inst)\s*\]/im;

function normalize(text: string): string {
  return text
    .normalize('NFKC')
    .replace(/[\u200B-\u200D\u2060\uFEFF]/g, '')
    .replace(/<<<SCREEN_DATA|SCREEN_DATA>>>/g, '');
}

export function injectionPrefilter(text: string): boolean {
  const t = normalize(text);
  return KEYWORDS.test(t) || ROLE_TAG.test(t);
}
