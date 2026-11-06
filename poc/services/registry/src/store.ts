// 정적 호스팅 저장소. 레지스트리는 공개 산출물만 담는다(서명된 파일 그대로). 키(경로)는 고정 형식만 받는다.
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
    // 쓰기마다 다른 임시 파일(같은 키를 동시에 올려도 섞이지 않는다) → 원자적 rename
    const tmp = `${file}.tmp-${process.pid}-${randomUUID()}`;
    try {
      await fs.writeFile(tmp, bytes);
      await fs.rename(tmp, file);
    } catch (e) {
      await fs.rm(tmp, { force: true });
      throw e;
    }
  }
}
