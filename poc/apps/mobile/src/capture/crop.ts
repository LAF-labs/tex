// 촬영 안내 틀 → 사진 좌표 자르기 사각형. 미리보기는 사진을 cover로 채운다(가운데 맞춤). 순수 함수.

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** 안내 틀(미리보기 좌표)을 사진 좌표로. 사진 밖으로 나가지 않게 자른다. */
export function guideCrop(photo: { width: number; height: number }, view: { width: number; height: number }, guide: Rect): { originX: number; originY: number; width: number; height: number } {
  const scale = Math.max(view.width / photo.width, view.height / photo.height);
  const ox = (photo.width - view.width / scale) / 2;
  const oy = (photo.height - view.height / scale) / 2;
  const x = Math.max(0, Math.round(ox + guide.x / scale));
  const y = Math.max(0, Math.round(oy + guide.y / scale));
  const w = Math.min(photo.width - x, Math.round(guide.w / scale));
  const h = Math.min(photo.height - y, Math.round(guide.h / scale));
  return { originX: x, originY: y, width: Math.max(1, w), height: Math.max(1, h) };
}

/** 긴 변이 max를 넘으면 줄인다. */
export function fitEdge(w: number, h: number, max: number): { width: number; height: number } | null {
  const long = Math.max(w, h);
  if (long <= max) return null;
  const k = max / long;
  return { width: Math.round(w * k), height: Math.round(h * k) };
}

/** 안내 틀: 미리보기 가운데, 폭 88%, 영수증 비율(세로 1.6배), 높이는 미리보기의 80%를 넘지 않는다. */
export function guideRect(view: { width: number; height: number }): Rect {
  let w = view.width * 0.88;
  let h = w * 1.6;
  if (h > view.height * 0.8) {
    h = view.height * 0.8;
    w = h / 1.6;
  }
  return { x: (view.width - w) / 2, y: (view.height - h) / 2, w, h };
}
