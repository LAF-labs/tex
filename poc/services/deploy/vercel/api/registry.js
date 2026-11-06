// Vercel 함수: registry(투명성 로그 GET·게시 PUT). 빌드(pnpm build)가 만든 dist를 쓴다. 조립은 services/registry/src/deploy.ts.
// 공개 정적 파일(/registry/*·/policy/*·/packages/*·/releases/*)은 이 함수를 거치지 않는다(vercel.json 외부 재작성 → 공개 버킷).
import { registryFunction } from '../../../registry/dist/index.js';

export default registryFunction();
