import { READBACK_KEYS, type ReadbackKey } from './gate.ts';

/** readback 대상 fieldKey. 순서는 gate.ts READBACK_KEYS(게이트 fields 순서)다. */
export const READBACK_FIELDS = READBACK_KEYS;
export type { ReadbackKey };

export interface SelectorEntry {
  css: string;
  role: string;
  name: string;
  landmark?: SelectorKey;
  commits: boolean;
  commitEffect?: 'issue_document';
  fieldKey?: ReadbackKey;
}

export const SELECTOR_KEYS = [
  'form.root', 'form.supplierBizNo', 'form.supplierName', 'form.counterpartBizNo', 'form.lookupCounterpart', 'form.counterpartName',
  'form.counterpartEmail', 'form.itemName', 'form.itemCount', 'form.supplyAmount', 'form.taxAmount', 'form.totalAmount',
  'form.issueDate', 'form.remark', 'form.receiptType', 'form.issueButton',
] as const;
export type SelectorKey = (typeof SELECTOR_KEYS)[number];

export interface LookupDef {
  path: string;
  query: Partial<Record<ReadbackKey | 'approvalNo', string>>;
  ready: string;
  rows: string;
}

export interface PortalConfig {
  kind: 'fixture' | 'hometax';
  origin: string;
  login: boolean;
  issueForm: string;
  selectors: Record<SelectorKey, SelectorEntry>;
  failureSignal: ReadonlyArray<FailureSignal>;
  invoiceLookup: LookupDef;
  mailLookup: LookupDef;
  verify: { minElapsedMs: number; lookups: number; intervalMs: number; maxMs: number };
  loginPaths?: readonly string[];
}

export interface FailureSignal {
  css: string;
  text: string;
}

const foldText = (s: string) => s.normalize('NFKC').replace(/\s+/g, ' ').trim();

/** 실패 신호 항목의 문구가 이 요소의 보이는 문구와 맞는가. 같은 셀렉터라도 성공 안내 문구는 실패가 아니다. */
export function failureMatches(entry: FailureSignal, visibleText: string): boolean {
  return new RegExp(entry.text).test(foldText(visibleText));
}

/** 이 실행이 지나가도 되는 포털 경로(플레이북 화면·조회·로그인). 이 밖의 포털 화면은 모르는 화면이다. */
export function expectedPaths(p: PortalConfig): string[] {
  return [p.issueForm, p.invoiceLookup.path, p.mailLookup.path, ...(p.loginPaths ?? [])].filter((x) => x && !x.includes(TODO));
}

/**
 * 주 프레임 주소가 기대 경로 안인가. 포털 호스트(와 그 하위 도메인)의 경로만 판정하고, 포털 밖 주소는 여기서 보지 않는다
 * (허용 origin은 금고 중계가 막는다). 경로는 기대 경로의 접두로 시작해야 한다.
 */
export function pathExpected(url: string, portal: PortalConfig): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return true;
  }
  const base = new URL(portal.origin).hostname;
  if (u.hostname !== base && !u.hostname.endsWith(`.${base}`)) return true;
  return expectedPaths(portal).some((p) => u.pathname.startsWith(p));
}

const TODO = 'TODO(PoC-3)';

const field = (css: string, role: string, name: string, fieldKey: ReadbackKey): SelectorEntry => ({ css, role, name, landmark: 'form.root', commits: false, fieldKey });

export function fixturePortal(origin: string): PortalConfig {
  return {
    kind: 'fixture',
    origin,
    login: false,
    issueForm: '/invoice/issue',
    selectors: {
      'form.root': { css: '#invoice-form', role: 'form', name: '^전자세금계산서 건별발급$', commits: false },
      'form.supplierBizNo': field('#supplierBizNo', 'status', '^공급자 등록번호$', 'supplierBizNo'),
      'form.supplierName': field('#supplierName', 'status', '^공급자 상호$', 'supplierName'),
      'form.counterpartBizNo': field('#dmnrBizNo', 'textbox', '^공급받는자 등록번호$', 'counterpartBizNo'),
      'form.lookupCounterpart': { css: '#btnCpCheck', role: 'button', name: '^공급받는자 확인$', landmark: 'form.root', commits: false },
      'form.counterpartName': field('#dmnrName', 'textbox', '^공급받는자 상호$', 'counterpartName'),
      'form.counterpartEmail': field('#dmnrEmail', 'textbox', '^공급받는자 이메일$', 'counterpartEmail'),
      'form.itemName': field('#itemNm', 'textbox', '^품목$', 'itemName'),
      'form.itemCount': field('#itemCnt', 'status', '^품목 수$', 'itemCount'),
      'form.supplyAmount': field('#splAmt', 'textbox', '^공급가액$', 'supplyAmount'),
      'form.taxAmount': field('#taxAmt', 'textbox', '^세액$', 'taxAmount'),
      'form.totalAmount': field('#totAmt', 'status', '^합계금액$', 'totalAmount'),
      'form.issueDate': field('#wrtDt', 'textbox', '^작성일자$', 'issueDate'),
      'form.remark': field('#rmk', 'textbox', '^비고$', 'remark'),
      'form.receiptType': field('#rcpt', 'combobox', '^영수/청구$', 'receiptType'),
      'form.issueButton': { css: '#btnIssue', role: 'button', name: '^발급하기$', landmark: 'form.root', commits: true, commitEffect: 'issue_document' },
    },
    failureSignal: [{ css: '#issue-error', text: '^발급할 수 없습니다\\. 입력 값을 확인하세요\\.$' }],
    invoiceLookup: { path: '/invoice/list', query: { counterpartBizNo: 'bizNo', issueDate: 'date' }, ready: '#invoice-list[data-count]', rows: '#invoice-list tr[data-row]' },
    mailLookup: { path: '/mail/list', query: { approvalNo: 'approvalNo' }, ready: '#mail-list[data-count]', rows: '#mail-list tr[data-row]' },
    verify: { minElapsedMs: 600, lookups: 2, intervalMs: 200, maxMs: 3_000 },
  };
}

const todoEntry = (role: string, fieldKey?: ReadbackKey, commits = false): SelectorEntry => ({ css: TODO, role, name: TODO, landmark: 'form.root', commits, fieldKey, ...(commits ? { commitEffect: 'issue_document' as const } : {}) });

/** 홈택스 실물(PoC-3에서 채운다). URL·셀렉터·조회 표·실패 신호가 전부 자리표시다. */
export const HOMETAX_PORTAL: PortalConfig = {
  kind: 'hometax',
  origin: 'https://hometax.go.kr',
  login: true,
  issueForm: TODO,
  selectors: {
    'form.root': { css: TODO, role: 'form', name: TODO, commits: false },
    'form.supplierBizNo': todoEntry('status', 'supplierBizNo'),
    'form.supplierName': todoEntry('status', 'supplierName'),
    'form.counterpartBizNo': todoEntry('textbox', 'counterpartBizNo'),
    'form.lookupCounterpart': todoEntry('button'),
    'form.counterpartName': todoEntry('textbox', 'counterpartName'),
    'form.counterpartEmail': todoEntry('textbox', 'counterpartEmail'),
    'form.itemName': todoEntry('textbox', 'itemName'),
    'form.itemCount': todoEntry('status', 'itemCount'),
    'form.supplyAmount': todoEntry('textbox', 'supplyAmount'),
    'form.taxAmount': todoEntry('textbox', 'taxAmount'),
    'form.totalAmount': todoEntry('status', 'totalAmount'),
    'form.issueDate': todoEntry('textbox', 'issueDate'),
    'form.remark': todoEntry('textbox', 'remark'),
    'form.receiptType': todoEntry('combobox', 'receiptType'),
    'form.issueButton': todoEntry('button', undefined, true),
  },
  failureSignal: [],
  invoiceLookup: { path: TODO, query: {}, ready: TODO, rows: TODO },
  mailLookup: { path: TODO, query: {}, ready: TODO, rows: TODO },
  verify: { minElapsedMs: 60_000, lookups: 2, intervalMs: 10_000, maxMs: 300_000 },
};

/** 앱 하한(D02 §4.4 policy.verify 기본값). 플레이북·포털 값은 이보다 엄격한 쪽만 쓴다. fixture는 예외다. maxMs는 홈택스만 본다. */
export const VERIFY_FLOOR = { minElapsedMs: 60_000, lookups: 2, maxMs: 300_000 } as const;

/** 실행 전 점검: 자리표시·앵커 없는 이름 패턴·하한 미달을 모두 찾는다. 하나라도 있으면 실행하지 않는다. */
export function portalProblems(p: PortalConfig): string[] {
  const out: string[] = [];
  const todo = (where: string, v: string) => v.includes(TODO) && out.push(`placeholder:${where}`);
  todo('issueForm', p.issueForm);
  for (const f of p.failureSignal) {
    todo('failureSignal', f.css);
    if (!(f.text.startsWith('^') && f.text.endsWith('$'))) out.push('unanchored:failureSignal');
  }
  for (const [k, l] of [['invoiceLookup', p.invoiceLookup], ['mailLookup', p.mailLookup]] as const) {
    todo(`${k}.path`, l.path);
    todo(`${k}.ready`, l.ready);
    todo(`${k}.rows`, l.rows);
  }
  for (const k of SELECTOR_KEYS) {
    const e = p.selectors[k];
    todo(`selector:${k}`, e.css);
    todo(`name:${k}`, e.name);
    if (!e.name.includes(TODO) && !(e.name.startsWith('^') && e.name.endsWith('$'))) out.push(`unanchored:${k}`);
  }
  if (!READBACK_FIELDS.every((f) => SELECTOR_KEYS.some((k) => p.selectors[k].fieldKey === f))) out.push('readback_field_without_selector');
  if (p.kind === 'hometax' && (p.verify.minElapsedMs < VERIFY_FLOOR.minElapsedMs || p.verify.lookups < VERIFY_FLOOR.lookups || p.verify.maxMs < VERIFY_FLOOR.maxMs)) out.push('verify_below_floor');
  return out;
}
