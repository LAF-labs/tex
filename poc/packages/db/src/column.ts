import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';

const VERSION = 0x01;
const IV = 12;
const TAG = 16;

export class ColumnCipherError extends Error {
  readonly code = 'db.column_unreadable';
  constructor() {
    super('db.column_unreadable');
  }
}

/** DB 키(32바이트)에서 컬럼 키를 파생한다. info "SAX-db-column-v1". */
export function deriveColumnKey(dbKey: Uint8Array): Uint8Array {
  if (dbKey.length !== 32) throw new Error('db key must be 32 bytes');
  return new Uint8Array(hkdfSync('sha256', dbKey, new Uint8Array(0), 'SAX-db-column-v1', 32));
}

export class ColumnCipher {
  private readonly key: Buffer;
  constructor(key: Uint8Array) {
    if (key.length !== 32) throw new Error('column key must be 32 bytes');
    this.key = Buffer.from(key);
  }

  seal(plain: string, aad: string): Buffer {
    const iv = randomBytes(IV);
    const c = createCipheriv('aes-256-gcm', this.key, iv);
    c.setAAD(Buffer.from(aad, 'utf8'));
    const body = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
    return Buffer.concat([Buffer.from([VERSION]), iv, body, c.getAuthTag()]);
  }

  open(blob: Uint8Array, aad: string): string {
    const b = Buffer.from(blob);
    if (b.length < 1 + IV + TAG || b[0] !== VERSION) throw new ColumnCipherError();
    try {
      const d = createDecipheriv('aes-256-gcm', this.key, b.subarray(1, 1 + IV));
      d.setAAD(Buffer.from(aad, 'utf8'));
      d.setAuthTag(b.subarray(b.length - TAG));
      return Buffer.concat([d.update(b.subarray(1 + IV, b.length - TAG)), d.final()]).toString('utf8');
    } catch {
      throw new ColumnCipherError();
    }
  }

  dispose(): void {
    this.key.fill(0);
  }
}
