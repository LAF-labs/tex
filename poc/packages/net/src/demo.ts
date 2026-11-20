import type { GatewayDecideBody } from './model-guard.ts';
import { Egress, EgressError, type Destination, type DestinationName, type EgressOptions, type EgressResponse } from './egress.ts';

export const DEMO_DESTINATIONS = {
  openrouter: { origin: 'https://openrouter.ai', paths: ['/api/v1/chat/completions'] },
} as const satisfies Record<string, Destination>;

export type DemoDestinationName = keyof typeof DEMO_DESTINATIONS;
export const COMPAT_CHAT_PATH = '/api/v1/chat/completions';

export interface CompatModelRequest {
  surface: 'decide';
  gateway: GatewayDecideBody;
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
