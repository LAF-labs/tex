// Vercel 함수: registry-cron(타임스탬프 자동 재서명). 조립은 services/registry/src/deploy.ts, 규칙은 resign.ts.
import { registryCronFunction } from '../../../registry/dist/index.js';

export default registryCronFunction();
