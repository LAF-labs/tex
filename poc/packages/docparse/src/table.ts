// 표 규칙 공용: 머리글 줄 찾기, 칸 역할 붙이기, 합계 줄 알아보기.
import type { Cell, SheetOutput, SheetTable } from './sandbox/index.ts';
import type { WarningCode } from './types.ts';
import { compact } from './util.ts';

export const cellText = (c: Cell | undefined): string => (c === null || c === undefined ? '' : typeof c === 'string' ? c : String(c));

export interface RoleRule<R extends string> {
  role: R;
  /** 머리글(공백·구두점 지운 것)에 들어 있으면 이 역할. 앞이 우선 */
  any: string[];
  /** 이것이 들어 있으면 이 역할이 아니다 */
  not?: string[];
  /** 한 표에 여러 칸이 이 역할일 수 있다(수수료 칸들) */
  multi?: boolean;
}

export interface HeaderMatch<R extends string> {
  sheet: SheetTable;
  headerRow: number;
  columns: Array<{ role: R; index: number; header: string }>;
}

export function roleOf<R extends string>(header: string, rules: RoleRule<R>[]): RoleRule<R> | null {
  const h = compact(header).toLowerCase();
  if (!h) return null;
  for (const r of rules) {
    if (r.not?.some((n) => h.includes(n.toLowerCase()))) continue;
    if (r.any.some((a) => h.includes(a.toLowerCase()))) return r;
  }
  return null;
}

/**
 * 보이는 시트의 앞 40줄에서 머리글 줄을 찾는다: 필수 역할을 모두 갖고, 붙은 역할이 가장 많은 줄.
 * 두 줄 머리글(위: 보험 이름, 아래: 근로자·사업주)을 위해 바로 윗줄 글자를 앞에 붙여 다시 본다.
 */
export function findHeader<R extends string>(out: SheetOutput, rules: RoleRule<R>[], required: R[]): HeaderMatch<R> | null {
  let best: (HeaderMatch<R> & { score: number }) | null = null;
  for (const sheet of out.sheets) {
    if (sheet.hidden) continue;
    const limit = Math.min(sheet.rows.length, 40);
    for (let r = 0; r < limit; r++) {
      const row = sheet.rows[r] ?? [];
      for (const merged of [false, true]) {
        if (merged && r === 0) continue;
        const above = sheet.rows[r - 1] ?? [];
        let carry = '';
        const columns: HeaderMatch<R>['columns'] = [];
        const used = new Set<R>();
        row.forEach((c, i) => {
          if (merged && cellText(above[i])) carry = cellText(above[i]);
          const header = merged ? `${carry} ${cellText(c)}`.trim() : cellText(c);
          if (typeof c !== 'string' && !merged) return;
          const rule = roleOf(header, rules);
          if (!rule || (used.has(rule.role) && !rule.multi)) return;
          used.add(rule.role);
          columns.push({ role: rule.role, index: i, header: header.slice(0, 80) });
        });
        if (!required.every((q) => used.has(q))) continue;
        const score = columns.length + (merged ? -0.5 : 0);
        if (!best || score > best.score) best = { sheet, headerRow: r, columns, score };
      }
    }
  }
  if (!best) return null;
  return { sheet: best.sheet, headerRow: best.headerRow, columns: best.columns };
}

const TOTAL_ROW = /^(합계|총합계|총계|소계|누계|total|sum)$/i;
export const isTotalRow = (row: Cell[]) => row.slice(0, 4).some((c) => TOTAL_ROW.test(compact(cellText(c))));

/** 시트 출력 플래그 → 경고 */
export function sheetWarnings(out: SheetOutput): WarningCode[] {
  const w: WarningCode[] = [];
  const f = out.flags;
  if (f.formulas) w.push('formula_cached_values');
  if (f.externalLinks) w.push('external_links_ignored');
  if (f.macros) w.push('macros_ignored');
  if (f.connections) w.push('connections_ignored');
  if (f.embedded) w.push('embedded_ignored');
  if (f.hiddenSheets) w.push('hidden_sheets_skipped');
  if (out.sheets.some((s) => s.hiddenRows > 0)) w.push('hidden_rows_skipped');
  if (f.truncated) w.push('sheet_truncated');
  if (f.formulaLikeText) w.push('formula_like_text');
  if (out.encoding === 'euc-kr') w.push('encoding_euc_kr');
  return w;
}

/** 시트 이름과 앞 10줄 글자(형식·플랫폼 찾기용) */
export function headText(out: SheetOutput): string {
  return out.sheets
    .filter((s) => !s.hidden)
    .map((s) => [s.name, ...s.rows.slice(0, 10).map((r) => r.map(cellText).join(' '))].join('\n'))
    .join('\n');
}
