// 폰 보관함(D14 M7-4): PC가 꺼져 있으면 사진·현금매출을 여기 두었다가 세션이 열리면 보낸다(@sax/remote flushOutbox).
// 항목 메타와 사진은 각각 fileKey로 봉인한 파일이다(sax/outbox/<msgId>.m, .p). 보호 등급·백업 제외는 files.ts가 맡는다.
import { Directory, File } from 'expo-file-system';
import { fromUtf8, openOutboxFile, sealOutboxFile, ULID_RE, utf8, type OutboxItem, type OutboxStore } from '@sax/remote';
import { inflight, liveKey } from '../inflight';
import { ROOT, writeProtected } from './files';

const DIR = new Directory(ROOT, 'outbox');
const META = (id: string) => new File(DIR, `${id}.m`);
const PHOTO = (id: string) => new File(DIR, `${id}.p`);

function check(id: string): string {
  if (!ULID_RE.test(id)) throw new Error('outbox: bad id');
  return id;
}

export class FileOutbox implements OutboxStore {
  #key: Uint8Array;
  constructor(fileKey: Uint8Array) {
    this.#key = fileKey;
  }

  async list(): Promise<OutboxItem[]> {
    if (!DIR.exists) return [];
    const out: OutboxItem[] = [];
    for (const f of DIR.list()) {
      if (!(f instanceof File) || !f.name.endsWith('.m')) continue;
      const id = f.name.slice(0, -2);
      if (!ULID_RE.test(id)) continue;
      try {
        out.push(JSON.parse(fromUtf8(openOutboxFile(this.#key, `${id}.m`, await f.bytes()))) as OutboxItem);
      } catch {
        // 봉인이 깨진 항목은 건너뛴다(내용을 로그에 남기지 않는다)
      }
    }
    return out;
  }

  async put(item: OutboxItem, photo?: Uint8Array): Promise<void> {
    const id = check(item.msgId);
    await inflight(async () => {
      if (photo) await writeProtected(PHOTO(id), sealOutboxFile(liveKey(this.#key), `${id}.p`, photo));
      await writeProtected(META(id), sealOutboxFile(liveKey(this.#key), `${id}.m`, utf8(JSON.stringify(item))));
    });
  }

  async readPhoto(msgId: string): Promise<Uint8Array> {
    const id = check(msgId);
    return openOutboxFile(this.#key, `${id}.p`, await PHOTO(id).bytes());
  }

  async remove(msgId: string): Promise<void> {
    const id = check(msgId);
    for (const f of [PHOTO(id), META(id)]) if (f.exists) f.delete();
  }

  async counts(): Promise<{ receipts: number; cash: number }> {
    const items = await this.list();
    return { receipts: items.filter((i) => i.kind === 'receipt').length, cash: items.filter((i) => i.kind === 'cash').length };
  }
}
