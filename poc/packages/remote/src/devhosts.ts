// 평문(http/ws) 개발 호스트 판정. localhost 계열은 늘 개발 호스트이고, 같은 LAN의 mDNS `<이름>.local`은 개발 빌드가 명시적으로
// 켰을 때만이다(팀장 지시 2026-11-06, #124). 기본은 꺼짐이라 릴리스 빌드(앱이 켜지 않음)에서는 *.local도 평문을 받지 않는다.
// 켜는 곳: 앱 config(__DEV__ && 실기기 && EXPO_PUBLIC_TEX_DEV_HOST), dev/stack.ts(STACK_HOST가 .local일 때).

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
