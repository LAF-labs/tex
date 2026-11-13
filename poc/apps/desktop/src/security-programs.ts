// 홈택스 공동인증서 보안 프로그램(MagicLine4NX) 점검(B4, 부장 지시 2026-11-13). 홈택스가 "보안프로그램 설치" 안내로 가기 전에 앱이 먼저 알아챈다.
// - 홈택스 인증서 창(ML4Web)은 이 PC의 MagicLine4NX(127.0.0.1:42235)에 붙어 하드디스크 인증서를 읽는다(공개 정적 파일 ML4Web_Config.js CS_PORT).
// - 점검은 네트워크 없이 한다: 설치 자리(앱 폴더)가 있는가, 프로세스가 떠 있는가. 포트를 두드리지 않는다(PC 쪽 송신은 net/egress만).
// - 설치 링크는 홈택스가 직접 내려 주는 파일이다(ML4Web_Config.js CS_DOWNLOAD_MAC·WIN). 기본 브라우저로 연다(사람이 설치를 마친다).
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { EXTERNAL_LINKS, type ExternalLinkKey } from './external-links.ts';

export type SecurityState = 'ok' | 'missing' | 'stopped' | 'unknown';
export interface SecurityStatus {
  state: SecurityState;
  /** 사람에게 보일 이름. */
  name: string;
  /** 설치 파일(홈택스 공식) 열기 키(external-links.ts)와 화면에 글자로 보일 주소. 이 플랫폼에 없으면 null. */
  installKey: ExternalLinkKey | null;
  installUrl: string | null;
  /** [켜기]를 보일 수 있는가(설치는 됐는데 꺼져 있고, 앱이 켤 수 있다). */
  canStart: boolean;
}

const NAME = 'MagicLine4NX(홈택스 공동인증서 프로그램)';
const MAC_APP = '/Applications/MagicLine4NX/MagicLine4NX.app';
/** Windows 설치 자리 후보(DreamSecurity 기본 설치 폴더). 못 찾으면 unknown이라 막지 않는다. */
const WIN_DIRS = ['C:\\Program Files (x86)\\DreamSecurity\\MagicLine4NX', 'C:\\Program Files\\DreamSecurity\\MagicLine4NX'];

export interface SecurityProbe {
  platform: NodeJS.Platform;
  exists(p: string): boolean;
  /** 이름이 같은 프로세스가 떠 있는가. 알 수 없으면 null. */
  running(name: string): boolean | null;
}

export const realProbe: SecurityProbe = {
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

/** 지금 상태. 모르는 플랫폼·알 수 없는 상태는 unknown(막지 않는다, 홈택스 안내가 마지막 자리다). */
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
    // 설치 자리를 못 찾아도 다른 폴더에 깔렸을 수 있다: 프로세스가 떠 있으면 ok
    const on = probe.running('MagicLine4NX');
    if (on) return { state: 'ok', name: NAME, ...inst, canStart: false };
    if (!dir) return { state: on === false ? 'missing' : 'unknown', name: NAME, ...inst, canStart: false };
    return { state: on === false ? 'stopped' : 'unknown', name: NAME, ...inst, canStart: false };
  }
  return { state: 'unknown', name: NAME, installKey: null, installUrl: null, canStart: false };
}

/** 막아야 하는가(없음·꺼짐). */
export const securityBlocks = (s: SecurityStatus) => s.state === 'missing' || s.state === 'stopped';

/** 꺼진 MagicLine4NX를 켠다(macOS만, `open` 한 번). 켰다고 바로 뜨지는 않으니 부르는 쪽이 잠시 뒤 다시 본다. */
export function startSecurityProgram(probe: SecurityProbe = realProbe): boolean {
  if (probe.platform !== 'darwin' || !probe.exists(MAC_APP)) return false;
  const r = spawnSync('open', [MAC_APP], { timeout: 5_000 });
  return r.status === 0;
}
