// 앱 스모크(tests/app-smoke.ts)가 실제 앱 루트를 건드리지 않게 하는 판정(N-57). Electron 없이 시험한다.
import path from 'node:path';

export interface SmokeRootPlan {
  ok: boolean;
  /** 자식 Electron에 줄 환경: 앱 루트가 임시 폴더 아래로 가게 LOCALAPPDATA·HOME을 바꾼다. */
  env: Record<string, string>;
  reason?: string;
}

/**
 * realRoot(defaultAppRoot())에 DB가 이미 있으면 시작하지 않는다(PoC-3 실법인 프로필·거래처가 있을 수 있다).
 * 없으면 임시 루트(tmp)로 띄울 환경을 돌려준다. 실 루트는 쓰지 않는다.
 */
export function smokeRootPlan(opts: { env: NodeJS.ProcessEnv; tmp: string; realRoot: string; exists: (p: string) => boolean }): SmokeRootPlan {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(opts.env)) if (typeof v === 'string') env[k] = v;
  env.LOCALAPPDATA = opts.tmp;
  env.HOME = opts.tmp;
  if (opts.exists(path.join(opts.realRoot, 'db', 'db.sqlite'))) return { ok: false, env, reason: `실제 앱 루트에 DB가 있어 스모크를 시작하지 않아요: ${opts.realRoot}` };
  return { ok: true, env };
}
