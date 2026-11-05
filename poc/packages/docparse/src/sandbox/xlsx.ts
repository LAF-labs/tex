// xlsx(OOXML) 읽기. 라이브러리를 쓰지 않는다(선정 근거는 packages/docparse/README.md §엑셀):
// - 필요한 것은 "보이는 시트의 저장된 칸 값"뿐이다. 수식 계산·외부 연결·매크로·데이터 연결은 아예 열지 않는다.
// - 항목 이름을 고른 것만 푼다: workbook.xml, workbook.xml.rels, sharedStrings.xml, styles.xml, 보이는 시트.
// - .xls(BIFF)·암호 걸린 xlsx(OLE 컨테이너)는 받지 않는다(unsupported_format). 사장님에게 "xlsx로 다시 저장"을 안내한다.
import { SandboxError, SHEET_LIMITS } from './limits.ts';
import { emptyFlags, looksLikeFormula, trimRow, type Cell, type SheetOutput, type SheetTable } from './sheet.ts';
import { localName, tokenize, type XmlToken } from './xml.ts';
import { ZipReader } from './zip.ts';

/** 내장 날짜·시각 서식 번호(ECMA-376 18.8.30) */
const BUILTIN_DATE_FMTS = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 45, 46, 47]);

export function isDateFormatCode(code: string): boolean {
  // 따옴표 글자·대괄호(색·조건·[$-412] 지역)·역슬래시 글자를 빼고 y·m·d·h·s가 남으면 날짜 서식이다
  const s = code.replace(/"[^"]*"/g, '').replace(/\[[^\]]*\]/g, '').replace(/\\./g, '');
  return /[yd]/i.test(s) || /h.*m|m.*s/i.test(s) || /[년월일]/.test(code);
}

/** 엑셀 날짜 일련번호 → ISO. 1900 체계(1900-02-29 버그 포함)·1904 체계. */
export function excelSerialToIso(serial: number, date1904 = false): string | null {
  if (!Number.isFinite(serial) || serial < 1 || serial > 2958465) return null;
  const days = Math.floor(serial);
  const base = date1904 ? Date.UTC(1904, 0, 1) : Date.UTC(1899, 11, 30);
  const ms = base + days * 86400000 + Math.round((serial - days) * 86400) * 1000;
  const d = new Date(ms);
  const iso = d.toISOString();
  const date = iso.slice(0, 10);
  const time = iso.slice(11, 16);
  return serial - days > 1e-9 ? `${date} ${time}` : date;
}

/** "B12" → [열 0부터, 행 0부터] */
export function cellRef(r: string): [number, number] | null {
  const m = /^([A-Z]{1,3})(\d{1,7})$/.exec(r);
  if (!m) return null;
  let col = 0;
  for (const ch of m[1]!) col = col * 26 + (ch.charCodeAt(0) - 64);
  return [col - 1, Number(m[2]) - 1];
}

function collect(xml: string, onToken: (t: XmlToken, path: string[]) => void): void {
  const path: string[] = [];
  for (const t of tokenize(xml)) {
    if (t.type === 'open') {
      onToken(t, path);
      if (!t.selfClosing) path.push(localName(t.name));
    } else if (t.type === 'close') {
      path.pop();
      onToken(t, path);
    } else onToken(t, path);
  }
}

function sharedStrings(xml: string | null): string[] {
  if (!xml) return [];
  const out: string[] = [];
  let cur: string[] | null = null;
  let inT = false;
  let inPhonetic = 0;
  collect(xml, (t, path) => {
    if (t.type === 'open') {
      const n = localName(t.name);
      if (n === 'si') {
        cur = [];
        if (t.selfClosing) {
          out.push('');
          cur = null;
        }
      } else if (n === 'rPh') inPhonetic++;
      else if (n === 't' && !t.selfClosing) inT = true;
    } else if (t.type === 'close') {
      const n = localName(t.name);
      if (n === 'si' && cur) {
        out.push(cur.join(''));
        cur = null;
        if (out.length > SHEET_LIMITS.maxSharedStrings) throw new SandboxError('sheet_too_large');
      } else if (n === 'rPh') inPhonetic--;
      else if (n === 't') inT = false;
    } else if (inT && cur && inPhonetic === 0 && path.includes('si')) cur.push(t.text);
  });
  return out;
}

function dateStyles(xml: string | null): Set<number> {
  const out = new Set<number>();
  if (!xml) return out;
  const custom = new Map<number, string>();
  const xfs: number[] = [];
  collect(xml, (t, path) => {
    if (t.type !== 'open') return;
    const n = localName(t.name);
    if (n === 'numFmt') custom.set(Number(t.attrs.numFmtId), t.attrs.formatCode ?? '');
    else if (n === 'xf' && path[path.length - 1] === 'cellXfs') xfs.push(Number(t.attrs.numFmtId ?? 0));
  });
  xfs.forEach((id, i) => {
    if (BUILTIN_DATE_FMTS.has(id) || (custom.has(id) && isDateFormatCode(custom.get(id)!))) out.add(i);
  });
  return out;
}

interface SheetRef {
  name: string;
  hidden: boolean;
  path: string;
}

function workbookSheets(wb: string, rels: string | null): { sheets: SheetRef[]; date1904: boolean } {
  const targets = new Map<string, string>();
  if (rels) {
    collect(rels, (t) => {
      if (t.type === 'open' && localName(t.name) === 'Relationship' && t.attrs.Id && t.attrs.Target && t.attrs.TargetMode !== 'External') targets.set(t.attrs.Id, t.attrs.Target);
    });
  }
  const sheets: SheetRef[] = [];
  let date1904 = false;
  collect(wb, (t) => {
    if (t.type !== 'open') return;
    const n = localName(t.name);
    if (n === 'workbookPr') date1904 = t.attrs.date1904 === '1' || t.attrs.date1904 === 'true';
    if (n !== 'sheet') return;
    const rid = Object.entries(t.attrs).find(([k]) => localName(k) === 'id')?.[1];
    const target = rid ? targets.get(rid) : undefined;
    if (!target) return;
    // 대상은 xl/ 기준 상대 경로(또는 /xl/… 절대)다. 다른 곳을 가리키면 읽지 않는다.
    const p = target.startsWith('/') ? target.slice(1) : `xl/${target}`;
    const norm = p.replace(/^xl\/\.\//, 'xl/');
    if (!/^xl\/worksheets\/[\w.-]+\.xml$/.test(norm)) return;
    sheets.push({ name: (t.attrs.name ?? '').slice(0, 64), hidden: t.attrs.state === 'hidden' || t.attrs.state === 'veryHidden', path: norm });
  });
  return { sheets, date1904 };
}

interface SheetCtx {
  strings: string[];
  dates: Set<number>;
  date1904: boolean;
  flags: SheetOutput['flags'];
  cells: number;
}

function readSheet(xml: string, ctx: SheetCtx): { rows: Cell[][]; hiddenRows: number } {
  const rows: Cell[][] = [];
  let hiddenRows = 0;
  let row: Cell[] | null = null;
  let rowHidden = false;
  let rowIndex = -1;
  let c: { col: number; t: string; s: number; v: string | null; inline: string[]; formula: boolean } | null = null;
  let field: 'v' | 't' | 'f' | null = null;
  let nextCol = 0;
  const finishCell = () => {
    if (!c || !row || rowHidden) return;
    if (c.col >= SHEET_LIMITS.maxCols) {
      ctx.flags.truncated = true;
      return;
    }
    if (c.formula) ctx.flags.formulas++;
    let v: Cell = null;
    const raw = c.v;
    switch (c.t) {
      case 's': {
        const k = raw === null ? NaN : Number(raw);
        v = Number.isInteger(k) && k >= 0 && k < ctx.strings.length ? ctx.strings[k]! : null;
        break;
      }
      case 'inlineStr':
        v = c.inline.join('');
        break;
      case 'str':
      case 'e':
        v = raw;
        break;
      case 'b':
        v = raw === '1';
        break;
      default: {
        const num = raw === null || raw.trim() === '' ? NaN : Number(raw);
        if (Number.isFinite(num)) v = ctx.dates.has(c.s) ? (excelSerialToIso(num, ctx.date1904) ?? num) : num;
      }
    }
    if (typeof v === 'string') {
      if (v.length > SHEET_LIMITS.maxCellChars) {
        v = v.slice(0, SHEET_LIMITS.maxCellChars);
        ctx.flags.truncated = true;
      }
      if (looksLikeFormula(v)) ctx.flags.formulaLikeText++;
    }
    if (++ctx.cells > SHEET_LIMITS.maxCells) throw new SandboxError('sheet_too_large');
    while (row.length < c.col) row.push(null);
    row[c.col] = v;
  };
  collect(xml, (t) => {
    if (t.type === 'open') {
      const n = localName(t.name);
      if (n === 'row') {
        const r = Number(t.attrs.r);
        rowIndex = Number.isInteger(r) && r > 0 ? r - 1 : rowIndex + 1;
        rowHidden = t.attrs.hidden === '1' || t.attrs.hidden === 'true';
        if (rowHidden) hiddenRows++;
        nextCol = 0;
        if (rowIndex >= SHEET_LIMITS.maxRows) {
          ctx.flags.truncated = true;
          row = null;
          return;
        }
        row = [];
        if (!rowHidden) {
          while (rows.length < rowIndex) rows.push([]);
          rows[rowIndex] = row;
        }
        if (t.selfClosing) row = null;
      } else if (n === 'c' && row) {
        const ref = t.attrs.r ? cellRef(t.attrs.r) : null;
        const col = ref ? ref[0] : nextCol;
        nextCol = col + 1;
        c = { col, t: t.attrs.t ?? 'n', s: Number(t.attrs.s ?? 0), v: null, inline: [], formula: false };
        if (t.selfClosing) {
          finishCell();
          c = null;
        }
      } else if (c && (n === 'v' || n === 't' || n === 'f')) {
        if (n === 'f') c.formula = true;
        field = t.selfClosing ? null : n;
      }
    } else if (t.type === 'close') {
      const n = localName(t.name);
      if (n === 'c') {
        finishCell();
        c = null;
      } else if (n === 'row') row = null;
      else if (n === 'v' || n === 't' || n === 'f') field = null;
    } else if (c && field === 'v') c.v = (c.v ?? '') + t.text;
    else if (c && field === 't') c.inline.push(t.text);
    // field === 'f': 수식 글자는 버린다(계산하지 않는다)
  });
  return { rows: rows.map((r) => trimRow(r ?? [])), hiddenRows };
}

export async function readXlsx(bytes: Uint8Array): Promise<SheetOutput> {
  const zip = new ZipReader(bytes);
  const flags = emptyFlags();
  const names = zip.names();
  flags.macros = names.some((n) => /vbaProject\.bin$|^xl\/macrosheets\//i.test(n));
  flags.externalLinks = names.some((n) => n.startsWith('xl/externalLinks/'));
  flags.connections = names.some((n) => n === 'xl/connections.xml' || n.startsWith('xl/queryTables/'));
  flags.embedded = names.some((n) => n.startsWith('xl/embeddings/') || n.startsWith('xl/activeX/') || n.startsWith('xl/ctrlProps/'));
  const wb = await zip.text('xl/workbook.xml');
  if (!wb) throw new SandboxError('sheet_invalid');
  const { sheets: refs, date1904 } = workbookSheets(wb, await zip.text('xl/_rels/workbook.xml.rels'));
  if (refs.length === 0) throw new SandboxError('sheet_invalid');
  if (refs.length > SHEET_LIMITS.maxSheets) throw new SandboxError('sheet_too_large');
  const ctx: SheetCtx = { strings: sharedStrings(await zip.text('xl/sharedStrings.xml')), dates: dateStyles(await zip.text('xl/styles.xml')), date1904, flags, cells: 0 };
  const sheets: SheetTable[] = [];
  for (const ref of refs) {
    if (ref.hidden) {
      flags.hiddenSheets++;
      sheets.push({ name: ref.name, hidden: true, rows: [], hiddenRows: 0 });
      continue;
    }
    const xml = await zip.text(ref.path);
    if (xml === null) throw new SandboxError('sheet_invalid');
    const { rows, hiddenRows } = readSheet(xml, ctx);
    sheets.push({ name: ref.name, hidden: false, rows, hiddenRows });
  }
  return { format: 'xlsx', encoding: null, sheets, flags };
}
