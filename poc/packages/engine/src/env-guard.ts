// 엔진 기동 환경 가드(ADR-022 결정 9, N-23, D11 §4 env 허용 목록). entry.ts의 첫 import다.
// 이 변수들은 CDP 전문 평문 기록(DEBUG·DEBUG_FILE·PWDEBUG), 코드 주입(NODE_OPTIONS), TLS 가로채기(NODE_EXTRA_CA_CERTS·
// SSLKEYLOGFILE·NODE_TLS_REJECT_UNAUTHORIZED=0)를 켠다. 앱은 환경 변수로 이것들을 켤 수 없어야 한다.

const PRESENT = ['DEBUG', 'DEBUG_FILE', 'PWDEBUG', 'NODE_OPTIONS', 'NODE_EXTRA_CA_CERTS', 'SSLKEYLOGFILE'] as const;

/** 문제가 되는 변수 이름(값은 보지 않는다). */
export function envProblems(env: NodeJS.ProcessEnv): string[] {
  const out: string[] = PRESENT.filter((k) => env[k] !== undefined);
  if (env.NODE_TLS_REJECT_UNAUTHORIZED === '0') out.push('NODE_TLS_REJECT_UNAUTHORIZED');
  return out;
}

// utilityProcess 안에서만 집행한다(시험·main이 이 모듈을 불러도 끝내지 않는다).
const parentPort = (process as unknown as { parentPort?: { postMessage(m: unknown): void } }).parentPort;
const problems = envProblems(process.env);
/** 기동 거부 중이다. entry는 어떤 메시지도 처리하지 않는다. */
export const ENV_TAMPERED = !!parentPort && problems.length > 0;
if (ENV_TAMPERED) {
  // 뒤따르는 모듈(playwright-core 등)이 읽기 전에 지우고, fatal이 main에 닿을 틈을 둔 뒤 끝낸다.
  for (const k of problems) delete process.env[k];
  parentPort!.postMessage({ t: 'fatal', code: `engine.env_tampered:${problems[0]}` });
  setTimeout(() => process.exit(1), 100);
}
