// 홈택스 '즉시발급 민원증명' 공유 템플릿(ADR-018 결정 2, 02 §5.1): H-03 사업자등록증명·H-08 부가가치세 과세표준증명·H-09 표준재무제표증명.
// 서류마다 다른 것은 입력(용도·제출처 외 서류별 칸)과 셀렉터(메뉴 이름·양식 이름·서류별 칸)뿐이다. 흐름(로그인 → 메뉴 → 양식 → readback → 승인 → 발급 →
// 조회 verify → PDF)은 하나다. 이 파일이 원본이고, packages/engine/playbooks/hometax.cert.{biz_registration,vat_tax_base,financial_statements} 폴더는 여기서 만든 결과다
// (node scripts/gen-cert-playbooks.ts). 발급 확인 조회 hometax.cert.issued_list는 H-04와 공유하는 패키지라 여기서 만들지 않는다.
// 시험(tests/cert-playbooks.test.ts)이 저장된 JSON과 이 템플릿 결과가 같은지 본다(손으로 고치면 시험이 깨진다).
//
// 셀렉터는 실제 화면과 대조하지 않았다(H-01과 같음, ADR-025 PoC 상한). 이름은 research/R2 §4(사업자등록증명 메뉴·입력 칸, 중간 신뢰)와
// R10 §2-A에서 가져왔고, 모르는 것은 capture에 적어 실기기 캡처로 채운다. capture가 있는 항목 목록은 CAPTURE-hometax-cert.md로 같이 만든다.
// 홈택스 로그인 구간(s0~s6·s90~s93)과 그 셀렉터는 H-01과 같다(같은 포털·같은 화면).
import type { PackageFiles, SelectorEntry, Step } from '@sax/engine/core';

export const CERT_VERSION = '1.0.0';
/** 발급 확인 조회 패키지. H-04(금고 세션, LAF-labs/tex#247)와 같이 쓰는 IR 조회 패키지이고, 여기서는 참조만 한다(팀장 결정 2026-11-09) */
export const LOOKUP_ID = 'hometax.cert.issued_list';
const VERIFIED = '2026-11-09';
const ZERO = '0'.repeat(64);
/** H-01과 같은 앱 내장 번들 다이제스트(screen_state v2, form_ready v2) */
const BUNDLES = [
  { id: 'screen_state', ver: 2, digest: '2f9a3c129c007ec2876398998b77d75b9be52c5e60e49f03eab40a7c780cd082' },
  { id: 'form_ready', ver: 2, digest: 'b35492acfdd4fe4dbaee0971f1183adfe4511abba57cb4f18ffa5f944a923409' },
];
const SIGS = [
  { keyId: 'pkg-1', alg: 'ed25519', sig: 'A'.repeat(86) },
  { keyId: 'pkg-2', alg: 'ed25519', sig: 'B'.repeat(86) },
];
const DOMAINS = ['hometax.go.kr', '*.hometax.go.kr'];

/** 템플릿 셀렉터: 사전 항목 + 캡처로 확인할 것(capture, 사전에는 넣지 않는다) */
interface TplEntry {
  entry: Omit<SelectorEntry, 'frame' | 'lastVerified' | 'candidates'> & { candidates?: SelectorEntry['candidates'] };
  /** 실기기 캡처로 채울 것. 없으면 R2·R10 근거로 이름을 알고 있는 것 */
  capture?: string;
}

/** 서류별 입력 칸(용도·제출처·주민번호 공개 여부는 모든 서류 공통) */
interface DocField {
  input: string;
  inputDef: { type: 'string' | 'enum'; required?: boolean; default?: string; values?: string[] };
  fieldKey: string;
  label: string;
  role: 'textbox' | 'combobox';
  capture: string;
}

export interface CertDoc {
  /** 카탈로그 번호(07 문서 카탈로그) */
  code: 'H-03' | 'H-08' | 'H-09';
  id: string;
  /** 보관함 doc_type(save_pdf.docType) */
  docType: string;
  /** 서류 이름(메뉴 링크·양식 이름) */
  name: string;
  /** 승인 카드 제목·보조 설명 */
  title: string;
  confirm: string;
  /** 서류별 입력 칸 */
  fields: DocField[];
  /** 메뉴·양식 캡처 메모 */
  menuCapture: string;
  formCapture: string;
}

export const CERT_DOCS: readonly CertDoc[] = [
  {
    code: 'H-03', id: 'hometax.cert.biz_registration', docType: 'biz_registration_cert', name: '사업자등록증명',
    title: '사업자등록증명 발급', confirm: '사업자등록증명을 발급할까요?', fields: [],
    menuCapture: '「증명·등록·신청 > 민원증명(발급)」 아래 사업자등록증명 링크의 접근성 이름(R2 §4, 중간 신뢰)',
    formCapture: '사업자등록증명 신청 양식의 form 랜드마크 이름',
  },
  {
    code: 'H-08', id: 'hometax.cert.vat_tax_base', docType: 'vat_tax_base_cert', name: '부가가치세 과세표준증명',
    title: '부가가치세 과세표준증명 발급', confirm: '부가가치세 과세표준증명을 발급할까요?',
    fields: [
      { input: 'periodFrom', inputDef: { type: 'string', required: true }, fieldKey: 'taxPeriodFrom', label: '과세기간 시작', role: 'combobox', capture: '과세기간 시작(연·월 또는 연·기 선택) 칸의 역할·이름·값 형식(신고가 끝난 과세기간만 고를 수 있음, R10)' },
      { input: 'periodTo', inputDef: { type: 'string', required: true }, fieldKey: 'taxPeriodTo', label: '과세기간 끝', role: 'combobox', capture: '과세기간 끝 칸의 역할·이름·값 형식' },
    ],
    menuCapture: '부가가치세 과세표준증명 메뉴 링크 이름(면세사업자 수입금액증명과 같은 화면인지도)',
    formCapture: '부가가치세 과세표준증명 신청 양식의 form 랜드마크 이름',
  },
  {
    code: 'H-09', id: 'hometax.cert.financial_statements', docType: 'financial_statements_cert', name: '표준재무제표증명',
    title: '표준재무제표증명 발급', confirm: '표준재무제표증명을 발급할까요?',
    fields: [
      { input: 'fiscalYear', inputDef: { type: 'string', required: true }, fieldKey: 'fiscalYear', label: '귀속연도', role: 'combobox', capture: '귀속연도(또는 사업연도) 칸의 역할·이름·값 형식. 신고가 전산에 반영되지 않은 해는 목록에 없을 수 있음(R10)' },
    ],
    menuCapture: '표준재무제표증명(개인·법인) 메뉴 링크 이름. 개인·법인이 다른 메뉴인지',
    formCapture: '표준재무제표증명 신청 양식의 form 랜드마크 이름과, 신고 미반영으로 발급이 안 될 때의 안내 문구',
  },
];

const role = (r: string, name: string) => ({ kind: 'role' as const, role: r, name });
const lit = (s: string) => `^${s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`;

/** H-01 로그인 구간 셀렉터(같은 홈택스 화면) */
function loginEntries(): Record<string, TplEntry> {
  return {
    'hometax.page.root': { entry: { candidates: [role('main', '홈택스')], role: 'main', namePattern: '^홈택스$', landmark: 'hometax.page.root', commits: false } },
    'hometax.nav.home': { entry: { candidates: [role('link', '홈')], role: 'link', namePattern: '^홈$', landmark: 'hometax.page.root', commits: false, navigationOnly: true } },
    'hometax.login.root': { entry: { candidates: [role('form', '로그인')], role: 'form', namePattern: '^로그인$', landmark: 'hometax.page.root', commits: false } },
    'hometax.login.simpleAuthButton': {
      entry: { candidates: [role('button', '간편인증')], role: 'button', namePattern: '^간편인증$', landmark: 'hometax.login.root', commits: false, reviewNote: { by: 'reviewer-a', reason: '로그인 시작 버튼, 커밋 아님' } },
      capture: '민원증명 발급에 쓰는 로그인 수단: 공동·금융인증서 버튼 이름(사업자용 간편인증으로 발급되는지 S16, ADR-018 결정 10)',
    },
    'hometax.captcha.image': { entry: { candidates: [role('img', '자동입력 방지 문자')], role: 'img', namePattern: '^자동입력 방지 문자$', landmark: 'hometax.login.root', commits: false } },
    'hometax.captcha.input': { entry: { candidates: [role('textbox', '자동입력 방지 문자 입력')], role: 'textbox', namePattern: '^자동입력 방지 문자 입력$', landmark: 'hometax.login.root', commits: false, inputType: 'text' } },
    'hometax.captcha.submit': { entry: { candidates: [role('button', '확인')], role: 'button', namePattern: '^확인$', landmark: 'hometax.login.root', commits: false, reviewNote: { by: 'reviewer-a', reason: '캡차 확인, 로그인 구간' } } },
  };
}

/** 메뉴(조회·이동만) — 민원증명 메뉴는 세 서류가 같다 */
function menuEntries(doc: CertDoc): Record<string, TplEntry> {
  return {
    'hometax.cert.menu.civil': {
      entry: { candidates: [role('link', '증명·등록·신청')], role: 'link', namePattern: '^증명·등록·신청$', landmark: 'hometax.page.root', commits: false, navigationOnly: true },
      capture: '상단 메뉴 「증명·등록·신청」 링크의 접근성 이름(R2 §4)',
    },
    'hometax.cert.menu.issue': {
      entry: { candidates: [role('link', '민원증명(발급)')], role: 'link', namePattern: '^민원증명\\(발급\\)$', landmark: 'hometax.page.root', commits: false, navigationOnly: true },
      capture: '「민원증명(발급)」(또는 「즉시발급 증명」) 하위 메뉴 이름(02 §5.1·R2 §4 표기가 다르다)',
    },
    'hometax.cert.menu.doc': {
      entry: { candidates: [role('link', doc.name)], role: 'link', namePattern: lit(doc.name), landmark: 'hometax.page.root', commits: false, navigationOnly: true },
      capture: doc.menuCapture,
    },
  };
}

const FORM = 'hometax.cert.form.root';

/** 양식: 공통 칸(신청인·용도·제출처·주민번호 공개 여부·수령 방법) + 서류별 칸 + 발급 버튼 */
function formEntries(doc: CertDoc): Record<string, TplEntry> {
  const box = (name: string, r: string, fieldKey: string, inputType: SelectorEntry['inputType'], capture: string, extra: Partial<SelectorEntry> = {}): TplEntry => ({
    entry: { candidates: [role(r, name)], role: r, namePattern: lit(name), landmark: FORM, commits: false, fieldKey, ...(inputType ? { inputType } : {}), ...extra },
    capture,
  });
  const out: Record<string, TplEntry> = {
    [FORM]: { entry: { candidates: [role('form', doc.name)], role: 'form', namePattern: lit(doc.name), landmark: 'hometax.page.root', commits: false }, capture: doc.formCapture },
    'hometax.cert.form.docName': box('민원명', 'textbox', 'certDoc', 'text', '양식에 보이는 서류 이름(민원명·증명서 종류) 칸. 승인 카드 첫 줄 「서류」 값이다(읽기 전용 표시일 수 있음)'),
    'hometax.cert.form.applicantBizNo': box('사업자등록번호', 'textbox', 'supplierBizNo', 'text', '신청 양식에 보이는 내 사업자등록번호 칸(읽기 전용일 수 있음). 여러 사업장이면 「내 사업자 선택」 화면이 먼저 나오는지(R2 §4)'),
    'hometax.cert.form.applicantName': box('상호', 'textbox', 'supplierName', 'text', '신청 양식의 상호(법인명) 칸'),
    'hometax.cert.form.purpose': box('사용 용도', 'combobox', 'certPurpose', undefined, '사용 용도 칸: 고르기(combobox)인지 직접 입력인지, 고를 수 있는 값 목록(R2 §4)'),
    'hometax.cert.form.submitTo': box('제출처', 'textbox', 'certSubmitTo', 'text', '제출처 칸: 직접 입력인지 목록 선택인지, 글자 수 제한(R2 §4)'),
    'hometax.cert.form.rrnDisclosure': box('주민등록번호 공개 여부', 'combobox', 'rrnDisclosure', undefined, '주민등록번호 공개 여부 칸의 역할(라디오·고르기)과 값 이름(「공개」·「비공개」 표기)(R2 §4)'),
    'hometax.cert.form.receiveMethod': box('수령 방법', 'combobox', 'receiveMethod', undefined, '수령 방법 칸과 값 이름(인터넷 발급(프린터 출력) 등). allowedConstants를 실제 값으로', { allowedConstants: ['인터넷 발급'] }),
  };
  for (const f of doc.fields) out[`hometax.cert.form.${f.input}`] = box(f.label, f.role, f.fieldKey, undefined, f.capture);
  out['hometax.cert.form.issueButton'] = {
    entry: {
      candidates: [role('button', '발급하기')], expect: { visible: true, enabled: true }, role: 'button', namePattern: '^발급하기$', landmark: FORM, commits: true, commitEffect: 'issue_document',
    },
    capture: '발급(신청) 버튼 이름(「발급하기」·「신청하기」·「열람」 중 무엇인지)과, 누른 뒤 확인 대화상자·전자서명 창이 뜨는지. 발급 요청의 wqAction actionId(HAR, commitEndpoints)',
  };
  return out;
}

const dict = (entries: Record<string, TplEntry>, commit: boolean) => ({
  portal: 'hometax',
  // 발급 요청의 actionId는 아직 모른다(HAR 캡처). 알기 전에는 commitEndpoints가 비어 커밋 가드가 이 요청을 '분류 안 됨'으로만 기록한다(R-C3)
  commitEndpoints: [] as unknown[],
  knownEndpoints: commit ? [{ method: 'GET', pathPattern: '^/websquare/.*$' }, { method: 'POST', pathPattern: '^/wqAction\\.do$' }] : [],
  entries: Object.fromEntries(Object.entries(entries).map(([k, v]) => [k, { ...v.entry, candidates: v.entry.candidates ?? [], frame: 'main', lastVerified: VERIFIED }])),
});

/** 공유 흐름(서류별 칸 채우기·대조만 다르다) */
function steps(doc: CertDoc): Step[] {
  const decideLogin = (id: string, max: number, captcha: string, login: string): Step =>
    ({ id, type: 'decide', bundle: 'screen_state_v2', scope: 'root', loopGuard: { max }, on: { logged_in: 's10', login_required: login, captcha, mfa_pending: 's5', error: 'handoff', unknown: 'handoff' } }) as Step;
  const docFill: Step[] = doc.fields.map((f, i) => ({ id: `s16${String.fromCharCode(97 + i)}`, type: 'select', target: `hometax.cert.form.${f.input}`, option: `$inputs.${f.input}` }) as Step);
  const docEq = doc.fields.map((f) => ({ readbackEquals: { fieldKey: f.fieldKey, ref: `$inputs.${f.input}` } }));
  return [
    { id: 's0', type: 'checkpoint', name: 'session', expect: { exists: 'hometax.nav.home' }, url: 'https://hometax.go.kr/', sessionRequired: true, reentry: 'reload' },
    { id: 's1', type: 'goto', url: 'https://hometax.go.kr/' },
    decideLogin('s2', 3, 's90', 's3'),
    { id: 's3', type: 'click', target: 'hometax.login.simpleAuthButton' },
    { id: 's4', type: 'sign', method: '$profile.signMethod', then: ['human:secret'] },
    { id: 's5', type: 'wait', for: 'text', value: 'hometax.login.successMarker', timeoutMs: 120000, pace: 'slow' },
    decideLogin('s6', 3, 's90', 'handoff'),
    // 메뉴로 들어간다. 민원증명 화면의 직접 URL은 모른다(캡처 목록). 그래서 게이트를 지배하는 체크포인트(V-03l: url·reload)는 홈 화면에 두고,
    // 다시 들어올 때(수정하기·발급 안 됨)도 홈 → 메뉴 → 양식 순서로 다시 채운다. 양식 URL을 알면 이 체크포인트를 양식 URL로 옮긴다(정식 버전).
    { id: 's10', type: 'checkpoint', name: 'form', expect: { exists: 'hometax.nav.home' }, url: 'https://hometax.go.kr/', sessionRequired: true, reentry: 'reload' },
    { id: 's10a', type: 'click', target: 'hometax.cert.menu.civil' },
    { id: 's10b', type: 'click', target: 'hometax.cert.menu.issue' },
    { id: 's10c', type: 'click', target: 'hometax.cert.menu.doc' },
    { id: 's11', type: 'wait', for: 'selector', value: FORM },
    { id: 's12', type: 'select', target: 'hometax.cert.form.purpose', option: '$inputs.purpose' },
    { id: 's13', type: 'fill', target: 'hometax.cert.form.submitTo', value: '$inputs.submitTo' },
    { id: 's14', type: 'select', target: 'hometax.cert.form.rrnDisclosure', option: '$inputs.rrnDisclosure' },
    { id: 's15', type: 'select', target: 'hometax.cert.form.receiveMethod', option: '인터넷 발급' },
    ...docFill,
    { id: 's19', type: 'decide', bundle: 'form_ready_v2', scope: FORM, on: { no_visible_error: 's19a', validation_error: 'handoff', unknown: 'handoff' } },
    { id: 's19a', type: 'assert', cond: { fieldsFilled: { fields: ['certDoc', 'certPurpose', 'certSubmitTo', 'rrnDisclosure', ...doc.fields.map((f) => f.fieldKey)] } }, code: 'assert.fields_missing' },
    { id: 's19b', type: 'readback', fields: ['certDoc', 'supplierBizNo', 'supplierName', 'certPurpose', 'certSubmitTo', 'rrnDisclosure', 'receiveMethod', ...doc.fields.map((f) => f.fieldKey)] },
    // 신청인이 내 사업자인지(다른 사업장 증명을 떼지 않게)
    { id: 's19c', type: 'assert', cond: { readbackEquals: { fieldKey: 'supplierBizNo', ref: '$profile.bizNo' } }, code: 'assert.supplier_mismatch', onFail: { retry: 0, then: 'abort' } },
    {
      id: 's19f', type: 'assert', code: 'assert.input_mismatch', onFail: { retry: 0, then: 'abort' },
      cond: { all: [
        // 양식이 고른 서류인지(메뉴를 잘못 타 다른 증명 양식에 채우지 않게)
        { readbackEquals: { fieldKey: 'certDoc', ref: '$inputs.certDoc' } },
        { readbackEquals: { fieldKey: 'certPurpose', ref: '$inputs.purpose' } },
        { readbackEquals: { fieldKey: 'certSubmitTo', ref: '$inputs.submitTo' } },
        { readbackEquals: { fieldKey: 'rrnDisclosure', ref: '$inputs.rrnDisclosure' } },
        ...docEq,
      ] },
    },
    { id: 's20', type: 'gate', card: 'cert.confirm', authorizes: ['s21'], waitMs: 600000 },
    // 확인 대화상자·전자서명 창이 뜨는지는 캡처로 확인한다(뜨면 expectConfirm·signFlow를 더한다, 정식 버전)
    { id: 's21', type: 'submit', target: 'hometax.cert.form.issueButton', intent: '$intent.id', verify: 's30', onFail: { retry: 0, then: 'handoff' } },
    {
      id: 's30', type: 'verify',
      lookup: {
        playbook: LOOKUP_ID,
        // 조회 열 이름은 hometax.cert.issued_list(H-04와 공유)를 따른다
        match: { certDoc: '$readback.certDoc', certPurpose: '$readback.certPurpose', certSubmitTo: '$readback.certSubmitTo' },
        window: 'today', baseline: 'pre_gate_snapshot', notCommittedPolicy: { minElapsedMs: 60000, lookups: 2 }, bind: { approvalNo: 'issueNo' },
      },
      failSignals: [{ css: '#errorDialog', text: '^(발급|신청)(이|에) 실패했습니다.*$' }],
      on: { committed: 's32', not_committed: 's10', unknown: 'handoff' },
    },
    // 홈택스 민원증명 PDF 경로는 실측 전이다(R2 §4·R10 §1). 인쇄 경로로 두고 캡처 결과로 정한다
    { id: 's32', type: 'save_pdf', strategy: 'print', docType: doc.docType },
    { id: 's34', type: 'end', status: 'success' },
    { id: 's90', type: 'human', kind: 'captcha', region: 'hometax.captcha.image', prompt: 'captcha.prompt', ttlMs: 90000 },
    { id: 's91', type: 'fill', target: 'hometax.captcha.input', value: '$human.s90' },
    { id: 's92', type: 'click', target: 'hometax.captcha.submit' },
    decideLogin('s93', 2, 'handoff', 's3'),
  ] as Step[];
}

function inputs(doc: CertDoc): Record<string, unknown> {
  return {
    // 서류 이름은 패키지마다 하나로 고정이다(readback 대조용, 사용자가 바꾸지 않는다)
    certDoc: { type: 'enum', values: [doc.name], default: doc.name },
    purpose: { type: 'string', required: true },
    submitTo: { type: 'string', required: true },
    // 주민번호는 기본으로 가린다(최소 노출, 02 §5.2-1과 같은 원칙)
    rrnDisclosure: { type: 'enum', values: ['공개', '비공개'], default: '비공개' },
    ...Object.fromEntries(doc.fields.map((f) => [f.input, f.inputDef])),
  };
}

const strings = (doc: CertDoc): Record<string, string> => ({
  'cert.title': doc.title,
  'cert.confirm': doc.confirm,
  'captcha.prompt': '그림의 문자를 입력해 주세요',
  'hometax.login.successMarker': '로그아웃',
});

function manifest(id: string, kind: 'playbook' | 'lookup', title: string, lookupsUsed: unknown[], bundles: unknown[], effects: string[]) {
  return {
    id, version: CERT_VERSION, kind, portal: 'hometax', title, profileKinds: ['business'], engineRange: '>=1.0.0 <2.0.0', domains: DOMAINS, effects,
    bundlesUsed: bundles, lookupsUsed, contentDigests: { playbook: ZERO, selectors: ZERO, strings: ZERO }, createdAt: '2026-11-09T00:00:00+09:00', signatures: SIGS,
  };
}

/** 서류 하나의 발급 패키지(서명 전 원본) */
export function certPackage(doc: CertDoc): PackageFiles {
  const entries = { ...loginEntries(), ...menuEntries(doc), ...formEntries(doc) };
  return {
    manifest: manifest(doc.id, 'playbook', 'cert.title', [{ id: LOOKUP_ID, version: CERT_VERSION, digest: ZERO }], BUNDLES, ['issue_document']),
    playbook: {
      ir: 2, id: doc.id, version: CERT_VERSION, portal: 'hometax', profileKinds: ['business'], effects: ['issue_document'], inputs: inputs(doc),
      preconditions: [{ profileHas: 'signMethod' }, { profileHas: 'bizNo' }],
      steps: steps(doc),
      postconditions: [{ varSet: 'issueNo' }, { artifact: 'pdf' }],
      pacing: { profile: 'interactive' },
    },
    selectors: dict(entries, true),
    strings: strings(doc),
  } as unknown as PackageFiles;
}

/** 캡처할 화면 목록(사용자에게 요청) */
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
  for (const d of CERT_DOCS) add(d.code, { ...loginEntries(), ...menuEntries(d), ...formEntries(d) });
  return [
    '# 홈택스 즉시발급 민원증명(H-03·H-08·H-09) 실기기 캡처 목록',
    '',
    '`scripts/playbooks/hometax-certificate.ts`가 만든다(손으로 고치지 않는다). 셀렉터는 실제 화면과 대조하지 않았다. 아래 항목을 실기기에서 캡처(접근성 트리·스크린숏·HAR)해 채운다.',
    '',
    '공통 흐름에서 확인할 것:',
    '- 민원증명 발급 로그인 수단(공동·금융인증서, 사업자용 간편인증 가능 여부, S16)',
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
