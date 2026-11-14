// 이번 달 판(08 M-02, ADR-033, D14 M6-16): 카드 4종의 항목·기한·정렬을 main이 계산한다. 렌더러는 받은 항목을 그리기만 한다.
// 판에는 승인 버튼이 없다(ADR-021). 항목을 누르면 대화 카드·작업 패널·화면으로 옮겨 갈 뿐이고, 승인은 main 승인 바에서만 한다.
// 판은 따로 저장하지 않고 매번 계산한다(D07: bundle_entries·documents·발급 이력에서). Phase 1 데이터는 목업 어댑터(shell-mock 방식)에서 온다.
// 세무 판단(세액·가산세·신고 여부)을 하지 않는다(02 §12). 세금계산서 발급기한 D-day 표시는 02 §14(Phase 2 후보, 법률 의견 대상)라
// 판에 날짜를 보이지 않고 정렬에만 쓴다(showDue:false).
// Electron 없이 시험한다(tests/shell-board.test.ts).

/** 'unpaid'·'deposits'는 받을 돈 카드(09 §3.4, 대표 결정 ⑤). main이 판 뒤에 붙인다(bank-host.ts bankBoardCards). */
export type BoardKind = 'invoice' | 'receipt' | 'accountant' | 'expiring' | 'unpaid' | 'deposits';
/** 판 카드 4종의 이름과 같은 기한일 때의 순서. */
export const BOARD_KINDS: ReadonlyArray<{ kind: BoardKind; title: string }> = [
  { kind: 'invoice', title: '발급할 세금계산서' },
  { kind: 'receipt', title: '받아야 할 증빙' },
  { kind: 'accountant', title: '세무사에게 줄 것' },
  { kind: 'expiring', title: '만료가 다가오는 서류' },
];

/** 항목을 눌렀을 때 갈 곳. 승인·실행 시작은 없다(대화 입력창에 채우기까지만, 보내기는 사람이 한다). */
export type BoardTarget =
  | { to: 'run'; id: string }
  | { to: 'doc'; id: string }
  | { to: 'compose'; text: string }
  | { to: 'view'; view: 'docs' | 'cps' | 'bundle' | 'card' | 'payroll' | 'bank'; filter?: string };

export interface BoardItem {
  id: string;
  kind: BoardKind;
  /** 한 줄 제목(거래처·서류 이름). */
  label: string;
  /** 보조 한 줄(지난 금액·빠진 것 수 등). */
  detail: string;
  /** 정렬 기준일(YYYY-MM-DD, 한국 날짜). 없으면 맨 뒤. */
  due: string | null;
  /** 기한을 화면에 보일지(세금계산서는 보이지 않는다, 02 §14). */
  showDue: boolean;
  /** 확인 필요(황토) · 진행 중(무채) 표시. */
  tone: 'attention' | 'progress' | null;
  target: BoardTarget;
}

export interface BoardCard {
  kind: BoardKind;
  title: string;
  items: BoardItem[];
  /** 카드의 가장 이른 기한(카드 정렬용). */
  due: string | null;
}

export interface Board {
  /** 'YYYY-MM' */
  month: string;
  cards: BoardCard[];
  /** 지금의 확인 필요·진행 중 건수(ADR-033 결정 1: 판에 둔다). */
  counts: { attention: number; progress: number; expiringSoon: number };
  /** 온보딩에서 건너뛴 항목(08 §4 "할 일"). 카드 4종(ADR-033)에 넣지 않고 판 머리 아래 한 줄로 둔다. 누르면 그 화면. */
  setup: BoardSetup[];
}
export interface BoardSetup {
  id: string;
  label: string;
  view: 'biz' | 'cps' | 'chrome' | 'security';
}

/** 지난 발급 한 건(원장·발급 이력·문서함 세금계산서에서). */
export interface IssuedInvoice {
  who: string;
  date: string;
  total: number | null;
}
export interface BoardRun {
  id: string;
  status: string;
  who: string;
  /** 발급됐는지 모름(in_doubt). 판 줄 설명이 달라진다. */
  inDoubt?: boolean;
}
export interface BoardDoc {
  id: string;
  name: string;
  expiresOn: string | null;
  needsUser: boolean;
}
/** 세무사 꾸러미 한 칸(D07 bundle_entries 요약). */
export interface BundleSlot {
  name: string;
  /** 'missing' 빠짐 · 'done' 넣음 · 'na' 해당 없음 */
  state: 'missing' | 'done' | 'na';
  /** 종이 증빙처럼 사장님이 받아 와야 하는 칸이면 true(받아야 할 증빙 카드로 간다). */
  receipt?: boolean;
}
export interface BoardInput {
  /** 오늘(한국 날짜 YYYY-MM-DD). */
  today: string;
  /** 설정 bundle.reminderDay(1~28): 매달 이날 "세무사 꾸러미 준비됨"을 알린다(02 §17). */
  reminderDay: number;
  issued: IssuedInvoice[];
  runs: BoardRun[];
  docs: BoardDoc[];
  /** 지난달 꾸러미(이번 달 알림 날에 보낼 것). 보냈으면 sentOn. */
  bundle: { month: string; slots: BundleSlot[]; sentOn: string | null } | null;
  /** 사업용 카드 내역 마지막 최신화 날짜(H-12). 없으면 한 번도 안 함. */
  cardFetchedOn: string | null;
  /** 온보딩에서 건너뛴 항목(onboardingTodos). */
  setup?: BoardSetup[];
  /** 사업용 카드 내역(D-04) 기능이 있는 빌드인지. 거짓이면 [최신화] 칸을 두지 않는다(제품 첫 설치본, 팀장 2026-11-09). 기본 참. */
  cardEnabled?: boolean;
  /** 받을 돈 카드("못 받은 돈"·"확인할 입금", bank-host.ts bankBoardCards). 판 카드 4종 뒤에 붙인다. */
  money?: BoardCard[];
}

export const EXPIRING_WITHIN_DAYS = 30;
const ACTIVE = new Set(['draft', 'preparing', 'turn', 'waiting', 'issuing', 'attention']);
const PROGRESS = new Set(['preparing', 'turn', 'waiting', 'issuing']);

const pad = (n: number) => String(n).padStart(2, '0');
const parse = (d: string) => {
  const [y, m, day] = d.split('-').map(Number) as [number, number, number];
  return { y, m, day };
};
/** 그 달의 day일(달의 날 수를 넘으면 마지막 날). */
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
/** a에서 b까지 날 수(b - a). */
export function daysBetween(a: string, b: string): number {
  const x = parse(a);
  const y = parse(b);
  return Math.round((Date.UTC(y.y, y.m - 1, y.day) - Date.UTC(x.y, x.m - 1, x.day)) / 86_400_000);
}
const won = (n: number) => `${n.toLocaleString('en-US')}원`;

/**
 * "발급할 세금계산서" 줄의 정렬 키: 다음 달 10일(02 §14 월합계 발급기한). **정렬에만 쓰고 화면에 보이지 않는다**(showDue: false).
 * 2026-11-05 팀장 결정 (가): 법률 의견 전에는 발급기한·가산세·"~까지" 문장을 쓰지 않는다(reports/decisions.tsv).
 * 법률 의견이 와서 (나)(사실 문장 표시)로 바꾸면 이 함수와 그 줄의 showDue·detail만 고친다.
 */
export function invoiceSortDue(month: string): string {
  return dayOf(addMonths(month, 1), 10);
}

/** 판 계산. 같은 입력이면 같은 판(정렬이 안정적이다). */
export function buildBoard(input: BoardInput): Board {
  const month = monthOf(input.today);
  const items: BoardItem[] = [];

  // 1. 발급할 세금계산서: 진행 중인 실행 + 지난달 발급한 거래처 중 이번 달 아직 없는 곳.
  // 정렬 기준은 다음 달 10일(02 §14 발급기한, 월합계)이지만 화면에는 날짜·가산세를 보이지 않는다.
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
    const detail = `지난달 ${Number(x.date.slice(5, 7))}월 ${Number(x.date.slice(8))}일${x.total !== null ? ` · ${won(x.total)}` : ''} · 이번 달은 아직이에요`;
    items.push({ id: `cp:${x.who}`, kind: 'invoice', label: x.who, detail, due: invoiceDue, showDue: false, tone: null, target: { to: 'compose', text: `${x.who}에 지난달처럼 세금계산서 끊어 줘` } });
  }

  // 2·3. 받아야 할 증빙 · 세무사에게 줄 것: 지난달 꾸러미를 이번 달 알림 날(bundle.reminderDay)까지. 보냈으면 다음 달 알림 날의 이번 달 꾸러미.
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
      detail: missing ? `빠진 것 ${missing}개 · 미리보고 보내기` : '다 모였어요 · 미리보고 보내기',
      due,
      showDue: true,
      tone: missing && daysBetween(input.today, due) < 0 ? 'attention' : null,
      target: { to: 'view', view: 'bundle' },
    });
  }
  // 사업용 카드 내역이 이번 달에 최신화되지 않았으면(ADR-033 결정 5) 세무사에게 줄 것에 [최신화] 길을 둔다. 누르면 D-04로 간다(그 화면의 버튼이 실행 승인).
  if (input.cardEnabled !== false && (!input.cardFetchedOn || monthOf(input.cardFetchedOn) < month)) {
    const ago = input.cardFetchedOn ? `마지막 최신화 ${daysBetween(input.cardFetchedOn, input.today)}일 전` : '아직 가져온 적 없어요';
    items.push({ id: 'card', kind: 'accountant', label: '사업용 카드 내역', detail: ago, due: b && !b.sentOn ? dayOf(addMonths(b.month, 1), input.reminderDay) : reminder, showDue: false, tone: null, target: { to: 'view', view: 'card' } });
  }

  // 4. 만료가 다가오는 서류: 30일 안(지난 것 포함). 확인 필요 서류는 황토.
  for (const d of input.docs) {
    if (!d.expiresOn) continue;
    const left = daysBetween(input.today, d.expiresOn);
    if (left > EXPIRING_WITHIN_DAYS) continue;
    items.push({ id: `doc:${d.id}`, kind: 'expiring', label: d.name, detail: left < 0 ? '만료됐어요 · 다시 발급' : `만료 ${d.expiresOn}`, due: d.expiresOn, showDue: true, tone: d.needsUser || left <= 7 ? 'attention' : null, target: { to: 'doc', id: d.id } });
  }

  /** 만료 임박: 7일 안이거나 지난 서류 줄. 머리에서는 확인 필요와 따로 센다. */
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
    // 머리 건수는 카드에 실제로 놓인 줄에서 센다(카드에 없는 건을 세거나, 카드의 확인 필요를 빠뜨리지 않게).
    counts: {
      attention: items.filter((x) => x.tone === 'attention' && !soon(x)).length,
      progress: items.filter((x) => x.tone === 'progress').length,
      expiringSoon: items.filter(soon).length,
    },
  };
}

/** 기한 표시: D-n · 오늘 · n일 지남. */
export function dueLabel(today: string, due: string): string {
  const n = daysBetween(today, due);
  return n === 0 ? '오늘' : n > 0 ? `D-${n}` : `${-n}일 지남`;
}
