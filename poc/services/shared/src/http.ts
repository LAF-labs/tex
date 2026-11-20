import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { ServiceError, fail, type ErrorCode } from './errors.ts';
import type { Logger } from './log.ts';

export interface Ctx {
  method: string;
  route: string;
  path: string;
  params: Record<string, string>;
  query: URLSearchParams;
  headers: http.IncomingHttpHeaders;
  body: unknown;
  rawBody: Buffer;
  ip: string;
  logAid?: string;
}

export interface Reply {
  status: number;
  body?: unknown;
  headers?: Record<string, string>;
  raw?: Buffer | string;
}

export type Handler = (ctx: Ctx) => Promise<Reply> | Reply;

interface Route {
  method: string;
  pattern: string;
  parts: string[];
  handler: Handler;
  maxBodyBytes: number;
  raw: boolean;
}

export interface RouteOpts {
  maxBodyBytes?: number;
  raw?: boolean;
}

const DEFAULT_MAX_BODY = 64 * 1024;

export class Router {
  private readonly routes: Route[] = [];

  add(method: string, pattern: string, handler: Handler, opts: RouteOpts = {}): this {
    this.routes.push({ method, pattern, parts: pattern.split('/').filter(Boolean), handler, maxBodyBytes: opts.maxBodyBytes ?? DEFAULT_MAX_BODY, raw: opts.raw ?? false });
    return this;
  }

  match(method: string, path: string): { route: Route; params: Record<string, string> } | 'method' | null {
    const segs = path.split('/').filter(Boolean);
    let methodMismatch = false;
    for (const r of this.routes) {
      if (r.parts.length !== segs.length) continue;
      const params: Record<string, string> = {};
      let ok = true;
      for (let i = 0; i < segs.length; i++) {
        const p = r.parts[i]!;
        const s = segs[i]!;
        if (p.startsWith(':')) {
          if (!/^[A-Za-z0-9_.@-]{1,128}$/.test(s)) {
            ok = false;
            break;
          }
          params[p.slice(1)] = s;
        } else if (p !== s) {
          ok = false;
          break;
        }
      }
      if (!ok) continue;
      if (r.method !== method) {
        methodMismatch = true;
        continue;
      }
      return { route: r, params };
    }
    return methodMismatch ? 'method' : null;
  }
}

export interface ServeOpts {
  logger: Logger;
  trustProxy?: boolean;
  headers?: Record<string, string>;
}

const BASE_HEADERS = { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer' };

function readBody(req: http.IncomingMessage, max: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length'] ?? 0);
    if (declared > max) return reject(new ServiceError('request.too_large'));
    const chunks: Buffer[] = [];
    let n = 0;
    req.on('data', (c: Buffer) => {
      n += c.length;
      if (n > max) {
        req.destroy();
        reject(new ServiceError('request.too_large'));
      } else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', () => reject(new ServiceError('request.param_rejected')));
  });
}

export function clientIp(req: http.IncomingMessage, trustProxy: boolean): string {
  if (trustProxy) {
    const xff = req.headers['x-forwarded-for'];
    const first = (Array.isArray(xff) ? xff[0] : xff)?.split(',')[0]?.trim();
    if (first) return first;
  }
  return req.socket.remoteAddress ?? '';
}

export async function dispatch(router: Router, req: http.IncomingMessage, opts: ServeOpts): Promise<{ reply: Reply; route: string; bytesIn: number; code: string; aid?: string }> {
  const url = new URL(req.url ?? '/', 'http://x');
  const m = router.match(req.method ?? 'GET', url.pathname);
  if (m === null) return { reply: errorReply('request.not_found'), route: '-', bytesIn: 0, code: 'request.not_found' };
  if (m === 'method') return { reply: errorReply('request.method_not_allowed'), route: '-', bytesIn: 0, code: 'request.method_not_allowed' };
  const { route, params } = m;
  let bytesIn = 0;
  const ctx: Ctx = { method: route.method, route: route.pattern, path: url.pathname, params, query: url.searchParams, headers: req.headers, body: undefined, rawBody: Buffer.alloc(0), ip: clientIp(req, opts.trustProxy ?? false) };
  try {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      const raw = await readBody(req, route.maxBodyBytes);
      bytesIn = raw.length;
      if (route.raw) ctx.rawBody = raw;
      if (raw.length) {
        const ct = String(req.headers['content-type'] ?? '');
        if (!/^application\/json\b/i.test(ct)) fail('request.unsupported_media');
        try {
          ctx.body = JSON.parse(raw.toString('utf8'));
        } catch {
          fail('request.param_rejected');
        }
      }
    }
    const reply = await route.handler(ctx);
    return { reply, route: route.pattern, bytesIn, code: '', aid: ctx.logAid };
  } catch (e) {
    const code: ErrorCode = e instanceof ServiceError ? e.code : 'server.internal';
    const reply = errorReply(code, e instanceof ServiceError ? e.retryAfterSec : undefined);
    return { reply, route: route.pattern, bytesIn, code, aid: ctx.logAid };
  }
}

export function errorReply(code: ErrorCode, retryAfterSec?: number): Reply {
  const err = new ServiceError(code);
  return { status: err.status, body: { error: code }, headers: retryAfterSec ? { 'retry-after': String(retryAfterSec) } : undefined };
}

export function send(res: http.ServerResponse, reply: Reply, extra: Record<string, string> = {}): number {
  const headers: Record<string, string> = { ...BASE_HEADERS, ...extra, ...(reply.headers ?? {}) };
  let payload: Buffer;
  if (reply.raw !== undefined) payload = Buffer.isBuffer(reply.raw) ? reply.raw : Buffer.from(reply.raw);
  else if (reply.body === undefined) payload = Buffer.alloc(0);
  else {
    payload = Buffer.from(JSON.stringify(reply.body));
    headers['content-type'] ??= 'application/json; charset=utf-8';
  }
  headers['content-length'] = String(payload.length);
  res.writeHead(reply.status, headers);
  res.end(reply.status === 304 ? undefined : payload);
  return payload.length;
}

/** 요청 처리기(라우팅·응답·접근 로그). `createServer`와 함수 진입점(Vercel 등)이 같은 것을 쓴다. */
export function requestListener(router: Router, opts: ServeOpts): (req: http.IncomingMessage, res: http.ServerResponse) => Promise<void> {
  return async (req, res) => {
    const started = performance.now();
    const { reply, route, bytesIn, code, aid } = await dispatch(router, req, opts);
    const bytesOut = send(res, reply, opts.headers);
    opts.logger.access({ m: req.method ?? '-', route, status: reply.status, code, bytesIn, bytesOut, ms: performance.now() - started, aid });
  };
}

export function createServer(router: Router, opts: ServeOpts): http.Server {
  const listener = requestListener(router, opts);
  return http.createServer((req, res) => void listener(req, res));
}

export async function listen(server: http.Server, port = 0, host = '127.0.0.1'): Promise<string> {
  await new Promise<void>((r) => server.listen(port, host, r));
  const a = server.address() as AddressInfo;
  return `http://${a.family === 'IPv6' ? `[${a.address}]` : a.address}:${a.port}`;
}

export const json = (status: number, body: unknown, headers?: Record<string, string>): Reply => ({ status, body, headers });
