// 앱 내장 값. 릴레이 허용 목록은 바이너리에 고정한다(OTA 없음, ADR-028 앱 채널 = 스토어 서명 빌드만, D01 §6).
import * as Device from 'expo-device';

export const APP_VERSION = '0.1.0';
export const RELAY_ALLOWLIST: readonly string[] = ['relay.tex.laf-co.com'];

/** 시뮬레이터 개발 빌드만 참이다. 릴리스 빌드(__DEV__ = false)와 실기기에서는 항상 거짓. */
export const DEV_LOCAL: boolean = __DEV__ && !Device.isDevice;
export const DEV_RELAY_HOST = 'localhost:8787';

export const relayAllowlist = (): readonly string[] => (DEV_LOCAL ? [...RELAY_ALLOWLIST, DEV_RELAY_HOST] : RELAY_ALLOWLIST);

/** P-01: 백그라운드 30초 뒤 다시 잠근다. */
export const LOCK_AFTER_MS = 30_000;
/** 앱이 앞에 있는 동안 PC 연결을 다시 시도하는 간격. */
export const RECONNECT_MS = 60_000;
/** 사진 긴 변 상한(4 MiB 상한 안에 들도록). */
export const PHOTO_MAX_EDGE = 2400;
export const PHOTO_QUALITY = 0.85;
