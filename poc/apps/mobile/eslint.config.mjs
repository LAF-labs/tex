// 폰 앱: poc 루트 규칙을 그대로 쓰고, 생성되는 네이티브 폴더(ios·android, git 제외)와 Expo 캐시만 뺀다.
// ESLint 10은 파일마다 가까운 설정을 찾으므로 루트 `pnpm lint`도 이 설정으로 apps/mobile을 검사한다.
import root from '../../eslint.config.mjs';

export default [{ ignores: ['ios/**', 'android/**', '.expo/**', 'dev/out/**'] }, ...root];
