import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

export interface Store {
  get(key: string): Promise<Buffer | null>;
  put(key: string, bytes: Buffer): Promise<void>;
}

const KEY = /^(registry|packages|policy|releases)(\/[a-z0-9_.@-]+){1,2}$/;

export function checkKey(key: string): string {
  if (!KEY.test(key) || key.includes('..')) throw new Error('store_key');
  return key;
}

export class MemoryStore implements Store {
  readonly files = new Map<string, Buffer>();
  get(key: string): Promise<Buffer | null> {
    return Promise.resolve(this.files.get(checkKey(key)) ?? null);
  }
  put(key: string, bytes: Buffer): Promise<void> {
    this.files.set(checkKey(key), Buffer.from(bytes));
    return Promise.resolve();
  }
}

/** 디렉터리 저장소(쓰기는 임시 파일 → rename으로 원자적). CDN·미러는 이 디렉터리를 그대로 올린다. */
export class DirStore implements Store {
  private readonly root: string;
  constructor(root: string) {
    this.root = path.resolve(root);
  }
  async get(key: string): Promise<Buffer | null> {
    try {
      return await fs.readFile(path.join(this.root, checkKey(key)));
    } catch {
      return null;
    }
  }
  async put(key: string, bytes: Buffer): Promise<void> {
    const file = path.join(this.root, checkKey(key));
    await fs.mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp-${process.pid}-${randomUUID()}`;
    try {
      await fs.writeFile(tmp, bytes);
      await renameReplacing(tmp, file);
    } catch (e) {
      await fs.rm(tmp, { force: true });
      throw e;
    }
  }
}

async function renameReplacing(from: string, to: string): Promise<void> {
  for (let i = 0; ; i++) {
    try {
      return await fs.rename(from, to);
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (process.platform !== 'win32' || i >= 8 || !['EPERM', 'EBUSY', 'EACCES'].includes(code ?? '')) throw e;
      await new Promise((r) => setTimeout(r, 10 * 2 ** i));
    }
  }
}
