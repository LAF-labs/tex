import { createHmac, timingSafeEqual } from 'node:crypto';

// ADR-014 결정 2: 로컬 비가역 승인은 main이 만드는 정적 승인 창에서, main이 직접 관찰한 실제 입력으로만 인정한다.
// 이 파일은 Electron 없이 시험할 수 있는 판정 로직과 HTML 생성기다.

export interface ApprovalCard {
  runId: string;
  gateStepId: string;
  actionHash: string;
  /** 앱 내장 문구 키(서명 패키지 문자열을 템플릿으로 쓰지 않는다). */
  titleKey: keyof typeof TITLES;
  /** 엔진의 신뢰 계획값(readback). 라벨은 앱 내장 문자열 키. */
  rows: Array<{ labelKey: keyof typeof LABELS; value: string }>;
}

export const TITLES = {
  tax_invoice_issue: '전자세금계산서 발급 승인',
  demo: '승인 창 시험(실제 발급 아님)',
} as const;

export const LABELS = {
  supplier: '공급자',
  buyer: '공급받는자',
  buyer_biz_no: '공급받는자 사업자번호',
  amount: '공급가액',
  tax: '세액',
  email: '이메일 수신',
  item: '품목',
  date: '작성일자',
} as const;

/** 고정 배치(줌 1 고정). 버튼 위치를 main이 알고 있어야 클릭 좌표로 판정할 수 있다. */
export const LAYOUT = {
  width: 560,
  height: 440,
  approve: { x: 316, y: 360, w: 200, h: 52 },
  deny: { x: 44, y: 360, w: 200, h: 52 },
} as const;

export const ARM_DELAY_MS = 600;

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

export const APPROVAL_CSP = "default-src 'none'; style-src 'self'";

/** 스크립트 없는 정적 HTML. 값은 이스케이프해 텍스트로만 넣는다(textContent와 같은 효과). */
export function buildApprovalHtml(card: ApprovalCard): string {
  const rows = card.rows
    .slice(0, 8)
    .map((r) => `<tr><th>${esc(LABELS[r.labelKey])}</th><td>${esc(r.value.slice(0, 120))}</td></tr>`)
    .join('');
  return `<!doctype html><html lang="ko"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${APPROVAL_CSP}">
<link rel="stylesheet" href="approval.css"><title>${esc(TITLES[card.titleKey])}</title></head>
<body><h1>${esc(TITLES[card.titleKey])}</h1>
<table>${rows}</table>
<p class="hash">확인값 ${esc(card.actionHash.slice(0, 16))}</p>
<div class="btn deny">거절</div><div class="btn approve">승인</div>
</body></html>`;
}

export function approvalCss(): string {
  const b = (r: { x: number; y: number; w: number; h: number }) => `left:${r.x}px;top:${r.y}px;width:${r.w}px;height:${r.h}px;line-height:${r.h}px`;
  return `html,body{margin:0;padding:0;width:${LAYOUT.width}px;height:${LAYOUT.height}px;overflow:hidden;font:15px -apple-system,'Malgun Gothic',sans-serif;background:#fff;color:#111;user-select:none}
h1{font-size:18px;margin:20px 24px 12px}table{margin:0 24px;border-collapse:collapse;width:${LAYOUT.width - 48}px}
th{text-align:left;color:#555;font-weight:500;padding:5px 8px 5px 0;width:160px;vertical-align:top}td{padding:5px 0;word-break:break-all}
.hash{position:absolute;left:24px;top:${LAYOUT.approve.y - 34}px;color:#888;font-size:12px;margin:0}
.btn{position:absolute;text-align:center;border-radius:8px;font-weight:600;cursor:default}
.approve{${b(LAYOUT.approve)};background:#1f6feb;color:#fff}.deny{${b(LAYOUT.deny)};background:#eee;color:#333}`;
}

export type Decision = 'approve' | 'deny';

export interface MouseIn {
  type: string;
  x: number;
  y: number;
  button?: string;
  clickCount?: number;
}

export interface KeyIn {
  type: string;
  key: string;
  alt?: boolean;
  control?: boolean;
  meta?: boolean;
  shift?: boolean;
  isAutoRepeat?: boolean;
}

const inside = (r: { x: number; y: number; w: number; h: number }, x: number, y: number) => x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h;

/**
 * 입력 판정. main이 승인 창의 before-mouse-event·before-input-event로 관찰한 값만 넣는다.
 * - 표시·활성화 후 ARM_DELAY_MS 동안 입력 무시(창이 뜬 직후 이어지던 클릭·키가 승인이 되지 않게)
 * - 승인 = 같은 버튼 안에서 왼쪽 mouseDown → mouseUp, 또는 Alt+Y(비타이핑 조합키). Enter 단독은 무시
 */
export class ApprovalGate {
  private armedAt = Number.POSITIVE_INFINITY;
  private pressed: Decision | null = null;
  private readonly armDelayMs: number;

  constructor(armDelayMs = ARM_DELAY_MS) {
    this.armDelayMs = armDelayMs;
  }

  /** 창 show·focus마다 호출: 다시 무장 대기. */
  shown(now: number): void {
    this.armedAt = now + this.armDelayMs;
    this.pressed = null;
  }

  private armed(now: number): boolean {
    return now >= this.armedAt;
  }

  mouse(ev: MouseIn, now: number): Decision | null {
    if (!this.armed(now)) {
      this.pressed = null;
      return null;
    }
    if (ev.button && ev.button !== 'left') return null;
    const hit: Decision | null = inside(LAYOUT.approve, ev.x, ev.y) ? 'approve' : inside(LAYOUT.deny, ev.x, ev.y) ? 'deny' : null;
    if (ev.type === 'mouseDown') {
      this.pressed = hit;
      return null;
    }
    if (ev.type === 'mouseUp') {
      const d = this.pressed && this.pressed === hit ? hit : null;
      this.pressed = null;
      return d;
    }
    return null;
  }

  key(ev: KeyIn, now: number): Decision | null {
    if (!this.armed(now) || ev.type !== 'keyDown' || ev.isAutoRepeat) return null;
    const k = ev.key.toLowerCase();
    if (ev.alt && !ev.control && !ev.meta && (k === 'y' || k === 'ㅛ')) return 'approve';
    if (k === 'escape') return 'deny';
    return null;
  }
}

export interface LocalApproval {
  runId: string;
  gateStepId: string;
  actionHash: string;
  exp: number;
  mac: string;
}

const canon = (a: Omit<LocalApproval, 'mac'>) => JSON.stringify([a.runId, a.gateStepId, a.actionHash, a.exp]);

/** LocalApproval 발급(ADR-014). 키는 기동 시 main↔금고가 공유한다(금고 검증은 Phase 2 커밋 가드 이전 때). */
export function issueLocalApproval(key: Uint8Array, card: ApprovalCard, ttlMs = 120_000, now = Date.now()): LocalApproval {
  const body = { runId: card.runId, gateStepId: card.gateStepId, actionHash: card.actionHash, exp: now + ttlMs };
  return { ...body, mac: createHmac('sha256', key).update('SAX-local-approval-v1').update(canon(body)).digest('base64url') };
}

export function verifyLocalApproval(key: Uint8Array, a: LocalApproval, now = Date.now()): boolean {
  if (a.exp < now) return false;
  const expected = createHmac('sha256', key).update('SAX-local-approval-v1').update(canon(a)).digest();
  const got = Buffer.from(a.mac, 'base64url');
  return got.length === expected.length && timingSafeEqual(got, expected);
}
