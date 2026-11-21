
export type BoardKind = 'invoice' | 'receipt' | 'accountant' | 'expiring' | 'unpaid' | 'deposits';
export const BOARD_KINDS: ReadonlyArray<{ kind: BoardKind; title: string }> = [
  { kind: 'invoice', title: '발급할 세금계산서' },
  { kind: 'receipt', title: '받아야 할 증빙' },
  { kind: 'accountant', title: '세무사에게 줄 것' },
  { kind: 'expiring', title: '만료가 다가오는 서류' },
];

type BoardTarget =
  | { to: 'run'; id: string }
  | { to: 'doc'; id: string }
  | { to: 'compose'; text: string }
  | { to: 'view'; view: 'docs' | 'cps' | 'bundle' | 'card' | 'payroll' | 'bank'; filter?: string };

export interface BoardItem {
  id: string;
  kind: BoardKind;
  label: string;
  detail: string;
  due: string | null;
  showDue: boolean;
  tone: 'attention' | 'progress' | null;
  target: BoardTarget;
}

export interface BoardCard {
  kind: BoardKind;
  title: string;
  items: BoardItem[];
  due: string | null;
}

export interface Board {
  month: string;
  cards: BoardCard[];
  counts: { attention: number; progress: number; expiringSoon: number };
  setup: BoardSetup[];
}
export interface BoardSetup {
  id: string;
  label: string;
  view: 'biz' | 'cps' | 'chrome' | 'security';
}

export interface IssuedInvoice {
  who: string;
  date: string;
  total: number | null;
}
export interface BoardRun {
  id: string;
  status: string;
  who: string;
  inDoubt?: boolean;
}
export interface BoardDoc {
  id: string;
  name: string;
  expiresOn: string | null;
  needsUser: boolean;
}
export interface BundleSlot {
  name: string;
  state: 'missing' | 'done' | 'na';
  receipt?: boolean;
}
export interface BoardInput {
  today: string;
  reminderDay: number;
  issued: IssuedInvoice[];
  runs: BoardRun[];
  docs: BoardDoc[];
  bundle: { month: string; slots: BundleSlot[]; sentOn: string | null } | null;
  cardFetchedOn: string | null;
  setup?: BoardSetup[];
  cardEnabled?: boolean;
  money?: BoardCard[];
}

const EXPIRING_WITHIN_DAYS = 30;
const ACTIVE = new Set(['draft', 'preparing', 'turn', 'waiting', 'issuing', 'attention']);
const PROGRESS = new Set(['preparing', 'turn', 'waiting', 'issuing']);

const pad = (n: number) => String(n).padStart(2, '0');
const parse = (d: string) => {
  const [y, m, day] = d.split('-').map(Number) as [number, number, number];
  return { y, m, day };
};
export function dayOf(month: string, day: number): string {
  const [y, m] = month.split('-').map(Number) as [number, number];
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return `${month}-${pad(Math.min(Math.max(1, Math.trunc(day)), last))}`;
}
export function addMonths(month: string, n: number): string {
  const [y, m] = month.split('-').map(Number) as [number, number];
  const t = y * 12 + (m - 1) + n;
  return `${Math.floor(t / 12)}-${pad((t % 12) + 1)}`;
}
const monthOf = (d: string) => d.slice(0, 7);
export function daysBetween(a: string, b: string): number {
  const x = parse(a);
  const y = parse(b);
  return Math.round((Date.UTC(y.y, y.m - 1, y.day) - Date.UTC(x.y, x.m - 1, x.day)) / 86_400_000);
}
const won = (n: number) => `${n.toLocaleString('en-US')}원`;

export function invoiceSortDue(month: string): string {
  return dayOf(addMonths(month, 1), 10);
}

export function buildBoard(input: BoardInput): Board {
  const month = monthOf(input.today);
  const items: BoardItem[] = [];

  const invoiceDue = invoiceSortDue(month);
  for (const r of input.runs.filter((x) => ACTIVE.has(x.status))) {
    const tone = r.status === 'attention' ? 'attention' : PROGRESS.has(r.status) ? 'progress' : null;
    const detail = r.inDoubt && r.status === 'attention' ? '발급 여부 확인 필요' : ({ draft: '작성 중', preparing: '준비 중', turn: '내 차례', waiting: '승인 대기', issuing: '발급 중', attention: '확인 필요' }[r.status] ?? '');
    items.push({ id: `run:${r.id}`, kind: 'invoice', label: r.who || '세금계산서', detail, due: input.today, showDue: false, tone, target: { to: 'run', id: r.id } });
  }
  const busy = new Set(input.runs.filter((x) => ACTIVE.has(x.status)).map((x) => x.who));
  const lastMonth = addMonths(month, -1);
  const thisMonth = new Set(input.issued.filter((x) => monthOf(x.date) === month).map((x) => x.who));
  const prev = new Map<string, IssuedInvoice>();
  for (const x of input.issued) if (monthOf(x.date) === lastMonth && (!prev.has(x.who) || prev.get(x.who)!.date < x.date)) prev.set(x.who, x);
  for (const x of [...prev.values()].sort((a, b) => a.date.localeCompare(b.date) || a.who.localeCompare(b.who))) {
    if (thisMonth.has(x.who) || busy.has(x.who)) continue;
    const detail = `지난달 ${Number(x.date.slice(5, 7))}월 ${Number(x.date.slice(8))}일${x.total !== null ? `, ${won(x.total)}` : ''}, 이번 달은 아직이에요`;
    items.push({ id: `cp:${x.who}`, kind: 'invoice', label: x.who, detail, due: invoiceDue, showDue: false, tone: null, target: { to: 'compose', text: `${x.who}에 지난달처럼 세금계산서 끊어 줘` } });
  }

  const reminder = dayOf(month, input.reminderDay);
  const b = input.bundle;
  if (b && !b.sentOn) {
    const due = dayOf(addMonths(b.month, 1), input.reminderDay);
    const bMonth = `${Number(b.month.slice(5, 7))}월`;
    for (const s of b.slots.filter((x) => x.receipt && x.state === 'missing')) {
      items.push({ id: `receipt:${s.name}`, kind: 'receipt', label: s.name, detail: `${bMonth} 꾸러미에 넣을 것`, due, showDue: true, tone: null, target: { to: 'view', view: 'bundle' } });
    }
    const missing = b.slots.filter((x) => x.state === 'missing').length;
    items.push({
      id: `bundle:${b.month}`,
      kind: 'accountant',
      label: `${bMonth} 세무사 꾸러미`,
      detail: missing ? `빠진 것 ${missing}개, 미리보고 보내기` : '다 모였어요. 미리보고 보내기',
      due,
      showDue: true,
      tone: missing && daysBetween(input.today, due) < 0 ? 'attention' : null,
      target: { to: 'view', view: 'bundle' },
    });
  }
  if (input.cardEnabled !== false && (!input.cardFetchedOn || monthOf(input.cardFetchedOn) < month)) {
    const ago = input.cardFetchedOn ? `마지막 최신화 ${daysBetween(input.cardFetchedOn, input.today)}일 전` : '아직 가져온 적 없어요';
    items.push({ id: 'card', kind: 'accountant', label: '사업용 카드 내역', detail: ago, due: b && !b.sentOn ? dayOf(addMonths(b.month, 1), input.reminderDay) : reminder, showDue: false, tone: null, target: { to: 'view', view: 'card' } });
  }

  for (const d of input.docs) {
    if (!d.expiresOn) continue;
    const left = daysBetween(input.today, d.expiresOn);
    if (left > EXPIRING_WITHIN_DAYS) continue;
    items.push({ id: `doc:${d.id}`, kind: 'expiring', label: d.name, detail: left < 0 ? '만료됐어요. 다시 발급' : `만료 ${d.expiresOn}`, due: d.expiresOn, showDue: true, tone: d.needsUser || left <= 7 ? 'attention' : null, target: { to: 'doc', id: d.id } });
  }

  const soon = (x: BoardItem) => x.kind === 'expiring' && !!x.due && daysBetween(input.today, x.due) <= 7;
  const order = new Map(BOARD_KINDS.map((k, i) => [k.kind, i]));
  const byDue = (a: { due: string | null }, b: { due: string | null }) => (a.due === b.due ? 0 : a.due === null ? 1 : b.due === null ? -1 : a.due.localeCompare(b.due));
  const cards: BoardCard[] = BOARD_KINDS.map(({ kind, title }) => {
    const list = items.filter((x) => x.kind === kind).sort((a, b) => byDue(a, b) || a.label.localeCompare(b.label, 'ko'));
    return { kind, title, items: list, due: list[0]?.due ?? null };
  })
    .filter((c) => c.items.length)
    .sort((a, b) => byDue(a, b) || order.get(a.kind)! - order.get(b.kind)!);

  return {
    month,
    cards: [...cards, ...(input.money ?? [])],
    setup: (input.setup ?? []).map((x) => ({ ...x })),
    counts: {
      attention: items.filter((x) => x.tone === 'attention' && !soon(x)).length,
      progress: items.filter((x) => x.tone === 'progress').length,
      expiringSoon: items.filter(soon).length,
    },
  };
}

export function dueLabel(today: string, due: string): string {
  const n = daysBetween(today, due);
  return n === 0 ? '오늘' : n > 0 ? `D-${n}` : `${-n}일 지남`;
}
