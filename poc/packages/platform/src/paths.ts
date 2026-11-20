import os from 'node:os';
import path from 'node:path';

export interface AppPaths {
  root: string;
  userData: string;
  db: string;
  vault: string;
  chromeProfile: string;
  staging: string;
  logs: string;
  crashDumps: string;
}

export const APP_DIR_NAME = 'SovereignAX';

export function defaultAppRoot(platform: NodeJS.Platform = process.platform): string {
  if (platform === 'win32') {
    const local = process.env.LOCALAPPDATA;
    if (!local) throw new Error('LOCALAPPDATA is not set');
    return path.win32.join(local, APP_DIR_NAME);
  }
  if (platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support', APP_DIR_NAME);
  return path.join(os.homedir(), '.local', 'share', APP_DIR_NAME);
}

export function appPaths(root: string = defaultAppRoot()): AppPaths {
  const j = (p: string) => path.join(root, p);
  return {
    root,
    userData: j('userData'),
    db: j('db'),
    vault: j('vault'),
    chromeProfile: j('chrome-profile'),
    staging: j('staging'),
    logs: j('logs'),
    crashDumps: j('crashDumps'),
  };
}
