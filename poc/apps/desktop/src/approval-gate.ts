import { createHmac, timingSafeEqual } from 'node:crypto';
import { domainToASCII } from 'node:url';
import { cbor, LOCAL_APPROVAL_TTL_MS, type GateRequest, type LocalApproval, type Presence } from '@sax/engine/gate';

// ADR-021 결정 1: 로컬 비가역 승인은 main 소유 승인 바(메인 창 자식 WebContentsView, 스크립트 없음)에서
// main이 직접 관찰한 클릭으로만 인정한다. 이 파일은 Electron 없이 시험할 수 있는 판정 로직과 정적 HTML 생성기다.
// 게이트 요청 모양·D03 해시는 엔진과 같은 @sax/engine/gate를 쓴다.

export type { GateRequest, LocalApproval };

export const ARM_DELAY_MS = 600;
export const DWELL_MS = 150;
/** 창 활성화 뒤 이 시간 안에 바 안에서 시작된 mouseDown은 클릭 활성화로 보고 재무장하지 않는다(앱이 연 핸드오프에서 돌아올 때만). */
export const ACTIVATION_GRACE_MS = 100;
/** main이 전용 Chrome·비밀 창·Hello를 앞에 올린 뒤 이 시간 안에 돌아온 활성화만 핸드오프 복귀다(ADR-024 결정 5). */
export const HANDOFF_RETURN_MS = 120_000;

// ---- 요약 줄(서류 종류별 앱 내장 표) ----

interface Piece {
  text: string;
  /** 줄일 수 있는 조각(상호, 이메일 @ 앞). 나머지는 줄이지 않는다. */
  shrink?: boolean;
}
export interface SummaryLine {
  label: string;
  pieces: Piece[];
  flag?: string;
  /** attention이면 바 전체를 주의 색으로 그린다(중복 가능성, ADR-024 결정 3). */
  tone?: 'normal' | 'attention';
}

/** 해시한 문자열 그대로 자릿수를 묶는다(Number 변환 없음, 2^53 넘는 값도 같게 보인다). */
const won = (v: string) => `${v.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}원`;
const bizNo = (v: string) => `${v.slice(0, 3)}-${v.slice(3, 5)}-${v.slice(5)}`;

/** 값에 제어문자·양방향·폭 없는 문자·한글 채움 문자(Cc·Cf·Default_Ignorable, 줄·문단 구분자, 점자 빈칸)가 있으면 무장하지 않는다. */
export const UNSAFE_CHARS = /[\p{Cc}\p{Cf}\p{Default_Ignorable_Code_Point}\u2028\u2029\u2800]/u;

export type ArmRefusal = { reason: 'missing' | 'unsafe' | 'overflow'; label: string } | { reason: 'hash' | 'duplicate' };

export const REFUSAL_TEXT = {
  missing: (l: string) => `${l} 값이 없어 승인할 수 없어요`,
  unsafe: (l: string) => `${l} 칸에 쓸 수 없는 문자가 있어요. 그 칸을 고쳐 주세요`,
  overflow: (l: string) => `창을 넓혀 주세요 · ${l}`,
  hash: () => '값 대조가 맞지 않아 승인할 수 없어요',
  duplicate: () => '같은 항목이 두 번 들어 있어 승인할 수 없어요',
};

export function refusalText(r: ArmRefusal): string {
  return 'label' in r ? REFUSAL_TEXT[r.reason](r.label) : REFUSAL_TEXT[r.reason]();
}

/** 같은 업무 키의 원장 상태 중 발급됐거나 발급됐을 수 있는 것. 이것이 있으면 "직전 시도 발급 안 됨"보다 먼저 보인다. */
export const ISSUED_OR_UNKNOWN = ['committed', 'in_doubt', 'armed', 'dispatched', 'observed_manual'];

/** $dup.businessKey 값(원장 상태 목록)에 발급됐거나 모르는 건이 있는가. */
export function dupMayBeIssued(f: Map<string, string>): boolean {
  return (f.get('$dup.businessKey') ?? '').split(',').some((s) => ISSUED_OR_UNKNOWN.includes(s));
}

export type DupState = { flag: string; tone: 'normal' | 'attention'; action: string };

/**
 * 중복 경고 표시(D02 §7, ADR-024 결정 3). 칸이 하나라 가장 위험한 것을 고른다:
 * 발급 확정 있음 → 발급 여부 모름 → 직전 시도 미발급 → 그 밖의 같은 건 기록 → 다른 PC 확인 불가. 카드에는 해당하는 경고를 모두 둔다.
 * 발급됐거나 모르는 건은 주의 색이다. 첫 클릭이 명시 확인이라는 ADR-021 규칙은 그대로다.
 */
export function dupState(f: Map<string, string>): DupState | undefined {
  const states = (f.get('$dup.businessKey') ?? '').split(',');
  if (states.includes('committed')) return { flag: '이미 발급됨(승인번호 있음)', tone: 'attention', action: ACTION_TEXT_DUP_COMMITTED };
  if (dupMayBeIssued(f)) return { flag: '발급 여부 확인 안 됨', tone: 'attention', action: ACTION_TEXT_DUP };
  if (f.get('$dup.priorNotCommitted') === 'true') return { flag: '직전 시도 미발급 판정', tone: 'normal', action: ACTION_TEXT_DUP };
  if (f.get('$dup.businessKey')) return { flag: '같은 건 기록 있음', tone: 'normal', action: ACTION_TEXT_DUP };
  if (f.get('$dup.otherDevice')) return { flag: '다른 PC 기록 확인 불가', tone: 'normal', action: ACTION_TEXT_DUP };
  return undefined;
}

/** 동작 글자. 중복 경고가 하나라도 있으면 이 클릭이 D02 §7의 명시 확인이다(ADR-021). */
export function actionText(req: Pick<GateRequest, 'fields'>): string {
  const d = dupState(new Map(req.fields.map((x) => [x.fieldKey, x.value])));
  if (d) return d.action;
  return req.fields.some((x) => x.fieldKey.startsWith('$dup.')) ? ACTION_TEXT_DUP : ACTION_TEXT;
}

/** 한국 시간(KST, UTC+9) 날짜 YYYY-MM-DD. 작성일자는 PC 시간대가 아니라 이것으로 비교한다(ADR-024 결정 1). */
export function kstToday(nowMs: number): string {
  return new Date(nowMs + 9 * 3_600_000).toISOString().slice(0, 10);
}

/**
 * H-01 요약 줄: 공급받는자(상호 · 사업자번호) / 합계 · 세액 / 받는 이메일. 해시한 fields에서만 고른다.
 * 작성일자가 KST 오늘과 다르면 합계 줄 끝에 줄이지 않는 조각 " · 작성일 YYYY-MM-DD"를 붙인다(같으면 화면은 그대로).
 */
export function summarize(req: Pick<GateRequest, 'fields'>, todayKst: string = kstToday(Date.now())): SummaryLine[] | ArmRefusal {
  const f = new Map(req.fields.map((x) => [x.fieldKey, x.value]));
  // 같은 키가 둘이면 Map은 마지막 값만 보이고 해시는 둘 다 덮는다. 보이는 값과 해시한 값이 갈리지 않게 거부한다.
  if (f.size !== req.fields.length) return { reason: 'duplicate' };
  const need = [
    ['counterpartName', '공급받는자'],
    ['counterpartBizNo', '공급받는자'],
    ['totalAmount', '합계'],
    ['taxAmount', '합계'],
  ] as const;
  for (const [k, label] of need) if (!f.get(k)) return { reason: 'missing', label };
  for (const [k, label] of need) if (UNSAFE_CHARS.test(f.get(k)!)) return { reason: 'unsafe', label };
  if (!/^\d{10}$/.test(f.get('counterpartBizNo')!)) return { reason: 'unsafe', label: '공급받는자' };
  if (!/^(0|[1-9]\d{0,14})$/.test(f.get('totalAmount')!) || !/^(0|[1-9]\d{0,14})$/.test(f.get('taxAmount')!)) return { reason: 'unsafe', label: '합계' };
  const issueDate = f.get('issueDate');
  if (issueDate !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(issueDate)) return { reason: 'unsafe', label: '합계' };
  const dup = dupState(f);
  const total: Piece[] = [{ text: won(f.get('totalAmount')!) }, { text: ` · 세액 ${won(f.get('taxAmount')!)}` }];
  if (issueDate && issueDate !== todayKst) total.push({ text: ` · 작성일 ${issueDate}` });
  const head: SummaryLine[] = [
    { label: '공급받는자', pieces: [{ text: f.get('counterpartName')!, shrink: true }, { text: ` · ${bizNo(f.get('counterpartBizNo')!)}` }], flag: f.get('$first.bizNo') === 'true' ? '처음 거래' : undefined },
    { label: '합계', pieces: total, flag: dup?.flag, tone: dup?.tone },
  ];
  // 받는 이메일이 비면 홈택스가 메일을 보내지 않는다(H-01 s15 ifAbsent: clear). 빈 값을 감추지 않고 "없음"으로 보인다.
  const email = f.get('counterpartEmail') ?? '';
  if (!email) return [...head, { label: '받는 이메일', pieces: [{ text: '없음 · 메일을 보내지 않아요' }] }];
  if (UNSAFE_CHARS.test(email)) return { reason: 'unsafe', label: '받는 이메일' };
  const at = email.lastIndexOf('@');
  if (at <= 0) return { reason: 'unsafe', label: '받는 이메일' };
  // 국제화 도메인은 punycode로 보인다.
  const domain = domainToASCII(email.slice(at + 1));
  if (!domain) return { reason: 'unsafe', label: '받는 이메일' };
  return [...head, { label: '받는 이메일', pieces: [{ text: email.slice(0, at), shrink: true }, { text: `@${domain}` }], flag: f.get('$first.email') === 'true' ? '처음 보내는 주소' : undefined }];
}

// ---- 배치·폭 어림 ----

/** 바 안의 고정 치수(DIP). 바 높이는 요약 줄 수로 정한다. */
export const BAR = {
  height: 90,
  padX: 16,
  label: 76,
  action: 132,
  gap: 12,
  flagPad: 16,
  /** 14px 글자 한 칸 폭의 보수적 어림. 한글 등 동아시아 문자는 두 칸. */
  unit: 8.5,
} as const;

const wide = /[\u1100-\u115f\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe30-\ufe4f\uff00-\uff60\uffe0-\uffe6]/u;
export const cells = (s: string) => [...s].reduce((n, c) => n + (wide.test(c) ? 2 : 1), 0);

/** 줄이지 않는 조각이 바 폭 안에 들어가는지 어림한다. 넘친 줄의 라벨, 다 들어가면 null. */
export function overflowLine(lines: SummaryLine[], barWidth: number): string | null {
  // barCss 배치와 같은 식: 좌우 여백, [요약 줄 | 간격 | 동작 칸], 요약 줄 안 [라벨 | 간격 | 값 | 간격 | 표시]. 간격은 셋이다.
  const valueWidth = barWidth - BAR.padX * 2 - BAR.action - BAR.gap - BAR.label - BAR.gap * 2;
  for (const l of lines) {
    const keep = l.pieces.filter((p) => !p.shrink).reduce((n, p) => n + cells(p.text), 0) * BAR.unit;
    const flag = l.flag ? cells(l.flag) * BAR.unit * (12 / 14) + BAR.flagPad : 0;
    // 줄일 수 있는 조각도 "…" 한 글자 자리는 남긴다.
    const shrinkMin = l.pieces.some((p) => p.shrink) ? 2 * BAR.unit : 0;
    if (keep + flag + shrinkMin > valueWidth) return l.label;
  }
  return null;
}

// ---- 정적 HTML ----

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

export const BAR_CSP = "default-src 'none'; style-src 'self'";

/** 무장 전(흐림)·무장됨·무장 거부. 문구(msg)는 요약 값·동작 글자가 아니라서 다시 무장하지 않는다. */
export type BarMode = 'unarmed' | 'armed' | 'refused';
export const BAR_MESSAGES = {
  arming: '잠시 뒤 다시 눌러 주세요',
  dwell: '마우스를 조금 움직인 뒤 눌러 주세요',
  cursor: '마우스 커서가 보이게 한 뒤 눌러 주세요',
} as const;
export const ACTION_TEXT = '승인하고 발급';
export const ACTION_TEXT_DUP = '같은 건 기록을 확인했고 발급';
export const ACTION_TEXT_DUP_COMMITTED = '그래도 한 번 더 발급';

/** 스크립트 없는 정적 페이지. 값은 이스케이프해 텍스트로만 넣는다. 바 전체가 동작 하나라 안에 작은 버튼이 없다. */
export function buildBarHtml(lines: SummaryLine[], mode: BarMode, msg?: string, action = ACTION_TEXT): string {
  const body = lines
    .map((l) => {
      const v = l.pieces.map((p) => `<span class="${p.shrink ? 'sh' : 'kp'}">${esc(p.text)}</span>`).join('');
      return `<div class="ln"><span class="lb">${esc(l.label)}</span><span class="v">${v}</span>${l.flag ? `<span class="fl">${esc(l.flag)}</span>` : '<span></span>'}</div>`;
    })
    .join('');
  const act = mode === 'refused' ? '' : `<div class="act">${esc(action)}</div>`;
  const attn = lines.some((l) => l.tone === 'attention') ? ' attn' : '';
  return `<!doctype html><html lang="ko"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${BAR_CSP}">
<link rel="stylesheet" href="bar.css"></head>
<body class="${mode}${attn}"><div class="lines">${body}</div><div class="side">${act}${msg ? `<div class="msg">${esc(msg)}</div>` : ''}</div></body></html>`;
}

// ---- 색(앱 내장 팔레트, ADR-025 결정 7) ----

export const BAR_COLOR_KEYS = ['accent', 'on-accent', 'accent-soft', 'ink', 'ink-3', 'surface', 'line-strong', 'attention', 'attention-soft'] as const;
export type BarColors = Record<(typeof BAR_COLOR_KEYS)[number], string>;
export type BarPalette = { light: BarColors; dark: BarColors };

/** 디자인 시스템 v1.2 tokens.json과 같은 값. 외부 토큰이 검사에 실패하면 이것 전체를 쓴다. */
export const BAR_PALETTE_DEFAULT: BarPalette = {
  light: { accent: '#2A4F9E', 'on-accent': '#FFFFFF', 'accent-soft': '#E8EEF9', ink: '#16191D', 'ink-3': '#646B76', surface: '#FFFFFF', 'line-strong': '#878E97', attention: '#8A5A0B', 'attention-soft': '#F8EEDC' },
  dark: { accent: '#8EAAF0', 'on-accent': '#0B1226', 'accent-soft': '#1B2540', ink: '#E9EBEE', 'ink-3': '#8B939D', surface: '#171A1E', 'line-strong': '#6B737D', attention: '#E0AE55', 'attention-soft': '#2E2410' },
};

/** 상태별 글자/배경 쌍. 모두 대비 4.5:1 이상이어야 한다. */
const CONTRAST_PAIRS = [
  ['on-accent', 'accent'],
  ['accent', 'accent-soft'],
  ['ink', 'surface'],
  ['on-accent', 'attention'],
  ['attention', 'attention-soft'],
] as const;

const lum = (hex: string) => {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};

/** WCAG 대비(#RRGGBB 두 색). */
export function contrast(a: string, b: string): number {
  const [x, y] = [lum(a), lum(b)];
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

/** 외부 토큰을 검사해 바 팔레트로. 하나라도 형식(#RRGGBB)·대비(4.5:1)에 실패하면 내장 팔레트 전체와 이유. */
export function barPalette(t: { light: Record<string, string>; dark: Record<string, string> }): { palette: BarPalette; rejected: string | null } {
  const out = { light: {}, dark: {} } as BarPalette;
  for (const theme of ['light', 'dark'] as const) {
    for (const k of BAR_COLOR_KEYS) {
      const v = t[theme]?.[k];
      if (typeof v !== 'string' || !/^#[0-9A-Fa-f]{6}$/.test(v)) return { palette: BAR_PALETTE_DEFAULT, rejected: `format:${theme}.${k}` };
      out[theme][k] = v;
    }
    for (const [fg, bg] of CONTRAST_PAIRS) if (contrast(out[theme][fg], out[theme][bg]) < 4.5) return { palette: BAR_PALETTE_DEFAULT, rejected: `contrast:${theme}.${fg}/${bg}` };
  }
  return { palette: out, rejected: null };
}

/**
 * 디자인 시스템 ApprovalBar 명세(v1.2)를 옮긴 앱 내장 CSS. 직각, 그림자 없음, 시스템 서체, 애니메이션 없음.
 * 치수(BAR)는 overflowLine의 폭 어림과 같은 식이라 바꾸지 않는다. v1.2는 색·굵기·표시 칩 모서리만 다듬었다:
 * 라벨 12px 500(무장 상태에서는 on-accent 78%로 값보다 한 단 뒤), 표시 칩 모서리 6px(radius-sm), 동작 글자 자간 -0.01em.
 * 색은 barPalette를 통과한 값만 받는다. 중복 가능성(attn)은 주의 색: 무장됨 attention 바탕, 무장 전 attention-soft 바탕.
 */
export function barCss(t: BarPalette): string {
  const theme = (c: BarColors) => `
body.armed{background:${c.accent};color:${c['on-accent']}}
body.armed .lb{color:${c['on-accent']};opacity:.78}
body.unarmed{background:${c['accent-soft']};color:${c.accent}}
body.unarmed .lb{color:${c['ink-3']}}
body.armed.attn{background:${c.attention};color:${c['on-accent']}}
body.unarmed.attn{background:${c['attention-soft']};color:${c.attention}}
body.refused{background:${c.surface};color:${c.ink};box-shadow:inset 0 0 0 1px ${c['line-strong']}}
body.refused .lb{color:${c['ink-3']}}`;
  return `html,body{margin:0;height:100%;overflow:hidden}
body{box-sizing:border-box;display:grid;grid-template-columns:minmax(0,1fr) ${BAR.action}px;column-gap:${BAR.gap}px;align-items:center;padding:0 ${BAR.padX}px;
font-family:"Malgun Gothic","Apple SD Gothic Neo",system-ui,sans-serif;font-size:14px;line-height:22px;font-variant-numeric:tabular-nums;-webkit-font-smoothing:antialiased;user-select:none;cursor:default}
.lines{min-width:0}
.ln{display:grid;grid-template-columns:${BAR.label}px minmax(0,1fr) auto;column-gap:${BAR.gap}px;align-items:center;white-space:nowrap}
.lb{font-size:12px;line-height:22px;font-weight:500}
.v{display:flex;min-width:0}
.sh{overflow:hidden;text-overflow:ellipsis;min-width:2ch}
.kp{flex:none;white-space:pre}
.fl{font-size:12px;line-height:18px;font-weight:500;padding:0 6px;border:1px solid currentColor;border-radius:6px}
.side{text-align:right}
.act{font-size:18px;line-height:26px;font-weight:700;letter-spacing:-0.01em;word-break:keep-all}
.msg{font-size:12px;line-height:16px;margin-top:2px;opacity:.9}
${theme(t.light)}
@media (prefers-color-scheme: dark){${theme(t.dark)}}`;
}

// ---- 입력 판정 ----

export interface MouseIn {
  type: string;
  x: number;
  y: number;
  button?: string;
  movementX?: number;
  movementY?: number;
}

export interface KeyIn {
  type: string;
  key: string;
  alt?: boolean;
  control?: boolean;
  meta?: boolean;
}

/**
 * 키보드 승인은 없다(ADR-021 결정 1, 08 §5). PoC-4의 Alt+Y 경로는 지우지 않고 꺼 둔다.
 * 접근성 설정으로 켤지는 Phase 1 접근성 검토에서 사용자가 정한다.
 */
export const KEYBOARD_APPROVAL = false;

export type GateResult = { kind: 'approve' } | { kind: 'refused'; reason: keyof typeof BAR_MESSAGES } | null;

/**
 * 승인 바 입력 판정. main이 바 뷰의 before-mouse-event로 관찰한 값만 넣는다(좌표는 바 기준 DIP, 시각은 단조 시계).
 * - 무장 지연: 무장 사건(rearm) 뒤 ARM_DELAY_MS 동안 입력 무시. 그 사이 mouseDown이면 지연을 다시 시작한다.
 * - 머무름: 마지막 mouseLeave·무장 사건 뒤 바 안에서 처음 실제로 움직인 때부터 DWELL_MS가 지났거나,
 *   무장 사건 때부터 커서가 바 안에 멈춰 있었을 때만 mouseDown을 인정한다. "무장 사건 때 바 안"은 main이
 *   OS 커서 위치로 정해 rearm에 넘긴다(앞 게이트에서 남은 추적 상태를 믿지 않는다). 그 예외는 mouseDown 때
 *   OS 커서가 무장 사건 때와 같은 자리일 때만 쓴다(cursorUnmoved). 바를 덮은 알림 위에서 커서가 움직였다면
 *   바는 나감을 받지 못하므로, 위치 비교로 "멈춰 있었음"을 확인한다.
 * - 승인 = 바 안에서 왼쪽 mouseDown → mouseUp.
 */
export class BarGate {
  private armAt = Number.POSITIVE_INFINITY;
  private pressed = false;
  private inside = false;
  private stillSinceArm = false;
  private movedAt: number | null = null;
  private activatedAt: number | null = null;
  private blocked = false;
  private size = { width: 0, height: 0 };
  private readonly armDelayMs: number;

  constructor(armDelayMs = ARM_DELAY_MS) {
    this.armDelayMs = armDelayMs;
  }

  setSize(width: number, height: number): void {
    this.size = { width, height };
  }

  /**
   * 무장 사건: 바가 보이기 시작함, 요약·동작 글자·위치가 바뀜, 창 표시·복원·배율 변경, 커서 위장 해제.
   * cursorInside는 main이 OS 커서 위치와 바의 화면 영역으로 계산한 값이다.
   */
  rearm(now: number, cursorInside: boolean): void {
    this.armAt = now + this.armDelayMs;
    this.pressed = false;
    this.movedAt = null;
    this.inside = cursorInside;
    this.stillSinceArm = cursorInside;
    this.activatedAt = null;
  }

  /** 무장 지연만 다시 시작한다(무장 전 mouseDown, 무장 표시가 아직 그려지지 않음). */
  deferArm(now: number): void {
    this.armAt = now + this.armDelayMs;
    this.pressed = false;
  }

  /**
   * 앱 창 활성화. 앱이 연 핸드오프(전용 Chrome·비밀 창·Hello)에서 돌아온 경우만 클릭 활성화 예외(100ms)를 둔다.
   * 그 밖에는 첫 클릭을 "앞으로 가져오기"로만 받는다: 눌린 상태를 취소하고 무장 지연을 다시 센다(ADR-024 결정 5).
   * 핸드오프 복귀에서 이미 바 안에서 눌린 상태면(포커스가 mouseDown 뒤에 옴) 클릭 활성화로 보고 기다리지 않는다.
   */
  windowActivated(now: number, fromHandoff = false): void {
    if (!fromHandoff) {
      this.activatedAt = null;
      this.deferArm(now);
      return;
    }
    this.activatedAt = this.pressed ? null : now;
  }

  /** 활성화 뒤 ACTIVATION_GRACE_MS가 지났는데 바 안 mouseDown이 없었으면 재무장해야 한다(true). */
  activationSettled(): boolean {
    return this.activatedAt !== null;
  }

  /** 대화 화면 커서가 none·custom이면 무장하지 않는다(커서 위장). 풀리면 main이 재무장한다. */
  setCursorBlocked(blocked: boolean): void {
    this.blocked = blocked;
    if (blocked) this.pressed = false;
  }

  get cursorBlocked(): boolean {
    return this.blocked;
  }

  armed(now: number): boolean {
    return !this.blocked && now >= this.armAt;
  }

  /** 다음 무장 시각(표시 전환 타이머용). */
  get armTime(): number {
    return this.armAt;
  }

  private within(x: number, y: number): boolean {
    return x >= 0 && y >= 0 && x < this.size.width && y < this.size.height;
  }

  private leave(): void {
    this.inside = false;
    this.stillSinceArm = false;
    this.movedAt = null;
    this.pressed = false;
  }

  /** 들어옴·나감·움직임만 기록한다. 바가 숨었거나 무장을 거부한 동안에도 부른다. */
  track(ev: MouseIn, now: number): void {
    if (ev.type === 'mouseLeave' || ((ev.type === 'mouseMove' || ev.type === 'mouseEnter') && !this.within(ev.x, ev.y))) return this.leave();
    if (ev.type === 'mouseEnter') this.inside = true;
    if (ev.type === 'mouseMove') {
      this.inside = true;
      if (this.movedAt === null && (ev.movementX || ev.movementY)) this.movedAt = now;
    }
  }

  mouse(ev: MouseIn, now: number, cursorUnmoved = true): GateResult {
    if (ev.type !== 'mouseDown' && ev.type !== 'mouseUp') {
      this.track(ev, now);
      return null;
    }
    if (ev.type === 'mouseDown') {
      if (ev.button !== 'left' || !this.within(ev.x, ev.y)) return null;
      this.inside = true;
      if (this.blocked) return { kind: 'refused', reason: 'cursor' };
      if (this.activatedAt !== null) {
        // 클릭 활성화(다른 창에서 바를 바로 눌러 앱을 앞으로 가져옴)는 재무장하지 않고 그대로 판정한다.
        // 활성화 뒤 ACTIVATION_GRACE_MS가 지났으면 재무장 타이머가 늦은 것이므로 지금 재무장하고 거부한다.
        if (now - this.activatedAt <= ACTIVATION_GRACE_MS) this.activatedAt = null;
        else {
          this.rearm(now, true);
          return { kind: 'refused', reason: 'arming' };
        }
      }
      if (!this.armed(now)) {
        this.deferArm(now);
        return { kind: 'refused', reason: 'arming' };
      }
      const dwelled = (this.movedAt !== null && now - this.movedAt >= DWELL_MS) || (this.stillSinceArm && cursorUnmoved);
      if (!dwelled) {
        this.pressed = false;
        return { kind: 'refused', reason: 'dwell' };
      }
      this.pressed = true;
      return null;
    }
    if (ev.button !== 'left') return null;
    const ok = this.pressed && this.armed(now) && this.within(ev.x, ev.y);
    this.pressed = false;
    return ok ? { kind: 'approve' } : null;
  }

  /** 키 입력. KEYBOARD_APPROVAL이 꺼져 있으면 어떤 키도 승인이 아니다. */
  key(ev: KeyIn, now: number): GateResult {
    if (!KEYBOARD_APPROVAL || !this.armed(now) || ev.type !== 'keyDown') return null;
    return ev.alt && !ev.control && !ev.meta && (ev.key.toLowerCase() === 'y' || ev.key === 'ㅛ') ? { kind: 'approve' } : null;
  }
}

/** 핸드오프 표시: main이 다른 창을 앞에 올렸다가 돌아왔음. 다음 활성화 한 번에만 쓴다(소비). */
export class HandoffMark {
  private at: number | null = null;

  note(now: number): void {
    this.at = now;
  }

  /** now가 표시 뒤 HANDOFF_RETURN_MS 안이면 true. 맞든 아니든 표시는 지운다. */
  consume(now: number): boolean {
    const at = this.at;
    this.at = null;
    return at !== null && now >= at && now - at <= HANDOFF_RETURN_MS;
  }
}

// ---- 근거 ----

const APPROVAL_CONTEXT = 'SAX-local-approval-v2';
const canon = (a: Omit<LocalApproval, 'mac'>) => cbor([a.v, a.runId, a.gateStepId, a.reqId, a.approvalNonce, a.actionHash, a.exp, a.presence]);

/**
 * LocalApproval v2(ADR-021). main 승인 바가 바에 띄운 그 게이트 요청으로 발급한다. 엔진은 키가 없어 MAC을 검증하지 않고
 * 게이트 포트 출처와 runId·gateStepId·reqId·approvalNonce·actionHash 일치만 본다(Phase 1과 같음). MAC은 main 자기 확인용이다.
 */
export function issueLocalApproval(key: Uint8Array, req: Pick<GateRequest, 'runId' | 'gateStepId' | 'reqId' | 'approvalNonce' | 'actionHash'>, presence: Presence = 'click', ttlMs = LOCAL_APPROVAL_TTL_MS, now = Date.now()): LocalApproval {
  const body = { v: 2 as const, runId: req.runId, gateStepId: req.gateStepId, reqId: req.reqId, approvalNonce: req.approvalNonce, actionHash: req.actionHash, exp: now + ttlMs, presence };
  return { ...body, mac: createHmac('sha256', key).update(APPROVAL_CONTEXT).update(canon(body)).digest('base64url') };
}

export function verifyLocalApproval(key: Uint8Array, a: LocalApproval, now = Date.now()): boolean {
  if (a?.v !== 2 || !(a.exp >= now)) return false;
  let expected: Buffer;
  try {
    expected = createHmac('sha256', key).update(APPROVAL_CONTEXT).update(canon(a)).digest();
  } catch {
    return false;
  }
  const got = Buffer.from(String(a.mac), 'base64url');
  return got.length === expected.length && timingSafeEqual(got, expected);
}
