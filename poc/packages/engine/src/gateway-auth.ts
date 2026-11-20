import { GatewayError, type GatewayAuth } from '@sax/net';
import type { PortLike } from '@sax/platform';

/** auth 포트 응답 상한(ADR-040 결정 3). main의 의도 해석 상한(4초)보다 길어도 된다: 그때 main은 먼저 "연결 안 됨"으로 끝낸다. */
export const GW_AUTH_TIMEOUT_MS = 5_000;
const HEADER_MAX = 8_192;
const VISIBLE = /^[\x21-\x7e][\x20-\x7e]*$/;
const ID_MAX = 2 ** 31 - 1;

export interface PortGatewayAuth extends GatewayAuth {
  invalidate(): void;
  close(): void;
}

function headersOf(raw: unknown): { authorization: string; dpop: string } | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const keys = Object.keys(raw);
  if (keys.length !== 2) return null;
  const { authorization, dpop } = raw as { authorization?: unknown; dpop?: unknown };
  for (const v of [authorization, dpop]) if (typeof v !== 'string' || v.length > HEADER_MAX || !VISIBLE.test(v)) return null;
  if (!(authorization as string).startsWith('DPoP ')) return null;
  return { authorization: authorization as string, dpop: dpop as string };
}

export function portGatewayAuth(port: PortLike, o: { timeoutMs?: number } = {}): PortGatewayAuth {
  const timeoutMs = o.timeoutMs ?? GW_AUTH_TIMEOUT_MS;
  const pending = new Map<number, { done: (h: { authorization: string; dpop: string } | null) => void; timer: ReturnType<typeof setTimeout> }>();
  let next = 1;
  let closed = false;
  port.onMessage((raw) => {
    const m = raw as { t?: unknown; id?: unknown; headers?: unknown } | null;
    if (!m || typeof m !== 'object' || m.t !== 'gw.auth.result' || typeof m.id !== 'number') return;
    const p = pending.get(m.id);
    if (!p) return;
    pending.delete(m.id);
    clearTimeout(p.timer);
    p.done(headersOf(m.headers));
  });
  return {
    headers(req) {
      if (closed) return Promise.reject(new GatewayError('gateway.unavailable'));
      const id = next;
      next = next >= ID_MAX ? 1 : next + 1;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new GatewayError('gateway.unavailable'));
        }, timeoutMs);
        timer.unref?.();
        pending.set(id, { done: (h) => (h ? resolve(h) : reject(new GatewayError('gateway.unavailable'))), timer });
        port.postMessage({ t: 'gw.auth', id, htm: req.method, htu: req.url });
      });
    },
    invalidate() {
      if (!closed) port.postMessage({ t: 'gw.auth.invalidate' });
    },
    close() {
      closed = true;
      for (const p of pending.values()) {
        clearTimeout(p.timer);
        p.done(null);
      }
      pending.clear();
    },
  };
}
