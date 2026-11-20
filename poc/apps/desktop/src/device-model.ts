import { execFile } from 'node:child_process';

let cached: Promise<string | undefined> | null = null;

function parseMacModel(out: string): string | undefined {
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
