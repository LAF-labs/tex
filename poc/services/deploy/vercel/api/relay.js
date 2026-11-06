// Vercel 함수: relay 서비스. 빌드(pnpm build)가 만든 dist를 쓴다. 조립은 services/relay/src/vercel.ts.
import { relayFunction } from '../../../relay/dist/vercel.js';

export default relayFunction();
