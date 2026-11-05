// 폰 장기 키(Sm·Vm·Km)와 로컬 파일 키. ADR-029·D08 §2: ThisDeviceOnly, 백업 제외, 서버는 열쇠를 갖지 않는다.
//  - 한 SecureStore 항목에 모두 담고, 그 항목은 생체 인증(iOS biometryCurrentSet, Android Keystore 사용자 인증)으로만 열린다.
//    앱 잠금(P-01) 해제 = 이 항목 읽기다. 생체 없이 키를 꺼낼 길이 없다.
//  - iOS: WHEN_PASSCODE_SET_THIS_DEVICE_ONLY. 폰 암호를 끄면 항목이 지워진다. 저장이 실패하면 약한 등급으로 내려가지 않는다.
//  - 재설치: iOS 키체인은 앱 삭제 뒤에도 남으므로, 문서 폴더의 설치 표지가 없으면 첫 실행에서 지운다.
// 비밀 값·키 바이트를 로그에 넣지 않는다.
import * as SecureStore from 'expo-secure-store';
import { b64, ed25519Keygen, ed25519Public, fromB64, newFileKey, uuid4, wipe, x25519Keygen, x25519Public } from '@sax/remote';
import { DEV_LOCAL } from './config';
import { installMarker, wipeAppData, writeInstallMarker } from './storage/files';

const ITEM = 'sax.device.v1';
const SERVICE = 'com.lafco.tex.keys';

export type KeyringErrorCode = 'passcode_required' | 'biometry_required' | 'cancelled' | 'corrupt' | 'unavailable';
export class KeyringError extends Error {
  readonly code: KeyringErrorCode;
  /** 원인 문구(OS 오류 코드 등, 값·키 없음). */
  constructor(code: KeyringErrorCode, cause?: string) {
    super(cause ? `keyring: ${code} (${cause.slice(0, 160)})` : `keyring: ${code}`);
    this.code = code;
  }
}

/** 메모리에 있는 동안만 살아 있다. 잠그면 forget()으로 지운다. */
export interface DeviceKeys {
  deviceId: string;
  sm: Uint8Array;
  vm: Uint8Array;
  km: Uint8Array;
  fileKey: Uint8Array;
  smPub: Uint8Array;
  vmPub: Uint8Array;
  kmPub: Uint8Array;
}

interface Stored {
  v: 1;
  deviceId: string;
  sm: string;
  vm: string;
  km: string;
  fileKey: string;
}

const AUTH_PROMPT = '앱을 열려면 확인해 주세요';

/** 실기기·릴리스: 생체 + 암호 설정 + 이 기기만. 시뮬레이터 개발 빌드만 생체 없이(여전히 이 기기만). */
function options(): SecureStore.SecureStoreOptions {
  if (DEV_LOCAL) return { keychainService: SERVICE, keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY, requireAuthentication: false };
  return {
    keychainService: SERVICE,
    keychainAccessible: SecureStore.WHEN_PASSCODE_SET_THIS_DEVICE_ONLY,
    requireAuthentication: true,
    authenticationPrompt: AUTH_PROMPT,
  };
}

/** 첫 실행(재설치 포함)이면 남은 키체인 항목과 앱 데이터를 지운다. 설치 표지가 있으면 아무것도 하지 않는다. */
export async function ensureFreshInstall(): Promise<{ hasDevice: boolean }> {
  const m = installMarker();
  if (m) return { hasDevice: !!m.deviceId };
  await SecureStore.deleteItemAsync(ITEM, { keychainService: SERVICE }).catch(() => {});
  wipeAppData();
  await writeInstallMarker({ installedAt: Date.now() });
  return { hasDevice: false };
}

function classify(e: unknown): KeyringError {
  const raw = String((e as { message?: string })?.message ?? e);
  const msg = raw.toLowerCase();
  if (msg.includes('cancel')) return new KeyringError('cancelled', raw);
  if (msg.includes('passcode') || msg.includes('-25293')) return new KeyringError('passcode_required', raw);
  if (msg.includes('biometr') || msg.includes('authentication')) return new KeyringError('biometry_required', raw);
  return new KeyringError('unavailable', raw);
}

function expand(s: Stored): DeviceKeys {
  const sm = fromB64(s.sm);
  const vm = fromB64(s.vm);
  const km = fromB64(s.km);
  const fileKey = fromB64(s.fileKey);
  if (sm.length !== 32 || vm.length !== 32 || km.length !== 32 || fileKey.length !== 32) throw new KeyringError('corrupt');
  return { deviceId: s.deviceId, sm, vm, km, fileKey, smPub: x25519Public(sm), vmPub: ed25519Public(vm), kmPub: x25519Public(km) };
}

/** 첫 실행: 키를 만들어 저장한다. 저장 실패는 그대로 던진다(대체 저장소 없음). */
export async function createDevice(): Promise<DeviceKeys> {
  if (!DEV_LOCAL && !SecureStore.canUseBiometricAuthentication()) throw new KeyringError('biometry_required');
  const s = x25519Keygen();
  const v = ed25519Keygen();
  const k = x25519Keygen();
  const stored: Stored = { v: 1, deviceId: uuid4(), sm: b64(s.secretKey), vm: b64(v.secretKey), km: b64(k.secretKey), fileKey: b64(newFileKey()) };
  try {
    await SecureStore.setItemAsync(ITEM, JSON.stringify(stored), options());
  } catch (e) {
    throw classify(e);
  } finally {
    wipe(s.secretKey);
    wipe(v.secretKey);
    wipe(k.secretKey);
  }
  await writeInstallMarker({ installedAt: installMarker()?.installedAt ?? Date.now(), deviceId: stored.deviceId });
  return expand(stored);
}

/** 잠금 해제: 생체 인증으로 항목을 읽는다. 취소하면 KeyringError('cancelled'). */
export async function unlock(): Promise<DeviceKeys> {
  let raw: string | null;
  try {
    raw = await SecureStore.getItemAsync(ITEM, options());
  } catch (e) {
    throw classify(e);
  }
  if (!raw) throw new KeyringError('corrupt');
  let s: Stored;
  try {
    s = JSON.parse(raw) as Stored;
  } catch {
    throw new KeyringError('corrupt');
  }
  if (s.v !== 1) throw new KeyringError('corrupt');
  return expand(s);
}

export function forget(k: DeviceKeys | null): void {
  if (!k) return;
  wipe(k.sm);
  wipe(k.vm);
  wipe(k.km);
  wipe(k.fileKey);
}

/** 분실·해제 뒤 이 폰을 초기화한다(키·앱 데이터 삭제). */
export async function resetDevice(): Promise<void> {
  await SecureStore.deleteItemAsync(ITEM, { keychainService: SERVICE }).catch(() => {});
  wipeAppData();
  await writeInstallMarker({ installedAt: Date.now() });
}

/** SP-1 진단용: 항목 속성만 보고한다(값 없음). */
export function keyringPolicy(): { accessible: string; biometric: boolean; service: string } {
  const o = options();
  const names: Record<number, string> = {
    [SecureStore.WHEN_PASSCODE_SET_THIS_DEVICE_ONLY]: 'WHEN_PASSCODE_SET_THIS_DEVICE_ONLY',
    [SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY]: 'WHEN_UNLOCKED_THIS_DEVICE_ONLY',
  };
  return { accessible: names[o.keychainAccessible ?? -1] ?? 'other', biometric: o.requireAuthentication === true, service: SERVICE };
}

