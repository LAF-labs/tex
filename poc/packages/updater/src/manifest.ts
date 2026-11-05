// 릴리스 매니페스트 releases/{channel}/latest.json 모양(services/registry API.md "릴리스 매니페스트", 클라우드 PR #56).
// 모양 검사만 한다. 서명·시각·버전은 verify.ts. 모르는 필드는 거부한다(서명 대상이 되는 필드를 클라이언트가 모른 채 받지 않는다).

/** 레지스트리 채널(D09 §8.6). 앱 릴리스는 stable·beta만 쓰지만 경로 규칙은 레지스트리와 같다. */
export const CHANNELS = ['stable', 'beta', 'hotfix'] as const;
export type Channel = (typeof CHANNELS)[number];

/** 업데이트 판정 결과 코드. registry.*는 D16 정본 코드, update.*는 이 패키지가 D16에 제안하는 코드(README 표). */
export type UpdateCode =
  | 'registry.signature_insufficient'
  | 'registry.key_revoked'
  | 'registry.expired'
  | 'registry.issued_in_future'
  | 'registry.version_rollback'
  | 'registry.revocation_stale'
  | 'registry.head_mismatch'
  | 'update.manifest_invalid'
  | 'update.channel_mismatch'
  | 'update.validity_too_long'
  | 'update.root_change_unsigned'
  | 'update.transparency_unverified'
  | 'update.feed_mismatch'
  | 'update.size_mismatch'
  | 'update.digest_mismatch';

/** 보안 이벤트로 남길 코드(D16 보안 이벤트 목록과 같은 기준: 위조·롤백·미래 시각·split-view 의심). */
export const SECURITY_CODES: ReadonlySet<UpdateCode> = new Set<UpdateCode>([
  'registry.signature_insufficient',
  'registry.key_revoked',
  'registry.issued_in_future',
  'registry.version_rollback',
  'registry.head_mismatch',
  'update.root_change_unsigned',
  'update.feed_mismatch',
  'update.digest_mismatch',
]);

export class UpdateError extends Error {
  readonly code: UpdateCode;
  constructor(code: UpdateCode) {
    super(code);
    this.code = code;
  }
}

export const fail = (code: UpdateCode): never => {
  throw new UpdateError(code);
};

export interface Sig {
  keyId: string;
  alg: 'ed25519';
  /** 64바이트 서명의 base64url(패딩 없음, 86자), SIGNING.md §1 */
  sig: string;
}

export interface ReleaseFile {
  /** 파일 이름만(경로·개행 없음) */
  url: string;
  /** sha512 표준 base64(88자) — electron-updater latest.yml과 같은 표기 */
  sha512: string;
  size: number;
}

/** 뿌리를 바꾸는 릴리스(ADR-028 결정 3)가 바꾸는 것 */
export const ROOT_CHANGES = ['keyEpoch', 'allowlist', 'ceiling'] as const;
export type RootChangeKind = (typeof ROOT_CHANGES)[number];

/**
 * 뿌리 변경 릴리스의 2-of-3 루트 서명(ADR-028 결정 3). API.md에 아직 없는 선택 필드다(클라우드에 제안, PR 본문).
 * 루트 키는 JCS(매니페스트 − signature, rootChange − signatures)에 서명하고, 릴리스 키는 그 뒤 루트 서명까지 포함한 내용에 서명한다.
 */
export interface RootChange {
  /** 새 앱이 핀 고정할 keyEpoch. 'keyEpoch' 변경이면 지금보다 커야 하고, 아니면 지금과 같아야 한다 */
  keyEpoch: number;
  changes: RootChangeKind[];
  signatures: Sig[];
}

export interface ReleaseManifest {
  channel: Channel;
  version: string;
  releaseDate: string;
  expiresAt: string;
  rolloutPercent: number;
  files: ReleaseFile[];
  signature: Sig;
  rootChange?: RootChange;
}

const KEYS = new Set(['channel', 'version', 'releaseDate', 'expiresAt', 'rolloutPercent', 'files', 'signature', 'rootChange']);
const FILE_KEYS = new Set(['url', 'sha512', 'size']);
const SIG_KEYS = new Set(['keyId', 'alg', 'sig']);
const ROOT_KEYS = new Set(['keyEpoch', 'changes', 'signatures']);

export const SEMVER_RE = /^(\d{1,6})\.(\d{1,6})\.(\d{1,6})$/;
const URL_RE = /^[A-Za-z0-9._-]{1,128}$/;
const SHA512_RE = /^[A-Za-z0-9+/]{86}==$/;
const SIG_RE = /^[A-Za-z0-9_-]{86}$/;
const KEYID_RE = /^[A-Za-z0-9._-]{1,64}$/;
/** ISO 8601 UTC(밀리초 선택). Date.parse가 받는 다른 형식(로컬 시각 등)은 거부한다. */
const TIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/;
/** 설치본 한 파일 상한(1GiB). 현실 크기는 수백 MB 아래다. */
export const MAX_FILE_SIZE = 1024 * 1024 * 1024;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const onlyKeys = (o: Record<string, unknown>, allowed: ReadonlySet<string>): boolean => Object.keys(o).every((k) => allowed.has(k));

function parseSig(v: unknown): Sig {
  if (!isObj(v) || !onlyKeys(v, SIG_KEYS)) return fail('update.manifest_invalid');
  if (typeof v.keyId !== 'string' || !KEYID_RE.test(v.keyId) || v.alg !== 'ed25519' || typeof v.sig !== 'string' || !SIG_RE.test(v.sig)) return fail('update.manifest_invalid');
  return { keyId: v.keyId, alg: 'ed25519', sig: v.sig };
}

export const isTime = (v: unknown): v is string => typeof v === 'string' && TIME_RE.test(v) && Number.isFinite(Date.parse(v));

/** latest.json 본문(이미 JSON.parse한 값)의 모양 검사. 통과한 값만 verify에 넘긴다. */
export function parseManifest(v: unknown): ReleaseManifest {
  if (!isObj(v) || !onlyKeys(v, KEYS)) return fail('update.manifest_invalid');
  const { channel, version, releaseDate, expiresAt, rolloutPercent, files } = v;
  if (typeof channel !== 'string' || !(CHANNELS as readonly string[]).includes(channel)) return fail('update.manifest_invalid');
  if (typeof version !== 'string' || !SEMVER_RE.test(version)) return fail('update.manifest_invalid');
  if (!isTime(releaseDate) || !isTime(expiresAt)) return fail('update.manifest_invalid');
  if (!Number.isInteger(rolloutPercent) || (rolloutPercent as number) < 0 || (rolloutPercent as number) > 100) return fail('update.manifest_invalid');
  if (!Array.isArray(files) || files.length < 1 || files.length > 8) return fail('update.manifest_invalid');
  const seen = new Set<string>();
  const outFiles: ReleaseFile[] = files.map((f: unknown) => {
    if (!isObj(f) || !onlyKeys(f, FILE_KEYS)) return fail('update.manifest_invalid');
    if (typeof f.url !== 'string' || !URL_RE.test(f.url) || f.url.startsWith('.') || seen.has(f.url)) return fail('update.manifest_invalid');
    if (typeof f.sha512 !== 'string' || !SHA512_RE.test(f.sha512)) return fail('update.manifest_invalid');
    if (!Number.isSafeInteger(f.size) || (f.size as number) < 1 || (f.size as number) > MAX_FILE_SIZE) return fail('update.manifest_invalid');
    seen.add(f.url);
    return { url: f.url, sha512: f.sha512, size: f.size as number };
  });
  const out: ReleaseManifest = { channel: channel as Channel, version, releaseDate, expiresAt, rolloutPercent: rolloutPercent as number, files: outFiles, signature: parseSig(v.signature) };
  if (v.rootChange !== undefined) {
    const r = v.rootChange;
    if (!isObj(r) || !onlyKeys(r, ROOT_KEYS)) return fail('update.manifest_invalid');
    if (!Number.isSafeInteger(r.keyEpoch) || (r.keyEpoch as number) < 1) return fail('update.manifest_invalid');
    if (!Array.isArray(r.changes) || r.changes.length < 1 || new Set(r.changes).size !== r.changes.length) return fail('update.manifest_invalid');
    if (!r.changes.every((c: unknown) => typeof c === 'string' && (ROOT_CHANGES as readonly string[]).includes(c))) return fail('update.manifest_invalid');
    if (!Array.isArray(r.signatures) || r.signatures.length < 1 || r.signatures.length > 3) return fail('update.manifest_invalid');
    out.rootChange = { keyEpoch: r.keyEpoch as number, changes: r.changes as RootChangeKind[], signatures: r.signatures.map(parseSig) };
  }
  return out;
}

/** a > b(semver 세 자리, 사전 릴리스 표기 없음) */
export function semverCmp(a: string, b: string): number {
  const x = SEMVER_RE.exec(a);
  const y = SEMVER_RE.exec(b);
  if (!x || !y) return fail('update.manifest_invalid');
  for (let i = 1; i <= 3; i++) {
    const d = Number(x[i]) - Number(y[i]);
    if (d !== 0) return Math.sign(d);
  }
  return 0;
}
