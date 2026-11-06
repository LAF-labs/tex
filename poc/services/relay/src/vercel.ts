// 함수 진입점(Vercel, services/deploy/vercel/api/relay.js). 환경 변수는 `RELAY__<이름>`(서비스별) 또는 접두 없는 공통 값.
// 마이그레이션은 배포 절차(supabase db push)가 하고 함수는 DDL을 하지 않는다. 정리는 플랫폼 cron이 /internal/v1/cron을 부른다.
import { functionEntry, requestListener, serviceEnv } from '@sax/svc-shared';
import { buildRelay } from './main.ts';

export function relayFunction(env: NodeJS.ProcessEnv = process.env) {
  const e = serviceEnv('RELAY', env);
  return functionEntry({
    cronSecret: env.CRON_SECRET,
    build: async () => {
      const b = await buildRelay(e, { migrate: false, stateful: false });
      return { listener: requestListener(b.hub.router, { logger: b.logger, trustProxy: e.TRUST_PROXY === '1' }), sweep: b.sweep };
    },
  });
}
