// 빌드 종류에 따른 개발 스택 판정(순수 함수, RN 의존 없음 — tests/remote-devhost-release.test.ts가 직접 부른다).
// 릴리스(__DEV__ = false)에서는 무엇을 넣어도 개발 호스트를 쓰지 않고, 릴레이 허용 목록은 바이너리 고정 값뿐이며, mDNS 평문도 켜지 않는다.

/** 릴레이 허용 목록은 바이너리에 고정한다(OTA 없음, ADR-028 앱 채널 = 스토어 서명 빌드만, D01 §6). */
export const RELAY_ALLOWLIST: readonly string[] = ['relay.tex.laf-co.com'];
const SIM_DEV_HOST = 'localhost:8787';

/**
 * acct_claim(설계 #120, SIGNING.md §8) 서명을 검증할 운영 계정 서비스(tax.laf-co.com) 공개키, 표준 base64. 앱에 고정한다.
 * 2026-11-06 회전된 값(팀장 전달). 운영 ACCT_CLAIM_SIGNING_KEY에서 services/account/src/acct-claim-pubkey-cli.ts로 뽑은 값과 같아야 한다.
 * 교체는 레지스트리 핀 키 규칙(keyEpoch, ADR-028 결정 3): 새 키를 앞에 더하고 옛 키는 회전이 끝난 뒤 뺀다.
 */
export const RELEASE_ACCOUNT_KEYS: readonly string[] = ['m505XiZjib3UhZGHVJKoS7FZ3FdVOJ0aS/XFpN4zPYQ='];
/** 개발 스택 시험 키(dev/test-account-key.ts). 릴리스 빌드에서는 쓰지 않는다. */
export const DEV_ACCOUNT_KEY = '3uABVr6gwZIYy5ir9UMb2ohr2fxONenkzT9XtRRIBCY=';

export interface DevConfig {
  /** 시뮬레이터 개발 빌드: 시뮬레이터 전용 완화(생체 없는 키·견본 카메라). */
  devLocal: boolean;
  /** 개발 스택(계정·릴레이·더미 PC)에 붙는다: 시뮬레이터, 또는 EXPO_PUBLIC_TEX_DEV_HOST를 넣은 실기기 개발 빌드. */
  devStack: boolean;
  devRelayHost: string;
  /** 같은 LAN mDNS(<이름>.local) 평문 허용(@sax/remote allowDevLanHosts). 실기기 개발 빌드만. */
  allowLan: boolean;
  relayAllowlist: readonly string[];
  /** acct_claim을 검증할 계정 서비스 공개키. 개발 스택이면 시험 키만, 아니면 운영 키만(섞지 않는다). */
  accountKeys: readonly string[];
}

export function resolveDevConfig(e: { isDev: boolean; isDevice: boolean; envHost: string | undefined }): DevConfig {
  const devLocal = e.isDev && !e.isDevice;
  const deviceHost = e.isDev && e.isDevice && typeof e.envHost === 'string' && /^[a-z0-9-]{1,63}\.local:\d{1,5}$/.test(e.envHost) ? e.envHost : null;
  const devStack = devLocal || deviceHost !== null;
  const devRelayHost = deviceHost ?? SIM_DEV_HOST;
  return {
    devLocal, devStack, devRelayHost, allowLan: deviceHost !== null,
    relayAllowlist: devStack ? [...RELAY_ALLOWLIST, devRelayHost] : RELAY_ALLOWLIST,
    accountKeys: devStack ? [DEV_ACCOUNT_KEY] : RELEASE_ACCOUNT_KEYS,
  };
}
