import fs from 'node:fs';
import { CHROME_CANDIDATES } from '../constants.ts';

function expandWin(p: string): string {
  return p.replace(/%([^%]+)%/g, (_, k: string) => process.env[k] ?? '');
}

/** 사용자 설치 Chrome을 내장 후보 경로에서 찾는다. 인자로 경로를 받지 않는다. */
export function findInstalledChrome(platform: NodeJS.Platform = process.platform): string | null {
  for (const c of CHROME_CANDIDATES[platform] ?? []) {
    const p = platform === 'win32' ? expandWin(c) : c;
    if (p && fs.existsSync(p)) return p;
  }
  return null;
}
