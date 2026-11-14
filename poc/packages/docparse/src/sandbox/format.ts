// 바이트 머리로 형식을 고른다(확장자·MIME은 믿지 않는다). 그림은 디코드하기 전에 머리에서 크기를 읽어 폭탄을 거른다.
import { IMAGE_LIMITS, SandboxError } from './limits.ts';
import { isZip } from './zip.ts';

export type InputFormat = 'pdf' | 'jpeg' | 'png' | 'xlsx' | 'csv' | 'xls' | 'html';
/** 알아보지만 받지 않는 형식(사장님에게 다른 형식으로 저장해 달라고 안내한다) */
export type RejectedFormat = 'heic' | 'webp' | 'gif' | 'tiff' | 'bmp' | 'html' | 'zip_other' | 'unknown';

const starts = (b: Uint8Array, sig: number[], at = 0) => sig.every((v, i) => b[at + i] === v);
const ascii = (b: Uint8Array, from: number, to: number) => String.fromCharCode(...b.subarray(from, Math.min(to, b.length)));
/** 앞 limit 바이트 안에 ASCII 글자(소문자로 준다)가 대소문자 무시로 있는가 */
function hasAsciiCI(b: Uint8Array, needle: string, limit: number): boolean {
  const n = Math.min(b.length, limit) - needle.length;
  outer: for (let i = 0; i <= n; i++) {
    for (let k = 0; k < needle.length; k++) if ((b[i + k]! | 0x20) !== needle.charCodeAt(k)) continue outer;
    return true;
  }
  return false;
}

export function sniffFormat(b: Uint8Array): { format: InputFormat } | { rejected: RejectedFormat } {
  if (b.length === 0) return { rejected: 'unknown' };
  // PDF 머리는 앞 1KB 안 어디든 올 수 있다(pdf.js와 같은 관대함)
  if (ascii(b, 0, 1024).includes('%PDF-')) return { format: 'pdf' };
  if (starts(b, [0xff, 0xd8, 0xff])) return { format: 'jpeg' };
  if (starts(b, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return { format: 'png' };
  // OLE 복합 문서: .xls(BIFF8) 또는 암호 건 xlsx. 어느 쪽인지는 readXls가 스트림을 보고 정한다(암호 → password_required, xls 아님 → unsupported_format)
  if (starts(b, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])) return { format: 'xls' };
  if (isZip(b)) return ascii(b, 30, 30 + 64).startsWith('[Content_Types].xml') || ascii(b, 0, 4096).includes('xl/') ? { format: 'xlsx' } : { rejected: 'zip_other' };
  if (ascii(b, 4, 12) === 'ftypheic' || ascii(b, 4, 12) === 'ftypheix' || ascii(b, 4, 12) === 'ftypmif1') return { rejected: 'heic' };
  if (ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 12) === 'WEBP') return { rejected: 'webp' };
  if (ascii(b, 0, 4) === 'GIF8') return { rejected: 'gif' };
  if (starts(b, [0x49, 0x49, 0x2a, 0x00]) || starts(b, [0x4d, 0x4d, 0x00, 0x2a])) return { rejected: 'tiff' };
  if (ascii(b, 0, 2) === 'BM') return { rejected: 'bmp' };
  const head = ascii(b, 0, 512).replace(/^\uFEFF|^\xEF\xBB\xBF/, '').trimStart().toLowerCase();
  // 국내 사이트의 "엑셀 내려받기"가 확장자만 .xls인 HTML 표인 경우. 표가 없는 HTML은 받지 않는다
  if (head.startsWith('<')) return hasAsciiCI(b, '<table', 64 * 1024) ? { format: 'html' } : { rejected: 'html' };
  // 남은 것은 글자 파일이라면 CSV로 본다. NUL이 있으면 이진 파일이다.
  if (b.subarray(0, 4096).includes(0)) return { rejected: 'unknown' };
  return { format: 'csv' };
}

export interface ImageInfo {
  format: 'jpeg' | 'png';
  width: number;
  height: number;
  /** JPEG EXIF(APP1)가 있다. 폰 앱은 지워서 보낸다(M7-4). PC 파일은 남아 있을 수 있다 */
  exif: boolean;
  /** EXIF 방향(1~8). 없으면 1. 샌드박스는 createImageBitmap이 방향을 반영한다 */
  orientation: number;
}

/** 디코드 전 머리 읽기. 크기를 모르면 image_decode_failed, 상한을 넘으면 image_too_large. */
export function imageInfo(b: Uint8Array): ImageInfo {
  let info: ImageInfo;
  if (starts(b, [0x89, 0x50, 0x4e, 0x47])) {
    if (b.length < 24 || ascii(b, 12, 16) !== 'IHDR') throw new SandboxError('image_decode_failed');
    const w = ((b[16]! << 24) | (b[17]! << 16) | (b[18]! << 8) | b[19]!) >>> 0;
    const h = ((b[20]! << 24) | (b[21]! << 16) | (b[22]! << 8) | b[23]!) >>> 0;
    info = { format: 'png', width: w, height: h, exif: false, orientation: 1 };
  } else if (starts(b, [0xff, 0xd8])) {
    info = jpegInfo(b);
  } else throw new SandboxError('unsupported_format');
  if (info.width === 0 || info.height === 0) throw new SandboxError('image_decode_failed');
  if (info.width > IMAGE_LIMITS.maxSide || info.height > IMAGE_LIMITS.maxSide || info.width * info.height > IMAGE_LIMITS.maxPixels) throw new SandboxError('image_too_large');
  return info;
}

function jpegInfo(b: Uint8Array): ImageInfo {
  let p = 2;
  let exif = false;
  let orientation = 1;
  while (p + 4 <= b.length) {
    if (b[p] !== 0xff) throw new SandboxError('image_decode_failed');
    const marker = b[p + 1]!;
    if (marker === 0xff) {
      p++;
      continue;
    }
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
      p += 2;
      continue;
    }
    if (marker === 0xd9 || marker === 0xda) break; // 끝·스캔 시작 전에 SOF가 없으면 실패
    const len = (b[p + 2]! << 8) | b[p + 3]!;
    if (len < 2 || p + 2 + len > b.length) throw new SandboxError('image_decode_failed');
    if (marker === 0xe1 && ascii(b, p + 4, p + 10) === 'Exif\0\0') {
      exif = true;
      orientation = exifOrientation(b.subarray(p + 10, p + 2 + len));
    }
    // SOF0~SOF15(DHT C4·JPG C8·DAC CC 제외)
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      if (len < 7) throw new SandboxError('image_decode_failed');
      const h = (b[p + 5]! << 8) | b[p + 6]!;
      const w = (b[p + 7]! << 8) | b[p + 8]!;
      return { format: 'jpeg', width: w, height: h, exif, orientation };
    }
    p += 2 + len;
  }
  throw new SandboxError('image_decode_failed');
}

function exifOrientation(t: Uint8Array): number {
  if (t.length < 8) return 1;
  const le = t[0] === 0x49;
  const r16 = (o: number) => (le ? t[o]! | (t[o + 1]! << 8) : (t[o]! << 8) | t[o + 1]!);
  const r32 = (o: number) => (le ? (t[o]! | (t[o + 1]! << 8) | (t[o + 2]! << 16) | (t[o + 3]! << 24)) >>> 0 : ((t[o]! << 24) | (t[o + 1]! << 16) | (t[o + 2]! << 8) | t[o + 3]!) >>> 0);
  const ifd = r32(4);
  if (ifd + 2 > t.length) return 1;
  const n = r16(ifd);
  for (let i = 0; i < n && ifd + 2 + i * 12 + 12 <= t.length; i++) {
    const e = ifd + 2 + i * 12;
    if (r16(e) === 0x0112) {
      const v = r16(e + 8);
      return v >= 1 && v <= 8 ? v : 1;
    }
  }
  return 1;
}
