// 엔진 → 게이트웨이 인증(ADR-040 예정, 클라우드 설계 노트 gateway-auth-design.md 2번). main이 엔진 auth 포트의 요청에 답한다.
// - 엔진은 요청마다 {t:'gw.auth', id, htm, htu}를 보내고 {t:'gw.auth.result', id, headers:{authorization, dpop}} 또는 {…, code}를 받는다.
// - 토큰은 gateway 범위만인 기기 토큰이다(DeviceSession.gatewayAuth). 전체 범위 토큰·키·인증서는 엔진에 가지 않는다.
// - 허용은 POST + GATEWAY_ORIGIN의 세 경로(/v1/run-tokens·/v1/decide·/v1/respond)뿐이다. 문자열이 정확히 같아야 한다(쿼리·조각·`..`·끝 / 없음).
// - 로그인 안 됨·신원 없음·금고 잠김이면 account.signed_out. 엔진은 게이트웨이를 부르지 않고 오프라인으로 간다.
// - {t:'gw.auth.invalidate'}는 게이트웨이 토큰만 지운다(분당 상한). 응답은 없다.
// - 토큰·헤더·htu는 기록하지 않는다. 이벤트는 이름과 결과 코드만.
import { GATEWAY_ORIGIN, GATEWAY_PATHS } from '@sax/net';

/** 엔진이 보내는 것. */
export type GwAuthRequest = { t: 'gw.auth'; id: number; htm: string; htu: string } | { t: 'gw.auth.invalidate' };

/** 실패 코드. 엔진은 무엇이든 gateway.unavailable로 접는다(코드는 로컬 기록용). */
export type GwAuthCode = 'auth.denied' | 'auth.bad_request' | 'account.signed_out' | 'account.scope_unavailable' | 'auth.unavailable' | 'consent.model_declined';

/** main이 돌려주는 것. headers 키는 소문자 둘뿐이다. */
export type GwAuthResult = { t: 'gw.auth.result'; id: number; headers: { authorization: string; dpop: string } } | { t: 'gw.auth.result'; id: number; code: GwAuthCode };

/** DeviceSession 중 이 모듈이 쓰는 부분. */
export interface GatewayDevice {
  gatewayAuth(htm: 'POST', htu: string): Promise<Record<string, string>>;
  clearGatewayToken(): void;
}

export interface GatewayAuthHostOptions {
  /** 로그인(첫 PC 등록)을 마쳤으면 기기 세션, 아니면 null. 계정을 처음 읽는 중이면 기다린다. */
  device: () => GatewayDevice | null | Promise<GatewayDevice | null>;
  log?: (name: string, data: Record<string, string | number>) => void;
  now?: () => number;
  /** 헤더를 실제로 내준 경로(/v1/decide 등). 활동 기록이 "무엇을 우리 서버로 보냈나"를 사실대로 적는 근거다(값·헤더는 넘기지 않는다). */
  onIssued?: (path: string) => void;
  /**
   * 모델 처리 동의(온보딩 ②)를 지금 허락하는지. 거짓이면 어떤 경로든 헤더를 내주지 않는다(기기 토큰도 받지 않는다).
   * 게이트웨이(decide·run-tokens·respond)는 모두 모델 상류로 가므로 뿌리에서 막는다. 엔진은 gateway.unavailable로 접어 오프라인 해석으로 간다.
   * 없으면 늘 허락(시험·기존 호출).
   */
  modelAllowed?: () => boolean;
}

/** 엔진이 인증을 받을 수 있는 htu(정확히 같은 문자열만). /v1/biz/status는 엔진이 쓰지 않으니 넣지 않는다. */
export const GATEWAY_AUTH_HTU: ReadonlySet<string> = new Set(Object.values(GATEWAY_PATHS).map((p) => GATEWAY_ORIGIN + p));

/** invalidate 상한(1분에). 엔진이 401마다 한 번 보내고 한 번만 다시 하므로 정상이면 넘지 않는다. */
export const GW_INVALIDATE_PER_MIN = 6;

/** 로그인이 안 된 것으로 보는 오류 코드: 금고 키를 못 읽음(잠김·없음, shell-app keysOf), 서버가 이 PC 인증서를 거부함(계정·기기 없음). */
const SIGNED_OUT = new Set(['account.keys_unavailable', 'account.cert_invalid']);

const ID_MAX = 2 ** 31;

/**
 * auth 포트 메시지를 받은 순서대로 하나씩 처리한다(EngineHost가 쓴다).
 * 동시에 처리하면 401 뒤 invalidate와 재시도 gw.auth가 겹쳐 재시도가 지우기 전의 옛 토큰을 받는다(두 번째도 401).
 * 답하는 쪽(handler)이 아직 없으면 account.signed_out, 던지면 auth.unavailable. invalidate·모르는 메시지에는 답하지 않는다.
 */
export function authPortResponder(handler: () => ((m: unknown) => Promise<GwAuthResult | null>) | null, post: (r: GwAuthResult) => void): (m: unknown) => Promise<void> {
  let q: Promise<void> = Promise.resolve();
  const one = async (m: unknown): Promise<void> => {
    const req = m as { t?: unknown; id?: unknown } | null;
    const id = req?.t === 'gw.auth' && typeof req.id === 'number' && Number.isSafeInteger(req.id) ? req.id : null;
    const h = handler();
    let r: GwAuthResult | null;
    try {
      r = h ? await h(m) : id === null ? null : { t: 'gw.auth.result', id, code: 'account.signed_out' };
    } catch {
      r = id === null ? null : { t: 'gw.auth.result', id, code: 'auth.unavailable' };
    }
    if (r) post(r);
  };
  return (m) => (q = q.then(() => one(m)).catch(() => {}));
}

export class GatewayAuthHost {
  readonly #o: GatewayAuthHostOptions;
  readonly #now: () => number;
  #invalidations: number[] = [];

  constructor(o: GatewayAuthHostOptions) {
    this.#o = o;
    this.#now = o.now ?? Date.now;
  }

  /** 포트 메시지 하나를 처리한다. 답할 것이 없으면 null(invalidate·모르는 메시지). */
  async handle(raw: unknown): Promise<GwAuthResult | null> {
    const m = raw as Partial<{ t: unknown; id: unknown; htm: unknown; htu: unknown }> | null;
    if (!m || typeof m !== 'object') return null;
    if (m.t === 'gw.auth.invalidate') {
      await this.#invalidate();
      return null;
    }
    if (m.t !== 'gw.auth') return null;
    const id = m.id;
    if (typeof id !== 'number' || !Number.isSafeInteger(id) || id < 0 || id >= ID_MAX) return null;
    if (typeof m.htm !== 'string' || typeof m.htu !== 'string') return this.#fail(id, 'auth.bad_request');
    if (m.htm !== 'POST' || !GATEWAY_AUTH_HTU.has(m.htu)) return this.#fail(id, 'auth.denied');
    if (this.#o.modelAllowed && !this.#o.modelAllowed()) return this.#fail(id, 'consent.model_declined');
    let device: GatewayDevice | null;
    try {
      device = await this.#o.device();
    } catch {
      device = null;
    }
    if (!device) return this.#fail(id, 'account.signed_out');
    try {
      const h = await device.gatewayAuth('POST', m.htu);
      const authorization = h.Authorization;
      const dpop = h.DPoP;
      if (typeof authorization !== 'string' || typeof dpop !== 'string') return this.#fail(id, 'auth.unavailable');
      this.#o.onIssued?.(m.htu.slice(GATEWAY_ORIGIN.length));
      return { t: 'gw.auth.result', id, headers: { authorization, dpop } };
    } catch (e) {
      const code = (e as { code?: unknown }).code;
      if (code === 'account.scope_unavailable') return this.#fail(id, 'account.scope_unavailable');
      return this.#fail(id, typeof code === 'string' && SIGNED_OUT.has(code) ? 'account.signed_out' : 'auth.unavailable');
    }
  }

  async #invalidate(): Promise<void> {
    const now = this.#now();
    this.#invalidations = this.#invalidations.filter((t) => now - t < 60_000);
    if (this.#invalidations.length >= GW_INVALIDATE_PER_MIN) {
      this.#o.log?.('main.gw_auth_invalidate', { result: 'limited' });
      return;
    }
    this.#invalidations.push(now);
    (await Promise.resolve(this.#o.device()).catch(() => null))?.clearGatewayToken();
    this.#o.log?.('main.gw_auth_invalidate', { result: 'ok' });
  }

  #fail(id: number, code: GwAuthCode): GwAuthResult {
    this.#o.log?.('main.gw_auth', { result: code });
    return { t: 'gw.auth.result', id, code };
  }
}
