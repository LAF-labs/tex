// 외부 주소 열기(D11 §4): 렌더러는 주소가 아니라 키만 보낸다. main이 내장 표에서 주소를 꺼내 https·사용자 정보 없음·포트 없음·허용 사이트를 본 뒤
// 기본 브라우저로 연다. 이 파일만 shell.openExternal을 부른다(tests/shell-harden.test.ts).
import { shell } from 'electron';

/** 키 → 주소. 홈택스 공동인증서 프로그램 설치 파일(공개 정적 파일 ML4Web_Config.js CS_DOWNLOAD_MAC·WIN, B4). */
export const EXTERNAL_LINKS = {
  'magicline.mac': 'https://hometax.go.kr/MagicLine4XML/ML4Web/install_bin/MagicLine4NX.pkg',
  'magicline.win': 'https://hometax.go.kr/MagicLine4XML/ML4Web/install_bin/magicline4nx_setup.exe',
  // 이용약관·개인정보 처리방침(F-06): 사이트 정적 페이지(services/deploy/vercel/public/terms·privacy)
  'legal.terms': 'https://tax.laf-co.com/terms',
  'legal.privacy': 'https://tax.laf-co.com/privacy',
} as const;
export type ExternalLinkKey = keyof typeof EXTERNAL_LINKS;
/** 열어도 되는 호스트. 하위 도메인은 www만(tax.laf-co.com은 그 호스트 그대로). */
const ALLOWED_SITES = ['hometax.go.kr', 'tax.laf-co.com'];

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

/**
 * 구독 결제 창(계정 서비스 /v1/billing/card?ref=…)을 기본 브라우저로 연다. 주소는 main이 계정 서비스에서 받은 것만(렌더러는 주소를 보내지 않는다).
 * 운영 origin(https, 포트·사용자 정보 없음)이나 개발 스택(http://localhost) 계정 origin과 정확히 맞아야 한다.
 */
function billingCheckoutUrl(url: string, accountOrigin: string): string {
  const u = new URL(url);
  const o = new URL(accountOrigin);
  const devLocal = o.protocol === 'http:' && (o.hostname === 'localhost' || o.hostname === '127.0.0.1');
  if (u.origin !== o.origin || u.pathname !== '/v1/billing/card' || u.username || u.password || u.hash) throw new Error('link_not_allowed');
  if (!devLocal && (u.protocol !== 'https:' || u.port)) throw new Error('link_not_allowed');
  if (![...u.searchParams.keys()].every((k) => k === 'ref') || !/^cus_[A-Za-z0-9_-]{24}$/.test(u.searchParams.get('ref') ?? '')) throw new Error('link_not_allowed');
  return u.href;
}

export async function openBillingCheckout(url: string, accountOrigin: string): Promise<void> {
  await shell.openExternal(billingCheckoutUrl(url, accountOrigin));
}
