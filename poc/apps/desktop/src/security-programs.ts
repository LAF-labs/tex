import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { EXTERNAL_LINKS, type ExternalLinkKey } from './external-links.ts';

export type SecurityState = 'ok' | 'missing' | 'stopped' | 'unknown';
export interface SecurityStatus {
  state: SecurityState;
  name: string;
  installKey: ExternalLinkKey | null;
  installUrl: string | null;
  canStart: boolean;
}

const NAME = 'MagicLine4NX(홈택스 공동인증서 프로그램)';
const MAC_APP = '/Applications/MagicLine4NX/MagicLine4NX.app';
const WIN_DIRS = ['C:\\Program Files (x86)\\DreamSecurity\\MagicLine4NX', 'C:\\Program Files\\DreamSecurity\\MagicLine4NX'];

interface SecurityProbe {
  platform: NodeJS.Platform;
  exists(p: string): boolean;
  running(name: string): boolean | null;
}

const realProbe: SecurityProbe = {
  platform: process.platform,
  exists: (p) => existsSync(p),
  running: (name) => {
    try {
      if (process.platform === 'win32') {
        const r = spawnSync('tasklist', ['/FI', `IMAGENAME eq ${name}.exe`, '/NH'], { encoding: 'utf8', timeout: 3_000, windowsHide: true });
        return r.status === 0 ? r.stdout.toLowerCase().includes(`${name.toLowerCase()}.exe`) : null;
      }
      const r = spawnSync('pgrep', ['-x', name], { timeout: 3_000 });
      return r.status === 0 ? true : r.status === 1 ? false : null;
    } catch {
      return null;
    }
  },
};

export function securityStatus(probe: SecurityProbe = realProbe): SecurityStatus {
  if (probe.platform === 'darwin') {
    const inst = { installKey: 'magicline.mac', installUrl: EXTERNAL_LINKS['magicline.mac'] } as const;
    if (!probe.exists(MAC_APP)) return { state: 'missing', name: NAME, ...inst, canStart: false };
    const on = probe.running('MagicLine4NX');
    return { state: on === false ? 'stopped' : on ? 'ok' : 'unknown', name: NAME, ...inst, canStart: on === false };
  }
  if (probe.platform === 'win32') {
    const inst = { installKey: 'magicline.win', installUrl: EXTERNAL_LINKS['magicline.win'] } as const;
    const dir = WIN_DIRS.find((d) => probe.exists(d));
    const on = probe.running('MagicLine4NX');
    if (on) return { state: 'ok', name: NAME, ...inst, canStart: false };
    if (!dir) return { state: on === false ? 'missing' : 'unknown', name: NAME, ...inst, canStart: false };
    return { state: on === false ? 'stopped' : 'unknown', name: NAME, ...inst, canStart: false };
  }
  return { state: 'unknown', name: NAME, installKey: null, installUrl: null, canStart: false };
}

export const securityBlocks = (s: SecurityStatus) => s.state === 'missing' || s.state === 'stopped';

export function startSecurityProgram(probe: SecurityProbe = realProbe): boolean {
  if (probe.platform !== 'darwin' || !probe.exists(MAC_APP)) return false;
  const r = spawnSync('open', [MAC_APP], { timeout: 5_000 });
  return r.status === 0;
}
