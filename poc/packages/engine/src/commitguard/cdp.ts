// 커밋 가드의 CDP 배선(금고 중계, R-C1 ②③).
// - Fetch.enable은 호스트를 고정한 패턴만 쓴다(`https://<호스트>/*`, requestStage Request). 금고는 `*`·와일드카드 호스트를 거부한다.
//   manifest.domains의 고정 호스트로 시작하고, `*.` 도메인은 실행 중 본 호스트(문서·요청)를 더해 다시 건다.
// - Fetch.requestPaused → guard.onRequest → Fetch.continueRequest | Fetch.failRequest(BlockedByClient).
//   무장된 요청의 본문은 금고가 지워 오므로 엔진은 보지 않는다(⑤).
// - 아직 고정하지 못한 호스트로 간 요청은 Network.requestWillBeSent로만 보인다(guard.onUnintercepted).
import { hostAllowed } from '../core/validate.ts';
import type { CommitGuard } from './guard.ts';

type Json = Record<string, unknown>;

/** Playwright CDPSession 모양(금고 중계 위). */
export interface CdpSessionLike {
  send(method: string, params?: Json): Promise<unknown>;
  on(event: string, fn: (p: Json) => void): void;
  off(event: string, fn: (p: Json) => void): void;
}

export interface FetchInterceptorInput {
  session: CdpSessionLike;
  guard: CommitGuard;
  domains: readonly string[];
  journal: (type: string, payload?: Record<string, string | number | boolean>) => void;
  /** 시험 픽스처 전용: 127.0.0.1·localhost는 http도 잡는다(금고 정책도 http를 루프백에만 허용). */
  insecureLoopback?: boolean;
}

const LOOPBACK = new Set(['127.0.0.1', 'localhost']);

export class FetchInterceptor {
  private readonly i: FetchInterceptorInput;
  /** Fetch.enable이 끝나 실제로 잡고 있는 호스트(포트 포함, 루프백 http는 `http://` 접두). */
  private pinned = new Set<string>();
  private wanted = new Set<string>();
  private chain: Promise<unknown> = Promise.resolve();
  private readonly handlers: Array<[string, (p: Json) => void]>;
  private started = false;

  constructor(i: FetchInterceptorInput) {
    this.i = i;
    for (const d of i.domains) if (!d.startsWith('*.')) this.wanted.add(d.toLowerCase());
    this.handlers = [
      ['Fetch.requestPaused', (p) => void this.onPaused(p)],
      ['Network.requestWillBeSent', (p) => this.onWillBeSent(p)],
      ['Page.frameNavigated', (p) => this.learn(String((p.frame as Json | undefined)?.url ?? ''))],
    ];
  }

  get hosts(): readonly string[] {
    return [...this.pinned].sort();
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    for (const [e, fn] of this.handlers) this.i.session.on(e, fn);
    await this.i.session.send('Network.enable', {});
    await this.i.session.send('Page.enable', {});
    await this.enable();
  }

  async stop(): Promise<void> {
    if (!this.started) return;
    this.started = false;
    for (const [e, fn] of this.handlers) this.i.session.off(e, fn);
    await this.chain.catch(() => {});
    await this.i.session.send('Fetch.disable', {}).catch(() => {});
    this.pinned = new Set();
  }

  /** 이 호스트를 잡는다(manifest.domains 안, https만). 이미 잡았거나 밖이면 그대로. */
  learn(url: string): Promise<void> {
    let u: URL;
    try {
      u = new URL(url);
    } catch {
      return Promise.resolve();
    }
    const h = this.key(u);
    if (!h || this.wanted.has(h) || !hostAllowed(u.hostname.toLowerCase(), this.i.domains)) return Promise.resolve();
    this.wanted.add(h);
    return this.enable();
  }

  /** 원하는 호스트 전부로 Fetch.enable을 다시 건다(호출은 한 줄로). 끝난 뒤에만 pinned에 넣는다. */
  private enable(): Promise<void> {
    const hosts = [...this.wanted].sort();
    const run = async () => {
      if (!this.started || !hosts.length) return;
      try {
        await this.i.session.send('Fetch.enable', { patterns: hosts.map((h) => ({ urlPattern: h.startsWith('http://') ? `${h}/*` : `https://${h}/*`, requestStage: 'Request' })) });
        this.pinned = new Set(hosts);
      } catch {
        this.i.journal('commit_guard.fetch_enable_failed', { hosts: hosts.length });
      }
    };
    const p = this.chain.then(run, run);
    this.chain = p;
    return p;
  }

  /** 고정 키: https는 host(포트 포함), 루프백 http는 시험 픽스처에서만 `http://host`. 그 밖은 null(잡지 않음). */
  private key(u: URL): string | null {
    const host = u.host.toLowerCase();
    if (u.protocol === 'https:') return host;
    if (u.protocol === 'http:' && this.i.insecureLoopback && LOOPBACK.has(u.hostname)) return `http://${host}`;
    return null;
  }

  private async onPaused(p: Json): Promise<void> {
    const requestId = String(p.requestId ?? '');
    const req = (p.request ?? {}) as Json;
    let d: 'continue' | 'fail';
    try {
      d = await this.i.guard.onRequest({ url: String(req.url ?? ''), method: String(req.method ?? 'GET'), postData: typeof req.postData === 'string' ? req.postData : null, contentType: header(req.headers, 'content-type') });
    } catch {
      d = 'fail';
    }
    const cmd = d === 'continue' ? this.i.session.send('Fetch.continueRequest', { requestId }) : this.i.session.send('Fetch.failRequest', { requestId, errorReason: 'BlockedByClient' });
    await cmd.catch(() => {});
  }

  private onWillBeSent(p: Json): void {
    const req = (p.request ?? {}) as Json;
    const url = String(req.url ?? '');
    let u: URL;
    try {
      u = new URL(url);
    } catch {
      return;
    }
    if (!hostAllowed(u.hostname.toLowerCase(), this.i.domains)) return;
    const host = this.key(u);
    if (!host || !this.pinned.has(host)) this.i.guard.onUnintercepted({ url, method: String(req.method ?? 'GET'), postData: typeof req.postData === 'string' ? req.postData : null, contentType: header(req.headers, 'content-type') });
    if (host && !this.wanted.has(host)) void this.learn(url);
  }
}

function header(h: unknown, name: string): string | undefined {
  if (!h || typeof h !== 'object') return undefined;
  for (const [k, v] of Object.entries(h as Json)) if (k.toLowerCase() === name && typeof v === 'string') return v;
  return undefined;
}
