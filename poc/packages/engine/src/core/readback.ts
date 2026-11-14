// readback(M2-3, D02 §2.1 B-06·§4 readback·§8 s19b~s19f): 게이트 앞에서 화면 값을 되읽어 고정한다.
// - 세 값 일치: 입력 요소의 DOM value, 접근성 트리의 값, (있으면) readbackOf 표시 요소의 텍스트를 같은 규칙으로 정규화해
//   모두 같아야 한다. 하나라도 다르면 step.readback_mismatch이고 그 값은 $readback에 남기지 않는다.
// - 고정한 값($readback.*)은 readbackEquals(입력·프로필 대조)·sumEquals(산술)·게이트 카드가 그대로 쓴다. 화면을 다시 읽지 않는다.
// - 비밀 칸은 읽지 않는다(V-20 런타임 가드, step.secret_field). 값은 저널·로그에 남기지 않는다(⑦).
import { normalizeName } from './constants.ts';
import type { ElementRef, PageReader } from './page.ts';
import { resolveTarget } from './resolve.ts';
import { isSecretEntry, type SelectorDict, type SelectorEntry } from './types.ts';

const NUMERIC_KEYS = new Set(['supplyAmount', 'taxAmount', 'totalAmount', 'itemCount']);
const BIZNO_KEYS = new Set(['supplierBizNo', 'counterpartBizNo']);
const DATE_KEY = /Date$/;
/**
 * DOM value를 읽는 역할(드라이버 value: select는 고른 선택지의 이름, radiogroup은 고른 라디오의 이름). 그 밖의 역할(표시 요소·라디오 하나 등)은 보이는 텍스트를 읽는다.
 * radiogroup(민원증명 발급유형·주민번호 공개 여부, 홈택스 라디오 묶음)의 보이는 텍스트는 선택지 전부라 값이 아니다.
 */
const INPUT_ROLES = new Set(['textbox', 'spinbutton', 'combobox', 'searchbox', 'radiogroup']);

type Normalizable = Pick<SelectorEntry, 'fieldKey' | 'inputType'>;

/**
 * fieldKey별 정규화(readback·대조·fill 되읽기가 같은 함수를 쓴다).
 * - 금액·수량: 공백·쉼표·'원'을 빼고 앞의 0을 뺀다(음수 부호는 둔다, 수정발급 음(-) 금액). 숫자가 아니면 그대로(산술이 거부한다).
 * - 사업자번호: 공백·하이픈을 뺀다.
 * - 날짜(inputType date 또는 ~Date): YYYY-MM-DD. "2026.11.06"·"20261106"·"2026년 11월 6일"을 같은 값으로 본다.
 * - 이메일: 도메인만 소문자.
 * - 그 밖: 이름 정규화(NFKC·제로폭·공백 접기).
 */
export function normalizeFieldValue(entry: Normalizable, raw: string): string {
  const s = normalizeName(raw);
  const fk = entry.fieldKey ?? '';
  if (entry.inputType === 'number' || NUMERIC_KEYS.has(fk)) {
    const d = s.replace(/[\s,원]/g, '');
    return /^-?\d+$/.test(d) ? d.replace(/^(-?)0+(?=\d)/, '$1') : d;
  }
  if (BIZNO_KEYS.has(fk)) return s.replace(/[\s-]/g, '');
  if (entry.inputType === 'date' || DATE_KEY.test(fk)) {
    const m = /^(\d{4})\s*(?:[-./]|년)?\s*(\d{1,2})\s*(?:[-./]|월)?\s*(\d{1,2})\s*일?$/.exec(s);
    return m ? `${m[1]}-${m[2]!.padStart(2, '0')}-${m[3]!.padStart(2, '0')}` : s;
  }
  if (entry.inputType === 'email') {
    const at = s.lastIndexOf('@');
    return at > 0 ? `${s.slice(0, at)}@${s.slice(at + 1).toLowerCase()}` : s;
  }
  return s;
}

/** fieldKey의 입력 항목 키. 정확히 하나일 때만(둘 이상이면 어느 칸인지 모른다). */
export function inputEntryKey(dict: SelectorDict, fieldKey: string): string | null {
  const ks = Object.keys(dict.entries).filter((k) => dict.entries[k]!.fieldKey === fieldKey);
  return ks.length === 1 ? ks[0]! : null;
}

/** fieldKey 값을 보여 주는 별도 표시 요소(readbackOf) 키들. */
export function displayEntryKeys(dict: SelectorDict, fieldKey: string): string[] {
  return Object.keys(dict.entries).filter((k) => dict.entries[k]!.readbackOf === fieldKey);
}

/** 요소의 화면 값: 입력 역할이면 DOM value, 아니면 보이는 텍스트. */
export async function domValue(page: PageReader, entry: SelectorEntry, el: ElementRef): Promise<string> {
  // 역할 없는 라디오 묶음(홈택스 민원증명 발급유형: div 안 라디오, inputType radio)도 고른 라디오 이름을 읽는다(2026-11-14 실화면 run-3f242cd5)
  return INPUT_ROLES.has(entry.role) || entry.inputType === 'radio' ? page.value(el) : page.text(el);
}

export type FieldRead = { ok: true; value: string } | { ok: false; code: string };

/** fieldKey 하나를 세 값 일치로 되읽는다. 정규화한 값을 돌려준다. */
export async function readField(page: PageReader, dict: SelectorDict, fieldKey: string): Promise<FieldRead> {
  const k = inputEntryKey(dict, fieldKey);
  if (!k) return { ok: false, code: 'step.selector_miss' };
  const entry = dict.entries[k]!;
  if (isSecretEntry(entry)) return { ok: false, code: 'step.secret_field' };
  const r = await resolveTarget(page, dict, k);
  if (!r.ok) return { ok: false, code: r.code };
  if (entry.countOf) {
    // 개수 칸(IR rev v1.3.5, 미리보기 품목 행 수): 하위에서 countOf에 맞고 글이 빈칸이 아닌 요소 수. 접근성 값 대조는 없다(수는 화면 글이 아니다).
    let n = 0;
    for (const el of await page.query({ kind: 'css', value: entry.countOf }, entry.frame, r.t.el)) if (normalizeName(await page.text(el)) !== '') n++;
    return { ok: true, value: String(n) };
  }
  const value = normalizeFieldValue(entry, await domValue(page, entry, r.t.el));
  if (normalizeFieldValue(entry, await page.a11yValue(r.t.el)) !== value) return { ok: false, code: 'step.readback_mismatch' };
  for (const dk of displayEntryKeys(dict, fieldKey)) {
    if (isSecretEntry(dict.entries[dk])) return { ok: false, code: 'step.secret_field' };
    const d = await resolveTarget(page, dict, dk);
    if (!d.ok) return { ok: false, code: d.code };
    if (normalizeFieldValue(entry, await page.text(d.t.el)) !== value) return { ok: false, code: 'step.readback_mismatch' };
  }
  return { ok: true, value };
}

/** readbackEquals 비교용 정규화: fieldKey의 입력 항목 규칙(없으면 fieldKey 이름 규칙). */
export function normalizeFor(dict: SelectorDict, fieldKey: string, raw: string): string {
  const k = inputEntryKey(dict, fieldKey);
  return normalizeFieldValue(k ? dict.entries[k]! : { fieldKey }, raw);
}
