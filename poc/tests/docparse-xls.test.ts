// .xls(BIFF8 in OLE 복합 문서)·HTML 표(.xls로 내려받은 것) 읽기(샌드박스 모듈, Electron 없음). 값은 모두 가짜다.
// xls는 이 파일 안의 작은 CFB·BIFF8 작성기로 만든다(실제 은행·홈택스 파일은 쓰지 않는다).
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { decodeHtmlEntities, metaCharset, readSheetBytes, SandboxError, sniffFormat } from '@sax/docparse/sandbox';

const code = (p: Promise<unknown>) => p.then(() => 'ok', (e: unknown) => (e instanceof SandboxError ? e.code : `throw:${(e as Error)?.message}`));

// ── 바이트 도우미 ──
const u16 = (n: number) => [n & 0xff, (n >> 8) & 0xff];
const u32 = (n: number) => [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff];
const f64 = (n: number) => {
  const b = new DataView(new ArrayBuffer(8));
  b.setFloat64(0, n, true);
  return [...new Uint8Array(b.buffer)];
};
const isWide = (s: string) => [...s].some((c) => c.charCodeAt(0) > 0xff);
const charBytes = (s: string, wide: boolean) => (wide ? [...s].flatMap((c) => u16(c.charCodeAt(0))) : [...s].map((c) => c.charCodeAt(0)));
/** XLUnicodeString(cch u16, flags, 글자) */
const xlStr = (s: string) => [...u16(s.length), isWide(s) ? 1 : 0, ...charBytes(s, isWide(s))];
/** ShortXLUnicodeString(cch u8, flags, 글자) */
const shortStr = (s: string) => [s.length, isWide(s) ? 1 : 0, ...charBytes(s, isWide(s))];
const rec = (type: number, data: number[]) => [...u16(type), ...u16(data.length), ...data];
const cat = (...parts: number[][]) => parts.flat();

const BOF = (dt: number, ver = 0x0600) => rec(0x0809, [...u16(ver), ...u16(dt), ...u16(0), ...u16(0), ...u32(0), ...u32(0)]);
const EOF = rec(0x000a, []);
const XF = (ifmt: number) => rec(0x00e0, [...u16(0), ...u16(ifmt), ...new Array<number>(16).fill(0)]);
const LABELSST = (r: number, c: number, i: number, xf = 0) => rec(0x00fd, [...u16(r), ...u16(c), ...u16(xf), ...u32(i)]);
const NUMBER = (r: number, c: number, v: number, xf = 0) => rec(0x0203, [...u16(r), ...u16(c), ...u16(xf), ...f64(v)]);
const rkInt = (n: number, x100 = false) => ((n << 2) | 2 | (x100 ? 1 : 0)) >>> 0;
const MULRK = (r: number, c0: number, rks: number[]) => rec(0x00bd, [...u16(r), ...u16(c0), ...rks.flatMap((k) => [...u16(0), ...u32(k)]), ...u16(c0 + rks.length - 1)]);
const FORMULA = (r: number, c: number, value: number[], xf = 0) => rec(0x0006, [...u16(r), ...u16(c), ...u16(xf), ...value, ...u16(0), ...u32(0), ...u16(3), 0x1e, 0x01, 0x00]);
const ROW = (r: number, hidden: boolean) => rec(0x0208, [...u16(r), ...u16(0), ...u16(6), ...u16(0xff), ...u16(0), ...u16(0), ...u32(hidden ? 0x20 : 0)]);
const BOOLERR = (r: number, c: number, v: number, err: boolean) => rec(0x0205, [...u16(r), ...u16(c), ...u16(0), v, err ? 1 : 0]);
const LABEL = (r: number, c: number, s: string) => rec(0x0204, [...u16(r), ...u16(c), ...u16(0), ...xlStr(s)]);
const BOUNDSHEET = (pos: number, name: string, hidden: boolean) => rec(0x0085, [...u32(pos), hidden ? 1 : 0, 0, ...shortStr(name)]);

const HEAD = ['거래일시', '적요', '기재내용', '찾으신금액', '맡기신금액', '잔액'];
const RICH = '급여(서식)';
const SPLIT = '메모-적요-ABCDEF';
const STRINGS = [...HEAD, '입금', RICH, SPLIT, '=HYPERLINK("x")', '숨김행', '숨긴 시트 글자'];
const [I_IN, I_RICH, I_SPLIT, I_FORM, I_HROW, I_HSHEET] = [6, 7, 8, 9, 10, 11];

/** SST + CONTINUE. SPLIT 글자 도중('메모-적요-' 뒤)에서 CONTINUE로 넘기고, 넘어간 꼬리는 압축(플래그 0)으로 적는다 */
function sst(): number[] {
  const a: number[] = [...u32(STRINGS.length), ...u32(STRINGS.length)];
  let b: number[] = [];
  for (let i = 0; i < STRINGS.length; i++) {
    const s = STRINGS[i]!;
    const wide = isWide(s);
    if (i === I_RICH) {
      // 서식 런 1개 + 확장 4바이트(건너뛰어야 한다)
      (b.length ? b : a).push(...u16(s.length), (wide ? 1 : 0) | 0x08 | 0x04, ...u16(1), ...u32(4), ...charBytes(s, wide), ...u16(0), ...u16(1), 9, 9, 9, 9);
    } else if (i === I_SPLIT) {
      const head = '메모-적요-';
      a.push(...u16(s.length), 1, ...charBytes(head, true));
      b = [0, ...charBytes(s.slice(head.length), false)]; // 새 조각 첫 바이트 = 플래그(압축)
    } else (b.length ? b : a).push(...u16(s.length), wide ? 1 : 0, ...charBytes(s, wide));
  }
  return [...rec(0x00fc, a), ...rec(0x003c, b)];
}

function sheet1(): number[] {
  return cat(
    BOF(0x0010),
    ROW(0, false),
    ROW(3, true),
    ...HEAD.map((_, c) => LABELSST(0, c, c)),
    NUMBER(1, 0, 46326.5, 1), // 사용자 서식 yyyy-mm-dd hh:mm(XF 1) → 시각 포함
    LABELSST(1, 1, I_IN),
    LABELSST(1, 2, I_RICH),
    MULRK(1, 3, [rkInt(0), rkInt(150000), rkInt(1234567, true)]),
    NUMBER(2, 0, 46327, 2), // 내장 서식 14(XF 2)
    FORMULA(2, 1, [0, 0, 0, 0, 0, 0, 0xff, 0xff]), // 문자열 결과 → 다음 STRING
    rec(0x04bc, [0, 0]), // SHRFMLA 흉내(FORMULA와 STRING 사이에 올 수 있다)
    rec(0x0207, xlStr('이체')),
    LABELSST(2, 2, I_SPLIT),
    NUMBER(2, 3, 50000),
    FORMULA(2, 5, f64(1100000)),
    LABELSST(3, 0, I_HROW), // 숨김 행
    NUMBER(3, 1, 999),
    LABEL(4, 0, '메모'),
    BOOLERR(4, 1, 1, false),
    BOOLERR(4, 2, 0x2a, true),
    LABELSST(4, 3, I_FORM),
    // 시트 안 차트(BOF…EOF)는 건너뛴다
    BOF(0x0020),
    NUMBER(9, 9, 777),
    EOF,
    EOF,
  );
}

function workbook(o: { filepass?: boolean; ver?: number } = {}): Uint8Array {
  const s1 = sheet1();
  const s2 = cat(BOF(0x0010), LABELSST(0, 0, I_HSHEET), EOF);
  const globals = (p1: number, p2: number) =>
    cat(
      BOF(0x0005, o.ver),
      o.filepass ? rec(0x002f, [1, 0, 1, 0, ...new Array<number>(48).fill(0x5a)]) : [],
      rec(0x0022, u16(0)),
      rec(0x041e, [...u16(164), ...xlStr('yyyy-mm-dd hh:mm')]),
      XF(0),
      XF(164),
      XF(14),
      BOUNDSHEET(p1, '거래내역', false),
      BOUNDSHEET(p2, '숨김', true),
      sst(),
      EOF,
    );
  const len = globals(0, 0).length;
  return new Uint8Array([...globals(len, len + s1.length), ...s1, ...s2]);
}

// ── CFB(v3, 512바이트 섹터) 작성기 ──
const END = 0xfffffffe;
const FREE = 0xffffffff;
const FATSECT = 0xfffffffd;
const NOSTREAM = 0xffffffff;

interface Cfb {
  bytes: Uint8Array;
  /** 스트림 이름 → 첫 섹터(큰 스트림만) */
  starts: Record<string, number>;
  fatSector: number;
  dirSector: number;
}

function cfb(streams: Array<{ name: string; data: Uint8Array }>): Cfb {
  const SEC = 512;
  const secs = (n: number) => Math.ceil(n / SEC);
  const small = streams.filter((s) => s.data.length < 4096);
  const big = streams.filter((s) => s.data.length >= 4096);
  // 미니 스트림
  const miniStart: number[] = [];
  const miniParts: number[] = [];
  const miniFat: number[] = [];
  for (const s of small) {
    const n = Math.ceil(s.data.length / 64);
    miniStart.push(n ? miniFat.length : END);
    for (let i = 0; i < n; i++) miniFat.push(i === n - 1 ? END : miniFat.length + 1);
    const padded = new Uint8Array(n * 64);
    padded.set(s.data);
    miniParts.push(...padded);
  }
  const dirN = secs((streams.length + 1) * 128);
  const miniFatN = secs(miniFat.length * 4);
  const miniN = secs(miniParts.length);
  const bigN = big.map((s) => secs(s.data.length));
  const rest = dirN + miniFatN + miniN + bigN.reduce((a, b) => a + b, 0);
  let fatN = 1;
  while (fatN * 128 < fatN + rest) fatN++;
  const fat: number[] = [];
  const run = (n: number) => {
    const start = fat.length;
    for (let i = 0; i < n; i++) fat.push(i === n - 1 ? END : fat.length + 1);
    return n ? start : END;
  };
  for (let i = 0; i < fatN; i++) fat.push(FATSECT);
  const dirStart = run(dirN);
  const miniFatStart = run(miniFatN);
  const miniStreamStart = run(miniN);
  const bigStart = bigN.map(run);
  while (fat.length < fatN * 128) fat.push(FREE);
  const total = fat.length > 0 ? fatN + rest : 0;
  const out = new Uint8Array(SEC + total * SEC);
  const v = new DataView(out.buffer);
  out.set([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
  v.setUint16(24, 0x3e, true);
  v.setUint16(26, 3, true);
  v.setUint16(28, 0xfffe, true);
  v.setUint16(30, 9, true);
  v.setUint16(32, 6, true);
  v.setUint32(44, fatN, true);
  v.setUint32(48, dirStart, true);
  v.setUint32(56, 4096, true);
  v.setUint32(60, miniFatN ? miniFatStart : END, true);
  v.setUint32(64, miniFatN, true);
  v.setUint32(68, END, true);
  v.setUint32(72, 0, true);
  for (let i = 0; i < 109; i++) v.setUint32(76 + i * 4, i < fatN ? i : FREE, true);
  const at = (s: number) => SEC + s * SEC;
  fat.forEach((x, i) => v.setUint32(at(0) + i * 4, x, true));
  // 디렉터리: 루트 + 자식(오른쪽 형제로 줄줄이)
  const ents = [{ name: 'Root Entry', type: 5, start: miniN ? miniStreamStart : END, size: miniParts.length }, ...streams.map((s) => {
    const bi = big.indexOf(s);
    return { name: s.name, type: 2, start: bi >= 0 ? bigStart[bi]! : miniStart[small.indexOf(s)]!, size: s.data.length };
  })];
  ents.forEach((e, i) => {
    const o = at(dirStart) + i * 128;
    for (let k = 0; k < e.name.length; k++) v.setUint16(o + k * 2, e.name.charCodeAt(k), true);
    v.setUint16(o + 64, (e.name.length + 1) * 2, true);
    out[o + 66] = e.type;
    out[o + 67] = 1;
    v.setUint32(o + 68, NOSTREAM, true);
    v.setUint32(o + 72, i > 0 && i < ents.length - 1 ? i + 1 : NOSTREAM, true);
    v.setUint32(o + 76, i === 0 && ents.length > 1 ? 1 : NOSTREAM, true);
    v.setUint32(o + 116, e.start, true);
    v.setUint32(o + 120, e.size, true);
  });
  miniFat.forEach((x, i) => v.setUint32(at(miniFatStart) + i * 4, x, true));
  if (miniN) out.set(miniParts, at(miniStreamStart));
  big.forEach((s, i) => out.set(s.data, at(bigStart[i]!)));
  return { bytes: out, starts: Object.fromEntries(big.map((s, i) => [s.name, bigStart[i]!])), fatSector: 0, dirSector: dirStart };
}

/** Workbook을 4096바이트 넘게 늘려 큰 섹터 체인에 둔다(EOF 뒤 0은 읽지 않는다) */
const padded = (b: Uint8Array) => {
  const out = new Uint8Array(Math.max(b.length, 5000));
  out.set(b);
  return out;
};

const EXPECTED_ROWS = [
  HEAD,
  ['2026-10-31 12:00', '입금', RICH, 0, 150000, 12345.67],
  ['2026-11-01', '이체', SPLIT, 50000, null, 1100000],
  [],
  ['메모', true, '#N/A', '=HYPERLINK("x")'],
];

describe('xls(BIFF8) 읽기', () => {
  it('머리 바이트: OLE → xls, <table 있는 HTML → html, 표 없는 HTML → 거부', () => {
    assert.deepEqual(sniffFormat(cfb([{ name: 'Workbook', data: workbook() }]).bytes), { format: 'xls' });
    assert.deepEqual(sniffFormat(new TextEncoder().encode('\uFEFF  <html><body><TABLE><tr><td>1</td></tr></TABLE>')), { format: 'html' });
    assert.deepEqual(sniffFormat(new TextEncoder().encode('<html><body>표 없음</body></html>')), { rejected: 'html' });
  });

  for (const [label, wrap] of [['미니 스트림(4KB 미만)', (b: Uint8Array) => b], ['큰 섹터 체인', padded]] as const) {
    it(`SST(한글·CONTINUE 경계·서식 런)·LABELSST·LABEL·NUMBER·RK·MULRK·FORMULA+STRING·BOOLERR·날짜 서식·숨김 행·숨김 시트 — ${label}`, async () => {
      const out = await readSheetBytes(cfb([{ name: 'Workbook', data: wrap(workbook()) }]).bytes);
      assert.equal(out.format, 'xls');
      assert.equal(out.encoding, null);
      assert.equal(out.sheets.length, 2);
      const [s, h] = out.sheets;
      assert.equal(s!.name, '거래내역');
      assert.deepEqual(s!.rows, EXPECTED_ROWS);
      assert.equal(s!.hiddenRows, 1);
      assert.deepEqual(h, { name: '숨김', hidden: true, rows: [], hiddenRows: 0 });
      assert.equal(out.flags.hiddenSheets, 1);
      assert.equal(out.flags.formulas, 2);
      assert.equal(out.flags.formulaLikeText, 1);
      assert.equal(out.flags.truncated, false);
      assert.ok(!JSON.stringify(out).includes('숨김행') && !JSON.stringify(out).includes('숨긴 시트 글자') && !JSON.stringify(out).includes('777'));
    });
  }

  it('1904 날짜 체계(DATEMODE=1)', async () => {
    const wb = workbook();
    // DATEMODE 레코드(0x0022) 값 0 → 1
    const i = wb.findIndex((_, k) => wb[k] === 0x22 && wb[k + 1] === 0 && wb[k + 2] === 2 && wb[k + 3] === 0);
    wb[i + 4] = 1;
    const out = await readSheetBytes(cfb([{ name: 'Workbook', data: wb }]).bytes);
    assert.equal(out.sheets[0]!.rows[2]![0], '2030-11-02');
  });

  it('암호: FILEPASS·EncryptionInfo/EncryptedPackage(암호 건 xlsx) → password_required', async () => {
    assert.equal(await code(readSheetBytes(cfb([{ name: 'Workbook', data: workbook({ filepass: true }) }]).bytes)), 'password_required');
    const enc = cfb([{ name: 'EncryptionInfo', data: new Uint8Array(200).fill(1) }, { name: 'EncryptedPackage', data: new Uint8Array(6000).fill(2) }]);
    assert.equal(await code(readSheetBytes(enc.bytes)), 'password_required');
  });

  it('BIFF5(Book 스트림)·xls 아닌 OLE 문서 → unsupported_format', async () => {
    assert.equal(await code(readSheetBytes(cfb([{ name: 'Book', data: workbook({ ver: 0x0500 }) }]).bytes)), 'unsupported_format');
    assert.equal(await code(readSheetBytes(cfb([{ name: 'WordDocument', data: new Uint8Array(100) }]).bytes)), 'unsupported_format');
  });

  it('깨진 파일은 멈추지 않고 오류 코드: FAT 체인 순환·디렉터리 형제 순환·체인이 크기보다 짧음·머리 0', async () => {
    const loop = cfb([{ name: 'Workbook', data: padded(workbook()) }]);
    const v = new DataView(loop.bytes.buffer);
    const s = loop.starts.Workbook!;
    v.setUint32(512 + (s + 2) * 4, s, true); // 세 번째 섹터가 첫 섹터로 돌아간다
    assert.equal(await code(readSheetBytes(loop.bytes)), 'sheet_invalid');

    const dirLoop = cfb([{ name: 'A', data: new Uint8Array(10) }, { name: 'Workbook', data: workbook() }]);
    const dv = new DataView(dirLoop.bytes.buffer);
    dv.setUint32(512 + dirLoop.dirSector * 512 + 2 * 128 + 72, 1, true); // Workbook의 오른쪽 형제 = A(순환)
    assert.equal(await code(readSheetBytes(dirLoop.bytes)), 'sheet_invalid');

    const short = cfb([{ name: 'Workbook', data: padded(workbook()) }]);
    new DataView(short.bytes.buffer).setUint32(512 + short.starts.Workbook! * 4, END, true);
    assert.equal(await code(readSheetBytes(short.bytes)), 'sheet_invalid');

    assert.equal(await code(readSheetBytes(new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, ...new Uint8Array(1500)]))), 'sheet_invalid');
  });

  it('무작위 변이 3000회: 성공하거나 SandboxError, 다른 예외·멈춤 없음', async () => {
    let seed = 7;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32);
    const bases = [cfb([{ name: 'Workbook', data: workbook() }]).bytes, cfb([{ name: 'Workbook', data: padded(workbook()) }]).bytes];
    for (let n = 0; n < 3000; n++) {
      const b = bases[n % 2]!.slice();
      for (let k = 0, m = 1 + Math.floor(rnd() * 8); k < m; k++) b[Math.floor(rnd() * b.length)] = Math.floor(rnd() * 256);
      const got = await code(readSheetBytes(b));
      assert.ok(!got.startsWith('throw:'), `${n}: ${got}`);
    }
  });
});

describe('HTML 표(.xls로 내려받은 것) 읽기', () => {
  const BANK = `<html><head><meta http-equiv="Content-Type" content="text/html; charset=utf-8"><title>거래내역 제목</title>
<style>td { mso-number-format:"\\@"; }</style><script>var x = "<table><tr><td>스크립트</td></tr></table>";</script></head>
<body><!-- <table><tr><td>주석</td></tr></table> -->
<table border=1>
<tr><th colspan="6">계좌 거래내역 &amp; 조회</th></tr>
<tr><th>거래일시</th><th>적요</th><th>기재내용</th><th>찾으신금액</th><th>맡기신금액</th><th>잔액</th></tr>
<tr><td rowspan=2>2026.10.01 09:00</td><td>입금</td><td>홍&nbsp;길동 &lt;급여&gt;</td><td>0</td><td>1,500,000</td><td>2,000,000</td></tr>
<tr><td>이체</td><td class='x' data-a="a>b">&#54620;&#xAE00;  &quot;메모&quot;<br>둘째 줄</td><td>50,000</td><td>0</td><td>1,950,000</td></tr>
<tr><td>=SUM(A1)</td><TD>&unknown; & 끝</TD></tr>
</table>
<table><tr><td></td></tr></table>
<table><tr><td>둘째 표</td></tr></table>
</body></html>`;

  it('UTF-8(meta charset): colspan·rowspan(null)·엔티티·공백·script/style/주석/title 버림·빈 표 뺌', async () => {
    const out = await readSheetBytes(new TextEncoder().encode(BANK));
    assert.equal(out.format, 'html');
    assert.equal(out.encoding, 'utf-8');
    assert.deepEqual(out.sheets.map((s) => s.name), ['table1', 'table3']);
    assert.deepEqual(out.sheets[0]!.rows, [
      ['계좌 거래내역 & 조회'],
      ['거래일시', '적요', '기재내용', '찾으신금액', '맡기신금액', '잔액'],
      ['2026.10.01 09:00', '입금', '홍 길동 <급여>', '0', '1,500,000', '2,000,000'],
      [null, '이체', '한글 "메모" 둘째 줄', '50,000', '0', '1,950,000'],
      ['=SUM(A1)', '&unknown; & 끝'],
    ]);
    assert.deepEqual(out.sheets[1]!.rows, [['둘째 표']]);
    assert.equal(out.flags.formulaLikeText, 1);
    assert.ok(!JSON.stringify(out).includes('스크립트') && !JSON.stringify(out).includes('주석') && !JSON.stringify(out).includes('제목'));
  });

  it('EUC-KR: meta charset=ks_c_5601-1987, meta 없음(UTF-8 실패 → EUC-KR), meta가 utf-8이라고 거짓말', async () => {
    const ascii = (s: string) => [...s].map((c) => c.charCodeAt(0));
    const IPGEUM = [0xc0, 0xd4, 0xb1, 0xdd]; // '입금'
    const body = (meta: string) => new Uint8Array([...ascii(`<html><head>${meta}</head><body><table><tr><td>`), ...IPGEUM, ...ascii('</td><td>1,000</td></tr></table></body></html>')]);
    for (const meta of ['<meta http-equiv="Content-Type" content="text/html; charset=ks_c_5601-1987">', '', '<meta charset="utf-8">']) {
      const out = await readSheetBytes(body(meta));
      assert.equal(out.encoding, 'euc-kr', meta);
      assert.deepEqual(out.sheets[0]!.rows, [['입금', '1,000']]);
    }
    assert.equal(metaCharset(body('<META CHARSET=cp949>')), 'euc-kr');
  });

  it('엔티티 풀기·태그 같은 글자', () => {
    assert.equal(decodeHtmlEntities('a&amp;b&lt;&gt;&quot;&apos;&nbsp;&#65;&#x42;&#0;&bogus;&'), 'a&b<>"\'\u00a0AB\ufffd&bogus;&');
  });

  it('닫히지 않은 따옴표·주석·긴 글자도 끝까지 한 번만 훑는다(백트래킹 없음)', async () => {
    const t0 = Date.now();
    const big = `<table><tr><td>${'x'.repeat(200_000)}</td><td a="${'<'.repeat(100_000)}`;
    const out = await readSheetBytes(new TextEncoder().encode(big));
    assert.equal(out.flags.truncated, true);
    assert.equal((out.sheets[0]!.rows[0]![0] as string).length, 4000);
    assert.equal(await code(readSheetBytes(new TextEncoder().encode(`<table><!-- ${'-'.repeat(300_000)}`))), 'sheet_invalid');
    assert.ok(Date.now() - t0 < 2000);
  });
});
