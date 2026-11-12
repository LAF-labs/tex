// OLE2 복합 문서(CFB v3·v4, [MS-CFB]) 읽기. .xls의 Workbook 스트림을 꺼내는 데만 쓴다.
// 맨 위 저장소의 자식 스트림만 본다(포함된 OLE 개체 MBD… 안의 Workbook은 읽지 않는다).
// 악성 파일 대비: 모든 섹터 번호는 파일 안이어야 하고, 체인 길이는 섹터 수를 넘지 못한다(순환 → sheet_invalid).
// 스트림 크기는 체인이 실제로 덮는 바이트를 넘지 못하므로 메모리는 파일 크기로 묶인다.
import { SandboxError } from './limits.ts';

const SIG = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];
const ENDOFCHAIN = 0xfffffffe;
const FREESECT = 0xffffffff;
const NOSTREAM = 0xffffffff;
const MAX_REGSECT = 0xfffffffa;
/** 디렉터리 항목 수 상한(정상 xls는 수십 개) */
const MAX_DIR_ENTRIES = 65536;

export const isCfb = (b: Uint8Array) => b.length >= 8 && SIG.every((v, i) => b[i] === v);

export interface CfbEntry {
  name: string;
  /** 1 저장소, 2 스트림 */
  type: 1 | 2;
  start: number;
  size: number;
}

export interface CfbFile {
  /** 맨 위 저장소의 자식(스트림·저장소) */
  top: CfbEntry[];
  /** 맨 위 스트림 이름(대소문자 무시)으로 바이트. 없으면 null */
  stream(name: string): Uint8Array | null;
}

const bad = (): never => {
  throw new SandboxError('sheet_invalid');
};

export function openCfb(bytes: Uint8Array): CfbFile {
  if (!isCfb(bytes) || bytes.length < 512) bad();
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const u16 = (o: number) => v.getUint16(o, true);
  const u32 = (o: number) => v.getUint32(o, true);
  const major = u16(26);
  if (u16(28) !== 0xfffe) bad();
  const shift = u16(30);
  if (!((major === 3 && shift === 9) || (major === 4 && shift === 12)) || u16(32) !== 6) bad();
  const secSize = 1 << shift;
  const perSec = secSize / 4;
  if (bytes.length <= secSize) bad();
  /** 파일에 있는 섹터 수(마지막 섹터는 잘려 있어도 받는다) */
  const numSectors = Math.ceil((bytes.length - secSize) / secSize);
  const numFat = u32(44);
  const firstDir = u32(48);
  const cutoff = u32(56);
  const firstMiniFat = u32(60);
  const numMiniFat = u32(64);
  const firstDifat = u32(68);
  const numDifat = u32(72);
  if (numFat === 0 || numFat > numSectors || numDifat > numSectors || numMiniFat > numSectors) bad();
  const secOff = (s: number) => {
    if (s >= numSectors) bad();
    return (s + 1) * secSize;
  };

  // FAT 섹터 목록: 머리 109개 + DIFAT 체인
  const fatSecs: number[] = [];
  for (let i = 0; i < 109 && fatSecs.length < numFat; i++) {
    const s = u32(76 + i * 4);
    if (s === FREESECT) break;
    fatSecs.push(s);
  }
  let d = firstDifat;
  for (let n = 0; fatSecs.length < numFat && d !== ENDOFCHAIN && d !== FREESECT; n++) {
    if (n >= numDifat || n > numSectors) bad();
    const o = secOff(d);
    if (o + secSize > bytes.length) bad();
    for (let i = 0; i < perSec - 1 && fatSecs.length < numFat; i++) {
      const s = u32(o + i * 4);
      if (s === FREESECT) continue;
      fatSecs.push(s);
    }
    d = u32(o + (perSec - 1) * 4);
  }
  if (fatSecs.length < numFat) bad();
  const fat = new Uint32Array(numFat * perSec);
  fatSecs.forEach((s, k) => {
    if (s > MAX_REGSECT) bad();
    const o = secOff(s);
    if (o + secSize > bytes.length) bad();
    for (let i = 0; i < perSec; i++) fat[k * perSec + i] = u32(o + i * 4);
  });

  /** 큰 섹터 체인 → 바이트(크기 size, 모르면 체인 전체) */
  const chain = (start: number, size: number | null): Uint8Array => {
    const secs: number[] = [];
    const seen = new Uint8Array(numSectors);
    for (let s = start; s !== ENDOFCHAIN; ) {
      if (s > MAX_REGSECT || s >= fat.length || s >= numSectors || seen[s]) bad(); // 순환·범위 밖
      seen[s] = 1;
      secs.push(s);
      if (size !== null && secs.length * secSize >= size) break;
      s = fat[s]!;
    }
    const total = size ?? secs.length * secSize;
    if (secs.length * secSize < total) bad();
    const out = new Uint8Array(total);
    for (let i = 0; i < secs.length; i++) {
      const o = secOff(secs[i]!);
      const len = Math.min(secSize, total - i * secSize);
      if (o + len > bytes.length) bad();
      out.set(bytes.subarray(o, o + len), i * secSize);
    }
    return out;
  };

  // 디렉터리
  const dir = chain(firstDir, null);
  const count = Math.min(dir.length / 128, MAX_DIR_ENTRIES);
  const dv = new DataView(dir.buffer, dir.byteOffset, dir.byteLength);
  interface Raw extends CfbEntry { left: number; right: number; child: number }
  const entry = (i: number): Raw => {
    const o = i * 128;
    const nameLen = Math.min(dv.getUint16(o + 64, true), 64);
    let name = '';
    for (let k = 0; k + 1 < nameLen - 1; k += 2) name += String.fromCharCode(dv.getUint16(o + k, true));
    const type = dir[o + 66]!;
    const lo = dv.getUint32(o + 120, true);
    const hi = major === 4 ? dv.getUint32(o + 124, true) : 0; // v3는 위 32비트가 쓰레기일 수 있다
    if (hi !== 0) throw new SandboxError('sheet_too_large');
    return { name, type: type as 1 | 2, start: dv.getUint32(o + 116, true), size: lo, left: dv.getUint32(o + 68, true), right: dv.getUint32(o + 72, true), child: dv.getUint32(o + 76, true) };
  };
  if (count < 1) bad();
  const root = entry(0);
  if (dir[66] !== 5) bad();

  // 맨 위 자식: 루트의 child에서 left·right 형제 나무를 돈다(방문 표시로 순환 차단)
  const top: CfbEntry[] = [];
  const seen = new Uint8Array(count);
  const stack = [root.child];
  while (stack.length) {
    const i = stack.pop()!;
    if (i === NOSTREAM) continue;
    if (i >= count || seen[i]) bad();
    seen[i] = 1;
    const e = entry(i);
    if (e.type === 1 || e.type === 2) top.push({ name: e.name, type: e.type, start: e.start, size: e.size });
    stack.push(e.left, e.right);
  }

  // 미니 스트림(cutoff보다 작은 스트림)
  let mini: { data: Uint8Array; fat: Uint32Array } | null = null;
  const miniStream = () => {
    if (mini) return mini;
    const data = root.start === ENDOFCHAIN || root.size === 0 ? new Uint8Array(0) : chain(root.start, root.size);
    const mf = firstMiniFat === ENDOFCHAIN || numMiniFat === 0 ? new Uint8Array(0) : chain(firstMiniFat, null);
    const mfv = new DataView(mf.buffer, mf.byteOffset, mf.byteLength);
    const table = new Uint32Array(mf.length / 4);
    for (let i = 0; i < table.length; i++) table[i] = mfv.getUint32(i * 4, true);
    mini = { data, fat: table };
    return mini;
  };
  const miniChain = (start: number, size: number): Uint8Array => {
    const m = miniStream();
    const n = Math.ceil(m.data.length / 64);
    const out = new Uint8Array(size);
    let got = 0;
    const seen = new Uint8Array(n);
    for (let s = start; got < size; ) {
      if (s === ENDOFCHAIN || s > MAX_REGSECT || s >= n || s >= m.fat.length || seen[s]) bad(); // 순환·범위 밖
      seen[s] = 1;
      const len = Math.min(64, size - got);
      if (s * 64 + len > m.data.length) bad();
      out.set(m.data.subarray(s * 64, s * 64 + len), got);
      got += len;
      s = m.fat[s]!;
    }
    return out;
  };

  return {
    top,
    stream(name: string) {
      const want = name.toLowerCase();
      const e = top.find((x) => x.type === 2 && x.name.toLowerCase() === want);
      if (!e) return null;
      if (e.size === 0) return new Uint8Array(0);
      if (e.size > bytes.length) bad(); // 파일보다 큰 스트림은 있을 수 없다
      return e.size < cutoff ? miniChain(e.start, e.size) : chain(e.start, e.size);
    },
  };
}
