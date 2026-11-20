import { CARD_ROWS, cardHeight } from './approval-gate.ts';


export const SHELL = {
  titlebar: 44,
  rail: 76,
  panel: 340,
  chatMax: 600,
  gutter: 24,
  composerReserve: 110,
  gap: 12,
  barHeight: cardHeight(CARD_ROWS['H-01']),
  barMinWidth: 520,
  browserShare: 0.55,
  browserMin: 420,
  chatMin: 380,
} as const;

// 창 최소 크기. 홈택스 화면 패널(browserMin)이 열려도 대화 열이 chatMin 아래로 줄지 않는 폭이다.
// 이보다 좁으면 패널이 대화 열을 150~220px로 눌러 카드 글이 한 글자씩 꺾이고 보내기 단추가 가려졌다(PC 점검 11-20 F01).
export const WINDOW_MIN = { width: SHELL.rail + SHELL.chatMin + SHELL.browserMin, height: 560 } as const;

export function browserPanelWidth(contentWidth: number, want: number | null, big: boolean, barActive: boolean): number {
  const room = contentWidth - SHELL.rail;
  const share = Math.round(room * SHELL.browserShare);
  if (barActive) return Math.max(0, Math.min(share, room - (SHELL.chatMax + SHELL.gutter * 2)));
  const max = room - SHELL.chatMin;
  const w = big ? max : (want ?? share);
  return Math.max(0, Math.round(Math.max(Math.min(w, max), Math.min(SHELL.browserMin, max))));
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export function barBounds(contentWidth: number, contentHeight: number, wide = false, height: number = SHELL.barHeight, panel: number = SHELL.panel): Rect & { band: boolean } {
  const region = contentWidth - SHELL.rail - panel;
  const col = Math.min(SHELL.chatMax, region - SHELL.gutter * 2);
  const y = contentHeight - SHELL.composerReserve - SHELL.gap - height;
  if (col >= SHELL.barMinWidth && !wide) return { x: SHELL.rail + Math.floor((region - col) / 2), y, width: col, height, band: false };
  return { x: SHELL.rail, y, width: Math.max(0, contentWidth - SHELL.rail), height, band: true };
}
