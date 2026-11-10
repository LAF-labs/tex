// OCR 전처리(순수 함수, RGBA 버퍼를 제자리에서 고친다). 서식의 음영 칸·표 선이 tesseract를 크게 흔들어서
// 흑백으로 바꾸고(붉은 직인은 지운다), 글자일 수 없는 긴 가로·세로 선을 지운다. 샌드박스 페이지와 Node 테스트가 같이 쓴다.
// 사진(종이 증빙·폰 촬영)은 조명이 고르지 않아 고정 임계로는 그늘진 쪽이 검게 뭉친다: cleanPhotoForOcr는 주변 평균에 맞춘 국소 임계를 쓴다.

/** 회색 음영(서식의 어두운 난)은 흰색으로, 글자는 검은색으로. */
const THRESHOLD = 170;

/** 글자 한 자는 300dpi에서 50px 안팎이다. 그보다 훨씬 긴 연속 선(dark 마스크)은 표 선으로 본다. */
function longLineMask(dark: Uint8Array, width: number, height: number): Uint8Array {
  const minH = Math.max(80, Math.round(width * 0.04));
  const minV = Math.max(80, Math.round(height * 0.025));
  const erase = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    let run = 0;
    for (let x = 0; x <= width; x++) {
      if (x < width && dark[y * width + x]) run++;
      else {
        if (run >= minH) erase.fill(1, y * width + x - run, y * width + x);
        run = 0;
      }
    }
  }
  for (let x = 0; x < width; x++) {
    let run = 0;
    for (let y = 0; y <= height; y++) {
      if (y < height && dark[y * width + x]) run++;
      else {
        if (run >= minV) for (let k = y - run; k < y; k++) erase[k * width + x] = 1;
        run = 0;
      }
    }
  }
  return erase;
}

export function cleanForOcr(rgba: Uint8ClampedArray | Uint8Array, width: number, height: number): { removed: number } {
  const dark = new Uint8Array(width * height);
  for (let i = 0, p = 0; i < dark.length; i++, p += 4) {
    const r = rgba[p]!;
    const g = rgba[p + 1]!;
    const b = rgba[p + 2]!;
    const y = 0.299 * r + 0.587 * g + 0.114 * b;
    // 붉은 직인은 글자가 아니다. 직인 아래 검은 글자는 붉지 않아서 남는다.
    const red = r > 120 && r - g > 60 && r - b > 60;
    dark[i] = rgba[p + 3]! > 0 && y < THRESHOLD && !red ? 1 : 0;
  }
  const erase = longLineMask(dark, width, height);
  let removed = 0;
  for (let i = 0, p = 0; i < dark.length; i++, p += 4) {
    const ink = dark[i] && !erase[i];
    if (dark[i] && erase[i]) removed++;
    const v = ink ? 0 : 255;
    rgba[p] = v;
    rgba[p + 1] = v;
    rgba[p + 2] = v;
    rgba[p + 3] = 255;
  }
  return { removed };
}

/** 국소 임계 창(긴 변의 1/24, 최소 15px)과 민감도. 주변 평균보다 이만큼 어두우면 글자로 본다. */
const PHOTO_K = 0.12;

/**
 * 사진 전처리: 흑백 + 국소 평균 임계(Bradley). 영수증의 감열지 바랜 글씨·그늘을 살리고, 붉은 직인·도장은 지운다.
 * 표 선 지우기는 하지 않는다(영수증의 점선 구분선은 OCR이 '-'로 읽어 줄 구분에 쓴다).
 */
export function cleanPhotoForOcr(rgba: Uint8ClampedArray | Uint8Array, width: number, height: number): { dark: number } {
  const n = width * height;
  const lum = new Float64Array(n);
  const red = new Uint8Array(n);
  for (let i = 0, p = 0; i < n; i++, p += 4) {
    const r = rgba[p]!;
    const g = rgba[p + 1]!;
    const b = rgba[p + 2]!;
    lum[i] = rgba[p + 3]! === 0 ? 255 : 0.299 * r + 0.587 * g + 0.114 * b;
    red[i] = r > 120 && r - g > 60 && r - b > 60 ? 1 : 0;
  }
  // 적분 영상(행 우선, (width+1)×(height+1))
  const W = width + 1;
  const sum = new Float64Array(W * (height + 1));
  for (let y = 0; y < height; y++) {
    let row = 0;
    for (let x = 0; x < width; x++) {
      row += lum[y * width + x]!;
      sum[(y + 1) * W + x + 1] = sum[y * W + x + 1]! + row;
    }
  }
  const half = Math.max(7, Math.round(Math.max(width, height) / 48));
  let dark = 0;
  for (let y = 0; y < height; y++) {
    const y0 = Math.max(0, y - half);
    const y1 = Math.min(height, y + half + 1);
    for (let x = 0; x < width; x++) {
      const x0 = Math.max(0, x - half);
      const x1 = Math.min(width, x + half + 1);
      const area = (x1 - x0) * (y1 - y0);
      const s = sum[y1 * W + x1]! - sum[y0 * W + x1]! - sum[y1 * W + x0]! + sum[y0 * W + x0]!;
      const i = y * width + x;
      // 아주 밝은 칸(종이 바탕)은 평균과 상관없이 바탕이다. 평균보다 충분히 어두워야 글자다.
      const ink = !red[i] && lum[i]! < 235 && lum[i]! * area < s * (1 - PHOTO_K);
      const v = ink ? 0 : 255;
      if (ink) dark++;
      const p = i * 4;
      rgba[p] = v;
      rgba[p + 1] = v;
      rgba[p + 2] = v;
      rgba[p + 3] = 255;
    }
  }
  return { dark };
}

/** 이 몫을 넘으면 바탕이 어두운 촬영본으로 본다(고정 임계로는 바탕까지 검게 뭉친다). 합성 등록증: 흰 바탕 PNG·스캔 3% 안팎, 폰 촬영 70~87%. */
export const DOCUMENT_PHOTO_INK_SHARE = 0.25;
/** 흰 종이의 옅은 바탕무늬·음영(이보다 밝은 회색)은 흰색으로 */
const PAPER_WHITE = 200;

/**
 * 그림 증명서 모드 전처리(사업자등록증·민원증명 사진·캡처). 흑백으로 자르지 않고 회색 단계를 남긴다: tesseract LSTM은 회색 글자 가장자리를 쓴다.
 * - 흰 종이(고정 임계로 검게 될 몫이 DOCUMENT_PHOTO_INK_SHARE 이하): 붉은 직인·긴 표 선·옅은 바탕무늬는 흰색으로, 나머지는 밝기 그대로.
 * - 바탕이 어두운 촬영본: 회색조만(바탕이 고정 임계 아래라 선·무늬를 가를 수 없다).
 * 2026-11-10 설치본: 폰으로 찍은 사업자등록증 JPEG에서 고정 임계(cleanForOcr)가 그늘진 아래쪽을 통째로 검게 만들어 대표자·주소·업태·종목이 비었다.
 * 흰 바탕 합성 스캔에서도 흑백 자르기가 등록번호 "100"을 "190"으로 읽게 했다(회색조는 바르게 읽음). PDF 쪽 OCR은 그대로 cleanForOcr를 쓴다.
 */
export function cleanDocumentForOcr(rgba: Uint8ClampedArray | Uint8Array, width: number, height: number): { photo: boolean } {
  const n = width * height;
  const lum = new Uint8Array(n);
  const red = new Uint8Array(n);
  const dark = new Uint8Array(n);
  let darkCount = 0;
  for (let i = 0, p = 0; i < n; i++, p += 4) {
    const r = rgba[p]!;
    const g = rgba[p + 1]!;
    const b = rgba[p + 2]!;
    const y = rgba[p + 3]! === 0 ? 255 : Math.round(0.299 * r + 0.587 * g + 0.114 * b);
    lum[i] = y;
    red[i] = r > 120 && r - g > 60 && r - b > 60 ? 1 : 0;
    if (y < THRESHOLD && !red[i]) {
      dark[i] = 1;
      darkCount++;
    }
  }
  const photo = n > 0 && darkCount / n > DOCUMENT_PHOTO_INK_SHARE;
  const erase = photo ? null : longLineMask(dark, width, height);
  for (let i = 0, p = 0; i < n; i++, p += 4) {
    const v = photo ? lum[i]! : red[i] || erase![i] || lum[i]! >= PAPER_WHITE ? 255 : lum[i]!;
    rgba[p] = v;
    rgba[p + 1] = v;
    rgba[p + 2] = v;
    rgba[p + 3] = 255;
  }
  return { photo };
}

/**
 * OCR에 넘길 배율. 긴 변이 ocrMaxSide보다 크면 줄인다. 증명서 모드에서 작은 그림(메신저로 받은 1000px 안팎 JPEG)은 2배까지 키운다:
 * tesseract는 글자 높이 30px 안팎에서 잘 읽는다(합성 등록증 1000px JPEG: 키우지 않으면 '서울'→'서물' 같은 오인식).
 */
export function ocrScale(width: number, height: number, mode: 'document' | 'photo', maxSide: number): number {
  const long = Math.max(width, height, 1);
  if (mode === 'document' && long < OCR_UPSCALE_BELOW) return Math.min(2, maxSide / long);
  return Math.min(1, maxSide / long);
}
/** 긴 변이 이보다 작은 문서 그림은 키운다 */
export const OCR_UPSCALE_BELOW = 1800;
