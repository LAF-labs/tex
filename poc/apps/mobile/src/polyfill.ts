// @sax/remote가 기대하는 웹 표준 전역을 Hermes에 맞춘다. 다른 모듈보다 먼저 import한다(index.ts 첫 줄).
import { getRandomValues } from 'expo-crypto';

type G = { crypto?: { getRandomValues?: unknown }; TextDecoder?: unknown };
const g = globalThis as unknown as G;

if (typeof g.crypto?.getRandomValues !== 'function') {
  g.crypto = { ...(g.crypto ?? {}), getRandomValues };
}

/** fatal 모드만 지원하는 UTF-8 디코더(잘못된 바이트는 던진다). Hermes에 TextDecoder가 없을 때만 쓴다. */
class StrictUtf8Decoder {
  decode(input?: ArrayBufferView | ArrayBuffer): string {
    if (!input) return '';
    const b = input instanceof ArrayBuffer ? new Uint8Array(input) : new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
    let out = '';
    for (let i = 0; i < b.length; ) {
      const c = b[i]!;
      let cp: number;
      let n: number;
      if (c < 0x80) {
        cp = c;
        n = 0;
      } else if (c >= 0xc2 && c <= 0xdf) {
        cp = c & 0x1f;
        n = 1;
      } else if (c >= 0xe0 && c <= 0xef) {
        cp = c & 0x0f;
        n = 2;
      } else if (c >= 0xf0 && c <= 0xf4) {
        cp = c & 0x07;
        n = 3;
      } else throw new TypeError('invalid utf-8');
      for (let k = 1; k <= n; k++) {
        const x = b[i + k];
        if (x === undefined || (x & 0xc0) !== 0x80) throw new TypeError('invalid utf-8');
        cp = (cp << 6) | (x & 0x3f);
      }
      if ((n === 2 && (cp < 0x800 || (cp >= 0xd800 && cp <= 0xdfff))) || (n === 3 && (cp < 0x10000 || cp > 0x10ffff))) throw new TypeError('invalid utf-8');
      out += String.fromCodePoint(cp);
      i += n + 1;
    }
    return out;
  }
}

if (typeof g.TextDecoder !== 'function') g.TextDecoder = StrictUtf8Decoder;
