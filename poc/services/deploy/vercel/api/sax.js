// Vercel 함수: sax. 빌드(pnpm build)가 만든 dist를 쓴다. 조립은 services/cloud/src/index.ts.
import { cloudFunction } from '../../../cloud/dist/index.js';

export default cloudFunction();
