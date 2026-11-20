
const PRESENT = ['DEBUG', 'DEBUG_FILE', 'PWDEBUG', 'NODE_OPTIONS', 'NODE_EXTRA_CA_CERTS', 'SSLKEYLOGFILE'] as const;

/** 문제가 되는 변수 이름(값은 보지 않는다). */
export function envProblems(env: NodeJS.ProcessEnv): string[] {
  const out: string[] = PRESENT.filter((k) => env[k] !== undefined);
  if (env.NODE_TLS_REJECT_UNAUTHORIZED === '0') out.push('NODE_TLS_REJECT_UNAUTHORIZED');
  return out;
}

const parentPort = (process as unknown as { parentPort?: { postMessage(m: unknown): void } }).parentPort;
const problems = envProblems(process.env);
/** 기동 거부 중이다. entry는 어떤 메시지도 처리하지 않는다. */
export const ENV_TAMPERED = !!parentPort && problems.length > 0;
if (ENV_TAMPERED) {
  for (const k of problems) delete process.env[k];
  parentPort!.postMessage({ t: 'fatal', code: `engine.env_tampered:${problems[0]}` });
  setTimeout(() => process.exit(1), 100);
}
