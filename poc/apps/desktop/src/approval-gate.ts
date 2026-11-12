import { createHmac, timingSafeEqual } from 'node:crypto';
import { domainToASCII } from 'node:url';
import { cbor, LOCAL_APPROVAL_TTL_MS, LOCAL_ATTEST_CONTEXT, LOCAL_ATTEST_TTL_MS, type AttestRequest, type GateRequest, type LocalApproval, type LocalAttestation, type Presence } from '@sax/engine/gate';

// ADR-021 결정 1: 로컬 비가역 승인은 main 소유 승인 바(메인 창 자식 WebContentsView, 스크립트 없음)에서
// main이 직접 관찰한 클릭으로만 인정한다. 이 파일은 Electron 없이 시험할 수 있는 판정 로직과 정적 HTML 생성기다.
// 게이트 요청 모양·D03 해시는 엔진과 같은 @sax/engine/gate를 쓴다.

export type { AttestRequest, GateRequest, LocalApproval, LocalAttestation };

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
  /** 금액 칸(합계 크게 + 그 아래 공급가액·세액). 카드 맨 위 값이고 값 줄 수에 들지 않는다. */
  amount?: boolean;
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

/** 같은 업무 키의 원장 상태 중 발급됐거나 발급됐을 수 있는 것. 이것이 있으면 "이전 시도는 발급되지 않았어요"보다 먼저 보인다. */
export const ISSUED_OR_UNKNOWN = ['committed', 'in_doubt', 'armed', 'dispatched', 'observed_manual'];

/** $dup.businessKey 값(원장 상태 목록)에 발급됐거나 모르는 건이 있는가. */
export function dupMayBeIssued(f: Map<string, string>): boolean {
  return (f.get('$dup.businessKey') ?? '').split(',').some((s) => ISSUED_OR_UNKNOWN.includes(s));
}

export type DupState = { flag: string; tone: 'normal' | 'attention'; action: string };

/**
 * 중복 경고 표시(D02 §7, ADR-027 결정 3). 칸이 하나라 가장 위험한 것을 고른다:
 * 발급 확정 있음 → 발급 여부 모름 → 이전 시도 미발급 → 그 밖의 같은 건 기록 → 다른 PC 확인 불가. 카드에는 해당하는 경고를 모두 둔다.
 * 발급됐거나 모르는 건은 주의 색이다. 첫 클릭이 명시 확인이라는 ADR-021 규칙은 그대로다.
 */
export function dupState(f: Map<string, string>): DupState | undefined {
  const states = (f.get('$dup.businessKey') ?? '').split(',');
  if (states.includes('committed')) return { flag: '이미 발급됨(승인번호 있음)', tone: 'attention', action: ACTION_TEXT_DUP_COMMITTED };
  if (dupMayBeIssued(f)) return { flag: '발급 여부 확인 안 됨', tone: 'attention', action: ACTION_TEXT_DUP };
  if (f.get('$dup.priorNotCommitted') === 'true') return { flag: '이전 시도는 발급되지 않았어요', tone: 'normal', action: ACTION_TEXT_DUP };
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

/** 서류 종류별 값 줄 수(금액 칸 제외, 앱 내장 표, ADR-021 결정 7). 카드 높이는 이 줄 수로만 정한다(렌더러 보고 없음). */
export const CARD_ROWS = { 'H-01': 4, cert: 4 } as const;

/**
 * H-01 승인 카드 줄(ADR-021 결정 7): 금액 칸(합계 / 공급가액 · 세액), 값 줄 공급받는자(상호 · 사업자번호) / 품목 / 작성일자 / 받는 이메일.
 * 값은 해시한 게이트 요청 fields에서만 고른다(엔진 readback, V-03h). 값 줄 수는 CARD_ROWS['H-01']로 늘 같다.
 * 작성일자가 KST 오늘과 다르면 "오늘 아님" 표시를 붙인다. 중복 경고는 합계 끝 표시 칸에 가장 위험한 것 하나를 둔다.
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
    { label: '합계', amount: true, pieces: [{ text: won(f.get('totalAmount')!) }, { text: `공급가액 ${won(f.get('supplyAmount')!)} · 세액 ${won(f.get('taxAmount')!)}` }], flag: dup?.flag, tone: dup?.tone },
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

/** 홈택스 민원증명 승인 카드 줄(H-03·H-04·H-08·H-09 공통, 팀장 결정 2026-11-09). 요약 칸은 엔진 APPROVAL_SUMMARIES 'cert.confirm'과 같다. */
export const CERT_SUMMARY_LABELS = [
  ['certDoc', '서류'],
  ['certPurpose', '사용 용도'],
  ['certSubmitTo', '제출처'],
  ['rrnDisclosure', '주민번호 공개'],
] as const;

/**
 * 민원증명 카드 줄: 서류 / 사용 용도 / 제출처 / 주민번호 공개. 값은 해시한 게이트 요청 fields에서만 고른다. 값 줄 수는 CARD_ROWS.cert로 늘 같다.
 * 중복 경고는 첫 줄 끝 표시 칸에 가장 위험한 것 하나를 둔다(H-01과 같은 규칙).
 */
export function summarizeCert(req: Pick<GateRequest, 'fields'>): SummaryLine[] | ArmRefusal {
  const f = new Map(req.fields.map((x) => [x.fieldKey, x.value]));
  if (f.size !== req.fields.length) return { reason: 'duplicate' };
  for (const [k, label] of CERT_SUMMARY_LABELS) if (!f.get(k)) return { reason: 'missing', label };
  for (const [k, label] of CERT_SUMMARY_LABELS) if (UNSAFE_CHARS.test(f.get(k)!)) return { reason: 'unsafe', label };
  const dup = dupState(f);
  return CERT_SUMMARY_LABELS.map(([k, label], i) => ({
    label,
    pieces: [{ text: f.get(k)!, shrink: k !== 'rrnDisclosure' }],
    ...(i === 0 && dup ? { flag: dup.flag, tone: dup.tone } : {}),
  }));
}

// ---- InDoubt 증언 바(ADR-021 결정 5) ----

/** 증언 바 동작 글자. 승인과 다른 말·다른 색(황토)이라 승인하던 습관대로 누른 클릭이 증언이 되지 않게 한다. */
export const ATTEST_ACTION_TEXT = '홈택스 발급목록에 없음을 확인했어요';
/** E-13 고정 문구. 증언 바의 정적 HTML에 늘 넣는다(D03 §2 InDoubt 행). */
export const ATTEST_FIXED = '발급목록 반영이 늦을 수 있습니다';
const PORTAL_NAME: Record<string, string> = { hometax: '홈택스', gov24: '정부24', sminfo: '중소기업현황정보시스템', insure4: '4대보험 정보연계센터' };
/** 정지 하향으로 조회 없이 받는 증언(manualCheck)에 더하는 문구(ADR-021 개정 메모). */
export const attestManualText = (portal: string) => `${PORTAL_NAME[portal] ?? '홈택스'} 발급목록을 직접 확인한 뒤 답해 주세요`;

/** 증언 카드 값 줄 수(금액 칸 제외): 공급받는자 + E-13 고정 줄(정지 하향이면 직접 확인 줄 하나 더). */
export const attestRows = (manualCheck?: boolean) => (manualCheck === true ? 3 : 2);

/**
 * 증언 카드 줄: 금액 칸(합계) / 공급받는자(상호 · 사업자번호). 엔진이 보낸 ATTEST_SUMMARY_KEYS 3칸에서만 고른다(그 해시가 summaryHash).
 * 모두 주의 색이고, 그 아래 E-13 고정 줄(정지 하향이면 직접 확인 줄도)을 둔다. 값 줄 수는 attestRows와 같다.
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
    { label: '합계', amount: true, pieces: [{ text: won(f.get('totalAmount')!) }], tone: 'attention' },
    { label: '공급받는자', pieces: [{ text: f.get('counterpartName')!, shrink: true }, { text: ` · ${bizNo(f.get('counterpartBizNo')!)}` }], tone: 'attention' },
    { label: '', pieces: [{ text: ATTEST_FIXED }], tone: 'attention', note: true },
  ];
  if (req.manualCheck === true) lines.push({ label: '', pieces: [{ text: attestManualText(req.portal) }], tone: 'attention', note: true });
  return lines;
}

// ---- 카드 치수·폭 어림(ADR-021 결정 7, 디자인 시스템 ApprovalCard) ----

/**
 * 승인 카드 안의 고정 치수(DIP). 높이는 값 줄 수로만(cardHeight), 버튼 자리는 이 상수와 카드 폭으로만(cardTargets) 정한다.
 * cardCss가 같은 상수로 그리고, main은 이 값으로 클릭을 판정한다. 렌더러가 보고하는 값은 쓰지 않는다.
 * 위에서 아래로: 머리 줄 · 금액(합계 + 공급가액·세액) · 값 줄 · 비가역 한 줄 · 버튼 줄([중지] · 간격 · [동작]).
 */
export const CARD = {
  padX: 20,
  padY: 16,
  head: 24,
  headGap: 8,
  total: 30,
  sub: 22,
  amountGap: 8,
  row: 22,
  label: 76,
  gap: 12,
  flagPad: 16,
  /** 14px 글자 한 칸 폭의 보수적 어림. 한글 등 동아시아 문자는 두 칸. */
  unit: 8.5,
  /** 비가역 한 줄(13px) 위 간격·높이 */
  irrGap: 10,
  irr: 20,
  btnGap: 14,
  btn: 44,
  /** [중지] 폭과 두 버튼 사이 앱 상수 간격(결정 7 원칙 4, ApprovalCard 112·48 DIP) */
  stop: 112,
  apart: 48,
  /** 동작 글자(16px 굵게) 한 칸 어림과 좌우 안쪽 여백 */
  btnUnit: 10,
  btnPadX: 20,
} as const;

const wide = /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦]/u;
export const cells = (s: string) => [...s].reduce((n, c) => n + (wide.test(c) ? 2 : 1), 0);

/** 값 줄 수로 정한 카드 높이(금액 칸·머리 줄·비가역 줄·버튼 줄은 늘 같다). */
export const cardHeight = (rows: number) =>
  CARD.padY * 2 + CARD.head + CARD.headGap + CARD.total + CARD.sub + CARD.amountGap + rows * CARD.row + CARD.irrGap + CARD.irr + CARD.btnGap + CARD.btn;

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

/** 동작 글자가 들어가는 데 필요한 버튼 폭(어림). */
export const approveWidth = (action: string) => Math.ceil(cells(action) * CARD.btnUnit) + CARD.btnPadX * 2;

/** 두 버튼 자리: 왼쪽 아래 [중지](112), 앱 상수 간격(48), 오른쪽 [동작](남은 폭 전부). */
export function cardTargets(width: number, height: number): CardTargets {
  const y = height - CARD.padY - CARD.btn;
  const ax = CARD.padX + CARD.stop + CARD.apart;
  return { approve: { x: ax, y, width: Math.max(0, width - CARD.padX - ax), height: CARD.btn }, stop: { x: CARD.padX, y, width: CARD.stop, height: CARD.btn } };
}

/** 점이 영역 안인가(오른쪽·아래 경계는 밖). */
export const inBox = (b: Box, x: number, y: number) => x >= b.x && y >= b.y && x < b.x + b.width && y < b.y + b.height;

/**
 * 줄이지 않는 조각·비가역 한 줄·동작 글자가 카드 폭 안에 들어가는지 어림한다. 넘친 줄의 라벨('안내'·'버튼' 포함), 다 들어가면 null.
 */
export function overflowLine(lines: SummaryLine[], cardWidth: number, text: CardText = GATE_TEXT): string | null {
  const inner = cardWidth - CARD.padX * 2;
  // cardCss 배치와 같은 식: 줄 안 [라벨 | 간격 | 값 | 간격 | 표시]. 간격은 둘이다.
  const valueWidth = inner - CARD.label - CARD.gap * 2;
  for (const l of lines) {
    const flag = l.flag ? cells(l.flag) * CARD.unit * (12 / 14) + CARD.flagPad : 0;
    if (l.amount) {
      // 합계(24px) + 표시, 그 아래 공급가액·세액(14px). 금액은 줄이지 않는다.
      const [total, ...rest] = l.pieces;
      if (cells(total?.text ?? '') * CARD.unit * (24 / 14) + flag + CARD.gap > inner) return l.label;
      if (rest.reduce((n, p) => n + cells(p.text), 0) * CARD.unit > inner) return l.label;
      continue;
    }
    const keep = l.pieces.filter((p) => !p.shrink).reduce((n, p) => n + cells(p.text), 0) * CARD.unit;
    // 줄일 수 있는 조각도 "…" 한 글자 자리는 남긴다.
    const shrinkMin = l.pieces.some((p) => p.shrink) ? 2 * CARD.unit : 0;
    // 고정 안내 줄은 라벨이 비어 있다. 넘쳤다는 표시가 빈 문자열(거짓)이 되지 않게 '안내'로 돌려준다.
    if (keep + flag + shrinkMin > valueWidth) return l.label || '안내';
  }
  if (cells(text.irreversible) * CARD.unit * (13 / 14) > inner) return '안내';
  if (approveWidth(text.action) > cardTargets(cardWidth, 0).approve.width) return '버튼';
  return null;
}

// ---- 정적 HTML ----

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

export const BAR_CSP = "default-src 'none'; style-src 'self'";

/**
 * 무장 안 됨(동작 버튼 흐림, 커서 위장 중일 때만)·무장됨·무장 거부(동작 자리에 거부 사유, [중지]는 그대로).
 * 카드는 뜨자마자 무장됨이다. 기다리는 시간은 없다(ADR-021 개정 2026-11-09: 무장 지연 600ms·머무름 150ms 철회).
 */
export type BarMode = 'unarmed' | 'armed' | 'refused';
export const BAR_MESSAGES = {
  cursor: '마우스 커서가 보이게 한 뒤 눌러 주세요',
} as const;
/**
 * 창을 앞으로 가져온 클릭이 승인 버튼 위였다(F-11): 그 클릭은 창 활성화로 쓰여 승인이 아니다(macOS는 첫 클릭을 페이지에 주지 않고,
 * 바는 활성화 때 누르던 클릭을 취소한다). 무장·결속 규칙은 그대로이고 문구만 보인다.
 */
export const BAR_AGAIN_TEXT = '창을 앞으로 가져오는 클릭이었어요. 한 번 더 눌러 주세요';
export const ACTION_TEXT = '승인하고 발급';
export const ACTION_TEXT_DUP = '같은 건 기록을 확인했고 발급';
export const ACTION_TEXT_DUP_COMMITTED = '그래도 한 번 더 발급';
/** 비가역 한 줄(서류 종류별 앱 고정 문구, 패키지 문자열 아님). 받는 이메일 유무로 둘 중 하나다. */
export const IRREVERSIBLE_TEXT = '승인하면 바로 발급되고 메일로 가요. 되돌릴 수 없어요.';
export const IRREVERSIBLE_TEXT_NO_MAIL = '승인하면 바로 발급돼요. 메일은 보내지 않아요. 되돌릴 수 없어요.';
export const ATTEST_IRREVERSIBLE_TEXT = '확인하면 이 건을 발급 안 됨으로 기록해요. 되돌릴 수 없어요.';
/** 민원증명 비가역 한 줄(팀장 결정 2026-11-09) */
export const CERT_IRREVERSIBLE_TEXT = '발급하면 홈택스 발급 이력에 남습니다. 되돌릴 수 없어요.';
export const STOP_TEXT = '중지';
export const ATTEST_STOP_TEXT = '닫기';
const DOC_TITLE = '세금계산서';

/** 카드의 앱 고정 글자: 머리 줄(서류 종류 · 상호, 상태 칩), 동작 버튼, 비가역 한 줄, [중지] 자리. 상호만 fields 값이다. */
export interface CardText {
  title: string;
  chip: string;
  action: string;
  irreversible: string;
  stop: string;
}
const title = (name?: string) => (name ? `${DOC_TITLE} · ${name}` : DOC_TITLE);
export const GATE_TEXT: CardText = { title: DOC_TITLE, chip: '승인 대기', action: ACTION_TEXT, irreversible: IRREVERSIBLE_TEXT, stop: STOP_TEXT };
export const ATTEST_TEXT: CardText = { title: DOC_TITLE, chip: '확인 필요', action: ATTEST_ACTION_TEXT, irreversible: ATTEST_IRREVERSIBLE_TEXT, stop: ATTEST_STOP_TEXT };
/** 게이트 카드 글자. name은 검사를 지난 fields의 상호(없으면 서류 종류만), mail은 받는 이메일 유무. */
export const gateText = (action: string, name?: string, mail = true): CardText => ({ ...GATE_TEXT, title: title(name), action, irreversible: mail ? IRREVERSIBLE_TEXT : IRREVERSIBLE_TEXT_NO_MAIL });
export const attestText = (name?: string): CardText => ({ ...ATTEST_TEXT, title: title(name) });
/** 민원증명 게이트 카드 글자. 머리 줄은 서류 이름(사업자등록증명 등, 앱 내장)이다 */
export const certGateText = (docName: string, action: string): CardText => ({ title: docName, chip: '승인 대기', action, irreversible: CERT_IRREVERSIBLE_TEXT, stop: STOP_TEXT });

/**
 * 스크립트 없는 정적 페이지. 값은 이스케이프해 텍스트로만 넣는다. 버튼 둘은 그림일 뿐이고(포커스·클릭 처리 없음)
 * 판정은 main이 cardTargets 영역으로 한다. [중지]는 기본 포커스 모양(focus-ring)으로 늘 그린다.
 * 무장 거부면 동작 자리에 거부 사유를 무채색으로 그리고, 그 밖의 문구(다시 눌러 주세요 등)는 동작 글자 아래 작은 줄이다.
 */
export function buildCardHtml(lines: SummaryLine[], mode: BarMode, msg?: string, text: CardText = GATE_TEXT): string {
  const flag = (l: SummaryLine) => (l.flag ? `<span class="fl">${esc(l.flag)}</span>` : '');
  const amount = lines.find((l) => l.amount);
  const am = amount
    ? `<div class="am"><span class="tot">${esc(amount.pieces[0]?.text ?? '')}</span>${flag(amount)}</div><div class="sub">${amount.pieces
        .slice(1)
        .map((p) => esc(p.text))
        .join('')}</div>`
    : '<div class="am"></div><div class="sub"></div>';
  const rows = lines
    .filter((l) => !l.amount)
    .map((l) => {
      const v = l.pieces.map((p) => `<span class="${p.shrink ? 'sh' : 'kp'}">${esc(p.text)}</span>`).join('');
      return `<div class="ln${l.note ? ' nt' : ''}"><span class="lb">${esc(l.label)}</span><span class="v">${v}</span>${flag(l) || '<span></span>'}</div>`;
    })
    .join('');
  const act =
    mode === 'refused'
      ? `<div class="btn ap rf" role="button" aria-disabled="true">${esc(msg ?? '')}</div>`
      : `<div class="btn ap" role="button"><span>${esc(text.action)}</span>${msg ? `<small>${esc(msg)}</small>` : ''}</div>`;
  const attn = lines.some((l) => l.tone === 'attention') ? ' attn' : '';
  return `<!doctype html><html lang="ko"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${BAR_CSP}">
<link rel="stylesheet" href="bar.css"></head>
<body class="${mode}${attn}"><div class="hd"><span class="tt">${esc(text.title)}</span><span class="cp">${esc(text.chip)}</span></div>${am}<div class="rows">${rows}</div><div class="irr">${esc(text.irreversible)}</div><div class="btn st" role="button">${esc(text.stop)}</div>${act}</body></html>`;
}

// ---- 색(앱 내장 팔레트, ADR-028 결정 7) ----

export const BAR_COLOR_KEYS = ['accent', 'on-accent', 'accent-soft', 'ink', 'ink-3', 'surface', 'canvas', 'line-strong', 'attention', 'attention-soft', 'focus-ring'] as const;
export type BarColors = Record<(typeof BAR_COLOR_KEYS)[number], string>;
export type BarPalette = { light: BarColors; dark: BarColors };

/** 디자인 시스템 v1.2 tokens.json과 같은 값. 외부 토큰이 검사에 실패하면 이것 전체를 쓴다. */
export const BAR_PALETTE_DEFAULT: BarPalette = {
  light: { accent: '#2A4F9E', 'on-accent': '#FFFFFF', 'accent-soft': '#E8EEF9', ink: '#16191D', 'ink-3': '#646B76', surface: '#FFFFFF', canvas: '#F5F6F7', 'line-strong': '#878E97', attention: '#8A5A0B', 'attention-soft': '#F8EEDC', 'focus-ring': '#2A4F9E' },
  dark: { accent: '#8EAAF0', 'on-accent': '#0B1226', 'accent-soft': '#1B2540', ink: '#E9EBEE', 'ink-3': '#8B939D', surface: '#171A1E', canvas: '#101215', 'line-strong': '#6B737D', attention: '#E0AE55', 'attention-soft': '#2E2410', 'focus-ring': '#8EAAF0' },
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
 * 승인 카드 앱 내장 CSS(디자인 시스템 ApprovalCard). 시스템 서체, 그림자·애니메이션 없음.
 * 뷰는 불투명한 사각형이고 바탕은 canvas, 그 안의 카드 면은 surface에 모서리 12다(둥근 모서리는 그림일 뿐, 판정은 두 버튼 사각형).
 * 카드 테두리 1.5px: 승인 대기 accent, 증언·같은 건 확정(attn) attention, 무장 거부 line-strong.
 * 치수는 CARD 상수 그대로라 cardHeight·cardTargets·overflowLine과 같은 식이다. 색은 barPalette를 통과한 값만 받는다.
 */
export function barCss(t: BarPalette): string {
  const theme = (c: BarColors) => `
html{background:${c.canvas}}
body{background:${c.surface};color:${c.ink};box-shadow:inset 0 0 0 1.5px ${c.accent}}
body.attn{box-shadow:inset 0 0 0 1.5px ${c.attention}}
body.refused{box-shadow:inset 0 0 0 1.5px ${c['line-strong']}}
.lb{color:${c['ink-3']}}
.cp{color:${c.accent}}
body.attn .cp{color:${c.attention}}
.fl{color:${c.accent};background:${c['accent-soft']}}
body.attn .fl{color:${c.attention};background:${c['attention-soft']}}
.st{background:${c.surface};color:${c.ink};box-shadow:inset 0 0 0 1px ${c['line-strong']};outline:2px solid ${c['focus-ring']};outline-offset:2px}
body.armed .ap{background:${c.accent};color:${c['on-accent']}}
body.unarmed .ap{background:${c['accent-soft']};color:${c.accent}}
body.armed.attn .ap{background:${c.attention};color:${c['on-accent']}}
body.unarmed.attn .ap{background:${c['attention-soft']};color:${c.attention}}
body .ap.rf{background:${c.surface};color:${c.ink};box-shadow:inset 0 0 0 1px ${c['line-strong']}}`;
  const bottomIrr = CARD.padY + CARD.btn + CARD.btnGap;
  return `html,body{margin:0;height:100%;overflow:hidden}
body{position:relative;box-sizing:border-box;padding:${CARD.padY}px ${CARD.padX}px;border-radius:12px;
font-family:"Malgun Gothic","Apple SD Gothic Neo",system-ui,sans-serif;font-size:14px;line-height:${CARD.row}px;font-variant-numeric:tabular-nums;-webkit-font-smoothing:antialiased;user-select:none;cursor:default}
.hd{display:flex;align-items:center;column-gap:${CARD.gap}px;height:${CARD.head}px;margin-bottom:${CARD.headGap}px}
.tt{flex:1;min-width:0;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.cp{flex:none;box-sizing:border-box;height:${CARD.head}px;padding:0 10px;border:1px solid currentColor;border-radius:999px;font-size:12px;line-height:${CARD.head - 2}px;font-weight:500}
.am{display:flex;align-items:center;column-gap:${CARD.gap}px;height:${CARD.total}px}
.tot{font-size:24px;line-height:${CARD.total}px;font-weight:600;letter-spacing:-0.015em;white-space:pre}
.am .fl{margin-left:auto}
.sub{height:${CARD.sub}px;margin-bottom:${CARD.amountGap}px;white-space:pre;overflow:hidden}
.ln{display:grid;grid-template-columns:${CARD.label}px minmax(0,1fr) auto;column-gap:${CARD.gap}px;align-items:center;white-space:nowrap;height:${CARD.row}px}
.lb{font-size:12px;line-height:${CARD.row}px;font-weight:500}
.v{display:flex;min-width:0}
.sh{overflow:hidden;text-overflow:ellipsis;min-width:2ch}
.kp{flex:none;white-space:pre}
.fl{font-size:12px;line-height:18px;font-weight:500;padding:0 6px;border:1px solid currentColor;border-radius:6px}
.nt{font-size:12px}
.irr{position:absolute;left:${CARD.padX}px;right:${CARD.padX}px;bottom:${bottomIrr}px;height:${CARD.irr}px;font-size:13px;line-height:${CARD.irr}px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.btn{position:absolute;bottom:${CARD.padY}px;height:${CARD.btn}px;box-sizing:border-box;display:flex;flex-direction:column;align-items:center;justify-content:center;border-radius:8px;font-size:16px;line-height:22px;font-weight:700;letter-spacing:-0.01em;white-space:nowrap;overflow:hidden}
.btn small{font-size:12px;line-height:14px;font-weight:500;letter-spacing:0}
.st{left:${CARD.padX}px;width:${CARD.stop}px}
.ap{left:${CARD.padX + CARD.stop + CARD.apart}px;right:${CARD.padX}px}
.ap.rf{font-size:13px;font-weight:600}
${theme(t.light)}
@media (prefers-color-scheme: dark){${theme(t.dark)}}`;
}

// ---- 입력 판정 ----

export interface MouseIn {
  type: string;
  x: number;
  y: number;
  button?: string;
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
 * 승인 카드 입력 판정. main이 카드 뷰의 before-mouse-event로 관찰한 값만 넣는다(좌표는 카드 기준 DIP).
 * 아래의 "바 안"은 [승인하고 발급] 영역(setTargets의 approve) 안이다. 카드의 다른 자리는 바깥으로 본다(결정 7 원칙 4).
 * [중지] 영역은 stop()이 따로 본다: down → up이 같은 영역 안이면 중지다.
 * - 승인 = [승인하고 발급] 영역 안에서 왼쪽 mouseDown → mouseUp. 카드가 뜬 직후의 클릭도 승인이다(기다림·머무름 없음,
 *   ADR-021 개정 2026-11-09). 누르는 사이 바를 나가거나 창 수준 사건(reset)이 오면 그 클릭은 취소된다.
 * - 커서 위장(대화 화면 커서 none·custom) 중에는 승인하지 않고 이유를 알린다.
 */
export class BarGate {
  private pressed = false;
  private blocked = false;
  private target: Box = { x: 0, y: 0, width: 0, height: 0 };
  private stopTarget: Box = { x: 0, y: 0, width: 0, height: 0 };
  private stopPressed = false;

  /** 두 판정 영역(카드 기준 DIP). main이 cardTargets로 정한다. */
  setTargets(t: CardTargets): void {
    this.target = { ...t.approve };
    this.stopTarget = { ...t.stop };
  }

  /**
   * 창 수준 사건: 카드가 뜸, 요약·동작 글자·위치가 바뀜, 창 이동·크기·표시·복원·활성화, 배율 변경, 커서 위장 해제.
   * 누르던 승인 클릭만 취소한다. 기다리는 시간은 두지 않는다.
   */
  reset(): void {
    this.pressed = false;
  }

  /** 대화 화면 커서가 none·custom이면 무장하지 않는다(커서 위장). */
  setCursorBlocked(blocked: boolean): void {
    this.blocked = blocked;
    if (blocked) this.pressed = false;
  }

  get cursorBlocked(): boolean {
    return this.blocked;
  }

  armed(): boolean {
    return !this.blocked;
  }

  private within(x: number, y: number): boolean {
    return inBox(this.target, x, y);
  }

  /** [중지] 판정. 커서 위장과 상관없다(안전한 실패). 중지가 성립하면 true. */
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

  /** 나감만 기록한다(누르던 클릭 취소). 바가 숨었거나 무장을 거부한 동안에도 부른다. */
  track(ev: MouseIn): void {
    if (ev.type === 'mouseLeave' || ((ev.type === 'mouseMove' || ev.type === 'mouseEnter') && !this.within(ev.x, ev.y))) this.pressed = false;
  }

  mouse(ev: MouseIn): GateResult {
    if (ev.type !== 'mouseDown' && ev.type !== 'mouseUp') {
      this.track(ev);
      return null;
    }
    if (ev.button !== 'left') return null;
    if (ev.type === 'mouseDown') {
      this.pressed = false;
      if (!this.within(ev.x, ev.y)) return null;
      if (this.blocked) return { kind: 'refused', reason: 'cursor' };
      this.pressed = true;
      return null;
    }
    const ok = this.pressed && !this.blocked && this.within(ev.x, ev.y);
    this.pressed = false;
    return ok ? { kind: 'approve' } : null;
  }

  /** 키 입력. KEYBOARD_APPROVAL이 꺼져 있으면 어떤 키도 승인이 아니다. */
  key(ev: KeyIn): GateResult {
    if (!KEYBOARD_APPROVAL || this.blocked || ev.type !== 'keyDown') return null;
    return ev.alt && !ev.control && !ev.meta && (ev.key.toLowerCase() === 'y' || ev.key === 'ㅛ') ? { kind: 'approve' } : null;
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
