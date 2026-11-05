// 모의 모델 게이트웨이(D04 §7 계약, 클라우드 트랙 실구현 전 합성). /v1/decide·/v1/respond·/v1/run-tokens·/v1/usage/me.
// 게이트웨이가 하는 일 중 클라이언트가 보는 것만 흉내 낸다: 질문 주입·questionsDigest·cached_tokens 제거·태그·오류 코드.
import { createHash } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { BundleCatalog, questionsDigest } from '@sax/model';

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
      if (f) return send(f.status, f.code ? { code: f.code } : {});
      if (!String(req.headers.authorization ?? '').startsWith('DPoP ') || !req.headers.dpop) return send(401, { code: 'gateway.auth' });
      if (path === '/v1/decide') {
        const b = catalog.get(String(body?.bundleId));
        if (!b || b.digest !== body?.bundleDigest) return send(409, { code: 'gateway.digest_mismatch' });
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
        return send(200, { status: 'completed', output, usage: { input_tokens: 300, output_tokens: 40 }, tags: output.map((_, i) => `gwtag${i}`) });
      }
      if (path === '/v1/run-tokens') return send(200, { runToken: `gw.${'a'.repeat(40)}` });
      if (path === '/v1/usage/me') return send(200, { month: '2026-11', tokens: 0, limit: 1 });
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
