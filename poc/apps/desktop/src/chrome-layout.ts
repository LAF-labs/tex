// 홈택스 Chrome 창 자리(대표 지시 2026-11-13 "claude desktop처럼 버튼을 누르면 브라우저가 보이게").
// 금고가 띄우는 실제 Chrome은 그대로 쓴다(공동인증서 보안 프로그램은 설치된 Chrome에서만 인식된다). 자리는 앱의 브라우저 패널(#panel)이다(shell-app placeRunBrowser).

/** 홈택스 화면을 읽을 만한 Chrome 폭(측정 아님, 짐작: 홈택스 본문은 1,000px 남짓이라 그보다 좁으면 가로 스크롤). 패널이 이보다 좁으면 왼쪽으로 넓힌다. */
export const CHROME_MIN_WIDTH = 720;
