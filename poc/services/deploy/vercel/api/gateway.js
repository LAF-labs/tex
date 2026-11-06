// Vercel 함수: gateway 서비스. 빌드(pnpm build)가 만든 dist를 쓴다. 조립은 services/gateway/src/vercel.ts.
import { gatewayFunction } from '../../../gateway/dist/vercel.js';

export default gatewayFunction();
