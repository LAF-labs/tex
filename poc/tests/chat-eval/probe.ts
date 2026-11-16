// chat_agent 도구 결과 전달 탐침(chat-eval 진단): 첫 호출에서 받은 출력과 도구 결과를 여러 모양으로 다시 보내 보고,
// 두 번째 호출이 답(message)을 내는지 같은 도구를 다시 부르는지 센다. 게이트웨이 본문(openAIResponsesBody)이 기준이다.
//   set -a; . ./.env.local; set +a
//   EVAL_MODEL=<OpenRouter 모델 ID> node --conditions=development tests/chat-eval/probe.ts [--n=3]
// 키·응답 원문은 남기지 않는다. 출력은 변형별 message/function_call 개수와 첫 응답 항목 키 모양뿐이다.
import { CHAT_AGENT, toolsetPrefix } from '@sax/model';
import { openAIResponsesBody } from '../../services/gateway/src/providers.ts';

const KEY = process.env.OPENROUTER_API_KEY ?? '';
const MODEL = process.env.EVAL_MODEL ?? '';
const N = Number(process.argv.find((a) => a.startsWith('--n='))?.slice(4) ?? 3);
if (!KEY || !MODEL) {
  console.error('OPENROUTER_API_KEY와 EVAL_MODEL이 필요합니다.');
  process.exit(2);
}

type Item = Record<string, unknown>;
const SAYS: Array<{ text: string; output: object }> = [
  { text: '[지금]\n화면: 열린 카드 없음\n사용자: 이번 달 매출 얼마야?', output: { ref: 'r1', status: 'ok', fields: ['date', 'supply', 'total', 'counterparty', 'approvalNo'], needs: null } },
  { text: '[지금]\n화면: 열린 카드 없음\n사용자: [NAME_1] [AMT_1] 세금계산서 끊어줘', output: { ref: 'd1', status: 'card_shown', fields: null, needs: null } },
  { text: '[지금]\n화면: 열린 카드 없음\n사용자: [NAME_2] 세금계산서 끊어줘', output: { ref: null, status: 'needs_input', fields: null, needs: ['amount'] } },
];

async function call(input: unknown[], patch: (b: Item) => Item = (b) => b): Promise<Item[]> {
  const body = patch(openAIResponsesBody({ model: MODEL, prefix: toolsetPrefix(CHAT_AGENT), effort: CHAT_AGENT.effort, maxOutputTokens: CHAT_AGENT.maxOutputTokens, tools: CHAT_AGENT.tools, output: CHAT_AGENT.output, input, cacheKey: 'chat-eval-probe', safetyId: 'chat-eval' }));
  const res = await fetch('https://openrouter.ai/api/v1/responses', { method: 'POST', headers: { authorization: `Bearer ${KEY}`, 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(60_000) });
  if (res.status !== 200) throw new Error(`${res.status} ${(await res.text()).slice(0, 300)}`);
  return ((await res.json()) as { output?: Item[] }).output ?? [];
}

/** 두 번째 호출 input을 만드는 변형들. first = 첫 호출 출력, out = 도구 결과 문자열 */
const VARIANTS: Record<string, { input: (user: Item, first: Item[], out: string) => unknown[]; patch?: (b: Item) => Item }> = {
  // 지금 게이트웨이와 같다: 첫 출력 그대로 + function_call_output
  as_is: { input: (u, f, o) => [u, ...f, ...f.filter((x) => x.type === 'function_call').map((x) => ({ type: 'function_call_output', call_id: x.call_id, output: o }))] },
  // 추론 항목을 빼고 보낸다
  no_reasoning: { input: (u, f, o) => [u, ...f.filter((x) => x.type !== 'reasoning'), ...f.filter((x) => x.type === 'function_call').map((x) => ({ type: 'function_call_output', call_id: x.call_id, output: o }))] },
  // 함수 호출 항목을 최소 필드(type·call_id·name·arguments)로 줄인다
  min_call: { input: (u, f, o) => [u, ...f.filter((x) => x.type === 'function_call').flatMap((x) => [{ type: 'function_call', call_id: x.call_id, name: x.name, arguments: x.arguments }, { type: 'function_call_output', call_id: x.call_id, output: o }])] },
  // 도구 결과를 user 문장으로 다시 붙인다(도구 결과 항목이 모델에 안 보일 때의 대조군)
  as_user_text: { input: (u, f, o) => [{ ...u, content: [{ type: 'input_text', text: `${(u.content as Array<{ text: string }>)[0]!.text}\n[도구 결과] ${f.filter((x) => x.type === 'function_call').map((x) => `${String(x.name)} → ${o}`).join('; ')}\n도구를 다시 부르지 말고 agent_reply로 답한다.` }] }] },
};

function shape(items: Item[]): string {
  return items.map((x) => `${String(x.type)}{${Object.keys(x).sort().join(',')}}`).join(' ');
}

const tally: Record<string, { message: number; call: number; err: number }> = {};
let shown = false;
for (const s of SAYS) {
  for (let i = 0; i < N; i++) {
    const user: Item = { role: 'user', content: [{ type: 'input_text', text: s.text }] };
    let first: Item[];
    try {
      // 첫 호출은 도구를 꼭 부르게 한다(비교할 두 번째 호출을 만들려고). 두 번째 호출은 제품과 같은 본문이다.
      first = await call([user], (b) => ({ ...b, tool_choice: 'required' }));
    } catch (e) {
      console.log('첫 호출 실패', (e as Error).message);
      continue;
    }
    if (!shown) {
      console.log('첫 응답 항목 모양:', shape(first));
      shown = true;
    }
    if (!first.some((x) => x.type === 'function_call')) {
      console.log('첫 호출에 도구 호출 없음:', shape(first));
      continue;
    }
    const out = JSON.stringify(s.output);
    for (const [name, v] of Object.entries(VARIANTS)) {
      const t = (tally[name] ??= { message: 0, call: 0, err: 0 });
      try {
        const second = await call(v.input(user, first, out), v.patch);
        if (second.some((x) => x.type === 'function_call')) t.call++;
        else if (second.some((x) => x.type === 'message')) t.message++;
        console.log(name, '→', second.map((x) => (x.type === 'function_call' ? `call:${String(x.name)}` : String(x.type))).join(' '));
      } catch (e) {
        t.err++;
        console.log(name, '오류', (e as Error).message);
      }
    }
  }
}
console.log('두 번째 호출 결과(message = 답을 냄, call = 도구를 또 부름):');
console.log(JSON.stringify(tally, null, 2));
