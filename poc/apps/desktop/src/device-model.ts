// 이 PC의 모델 이름(예: "MacBook Pro"). 기기 토큰을 받을 때 계정 서비스에 알려 기기 목록의 이름으로 쓴다(2026-11-19 대표: 목록에는 기기 이름과 마지막 접속일만).
// macOS만 읽는다(system_profiler, 한 번만). 다른 OS나 읽지 못하면 undefined(서버는 이름을 그대로 둔다).
import { execFile } from 'node:child_process';

let cached: Promise<string | undefined> | null = null;

/** system_profiler -json 출력에서 machine_name을 꺼낸다. 글자가 이상하면 undefined. */
export function parseMacModel(out: string): string | undefined {
  try {
    const v = (JSON.parse(out) as { SPHardwareDataType?: Array<{ machine_name?: unknown }> }).SPHardwareDataType?.[0]?.machine_name;
    if (typeof v !== 'string') return undefined;
    const m = v.replace(/[\p{Cc}\p{Cf}]/gu, '').trim().slice(0, 40);
    return m || undefined;
  } catch {
    return undefined;
  }
}

export function deviceModel(platform: NodeJS.Platform = process.platform): Promise<string | undefined> {
  if (platform !== 'darwin') return Promise.resolve(undefined);
  cached ??= new Promise((resolve) => {
    execFile('/usr/sbin/system_profiler', ['SPHardwareDataType', '-json'], { timeout: 5_000, maxBuffer: 256 * 1024 }, (err, out) => resolve(err ? undefined : parseMacModel(out)));
  });
  return cached;
}
