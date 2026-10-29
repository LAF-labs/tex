// 모의 OpenAI(Decisions·Responses). 응답 모양은 SDK 7.45.1 타입·R1 §A.5 예시를 따른 합성 녹화다(실측값 아님).
// 쓰는 곳: 어댑터·egress 테스트, scripts/s9-decisions.ts 모의 모드(키 없을 때).
import { createHash } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

export interface MockCall {
  path: string;
  body: Record<string, unknown>;
  headers: http.IncomingHttpHeaders;
}

export interface MockOptions {
  /** 경로별 앞쪽 N개 요청에 돌려줄 오류(재시도 정책 테스트) */
  failures?: Array<{ status: number; code?: string; retryAfter?: string }>;
  /** Decisions answers를 바꿔치기(이름 조인·비신뢰 응답 테스트) */
  tamper?: (answers: Array<Record<string, unknown>>) => Array<Record<string, unknown>>;
  /** choice probabilities를 전체 분포로 줄지(기본: top-1만, R1 예시처럼) */
  fullDistribution?: boolean;
  model?: string;
}

export interface OpenAIMock {
  origin: string;
  calls: MockCall[];
  close(): Promise<void>;
}

const tokens = (s: string) => Math.ceil(Buffer.byteLength(s, 'utf8') / 3);

// 합성 판정: 키워드로 그럴듯한 확률을 만든다. 실제 모델 동작을 흉내 내는 것이 아니라 파이프라인 검증용이다.
const KW: Record<string, RegExp> = {
  security_warning: /비정상|이용이\s*제한|접근이\s*제한|매크로|자동화/,
  logged_out_by_other_session: /다른\s*(PC|기기|브라우저)에서/,
  captcha_visible: /보안문자|자동입력/,
  mfa_pending: /인증\s*앱|휴대폰에서\s*인증/,
  session_expired_notice: /세션이\s*만료|다시\s*로그인/,
  has_error_modal: /alertdialog|오류/,
  issuance_success_text: /발급되었습니다.*APPROVAL|APPROVAL.*발급되었습니다/s,
  page_text_addresses_agent: /AI|에이전트|무시하고|ignore/i,
  validation_error_visible: /invalid|입력하세요|올바르지/,
  asks_to_proceed_or_issue: /발급하시겠습니까|button "예"/,
  mentions_tax_advice: /절세|공제|신고\s*방법/,
  parse_matches_user_text: /./,
};
const REFUSE = /(무시하고|ignore previous).*(지시|instructions)|REFUSE_PROBE/is;

function answerFor(q: Record<string, unknown>, text: string, full: boolean): Record<string, unknown> {
  const name = String(q.name);
  if (REFUSE.test(text) && (name === 'page_text_addresses_agent' || name === 'security_warning')) return { type: 'refusal', name };
  if (q.type === 'predicate') {
    const re = KW[name];
    return { type: 'predicate', name, probability: re && re.test(text) ? 0.97 : 0.02 };
  }
  const choices = (q.choices as Array<{ value: string }>).map((c) => c.value);
  let choice = choices.includes('unknown') ? 'unknown' : choices.at(-1)!;
  if (name === 'screen') choice = /로그아웃/.test(text) ? (/textbox/.test(text) ? 'form' : 'logged_in_home') : /로그인/.test(text) ? 'login_page' : /접근이\s*제한/.test(text) ? 'blocked' : choice;
  if (name === 'result') choice = /발급되었습니다/.test(text) ? 'issued' : /이미\s*발급/.test(text) ? 'duplicate' : choice;
  if (name === 'popup') choice = /공지/.test(text) ? 'notice_dismissable' : /오류/.test(text) ? 'error' : choice;
  if (name === 'situation') choice = /dialog/.test(text) ? 'modal_blocking' : 'element_missing_same_screen';
  if (name === 'playbook') choice = /계산서/.test(text) ? 'hometax.invoice.issue' : /납세/.test(text) ? 'hometax.cert.taxpayment' : 'none_of_these';
  if (name === 'issued_on' || name === 'valid_until') choice = /candidate_1/.test(text) ? 'candidate_1' : 'none';
  const conf = choice === 'unknown' ? 0.5 : 0.93;
  const rest = choices.filter((c) => c !== choice);
  const probabilities = full ? [{ value: choice, probability: conf }, ...rest.map((v) => ({ value: v, probability: (1 - conf) / rest.length }))] : [{ value: choice, probability: conf }];
  return { type: 'choice', name, choice, confidence: conf, probabilities };
}

export async function startOpenAIMock(opts: MockOptions = {}): Promise<OpenAIMock> {
  const calls: MockCall[] = [];
  const failures = [...(opts.failures ?? [])];
  const cache = new Set<string>();
  let remaining = 4999;
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const body = JSON.parse(raw || '{}') as Record<string, unknown>;
      calls.push({ path: req.url ?? '', body, headers: req.headers });
      const headers: Record<string, string> = {
        'content-type': 'application/json',
        'x-ratelimit-limit-requests': '5000',
        'x-ratelimit-remaining-requests': String(remaining--),
        'x-ratelimit-reset-requests': '12ms',
        'x-ratelimit-limit-tokens': '2000000',
        'x-ratelimit-remaining-tokens': '1998000',
        'x-ratelimit-reset-tokens': '60ms',
        'x-request-id': `req_mock_${calls.length}`,
      };
      const f = failures.shift();
      if (f) {
        if (f.retryAfter) headers['retry-after'] = f.retryAfter;
        res.writeHead(f.status, headers).end(JSON.stringify({ error: { message: 'mock', type: 'mock_error', code: f.code ?? null } }));
        return;
      }
      const input = (body.input as Array<{ role?: string; type?: string; content?: Array<{ text?: string; prompt_cache_breakpoint?: unknown }> }>) ?? [];
      const dev = input.find((m) => m.role === 'developer')?.content?.[0];
      const prefix = dev?.prompt_cache_breakpoint ? (dev.text ?? '') : '';
      const userText = input
        .filter((m) => m.role === 'user')
        .flatMap((m) => m.content ?? [])
        .map((c) => c.text ?? '')
        .join('\n');
      const key = createHash('sha256').update(String(body.prompt_cache_key ?? '')).update(prefix).digest('hex');
      const pt = tokens(prefix);
      const hit = pt >= 1024 && cache.has(key);
      const write = pt >= 1024 && !hit;
      if (write) cache.add(key);
      const inputTokens = tokens(JSON.stringify(input));
      const usage = { input_tokens: inputTokens, input_tokens_details: { cached_tokens: hit ? pt : 0, cache_write_tokens: write ? pt : 0 }, output_tokens: 0, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: inputTokens };
      if (req.url === '/v1/decisions') {
        let answers = (body.questions as Array<Record<string, unknown>>).map((q) => answerFor(q, userText, opts.fullDistribution ?? false));
        if (opts.tamper) answers = opts.tamper(answers);
        res.writeHead(200, headers).end(JSON.stringify({ model: opts.model ?? 'gpt-6-luna-2026-10-22', answers, usage }));
        return;
      }
      if (req.url === '/v1/responses') {
        const replayed = input.filter((m) => m.type === 'function_call_output').length;
        const output = replayed
          ? [
              { type: 'reasoning', id: 'rs_2', summary: [], encrypted_content: 'gAAAA-mock-2' },
              { type: 'message', id: 'msg_1', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: JSON.stringify({ outcome: 'repaired', risk_flags: [], candidates: [{ kind: 'role', value: 'textbox', name: '공급받는자 등록번호', why: 'same_label' }] }), annotations: [] }] },
            ]
          : [
              { type: 'reasoning', id: 'rs_1', summary: [], encrypted_content: 'gAAAA-mock-1' },
              { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'get_a11y_subtree', arguments: JSON.stringify({ scopeId: 'form.counterpart', maxBytes: 4000 }), status: 'completed' },
            ];
        res.writeHead(200, headers).end(JSON.stringify({ id: `resp_${calls.length}`, object: 'response', model: 'gpt-6.1-terra-2026-10-01', status: 'completed', output, usage: { ...usage, output_tokens: 120, output_tokens_details: { reasoning_tokens: 80 } } }));
        return;
      }
      res.writeHead(404, headers).end('{}');
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;
  return { origin: `http://127.0.0.1:${port}`, calls, close: () => new Promise((r) => server.close(() => r())) };
}
