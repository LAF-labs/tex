import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { domainToASCII } from 'node:url';

// ADR-021 결정 1: 로컬 비가역 승인은 main 소유 승인 바(메인 창 자식 WebContentsView, 스크립트 없음)에서
// main이 직접 관찰한 클릭으로만 인정한다. 이 파일은 Electron 없이 시험할 수 있는 판정 로직과 정적 HTML 생성기다.

export const ARM_DELAY_MS = 600;
export const DWELL_MS = 150;
/** 창 활성화 뒤 이 시간 안에 바 안에서 시작된 mouseDown은 클릭 활성화로 보고 재무장하지 않는다. */
export const ACTIVATION_GRACE_MS = 100;

/** 엔진 게이트 요청의 대역(PoC-9 목업). PoC-6에서 엔진 `WaitingGate` 요청과 D03 cardHash로 바꾼다. */
export interface GateRequest {
  runId: string;
  gateStepId: string;
  reqId: string;
  docType: 'H-01';
  /** readback 값과 엔진 예약 키($first.*)의 배열 전체. 순서도 해시에 들어간다. */
  fields: Array<{ fieldKey: string; value: string }>;
  actionHash: string;
}

/** 목업 자기 일치 확인용 해시. D03 cardHash·actionHash 식이 아니다(PoC-6에서 교체). */
export function gateHash(req: Omit<GateRequest, 'actionHash'>): string {
  return createHash('sha256').update(JSON.stringify([req.runId, req.gateStepId, req.reqId, req.docType, req.fields.map((f) => [f.fieldKey, f.value])])).digest('hex');
}

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

/** H-01 요약 줄: 공급받는자(상호 · 사업자번호) / 합계 · 세액 / 받는 이메일. 해시한 fields에서만 고른다. */
export function summarize(req: GateRequest): SummaryLine[] | ArmRefusal {
  const f = new Map(req.fields.map((x) => [x.fieldKey, x.value]));
  // 같은 키가 둘이면 Map은 마지막 값만 보이고 해시는 둘 다 덮는다. 보이는 값과 해시한 값이 갈리지 않게 거부한다.
  if (f.size !== req.fields.length) return { reason: 'duplicate' };
  const need = [
    ['counterpartName', '공급받는자'],
    ['counterpartBizNo', '공급받는자'],
    ['totalAmount', '합계'],
    ['taxAmount', '합계'],
    ['counterpartEmail', '받는 이메일'],
  ] as const;
  for (const [k, label] of need) if (!f.get(k)) return { reason: 'missing', label };
  for (const [k, label] of need) if (UNSAFE_CHARS.test(f.get(k)!)) return { reason: 'unsafe', label };
  if (!/^\d{10}$/.test(f.get('counterpartBizNo')!)) return { reason: 'unsafe', label: '공급받는자' };
  if (!/^(0|[1-9]\d{0,14})$/.test(f.get('totalAmount')!) || !/^(0|[1-9]\d{0,14})$/.test(f.get('taxAmount')!)) return { reason: 'unsafe', label: '합계' };
  const email = f.get('counterpartEmail')!;
  const at = email.lastIndexOf('@');
  if (at <= 0) return { reason: 'unsafe', label: '받는 이메일' };
  // 국제화 도메인은 punycode로 보인다.
  const domain = domainToASCII(email.slice(at + 1));
  if (!domain) return { reason: 'unsafe', label: '받는 이메일' };
  return [
    { label: '공급받는자', pieces: [{ text: f.get('counterpartName')!, shrink: true }, { text: ` · ${bizNo(f.get('counterpartBizNo')!)}` }], flag: f.get('$first.bizNo') === 'true' ? '처음 거래' : undefined },
    { label: '합계', pieces: [{ text: won(f.get('totalAmount')!) }, { text: ` · 세액 ${won(f.get('taxAmount')!)}` }] },
    { label: '받는 이메일', pieces: [{ text: email.slice(0, at), shrink: true }, { text: `@${domain}` }], flag: f.get('$first.email') === 'true' ? '처음 보내는 주소' : undefined },
  ];
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
  const valueWidth = barWidth - BAR.padX * 2 - BAR.label - BAR.action - BAR.gap * 2;
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

/** 스크립트 없는 정적 페이지. 값은 이스케이프해 텍스트로만 넣는다. 바 전체가 동작 하나라 안에 작은 버튼이 없다. */
export function buildBarHtml(lines: SummaryLine[], mode: BarMode, msg?: string): string {
  const body = lines
    .map((l) => {
      const v = l.pieces.map((p) => `<span class="${p.shrink ? 'sh' : 'kp'}">${esc(p.text)}</span>`).join('');
      return `<div class="ln"><span class="lb">${esc(l.label)}</span><span class="v">${v}</span>${l.flag ? `<span class="fl">${esc(l.flag)}</span>` : '<span></span>'}</div>`;
    })
    .join('');
  const act = mode === 'refused' ? '' : `<div class="act">${esc(ACTION_TEXT)}</div>`;
  return `<!doctype html><html lang="ko"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${BAR_CSP}">
<link rel="stylesheet" href="bar.css"></head>
<body class="${mode}"><div class="lines">${body}</div><div class="side">${act}${msg ? `<div class="msg">${esc(msg)}</div>` : ''}</div></body></html>`;
}

/** 디자인 시스템 ApprovalBar 명세를 옮긴 앱 내장 CSS. 직각, 그림자 없음, 시스템 서체, 애니메이션 없음. */
export function barCss(t: { light: Record<string, string>; dark: Record<string, string> }): string {
  const theme = (c: Record<string, string>) => `
body.armed{background:${c.accent};color:${c['on-accent']}}
body.unarmed{background:${c['accent-soft']};color:${c.accent}}
body.unarmed .lb{color:${c['ink-3']}}
body.refused{background:${c.surface};color:${c.ink};box-shadow:inset 0 0 0 1px ${c['line-strong']}}
body.refused .lb{color:${c['ink-3']}}`;
  return `html,body{margin:0;height:100%;overflow:hidden}
body{box-sizing:border-box;display:grid;grid-template-columns:minmax(0,1fr) ${BAR.action}px;column-gap:${BAR.gap}px;align-items:center;padding:0 ${BAR.padX}px;
font-family:"Malgun Gothic","Apple SD Gothic Neo",system-ui,sans-serif;font-size:14px;line-height:22px;font-variant-numeric:tabular-nums;user-select:none;cursor:default}
.lines{min-width:0}
.ln{display:grid;grid-template-columns:${BAR.label}px minmax(0,1fr) auto;column-gap:${BAR.gap}px;align-items:center;white-space:nowrap}
.lb{font-size:12px;opacity:.86}
.v{display:flex;min-width:0}
.sh{overflow:hidden;text-overflow:ellipsis;min-width:2ch}
.kp{flex:none;white-space:pre}
.fl{font-size:12px;line-height:18px;padding:0 6px;border:1px solid currentColor;border-radius:4px}
.side{text-align:right}
.act{font-size:18px;line-height:26px;font-weight:700}
.msg{font-size:12px;line-height:16px;margin-top:2px}
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

  /** 앱 창 활성화. 이미 바 안에서 눌린 상태면(포커스가 mouseDown 뒤에 옴) 클릭 활성화로 보고 기다리지 않는다. */
  windowActivated(now: number): void {
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

// ---- 근거 ----

export interface LocalApproval {
  runId: string;
  gateStepId: string;
  actionHash: string;
  exp: number;
  mac: string;
}

const canon = (a: Omit<LocalApproval, 'mac'>) => JSON.stringify([a.runId, a.gateStepId, a.actionHash, a.exp]);

/** LocalApproval v1(ADR-014 형식). v2(reqId·approvalNonce·presence, `SAX-local-approval-v2`)는 PoC-6에서. */
export function issueLocalApproval(key: Uint8Array, gate: { runId: string; gateStepId: string; actionHash: string }, ttlMs = 120_000, now = Date.now()): LocalApproval {
  const body = { runId: gate.runId, gateStepId: gate.gateStepId, actionHash: gate.actionHash, exp: now + ttlMs };
  return { ...body, mac: createHmac('sha256', key).update('SAX-local-approval-v1').update(canon(body)).digest('base64url') };
}

export function verifyLocalApproval(key: Uint8Array, a: LocalApproval, now = Date.now()): boolean {
  if (a.exp < now) return false;
  const expected = createHmac('sha256', key).update('SAX-local-approval-v1').update(canon(a)).digest();
  const got = Buffer.from(a.mac, 'base64url');
  return got.length === expected.length && timingSafeEqual(got, expected);
}
