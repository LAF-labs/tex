// D03 §3.1 패키지 로더: 로드할 때마다 1 서명(2-of-3, 폐기 키 제외) → 2 내용 결속 → 3 버전 → 4 번들(BV-06) → 5 조회 하위
// 플레이북(V-22) → 6 정적 검증(스키마 + V-01~V-24) → 7 핫픽스 → 8 승인 바 요약 표 순서로 확인하고, 하나라도 실패하면 로드하지
// 않는다. 핫픽스만은 실패해도 패키지를 원래 후보로 로드한다. 결과에는 코드·규칙 번호만 담는다(화면 문자열·값 없음).
import { canonicalJson, canonicalizable, canonicalWithout, sha256Hex } from './canon.ts';
import { HOTFIX_MAX_VALIDITY_D } from './constants.ts';
import { applyHotfix, hotfixEligibilityViolations } from './hotfix.ts';
import { countSignatures, epochProblem, issuedInFuture, versionProblem, type TrustRoots, type VersionMark } from './registry.ts';
import { schemaViolations } from './schema.ts';
import type { Hotfix, Manifest, PackageFiles, PlaybookIR, SelectorDict, Strings, Violation } from './types.ts';
import { semanticViolations, validatePackage, type BundleOutcomes } from './validate.ts';

const DAY = 86_400_000;

/** 레지스트리에서 받은 원시 바이트(contentDigests는 이 바이트의 SHA-256). */
export interface RawPackage {
  manifest: Uint8Array;
  playbook: Uint8Array;
  selectors: Uint8Array;
  strings: Uint8Array;
}

/** manifest 다이제스트 = JCS(manifest − signatures)의 SHA-256(서명 대상과 같은 바이트). lookupsUsed[].digest·hotfix.appliesTo가 이것을 가리킨다. */
export const manifestDigest = (m: Manifest) => sha256Hex(canonicalWithout(m, ['signatures']));
export const hotfixDigest = (h: Hotfix) => sha256Hex(canonicalWithout(h, ['signatures']));

/**
 * D03 §3 packageDigest = IR + selectors + 적용된 핫픽스 + lookupsUsed 다이제스트 + 정책 버전 + 프로필 버전(B-08).
 * IR·selectors(·strings)는 manifest의 contentDigests로 결속되므로 manifest 다이제스트로 대신한다.
 */
export function packageDigest(p: { manifest: string; hotfix: string | null; lookups: readonly string[]; policyVersion: string; profileVersion: string }): string {
  return sha256Hex(canonicalJson({ manifest: p.manifest, hotfix: p.hotfix, lookups: [...p.lookups], policyVersion: p.policyVersion, profileVersion: p.profileVersion }));
}

/** 앱 내장 승인 바 요약 표(ADR-021): 게이트 card → 요약 줄에 쓰는 fieldKey. 앱 업데이트로만 바뀐다. */
export const APPROVAL_SUMMARIES: ReadonlyMap<string, readonly string[]> = new Map([
  // H-01: 공급받는자(상호·사업자번호), 합계와 세액, 받는 이메일(D03 §3)
  ['invoice.confirm', ['counterpartName', 'counterpartBizNo', 'totalAmount', 'taxAmount', 'counterpartEmail']],
]);

export interface LoadedPackage {
  files: PackageFiles;
  /** 핫픽스를 반영한 실효 사전(원본은 files.selectors). */
  selectors: SelectorDict;
  manifestDigest: string;
  hotfix: { digest: string; mark: VersionMark } | null;
  /** lookupsUsed 순서대로의 manifest 다이제스트. */
  lookupDigests: string[];
}

export interface HotfixInput {
  hotfix: Hotfix;
  /** 이 패키지에 마지막으로 적용한 핫픽스의 버전과 다이제스트(`LoadedPackage.hotfix`, 없으면 null). */
  stored: (VersionMark & { digest: string }) | null;
}

export interface LoaderContext {
  roots: TrustRoots;
  revoked: ReadonlySet<string>;
  /** 앱 내장 번들 다이제스트 허용 목록(BV-06, @sax/model BUNDLE_ALLOWLIST). id는 wireId(`<id>_v<ver>`). */
  bundleAllowlist: ReadonlyArray<{ id: string; digest: string }>;
  /** 앱 내장 번들 결과(V-07). */
  bundles: ReadonlyMap<string, BundleOutcomes>;
  /** 이미 로드된 조회 하위 패키지(id → LoadedPackage). */
  installedLookups: ReadonlyMap<string, LoadedPackage>;
  /** 이 id로 마지막에 로드한 버전(semver). 없으면 null. */
  storedVersion: string | null;
  /** 지금 설치되어 있는 manifest 다이제스트. 보류 중에도 설치본은 계속 로드한다. */
  installedDigest: string | null;
  /** 헤드 불일치(E-14) 또는 폐기 목록 신선도 상실(D09 §8.4): 새 패키지·핫픽스 보류. */
  hold: boolean;
  /** 정책이 만료(stale·fallback·none)면 핫픽스 로드 거부(D03 §7.1 (c)). */
  policyFresh: boolean;
  hotfix?: HotfixInput;
  approvalSummaries?: ReadonlyMap<string, readonly string[]>;
  now: number;
}

export type LoadResult =
  | { ok: true; pkg: LoadedPackage; events: string[] }
  | { ok: false; code: string; violations: Violation[]; events: string[] };

const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/;
/** a < b → 음수. 형식이 틀리면 null. */
export function compareSemver(a: string, b: string): number | null {
  const x = SEMVER.exec(a);
  const y = SEMVER.exec(b);
  if (!x || !y) return null;
  for (let i = 1; i <= 3; i++) {
    const d = Number(x[i]) - Number(y[i]);
    if (d) return d;
  }
  return 0;
}

const parse = <T>(b: Uint8Array): T | undefined => {
  try {
    return JSON.parse(Buffer.from(b).toString('utf8')) as T;
  } catch {
    return undefined;
  }
};

export function loadPackage(raw: RawPackage, ctx: LoaderContext): LoadResult {
  const events: string[] = [];
  const fail = (code: string, violations: Violation[] = []): LoadResult => ({ ok: false, code, violations, events });

  // 1. 서명
  const manifest = parse<Manifest>(raw.manifest);
  if (!manifest) return fail('loader.manifest_unparsable');
  const ms = schemaViolations('manifest', manifest);
  if (ms.length) return fail('loader.schema_invalid', ms);
  if (!canonicalizable(manifest)) return fail('loader.schema_invalid', [{ rule: 'LOADER-1', message: 'JCS로 직렬화할 수 없는 값' }]);
  // 패키지 id는 핫픽스 인덱스 이름(<appliesTo.id>.hotfix, SIGNING.md §6)과 겹칠 수 없다.
  if (manifest.id.endsWith('.hotfix')) return fail('loader.schema_invalid', [{ rule: 'LOADER-1', message: '패키지 id는 .hotfix로 끝날 수 없음' }]);
  const signed = canonicalWithout(manifest, ['signatures']);
  const q = countSignatures(signed, manifest.signatures, ctx.roots.packageKeys, ctx.revoked);
  if (q.revoked.length) events.push('registry.key_revoked');
  if (q.valid.length < 2) return fail('registry.signature_insufficient');
  const mDigest = sha256Hex(signed);
  if (ctx.hold && mDigest !== ctx.installedDigest) return fail('registry.update_held');

  // 2. 내용 결속(원시 바이트)
  for (const k of ['playbook', 'selectors', 'strings'] as const) if (sha256Hex(raw[k]) !== manifest.contentDigests[k]) return fail('loader.content_digest_mismatch', [{ rule: 'LOADER-2', target: k, message: `${k} 다이제스트 불일치` }]);
  const playbook = parse<PlaybookIR>(raw.playbook);
  const selectors = parse<SelectorDict>(raw.selectors);
  const strings = parse<Strings>(raw.strings);
  if (!playbook || !selectors || !strings) return fail('loader.content_unparsable');
  const files: PackageFiles = { manifest, playbook, selectors, strings };

  // 3. 버전: 같은 id의 내림 금지. 같은 버전은 같은 내용일 때만(설치본 재로드).
  if (ctx.storedVersion !== null) {
    const c = compareSemver(manifest.version, ctx.storedVersion);
    if (c === null || c < 0) return fail('registry.version_rollback');
    // 설치본 다이제스트를 모르면 같은 버전도 받지 않는다(fail-closed).
    if (c === 0 && mDigest !== ctx.installedDigest) return fail('registry.version_rollback');
  }

  // 4. 번들(BV-06): 다이제스트가 앱 내장 허용 목록과 일치.
  const allow = new Map(ctx.bundleAllowlist.map((b) => [b.id, b.digest]));
  for (const b of manifest.bundlesUsed) {
    const wire = `${b.id}_v${b.ver}`;
    if (allow.get(wire) !== b.digest) return fail('loader.bundle_not_allowed', [{ rule: 'BV-06', target: wire, message: '앱 내장 허용 목록에 없는 번들 다이제스트' }]);
  }

  // 5. 조회 하위 플레이북: 설치·서명(로드 결과)·kind lookup·다이제스트.
  const lookups = new Map<string, PackageFiles>();
  const lookupDigests: string[] = [];
  for (const l of manifest.lookupsUsed) {
    const got = ctx.installedLookups.get(l.id);
    if (!got || got.files.manifest.kind !== 'lookup' || got.files.manifest.version !== l.version || got.manifestDigest !== l.digest)
      return fail('loader.lookup_mismatch', [{ rule: 'V-22', target: l.id, message: '조회 하위 패키지가 없거나 다이제스트·kind·버전이 다름' }]);
    lookups.set(l.id, got.files);
    lookupDigests.push(got.manifestDigest);
  }

  // 6. 정적 검증(스키마 + V-01~V-24). SV는 레지스트리 CI에서만.
  const vopts = { bundles: ctx.bundles, lookups };
  const sv = validatePackage(files, vopts);
  if (sv.length) return fail('loader.static_invalid', sv);

  // 8. 승인 바 요약 표(7보다 먼저 계산해도 결과는 같다: 핫픽스는 fieldKey를 바꿀 수 없다).
  const { analysis } = semanticViolations(files, vopts);
  const summaries = ctx.approvalSummaries ?? APPROVAL_SUMMARIES;
  for (const g of new Set(analysis.gateOf.values())) {
    const gs = analysis.cfg.info.get(g)!.step;
    if (gs.type !== 'gate') continue;
    const need = summaries.get(gs.card);
    const have = new Set((analysis.readbackBefore.get(g) ?? []).flatMap((r) => {
      const s = analysis.cfg.info.get(r)!.step;
      return s.type === 'readback' ? s.fields : [];
    }));
    if (!need || need.some((k) => !have.has(k))) return fail('loader.approval_summary_missing', [{ rule: 'LOADER-8', step: g, message: '승인 바 요약 표에 없는 카드이거나 요약 fieldKey가 게이트 카드에 없음' }]);
  }

  // 7. 핫픽스: 거부해도 패키지는 원래 후보로 로드한다.
  let effective = selectors;
  let hotfix: LoadedPackage['hotfix'] = null;
  if (ctx.hotfix) {
    const r = checkHotfix(ctx.hotfix, files, mDigest, ctx, vopts);
    if (r.ok) {
      effective = r.selectors;
      hotfix = { digest: hotfixDigest(ctx.hotfix.hotfix), mark: { keyEpoch: ctx.hotfix.hotfix.keyEpoch, monotonic: ctx.hotfix.hotfix.monotonic } };
      events.push('registry.hotfix_applied');
    } else {
      events.push('registry.hotfix_rejected');
    }
  }

  return { ok: true, pkg: { files, selectors: effective, manifestDigest: mDigest, hotfix, lookupDigests }, events };
}

export type HotfixCheck = { ok: true; selectors: SelectorDict } | { ok: false; reason: string; violations: Violation[] };

/** D03 §3.1-7. reason은 registry.hotfix_rejected의 세부 코드(저널에는 코드만). */
export function checkHotfix(input: HotfixInput, files: PackageFiles, mDigest: string, ctx: Pick<LoaderContext, 'roots' | 'revoked' | 'hold' | 'policyFresh' | 'now'>, vopts: Parameters<typeof validatePackage>[1]): HotfixCheck {
  const no = (reason: string, violations: Violation[] = []): HotfixCheck => ({ ok: false, reason, violations });
  const hf = input.hotfix;
  if (files.manifest.kind === 'lookup') return no('hotfix.lookup_package');
  if (!ctx.policyFresh) return no('hotfix.policy_stale');
  // 다이제스트(JCS)를 계산하기 전에 스키마·JCS 가능 여부부터 본다(던지지 않고 거부).
  const hs = schemaViolations('hotfix', hf);
  if (hs.length || !canonicalizable(hf)) return no('hotfix.schema_invalid', hs);
  // 이미 적용한 핫픽스를 다시 로드(재시작)하는 것은 버전 내림이 아니고, 보류(hold) 중에도 설치본 그대로 얼려 둔다.
  const st = input.stored;
  const reload = !!st && st.keyEpoch === hf.keyEpoch && st.monotonic === hf.monotonic && st.digest === hotfixDigest(hf);
  if (ctx.hold && !reload) return no('hotfix.update_held');
  if (hf.appliesTo.id !== files.manifest.id || hf.appliesTo.version !== files.manifest.version || hf.appliesTo.packageDigest !== mDigest) return no('hotfix.applies_to_mismatch');
  if (countSignatures(canonicalWithout(hf, ['signatures']), hf.signatures, ctx.roots.packageKeys, ctx.revoked).valid.length < 2) return no('registry.signature_insufficient');
  const ep = epochProblem(hf, ctx.roots);
  if (ep) return no(ep);
  const vp = reload ? null : versionProblem(st, hf);
  if (vp) return no(vp);
  const iss = Date.parse(hf.issuedAt);
  const exp = Date.parse(hf.expiresAt);
  if (!(exp > iss) || exp - iss > HOTFIX_MAX_VALIDITY_D * DAY) return no('hotfix.validity_too_long');
  if (issuedInFuture(hf.issuedAt, ctx.now)) return no('registry.issued_in_future');
  if (exp <= ctx.now) return no('hotfix.expired');
  const ev = hotfixEligibilityViolations(hf, files, vopts);
  if (ev.length) return no('hotfix.ineligible', ev);
  const selectors = applyHotfix(files.selectors, hf);
  const rv = validatePackage({ ...files, selectors }, vopts);
  if (rv.length) return no('hotfix.revalidate_failed', rv);
  return { ok: true, selectors };
}
