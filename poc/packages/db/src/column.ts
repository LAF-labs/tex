// DB 키 암호화 컬럼(D07 §2 `*_enc`, ADR-031 주민번호). DB 파일 자체가 sqlcipher로 암호화되어 있지만,
// 주민번호처럼 화면·내보내기에서도 가려야 하는 값은 컬럼 단위로 한 번 더 감싼다. 질의 결과·로그·덤프에 평문이 섞이지 않게 하려는 것이다.
// - 키: DB 키에서 HKDF로 파생(원장 HMAC 키와 같은 방식, 다른 info). 엔진이 DB 키를 지우기 전에 한 번 파생한다.
// - 형식: 0x01 ‖ iv(12) ‖ 암호문 ‖ tag(16), AES-256-GCM. AAD = "<table>.<column>:<rowId>" 라 행끼리 맞바꾸면 열리지 않는다.
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

  /** 키를 지운다(엔진 종료 시). */
  dispose(): void {
    this.key.fill(0);
  }
}
