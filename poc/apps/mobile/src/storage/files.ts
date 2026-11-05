// 앱 데이터 폴더. 문서 폴더 아래 sax/ 하나에 모은다: 파일 보호 등급 Complete(iOS 기본 등급 entitlement + 파일마다 지정)와
// 백업 제외(isExcludedFromBackup, Android는 allowBackup=false·dataExtractionRules 전부 제외). 카메라 롤·갤러리는 쓰지 않는다.
// 보호 지정이 안 되는 환경(네이티브 모듈 없음)에서는 저장을 거부한다.
import { Directory, File, Paths } from 'expo-file-system';
import SaxNative, { type PathProtection } from '../../modules/sax-native/src/SaxNativeModule';

export const ROOT = new Directory(Paths.document, 'sax');
const MARKER = new File(Paths.document, 'sax-install.json');

export class ProtectionError extends Error {
  constructor() {
    super('files: protection unavailable');
  }
}

export interface InstallMarker {
  installedAt: number;
  deviceId?: string;
}

export function installMarker(): InstallMarker | null {
  try {
    if (!MARKER.exists) return null;
    return JSON.parse(MARKER.textSync()) as InstallMarker;
  } catch {
    return null;
  }
}

/** 표지도 백업에서 뺀다(복원된 폰에서 키체인 없이 표지만 남지 않게). */
export async function writeInstallMarker(m: InstallMarker): Promise<void> {
  MARKER.write(JSON.stringify(m));
  await protect(MARKER.uri);
}

export function wipeAppData(): void {
  if (ROOT.exists) ROOT.delete();
}

/** 보호 지정. iOS는 파일 보호 Complete + 백업 제외, Android는 앱 전용 폴더(백업 규칙으로 제외). */
export async function protect(uri: string): Promise<PathProtection> {
  if (!SaxNative) throw new ProtectionError();
  const p = await SaxNative.protectPath(uri);
  if (!p.excludedFromBackup) throw new ProtectionError();
  return p;
}

export async function inspect(uri: string): Promise<PathProtection | null> {
  return SaxNative ? SaxNative.inspectPath(uri) : null;
}

export async function ensureDir(d: Directory): Promise<Directory> {
  if (!d.exists) d.create({ intermediates: true, idempotent: true });
  await protect(d.uri);
  return d;
}

/** 쓰고 나서 바로 보호 지정. 실패하면 파일을 지운다. */
export async function writeProtected(f: File, bytes: Uint8Array): Promise<void> {
  await ensureDir(f.parentDirectory);
  f.write(bytes);
  try {
    await protect(f.uri);
  } catch (e) {
    f.delete();
    throw e;
  }
}

export function deleteQuietly(uri: string | null | undefined): void {
  if (!uri) return;
  try {
    const f = new File(uri);
    if (f.exists) f.delete();
  } catch {
    /* 이미 없음 */
  }
}

/**
 * 촬영 임시 파일(카메라·자르기 결과, 봉인 전 평문 JPEG)이 남는 캐시 폴더를 비운다. 앱 시작 때와 촬영 화면을 떠날 때 부른다.
 * 정상 흐름은 촬영 화면이 파일마다 지우고, 이것은 앱이 백그라운드에서 종료되는 등 그 자리를 건너뛴 경우를 덮는다.
 */
export const CAPTURE_CACHE_DIRS = ['Camera', 'ImageManipulator'] as const;
export function sweepCaptureTemps(): void {
  for (const name of CAPTURE_CACHE_DIRS) {
    try {
      const d = new Directory(Paths.cache, name);
      if (!d.exists) continue;
      for (const c of d.list()) {
        try {
          c.delete();
        } catch {
          /* 다음 시작 때 다시 */
        }
      }
    } catch {
      /* 폴더 없음 */
    }
  }
}
