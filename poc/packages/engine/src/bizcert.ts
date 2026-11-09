// 사업자등록증 OCR 텍스트 → 거래처·프로필 입력 후보. OCR 자체는 docparse 샌드박스(ADR-014)에서 돌고
// 엔진은 텍스트만 받는다. 결과는 사용자가 확인·수정한 뒤에만 저장한다(source='ocr').

export interface BizCertFields {
  bizNo: string | null;
  name: string | null;
  repName: string | null;
  openDate: string | null; // YYYYMMDD
  corpNo: string | null;
  address: string | null;
  bizType: string | null;
  bizItem: string | null;
  kind: 'corporate' | 'individual' | null;
}

export interface BizCertParse {
  fields: BizCertFields;
  missing: Array<keyof BizCertFields>;
  bizNoChecksumOk: boolean;
  /** 체크섬이 틀리면 OCR 혼동 숫자를 한 자리씩 바꿔 체크섬이 맞는 후보(사용자가 고른다). */
  bizNoSuggestions: string[];
}

/** OCR 공백 정리: 한 글자짜리 한글 토큰이 이어지면 붙인다("가 나 상 사" → "가나상사"). 앞뒤 잡음 기호 제거. */
export function tidyOcrValue(v: string): string {
  const tokens = v.replace(/^[^0-9A-Za-z가-힣(]+/u, '').replace(/[^0-9A-Za-z가-힣)]+$/u, '').split(/\s+/).filter(Boolean);
  const out: string[] = [];
  let inRun = false; // 직전 토큰이 한 글자 한글로 시작한 묶음인가
  for (const t of tokens) {
    const single = /^[가-힣]$/u.test(t);
    if (out.length && inRun && /^[가-힣]/u.test(t)) {
      out[out.length - 1] += t;
      inRun = single;
    } else {
      out.push(t);
      inRun = single;
    }
  }
  return out.join(' ');
}

/**
 * 상호에 섞인 OCR 잡음 글자(#219 관찰: `가나상사상호 _ :： 가나상사`). 실제 상호에 쓰는 ( ) & . , - · ' 와 영숫자·한글 음절은 뺀다.
 * 낱자모(ㄱ-ㅎ·ㅏ-ㅣ)도 상호에 혼자 쓰지 않는다(음절이 깨진 것).
 */
const NAME_JUNK = /[_:：;|\\~^*=<>{}[\]#@$%?!"“”‘’`]|[\u3131-\u318e]/u;
/** 상호 칸에 다른 칸 라벨이 들어 있으면 줄이 합쳐진 것이다. '상호'·'성명'은 넣지 않는다(상호저축은행·대성명품처럼 실제 이름에 나온다). */
const NAME_FOREIGN_LABELS = ['법인명', '대표자', '등록번호', '개업연월일', '소재지', '사업의종류', '업태', '종목', '교부사유', '생년월일', '주민등록번호', '공동사업자'];

/**
 * OCR로 깨진 상호인가. 깨졌으면 후보로 내지 않고 missing으로 보내 사용자가 다시 확인하게 한다(조용히 채우지 않는다, ADR-014).
 * - 잡음 글자가 섞였다(구분 기호·밑줄·낱자모 등)
 * - 다른 칸의 라벨이 들어 있다(줄 합쳐짐)
 * - 같은 이름이 라벨을 사이에 두고 되풀이된다(`가나상사상호가나상사`)
 */
export function brokenBizName(v: string): boolean {
  if (NAME_JUNK.test(v)) return true;
  const c = v.replace(/\s+/gu, '');
  if (NAME_FOREIGN_LABELS.some((l) => c.includes(l))) return true;
  return /^(.+)(?:상호|법인명\(?단체명\)?)\1$/u.test(c);
}

const CONFUSABLE: Record<string, string[]> = { '0': ['9', '8', '6'], '9': ['0', '8'], '8': ['0', '3', '6', '9'], '6': ['8', '5', '0'], '5': ['6', '3'], '3': ['8', '5'], '1': ['7', '4'], '7': ['1'], '4': ['1'] };

function bizNoSuggestions(d: string): string[] {
  const out = new Set<string>();
  for (let i = 0; i < d.length; i++) {
    for (const alt of CONFUSABLE[d[i]!] ?? []) {
      const c = d.slice(0, i) + alt + d.slice(i + 1);
      if (checksum(c)) out.add(c);
    }
  }
  return [...out];
}

/** 라벨 글자 사이 OCR 공백 허용: '상호' → /상\s*호/ */
const label = (s: string) => s.split('').map((c) => c.replace(/[()]/g, '\\$&')).join('\\s*');
const SEP = '\\s*[:：;]?\\s*';
const STOP_LABELS = ['대표자', '성명', '개업연월일', '법인등록번호', '사업장소재지', '본점소재지', '사업의종류', '업태', '종목', '교부사유', '생년월일', '공동사업자', '주민등록번호'];
const STOP = new RegExp(`\\s*(?:${STOP_LABELS.map(label).join('|')})\\s*[:：]`, 'u');

function after(text: string, labels: string[]): string | null {
  for (const l of labels) {
    const m = new RegExp(`${label(l)}${SEP}([^\\n]+)`, 'u').exec(text);
    if (m?.[1]) {
      const v = tidyOcrValue(m[1].split(STOP)[0]!.trim());
      if (v) return v;
    }
  }
  return null;
}

function checksum(d: string): boolean {
  if (!/^\d{10}$/.test(d)) return false;
  const w = [1, 3, 7, 1, 3, 7, 1, 3, 5];
  let sum = 0;
  for (let i = 0; i < 9; i++) sum += Number(d[i]) * w[i]!;
  sum += Math.floor((Number(d[8]) * 5) / 10);
  return (10 - (sum % 10)) % 10 === Number(d[9]);
}

/** OCR이 자주 혼동하는 글자를 숫자로 바로잡는다(숫자 문맥에서만). */
const fixDigits = (s: string) => s.replace(/[Oo]/g, '0').replace(/[Il|]/g, '1').replace(/[Ss]/g, '5').replace(/B/g, '8');

export function parseBizCert(raw: string): BizCertParse {
  const text = raw.replace(/\r/g, '').replace(/[ \t]+/g, ' ');
  const fields: BizCertFields = { bizNo: null, name: null, repName: null, openDate: null, corpNo: null, address: null, bizType: null, bizItem: null, kind: null };

  // 등록번호: 라벨 뒤 우선, 없으면 문서 전체에서 체크섬 맞는 3-2-5
  const nos = [...text.matchAll(/([0-9OoIlSB|]{3})\s*[-–—~]\s*([0-9OoIlSB|]{2})\s*[-–—~]\s*([0-9OoIlSB|]{5})/gu)].map((m) => fixDigits(m[1]! + m[2]! + m[3]!));
  const labelled = new RegExp(`${label('등록번호')}${SEP}([0-9OoIlSB|\\s\\-–—~]{10,16})`, 'u').exec(text);
  const candidates = [labelled ? fixDigits(labelled[1]!.replace(/[^0-9OoIlSB|]/g, '')) : '', ...nos].filter((d) => d.length === 10);
  fields.bizNo = candidates.find(checksum) ?? candidates[0] ?? null;

  if (/법\s*인\s*사\s*업\s*자/u.test(text) || /법\s*인\s*명/u.test(text)) fields.kind = 'corporate';
  else if (/일\s*반\s*과\s*세\s*자|간\s*이\s*과\s*세\s*자|개\s*인\s*사\s*업\s*자/u.test(text)) fields.kind = 'individual';

  const name = after(text, ['법인명(단체명)', '법인명', '상호']);
  fields.name = name && !brokenBizName(name) ? name : null;
  const rep = after(text, ['대표자', '성명']);
  fields.repName = rep ? (/[가-힣]{2,5}(?:\s*외\s*\d+\s*명)?/u.exec(rep.replace(/\s+(?=[가-힣])/gu, ''))?.[0] ?? rep) : null;

  const od = new RegExp(`${label('개업연월일')}${SEP}(\\d{4})\\s*[년.\\-]\\s*(\\d{1,2})\\s*[월.\\-]\\s*(\\d{1,2})`, 'u').exec(text);
  if (od) fields.openDate = `${od[1]}${od[2]!.padStart(2, '0')}${od[3]!.padStart(2, '0')}`;

  const cn = new RegExp(`${label('법인등록번호')}${SEP}(\\d{6})\\s*-\\s*(\\d{7})`, 'u').exec(text);
  if (cn) fields.corpNo = cn[1]! + cn[2]!;

  fields.address = after(text, ['사업장소재지', '사업장 소재지', '본점소재지']);
  const bt = new RegExp(`${label('업태')}${SEP}([^\\n]+?)\\s*${label('종목')}${SEP}([^\\n]+)`, 'u').exec(text);
  if (bt) {
    fields.bizType = tidyOcrValue(bt[1]!);
    fields.bizItem = tidyOcrValue(bt[2]!.split(STOP)[0]!);
  } else {
    fields.bizType = after(text, ['업태']);
    fields.bizItem = after(text, ['종목']);
  }

  const required: Array<keyof BizCertFields> = ['bizNo', 'name', 'repName', 'openDate'];
  const ok = !!fields.bizNo && checksum(fields.bizNo);
  return {
    fields,
    missing: required.filter((k) => !fields[k]),
    bizNoChecksumOk: ok,
    bizNoSuggestions: fields.bizNo && !ok ? bizNoSuggestions(fields.bizNo) : [],
  };
}
