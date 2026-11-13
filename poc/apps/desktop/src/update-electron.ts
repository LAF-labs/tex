// electron-updater 어댑터(ADR-028 결정 1: 받기·설치만 맡긴다). 신뢰 판단은 update-host.ts(@sax/updater)가 한다.
// - 피드 파일(latest.yml·latest-mac.yml)을 읽지 않는다. 검증을 통과한 latest.json 값을 사용자 정의 공급자(VerifiedFeed)로 넘긴다.
//   electron-updater가 받는 파일 이름·sha512·크기는 서명된 매니페스트 것뿐이다. mac은 latest-mac.yml을 찾는데 레지스트리는 latest.yml만 만들기 때문이기도 하다.
// - 파일은 {origin}/releases/{channel}/{파일 이름}에서 받는다(매니페스트 url은 파일 이름만). mac은 .zip(Squirrel.Mac), Windows는 .exe(NSIS)를 고른다.
// - autoDownload·autoInstallOnAppQuit·allowDowngrade를 끈다: 우리가 검증한 뒤에만 받고, 관문을 본 뒤에만 설치하며, 내려가지 않는다.
// - 차등 다운로드를 끈다: 블록맵은 서명된 매니페스트가 다루지 않는 파일이다.
// - 설치 직전 서명 확인은 OS 쪽이 한 번 더 한다: mac은 Squirrel.Mac이 새 앱이 지금 앱의 지정 요구사항(팀 ID)을 만족하는지, Windows는 verifyUpdateCodeSignature.
import fs from 'node:fs/promises';
import type { Channel, FeedInfo, VerifiedRelease } from '@sax/updater';
import type { UpdateInstaller } from './update-host.ts';

/** VerifiedFeed가 electron-updater에 돌려주는 업데이트 정보(6.8.x UpdateInfo 가운데 쓰는 칸). */
export interface VerifiedUpdateInfo extends FeedInfo {
  files: Array<{ url: string; sha512: string; size: number }>;
  path: string;
  sha512: string;
  releaseDate: string;
}

export function updateInfoOf(release: VerifiedRelease): VerifiedUpdateInfo {
  const m = release.manifest;
  return {
    version: m.version,
    files: m.files.map((f) => ({ url: f.url, sha512: f.sha512, size: f.size })),
    path: m.files[0]!.url,
    sha512: m.files[0]!.sha512,
    releaseDate: m.releaseDate,
  };
}

/** electron-updater Provider 생성자(6.8.x). 시험이 electron 없이 돌도록 electron-updater 모듈에서 꺼내 넘긴다. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type ProviderBase = abstract new (runtimeOptions: any) => object;

interface VerifiedFeedConfig {
  provider: 'custom';
  url: string;
  info(): VerifiedUpdateInfo | null;
}

/** 사용자 정의 공급자: 받을 정보는 check()가 넣은 검증된 값뿐이고, 파일 주소는 피드 기준 주소 + 파일 이름이다. */
export function verifiedFeed(Base: ProviderBase) {
  return class VerifiedFeed extends Base {
    readonly cfg: VerifiedFeedConfig;
    constructor(cfg: VerifiedFeedConfig, _updater: unknown, runtimeOptions: unknown) {
      super(runtimeOptions);
      this.cfg = cfg;
    }
    async getLatestVersion(): Promise<VerifiedUpdateInfo> {
      const i = this.cfg.info();
      if (!i) throw new Error('update.no_verified_release');
      return i;
    }
    resolveFiles(info: VerifiedUpdateInfo): Array<{ url: URL; info: VerifiedUpdateInfo['files'][number] }> {
      const base = new URL(this.cfg.url);
      return info.files.map((f) => ({ url: new URL(f.url, base), info: f }));
    }
  };
}

/** electron-updater AppUpdater 가운데 쓰는 부분(6.8.x). 시험은 이 모양의 가짜를 넘긴다. */
export interface AppUpdaterLike {
  autoDownload: boolean;
  autoInstallOnAppQuit: boolean;
  allowDowngrade: boolean;
  allowPrerelease: boolean;
  disableDifferentialDownload: boolean;
  setFeedURL(o: VerifiedFeedConfig & { updateProvider: unknown }): void;
  checkForUpdates(): Promise<{ updateInfo: FeedInfo; isUpdateAvailable?: boolean } | null>;
  downloadUpdate(): Promise<string[]>;
  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void;
}

/**
 * 레지스트리 origin(https만, 경로 없음) + 채널 → 피드 기준 주소. 틀리면 던진다.
 * loopback은 실계정 시험 빌드의 로컬 피드(http://127.0.0.1:포트)만 받는다(shell.ts가 testBuild일 때만 켠다).
 */
export function feedUrl(origin: string, channel: Channel, o: { loopback?: boolean } = {}): string {
  const u = new URL(origin);
  const local = o.loopback === true && u.protocol === 'http:' && u.hostname === '127.0.0.1';
  if ((u.protocol !== 'https:' && !local) || u.pathname !== '/' || u.search || u.hash || u.username || u.password) throw new Error('update.feed_origin_invalid');
  return `${u.origin}/releases/${channel}/`;
}

export function electronInstaller(u: AppUpdaterLike, o: { origin: string; channel: Channel; Provider: ProviderBase; loopback?: boolean }): UpdateInstaller {
  u.autoDownload = false;
  u.autoInstallOnAppQuit = false;
  u.allowDowngrade = false;
  u.allowPrerelease = false;
  u.disableDifferentialDownload = true;
  let next: VerifiedUpdateInfo | null = null;
  u.setFeedURL({ provider: 'custom', updateProvider: verifiedFeed(o.Provider), url: feedUrl(o.origin, o.channel, { loopback: o.loopback }), info: () => next });
  return {
    async check(release) {
      next = updateInfoOf(release);
      const r = await u.checkForUpdates();
      if (!r || r.isUpdateAvailable === false) return null;
      return r.updateInfo;
    },
    download: () => u.downloadUpdate(),
    async discard(file) {
      await fs.rm(file, { force: true }).catch(() => {});
    },
    // Windows: 조용히 설치(사용자별 NSIS) 뒤 다시 연다. mac: Squirrel.Mac이 앱을 바꾸고 다시 연다(인자는 쓰지 않는다)
    install: () => u.quitAndInstall(true, true),
  };
}
