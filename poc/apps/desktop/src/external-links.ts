// 외부 주소 열기(D11 §4): 렌더러는 주소가 아니라 키만 보낸다. main이 내장 표에서 주소를 꺼내 https·사용자 정보 없음·포트 없음·허용 사이트를 본 뒤
// 기본 브라우저로 연다. 이 파일만 shell.openExternal을 부른다(tests/shell-harden.test.ts).
import { shell } from 'electron';

/** 키 → 주소. 홈택스 공동인증서 프로그램 설치 파일(공개 정적 파일 ML4Web_Config.js CS_DOWNLOAD_MAC·WIN, B4). */
export const EXTERNAL_LINKS = {
  'magicline.mac': 'https://hometax.go.kr/MagicLine4XML/ML4Web/install_bin/MagicLine4NX.pkg',
  'magicline.win': 'https://hometax.go.kr/MagicLine4XML/ML4Web/install_bin/magicline4nx_setup.exe',
} as const;
export type ExternalLinkKey = keyof typeof EXTERNAL_LINKS;
/** 열어도 되는 사이트(등록 도메인). 하위 도메인은 www만. */
const ALLOWED_SITES = ['hometax.go.kr'];

/** 키의 주소. 표에 없거나 규칙에 맞지 않으면 던진다. */
export function externalUrl(key: string): string {
  if (!Object.hasOwn(EXTERNAL_LINKS, key)) throw new Error('unknown_link');
  const u = new URL(EXTERNAL_LINKS[key as ExternalLinkKey]);
  const host = u.hostname.replace(/^www\./, '');
  if (u.protocol !== 'https:' || u.username || u.password || u.port || !ALLOWED_SITES.includes(host)) throw new Error('link_not_allowed');
  return u.href;
}

export async function openExternalKey(key: string): Promise<void> {
  await shell.openExternal(externalUrl(key));
}
