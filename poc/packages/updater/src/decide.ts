// 업데이트 판정(ADR-028 결정 2, D09 §8.3·§8.6, D11 §4 자동 업데이트 행). 입력은 모두 값이다: 네트워크·Electron·시계 없음.
// 판정 흐름(main 배선, README "배선 순서"): latest.json 받기 → decideUpdate → download이면 electron-updater에 넘기기 전 matchFeed →
// 받은 파일 verifyDownloadedFile → installGate가 now일 때만 설치.
import { createHash } from 'node:crypto';
import { SECURITY_CODES, semverCmp, UpdateError, type Channel, type ReleaseFile, type ReleaseManifest, type UpdateCode } from './manifest.ts';
import { filesDigest, verifyRelease, type Revocation, type SeenRelease, type TrustRoot, type VerifiedRelease } from './verify.ts';

/** 투명성 로그·미러 확인 결과(ADR-028 결정 2, E-14). main이 latest.json 다이제스트·설치본 sha512의 포함 증명과 미러 헤드를 확인한 값 */
export type Transparency = 'verified' | 'head_mismatch' | 'unverified';

export interface UpdatePolicy {
  /**
   * 투명성 로그 포함 증명·미러 확인을 요구한다(ADR-028 결정 2). 기본 true(fail-closed).
   * 로그가 아직 없는 동안 false로 두는 것은 팀장 결정 사항이다(PR 본문).
   */
  requireTransparency: boolean;
}

export const DEFAULT_POLICY: UpdatePolicy = { requireTransparency: true };

/** 채널별 저장 상태(main이 DB·파일에 둔다). */
export interface UpdaterState {
  highestSeen: SeenRelease | null;
  /** 마지막으로 검증까지 성공한 확인 시각(ms). 처음이면 null */
  lastSuccessAt: number | null;
}

export const INITIAL_STATE: UpdaterState = { highestSeen: null, lastSuccessAt: null };

export interface DecideInput {
  doc: unknown;
  channel: Channel;
  trust: TrustRoot;
  revocation: Revocation;
  /** 지금 설치된 앱 버전(app.getVersion()) */
  installedVersion: string;
  state: UpdaterState;
  /** 롤아웃 버킷용 기기 ID(원문을 밖으로 보내지 않는다, 여기서만 해시) */
  deviceId: string;
  transparency: Transparency;
  now: number;
  policy?: UpdatePolicy;
}

export type Decision =
  /** 받을 것: release 검증 통과, file이 설치본(files[0], latest.yml path) */
  | { action: 'download'; release: VerifiedRelease; file: ReleaseFile; state: UpdaterState }
  /** 할 일 없음: 최신이거나 롤아웃 차례가 아니다. 검증은 통과했다 */
  | { action: 'none'; reason: 'up_to_date' | 'rollout_wait'; release: VerifiedRelease; state: UpdaterState }
  /** 보류: 설치본 유지, "업데이트를 확인하지 못했습니다". security면 보안 이벤트로 남긴다 */
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
  // 검증을 통과한 매니페스트만 "본 것"으로 올린다(롤백 판정 기준). 낮아지지 않는다
  const prev = input.state.highestSeen;
  const highestSeen = prev && semverCmp(prev.version, m.version) > 0 ? prev : { version: m.version, filesDigest: filesDigest(m) };
  const state: UpdaterState = { highestSeen, lastSuccessAt: input.now };
  // 설치본보다 높지 않으면 할 일 없음(다운그레이드 금지, D11 §4)
  if (semverCmp(m.version, input.installedVersion) <= 0) return { action: 'none', reason: 'up_to_date', release, state };
  if (policy.requireTransparency && input.transparency !== 'verified') {
    const code: UpdateCode = input.transparency === 'head_mismatch' ? 'registry.head_mismatch' : 'update.transparency_unverified';
    // 로그를 확인하지 못한 것은 확인 성공이 아니다: lastSuccessAt을 올리지 않는다(14일 미확인 알림이 살아 있게)
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
  /** 실행(플레이북)이 돌고 있다 */
  runActive: boolean;
  /** 커밋 구간 안이다(D03, 되돌릴 수 없는 제출 앞뒤) */
  commitZone: boolean;
  /** 데몬 실행 중이다 */
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
