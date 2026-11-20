import path from 'node:path';

export interface SmokeRootPlan {
  ok: boolean;
  env: Record<string, string>;
  reason?: string;
}

export function smokeRootPlan(opts: { env: NodeJS.ProcessEnv; tmp: string; realRoot: string; exists: (p: string) => boolean }): SmokeRootPlan {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(opts.env)) if (typeof v === 'string') env[k] = v;
  env.LOCALAPPDATA = opts.tmp;
  env.HOME = opts.tmp;
  if (opts.exists(path.join(opts.realRoot, 'db', 'db.sqlite'))) return { ok: false, env, reason: `실제 앱 루트에 DB가 있어 스모크를 시작하지 않아요: ${opts.realRoot}` };
  return { ok: true, env };
}
