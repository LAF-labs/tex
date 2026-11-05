// D06 §7 합성 마스킹 코퍼스: 유효 체크섬을 갖는 가짜 주민번호·사업자번호·법인번호·카드(Luhn)·계좌 등 10,000건.
// 변형: 구분자(하이픈·공백·점·없음·유니코드 대시), 전각 숫자, 보이지 않는 문자 삽입, 한글 숫자, 노드 분절(셀·span),
// 화면 밖·투명·크기 0·title 속성 텍스트, 입력값. 시드 고정이라 실행마다 같은 코퍼스다. 실제 사람 데이터는 없다.
import type { A11yNode } from '@sax/redaction';

export type Kind = 'RRN' | 'BIZNO' | 'CORPNO' | 'CARD' | 'ACCT' | 'PHONE' | 'EMAIL' | 'APPROVAL' | 'DLN' | 'PASSPORT' | 'NHIS' | 'ADDR' | 'NAME' | 'AMT';
export type Variant =
  | 'plain'
  | 'nosep'
  | 'space'
  | 'dot'
  | 'unidash'
  | 'fullwidth'
  | 'invisible'
  | 'korean'
  | 'split'
  | 'split_nosep'
  | 'offscreen'
  | 'title'
  | 'input_value'
  | 'aria';

export interface CorpusItem {
  id: number;
  kind: Kind;
  variant: Variant;
  /** 원값(정규형). 누락 판정 기준. */
  value: string;
  /** 평문 입력(트리 변형이면 undefined) */
  text?: string;
  /** 트리 입력 */
  tree?: A11yNode;
  /** 누락 판정: 출력에 남으면 안 되는 문자열들(숫자형은 숫자 골격 기준) */
  leaks: { digits?: string; substrings?: string[] };
}

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type R = () => number;
const int = (r: R, lo: number, hi: number) => lo + Math.floor(r() * (hi - lo + 1));
const pick = <T>(r: R, xs: readonly T[]): T => xs[Math.floor(r() * xs.length)]!;
const ds = (r: R, n: number) => Array.from({ length: n }, () => String(int(r, 0, 9))).join('');
const pad = (n: number, w: number) => String(n).padStart(w, '0');

// ── 체크섬 생성기 ──
export function rrn(r: R): string {
  const yy = pad(int(r, 0, 99), 2);
  const mm = pad(int(r, 1, 12), 2);
  const dd = pad(int(r, 1, 28), 2);
  const body = `${yy}${mm}${dd}${int(r, 1, 8)}${ds(r, 5)}`;
  const w = [2, 3, 4, 5, 6, 7, 8, 9, 2, 3, 4, 5];
  const sum = [...body].reduce((a, c, i) => a + Number(c) * w[i]!, 0);
  return `${body.slice(0, 6)}-${body.slice(6)}${(11 - (sum % 11)) % 10}`;
}

export function bizno(r: R): string {
  const b = `${int(r, 101, 899)}${pad(int(r, 1, 99), 2)}${ds(r, 4)}`;
  const w = [1, 3, 7, 1, 3, 7, 1, 3, 5];
  let sum = [...b].reduce((a, c, i) => a + Number(c) * w[i]!, 0);
  sum += Math.floor((Number(b[8]) * 5) / 10);
  const d = `${b}${(10 - (sum % 10)) % 10}`;
  return `${d.slice(0, 3)}-${d.slice(3, 5)}-${d.slice(5)}`;
}

export function corpno(r: R): string {
  const b = `${int(r, 110, 285)}${pad(int(r, 1, 99), 2)}${ds(r, 1)}${ds(r, 6)}`;
  const sum = [...b].reduce((a, c, i) => a + Number(c) * (i % 2 ? 2 : 1), 0);
  const d = `${b}${(10 - (sum % 10)) % 10}`;
  // 7번째 자리가 0·9면 주민번호 패턴과 구별된다(1~8이면 RRN으로 잡혀도 누락은 아니다).
  return `${d.slice(0, 6)}-${d.slice(6)}`;
}

export function card(r: R): string {
  const b = `${pick(r, ['4', '5', '9', '3'])}${ds(r, 14)}`;
  let sum = 0;
  for (let i = 0; i < 15; i++) {
    let x = Number(b[14 - i]);
    if (i % 2 === 0) {
      x *= 2;
      if (x > 9) x -= 9;
    }
    sum += x;
  }
  const d = `${b}${(10 - (sum % 10)) % 10}`;
  return d.match(/.{4}/g)!.join('-');
}

const ACCT_FORMS: number[][] = [[3, 2, 6], [3, 6, 5], [3, 3, 6], [4, 2, 7], [6, 2, 6], [3, 4, 4, 2], [4, 3, 6], [3, 2, 5, 1], [2, 6, 4]];
export function acct(r: R): string {
  const f = pick(r, ACCT_FORMS);
  return f.map((n) => ds(r, n)).join('-');
}

export function phone(r: R): string {
  const f = int(r, 0, 4);
  if (f === 0) return `010-${ds(r, 4)}-${ds(r, 4)}`;
  if (f === 1) return `02-${ds(r, 3)}-${ds(r, 4)}`;
  if (f === 2) return `0${pick(r, ['31', '32', '51', '53', '62', '64'])}-${ds(r, 3)}-${ds(r, 4)}`;
  if (f === 3) return `070-${ds(r, 4)}-${ds(r, 4)}`;
  return `011-${ds(r, 3)}-${ds(r, 4)}`;
}

const SUR = ['김', '이', '박', '최', '정', '강', '조', '윤', '장', '임', '한', '오', '서', '신', '권', '황', '안', '송', '류', '홍'];
const GIVEN = ['민준', '서연', '지훈', '하은', '도윤', '수아', '예준', '지우', '시우', '서윤', '주원', '하준', '지민', '은서', '현우', '채원', '건우', '소율', '우진', '다은', '길동', '철수', '영희'];
export const name = (r: R) => `${pick(r, SUR)}${pick(r, GIVEN)}`;

const SIDO = ['서울특별시', '부산광역시', '대구광역시', '인천광역시', '경기도', '강원특별자치도', '충청북도', '전라남도', '경상북도', '제주특별자치도', '세종특별자치시'];
const SGG = ['강남구', '마포구', '수원시 영통구', '성남시 분당구', '해운대구', '춘천시', '청주시 상당구', '여수시', '포항시 북구', '제주시', '중구'];
const ROADS = ['테헤란로', '월드컵북로', '광교중앙로', '판교역로', '해운대해변로', '중앙로', '번영로', '첨단과기로', '연북로', '한누리대로', '세종대로'];
const DONGS = ['역삼동', '서교동', '이의동', '삼평동', '우동', '효자동', '용암동', '학동', '양덕동', '노형동', '어진동'];

export function address(r: R): { text: string; road: string; num: string; dong: string } {
  const road = pick(r, ROADS);
  const num = `${int(r, 1, 999)}${r() < 0.3 ? `-${int(r, 1, 99)}` : ''}`;
  const dong = pick(r, DONGS);
  const f = int(r, 0, 3);
  if (f === 0) return { text: `${pick(r, SIDO)} ${pick(r, SGG)} ${road} ${num}`, road, num, dong: '' };
  if (f === 1) return { text: `${pick(r, SIDO)} ${pick(r, SGG)} ${road} ${num}, ${int(r, 1, 20)}층`, road, num, dong: '' };
  if (f === 2) return { text: `${pick(r, SIDO)} ${pick(r, SGG)} ${dong} ${int(r, 1, 999)}-${int(r, 1, 99)}번지`, road: '', num: '', dong };
  return { text: `${road} ${num} ${int(r, 101, 1504)}호`, road, num, dong: '' };
}

const EMAIL_DOMAINS = ['example.co.kr', 'test.com', 'corp.example', '예시.한국', 'mail.example.org'];
export const email = (r: R) => `${pick(r, ['kim', 'lee', 'park', 'tax', 'acct', 'ceo', 'info'])}${pick(r, ['', '.', '_'])}${ds(r, int(r, 0, 3))}${pick(r, ['ab', 'xy', 'k', ''])}@${pick(r, EMAIL_DOMAINS)}`;

// ── 변형 ──
const KO = ['공', '일', '이', '삼', '사', '오', '육', '칠', '팔', '구'];
const INVIS = ['­', '​', '‎', '͏', '️', '⁠'];

function withSep(v: string, sep: string): string {
  return v.replace(/-/g, sep);
}

function toFullwidth(v: string): string {
  return v.replace(/[0-9-]/g, (c) => (c === '-' ? '－' : String.fromCharCode(0xff10 + Number(c))));
}

function toKorean(v: string, r: R): string {
  return v.replace(/\d/g, (c) => (c === '0' ? pick(r, ['공', '영']) : KO[Number(c)]!)).replace(/-/g, ' ');
}

function sprinkle(v: string, r: R): string {
  return [...v].map((c, i) => (i > 0 && /\d/.test(c) && r() < 0.35 ? pick(r, INVIS) + c : c)).join('');
}

function splitParts(v: string, r: R, keepSep: boolean): string[] {
  const s = keepSep ? v : v.replace(/-/g, '');
  const n = int(r, 2, Math.min(4, s.length - 1));
  const cuts = new Set<number>();
  while (cuts.size < n - 1) cuts.add(int(r, 1, s.length - 1));
  const at = [0, ...[...cuts].sort((a, b) => a - b), s.length];
  return at.slice(0, -1).map((a, i) => s.slice(a, at[i + 1]));
}

const LABEL: Record<Kind, string[]> = {
  RRN: ['주민등록번호', '대표자 주민번호', '생년월일 및 주민등록번호'],
  BIZNO: ['공급받는자 등록번호', '사업자등록번호', '거래처 사업자번호'],
  CORPNO: ['법인등록번호', '법인번호'],
  CARD: ['카드번호', '사업용 카드'],
  ACCT: ['계좌번호', '환급 계좌', '입금 계좌'],
  PHONE: ['연락처', '휴대전화', '담당자 전화번호'],
  EMAIL: ['이메일', '전자우편 주소', '담당자 이메일'],
  APPROVAL: ['승인번호'],
  DLN: ['운전면허번호'],
  PASSPORT: ['여권번호'],
  NHIS: ['건강보험증 번호'],
  ADDR: ['사업장 주소', '주소', '소재지'],
  NAME: ['대표자', '성명', '예금주', '담당자'],
  AMT: ['공급가액', '세액', '합계금액'],
};

const NUMERIC: Kind[] = ['RRN', 'BIZNO', 'CORPNO', 'CARD', 'ACCT', 'PHONE', 'APPROVAL', 'DLN', 'NHIS'];
const TEXT_VARIANTS: Variant[] = ['plain', 'nosep', 'space', 'dot', 'unidash', 'fullwidth', 'invisible', 'korean'];
const TREE_VARIANTS: Variant[] = ['split', 'split_nosep', 'offscreen', 'title', 'input_value', 'aria'];

/** 종류별로 의미 있는 변형만 만든다(예: 승인번호는 홈택스가 하이픈 형식으로만 보인다). */
export function variantsFor(kind: Kind): Variant[] {
  if (kind === 'APPROVAL') return ['plain', 'unidash', 'fullwidth', 'invisible', 'split', 'offscreen', 'title', 'aria'];
  if (kind === 'DLN') return ['plain', 'nosep', 'unidash', 'fullwidth', 'invisible', 'split', 'split_nosep', 'offscreen', 'title', 'input_value'];
  if (kind === 'NHIS') return ['plain', 'nosep', 'unidash', 'fullwidth', 'invisible', 'split', 'offscreen', 'title', 'input_value'];
  if (NUMERIC.includes(kind)) return [...TEXT_VARIANTS, ...TREE_VARIANTS];
  if (kind === 'EMAIL') return ['plain', 'fullwidth', 'invisible', 'offscreen', 'title', 'input_value', 'aria'];
  if (kind === 'PASSPORT') return ['plain', 'fullwidth', 'invisible', 'offscreen', 'title', 'input_value'];
  if (kind === 'AMT') return ['plain', 'korean', 'fullwidth', 'offscreen', 'title'];
  return ['plain', 'invisible', 'offscreen', 'title', 'input_value', 'aria'];
}

function valueOf(kind: Kind, r: R): { value: string; leaks: CorpusItem['leaks'] } {
  switch (kind) {
    case 'RRN':
      return withDigits(rrn(r));
    case 'BIZNO':
      return withDigits(bizno(r));
    case 'CORPNO':
      return withDigits(corpno(r));
    case 'CARD':
      return withDigits(card(r));
    case 'ACCT':
      return withDigits(acct(r));
    case 'PHONE':
      return withDigits(phone(r));
    case 'APPROVAL':
      return withDigits(`2026${pad(int(r, 1, 12), 2)}${pad(int(r, 1, 28), 2)}-${ds(r, 8)}-${ds(r, 8)}`);
    case 'DLN':
      return withDigits(`${pad(int(r, 11, 28), 2)}-${pad(int(r, 0, 99), 2)}-${ds(r, 6)}-${ds(r, 2)}`);
    case 'NHIS':
      return withDigits(`${int(r, 1, 9)}-${ds(r, 10)}`);
    case 'PASSPORT': {
      const v = `${pick(r, ['M', 'S', 'R', 'G', 'D', 'MS'])}${ds(r, int(r, 7, 8))}`;
      return { value: v, leaks: { substrings: [v] } };
    }
    case 'EMAIL': {
      const v = email(r);
      return { value: v, leaks: { substrings: [v, v.split('@')[0]!.length >= 3 ? `${v.split('@')[0]}@` : v] } };
    }
    case 'ADDR': {
      const a = address(r);
      return { value: a.text, leaks: { substrings: [a.road ? `${a.road} ${a.num}` : `${a.dong}`].filter(Boolean) } };
    }
    case 'NAME': {
      const v = name(r);
      return { value: v, leaks: { substrings: [v] } };
    }
    case 'AMT': {
      const n = int(r, 1, 999) * 10000 + int(r, 0, 9) * 1000;
      return { value: `${n.toLocaleString('en-US')}원`, leaks: { digits: String(n) } };
    }
  }
}

function withDigits(v: string): { value: string; leaks: CorpusItem['leaks'] } {
  return { value: v, leaks: { digits: v.replace(/\D/g, '') } };
}

const KO_AMT = ['삼백삼십만원', '일천이백만원', '오십만원', '이백구십칠만원', '육십오만오천원'];

function textOf(kind: Kind, variant: Variant, value: string, r: R): string {
  switch (variant) {
    case 'plain':
      return value;
    case 'nosep':
      return value.replace(/-/g, '');
    case 'space':
      return withSep(value, ' ');
    case 'dot':
      return withSep(value, '.');
    case 'unidash':
      return withSep(value, pick(r, ['–', '−', '‐', '—']));
    case 'fullwidth':
      return toFullwidth(value);
    case 'invisible':
      return kind === 'NAME' || kind === 'ADDR' ? [...value].map((c, i) => (i > 0 && r() < 0.4 ? pick(r, INVIS) + c : c)).join('') : sprinkle(value, r);
    case 'korean':
      return kind === 'AMT' ? pick(r, KO_AMT) : toKorean(value, r);
    default:
      return value;
  }
}

const FILLER = ['조회 결과입니다.', '아래 내용을 확인하세요.', '발급 신청', '전자세금계산서 발급', '저장되었습니다.', '이전 화면', '다음'];

function sentence(kind: Kind, label: string, v: string, r: R): string {
  if (kind === 'NAME') {
    const f = int(r, 0, 2);
    if (f === 0) return `${label} ${v}`;
    if (f === 1) return `${label}: ${v}`;
    return `${v} ${pick(r, ['님', '대표님', '사장님', '씨'])} 안녕하세요`;
  }
  // 날짜·시각 바로 옆의 식별자(날짜 보호 구간이 식별자를 가리지 않는지)
  const when = r() < 0.25 ? `${pick(r, ['2026-11-05', '2026.10.31', '2026/01/02'])}${pick(r, ['', ' 14:32', ' 09:05:11'])} ` : '';
  return when + pick(r, [`${label} ${v}`, `${label}: ${v}`, `${label}(${v})`, `${v} ${label}`, `${label}${v}`]);
}

function tree(kind: Kind, variant: Variant, value: string, r: R): A11yNode {
  const label = pick(r, LABEL[kind]);
  const filler: A11yNode = { role: 'heading', name: pick(r, FILLER), states: ['level2'] };
  let target: A11yNode[];
  switch (variant) {
    case 'split':
    case 'split_nosep':
      target = [
        { role: 'cell', name: label },
        { role: 'cell', children: splitParts(value, r, variant === 'split').map((p) => ({ role: 'StaticText', name: p })) },
      ];
      // 셀 자체를 여러 셀로 나누는 경우(표 셀 분절)
      if (r() < 0.5) target = [{ role: 'cell', name: label }, ...splitParts(value, r, variant === 'split').map((p) => ({ role: 'cell', name: p }))];
      target = [{ role: 'row', children: target }];
      break;
    case 'offscreen': {
      const layout = pick(r, [{ offscreen: true }, { opacity: 0 }, { width: 0, height: 0 }, { fgEqualsBg: true }, { clipped: true }]);
      target = [{ role: 'paragraph', name: `${label} ${value}`, layout }];
      if (r() < 0.5) target = [{ role: 'generic', layout, children: [{ role: 'StaticText', name: `${label} ${value}` }] }];
      if (r() < 0.2) target = [{ role: 'paragraph', name: `${label} ${value}`, hidden: true }];
      break;
    }
    case 'title':
      target = [{ role: 'img', name: `${label} ${value}`, nameSource: 'title' }];
      break;
    case 'input_value':
      target = [{ role: pick(r, ['textbox', 'combobox', 'spinbutton', 'searchbox']), name: label, value, states: ['required'] }];
      if (r() < 0.3) target = [{ role: 'textbox', name: label, value, secret: true }];
      break;
    case 'aria':
      target = [{ role: 'button', name: `${label} ${value}`, nameSource: pick(r, ['aria', 'alt'] as const) }];
      break;
    default:
      target = [{ role: 'paragraph', name: `${label} ${value}` }];
  }
  return { role: 'RootWebArea', name: '국세청 홈택스', children: [{ role: 'banner', children: [{ role: 'link', name: '홈' }] }, { role: 'main', children: [filler, { role: 'table', children: target }] }] };
}

export function buildCorpus(n = 10_000, seed = 0x5a7e06): CorpusItem[] {
  const r = mulberry32(seed);
  const kinds: Kind[] = ['RRN', 'BIZNO', 'CORPNO', 'CARD', 'ACCT', 'PHONE', 'EMAIL', 'APPROVAL', 'DLN', 'PASSPORT', 'NHIS', 'ADDR', 'NAME', 'AMT'];
  const combos = kinds.flatMap((k) => variantsFor(k).map((v) => [k, v] as const));
  const out: CorpusItem[] = [];
  for (let id = 0; id < n; id++) {
    const [kind, variant] = combos[id % combos.length]!;
    const { value, leaks } = valueOf(kind, r);
    const item: CorpusItem = { id, kind, variant, value, leaks };
    if (TREE_VARIANTS.includes(variant)) item.tree = tree(kind, variant, value, r);
    else {
      const t = textOf(kind, variant, value, r);
      if (kind === 'AMT' && variant === 'korean') item.leaks = { substrings: [t] };
      item.text = `${pick(r, FILLER)}\n${sentence(kind, pick(r, LABEL[kind]), t, r)}\n${pick(r, FILLER)}`;
    }
    out.push(item);
  }
  return out;
}

/**
 * 오탐 점검용 정상 문구(치환되면 안 되는 홈택스 화면 문구·날짜·시각). 과치환 수만 보고한다(게이트 아님).
 */
export const BENIGN: string[] = [
  '전자세금계산서 발급이 완료되었습니다.',
  '작성일자 2026-11-05',
  '발급일시 2026.11.05 14:32:10',
  '조회기간 2026-10-01 ~ 2026-10-31',
  '공급받는자 등록번호를 입력하세요.',
  '총 3건 중 1~3건',
  '페이지 1 / 12',
  '세션이 10분 후 만료됩니다.',
  '처리 결과: 정상',
  '로그인 화면으로 이동합니다.',
  '공동·금융인증서 로그인',
  '간편인증(민간인증서) 로그인',
  '보안 경고: 비정상적인 접근이 감지되었습니다.',
  '부가가치세 신고서',
  '수정세금계산서 발급 사유를 선택하세요.',
  '고객님의 요청이 접수되었습니다.',
  '담당자에게 문의하세요.',
  '홈택스 이용 시간 06:00~24:00',
  '2026년 11월 5일',
  '제1기 확정 신고',
];
