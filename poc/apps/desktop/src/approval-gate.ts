import { createHmac, timingSafeEqual } from 'node:crypto';
import { domainToASCII } from 'node:url';
import { cbor, LOCAL_APPROVAL_TTL_MS, LOCAL_ATTEST_CONTEXT, LOCAL_ATTEST_TTL_MS, type AttestRequest, type GateRequest, type LocalApproval, type LocalAttestation, type Presence } from '@sax/engine/gate';


export type { AttestRequest, GateRequest, LocalApproval, LocalAttestation };

interface Piece {
  text: string;
  shrink?: boolean;
}
export interface SummaryLine {
  label: string;
  pieces: Piece[];
  flag?: string;
  tone?: 'normal' | 'attention';
  note?: boolean;
  amount?: boolean;
}

const won = (v: string) => `${v.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}원`;
const bizNo = (v: string) => `${v.slice(0, 3)}-${v.slice(3, 5)}-${v.slice(5)}`;

export const UNSAFE_CHARS = /[\p{Cc}\p{Cf}\p{Default_Ignorable_Code_Point}\u2028\u2029\u2800]/u;

type ArmRefusal = { reason: 'missing' | 'unsafe' | 'overflow'; label: string } | { reason: 'hash' | 'duplicate' };

export const REFUSAL_TEXT = {
  missing: (l: string) => `${l} 값이 없어 승인할 수 없어요`,
  unsafe: (l: string) => `${l} 칸에 쓸 수 없는 문자가 있어요. 그 칸을 고쳐 주세요`,
  overflow: (l: string) => `창을 넓혀 주세요. ${l}`,
  tall: () => '창을 높여 주세요. 승인 카드가 다 보이지 않아요',
  hash: () => '값 대조가 맞지 않아 승인할 수 없어요',
  duplicate: () => '같은 항목이 두 번 들어 있어 승인할 수 없어요',
};

export function refusalText(r: ArmRefusal): string {
  return 'label' in r ? REFUSAL_TEXT[r.reason](r.label) : REFUSAL_TEXT[r.reason]();
}

export const attestRefusalText = (text: string) => text.replace('승인할 수 없어요', '확인 결과를 받을 수 없어요');

export const ISSUED_OR_UNKNOWN = ['committed', 'in_doubt', 'armed', 'dispatched', 'observed_manual'];

function dupMayBeIssued(f: Map<string, string>): boolean {
  return (f.get('$dup.businessKey') ?? '').split(',').some((s) => ISSUED_OR_UNKNOWN.includes(s));
}

type DupState = { flag: string; tone: 'normal' | 'attention'; action: string };

function dupState(f: Map<string, string>): DupState | undefined {
  const states = (f.get('$dup.businessKey') ?? '').split(',');
  if (states.includes('committed')) return { flag: '이미 발급됨(승인번호 있음)', tone: 'attention', action: ACTION_TEXT_DUP_COMMITTED };
  if (dupMayBeIssued(f)) return { flag: '발급 여부 확인 안 됨', tone: 'attention', action: ACTION_TEXT_DUP };
  if (f.get('$dup.priorNotCommitted') === 'true') return { flag: '이전 시도는 발급되지 않았어요', tone: 'normal', action: ACTION_TEXT_DUP };
  if (f.get('$dup.businessKey')) return { flag: '같은 건 기록 있음', tone: 'normal', action: ACTION_TEXT_DUP };
  if (f.get('$dup.otherDevice')) return { flag: '다른 PC 기록 확인 불가', tone: 'normal', action: ACTION_TEXT_DUP };
  return undefined;
}

export function actionText(req: Pick<GateRequest, 'fields'>): string {
  const d = dupState(new Map(req.fields.map((x) => [x.fieldKey, x.value])));
  if (d) return d.action;
  return req.fields.some((x) => x.fieldKey.startsWith('$dup.')) ? ACTION_TEXT_DUP : ACTION_TEXT;
}

export function kstToday(nowMs: number): string {
  return new Date(nowMs + 9 * 3_600_000).toISOString().slice(0, 10);
}

const AMOUNT = /^(0|[1-9]\d{0,14})$/;

export const CARD_ROWS = { 'H-01': 4, cert: 4 } as const;

export function summarize(req: Pick<GateRequest, 'fields'>, todayKst: string = kstToday(Date.now())): SummaryLine[] | ArmRefusal {
  const f = new Map(req.fields.map((x) => [x.fieldKey, x.value]));
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
    { label: '합계', amount: true, pieces: [{ text: won(f.get('totalAmount')!) }, { text: `공급가액 ${won(f.get('supplyAmount')!)}, 세액 ${won(f.get('taxAmount')!)}` }], flag: dup?.flag, tone: dup?.tone },
    { label: '공급받는자', pieces: [{ text: f.get('counterpartName')!, shrink: true }, { text: `, ${bizNo(f.get('counterpartBizNo')!)}` }], flag: f.get('$first.bizNo') === 'true' ? '처음 거래' : undefined },
    { label: '품목', pieces: [{ text: f.get('itemName')!, shrink: true }, ...(count && count !== '1' ? [{ text: `, ${count}개 품목` }] : [])] },
    { label: '작성일자', pieces: [{ text: issueDate }], flag: issueDate !== todayKst ? '오늘 아님' : undefined },
  ];
  const email = f.get('counterpartEmail') ?? '';
  if (!email) return [...rows, { label: '받는 이메일', pieces: [{ text: '없음, 메일을 보내지 않아요' }] }];
  if (UNSAFE_CHARS.test(email)) return { reason: 'unsafe', label: '받는 이메일' };
  const at = email.lastIndexOf('@');
  if (at <= 0) return { reason: 'unsafe', label: '받는 이메일' };
  const domain = domainToASCII(email.slice(at + 1));
  if (!domain) return { reason: 'unsafe', label: '받는 이메일' };
  return [...rows, { label: '받는 이메일', pieces: [{ text: email.slice(0, at), shrink: true }, { text: `@${domain}` }], flag: f.get('$first.email') === 'true' ? '처음 보내는 주소' : undefined }];
}

export const CERT_SUMMARY_LABELS = [
  ['certDoc', '서류'],
  ['certPurpose', '사용 용도'],
  ['certSubmitTo', '제출처'],
  ['rrnDisclosure', '주민번호 공개'],
] as const;

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

export const ATTEST_ACTION_TEXT = '홈택스 발급목록에 없음을 확인했어요';
export const ATTEST_FIXED = '발급목록 반영이 늦을 수 있습니다';
const PORTAL_NAME: Record<string, string> = { hometax: '홈택스', gov24: '정부24', sminfo: '중소기업현황정보시스템', insure4: '4대보험 정보연계센터' };
export const attestManualText = (portal: string) => `${PORTAL_NAME[portal] ?? '홈택스'} 발급목록을 직접 확인한 뒤 답해 주세요`;

export const attestRows = (manualCheck?: boolean) => (manualCheck === true ? 3 : 2);

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
    { label: '공급받는자', pieces: [{ text: f.get('counterpartName')!, shrink: true }, { text: `, ${bizNo(f.get('counterpartBizNo')!)}` }], tone: 'attention' },
    { label: '', pieces: [{ text: ATTEST_FIXED }], tone: 'attention', note: true },
  ];
  if (req.manualCheck === true) lines.push({ label: '', pieces: [{ text: attestManualText(req.portal) }], tone: 'attention', note: true });
  return lines;
}

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
  unit: 8.5,
  irrGap: 10,
  irr: 20,
  btnGap: 14,
  btn: 44,
  stop: 112,
  apart: 48,
  btnUnit: 10,
  btnPadX: 20,
} as const;

const wide = /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦]/u;
export const cells = (s: string) => [...s].reduce((n, c) => n + (wide.test(c) ? 2 : 1), 0);

export const cardHeight = (rows: number) =>
  CARD.padY * 2 + CARD.head + CARD.headGap + CARD.total + CARD.sub + CARD.amountGap + rows * CARD.row + CARD.irrGap + CARD.irr + CARD.btnGap + CARD.btn;

export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}
export interface CardTargets {
  approve: Box;
  stop: Box;
}

const approveWidth = (action: string) => Math.ceil(cells(action) * CARD.btnUnit) + CARD.btnPadX * 2;

export function cardTargets(width: number, height: number): CardTargets {
  const y = height - CARD.padY - CARD.btn;
  const ax = CARD.padX + CARD.stop + CARD.apart;
  return { approve: { x: ax, y, width: Math.max(0, width - CARD.padX - ax), height: CARD.btn }, stop: { x: CARD.padX, y, width: CARD.stop, height: CARD.btn } };
}

export const inBox = (b: Box, x: number, y: number) => x >= b.x && y >= b.y && x < b.x + b.width && y < b.y + b.height;

export function overflowLine(lines: SummaryLine[], cardWidth: number, text: CardText = GATE_TEXT): string | null {
  const inner = cardWidth - CARD.padX * 2;
  const valueWidth = inner - CARD.label - CARD.gap * 2;
  for (const l of lines) {
    const flag = l.flag ? cells(l.flag) * CARD.unit * (12 / 14) + CARD.flagPad : 0;
    if (l.amount) {
      const [total, ...rest] = l.pieces;
      if (cells(total?.text ?? '') * CARD.unit * (24 / 14) + flag + CARD.gap > inner) return l.label;
      if (rest.reduce((n, p) => n + cells(p.text), 0) * CARD.unit > inner) return l.label;
      continue;
    }
    const keep = l.pieces.filter((p) => !p.shrink).reduce((n, p) => n + cells(p.text), 0) * CARD.unit;
    const shrinkMin = l.pieces.some((p) => p.shrink) ? 2 * CARD.unit : 0;
    if (keep + flag + shrinkMin > valueWidth) return l.label || '안내';
  }
  if (cells(text.irreversible) * CARD.unit * (13 / 14) > inner) return '안내';
  if (approveWidth(text.action) > cardTargets(cardWidth, 0).approve.width) return '버튼';
  return null;
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

export const BAR_CSP = "default-src 'none'; style-src 'self'";

export type BarMode = 'unarmed' | 'armed' | 'refused';
export const BAR_MESSAGES = {
  cursor: '마우스 커서가 보이게 한 뒤 눌러 주세요',
} as const;
export const BAR_AGAIN_TEXT = '창을 앞으로 가져오는 클릭이었어요. 한 번 더 눌러 주세요';
export const ACTION_TEXT = '승인하고 발급';
export const batchActionText = (n: number) => `${n}건 차례로 승인하고 발급`;
export const ACTION_TEXT_DUP = '같은 건 기록을 확인했고 발급';
export const ACTION_TEXT_DUP_COMMITTED = '그래도 한 번 더 발급';
export const IRREVERSIBLE_TEXT = '승인하면 바로 발급되고 메일로 가요. 되돌릴 수 없어요.';
export const IRREVERSIBLE_TEXT_NO_MAIL = '승인하면 바로 발급돼요. 메일은 보내지 않아요. 되돌릴 수 없어요.';
const ATTEST_IRREVERSIBLE_TEXT = '확인하면 이 건을 발급 안 됨으로 기록해요. 되돌릴 수 없어요.';
export const CERT_IRREVERSIBLE_TEXT = '발급하면 홈택스 발급 이력에 남습니다. 되돌릴 수 없어요.';
const STOP_TEXT = '중지';
export const ATTEST_STOP_TEXT = '닫기';
const DOC_TITLE = '세금계산서';

export interface CardText {
  title: string;
  chip: string;
  action: string;
  irreversible: string;
  stop: string;
}
const title = (name?: string) => (name ? `${DOC_TITLE} ${name}` : DOC_TITLE);
export const GATE_TEXT: CardText = { title: DOC_TITLE, chip: '승인 대기', action: ACTION_TEXT, irreversible: IRREVERSIBLE_TEXT, stop: STOP_TEXT };
export const ATTEST_TEXT: CardText = { title: DOC_TITLE, chip: '확인 필요', action: ATTEST_ACTION_TEXT, irreversible: ATTEST_IRREVERSIBLE_TEXT, stop: ATTEST_STOP_TEXT };
export const SIGN_AFTER: Readonly<Record<string, string>> = {
  '공동/금융인증서': '승인 뒤 인증서 비밀번호를 넣으면',
  '사업자 간편인증': '승인 뒤 휴대폰 간편인증을 마치면',
};
const SIGN_AFTER_DEFAULT = '승인 뒤 홈택스 인증을 마치면';
export const irreversibleText = (auth: string | undefined, mail: boolean): string =>
  `${(auth && Object.hasOwn(SIGN_AFTER, auth) ? SIGN_AFTER[auth] : null) ?? SIGN_AFTER_DEFAULT} ${mail ? '발급/메일 전송' : '발급'}돼요. 되돌릴 수 없어요.`;
export const gateText = (action: string, name?: string, mail = true, auth?: string): CardText => ({ ...GATE_TEXT, title: title(name), action, irreversible: auth === undefined ? (mail ? IRREVERSIBLE_TEXT : IRREVERSIBLE_TEXT_NO_MAIL) : irreversibleText(auth, mail) });
export const attestText = (name?: string): CardText => ({ ...ATTEST_TEXT, title: title(name) });
export const certGateText = (docName: string, action: string): CardText => ({ title: docName, chip: '승인 대기', action, irreversible: CERT_IRREVERSIBLE_TEXT, stop: STOP_TEXT });

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

const BAR_COLOR_KEYS = ['accent', 'on-accent', 'accent-soft', 'ink', 'ink-3', 'surface', 'canvas', 'line-strong', 'attention', 'attention-soft', 'focus-ring'] as const;
export type BarColors = Record<(typeof BAR_COLOR_KEYS)[number], string>;
export type BarPalette = { light: BarColors; dark: BarColors };

export const BAR_PALETTE_DEFAULT: BarPalette = {
  light: { accent: '#0064D4', 'on-accent': '#FFFFFF', 'accent-soft': '#EBF3FD', ink: '#111112', 'ink-3': '#686A6E', surface: '#FCFCFC', canvas: '#FCFCFC', 'line-strong': '#8F9296', attention: '#8A5A0B', 'attention-soft': '#FBF3E4', 'focus-ring': '#0064D4' },
  dark: { accent: '#4B93FF', 'on-accent': '#0B1226', 'accent-soft': '#17263D', ink: '#F3F4F5', 'ink-3': '#989B9E', surface: '#181819', canvas: '#181819', 'line-strong': '#76797D', attention: '#E0AE55', 'attention-soft': '#2E2410', 'focus-ring': '#4B93FF' },
};

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

export function contrast(a: string, b: string): number {
  const [x, y] = [lum(a), lum(b)];
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

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
font-family:-apple-system,BlinkMacSystemFont,"Apple SD Gothic Neo","Malgun Gothic",system-ui,sans-serif;font-size:14px;line-height:${CARD.row}px;font-variant-numeric:tabular-nums;-webkit-font-smoothing:antialiased;user-select:none;cursor:default}
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

interface MouseIn {
  type: string;
  x: number;
  y: number;
  button?: string;
}

interface KeyIn {
  type: string;
  key: string;
  alt?: boolean;
  control?: boolean;
  meta?: boolean;
}

export const KEYBOARD_APPROVAL = false;

type GateResult = { kind: 'approve' } | { kind: 'refused'; reason: keyof typeof BAR_MESSAGES } | null;

export const STOP_KEYS: readonly string[] = ['Enter', ' ', 'Escape'];

export class BarGate {
  private pressed = false;
  private blocked = false;
  private target: Box = { x: 0, y: 0, width: 0, height: 0 };
  private stopTarget: Box = { x: 0, y: 0, width: 0, height: 0 };
  private stopPressed = false;

  setTargets(t: CardTargets): void {
    this.target = { ...t.approve };
    this.stopTarget = { ...t.stop };
  }

  reset(): void {
    this.pressed = false;
  }

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

  key(ev: KeyIn): GateResult {
    if (!KEYBOARD_APPROVAL || this.blocked || ev.type !== 'keyDown') return null;
    return ev.alt && !ev.control && !ev.meta && (ev.key.toLowerCase() === 'y' || ev.key === 'ㅛ') ? { kind: 'approve' } : null;
  }
}

const APPROVAL_CONTEXT = 'SAX-local-approval-v2';
const canon = (a: Omit<LocalApproval, 'mac'>) => cbor([a.v, a.runId, a.gateStepId, a.reqId, a.approvalNonce, a.actionHash, a.exp, a.presence]);

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
