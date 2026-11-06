import fs from 'node:fs/promises';
import path from 'node:path';
import { REQUIRED_LOCAL_STATE, REQUIRED_PREFERENCES } from '../constants.ts';

type Json = Record<string, unknown>;

async function readJson(file: string): Promise<Json> {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8')) as Json;
  } catch {
    return {};
  }
}

function getPath(obj: Json, dotted: string): unknown {
  let cur: unknown = obj;
  for (const k of dotted.split('.')) {
    if (!cur || typeof cur !== 'object') return undefined;
    cur = (cur as Json)[k];
  }
  return cur;
}

function setPath(obj: Json, dotted: string, value: unknown): void {
  const keys = dotted.split('.');
  let cur = obj;
  for (const k of keys.slice(0, -1)) {
    if (!cur[k] || typeof cur[k] !== 'object') cur[k] = {};
    cur = cur[k] as Json;
  }
  cur[keys[keys.length - 1]!] = value;
}

const prefsFile = (dir: string) => path.join(dir, 'Default', 'Preferences');
const localStateFile = (dir: string) => path.join(dir, 'Local State');

/** D05 §3.6: 기동 전 Preferences·Local State 기록(엔터프라이즈 정책 미사용). */
export async function writeProfileSettings(profileDir: string, extra: Array<[string, unknown]> = []): Promise<void> {
  await fs.mkdir(path.join(profileDir, 'Default'), { recursive: true, mode: 0o700 });
  const prefs = await readJson(prefsFile(profileDir));
  for (const [k, v] of [...REQUIRED_PREFERENCES, ...extra]) setPath(prefs, k, v);
  await fs.writeFile(prefsFile(profileDir), JSON.stringify(prefs), { mode: 0o600 });
  const ls = await readJson(localStateFile(profileDir));
  for (const [k, v] of REQUIRED_LOCAL_STATE) setPath(ls, k, v);
  await fs.writeFile(localStateFile(profileDir), JSON.stringify(ls), { mode: 0o600 });
}

/** 기동 후 다시 읽어 확인. 불일치 키 목록을 돌려준다. */
export async function verifyProfileSettings(profileDir: string, extra: Array<[string, unknown]> = []): Promise<string[]> {
  const prefs = await readJson(prefsFile(profileDir));
  const ls = await readJson(localStateFile(profileDir));
  const bad: string[] = [];
  for (const [k, v] of [...REQUIRED_PREFERENCES, ...extra]) if (getPath(prefs, k) !== v) bad.push(k);
  for (const [k, v] of REQUIRED_LOCAL_STATE) if (getPath(ls, k) !== v) bad.push(k);
  return bad;
}

// Chrome extensions::mojom::ManifestLocation: 5 = kComponent, 10 = kExternalComponent
const COMPONENT_LOCATIONS = new Set([5, 10]);

/** 설치 확장 ID 열거(S6i 전 간이판: Preferences·Secure Preferences의 extensions.settings). */
export async function listInstalledExtensions(profileDir: string): Promise<string[]> {
  const ids = new Set<string>();
  for (const f of ['Preferences', 'Secure Preferences']) {
    const j = await readJson(path.join(profileDir, 'Default', f));
    const settings = getPath(j, 'extensions.settings');
    if (!settings || typeof settings !== 'object') continue;
    for (const [id, s] of Object.entries(settings as Json)) {
      const loc = (s as Json | null)?.location;
      if (typeof loc === 'number' && COMPONENT_LOCATIONS.has(loc)) continue;
      ids.add(id);
    }
  }
  return [...ids].sort();
}

/** 전용 프로필 Google 로그인 감지(D05 §3.6). */
export async function hasGoogleSignin(profileDir: string): Promise<boolean> {
  const prefs = await readJson(prefsFile(profileDir));
  const accounts = prefs.account_info;
  return (Array.isArray(accounts) && accounts.length > 0) || typeof getPath(prefs, 'google.services.last_gaia_id') === 'string';
}

/** 프로필 아래 크래시 덤프 폴더. Windows·macOS는 Crashpad, Linux는 Crash Reports. */
const CRASH_DUMP_DIRS = ['Crashpad', 'Crash Reports'];

async function countFiles(dir: string): Promise<number> {
  let n = 0;
  for (const e of await fs.readdir(dir, { withFileTypes: true }).catch(() => [])) {
    if (e.isDirectory()) n += await countFiles(path.join(dir, e.name));
    else n++;
  }
  return n;
}

/**
 * 주소·탐색 기록이 남는 프로필 파일(S6 누출 스캐너 회귀). 페이지가 비밀을 주소(해시·쿼리)에 넣거나 자식 프레임 폼으로 POST하면
 * Chrome이 방문 기록·세션 복원(POST 바디 포함)·UKM에 평문으로 적는다. 허용 인자·Preferences로 기록을 끄는 수단을 확인하지 못해 기동 전·종료 뒤에 지운다.
 * 쿠키·Local Storage는 지우지 않는다(포털 로그인 유지, 페이지 자신의 저장소는 남는 위험).
 */
export const PROFILE_RESIDUE_PATHS = [
  'Default/History', 'Default/History-journal', 'Default/Sessions', 'Default/Current Session', 'Default/Current Tabs',
  'Default/Last Session', 'Default/Last Tabs', 'Default/Visited Links', 'Default/Top Sites', 'Default/Top Sites-journal',
  'Default/Shortcuts', 'Default/Shortcuts-journal', 'Default/Network Action Predictor', 'Default/Network Action Predictor-journal',
  'Default/Favicons', 'Default/Favicons-journal', 'segmentation_platform',
] as const;

/**
 * 잔존물·덤프 삭제 옵션.
 * - Windows는 Browser.close 뒤 주 프로세스가 끝나도 자식(네트워크 서비스 등)이 잠시 파일을 잡고 있다. 실기기 10회 중 1회 자식 2개가 남았다
 *   (reports WIN-REALDEVICE §5). 그동안 지우면 EBUSY·EPERM이 난다.
 * - 잠금 오류는 경로마다 짧게 다시 시도한다(전체 상한 RESIDUE_RETRY_BUDGET_MS). 그래도 안 되면 그 경로만 건너뛰고 다음 경로를 지운다.
 *   `onFailed`로 실패 경로 수를 알린다(§6.3: 예전에는 첫 실패에서 멈추고 아무 기록도 없었다).
 */
export interface RemoveOptions {
  /** 시험 전용. 기본 fs.rm. */
  rm?: (p: string, o: { recursive: true; force: true }) => Promise<void>;
  /** 다시 시도 간격 기본값(ms, 시도마다 늘어난다). 시험은 0. */
  retryDelayMs?: number;
  onFailed?: (count: number) => void;
}
/** 경로당 시도 횟수(첫 시도 포함). */
export const RESIDUE_RM_ATTEMPTS = 6;
/** 한 번의 정리 전체에서 다시 시도에 쓰는 시간 상한. 넘으면 남은 경로는 한 번씩만 시도한다. */
export const RESIDUE_RETRY_BUDGET_MS = 3_000;
const BUSY_CODES = new Set(['EBUSY', 'EPERM', 'EACCES', 'ENOTEMPTY']);

/** 지우고 성공 여부를 돌려준다. 잠금 오류만 다시 시도한다. */
async function rmWithRetry(p: string, o: RemoveOptions, budget: { until: number }): Promise<boolean> {
  const rm = o.rm ?? ((x, opt) => fs.rm(x, opt));
  const step = o.retryDelayMs ?? 100;
  for (let i = 1; ; i++) {
    try {
      await rm(p, { recursive: true, force: true });
      return true;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code ?? '';
      if (!BUSY_CODES.has(code) || i >= RESIDUE_RM_ATTEMPTS || Date.now() >= budget.until) return false;
      await new Promise((r) => setTimeout(r, step * i));
    }
  }
}

/** 탐색 기록 잔존물 삭제. 지운 파일 수, 경로 중 하나라도 링크면 링크 너머를 지우지 않고 -1. */
export async function removeProfileResidue(profileDir: string, opts: RemoveOptions = {}): Promise<number> {
  const budget = { until: Date.now() + RESIDUE_RETRY_BUDGET_MS };
  let failed = 0;
  let count = 0;
  for (const rel of PROFILE_RESIDUE_PATHS) {
    const p = path.join(profileDir, ...rel.split('/'));
    const parent = await fs.lstat(path.dirname(p)).catch(() => null);
    if (parent?.isSymbolicLink()) return -1;
    const st = await fs.lstat(p).catch(() => null);
    if (!st) continue;
    if (st.isSymbolicLink()) return -1;
    const n = st.isDirectory() ? await countFiles(p) : 1;
    if (await rmWithRetry(p, opts, budget)) count += n;
    else failed++;
  }
  if (failed) opts.onFailed?.(failed);
  return count;
}

/**
 * 전용 Chrome 크래시 덤프 삭제(N-04). 지운 파일 수를 돌려준다.
 * 덤프 폴더가 심링크·재분석 지점이면 링크 너머를 지우지 않고 -1. 잠금 오류는 removeProfileResidue와 같이 다시 시도한다.
 */
export async function removeCrashDumps(profileDir: string, opts: RemoveOptions = {}): Promise<number> {
  const budget = { until: Date.now() + RESIDUE_RETRY_BUDGET_MS };
  let failed = 0;
  let count = 0;
  for (const name of CRASH_DUMP_DIRS) {
    const dir = path.join(profileDir, name);
    const st = await fs.lstat(dir).catch(() => null);
    if (!st) continue;
    if (st.isSymbolicLink()) return -1;
    const n = st.isDirectory() ? await countFiles(dir) : 1;
    if (await rmWithRetry(dir, opts, budget)) count += n;
    else failed++;
  }
  if (failed) opts.onFailed?.(failed);
  return count;
}
