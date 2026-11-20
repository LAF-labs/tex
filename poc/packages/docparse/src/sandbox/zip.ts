import { SandboxError, ZIP_LIMITS } from './limits.ts';

export interface ZipEntry {
  name: string;
  method: number;
  compressedSize: number;
  size: number;
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
  if (count === 0xffff || cdSize === 0xffffffff || cdOff === 0xffffffff) throw new SandboxError('zip_unsupported');
  if (disk !== 0) throw new SandboxError('zip_unsupported');
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
    if (flags & 0x1) throw new SandboxError('zip_unsupported');
    if (compressedSize === 0xffffffff || size === 0xffffffff || offset === 0xffffffff) throw new SandboxError('zip_unsupported');
    let name: string;
    try {
      name = new TextDecoder('utf-8', { fatal: true }).decode(rawName);
    } catch {
      throw new SandboxError('zip_invalid');
    }
    if (!name || name.includes('\\') || name.startsWith('/') || name.split('/').includes('..') || name.includes('\0')) throw new SandboxError('zip_invalid');
    if (entries.has(name)) throw new SandboxError('zip_invalid');
    if (method !== 0 && method !== 8) {
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
