import fs from 'node:fs/promises';
import type { Channel, FeedInfo, VerifiedRelease } from '@sax/updater';
import type { UpdateInstaller } from './update-host.ts';

interface VerifiedUpdateInfo extends FeedInfo {
  files: Array<{ url: string; sha512: string; size: number }>;
  path: string;
  sha512: string;
  releaseDate: string;
}

function updateInfoOf(release: VerifiedRelease): VerifiedUpdateInfo {
  const m = release.manifest;
  return {
    version: m.version,
    files: m.files.map((f) => ({ url: f.url, sha512: f.sha512, size: f.size })),
    path: m.files[0]!.url,
    sha512: m.files[0]!.sha512,
    releaseDate: m.releaseDate,
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type ProviderBase = abstract new (runtimeOptions: any) => object;

interface VerifiedFeedConfig {
  provider: 'custom';
  url: string;
  info(): VerifiedUpdateInfo | null;
}

function verifiedFeed(Base: ProviderBase) {
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

export interface AppUpdaterLike {
  autoDownload: boolean;
  autoInstallOnAppQuit: boolean;
  allowDowngrade: boolean;
  allowPrerelease: boolean;
  disableDifferentialDownload: boolean;
  autoRunAppAfterInstall: boolean;
  setFeedURL(o: VerifiedFeedConfig & { updateProvider: unknown }): void;
  checkForUpdates(): Promise<{ updateInfo: FeedInfo; isUpdateAvailable?: boolean } | null>;
  downloadUpdate(): Promise<string[]>;
  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void;
}

export function feedUrl(origin: string, channel: Channel, o: { loopback?: boolean } = {}): string {
  const u = new URL(origin);
  const local = o.loopback === true && u.protocol === 'http:' && u.hostname === '127.0.0.1';
  if ((u.protocol !== 'https:' && !local) || u.pathname !== '/' || u.search || u.hash || u.username || u.password) throw new Error('update.feed_origin_invalid');
  return `${u.origin}/releases/${channel}/`;
}

export function electronInstaller(u: AppUpdaterLike, o: { origin: string; channel: Channel; Provider: ProviderBase; loopback?: boolean; relaunch?: boolean }): UpdateInstaller {
  u.autoDownload = false;
  u.autoInstallOnAppQuit = false;
  u.allowDowngrade = false;
  u.allowPrerelease = false;
  u.disableDifferentialDownload = true;
  u.autoRunAppAfterInstall = o.relaunch !== false;
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
    install: () => u.quitAndInstall(true, true),
  };
}
