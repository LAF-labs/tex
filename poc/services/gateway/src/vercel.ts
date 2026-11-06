// 함수 진입점(Vercel, services/deploy/vercel/api/gateway.js). 환경 변수는 `GATEWAY__<이름>`(서비스별) 또는 접두 없는 공통 값.
// 마이그레이션은 배포 절차(supabase db push)가 하고 함수는 DDL을 하지 않는다. 정리는 플랫폼 cron이 /internal/v1/cron을 부른다.
import { functionEntry, requestListener, serviceEnv } from '@sax/svc-shared';
import { buildGateway } from './main.ts';

export function gatewayFunction(env: NodeJS.ProcessEnv = process.env) {
  const e = serviceEnv('GATEWAY', env);
  return functionEntry({
    cronSecret: env.CRON_SECRET,
    build: async () => {
      const b = await buildGateway(e, {}, { migrate: false });
      return { listener: requestListener(b.router, { logger: b.logger, trustProxy: e.TRUST_PROXY === '1' }), sweep: b.sweep };
    },
  });
}
