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
export async function writeProfileSettings(profileDir: string): Promise<void> {
  await fs.mkdir(path.join(profileDir, 'Default'), { recursive: true, mode: 0o700 });
  const prefs = await readJson(prefsFile(profileDir));
  for (const [k, v] of REQUIRED_PREFERENCES) setPath(prefs, k, v);
  await fs.writeFile(prefsFile(profileDir), JSON.stringify(prefs), { mode: 0o600 });
  const ls = await readJson(localStateFile(profileDir));
  for (const [k, v] of REQUIRED_LOCAL_STATE) setPath(ls, k, v);
  await fs.writeFile(localStateFile(profileDir), JSON.stringify(ls), { mode: 0o600 });
}

/** 기동 후 다시 읽어 확인. 불일치 키 목록을 돌려준다. */
export async function verifyProfileSettings(profileDir: string): Promise<string[]> {
  const prefs = await readJson(prefsFile(profileDir));
  const ls = await readJson(localStateFile(profileDir));
  const bad: string[] = [];
  for (const [k, v] of REQUIRED_PREFERENCES) if (getPath(prefs, k) !== v) bad.push(k);
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
 * 전용 Chrome 크래시 덤프 삭제(N-04). 지운 파일 수를 돌려준다.
 * 덤프 폴더가 심링크·재분석 지점이면 링크 너머를 지우지 않고 -1.
 */
export async function removeCrashDumps(profileDir: string): Promise<number> {
  let count = 0;
  for (const name of CRASH_DUMP_DIRS) {
    const dir = path.join(profileDir, name);
    const st = await fs.lstat(dir).catch(() => null);
    if (!st) continue;
    if (st.isSymbolicLink()) return -1;
    if (st.isDirectory()) count += await countFiles(dir);
    else count++;
    await fs.rm(dir, { recursive: true, force: true });
  }
  return count;
}
