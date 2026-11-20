import { RedactionError } from './tree.ts';

export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
  reason: 'entity' | 'img' | 'ocr';
}

declare const REDACTED_IMAGE: unique symbol;
/** 마스킹을 거친 이미지 조각. Phase 1에는 만들 길이 없다. */
export type RedactedImagePart = { readonly png: Uint8Array; readonly boxes: number } & { readonly [REDACTED_IMAGE]: 'RedactedImage' };

/** Phase 1 차단 스위치(게이트웨이 GW_ALLOW_IMAGES=false와 같은 뜻). 바꾸려면 ADR이 필요하다. */
export const PHASE1_IMAGES_DISABLED = true;

export function applyImage(_png: Uint8Array, _boxes: Box[]): Promise<RedactedImagePart> {
  if (PHASE1_IMAGES_DISABLED) return Promise.reject(new RedactionError('image_disabled_phase1'));
  return Promise.reject(new RedactionError('image_invalid'));
}

/**
 * RGBA 버퍼의 박스 영역을 불투명 검정으로 덮는다(제자리). 박스는 이미지 경계로 자르고, 정수가 아닌 좌표는 바깥쪽으로 넓힌다
 * (덜 덮는 쪽으로 반올림하지 않는다). 덮은 픽셀 수를 돌려준다.
 */
export function maskRgba(rgba: Uint8Array, width: number, height: number, boxes: readonly Box[]): number {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0 || rgba.length !== width * height * 4) throw new RedactionError('image_invalid');
  let covered = 0;
  for (const b of boxes) {
    if (![b.x, b.y, b.width, b.height].every(Number.isFinite) || b.width < 0 || b.height < 0) throw new RedactionError('image_invalid');
    const x0 = Math.max(0, Math.floor(b.x));
    const y0 = Math.max(0, Math.floor(b.y));
    const x1 = Math.min(width, Math.ceil(b.x + b.width));
    const y1 = Math.min(height, Math.ceil(b.y + b.height));
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const i = (y * width + x) * 4;
        if (rgba[i] !== 0 || rgba[i + 1] !== 0 || rgba[i + 2] !== 0 || rgba[i + 3] !== 255) covered++;
        rgba[i] = 0;
        rgba[i + 1] = 0;
        rgba[i + 2] = 0;
        rgba[i + 3] = 255;
      }
    }
  }
  return covered;
}
