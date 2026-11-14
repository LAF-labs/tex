// 홈택스 '즉시발급 민원증명' 공유 템플릿(ADR-018 결정 2, 02 §5.1): H-03 사업자등록증명·H-08 부가가치세 과세표준증명·H-09 표준재무제표증명.
// 서류마다 다른 것은 입력(용도·제출처 외 서류별 칸)과 셀렉터(메뉴 이름·양식 이름·서류별 칸)뿐이다. 흐름(로그인 → 메뉴 → 양식 → readback → 승인 → 발급 →
// 조회 verify → PDF)은 하나다. 이 파일이 원본이고, packages/engine/playbooks/hometax.cert.{biz_registration,vat_tax_base,financial_statements} 폴더는 여기서 만든 결과다
// (node scripts/gen-cert-playbooks.ts). 발급 확인 조회 hometax.cert.issued_list는 H-04와 공유하는 패키지라 여기서 만들지 않는다.
// 시험(tests/cert-playbooks.test.ts)이 저장된 JSON과 이 템플릿 결과가 같은지 본다(손으로 고치면 시험이 깨진다).
//
// 셀렉터 id·선택지는 2026-11-10 실기기 캡처(로그인 뒤 양식 화면, 개인사업자 사업자 인증서 로그인, 값은 넣지 않음)로 채웠다. 제출 뒤 화면(확인창·actionId·열람·PDF)과
// H-09 화면은 아직 못 봤다. 모르는 것은 capture에 적어 실기기 캡처로 채운다. capture가 있는 항목 목록은 CAPTURE-hometax-cert.md로 같이 만든다.
// 홈택스 로그인 구간(s0~s7g)과 그 셀렉터·글은 H-01 원본에서 가져온다(h01Login).
import fs from 'node:fs';
import path from 'node:path';
import type { PackageFiles, SelectorEntry, Step } from '@sax/engine/core';

/**
 * 홈택스 로그인 구간은 H-01 발급 패키지(hometax.invoice.issue) 원본에서 그대로 가져온다: 같은 포털·같은 화면이고, 실화면 예행을 통과한 판이다(2.3.7).
 * s0~s7g 스텝, 그 스텝과 closeLayers가 쓰는 셀렉터(랜드마크까지), 로그인 글·팝업 숨김 글, closeWindows. H-01 파일은 읽기만 한다.
 * 로그인 스텝이 로그인 뒤 가는 곳은 s10(양식 열기)이다. H-01과 민원증명 모두 s10이 로그인 다음 스텝이다.
 */
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
/** 발급 확인 조회 패키지. H-04(금고 세션, LAF-labs/tex#247)와 같이 쓰는 IR 조회 패키지이고, 여기서는 참조만 한다(팀장 결정 2026-11-09) */
export const LOOKUP_ID = 'hometax.cert.issued_list';
const VERIFIED = '2026-11-10';
const ZERO = '0'.repeat(64);
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
  /** 캡처한 요소 id(없으면 역할·이름만) */
  css?: string;
  /** 캡처로 확인했으면 없음 */
  capture?: string;
}

/** 홈택스 민원증명 메뉴 직접 주소(캡처 2026-11-10). tm3lIdx가 서류 코드다 */
const menuUrl = (code: string) => `https://hometax.go.kr/websquare/websquare.html?w2xPath=/ui/pp/index_pp.xml&tmIdx=43&tm2lIdx=4315010000&tm3lIdx=${code}`;

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
  /** 메뉴 코드(tm3lIdx). 모르면 null이고 메뉴 클릭으로 들어간다 */
  menuCode: string | null;
  /** 양식 제목(form 랜드마크 이름) */
  formTitle: string;
  /** 제출 버튼(서류마다 다르다: H-03 작성완료, H-08 신청하기) */
  submit: { name: string; css: string | null };
  /** 메뉴·양식 캡처 메모(캡처했으면 없음) */
  menuCapture?: string;
  formCapture?: string;
}

const YEARS = '2026~1997 선택(캡처)';
const HALF = ['1기', '2기'];

export const CERT_DOCS: readonly CertDoc[] = [
  {
    code: 'H-03', id: 'hometax.cert.biz_registration', docType: 'biz_registration_cert', name: '사업자등록증명',
    title: '사업자등록증명 발급', confirm: '사업자등록증명을 발급할까요?', fields: [],
    menuCode: '4315010800', formTitle: '사업자등록증명 발급 신청', submit: { name: '작성완료', css: '#mf_txppWframe_btn_wrtCmpl' },
  },
  {
    code: 'H-08', id: 'hometax.cert.vat_tax_base', docType: 'vat_tax_base_cert', name: '부가가치세 과세표준증명',
    title: '부가가치세 과세표준증명 발급', confirm: '부가가치세 과세표준증명을 발급할까요?',
    menuCode: '4315010500', formTitle: '부가가치세 과세표준증명원 접수', submit: { name: '신청하기', css: '#mf_txppWframe_btn_apln' },
    // 과세기간은 시작·종료 연도와 1기·2기(간이과세자 2013년 이후분은 1기). 발급희망개업일자는 필수이고 선택지는 개업일 하나다
    fields: [
      { input: 'periodStartYear', inputDef: { type: 'string', required: true }, fieldKey: 'taxPeriodStartYear', label: '과세기간', role: 'combobox', css: '#mf_txppWframe_sbx_txnrmStrtYear', capture: `시작 연도 접근성 이름(라벨 「과세기간」이 시작 연도에 붙어 있다), 값 ${YEARS}` },
      { input: 'periodStartHalf', inputDef: { type: 'enum', required: true, values: HALF }, fieldKey: 'taxPeriodStartHalf', label: '과세기간 시작년도 분기', role: 'combobox', css: '#mf_txppWframe_sbx_strtHt' },
      { input: 'periodEndYear', inputDef: { type: 'string', required: true }, fieldKey: 'taxPeriodEndYear', label: '과세기간 종료년도', role: 'combobox', css: '#mf_txppWframe_sbx_txnrmEndYear' },
      { input: 'periodEndHalf', inputDef: { type: 'enum', required: true, values: HALF }, fieldKey: 'taxPeriodEndHalf', label: '과세기간 종료년도 분기', role: 'combobox', css: '#mf_txppWframe_sbx_endHt' },
      { input: 'openDate', inputDef: { type: 'string', required: true }, fieldKey: 'bizOpenDate', label: '발급희망개업일자', role: 'combobox', css: '#mf_txppWframe_sbx_bmanOfbDt' },
    ],
  },
  {
    code: 'H-09', id: 'hometax.cert.financial_statements', docType: 'financial_statements_cert', name: '표준재무제표증명',
    title: '표준재무제표증명 발급', confirm: '표준재무제표증명을 발급할까요?',
    fields: [
      { input: 'fiscalYear', inputDef: { type: 'string', required: true }, fieldKey: 'fiscalYear', label: '귀속연도', role: 'combobox', capture: '귀속연도(또는 사업연도) 칸의 id·이름·값 형식. 신고가 전산에 반영되지 않은 해는 목록에 없을 수 있음(R10)' },
    ],
    menuCode: null, formTitle: '표준재무제표증명', submit: { name: '신청하기', css: null },
    menuCapture: '표준재무제표증명 메뉴 코드(tm3lIdx). 2026-11-10 캡처에는 없다(소득금액증명 4315011000은 개인사업자 로그인에서 막혔다)',
    formCapture: '표준재무제표증명 양식 제목·제출 버튼(작성완료·신청하기)·개인사업자 로그인에서 막히는지',
  },
];

const role = (r: string, name: string) => ({ kind: 'role' as const, role: r, name });
const lit = (s: string) => `^${s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`;

/** 페이지 틀(H-01과 같은 #mf_wrap). 로그인 구간 셀렉터는 h01Login().entries다 */
function pageEntries(): Record<string, TplEntry> {
  return {
    'hometax.page.root': { entry: { candidates: [{ kind: 'css', value: '#mf_wrap' }], role: 'generic', namePattern: '^$', landmark: 'hometax.page.root', commits: false } },
  };
}

/**
 * 메뉴 링크 이름에 「등록」「신청」「발급」이 들어 있어 커밋 그림자 이름 규칙(DENY_ACTION_NAME)에 걸린다. 화면 이동만 하는 메뉴라 검토 메모로 푼다
 * (메모가 없으면 실행 때 step.commit_shadow로 누르지 않는다, 가짜 페이지 실행 시험에서 확인)
 */
const NAV_REVIEW = { by: 'engine-cert', reason: '상단 메뉴 이동(navigationOnly), 커밋 아님' };

/** 메뉴(조회·이동만) — 민원증명 메뉴는 세 서류가 같다 */
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

/** 사용용도·제출처 선택지(캡처 2026-11-10, H-03·H-08 같음) */
export const PURPOSES = ['입찰, 계약용', '수금용', '관공서제출용', '대출용', '여권또는비자신청용', '건강보험·국민연금공단제출용', '금융기관제출용', '신용카드발급용', '기타'];
export const SUBMIT_TO = ['금융기관', '관공서', '조합/협회', '거래처', '학교', '외교부/재외공관/재외동포청', '기타'];
/** 수령방법·수량은 고정값만 쓴다(인터넷발급(프린터출력), 1매) */
const RECEIVE = '인터넷발급(프린터출력)';
const COPIES = '1매';
const ALERT = 'hometax.cert.alert';

/** 양식: 공통 칸(서류·신청인·발급유형·용도·제출처·주민번호 공개·수령방법·수량) + 서류별 칸 + 제출 버튼 + 메뉴 차단 알림 */
function formEntries(doc: CertDoc): Record<string, TplEntry> {
  const box = (name: string, r: string, fieldKey: string, inputType: SelectorEntry['inputType'], css: string | null, capture: string | undefined, extra: Partial<SelectorEntry> = {}): TplEntry => ({
    entry: { candidates: [...(css ? [{ kind: 'css' as const, value: css }] : []), role(r, name)], role: r, namePattern: lit(name), landmark: FORM, commits: false, fieldKey, ...(inputType ? { inputType } : {}), ...extra },
    ...(capture ? { capture } : {}),
  });
  const out: Record<string, TplEntry> = {
    [FORM]: {
      entry: { candidates: [{ kind: 'css', value: '#mf_txppWframe' }, role('form', doc.formTitle)], role: 'form', namePattern: lit(doc.formTitle), landmark: 'hometax.page.root', commits: false },
      capture: doc.formCapture ?? '본문 틀 #mf_txppWframe의 역할(form인지)과 접근성 이름(양식 제목)',
    },
    // 서류·신청인은 입력 칸이 아니라 화면 표시다(신청인 사업자번호는 로그인에서 온다)
    'hometax.cert.form.docName': box('민원명', 'textbox', 'certDoc', 'text', null, '양식 제목(서류 이름)을 읽을 요소. 제목 요소 id는 wq_uuid라 고정이 아니다 → 역할·이름 확인'),
    'hometax.cert.form.applicantBizNo': box('사업자등록번호', 'textbox', 'supplierBizNo', 'text', null, '「기본 인적 사항」에 보이는 신청인 사업자번호 요소(입력 칸이 아님)의 id·역할'),
    'hometax.cert.form.applicantName': box('상호', 'textbox', 'supplierName', 'text', null, '「기본 인적 사항」의 상호 요소의 id·역할'),
    'hometax.cert.form.language': box('발급유형', 'radiogroup', 'certLanguage', 'radio', '#mf_txppWframe_rad_englCvaAplnYn', '라디오 묶음 요소(_input_0 한글, _input_1 영문증명)의 역할·이름', { allowedConstants: ['한글'] }),
    'hometax.cert.form.purpose': box('사용용도', 'combobox', 'certPurpose', 'select', '#mf_txppWframe_sbx_cvaDcumUseUsgCd', undefined),
    'hometax.cert.form.submitTo': box('제출처', 'combobox', 'certSubmitTo', 'select', '#mf_txppWframe_sbx_cvaDcumSbmsOrgnClCd', undefined),
    'hometax.cert.form.rrnDisclosure': box('주민등록번호 공개여부', 'radiogroup', 'rrnDisclosure', 'radio', '#mf_txppWframe_pfm_UTECAAA0Z002_rad_cvaAplnRecptResNoOpYn', '라디오 묶음 요소(_input_0 공개, _input_1 비공개)의 역할·이름'),
    'hometax.cert.form.receiveMethod': box('수령방법', 'combobox', 'receiveMethod', 'select', '#mf_txppWframe_pfm_UTECAAA0Z002_sbx_cvaAplnRecptMthd', undefined, { allowedConstants: [RECEIVE] }),
    'hometax.cert.form.copies': box('발급희망수량', 'combobox', 'copies', 'select', '#mf_txppWframe_pfm_UTECAAA0Z002_sbx_cvaAplnRecptIsnHopeQty', undefined, { allowedConstants: [COPIES] }),
  };
  for (const f of doc.fields) out[`hometax.cert.form.${f.input}`] = box(f.label, f.role, f.fieldKey, 'select', f.css ?? null, f.capture);
  out['hometax.cert.form.issueButton'] = {
    entry: {
      candidates: [...(doc.submit.css ? [{ kind: 'css' as const, value: doc.submit.css }] : []), role('button', doc.submit.name)], expect: { visible: true, enabled: true },
      role: 'button', namePattern: lit(doc.submit.name), landmark: FORM, commits: true, commitEffect: 'issue_document',
    },
    capture: `[${doc.submit.name}]을 유효한 값으로 누른 뒤: 확인창·전자서명 창이 뜨는지, wqAction actionId(HAR → commitEndpoints). 접수가 실제로 생기므로 사용자 승인 뒤`,
  };
  // 메뉴 차단 알림(.w2window.msg). id(mf_wfHeader_info<숫자>)는 매번 바뀌어 css 후보를 쓸 수 없다 → 역할·이름
  out[ALERT] = {
    entry: { candidates: [role('dialog', '알림')], role: 'dialog', namePattern: '^알림$', landmark: 'hometax.page.root', commits: false },
    capture: '알림창(.w2window.w2popup_window.msg)의 접근성 역할·이름. 본문 「해당 화면은 개인사업자는 이용할 수 없습니다.」',
  };
  return out;
}

const dict = (entries: Record<string, TplEntry>, commit: boolean) => ({
  portal: 'hometax',
  // 발급 요청의 actionId는 아직 모른다(HAR 캡처). 알기 전에는 commitEndpoints가 비어 커밋 가드가 이 요청을 '분류 안 됨'으로만 기록한다(R-C3)
  commitEndpoints: [] as unknown[],
  knownEndpoints: commit ? [{ method: 'GET', pathPattern: '^/websquare/.*$' }, { method: 'GET', pathPattern: '^/MagicLine4XML/.*$' }, { method: 'POST', pathPattern: '^/wqAction\\.do$' }, { method: 'POST', pathPattern: '^/permission\\.do$' }] : [],
  entries: {
    ...h01Login().entries,
    ...Object.fromEntries(Object.entries(entries).map(([k, v]) => [k, { ...v.entry, candidates: v.entry.candidates ?? [], frame: 'main', lastVerified: VERIFIED }])),
  },
});

/** 공유 흐름(서류별 칸 채우기·대조만 다르다) */
function steps(doc: CertDoc): Step[] {
  const docFill: Step[] = doc.fields.map((f, i) => ({ id: `s16${String.fromCharCode(97 + i)}`, type: 'select', target: `hometax.cert.form.${f.input}`, option: `$inputs.${f.input}` }) as Step);
  const entry = (d: CertDoc): Step[] =>
    d.menuCode
      ? ([
          // 로그인 뒤 화면은 홈이다. 체크포인트 첫 통과는 이동하지 않으므로(조율기 checkpoint) 양식 주소로 먼저 간다(H-04 s10·s11과 같은 모양)
          { id: 's10', type: 'goto', url: menuUrl(d.menuCode) },
          { id: 's10a', type: 'checkpoint', name: 'form', expect: { any: [{ exists: FORM }, { exists: ALERT }] }, url: menuUrl(d.menuCode), sessionRequired: true, reentry: 'reload' },
        ] as Step[])
      : ([
          { id: 's10', type: 'goto', url: 'https://hometax.go.kr/' },
          { id: 's10a', type: 'checkpoint', name: 'form', expect: { exists: 'hometax.header.logo' }, url: 'https://hometax.go.kr/websquare/websquare.html?w2xPath=/ui/pp/index_pp.xml', sessionRequired: true, reentry: 'reload' },
          { id: 's10b', type: 'click', target: 'hometax.cert.menu.civil' },
          { id: 's10c', type: 'click', target: 'hometax.cert.menu.issue' },
          { id: 's10d', type: 'click', target: 'hometax.cert.menu.doc' },
        ] as Step[]);
  // 날짜형 칸(fieldKey …Date)은 V-03j′대로 따로 assert한다(all 안에 넣으면 날짜 대조로 세지 않는다)
  const isDate = (f: DocField) => /Date$/.test(f.fieldKey);
  const docEq = doc.fields.filter((f) => !isDate(f)).map((f) => ({ readbackEquals: { fieldKey: f.fieldKey, ref: `$inputs.${f.input}` } }));
  const dateEq: Step[] = doc.fields.filter(isDate).map((f, i) => ({
    id: `s18${String.fromCharCode(97 + i)}`, type: 'assert', cond: { readbackEquals: { fieldKey: f.fieldKey, ref: `$inputs.${f.input}` } }, code: 'assert.input_mismatch', onFail: { retry: 0, then: 'abort' },
  }) as Step);
  return [
    ...h01Login().steps,
    // 양식 직접 주소를 알면 그 주소가 게이트를 지배하는 체크포인트다(V-03l: url·reload). 모르면(H-09) 홈 체크포인트 → 메뉴 클릭.
    // 체크포인트 첫 통과는 이동하지 않는다(조율기 checkpoint): 둘 다 goto(s10) 뒤 체크포인트(s10a)다.
    // 개인사업자 로그인으로 못 여는 화면은 알림이 뜬다: 체크포인트는 양식이나 알림 둘 중 하나를 기다리고, 알림이면 s10x에서 멈춘다.
    ...entry(doc),
    { id: 's10x', type: 'assert', cond: { not: { textMatches: { target: ALERT, patternRef: 'cert.block.personalOnly' } } }, code: 'portal.personal_login_required', onFail: { retry: 0, then: 'abort' } },
    { id: 's11', type: 'wait', for: 'selector', value: FORM },
    { id: 's12', type: 'select', target: 'hometax.cert.form.language', option: '$inputs.certLanguage' },
    { id: 's13', type: 'select', target: 'hometax.cert.form.purpose', option: '$inputs.purpose' },
    { id: 's13b', type: 'select', target: 'hometax.cert.form.submitTo', option: '$inputs.submitTo' },
    { id: 's14', type: 'select', target: 'hometax.cert.form.rrnDisclosure', option: '$inputs.rrnDisclosure' },
    // 수량은 수령방법을 고른 뒤에 켜진다(캡처)
    { id: 's15', type: 'select', target: 'hometax.cert.form.receiveMethod', option: RECEIVE },
    { id: 's15b', type: 'select', target: 'hometax.cert.form.copies', option: COPIES },
    ...docFill,
    { id: 's19a', type: 'assert', cond: { fieldsFilled: { fields: ['certDoc', 'certPurpose', 'certSubmitTo', 'rrnDisclosure', 'receiveMethod', 'copies', ...doc.fields.map((f) => f.fieldKey)] } }, code: 'assert.fields_missing' },
    { id: 's19b', type: 'readback', fields: ['certDoc', 'supplierBizNo', 'supplierName', 'certLanguage', 'certPurpose', 'certSubmitTo', 'rrnDisclosure', 'receiveMethod', 'copies', ...doc.fields.map((f) => f.fieldKey)] },
    // 신청인이 내 사업자인지(다른 사업장 증명을 떼지 않게)
    { id: 's19c', type: 'assert', cond: { readbackEquals: { fieldKey: 'supplierBizNo', ref: '$profile.bizNo' } }, code: 'assert.supplier_mismatch', onFail: { retry: 0, then: 'abort' } },
    {
      id: 's19f', type: 'assert', code: 'assert.input_mismatch', onFail: { retry: 0, then: 'abort' },
      cond: { all: [
        // 양식이 고른 서류인지(메뉴를 잘못 타 다른 증명 양식에 채우지 않게)
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
    // 확인 대화상자·전자서명 창이 뜨는지는 캡처로 확인한다(뜨면 expectConfirm·signFlow를 더한다, 정식 버전)
    { id: 's21', type: 'submit', target: 'hometax.cert.form.issueButton', intent: '$intent.id', verify: 's30', onFail: { retry: 0, then: 'handoff' } },
    {
      id: 's30', type: 'verify',
      lookup: {
        playbook: LOOKUP_ID,
        // 처리결과 조회는 카드 목록이고 민원명·접수번호·처리상태·접수방법·접수일시만 있다(캡처 2026-11-10): 같은 민원명의 새 건 1건 = 접수, 접수번호를 묶는다
        match: { certDoc: '$readback.certDoc' },
        window: 'today', baseline: 'pre_gate_snapshot', notCommittedPolicy: { minElapsedMs: 60000, lookups: 2 }, bind: { approvalNo: 'issueNo' },
      },
      failSignals: [{ css: '#errorDialog', text: '^(발급|신청)(이|에) 실패했습니다.*$' }],
      // 발급 안 됨이면 게이트를 지배하는 체크포인트(s10a: 양식 주소 또는 홈)로 돌아가 다시 채운다
      on: { committed: 's32', not_committed: 's10a', unknown: 'handoff' },
    },
    // 홈택스 민원증명 PDF 경로는 실측 전이다(R2 §4·R10 §1). 인쇄 경로로 두고 캡처 결과로 정한다
    { id: 's32', type: 'save_pdf', strategy: 'print', docType: doc.docType },
    { id: 's34', type: 'end', status: 'success' },
  ] as Step[];
}

function inputs(doc: CertDoc): Record<string, unknown> {
  return {
    // 서류 이름은 패키지마다 하나로 고정이다(readback 대조용, 사용자가 바꾸지 않는다)
    certDoc: { type: 'enum', values: [doc.name], default: doc.name },
    // 발급유형은 한글만(영문증명은 다른 서류로 본다)
    certLanguage: { type: 'enum', values: ['한글'], default: '한글' },
    purpose: { type: 'enum', required: true, values: PURPOSES },
    submitTo: { type: 'enum', required: true, values: SUBMIT_TO },
    // 주민번호는 기본으로 가린다(최소 노출, 02 §5.2-1과 같은 원칙)
    rrnDisclosure: { type: 'enum', values: ['공개', '비공개'], default: '비공개' },
    ...Object.fromEntries(doc.fields.map((f) => [f.input, f.inputDef])),
  };
}

const strings = (doc: CertDoc): Record<string, string> => ({
  'cert.title': doc.title,
  'cert.confirm': doc.confirm,
  ...h01Login().strings,
  // 개인사업자(사업자 인증서) 로그인으로 못 여는 화면의 알림(캡처 2026-11-10). 알림 글 전체에 이 문장이 들어 있으면 멈춘다
  'cert.block.personalOnly': '^.*해당 화면은 개인사업자는 이용할 수 없습니다\\..*$',
});

function manifest(id: string, kind: 'playbook' | 'lookup', title: string, lookupsUsed: unknown[], bundles: unknown[], effects: string[]) {
  return {
    id, version: CERT_VERSION, kind, portal: 'hometax', title, profileKinds: ['business'], engineRange: '>=1.0.0 <2.0.0', domains: DOMAINS, effects,
    bundlesUsed: bundles, lookupsUsed, contentDigests: { playbook: ZERO, selectors: ZERO, strings: ZERO }, createdAt: '2026-11-09T00:00:00+09:00', signatures: SIGS,
  };
}

/** 서류 하나의 발급 패키지(서명 전 원본) */
export function certPackage(doc: CertDoc): PackageFiles {
  const entries = { ...pageEntries(), ...menuEntries(doc), ...formEntries(doc) };
  return {
    manifest: manifest(doc.id, 'playbook', 'cert.title', [{ id: LOOKUP_ID, version: CERT_VERSION, digest: ZERO }], [], ['issue_document']),
    playbook: {
      ir: 2, id: doc.id, version: CERT_VERSION, portal: 'hometax', profileKinds: ['business'], effects: ['issue_document'], inputs: inputs(doc),
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
