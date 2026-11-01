// H-01 포털 설정: URL·셀렉터 사전(D02 §2.1의 PoC 부분집합)·verify 정책. 두 벌이다.
// - fixture: 가짜 H-01 페이지(apps/desktop/src/h01-fixture.ts)에 맞춘 실제 값.
// - hometax: PoC-3(로그인·셀렉터) 전까지 자리표시. 자리표시가 하나라도 있으면 실행을 시작하지 않는다.

/** readback 대상 fieldKey(D02 §8 s19b, 커밋 랜드마크 안 전부). 순서가 게이트 fields 순서다. */
export const READBACK_FIELDS = [
  'supplierBizNo', 'supplierName', 'counterpartBizNo', 'counterpartName', 'counterpartEmail',
  'itemName', 'itemCount', 'supplyAmount', 'taxAmount', 'totalAmount', 'issueDate', 'remark', 'receiptType',
] as const;
export type ReadbackKey = (typeof READBACK_FIELDS)[number];

export interface SelectorEntry {
  /** 후보(PoC는 하나). id·name·data-*·aria-label 셀렉터만(D02 §2.1). 'TODO(PoC-3)'이면 자리표시. */
  css: string;
  role: string;
  /** 접근성 이름 패턴. ^…$ 앵커 필수, 랜드마크 안에서 정확히 1개에 맞아야 한다(SV-04·R-A1). */
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
  /** 조회 화면 경로와 질의 이름(fieldKey → 질의 파라미터). */
  path: string;
  query: Partial<Record<ReadbackKey | 'approvalNo', string>>;
  /** 결과 행. 행 안의 [data-k] 칸을 읽는다(가짜 페이지 모양, PoC-3에서 실제 표로 바꾼다). */
  rows: string;
}

export interface PortalConfig {
  kind: 'fixture' | 'hometax';
  origin: string;
  /** 로그인 단계가 있는가(fixture는 세션이 있다고 본다. 홈택스 로그인은 PoC-3). */
  login: boolean;
  issueForm: string;
  selectors: Record<SelectorKey, SelectorEntry>;
  /** 발급 화면의 명시적 실패 신호(오류 문구, D02 §4.4). */
  failureSignal: string;
  invoiceLookup: LookupDef;
  mailLookup: LookupDef;
  /** policy.verify(D02 §4.4). 홈택스는 앱 하한(60초·2회)보다 느슨할 수 없다. */
  verify: { minElapsedMs: number; lookups: number; intervalMs: number };
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
    failureSignal: '#issue-error',
    invoiceLookup: { path: '/invoice/list', query: { counterpartBizNo: 'bizNo', issueDate: 'date' }, rows: '#invoice-list tr[data-row]' },
    mailLookup: { path: '/mail/list', query: { approvalNo: 'approvalNo' }, rows: '#mail-list tr[data-row]' },
    // 가짜 페이지는 반영이 바로 된다. 시험이 빨리 끝나게 짧게 둔다(홈택스 값과 섞이지 않게 kind로 나눈다).
    verify: { minElapsedMs: 600, lookups: 2, intervalMs: 200 },
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
  failureSignal: TODO,
  invoiceLookup: { path: TODO, query: {}, rows: TODO },
  mailLookup: { path: TODO, query: {}, rows: TODO },
  verify: { minElapsedMs: 60_000, lookups: 2, intervalMs: 10_000 },
};

/** 앱 하한(D02 §4.4 policy.verify 기본값). 플레이북·포털 값은 이보다 엄격한 쪽만 쓴다. fixture는 예외다. */
export const VERIFY_FLOOR = { minElapsedMs: 60_000, lookups: 2 } as const;

/** 실행 전 점검: 자리표시·앵커 없는 이름 패턴·하한 미달을 모두 찾는다. 하나라도 있으면 실행하지 않는다. */
export function portalProblems(p: PortalConfig): string[] {
  const out: string[] = [];
  const todo = (where: string, v: string) => v.includes(TODO) && out.push(`placeholder:${where}`);
  todo('issueForm', p.issueForm);
  todo('failureSignal', p.failureSignal);
  for (const [k, l] of [['invoiceLookup', p.invoiceLookup], ['mailLookup', p.mailLookup]] as const) {
    todo(`${k}.path`, l.path);
    todo(`${k}.rows`, l.rows);
  }
  for (const k of SELECTOR_KEYS) {
    const e = p.selectors[k];
    todo(`selector:${k}`, e.css);
    todo(`name:${k}`, e.name);
    if (!e.name.includes(TODO) && !(e.name.startsWith('^') && e.name.endsWith('$'))) out.push(`unanchored:${k}`);
  }
  if (!READBACK_FIELDS.every((f) => SELECTOR_KEYS.some((k) => p.selectors[k].fieldKey === f))) out.push('readback_field_without_selector');
  if (p.kind === 'hometax' && (p.verify.minElapsedMs < VERIFY_FLOOR.minElapsedMs || p.verify.lookups < VERIFY_FLOOR.lookups)) out.push('verify_below_floor');
  return out;
}
