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
  testArgs?: string[];
  headless?: boolean;
}

export function buildChromeArgs(profileDir: string, testArgs: string[] = [], headless = false): string[] {
  const fixed = ['--remote-debugging-pipe', `--user-data-dir=${profileDir}`, '--no-first-run', '--disable-breakpad', '--disable-default-apps', '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding', '--disable-background-timer-throttling', `--app=${CHROME_APP_START_URL}`, '--no-default-browser-check'];
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
