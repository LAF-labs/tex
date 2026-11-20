
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);
const MDNS_LOCAL = /^[a-z0-9-]{1,63}\.local$/i;
let lan = false;

/** 개발 빌드만 부른다. 한 번 켜면 프로세스가 끝날 때까지 유지한다(시험은 false로 되돌린다). */
export function allowDevLanHosts(on: boolean): void {
  lan = on;
}

export const devLanHostsAllowed = (): boolean => lan;

/** 포트를 뺀 호스트 이름이 평문 개발 호스트인지. */
export function isDevPlainHost(hostname: string): boolean {
  return LOOPBACK.has(hostname) || (lan && MDNS_LOCAL.test(hostname));
}
