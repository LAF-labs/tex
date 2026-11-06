// 앱 내장 값. 개발 스택 판정은 devhost.ts(순수 함수, 릴리스 거절 시험 대상)에 있다.
import * as Device from 'expo-device';
import { allowDevLanHosts } from '@sax/remote';
import { RELAY_ALLOWLIST, resolveDevConfig } from './devhost';

export { RELAY_ALLOWLIST };
export const APP_VERSION = '0.1.0';

/**
 * EXPO_PUBLIC_TEX_DEV_HOST=<소문자 LocalHostName>.local:8787 은 실기기 개발 빌드가 붙을 맥의 개발 스택이다(Metro를 띄울 때 넣으면
 * Expo가 번들 때 값을 박는다). __DEV__가 거짓이면 무시한다.
 */
const DEV = resolveDevConfig({ isDev: __DEV__, isDevice: Device.isDevice, envHost: process.env.EXPO_PUBLIC_TEX_DEV_HOST });
// mDNS 평문(http/ws <이름>.local)은 실기기 개발 빌드만 켠다. 릴리스·시뮬레이터에서는 꺼진 채로 둔다.
allowDevLanHosts(DEV.allowLan);

/** 시뮬레이터 개발 빌드만 참. 시뮬레이터 전용 완화(생체 인증 없는 키, 견본 영수증 카메라)를 켠다. 실기기·릴리스에서는 늘 거짓. */
export const DEV_LOCAL: boolean = DEV.devLocal;
/** 개발 스택(계정·릴레이·더미 PC)에 붙는 개발 빌드: 시뮬레이터, 또는 EXPO_PUBLIC_TEX_DEV_HOST를 넣은 실기기. */
export const DEV_STACK: boolean = DEV.devStack;
export const DEV_RELAY_HOST: string = DEV.devRelayHost;

/**
 * 계정·릴레이 공개 origin(DPoP htu 앞부분, 팀장 결정 2026-11-05: 둘 다 https://tax.laf-co.com, 경로는 services API.md).
 * 릴리스 빌드 설정의 자리만 둔다. 값은 배포 때 넣는다. 비어 있으면 릴리스 빌드는 연결하지 않는다.
 */
export const PUBLIC_ORIGIN: string = '';

/**
 * acct_claim(설계 #120) 서명을 검증할 계정 서비스 공개키. 릴리스 키는 클라우드 세션이 만들면 넣는다. 비어 있으면 페어링은 늘 실패한다.
 * 개발 스택에서는 시험 키(dev/test-account-key.ts)만 쓴다. 릴리스 빌드에는 시험 키가 들어가지 않는다(DEV_STACK은 __DEV__에서만 참).
 */
const RELEASE_ACCOUNT_KEYS: readonly string[] = [];
const DEV_ACCOUNT_KEY = '3uABVr6gwZIYy5ir9UMb2ohr2fxONenkzT9XtRRIBCY=';
export const accountKeys = (): readonly string[] => (DEV_STACK ? [DEV_ACCOUNT_KEY] : RELEASE_ACCOUNT_KEYS);

export const relayAllowlist = (): readonly string[] => DEV.relayAllowlist;

/** P-01: 백그라운드 30초 뒤 다시 잠근다. */
export const LOCK_AFTER_MS = 30_000;
/** 잠글 때 진행 중 저장·전송을 기다리는 최대 시간. 그 뒤에는 키를 지우고 남은 작업은 봉인하지 못하고 실패한다. */
export const LOCK_DRAIN_MS = 15_000;
/** 앱이 앞에 있는 동안 PC 연결을 다시 시도하는 간격. */
export const RECONNECT_MS = 60_000;
/** 사진 긴 변 상한(4 MiB 상한 안에 들도록). */
export const PHOTO_MAX_EDGE = 2400;
export const PHOTO_QUALITY = 0.85;
