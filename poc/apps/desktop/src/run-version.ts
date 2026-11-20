
export function runVersion(packaged: boolean, env: NodeJS.ProcessEnv, real: () => string): string {
  const v = env.SAX_DEV_APP_VERSION;
  return !packaged && typeof v === 'string' && /^\d+\.\d+\.\d+$/.test(v) ? v : real();
}
