#!/usr/bin/env node
// 스크롤 밀림 재기: 녹화(영상 또는 프레임 PNG 폴더)를 프레임으로 잘라, 사건(새 말, 키보드) 앞 프레임과 비교해
// 대화 내용이 "가장 많이 밀린 거리(px)"를 재고 프레임을 한 장(sheet.png)에 늘어놓는다. 멈춘 뒤 사진 한 장으로는 지나가는 튐이 안 보여서 만들었다.
// 의존성은 ffmpeg 하나(brew install ffmpeg). 같은 파일이 taxoff-mobile scripts/scroll-shift.mjs에도 있다(폰 갤러리·시뮬레이터 녹화용).
//
// 쓰기:
//   node scroll-shift.mjs --video rec.mov --crop 0,120,1179,1900 --scale 3 --event 0.5 --out out/kb
//   node scroll-shift.mjs --frames out/frames --fps 60 --crop 300,60,900,700 --scale 2 --out out/new-reply
// --crop x,y,w,h   잴 곳(원본 픽셀). 대화 목록만 잡는다(머리 바·입력 줄 빼고).
// --scale n        원본 픽셀 / 화면 점(px). 결과는 화면 점으로 낸다(레티나 2, 아이폰 3).
// --event s|#n     사건 직전 시각(초) 또는 프레임 번호(#12). 그 프레임이 기준이다. 기본 0.
// --until s       이 시각(초)까지만 잰다(뒤에 단추 누르기처럼 일부러 내리는 장면이 이어질 때)
// --marker x,y     사건 순간 녹화 도구가 빨갛게 바꾸는 점(원본 픽셀, 잰 곳 밖). 주면 --event 대신 그 점이 빨개지기 바로 앞 프레임이 기준이다(쪽 시계와 녹화 시계가 어긋나도 맞는다)
// --span s         기준 프레임부터 몇 초를 잴지(--marker와 같이 쓴다, 기본 1)
// --label 이름      sheet와 JSON에 적을 이름
// 결과: <out>/shift.json { maxShiftPx, lost, perFrame[] }, <out>/sheet.png(프레임 + 밀린 거리 막대와 숫자)
//
// 재는 법: 각 프레임의 줄별 평균 밝기(행 윤곽)를 기준 프레임 윤곽과 위아래로 밀어 맞춰 가장 잘 맞는 거리를 고른다(글자 줄 무늬가 지문 역할).
// 겹치는 부분이 20% 아래로 줄면(화면 하나 넘게 튐) 바로 앞 프레임과의 거리를 더해 이어 잰다. 그래도 못 맞추면 lost로 적는다(화면 대부분이 바뀔 만큼 튐, 거리는 지어내지 않는다).
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const argv = process.argv.slice(2);
const opt = (k, d) => {
  const i = argv.indexOf(`--${k}`);
  return i >= 0 ? argv[i + 1] : d;
};
const video = opt('video');
const framesDir = opt('frames');
const fps = Number(opt('fps', video ? 30 : 60));
const scale = Number(opt('scale', 1));
const out = path.resolve(opt('out', 'scroll-shift-out'));
const label = opt('label', path.basename(out));
if (!video && !framesDir) {
  console.error('--video 또는 --frames가 필요해요');
  process.exit(2);
}
fs.mkdirSync(out, { recursive: true });

const input = video ? ['-i', video] : ['-framerate', String(fps), '-pattern_type', 'glob', '-i', path.join(framesDir, '*.png')];
const probe = spawnSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height,r_frame_rate', '-of', 'json', video ?? fs.readdirSync(framesDir).filter((f) => f.endsWith('.png')).sort().map((f) => path.join(framesDir, f))[0]], { encoding: 'utf8' });
const st = JSON.parse(probe.stdout).streams[0];
const [cx, cy, cw0, ch0] = (opt('crop') ?? `0,0,${st.width},${st.height}`).split(',').map(Number);
// 영상은 짝수 폭으로 저장될 수 있다(393 → 392). 잰 곳을 영상 안으로 줄이지 않으면 줄이 비껴 읽힌다.
const cw = Math.min(cw0, st.width - cx);
const ch = Math.min(ch0, st.height - cy);
// 영상은 고정 프레임으로 다시 뽑는다(시뮬레이터·화면 녹화는 멈춘 화면을 건너뛰는 가변 프레임이라 시각과 번호가 어긋난다)
const rate = video ? Number(opt('fps', 30)) : fps;
const resample = video ? `fps=${rate},` : '';

// 분석용: 잰 곳만 회색 원본 크기
const gray = spawnSync('ffmpeg', ['-v', 'error', ...input, '-vf', `${resample}crop=${cw}:${ch}:${cx}:${cy},format=gray`, '-f', 'rawvideo', '-'], { maxBuffer: 2 ** 31 });
if (gray.status !== 0) throw new Error(gray.stderr.toString());
const until = opt('until');
let n = Math.min(Math.floor(gray.stdout.length / (cw * ch)), until ? Math.round(Number(until) * rate) + 1 : Infinity);
const B = 32; // 줄마다 가로를 32칸으로 나눈 밝기(왼쪽 말풍선, 오른쪽 말풍선, 글자 길이가 지문이 된다)
const profile = (f) => {
  const p = new Float32Array(ch * B);
  const base = f * cw * ch;
  for (let y = 0; y < ch; y++) {
    const r = base + y * cw;
    for (let b = 0; b < B; b++) {
      const x0 = Math.floor((b * cw) / B);
      const x1 = Math.floor(((b + 1) * cw) / B);
      let s = 0;
      for (let x = x0; x < x1; x++) s += gray.stdout[r + x];
      p[y * B + b] = s / (x1 - x0);
    }
  }
  return p;
};
const profs = Array.from({ length: n }, (_, i) => profile(i));

/** a를 기준으로 b의 내용이 위로 d만큼 올라갔다 = b[y] ≈ a[y + d]. 차이 큰 줄 15%는 뺀다(새 단추, 점 셋 같은 국소 변화). 겹침이 20% 아래면 보지 않는다. */
function match(a, b, maxD = Math.floor(ch * 0.8)) {
  let best = { d: 0, err: Infinity };
  const diffs = new Float32Array(ch);
  for (let d = -maxD; d <= maxD; d++) {
    let k = 0;
    for (let y = Math.max(0, -d); y < Math.min(ch, ch - d); y++) {
      let s = 0;
      const o = y * B;
      const q = (y + d) * B;
      for (let c = 0; c < B; c++) s += Math.abs(b[o + c] - a[q + c]);
      diffs[k++] = s / B;
    }
    if (k < ch * 0.2) continue;
    const v = diffs.subarray(0, k).sort();
    const keep = Math.floor(k * 0.85);
    let s = 0;
    for (let i = 0; i < keep; i++) s += v[i];
    const err = s / keep;
    if (err < best.err - 1e-6 || (Math.abs(err - best.err) < 1e-6 && Math.abs(d) < Math.abs(best.d))) best = { d, err };
  }
  return best;
}

const ev = opt('event', '0');
let e0 = ev.startsWith('#') ? Number(ev.slice(1)) : Math.round(Number(ev) * rate);
const marker = opt('marker');
if (marker) {
  const [mx, my] = marker.split(',').map(Number);
  const m = spawnSync('ffmpeg', ['-v', 'error', ...input, '-vf', `${resample}crop=2:2:${mx}:${my},format=rgb24`, '-f', 'rawvideo', '-'], { maxBuffer: 2 ** 28 });
  const red = Array.from({ length: Math.floor(m.stdout.length / 12) }, (_, f) => m.stdout[f * 12] > 180 && m.stdout[f * 12 + 1] < 90 && m.stdout[f * 12 + 2] < 90);
  const at = red.indexOf(true);
  if (at < 1) throw new Error('표시 점이 빨개지는 프레임을 못 찾았어요(--marker 자리를 확인해 주세요)');
  e0 = at - 1;
  n = Math.min(n, e0 + Math.round(Number(opt('span', 1)) * rate) + 1);
}
// 맞았다고 볼 차이(회색 0~255 칸 평균). 순수 스크롤이면 0 근처, 틀린 자리는 1 넘게 나온다.
// 압축 영상(webm, mov)은 멈춘 화면끼리도 차이가 있어, 사건 앞 멈춘 프레임끼리의 차이(잡음) 네 배까지 봐준다(0.8~2).
// 잡음은 가운값으로 본다(사건 앞에 단추가 서서히 뜨는 프레임 하나가 잡음을 키우지 않게). 상한 2: 그보다 크면 틀린 자리도 맞았다고 본다.
const nz = Array.from({ length: Math.min(8, e0) }, (_, k) => match(profs[e0 - k - 1], profs[e0 - k], 0).err).sort((a, b) => a - b);
const noise = nz.length ? nz[Math.floor(nz.length / 2)] : 0;
const OK = Math.min(2, Math.max(0.8, noise * 4));
const per = [];
let chain = 0;
for (let i = 0; i < n; i++) {
  if (i <= e0) {
    per.push({ i, t: +(i / rate).toFixed(3), shift: 0, err: 0, how: 'before' });
    continue;
  }
  const m = match(profs[e0], profs[i]);
  const step = match(profs[i - 1], profs[i]);
  // 한 번 놓치면(화면 하나 넘게 튐) 앞 프레임 거리를 더해도 기준을 모르니, 기준 프레임과 다시 맞을 때까지 lost다
  chain = chain !== null && step.err < OK ? chain + step.d : null;
  if (m.err < OK) {
    chain = m.d;
    per.push({ i, t: +(i / rate).toFixed(3), shift: +(m.d / scale).toFixed(1), err: +m.err.toFixed(2), how: 'base' });
  } else if (chain !== null) per.push({ i, t: +(i / rate).toFixed(3), shift: +(chain / scale).toFixed(1), err: +step.err.toFixed(2), how: 'chain' });
  else per.push({ i, t: +(i / rate).toFixed(3), shift: null, err: +m.err.toFixed(2), how: 'lost' });
}
const lost = per.some((p) => p.how === 'lost');
// 못 맞춘 프레임(lost)은 거리를 지어내지 않는다: maxShiftPx는 null, lost true(화면 대부분이 바뀔 만큼 튀었다). 맞춘 프레임 중 가장 큰 값은 따로 둔다.
const seenMax = Math.round(Math.max(0, ...per.filter((p) => p.shift !== null).map((p) => Math.abs(p.shift))));
const maxAbs = lost ? null : seenMax;
const res = { label, frames: n, fps: rate, crop: [cx, cy, cw, ch], scale, eventFrame: e0, noise: +noise.toFixed(2), ok: +OK.toFixed(2), maxShiftPx: maxAbs, maxMatchedPx: seenMax, lost, perFrame: per };
fs.writeFileSync(path.join(out, 'shift.json'), JSON.stringify(res, null, 1));

// ---- 한 장에 늘어놓기: 사건 앞 1장 + 뒤 프레임을 고르게 최대 11장, 칸마다 밀린 거리 막대와 숫자 ----
const pick = [e0, ...Array.from({ length: 11 }, (_, k) => Math.min(n - 1, e0 + 1 + Math.round((k * (n - 2 - e0)) / 10)))].filter((v, i, a) => v >= 0 && a.indexOf(v) === i);
const TW = 220;
const TH = Math.round((ch * TW) / cw);
const sel = pick.map((p) => `eq(n\\,${p})`).join('+');
const rgb = spawnSync('ffmpeg', ['-v', 'error', ...input, '-vf', `${resample}crop=${cw}:${ch}:${cx}:${cy},select='${sel}',scale=${TW}:${TH},format=rgb24`, '-fps_mode', 'passthrough', '-f', 'rawvideo', '-'], { maxBuffer: 2 ** 30 });
const thumbs = Math.min(pick.length, Math.floor(rgb.stdout.length / (TW * TH * 3)));
const COLS = 6;
const PAD = 8;
const LAB = 22;
const rows = Math.ceil(thumbs / COLS);
const SW = COLS * (TW + PAD) + PAD;
const SH = rows * (TH + LAB + PAD) + PAD + LAB;
const sheet = Buffer.alloc(SW * SH * 3, 245);
const px = (x, y, c) => {
  if (x < 0 || y < 0 || x >= SW || y >= SH) return;
  const o = (y * SW + x) * 3;
  sheet[o] = c[0];
  sheet[o + 1] = c[1];
  sheet[o + 2] = c[2];
};
// 3x5 숫자 글꼴(0-9, '-', 'p', 'x', '#', '>', '?')
const G = { 0: '111101101101111', 1: '010110010010111', 2: '111001111100111', 3: '111001111001111', 4: '101101111001001', 5: '111100111001111', 6: '111100111101111', 7: '111001010010010', 8: '111101111101111', 9: '111101111001111', '-': '000000111000000', p: '111101111100100', x: '000101010101000', '#': '101111101111101', '>': '100010001010100', '?': '111001011000010', ' ': '000000000000000', '.': '000000000000010' };
const text = (s, x, y, c, k = 3) => {
  for (const ch2 of String(s)) {
    const g = G[ch2] ?? G['?'];
    for (let r = 0; r < 5; r++) for (let q = 0; q < 3; q++) if (g[r * 3 + q] === '1') for (let a = 0; a < k; a++) for (let b = 0; b < k; b++) px(x + q * k + a, y + r * k + b, c);
    x += 4 * k;
  }
};
text(lost ? '?px' : `${res.maxShiftPx}px`, PAD, 4, lost ? [200, 60, 40] : [20, 20, 20]);
for (let t = 0; t < thumbs; t++) {
  const col = t % COLS;
  const row = Math.floor(t / COLS);
  const ox = PAD + col * (TW + PAD);
  const oy = LAB + PAD + row * (TH + LAB + PAD);
  for (let y = 0; y < TH; y++) rgb.stdout.copy(sheet, ((oy + y) * SW + ox) * 3, (t * TW * TH + y * TW) * 3, (t * TW * TH + (y + 1) * TW) * 3);
  const f = per[pick[t]];
  const v = f.shift === null ? null : Math.abs(f.shift);
  const color = t === 0 ? [90, 90, 90] : v === null || v > 40 ? [200, 60, 40] : v > 4 ? [190, 140, 30] : [40, 140, 80];
  const barW = v === null ? TW : Math.min(TW, Math.round((v / Math.max(1, ch / scale)) * TW));
  for (let y = 0; y < 4; y++) for (let x = 0; x < Math.max(2, barW); x++) px(ox + x, oy + TH + 2 + y, color);
  text(`#${f.i} ${v === null ? '?' : f.shift}px`, ox, oy + TH + 8, color, 2);
}
const enc = spawnSync('ffmpeg', ['-v', 'error', '-y', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', `${SW}x${SH}`, '-i', '-', path.join(out, 'sheet.png')], { input: sheet });
if (enc.status !== 0) throw new Error(enc.stderr.toString());
console.log(JSON.stringify({ label, maxShiftPx: res.maxShiftPx, lost, frames: n, sheet: path.join(out, 'sheet.png') }));
