// 보안카드 사진 인식(대표 지시 2026-11-14 "보안카드는 OS 내장 텍스트 인식"). 금고 프로세스 안에서만 돈다.
// - macOS: Vision(VNRecognizeTextRequest)을 osascript JXA로 부른다. 시스템 osascript라 따로 묶거나 서명할 것이 없다.
// - 이미지는 금고 임시 폴더(0700)에 0600으로 쓰고, 인식이 끝나면 곧바로 지운다. 인식 결과(칸 값)는 이 프로세스 밖으로 나가지 않는다.
// - 칸 번호 옆 4자리를 짝짓는다. 애매한 칸(못 읽음·글자 혼동·짝 충돌·자리 수 다름·낮은 확신)만 칸 번호로 돌려주고, 그 칸만 사람에게 다시 묻는다.
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { SECURITY_CARD_ROWS } from '../protocol.ts';

/** Vision 관측 하나(정규화 좌표, 원점 왼쪽 아래). */
export interface OcrObservation {
  alts: Array<{ t: string; c: number }>;
  x: number;
  y: number;
  w: number;
  h: number;
}

/** 인식 결과. rows는 칸 번호 → 4자리. unsure는 다시 물을 칸 번호(오름차순). */
export interface CardScan {
  size: 30 | 35;
  rows: Map<number, string>;
  unsure: number[];
}

export type ScanError = 'ocr_unavailable' | 'ocr_failed' | 'not_a_card' | 'image_too_large';

/** 사진 상한(카메라 원본 HEIC·JPEG도 받는다). */
export const CARD_IMAGE_MAX_BYTES = 20 * 1024 * 1024;
const OCR_TIMEOUT_MS = 20_000;
/** 이보다 확신이 낮은 글자는 그 칸을 다시 묻는다(Vision accurate는 0.3·0.5·1.0 근처 값을 준다). */
const MIN_CONFIDENCE = 0.5;

const JXA = `ObjC.import('Foundation');
ObjC.import('Vision');
function run(argv) {
  const req = $.VNRecognizeTextRequest.alloc.init;
  req.recognitionLevel = 0;
  req.usesLanguageCorrection = false;
  req.recognitionLanguages = $(['ko-KR', 'en-US']);
  const h = $.VNImageRequestHandler.alloc.initWithURLOptions($.NSURL.fileURLWithPath(argv[0]), $({}));
  if (!h.performRequestsError($([req]), $())) return '{"error":"perform"}';
  const out = [];
  const rs = req.results;
  for (let i = 0; i < rs.count; i++) {
    const o = rs.objectAtIndex(i);
    const cs = o.topCandidates(2);
    const alts = [];
    for (let j = 0; j < cs.count; j++) alts.push({ t: cs.objectAtIndex(j).string.js, c: cs.objectAtIndex(j).confidence });
    const b = o.boundingBox;
    out.push({ alts, x: b.origin.x, y: b.origin.y, w: b.size.width, h: b.size.height });
  }
  return JSON.stringify({ obs: out });
}`;

/** 이미지 바이트를 인식한다. 바이트는 부른 쪽이 0으로 덮는다. */
export async function scanCardImage(bytes: Uint8Array, o: { platform?: NodeJS.Platform; tmpRoot?: string } = {}): Promise<CardScan | { error: ScanError }> {
  if ((o.platform ?? process.platform) !== 'darwin') return { error: 'ocr_unavailable' };
  if (bytes.length === 0 || bytes.length > CARD_IMAGE_MAX_BYTES) return { error: 'image_too_large' };
  const dir = await fs.mkdtemp(path.join(o.tmpRoot ?? os.tmpdir(), 'sax-card-'));
  const file = path.join(dir, `${randomUUID()}.img`);
  try {
    await fs.chmod(dir, 0o700);
    await fs.writeFile(file, bytes, { mode: 0o600 });
    const out = await new Promise<string | null>((resolve) => {
      const child = execFile('/usr/bin/osascript', ['-l', 'JavaScript', '-', file], { timeout: OCR_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => resolve(err ? null : String(stdout)));
      child.stdin?.end(JXA);
    });
    if (!out) return { error: 'ocr_failed' };
    let parsed: { obs?: OcrObservation[]; error?: string };
    try {
      parsed = JSON.parse(out) as typeof parsed;
    } catch {
      return { error: 'ocr_failed' };
    }
    if (!Array.isArray(parsed.obs)) return { error: 'ocr_failed' };
    return parseCard(parsed.obs) ?? { error: 'not_a_card' };
  } finally {
    // 임시 이미지는 결과와 상관없이 지운다(덮어쓴 뒤 지운다).
    await fs.writeFile(file, new Uint8Array(bytes.length)).catch(() => {});
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

interface Token {
  /** 숫자만(혼동 글자를 숫자로 바꾼 뒤). */
  d: string;
  /** 혼동 글자(O·l·I·S·B 등)를 바꿨다. */
  fuzzy: boolean;
  conf: number;
  /** 둘째 후보가 다른 숫자를 읽었다. */
  disputed: boolean;
  cx: number;
  cy: number;
  h: number;
}

const CONFUSABLE: Readonly<Record<string, string>> = { O: '0', o: '0', D: '0', Q: '0', I: '1', l: '1', '|': '1', i: '1', '!': '1', S: '5', s: '5', B: '8', Z: '2', z: '2', g: '9', q: '9', b: '6', G: '6', T: '7' };

/** 관측 글자를 숫자 덩어리로 자른다. 혼동 글자는 숫자 사이에 있을 때만 숫자로 본다. */
function tokens(o: OcrObservation): Token[] {
  const top = o.alts[0];
  if (!top) return [];
  const text = top.t.normalize('NFKC');
  const second = o.alts[1]?.t.normalize('NFKC');
  const out: Token[] = [];
  const re = /[0-9OoDQIl|i!SsBZzgqbGT]+/g;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    const raw = m[0];
    if (!/\d/.test(raw)) continue;
    let d = '';
    let fuzzy = false;
    for (const ch of raw) {
      if (/\d/.test(ch)) d += ch;
      else {
        d += CONFUSABLE[ch]!;
        fuzzy = true;
      }
    }
    const mid = (m.index + raw.length / 2) / Math.max(1, text.length);
    const disputed = second !== undefined && (o.alts[1]!.c >= top.c - 0.2) && second.replace(/\D/g, '') !== text.replace(/\D/g, '');
    out.push({ d, fuzzy, conf: top.c, disputed, cx: o.x + o.w * mid, cy: o.y + o.h / 2, h: o.h });
  }
  return out;
}

const isRow = (n: number): boolean => Number.isInteger(n) && n >= SECURITY_CARD_ROWS.min && n <= SECURITY_CARD_ROWS.max;

/**
 * Vision 관측에서 칸 번호(1~2자리, 1~35) 바로 오른쪽 같은 줄의 4자리를 짝짓는다. 칸 번호가 이렇게 10개 미만이면 카드가 아니다.
 * 칸 수는 31번 이상이 보이면 35, 아니면 30. 그 범위에서 못 찾은 칸·의심 칸은 unsure.
 */
export function parseCard(obs: OcrObservation[]): CardScan | null {
  const all = obs.flatMap(tokens).sort((a, b) => a.cy - b.cy);
  // 줄 묶기: 중심 높이 차이가 글자 높이의 절반 안이면 같은 줄
  const lines: Token[][] = [];
  for (const t of all) {
    const line = lines.find((l) => Math.abs(l[0]!.cy - t.cy) < Math.min(l[0]!.h, t.h) * 0.5);
    if (line) line.push(t);
    else lines.push([t]);
  }
  const seen = new Map<number, Array<{ v: string; doubt: boolean }>>();
  const add = (row: number, v: string, doubt: boolean) => seen.set(row, [...(seen.get(row) ?? []), { v, doubt }]);
  let indices = 0;
  for (const line of lines) {
    line.sort((a, b) => a.cx - b.cx);
    for (let i = 0; i < line.length; i++) {
      const k = line[i]!;
      // 칸 번호와 값이 붙어 읽힌 경우("017387"): 앞 2자리를 칸 번호로 보고 그 칸은 다시 묻는다
      if (k.d.length === 6 && isRow(Number(k.d.slice(0, 2)))) {
        indices++;
        add(Number(k.d.slice(0, 2)), k.d.slice(2), true);
        continue;
      }
      if (k.d.length > 2 || !isRow(Number(k.d))) continue;
      indices++;
      const v = line[i + 1];
      const row = Number(k.d);
      if (!v || v.d.length <= 2) {
        add(row, '', true);
        continue;
      }
      i++;
      const doubt = k.fuzzy || v.fuzzy || k.disputed || v.disputed || Math.min(k.conf, v.conf) < MIN_CONFIDENCE || v.d.length !== 4;
      add(row, v.d.length === 4 ? v.d : '', doubt);
    }
  }
  if (indices < 10) return null;
  const size: 30 | 35 = [...seen.keys()].some((r) => r > 30) ? 35 : 30;
  const rows = new Map<number, string>();
  const unsure: number[] = [];
  for (let r = 1; r <= size; r++) {
    const xs = seen.get(r) ?? [];
    const vals = new Set(xs.map((x) => x.v));
    const v = xs[0]?.v ?? '';
    if (xs.length === 0 || vals.size !== 1 || !/^\d{4}$/.test(v) || xs.some((x) => x.doubt)) unsure.push(r);
    else rows.set(r, v);
  }
  return { size, rows, unsure };
}

/** 사람이 다시 넣은 칸 값: 4자리 숫자만. */
export const isCardCell = (s: string): boolean => /^\d{4}$/.test(s);

/**
 * 홈택스 보안카드 창의 요청 글자("[7]번 보안카드번호 앞 2자리", 실화면 정적 UTXPPABA08)에서 칸 번호와 앞·뒤를 읽는다.
 * 대괄호 안 숫자가 정확히 하나(1~35)이고 "앞"·"뒤" 중 하나만 있을 때만. 자리 표시 "[00]"은 null(아직 번호가 안 정해졌다).
 */
export function parseCardAsk(text: unknown): { row: number; half: 'front' | 'back' } | null {
  if (typeof text !== 'string' || text.length > 80) return null;
  const t = text.normalize('NFKC').replace(/\s+/g, ' ');
  const nums = [...t.matchAll(/\[\s*(\d{1,2})\s*\]/g)];
  if (nums.length !== 1) return null;
  const row = Number(nums[0]![1]);
  if (!isRow(row)) return null;
  const front = /앞\s*2\s*자리/.test(t);
  const back = /뒤\s*2\s*자리/.test(t);
  if (front === back) return null;
  return { row, half: front ? 'front' : 'back' };
}
