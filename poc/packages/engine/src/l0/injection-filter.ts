
import { normalizeForDetection } from '@sax/redaction';

const KEYWORDS = /무시|지시|명령|시스템|프롬프트|에이전트|\bAI\b|assistant|ignore|instruction|developer/i;
const STEER = new RegExp(
  [
    '(판정|분류|채점)기(?![준간한일록관호])',
    '(판정|분류|평가|채점|심사)\\s*(모델|엔진|봇|로봇|프로그램)',
    '(?<![0-9a-z가-힣])(없음|있음|정상|오류|이상\\s*없음|예|아니오|참|거짓|true|false|yes|no|0|1)\\s*(으로|로|이라고|라고)\\s*(만\\s*)?(답|응답|대답|판정|분류|출력)\\s*(하십시오|하세요|하시오|하라|해라|해|할\\s*것)',
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
