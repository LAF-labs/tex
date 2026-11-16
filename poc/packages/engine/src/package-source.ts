// 실행 시작 패키지 공급(PR-D2 앞부분, D03 §3.1): RegistrySync가 받아 둔 설치본을 실행을 시작할 때마다 loadPackage로 다시 검증해
// RunService의 IrPackage로 만든다. 네트워크는 쓰지 않는다(받기는 RegistrySync.sync). 로그에는 코드만 남긴다.
import { generateKeyPairSync, sign as edSign, type KeyObject } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { BUNDLE_ALLOWLIST } from '@sax/model';
import { canonicalWithout, sha256Hex } from './core/canon.ts';
import { loadPackage, type LoadedPackage } from './core/loader.ts';
import type { TrustRoots } from './core/registry.ts';
import type { Manifest, PackageFiles, SelectorDict } from './core/types.ts';
import { appBundleOutcomes } from './registry-sync.ts';
import type { LocateResponder } from './run/locate-port.ts';
import type { RunToken } from '@sax/model';
import type { PdfPort } from './core/savepdf.ts';
import type { Judge } from './l0/judge.ts';
import type { LookupDef, PortalConfig } from './portal.ts';
import type { InstalledPackage } from './registry-sync.ts';
import type { SecretVault } from './driver/secret.ts';
import type { IrSourceResult } from './run/service-ir.ts';

/**
 * 조회 하위 패키지 id → 포털 조회 화면 정의(PopupLookupPort, 가짜 페이지 시험용. 제품은 서명 조회 패키지 IR을 쓴다). H-01의 조회 패키지 두 개는 `<portal.kind>.invoice.lookup`(발급 목록)과
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
  /** 공동인증서 비밀번호 차례의 금고(B1·B2, IrPackage.secret). 없으면 human:secret이 곧바로 시간 초과다. */
  secret?: { vault: SecretVault; targetId(): string };
  /** AI 위치 찾기 모델 길(IrPackage.locate, 게이트웨이 selector_repair). */
  locate?: LocateResponder;
}

/**
 * RunServiceDeps.irSource. 부를 때마다 설치본을 다시 로드한다(설치 뒤 폐기된 키·바뀐 저장 바이트를 실행 전에 잡는다).
 * 패키지의 portal이 이 RunService 포털과 다르면 package.portal_mismatch.
 * 조회는 함께 받은 서명 조회 패키지 IR로 돈다(lookupPackages, IrLookupPort). 앱 코드 조회 정의(portalLookupDefs)는 쓰지 않는다.
 */
export function installedIrSource(registry: { loadInstalled(id: string): InstalledPackage }, o: InstalledIrSourceOptions): () => IrSourceResult {
  return () => {
    const r = registry.loadInstalled(o.id);
    if (!r.ok) return { ok: false, code: r.code };
    if (r.pkg.files.manifest.portal !== o.portal.kind) return { ok: false, code: 'package.portal_mismatch' };
    return {
      ok: true,
      ir: { pkg: r.pkg, lookupPackages: r.lookups, ...(o.judge ? { judge: o.judge } : {}), ...(o.pdf ? { pdf: o.pdf } : {}), ...(o.runToken ? { runToken: o.runToken } : {}), ...(o.runTokenFor ? { runTokenFor: o.runTokenFor } : {}), ...(o.secret ? { secret: o.secret } : {}), ...(o.locate ? { locate: o.locate } : {}) },
    };
  };
}

/** 예행 로컬 패키지 폴더(앱 데이터 아래). 패키지마다 <id>/manifest.json·playbook.json·selectors.json·strings.ko.json. */
export const REHEARSAL_PACKAGES_DIR = 'rehearsal-packages';

const readJson = (f: string): unknown => JSON.parse(fs.readFileSync(f, 'utf8'));
const jsonKey = (x: unknown) => JSON.stringify(x);

/**
 * 로컬 패키지가 같은 id의 서명 설치본보다 약하지 않은가(예행 전용, 패키지와 무관한 앱 쪽 하한).
 * 비가역 판정(commits)·커밋 엔드포인트·허용 도메인은 패키지가 정하므로, 서명본이 비가역이라 한 것을 로컬이 풀지 못하게 한다.
 * 비가역 항목의 후보(셀렉터)를 다른 키에 새로 담아도 비가역이어야 한다. 틀리면 이유 코드.
 */
function weakerThanSigned(local: PackageFiles, signed: PackageFiles): string | null {
  if (local.manifest.id !== signed.manifest.id || local.manifest.portal !== signed.manifest.portal) return 'id_or_portal';
  if (local.manifest.domains.some((d) => !signed.manifest.domains.includes(d))) return 'domains';
  const sd: SelectorDict = signed.selectors;
  const ld: SelectorDict = local.selectors;
  const commitCandidates = new Set(Object.values(sd.entries).filter((e) => e.commits).flatMap((e) => e.candidates.map(jsonKey)));
  for (const [k, e] of Object.entries(sd.entries)) if (e.commits && ld.entries[k]?.commits !== true) return 'commits_dropped';
  for (const [k, e] of Object.entries(ld.entries)) {
    if (e.commits) continue;
    // 서명본에 이미 있던 같은 키·같은 후보 겹침(검토를 거친 것)은 그대로 받는다. 새로 생긴 겹침만 막는다.
    const had = new Set((sd.entries[k] && !sd.entries[k].commits ? sd.entries[k].candidates : []).map(jsonKey));
    if (e.candidates.some((c) => commitCandidates.has(jsonKey(c)) && !had.has(jsonKey(c)))) return 'commit_target_unflagged';
  }
  const localEndpoints = new Set(ld.commitEndpoints.map(jsonKey));
  if (sd.commitEndpoints.some((ce) => !localEndpoints.has(jsonKey(ce)))) return 'commit_endpoint_dropped';
  return null;
}

/**
 * 예행 전용 패키지 공급(부장 2026-11-13: 고칠 때마다 게시 서명 없이 실화면 예행). <dir>/<id>/에 파일이 없으면 null(레지스트리 판을 쓴다).
 * 서명 대신 같은 로더(loadPackage)를 그대로 지난다: 실행마다 만든 버리는 키 둘로 서명해 그 키만 믿는 문맥으로 로드한다(구조·V 규칙·번들 허용 목록·승인 요약 표).
 * 조회 하위 패키지는 서명 설치본을 쓰고(판이 같아야 한다), 서명 설치본보다 약하면(weakerThanSigned) 받지 않는다.
 * RunService는 예행(StartParams.rehearsal)일 때만 이것을 부른다. 결과 IrPackage.local이 있으면 그 실행은 금고 비밀번호를 첫 입력 스텝 전에만 쓴다(IrRun).
 */
export function rehearsalIrSource(
  registry: { loadInstalled(id: string): InstalledPackage },
  o: InstalledIrSourceOptions & { dir: string; unsignedBaseline?: string },
): () => IrSourceResult | null {
  return () => {
    const files = readLocal(o.dir, o.id);
    if (files === null) return null;
    if (files === 'unreadable') return { ok: false, code: 'rehearsal.package_unreadable' };
    const base = registry.loadInstalled(o.id);
    let lookups: ReadonlyMap<string, LoadedPackage>;
    if (base.ok) {
      const weaker = files.manifest?.domains && files.selectors?.entries ? weakerThanSigned(files, base.pkg.files) : 'shape';
      if (weaker) return { ok: false, code: `rehearsal.weaker_than_signed.${weaker}` };
      lookups = base.lookups;
    } else {
      // 아직 게시한 적 없는 패키지(민원증명): 같은 포털 서명 설치본(unsignedBaseline, H-01)의 도메인 안에서만 받는다. 예행은 승인 카드 자리에서 멈추므로 비가역 스텝까지 가지 않는다.
      const anchor = o.unsignedBaseline ? registry.loadInstalled(o.unsignedBaseline) : null;
      if (!anchor?.ok) return { ok: false, code: 'rehearsal.no_signed_baseline' };
      if (!files.manifest?.domains || !files.selectors?.entries) return { ok: false, code: 'rehearsal.weaker_than_signed.shape' };
      if (files.manifest.portal !== anchor.pkg.files.manifest.portal) return { ok: false, code: 'rehearsal.weaker_than_signed.id_or_portal' };
      if (files.manifest.domains.some((d) => !anchor.pkg.files.manifest.domains.includes(d))) return { ok: false, code: 'rehearsal.weaker_than_signed.domains' };
      const local = new Map<string, LoadedPackage>();
      for (const l of files.manifest.lookupsUsed) {
        const lf = readLocal(o.dir, l.id);
        if (!lf || lf === 'unreadable' || lf.manifest.portal !== files.manifest.portal || lf.manifest.domains.some((d) => !anchor.pkg.files.manifest.domains.includes(d))) return { ok: false, code: 'rehearsal.lookup_mismatch' };
        const r = loadEphemeral(lf, new Map());
        if (!r.ok) return { ok: false, code: r.code };
        local.set(l.id, r.pkg);
      }
      lookups = local;
    }
    for (const l of files.manifest.lookupsUsed) {
      const got = lookups.get(l.id);
      if (!got || got.files.manifest.version !== l.version) return { ok: false, code: 'rehearsal.lookup_mismatch' };
    }
    const r = loadEphemeral(files, lookups);
    if (!r.ok) return { ok: false, code: r.code };
    return {
      ok: true,
      ir: { pkg: r.pkg, lookupPackages: lookups, local: { digest: r.pkg.manifestDigest }, ...(o.judge ? { judge: o.judge } : {}), ...(o.pdf ? { pdf: o.pdf } : {}), ...(o.runToken ? { runToken: o.runToken } : {}), ...(o.runTokenFor ? { runTokenFor: o.runTokenFor } : {}), ...(o.secret ? { secret: o.secret } : {}), ...(o.locate ? { locate: o.locate } : {}) },
    };
  };
}

/** <dir>/<id>/의 패키지 파일. 없으면 null, 읽지 못하면 'unreadable'. */
function readLocal(dir: string, id: string): PackageFiles | 'unreadable' | null {
  const d = path.join(dir, id);
  if (!fs.existsSync(path.join(d, 'manifest.json'))) return null;
  try {
    const strings = fs.existsSync(path.join(d, 'strings.ko.json')) ? 'strings.ko.json' : 'strings.json';
    return { manifest: readJson(path.join(d, 'manifest.json')) as Manifest, playbook: readJson(path.join(d, 'playbook.json')) as never, selectors: readJson(path.join(d, 'selectors.json')) as never, strings: readJson(path.join(d, strings)) as never };
  } catch {
    return 'unreadable';
  }
}

/**
 * 서명 대신 같은 로더(loadPackage)를 그대로 지난다: 부를 때마다 만든 버리는 키 둘로 서명해 그 키만 믿는 문맥으로 로드한다(구조·V 규칙·번들 허용 목록·승인 요약 표).
 * 조회 다이제스트는 넘긴 조회 설치본에서 채운다.
 */
function loadEphemeral(files: PackageFiles, lookups: ReadonlyMap<string, LoadedPackage>): { ok: true; pkg: LoadedPackage } | { ok: false; code: string } {
  const keys = [0, 1].map((n) => ({ keyId: `rehearsal-${n}`, ...generateKeyPairSync('ed25519') }));
  const bytes = (x: unknown) => Buffer.from(JSON.stringify(x), 'utf8');
  const raw = { playbook: bytes(files.playbook), selectors: bytes(files.selectors), strings: bytes(files.strings) };
  const m: Manifest = {
    ...files.manifest,
    contentDigests: { playbook: sha256Hex(raw.playbook), selectors: sha256Hex(raw.selectors), strings: sha256Hex(raw.strings) },
    lookupsUsed: files.manifest.lookupsUsed.map((l) => ({ ...l, digest: lookups.get(l.id)?.manifestDigest ?? l.digest })),
  };
  const signed = canonicalWithout(m, ['signatures']);
  m.signatures = keys.map((k) => ({ keyId: k.keyId, alg: 'ed25519' as const, sig: edSign(null, signed, k.privateKey).toString('base64url') }));
  const only = (ks: typeof keys): ReadonlyMap<string, KeyObject> => new Map(ks.map((k) => [k.keyId, k.publicKey]));
  const roots: TrustRoots = { keyEpoch: 0, rootKeys: new Map(), packageKeys: only(keys), policyKeys: new Map(), emergencyKey: { keyId: keys[0]!.keyId, key: keys[0]!.publicKey }, timestampKey: { keyId: keys[0]!.keyId, key: keys[0]!.publicKey } };
  const r = loadPackage({ manifest: bytes(m), ...raw }, { roots, revoked: new Set(), bundleAllowlist: BUNDLE_ALLOWLIST, bundles: appBundleOutcomes(), installedLookups: lookups, storedVersion: null, installedDigest: null, hold: false, policyFresh: true, now: Date.now() });
  return r.ok ? { ok: true, pkg: r.pkg } : { ok: false, code: r.code };
}
