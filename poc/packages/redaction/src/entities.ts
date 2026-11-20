
export type EntityKind =
  | 'APPROVAL'
  | 'CARD'
  | 'RRN'
  | 'CORPNO'
  | 'DLN'
  | 'BIZNO'
  | 'NHIS'
  | 'PHONE'
  | 'EMAIL'
  | 'PASSPORT'
  | 'ACCT'
  | 'ADDR'
  | 'AMT'
  | 'NAME';

const S = '[-. ]?';
const D = '(?<![\\d])';
const E = '(?![\\d])';

const DATE_RE = /(?<!\d)(?:19|20)\d{2}[-./ ](?:0?[1-9]|1[0-2])[-./ ](?:0?[1-9]|[12]\d|3[01])(?!\d)|(?<![\d:])(?:[01]?\d|2[0-3]):[0-5]\d(?::[0-5]\d)?(?![\d:])/g;
const digits = (s: string) => s.replace(/\D/g, '').length;

export interface NumericRule {
  kind: EntityKind;
  re: RegExp;
  reject?: (m: string) => boolean;
  allowDates?: boolean;
}

/** 숫자형 식별자 규칙. 마스킹·트립와이어 공용. */
export const NUMERIC_RULES: NumericRule[] = [
  { kind: 'APPROVAL', re: new RegExp(`${D}\\d{8}-\\d{8}-\\d{8}${E}`, 'g') },
  { kind: 'CARD', re: new RegExp(`${D}\\d{4}${S}(?:\\d{4}|\\*{4})${S}(?:\\d{4}|\\*{4})${S}\\d{4}${E}`, 'g') },
  { kind: 'RRN', re: new RegExp(`${D}\\d{6}${S}[1-8]\\d{6}${E}`, 'g') },
  { kind: 'CORPNO', re: new RegExp(`${D}\\d{6}${S}\\d{7}${E}`, 'g') },
  { kind: 'DLN', re: new RegExp(`${D}\\d{2}-\\d{2}-\\d{6}-\\d{2}${E}`, 'g') },
  { kind: 'NHIS', re: new RegExp(`${D}\\d-\\d{10}${E}`, 'g') },
  { kind: 'BIZNO', re: new RegExp(`${D}\\d{3}${S}\\d{2}${S}\\d{5}${E}`, 'g') },
  { kind: 'PHONE', re: new RegExp(`(?:\\+82[- ]?|${D}0)(?:10|1[16789]|2|[3-6][1-5]|70|50[2-8])[-. ]?\\d{3,4}[-. ]?\\d{4}${E}|${D}1[5-9]\\d{2}-\\d{4}${E}`, 'g') },
  {
    kind: 'ACCT',
    re: new RegExp(`${D}(?:\\d{10,14}|\\d{2,6}[-. ]\\d{2,6}[-. ]\\d{2,7}(?:[-. ]\\d{1,3})?)${E}`, 'g'),
    reject: (m) => /\D/.test(m) && (digits(m) < 10 || digits(m) > 14),
  },
];

export const EMAIL_RE = /[\p{L}\p{N}._%+-]+@[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)+/gu;
export const PASSPORT_RE = /(?<![A-Za-z0-9])[A-Z]{1,2}\d{7,8}(?![0-9])/g;

const COUNTER = '(?:명|건|개|장|회|번|곳|대|권|마리|가구|세대|평|분|시간|개월|년|km|킬로|미터)';
export const AMOUNT_RE = new RegExp(
  [
    '(?<![\\d,])(?:\\d{1,3}(?:,\\d{3})+|\\d+)(?:\\.\\d+)?\\s*(?:[천백십]?만|억|천)?\\s*원',
    `(?<![\\d,.])(?:\\d{1,3}(?:,\\d{3})+|\\d+)(?:\\.\\d+)?(?:억|[천백십]?만)(?!큼)(?:\\s?\\d+(?:\\.\\d+)?(?:억|[천백십]?만|천|백))*(?!\\s?${COUNTER})(?:\\s*원)?`,
    '(?<![\\d,])\\d{1,3}(?:,\\d{3})+(?![\\d,])',
    '[영공일이삼사오육륙칠팔구십백천만억]{2,}\\s*원',
  ].join('|'),
  'gu',
);

const SIDO = '(?:서울|부산|대구|인천|광주|대전|울산|세종|경기|강원|충북|충남|전북|전남|경북|경남|제주|충청북|충청남|전라북|전라남|경상북|경상남)(?:특별시|광역시|특별자치시|특별자치도|도|시)?';
const SIGUNGU = '[가-힣]{1,6}(?:시|군|구)';
const ROAD = '[가-힣A-Za-z0-9·]{1,20}(?:로|길|대로)(?:\\s?\\d{1,4}(?:번)?(?:길|가))?';
const DONG = '[가-힣0-9]{1,10}(?:동|읍|면|리|가)';
const BUNJI = '(?:산\\s?)?\\d{1,5}(?:-\\d{1,5})?(?:번지)?';
const DETAIL = '(?:,?\\s?(?:[가-힣A-Za-z0-9]{1,15}\\s?)?\\d{1,5}(?:동|호|층)(?:\\s?\\d{1,5}(?:호|층))?)?';
export const ADDRESS_RE = new RegExp(
  [
    `${SIDO}(?:\\s?${SIGUNGU}){1,2}(?:\\s?(?:${ROAD}|${DONG}))*(?:\\s?${BUNJI})?${DETAIL}(?:\\s?\\([가-힣0-9,\\s]{1,20}\\))?`,
    `(?<![가-힣])${ROAD}\\s?${BUNJI}(?![\\d,]|\\s?(?:[천백십]?만|억|천\\s?원|원))${DETAIL}`,
    `(?<![가-힣])${DONG}\\s?${BUNJI}번지${DETAIL}`,
  ].join('|'),
  'gu',
);

const HONORIFIC = '(?:님|씨|대표님|대표|사장님|사장|이사님|이사|과장님|과장|부장님|부장|팀장님|팀장|실장님|실장|원장님|원장|선생님|세무사님|세무사|고객님)';
export const NAME_AFTER_RE = new RegExp(`(?<![가-힣])([가-힣]{2,4}?)\\s?(?=${HONORIFIC}(?![가-힣]))`, 'gu');
export const NAME_LABEL_RE = /(?<=(?:성명|이름|대표자|대표자명|예금주|담당자|수신자|신청인|세대주|세대원|받는\s?사람|보내는\s?사람)(?:\s|\s?[:：]\s?))([가-힣]{2,4})(?![가-힣])/gu;
/** 호칭·라벨 문맥이어도 이름이 아닌 일반 명사(확실히 아닌 것). */
export const NAME_STOPWORDS = new Set([
  '고객', '사용자', '회원', '담당자', '관리자', '이용자', '대표', '대표자', '납세자', '신청인', '귀하', '사업자', '거래처', '본인', '세무사',
  '사장', '원장', '선생', '부장', '과장', '팀장', '실장', '이사', '공급자', '공급받는자', '수신자', '발신자', '세대주', '세대원', '예금주',
  '확인', '입력', '선택', '조회', '없음', '해당', '미입력', '필수', '성명', '이름', '주소', '상호',
]);

const KO_DIGIT: Record<string, string> = { 영: '0', 공: '0', 일: '1', 이: '2', 삼: '3', 사: '4', 오: '5', 육: '6', 륙: '6', 칠: '7', 팔: '8', 구: '9' };
const KO_DIGIT_RE = /[영공일이삼사오육륙칠팔구]/g;

export function koreanDigitCopy(s: string): string {
  return s.replace(KO_DIGIT_RE, (c) => KO_DIGIT[c]!);
}

export function hasKoreanDigit(s: string): boolean {
  return /[영공일이삼사오육륙칠팔구]/.test(s);
}

export interface Span {
  start: number;
  end: number;
  kind: EntityKind;
}

/** 숫자형 식별자 구간(겹치면 앞 규칙 우선). */
export function numericSpans(text: string): Span[] {
  const out: Span[] = [];
  const dates = [...text.matchAll(DATE_RE)].map((m) => [m.index!, m.index! + m[0].length] as const);
  const taken = (a: number, b: number) => out.some((s) => a < s.end && b > s.start);
  const inDate = (a: number, b: number) => dates.some(([s, e]) => a < e && b > s);
  for (const r of NUMERIC_RULES) {
    const re = new RegExp(r.re.source, r.re.flags);
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
      const start = m.index;
      const end = start + m[0].length;
      if (r.reject?.(m[0]) || taken(start, end) || (!r.allowDates && inDate(start, end))) {
        re.lastIndex = start + 1;
        continue;
      }
      out.push({ start, end, kind: r.kind });
    }
  }
  return out.sort((a, b) => a.start - b.start);
}

/**
 * 2차 트립와이어(egress·BYOK, D06 §4 egress 트립와이어, gateway-request 규칙 (6)): 주민번호·사업자번호·카드·계좌 모양.
 * 마스킹을 통과한 텍스트에 다시 돌린다. 한글 숫자 사본도 본다. 숫자 골격(구분자 전부 제거) 검사는 하지 않는다(D06 §2, 오탐).
 */
export function identifierTripwire(normalized: string): EntityKind | null {
  for (const t of [normalized, hasKoreanDigit(normalized) ? koreanDigitCopy(normalized) : null]) {
    if (t === null) continue;
    for (const s of numericSpans(t)) if (s.kind === 'RRN' || s.kind === 'BIZNO' || s.kind === 'CARD' || s.kind === 'ACCT' || s.kind === 'CORPNO') {
      if (s.kind === 'CARD' && t.slice(s.start, s.end).includes('*')) continue;
      return s.kind;
    }
  }
  return null;
}
