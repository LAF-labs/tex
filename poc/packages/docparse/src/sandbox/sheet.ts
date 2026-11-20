/** 칸 값. 날짜 서식 칸은 'YYYY-MM-DD'(시각이 있으면 'YYYY-MM-DD HH:MM') 문자열로 바꾼다. 수식은 계산하지 않고 파일에 저장된 값만 쓴다. */
export type Cell = string | number | boolean | null;

export interface SheetTable {
  name: string;
  hidden: boolean;
  rows: Cell[][];
  hiddenRows: number;
}

export interface SheetFlags {
  formulas: number;
  externalLinks: boolean;
  macros: boolean;
  connections: boolean;
  embedded: boolean;
  hiddenSheets: number;
  truncated: boolean;
  formulaLikeText: number;
}

export interface SheetOutput {
  format: 'xlsx' | 'csv' | 'xls' | 'html';
  encoding: 'utf-8' | 'euc-kr' | null;
  sheets: SheetTable[];
  flags: SheetFlags;
}

export const emptyFlags = (): SheetFlags => ({ formulas: 0, externalLinks: false, macros: false, connections: false, embedded: false, hiddenSheets: 0, truncated: false, formulaLikeText: 0 });

/** '=HYPERLINK(…)', '+cmd', '@SUM' 같은 글자. 음수·전화번호('-'로 시작)는 세지 않는다. */
export const looksLikeFormula = (s: string) => /^[=+@]/.test(s) && !/^\+?\d[\d\s-]*$/.test(s);

/** 끝의 빈 칸을 지운다. */
export function trimRow(r: Cell[]): Cell[] {
  let e = r.length;
  while (e > 0 && (r[e - 1] === null || r[e - 1] === '')) e--;
  return e === r.length ? r : r.slice(0, e);
}
