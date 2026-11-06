// Vercel 함수: push 서비스. 빌드(pnpm build)가 만든 dist를 쓴다. 조립은 services/push/src/vercel.ts.
import { pushFunction } from '../../../push/dist/vercel.js';

export default pushFunction();
