// CSV 읽기. 글자 인코딩: BOM이 있으면 UTF-8, 없으면 UTF-8(엄격) → 안 되면 EUC-KR(CP949, 국내 사이트 내려받기 기본).
// 따옴표 칸(RFC 4180), 쉼표·탭 구분을 받는다. 수식 같은 글자는 세기만 하고 그대로 둔다(계산하지 않는다).
import { SandboxError, SHEET_LIMITS } from './limits.ts';
import { emptyFlags, looksLikeFormula, trimRow, type Cell, type SheetOutput } from './sheet.ts';

export function decodeText(bytes: Uint8Array): { text: string; encoding: 'utf-8' | 'euc-kr' } {
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return { text: new TextDecoder('utf-8').decode(bytes.subarray(3)), encoding: 'utf-8' };
  if ((bytes[0] === 0xff && bytes[1] === 0xfe) || (bytes[0] === 0xfe && bytes[1] === 0xff)) throw new SandboxError('text_decode_failed'); // UTF-16은 받지 않는다
  try {
    return { text: new TextDecoder('utf-8', { fatal: true }).decode(bytes), encoding: 'utf-8' };
  } catch {
    try {
      return { text: new TextDecoder('euc-kr', { fatal: true }).decode(bytes), encoding: 'euc-kr' };
    } catch {
      throw new SandboxError('text_decode_failed');
    }
  }
}

/** 첫 줄에서 쉼표와 탭 중 많은 쪽 */
function delimiter(text: string): ',' | '\t' {
  const first = text.slice(0, text.indexOf('\n') < 0 ? text.length : text.indexOf('\n'));
  return (first.match(/\t/g)?.length ?? 0) > (first.match(/,/g)?.length ?? 0) ? '\t' : ',';
}

export function parseCsvText(text: string): { rows: Cell[][]; truncated: boolean; formulaLike: number } {
  const d = delimiter(text);
  const rows: Cell[][] = [];
  let row: Cell[] = [];
  let field = '';
  let quoted = false;
  let wasQuoted = false;
  let truncated = false;
  let cells = 0;
  let formulaLike = 0;
  const pushField = () => {
    if (row.length < SHEET_LIMITS.maxCols) {
      let v = wasQuoted ? field : field.trim();
      if (v.length > SHEET_LIMITS.maxCellChars) {
        v = v.slice(0, SHEET_LIMITS.maxCellChars);
        truncated = true;
      }
      if (looksLikeFormula(v)) formulaLike++;
      row.push(v === '' ? null : v);
      if (++cells > SHEET_LIMITS.maxCells) throw new SandboxError('sheet_too_large');
    } else truncated = true;
    field = '';
    wasQuoted = false;
  };
  const pushRow = () => {
    pushField();
    if (rows.length < SHEET_LIMITS.maxRows) rows.push(trimRow(row));
    else truncated = true;
    row = [];
  };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += ch;
      if (field.length > SHEET_LIMITS.maxCellChars * 4) throw new SandboxError('sheet_too_large'); // 글자마다 본다: 닫히지 않는 따옴표는 상한×4에서 바로 거부(파일 끝까지 쌓지 않음)
    } else if (ch === '"' && field.trim() === '') {
      quoted = true;
      wasQuoted = true;
      field = '';
    } else if (ch === d) pushField();
    else if (ch === '\n') pushRow();
    else if (ch !== '\r') {
      // 따옴표 없는 칸: 상한을 넘으면 더 쌓지 않는다(pushField가 잘라 truncated로 표시)
      if (field.length <= SHEET_LIMITS.maxCellChars) field += ch;
    }
  }
  if (field !== '' || row.length) pushRow();
  return { rows, truncated, formulaLike };
}

export function readCsv(bytes: Uint8Array): SheetOutput {
  const { text, encoding } = decodeText(bytes);
  const { rows, truncated, formulaLike } = parseCsvText(text);
  const flags = emptyFlags();
  flags.truncated = truncated;
  flags.formulaLikeText = formulaLike;
  return { format: 'csv', encoding, sheets: [{ name: 'csv', hidden: false, rows, hiddenRows: 0 }], flags };
}
