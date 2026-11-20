import { openCfb } from './cfb.ts';
import { SandboxError, SHEET_LIMITS } from './limits.ts';
import { emptyFlags, looksLikeFormula, trimRow, type Cell, type SheetOutput, type SheetTable } from './sheet.ts';
import { excelSerialToIso, isDateFormatCode } from './xlsx.ts';

const R = {
  BOF: 0x0809,
  EOF: 0x000a,
  FILEPASS: 0x002f,
  DATEMODE: 0x0022,
  BOUNDSHEET: 0x0085,
  SST: 0x00fc,
  CONTINUE: 0x003c,
  FORMAT: 0x041e,
  XF: 0x00e0,
  SUPBOOK: 0x01ae,
  OBPROJ: 0x00d3,
  LABELSST: 0x00fd,
  LABEL: 0x0204,
  NUMBER: 0x0203,
  RK: 0x027e,
  MULRK: 0x00bd,
  BOOLERR: 0x0205,
  FORMULA: 0x0006,
  STRING: 0x0207,
  ROW: 0x0208,
} as const;

const CELL_RECORDS = new Set<number>([R.LABELSST, R.LABEL, R.NUMBER, R.RK, R.MULRK, R.BOOLERR, R.FORMULA, 0x0201, 0x00be]);

const BUILTIN_DATE_FMTS = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 45, 46, 47]);
const EAST_ASIA_DATE_FMTS = new Set([27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 50, 51, 52, 53, 54, 55, 56, 57, 58]);
const ERRORS: Record<number, string> = { 0x00: '#NULL!', 0x07: '#DIV/0!', 0x0f: '#VALUE!', 0x17: '#REF!', 0x1d: '#NAME?', 0x24: '#NUM!', 0x2a: '#N/A', 0x2b: '#GETTING_DATA' };

const bad = (): never => {
  throw new SandboxError('sheet_invalid');
};

interface Rec {
  type: number;
  data: Uint8Array;
  next: number;
}

function rec(s: Uint8Array, p: number): Rec | null {
  if (p + 4 > s.length) return null;
  const type = s[p]! | (s[p + 1]! << 8);
  const len = s[p + 2]! | (s[p + 3]! << 8);
  if (p + 4 + len > s.length) bad();
  return { type, data: s.subarray(p + 4, p + 4 + len), next: p + 4 + len };
}

const dv = (d: Uint8Array) => new DataView(d.buffer, d.byteOffset, d.byteLength);
const need = (d: Uint8Array, n: number) => {
  if (d.length < n) bad();
};

function chars(d: Uint8Array, at: number, n: number, high: boolean): string {
  const parts: string[] = [];
  const step = 4096;
  if (high) {
    for (let i = 0; i < n; i += step) {
      const k = Math.min(step, n - i);
      const codes = new Array<number>(k);
      for (let j = 0; j < k; j++) codes[j] = d[at + (i + j) * 2]! | (d[at + (i + j) * 2 + 1]! << 8);
      parts.push(String.fromCharCode(...codes));
    }
  } else {
    for (let i = 0; i < n; i += step) parts.push(String.fromCharCode(...d.subarray(at + i, at + Math.min(n, i + step))));
  }
  return parts.join('');
}

function xlString(d: Uint8Array, at: number): string {
  need(d, at + 3);
  const cch = d[at]! | (d[at + 1]! << 8);
  const high = (d[at + 2]! & 1) === 1;
  const n = Math.min(cch, Math.floor((d.length - at - 3) / (high ? 2 : 1)));
  return chars(d, at + 3, n, high);
}

function shortString(d: Uint8Array, at: number): string {
  need(d, at + 2);
  const cch = d[at]!;
  const high = (d[at + 1]! & 1) === 1;
  const n = Math.min(cch, Math.floor((d.length - at - 2) / (high ? 2 : 1)));
  return chars(d, at + 2, n, high);
}

function readSst(segs: Uint8Array[]): string[] {
  let si = 0;
  let p = 0;
  const avail = () => {
    while (si < segs.length && p >= segs[si]!.length) {
      si++;
      p = 0;
    }
    if (si >= segs.length) bad();
    return segs[si]!;
  };
  const u8 = () => {
    const s = avail();
    return s[p++]!;
  };
  const u16 = () => u8() | (u8() << 8);
  const u32 = () => (u16() | (u16() << 16)) >>> 0;
  const skip = (n: number) => {
    while (n > 0) {
      const s = avail();
      const k = Math.min(n, s.length - p);
      p += k;
      n -= k;
    }
  };
  const text = (cch: number, high: boolean) => {
    const parts: string[] = [];
    let left = cch;
    while (left > 0) {
      let s = segs[si];
      if (!s || p >= s.length) {
        si++;
        p = 0;
        s = segs[si];
        if (!s || s.length === 0) bad();
        high = (s![p++]! & 1) === 1;
      }
      const room = Math.floor((s!.length - p) / (high ? 2 : 1));
      if (room === 0) bad();
      const k = Math.min(left, room);
      parts.push(chars(s!, p, k, high));
      p += k * (high ? 2 : 1);
      left -= k;
    }
    return parts.join('');
  };
  const total = segs.reduce((n, s) => n + s.length, 0);
  if (total < 8) bad();
  u32();
  const unique = u32();
  const out: string[] = [];
  for (let i = 0; i < unique; i++) {
    if (si >= segs.length || (si === segs.length - 1 && p >= segs[si]!.length)) break;
    const cch = u16();
    const flags = u8();
    const runs = flags & 0x08 ? u16() : 0;
    const ext = flags & 0x04 ? u32() : 0;
    out.push(text(cch, (flags & 1) === 1));
    skip(runs * 4);
    skip(ext);
    if (out.length > SHEET_LIMITS.maxSharedStrings) throw new SandboxError('sheet_too_large');
  }
  return out;
}

function rk(v: number): number {
  let n: number;
  if (v & 2) n = v >> 2;
  else {
    const b = new DataView(new ArrayBuffer(8));
    b.setUint32(4, v & 0xfffffffc, true);
    n = b.getFloat64(0, true);
  }
  return v & 1 ? n / 100 : n;
}

interface SheetRef {
  name: string;
  hidden: boolean;
  pos: number;
}

interface Ctx {
  strings: string[];
  dates: Set<number>;
  date1904: boolean;
  flags: SheetOutput['flags'];
  cells: number;
}

function eachSheetRecord(wb: Uint8Array, pos: number, fn: (r: Rec) => void): void {
  let p = pos;
  let depth = 0;
  for (;;) {
    const r = rec(wb, p);
    if (!r) bad();
    if (r!.type === R.BOF) depth++;
    else if (r!.type === R.EOF) {
      if (--depth === 0) return;
    } else if (depth === 1) fn(r!);
    else if (depth === 0) bad();
    p = r!.next;
  }
}

function readSheet(wb: Uint8Array, pos: number, ctx: Ctx): { rows: Cell[][]; hiddenRows: number } {
  const first = rec(wb, pos);
  if (!first || first.type !== R.BOF || first.data.length < 4) bad();
  const ver = first!.data[0]! | (first!.data[1]! << 8);
  if (ver !== 0x0600) throw new SandboxError('unsupported_format');
  const hidden = new Set<number>();
  eachSheetRecord(wb, pos, (r) => {
    if (r.type === R.ROW && r.data.length >= 16) {
      const v = dv(r.data);
      if (v.getUint32(12, true) & 0x20) hidden.add(v.getUint16(0, true));
    }
  });
  const rows: Cell[][] = [];
  let pendingString: [number, number] | null = null;
  const clean = (v: Cell): Cell => {
    if (typeof v !== 'string') return v;
    if (v.length > SHEET_LIMITS.maxCellChars) {
      v = v.slice(0, SHEET_LIMITS.maxCellChars);
      ctx.flags.truncated = true;
    }
    if (looksLikeFormula(v)) ctx.flags.formulaLikeText++;
    return v;
  };
  const put = (row: number, col: number, xf: number, value: Cell, formula = false): boolean => {
    if (hidden.has(row)) return false;
    if (row >= SHEET_LIMITS.maxRows || col >= SHEET_LIMITS.maxCols) {
      ctx.flags.truncated = true;
      return false;
    }
    if (formula) ctx.flags.formulas++;
    let v = value;
    if (typeof v === 'number') v = !Number.isFinite(v) ? null : ctx.dates.has(xf) ? (excelSerialToIso(v, ctx.date1904) ?? v) : v;
    if (++ctx.cells > SHEET_LIMITS.maxCells) throw new SandboxError('sheet_too_large');
    while (rows.length <= row) rows.push([]);
    const r = rows[row]!;
    while (r.length < col) r.push(null);
    r[col] = clean(v);
    return true;
  };
  eachSheetRecord(wb, pos, (r) => {
    const d = r.data;
    if (r.type === R.STRING) {
      if (pendingString) rows[pendingString[0]]![pendingString[1]] = clean(xlString(d, 0));
      pendingString = null;
      return;
    }
    if (CELL_RECORDS.has(r.type)) pendingString = null;
    switch (r.type) {
      case R.LABELSST: {
        need(d, 10);
        const v = dv(d);
        const k = v.getUint32(6, true);
        put(v.getUint16(0, true), v.getUint16(2, true), v.getUint16(4, true), k < ctx.strings.length ? ctx.strings[k]! : null);
        break;
      }
      case R.LABEL: {
        need(d, 9);
        const v = dv(d);
        put(v.getUint16(0, true), v.getUint16(2, true), v.getUint16(4, true), xlString(d, 6));
        break;
      }
      case R.NUMBER: {
        need(d, 14);
        const v = dv(d);
        put(v.getUint16(0, true), v.getUint16(2, true), v.getUint16(4, true), v.getFloat64(6, true));
        break;
      }
      case R.RK: {
        need(d, 10);
        const v = dv(d);
        put(v.getUint16(0, true), v.getUint16(2, true), v.getUint16(4, true), rk(v.getUint32(6, true)));
        break;
      }
      case R.MULRK: {
        need(d, 6);
        const v = dv(d);
        const row = v.getUint16(0, true);
        const col0 = v.getUint16(2, true);
        const n = Math.floor((d.length - 6) / 6);
        for (let i = 0; i < n; i++) put(row, col0 + i, v.getUint16(4 + i * 6, true), rk(v.getUint32(6 + i * 6, true)));
        break;
      }
      case R.BOOLERR: {
        need(d, 8);
        const v = dv(d);
        put(v.getUint16(0, true), v.getUint16(2, true), v.getUint16(4, true), d[7] ? (ERRORS[d[6]!] ?? '#ERROR!') : d[6] !== 0);
        break;
      }
      case R.FORMULA: {
        need(d, 14);
        const v = dv(d);
        const row = v.getUint16(0, true);
        const col = v.getUint16(2, true);
        const xf = v.getUint16(4, true);
        if (v.getUint16(12, true) === 0xffff) {
          const kind = d[6]!;
          if (kind === 0) {
            if (put(row, col, xf, null, true)) pendingString = [row, col];
          } else if (kind === 1) put(row, col, xf, d[8] !== 0, true);
          else if (kind === 2) put(row, col, xf, ERRORS[d[8]!] ?? '#ERROR!', true);
          else put(row, col, xf, null, true);
        } else put(row, col, xf, v.getFloat64(6, true), true);
        break;
      }
    }
  });
  return { rows: rows.map((r) => trimRow(r)), hiddenRows: hidden.size };
}

/** CFB 안의 Workbook(BIFF8) 스트림 → 표 */
export function readXls(bytes: Uint8Array): SheetOutput {
  const cfb = openCfb(bytes);
  const names = new Set(cfb.top.map((e) => e.name.toLowerCase()));
  if (names.has('encryptioninfo') || names.has('encryptedpackage')) throw new SandboxError('password_required');
  const flags = emptyFlags();
  flags.macros = names.has('_vba_project_cur') || names.has('_vba_project');
  flags.embedded = [...names].some((n) => n.startsWith('mbd') || n === 'objectpool');
  const wb = cfb.stream('Workbook') ?? cfb.stream('Book');
  if (!wb) throw new SandboxError('unsupported_format');

  const bof = rec(wb, 0);
  if (!bof || bof.type !== R.BOF) {
    if (bof && (bof.type === 0x0009 || bof.type === 0x0209 || bof.type === 0x0409)) throw new SandboxError('unsupported_format');
    bad();
  }
  if (bof!.data.length < 4) bad();
  const ver = bof!.data[0]! | (bof!.data[1]! << 8);
  if (ver !== 0x0600) throw new SandboxError('unsupported_format');
  const dt = bof!.data[2]! | (bof!.data[3]! << 8);
  if (dt !== 0x0005) bad();

  const refs: SheetRef[] = [];
  let strings: string[] = [];
  let date1904 = false;
  const formats = new Map<number, string>();
  const xfs: number[] = [];
  let p = bof!.next;
  for (;;) {
    const r = rec(wb, p);
    if (!r) bad();
    const d = r!.data;
    p = r!.next;
    if (r!.type === R.EOF) break;
    switch (r!.type) {
      case R.FILEPASS:
        throw new SandboxError('password_required');
      case R.DATEMODE:
        date1904 = d.length >= 2 && (d[0]! | (d[1]! << 8)) === 1;
        break;
      case R.BOUNDSHEET: {
        need(d, 8);
        const kind = d[5]!;
        if (kind === 1) flags.macros = true;
        if (kind !== 0) break;
        refs.push({ name: shortString(d, 6).slice(0, 64), hidden: (d[4]! & 3) !== 0, pos: dv(d).getUint32(0, true) });
        break;
      }
      case R.SST: {
        const segs = [d];
        for (let n = rec(wb, p); n && n.type === R.CONTINUE; n = rec(wb, p)) {
          segs.push(n.data);
          p = n.next;
        }
        strings = readSst(segs);
        break;
      }
      case R.FORMAT:
        if (d.length >= 5) formats.set(d[0]! | (d[1]! << 8), xlString(d, 2));
        break;
      case R.XF:
        need(d, 4);
        xfs.push(d[2]! | (d[3]! << 8));
        break;
      case R.SUPBOOK:
        if (d.length >= 4) {
          const cch = d[2]! | (d[3]! << 8);
          if (cch !== 0x0401 && cch !== 0x3a01) flags.externalLinks = true;
        }
        break;
      case R.OBPROJ:
        flags.macros = true;
        break;
    }
  }
  if (refs.length === 0) bad();
  if (refs.length > SHEET_LIMITS.maxSheets) throw new SandboxError('sheet_too_large');
  const dates = new Set<number>();
  xfs.forEach((id, i) => {
    const code = formats.get(id);
    if (BUILTIN_DATE_FMTS.has(id) || (code !== undefined ? isDateFormatCode(code) : EAST_ASIA_DATE_FMTS.has(id))) dates.add(i);
  });
  const ctx: Ctx = { strings, dates, date1904, flags, cells: 0 };
  const sheets: SheetTable[] = [];
  for (const ref of refs) {
    if (ref.hidden) {
      flags.hiddenSheets++;
      sheets.push({ name: ref.name, hidden: true, rows: [], hiddenRows: 0 });
      continue;
    }
    if (ref.pos >= wb.length) bad();
    const { rows, hiddenRows } = readSheet(wb, ref.pos, ctx);
    sheets.push({ name: ref.name, hidden: false, rows, hiddenRows });
  }
  return { format: 'xls', encoding: null, sheets, flags };
}
