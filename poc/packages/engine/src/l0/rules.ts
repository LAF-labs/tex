// L0 결정적 규칙(S-L0, R8 §5.3). 각 규칙은 확실할 때만 답하고(확률 1.0/0.0, confidence 1.0) 나머지는 기권(null)한다.
// 문구 사전은 초기 추정이다. 홈택스 실화면 코퍼스(PoC-3 이후)로 정확도를 재고, ≥ 99.5%인 질문만 승격한다(promotion.ts).
import { dialogText, dialogs, sameScreen, screenText, type AmountObservation, type DocMetaObservation, type IntentObservation, type Observation, type ScreenObservation } from './observation.ts';

/** Decisions 와이어 모양의 답(규칙 어댑터가 가짜 응답 answers[]로 낸다). */
export type WireAnswer =
  | { type: 'predicate'; name: string; probability: number }
  | { type: 'choice'; name: string; choice: string; confidence: number; probabilities: Array<{ value: string; probability: number }> };

const yes = (name: string): WireAnswer => ({ type: 'predicate', name, probability: 1 });
const no = (name: string): WireAnswer => ({ type: 'predicate', name, probability: 0 });
const pick = (name: string, value: string): WireAnswer => ({ type: 'choice', name, choice: value, confidence: 1, probabilities: [{ value, probability: 1 }] });

const asScreen = (o: Observation): ScreenObservation | null => (o.kind === 'screen' ? o : null);

// ── 문구 사전(초기값) ─────────────────────────────────────────
export const DICT = {
  security: /비정상(적인)?\s*(접근|이용)|접근이\s*(제한|차단)|이용이\s*(제한|정지)|자동화\s*(프로그램|도구)|매크로|보안\s*경고|부정\s*접속/,
  blockedPage: /접근이\s*(제한|차단)|이용이\s*(제한|정지)|차단되었습니다/,
  errorPage: /서비스\s*점검|페이지를\s*찾을\s*수\s*없|일시적인\s*오류|시스템\s*오류가\s*발생/,
  otherSession: /다른\s*(PC|브라우저|기기|곳|장소)에서\s*(로그인|접속)|중복\s*로그인/,
  captcha: /보안\s*문자|자동\s*입력\s*방지|captcha/i,
  mfa: /인증\s*앱에서|휴대폰에서\s*인증|승인\s*대기|인증을\s*완료해\s*주세요|인증\s*요청을\s*보냈습니다/,
  sessionExpired: /세션이\s*만료|로그인\s*시간이\s*(경과|만료)|다시\s*로그인/,
  errorText: /오류|실패|올바르지\s*않|확인하세요|입력하세요|일치하지\s*않|필수\s*입력/,
  issuedText: /정상적으로\s*발급되었습니다|발급이\s*완료|신청이\s*완료/,
  approvalNo: /\d{8}-\d{8}-\d{8}/,
  duplicate: /이미\s*발급|중복|동일한\s*(건|내역)/,
  rejected: /발급(이|에)?\s*실패|처리할\s*수\s*없|반려|권한이\s*없/,
  pendingAuth: /전자\s*서명|인증서\s*(암호|비밀번호)|서명\s*대기/,
  consent: /동의(합니다|하시겠습니까|가\s*필요)|약관/,
  proceedButton: /^(발급|발급하기|신청|신청하기|제출|전송|서명|예|확인\s*후\s*진행)$/,
  taxAdvice: /절세|공제|신고\s*방법|세액.*(얼마|계산)|부가세.*(얼마|계산|내야)|환급|세금.*(줄|아끼)/,
} as const;

// ── screen_state_v2 ──────────────────────────────────────────
const screenState: Record<string, (o: Observation) => WireAnswer | null> = {
  screen(o) {
    const s = asScreen(o);
    if (!s) return null;
    const head = [s.title, ...s.nodes.filter((n) => n.role === 'heading').map((n) => n.name)].join('\n');
    if (DICT.blockedPage.test(head)) return pick('screen', 'blocked');
    if (DICT.errorPage.test(head)) return pick('screen', 'error_page');
    const hasLogout = s.nodes.some((n) => n.role === 'link' && /^로그아웃$/.test(n.name));
    const loginBtn = s.nodes.some((n) => n.role === 'button' && /^로그인$/.test(n.name));
    const authTab = s.nodes.some((n) => (n.role === 'tab' || n.role === 'button') && /공동·?금융인증서|간편인증/.test(n.name));
    if (!hasLogout && loginBtn && authTab) return pick('screen', 'login_page');
    return null;
  },
  security_warning: (o) => (asScreen(o) && DICT.security.test(screenText(o as ScreenObservation)) ? yes('security_warning') : null),
  logged_out_by_other_session: (o) => (asScreen(o) && DICT.otherSession.test(screenText(o as ScreenObservation)) ? yes('logged_out_by_other_session') : null),
  captcha_visible(o) {
    const s = asScreen(o);
    if (!s) return null;
    const img = s.nodes.some((n) => n.role === 'img' && DICT.captcha.test(n.name));
    const box = s.nodes.some((n) => n.role === 'textbox' && DICT.captcha.test(n.name));
    return img && box ? yes('captcha_visible') : null;
  },
  mfa_pending: (o) => (asScreen(o) && DICT.mfa.test(screenText(o as ScreenObservation)) ? yes('mfa_pending') : null),
  session_expired_notice: (o) => (asScreen(o) && DICT.sessionExpired.test(screenText(o as ScreenObservation)) ? yes('session_expired_notice') : null),
  has_error_modal(o) {
    const s = asScreen(o);
    if (!s) return null;
    return dialogs(s).length && DICT.errorText.test(dialogText(s)) ? yes('has_error_modal') : null;
  },
  issuance_success_text(o) {
    const s = asScreen(o);
    if (!s) return null;
    const t = screenText(s);
    return DICT.issuedText.test(t) && DICT.approvalNo.test(t) ? yes('issuance_success_text') : null;
  },
  // 인젝션: 결정적 사전 필터(injection-filter.ts)가 따로 돈다. 열린 공격 공간이라 모델 predicate가 필수(R8 낮음).
  page_text_addresses_agent: () => null,
};

// ── popup_class_v1 ───────────────────────────────────────────
const popupClass: Record<string, (o: Observation) => WireAnswer | null> = {
  popup(o) {
    const s = asScreen(o);
    if (!s || !dialogs(s).length) return null;
    const t = dialogText(s);
    const hits = (
      [
        ['security_warning', DICT.security],
        ['captcha', DICT.captcha],
        ['session_expired', DICT.sessionExpired],
        ['consent_required', DICT.consent],
        ['error', DICT.errorText],
      ] as const
    ).filter(([, re]) => re.test(t));
    // 닫아도 되는 공지(notice_dismissable)는 진행 쪽이라 규칙이 답하지 않는다.
    return hits.length === 1 ? pick('popup', hits[0]![0]) : hits[0]?.[0] === 'security_warning' ? pick('popup', 'security_warning') : null;
  },
  asks_to_proceed_or_issue(o) {
    const s = asScreen(o);
    if (!s) return null;
    return s.nodes.some((n) => n.inDialog && n.role === 'button' && DICT.proceedButton.test(n.name.trim())) ? yes('asks_to_proceed_or_issue') : null;
  },
};

// ── recovery_v1 ──────────────────────────────────────────────
const recovery: Record<string, (o: Observation) => WireAnswer | null> = {
  situation(o) {
    const s = asScreen(o);
    if (!s?.expected) return null;
    const t = screenText(s);
    if (DICT.sessionExpired.test(t) || DICT.otherSession.test(t)) return pick('situation', 'session_expired');
    if (dialogs(s).length) return pick('situation', 'modal_blocking');
    const same = sameScreen(s, s.expected);
    if (same === null) return null; // 이 포털의 화면 식별 파라미터를 모르면 기권
    return pick('situation', same ? 'element_missing_same_screen' : 'different_screen');
  },
};

// ── form_ready_v2 / issue_result_v2 (비가역 직전·직후: 중단 쪽만) ─────────
const formReady: Record<string, (o: Observation) => WireAnswer | null> = {
  validation_error_visible(o) {
    const s = asScreen(o);
    if (!s) return null;
    const invalid = s.nodes.some((n) => n.states?.includes('invalid'));
    const alertText = s.nodes.some((n) => (n.role === 'alert' || n.inDialog) && DICT.errorText.test(n.name));
    return invalid || alertText ? yes('validation_error_visible') : null;
  },
};

const issueResult: Record<string, (o: Observation) => WireAnswer | null> = {
  result(o) {
    const s = asScreen(o);
    if (!s) return null;
    const t = screenText(s);
    const hits = (
      [
        ['duplicate', DICT.duplicate],
        ['rejected', DICT.rejected],
        ['pending_auth', DICT.pendingAuth],
      ] as const
    ).filter(([, re]) => re.test(t));
    // issued는 진행 결과라 규칙이 내지 않는다(확정은 verify 조회).
    return hits.length === 1 && !DICT.issuedText.test(t) ? pick('result', hits[0]![0]) : null;
  },
};

// ── intent_route_v1 ──────────────────────────────────────────
export const INTENT_DICT: Array<[string, RegExp]> = [
  ['hometax.invoice.amend', /수정\s*(세금)?\s*계산서/],
  ['hometax.invoice.issue', /(세금)?\s*계산서\s*.{0,6}(발행|발급|끊|보내|써)/],
  ['hometax.invoice.list', /계산서\s*.{0,6}(조회|목록|내역|저장)/],
  ['hometax.cert.business', /사업자\s*등록\s*증명|사업자등록증\s*.{0,4}(발급|뽑|떼)/],
  ['gov24.localtax.cert', /지방세\s*(납세|완납)\s*증명/],
  ['hometax.cert.taxpayment', /(?<!지방세\s*)(국세\s*)?(납세|완납)\s*증명/],
  ['gov24.resident.copy', /등본|초본|주민\s*등록/],
  ['gov24.nhis.eligibility', /자격\s*득실/],
  ['gov24.land.register', /토지\s*대장|건축물\s*대장/],
  ['gov24.localtax.itemized', /세목별/],
  ['sminfo.sme.cert', /중소기업\s*확인서/],
  ['fourins.paid.cert', /[4사]대\s*보험|가입자\s*명부/],
  ['counterparty.bizstatus.check', /휴업|폐업|진위\s*확인|사업자\s*상태/],
  ['hometax.summary.view', /합계표|매출\s*.{0,4}매입\s*.{0,4}(합계|조회)/],
  ['query.documents', /만료|언제까지|보관함/],
];

const intentRoute: Record<string, (o: Observation) => WireAnswer | null> = {
  playbook(o) {
    if (o.kind !== 'intent') return null;
    const t = (o as IntentObservation).text.normalize('NFKC');
    if (DICT.taxAdvice.test(t)) return null;
    const hits = INTENT_DICT.filter(([, re]) => re.test(t));
    return hits.length === 1 ? pick('playbook', hits[0]![0]) : null;
  },
  // 키워드 휴리스틱은 위양성이 크다(R8 낮음). 모델 필수.
  mentions_tax_advice: () => null,
};

// ── amount_parse_check_v1 ────────────────────────────────────
const UNITS: Record<string, number> = { 억: 1e8, 천만: 1e7, 백만: 1e6, 십만: 1e5, 만: 1e4, 천: 1e3 };
const KDIGIT: Record<string, number> = { 일: 1, 이: 2, 삼: 3, 사: 4, 오: 5, 육: 6, 칠: 7, 팔: 8, 구: 9 };

function parseKorean(s: string): number | null {
  let total = 0;
  let section = 0;
  let num = 0;
  for (const ch of s) {
    if (ch in KDIGIT) num = KDIGIT[ch]!;
    else if (ch === '십' || ch === '백' || ch === '천') {
      section += (num || 1) * (ch === '십' ? 10 : ch === '백' ? 100 : 1000);
      num = 0;
    } else if (ch === '만' || ch === '억') {
      total += (section + num || 1) * (ch === '만' ? 1e4 : 1e8);
      section = 0;
      num = 0;
    } else return null;
  }
  return total + section + num;
}

/** 파서와 독립된 금액 추출(아라비아 숫자·콤마·단위·한글 숫자). 날짜·수량처럼 단위·원·콤마가 없는 숫자는 금액으로 보지 않는다. */
export function extractAmounts(text: string): number[] {
  const t = text.normalize('NFKC');
  const out: number[] = [];
  const arabic = /((?:\d[\d,]*(?:\.\d+)?\s*(?:억|천만|백만|십만|만|천)\s*)+(?:\d[\d,]*)?\s*원?|\d{1,3}(?:,\d{3})+\s*원?|\d+\s*원)/g;
  for (const m of t.matchAll(arabic)) {
    let sum = 0;
    for (const part of m[0].replace(/원$/, '').trim().matchAll(/(\d[\d,]*(?:\.\d+)?)\s*(억|천만|백만|십만|만|천)?/g)) {
      const v = Number(part[1]!.replace(/,/g, ''));
      sum += part[2] ? v * UNITS[part[2]]! : v;
    }
    if (Number.isFinite(sum) && sum > 0) out.push(Math.round(sum));
  }
  for (const m of t.matchAll(/(?<![\d,.]\s*)([일이삼사오육칠팔구십백천만억]{2,})\s*원/g)) {
    const v = parseKorean(m[1]!);
    if (v) out.push(v);
  }
  return out;
}

const amountParse: Record<string, (o: Observation) => WireAnswer | null> = {
  parse_matches_user_text(o) {
    if (o.kind !== 'amount') return null;
    const { userText, parse } = o as AmountObservation;
    const amounts = [...new Set(extractAmounts(userText))];
    if (amounts.length !== 1) return null;
    const said = amounts[0]!;
    const field = parse.vatMode === 'excluded' ? parse.supply : parse.total;
    return said === field && parse.supply + parse.tax === parse.total ? yes('parse_matches_user_text') : no('parse_matches_user_text');
  },
};

// ── doc_meta_check_v1 ────────────────────────────────────────
const ISSUED_CTX = /발급\s*(일|일자)|발행\s*일|위와\s*같이\s*증명/;
const VALID_CTX = /유효\s*기간|까지\s*유효|유효\s*기한/;

function candidatePick(name: string, o: Observation, re: RegExp): WireAnswer | null {
  if (o.kind !== 'doc_meta') return null;
  const c = (o as DocMetaObservation).candidates;
  if (!c.length) return pick(name, 'none');
  const hits = c.flatMap((x, i) => (re.test(x.context) ? [i] : []));
  return hits.length === 1 ? pick(name, `candidate_${hits[0]! + 1}`) : null;
}

const docMeta: Record<string, (o: Observation) => WireAnswer | null> = {
  issued_on: (o) => candidatePick('issued_on', o, ISSUED_CTX),
  valid_until: (o) => candidatePick('valid_until', o, VALID_CTX),
};

/** 번들 와이어 ID → 질문 이름 → 규칙. 여기 없는 질문은 규칙이 없다(모델 필수). */
export const RULES: Record<string, Record<string, (o: Observation) => WireAnswer | null>> = {
  screen_state_v2: screenState,
  popup_class_v1: popupClass,
  recovery_v1: recovery,
  form_ready_v2: formReady,
  issue_result_v2: issueResult,
  intent_route_v1: intentRoute,
  amount_parse_check_v1: amountParse,
  doc_meta_check_v1: docMeta,
};
