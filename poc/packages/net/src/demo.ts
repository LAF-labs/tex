// 시연·측정 전용 송신(ADR-035 W-5). 제품 Egress(@sax/net)에는 없는 OpenRouter 목적지를 이 하위 경로(@sax/net/demo)만 연다.
// 린트(eslint.config.mjs)가 이 경로의 import를 시연 파일(apps/desktop/src/demo-*.ts)·scripts·tests로만 제한한다.
// - postJson('openrouter', …): 시연 채팅 해석(SAX_DEMO_MODEL=openrouter, fixture 모드만, reports/demo-meeting.md §예외).
// - toCompatModel(): 측정 스크립트(S7·S9 실측)의 OpenAI 호환 Chat Completions 판정. BYOK와 같은 ModelGuard 검사
//   (스키마·허용 목록·입력 한도·이미지·트립와이어·발급 영수증·예산)를 통과해야 나간다.
import type { GatewayDecideBody } from './model-guard.ts';
import { Egress, EgressError, type Destination, type DestinationName, type EgressOptions, type EgressResponse } from './egress.ts';

export const DEMO_DESTINATIONS = {
  openrouter: { origin: 'https://openrouter.ai', paths: ['/api/v1/chat/completions'] },
} as const satisfies Record<string, Destination>;

export type DemoDestinationName = keyof typeof DEMO_DESTINATIONS;
export const COMPAT_CHAT_PATH = '/api/v1/chat/completions';

export interface CompatModelRequest {
  surface: 'decide';
  /** ModelGuard 검사에 쓰는 게이트웨이 모양 본문(입력·runToken·번들 다이제스트) */
  gateway: GatewayDecideBody;
  /** 실제로 나갈 Chat Completions 본문 */
  providerBody: object;
}

export class DemoEgress extends Egress {
  constructor(opts: EgressOptions = {}) {
    super(opts);
  }

  protected override destinationOf(dest: string): Destination | undefined {
    return super.destinationOf(dest) ?? (Object.hasOwn(DEMO_DESTINATIONS, dest) ? (DEMO_DESTINATIONS[dest as DemoDestinationName] as Destination) : undefined);
  }

  override postJson(dest: DestinationName | DemoDestinationName, path: string, body: unknown, headers: Record<string, string> = {}): Promise<EgressResponse> {
    return super.postJson(dest as DestinationName, path, body, headers);
  }

  /** 측정용 판정 송신. 검사 통과 후에만 OpenRouter로 나가고, 진단에는 목적지·경로·상태·지연만 남긴다. */
  async toCompatModel(req: CompatModelRequest, headers: Record<string, string>): Promise<EgressResponse> {
    if (this.envTampered.length) throw new EgressError('egress_env_tampered');
    if (!this.guard) throw new EgressError('destination_not_allowed');
    this.guard.check('decide', req.gateway, req.providerBody);
    const started = performance.now();
    try {
      const r = await this.postJson('openrouter', COMPAT_CHAT_PATH, req.providerBody, headers);
      this.modelAudit.push({ dest: 'openrouter', path: COMPAT_CHAT_PATH, status: r.status, ms: performance.now() - started, rateLimit: {} });
      return r;
    } catch (e) {
      this.modelAudit.push({ dest: 'openrouter', path: COMPAT_CHAT_PATH, status: 'error', ms: performance.now() - started, rateLimit: {} });
      throw e;
    }
  }
}
