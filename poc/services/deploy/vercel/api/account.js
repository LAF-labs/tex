// Vercel 함수: account 서비스. 빌드(pnpm build)가 만든 dist를 쓴다. 조립은 services/account/src/vercel.ts.
import { accountFunction } from '../../../account/dist/vercel.js';

export default accountFunction();
