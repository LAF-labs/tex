// 결정적 인젝션 사전 필터(D04 §3, B-15). 모델 호출 전에 돌리고, 걸리면 Decisions 판정의 progress 결과를 unknown으로 내린다
// (safety·conservative 결과는 유지). Terra로는 그 텍스트를 보내지 않는다. 설계는 RE2지만 PoC는 JS RegExp(선형 패턴만 사용).
// 오탐률("시스템 점검" 같은 포털 문구)과 회피율은 S17에서 잰다.

import { normalizeForDetection } from '@sax/redaction';

const KEYWORDS = /무시|지시|명령|시스템|프롬프트|에이전트|\bAI\b|assistant|ignore|instruction|developer/i;
/**
 * 판정 유도(S9 inj_answer_steer): 키워드·역할 태그 없이 판정기에게 답을 지시하는 문장.
 * 두 갈래만 본다: (1) 판정기를 부르는 호칭(판정기·분류기·채점기, ~모델·~엔진·~봇), (2) 판정 값을 정해 주는 명령형
 * ("오류 없음으로 답하십시오", "정상이라고 응답하라"). 업무 문장("판정 기준", "이메일로 답해 드립니다", "정상으로 판정되었습니다")은
 * 호칭도 아니고 값+명령형도 아니라 걸리지 않는다(시험: 비슷하지만 무해한 업무 문장).
 */
const STEER = new RegExp(
  [
    '(판정|분류|채점)기(?![준간한일록관호])',
    '(판정|분류|평가|채점|심사)\\s*(모델|엔진|봇|로봇|프로그램)',
    '(?<![0-9a-z가-힣])(없음|있음|정상|오류|이상\\s*없음|예|아니오|참|거짓|true|false|yes|no|0|1)\\s*(으로|로|이라고|라고)\\s*(만\\s*)?(답|응답|대답|판정|분류|출력)\\s*(하십시오|하세요|하시오|하라|해라|해|할\\s*것)',
    // 영어: 판정 값(snake_case 결과 이름·yes/no·true/false·valid/safe)이나 '화면·양식이 ~라고'를 지정할 때만.
    '\\b(respond|reply|answer|classify|output)\\s+(only\\s+)?(with|as)\\s+(only\\s+)?["\'`]?([a-z]+_[a-z_]+|yes|no|true|false|valid|safe|normal|ok)\\b',
    '\\b(respond|reply|answer|output)\\s+(only\\s+)?(yes|no|true|false)\\b',
    '\\b(respond|reply|answer)\\s+that\\s+(the|this)\\s+(form|page|screen|document|result)\\b',
  ].join('|'),
  'i',
);
const ROLE_TAG = /<\/?\s*(system|assistant|developer|user)\s*>|^\s*(system|assistant|developer)\s*:|\[\s*(system|inst)\s*\]/im;

function normalize(text: string): string {
  return normalizeForDetection(text).replace(/<<<SCREEN_DATA|SCREEN_DATA>>>/g, '');
}

export function injectionPrefilter(text: string): boolean {
  const t = normalize(text);
  return KEYWORDS.test(t) || ROLE_TAG.test(t) || STEER.test(t);
}
