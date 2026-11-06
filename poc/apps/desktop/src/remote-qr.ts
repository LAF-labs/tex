// 폰 연결 QR(S-03): main에서 qrcode-generator 1.4.4(MIT, 정확한 버전 고정)로 SVG를 만들고, 창에는 data URL 이미지로만 넘긴다(팀장 결정 2026-11-06).
// 창은 <img src>로만 쓴다(HTML·SVG 문자열 삽입 없음). SVG 안에는 칸(path)만 있고 QR 원문은 글자로 들어가지 않는다.
import qrcode from 'qrcode-generator';

export const QR_DATA_URL_PREFIX = 'data:image/svg+xml;base64,';
/** 칸 하나의 SVG 단위·여백(칸 수). 여백 4칸은 QR 규격의 조용한 영역. */
const CELL = 4;
const QUIET = 4;

/** QR 글자 → SVG data URL. 오류 정정 M, 바이트 모드. 페어링 QR은 ASCII(base64url)라 Latin-1 밖의 글자는 받지 않는다. */
export function qrSvgDataUrl(text: string): string {
  if (!text || /[^\x20-\x7e]/.test(text)) throw new Error('pair.qr_text');
  const q = qrcode(0, 'M');
  q.addData(text, 'Byte');
  q.make();
  const svg = q.createSvgTag({ cellSize: CELL, margin: CELL * QUIET, scalable: true });
  return QR_DATA_URL_PREFIX + Buffer.from(svg, 'utf8').toString('base64');
}
