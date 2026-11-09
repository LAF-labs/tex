// 실행 시작 패키지 공급(PR-D2 앞부분, D03 §3.1): RegistrySync가 받아 둔 설치본을 실행을 시작할 때마다 loadPackage로 다시 검증해
// RunService의 IrPackage로 만든다. 네트워크는 쓰지 않는다(받기는 RegistrySync.sync). 로그에는 코드만 남긴다.
import type { RunToken } from '@sax/model';
import type { PdfPort } from './core/savepdf.ts';
import type { Judge } from './l0/judge.ts';
import type { LookupDef, PortalConfig } from './portal.ts';
import type { InstalledPackage } from './registry-sync.ts';
import type { IrSourceResult } from './run/service-ir.ts';

/**
 * 조회 하위 패키지 id → 포털 조회 화면 정의(PopupLookupPort). H-01의 조회 패키지 두 개는 `<portal.kind>.invoice.lookup`(발급 목록)과
 * `<portal.kind>.invoice.email_status`(메일 발송 상태)다(fixture·hometax 같은 이름 규칙, 제품 원본 packages/engine/playbooks).
 */
export function portalLookupDefs(portal: PortalConfig): Map<string, LookupDef> {
  return new Map([
    [`${portal.kind}.invoice.lookup`, portal.invoiceLookup],
    [`${portal.kind}.invoice.email_status`, portal.mailLookup],
  ]);
}

export interface InstalledIrSourceOptions {
  /** 실행할 플레이북 id(RegistrySyncOptions.packages.ids 중 하나). */
  id: string;
  portal: PortalConfig;
  judge?: Pick<Judge, 'decide'>;
  pdf?: PdfPort;
  runToken?: RunToken;
  runTokenFor?: (runId: string) => Promise<RunToken>;
}

/**
 * RunServiceDeps.irSource. 부를 때마다 설치본을 다시 로드한다(설치 뒤 폐기된 키·바뀐 저장 바이트를 실행 전에 잡는다).
 * 패키지의 portal이 이 RunService 포털과 다르면 package.portal_mismatch, 조회 패키지가 포털 조회 정의에 없으면 package.lookup_undefined.
 */
export function installedIrSource(registry: { loadInstalled(id: string): InstalledPackage }, o: InstalledIrSourceOptions): () => IrSourceResult {
  const lookupDefs = portalLookupDefs(o.portal);
  return () => {
    const r = registry.loadInstalled(o.id);
    if (!r.ok) return { ok: false, code: r.code };
    if (r.pkg.files.manifest.portal !== o.portal.kind) return { ok: false, code: 'package.portal_mismatch' };
    for (const id of r.lookups.keys()) if (!lookupDefs.has(id)) return { ok: false, code: 'package.lookup_undefined' };
    return {
      ok: true,
      ir: { pkg: r.pkg, lookupDefs, ...(o.judge ? { judge: o.judge } : {}), ...(o.pdf ? { pdf: o.pdf } : {}), ...(o.runToken ? { runToken: o.runToken } : {}), ...(o.runTokenFor ? { runTokenFor: o.runTokenFor } : {}) },
    };
  };
}
