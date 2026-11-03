// 금고·엔진 utilityProcess에 넘길 환경 변수 허용 목록(ADR-025 결정 9, D11 §4).
// main의 DEBUG·DEBUG_FILE·NODE_OPTIONS·프록시·TLS·API 키 변수가 자식에 닿지 않게 한다. Electron 없이 시험한다.

export const CHILD_ENV_ALLOWLIST = [
  'PATH', 'SystemRoot', 'SystemDrive', 'windir', 'USERPROFILE', 'USERNAME', 'LOCALAPPDATA', 'APPDATA', 'TEMP', 'TMP',
  'HOME', 'USER', 'LOGNAME', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TMPDIR', 'DISPLAY', 'XDG_RUNTIME_DIR',
  // Linux X11·xvfb: DISPLAY만으로는 X 서버 인증 파일을 못 찾는다(금고가 띄우는 Chrome이 화면을 못 연다).
  'XAUTHORITY',
  'ProgramFiles', 'ProgramFiles(x86)', 'ProgramData', 'COMPUTERNAME', 'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE',
  // Linux 개발 환경의 키체인(Secret Service, D-Bus). Windows·macOS에서는 없다.
  'DBUS_SESSION_BUS_ADDRESS',
] as const;

/** 허용 목록에 있는 변수만 옮긴 새 객체. Windows의 process.env는 대소문자를 가리지 않으므로 이름 그대로 읽는다. */
export function childEnv(src: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const env: Record<string, string> = {};
  for (const k of CHILD_ENV_ALLOWLIST) {
    const v = src[k];
    if (typeof v === 'string') env[k] = v;
  }
  return env;
}
