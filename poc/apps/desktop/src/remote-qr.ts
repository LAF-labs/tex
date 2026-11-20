import qrcode from 'qrcode-generator';

export const QR_DATA_URL_PREFIX = 'data:image/svg+xml;base64,';
const CELL = 4;
const QUIET = 4;

export function qrSvgDataUrl(text: string): string {
  if (!text || /[^\x20-\x7e]/.test(text)) throw new Error('pair.qr_text');
  const q = qrcode(0, 'M');
  q.addData(text, 'Byte');
  q.make();
  const svg = q.createSvgTag({ cellSize: CELL, margin: CELL * QUIET, scalable: true });
  return QR_DATA_URL_PREFIX + Buffer.from(svg, 'utf8').toString('base64');
}
