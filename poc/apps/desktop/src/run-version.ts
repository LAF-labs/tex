// 레지스트리 minAppVersion·폰 hello에 쓰는 앱 판. 패키지된 앱은 늘 app.getVersion()이다.
// 패키지하지 않은 개발 빌드(package.json 0.0.0)는 SAX_DEV_APP_VERSION(x.y.z)으로 판을 정할 수 있다: 없으면 0.0.0이라
// minAppVersion이 있는 발급 패키지를 엔진이 거부한다(2026-11-19 실기기 시험: 폰 발급 요청이 registry.app_version_low → package.load_failed).
// 자동 업데이트 판 비교(update-host)에는 쓰지 않는다.

export function runVersion(packaged: boolean, env: NodeJS.ProcessEnv, real: () => string): string {
  const v = env.SAX_DEV_APP_VERSION;
  return !packaged && typeof v === 'string' && /^\d+\.\d+\.\d+$/.test(v) ? v : real();
}
