// OCR 전처리(순수 함수, RGBA 버퍼를 제자리에서 고친다). 서식의 음영 칸·표 선이 tesseract를 크게 흔들어서
// 흑백으로 바꾸고(붉은 직인은 지운다), 글자일 수 없는 긴 가로·세로 선을 지운다. 샌드박스 페이지와 Node 테스트가 같이 쓴다.

/** 회색 음영(서식의 어두운 난)은 흰색으로, 글자는 검은색으로. */
const THRESHOLD = 170;

export function cleanForOcr(rgba, width, height) {
  const dark = new Uint8Array(width * height);
  for (let i = 0, p = 0; i < dark.length; i++, p += 4) {
    const r = rgba[p];
    const g = rgba[p + 1];
    const b = rgba[p + 2];
    const y = 0.299 * r + 0.587 * g + 0.114 * b;
    // 붉은 직인은 글자가 아니다. 직인 아래 검은 글자는 붉지 않아서 남는다.
    const red = r > 120 && r - g > 60 && r - b > 60;
    dark[i] = rgba[p + 3] > 0 && y < THRESHOLD && !red ? 1 : 0;
  }
  // 글자 한 자는 300dpi에서 50px 안팎이다. 그보다 훨씬 긴 연속 선은 표 선으로 보고 지운다.
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
