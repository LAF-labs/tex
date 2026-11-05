// 샌드박스가 main에 돌려주는 표 모양(엑셀·CSV 공통). schema/sandbox-output.schema.json의 sheet 출력과 같다.

/** 칸 값. 날짜 서식 칸은 'YYYY-MM-DD'(시각이 있으면 'YYYY-MM-DD HH:MM') 문자열로 바꾼다. 수식은 계산하지 않고 파일에 저장된 값만 쓴다. */
export type Cell = string | number | boolean | null;

export interface SheetTable {
  name: string;
  /** 숨김 시트는 행을 읽지 않는다(숨긴 글자가 파서·화면에 닿지 않게). */
  hidden: boolean;
  rows: Cell[][];
  /** 숨김 행이라 뺀 수 */
  hiddenRows: number;
}

export interface SheetFlags {
  /** 수식 칸 수(계산하지 않고 저장된 값만 썼다) */
  formulas: number;
  /** 외부 통합 문서 연결(xl/externalLinks) 항목이 있었다. 읽지 않았다. */
  externalLinks: boolean;
  /** 매크로(vbaProject.bin) 항목이 있었다. 읽지 않았다. */
  macros: boolean;
  /** 데이터 연결(connections.xml·queryTables) 항목이 있었다. 읽지 않았다. */
  connections: boolean;
  /** OLE 개체·ActiveX·임베디드 파일이 있었다. 읽지 않았다. */
  embedded: boolean;
  hiddenSheets: number;
  /** 상한에 걸려 일부 행·열·칸을 버렸다 */
  truncated: boolean;
  /** 수식처럼 보이는 글자(=·+·@로 시작) 칸 수. 다시 엑셀로 내보낼 때 수식이 되지 않게 해야 한다(꾸러미 트랙). */
  formulaLikeText: number;
}

export interface SheetOutput {
  format: 'xlsx' | 'csv';
  /** CSV를 읽은 글자 인코딩 */
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
