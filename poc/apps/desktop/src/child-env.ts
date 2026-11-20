
const CHILD_ENV_ALLOWLIST = [
  'PATH', 'SystemRoot', 'SystemDrive', 'windir', 'USERPROFILE', 'USERNAME', 'LOCALAPPDATA', 'APPDATA', 'TEMP', 'TMP',
  'HOME', 'USER', 'LOGNAME', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TMPDIR', 'DISPLAY', 'XDG_RUNTIME_DIR',
  'XAUTHORITY',
  'ProgramFiles', 'ProgramFiles(x86)', 'ProgramData', 'COMPUTERNAME', 'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE',
  'DBUS_SESSION_BUS_ADDRESS',
] as const;

export function childEnv(src: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const env: Record<string, string> = {};
  for (const k of CHILD_ENV_ALLOWLIST) {
    const v = src[k];
    if (typeof v === 'string') env[k] = v;
  }
  return env;
}
