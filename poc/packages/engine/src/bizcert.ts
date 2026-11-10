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

/** OCR 공백 정리: 한 글자짜리 한글 토큰이 이어지면 붙인다("가 나 상 사" → "가나상사", '및'은 빼고). 앞뒤 잡음 기호 제거. */
export function tidyOcrValue(v: string): string {
  const tokens = v.replace(/^[^0-9A-Za-z가-힣(]+/u, '').replace(/[^0-9A-Za-z가-힣)]+$/u, '').split(/\s+/).filter(Boolean);
  const out: string[] = [];
  let inRun = false; // 직전 토큰이 한 글자 한글로 시작한 묶음인가
  for (const t of tokens) {
    // '및'은 낱말 사이 접속어다("도매 및 소매업"): 붙이지 않고 묶음도 끊는다
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

/** 라벨 글자 사이 OCR 공백 허용: '상호' → /상\s*호/. 괄호는 반각·전각 둘 다. */
const label = (s: string) => [...s.replace(/\s+/g, '')].map((c) => (c === '(' ? '[(（]' : c === ')' ? '[)）]' : c)).join('\\s*');
/** 라벨과 값 사이: 쌍점·OCR이 쌍점을 잘못 읽은 기호(; . , _ |)와 공백 */
const SEP_CHARS = '[ \\t:：;.,_|·ㆍ]*';
/** 라벨 뒤에 붙는 괄호 보조 라벨: "상 호 (법인명)", "성 명 (대표자)", "법인명(단체명)" */
const SUB = `(?:\\s*[(（]\\s*(?:${['법인명', '단체명', '대표자', '성명'].map(label).join('|')})\\s*[)）])?`;
/** 줄 머리의 잡음(OCR이 표 선·글머리를 읽은 것: "| 상호", "ㆍ 성명", "① 상호") */
const LINE_HEAD = '^[^가-힣A-Za-z\\n]{0,6}';
/** 등록증의 모든 라벨. 값 안에 다른 라벨이 쌍점과 함께 나오면 거기서 자른다(두 칸이 한 줄에 있는 양식·줄 합쳐짐). */
const ALL_LABELS = ['상호', '법인명', '단체명', '대표자', '성명', '생년월일', '주민등록번호', '개업연월일', '법인등록번호', '등록번호', '사업장소재지', '본점소재지', '소재지', '사업의종류', '업태', '종목', '발급사유', '교부사유', '공동사업자', '사업자단위과세', '전자세금계산서', '전자우편주소'];
const ANY_LABEL = ALL_LABELS.map(label).join('|');
/** 쌍점 없이도 자르는 라벨: 값(상호·성명·주소·업태)에 나올 일이 없는 낱말 */
const HARD_STOP = new RegExp(`(?:${['생년월일', '주민등록번호', '법인등록번호', '개업연월일', '사업의종류', '발급사유', '교부사유', '공동사업자'].map(label).join('|')})`, 'u');
const SOFT_STOP = new RegExp(`(?:^|[^가-힣])(?:${ANY_LABEL})\\s*${SUB}[ \\t_.]*[:：;]`, 'u');
/** 줄이 라벨로 시작하는가(값만 있는 줄과 가르기) */
const STARTS_WITH_LABEL = new RegExp(`${LINE_HEAD}(?:${ANY_LABEL})(?![가-힣])`, 'u');
/** 라벨만 있는 줄 */
const LABEL_ONLY = new RegExp(`${LINE_HEAD}(?:${ANY_LABEL})${SUB}${SEP_CHARS}$`, 'u');

/** 값에서 다른 칸을 잘라 낸다 */
function cutValue(v: string): string {
  let out = v;
  const h = HARD_STOP.exec(out);
  if (h) out = out.slice(0, h.index);
  const s = SOFT_STOP.exec(out);
  if (s) out = out.slice(0, s.index + (/^[^가-힣]/u.test(s[0]) ? 1 : 0));
  return out;
}

/** 값으로 쓸 만한가: 글자(한글·영문) 두 자 이상, 라벨로 시작하지 않는다. */
const valueLike = (v: string) => (v.match(/[가-힣A-Za-z]/gu)?.length ?? 0) >= 2 && !STARTS_WITH_LABEL.test(v) && v.length <= 200;

/**
 * 라벨 뒤 값. 라벨은 줄 머리(앞 잡음 허용)에 있거나, 줄 가운데라면 쌍점이 붙어야 한다(상호 "대성명품"의 '성명'을 라벨로 읽지 않게).
 * 라벨만 있는 줄이면 다음 줄이 값이다. 다만 다음 줄이 다른 라벨로 시작하거나 앞 줄도 라벨만 있는 줄이면 비운다
 * (OCR이 라벨 열을 먼저, 값 열을 나중에 내놓은 순서는 짝을 지을 수 없다: "상호\n성명\n가나상사\n이가나"에서 성명 다음 줄은 상호 값이다).
 * `not`: 이 낱말이 라벨 바로 앞에 붙으면 다른 칸이다("본점소재지"의 '소재지').
 */
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

/**
 * 대표자 성명만: 한글 2~5자(OCR이 띄운 글자는 붙인다) 또는 영문 이름. 생년월일·주민번호·괄호는 버린다. 공동대표 "외 N명"은 붙여 둔다.
 * 이름 모양이 아니면 null(추측해서 채우지 않는다).
 */
function repNameOf(v: string): string | null {
  const co = /외\s*(\d{1,2})\s*명/u.exec(v);
  const head = (co ? v.slice(0, co.index) : v).split(/[0-9(（[<*]/u)[0]!;
  const t = tidyOcrValue(head);
  const ko = t.replace(/\s+/gu, '');
  const name = /^[가-힣]{2,5}$/u.test(ko) ? ko : /^[A-Za-z][A-Za-z .'-]{1,40}$/u.test(t) ? t : null;
  return name && co ? `${name} 외 ${co[1]}명` : name;
}

/** "업태 X 종목 Y"(사업의 종류 한 줄) 또는 업태·종목 따로. 여러 줄(업태·종목이 여럿)이면 첫 줄만(어느 열인지 글자로는 가를 수 없다). */
function bizKinds(lines: string[]): { type: string | null; item: string | null } {
  const both = new RegExp(`(?:^|[^가-힣])${label('업태')}${SEP_CHARS}(.*?)(?:^|[^가-힣])${label('종목')}${SEP_CHARS}(.*)$`, 'u');
  for (const line of lines) {
    const m = both.exec(line);
    if (!m) continue;
    const type = tidyOcrValue(cutValue(m[1]!));
    const item = tidyOcrValue(cutValue(m[2]!));
    // "업태 종목" 머리 줄(값이 다음 줄에 모여 있음)은 열을 가를 수 없다: 둘 다 비운다
    return { type: type && valueLike(type) ? type : null, item: type && item && valueLike(item) ? item : null };
  }
  return { type: after(lines, ['업태']), item: after(lines, ['종목']) };
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
const D = '[0-9OoIlSB|]';
const DASH = '[ ]?[-–—―~_.][ ]?';
/** 3-2-5(숫자 사이 OCR 공백 한 칸 허용). 앞뒤에 숫자가 더 붙으면 다른 번호다(발급번호·법인등록번호, "1900-16-62990"처럼 한 자 더 읽힌 것). */
const BIZNO_RE = new RegExp(`(?<![0-9])(${D}(?: ?${D}){2})${DASH}(${D} ?${D})${DASH}(${D}(?: ?${D}){4})(?![0-9])`, 'gu');
const digitsOf = (s: string) => fixDigits(s.replace(/[^0-9OoIlSB|]/g, ''));

export function parseBizCert(raw: string): BizCertParse {
  const text = raw.replace(/\r/g, '').replace(/[ \t\u00a0\u3000]+/g, ' ');
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  const fields: BizCertFields = { bizNo: null, name: null, repName: null, openDate: null, corpNo: null, address: null, bizType: null, bizItem: null, kind: null };

  // 등록번호: 라벨 뒤(법인등록번호 아님) 우선, 없으면 문서 전체에서 3-2-5. 체크섬 맞는 것을 고르고, 없으면 첫 후보(체크섬 틀림 표시·후보 제안)
  const labelledRe = new RegExp(`(?<!${label('법인')}\\s*)${label('등록번호')}${SEP_CHARS}(${D}[0-9OoIlSB|\\-–—―~_. ]{8,24})`, 'u');
  const labelled = lines.map((l) => labelledRe.exec(l)).find(Boolean);
  const nos = [...text.matchAll(BIZNO_RE)].map((m) => fixDigits(m[1]!.replace(/ /g, '') + m[2]!.replace(/ /g, '') + m[3]!.replace(/ /g, '')));
  const candidates = [labelled ? digitsOf(labelled[1]!) : '', ...nos].filter((d) => /^\d{10}$/.test(d));
  fields.bizNo = candidates.find(checksum) ?? candidates[0] ?? null;

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

  // 주소: 사업장 소재지 우선, 없으면 본점 소재지(법인), 끝으로 '소재지'만 읽힌 줄(본점 것은 빼고)
  fields.address = after(lines, ['사업장소재지', '사업장주소']) ?? after(lines, ['본점소재지']) ?? after(lines, ['소재지'], '본점');
  const kinds = bizKinds(lines);
  fields.bizType = kinds.type;
  fields.bizItem = kinds.item;
  const required: Array<keyof BizCertFields> = ['bizNo', 'name', 'repName', 'openDate'];
  const ok = !!fields.bizNo && checksum(fields.bizNo);
  return {
    fields,
    missing: required.filter((k) => !fields[k]),
    bizNoChecksumOk: ok,
    bizNoSuggestions: fields.bizNo && !ok ? bizNoSuggestions(fields.bizNo) : [],
  };
}
