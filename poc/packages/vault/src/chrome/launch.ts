import { spawn, type ChildProcess } from 'node:child_process';
import type { Readable, Writable } from 'node:stream';
import { findReparsePoint } from '@sax/platform';
import { CHROME_APP_START_URL, CHROME_ARG_ALLOWLIST, CHROME_ENV_ALLOWLIST, CHROME_HEADLESS_ARGS, FORBIDDEN_CHROME_ARGS } from '../constants.ts';
import { PipeConnection } from '../cdp/connection.ts';

export interface LaunchedChrome {
  conn: PipeConnection;
  proc: ChildProcess;
  args: string[];
  close(): Promise<void>;
}

export interface LaunchSpec {
  executable: string;
  profileDir: string;
  /** 테스트 전용(헤드리스 등). 앱 진입점은 비워 둔다. 금지 인자는 여기서도 거부한다. */
  testArgs?: string[];
  /** 창 없이 띄운다(앱 기본). 사람이 페이지를 만져야 할 때만 false로 다시 띄운다. */
  headless?: boolean;
}

export function buildChromeArgs(profileDir: string, testArgs: string[] = [], headless = false): string[] {
  // --disable-breakpad: 크래시해도 프로필 아래 로컬 덤프(Crashpad)를 만들지 않는다(N-04).
  // --disable-default-apps: 기본 앱이 전용 프로필에 깔려 확장 검사가 비밀 창을 막지 않게 한다(constants.ts CHROME_ARG_ALLOWLIST).
  // 가려진 창·뒤 렌더러·타이머 늦추기를 끈다: 앱이 홈택스 Chrome을 앱 옆·뒤에 두므로(#305) 가려져도 자동화가 느려지지 않게.
  const fixed = ['--remote-debugging-pipe', `--user-data-dir=${profileDir}`, '--no-first-run', '--disable-breakpad', '--disable-default-apps', '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding', '--disable-background-timer-throttling', `--app=${CHROME_APP_START_URL}`, '--no-default-browser-check'];
  // 시험 인자가 이미 정한 플래그(headless·창 크기)는 겹쳐 넣지 않는다.
  const flag = (a: string) => a.split('=')[0];
  if (headless) fixed.push(...CHROME_HEADLESS_ARGS.filter((h) => !testArgs.some((a) => flag(a) === flag(h))));
  const args = [...fixed, ...testArgs];
  for (const a of args) {
    if (FORBIDDEN_CHROME_ARGS.some((f) => a === f || a.startsWith(f + '='))) throw new Error(`forbidden chrome arg: ${a.split('=')[0]}`);
  }
  for (const a of args.slice(0, fixed.length)) {
    if (!CHROME_ARG_ALLOWLIST.some((ok) => a === ok || a.startsWith(ok + '='))) throw new Error('arg not in allowlist');
  }
  return args;
}

export function chromeEnv(src: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const k of CHROME_ENV_ALLOWLIST) if (src[k] !== undefined) env[k] = src[k];
  return env;
}

export async function launchChrome(spec: LaunchSpec): Promise<LaunchedChrome> {
  if (await findReparsePoint(spec.profileDir)) throw new Error('profile path contains a reparse point');
  const args = buildChromeArgs(spec.profileDir, spec.testArgs, spec.headless === true);
  const proc = spawn(spec.executable, args, {
    stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'],
    env: chromeEnv(),
    detached: false,
  });
  // 실행 실패(EACCES 등)는 'error'로만 온다. 듣지 않으면 금고 프로세스가 잡히지 않은 예외로 죽는다. 띄운 뒤의 오류(kill 실패 등)도 계속 받는다.
  await new Promise<void>((resolve, reject) => {
    proc.once('spawn', resolve);
    proc.on('error', reject);
  });
  const toChrome = proc.stdio[3] as Writable;
  const fromChrome = proc.stdio[4] as Readable;
  const conn = new PipeConnection(toChrome, fromChrome);
  const exited = new Promise<void>((r) => proc.once('exit', () => r()));
  return {
    conn,
    proc,
    args,
    async close() {
      if (proc.exitCode !== null) return;
      try {
        await Promise.race([conn.send('Browser.close'), new Promise((r) => setTimeout(r, 3000))]);
      } catch {
        // 파이프가 먼저 닫힐 수 있다
      }
      const t = setTimeout(() => proc.kill('SIGKILL'), 5000);
      await exited;
      clearTimeout(t);
    },
  };
}
