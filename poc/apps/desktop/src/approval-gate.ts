import { createHmac, timingSafeEqual } from 'node:crypto';
import { domainToASCII } from 'node:url';
import { cbor, LOCAL_APPROVAL_TTL_MS, LOCAL_ATTEST_CONTEXT, LOCAL_ATTEST_TTL_MS, type AttestRequest, type GateRequest, type LocalApproval, type LocalAttestation, type Presence } from '@sax/engine/gate';

// ADR-021 결정 1: 로컬 비가역 승인은 main 소유 승인 바(메인 창 자식 WebContentsView, 스크립트 없음)에서
// main이 직접 관찰한 클릭으로만 인정한다. 이 파일은 Electron 없이 시험할 수 있는 판정 로직과 정적 HTML 생성기다.
// 게이트 요청 모양·D03 해시는 엔진과 같은 @sax/engine/gate를 쓴다.

export type { AttestRequest, GateRequest, LocalApproval, LocalAttestation };

export const ARM_DELAY_MS = 600;
export const DWELL_MS = 150;
/** 창 활성화 뒤 이 시간 안에 바 안에서 시작된 mouseDown은 클릭 활성화로 보고 재무장하지 않는다(앱이 연 핸드오프에서 돌아올 때만). */
export const ACTIVATION_GRACE_MS = 100;
/** main이 전용 Chrome·비밀 창·Hello를 앞에 올린 뒤 이 시간 안에 돌아온 활성화만 핸드오프 복귀다(ADR-027 결정 5). */
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
  /** attention이면 바 전체를 주의 색으로 그린다(중복 가능성, ADR-027 결정 3). */
  tone?: 'normal' | 'attention';
  /** 고정 안내 줄(증언 바의 E-13 문구). 작은 글자로 그리고 값이 아니다. */
  note?: boolean;
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

/** 증언 바의 무장 거부 문구. 승인이 아니므로 "승인할 수 없어요"를 "확인 결과를 받을 수 없어요"로 바꾼다. */
export const attestRefusalText = (text: string) => text.replace('승인할 수 없어요', '확인 결과를 받을 수 없어요');

/** 같은 업무 키의 원장 상태 중 발급됐거나 발급됐을 수 있는 것. 이것이 있으면 "직전 시도 발급 안 됨"보다 먼저 보인다. */
export const ISSUED_OR_UNKNOWN = ['committed', 'in_doubt', 'armed', 'dispatched', 'observed_manual'];

/** $dup.businessKey 값(원장 상태 목록)에 발급됐거나 모르는 건이 있는가. */
export function dupMayBeIssued(f: Map<string, string>): boolean {
  return (f.get('$dup.businessKey') ?? '').split(',').some((s) => ISSUED_OR_UNKNOWN.includes(s));
}

export type DupState = { flag: string; tone: 'normal' | 'attention'; action: string };

/**
 * 중복 경고 표시(D02 §7, ADR-027 결정 3). 칸이 하나라 가장 위험한 것을 고른다:
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

/** 한국 시간(KST, UTC+9) 날짜 YYYY-MM-DD. 작성일자는 PC 시간대가 아니라 이것으로 비교한다(ADR-027 결정 1). */
export function kstToday(nowMs: number): string {
  return new Date(nowMs + 9 * 3_600_000).toISOString().slice(0, 10);
}

const AMOUNT = /^(0|[1-9]\d{0,14})$/;

/** 서류 종류별 카드 줄 수(앱 내장 표, ADR-021 결정 7). 카드 높이는 이 줄 수로만 정한다(렌더러 보고 없음). */
export const CARD_ROWS = { 'H-01': 5 } as const;

/**
 * H-01 승인 카드 줄(ADR-021 결정 7): 합계(· 공급가액 · 세액) / 공급받는자(상호 · 사업자번호) / 품목 / 작성일자 / 받는 이메일.
 * 값은 해시한 게이트 요청 fields에서만 고른다(엔진 readback, V-03h). 줄 수는 CARD_ROWS['H-01']로 늘 같다.
 * 작성일자가 KST 오늘과 다르면 "오늘 아님" 표시를 붙인다. 중복 경고는 합계 줄 표시 칸에 가장 위험한 것 하나를 둔다.
 */
export function summarize(req: Pick<GateRequest, 'fields'>, todayKst: string = kstToday(Date.now())): SummaryLine[] | ArmRefusal {
  const f = new Map(req.fields.map((x) => [x.fieldKey, x.value]));
  // 같은 키가 둘이면 Map은 마지막 값만 보이고 해시는 둘 다 덮는다. 보이는 값과 해시한 값이 갈리지 않게 거부한다.
  if (f.size !== req.fields.length) return { reason: 'duplicate' };
  const need = [
    ['totalAmount', '합계'],
    ['supplyAmount', '합계'],
    ['taxAmount', '합계'],
    ['counterpartName', '공급받는자'],
    ['counterpartBizNo', '공급받는자'],
    ['itemName', '품목'],
    ['issueDate', '작성일자'],
  ] as const;
  for (const [k, label] of need) if (!f.get(k)) return { reason: 'missing', label };
  for (const [k, label] of need) if (UNSAFE_CHARS.test(f.get(k)!)) return { reason: 'unsafe', label };
  for (const k of ['totalAmount', 'supplyAmount', 'taxAmount'] as const) if (!AMOUNT.test(f.get(k)!)) return { reason: 'unsafe', label: '합계' };
  if (!/^\d{10}$/.test(f.get('counterpartBizNo')!)) return { reason: 'unsafe', label: '공급받는자' };
  const issueDate = f.get('issueDate')!;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(issueDate)) return { reason: 'unsafe', label: '작성일자' };
  const count = f.get('itemCount');
  if (count !== undefined && !/^[1-9]\d{0,3}$/.test(count)) return { reason: 'unsafe', label: '품목' };
  const dup = dupState(f);
  const rows: SummaryLine[] = [
    { label: '합계', pieces: [{ text: won(f.get('totalAmount')!) }, { text: ` · 공급가액 ${won(f.get('supplyAmount')!)} · 세액 ${won(f.get('taxAmount')!)}` }], flag: dup?.flag, tone: dup?.tone },
    { label: '공급받는자', pieces: [{ text: f.get('counterpartName')!, shrink: true }, { text: ` · ${bizNo(f.get('counterpartBizNo')!)}` }], flag: f.get('$first.bizNo') === 'true' ? '처음 거래' : undefined },
    { label: '품목', pieces: [{ text: f.get('itemName')!, shrink: true }, ...(count && count !== '1' ? [{ text: ` · ${count}개 품목` }] : [])] },
    { label: '작성일자', pieces: [{ text: issueDate }], flag: issueDate !== todayKst ? '오늘 아님' : undefined },
  ];
  // 받는 이메일이 비면 홈택스가 메일을 보내지 않는다(H-01 s15 ifAbsent: clear). 빈 값을 감추지 않고 "없음"으로 보인다.
  const email = f.get('counterpartEmail') ?? '';
  if (!email) return [...rows, { label: '받는 이메일', pieces: [{ text: '없음 · 메일을 보내지 않아요' }] }];
  if (UNSAFE_CHARS.test(email)) return { reason: 'unsafe', label: '받는 이메일' };
  const at = email.lastIndexOf('@');
  if (at <= 0) return { reason: 'unsafe', label: '받는 이메일' };
  // 국제화 도메인은 punycode로 보인다.
  const domain = domainToASCII(email.slice(at + 1));
  if (!domain) return { reason: 'unsafe', label: '받는 이메일' };
  return [...rows, { label: '받는 이메일', pieces: [{ text: email.slice(0, at), shrink: true }, { text: `@${domain}` }], flag: f.get('$first.email') === 'true' ? '처음 보내는 주소' : undefined }];
}

// ---- InDoubt 증언 바(ADR-021 결정 5) ----

/** 증언 바 동작 글자. 승인과 다른 말·다른 색(황토)이라 승인하던 습관대로 누른 클릭이 증언이 되지 않게 한다. */
export const ATTEST_ACTION_TEXT = '홈택스 발급목록에 없음을 확인했어요';
/** E-13 고정 문구. 증언 바의 정적 HTML에 늘 넣는다(D03 §2 InDoubt 행). */
export const ATTEST_FIXED = '발급목록 반영이 늦을 수 있습니다';
const PORTAL_NAME: Record<string, string> = { hometax: '홈택스', gov24: '정부24', sminfo: '중소기업현황정보시스템', insure4: '4대보험 정보연계센터' };
/** 정지 하향으로 조회 없이 받는 증언(manualCheck)에 더하는 문구(ADR-021 개정 메모). */
export const attestManualText = (portal: string) => `${PORTAL_NAME[portal] ?? '홈택스'} 발급목록을 직접 확인한 뒤 답해 주세요`;

/** 증언 카드 줄 수: 값 2줄 + E-13 고정 줄(정지 하향이면 직접 확인 줄 하나 더). */
export const attestRows = (manualCheck?: boolean) => (manualCheck === true ? 4 : 3);

/**
 * 증언 카드 줄: 공급받는자(상호 · 사업자번호) / 합계. 엔진이 보낸 ATTEST_SUMMARY_KEYS 3칸에서만 고른다(그 해시가 summaryHash).
 * 두 줄 모두 주의 색이고, 그 아래 E-13 고정 줄(정지 하향이면 직접 확인 줄도)을 둔다. 줄 수는 attestRows와 같다.
 */
export function summarizeAttest(req: Pick<AttestRequest, 'fields' | 'manualCheck' | 'portal'>): SummaryLine[] | ArmRefusal {
  const f = new Map(req.fields.map((x) => [x.fieldKey, x.value]));
  if (f.size !== req.fields.length) return { reason: 'duplicate' };
  const need = [
    ['counterpartName', '공급받는자'],
    ['counterpartBizNo', '공급받는자'],
    ['totalAmount', '합계'],
  ] as const;
  for (const [k, label] of need) if (!f.get(k)) return { reason: 'missing', label };
  for (const [k, label] of need) if (UNSAFE_CHARS.test(f.get(k)!)) return { reason: 'unsafe', label };
  if (!/^\d{10}$/.test(f.get('counterpartBizNo')!)) return { reason: 'unsafe', label: '공급받는자' };
  if (!AMOUNT.test(f.get('totalAmount')!)) return { reason: 'unsafe', label: '합계' };
  const lines: SummaryLine[] = [
    { label: '공급받는자', pieces: [{ text: f.get('counterpartName')!, shrink: true }, { text: ` · ${bizNo(f.get('counterpartBizNo')!)}` }], tone: 'attention' },
    { label: '합계', pieces: [{ text: won(f.get('totalAmount')!) }], tone: 'attention' },
    { label: '', pieces: [{ text: ATTEST_FIXED }], tone: 'attention', note: true },
  ];
  if (req.manualCheck === true) lines.push({ label: '', pieces: [{ text: attestManualText(req.portal) }], tone: 'attention', note: true });
  return lines;
}

// ---- 카드 치수·폭 어림(ADR-021 결정 7) ----

/**
 * 승인 카드 안의 고정 치수(DIP). 높이는 줄 수로만(cardHeight), 버튼 자리는 이 상수와 카드 폭·동작 글자로만(cardTargets) 정한다.
 * cardCss가 같은 상수로 그리고, main은 이 값으로 클릭을 판정한다. 렌더러가 보고하는 값은 쓰지 않는다.
 */
export const CARD = {
  padX: 16,
  padY: 14,
  label: 76,
  gap: 12,
  flagPad: 16,
  /** 14px 글자 한 칸 폭의 보수적 어림. 한글 등 동아시아 문자는 두 칸. */
  unit: 8.5,
  row: 22,
  /** 비가역 한 줄(13px) 위 간격·높이 */
  irrGap: 8,
  irr: 20,
  /** 문구 줄(다시 눌러 주세요·무장 거부, 12px) */
  msg: 18,
  btnGap: 8,
  btn: 36,
  /** [중지] 폭과 두 버튼 사이 앱 상수 간격(결정 7 원칙 4) */
  stop: 88,
  apart: 32,
  /** 동작 버튼 글자(15px 굵게) 한 칸 어림과 좌우 안쪽 여백 */
  btnUnit: 9.5,
  btnPadX: 20,
} as const;

const wide = /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦]/u;
export const cells = (s: string) => [...s].reduce((n, c) => n + (wide.test(c) ? 2 : 1), 0);

/** 줄 수로 정한 카드 높이: 위 여백 · 값 줄 · 비가역 한 줄 · 문구 줄 · 버튼 줄 · 아래 여백. */
export const cardHeight = (rows: number) => CARD.padY * 2 + rows * CARD.row + CARD.irrGap + CARD.irr + CARD.msg + CARD.btnGap + CARD.btn;

export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}
/** 카드 기준 DIP의 두 판정 영역. */
export interface CardTargets {
  approve: Box;
  stop: Box;
}

export const approveWidth = (action: string) => Math.ceil(cells(action) * CARD.btnUnit) + CARD.btnPadX * 2;

/** 두 버튼 자리. 오른쪽 아래에 [중지] · 앱 상수 간격 · [동작] 순서다. */
export function cardTargets(width: number, height: number, action: string): CardTargets {
  const y = height - CARD.padY - CARD.btn;
  const aw = approveWidth(action);
  const ax = width - CARD.padX - aw;
  return { approve: { x: ax, y, width: aw, height: CARD.btn }, stop: { x: ax - CARD.apart - CARD.stop, y, width: CARD.stop, height: CARD.btn } };
}

/** 점이 영역 안인가(오른쪽·아래 경계는 밖). */
export const inBox = (b: Box, x: number, y: number) => x >= b.x && y >= b.y && x < b.x + b.width && y < b.y + b.height;

/**
 * 줄이지 않는 조각·비가역 한 줄·버튼 줄이 카드 폭 안에 들어가는지 어림한다. 넘친 줄의 라벨('안내'·'버튼' 포함), 다 들어가면 null.
 */
export function overflowLine(lines: SummaryLine[], cardWidth: number, text: CardText = GATE_TEXT): string | null {
  // cardCss 배치와 같은 식: 좌우 여백, 줄 안 [라벨 | 간격 | 값 | 간격 | 표시]. 간격은 둘이다.
  const valueWidth = cardWidth - CARD.padX * 2 - CARD.label - CARD.gap * 2;
  for (const l of lines) {
    const keep = l.pieces.filter((p) => !p.shrink).reduce((n, p) => n + cells(p.text), 0) * CARD.unit;
    const flag = l.flag ? cells(l.flag) * CARD.unit * (12 / 14) + CARD.flagPad : 0;
    // 줄일 수 있는 조각도 "…" 한 글자 자리는 남긴다.
    const shrinkMin = l.pieces.some((p) => p.shrink) ? 2 * CARD.unit : 0;
    // 고정 안내 줄은 라벨이 비어 있다. 넘쳤다는 표시가 빈 문자열(거짓)이 되지 않게 '안내'로 돌려준다.
    if (keep + flag + shrinkMin > valueWidth) return l.label || '안내';
  }
  if (cells(text.irreversible) * CARD.unit * (13 / 14) > cardWidth - CARD.padX * 2) return '안내';
  if (CARD.padX * 2 + CARD.stop + CARD.apart + approveWidth(text.action) > cardWidth) return '버튼';
  return null;
}

// ---- 정적 HTML ----

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

export const BAR_CSP = "default-src 'none'; style-src 'self'";

/** 무장 전(동작 버튼 흐림)·무장됨·무장 거부(동작 버튼 없음, [중지]는 있음). 문구(msg)는 값·동작 글자가 아니라서 다시 무장하지 않는다. */
export type BarMode = 'unarmed' | 'armed' | 'refused';
export const BAR_MESSAGES = {
  arming: '잠시 뒤 다시 눌러 주세요',
  dwell: '마우스를 조금 움직인 뒤 눌러 주세요',
  cursor: '마우스 커서가 보이게 한 뒤 눌러 주세요',
} as const;
export const ACTION_TEXT = '승인하고 발급';
export const ACTION_TEXT_DUP = '같은 건 기록을 확인했고 발급';
export const ACTION_TEXT_DUP_COMMITTED = '그래도 한 번 더 발급';
/** 비가역 한 줄(앱 고정 문구, 패키지 문자열 아님). */
export const IRREVERSIBLE_TEXT = '승인하면 바로 발급돼요. 발급한 세금계산서는 되돌릴 수 없어요.';
export const ATTEST_IRREVERSIBLE_TEXT = '확인하면 이 건을 발급 안 됨으로 기록해요. 되돌릴 수 없어요.';
export const STOP_TEXT = '중지';
export const ATTEST_STOP_TEXT = '닫기';
/** 카드 CSS가 버튼 폭을 미리 가진 동작 글자 전부(페이지에 style 속성을 쓰지 않는다: CSP style-src 'self'). */
export const CARD_ACTIONS = [ACTION_TEXT, ACTION_TEXT_DUP, ACTION_TEXT_DUP_COMMITTED, ATTEST_ACTION_TEXT] as const;

/** 카드의 앱 고정 글자: 동작 버튼, 비가역 한 줄, [중지] 자리. */
export interface CardText {
  action: string;
  irreversible: string;
  stop: string;
}
export const GATE_TEXT: CardText = { action: ACTION_TEXT, irreversible: IRREVERSIBLE_TEXT, stop: STOP_TEXT };
export const ATTEST_TEXT: CardText = { action: ATTEST_ACTION_TEXT, irreversible: ATTEST_IRREVERSIBLE_TEXT, stop: ATTEST_STOP_TEXT };
export const gateText = (action: string): CardText => ({ ...GATE_TEXT, action });

/**
 * 스크립트 없는 정적 페이지. 값은 이스케이프해 텍스트로만 넣는다. 버튼 둘은 그림일 뿐이고(포커스·클릭 처리 없음)
 * 판정은 main이 cardTargets 영역으로 한다. [중지]는 기본 포커스 모양(테두리 고리)으로 늘 그린다.
 */
export function buildCardHtml(lines: SummaryLine[], mode: BarMode, msg?: string, text: CardText = GATE_TEXT): string {
  const a = (CARD_ACTIONS as readonly string[]).indexOf(text.action);
  if (a < 0) throw new Error('card.action_unknown');
  const body = lines
    .map((l) => {
      const v = l.pieces.map((p) => `<span class="${p.shrink ? 'sh' : 'kp'}">${esc(p.text)}</span>`).join('');
      return `<div class="ln${l.note ? ' nt' : ''}"><span class="lb">${esc(l.label)}</span><span class="v">${v}</span>${l.flag ? `<span class="fl">${esc(l.flag)}</span>` : '<span></span>'}</div>`;
    })
    .join('');
  const act = mode === 'refused' ? '' : `<div class="btn ap" role="button">${esc(text.action)}</div>`;
  const attn = lines.some((l) => l.tone === 'attention') ? ' attn' : '';
  return `<!doctype html><html lang="ko"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${BAR_CSP}">
<link rel="stylesheet" href="bar.css"></head>
<body class="${mode}${attn} a${a}"><div class="lines">${body}</div><div class="irr">${esc(text.irreversible)}</div><div class="msg">${msg ? esc(msg) : ''}</div><div class="btn st" role="button">${esc(text.stop)}</div>${act}</body></html>`;
}

// ---- 색(앱 내장 팔레트, ADR-028 결정 7) ----

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

/** 외부 토큰을 검사해 카드 팔레트로. 하나라도 형식(#RRGGBB)·대비(4.5:1)에 실패하면 내장 팔레트 전체와 이유. */
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
 * 승인 카드 앱 내장 CSS. 직각에 가까운 모서리, 그림자 없음, 시스템 서체, 애니메이션 없음.
 * 치수는 CARD 상수 그대로라 cardHeight·cardTargets·overflowLine과 같은 식이다. 버튼 폭은 동작 글자마다(a0~a3) 미리 둔다.
 * 색은 barPalette를 통과한 값만 받는다. 바탕은 surface, 동작 버튼은 무장됨 accent·무장 전 accent-soft,
 * 중복 가능성·증언(attn)은 주의 색(attention·attention-soft)이고 카드 테두리도 주의 색이다.
 */
export function barCss(t: BarPalette): string {
  const theme = (c: BarColors) => `
body{background:${c.surface};color:${c.ink};box-shadow:inset 0 0 0 1px ${c['line-strong']}}
body.attn{box-shadow:inset 0 0 0 2px ${c.attention}}
.lb{color:${c['ink-3']}}
.fl{color:${c.accent};background:${c['accent-soft']}}
body.attn .fl{color:${c.attention};background:${c['attention-soft']}}
.st{background:${c.surface};color:${c.ink};box-shadow:inset 0 0 0 1px ${c['line-strong']};outline:2px solid ${c.accent};outline-offset:2px}
body.armed .ap{background:${c.accent};color:${c['on-accent']}}
body.unarmed .ap{background:${c['accent-soft']};color:${c.accent}}
body.armed.attn .ap{background:${c.attention};color:${c['on-accent']}}
body.unarmed.attn .ap{background:${c['attention-soft']};color:${c.attention}}`;
  const widths = CARD_ACTIONS.map((a, i) => {
    const w = approveWidth(a);
    return `body.a${i} .ap{width:${w}px}body.a${i} .st{right:${CARD.padX + w + CARD.apart}px}`;
  }).join('\n');
  const bottomMsg = CARD.padY + CARD.btn + CARD.btnGap;
  return `html,body{margin:0;height:100%;overflow:hidden}
body{position:relative;box-sizing:border-box;padding:${CARD.padY}px ${CARD.padX}px;
font-family:"Malgun Gothic","Apple SD Gothic Neo",system-ui,sans-serif;font-size:14px;line-height:${CARD.row}px;font-variant-numeric:tabular-nums;-webkit-font-smoothing:antialiased;user-select:none;cursor:default}
.ln{display:grid;grid-template-columns:${CARD.label}px minmax(0,1fr) auto;column-gap:${CARD.gap}px;align-items:center;white-space:nowrap;height:${CARD.row}px}
.lb{font-size:12px;line-height:${CARD.row}px;font-weight:500}
.v{display:flex;min-width:0}
.sh{overflow:hidden;text-overflow:ellipsis;min-width:2ch}
.kp{flex:none;white-space:pre}
.fl{font-size:12px;line-height:18px;font-weight:500;padding:0 6px;border-radius:6px}
.nt{font-size:12px}
.irr,.msg{position:absolute;left:${CARD.padX}px;right:${CARD.padX}px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.irr{bottom:${bottomMsg + CARD.msg}px;height:${CARD.irr}px;font-size:13px;line-height:${CARD.irr}px;font-weight:600}
.msg{bottom:${bottomMsg}px;height:${CARD.msg}px;font-size:12px;line-height:${CARD.msg}px}
.btn{position:absolute;bottom:${CARD.padY}px;height:${CARD.btn}px;box-sizing:border-box;display:flex;align-items:center;justify-content:center;border-radius:6px;font-size:15px;font-weight:700;letter-spacing:-0.01em;white-space:nowrap;overflow:hidden}
.st{width:${CARD.stop}px}
.ap{right:${CARD.padX}px}
${widths}
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

/** 카드가 포커스를 가졌을 때 [중지]로 받는 키(기본 포커스가 [중지]다, ADR-021 결정 7 원칙 3). 승인 키는 없다. */
export const STOP_KEYS: readonly string[] = ['Enter', ' ', 'Escape'];

/**
 * 승인 카드 입력 판정. main이 카드 뷰의 before-mouse-event로 관찰한 값만 넣는다(좌표는 카드 기준 DIP, 시각은 단조 시계).
 * 아래의 "바 안"은 [승인하고 발급] 영역(setTargets의 approve) 안이다. 카드의 다른 자리는 바깥으로 본다(결정 7 원칙 4).
 * [중지] 영역은 stop()이 따로 본다: 무장을 기다리지 않고 down → up이 같은 영역 안이면 중지다.
 * - 무장 지연: 무장 사건(rearm) 뒤 ARM_DELAY_MS 동안 입력 무시. 그 사이 mouseDown이면 지연을 다시 시작한다.
 * - 머무름: 마지막 mouseLeave·무장 사건 뒤 바 안에서 처음 실제로 움직인 때부터 DWELL_MS가 지났거나,
 *   무장 사건 때부터 커서가 바 안에 멈춰 있었을 때만 mouseDown을 인정한다. "무장 사건 때 바 안"은 main이
 *   OS 커서 위치로 정해 rearm에 넘긴다(앞 게이트에서 남은 추적 상태를 믿지 않는다). 그 예외는 mouseDown 때
 *   OS 커서가 무장 사건 때와 같은 자리일 때만 쓴다(cursorUnmoved). 바를 덮은 알림 위에서 커서가 움직였다면
 *   바는 나감을 받지 못하므로, 위치 비교로 "멈춰 있었음"을 확인한다.
 * - 승인 = [승인하고 발급] 영역 안에서 왼쪽 mouseDown → mouseUp.
 */
export class BarGate {
  private armAt = Number.POSITIVE_INFINITY;
  private pressed = false;
  private inside = false;
  private stillSinceArm = false;
  private movedAt: number | null = null;
  private activatedAt: number | null = null;
  private blocked = false;
  private target: Box = { x: 0, y: 0, width: 0, height: 0 };
  private stopTarget: Box = { x: 0, y: 0, width: 0, height: 0 };
  private stopPressed = false;
  private readonly armDelayMs: number;

  constructor(armDelayMs = ARM_DELAY_MS) {
    this.armDelayMs = armDelayMs;
  }

  /** 두 판정 영역(카드 기준 DIP). main이 cardTargets로 정한다. */
  setTargets(t: CardTargets): void {
    this.target = { ...t.approve };
    this.stopTarget = { ...t.stop };
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
   * 그 밖에는 첫 클릭을 "앞으로 가져오기"로만 받는다: 눌린 상태를 취소하고 무장 지연을 다시 센다(ADR-027 결정 5).
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
    return inBox(this.target, x, y);
  }

  /** [중지] 판정. 무장·머무름·커서 위장과 상관없다(안전한 실패). 중지가 성립하면 true. */
  stop(ev: MouseIn): boolean {
    if (ev.button !== 'left' || (ev.type !== 'mouseDown' && ev.type !== 'mouseUp')) return false;
    const inside = inBox(this.stopTarget, ev.x, ev.y);
    if (ev.type === 'mouseDown') {
      this.stopPressed = inside;
      return false;
    }
    const ok = this.stopPressed && inside;
    this.stopPressed = false;
    return ok;
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
      if (ev.button === 'left' && !this.within(ev.x, ev.y)) this.pressed = false;
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

const canonAttest = (a: Omit<LocalAttestation, 'mac'>) => cbor([a.v, a.intentId, a.stepId, a.attestReqId, a.attestNonce, a.summaryHash, a.kind, a.exp]);

/**
 * LocalAttestation v1(ADR-021 결정 5). 증언 바가 띄운 그 증언 요청으로만 발급한다. HMAC 문맥이 승인과 달라(SAX-local-attest-v1)
 * 증언이 승인 근거로 쓰이지 않는다. 엔진은 키가 없어 게이트 포트 출처와 요청 일치·exp만 본다(checkAttestation).
 */
export function issueLocalAttestation(key: Uint8Array, req: Pick<AttestRequest, 'intentId' | 'stepId' | 'attestReqId' | 'attestNonce' | 'summaryHash'>, ttlMs = LOCAL_ATTEST_TTL_MS, now = Date.now()): LocalAttestation {
  const body = { v: 1 as const, intentId: req.intentId, stepId: req.stepId, attestReqId: req.attestReqId, attestNonce: req.attestNonce, summaryHash: req.summaryHash, kind: 'not_committed' as const, exp: now + ttlMs };
  return { ...body, mac: createHmac('sha256', key).update(LOCAL_ATTEST_CONTEXT).update(canonAttest(body)).digest('base64url') };
}

export function verifyLocalAttestation(key: Uint8Array, a: LocalAttestation, now = Date.now()): boolean {
  if (a?.v !== 1 || a.kind !== 'not_committed' || !(a.exp >= now)) return false;
  let expected: Buffer;
  try {
    expected = createHmac('sha256', key).update(LOCAL_ATTEST_CONTEXT).update(canonAttest(a)).digest();
  } catch {
    return false;
  }
  const got = Buffer.from(String(a.mac), 'base64url');
  return got.length === expected.length && timingSafeEqual(got, expected);
}
