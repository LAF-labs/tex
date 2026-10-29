// Upstage solar-decide(System One 계약) 어댑터 스텁(ADR-015 결정 2). 한국 리전 승인 전이라 호출하지 않는다.
// 요청 조립·응답 정규화만 구현해 계약 호환(이름 키 객체 answers, noul, refusal 없음, 선택지 ≤ 26)을 테스트로 고정한다.
// 와이어 필드명은 R8 §1.3 교집합 기준이며 GA 전 바뀔 수 있다(R6 §1.4). egress 목적지에도 아직 넣지 않았다.
import type { RedactedText, RunToken } from '../contract.ts';
import type { LoadedBundle } from '../bundle/types.ts';
import { joinByName, type NormalizeResult, type RawAnswer } from '../normalize.ts';
import { AdapterError, type AdapterLimits, type DecideAdapter, type ProviderDecision } from './types.ts';

export const SOLAR_DECIDE = 'solar-decide';

type SystemOneQuestion =
  | { type: 'noul'; instructions: string }
  | { type: 'choice'; instructions: string; criteria: Record<string, string> }
  | { type: 'score'; instructions: string; criteria: string[] };

export interface SystemOneRequest {
  model: string;
  /** System One에는 역할 구분이 없어 고정 접두와 화면 텍스트를 한 state로 보낸다(캐시는 계약 밖). */
  state: string;
  questions: Record<string, SystemOneQuestion>;
}

export class UpstageSystemOneAdapter implements DecideAdapter {
  readonly provider = 'upstage' as const;
  readonly model = SOLAR_DECIDE;
  /** R6: 선택지 2~26, 질문별 refusal 없음, 문맥 512K(바이트 상한은 보수적으로 그 절반) */
  readonly limits: AdapterLimits = { maxChoices: 26, maxQuestions: 64, refusals: false, maxRequestBytes: 256_000 };

  buildRequest(b: LoadedBundle, input: RedactedText): SystemOneRequest {
    const questions: Record<string, SystemOneQuestion> = {};
    for (const q of b.def.questions) {
      if (q.type === 'predicate') questions[q.name] = { type: 'noul', instructions: q.instructions };
      else if (q.type === 'choice') questions[q.name] = { type: 'choice', instructions: q.instructions, criteria: Object.fromEntries(q.choices.map((c) => [c.value, c.description])) };
      else questions[q.name] = { type: 'score', instructions: q.instructions, criteria: q.levels.map((l) => l.label) };
    }
    return { model: this.model, state: `${b.prefixText}\n\n${input}`, questions };
  }

  requestBytes(b: LoadedBundle, input: RedactedText): number {
    return Buffer.byteLength(JSON.stringify(this.buildRequest(b, input)), 'utf8');
  }

  async call(_b: LoadedBundle, _input: RedactedText, _runToken: RunToken): Promise<ProviderDecision> {
    throw new AdapterError('not_available');
  }

  /** answers는 질문 이름 키 객체. choice probabilities는 배열·객체 두 형태를 모두 받는다(미확인, R8 §1.3). */
  normalize(b: LoadedBundle, raw: ProviderDecision): NormalizeResult {
    const answers = (raw.body as { answers?: unknown }).answers;
    if (!answers || typeof answers !== 'object' || Array.isArray(answers)) return { ok: false, reason: 'answer_names_mismatch' };
    const qType = new Map(b.def.questions.map((q) => [q.name, q.type]));
    const entries: Array<[unknown, RawAnswer]> = [];
    for (const [name, a] of Object.entries(answers as Record<string, Record<string, unknown>>)) {
      const t = qType.get(name);
      if (t === 'predicate') entries.push([name, { type: 'predicate', probability: a?.noul }]);
      else if (t === 'choice') {
        const p = a?.probabilities;
        const list = Array.isArray(p) ? p : p && typeof p === 'object' ? Object.entries(p).map(([value, probability]) => ({ value, probability })) : p;
        entries.push([name, { type: 'choice', choice: a?.choice, confidence: a?.confidence, probabilities: list }]);
      } else if (t === 'score') entries.push([name, { type: 'score', score: a?.score, confidence: a?.confidence }]);
      else entries.push([name, { type: 'refusal' }]);
    }
    const r = joinByName(b.def, entries);
    // System One에는 refusal이 없다. 모르는 이름을 refusal로 넣은 것은 위 joinByName이 이름 집합 불일치로 거른다.
    if (r.ok && r.refusals.length) return { ok: false, reason: 'answer_names_mismatch' };
    return r;
  }
}
