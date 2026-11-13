// 앱 업데이트 배선(D14 M4-9, ADR-028 결정 1~3, D11 §4 자동 업데이트 행). packages/updater README "배선 순서" 1~5단계를 main에서 돈다.
// - 신뢰 판단은 @sax/updater만 한다: latest.json 서명·만료·채널·단조 버전(decideUpdate) → 검증한 값만 electron-updater에 넘기고 대조(matchFeed)
//   → 받은 설치본 sha512 재확인(verifyDownloadedFile) → 설치 관문(installGate). electron-updater는 받기·설치만 한다.
// - 원천(latest.json·폐기 목록·핀 키·투명성 확인)은 포트다. 어느 하나라도 못 받으면 보류(설치본 유지)이고 상태를 바꾸지 않는다(fail-closed).
// - 투명성 확인(requireTransparency)은 제품에서 늘 켠다. 실계정 시험 빌드에서만 설정으로 끌 수 있다(팀장 결정 11-05, updatePolicy).
// - 상태: userData/updater-state.json(채널별 본 최고 버전·파일 다이제스트·마지막 성공 시각, 설치 id·처음 기동 시각). 값·경로·기기 정보 없음.
// - 로그: 결과·코드만(main.update_*). 버전 문자열도 남기지 않는다.
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  CHANNELS,
  decideUpdate,
  DEFAULT_POLICY,
  INITIAL_STATE,
  installGate,
  matchFeed,
  needsStaleNotice,
  SECURITY_CODES,
  verifyDownloadedFile,
  type Channel,
  type Decision,
  type FeedInfo,
  type InstallContext,
  type ReleaseFile,
  type Revocation,
  type Transparency,
  type TrustRoot,
  type UpdateCode,
  type UpdatePolicy,
  type UpdaterState,
  type VerifiedRelease,
} from '@sax/updater';

export type UpdateLog = (name: string, data?: Record<string, string | number | boolean>) => void;

/** 판정 원천. 모두 던지면 보류다(설치본 유지). */
export interface UpdateSources {
  /** 레지스트리 GET /releases/{channel}/latest.json 바이트 그대로(egress). 투명성 로그는 이 바이트의 sha256을 기록한다. */
  latest(channel: Channel): Promise<Uint8Array>;
  /** 앱에 내장된 핀 키 + 엔진이 수용한 폐기 목록(keyIds·24시간 신선도). */
  registry(): Promise<{ trust: TrustRoot; revocation: Revocation }>;
  /** 받은 latest.json 바이트가 서명된 로그 헤드에 포함됐는지(ADR-028 결정 2, update-sources.ts). */
  transparency(bytes: Uint8Array, channel: Channel): Promise<Transparency>;
}

/** 설치기(electron-updater 어댑터, update-electron.ts). */
export interface UpdateInstaller {
  /** 검증한 릴리스를 electron-updater에 넘겨 읽힌 값. 새 버전이 없다고 하면 null. */
  check(release: VerifiedRelease): Promise<FeedInfo | null>;
  /** 받은 파일 경로들. */
  download(): Promise<string[]>;
  /** 받은 파일을 지운다(검증 실패). 못 지워도 던지지 않는다. */
  discard(file: string): Promise<void>;
  /** 재시작해 설치한다. */
  install(): void;
}

export interface UpdateTimers {
  setInterval(f: () => void, ms: number): unknown;
  clearInterval(h: unknown): void;
}

export interface UpdateHostOptions {
  sources: UpdateSources;
  installer: UpdateInstaller;
  channel: Channel;
  /** app.getVersion() */
  installedVersion: string;
  stateFile: string;
  policy: UpdatePolicy;
  /** 설치 관문 입력(실행 중·커밋 구간·데몬 실행). */
  idle: () => InstallContext;
  /** 14일 동안 확인 성공이 없을 때(하루 한 번까지). */
  onStale?: () => void;
  log?: UpdateLog;
  now?: () => number;
  timers?: UpdateTimers;
  /** 확인 주기(기본 15분, D09 §8.1과 같다) */
  checkEveryMs?: number;
  /** 설치 미룸 재시도 주기(기본 1분) */
  installRetryMs?: number;
}

export type CheckOutcome =
  | { result: 'busy' }
  | { result: 'source_failed' }
  | { result: 'hold'; code: UpdateCode; security: boolean }
  | { result: 'none'; reason: 'up_to_date' | 'rollout_wait' }
  | { result: 'feed_failed' }
  | { result: 'feed_mismatch' }
  | { result: 'download_failed' }
  | { result: 'bad_download'; code: UpdateCode }
  | { result: 'downloaded'; installed: boolean };

export interface UpdateHost {
  /** 지금 한 번 확인한다(기동·주기·절전 복귀). 겹치면 busy. */
  check(): Promise<CheckOutcome>;
  /** 받아 둔 설치본이 있으면 관문을 보고 설치한다. 설치했으면 true. */
  tryInstall(): boolean;
  stop(): void;
}

// ---- 정책 ----

/**
 * UpdatePolicy 정하기(팀장 결정 11-05). 제품 빌드는 설정이 있어도 무시하고 투명성 확인을 요구한다(fail-closed). 그때 경고 로그를 남긴다.
 * 실계정 시험 빌드(testBuild)에서만 setting.requireTransparency === false를 받는다.
 */
export function updatePolicy(o: { testBuild: boolean; setting?: { requireTransparency?: unknown } | null; log?: UpdateLog }): UpdatePolicy {
  const off = o.setting?.requireTransparency === false;
  if (off && !o.testBuild) {
    o.log?.('main.update_policy_ignored', { field: 'requireTransparency' });
    return DEFAULT_POLICY;
  }
  if (off) o.log?.('main.update_transparency_off', { testBuild: true });
  return off ? { requireTransparency: false } : DEFAULT_POLICY;
}

// ---- 상태 파일 ----

export interface UpdaterFile {
  v: 1;
  /** 롤아웃 버킷용 설치 id(밖으로 보내지 않는다, @sax/updater가 해시만 쓴다) */
  installId: string;
  /** 이 설치본의 처음 기동 시각(14일 미확인 알림 기준) */
  installedAt: number;
  channels: Partial<Record<Channel, UpdaterState>>;
  staleNotifiedAt: number | null;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const SEEN_RE = { version: /^\d{1,6}\.\d{1,6}\.\d{1,6}$/, digest: /^[0-9a-f]{64}$/ };

function isState(v: unknown): v is UpdaterState {
  if (!isObj(v) || !(v.lastSuccessAt === null || isNum(v.lastSuccessAt))) return false;
  const h = v.highestSeen;
  return h === null || (isObj(h) && typeof h.version === 'string' && SEEN_RE.version.test(h.version) && typeof h.filesDigest === 'string' && SEEN_RE.digest.test(h.filesDigest));
}

/**
 * 상태 파일. 모양이 틀리면 새로 만든다. 단, 본 최고 버전을 잃으면 롤백 기준이 사라지므로(되감기 공격 창) 틀린 채널만 버리지 않고
 * 파일 전체를 새로 시작하되 그 사실을 로그로 남긴다(main.update_state_reset). 쓰기는 임시 파일 → 이름 바꾸기.
 */
export class UpdaterStateFile {
  private readonly file: string;
  private readonly now: () => number;
  constructor(file: string, now: () => number = Date.now) {
    this.file = file;
    this.now = now;
  }
  load(log?: UpdateLog): UpdaterFile {
    let raw: unknown;
    try {
      raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') log?.('main.update_state_reset', { why: 'unreadable' });
      return this.fresh();
    }
    if (
      isObj(raw) && raw.v === 1 && typeof raw.installId === 'string' && /^[0-9a-f-]{36}$/.test(raw.installId) && isNum(raw.installedAt) &&
      (raw.staleNotifiedAt === null || isNum(raw.staleNotifiedAt)) && isObj(raw.channels) &&
      Object.entries(raw.channels).every(([k, s]) => (CHANNELS as readonly string[]).includes(k) && isState(s))
    ) {
      return raw as unknown as UpdaterFile;
    }
    log?.('main.update_state_reset', { why: 'shape' });
    return this.fresh();
  }
  save(s: UpdaterFile): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(s));
    fs.renameSync(tmp, this.file);
  }
  private fresh(): UpdaterFile {
    const s: UpdaterFile = { v: 1, installId: randomUUID(), installedAt: this.now(), channels: {}, staleNotifiedAt: null };
    this.save(s);
    return s;
  }
}

// ---- 본체 ----

const DAY_MS = 24 * 3600_000;

/** 받은 파일 가운데 설치본(files[0] 주소의 마지막 이름과 같은 것, electron-updater가 그 이름으로 저장한다). 없으면 첫 파일(어차피 sha512 재확인에서 걸린다). */
export function pickInstaller(files: readonly string[], want: ReleaseFile): string | null {
  const name = want.url.startsWith('https://') ? path.posix.basename(new URL(want.url).pathname) : want.url;
  return files.find((f) => path.basename(f) === name) ?? files[0] ?? null;
}

export function startUpdateHost(o: UpdateHostOptions): UpdateHost {
  const log = o.log ?? (() => {});
  const now = o.now ?? Date.now;
  const store = new UpdaterStateFile(o.stateFile, now);
  let file = store.load(log);
  let running = false;
  let pending: { path: string } | null = null;
  let installed = false;

  const stale = () => {
    const st = file.channels[o.channel] ?? INITIAL_STATE;
    const t = now();
    if (!needsStaleNotice(st, file.installedAt, t)) return;
    if (file.staleNotifiedAt !== null && t - file.staleNotifiedAt < DAY_MS) return;
    file = { ...file, staleNotifiedAt: t };
    store.save(file);
    log('main.update_stale_notice');
    o.onStale?.();
  };

  const saveState = (st: UpdaterState) => {
    file = { ...file, channels: { ...file.channels, [o.channel]: st } };
    store.save(file);
  };

  const decide = async (doc: unknown, reg: { trust: TrustRoot; revocation: Revocation }, transparency: Transparency): Promise<Decision> =>
    decideUpdate({
      doc, channel: o.channel, trust: reg.trust, revocation: reg.revocation, installedVersion: o.installedVersion,
      state: file.channels[o.channel] ?? INITIAL_STATE, deviceId: file.installId, transparency, now: now(), policy: o.policy,
    });

  const tryInstall = (): boolean => {
    if (!pending || installed) return false;
    const g = installGate(o.idle());
    if (!g.install) {
      log('main.update_install_deferred', { reason: g.reason });
      return false;
    }
    installed = true;
    log('main.update_install');
    o.installer.install();
    return true;
  };

  const download = async (release: VerifiedRelease, want: ReleaseFile): Promise<CheckOutcome> => {
    let info: FeedInfo | null;
    try {
      info = await o.installer.check(release);
    } catch {
      log('main.update_check', { result: 'feed_failed' });
      return { result: 'feed_failed' };
    }
    // electron-updater가 받을 값이 검증한 매니페스트와 다르면 받지 않는다(보안 이벤트)
    if (!info || !matchFeed(release, info).ok) {
      log('main.update_held', { code: 'update.feed_mismatch', security: true });
      return { result: 'feed_mismatch' };
    }
    let files: string[];
    try {
      files = await o.installer.download();
    } catch {
      log('main.update_check', { result: 'download_failed' });
      return { result: 'download_failed' };
    }
    const got = pickInstaller(files, want);
    const v = got ? await verifyDownloadedFile(got, want) : ({ ok: false, code: 'update.digest_mismatch' } as const);
    if (!v.ok) {
      // 받은 파일은 지우고 다음 주기에 처음부터(README 롤백 규칙 4)
      for (const f of files) await o.installer.discard(f);
      log('main.update_held', { code: v.code, security: SECURITY_CODES.has(v.code) });
      return { result: 'bad_download', code: v.code };
    }
    pending = { path: got! };
    log('main.update_check', { result: 'downloaded' });
    return { result: 'downloaded', installed: tryInstall() };
  };

  const checkOnce = async (): Promise<CheckOutcome> => {
    if (pending) return { result: 'downloaded', installed: tryInstall() };
    let bytes: Uint8Array;
    let reg: { trust: TrustRoot; revocation: Revocation };
    try {
      [bytes, reg] = await Promise.all([o.sources.latest(o.channel), o.sources.registry()]);
    } catch {
      log('main.update_check', { result: 'source_failed' });
      return { result: 'source_failed' };
    }
    let doc: unknown;
    try {
      doc = JSON.parse(Buffer.from(bytes).toString('utf8'));
    } catch {
      // 모양 오류로 판정한다(update.manifest_invalid)
      doc = undefined;
    }
    // 투명성 확인은 검증을 통과한 더 높은 버전에만 묻는다: 먼저 미확인으로 판정해 보고, 그 이유로 보류일 때만 확인한다.
    let d = await decide(doc, reg, 'unverified');
    if (d.action === 'hold' && d.code === 'update.transparency_unverified') {
      const t: Transparency = await o.sources.transparency(bytes, o.channel).catch(() => 'unverified' as const);
      if (t !== 'unverified') d = await decide(doc, reg, t);
    }
    saveState(d.state);
    if (d.action === 'hold') {
      log('main.update_held', { code: d.code, security: d.security });
      return { result: 'hold', code: d.code, security: d.security };
    }
    if (d.action === 'none') {
      log('main.update_check', { result: d.reason });
      return { result: 'none', reason: d.reason };
    }
    return download(d.release, d.file);
  };

  const check = async (): Promise<CheckOutcome> => {
    if (running || installed) return { result: 'busy' };
    running = true;
    try {
      return await checkOnce();
    } finally {
      running = false;
      stale();
    }
  };

  const timers = o.timers ?? { setInterval: (f, ms) => setInterval(f, ms), clearInterval: (h) => clearInterval(h as ReturnType<typeof setInterval>) };
  const hCheck = timers.setInterval(() => void check(), o.checkEveryMs ?? 15 * 60_000);
  const hInstall = timers.setInterval(() => void tryInstall(), o.installRetryMs ?? 60_000);
  return {
    check,
    tryInstall,
    stop: () => {
      timers.clearInterval(hCheck);
      timers.clearInterval(hInstall);
    },
  };
}
