import fs from 'node:fs';
import path from 'node:path';
import type { PackageFiles, SelectorEntry, Step } from '@sax/engine/core';

const SELECT_ONLY = '*only';

const H01_DIR = path.resolve(import.meta.dirname, '../../packages/engine/playbooks/hometax.invoice.issue');
const H01_LOGIN_STEPS = ['s0', 's2', 's3', 's4', 's4a', 's4b', 's4c', 's8', 's8a', 's8b', 's4d', 's4e', 's4f', 's4g', 's4h', 's5', 's6', 's7', 's7a', 's7b', 's7c', 's7d', 's7e', 's7f', 's7g'];
const H01_LOGIN_STRINGS = ['login.loggedIn', 'hometax.login.successMarker', 'cert.passwordPrompt', 'cert.pickOne', 'login.certNoticeWindow', 'login.simpleAuth', 'popup.hide', 'popup.hide.idPrefix', 'popup.hide.cookie', 'popup.window.close'];
interface H01Login { steps: Step[]; entries: Record<string, SelectorEntry>; strings: Record<string, string>; closeWindows: string[]; closeLayers: { targets: string[]; until: string } }
let h01Cache: H01Login | null = null;
export function h01Login(): H01Login {
  if (h01Cache) return h01Cache;
  const read = (f: string) => JSON.parse(fs.readFileSync(path.join(H01_DIR, f), 'utf8'));
  const pb = read('playbook.json') as { steps: Step[]; closeWindows: string[]; closeLayers: { targets: string[]; until: string } };
  const sel = read('selectors.json') as { entries: Record<string, SelectorEntry> };
  const st = read('strings.ko.json') as Record<string, string>;
  const steps = H01_LOGIN_STEPS.map((id) => {
    const x = pb.steps.find((y) => y.id === id);
    if (!x) throw new Error(`H-01에 로그인 스텝이 없다: ${id}`);
    return x;
  });
  const keys = new Set<string>();
  const walk = (x: unknown): void => {
    if (Array.isArray(x)) x.forEach(walk);
    else if (x && typeof x === 'object') Object.values(x).forEach(walk);
    else if (typeof x === 'string' && Object.hasOwn(sel.entries, x)) keys.add(x);
  };
  walk(steps);
  walk(pb.closeLayers.targets);
  for (const k of [...keys]) for (let l = sel.entries[k]!.landmark; l && !keys.has(l); l = sel.entries[l]?.landmark) keys.add(l);
  const strings = Object.fromEntries(H01_LOGIN_STRINGS.map((k) => {
    if (!Object.hasOwn(st, k)) throw new Error(`H-01에 로그인 글이 없다: ${k}`);
    return [k, st[k]!];
  }));
  h01Cache = { steps, entries: Object.fromEntries([...keys].sort().map((k) => [k, sel.entries[k]!])), strings, closeWindows: pb.closeWindows, closeLayers: pb.closeLayers };
  return h01Cache;
}

export const CERT_VERSION = '1.0.0';
export const LOOKUP_ID = 'hometax.cert.issued_list';
const VERIFIED = '2026-11-10';
const ZERO = '0'.repeat(64);
const SIGS = [
  { keyId: 'pkg-1', alg: 'ed25519', sig: 'A'.repeat(86) },
  { keyId: 'pkg-2', alg: 'ed25519', sig: 'B'.repeat(86) },
];
const DOMAINS = ['hometax.go.kr', '*.hometax.go.kr'];

interface TplEntry {
  entry: Omit<SelectorEntry, 'frame' | 'lastVerified' | 'candidates'> & { candidates?: SelectorEntry['candidates'] };
  capture?: string;
}

interface DocField {
  input: string;
  inputDef: { type: 'string' | 'enum'; required?: boolean; default?: string; values?: string[] };
  fieldKey: string;
  label: string;
  role: 'textbox' | 'combobox';
  css?: string;
  capture?: string;
  screenName?: string;
  namePattern?: string;
  screenOnly?: true;
}

const menuUrl = (code: string) => `https://hometax.go.kr/websquare/websquare.html?w2xPath=/ui/pp/index_pp.xml&tmIdx=43&tm2lIdx=4315010000&tm3lIdx=${code}`;

export interface CertDoc {
  code: 'H-03' | 'H-08' | 'H-09';
  id: string;
  docType: string;
  name: string;
  title: string;
  confirm: string;
  fields: DocField[];
  menuCode: string | null;
  formTitle: string;
  submit: { name: string; css: string | null };
  confirmLayer?: { apply: { name: string; css: string }; root: string };
  version?: string;
  menuCapture?: string;
  formCapture?: string;
}

const HALF = ['1기', '2기'];

export const CERT_DOCS: readonly CertDoc[] = [
  {
    code: 'H-03', id: 'hometax.cert.biz_registration', docType: 'biz_registration_cert', name: '사업자등록증명',
    title: '사업자등록증명 발급', confirm: '사업자등록증명을 발급할까요?', fields: [],
    menuCode: '4315010800', formTitle: '사업자등록증명 발급 신청',
    submit: { name: '작성완료', css: '#mf_txppWframe_btn_wrtCmpl' },
    confirmLayer: { apply: { name: '신청하기', css: '#mf_txppWframe_UTECAAA0A016_wframe_btn_sbms' }, root: '#mf_txppWframe_UTECAAA0A016' }, version: '1.0.1',
  },
  {
    code: 'H-08', id: 'hometax.cert.vat_tax_base', docType: 'vat_tax_base_cert', name: '부가가치세 과세표준증명',
    title: '부가가치세 과세표준증명 발급', confirm: '부가가치세 과세표준증명을 발급할까요?',
    menuCode: '4315010500', formTitle: '부가가치세 과세표준증명원 접수', submit: { name: '신청하기', css: '#mf_txppWframe_btn_apln' },
    fields: [
      { input: 'periodStartYear', inputDef: { type: 'string', required: true }, fieldKey: 'taxPeriodStartYear', label: '과세기간 시작년도', screenName: '과세기간', namePattern: '^과세기간( 시작년도)?$', role: 'combobox', css: '#mf_txppWframe_sbx_txnrmStrtYear' },
      { input: 'periodStartHalf', inputDef: { type: 'enum', required: true, values: HALF }, fieldKey: 'taxPeriodStartHalf', label: '과세기간 시작년도 분기', role: 'combobox', css: '#mf_txppWframe_sbx_strtHt' },
      { input: 'periodEndYear', inputDef: { type: 'string', required: true }, fieldKey: 'taxPeriodEndYear', label: '과세기간 종료년도', role: 'combobox', css: '#mf_txppWframe_sbx_txnrmEndYear' },
      { input: 'periodEndHalf', inputDef: { type: 'enum', required: true, values: HALF }, fieldKey: 'taxPeriodEndHalf', label: '과세기간 종료년도 분기', role: 'combobox', css: '#mf_txppWframe_sbx_endHt' },
      { input: 'openDate', inputDef: { type: 'string' }, fieldKey: 'bizOpenDate', label: '발급희망개업일자', role: 'combobox', css: '#mf_txppWframe_sbx_bmanOfbDt', screenOnly: true },
    ],
  },
  {
    code: 'H-09', id: 'hometax.cert.financial_statements', docType: 'financial_statements_cert', name: '표준재무제표증명(개인/법인)',
    title: '표준재무제표증명 발급', confirm: '표준재무제표증명을 발급할까요?',
    fields: [
      { input: 'fiscalYear', inputDef: { type: 'string', required: true }, fieldKey: 'fiscalYear', label: '과세년도', role: 'textbox', css: '#mf_txppWframe_ibx_txyr' },
    ],
    menuCode: '4315011800', formTitle: '표준재무제표증명(개인/법인) 신청',
    submit: { name: '작성완료', css: '#mf_txppWframe_btn_wrtCmpl' },
    confirmLayer: { apply: { name: '신청하기', css: '#mf_txppWframe_UTECAAA0A016_wframe_btn_sbms' }, root: '#mf_txppWframe_UTECAAA0A016' }, version: '1.0.1',
  },
];

const role = (r: string, name: string) => ({ kind: 'role' as const, role: r, name });
const lit = (s: string) => `^${s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`;

function pageEntries(): Record<string, TplEntry> {
  return {
    'hometax.page.root': { entry: { candidates: [{ kind: 'css', value: '#mf_wrap' }], role: 'generic', namePattern: '^$', landmark: 'hometax.page.root', commits: false } },
  };
}

const NAV_REVIEW = { by: 'engine-cert', reason: '상단 메뉴 이동(navigationOnly), 커밋 아님' };

function menuEntries(doc: CertDoc): Record<string, TplEntry> {
  return {
    'hometax.cert.menu.civil': {
      entry: { candidates: [role('link', '증명·등록·신청')], role: 'link', namePattern: '^증명·등록·신청$', landmark: 'hometax.page.root', commits: false, navigationOnly: true, reviewNote: NAV_REVIEW },
      capture: '상단 메뉴 「증명·등록·신청」 링크의 접근성 이름(R2 §4)',
    },
    'hometax.cert.menu.issue': {
      entry: { candidates: [role('link', '민원증명(발급)')], role: 'link', namePattern: '^민원증명\\(발급\\)$', landmark: 'hometax.page.root', commits: false, navigationOnly: true, reviewNote: NAV_REVIEW },
      capture: '「민원증명(발급)」(또는 「즉시발급 증명」) 하위 메뉴 이름(02 §5.1·R2 §4 표기가 다르다)',
    },
    'hometax.cert.menu.doc': {
      entry: { candidates: [role('link', doc.name)], role: 'link', namePattern: lit(doc.name), landmark: 'hometax.page.root', commits: false, navigationOnly: true },
      ...(doc.menuCapture ? { capture: doc.menuCapture } : {}),
    },
  };
}

const FORM = 'hometax.cert.form.root';
const TITLE = 'hometax.cert.form.title';

export const PURPOSES = ['입찰, 계약용', '수금용', '관공서제출용', '대출용', '여권또는비자신청용', '건강보험·국민연금공단제출용', '금융기관제출용', '신용카드발급용', '기타'];
export const SUBMIT_TO = ['금융기관', '관공서', '조합/협회', '거래처', '학교', '외교부/재외공관/재외동포청', '기타'];
const RECEIVE = '인터넷발급(프린터출력)';
const COPIES = '1매';
const ALERT = 'hometax.cert.alert';
const CONFIRM_LAYER = 'hometax.cert.confirm.root';
const CONFIRM_APPLY = 'hometax.cert.confirm.apply';
const CONFIRM_WAIT_MS = 30_000;

function formEntries(doc: CertDoc): Record<string, TplEntry> {
  const box = (name: string, r: string, fieldKey: string, inputType: SelectorEntry['inputType'], css: string | null, capture: string | undefined, extra: Partial<SelectorEntry> = {}): TplEntry => ({
    entry: { candidates: [...(css ? [{ kind: 'css' as const, value: css }] : []), role(r, name)], role: r, namePattern: lit(name), landmark: FORM, commits: false, fieldKey, ...(inputType ? { inputType } : {}), ...extra },
    ...(capture ? { capture } : {}),
  });
  const shown = (css: string, fieldKey: string, landmark: string, role = 'generic'): TplEntry => ({ entry: { candidates: [{ kind: 'css', value: css }], role, namePattern: '^$', landmark, commits: false, fieldKey, inputType: 'text' } });
  const radios = (css: string, fieldKey: string, extra: Partial<SelectorEntry> = {}): TplEntry => ({ entry: { candidates: [{ kind: 'css', value: css }], role: 'generic', namePattern: '^$', landmark: FORM, commits: false, fieldKey, inputType: 'radio', ...extra } });
  const out: Record<string, TplEntry> = {
    [FORM]: { entry: { candidates: [{ kind: 'css', value: '#mf_txppWframe' }], role: 'generic', namePattern: '^$', landmark: 'hometax.page.root', commits: false } },
    [TITLE]: { entry: { candidates: [role('heading', doc.formTitle)], role: 'heading', namePattern: lit(doc.formTitle), landmark: FORM, commits: false } },
    'hometax.cert.form.docName': shown('#mf_wfHeader_spn_third', 'certDoc', 'hometax.cert.form.docName', 'strong'),
    'hometax.cert.form.applicantBizNo': shown('#mf_txppWframe_pfm_UTECAAA0Z001_tbx_cvaAplnBscBsno', 'supplierBizNo', FORM, 'paragraph'),
    'hometax.cert.form.applicantName': shown('#mf_txppWframe_pfm_UTECAAA0Z001_tbx_cvaAplnBscTnm', 'supplierName', FORM, 'paragraph'),
    'hometax.cert.form.language': radios('#mf_txppWframe_rad_englCvaAplnYn', 'certLanguage', { allowedConstants: ['한글증명'] }),
    'hometax.cert.form.purpose': box('사용용도', 'combobox', 'certPurpose', 'select', '#mf_txppWframe_sbx_cvaDcumUseUsgCd', undefined),
    'hometax.cert.form.submitTo': box('제출처', 'combobox', 'certSubmitTo', 'select', '#mf_txppWframe_sbx_cvaDcumSbmsOrgnClCd', undefined),
    'hometax.cert.form.rrnDisclosure': radios('#mf_txppWframe_pfm_UTECAAA0Z002_rad_cvaAplnRecptResNoOpYn', 'rrnDisclosure'),
    'hometax.cert.form.receiveMethod': box('수령방법', 'combobox', 'receiveMethod', 'select', '#mf_txppWframe_pfm_UTECAAA0Z002_sbx_cvaAplnRecptMthd', undefined, { allowedConstants: [RECEIVE] }),
    'hometax.cert.form.copies': box('발급희망수량', 'combobox', 'copies', 'select', '#mf_txppWframe_pfm_UTECAAA0Z002_sbx_cvaAplnRecptIsnHopeQty', undefined, { allowedConstants: [COPIES] }),
  };
  for (const f of doc.fields) out[`hometax.cert.form.${f.input}`] = box(f.screenName ?? f.label, f.role, f.screenOnly ? '_ignore' : f.fieldKey, f.role === 'textbox' ? 'text' : 'select', f.css ?? null, f.capture, { ...(f.namePattern ? { namePattern: f.namePattern } : {}), ...(f.screenOnly ? { allowedConstants: [SELECT_ONLY], reviewNote: { by: 'cert-docs', reason: `${f.label}: 화면이 정한 값, 선택지가 하나일 때만 고른다(*only)` } } : {}) });
  out['hometax.cert.form.issueButton'] = {
    entry: {
      candidates: [...(doc.submit.css ? [{ kind: 'css' as const, value: doc.submit.css }] : []), role('button', doc.submit.name)], expect: { visible: true, enabled: true },
      role: 'button', namePattern: lit(doc.submit.name), landmark: FORM, commits: true, commitEffect: 'issue_document',
    },
    ...(doc.confirmLayer ? {} : { capture: `[${doc.submit.name}]을 유효한 값으로 누른 뒤: 확인창·전자서명 창이 뜨는지, wqAction actionId(HAR → commitEndpoints). 접수가 실제로 생기므로 사용자 승인 뒤` }),
  };
  const layer = doc.confirmLayer;
  if (layer) {
    out[CONFIRM_LAYER] = { entry: { candidates: [{ kind: 'css', value: layer.root }], role: 'generic', namePattern: '^$', landmark: CONFIRM_LAYER, commits: false } };
    out[CONFIRM_APPLY] = {
      entry: {
        candidates: [{ kind: 'css', value: layer.apply.css }, role('button', layer.apply.name)], expect: { visible: true, enabled: true },
        role: 'button', namePattern: lit(layer.apply.name), landmark: CONFIRM_LAYER, commits: true, commitEffect: 'issue_document',
        reviewNote: { by: 'cert-docs', reason: '[작성완료]가 연 신청 확인 레이어(UTECAAA0A016)의 [신청하기]가 실제 신청이다(실화면 2026-11-18). submit 무장 구간에서만 누른다' },
      },
      capture: `[${layer.apply.name}]을 누른 뒤: 전자서명 창이 뜨는지(뜨면 signFlow readyTarget·doneTarget을 더한다), wqAction actionId(HAR → commitEndpoints). 접수가 실제로 생기므로 사용자 승인 뒤`,
    };
  }
  out[ALERT] = {
    entry: { candidates: [role('dialog', '알림')], role: 'dialog', namePattern: '^알림$', landmark: 'hometax.page.root', commits: false },
    capture: '알림창(.w2window.w2popup_window.msg)의 접근성 역할·이름. 본문 「해당 화면은 개인사업자는 이용할 수 없습니다.」',
  };
  return out;
}

const dict = (entries: Record<string, TplEntry>, commit: boolean) => ({
  portal: 'hometax',
  commitEndpoints: [] as unknown[],
  knownEndpoints: commit ? [{ method: 'GET', pathPattern: '^/websquare/.*$' }, { method: 'GET', pathPattern: '^/MagicLine4XML/.*$' }, { method: 'POST', pathPattern: '^/wqAction\\.do$' }, { method: 'POST', pathPattern: '^/permission\\.do$' }] : [],
  entries: {
    ...h01Login().entries,
    ...Object.fromEntries(Object.entries(entries).map(([k, v]) => [k, { ...v.entry, candidates: v.entry.candidates ?? [], frame: 'main', lastVerified: VERIFIED }])),
  },
});

function steps(doc: CertDoc): Step[] {
  const docFill: Step[] = doc.fields.map((f, i) => (f.role === 'textbox'
    ? { id: `s16${String.fromCharCode(97 + i)}`, type: 'fill', target: `hometax.cert.form.${f.input}`, value: `$inputs.${f.input}` }
    : { id: `s16${String.fromCharCode(97 + i)}`, type: 'select', target: `hometax.cert.form.${f.input}`, option: f.screenOnly ? SELECT_ONLY : `$inputs.${f.input}` }) as Step);
  const asked = doc.fields.filter((f) => !f.screenOnly);
  const entry = (d: CertDoc): Step[] =>
    d.menuCode
      ? ([
          { id: 's10', type: 'goto', url: menuUrl(d.menuCode) },
          { id: 's10a', type: 'checkpoint', name: 'form', expect: { any: [{ exists: FORM }, { exists: ALERT }] }, url: menuUrl(d.menuCode), sessionRequired: true, reentry: 'reload' },
        ] as Step[])
      : ([
          { id: 's10', type: 'goto', url: 'https://hometax.go.kr/websquare/websquare.html?w2xPath=/ui/pp/index_pp.xml' },
          { id: 's10a', type: 'checkpoint', name: 'form', expect: { exists: 'hometax.header.logo' }, url: 'https://hometax.go.kr/websquare/websquare.html?w2xPath=/ui/pp/index_pp.xml', sessionRequired: true, reentry: 'reload' },
          { id: 's10b', type: 'click', target: 'hometax.cert.menu.civil' },
          { id: 's10c', type: 'click', target: 'hometax.cert.menu.issue' },
          { id: 's10d', type: 'click', target: 'hometax.cert.menu.doc' },
        ] as Step[]);
  const isDate = (f: DocField) => /Date$/.test(f.fieldKey);
  const docEq = asked.filter((f) => !isDate(f)).map((f) => ({ readbackEquals: { fieldKey: f.fieldKey, ref: `$inputs.${f.input}` } }));
  const dateEq: Step[] = asked.filter(isDate).map((f, i) => ({
    id: `s18${String.fromCharCode(97 + i)}`, type: 'assert', cond: { readbackEquals: { fieldKey: f.fieldKey, ref: `$inputs.${f.input}` } }, code: 'assert.input_mismatch', onFail: { retry: 0, then: 'abort' },
  }) as Step);
  return [
    ...h01Login().steps,
    ...entry(doc),
    { id: 's10x', type: 'assert', cond: { not: { textMatches: { target: ALERT, patternRef: 'cert.block.personalOnly' } } }, code: 'portal.personal_login_required', onFail: { retry: 0, then: 'abort' } },
    { id: 's11', type: 'wait', for: 'selector', value: FORM },
    { id: 's11t', type: 'assert', cond: { exists: TITLE }, code: 'assert.input_mismatch', onFail: { retry: 0, then: 'handoff' } },
    { id: 's12', type: 'select', target: 'hometax.cert.form.language', option: '$inputs.certLanguage' },
    { id: 's13', type: 'select', target: 'hometax.cert.form.purpose', option: '$inputs.purpose' },
    { id: 's13b', type: 'select', target: 'hometax.cert.form.submitTo', option: '$inputs.submitTo' },
    { id: 's14', type: 'select', target: 'hometax.cert.form.rrnDisclosure', option: '$inputs.rrnDisclosure' },
    { id: 's15', type: 'select', target: 'hometax.cert.form.receiveMethod', option: RECEIVE },
    { id: 's15b', type: 'select', target: 'hometax.cert.form.copies', option: COPIES },
    ...docFill,
    { id: 's19a', type: 'assert', cond: { fieldsFilled: { fields: ['certDoc', 'certPurpose', 'certSubmitTo', 'rrnDisclosure', 'receiveMethod', 'copies', ...asked.map((f) => f.fieldKey)] } }, code: 'assert.fields_missing' },
    { id: 's19b', type: 'readback', fields: ['certDoc', 'supplierBizNo', 'supplierName', 'certLanguage', 'certPurpose', 'certSubmitTo', 'rrnDisclosure', 'receiveMethod', 'copies', ...asked.map((f) => f.fieldKey)] },
    { id: 's19c', type: 'assert', cond: { readbackEquals: { fieldKey: 'supplierBizNo', ref: '$profile.bizNo' } }, code: 'assert.supplier_mismatch', onFail: { retry: 0, then: 'abort' } },
    {
      id: 's19f', type: 'assert', code: 'assert.input_mismatch', onFail: { retry: 0, then: 'abort' },
      cond: { all: [
        { readbackEquals: { fieldKey: 'certDoc', ref: '$inputs.certDoc' } },
        { readbackEquals: { fieldKey: 'certLanguage', ref: '$inputs.certLanguage' } },
        { readbackEquals: { fieldKey: 'certPurpose', ref: '$inputs.purpose' } },
        { readbackEquals: { fieldKey: 'certSubmitTo', ref: '$inputs.submitTo' } },
        { readbackEquals: { fieldKey: 'rrnDisclosure', ref: '$inputs.rrnDisclosure' } },
        ...docEq,
      ] },
    },
    ...dateEq,
    { id: 's20', type: 'gate', card: 'cert.confirm', authorizes: ['s21'], waitMs: 600000 },
    {
      id: 's21', type: 'submit', target: 'hometax.cert.form.issueButton', intent: '$intent.id', verify: 's30', onFail: { retry: 0, then: 'handoff' },
      ...(doc.confirmLayer ? { signFlow: { method: '$profile.signMethod', openTargets: [CONFIRM_APPLY], maxWaitMs: CONFIRM_WAIT_MS } } : {}),
    },
    {
      id: 's30', type: 'verify',
      lookup: {
        playbook: LOOKUP_ID,
        match: { certDoc: '$readback.certDoc' },
        window: 'today', baseline: 'pre_gate_snapshot', notCommittedPolicy: { minElapsedMs: 60000, lookups: 2 }, bind: { approvalNo: 'issueNo' },
      },
      failSignals: [{ css: '#errorDialog', text: '^(발급|신청)(이|에) 실패했습니다.*$' }],
      on: { committed: 's32', not_committed: 's10a', unknown: 'handoff' },
    },
    { id: 's32', type: 'save_pdf', strategy: 'print', docType: doc.docType },
    { id: 's34', type: 'end', status: 'success' },
  ] as Step[];
}

function inputs(doc: CertDoc): Record<string, unknown> {
  return {
    certDoc: { type: 'enum', values: [doc.name], default: doc.name },
    certLanguage: { type: 'enum', values: ['한글증명'], default: '한글증명' },
    purpose: { type: 'enum', required: true, values: PURPOSES },
    submitTo: { type: 'enum', required: true, values: SUBMIT_TO },
    rrnDisclosure: { type: 'enum', values: ['공개', '비공개'], default: '비공개' },
    ...Object.fromEntries(doc.fields.filter((f) => !f.screenOnly).map((f) => [f.input, f.inputDef])),
  };
}

const strings = (doc: CertDoc): Record<string, string> => ({
  'cert.title': doc.title,
  'cert.confirm': doc.confirm,
  ...h01Login().strings,
  'cert.block.personalOnly': '^.*해당 화면은 개인사업자는 이용할 수 없습니다\\..*$',
});

function manifest(id: string, kind: 'playbook' | 'lookup', title: string, lookupsUsed: unknown[], bundles: unknown[], effects: string[], version = CERT_VERSION) {
  return {
    id, version, kind, portal: 'hometax', title, profileKinds: ['business'], engineRange: '>=1.0.0 <2.0.0', domains: DOMAINS, effects,
    bundlesUsed: bundles, lookupsUsed, contentDigests: { playbook: ZERO, selectors: ZERO, strings: ZERO }, createdAt: '2026-11-09T00:00:00+09:00', signatures: SIGS,
  };
}

export function certPackage(doc: CertDoc): PackageFiles {
  const entries = { ...pageEntries(), ...menuEntries(doc), ...formEntries(doc) };
  return {
    manifest: manifest(doc.id, 'playbook', 'cert.title', [{ id: LOOKUP_ID, version: CERT_VERSION, digest: ZERO }], [], ['issue_document'], doc.version),
    playbook: {
      ir: 2, id: doc.id, version: doc.version ?? CERT_VERSION, portal: 'hometax', profileKinds: ['business'], effects: ['issue_document'], inputs: inputs(doc),
      preconditions: [{ profileHas: 'signMethod' }, { profileHas: 'bizNo' }],
      steps: steps(doc),
      postconditions: [{ varSet: 'issueNo' }, { artifact: 'pdf' }],
      pacing: { profile: 'interactive' },
      closeWindows: h01Login().closeWindows,
      closeLayers: { targets: h01Login().closeLayers.targets, until: 's12' },
    },
    selectors: dict(entries, true),
    strings: strings(doc),
  } as unknown as PackageFiles;
}

const LOGIN_IDS = new Set(['s1', 's90', 's91', 's92', 's93', ...H01_LOGIN_STEPS]);
const OLD_LOGIN_KEYS = ['hometax.nav.home', 'hometax.login.root', 'hometax.login.startButton', 'hometax.login.simpleAuthButton', 'hometax.captcha.image', 'hometax.captcha.input', 'hometax.captcha.submit'];

export function withH01Login(f: PackageFiles): PackageFiles {
  const h = h01Login();
  const pb = f.playbook as unknown as { steps: Step[]; closeWindows?: string[]; closeLayers?: unknown };
  if (!pb.steps.some((s) => s.id === 's10')) throw new Error(`${f.manifest.id}: 로그인 뒤 s10이 없다`);
  pb.steps = [...h.steps, ...pb.steps.filter((s) => !LOGIN_IDS.has(s.id))];
  pb.closeWindows = h.closeWindows;
  pb.closeLayers = { targets: h.closeLayers.targets, until: 's12' };
  const sel = f.selectors as unknown as { entries: Record<string, SelectorEntry> };
  for (const k of OLD_LOGIN_KEYS) delete sel.entries[k];
  sel.entries = { ...h.entries, ...sel.entries, 'hometax.page.root': { ...pageEntries()['hometax.page.root']!.entry, candidates: pageEntries()['hometax.page.root']!.entry.candidates!, frame: 'main', lastVerified: VERIFIED } as SelectorEntry };
  const st = f.strings as Record<string, string>;
  delete st['captcha.prompt'];
  Object.assign(st, h.strings);
  f.manifest.bundlesUsed = f.manifest.bundlesUsed.filter((b) => b.id !== 'screen_state' && (b.id !== 'form_ready' || pb.steps.some((s) => s.type === 'decide')));
  return f;
}

export function captureList(): string {
  const rows: string[] = [];
  const seen = new Set<string>();
  const add = (pkg: string, entries: Record<string, TplEntry>) => {
    for (const [k, v] of Object.entries(entries)) {
      if (!v.capture) continue;
      const key = `${k}|${v.capture}`;
      if (seen.has(key)) continue;
      seen.add(key);
      rows.push(`| ${pkg} | \`${k}\` | ${v.capture} |`);
    }
  };
  for (const d of CERT_DOCS) add(d.code, { ...menuEntries(d), ...formEntries(d) });
  return [
    '# 홈택스 즉시발급 민원증명(H-03·H-08·H-09) 실기기 캡처 목록',
    '',
    '`scripts/playbooks/hometax-certificate.ts`가 만든다(손으로 고치지 않는다). 셀렉터는 실제 화면과 대조하지 않았다. 아래 항목을 실기기에서 캡처(접근성 트리·스크린숏·HAR)해 채운다.',
    '',
    '2026-11-10 캡처(로그인 뒤 양식, 개인사업자 사업자 인증서)로 H-03·H-08의 칸 id·선택지·제출 버튼·메뉴 주소를 채웠다. 아래는 아직 남은 것이다.',
    '',
    '공통 흐름에서 확인할 것:',
    '- 민원증명 발급 로그인 수단(공동·금융인증서, 사업자용 간편인증 가능 여부, S16). 납세증명서·소득금액증명은 개인사업자 로그인으로 막힌다(대표자 개인 로그인 필요)',
    '- 발급 버튼을 누른 뒤 확인 대화상자·전자서명 창이 뜨는지(뜨면 submit에 expectConfirm·signFlow를 더한다)',
    '- 발급 요청의 `wqAction.do` actionId(HAR) → `commitEndpoints`',
    '- 발급 실패 안내의 요소와 문구 → verify `failSignals`(지금은 H-01과 같은 자리표시 `#errorDialog`)',
    '- PDF 경로: [출력]·[PDF 저장]·인쇄 대화상자 중 무엇이 되는지 → `save_pdf.strategy`(R2 §4는 과거 공식 「출력불가 프린터」)',
    '- 발급 확인 조회는 `hometax.cert.issued_list`(H-04와 공유, LAF-labs/tex#247)다. 그 화면(민원신청 처리결과 조회)의 캡처는 그 패키지 몫이고, 여기서는 결과 표에 민원명·용도·제출처·발급번호 열이 보이는지만 같이 본다(verify match 키 certDoc·certPurpose·certSubmitTo, bind issueNo, H-04와 같음)',
    '',
    '| 서류 | 셀렉터 | 캡처할 것 |',
    '|---|---|---|',
    ...rows,
    '',
  ].join('\n');
}
