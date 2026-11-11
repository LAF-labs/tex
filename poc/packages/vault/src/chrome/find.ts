import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CHROME_CANDIDATES } from '../constants.ts';

/** Chrome이 후보 어디에도 없을 때 금고가 던지는 고정 코드(엔진이 RunEnd 코드로 그대로 옮긴다, 데스크톱이 사람 말로 바꾼다). */
export const CHROME_NOT_INSTALLED = 'chrome.not_installed';

function expandWin(p: string): string {
  return p.replace(/%([^%]+)%/g, (_, k: string) => process.env[k] ?? '');
}

/**
 * macOS·Linux 후보의 `~/`는 이 사용자 홈이다(환경 변수가 아니라 os.homedir). 홈을 모르면 그 후보는 건너뛴다.
 * 이어 붙이기는 실행 중인 OS의 path다(macOS에서는 posix와 같다. 다른 OS의 시험에서 구분자가 섞이지 않게).
 */
function expandHome(p: string, home: string): string {
  if (!p.startsWith('~/')) return p;
  return home ? path.join(home, p.slice(2)) : '';
}

/** 사용자 설치 Chrome을 내장 후보 경로에서 찾는다. 인자로 경로를 받지 않는다(home은 시험용). */
export function findInstalledChrome(platform: NodeJS.Platform = process.platform, home: string = os.homedir()): string | null {
  for (const c of CHROME_CANDIDATES[platform] ?? []) {
    const p = platform === 'win32' ? expandWin(c) : expandHome(c, home);
    if (p && fs.existsSync(p)) return p;
  }
  return null;
}
