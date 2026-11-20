import { h, icon } from './shell-views.js';

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
const AMOUNT_MAX = 999_999_999_999;

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const BIZ_W = [1, 3, 7, 1, 3, 7, 1, 3, 5];

export function bizNoOk(d) {
  if (!/^\d{10}$/.test(d)) return false;
  let sum = 0;
  for (let i = 0; i < 9; i++) sum += Number(d[i]) * BIZ_W[i];
  sum += Math.floor((Number(d[8]) * 5) / 10);
  return (10 - (sum % 10)) % 10 === Number(d[9]);
}
export const bizDigits = (s) => String(s ?? '').replace(/\D/g, '').slice(0, 10);
const bizShape = (d) => (d.length > 5 ? `${d.slice(0, 3)}-${d.slice(3, 5)}-${d.slice(5)}` : d.length > 3 ? `${d.slice(0, 3)}-${d.slice(3)}` : d);
const commas = (d) => (d ? Number(d).toLocaleString('en-US') : '');
export const amountOf = (input) => Number(String(input.value).replace(/\D/g, '')) || 0;

const checks = new WeakMap();
const setters = new WeakMap();
const extras = new WeakMap();
let seq = 0;

const need = (required, text) => (required ? (typeof required === 'string' ? required : text) : null);

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

export function textInput({ value, max, required, ...attrs } = {}) {
  const input = base('input', { type: 'text', value: value ?? '', maxlength: max, required, ...attrs });
  checks.set(input, (v) => (v.trim() ? null : need(required, '이 칸을 채워 주세요.')));
  return input;
}

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

export function dateInput({ value, required, ...attrs } = {}) {
  const input = base('input', { type: 'date', required, ...attrs });
  input.value = value ?? '';
  checks.set(input, (v) => (input.validity.badInput ? '날짜를 끝까지 넣어 주세요.' : v ? null : need(required, '날짜를 넣어 주세요.')));
  return input;
}

export function selectInput(options, { value, ...attrs } = {}) {
  return base('select', attrs, (el) => el.append(...options.map(([v, label]) => h('option', { value: v, selected: v === value }, label))));
}

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

export function kvField({ label, input, help, error, after, attrs = {} }) {
  const { id, box, helpEl, errEl } = wire(input, help, error);
  return [h('dt', {}, h('label', { class: 'sx-field-label', for: id }, label)), h('dd', { ...attrs, class: 'is-editing' }, after ? h('div', { class: 'sx-field-row' }, box, after) : box, helpEl, errEl)];
}

export function fieldError(input, text) {
  setters.get(input)?.(text);
}

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
