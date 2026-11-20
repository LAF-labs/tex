import { canonicalJson, canonicalizable, canonicalWithout, sha256Hex } from './canon.ts';
import { HOTFIX_MAX_VALIDITY_D } from './constants.ts';
import { applyHotfix, hotfixEligibilityViolations } from './hotfix.ts';
import { countSignatures, epochProblem, issuedInFuture, versionProblem, type TrustRoots, type VersionMark } from './registry.ts';
import { schemaViolations } from './schema.ts';
import { FIXTURE_PORTAL, type Hotfix, type Manifest, type PackageFiles, type PlaybookIR, type SelectorDict, type Strings, type Violation } from './types.ts';
import { fixtureUrlProblem, semanticViolations, urlProblem, validatePackage, type BundleOutcomes } from './validate.ts';

const DAY = 86_400_000;

/**
 * fixture 패키지 로드 허용(ADR-039 조건 2 ②): 이 모듈을 TS 소스로 읽을 때만 참이다. 소스는 `--conditions=development`(시험·개발)로만
 * 읽히고, 제품 설치본에는 진입점에서 닿는 dist/*.js만 들어간다(package-win). 설정·인자로 켜는 길은 두지 않는다.
 */
export const FIXTURE_LOAD_ALLOWED: boolean = new URL(import.meta.url).pathname.endsWith('.ts');

/**
 * fixture 출처 허가(ADR-039 결정 2 ②의 같은 관문, 팀장 결정 2026-11-07). 액추에이터·goto 핸들러의 출처 판정은 제품의 마지막 방어선이라
 * 허용 목록을 넓히지 않고, fixture 패키지를 실행할 때만 이 허가를 따로 주입한다. 허가는 이 모듈이 발급한 객체만 유효하고(WeakSet),
 * 관문(FIXTURE_LOAD_ALLOWED)이 닫힌 제품 dist에서는 발급도 인정도 하지 않는다.
 */
export interface FixtureOriginGrant {
  readonly portal: typeof FIXTURE_PORTAL;
}
const grants = new WeakSet<FixtureOriginGrant>();

/** 로드한 fixture 패키지에 출처 허가를 낸다. 관문이 닫혔거나 portal이 fixture가 아니면 null. */
export function fixtureOriginGrant(pkg: Pick<LoadedPackage, 'files'>): FixtureOriginGrant | null {
  if (!FIXTURE_LOAD_ALLOWED || pkg.files.manifest.portal !== FIXTURE_PORTAL) return null;
  const g: FixtureOriginGrant = Object.freeze({ portal: FIXTURE_PORTAL });
  grants.add(g);
  return g;
}

/** 이 모듈이 발급한 허가이고 관문이 열려 있는가(제품 dist에서는 언제나 거짓). */
export function isFixtureGrant(grant: FixtureOriginGrant | null | undefined): grant is FixtureOriginGrant {
  return !!grant && FIXTURE_LOAD_ALLOWED && grants.has(grant);
}

/**
 * 실행 시 이동 URL 판정. 이 모듈이 발급한 허가가 있고 관문이 열려 있을 때만 fixture 규칙(V-25: http://127.0.0.1·[::1]:PORT)을 쓴다.
 * 그때도 실제 포털 URL은 받지 않는다(규칙을 합치지 않고 바꾼다). 그 밖은 실제 포털 규칙(V-06)이다.
 */
export function navigationUrlProblem(url: string, domains: readonly string[], grant?: FixtureOriginGrant | null): string | null {
  if (isFixtureGrant(grant)) return fixtureUrlProblem(url, domains);
  return urlProblem(url, domains);
}

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
  ['invoice.confirm', ['counterpartName', 'counterpartBizNo', 'totalAmount', 'taxAmount', 'counterpartEmail']],
  ['cert.confirm', ['certDoc', 'certPurpose', 'certSubmitTo', 'rrnDisclosure']],
]);

export interface LoadedPackage {
  files: PackageFiles;
  selectors: SelectorDict;
  manifestDigest: string;
  hotfix: { digest: string; mark: VersionMark } | null;
  lookupDigests: string[];
}

export interface HotfixInput {
  hotfix: Hotfix;
  stored: (VersionMark & { digest: string }) | null;
}

export interface LoaderContext {
  roots: TrustRoots;
  revoked: ReadonlySet<string>;
  bundleAllowlist: ReadonlyArray<{ id: string; digest: string }>;
  bundles: ReadonlyMap<string, BundleOutcomes>;
  installedLookups: ReadonlyMap<string, LoadedPackage>;
  storedVersion: string | null;
  installedDigest: string | null;
  hold: boolean;
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

  const manifest = parse<Manifest>(raw.manifest);
  if (!manifest) return fail('loader.manifest_unparsable');
  const ms = schemaViolations('manifest', manifest);
  if (ms.length) return fail('loader.schema_invalid', ms);
  if (!canonicalizable(manifest)) return fail('loader.schema_invalid', [{ rule: 'LOADER-1', message: 'JCS로 직렬화할 수 없는 값' }]);
  if (manifest.id.endsWith('.hotfix')) return fail('loader.schema_invalid', [{ rule: 'LOADER-1', message: '패키지 id는 .hotfix로 끝날 수 없음' }]);
  if (manifest.portal === FIXTURE_PORTAL && !FIXTURE_LOAD_ALLOWED) return fail('loader.fixture_package', [{ rule: 'LOADER-0', message: 'fixture 패키지는 제품 엔진에서 로드하지 않음(ADR-039)' }]);
  const signed = canonicalWithout(manifest, ['signatures']);
  const q = countSignatures(signed, manifest.signatures, ctx.roots.packageKeys, ctx.revoked);
  if (q.revoked.length) events.push('registry.key_revoked');
  if (q.valid.length < 2) return fail('registry.signature_insufficient');
  const mDigest = sha256Hex(signed);
  if (ctx.hold && mDigest !== ctx.installedDigest) return fail('registry.update_held');

  for (const k of ['playbook', 'selectors', 'strings'] as const) if (sha256Hex(raw[k]) !== manifest.contentDigests[k]) return fail('loader.content_digest_mismatch', [{ rule: 'LOADER-2', target: k, message: `${k} 다이제스트 불일치` }]);
  const playbook = parse<PlaybookIR>(raw.playbook);
  const selectors = parse<SelectorDict>(raw.selectors);
  const strings = parse<Strings>(raw.strings);
  if (!playbook || !selectors || !strings) return fail('loader.content_unparsable');
  const files: PackageFiles = { manifest, playbook, selectors, strings };

  if (ctx.storedVersion !== null) {
    const c = compareSemver(manifest.version, ctx.storedVersion);
    if (c === null || c < 0) return fail('registry.version_rollback');
    if (c === 0 && mDigest !== ctx.installedDigest) return fail('registry.version_rollback');
  }

  const allow = new Map(ctx.bundleAllowlist.map((b) => [b.id, b.digest]));
  for (const b of manifest.bundlesUsed) {
    const wire = `${b.id}_v${b.ver}`;
    if (allow.get(wire) !== b.digest) return fail('loader.bundle_not_allowed', [{ rule: 'BV-06', target: wire, message: '앱 내장 허용 목록에 없는 번들 다이제스트' }]);
  }

  const lookups = new Map<string, PackageFiles>();
  const lookupDigests: string[] = [];
  for (const l of manifest.lookupsUsed) {
    const got = ctx.installedLookups.get(l.id);
    if (!got || got.files.manifest.kind !== 'lookup' || got.files.manifest.version !== l.version || got.manifestDigest !== l.digest)
      return fail('loader.lookup_mismatch', [{ rule: 'V-22', target: l.id, message: '조회 하위 패키지가 없거나 다이제스트·kind·버전이 다름' }]);
    lookups.set(l.id, got.files);
    lookupDigests.push(got.manifestDigest);
  }

  const vopts = { bundles: ctx.bundles, lookups };
  const sv = validatePackage(files, vopts);
  if (sv.length) return fail('loader.static_invalid', sv);

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
  const hs = schemaViolations('hotfix', hf);
  if (hs.length || !canonicalizable(hf)) return no('hotfix.schema_invalid', hs);
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
