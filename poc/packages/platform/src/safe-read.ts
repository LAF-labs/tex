// 남이 쓸 수 있는 폴더(스테이징·내려받기)의 일반 파일 하나를 한 번 읽는다. 경로를 두 번 따라가지 않는다.
// lstat으로 본 파일과 실제로 연 파일이 같은지(dev·ino, bigint) 연 핸들로 확인하고, 그 핸들에서 상한까지만 읽는다.
// - 경로로 lstat한 뒤 경로로 readFile하면 그 사이 바꿔치기(링크·rename)로 확인하지 않은 다른 파일을 상한 없이 읽는다.
// - Windows의 ino는 64비트 NTFS 파일 ID라 Number로 비교하면 2^53 위에서 다른 파일이 같아 보인다(#199). 그래서 bigint로 본다.
// - Windows에는 O_NOFOLLOW가 없다. 링크를 따라 열었더라도 lstat(링크 자체)과 연 파일의 ID가 달라 changed가 된다.
// - 파일 ID 0(ID를 주지 않는 파일 시스템)은 같은 파일인지 알 수 없으므로 changed로 버린다.
import { constants as fsc, type BigIntStats } from 'node:fs';
import fs, { type FileHandle } from 'node:fs/promises';

export type SafeReadFail = 'missing' | 'not_file' | 'linked' | 'changed' | 'empty' | 'too_large' | 'unreadable';
export type SafeReadResult = { ok: true; bytes: Uint8Array } | { ok: false; reason: SafeReadFail };

/** 시험에서 열기 경쟁을 흉내 내려고 주입한다. 기본은 node:fs/promises. */
export interface SafeReadFs {
  lstat(p: string): Promise<BigIntStats>;
  open(p: string, flags: number): Promise<FileHandle>;
}

export const nodeSafeReadFs: SafeReadFs = {
  lstat: (p) => fs.lstat(p, { bigint: true }),
  open: (p, flags) => fs.open(p, flags),
};

const NOFOLLOW = fsc.O_NOFOLLOW ?? 0;

/**
 * 링크·특수 파일·하드링크(nlink>1)·열거 뒤 바꿔치기·0바이트·상한 초과는 읽지 않는다.
 * 상한 초과는 읽는 동안 커진 경우도 잡는다(상한+1바이트까지만 읽는다).
 */
export async function readRegularFile(file: string, maxBytes: number, o: { fs?: SafeReadFs } = {}): Promise<SafeReadResult> {
  const sfs = o.fs ?? nodeSafeReadFs;
  const fail = (reason: SafeReadFail): SafeReadResult => ({ ok: false, reason });
  let before: BigIntStats;
  try {
    before = await sfs.lstat(file);
  } catch (e) {
    return fail((e as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'unreadable');
  }
  if (!before.isFile()) return fail('not_file');
  if (before.nlink > 1n) return fail('linked');
  if (before.size === 0n) return fail('empty');
  if (before.size > BigInt(maxBytes)) return fail('too_large');
  let fh: FileHandle;
  try {
    fh = await sfs.open(file, fsc.O_RDONLY | NOFOLLOW);
  } catch (e) {
    return fail((e as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'unreadable');
  }
  try {
    const st = await fh.stat({ bigint: true });
    if (!st.isFile() || st.ino === 0n || st.dev !== before.dev || st.ino !== before.ino) return fail('changed');
    if (st.nlink > 1n) return fail('linked');
    if (st.size > BigInt(maxBytes)) return fail('too_large');
    // 연 파일 크기+1바이트까지만 읽는다. 그보다 많이 나오면 읽는 동안 커진 것이다.
    const size = Number(st.size);
    const buf = Buffer.alloc(size + 1);
    let n = 0;
    while (n < buf.length) {
      const { bytesRead } = await fh.read(buf, n, buf.length - n, n);
      if (bytesRead === 0) break;
      n += bytesRead;
    }
    if (n > size) return fail(n > maxBytes ? 'too_large' : 'changed');
    if (n === 0) return fail('empty');
    return { ok: true, bytes: new Uint8Array(buf.buffer, buf.byteOffset, n) };
  } catch {
    return fail('unreadable');
  } finally {
    await fh.close().catch(() => {});
  }
}
