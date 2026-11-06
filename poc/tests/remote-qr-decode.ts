// 시험 전용: main이 만든 QR SVG data URL(remote-qr.ts)을 칸 그림으로 다시 그려 jsQR(개발용, apps/desktop devDependencies)로 읽는다.
import { createRequire } from 'node:module';
import { QR_DATA_URL_PREFIX } from '../apps/desktop/src/remote-qr.ts';

type JsQr = (data: Uint8ClampedArray, w: number, h: number) => { data: string } | null;
const jsQR = createRequire(new URL('../apps/desktop/package.json', import.meta.url))('jsqr') as JsQr;

/** SVG 문자열 → RGBA(흰 바탕, path의 칸 사각형만 검게). */
export function svgPixels(svg: string): { data: Uint8ClampedArray; size: number } {
  const vb = /viewBox="0 0 (\d+) (\d+)"/.exec(svg);
  if (!vb || vb[1] !== vb[2]) throw new Error('viewBox');
  const size = Number(vb[1]);
  const data = new Uint8ClampedArray(size * size * 4).fill(255);
  for (const m of svg.matchAll(/M(\d+),(\d+)l(\d+),0 0,(\d+) -\d+,0 0,-\d+z/g)) {
    const [x, y, w, h] = m.slice(1).map(Number) as [number, number, number, number];
    for (let yy = y; yy < y + h; yy++)
      for (let xx = x; xx < x + w; xx++) {
        const i = (yy * size + xx) * 4;
        data[i] = data[i + 1] = data[i + 2] = 0;
      }
  }
  return { data, size };
}

export const svgOf = (dataUrl: string): string => {
  if (!dataUrl.startsWith(QR_DATA_URL_PREFIX)) throw new Error('prefix');
  return Buffer.from(dataUrl.slice(QR_DATA_URL_PREFIX.length), 'base64').toString('utf8');
};

/** data URL → QR 원문(못 읽으면 null). */
export function decodeQrDataUrl(dataUrl: string): string | null {
  const { data, size } = svgPixels(svgOf(dataUrl));
  return jsQR(data, size, size)?.data ?? null;
}
