import { isValidBizNo } from '@sax/db';

export interface BizCertFields {
  bizNo: string | null;
  name: string | null;
  repName: string | null;
  openDate: string | null;
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
  bizNoSuggestions: string[];
}

/** OCR 공백 정리: 한 글자짜리 한글 토큰이 이어지면 붙인다("가 나 상 사" → "가나상사", '및'은 빼고). 앞뒤 잡음 기호 제거. */
export function tidyOcrValue(v: string): string {
  const tokens = v.replace(/^[^0-9A-Za-z가-힣(]+/u, '').replace(/[^0-9A-Za-z가-힣)]+$/u, '').split(/\s+/).filter(Boolean);
  const out: string[] = [];
  let inRun = false;
  for (const t of tokens) {
    if (t === '및') {
      out.push(t);
      inRun = false;
      continue;
    }
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

const NAME_JUNK = /[_:：;|\\~^*=<>{}[\]#@$%?!"“”‘’`]|[\u3131-\u318e]/u;
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
      if (isValidBizNo(c)) out.add(c);
    }
  }
  return [...out];
}

const label = (s: string) => [...s.replace(/\s+/g, '')].map((c) => (c === '(' ? '[(（]' : c === ')' ? '[)）]' : c)).join('\\s*');
const SEP_CHARS = '[ \\t:：;.,_|·ㆍ]*';
const SUB = `(?:\\s*[(（]\\s*(?:${['법인명', '단체명', '대표자', '성명'].map(label).join('|')})\\s*[)）])?`;
const LINE_HEAD = '^[^가-힣A-Za-z\\n]{0,6}';
const ALL_LABELS = ['상호', '법인명', '단체명', '대표자', '성명', '생년월일', '주민등록번호', '개업연월일', '법인등록번호', '등록번호', '사업장소재지', '본점소재지', '소재지', '사업의종류', '업태', '종목', '발급사유', '교부사유', '공동사업자', '사업자단위과세', '전자세금계산서', '전자우편주소'];
const ANY_LABEL = ALL_LABELS.map(label).join('|');
const HARD_STOP = new RegExp(`(?:${['생년월일', '주민등록번호', '법인등록번호', '개업연월일', '사업의종류', '발급사유', '교부사유', '공동사업자'].map(label).join('|')})`, 'u');
const SOFT_STOP = new RegExp(`(?:^|[^가-힣])(?:${ANY_LABEL})\\s*${SUB}[ \\t_.]*[:：;]`, 'u');
const STARTS_WITH_LABEL = new RegExp(`${LINE_HEAD}(?:${ANY_LABEL})(?![가-힣])`, 'u');
const LABEL_ONLY = new RegExp(`${LINE_HEAD}(?:${ANY_LABEL})${SUB}${SEP_CHARS}$`, 'u');

function cutValue(v: string): string {
  let out = v;
  const h = HARD_STOP.exec(out);
  if (h) out = out.slice(0, h.index);
  const s = SOFT_STOP.exec(out);
  if (s) out = out.slice(0, s.index + (/^[^가-힣]/u.test(s[0]) ? 1 : 0));
  return out;
}

const valueLike = (v: string) => (v.match(/[가-힣A-Za-z]/gu)?.length ?? 0) >= 2 && !STARTS_WITH_LABEL.test(v) && v.length <= 200;

function after(lines: string[], labels: string[], not?: string): string | null {
  for (const l of labels) {
    const lead = not ? `(?<!${label(not)}\\s*)` : '';
    const atHead = new RegExp(`${LINE_HEAD}${lead}${label(l)}${SUB}${SEP_CHARS}(.*)$`, 'u');
    const inLine = new RegExp(`(?:^|[^가-힣])${lead}${label(l)}${SUB}[ \\t_.]*[:：;]${SEP_CHARS}(.*)$`, 'u');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      const m = atHead.exec(line) ?? inLine.exec(line);
      if (!m) continue;
      let v = tidyOcrValue(cutValue(m[1]!));
      const alone = !v && atHead.test(line) && i + 1 < lines.length && !STARTS_WITH_LABEL.test(lines[i + 1]!) && !(i > 0 && LABEL_ONLY.test(lines[i - 1]!));
      if (alone) v = tidyOcrValue(cutValue(lines[i + 1]!));
      return v && valueLike(v) ? v : null;
    }
  }
  return null;
}

function repNameOf(v: string): string | null {
  const co = /외\s*(\d{1,2})\s*명/u.exec(v);
  const head = (co ? v.slice(0, co.index) : v).split(/[0-9(（[<*]/u)[0]!;
  const t = tidyOcrValue(head);
  const ko = t.replace(/\s+/gu, '');
  const name = /^[가-힣]{2,5}$/u.test(ko) ? ko : /^[A-Za-z][A-Za-z .'-]{1,40}$/u.test(t) ? t : null;
  return name && co ? `${name} 외 ${co[1]}명` : name;
}

function bizKinds(lines: string[]): { type: string | null; item: string | null } {
  const both = new RegExp(`(?:^|[^가-힣])${label('업태')}${SEP_CHARS}(.*?)(?:^|[^가-힣])${label('종목')}${SEP_CHARS}(.*)$`, 'u');
  for (const line of lines) {
    const m = both.exec(line);
    if (!m) continue;
    const type = tidyOcrValue(cutValue(m[1]!));
    const item = tidyOcrValue(cutValue(m[2]!));
    return { type: type && valueLike(type) ? type : null, item: type && item && valueLike(item) ? item : null };
  }
  return { type: after(lines, ['업태']), item: after(lines, ['종목']) };
}

const fixDigits = (s: string) => s.replace(/[Oo]/g, '0').replace(/[Il|]/g, '1').replace(/[Ss]/g, '5').replace(/B/g, '8');
const D = '[0-9OoIlSB|]';
const DASH = '[ ]?[-–—―~_.][ ]?';
const BIZNO_RE = new RegExp(`(?<![0-9])(${D}(?: ?${D}){2})${DASH}(${D} ?${D})${DASH}(${D}(?: ?${D}){4})(?![0-9])`, 'gu');
const digitsOf = (s: string) => fixDigits(s.replace(/[^0-9OoIlSB|]/g, ''));

export function parseBizCert(raw: string): BizCertParse {
  const text = raw.replace(/\r/g, '').replace(/[ \t\u00a0\u3000]+/g, ' ');
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  const fields: BizCertFields = { bizNo: null, name: null, repName: null, openDate: null, corpNo: null, address: null, bizType: null, bizItem: null, kind: null };

  const labelledRe = new RegExp(`(?<!${label('법인')}\\s*)${label('등록번호')}${SEP_CHARS}(${D}[0-9OoIlSB|\\-–—―~_. ]{8,24})`, 'u');
  const labelled = lines.map((l) => labelledRe.exec(l)).find(Boolean);
  const nos = [...text.matchAll(BIZNO_RE)].map((m) => fixDigits(m[1]!.replace(/ /g, '') + m[2]!.replace(/ /g, '') + m[3]!.replace(/ /g, '')));
  const candidates = [labelled ? digitsOf(labelled[1]!) : '', ...nos].filter((d) => /^\d{10}$/.test(d));
  fields.bizNo = candidates.find(isValidBizNo) ?? candidates[0] ?? null;

  if (/법\s*인\s*사\s*업\s*자/u.test(text) || /법\s*인\s*명/u.test(text)) fields.kind = 'corporate';
  else if (/일\s*반\s*과\s*세\s*자|간\s*이\s*과\s*세\s*자|면\s*세\s*사\s*업\s*자|개\s*인\s*사\s*업\s*자/u.test(text)) fields.kind = 'individual';

  const name = after(lines, ['법인명', '단체명', '상호']);
  fields.name = name && !brokenBizName(name) ? name : null;
  const rep = after(lines, ['대표자', '성명']);
  fields.repName = rep ? repNameOf(rep) : null;

  const od = new RegExp(`${label('개업연월일')}${SEP_CHARS}(\\d{4})\\s*[년.\\-]\\s*(\\d{1,2})\\s*[월.\\-]\\s*(\\d{1,2})`, 'u').exec(text);
  if (od) fields.openDate = `${od[1]}${od[2]!.padStart(2, '0')}${od[3]!.padStart(2, '0')}`;

  const cn = new RegExp(`${label('법인등록번호')}${SEP_CHARS}(\\d{6})\\s*[-–—]\\s*(\\d{7})`, 'u').exec(text);
  if (cn) fields.corpNo = cn[1]! + cn[2]!;

  fields.address = after(lines, ['사업장소재지', '사업장주소']) ?? after(lines, ['본점소재지']) ?? after(lines, ['소재지'], '본점');
  const kinds = bizKinds(lines);
  fields.bizType = kinds.type;
  fields.bizItem = kinds.item;
  const required: Array<keyof BizCertFields> = ['bizNo', 'name', 'repName', 'openDate'];
  const ok = !!fields.bizNo && isValidBizNo(fields.bizNo);
  return {
    fields,
    missing: required.filter((k) => !fields[k]),
    bizNoChecksumOk: ok,
    bizNoSuggestions: fields.bizNo && !ok ? bizNoSuggestions(fields.bizNo) : [],
  };
}
