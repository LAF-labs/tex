// 확장자만 .xls인 HTML 표 읽기(국내 은행·홈택스 "엑셀 내려받기"에 흔하다). <table>마다 시트 하나(table1, table2…).
// 정규식 없이 한 번 훑는 스캐너다(백트래킹 폭탄 없음). <script>·<style>·주석 내용은 버린다. 그림·링크·스타일은 따라가지 않는다.
// colspan은 오른쪽 칸을 null로, rowspan은 아래 행 같은 열을 null로 채운다(같은 값을 되풀이하지 않는다).
import { decodeText } from './csv.ts';
import { SandboxError, SHEET_LIMITS } from './limits.ts';
import { emptyFlags, looksLikeFormula, trimRow, type Cell, type SheetOutput, type SheetTable } from './sheet.ts';

const EUC_KR_NAMES = new Set(['euc-kr', 'euckr', 'ks_c_5601-1987', 'ks_c_5601', 'ksc5601', 'cp949', 'windows-949', 'x-windows-949', 'ms949', 'uhc']);
const UTF8_NAMES = new Set(['utf-8', 'utf8']);
/** 칸 글자는 공백 정리 전 이만큼까지만 모은다 */
const MAX_RAW_CELL = SHEET_LIMITS.maxCellChars * 4;

/** 앞 4KB의 <meta … charset=…>(http-equiv content 안의 charset= 포함) */
export function metaCharset(bytes: Uint8Array): 'utf-8' | 'euc-kr' | null {
  const n = Math.min(bytes.length, 4096);
  let head = '';
  for (let i = 0; i < n; i++) head += String.fromCharCode(bytes[i]! < 0x80 ? bytes[i]! : 0x20);
  head = head.toLowerCase();
  for (let at = head.indexOf('<meta'); at >= 0; at = head.indexOf('<meta', at + 5)) {
    const end = head.indexOf('>', at);
    const tag = head.slice(at, end < 0 ? head.length : end);
    const c = tag.indexOf('charset');
    if (c < 0) continue;
    let p = c + 7;
    while (tag[p] === ' ') p++;
    if (tag[p] !== '=') continue;
    p++;
    while (tag[p] === ' ' || tag[p] === '"' || tag[p] === "'") p++;
    let name = '';
    while (p < tag.length && /[a-z0-9_.:-]/.test(tag[p]!)) name += tag[p++];
    if (EUC_KR_NAMES.has(name)) return 'euc-kr';
    if (UTF8_NAMES.has(name)) return 'utf-8';
  }
  return null;
}

const NAMED: Record<string, string> = { nbsp: '\u00a0', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

/** &nbsp; &amp; &lt; &gt; &quot; &apos; &#123; &#x1F; 풀기. 모르는 것은 그대로 둔다 */
export function decodeHtmlEntities(s: string): string {
  if (!s.includes('&')) return s;
  let out = '';
  let i = 0;
  for (;;) {
    const a = s.indexOf('&', i);
    if (a < 0) return out + s.slice(i);
    out += s.slice(i, a);
    const semi = s.indexOf(';', a + 1);
    const body = semi > a && semi - a <= 10 ? s.slice(a + 1, semi) : null;
    let rep: string | null = null;
    if (body !== null) {
      if (body[0] === '#') {
        const hex = body[1] === 'x' || body[1] === 'X';
        const digits = body.slice(hex ? 2 : 1);
        if (digits && (hex ? /^[0-9a-fA-F]+$/ : /^\d+$/).test(digits)) {
          const cp = parseInt(digits, hex ? 16 : 10);
          rep = cp > 0 && cp <= 0x10ffff && !(cp >= 0xd800 && cp <= 0xdfff) ? String.fromCodePoint(cp) : '\ufffd';
        }
      } else rep = NAMED[body.toLowerCase()] ?? null;
    }
    if (rep === null) {
      out += '&';
      i = a + 1;
    } else {
      out += rep;
      i = semi + 1;
    }
  }
}

const isNameChar = (c: number) => (c >= 0x61 && c <= 0x7a) || (c >= 0x41 && c <= 0x5a) || (c >= 0x30 && c <= 0x39) || c === 0x2d || c === 0x3a || c === 0x5f;
const isSpace = (c: number) => c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d || c === 0x0c;

interface Tag {
  name: string;
  close: boolean;
  attrs: Record<string, string>;
  end: number;
}

/** text[at] === '<' 인 태그 하나. 따옴표 안의 '>'는 끝으로 보지 않는다 */
function readTag(text: string, at: number): Tag | null {
  let p = at + 1;
  const close = text.charCodeAt(p) === 0x2f;
  if (close) p++;
  const s = p;
  while (p < text.length && isNameChar(text.charCodeAt(p))) p++;
  if (p === s) return null; // '<' 뒤가 이름이 아니면 글자다
  const name = text.slice(s, p).toLowerCase();
  const attrs: Record<string, string> = {};
  for (;;) {
    while (p < text.length && (isSpace(text.charCodeAt(p)) || text.charCodeAt(p) === 0x2f)) p++;
    if (p >= text.length) return { name, close, attrs, end: text.length };
    if (text.charCodeAt(p) === 0x3e) return { name, close, attrs, end: p + 1 };
    const ns = p;
    while (p < text.length && !isSpace(text.charCodeAt(p)) && text[p] !== '=' && text[p] !== '>' && text[p] !== '/') p++;
    if (p === ns) p++; // 이름이 될 수 없는 글자 하나 건너뜀
    const an = text.slice(ns, p).toLowerCase();
    while (p < text.length && isSpace(text.charCodeAt(p))) p++;
    let val = '';
    if (text[p] === '=') {
      p++;
      while (p < text.length && isSpace(text.charCodeAt(p))) p++;
      const q = text[p];
      if (q === '"' || q === "'") {
        const e = text.indexOf(q, p + 1);
        val = text.slice(p + 1, e < 0 ? text.length : e);
        p = e < 0 ? text.length : e + 1;
      } else {
        const vs = p;
        while (p < text.length && !isSpace(text.charCodeAt(p)) && text[p] !== '>') p++;
        val = text.slice(vs, p);
      }
    }
    if (an && !(an in attrs)) attrs[an] = val;
  }
}

/** '</name' 을 대소문자 무시로 찾는다(없으면 끝) */
function findClose(text: string, from: number, name: string): number {
  for (let p = text.indexOf('</', from); p >= 0; p = text.indexOf('</', p + 2)) {
    if (text.slice(p + 2, p + 2 + name.length).toLowerCase() === name && !isNameChar(text.charCodeAt(p + 2 + name.length))) return p;
  }
  return text.length;
}

const span = (v: string | undefined, max: number) => {
  const n = v ? parseInt(v, 10) : 1;
  return Number.isFinite(n) && n >= 1 ? Math.min(n, max) : 1;
};

interface TableCtx {
  index: number;
  rows: Cell[][];
  /** 열마다 rowspan으로 아래 몇 행을 더 차지하는지 */
  spans: number[];
  /** 지금 행에서 rowspan이 차지한 열 */
  occupied: Set<number>;
  row: Cell[] | null;
  col: number;
  cell: { parts: string[]; len: number; colspan: number; rowspan: number } | null;
}

export function parseHtmlTables(text: string): { sheets: SheetTable[]; truncated: boolean; formulaLike: number } {
  const sheets: SheetTable[] = [];
  const stack: TableCtx[] = [];
  let tableCount = 0;
  let truncated = false;
  let formulaLike = 0;
  let cells = 0;

  const finishCell = (t: TableCtx) => {
    const c = t.cell;
    if (!c || !t.row) return;
    t.cell = null;
    let v = decodeHtmlEntities(c.parts.join('')).replace(/[\s\u00a0\u3000]+/g, ' ').trim();
    if (c.len > MAX_RAW_CELL || v.length > SHEET_LIMITS.maxCellChars) {
      v = v.slice(0, SHEET_LIMITS.maxCellChars);
      truncated = true;
    }
    if (looksLikeFormula(v)) formulaLike++;
    while (t.occupied.has(t.col)) {
      t.row[t.col] = null;
      t.col++;
    }
    for (let k = 0; k < c.colspan; k++) {
      const col = t.col + k;
      if (col >= SHEET_LIMITS.maxCols) {
        truncated = true;
        break;
      }
      if (++cells > SHEET_LIMITS.maxCells) throw new SandboxError('sheet_too_large');
      while (t.row.length < col) t.row.push(null);
      t.row[col] = k === 0 && v !== '' ? v : null;
      if (c.rowspan > 1) t.spans[col] = Math.max(t.spans[col] ?? 0, c.rowspan - 1);
    }
    t.col += c.colspan;
  };
  const finishRow = (t: TableCtx) => {
    finishCell(t);
    if (!t.row) return;
    if (t.rows.length < SHEET_LIMITS.maxRows) t.rows.push(trimRow(t.row));
    else truncated = true;
    t.row = null;
  };
  const startRow = (t: TableCtx) => {
    finishRow(t);
    t.row = [];
    t.col = 0;
    t.occupied = new Set();
    t.spans.forEach((n, c) => {
      if (n > 0) {
        t.occupied.add(c);
        t.spans[c] = n - 1;
      }
    });
  };
  const finishTable = () => {
    const t = stack.pop()!;
    finishRow(t);
    if (!t.rows.some((r) => r.length > 0)) return;
    if (sheets.length >= SHEET_LIMITS.maxSheets) {
      truncated = true;
      return;
    }
    sheets.push({ name: `table${t.index}`, hidden: false, rows: t.rows, hiddenRows: 0 });
  };

  let i = 0;
  while (i < text.length) {
    const lt = text.indexOf('<', i);
    const top = stack[stack.length - 1];
    const textEnd = lt < 0 ? text.length : lt;
    if (top?.cell && textEnd > i && top.cell.len <= MAX_RAW_CELL) {
      const piece = text.slice(i, Math.min(textEnd, i + MAX_RAW_CELL + 1 - top.cell.len));
      top.cell.parts.push(piece);
      top.cell.len += textEnd - i;
    } else if (top?.cell && textEnd > i) top.cell.len += textEnd - i;
    if (lt < 0) break;
    if (text.startsWith('<!--', lt)) {
      const e = text.indexOf('-->', lt + 4);
      i = e < 0 ? text.length : e + 3;
      continue;
    }
    const nx = text[lt + 1];
    if (nx === '!' || nx === '?') {
      const e = text.indexOf('>', lt);
      i = e < 0 ? text.length : e + 1;
      continue;
    }
    const tag = readTag(text, lt);
    if (!tag) {
      if (top?.cell && top.cell.len <= MAX_RAW_CELL) top.cell.parts.push('<');
      if (top?.cell) top.cell.len++;
      i = lt + 1;
      continue;
    }
    i = tag.end;
    const { name, close } = tag;
    if (!close && (name === 'script' || name === 'style' || name === 'textarea' || name === 'title')) {
      const e = findClose(text, i, name);
      const g = text.indexOf('>', e);
      i = g < 0 ? text.length : g + 1;
      continue;
    }
    if (name === 'table') {
      if (close) {
        if (stack.length) finishTable();
      } else {
        if (stack.length >= SHEET_LIMITS.maxXmlDepth) throw new SandboxError('sheet_invalid');
        tableCount++;
        stack.push({ index: tableCount, rows: [], spans: [], occupied: new Set(), row: null, col: 0, cell: null });
      }
      continue;
    }
    if (!top) continue;
    if (name === 'tr') {
      if (close) finishRow(top);
      else startRow(top);
    } else if (name === 'td' || name === 'th') {
      if (close) finishCell(top);
      else {
        if (!top.row) startRow(top);
        finishCell(top);
        top.cell = { parts: [], len: 0, colspan: span(tag.attrs.colspan, SHEET_LIMITS.maxCols), rowspan: span(tag.attrs.rowspan, SHEET_LIMITS.maxRows) };
      }
    } else if (top.cell && (name === 'br' || name === 'p' || name === 'div' || name === 'li')) top.cell.parts.push(' ');
  }
  while (stack.length) finishTable();
  // 문서 순서(바깥 표가 먼저)로 정렬: 안쪽 표가 먼저 닫혀 먼저 들어간다
  sheets.sort((a, b) => Number(a.name.slice(5)) - Number(b.name.slice(5)));
  return { sheets, truncated, formulaLike };
}

export function readHtmlTable(bytes: Uint8Array): SheetOutput {
  const { text, encoding } = decodeText(bytes, metaCharset(bytes) ?? undefined);
  const { sheets, truncated, formulaLike } = parseHtmlTables(text);
  if (sheets.length === 0) throw new SandboxError('sheet_invalid');
  const flags = emptyFlags();
  flags.truncated = truncated;
  flags.formulaLikeText = formulaLike;
  return { format: 'html', encoding, sheets, flags };
}
