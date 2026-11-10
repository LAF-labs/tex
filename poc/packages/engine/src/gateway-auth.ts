// 엔진 → 게이트웨이 인증(ADR-040 결정 3·5): main auth 포트로 요청마다 헤더를 받는 GatewayAuth.
// - 보내는 것: {t:'gw.auth', id, htm, htu}, 401 뒤 {t:'gw.auth.invalidate'}. 본문 해시(bodySha256)는 보내지 않는다(DPoP 키 다섯 개, CONTRACT §3).
// - 받는 것: {t:'gw.auth.result', id, headers:{authorization, dpop}} 또는 {…, code}.
// - 엔진은 토큰·키를 갖지 않는다. 헤더는 이 요청 한 번에만 쓰고 저장·기록하지 않는다(코드도 기록하지 않는다. main이 이름만 남긴다).
// - 실패(signed_out·denied·unavailable·모양 틀림)와 5초 초과는 모두 GatewayError('gateway.unavailable')다. 다시 보내지 않는다.
//   intent.resolve는 그것을 decide.unavailable로 접고 main은 "연결 안 됨"과 [다시 시도]를 보인다(오프라인 해석 없음, 사용자 결정 2026-11-10).
import { GatewayError, type GatewayAuth } from '@sax/net';
import type { PortLike } from '@sax/platform';

/** auth 포트 응답 상한(ADR-040 결정 3). main의 의도 해석 상한(4초)보다 길어도 된다: 그때 main은 먼저 "연결 안 됨"으로 끝낸다. */
export const GW_AUTH_TIMEOUT_MS = 5_000;
/** 헤더 값 상한. 기기 토큰(서명 JWT)·DPoP 증명은 1~2KB다. */
const HEADER_MAX = 8_192;
/** 보이는 ASCII만(CR·LF·제어 문자 없음). 헤더 주입·비정상 값을 fetch 전에 거른다. */
const VISIBLE = /^[\x21-\x7e][\x20-\x7e]*$/;
const ID_MAX = 2 ** 31 - 1;

export interface PortGatewayAuth extends GatewayAuth {
  invalidate(): void;
  /** 기다리는 요청을 모두 unavailable로 끝낸다(포트가 닫힐 때). */
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
    if (!p) return; // 늦은 답(시간 초과 뒤)·모르는 id는 버린다
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
