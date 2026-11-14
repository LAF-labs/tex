// 홈택스 민원증명 4종(H-03·H-04·H-08·H-09) 표 하나: 대화 요청 인식, 맡긴 업무 버튼, 예행 메뉴, 승인 카드 제목, 문서함 이름이 모두 여기서 나온다.
// 엔진 run.startCert {runId, playbookId, inputs}의 inputs 키·값은 서명 패키지 playbook.inputs 선언과 같아야 한다(엔진 cert.ts certInputs가 다시 검사한다).
// 사람이 따로 고르지 않으면 기본 용도·제출처로 바로 시작한다. 값은 승인 카드(승인 바 4칸)에 보이고, 다르면 [중지] 뒤 "관공서 제출용으로"처럼 다시 말하면 된다.

export type CertCode = 'H-03' | 'H-04' | 'H-08' | 'H-09';

export interface CertDocDef {
  code: CertCode;
  playbookId: string;
  /** 서류 이름(홈택스 민원명, 승인 카드 제목, 문서함 이름) */
  name: string;
  /** 맡긴 업무 버튼·대화 칩 글 */
  label: string;
  /** 엔진 문서 종류(save_pdf docType, 문서함 vault.docType) */
  docType: string;
  /** 대화 요청에서 이 서류를 알아보는 말 */
  match: RegExp;
  /** 용도·제출처 선택지(패키지 enum과 같은 글) */
  purposes: readonly string[];
  submitTo: readonly string[];
  /** 기본 용도·제출처 */
  defaults: { purpose: string; submitTo: string };
  /** 서류별 칸(과세기간·귀속연도). today는 KST 'YYYY-MM-DD' */
  extra?: (today: string) => Record<string, string>;
}

const PURPOSES_COMMON = ['입찰, 계약용', '수금용', '관공서제출용', '대출용', '여권또는비자신청용', '건강보험·국민연금공단제출용', '금융기관제출용', '신용카드발급용', '기타'] as const;
const SUBMIT_COMMON = ['금융기관', '관공서', '조합/협회', '거래처', '학교', '외교부/재외공관/재외동포청', '기타'] as const;

const lastYear = (today: string) => String(Number(today.slice(0, 4)) - 1);

export const CERT_DOCS: readonly CertDocDef[] = [
  {
    code: 'H-03', playbookId: 'hometax.cert.biz_registration', name: '사업자등록증명', label: '사업자등록증명', docType: 'biz_registration_cert',
    match: /사업자\s*등록\s*증명/, purposes: PURPOSES_COMMON, submitTo: SUBMIT_COMMON, defaults: { purpose: '금융기관제출용', submitTo: '금융기관' },
  },
  {
    code: 'H-04', playbookId: 'hometax.cert.taxpayment', name: '납세증명서', label: '납세증명서', docType: 'national_tax_cert',
    match: /납세\s*증명|국세\s*완납/,
    purposes: ['대금수령', '관공서 제출', '금융기관 제출', '입찰 참가', '해외이주', '기타'], submitTo: ['관공서', '금융기관', '공공기관', '기타'],
    defaults: { purpose: '금융기관 제출', submitTo: '금융기관' },
  },
  {
    code: 'H-08', playbookId: 'hometax.cert.vat_tax_base', name: '부가가치세 과세표준증명', label: '부가세 과세표준증명', docType: 'vat_tax_base_cert',
    match: /과세\s*표준\s*증명|부가(가치)?세\s*(과표|증명)/, purposes: PURPOSES_COMMON, submitTo: SUBMIT_COMMON, defaults: { purpose: '금융기관제출용', submitTo: '금융기관' },
    // 지난해 1기~2기(한 해 전체)
    extra: (today) => ({ periodStartYear: lastYear(today), periodStartHalf: '1기', periodEndYear: lastYear(today), periodEndHalf: '2기' }),
  },
  {
    code: 'H-09', playbookId: 'hometax.cert.financial_statements', name: '표준재무제표증명', label: '표준재무제표증명', docType: 'financial_statements_cert',
    match: /재무\s*제표\s*증명|표준\s*재무/, purposes: PURPOSES_COMMON, submitTo: SUBMIT_COMMON, defaults: { purpose: '금융기관제출용', submitTo: '금융기관' },
    extra: (today) => ({ fiscalYear: lastYear(today) }),
  },
];

/** 말에서 용도·제출처를 고르는 낱말(앞에 있는 것이 먼저). 패키지 선택지에 없는 값은 고르지 않는다. */
const PURPOSE_WORDS: ReadonlyArray<[RegExp, readonly string[], readonly string[]]> = [
  [/입찰|계약/, ['입찰, 계약용', '입찰 참가'], ['거래처', '관공서']],
  [/대출/, ['대출용', '금융기관제출용', '금융기관 제출'], ['금융기관']],
  [/은행|금융/, ['금융기관제출용', '금융기관 제출'], ['금융기관']],
  [/관공서|구청|시청|주민센터|관청/, ['관공서제출용', '관공서 제출'], ['관공서']],
  [/수금|대금|거래처/, ['수금용', '대금수령'], ['거래처', '기타']],
  [/카드/, ['신용카드발급용'], ['금융기관']],
  [/비자|여권/, ['여권또는비자신청용'], ['외교부/재외공관/재외동포청']],
  [/건강보험|국민연금|공단/, ['건강보험·국민연금공단제출용'], ['관공서', '공공기관']],
  [/해외\s*이주|이민/, ['해외이주'], ['기타']],
];

export function certDocOf(text: string): CertDocDef | null {
  return CERT_DOCS.find((d) => d.match.test(text)) ?? null;
}

export function certDocByCode(code: string): CertDocDef | null {
  return CERT_DOCS.find((d) => d.code === code || d.playbookId === code) ?? null;
}

/** 요청 글 → run.startCert inputs. 용도·제출처는 말에 있으면 그것, 없으면 기본값. */
export function certInputsFor(doc: CertDocDef, text: string, today: string): Record<string, string> {
  let purpose = doc.defaults.purpose;
  let submitTo = doc.defaults.submitTo;
  for (const [re, ps, ss] of PURPOSE_WORDS) {
    if (!re.test(text)) continue;
    const p = ps.find((x) => doc.purposes.includes(x));
    const s = ss.find((x) => doc.submitTo.includes(x));
    if (p) purpose = p;
    if (s) submitTo = s;
    break;
  }
  return { purpose, submitTo, ...(doc.extra ? doc.extra(today) : {}) };
}
