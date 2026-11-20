
export interface TextItem {
  str: string;
  transform: number[];
  width?: number;
  height?: number;
}

export interface TextLayerAssessment {
  ok: boolean;
  reason: 'too_little_text' | 'garbled' | 'unusual_chars' | null;
  chars: number;
  good: number;
  bad: number;
}

/**
 * pdf.js getTextContent 항목 → 줄 목록. 같은 y(글자 크기 절반까지 허용)끼리 묶고 x 순으로 잇는다.
 * 표 형식 서류는 hasEOL만으로 줄이 맞지 않아서, 위치로 다시 묶는다. 항목 사이가 글자 크기의 1/4보다 벌어지면 공백을 넣는다.
 */
export function itemsToLines(items: ReadonlyArray<unknown>): string[] {
  interface Run { str: string; x: number; y: number; end: number; size: number }
  const runs: Run[] = [];
  for (const raw of items) {
    const it = raw as Partial<TextItem> | null;
    if (!it || typeof it.str !== 'string' || !Array.isArray(it.transform) || it.str === '') continue;
    const [a = 0, b = 0, c = 0, d = 0, x = 0, y = 0] = it.transform;
    const size = Math.hypot(c, d) || Math.hypot(a, b) || it.height || 1;
    runs.push({ str: it.str, x, y, end: x + (it.width || 0), size });
  }
  runs.sort((p, q) => q.y - p.y || p.x - q.x);
  const lines: Array<{ y: number; size: number; runs: Run[] }> = [];
  let cur: { y: number; size: number; runs: Run[] } | null = null;
  for (const r of runs) {
    if (cur && Math.abs(cur.y - r.y) <= Math.max(1, Math.min(cur.size, r.size) * 0.5)) cur.runs.push(r);
    else {
      cur = { y: r.y, size: r.size, runs: [r] };
      lines.push(cur);
    }
  }
  return lines.map((l) => {
    l.runs.sort((p, q) => p.x - q.x);
    let out = '';
    let prev: Run | null = null;
    for (const r of l.runs) {
      if (prev && r.x - prev.end > Math.min(prev.size, r.size) * 0.25 && !out.endsWith(' ') && !r.str.startsWith(' ')) out += ' ';
      out += r.str;
      prev = r;
    }
    return out;
  });
}

/** 제어 문자를 공백으로, 폭 없는 문자는 지우고, 공백류를 하나로, 줄 앞뒤 공백 제거, NFC. 빈 줄은 뺀다. */
export function tidyText(text: string): string {
  return text
    .normalize('NFC')
    // eslint-disable-next-line no-control-regex -- 텍스트 층의 제어 문자를 지우는 것이 목적이다
    .replace(/[\u0000-\u0008\u000B-\u001F\u007F]/g, ' ')
    .split('\n')
    .map((l) => l.replace(/[\u200B-\u200D\u2060\uFEFF]/g, '').replace(/[ \t\u00A0\u2000-\u200A\u3000]+/g, ' ').trim())
    .filter(Boolean)
    .join('\n');
}

const isGood = (c: number): boolean =>
  (c >= 0xac00 && c <= 0xd7a3) ||
  (c >= 0x3131 && c <= 0x318e) ||
  (c >= 0x21 && c <= 0x7e) ||
  (c >= 0x2010 && c <= 0x206f) ||
  (c >= 0x2460 && c <= 0x24ff) ||
  (c >= 0x25a0 && c <= 0x25ff) ||
  (c >= 0x3000 && c <= 0x303f) ||
  (c >= 0x4e00 && c <= 0x9fff) ||
  (c >= 0xff01 && c <= 0xffef) ||
  c === 0xb7 || c === 0x318d || c === 0x2027;
const isBad = (c: number): boolean => (c >= 0xe000 && c <= 0xf8ff) || c === 0xfffd || c < 0x20 || c >= 0xf0000;

/**
 * 텍스트 층이 쓸 만한가. 글자가 너무 적거나(이미지 PDF), 깨진 글자(PUA·U+FFFD)가 많거나,
 * 한글·ASCII·흔한 기호 비중이 낮으면(ToUnicode 없는 폰트) 없다고 본다. 임계값은 S13b·실물로 조정한다.
 */
export function assessTextLayer(text: string, pages: number): TextLayerAssessment {
  const chars = [...text.replace(/\s+/g, '')];
  const n = chars.length;
  if (n < 20 * Math.max(1, pages)) return { ok: false, reason: 'too_little_text', chars: n, good: 0, bad: 0 };
  let good = 0;
  let bad = 0;
  for (const ch of chars) {
    const c = ch.codePointAt(0) ?? 0;
    if (isBad(c)) bad++;
    else if (isGood(c)) good++;
  }
  const r = { chars: n, good: good / n, bad: bad / n };
  if (r.bad > 0.02) return { ok: false, reason: 'garbled', ...r };
  if (r.good < 0.9) return { ok: false, reason: 'unusual_chars', ...r };
  return { ok: true, reason: null, ...r };
}
