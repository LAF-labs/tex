import { amountInput, checkFields, emailInput, keys, kvField, LIMITS, selectInput, textInput } from './fields.js';

export function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of kids.flat(Infinity)) if (c != null && c !== false) el.append(c instanceof Node ? c : String(c));
  if (tag === 'tr' && typeof attrs?.onclick === 'function') {
    el.tabIndex = 0;
    el.addEventListener('keydown', (e) => {
      if (e.target === el && (e.key === 'Enter' || e.key === ' ')) {
        e.preventDefault();
        el.click();
      }
    });
  }
  return el;
}

const SVG = 'http://www.w3.org/2000/svg';
const ICONS = {
  chat: [20, 'M3.5 5.5a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v6a2 2 0 0 1-2 2H9l-3.5 3v-3a2 2 0 0 1-2-2z'],
  docs: [20, 'M3 6.5V15a1.5 1.5 0 0 0 1.5 1.5h11A1.5 1.5 0 0 0 17 15V8a1.5 1.5 0 0 0-1.5-1.5H10L8.5 4.5h-4A1.5 1.5 0 0 0 3 6z'],
  cps: [20, 'M10.25 7a2.75 2.75 0 1 1-5.5 0a2.75 2.75 0 1 1 5.5 0z', 'M2.5 16c.6-2.6 2.6-4 5-4s4.4 1.4 5 4', 'M13 4.6a2.6 2.6 0 0 1 0 5', 'M14.5 12.2c1.6.5 2.6 1.8 3 3.8'],
  biz: [20, 'M3.5 16.5V5.5l6.5-2.5 6.5 2.5v11', 'M2.5 16.5h15', 'M8 16.5v-4h4v4'],
  bundle: [20, 'M3.5 7h13v8.5a1.5 1.5 0 0 1-1.5 1.5H5a1.5 1.5 0 0 1-1.5-1.5z', 'M2.5 4h15v3h-15z', 'M8 10.5h4'],
  activity: [20, 'M6 5h10M6 10h10M6 15h10M3 5h.5M3 10h.5M3 15h.5'],
  settings: [20, 'M12.5 10a2.5 2.5 0 1 1-5 0a2.5 2.5 0 1 1 5 0z', 'M10 2.5v2M10 15.5v2M2.5 10h2M15.5 10h2M4.7 4.7l1.4 1.4M13.9 13.9l1.4 1.4M4.7 15.3l1.4-1.4M13.9 6.1l1.4-1.4'],
  pc: [16, 'M2 3.5h12v7.5H2z', 'M6 13.5h4M8 11v2.5'],
  lock: [16, 'M4.5 7h7A1.5 1.5 0 0 1 13 8.5v4a1.5 1.5 0 0 1-1.5 1.5h-7A1.5 1.5 0 0 1 3 12.5v-4A1.5 1.5 0 0 1 4.5 7z', 'M5.5 7V5a2.5 2.5 0 0 1 5 0'],
  phone: [16, 'M6 1.5h4A1.5 1.5 0 0 1 11.5 3v10a1.5 1.5 0 0 1-1.5 1.5H6A1.5 1.5 0 0 1 4.5 13V3A1.5 1.5 0 0 1 6 1.5z', 'M7 12h2'],
  chevron: [10, 'M2 3.5 5 6.5 8 3.5'],
  chevronLeft: [16, 'M10 3 5 8l5 5'],
  warn: [16, 'M8 2.5 14 13H2z', 'M8 6.5v3M8 11.2v.1'],
  key: [16, 'M8.5 10.5a3 3 0 1 1-6 0a3 3 0 1 1 6 0z', 'M7.7 8.3 13.5 2.5M11.5 4.5l1.5 1.5'],
  mail: [16, 'M2.5 3.5h11a1 1 0 0 1 1 1v7a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1v-7a1 1 0 0 1 1-1z', 'M2 4l6 5 6-5'],
  plus: [16, 'M8 3v10M3 8h10'],
  check: [16, 'M3.5 8.5 6.5 11.5 12.5 4.5'],
  info: [16, 'M14 8A6 6 0 1 1 2 8a6 6 0 0 1 12 0z', 'M8 7.5v3.5M8 5v.5'],
  close: [16, 'M4 4l8 8M12 4l-8 8'],
  eye: [16, 'M1.5 8s2.5-4.5 6.5-4.5S14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8z', 'M10 8a2 2 0 1 1-4 0a2 2 0 1 1 4 0z'],
  eyeOff: [16, 'M1.5 8s2.5-4.5 6.5-4.5S14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8z', 'M10 8a2 2 0 1 1-4 0a2 2 0 1 1 4 0z', 'M2.5 2.5l11 11'],
  send: [14, 'M7 11.5v-9M3 6.5l4-4 4 4'],
  payroll: [20, 'M5 2.5h10A1.5 1.5 0 0 1 16.5 4v12.5l-2-1.25-2 1.25-2.5-1.25-2.5 1.25-2-1.25-2 1.25V4A1.5 1.5 0 0 1 5 2.5z', 'M7 6.5h6M7 9.5h6M7 12.5h3'],
  money: [20, 'M2.5 5.5h15v9h-15z', 'M12.5 10a2.5 2.5 0 1 1-5 0a2.5 2.5 0 1 1 5 0z', 'M5 8v4M15 8v4'],
  pencil: [16, 'M3 13l.7-2.8L10.9 3a1.4 1.4 0 0 1 2 2l-7.2 7.2z'],
  globe: [16, 'M14 8A6 6 0 1 1 2 8a6 6 0 0 1 12 0z', 'M2 8h12', 'M8 2c1.7 1.6 2.5 3.6 2.5 6S9.7 12.4 8 14C6.3 12.4 5.5 10.4 5.5 8S6.3 3.6 8 2z'],
  expand: [16, 'M9.5 2.5h4v4M13.5 2.5 9 7M6.5 13.5h-4v-4M2.5 13.5 7 9'],
  shrink: [16, 'M13 7H9V3M9 7l4.5-4.5M3 9h4v4M7 9l-4.5 4.5'],
};
export function icon(name) {
  const [box, ...paths] = ICONS[name];
  const s = document.createElementNS(SVG, 'svg');
  s.setAttribute('viewBox', `0 0 ${box} ${box}`);
  s.setAttribute('fill', 'none');
  s.setAttribute('stroke', 'currentColor');
  s.setAttribute('stroke-width', '1.5');
  s.setAttribute('stroke-linecap', 'round');
  s.setAttribute('stroke-linejoin', 'round');
  s.setAttribute('aria-hidden', 'true');
  for (const d of paths) {
    const p = document.createElementNS(SVG, 'path');
    p.setAttribute('d', d);
    s.append(p);
  }
  return s;
}

export const num = (n) => Number(n).toLocaleString('en-US');
export const won = (n) => `${num(n)}원`;
export const fmtBiz = (d) => (d && d.length === 10 ? `${d.slice(0, 3)}-${d.slice(3, 5)}-${d.slice(5)}` : d || '—');
const WD = ['일', '월', '화', '수', '목', '금', '토'];
const parse = (s) => {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d);
};
export const dayLabel = (s) => {
  const d = parse(s);
  return `${d.getMonth() + 1}월 ${d.getDate()}일 ${WD[d.getDay()]}요일`;
};
export function museStamp(at, now = new Date(), dateOnly = false) {
  const d = new Date(at);
  const sameDay = d.toDateString() === now.toDateString();
  const date = sameDay ? null : { month: 'short', day: 'numeric', ...(d.getFullYear() === now.getFullYear() ? {} : { year: 'numeric' }) };
  if (dateOnly) return date ? new Intl.DateTimeFormat('ko-KR', date).format(d) : '오늘';
  return new Intl.DateTimeFormat('ko-KR', { ...date, hour: 'numeric', minute: '2-digit' }).format(d);
}
export const museDayStamp = (s, now) => museStamp(parse(s).getTime(), now, true);
export function dday(s, today) {
  if (!s) return null;
  const t = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  return Math.round((parse(s) - t) / 86400000);
}
export const ddayText = (n) => (n === null ? '—' : n < 0 ? '만료됨' : n === 0 ? 'D-day' : `D-${n}`);
export function agoText(s, today) {
  const n = dday(s, today);
  return n === null || n > 0 ? '' : n === 0 ? '(오늘)' : `(${-n}일 전)`;
}

export const CHIP = {
  draft: ['작성 중', ''],
  preparing: ['준비 중', ''],
  turn: ['내 차례', 'is-turn'],
  waiting: ['승인 대기', 'is-waiting'],
  issuing: ['발급 중', ''],
  checking: ['확인 중', ''],
  done: ['완료', 'is-done'],
  stopped: ['중지됨', 'is-stopped'],
  discarded: ['취소함', 'is-stopped'],
  attention: ['확인 필요', 'is-attention'],
};
export const chip = (status, label) => h('span', { class: `sx-chip ${CHIP[status][1]}` }, label ?? CHIP[status][0]);

export const verifying = (run) => run.status === 'issuing' && run.steps[6]?.state === 'now';
export const shownStatus = (run) => (verifying(run) ? 'checking' : run.status);

export function amount(total, supply, tax, note, split = true) {
  return h(
    'div',
    { class: 'sx-amount' },
    h('div', { class: 'sx-amount-total' }, num(total), h('span', { class: 'sx-unit' }, '원')),
    split ? h('div', { class: 'sx-amount-split' }, `공급가 ${num(supply)} + 세액 ${num(tax)}${note ? ` · ${note}` : ''}`) : null,
  );
}

export function kv(rows, start = false) {
  return h(
    'dl',
    { class: `sx-kv${start ? ' is-start' : ''}` },
    rows.filter(Boolean).map(([label, value, o = {}]) => [
      h('dt', {}, label),
      h(
        'dd',
        { class: [o.state ? `is-${o.state}` : '', o.total ? 'is-total' : '', o.start ? 'is-start' : ''].join(' ').trim() || null },
        h('span', { class: `sx-val${o.mono ? ' sx-id' : ''}` }, value ?? '—'),
        o.tag ? h('span', { class: 'sx-tag' }, o.tag) : null,
        o.flag ? h('span', { class: 'sx-flag' }, o.flag) : null,
        o.copy ? h('button', { type: 'button', class: 'sx-copy', onclick: o.copy, 'aria-label': `${label} ${o.copyLabel ?? '복사'}` }, o.copyLabel ?? '복사') : null,
      ),
    ]),
  );
}

export function steps(list) {
  return h(
    'ol',
    { class: 'sx-steps' },
    list.map((s) =>
      h(
        'li',
        { class: s.state === 'todo' ? null : `is-${s.state}` },
        h(
          'span',
          {},
          s.label,
          s.note ? h('small', {}, s.note) : null,
          ...(s.checks ?? []).map((c) => h('small', { class: `sx-step-check ${c.ok ? 'is-ok' : 'is-bad'}`, 'data-portal-check': c.ok ? 'ok' : 'bad' }, c.text)),
        ),
      ),
    ),
  );
}

const STEP_GROUPS = [
  ['홈택스 로그인', [0]],
  ['세금계산서 화면 열기', [1]],
  ['내용 넣고 확인', [2, 3]],
  ['사장님 승인', [4]],
  ['서명하고 발급 확인', [5, 6]],
  ['메일 보낸 것 확인', [7]],
];
const CERT_STEP_GROUPS = [
  ['홈택스 로그인', [0]],
  ['신청 화면 열기', [1]],
  ['신청 내용 넣고 확인', [2, 3]],
  ['사장님 승인', [4]],
  ['발급하고 확인', [5, 6]],
];
const ACTIVE = ['preparing', 'turn', 'waiting', 'issuing'];
export function runSteps(run) {
  const groups = (run.cert ? CERT_STEP_GROUPS : STEP_GROUPS).map(([label, idx]) => {
    const g = group(label, idx);
    const checks = (run.portalChecks ?? []).filter((c) => idx.includes(c.step));
    return checks.length ? { ...g, checks } : g;
  });
  function group(label, idx) {
    const xs = idx.map((i) => run.steps[i]).filter(Boolean);
    const pick = (st) => xs.find((s) => s.state === st);
    const att = pick('attention');
    const now = pick('now');
    if (att) return { label, state: 'attention', note: att.note };
    if (now) return { label, state: 'now', note: now.note };
    if (xs.length && xs.every((s) => s.state === 'done')) return { label, state: 'done', note: xs.map((s) => s.note).filter(Boolean)[0] };
    if (xs.some((s) => s.state === 'done') && ACTIVE.includes(run.status)) return { label, state: 'now' };
    return { label, state: 'todo' };
  }
  if (run.status === 'attention' && !groups.some((g) => g.state === 'attention')) {
    const at = groups.find((g) => g.state !== 'done');
    if (at) at.state = 'attention';
  }
  return groups;
}

export function note(text, attention, extra, ic = 'info') {
  return h('div', { class: `sx-note${attention ? ' is-attention' : ''}` }, icon(ic), h('div', {}, text, extra ? h('div', { class: 'sx-meta' }, extra) : null));
}

export function noteGroup(items, attention = true, ic = attention ? 'warn' : 'info') {
  const list = items.filter(Boolean).map((x) => (Array.isArray(x) ? x : [x, {}]));
  if (!list.length) return null;
  return h('div', { class: `sx-note${attention ? ' is-attention' : ''}`, 'data-note-group': String(list.length) }, icon(ic), h('div', { class: 'sx-note-body' }, ...list.map(([t, a]) => h('p', a, t))));
}

const tagged = (el, key, value) => ((el.dataset[key] = value), el);

export const btn = (label, onclick, kind = '', attrs = {}) => h('button', { type: 'button', class: `sx-btn ${kind}`.trim(), onclick, ...attrs }, label);

const vatText = (run) => (run.vat === 'separate' ? (run.status === 'draft' && run.vatGuessed ? '부가세 별도로 계산했어요' : '부가세 별도') : '부가세 포함');
const nowStep = (run) => runSteps(run).find((s) => s.state === 'now' || s.state === 'attention');
const line = (text, muted) => h('p', { class: `sx-body-sm${muted ? ' is-muted' : ''}` }, text);

export const NO_CHROME_TEXT = 'Chrome이 설치돼 있어야 홈택스에서 준비할 수 있어요. Chrome을 설치한 뒤 [홈택스에서 준비]를 다시 눌러 주세요. 아직 아무것도 보내지 않았어요.';
export const CHROME_GUIDE_TEXT = '홈택스 작업은 이 PC의 Chrome 창에서 해요. 다른 브라우저에서 google.com/chrome 을 열어 Chrome을 설치한 뒤 [다시 확인]을 눌러 주세요.';
export const ISSUE_DATE_LATE_TEXT = '국세청 안내 발급기한(공급한 달 다음 달 10일)이 지났어요. 가산세가 붙는지는 세무사에게 확인해 보세요.';
export const ISSUE_DATE_HELD_TEXT = '작성일자를 오늘이 아닌 날로 정한 카드는 곧 발급할 수 있어요. 지금 발급하려면 작성일자를 오늘로 바꿔 주세요.';
export const writeDateText = (d) => {
  const y = Number(String(d).slice(0, 4));
  const md = `${Number(String(d).slice(5, 7))}월 ${Number(String(d).slice(8, 10))}일`;
  return y === Number(new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul', year: 'numeric' }).format(new Date())) ? md : `${y}년 ${md}`;
};
export const DUP_TODAY_TEXT = '이미 오늘 같은 거래처·같은 금액으로 발급했어요. 한 번 더 발급하려는 게 맞는지 확인해 주세요.';

export function emptyState(title, sub, action = null, attrs = {}) {
  return h('div', { class: 'empty', ...attrs }, h('p', { class: 'empty-title' }, title), sub ? h('p', { class: 'empty-sub' }, sub) : null, action ? h('div', { class: 'empty-act' }, action) : null);
}

export function replyOptions(opts, attrs = {}) {
  const box = h('div', { class: 'sx-replies', role: 'group', ...attrs });
  const rows = opts.map((o) =>
    h(
      'button',
      {
        type: 'button',
        class: 'sx-reply',
        'data-act': o.act ?? null,
        ...(o.attrs ?? {}),
        onclick: (e) => {
          const row = e.currentTarget;
          if (box.dataset.picked) return;
          if (o.lock !== false) {
            box.dataset.picked = '1';
            for (const r of rows) r.disabled = r !== row;
            row.classList.add('is-picked');
            row.append(icon('check'));
          }
          o.onPick(e);
        },
      },
      h('span', {}, o.label),
    ),
  );
  box.append(...rows);
  return box;
}

export const NO_FILE_TEXT = '세금계산서 PDF는 홈택스 발급목록에서 확인할 수 있어요.';
const CERT_NO_FILE_TEXT = '증명서 PDF는 홈택스 민원증명 발급 내역에서 다시 출력할 수 있어요.';

export const runTitle = (run) => (run.cert ? run.cert.name : `세금계산서 · ${run.counterparty.name}`);
const certLine = (run) => h('div', { class: 'sx-meta', 'data-cert-inputs': '' }, `사용 용도 ${run.cert.inputs.purpose ?? ''} · 제출처 ${run.cert.inputs.submitTo ?? ''}`);

const showBrowserBtn = (run, act, primary = false) => btn('홈택스 창 보기', () => act.showBrowser(run.id), primary ? 'sx-btn-primary' : '', { 'data-act': 'show-browser' });

const INFO_NOTICE = /이 값으로 준비해요|이어서 준비해요|한 번 더 로그인해 볼게요/;
const verifyLine = (n) => (n && n > 1 ? `발급 목록 다시 확인 중(${n}번째)` : '발급 목록 확인 중 · 1~2분 걸려요');
const stepLine = (now, withNote = true) => (now ? (withNote && now.note ? now.note : now.label) : '');
function progressBar(run) {
  const gs = runSteps(run);
  const done = gs.filter((g) => g.state === 'done').length;
  const at = gs.findIndex((g) => g.state === 'now' || g.state === 'attention');
  const n = Math.min(gs.length, done + (at >= 0 ? 0.5 : 0));
  const fill = h('i');
  fill.style.width = `${Math.round((n / gs.length) * 100)}%`;
  return h('div', { class: 'sx-progress', role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': String(gs.length), 'aria-valuenow': String(done), 'aria-label': `${gs.length}단계 중 ${done}단계 끝`, 'data-progress': `${done}/${gs.length}` }, fill);
}

const todoLine = (text, ...meta) => h('div', { class: 'sx-todo' }, h('p', {}, text), meta.filter(Boolean).map((m) => (m instanceof Node ? m : h('p', { class: 'sx-meta' }, m))));

function fold(card, run, act, step, stop = null) {
  card.classList.toggle('is-attention', run.status === 'attention');
  const info = (run.notices ?? []).filter((t) => INFO_NOTICE.test(t));
  card.replaceChildren(
    h('div', { class: 'sx-card-hd sx-run-hd' }, h('div', { class: 'sx-card-title' }, `${run.batch ? `${run.batch.index + 1}. ` : ''}${runTitle(run)}`), chip(shownStatus(run)), stop),
    runSummary(run),
    step || info.length
      ? h(
          'div',
          { class: 'sx-run-foot' },
          run.status === 'attention' || run.status === 'stopped' ? null : progressBar(run),
          step ? h('p', { class: 'sx-card-now', 'aria-live': 'polite' }, step, progressCount(run)) : null,
          ...info.map((t) => h('p', { class: 'sx-run-info', 'data-run-info': '' }, t)),
          stepsToggle(run, act),
        )
      : null,
  );
}

function stepsToggle(run, act) {
  if (!act?.stepsOpen) return null;
  const open = act.stepsOpen.has(run.id);
  const list = steps(runSteps(run));
  list.classList.add('sx-run-steps');
  if (!open) list.hidden = true;
  const b = h('button', { type: 'button', class: 'sx-steps-toggle', 'data-act': 'steps-toggle', 'aria-expanded': String(open) }, open ? '단계 접기' : '단계 보기', icon('chevron'));
  b.addEventListener('click', () => {
    const now = list.hidden;
    list.hidden = !now;
    b.setAttribute('aria-expanded', String(now));
    b.firstChild.textContent = now ? '단계 접기' : '단계 보기';
    act.toggleSteps(run.id, now);
  });
  return [b, list];
}

function runSummary(run) {
  if (run.cert) return certLine(run);
  return h('p', { class: 'sx-run-sum', 'data-run-facts': '' }, h('b', {}, won(run.total)), ` · 부가세 ${run.vat === 'separate' ? '별도' : '포함'}${run.item ? ` · ${run.item}` : ''}`);
}
function progressCount(run) {
  if (run.status === 'attention' || run.status === 'stopped') return null;
  const gs = runSteps(run);
  return h('span', { class: 'sx-run-count' }, `${Math.min(gs.length, gs.filter((g) => g.state === 'done').length + 1)}/${gs.length}`);
}
const stopBtn = (run, act) => btn('중지', () => act.stop(run.id), 'sx-btn-quiet', { 'data-act': 'stop' });

export function taskCard(run, act) {
  const title = runTitle(run);
  if (run.discarded)
    return h(
      'section',
      { class: 'sx-card is-discarded', 'data-run': run.id, 'data-status': 'discarded' },
      h('div', { class: 'sx-card-hd' }, h('div', { class: 'sx-card-title' }, title), chip('discarded')),
      h('p', { class: 'sx-meta' }, '발급 전에 취소한 카드예요. 홈택스에는 아무것도 보내지 않았어요.'),
    );
  const st = run.status;
  const card = h('section', { class: `sx-card${st === 'turn' || st === 'waiting' ? ' is-turn' : ''}`, 'data-run': run.id, 'data-status': st });
  const domAppend = card.append.bind(card);
  card.append = (...kids) => domAppend(...kids.flat().filter((k) => k != null && k !== false));
  card.addEventListener('click', (e) => {
    if (!e.target.closest('button, input, select, dl, .sx-where')) act.open(run.id);
  });
  const hd = h('div', { class: 'sx-card-hd' }, h('div', { class: 'sx-card-title' }, title), chip(shownStatus(run)));
  card.append(hd, st === 'draft' && !run.cert ? null : runSummary(run));
  const now = nowStep(run);

  if (st === 'draft' && run.cert) {
    card.append(
      run.noChrome ? h('div', { 'data-no-chrome': '' }, note(NO_CHROME_TEXT, true)) : null,
      h('div', { class: 'sx-actions' }, btn('홈택스에서 떼기', () => act.prepare(run.id), 'sx-btn-primary', { 'data-act': 'prepare' }), btn('취소', () => act.stop(run.id), 'sx-btn-quiet', { 'data-act': 'cancel' })),
      h('div', { class: 'sx-meta' }, '아직 아무것도 보내지 않았어요'),
    );
  } else if (st === 'draft') {
    const noItem = !String(run.item ?? '').trim();
    const noAmount = !(Number(run.total) > 0);
    const errAt = (f) => (act.draftErr?.id === run.id && act.draftErr.field === f ? act.draftErr.msg : null);
    const kept = (act.draftErr?.id === run.id && act.draftErr.vals) || {};
    const err = act.draftErr?.id === run.id && !act.draftErr.field ? h('p', { class: 'sx-field-error', role: 'alert', 'data-draft-err': '' }, act.draftErr.msg) : null;
    const valBtn = (label, text, onclick, o = {}) =>
      h('button', { type: 'button', class: `sx-val-btn${o.cls ? ` ${o.cls}` : ''}`, 'data-act': o.act, 'aria-label': `${label}: ${text}. 눌러서 고치기`, onclick }, text);
    let rows;
    if (act.editingCp === run.id) {
      const others = (act.counterparties ?? []).filter((c) => c.id !== run.counterparty.id);
      const cancel = () => act.editCp(null);
      const quit = btn('그만두기', cancel, 'sx-btn-quiet', { 'data-act': 'draft-cp-cancel' });
      if (others.length) {
        const sel = selectInput(others.map((c) => [c.id, c.name]), { name: 'counterparty', compact: true });
        const save = () => act.saveCp(run.id, sel.value);
        sel.addEventListener('keydown', keys(save, cancel));
        rows = kvField({ label: '거래처', input: sel, error: errAt('counterparty'), after: [btn('바꾸기', save, 'sx-btn-primary', { 'data-act': 'draft-cp-save' }), quit], attrs: { 'data-draft-cp': '' } });
        setTimeout(() => sel.focus(), 0);
      } else rows = [h('dt', {}, '거래처'), h('dd', { class: 'is-editing' }, h('div', { class: 'sx-actions', 'data-draft-cp': '' }, h('span', { class: 'sx-meta' }, '장부에 다른 거래처가 없어요. 거래처 화면에서 추가할 수 있어요.'), quit))];
    } else if (act.editing === run.id) {
      const input = amountInput({ name: 'amount', value: kept.amount ?? run.amount, units: true, compact: true });
      const save = () => checkFields([input]) && act.saveAmount(run.id, input.value);
      const cancel = () => act.editAmount(null);
      input.addEventListener('keydown', keys(save, cancel));
      rows = kvField({ label: run.vat === 'separate' ? '공급가액' : '합계', input, error: errAt('amount'), after: [btn('바꾸기', save, 'sx-btn-primary'), btn('그만두기', cancel, 'sx-btn-quiet')] });
      setTimeout(() => (input.focus(), input.select()), 0);
    } else if (act.editingFields === run.id) {
      const item = textInput({ name: 'item', value: kept.item ?? run.item, max: LIMITS.item, required: '품목을 넣어 주세요. 예: 컨설팅 용역', placeholder: '예: 컨설팅 용역', compact: true });
      const email = emailInput({ name: 'email', value: kept.email ?? run.email.value, compact: true });
      const save = () => checkFields([item, email]) && act.saveFields(run.id, item.value, email.value);
      const cancel = () => act.editFields(null);
      for (const i of [item, email]) i.addEventListener('keydown', keys(save, cancel));
      rows = [
        ...kvField({ label: '품목', input: item, error: errAt('item') }),
        ...kvField({ label: '받는 이메일', input: email, help: '비우면 메일을 보내지 않아요', error: errAt('email') }),
        h('dt', {}, ''),
        h('dd', { class: 'is-editing' }, h('div', { class: 'sx-actions' }, btn('바꾸기', save, 'sx-btn-primary', { 'data-act': 'fields-save' }), btn('그만두기', cancel, 'sx-btn-quiet', { 'data-act': 'fields-cancel' }))),
      ];
      setTimeout(() => (act.editingFocus === 'email' ? email : item).focus(), 0);
    } else {
      const vatSeg = h(
        'div',
        { class: 'sx-seg', role: 'group', 'aria-label': '부가세' },
        ...[['separate', '별도', 'included'], ['included', '포함', 'separate']].map(([v, label]) =>
          h('button', { type: 'button', class: run.vat === v ? 'is-on' : null, 'aria-pressed': String(run.vat === v), 'data-act': run.vat === v ? null : 'vat', onclick: run.vat === v ? null : () => act.vat(run.id, v) }, label),
        ),
      );
      const more = (...kids) => h('div', { class: 'sx-draft-more', 'data-draft-more': '', hidden: act.draftMore?.has?.(run.id) ? null : '' }, ...kids);
      rows = [
        h('dt', {}, '부가세'),
        h('dd', {}, vatSeg, run.vatGuessed ? h('span', { class: 'sx-tag' }, '기본값') : null),
        h('dt', {}, '품목'),
        h('dd', { 'data-draft-item': run.item ?? '' }, valBtn('품목', `${noItem ? '비어 있음' : run.item}`, () => act.editFields(run.id, 'item'), { act: 'fields-edit', cls: noItem ? 'is-missing' : run.itemGuessed ? 'is-guessed' : '' }), !noItem && run.itemGuessed ? h('span', { class: 'sx-tag' }, '저장 품목') : null),
        ...(run.writeDateSet ? [h('dt', {}, '작성일자'), h('dd', { 'data-draft-date': run.writeDate ?? '' }, writeDateText(run.writeDate), h('span', { class: 'sx-tag' }, '오늘 아님'))] : []),
        more(
          h('dt', {}, '거래처'),
          h('dd', {}, valBtn('거래처', run.counterparty.name, () => act.editCp(run.id), { act: 'draft-cp' })),
          ...(run.writeDateSet ? [] : [h('dt', {}, '작성일자'), h('dd', { 'data-draft-date': run.writeDate ?? '' }, writeDateText(run.writeDate))]),
          h('dt', {}, '받는 이메일'),
          h('dd', { 'data-draft-email': run.email.value ?? '' }, valBtn('받는 이메일', run.email.value || '없음 · 메일은 보내지 않아요', () => act.editFields(run.id, 'email'), { act: 'email-edit', cls: run.email.value ? '' : 'is-none' })),
        ),
      ];
    }
    const editing = act.editingCp === run.id || act.editing === run.id || act.editingFields === run.id;
    card.append(
      h(
        'div',
        { class: 'sx-amount', 'data-draft-amount': '' },
        valBtn('금액', `${num(run.total)}원`, () => act.editAmount(run.id), { act: 'amount-edit', cls: noAmount ? 'is-total is-missing' : 'is-total' }),
        run.quantity && run.unitPrice ? h('span', { class: 'sx-amount-split' }, `${num(run.quantity)} × ${num(run.unitPrice)}`) : null,
      ),
    );
    card.append(
      noteGroup([
        run.noChrome ? [NO_CHROME_TEXT, { 'data-no-chrome': '' }] : null,
        run.dupToday ? [DUP_TODAY_TEXT, { 'data-dup-today': '' }] : null,
        run.issueDateHeld ? [ISSUE_DATE_HELD_TEXT, { 'data-issue-date-held': '' }] : run.issueDateLate ? [ISSUE_DATE_LATE_TEXT, { 'data-issue-date-late': '' }] : null,
      ]),
      h('dl', { class: 'sx-kv sx-draft', 'data-draft-fields': '', 'data-draft-edit': act.editingFields === run.id ? '' : null }, ...rows),
      err,
      editing
        ? null
        : h(
            'div',
            { class: 'sx-actions' },
            btn('홈택스에서 준비', () => act.prepare(run.id), 'sx-btn-primary', { 'data-act': 'prepare', disabled: noItem || noAmount || !!run.issueDateHeld }),
            btn('취소', () => act.stop(run.id), 'sx-btn-quiet', { 'data-act': 'cancel' }),
            act.editingCp === run.id || act.editing === run.id || act.editingFields === run.id
              ? null
              : h('button', { type: 'button', class: 'sx-btn sx-btn-quiet sx-more-btn', 'data-act': 'draft-more', 'aria-expanded': String(!!act.draftMore?.has?.(run.id)), onclick: (e) => {
                  const box = e.currentTarget.closest('[data-run]')?.querySelector('[data-draft-more]');
                  if (!box) return;
                  box.hidden = !box.hidden;
                  e.currentTarget.textContent = box.hidden ? '자세히' : '접기';
                  e.currentTarget.setAttribute('aria-expanded', String(!box.hidden));
                  act.toggleDraftMore?.(run.id, !box.hidden);
                } }, act.draftMore?.has?.(run.id) ? '접기' : '자세히'),
          ),
      editing ? null : h('div', { class: 'sx-meta' }, noAmount ? '합계가 0원이에요. 금액을 눌러 고치면 준비할 수 있어요.' : noItem ? '품목을 넣으면 준비할 수 있어요.' : '값을 누르면 고쳐요 · 아직 보낸 것은 없어요'),
    );
  } else if (st === 'preparing') {
    fold(card, run, act, stepLine(now, run.steps[0].state !== 'now'), stopBtn(run, act));
  } else if (verifying(run)) {
    fold(card, run, act, h('span', { 'data-verify-attempt': run.verifyAttempt ? String(run.verifyAttempt) : null }, verifyLine(run.verifyAttempt)));
  } else if (st === 'issuing' && run.steps[5].state === 'now' && run.steps[5].note) {
    card.dataset.signNow = '';
    fold(card, run, act, stepLine(now, false));
    card.append(todoLine(`${run.steps[5].note}. 끝나면 자동으로 이어집니다`, '홈택스 발급목록에서 확인할 때까지 다시 발급하지 않아요.'), h('div', { class: 'sx-actions' }, showBrowserBtn(run, act, true)));
  } else if (st === 'issuing') {
    fold(card, run, act, stepLine(now));
  } else if (st === 'turn' && run.handoff) {
    const kind = run.handoff.kind ?? 'other';
    card.dataset.handoff = kind;
    fold(card, run, act, stepLine(now, false), btn('중지', () => act.stop(run.id), 'sx-btn-quiet', { 'data-act': 'stop' }));
    card.append(
      todoLine(run.turn.text, run.turn.note, kind === 'sign' ? h('p', { class: 'sx-meta', 'data-sign-wait': '' }, '서명을 마치면 앱이 발급목록을 확인해요. 그동안 다시 발급하지 않아요.') : null),
      h(
        'div',
        { class: 'sx-actions' },
        kind === 'sign' ? showBrowserBtn(run, act, true) : null,
        run.handoff.code === 'login.simple_sent' ? btn('승인했어요', () => act.simpleDone(run.id), 'sx-btn-primary', { 'data-act': 'simple-done' }) : null,
        run.handoff.code === 'login.simple_auth' || run.handoff.code === 'login.simple_sent' ? btn('인증서로 다시 시도', () => act.retryCert(run.id), run.handoff.code === 'login.simple_auth' ? 'sx-btn-primary' : '', { 'data-act': 'retry-cert' }) : null,
        run.handoff.code === 'login.simple_sent' ? null : kind === 'login' ? btn(run.handoff.code === 'login.simple_auth' ? '간편인증 마치고 이어서' : '이어서', () => act.resume(run.id), run.handoff.code === 'login.simple_auth' ? '' : 'sx-btn-primary', { 'data-act': 'resume' }) : btn('다 했어요', () => act.resume(run.id), kind === 'sign' ? '' : 'sx-btn-primary', { 'data-act': 'resume' }),
        kind === 'other' ? btn('직접 발급함', () => act.manualDone(run.id), '', { 'data-act': 'manual-done' }) : null,
        kind === 'sign' ? null : showBrowserBtn(run, act),
      ),
    );
  } else if (st === 'turn') {
    const signing = run.steps[4].state === 'done';
    fold(card, run, act, stepLine(now, false), signing ? null : stopBtn(run, act));
    card.append(todoLine(run.turn.text, run.turn.note));
  } else if (st === 'waiting') {
    card.replaceChildren();
    card.classList.add('is-folded');
    card.append(
      ...[
        h('div', { class: 'sx-card-hd', 'data-folded': '' }, h('div', { class: 'sx-card-title sx-folded' }, icon('check'), '작성 완료'), h('span', { class: 'sx-meta sx-folded-line' }, run.cert ? `${run.cert.name} · ${run.cert.inputs.purpose ?? ''}` : `세금계산서 · ${run.counterparty.name} · ${won(run.total)}`), chip(shownStatus(run))),
        run.regate ? tagged(note(run.regate.note, true), 'regate', run.regate.reason) : null,
        run.approvedPending ? h('div', { class: 'sx-actions' }, note('승인했어요. 2초 안에 [중지]하면 발급하지 않아요'), btn('중지', () => act.stop(run.id), 'sx-btn-quiet', { 'data-act': 'stop' })) : null,
      ].filter(Boolean),
    );
  } else if (st === 'done') {
    const r = run.result;
    const mail = run.cert ? '문서함 증명서에 넣었어요.' : r.mailConfirmed ? `${run.counterparty.name} 메일로 보낸 것도 확인했어요.` : r.mailTo ? '메일 발송은 홈택스 메일발송목록에서 확인해 주세요.' : '받는 이메일이 없어 메일은 보내지 않았어요.';
    const where = whereItWent(run);
    where.hidden = true;
    const toggle = btn('어디로 무엇이 갔나요', () => {
      where.hidden = !where.hidden;
      toggle.setAttribute('aria-expanded', String(!where.hidden));
    }, 'sx-btn-quiet', { 'aria-expanded': 'false' });
    card.append(
      h(
        'div',
        { class: 'sx-run-foot' },
        h('p', { class: 'sx-card-now' }, `발급했어요. ${mail}`),
        r.approvalNo ? h('p', { class: 'sx-card-now sx-run-id' }, h('span', { class: 'sx-meta' }, run.cert ? '접수번호' : '승인번호'), h('span', { class: 'sx-id', 'data-approval-no': '' }, r.approvalNo), h('button', { type: 'button', class: 'sx-copy', onclick: () => act.copy(r.approvalNo) }, '복사')) : null,
      ),
      r.noFile ? line(run.cert ? CERT_NO_FILE_TEXT : NO_FILE_TEXT, true) : null,
      h('div', { class: 'sx-actions' }, r.noFile ? null : btn('PDF 열기', () => act.openRunDoc(run), 'sx-btn-primary', { 'data-act': 'result-open' }), btn(run.cert ? '한 번 더 떼기' : '지난번과 같게', () => act.again(run), '', { 'data-act': 'again' }), toggle),
      where,
    );
  } else if (st === 'stopped' && run.replaced) {
    card.replaceChildren(h('div', { class: 'sx-replaced-line', 'data-replaced': '' }, h('span', {}, runTitle(run)), h('span', {}, `${won(run.total)} · 고친 값으로 바꿨어요`)));
    card.classList.add('is-folded', 'is-replaced');
    return card;
  } else if (st === 'stopped') {
    fold(card, run, act, null);
    card.append(line(run.stoppedNote || '중지했어요.', true));
    if (run.browserClosed) card.append(h('div', { class: 'sx-actions' }, btn('다시 시작', () => act.restart(run.id), 'sx-btn-primary', { 'data-act': 'restart' })));
    else if (run.redo) card.append(h('div', { class: 'sx-actions' }, btn('다시 준비', () => act.redraft(run.id), 'sx-btn-primary', { 'data-act': 'redraft' })));
  } else if (st === 'attention' && run.inDoubt) {
    card.dataset.inDoubt = '1';
    fold(card, run, act, stepLine(now, false));
    card.append(
      todoLine(
        run.stoppedNote || '발급됐는지 확인하지 못했어요.',
        '확인되기 전에는 이 건을 다시 발급하지 않아요.',
        run.attest?.note ? h('p', { class: 'sx-meta', 'data-attest': run.attest.state }, run.attest.note) : null,
      ),
      h('div', { class: 'sx-actions' }, btn('홈택스에서 직접 확인', () => act.open(run.id), 'sx-btn-primary', { 'data-act': 'check-list' })),
    );
  } else if (st === 'attention') {
    fold(card, run, act, stepLine(now, false));
    card.append(
      todoLine(run.stoppedNote || '확인이 필요해요.'),
      run.maintenance
        ? run.maintenance.restartedAs
          ? line('같은 내용으로 다시 시작했어요. 아래 새 카드에서 이어져요.', true)
          : run.maintenance.until
            ? h('div', { class: 'sx-meta', 'data-maintenance': 'auto' }, `${run.maintenance.until} 지나면 자동으로 다시 시작해요`)
            : h('div', { class: 'sx-actions', 'data-maintenance': 'manual' }, btn('다시 시작', () => act.restart(run.id), 'sx-btn-primary', { 'data-act': 'maintenance-restart' }))
        : run.handoffEnd
        ? h('div', { class: 'sx-actions' }, btn('다시 준비', () => act.redraft(run.id), 'sx-btn-primary', { 'data-act': 'handoff-again' }), btn('홈택스에서 직접 발급', () => act.open(run.id), '', { 'data-act': 'handoff-manual' }))
        : run.redo && !run.retry
          ? h('div', { class: 'sx-actions' }, btn('다시 준비', () => act.redraft(run.id), 'sx-btn-primary', { 'data-act': 'redo' }))
          : null,
    );
  }
  const warnNotices = (run.notices ?? []).filter((t) => !INFO_NOTICE.test(t));
  if (warnNotices.length) card.append(noteGroup(warnNotices));
  if (!card.querySelector('[data-run-info]')) for (const t of (run.notices ?? []).filter((x) => INFO_NOTICE.test(x))) card.append(h('p', { class: 'sx-run-info', 'data-run-info': '' }, t));
  if (run.retry && !run.result && !run.inDoubt && (st === 'stopped' || st === 'attention')) {
    card.append(h('div', { class: 'sx-actions' }, btn('다시 시도', () => act.again(run), 'sx-btn-primary', { 'data-act': 'retry' })));
  }
  return card;
}

const sentSet = (sent) => new Set(Array.isArray(sent) ? sent.filter((x) => typeof x === 'string') : []);
export const modelRow = (sent) => {
  const s = sentSet(sent);
  if (s.has('openrouter_demo')) return ['AI', '시연용 외부 AI · 채팅 문장과 가상 거래처 이름만 보냄'];
  if (s.has('gateway.decide')) return ['AI', '요청 이해에 씀 · 이름·번호를 가린 요청 문장만 보냄'];
  return ['AI', '쓰지 않음(요청은 이 PC 안에서 이해함)'];
};
export const serverRow = (sent) => {
  const s = sentSet(sent);
  const parts = [s.has('gateway.run_tokens') ? '실행 허가 받기(문장 없음)' : null, s.has('gateway.decide') ? '이름·번호를 가린 요청 문장' : null, s.has('gateway.respond') ? '이름·번호를 가린 대화 문장(짧은 답)' : null].filter(Boolean);
  return ['우리 서버', parts.length ? parts.join(', ') : '보낸 것 없음'];
};
export const modelCell = (sent) => {
  const s = sentSet(sent);
  return s.has('openrouter_demo') ? '시연용 AI' : s.has('gateway.decide') ? '우리 서버' : null;
};

export function batchCard(runs, act) {
  const live = (r) => ['preparing', 'turn', 'waiting', 'issuing'].includes(r.status);
  const done = runs.filter((r) => r.status === 'done').length;
  const total = runs.reduce((n, r) => n + (r.discarded ? 0 : Number(r.total) || 0), 0);
  const focus = runs.find(live) ?? runs.find((r) => r.status === 'draft' && !r.discarded) ?? null;
  const approved = runs.some((r) => r.batch?.approved);
  const halted = runs.some((r) => r.batch?.halted);
  const ended = !focus;
  const extra = runs.filter((r) => r !== focus && !r.discarded && (r.status === 'attention' || (r.status === 'stopped' && (r.redo || r.browserClosed))));
  const inRow = new Set([...(focus && live(focus) ? [focus] : []), ...extra]);
  const rows = runs.map((r) =>
    inRow.has(r)
      ? h('li', { class: 'is-card', 'data-batch-row': r.id, 'data-status': shownStatus(r) }, taskCard(r, act))
      : h(
          'li',
          { 'data-batch-row': r.id, 'data-status': r.discarded ? 'discarded' : shownStatus(r), onclick: () => act.open(r.id) },
          h('span', { class: 'sx-batch-name' }, `${(r.batch?.index ?? 0) + 1}. ${r.counterparty.name}`),
          h('span', { class: 'sx-batch-amt' }, `${num(r.total)}원`),
          r.discarded ? chip('discarded') : chip(shownStatus(r)),
          r.result?.approvalNo ? h('span', { class: 'sx-batch-no' }, `승인번호 ${r.result.approvalNo}`) : null,
        ),
  );
  const lead = ended
    ? `${runs.length}건 중 ${done}건 발급했어요.`
    : halted
      ? `${runs.length}건 중 ${done}건 발급하고 묶음을 멈췄어요. 남은 건은 [홈택스에서 준비]를 누르면 승인 카드에서 한 건씩 승인해요.`
      : approved
      ? '한 번 승인으로 차례로 발급하고 있어요. 홈택스 값이 승인 때와 다르면 그 건만 다시 물어요.'
      : `모두 합계 ${num(total)}원. 첫 승인 카드에서 한 번 승인하면 나머지는 차례로 발급해요.`;
  return h(
    'article',
    { class: 'sx-card sx-batch', 'data-batch': runs[0].batch.id, 'data-done': done },
    h('div', { class: 'sx-card-hd' }, h('div', { class: 'sx-card-title' }, `세금계산서 ${runs.length}건 · 차례로 발급`), h('span', { class: `sx-chip${ended ? ' is-done' : ''}` }, `${done}/${runs.length} 발급`)),
    h('p', { class: 'sx-meta' }, lead),
    h('ol', { class: 'sx-batch-list' }, rows),
    focus && !inRow.has(focus) ? taskCard(focus, act) : null,
  );
}

export function whereRows(run) {
  if (run.cert) return [['홈택스', `${run.cert.name} 1건 발급`], ['보관', '이 PC 문서함 · 증명서'], modelRow(run.sent), serverRow(run.sent)];
  return [
    ['홈택스', '전자세금계산서 1건 발급 · 발급목록에서 확인'],
    ['메일', run.result.mailTo ? `${run.result.mailTo} · 홈택스가 보냄, ${run.result.mailConfirmed ? '메일발송목록에서 확인' : '메일발송목록에서 확인하지 못함'}` : '보내지 않음'],
    ['보관', '이 PC 문서함 · 파일명에는 거래처·승인번호를 넣지 않아요'],
    modelRow(run.sent),
    serverRow(run.sent),
  ];
}
function whereItWent(run) {
  return h('div', { class: 'sx-where' }, kv(whereRows(run), true));
}

const panelX = (act) => h('button', { type: 'button', class: 'panel-x', 'aria-label': '패널 닫기', onclick: act.closePanel }, icon('close'));

export function runPanel(run, act) {
  const st = run.status;
  const confirmed = run.confirmed;
  const tag = confirmed ? { state: 'verified', tag: '홈택스 확정' } : {};
  const r = run.result;
  const guessed = [run.vatGuessed ? '부가세' : null, run.itemGuessed ? '품목' : null].filter(Boolean);
  const rows = run.cert
    ? [
        st === 'done' && r?.approvalNo ? ['접수번호', r.approvalNo, { mono: true }] : null,
        ['신청 사업자', act.supplier()],
        ['서류', run.cert.name],
        ['사용 용도', run.cert.inputs.purpose, tag],
        ['제출처', run.cert.inputs.submitTo, tag],
        ['발급 인증', run.auth, { tag: '설정에서 변경' }],
      ]
    : [
        st === 'done' && r ? ['승인번호', r.approvalNo, { mono: true }] : null,
        ['공급자', act.supplier()],
        ['공급받는자', run.counterparty.name, { ...tag, flag: run.counterparty.first ? '처음 거래' : null }],
        ['사업자번호', fmtBiz(run.counterparty.bizNo), { ...tag, mono: true }],
        st === 'draft' ? ['부가세', run.vat === 'separate' ? '별도' : '포함', run.vatGuessed ? { state: 'inferred', tag: '기본값' } : {}] : null,
        ['공급가', won(run.supply), tag],
        ['세액', won(run.tax), confirmed ? tag : run.vatGuessed ? { state: 'inferred', tag: '추정' } : {}],
        ['품목', run.item || null, confirmed ? tag : run.itemGuessed ? { state: 'inferred', tag: '저장 품목' } : {}],
        ['작성일자', run.writeDate, tag],
        ['받는 이메일', run.email.value, { ...(st === 'done' && r?.mailConfirmed ? { state: 'verified', tag: '전송 확인' } : tag), flag: run.email.first ? '처음 보내는 주소' : null }],
        ['발급 인증', run.auth, { tag: '설정에서 변경' }],
      ];
  const source =
    st === 'done' && r
      ? `홈택스 발급목록에서 확인 · ${r.doneAt}`
      : confirmed
        ? `홈택스에서 다시 읽음 · ${run.createdAt} 요청`
        : st === 'draft'
          ? `초안 · ${guessed.length ? `추정 값 ${guessed.length}개 · ` : ''}아직 아무것도 보내지 않았어요`
          : run.cert
            ? `요청 문장과 기본 용도·제출처로 채움 · ${run.createdAt}`
            : `요청 문장과 거래처 장부에서 채움 · ${run.createdAt}`;
  const canStop = st === 'preparing' || st === 'waiting' || (st === 'turn' && (!!run.handoff || run.steps[4].state !== 'done'));
  const promise = st === 'preparing' ? '승인하기 전에는 아무것도 발급하지 않아요.' : st === 'issuing' ? '홈택스 발급목록에서 확인할 때까지 다시 발급하지 않아요.' : null;
  return h(
    'div',
    { class: 'panel-in', 'data-panel-run': run.id },
    h('div', { class: 'sx-card-hd' }, h('div', { class: 'sx-card-title' }, runTitle(run)), chip(shownStatus(run)), panelX(act)),
    run.cert ? null : amount(run.total, run.supply, run.tax, vatText(run)),
    st === 'attention' && run.inDoubt ? checkListGuide(run, act) : null,
    kv(rows),
    h('div', { class: 'sx-source' }, source),
    h('div', { class: 'sx-panel-sec' }, '실행 단계'),
    steps(runSteps(run)),
    promise ? line(promise, true) : null,
    canStop ? h('div', { class: 'sx-actions' }, btn('중지', () => act.stop(run.id), 'sx-btn-quiet', { 'data-act': 'panel-stop' })) : null,
    st === 'done' ? (run.result.noFile ? line(run.cert ? CERT_NO_FILE_TEXT : NO_FILE_TEXT, true) : h('div', { class: 'sx-actions' }, btn('PDF 열기', () => act.openRunDoc(run), 'sx-btn-primary'), btn('폴더 열기', () => act.openRunDoc(run, true)))) : null,
  );
}

export const BROWSER_STATUSES = ['preparing', 'turn', 'waiting', 'issuing'];
const parseUrl = (raw) => {
  const url = raw.replace(/^[a-z]+:\/\//i, '');
  const i = url.indexOf('/');
  const host = i < 0 ? url : url.slice(0, i);
  const rest = i < 0 ? '' : url.slice(i);
  return { secure: !!host && !/^(127\.0\.0\.1|localhost)(:|$)/.test(host), host, rest: rest === '/' ? '' : rest };
};
export function browserTabTitle(url) {
  const { host } = parseUrl(url ?? '');
  if (/(^|\.)hometax\.go\.kr$/.test(host)) return '국세청 홈택스';
  if (/^(127\.0\.0\.1|localhost)(:|$)/.test(host)) return '홈택스(시험 페이지)';
  return host || '홈택스';
}
export function browserUrlParts(url) {
  const u = parseUrl(url ?? '');
  return [u.host && u.secure ? icon('lock') : null, h('span', { class: 'bp-host' }, browserTabTitle(url))];
}
export function browserPane(run, url, big, act) {
  if (!BROWSER_STATUSES.includes(run.status)) return null;
  return h(
    'section',
    { class: 'bp', 'data-browser-pane': run.id, 'aria-label': '앱 안 브라우저' },
    act.browserDrag ? h('div', { class: 'bp-resize', role: 'separator', 'aria-orientation': 'vertical', 'aria-label': '브라우저 폭 조절', title: '끌어서 폭 조절', onpointerdown: act.browserDrag }) : null,
    h(
      'div',
      { class: 'bp-bar' },
      h('div', { class: 'bp-url', id: 'browser-addr', role: 'status', 'aria-label': '지금 열린 사이트', title: url || '' }, ...browserUrlParts(url)),
      h('span', { class: 'bp-state', 'data-bp-state': 'loading', title: '이 화면을 직접 눌러 조작할 수 있어요. 인증서 비밀번호는 앱의 비밀번호 창에서 받아요.' }, '여는 중'),
      h('button', { type: 'button', class: 'bp-icon', 'data-act': 'browser-size', 'aria-pressed': String(big), title: big ? '브라우저 작게' : '브라우저 크게', 'aria-label': big ? '브라우저 작게' : '브라우저 크게', onclick: () => act.browserSize(!big) }, icon(big ? 'shrink' : 'expand')),
    ),
    h('div', { class: 'run-screen', 'data-run-screen': run.id }, h('p', { class: 'sx-meta bp-wait' }, h('i', { class: 'bp-wait-dot', 'aria-hidden': 'true' }), '홈택스 여는 중')),
  );
}

export function runDock(run, detail, open, onToggle) {
  const now = nowStep(run);
  const text = run.turn?.text ?? (verifying(run) ? verifyLine(run.verifyAttempt) : stepLine(now));
  detail.hidden = !open;
  const more = h('button', { type: 'button', class: 'sx-btn sx-btn-quiet bp-more', 'aria-expanded': String(open), 'data-act': 'dock-more' }, open ? '접기' : '자세히');
  more.onclick = () => {
    const o = detail.hidden;
    detail.hidden = !o;
    more.textContent = o ? '접기' : '자세히';
    more.setAttribute('aria-expanded', String(o));
    onToggle(o);
  };
  return h(
    'div',
    { class: `bp-dock${open ? ' is-open' : ''}`, 'data-bp-dock': run.id },
    h('div', { class: 'bp-dock-hd' }, h('div', { class: 'sx-card-title' }, runTitle(run)), text ? h('span', { class: 'bp-dock-now' }, text) : null, chip(shownStatus(run)), more),
    detail,
  );
}

function checkListGuide(run, act) {
  const c = (v) => () => act.copy(v);
  return h(
    'div',
    { class: 'sx-check', 'data-check-list': run.id },
    h('div', { class: 'sx-panel-sec' }, '홈택스에서 직접 확인'),
    note('홈택스 발급목록에서 아래 건을 찾아 주세요. 목록에 있으면 발급된 것이니 다시 발급하지 마세요.', !(run.attest?.note && run.attest.state !== 'sent')),
    kv(
      run.cert
        ? [
            ['발급일', run.writeDate, { copy: c(run.writeDate) }],
            ['서류', run.cert.name, { copy: c(run.cert.name) }],
            ['사용 용도', run.cert.inputs.purpose],
          ]
        : [
            ['작성일자', run.writeDate, { copy: c(run.writeDate) }],
            ['공급받는자', run.counterparty.name, { copy: c(run.counterparty.name) }],
            ['사업자번호', fmtBiz(run.counterparty.bizNo), { mono: true, copy: c(fmtBiz(run.counterparty.bizNo)) }],
            ['합계', won(run.total), { copy: c(String(run.total)) }],
          ],
    ),
    h('div', { class: 'sx-meta' }, '목록에 없다는 확인은 대화 아래에 뜨는 황토색 확인 카드로만 받아요. 확인한 뒤 다시 발급하려면 새로 승인해야 해요.'),
    run.attest?.note ? note(run.attest.note, run.attest.state !== 'sent') : null,
  );
}

export function pastCard(p, act) {
  return h(
    'section',
    { class: 'sx-card' },
    h('div', { class: 'sx-card-hd' }, h('div', { class: 'sx-card-title' }, `${p.title} · ${p.who}`), chip('done')),
    h('p', { class: 'sx-run-sum' }, h('b', {}, won(p.total))),
    h('div', { class: 'sx-run-foot' }, h('p', { class: 'sx-card-now' }, h('span', { class: 'sx-id' }, p.approvalNo), h('button', { type: 'button', class: 'sx-copy', onclick: () => act.copy(p.approvalNo) }, '복사')), h('p', { class: 'sx-run-info' }, `${p.mail}로 보낸 것도 확인했어요`)),
  );
}

export function summaryCard(s) {
  return h('section', { class: 'sx-card' }, h('div', { class: 'sx-card-hd' }, h('div', { class: 'sx-card-title' }, '등록 내용'), h('span', { class: 'sx-meta' }, '온보딩 요약')), kv(s.rows, true));
}

const EXPIRY_TAG = { document: '문서', rule: '추정', user: '확인함' };
export const expiryTag = (doc) => (doc.vault.needsUser ? '추정' : (EXPIRY_TAG[doc.vault.expirySource] ?? ''));

const docKind = (doc) => (doc.kind === doc.source ? doc.kind : `${doc.kind} · ${doc.source}`);

function docCells(doc, today) {
  const d = dday(doc.expiresOn, today);
  const v = doc.vault;
  const inferred = v && doc.expiresOn && (v.expirySource === 'rule' || v.needsUser);
  return h(
    'div',
    { class: 'sx-cells' },
    h('div', {}, h('span', { class: 'label sx-meta' }, '발급일'), h('span', { class: 'value' }, doc.issuedOn ? h('span', { class: 'doc-date' }, doc.issuedOn) : '—')),
    h('div', {}, h('span', { class: 'label sx-meta' }, '용도'), h('span', { class: `value${doc.purpose ? '' : ' is-none'}` }, doc.purpose || '—')),
    h(
      'div',
      { class: inferred ? 'is-inferred' : v?.expirySource === 'user' ? 'is-verified' : null },
      h('span', { class: 'label sx-meta' }, '유효'),
      h('span', { class: `value sx-val${d !== null && d <= 7 ? ' is-attention' : ''}${d === null ? ' is-none' : ''}` }, ddayText(d)),
      doc.expiresOn ? h('span', { class: 'sx-tag' }, h('span', { class: 'doc-date' }, doc.expiresOn), v ? ` · ${expiryTag(doc)}` : '') : null,
    ),
  );
}

export function docCard(doc, today) {
  return h(
    'section',
    { class: 'sx-card sx-doc', 'data-doc': doc.id },
    h('div', { class: 'sx-doc-kind' }, docKind(doc)),
    h('div', { class: 'sx-doc-name' }, doc.docName),
    docCells(doc, today),
  );
}

export function docPanel(doc, today, act, review) {
  return h(
    'div',
    { class: 'panel-in', 'data-panel-doc': doc.id },
    h('div', { class: 'doc-kind-row' }, h('span', { class: 'sx-doc-kind' }, docKind(doc)), panelX(act)),
    h('div', { class: 'doc-head' }, h('div', { class: 'sx-doc-name' }, doc.docName)),
    docCells(doc, today),
    review ?? [
      kv([
        ['표시 이름', doc.name],
        ['프로필', doc.profile === 'business' ? '사업자' : '개인'],
        ['보관', doc.noFile ? '홈택스 발급목록' : '이 PC 문서함'],
      ]),
      doc.noFile ? h('p', { class: 'sx-body-sm is-muted', 'data-doc-nofile': '' }, NO_FILE_TEXT) : null,
      h('div', { class: 'sx-actions' }, doc.noFile ? null : btn('열기', () => act.openDoc(doc.id), 'sx-btn-primary', { 'data-act': 'doc-open' }), doc.source === '앱이 발급' && !doc.noFile ? btn('다시 발급', () => act.reissue(doc)) : null),
      h('div', { class: 'sx-source' }, `${doc.source}${doc.issuedOn ? ` · ${doc.issuedOn}` : ''} · 파일명에는 거래처·승인번호를 넣지 않아요`),
    ],
  );
}

export function securityBox(st, ops, onOk) {
  const box = h('div', { class: 'sx-note is-attention onb-security', role: 'alert', 'data-security': st.state });
  const draw = (s) => {
    box.dataset.security = s.state;
    box.replaceChildren();
    if (s.state !== 'missing' && s.state !== 'stopped') {
      box.remove();
      onOk?.(s);
      return;
    }
    const missing = s.state === 'missing';
    const run = (fn) => async () => {
      try {
        const r = await fn();
        if (r && r.state) draw(r);
      } catch {
        /* 버튼만 다시 누르게 둔다 */
      }
    };
    const main = missing && s.installUrl ? btn('설치 파일 받기', run(async () => (await ops.install(), null)), 'sx-btn-primary', { 'data-act': 'security-install' }) : !missing && s.canStart ? btn('켜기', run(ops.start), 'sx-btn-primary', { 'data-act': 'security-start' }) : null;
    box.append(
      icon('warn'),
      h(
        'div',
        { class: 'sx-note-body' },
        h('b', { class: 'sx-note-title' }, missing ? `홈택스 인증서 프로그램(${s.name})이 없어요` : `홈택스 인증서 프로그램(${s.name})이 꺼져 있어요`),
        h('p', {}, missing ? '홈택스 로그인·서명에 필요해요. 홈택스 공식 설치 파일을 받아 설치한 뒤 [다시 확인]을 눌러 주세요.' : '이 프로그램을 켜야 홈택스가 이 PC의 인증서를 읽어요.'),
        h('div', { class: 'sx-actions' }, main, btn('다시 확인', run(ops.check), main ? 'sx-btn-quiet' : 'sx-btn-primary', { 'data-act': 'security-check' })),
      ),
    );
  };
  draw(st);
  return box;
}
