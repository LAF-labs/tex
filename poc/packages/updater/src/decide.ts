import { createHash } from 'node:crypto';
import { SECURITY_CODES, semverCmp, UpdateError, type Channel, type ReleaseFile, type ReleaseManifest, type UpdateCode } from './manifest.ts';
import { filesDigest, verifyRelease, type Revocation, type SeenRelease, type TrustRoot, type VerifiedRelease } from './verify.ts';

/** 투명성 로그·미러 확인 결과(ADR-028 결정 2, E-14). main이 latest.json 다이제스트·설치본 sha512의 포함 증명과 미러 헤드를 확인한 값 */
export type Transparency = 'verified' | 'head_mismatch' | 'unverified';

export interface UpdatePolicy {
  requireTransparency: boolean;
}

export const DEFAULT_POLICY: UpdatePolicy = { requireTransparency: true };

/** 채널별 저장 상태(main이 DB·파일에 둔다). */
export interface UpdaterState {
  highestSeen: SeenRelease | null;
  lastSuccessAt: number | null;
}

export const INITIAL_STATE: UpdaterState = { highestSeen: null, lastSuccessAt: null };

export interface DecideInput {
  doc: unknown;
  channel: Channel;
  trust: TrustRoot;
  revocation: Revocation;
  installedVersion: string;
  state: UpdaterState;
  deviceId: string;
  transparency: Transparency;
  now: number;
  policy?: UpdatePolicy;
}

export type Decision =
  | { action: 'download'; release: VerifiedRelease; file: ReleaseFile; state: UpdaterState }
  | { action: 'none'; reason: 'up_to_date' | 'rollout_wait'; release: VerifiedRelease; state: UpdaterState }
  | { action: 'hold'; code: UpdateCode; security: boolean; state: UpdaterState };

/** 롤아웃 버킷 id. 앱 릴리스는 버전마다 다시 섞는다(API.md 공식의 id 자리에 넣는다) */
export const rolloutId = (version: string): string => `sax-desktop@${version}`;

/** bucket = u32be(sha256("SAX-rollout-v1\0" ‖ id ‖ "\0" ‖ deviceId)[0..4]) mod 100 (services/registry API.md 롤아웃) */
export function rolloutBucket(id: string, deviceId: string): number {
  const h = createHash('sha256').update(Buffer.from(`SAX-rollout-v1\0${id}\0${deviceId}`, 'utf8')).digest();
  return h.readUInt32BE(0) % 100;
}

export function decideUpdate(input: DecideInput): Decision {
  const policy = input.policy ?? DEFAULT_POLICY;
  let release: VerifiedRelease;
  try {
    release = verifyRelease({ doc: input.doc, channel: input.channel, trust: input.trust, revocation: input.revocation, highestSeen: input.state.highestSeen, now: input.now });
  } catch (e) {
    if (!(e instanceof UpdateError)) throw e;
    return { action: 'hold', code: e.code, security: SECURITY_CODES.has(e.code), state: input.state };
  }
  const m = release.manifest;
  const prev = input.state.highestSeen;
  const below = semverCmp(m.version, input.installedVersion) < 0;
  const highestSeen = below || (prev && semverCmp(prev.version, m.version) > 0) ? prev : { version: m.version, filesDigest: filesDigest(m) };
  const state: UpdaterState = { highestSeen, lastSuccessAt: input.now };
  if (semverCmp(m.version, input.installedVersion) <= 0) return { action: 'none', reason: 'up_to_date', release, state };
  if (policy.requireTransparency && input.transparency !== 'verified') {
    const code: UpdateCode = input.transparency === 'head_mismatch' ? 'registry.head_mismatch' : 'update.transparency_unverified';
    return { action: 'hold', code, security: SECURITY_CODES.has(code), state: { ...input.state, highestSeen } };
  }
  if (rolloutBucket(rolloutId(m.version), input.deviceId) >= m.rolloutPercent) return { action: 'none', reason: 'rollout_wait', release, state };
  return { action: 'download', release, file: m.files[0]!, state };
}

/** 14일 동안 확인 성공이 없으면 알린다(D11 §4). 매니페스트 유효 기간 상한과 같아 동결 공격이 그 안에 드러난다 */
export const STALE_NOTICE_MS = 14 * 24 * 3600_000;

export function needsStaleNotice(state: UpdaterState, installedAt: number, now: number): boolean {
  return now - (state.lastSuccessAt ?? installedAt) > STALE_NOTICE_MS;
}

export interface InstallContext {
  runActive: boolean;
  commitZone: boolean;
  daemonRunning: boolean;
}

/** 실행 중·커밋 구간·데몬 실행 중에는 설치하지 않는다(D11 §4). 미루면 다음 유휴 때 다시 부른다 */
export function installGate(ctx: InstallContext): { install: true } | { install: false; reason: 'run_active' | 'commit_zone' | 'daemon_running' } {
  if (ctx.commitZone) return { install: false, reason: 'commit_zone' };
  if (ctx.runActive) return { install: false, reason: 'run_active' };
  if (ctx.daemonRunning) return { install: false, reason: 'daemon_running' };
  return { install: true };
}

/** 검증된 매니페스트에서 electron-updater용 latest.yml을 만든다(값은 manifest 정규식으로 제한돼 YAML 주입이 없다, API.md와 같은 모양) */
export function renderLatestYml(m: ReleaseManifest): string {
  const lines = [`version: ${m.version}`, 'files:'];
  for (const f of m.files) lines.push(`  - url: ${f.url}`, `    sha512: ${f.sha512}`, `    size: ${f.size}`);
  lines.push(`path: ${m.files[0]!.url}`, `sha512: ${m.files[0]!.sha512}`, `releaseDate: '${new Date(Date.parse(m.releaseDate)).toISOString()}'`);
  return lines.join('\n') + '\n';
}
