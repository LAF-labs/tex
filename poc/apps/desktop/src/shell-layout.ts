import { CARD_ROWS, cardHeight } from './approval-gate.ts';

// ADR-021 결정 1 "위치"·결정 7: 승인 카드 자리는 main이 창 콘텐츠 크기, 앱 상수, 서류 종류별 줄 수로 정한 높이만으로 정한다.
// 렌더러는 main이 넘겨준 같은 값으로 그 자리를 비운다. 렌더러가 보고하는 좌표·배율·높이는 쓰지 않는다. 단위는 DIP.

export const SHELL = {
  /** 디자인 토큰 titlebar-height·rail-width·panel-width·chat-max */
  titlebar: 44,
  rail: 60,
  panel: 340,
  chatMax: 600,
  /** 대화 좌우 여백(space-5) */
  gutter: 24,
  /** 입력창 예약 높이: 입력창 3줄(24×3 + 안쪽 여백 20 + 테두리 2) + 아래 여백 16 */
  composerReserve: 110,
  /** 바와 입력창 예약 영역 사이 간격. 입력하려는 클릭이 바에 떨어지지 않게 한다. */
  gap: 12,
  /** 기본 카드 높이(H-01 줄 수). 실제 높이는 카드가 뜰 때 main이 'bar' 이벤트로 알린다(증언 카드는 다르다). */
  barHeight: cardHeight(CARD_ROWS['H-01']),
  /** 이보다 좁은 대화 열에서는 레일 오른쪽부터 창 끝까지의 띠로 넓힌다. */
  barMinWidth: 520,
} as const;

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * 대화 열 폭 = min(chat-max, 콘텐츠 폭 − 레일 − 패널 − 좌우 여백). 패널 폭은 패널이 접혀 있어도 늘 뺀다
 * (접힘은 렌더러 상태라, 위치 계산에 쓰면 렌더러가 바를 옮길 수 있다).
 * 대화 열이 바 최소 폭보다 좁거나, 요약 줄의 줄이지 않는 값이 대화 열 폭에 안 들어가면(wide) 레일 오른쪽부터 창 끝까지 띠로 넓힌다.
 * wide는 main이 게이트 요청 값으로 정한다. 어느 쪽이든 렌더러가 보고하는 값은 쓰지 않는다.
 */
export function barBounds(contentWidth: number, contentHeight: number, wide = false, height: number = SHELL.barHeight): Rect & { band: boolean } {
  const region = contentWidth - SHELL.rail - SHELL.panel;
  const col = Math.min(SHELL.chatMax, region - SHELL.gutter * 2);
  const y = contentHeight - SHELL.composerReserve - SHELL.gap - height;
  if (col >= SHELL.barMinWidth && !wide) return { x: SHELL.rail + Math.floor((region - col) / 2), y, width: col, height, band: false };
  return { x: SHELL.rail, y, width: Math.max(0, contentWidth - SHELL.rail), height, band: true };
}
