// 공통 입력 칸(디자인 v2.0 Field). 같은 뜻의 값은 어느 화면에서든 같은 칸·같은 상한·같은 검사로 받는다.
// - field·kvField: 보이는 <label for>, 칸 아래 도움말·오류 줄. aria-describedby·aria-invalid는 여기서만 붙인다.
// - 칸마다 검사를 단다. 칸을 떠날 때와 checkFields(제출 직전)에 돌고, 결과는 그 칸 아래에 쓴다. 칸을 고치면 오류를 내린다.
// - 값은 입력 칸 value로만 다룬다. 비밀값 칸은 value를 속성·state에 두지 않는다(부르는 쪽이 보낸 뒤 비운다).
// - 크기는 두 단계: 기본 40(폼·비밀값), compact 32(카드·패널 안). 글자는 14 하나다.
import { h, icon } from './shell-views.js';

/**
 * 칸 상한(글자 수). 엔진·DB·main이 받는 상한과 같거나 작다(tests/shell-profile-edit·shell-counterparty-book이 main 상수와 맞춰 본다).
 * bizNo는 보이는 모양(000-00-00000)의 길이다. 보낼 때는 숫자 10자리만 보낸다.
 */
export const LIMITS = Object.freeze({
  bizNo: 12,
  name: 100,
  rep: 100,
  bizType: 100,
  bizItem: 100,
  address: 200,
  email: 254,
  item: 100,
  account: 20,
  accountAlias: 60,
  holder: 60,
  payer: 60,
});
/** 금액 상한(packages/db bank-repo AMOUNT_MAX, 초안 1e12 미만). */
const AMOUNT_MAX = 999_999_999_999;

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const BIZ_W = [1, 3, 7, 1, 3, 7, 1, 3, 5];

/** 사업자번호 검증 숫자(packages/db bizno.ts isValidBizNo와 같은 식). */
export function bizNoOk(d) {
  if (!/^\d{10}$/.test(d)) return false;
  let sum = 0;
  for (let i = 0; i < 9; i++) sum += Number(d[i]) * BIZ_W[i];
  sum += Math.floor((Number(d[8]) * 5) / 10);
  return (10 - (sum % 10)) % 10 === Number(d[9]);
}
export const bizDigits = (s) => String(s ?? '').replace(/\D/g, '').slice(0, 10);
/** 치는 동안의 모양: 3-2-5로 하이픈을 넣는다(123 → 123-4 → 123-45-6…). */
const bizShape = (d) => (d.length > 5 ? `${d.slice(0, 3)}-${d.slice(3, 5)}-${d.slice(5)}` : d.length > 3 ? `${d.slice(0, 3)}-${d.slice(3)}` : d);
const commas = (d) => (d ? Number(d).toLocaleString('en-US') : '');
/** 쉼표 금액 칸의 값(숫자). 빈 칸은 0. */
export const amountOf = (input) => Number(String(input.value).replace(/\D/g, '')) || 0;

const checks = new WeakMap();
const setters = new WeakMap();
const extras = new WeakMap();
let seq = 0;

const need = (required, text) => (required ? (typeof required === 'string' ? required : text) : null);

/** 칸 요소. 부르는 쪽의 on* 처리기는 칸 자신의 정리(하이픈·쉼표) 뒤에 단다(정리된 값을 읽게). */
function base(tag, { compact, cls, required, ...attrs }, setup) {
  const own = {};
  const handlers = [];
  for (const [k, v] of Object.entries(attrs)) {
    if (k.startsWith('on') && typeof v === 'function') handlers.push([k.slice(2), v]);
    else own[k] = v;
  }
  const el = h(tag, { autocomplete: 'off', ...own, class: `sx-field-input${compact ? ' is-compact' : ''}${cls ? ` ${cls}` : ''}`, required: !!required, 'aria-required': required ? 'true' : null });
  setup?.(el);
  for (const [type, fn] of handlers) el.addEventListener(type, fn);
  return el;
}

/** 칸 값을 바꾸되 커서는 같은 숫자 뒤에 둔다(쉼표·하이픈을 넣어도 튀지 않게). */
function reshape(input, shape) {
  const v = input.value;
  const next = shape(v);
  if (next === v) return;
  const at = input.selectionStart ?? v.length;
  const before = v.slice(0, at).replace(/\D/g, '').length;
  input.value = next;
  if (document.activeElement !== input) return;
  let i = 0;
  for (let n = 0; i < next.length && n < before; i++) if (/\d/.test(next[i])) n++;
  try {
    input.setSelectionRange(i, i);
  } catch {
    // 커서를 못 두는 칸
  }
}

/** 글자 칸. max는 LIMITS의 값이다. required: true 또는 비었을 때 쓸 문장. */
export function textInput({ value, max, required, ...attrs } = {}) {
  const input = base('input', { type: 'text', value: value ?? '', maxlength: max, required, ...attrs });
  checks.set(input, (v) => (v.trim() ? null : need(required, '이 칸을 채워 주세요.')));
  return input;
}

/** 사업자번호: 숫자만 남기고 3-2-5로 하이픈. 떠날 때 10자리와 검증 숫자를 본다. 보낼 때는 bizDigits(value). */
export function bizNoInput({ value, required, ...attrs } = {}) {
  const input = base('input', { type: 'text', inputmode: 'numeric', spellcheck: 'false', maxlength: LIMITS.bizNo, placeholder: '000-00-00000', value: bizShape(bizDigits(value)), required, cls: 'is-num', ...attrs }, (el) =>
    el.addEventListener('input', () => reshape(el, (v) => bizShape(bizDigits(v)))),
  );
  checks.set(input, (v) => {
    const d = bizDigits(v);
    if (!d) return need(required, '사업자번호를 넣어 주세요.');
    if (d.length !== 10) return '사업자번호 10자리를 모두 넣어 주세요.';
    return bizNoOk(d) ? null : '사업자번호가 맞지 않아요. 숫자를 다시 확인해 주세요.';
  });
  return input;
}

export function emailInput({ value, required, ...attrs } = {}) {
  const input = base('input', { type: 'email', inputmode: 'email', spellcheck: 'false', autocapitalize: 'off', maxlength: LIMITS.email, value: value ?? '', required, ...attrs });
  checks.set(input, (v) => {
    const t = v.trim();
    if (!t) return need(required, '이메일 주소를 넣어 주세요.');
    return EMAIL.test(t) ? null : '이메일 주소 모양이 맞지 않아요. 예: tax@example.com';
  });
  return input;
}

/**
 * 금액: 쉼표를 저절로 넣고 오른쪽 정렬·고정폭 숫자. 0·빈 값·음수는 칸 아래 오류.
 * units: 단위 글("330만원", "1억 2천만원")도 받는다(main이 요청 문장과 같은 규칙으로 읽는다). 숫자만 칠 때만 쉼표를 넣는다.
 */
export function amountInput({ value, units = false, required = true, ...attrs } = {}) {
  const start = value === null || value === undefined || value === '' ? '' : /^[\d,]+$/.test(String(value)) ? commas(String(value).replace(/\D/g, '')) : String(value);
  const input = base('input', { type: 'text', inputmode: 'numeric', spellcheck: 'false', maxlength: units ? 30 : 15, value: start, required, cls: 'is-amount', ...attrs }, (el) =>
    el.addEventListener('input', () => reshape(el, (v) => (units && !/^[\d,]*$/.test(v) ? v : commas(v.replace(/\D/g, '').slice(0, 12))))),
  );
  checks.set(input, (v) => {
    const t = v.trim();
    if (!t) return need(required, '금액을 넣어 주세요.');
    if (t.includes('-')) return '0원보다 큰 금액을 넣어 주세요.';
    if (units && !/^[\d,\s]+$/.test(t)) return null;
    const n = Number(t.replace(/\D/g, ''));
    if (!(n > 0)) return '0원보다 큰 금액을 넣어 주세요.';
    return n > AMOUNT_MAX ? '1조 원보다 작은 금액을 넣어 주세요.' : null;
  });
  return input;
}

/** 계좌번호: 숫자만(하이픈·공백은 지운다), 6~20자리(DB normalizeAccountNumber). */
export function accountInput({ value, required = true, ...attrs } = {}) {
  const input = base('input', { type: 'text', inputmode: 'numeric', spellcheck: 'false', maxlength: LIMITS.account, value: String(value ?? '').replace(/\D/g, ''), required, cls: 'is-num', ...attrs }, (el) =>
    el.addEventListener('input', () => reshape(el, (v) => v.replace(/\D/g, '').slice(0, LIMITS.account))),
  );
  checks.set(input, (v) => {
    if (!v) return need(required, '계좌번호를 넣어 주세요.');
    return /^\d{6,20}$/.test(v) ? null : '계좌번호를 숫자로 6~20자리 넣어 주세요.';
  });
  return input;
}

/** 날짜 칸. 입력하다 만 날짜(badInput)는 오류다. */
export function dateInput({ value, required, ...attrs } = {}) {
  const input = base('input', { type: 'date', required, ...attrs });
  input.value = value ?? '';
  checks.set(input, (v) => (input.validity.badInput ? '날짜를 끝까지 넣어 주세요.' : v ? null : need(required, '날짜를 넣어 주세요.')));
  return input;
}

/** 고르기 칸. options: [값, 보이는 글][]. */
export function selectInput(options, { value, ...attrs } = {}) {
  return base('select', attrs, (el) => el.append(...options.map(([v, label]) => h('option', { value: v, selected: v === value }, label))));
}

/**
 * 비밀값 칸: password, 자동 완성·맞춤법·대문자 끔. [보기]는 30초 뒤 다시 가린다.
 * value를 받지 않는다(속성에 남지 않게). 부르는 쪽이 읽고 바로 비운다.
 */
export function secretInput({ label = '비밀번호', ...attrs } = {}) {
  const input = base('input', { type: 'password', spellcheck: 'false', autocapitalize: 'off', cls: 'is-secret', ...attrs });
  let timer = null;
  const eye = h('button', { type: 'button', class: 'sx-field-eye', 'aria-pressed': 'false', 'aria-label': `${label} 보기` }, icon('eye'));
  const show = (on) => {
    clearTimeout(timer);
    input.type = on ? 'text' : 'password';
    eye.setAttribute('aria-pressed', String(on));
    eye.setAttribute('aria-label', `${label} ${on ? '가리기' : '보기'}`);
    eye.replaceChildren(icon(on ? 'eyeOff' : 'eye'));
    if (on) timer = setTimeout(() => show(false), 30_000);
  };
  eye.addEventListener('click', () => {
    show(input.type === 'password');
    input.focus();
  });
  extras.set(input, eye);
  return input;
}

/** 칸 하나를 라벨·도움말·오류 줄과 잇는다. */
function wire(input, help, error) {
  const id = input.id || (input.id = `sx-f${++seq}`);
  const helpEl = help ? h('p', { class: 'sx-field-help', id: `${id}-help` }, help) : null;
  const errEl = h('p', { class: 'sx-field-error', id: `${id}-err`, role: 'alert', 'data-field-error': input.name || input.dataset.field || '' });
  const set = (text) => {
    errEl.textContent = text || '';
    errEl.hidden = !text;
    if (text) input.setAttribute('aria-invalid', 'true');
    else input.removeAttribute('aria-invalid');
    const by = [helpEl?.id, text ? errEl.id : null].filter(Boolean).join(' ');
    if (by) input.setAttribute('aria-describedby', by);
    else input.removeAttribute('aria-describedby');
  };
  set(error);
  setters.set(input, set);
  // 단추로 옮겨 가는 blur는 검사하지 않는다(오류 줄이 끼어 단추가 밀리면 누름이 빗나간다). 제출은 checkFields가 다시 본다.
  input.addEventListener('blur', (e) => {
    if (input.disabled || e.relatedTarget?.closest?.('button')) return;
    const t = checks.get(input)?.(input.value);
    if (t) set(t);
  });
  input.addEventListener('input', () => !errEl.hidden && set(null));
  const eye = extras.get(input);
  const box = eye ? h('span', { class: 'sx-field-box' }, input, eye) : input;
  return { id, box, helpEl, errEl };
}

/**
 * 보이는 라벨 위, 칸, 그 아래 도움말·오류. after: 칸 옆에 둘 단추. error: 처음부터 보일 오류(main이 거절한 까닭).
 * attrs: 바깥 div 속성.
 */
export function field({ label, input, help, error, after, attrs = {} }) {
  const { id, box, helpEl, errEl } = wire(input, help, error);
  const compact = input.classList.contains('is-compact');
  return h(
    'div',
    { ...attrs, class: `sx-field${compact ? ' is-compact' : ''}${attrs.class ? ` ${attrs.class}` : ''}` },
    h('label', { class: 'sx-field-label', for: id }, label),
    after ? h('div', { class: 'sx-field-row' }, box, after) : box,
    helpEl,
    errEl,
  );
}

/** 라벨·값 목록(dl) 안의 칸: [dt(라벨), dd(칸·도움말·오류)]. attrs: dd 속성. */
export function kvField({ label, input, help, error, after, attrs = {} }) {
  const { id, box, helpEl, errEl } = wire(input, help, error);
  return [h('dt', {}, h('label', { class: 'sx-field-label', for: id }, label)), h('dd', { ...attrs, class: 'is-editing' }, after ? h('div', { class: 'sx-field-row' }, box, after) : box, helpEl, errEl)];
}

/** main이 거절한 까닭을 그 칸 아래에 쓴다(null이면 내린다). */
export function fieldError(input, text) {
  setters.get(input)?.(text);
}

/** 제출 직전: 칸들(폼 요소 또는 칸 목록)을 모두 검사하고 오류를 칸 아래에 쓴다. 첫 오류 칸으로 포커스를 옮긴다. 모두 맞으면 true. */
export function checkFields(root) {
  let first = null;
  for (const el of Array.isArray(root) ? root : root.querySelectorAll('input, select, textarea')) {
    if (el.disabled || !checks.has(el)) continue;
    const t = checks.get(el)(el.value);
    if (!t) continue;
    setters.get(el)?.(t);
    first ??= el;
  }
  first?.focus();
  return !first;
}

/**
 * 폼 키: 글자·날짜 칸과 고르기 칸의 Enter = 제출, 어디서든 Escape = 취소. 단추 위 Enter는 그 단추 몫이다.
 * 한글 조합 중 키는 조합만 끝내니 무시한다. 처리한 키는 위로 올려 보내지 않는다(전역 Esc가 패널·창을 닫지 않게).
 */
export const keys = (submit, cancel) => (e) => {
  if (e.isComposing || e.keyCode === 229) {
    e.stopPropagation();
    return;
  }
  const t = e.target;
  if (e.key === 'Enter' && submit && (t.tagName === 'SELECT' || (t.tagName === 'INPUT' && !['checkbox', 'radio', 'button', 'submit'].includes(t.type)))) {
    e.preventDefault();
    e.stopPropagation();
    submit();
  } else if (e.key === 'Escape' && cancel) {
    e.preventDefault();
    e.stopPropagation();
    cancel();
  }
};
