// 홈택스 Chrome 창 자리(대표 요청 2026-11-13: "크롬이 우리 앱을 가리지 않았으면 좋겠다").
// 금고가 띄우는 실제 Chrome은 그대로 쓴다(공동인증서 보안 프로그램은 설치된 Chrome에서만 인식된다). 창 자리만 정한다.
// 화면(작업 영역) 하나 안에서: 앱 오른쪽에 넉넉한 빈자리가 있으면 거기에 Chrome을 두고 앱은 그대로 둔다.
// 없으면(맥북처럼 화면이 하나뿐이고 앱이 넓으면) 앱 왼쪽·Chrome 오른쪽으로 나눈다. 앱 창은 사람 차례에만 옮긴다.

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** 홈택스 화면을 읽을 만한 Chrome 폭(측정 아님, 짐작: 홈택스 본문은 1,000px 남짓이라 그보다 좁으면 가로 스크롤). */
export const CHROME_MIN_WIDTH = 720;
/** 앱이 대화 열과 승인 바를 띠 모드 없이 보이는 폭(승인 바 비띠 최소 520 + 여백, approval-bar 레이아웃). */
export const APP_MIN_WIDTH = 640;

export function chromeBeside(work: Rect, app: Rect): { chrome: Rect; app: Rect } {
  const right = work.x + work.width;
  const appRight = Math.min(app.x + app.width, right);
  // 앱 오른쪽 빈자리가 Chrome에 충분하면 앱은 건드리지 않는다.
  if (right - appRight >= CHROME_MIN_WIDTH) return { chrome: { x: appRight, y: work.y, width: right - appRight, height: work.height }, app };
  // 나눈다. Chrome에 절반(최소 CHROME_MIN_WIDTH), 앱은 남은 왼쪽(최소 APP_MIN_WIDTH). 화면이 그보다 좁으면 Chrome이 앱 일부를 덮는다.
  const half = Math.floor(work.width / 2);
  const chromeW = Math.max(Math.min(Math.max(half, CHROME_MIN_WIDTH), work.width - APP_MIN_WIDTH), Math.min(CHROME_MIN_WIDTH, work.width));
  const appW = Math.max(work.width - chromeW, Math.min(APP_MIN_WIDTH, work.width));
  return {
    chrome: { x: right - chromeW, y: work.y, width: chromeW, height: work.height },
    app: { x: work.x, y: work.y, width: appW, height: work.height },
  };
}
