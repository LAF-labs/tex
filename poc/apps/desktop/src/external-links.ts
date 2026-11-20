import { shell } from 'electron';

export const EXTERNAL_LINKS = {
  'magicline.mac': 'https://hometax.go.kr/MagicLine4XML/ML4Web/install_bin/MagicLine4NX.pkg',
  'magicline.win': 'https://hometax.go.kr/MagicLine4XML/ML4Web/install_bin/magicline4nx_setup.exe',
  'legal.terms': 'https://tax.laf-co.com/terms',
  'legal.privacy': 'https://tax.laf-co.com/privacy',
} as const;
export type ExternalLinkKey = keyof typeof EXTERNAL_LINKS;
const ALLOWED_SITES = ['hometax.go.kr', 'tax.laf-co.com'];

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
