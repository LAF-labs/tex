import { NativeModule, requireOptionalNativeModule } from 'expo';

export interface PathProtection {
  excludedFromBackup: boolean;
  /** iOS: FileProtectionType 원문(예: NSFileProtectionComplete), Android: app_private */
  protection: string;
}

declare class SaxNativeModule extends NativeModule<Record<string, never>> {
  protectPath(uri: string): Promise<PathProtection>;
  inspectPath(uri: string): Promise<PathProtection>;
  ocrAvailable(): boolean;
  recognizeText(uri: string): Promise<string[]>;
}

/** 네이티브 빌드에만 있다. 없으면 null이고, 호출하는 쪽은 사진을 저장하지 않는다(fail-closed). */
export default requireOptionalNativeModule<SaxNativeModule>('SaxNative');
