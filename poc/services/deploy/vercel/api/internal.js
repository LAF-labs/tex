// Vercel 함수: internal. 빌드(pnpm build)가 만든 dist를 쓴다. 조립은 services/cloud/src/index.ts.
import { internalFunction } from '../../../cloud/dist/index.js';

export default internalFunction();
