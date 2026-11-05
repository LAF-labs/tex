// 앱 내장 값. 릴레이 허용 목록은 바이너리에 고정한다(OTA 없음, ADR-028 앱 채널 = 스토어 서명 빌드만, D01 §6).
import * as Device from 'expo-device';

export const APP_VERSION = '0.1.0';
export const RELAY_ALLOWLIST: readonly string[] = ['relay.tex.laf-co.com'];

/** 시뮬레이터 개발 빌드만 참이다. 릴리스 빌드(__DEV__ = false)와 실기기에서는 항상 거짓. */
export const DEV_LOCAL: boolean = __DEV__ && !Device.isDevice;
export const DEV_RELAY_HOST = 'localhost:8787';

/**
 * 계정·릴레이 공개 origin(DPoP htu 앞부분, 팀장 결정 2026-11-05: 둘 다 https://tax.laf-co.com, 경로는 services API.md).
 * 릴리스 빌드 설정의 자리만 둔다. 값은 배포 때 넣는다. 비어 있으면 릴리스 빌드는 연결하지 않는다.
 */
export const PUBLIC_ORIGIN: string = '';

export const relayAllowlist = (): readonly string[] => (DEV_LOCAL ? [...RELAY_ALLOWLIST, DEV_RELAY_HOST] : RELAY_ALLOWLIST);

/** P-01: 백그라운드 30초 뒤 다시 잠근다. */
export const LOCK_AFTER_MS = 30_000;
/** 잠글 때 진행 중 저장·전송을 기다리는 최대 시간. 그 뒤에는 키를 지우고 남은 작업은 봉인하지 못하고 실패한다. */
export const LOCK_DRAIN_MS = 15_000;
/** 앱이 앞에 있는 동안 PC 연결을 다시 시도하는 간격. */
export const RECONNECT_MS = 60_000;
/** 사진 긴 변 상한(4 MiB 상한 안에 들도록). */
export const PHOTO_MAX_EDGE = 2400;
export const PHOTO_QUALITY = 0.85;
