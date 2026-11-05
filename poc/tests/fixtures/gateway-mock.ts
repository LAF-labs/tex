// 모의 모델 게이트웨이(services/gateway/API.md 와이어, M4-6). /v1/decide·/v1/respond·/v1/run-tokens.
// 게이트웨이가 하는 일 중 클라이언트가 보는 것만 흉내 낸다: 질문 주입·questionsDigest·cached_tokens 제거·태그·오류 코드.
import { createHash } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { BundleCatalog, QUERY_PARSE, questionsDigest, toolsetDigest } from '@sax/model';

export interface GatewayMockCall {
  method: string;
  path: string;
  body: Record<string, unknown> | null;
  headers: http.IncomingHttpHeaders;
}

export interface GatewayMockOptions {
  /** 경로별 다음 응답을 강제(오류 코드 시험) */
  fail?: Partial<Record<string, { status: number; code?: string }>>;
  /** questionsDigest를 바꿔치기(신뢰 지점 대조 시험) */
  tamperDigest?: boolean;
  /** toolsetDigest를 바꿔치기 */
  tamperToolset?: boolean;
  /** decide 답: 질문 이름 → 확률(predicate) 또는 선택값(choice) */
  answers?: Record<string, number | string>;
  /** respond 응답 output(기본: query_parse 구조화 출력 한 건) */
  respondOutput?: Array<Record<string, unknown>>;
}

export interface GatewayMock {
  origin: string;
  calls: GatewayMockCall[];
  opts: GatewayMockOptions;
  close(): Promise<void>;
}

export async function startGatewayMock(opts: GatewayMockOptions = {}): Promise<GatewayMock> {
  const catalog = BundleCatalog.load();
  const calls: GatewayMockCall[] = [];
  const state = { opts };
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : null;
      const path = req.url ?? '';
      calls.push({ method: req.method ?? '', path, body, headers: req.headers });
      const send = (status: number, json: unknown) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(json));
      };
      const f = state.opts.fail?.[path];
      if (f) return send(f.status, f.code ? { error: f.code } : {});
      if (!String(req.headers.authorization ?? '').startsWith('DPoP ') || !req.headers.dpop) return send(401, { error: 'gateway.unauthorized' });
      if (path === '/v1/decide') {
        const b = catalog.get(String(body?.bundleId));
        if (!b || b.digest !== body?.bundleDigest) return send(409, { error: 'gateway.digest_mismatch' });
        const a = state.opts.answers ?? {};
        const answers = b.def.questions.map((q) => {
          if (q.type === 'predicate') return { type: 'predicate', name: q.name, probability: typeof a[q.name] === 'number' ? a[q.name] : 0.02 };
          if (q.type === 'choice') {
            const choice = typeof a[q.name] === 'string' ? a[q.name] : 'unknown';
            return { type: 'choice', name: q.name, choice, confidence: 0.97, probabilities: [{ value: choice, probability: 0.97 }] };
          }
          return { type: 'score', name: q.name, score: 1, confidence: 0.9 };
        });
        const qd = state.opts.tamperDigest ? createHash('sha256').update('tampered').digest('hex') : questionsDigest(b);
        return send(200, { id: 'dec_mock', model: 'gpt-6-luna-2026-10-22', answers, usage: { input_tokens: 1200, output_tokens: 0 }, questionsDigest: qd });
      }
      if (path === '/v1/respond') {
        const output = state.opts.respondOutput ?? [
          { type: 'reasoning', id: 'rs_1', encrypted_content: 'enc' },
          { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: JSON.stringify({ query_kind: 'documents_expiring', doc_type: null, from: null, to: null }) }] },
        ];
        const td = state.opts.tamperToolset ? 'f'.repeat(64) : toolsetDigest(QUERY_PARSE);
        return send(200, { model: 'gpt-6.1-terra', status: 'completed', output: output.map((item, i) => ({ item, tag: `gwtag${i}` })), usage: { input_tokens: 300, output_tokens: 40, input_tokens_details: { cached_tokens: 256, cache_write_tokens: 0 } }, toolsetDigest: td });
      }
      if (path === '/v1/run-tokens') {
        const keys = Object.keys(body ?? {});
        if (keys.length !== 1 || !['runId', 'chatSessionId'].includes(keys[0]!)) return send(400, { error: 'gateway.param_rejected' });
        return send(200, { runToken: `sxr1.${Buffer.from(JSON.stringify(body)).toString('base64url')}.sig`, expiresAt: '2026-11-05T12:00:00Z', budget: { l1: 12, l2: 2 } });
      }
      return send(404, {});
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;
  return {
    origin: `http://127.0.0.1:${port}`,
    calls,
    get opts() {
      return state.opts;
    },
    set opts(v: GatewayMockOptions) {
      state.opts = v;
    },
    close: () => new Promise((r) => server.close(() => r())),
  } as GatewayMock;
}
