// 최소 ZIP 읽기(xlsx 전용). 중앙 디렉터리만 믿고, 이름을 고른 항목만 푼다(매크로·외부 연결 항목은 풀지도 않는다).
// 푸는 일은 플랫폼 DecompressionStream('deflate-raw')에 맡기고, 푸는 도중에 바이트를 세어 상한에서 끊는다(머리의 크기가 거짓이어도).
// ZIP64·암호·분할·deflate 밖 압축은 받지 않는다. 같은 이름이 두 번 나오면(파서마다 다른 항목을 읽게 하는 공격) 거부한다.
import { SandboxError, ZIP_LIMITS } from './limits.ts';

export interface ZipEntry {
  name: string;
  method: number;
  compressedSize: number;
  size: number;
  /** 로컬 머리 오프셋 */
  offset: number;
}

const u16 = (b: Uint8Array, o: number) => b[o]! | (b[o + 1]! << 8);
const u32 = (b: Uint8Array, o: number) => (b[o]! | (b[o + 1]! << 8) | (b[o + 2]! << 16) | (b[o + 3]! << 24)) >>> 0;

export function isZip(b: Uint8Array): boolean {
  return b.length >= 4 && b[0] === 0x50 && b[1] === 0x4b && b[2] === 0x03 && b[3] === 0x04;
}

export class ZipReader {
  readonly entries: ReadonlyMap<string, ZipEntry>;
  private readonly bytes: Uint8Array;
  private inflated = 0;

  constructor(bytes: Uint8Array) {
    this.bytes = bytes;
    this.entries = readCentralDirectory(bytes);
  }

  has(name: string): boolean {
    return this.entries.has(name);
  }

  names(): string[] {
    return [...this.entries.keys()];
  }

  /** 항목 하나를 푼다. 없으면 null. */
  async read(name: string): Promise<Uint8Array | null> {
    const e = this.entries.get(name);
    if (!e) return null;
    const b = this.bytes;
    if (e.offset + 30 > b.length || u32(b, e.offset) !== 0x04034b50) throw new SandboxError('zip_invalid');
    const start = e.offset + 30 + u16(b, e.offset + 26) + u16(b, e.offset + 28);
    const end = start + e.compressedSize;
    if (end > b.length) throw new SandboxError('zip_invalid');
    const data = b.subarray(start, end);
    const cap = Math.min(ZIP_LIMITS.maxEntryBytes, ZIP_LIMITS.maxTotalBytes - this.inflated);
    let out: Uint8Array;
    if (e.method === 0) {
      if (data.length > cap) throw new SandboxError('zip_bomb');
      out = data.slice();
    } else {
      // 머리에 적힌 크기 + 여유, 압축률 상한, 남은 총량 중 가장 작은 값에서 끊는다
      out = await inflateCapped(data, Math.min(cap, e.size + 1024 * 1024, e.compressedSize * ZIP_LIMITS.maxRatio + 64 * 1024));
    }
    this.inflated += out.length;
    return out;
  }

  async text(name: string): Promise<string | null> {
    const b = await this.read(name);
    if (!b) return null;
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(b);
    } catch {
      throw new SandboxError('xml_invalid');
    }
  }
}

function readCentralDirectory(b: Uint8Array): Map<string, ZipEntry> {
  if (!isZip(b)) throw new SandboxError('zip_invalid');
  // 끝 레코드: 끝에서 22 + 주석(최대 65535) 안을 거꾸로 찾는다
  let eocd = -1;
  for (let i = b.length - 22; i >= Math.max(0, b.length - 22 - 65535); i--) {
    if (u32(b, i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new SandboxError('zip_invalid');
  const disk = u16(b, eocd + 4);
  const count = u16(b, eocd + 10);
  const cdSize = u32(b, eocd + 12);
  const cdOff = u32(b, eocd + 16);
  if (count === 0xffff || cdSize === 0xffffffff || cdOff === 0xffffffff) throw new SandboxError('zip_unsupported'); // ZIP64
  if (disk !== 0) throw new SandboxError('zip_unsupported'); // 분할
  if (count > ZIP_LIMITS.maxEntries) throw new SandboxError('zip_bomb');
  if (cdOff + cdSize > eocd) throw new SandboxError('zip_invalid');
  const entries = new Map<string, ZipEntry>();
  let p = cdOff;
  let declared = 0;
  for (let k = 0; k < count; k++) {
    if (p + 46 > eocd || u32(b, p) !== 0x02014b50) throw new SandboxError('zip_invalid');
    const flags = u16(b, p + 8);
    const method = u16(b, p + 10);
    const compressedSize = u32(b, p + 20);
    const size = u32(b, p + 24);
    const nameLen = u16(b, p + 28);
    const extraLen = u16(b, p + 30);
    const commentLen = u16(b, p + 32);
    const offset = u32(b, p + 42);
    if (p + 46 + nameLen > eocd) throw new SandboxError('zip_invalid');
    const rawName = b.subarray(p + 46, p + 46 + nameLen);
    p += 46 + nameLen + extraLen + commentLen;
    if (flags & 0x1) throw new SandboxError('zip_unsupported'); // 암호
    if (compressedSize === 0xffffffff || size === 0xffffffff || offset === 0xffffffff) throw new SandboxError('zip_unsupported');
    let name: string;
    try {
      name = new TextDecoder('utf-8', { fatal: true }).decode(rawName);
    } catch {
      throw new SandboxError('zip_invalid');
    }
    // 이름 정규화: 역슬래시·앞 '/'·'..'은 받지 않는다(xlsx 항목 이름에는 없다)
    if (!name || name.includes('\\') || name.startsWith('/') || name.split('/').includes('..') || name.includes('\0')) throw new SandboxError('zip_invalid');
    if (entries.has(name)) throw new SandboxError('zip_invalid');
    if (method !== 0 && method !== 8) {
      // 다른 압축 방식 항목은 목록에만 두고 읽지 않는다(읽으려 하면 실패)
      entries.set(name, { name, method, compressedSize, size, offset });
      continue;
    }
    if (size > ZIP_LIMITS.maxEntryBytes) throw new SandboxError('zip_bomb');
    if (compressedSize > 0 && size / compressedSize > ZIP_LIMITS.maxRatio && size > 1024 * 1024) throw new SandboxError('zip_bomb');
    declared += size;
    entries.set(name, { name, method, compressedSize, size, offset });
  }
  if (declared > ZIP_LIMITS.maxTotalBytes * 4) throw new SandboxError('zip_bomb');
  return entries;
}

/** deflate-raw를 풀되 cap 바이트를 넘으면 바로 끊는다. */
async function inflateCapped(data: Uint8Array, cap: number): Promise<Uint8Array> {
  const ds = new DecompressionStream('deflate-raw');
  const writer = ds.writable.getWriter();
  const reader = ds.readable.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  const written = writer.write(data as Uint8Array<ArrayBuffer>).then(() => writer.close()).catch(() => {});
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > cap) {
        await reader.cancel().catch(() => {});
        throw new SandboxError('zip_bomb');
      }
      chunks.push(value);
    }
  } catch (e) {
    if (e instanceof SandboxError) throw e;
    throw new SandboxError('zip_invalid');
  } finally {
    await written;
  }
  const out = new Uint8Array(total);
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.length;
  }
  return out;
}
