// electron-updater 어댑터(ADR-028 결정 1: 받기·설치만 맡긴다). 신뢰 판단은 update-host.ts(@sax/updater)가 한다.
// - autoDownload·autoInstallOnAppQuit·allowDowngrade를 끈다: 우리가 검증한 뒤에만 받고, 관문을 본 뒤에만 설치하며, 내려가지 않는다.
// - 피드는 레지스트리 /releases/{channel}/latest.yml(generic). electron-updater가 읽은 값은 matchFeed로 우리 매니페스트와 대조한다.
// - Authenticode 서명 주체 검사는 electron-builder 설정(verifyUpdateCodeSignature, 2차 방어)이 한다.
import fs from 'node:fs/promises';
import type { Channel, FeedInfo } from '@sax/updater';
import type { UpdateInstaller } from './update-host.ts';

/** electron-updater AppUpdater 가운데 쓰는 부분(6.8.x). 시험은 이 모양의 가짜를 넘긴다. */
export interface AppUpdaterLike {
  autoDownload: boolean;
  autoInstallOnAppQuit: boolean;
  allowDowngrade: boolean;
  allowPrerelease: boolean;
  setFeedURL(o: { provider: 'generic'; url: string; channel?: string }): void;
  checkForUpdates(): Promise<{ updateInfo: FeedInfo; isUpdateAvailable?: boolean } | null>;
  downloadUpdate(): Promise<string[]>;
  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void;
}

/** 레지스트리 origin(https만, 경로 없음) + 채널 → generic 피드 URL. 틀리면 던진다. */
export function feedUrl(origin: string, channel: Channel): string {
  const u = new URL(origin);
  if (u.protocol !== 'https:' || u.pathname !== '/' || u.search || u.hash || u.username || u.password) throw new Error('update.feed_origin_invalid');
  return `${u.origin}/releases/${channel}/`;
}

export function electronInstaller(u: AppUpdaterLike, o: { origin: string; channel: Channel }): UpdateInstaller {
  u.autoDownload = false;
  u.autoInstallOnAppQuit = false;
  u.allowDowngrade = false;
  u.allowPrerelease = false;
  // generic 공급자는 {url}{channel}.yml을 읽는다: 채널 'latest' → /releases/{channel}/latest.yml
  u.setFeedURL({ provider: 'generic', url: feedUrl(o.origin, o.channel), channel: 'latest' });
  return {
    async check() {
      const r = await u.checkForUpdates();
      if (!r || r.isUpdateAvailable === false) return null;
      return r.updateInfo;
    },
    download: () => u.downloadUpdate(),
    async discard(file) {
      await fs.rm(file, { force: true }).catch(() => {});
    },
    // 조용히 설치(사용자별 NSIS), 설치 뒤 다시 연다
    install: () => u.quitAndInstall(true, true),
  };
}
