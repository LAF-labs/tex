// 테스트용 ZIP·xlsx 쓰기(합성 픽스처·퍼징 시드 전용, 제품 경로에서 쓰지 않는다). 머리 크기를 일부러 속일 수 있다.

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(b: Uint8Array): number {
  let c = 0xffffffff;
  for (const x of b) c = CRC_TABLE[(c ^ x) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export async function deflateRaw(b: Uint8Array): Promise<Uint8Array> {
  const cs = new CompressionStream('deflate-raw');
  const w = cs.writable.getWriter();
  void w.write(b as Uint8Array<ArrayBuffer>).then(() => w.close());
  return new Uint8Array(await new Response(cs.readable).arrayBuffer());
}

export interface ZipItem {
  name: string;
  data: Uint8Array | string;
  /** 기본 deflate */
  store?: boolean;
  /** 중앙 디렉터리에 적을 풀린 크기(거짓말 시험) */
  lieSize?: number;
  /** 일반 목적 플래그(암호 비트 시험) */
  flags?: number;
  method?: number;
}

const enc = new TextEncoder();

export async function writeZip(items: ZipItem[], opts: { zip64Marker?: boolean } = {}): Promise<Uint8Array> {
  const parts: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  for (const it of items) {
    const raw = typeof it.data === 'string' ? enc.encode(it.data) : it.data;
    const method = it.method ?? (it.store ? 0 : 8);
    const body = method === 8 ? await deflateRaw(raw) : raw;
    const name = enc.encode(it.name);
    const crc = crc32(raw);
    const size = it.lieSize ?? raw.length;
    const local = new Uint8Array(30 + name.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);
    lv.setUint16(6, (it.flags ?? 0) | 0x800, true);
    lv.setUint16(8, method, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, body.length, true);
    lv.setUint32(22, size, true);
    lv.setUint16(26, name.length, true);
    local.set(name, 30);
    const cd = new Uint8Array(46 + name.length);
    const cv = new DataView(cd.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(8, (it.flags ?? 0) | 0x800, true);
    cv.setUint16(10, method, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, body.length, true);
    cv.setUint32(24, size, true);
    cv.setUint16(28, name.length, true);
    cv.setUint32(42, offset, true);
    cd.set(name, 46);
    parts.push(local, body);
    central.push(cd);
    offset += local.length + body.length;
  }
  const cdSize = central.reduce((s, c) => s + c.length, 0);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, opts.zip64Marker ? 0xffff : items.length, true);
  ev.setUint16(10, opts.zip64Marker ? 0xffff : items.length, true);
  ev.setUint32(12, cdSize, true);
  ev.setUint32(16, offset, true);
  const all = [...parts, ...central, end];
  const out = new Uint8Array(all.reduce((s, p) => s + p.length, 0));
  let o = 0;
  for (const p of all) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const colName = (i: number) => {
  let s = '';
  for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
};

export type FixtureCell = string | number | null | { f: string; v: string | number } | { date: string };

export interface FixtureSheet {
  name: string;
  rows: FixtureCell[][];
  hidden?: boolean;
  hiddenRows?: number[];
}

/** 최소 xlsx. 문자열은 공유 문자열, 날짜는 스타일 1(numFmt 14), 수식은 저장 값과 함께. extra로 매크로·외부 연결 같은 항목을 더한다. */
export async function writeXlsx(sheets: FixtureSheet[], extra: ZipItem[] = [], opts: { sheetXml?: (i: number, xml: string) => string } = {}): Promise<Uint8Array> {
  const strings: string[] = [];
  const sid = (s: string) => {
    let k = strings.indexOf(s);
    if (k < 0) k = strings.push(s) - 1;
    return k;
  };
  const serial = (iso: string) => Math.round((Date.parse(`${iso}T00:00:00Z`) - Date.UTC(1899, 11, 30)) / 86400000);
  const sheetXml = sheets.map((sh, si) => {
    const rows = sh.rows
      .map((r, ri) => {
        const cells = r
          .map((c, ci) => {
            const ref = `${colName(ci)}${ri + 1}`;
            if (c === null) return '';
            if (typeof c === 'number') return `<c r="${ref}"><v>${c}</v></c>`;
            if (typeof c === 'string') return `<c r="${ref}" t="s"><v>${sid(c)}</v></c>`;
            if ('date' in c) return `<c r="${ref}" s="1"><v>${serial(c.date)}</v></c>`;
            return typeof c.v === 'number' ? `<c r="${ref}"><f>${esc(c.f)}</f><v>${c.v}</v></c>` : `<c r="${ref}" t="str"><f>${esc(c.f)}</f><v>${esc(c.v)}</v></c>`;
          })
          .join('');
        return `<row r="${ri + 1}"${sh.hiddenRows?.includes(ri) ? ' hidden="1"' : ''}>${cells}</row>`;
      })
      .join('');
    const xml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${rows}</sheetData></worksheet>`;
    return opts.sheetXml ? opts.sheetXml(si, xml) : xml;
  });
  const wb = `<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${sheets
    .map((s, i) => `<sheet name="${esc(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"${s.hidden ? ' state="hidden"' : ''}/>`)
    .join('')}</sheets></workbook>`;
  const rels = `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets
    .map((_s, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`)
    .join('')}</Relationships>`;
  const sst = `<?xml version="1.0" encoding="UTF-8"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${strings.length}" uniqueCount="${strings.length}">${strings.map((s) => `<si><t xml:space="preserve">${esc(s)}</t></si>`).join('')}</sst>`;
  const styles = `<?xml version="1.0" encoding="UTF-8"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><cellXfs count="2"><xf numFmtId="0"/><xf numFmtId="14" applyNumberFormat="1"/></cellXfs></styleSheet>`;
  const types = `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/></Types>`;
  return writeZip([
    { name: '[Content_Types].xml', data: types },
    { name: 'xl/workbook.xml', data: wb },
    { name: 'xl/_rels/workbook.xml.rels', data: rels },
    { name: 'xl/sharedStrings.xml', data: sst },
    { name: 'xl/styles.xml', data: styles },
    ...sheetXml.map((x, i) => ({ name: `xl/worksheets/sheet${i + 1}.xml`, data: x })),
    ...extra,
  ]);
}

/** EUC-KR 인코딩(플랫폼 TextDecoder로 역표를 만든다. 합성 CSV 전용) */
let eucMap: Map<string, number[]> | null = null;
export function encodeEucKr(s: string): Uint8Array {
  if (!eucMap) {
    eucMap = new Map();
    const d = new TextDecoder('euc-kr');
    for (let a = 0xb0; a <= 0xc8; a++) for (let b = 0xa1; b <= 0xfe; b++) eucMap.set(d.decode(new Uint8Array([a, b])), [a, b]);
    for (let b = 0xa1; b <= 0xfe; b++) eucMap.set(d.decode(new Uint8Array([0xa1, b])), [0xa1, b]);
  }
  const out: number[] = [];
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    if (c < 0x80) out.push(c);
    else {
      const m = eucMap.get(ch);
      if (!m) throw new Error(`euc-kr: ${ch}`);
      out.push(...m);
    }
  }
  return new Uint8Array(out);
}
