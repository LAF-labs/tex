import { g24Card, g24Panel } from './shell-g24.js';
import { onboardingView, showOnbError } from './shell-onboarding.js';
import { accountCard, accountErrText, loginScreen } from './shell-account.js';
import { pairErrText, pairInModal, pairLeftText, pairModal, pairSection, pairTtlText } from './shell-pair.js';
import { bizEditStart, bizProfileCard } from './shell-biz.js';
import { createBankAuto } from './shell-bank-auto.js';
import { createBilling } from './shell-billing.js';
import { createDevices } from './shell-devices.js';
import { createBankScreen } from './shell-bank.js';
import { createPackScreen } from './shell-pack.js';
import { identityIn } from './password-rules.js';
import { bizDigits, bizNoInput, checkFields, dateInput, emailInput, field, fieldError, keys, LIMITS, secretInput, selectInput, textInput } from './fields.js';
import { agoText, batchCard, btn, CHIP, emptyState, noteGroup, CHROME_GUIDE_TEXT, securityBox, NO_FILE_TEXT, chip, museDayStamp, museStamp, dday, docCard, docPanel, expiryTag, fmtBiz, h, icon, kv, note, num, pastCard, replyOptions, runPanel, runSteps, runTitle, steps, browserPane, runDock, browserTabTitle, browserUrlParts, summaryCard, taskCard, modelRow, serverRow, modelCell, whereRows } from './shell-views.js';

const call = (m, p) => window.sax.call(m, p);
const localDate = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const $ = (s) => document.querySelector(s);

const state = {
  screen: null,
  browser: { shown: false, available: false, embedded: false, width: 0 },
  dockOpen: false,
  draftMore: new Set(),
  stepsOpen: new Set(),
  boot: null,
  today: new Date(),
  view: 'chat',
  profile: 'business',
  sending: false,
  runs: new Map(),
  g24: new Map(),
  docs: [],
  cps: [],
  load: { cps: null, docs: null },
  panel: null,
  menu: false,
  editing: null,
  editingFields: null,
  editingCp: null,
  vat: null,
  fill: [],
  composing: false,
  agentAsk: false,
  lastMe: null,
  waitEl: null,
  barActive: false,
  board: null,
  boardExpanded: new Set(),
  onb: null,
  docFilter: 'all',
  docImport: null,
  docLocked: new Set(),
  docBusy: false,
  docDraft: null,
  docUpdating: false,
  docsRev: 0,
  setTab: 'biz',
  deletion: null,
  account: null,
  login: null,
  pair: null,
  pairBusy: false,
  pairCode: '',
};

let toastTimer;
function toast(text) {
  const t = $('#toast');
  t.textContent = text;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), 2400);
}
const errText = (e) => String(e?.message || e).replace(/^Error invoking remote method 'sax': (Error: )?/, '');
const COMMON_ERR = {
  gesture_required: '버튼을 직접 눌러 주세요.',
  account_required: '먼저 로그인해 주세요.',
  busy: '처리 중이에요. 잠시 뒤에 다시 해 주세요.',
  throttled: '잠시 뒤 다시 눌러 주세요.',
  not_found: '찾지 못했어요. 화면을 다시 열어 주세요.',
  run_active: '발급이 진행 중이라 지금은 할 수 없어요. 끝난 뒤에 해 주세요.',
};
const GENERIC_ERR = '처리하지 못했어요. 잠시 뒤 다시 해 주세요.';
const human = (e, table = {}) => {
  const c = errText(e);
  return table[c] || COMMON_ERR[c] || GENERIC_ERR;
};

const DOC_ERR = {
  profile_required: '내 사업장을 먼저 등록해 주세요', not_pdf: 'PDF 파일이 아니에요', input_size: '파일이 비었거나 15MB를 넘어요', read_failed: '파일을 읽지 못했어요',
  invalid_pdf: 'PDF를 열 수 없어요(손상)', timeout: '읽는 데 너무 오래 걸려 멈췄어요', memory_limit: '파일이 너무 커서 멈췄어요', session_failed: 'PDF를 여는 데 실패했어요. 다시 해 주세요',
  pick_expired: '파일을 다시 골라 주세요', password_too_long: '암호가 너무 길어요', schema: '읽은 결과를 확인하지 못했어요',
  issued_in_future: '발급일이 오늘보다 뒤예요', expires_before_issued: '만료일이 발급일보다 앞이에요', expires_after_legal_max: '납세증명서 유효기간은 발급일부터 30일을 넘을 수 없어요',
  invalid_issued_on: '발급일 형식이 아니에요', invalid_expires_on: '만료일 형식이 아니에요', not_found: '보관함에 없는 서류예요',
  invalid_doc_type: '고를 수 없는 종류예요', bad_request: '요청을 처리하지 못했어요', file_missing: '보관함 파일이 없어요(다시 가져와 주세요)', open_failed: 'PDF를 열지 못했어요',
  stale: '서류가 그사이 바뀌었어요. 지금 값을 다시 보고 확인해 주세요', seen_required: '요청을 처리하지 못했어요', busy: '다른 파일을 읽는 중이에요', renderer_gone: '읽던 창이 멈췄어요. 다시 해 주세요',
  closed: '보관함이 닫혔어요', failed: '처리하지 못했어요. 다시 해 주세요',
  worker_failed: '읽는 창을 준비하지 못했어요. 다시 해 주세요', parse_failed: 'PDF를 읽지 못했어요', render_failed: 'PDF 쪽을 그리지 못했어요',
  ocr_failed: '그림 글자를 읽지 못했어요', bad_extract: '읽은 결과를 확인하지 못했어요',
  pick_password_tries: '암호가 5번 틀려 이 파일은 닫았어요. 파일을 다시 골라 주세요.',
  gesture_required: '잠시 뒤 다시 눌러 주세요.', throttled: '잠시 뒤 다시 눌러 주세요.',
};
const docErr = (e) => human(e, DOC_ERR);
const DOC_ERR_FIELD = { issued_in_future: 'issuedOn', invalid_issued_on: 'issuedOn', expires_before_issued: 'expiresOn', expires_after_legal_max: 'expiresOn', invalid_expires_on: 'expiresOn', invalid_doc_type: 'docType' };
const DOC_REASON = {
  doc_type_unknown: '서류 종류를 알아보지 못했어요',
  issued_on_not_found: '발급일을 찾지 못했어요', issued_on_ambiguous: '발급일 후보가 여러 개예요', issued_on_unparseable: '발급일을 읽지 못했어요',
  issued_on_out_of_range: '발급일이 오늘보다 뒤이거나 너무 일러요', issued_on_uncertain: '발급일 라벨을 못 찾아 위치로 짐작했어요', issued_on_missing: '발급일이 비어 있어요',
  valid_until_not_found: '유효기간을 찾지 못해 30일로 추정했어요', valid_until_ambiguous: '유효기간 후보가 여러 개예요', valid_until_unparseable: '유효기간을 읽지 못했어요',
  valid_until_out_of_range: '적힌 유효기간이 발급일부터 30일 밖이에요', expires_on_missing: '납세증명서 만료일이 비어 있어요', expiry_recomputed: '만료일을 다시 계산했어요',
  read_by_ocr: '글자 층이 없어 그림에서 읽었어요', scanned_text_layer: '스캔 파일에 덧입힌 글자로 읽었어요',
  subject_mismatch: '내 사업장과 사업자번호가 달라요', subject_unverified: '사업자번호를 읽지 못했어요',
};

let slotSent = '';
let slotDrag = false;
function slotTick() {
  requestAnimationFrame(slotTick);
  if (!state.browser.embedded) return;
  const box = state.browser.available && !slotDrag && !document.querySelector('.modal') ? document.querySelector('.bp .run-screen') : null;
  const r = box?.getBoundingClientRect();
  const p = r && r.width > 0 && r.height > 0 ? { x: Math.round(r.left), y: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height) } : { none: true };
  const key = JSON.stringify(p);
  if (key === slotSent) return;
  slotSent = key;
  void call('browser.slot', p).catch(() => {});
}
requestAnimationFrame(slotTick);

function draftError(id, msg, field = null, vals = null) {
  state.draftErr = { id, msg, field, vals };
  const r = state.runs.get(id);
  if (r) renderRun(r);
}

const act = {
  toast,
  browserSize: (big) => void call('browser.toggle', { show: big }).catch(() => {}),
  browserDrag: (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const el = e.currentTarget;
    el.setPointerCapture(e.pointerId);
    slotDrag = true;
    document.body.classList.add('bp-dragging');
    let want = null;
    let queued = false;
    const flush = () => {
      queued = false;
      if (want !== null) void call('browser.resize', { width: want }).catch(() => {});
    };
    const move = (ev) => {
      want = Math.round(window.innerWidth - ev.clientX);
      if (!queued) {
        queued = true;
        requestAnimationFrame(flush);
      }
    };
    const up = () => {
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointercancel', up);
      slotDrag = false;
      document.body.classList.remove('bp-dragging');
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
  },
  openDoc: (id) => call('docs.open', { id }).catch((e) => toast(docErr(e))),
  revealDoc: (id) => call('docs.reveal', { id }).catch((e) => toast(docErr(e))),
  openRunDoc: (run, reveal = false) => runDoc(run).then((d) => (d ? (reveal ? act.revealDoc(d.id) : act.openDoc(d.id)) : toast(NO_FILE_TEXT))),
  supplier: () => state.boot.profiles.business.name,
  open: (id) => openPanel({ kind: 'run', id }),
  openG24: (id) => openPanel({ kind: 'g24', id }),
  closePanel: () => openPanel(null),
  importDoc: (o) => importDoc(o),
  copy: async (text) => {
    await call('clipboard.copy', { text });
    toast('복사했어요');
  },
  prepare: async (id) => {
    try {
      putRun(await call('run.prepare', { id }));
      openPanel({ kind: 'run', id });
    } catch (e) {
      const c = errText(e);
      toast(c === 'busy' ? '진행 중인 작업이 끝난 뒤에 시작할 수 있어요' : c === 'item_required' ? '품목이 비어 있어요. 카드의 품목을 눌러 넣고 다시 준비해 주세요.' : c === 'amount_zero' ? '합계가 0원이에요. 카드의 금액을 눌러 고치고 다시 준비해 주세요.' : c === 'issue_date.not_supported' ? '작성일자를 오늘이 아닌 날로 정한 카드는 아직 준비할 수 없어요. 대화로 작성일자를 오늘로 바꿔 주세요.' : c === 'issue_date.out_of_range' ? '이 작성일자로는 발급할 수 없어요. 대화로 작성일자를 다시 정해 주세요.' : c === 'bad_email' ? '받는 이메일 모양이 맞지 않아요. 카드의 받는 이메일을 눌러 고치고 다시 준비해 주세요.' : c === 'chrome.not_installed' ? 'Chrome을 찾지 못했어요. Chrome을 설치한 뒤 다시 눌러 주세요.' : prepareRefusal(c) ?? human(e));
    }
  },
  vat: async (id, vat) => {
    try {
      putRun(await call('draft.update', { id, vat }));
    } catch (e) {
      toast(human(e));
    }
  },
  editAmount: (id) => {
    state.draftErr = null;
    state.editing = id;
    state.editingFields = null;
    state.editingCp = null;
    for (const r of state.runs.values()) renderRun(r);
  },
  editFields: (id, focus = 'item') => {
    state.draftErr = null;
    state.editingFields = id;
    state.editingFocus = focus;
    state.editing = null;
    state.editingCp = null;
    for (const r of state.runs.values()) renderRun(r);
  },
  editCp: (id) => {
    state.draftErr = null;
    state.editingCp = id;
    state.editing = null;
    state.editingFields = null;
    for (const r of state.runs.values()) renderRun(r);
  },
  saveCp: async (id, counterpartyId) => {
    try {
      putRun(await call('draft.update', { id, counterpartyId: String(counterpartyId) }));
      state.editingCp = null;
      state.draftErr = null;
      renderRun(state.runs.get(id));
    } catch (e) {
      draftError(id, errText(e) === 'no_counterparty' ? '거래처 목록에 없는 이름이에요. 거래처 화면에서 확인해 주세요' : '바꾸지 못했어요. 다시 해 주세요', 'counterparty');
    }
  },
  saveFields: async (id, item, email) => {
    try {
      putRun(await call('draft.update', { id, item: String(item), email: String(email) }));
      state.editingFields = null;
      state.draftErr = null;
      renderRun(state.runs.get(id));
    } catch (e) {
      const c = errText(e);
      draftError(id, c === 'item_required' ? '품목을 넣어 주세요. 예: 컨설팅 용역' : c === 'bad_email' ? '이메일 주소 모양이 맞지 않아요' : '바꾸지 못했어요. 다시 해 주세요', c === 'item_required' ? 'item' : c === 'bad_email' ? 'email' : null, { item: String(item), email: String(email) });
    }
  },
  saveAmount: async (id, text) => {
    try {
      putRun(await call('draft.update', { id, amountText: String(text) }));
      state.editing = null;
      state.draftErr = null;
      renderRun(state.runs.get(id));
    } catch (e) {
      draftError(id, human(e, { bad_amount: '금액을 다시 확인해 주세요. 예: 330만원, 3,300,000' }), 'amount', { amount: String(text) });
    }
  },
  resume: (id) => handoffCall('run.resume', id),
  retryCert: (id) => handoffCall('run.retryCert', id),
  simpleDone: (id) => handoffCall('run.simpleDone', id),
  manualDone: (id) => handoffCall('run.manualDone', id),
  showBrowser: async (id) => {
    try {
      await call('run.showBrowser', { id });
    } catch (e) {
      toast(human(e, { no_browser: '홈택스 창을 찾지 못했어요. 작업 표시줄이나 Dock의 Chrome을 눌러 주세요.', not_running: '이 작업은 지금 진행 중이 아니에요.' }));
    }
  },
  stop: async (id) => {
    try {
      putRun(await call('run.stop', { id }));
    } catch (e) {
      toast(human(e, { already_issuing: '이미 발급을 시작해서 멈출 수 없어요' }));
    }
  },
  restart: async (id) => {
    try {
      const d = await call('run.redraft', { id });
      putRun(d);
      await act.prepare(d.id);
    } catch {
      toast('다시 시작하지 못했어요. 같은 요청을 대화에 다시 말해 주세요');
    }
  },
  redraft: async (id) => {
    if (state.runs.get(id)?.cert) return act.restart(id);
    try {
      const d = await call('run.redraft', { id });
      putRun(d);
    } catch (e) {
      toast(errText(e) === 'no_counterparty' ? '거래처 목록에 없는 이름이에요. 거래처 화면에서 확인해 주세요' : '다시 준비하지 못했어요. 같은 요청을 대화에 다시 말해 주세요');
    }
  },
  again: (run) => {
    if (run.cert) return act.restart(run.id);
    state.vat = run.vat;
    fillComposer(`${run.counterparty.name}에 ${num(run.amount)}원 세금계산서 끊고 메일 보내 줘`);
  },
  reissue: (doc) => {
    go('chat');
    fillComposer(doc.kind === '세금계산서' ? `${doc.name.split(' · ')[1] || ''}에 세금계산서 ` : `${doc.docName} 떼 줘`);
  },
  go: (v) => go(v),
  g24Saved: async (id) => {
    const g = state.g24.get(id);
    if (g.stage !== 'guide') return;
    const candidates = await call('g24.candidates', { doc: g.doc, startedAt: g.startedMs });
    if (g.stage !== 'guide') return;
    g.candidates = candidates;
    g.stage = 'pick';
    renderG24(g);
  },
  g24Pick: (id, cid) => {
    const g = state.g24.get(id);
    g.picked = cid;
    renderG24(g);
  },
  g24Save: async (id) => {
    const g = state.g24.get(id);
    if (g.saving || g.stage !== 'pick') return;
    g.saving = true;
    let doc;
    try {
      doc = await call('g24.save', { id: g.picked, doc: g.doc });
    } catch (e) {
      g.saving = false;
      return toast(human(e));
    }
    if (g.stage !== 'pick') return;
    g.stage = 'saved';
    renderG24(g);
    addDoc(doc);
    appendThread(docCard(doc, state.today, act, true));
  },
  g24Stop: (id) => {
    const g = state.g24.get(id);
    g.stage = 'stopped';
    renderG24(g);
    if (state.panel?.id === id) openPanel(null);
  },
};

const RAIL_SHORT = { chat: '대화', docs: '문서함', cps: '거래처', bank: '받을 돈', biz: '사업장', bundle: '꾸러미', payroll: '급여', activity: '기록', settings: '설정' };

const RAIL = [
  ['chat', '대화', 'chat'],
  ['docs', '문서함', 'docs'],
  ['cps', '거래처', 'cps'],
  ['bank', '받을 돈', 'money', () => state.profile === 'business'],
  ['payroll', '급여대장', 'payroll', () => !!state.boot?.payrollEnabled],
];
const PARENT = { bundle: 'docs', activity: 'docs' };
const PARENT_LABEL = { docs: '문서함', settings: '설정' };

function renderTitlebar() {
  const p = state.boot.profiles;
  const cur = p[state.profile];
  const item = (kind, label) =>
    h(
      'button',
      { type: 'button', role: 'menuitemradio', 'aria-checked': String(state.profile === kind), class: 'menu-item', 'data-profile': kind, onclick: () => setProfile(kind) },
      h('span', { class: 'menu-check' }, state.profile === kind ? icon('check') : null),
      h('span', {}, label),
    );
  $('#titlebar').replaceChildren(
    ...[
    h(
      'div',
      { class: 'tb-profile' },
      h('button', { type: 'button', class: 'tb-co', 'aria-haspopup': 'menu', 'aria-expanded': String(state.menu), onclick: () => toggleMenu() }, cur.name, icon('chevron')),
      state.menu ? h('div', { class: 'menu', role: 'menu', 'aria-label': '프로필' }, h('div', { class: 'menu-label' }, '새 요청에 쓸 프로필'), item('business', `사업자 · ${p.business.name}`), p.personal && !p.personal.placeholder ? item('personal', `개인 · ${p.personal.name}`) : null) : null,
    ),
    state.browser.available ? h('button', { type: 'button', class: 'tb-browser', 'data-act': 'browser-toggle', 'aria-pressed': String(state.browser.shown), title: state.browser.shown ? '브라우저 패널 작게' : '브라우저 패널 크게', onclick: () => void call('browser.toggle', { show: !state.browser.shown }).catch(() => {}) }, '홈택스 화면') : null,
    ...(state.boot?.sample === false ? [] : [h('span', { class: 'mock-badge' }, '견본 데이터 · PoC 데모')]),
    ...(state.boot?.build ?? []).map((t) => h('span', { class: 'mock-badge', 'data-build-badge': '' }, t)),
    ].filter(Boolean),
  );
}

function toggleMenu(open = !state.menu) {
  if (state.menu === open) return;
  state.menu = open;
  renderTitlebar();
  if (open) $('#titlebar .menu-item[aria-checked=true]')?.focus();
}

async function setProfile(kind) {
  toggleMenu(false);
  if (kind === state.profile) return;
  await call('profile.set', { kind });
  state.profile = kind;
  renderTitlebar();
  appendThread(h('div', { class: 'sx-app' }, `새 요청은 ${kind === 'business' ? '사업자' : '개인'} 프로필로 할게요.`));
}

function renderRail() {
  const soon = state.docs.filter((d) => {
    const n = dday(d.expiresOn, state.today);
    return n !== null && n <= 7;
  }).length;
  const item = ([v, label, ic]) =>
    h(
      'button',
      { type: 'button', class: state.view === v || PARENT[state.view] === v ? 'is-on' : null, title: label, 'aria-label': v === 'docs' && soon ? `${label}, 만료 임박 ${soon}개` : label, 'aria-current': state.view === v ? 'page' : null, 'data-view': v, onclick: () => go(v) },
      h('span', { class: 'rail-ic' }, icon(ic), v === 'docs' && soon ? h('b', { 'aria-hidden': 'true' }) : null),
      h('span', { class: 'rail-label', 'aria-hidden': 'true' }, RAIL_SHORT[v] ?? label),
    );
  $('#rail').replaceChildren(h('i'), ...RAIL.filter((r) => !r[3] || r[3]()).map(item), h('i'), item(['settings', '설정', 'settings']));
}

const chat = {
  root: null,
  thread: null,
  scroll: null,
  quick: null,
  input: null,
  today: null,
};

function buildChat() {
  chat.thread = h('div', { class: 'sx-thread' });
  chat.scroll = h('div', { class: 'thread-scroll' }, h('div', { class: 'col' }, chat.thread));
  chat.newReply = h('button', { type: 'button', class: 'sx-new-reply', 'data-act': 'new-reply', hidden: '', onclick: () => scrollToEnd(true) }, icon('chevron'), '새 답');
  chat.scroll.addEventListener('scroll', () => {
    if (nearEnd()) chat.newReply.hidden = true;
  }, { passive: true });
  chat.today = h('section', { class: 'col sx-board', 'aria-label': '이번 달 판', 'data-board': '' });
  chat.handoff = h('div', { class: 'col sx-handoff', role: 'status', 'data-handoff-band': '', hidden: '' });
  chat.quick = h('div', { class: 'sx-quick', id: 'quick' });
  chat.input = h('textarea', { rows: '1', placeholder: '세금계산서 발급이나 지난 발급, 매출을 말해 주세요', 'aria-label': '입력창', id: 'composer' });
  chat.input.addEventListener('input', () => {
    state.composing = true;
    autoGrow();
    renderQuick();
  });
  chat.input.addEventListener('pointerdown', () => ((state.composing = true), renderQuick()));
  chat.input.addEventListener('blur', () => {
    if (chat.input.value.trim()) return;
    state.composing = false;
    renderQuick();
  });
  chat.input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.altKey && !e.isComposing && e.keyCode !== 229) {
      e.preventDefault();
      send();
    }
  });
  const sendBtn = h('button', { type: 'button', class: 'sx-send', 'aria-label': '보내기', onclick: send }, icon('send'));
  const attach = h('button', { type: 'button', class: 'sx-attach', 'aria-label': 'PDF 가져오기', title: 'PDF 가져오기', onclick: () => importDoc({ pick: true }) }, icon('plus'));
  const inputBox = h('div', { class: 'sx-input', onpointerdown: (e) => { if (!e.target.closest('button, textarea')) { e.preventDefault(); chat.input.focus(); } } }, attach, chat.input, sendBtn);
  chat.root = h(
    'section',
    { class: 'chat', 'data-view': 'chat' },
    chat.handoff,
    chat.today,
    h('div', { class: 'thread-wrap' }, chat.scroll, chat.newReply),
    h('div', { class: 'quick-zone col' }, chat.quick),
    h('div', { class: 'bar-slot', 'aria-hidden': 'true' }),
    h('div', { class: 'composer-zone' }, h('div', { class: 'col sx-composer' }, inputBox)),
  );
  if (state.onb) {
    appendThread(h('div', { 'data-onboarding': '' }), false);
    renderOnboarding();
  } else for (const item of state.boot.timeline) appendThread(timelineItem(item), false);
  renderQuick();
  renderToday();
}

const ONB_ERR = {
  bad_biz_no: '사업자번호가 맞지 않아요. 10자리를 다시 확인해 주세요.',
  biz_inactive: '이 사업자는 지금 등록할 수 없는 상태예요.',
  bad_cert: '인증서를 다시 골라 주세요.',
  bad_email: '이메일 주소 모양이 맞지 않아요. 다시 확인해 주세요.',
  name_required: '상호를 넣어 주세요. [고칠게요]에서 채울 수 있어요.',
  no_tasks: '지금 되는 일 중 하나 이상 골라 주세요.',
  stale_step: '이미 답한 질문이에요.',
  gesture_required: '버튼을 직접 눌러 주세요.',
  account_required: '먼저 로그인해 주세요.',
};
function applyOnb(r) {
  if (r.onboarding !== undefined) state.onb = r.onboarding;
  if (r.profiles) state.boot.profiles = r.profiles;
  renderOnboarding();
  renderTitlebar();
  renderToday();
  if (r.fill) fillComposer(r.fill);
  if (loginGate()) renderModal();
}
const onbAct = {
  reply: async (step, choice, extra = {}) => {
    try {
      applyOnb(await call('onboarding.reply', { step, choice, ...extra }));
      return true;
    } catch (e) {
      showOnbError(step, ONB_ERR[errText(e)] ?? '다시 해 주세요', errText(e));
      renderOnboarding();
      return false;
    }
  },
  go: (v) => go(v),
  toast,
  legal: (doc) => openLegal(doc),
  rerender: () => renderOnboarding(),
  get security() {
    return securityOps;
  },
};
async function openLegal(doc) {
  try {
    await call('legal.open', { doc });
  } catch {
    toast('열지 못했어요. tax.laf-co.com에서 볼 수 있어요.');
  }
}
function renderOnboarding() {
  const old = chat.thread?.querySelector('[data-onboarding]');
  if (!old || !state.onb) return;
  old.replaceWith(onboardingView(state.onb, onbAct));
  const locked = !state.onb.consents.terms;
  chat.input.disabled = locked;
  chat.input.placeholder = locked ? '약관에 동의하면 입력할 수 있어요' : '세금계산서 발급이나 지난 발급, 매출을 말해 주세요';
  renderQuick();
  scrollToEnd();
}
const onbActive = () => !!state.onb && state.onb.step !== 'done';

function chromeGuide() {
  if (state.view !== 'chat') go('chat');
  chat.thread.querySelector('[data-chrome-guide]')?.remove();
  const box = h('div', { class: 'sx-app', 'data-chrome-guide': '' }, h('p', {}, CHROME_GUIDE_TEXT));
  const check = async () => {
    try {
      const r = await call('chrome.check');
      if (r.ready) {
        box.remove();
        toast('Chrome을 찾았어요. 이제 발급을 요청할 수 있어요.');
      } else toast('아직 Chrome을 찾지 못했어요. 설치를 마친 뒤 다시 눌러 주세요.');
    } catch {
      toast('다시 해 주세요');
    }
  };
  box.append(h('div', { class: 'sx-actions' }, btn('다시 확인', check, 'sx-btn-primary', { 'data-act': 'chrome-check' })));
  appendThread(box);
}

const securityOps = {
  check: () => call('security.check'),
  install: () => call('security.install'),
  start: () => call('security.start'),
};
async function securityGuide() {
  if (state.view !== 'chat') go('chat');
  chat.thread.querySelector('[data-security-guide]')?.remove();
  let st;
  try {
    st = await call('security.check');
  } catch {
    return toast('다시 해 주세요');
  }
  if (st.state !== 'missing' && st.state !== 'stopped') return toast('보안 프로그램이 준비돼 있어요');
  const wrap = h('div', { class: 'sx-app', 'data-security-guide': '' });
  wrap.append(securityBox(st, securityOps, () => (wrap.remove(), toast('보안 프로그램이 준비됐어요. 이제 발급을 요청할 수 있어요.'))));
  appendThread(wrap);
}

const SCREEN_TAB = { issue_auth: 'auth', business: 'biz', bank: 'bank', devices: 'devices', billing: 'billing' };
const SCREEN_VIEW = { counterparties: 'cps', docs: 'docs', receivables: 'bank' };
function openScreen(screen) {
  const tab = Object.hasOwn(SCREEN_TAB, screen) ? SCREEN_TAB[screen] : null;
  const view = Object.hasOwn(SCREEN_VIEW, screen) ? SCREEN_VIEW[screen] : null;
  if (!tab && !view && screen !== 'chrome' && screen !== 'security_program') return;
  setTimeout(async () => {
    if (screen === 'chrome') return chromeGuide();
    if (screen === 'security_program') return securityGuide();
    if (view) return go(view);
    state.setTab = tab;
    await go('settings');
    setTab(tab);
  }, 700);
}

async function reopenSetup(item) {
  if (item === 'chrome') return chromeGuide();
  if (item === 'security') return securityGuide();
  try {
    const r = await call('onboarding.reopen', { item });
    state.onb = r.onboarding;
    if (r.profiles) state.boot.profiles = r.profiles;
    if (state.view !== 'chat') go('chat');
    chat.thread.querySelector('[data-onboarding]')?.removeAttribute('data-onboarding');
    appendThread(h('div', { 'data-onboarding': '' }));
    renderOnboarding();
    renderTitlebar();
    renderToday();
  } catch (e) {
    const c = errText(e);
    if (c === 'onboarding_unavailable') go('biz');
    else toast(c === 'nothing_to_reopen' ? '이미 등록돼 있어요' : (ONB_ERR[c] ?? '다시 해 주세요'));
  }
}

function timelineItem(it) {
  switch (it.type) {
    case 'day':
      return h('div', { class: 'sx-stamp' }, museDayStamp(it.date, new Date()));
    case 'me':
      return h('div', { class: 'sx-me' }, it.text);
    case 'app':
      return h('div', { class: 'sx-app' }, it.text);
    case 'summary':
      return summaryCard(it);
    case 'past':
      return pastCard(it, act);
  }
  return h('div');
}

function onSecretAsk(ev) {
  const card = () => document.querySelector(`[data-secret-ask="${CSS.escape(ev.reqId)}"]`);
  if (ev.state !== 'open') {
    const c = card();
    if (c && c.querySelector('form')) c.replaceChildren(h('p', { class: 'sx-meta' }, ev.state === 'done' ? `${c.dataset.label || '비밀번호'} ●●●● 입력함` : '입력 요청이 끝났어요'));
    return;
  }
  if (card()) return;
  if (state.view !== 'chat') void go('chat');
  const input = h('input', { type: 'password', class: 'sx-input secret-ask-input', autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false', 'aria-label': ev.label || '비밀번호' });
  const msg = h('p', { class: 'sx-meta secret-ask-msg', role: 'status' });
  const send = h('button', { type: 'submit', class: 'sx-btn sx-btn-primary' }, '넘기기');
  const cancel = h('button', { type: 'button', class: 'sx-btn', 'data-act': 'secret-cancel' }, '취소');
  const form = h('form', { class: 'secret-ask-form', autocomplete: 'off' }, input, send, cancel);
  const box = h(
    'div',
    { class: 'sx-app secret-ask', 'data-secret-ask': ev.reqId, 'data-label': ev.label || '비밀번호' },
    h('p', { class: 'secret-ask-q' }, ev.kind === 'cert_password' ? '공동인증서 비밀번호를 입력해 주세요' : `${ev.label || '비밀번호'}를 입력해 주세요`),
    h('p', { class: 'sx-meta' }, ev.note || ''),
    form,
    msg,
  );
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const value = input.value;
    input.value = '';
    if (!value) return input.focus();
    send.disabled = cancel.disabled = input.disabled = true;
    msg.textContent = '금고에 넘기는 중이에요';
    call('secret.answer', { reqId: ev.reqId, value }).then(
      () => box.replaceChildren(h('p', { class: 'sx-meta' }, `${ev.label || '비밀번호'} ●●●● 입력함`)),
      () => {
        send.disabled = cancel.disabled = input.disabled = false;
        msg.textContent = '금고가 받지 않았어요. 다시 넣어 주세요.';
        input.focus();
      },
    );
  });
  cancel.addEventListener('click', () => {
    input.value = '';
    void call('secret.answer', { reqId: ev.reqId, cancel: true }).catch(() => {});
    box.replaceChildren(h('p', { class: 'sx-meta' }, '입력하지 않았어요'));
  });
  appendThread(box, false);
  requestAnimationFrame(() => {
    box.scrollIntoView({ block: 'start' });
    input.focus({ preventScroll: true });
  });
}

const STAMP_GAP_MS = 30 * 60 * 1000;
const JOIN_MS = 2 * 60 * 1000;
const clock = { at: null, day: null, side: null, el: null };
const msgSide = (el) => (el.classList?.contains('sx-me') ? 'me' : el.classList?.contains('sx-app') && !el.dataset.agentProgress ? 'app' : null);
function stampFor(el, at) {
  const side = msgSide(el);
  if (!side) return;
  const day = new Date(at).toDateString();
  if (clock.at == null || day !== clock.day || at - clock.at > STAMP_GAP_MS) {
    const prev = chat.thread.lastElementChild;
    if (prev?.classList.contains('sx-stamp') && !prev.dataset.stamp && new Date().toDateString() === day) prev.remove();
    chat.thread.append(h('div', { class: 'sx-stamp', 'data-stamp': String(at) }, museStamp(at)));
  } else if (side === clock.side && at - clock.at < JOIN_MS && clock.el?.isConnected && chat.thread.lastElementChild === clock.el) {
    clock.el.classList.add('is-joined-next');
    el.classList.add('is-joined-prev');
  }
  Object.assign(clock, { at, day, side, el });
}

function appendThread(el, scroll = true, mine = false) {
  if (scroll) stampFor(el, Date.now());
  const follow = mine || nearEnd();
  chat.thread.append(el);
  if (!scroll) return;
  if (follow) scrollToEnd();
  else showNewReply();
}
const FOLLOW_PX = 80;
const nearEnd = () => !chat.scroll || chat.scroll.scrollHeight - chat.scroll.scrollTop - chat.scroll.clientHeight <= FOLLOW_PX;
const showNewReply = () => chat.newReply && (chat.newReply.hidden = false);
const scrollToEnd = (smooth = false) =>
  requestAnimationFrame(() => {
    if (chat.newReply) chat.newReply.hidden = true;
    const top = chat.scroll.scrollHeight;
    if (smooth && !matchMedia('(prefers-reduced-motion: reduce)').matches) chat.scroll.scrollTo({ top, behavior: 'smooth' });
    else chat.scroll.scrollTop = top;
  });
const followEnd = (wasNear) => {
  if (wasNear) scrollToEnd();
  else showNewReply();
};

function autoGrow() {
  const el = chat.input;
  el.style.height = 'auto';
  const max = (state.barActive ? 3 : 6) * 24;
  el.style.height = `${Math.min(el.scrollHeight, max)}px`;
}

const BUSY = ['draft', 'preparing', 'turn', 'waiting', 'issuing', 'attention'];
const cardWork = () => [...state.runs.values()].some((r) => BUSY.includes(r.status)) || [...state.g24.values()].some((g) => g.stage === 'guide' || g.stage === 'pick');

function prompts() {
  return state.boot.quick
    .filter((q) => !q.soon)
    .slice(0, 2)
    .map((q) => {
      const t = q.text.trim();
      return /줘$/.test(t) ? t : `${t} 발급해 줘`;
    });
}

function lastAmount(name) {
  const run = [...state.runs.values()].reverse().find((r) => r.status === 'done' && r.counterparty.name === name);
  if (run) return run.amount;
  const past = [...state.boot.timeline].reverse().find((t) => t.type === 'past' && t.who === name);
  return past ? past.supply : null;
}
const won = (n) => (n % 10000 === 0 ? `${n / 10000}만원` : `${num(n)}원`);

function fillChips(chips) {
  return chips.map((c) => {
    const amt = lastAmount(c.label);
    return amt ? { label: `${c.label} ${won(amt)}`, text: `${c.text} ${won(amt)}`, cp: c.label } : { label: c.label, text: c.text, cp: c.label };
  });
}

function renderQuick() {
  if (onbActive()) return chat.quick.replaceChildren();
  const text = chat.input.value;
  if (!text.trim()) {
    state.vat = null;
    if (state.composing || state.agentAsk) {
      chat.quick.replaceChildren();
    } else if (state.fill.length) {
      chat.quick.replaceChildren(...state.fill.map((c) => h('button', { type: 'button', class: 'is-fill', 'data-fill': c.cp, title: '입력창에 채우기', onclick: () => fillComposer(c.text) }, icon('pencil'), c.label)));
    } else if (!cardWork()) {
      chat.quick.replaceChildren(...prompts().map((p) => h('button', { type: 'button', class: 'is-prompt', 'data-prompt': p, onclick: () => sendPrompt(p) }, p, icon('send'))));
    } else {
      chat.quick.replaceChildren();
    }
  } else {
    chat.quick.replaceChildren();
  }
}

function sendPrompt(text) {
  if (state.view !== 'chat') go('chat');
  chat.input.value = text;
  send();
}

function prepareRefusal(c) {
  if (c === 'gesture_required') return '버튼 클릭을 확인하지 못했어요. [홈택스에서 준비]를 한 번 더 눌러 주세요.';
  const m = /^throttled\.(streak|rate):(\d{1,3})$/.exec(c);
  if (m) return m[1] === 'streak' ? `승인 전에 멈춘 실행이 3번 이어져 1분 쉬었다가 시작해요. ${m[2]}초 뒤에 다시 눌러 주세요.` : `[홈택스에서 준비]는 1분에 3번까지 시작해요. ${m[2]}초 뒤에 다시 눌러 주세요.`;
  return c === 'throttled' ? '조금 뒤에 다시 눌러 주세요.' : null;
}

async function runDoc(run) {
  const find = () => state.docs.find((d) => d.runId === run.id);
  if (find()) return find();
  try {
    state.docs = await call('docs.list');
  } catch {
    return null;
  }
  return find() ?? null;
}

async function addCpFromAsk(name) {
  await go('cps');
  openPanel({ kind: 'cp-edit', id: null, name: String(name ?? ''), ask: true });
}

function fillComposer(text) {
  if (state.view !== 'chat') go('chat');
  state.composing = true;
  chat.input.value = text;
  autoGrow();
  renderQuick();
  chat.input.focus();
  chat.input.setSelectionRange(text.length, text.length);
}

async function send() {
  const text = chat.input.value.trim();
  if (!text || state.sending) return;
  const vat = state.vat;
  chat.input.value = '';
  state.vat = null;
  state.fill = [];
  state.composing = false;
  state.agentAsk = false;
  for (const b of chat.thread.querySelectorAll('[data-act="intent-retry"], [data-agent-chip]')) b.disabled = true;
  autoGrow();
  renderQuick();
  const me = h('div', { class: 'sx-me' }, text);
  appendThread(me, true, true);
  state.lastMe = me;
  await ask(text, vat);
}

const REACTION_EMOJI = { thumbs_up: '👍', eyes: '👀', check: '✅', pray: '🙏' };
const REACTION_LABEL = { thumbs_up: '좋아요', eyes: '보고 있어요', check: '확인', pray: '감사해요' };
function reactTo(el, reaction) {
  if (!el?.isConnected || !Object.hasOwn(REACTION_EMOJI, reaction)) return;
  el.querySelector(':scope > .sx-react')?.remove();
  el.classList.add('has-reaction');
  el.dataset.reaction = reaction;
  el.append(h('span', { class: 'sx-react', role: 'img', 'aria-label': REACTION_LABEL[reaction] }, REACTION_EMOJI[reaction]));
}

async function ask(text, vat) {
  let r;
  state.sending = true;
  const waitEl = h('div', { class: 'sx-app sx-typing', role: 'status', 'aria-label': PROGRESS_TEXT.thinking, 'data-agent-progress': 'thinking' }, h('i'), h('i'), h('i'));
  state.waitEl = waitEl;
  const waitTimer = setTimeout(() => waitEl.isConnected || appendThread(waitEl), 180);
  try {
    r = await call('request.send', { text, vat });
  } catch (e) {
    toast(human(e));
    return;
  } finally {
    clearTimeout(waitTimer);
    waitEl.remove();
    state.waitEl = null;
    state.sending = false;
  }
  if (r.kind === 'unavailable') {
    const box = h('div', { class: 'sx-app', 'data-intent-unavailable': '' }, h('p', {}, r.text));
    appendThread(box);
    if (r.retry === false) return;
    const retry = btn(
      '다시 시도',
      () => {
        if (state.sending) return;
        box.remove();
        void ask(text, vat);
      },
      'sx-btn-primary',
      { 'data-act': 'intent-retry' },
    );
    box.append(h('div', { class: 'sx-actions' }, retry));
    return;
  }
  if (r.kind === 'setup') {
    const box = h('div', { class: 'sx-app', 'data-setup-needed': r.missing.map((m) => m.id).join(' ') }, h('p', {}, r.text));
    box.append(h('div', { class: 'sx-actions' }, ...r.missing.map((m, i) => btn(m.label, () => reopenSetup(m.id), i ? '' : 'sx-btn-primary', { 'data-act': `setup-${m.id}` }))));
    appendThread(box);
    return;
  }
  if (r.kind === 'agent') return renderAgent(r);
  if (r.kind === 'reaction') return void reactTo(state.lastMe, r.reaction);
  if (r.kind === 'pack') {
    appendThread(h('div', { class: 'sx-app', 'data-pack-reply': r.pack.month }, h('p', {}, `${r.pack.label} 세무사 꾸러미를 만들었어요.`), packUi.chatCard(r.pack, (m) => (packUi.select(m), go('bundle')))));
    return;
  }
  if (r.kind === 'chat') {
    const box = h('div', { class: 'sx-app', 'data-chat-reply': r.filtered ?? '' }, h('p', {}, r.text));
    if (r.suggest?.length) box.append(h('div', { class: 'sx-actions' }, ...r.suggest.map((c) => btn(c.label, () => fillComposer(c.text), '', { 'data-chat-suggest': c.playbook }))));
    appendThread(box);
    return;
  }
  if (r.note) appendThread(h('div', { class: 'sx-app sx-meta', 'data-advice-note': '' }, r.note));
  if (r.kind === 'draft') {
    if (r.text) appendThread(h('div', { class: 'sx-app', 'data-cert-reply': r.run.cert?.code ?? '' }, r.text));
    putRun(r.run);
  } else if (r.kind === 'g24') {
    const id = `g24-${Date.now()}`;
    const now = new Date();
    const g = { id, doc: r.doc, stage: 'guide', startedMs: now.getTime(), startedAt: now.toTimeString().slice(0, 5), today: localDate(now), candidates: [], picked: null, saving: false, interp: r.via, sent: r.sent };
    state.g24.set(id, g);
    appendThread(h('div', { class: 'sx-app' }, `${r.doc}은 정부24 서류라 직접 발급해 주셔야 해요. 받은 PDF를 문서함에 넣으면 보관해 드려요.`));
    renderG24(g);
  } else {
    const box = h('div', { class: 'sx-app' }, r.text);
    if (r.addCp) box.append(h('div', { class: 'sx-actions' }, btn('거래처 추가', () => addCpFromAsk(r.addCp.name), 'sx-btn-primary', { 'data-act': 'ask-cp-add' })));
    appendThread(box);
    state.fill = r.chips?.length ? fillChips(r.chips) : [];
    renderQuick();
  }
}

const PROGRESS_TEXT = { thinking: '말씀을 읽고 있어요…', reading: '기록을 찾아보고 있어요…', drafting: '카드를 만들고 있어요…' };
const AGENT_TABLE_ROWS = 10;

const MAIL_TEXT = { sent: '메일 보냄', unconfirmed: '메일 확인 못 함' };

function agentIssued(x) {
  return [
    h(
      'td',
      { class: 'sx-meta' },
      x.approvalNo ? h('div', { 'data-approval': '' }, `승인 ${x.approvalNo}`) : null,
      x.mail ? h('div', { 'data-mail': x.mail }, MAIL_TEXT[x.mail]) : null,
    ),
    h('td', {}, x.documentId ? btn('PDF', () => act.openDoc(x.documentId), '', { 'data-act': 'agent-pdf' }) : null),
  ];
}

function agentTable(t) {
  const md = (d) => `${Number(d.slice(5, 7))}월 ${Number(d.slice(8, 10))}일`;
  const rows = t.rows.slice(0, AGENT_TABLE_ROWS);
  const issued = t.table === 'sales' || t.table === 'history';
  return h(
    'div',
    { class: 'sx-agent-table', 'data-agent-table': t.table },
    h('div', { class: 'sx-agent-table-title' }, t.title),
    rows.length
      ? h('table', { class: 'list' }, h('tbody', {}, ...rows.map((x) => h('tr', {}, h('td', { class: 'num-l' }, md(x.date)), h('td', { class: 'name' }, x.counterparty), h('td', { class: x.total === null ? 'num is-none' : 'num' }, x.total === null ? '금액 모름' : `${num(x.total)}원`), ...(issued ? agentIssued(x) : [])))))
      : h('p', { class: 'sx-meta' }, '해당하는 건이 없어요.'),
    t.rows.length > rows.length ? h('p', { class: 'sx-meta' }, `외 ${t.rows.length - rows.length}건`) : null,
  );
}

function renderAgent(r) {
  const box = h('div', { class: 'sx-app', 'data-agent-reply': r.filtered ?? '' }, h('p', {}, r.text));
  for (const x of r.show) if (x.type === 'table') box.append(agentTable(x));
  if (r.setup?.length) box.append(replyOptions(r.setup.map((m) => ({ label: m.label, onPick: () => reopenSetup(m.id), act: `setup-${m.id}`, lock: false }))));
  if (r.unknown) box.append(h('p', { class: 'sx-meta', 'data-unknown-name': r.unknown.name }, r.unknown.text), replyOptions([{ label: `${r.unknown.name}을(를) 거래처로 추가`, onPick: () => addCpFromAsk(r.unknown.name), act: 'ask-cp-add', lock: false }]));
  if (r.ask) {
    const opts = r.ask.chips.map((c) => ({ label: c.label, onPick: () => sendPrompt(c.text), attrs: { 'data-agent-chip': r.ask.kind } }));
    if (r.ask.kind === 'counterparty' && !r.unknown) opts.push({ label: '새 거래처 추가', onPick: () => addCpFromAsk(''), act: 'ask-cp-add', lock: false });
    if (opts.length) box.append(replyOptions(opts));
  }
  appendThread(box);
  state.agentAsk = !!r.ask;
  const cards = r.show.filter((x) => x.type === 'card');
  for (const c of cards) putRun(c.run);
  renderQuick();
}

async function handoffCall(method, id) {
  try {
    putRun(await call(method, { id }));
  } catch (e) {
    const c = errText(e);
    toast(
      c === 'gesture_required'
        ? '버튼을 직접 눌러 주세요.'
        : c === 'not_handed_off'
          ? '이미 이어서 진행하고 있어요'
          : c === 'simple.no_complete_button' || c === 'simple.complete_failed'
            ? '간편인증이 아직 끝나지 않았어요. 인증 앱에서 승인한 뒤 다시 눌러 주세요.'
          : c === 'sign.turn_resume_only'
            ? '서명 차례에는 [다 했어요]만 받아요. 홈택스 창에서 서명을 마쳐 주세요.'
            : c === 'refused' || /^[a-z_]+\.[a-z_.]+$/.test(c)
              ? '지금은 이어서 할 수 없어요. 홈택스 창을 확인한 뒤 다시 눌러 주세요.'
              : '앱이 바빠서 받지 못했어요. 잠시 뒤 다시 눌러 주세요.',
    );
  }
}

let handoffSeen = null;
function renderHandoff() {
  if (!chat.handoff) return;
  handoffSeen?.disconnect();
  handoffSeen = null;
  const r = [...state.runs.values()].find((x) => x.status === 'turn' && x.handoff);
  const cardOf = () => (r ? chat.thread.querySelector(`[data-run="${CSS.escape(r.id)}"]`) : null);
  const el = cardOf();
  if (!el || chat.handoff.dataset.card !== r.id) chat.handoff.hidden = true;
  chat.handoff.dataset.card = r?.id ?? '';
  if (!el) return chat.handoff.replaceChildren();
  chat.handoff.replaceChildren(
    h('span', { class: 'sx-handoff-text' }, `지금 사람이 필요해요 · ${runTitle(r)}`),
    h('button', { type: 'button', class: 'sx-btn sx-btn-quiet', 'data-act': 'handoff-go', onclick: () => cardOf()?.scrollIntoView({ block: 'center' }) }, '카드로 가기'),
  );
  handoffSeen = new IntersectionObserver(
    (entries) => {
      const e = entries[entries.length - 1];
      if (cardOf() !== e.target) return void queueMicrotask(renderHandoff);
      chat.handoff.hidden = e.intersectionRatio >= 0.5;
    },
    { root: chat.scroll, threshold: [0, 0.5, 1] },
  );
  handoffSeen.observe(el);
}

function putRun(run) {
  if (run.discarded) {
    renderRun(run);
    state.runs.delete(run.id);
    if (state.panel?.kind === 'run' && state.panel.id === run.id) openPanel(null);
    renderQuick();
    renderToday();
    return;
  }
  state.runs.set(run.id, run);
  renderRun(run);
  renderHandoff();
  renderQuick();
  if (state.panel?.kind === 'run' && state.panel.id === run.id) renderPanel();
  renderToday();
}

function renderRun(run) {
  const wasNear = nearEnd();
  const cardAct = { ...act, editing: state.editing, editingFields: state.editingFields, editingFocus: state.editingFocus, draftErr: state.draftErr, editingCp: state.editingCp, counterparties: state.cps, draftMore: state.draftMore, toggleDraftMore: (id, open) => (open ? state.draftMore.add(id) : state.draftMore.delete(id)), stepsOpen: state.stepsOpen, toggleSteps: (id, open) => (open ? state.stepsOpen.add(id) : state.stepsOpen.delete(id)) };
  if (run.batch) {
    const mates = [...state.runs.values()].filter((x) => x.batch?.id === run.batch.id && x.id !== run.id);
    const all = [...mates, run].sort((a, b) => a.batch.index - b.batch.index);
    const el = batchCard(all, cardAct);
    const old = chat.thread.querySelector(`[data-batch="${run.batch.id}"]`) ?? chat.thread.querySelector(`[data-run="${run.id}"]`);
    if (old) old.replaceWith(el);
    else appendThread(el);
    if (old && (chat.thread.lastElementChild === el || run.status === 'waiting')) followEnd(wasNear);
    return;
  }
  const el = taskCard(run, cardAct);
  const old = chat.thread.querySelector(`[data-run="${run.id}"]`);
  if (old) old.replaceWith(el);
  else appendThread(el);
  if (old && (chat.thread.lastElementChild === el || run.status === 'waiting')) followEnd(wasNear);
  renderHandoff();
}

function renderG24(g) {
  const el = g24Card(g, act);
  const old = chat.thread.querySelector(`[data-g24="${g.id}"]`);
  if (old) old.replaceWith(el);
  else appendThread(el);
  if (state.panel?.kind === 'g24' && state.panel.id === g.id) renderPanel();
  renderToday();
  renderQuick();
}

function renderToday() {
  if (!chat.today) return;
  chat.today.hidden = onbActive();
  if (onbActive()) return;
  const b = state.board;
  const items = b ? b.cards.flatMap((c) => c.items) : [];
  const setup = b?.setup ?? [];
  const counts = b
    ? [
        ['확인 필요', b.counts.attention, 'is-attention'],
        ['진행 중', b.counts.progress, ''],
        ['만료 임박', b.counts.expiringSoon, 'is-attention'],
      ].filter(([, n]) => n > 0)
    : [];
  const open = state.panel?.kind === 'board';
  chat.today.replaceChildren(
    h(
      'button',
      { type: 'button', class: 'board-line', 'aria-expanded': String(open), 'data-act': 'board-toggle', onclick: () => openPanel(state.panel?.kind === 'board' ? null : { kind: 'board' }) },
      h('span', { class: 'board-title' }, `${boardMonth()} 할 일`),
      h('span', { class: 'board-count' }, items.length ? h('b', {}, String(items.length)) : '챙길 일이 없어요'),
      ...counts.map(([label, n, cls]) => h('span', { class: `board-count ${cls}`.trim() }, `${label} `, h('b', {}, String(n)))),
      setup.length ? h('span', { class: 'board-count' }, `등록 할 일 `, h('b', {}, String(setup.length))) : null,
      h('span', { class: 'board-go', 'aria-hidden': 'true' }, icon('chevron')),
    ),
  );
  if (open) renderPanel();
}

const boardMonth = () => (state.board ? `${Number(state.board.month.slice(5, 7))}월` : '이번 달');

function boardPanel() {
  const b = state.board;
  const setup = b?.setup ?? [];
  const cards = (b?.cards ?? []).filter((c) => c.items.length);
  return h(
    'div',
    { class: 'panel-in', 'data-board-panel': '' },
    panelHead(`${boardMonth()} 할 일`),
    setup.length
      ? h('div', { class: 'board-setup', 'data-board-setup': '' }, ...setup.map((x) => h('button', { type: 'button', class: 'board-setup-item', 'data-setup': x.id, onclick: () => (x.id === 'biz' || x.id === 'auth' || x.id === 'chrome' || x.id === 'security' ? reopenSetup(x.id) : go(x.view)) }, x.label)))
      : null,
    cards.length ? h('div', { class: 'board-cards' }, ...cards.map(boardCard)) : h('p', { class: 'board-empty' }, '챙길 일이 없어요'),
  );
}

function boardCard(c) {
  const MAX = 3;
  const open = state.boardExpanded.has(c.kind);
  const rows = (open ? c.items : c.items.slice(0, MAX)).map(boardRow);
  const more = c.items.length - MAX;
  const toggleMore = () => {
    if (open) state.boardExpanded.delete(c.kind);
    else state.boardExpanded.add(c.kind);
    renderToday();
  };
  return h(
    'article',
    { class: 'board-card', 'data-board-card': c.kind },
    h('div', { class: 'board-card-hd' }, h('span', { class: 'board-card-title' }, c.title), h('span', { class: 'sx-meta' }, String(c.items.length))),
    h('ul', { class: 'board-rows' }, ...rows),
    more > 0 ? h('button', { type: 'button', class: 'board-more', 'aria-expanded': String(open), 'data-board-more': c.kind, onclick: toggleMore }, open ? '줄이기' : `${more}건 더 보기`) : null,
  );
}

function boardRow(it) {
  const due = it.showDue && it.due ? dueText(it.due) : null;
  return h(
    'li',
    {},
    h(
      'button',
      { type: 'button', class: `board-row${it.tone ? ` is-${it.tone}` : ''}`, 'data-board-item': it.id, onclick: () => boardGo(it.target) },
      h('span', { class: 'board-row-main' }, h('span', { class: 'board-row-label' }, it.label), h('span', { class: 'board-row-detail' }, it.detail)),
      due ? h('span', { class: `board-due${due.soon ? ' is-soon' : ''}` }, due.text) : null,
    ),
  );
}

function dueText(due) {
  const n = dday(due, state.today);
  if (n === null) return null;
  return { text: n === 0 ? '오늘' : n > 0 ? `D-${n}` : `${-n}일 지남`, soon: n <= 7 };
}

async function boardGo(t) {
  if (t.to === 'run') {
    if (state.view !== 'chat') await go('chat');
    openPanel({ kind: 'run', id: t.id });
    (document.querySelector(`[data-run="${CSS.escape(t.id)}"]`) ?? document.querySelector(`[data-batch-row="${CSS.escape(t.id)}"]`))?.scrollIntoView({ block: 'center' });
  } else if (t.to === 'doc') {
    state.docFilter = 'all';
    await go('docs');
    openPanel({ kind: 'doc', id: t.id });
  } else if (t.to === 'compose') {
    if (state.view !== 'chat') await go('chat');
    fillComposer(t.text);
  } else if (t.to === 'view') {
    if (t.filter) state.docFilter = t.filter;
    await go(t.view);
  }
}

let incidentId = null;
function syncIncident(p) {
  const next = p?.kind === 'run' && state.runs.get(p.id)?.inDoubt ? p.id : null;
  if (next === incidentId) return;
  if (incidentId) void call('incident.close', { id: incidentId }).catch(() => {});
  incidentId = next;
  if (next)
    void call('incident.open', { id: next }).catch(() => {
      if (incidentId === next) incidentId = null;
    });
}

function openPanel(p) {
  syncIncident(p);
  if (!(p?.kind === 'doc' && p.id === state.docDraft?.id)) state.docDraft = null;
  state.panel = p;
  $('#app').classList.toggle('panel-closed', !p);
  chat.today?.querySelector('.board-line')?.setAttribute('aria-expanded', String(p?.kind === 'board'));
  renderPanel();
}

const modBits = (e) => (e.altKey ? 1 : 0) | (e.ctrlKey ? 2 : 0) | (e.metaKey ? 4 : 0) | (e.shiftKey ? 8 : 0);
const SCREEN_KEYS = new Set(['Enter', 'Backspace', 'Tab', 'Escape', 'Delete', 'ArrowLeft', 'ArrowUp', 'ArrowRight', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown']);
const SCREEN_CMD_KEYS = new Set(['a', 'z', 'x', 'c']);
const screenInput = (p) => call('browser.input', p).catch(() => {});

function wireScreen(box, img, input) {
  const at = (e) => {
    const b = img.getBoundingClientRect();
    return { x: Math.min(1, Math.max(0, (e.clientX - b.left) / b.width)), y: Math.min(1, Math.max(0, (e.clientY - b.top) / b.height)) };
  };
  let lastMove = 0;
  img.addEventListener('mousedown', (e) => {
    e.preventDefault();
    input.focus({ preventScroll: true });
    void screenInput({ kind: 'mouse', type: 'mousePressed', ...at(e), button: e.button === 2 ? 'right' : 'left', clickCount: Math.min(3, Math.max(1, e.detail || 1)), modifiers: modBits(e) });
  });
  img.addEventListener('mouseup', (e) => {
    e.preventDefault();
    void screenInput({ kind: 'mouse', type: 'mouseReleased', ...at(e), button: e.button === 2 ? 'right' : 'left', clickCount: Math.min(3, Math.max(1, e.detail || 1)), modifiers: modBits(e) });
  });
  img.addEventListener('mousemove', (e) => {
    const now = performance.now();
    if (now - lastMove < 50) return;
    lastMove = now;
    void screenInput({ kind: 'mouse', type: 'mouseMoved', ...at(e), modifiers: modBits(e) });
  });
  img.addEventListener('wheel', (e) => {
    e.preventDefault();
    const k = e.deltaMode === 1 ? 40 : e.deltaMode === 2 ? 800 : 1;
    void screenInput({ kind: 'wheel', ...at(e), dx: Math.max(-5000, Math.min(5000, e.deltaX * k)), dy: Math.max(-5000, Math.min(5000, e.deltaY * k)), modifiers: modBits(e) });
  }, { passive: false });
  img.addEventListener('contextmenu', (e) => e.preventDefault());
  const flush = () => {
    const v = input.value;
    input.value = '';
    if (v) void screenInput({ kind: 'text', text: v.slice(0, 2000) });
  };
  input.addEventListener('keydown', (e) => {
    if (e.isComposing || e.keyCode === 229) return;
    const mods = modBits(e);
    if ((e.metaKey || e.ctrlKey) && !e.altKey) {
      if (SCREEN_CMD_KEYS.has(e.key.toLowerCase())) {
        e.preventDefault();
        void screenInput({ kind: 'key', key: e.key.toLowerCase(), modifiers: mods });
      }
      return;
    }
    if (SCREEN_KEYS.has(e.key)) {
      e.preventDefault();
      flush();
      void screenInput({ kind: 'key', key: e.key, modifiers: mods });
    }
  });
  input.addEventListener('input', (e) => {
    if (!e.isComposing) flush();
  });
  input.addEventListener('compositionend', () => flush());
  input.addEventListener('paste', (e) => {
    e.preventDefault();
    const t = e.clipboardData?.getData('text/plain') ?? '';
    if (t) void screenInput({ kind: 'text', text: t.slice(0, 2000) });
  });
  box.addEventListener('focusin', () => box.classList.add('is-focused'));
  box.addEventListener('focusout', () => box.classList.remove('is-focused'));
}
function focusScreen() {
  const s = state.screen;
  if (!s) return;
  if (state.panel?.kind !== 'run' || state.panel.id !== s.runId) openPanel({ kind: 'run', id: s.runId });
  requestAnimationFrame(() => {
    const box = document.querySelector(`[data-run-screen="${CSS.escape(s.runId)}"]`);
    box?.closest('[data-browser-pane]')?.scrollIntoView({ block: 'start' });
    box?.querySelector('.run-screen-input')?.focus({ preventScroll: true });
  });
}

function paintScreen() {
  const s = state.screen;
  const box = s ? document.querySelector(`[data-run-screen="${CSS.escape(s.runId)}"]`) : null;
  if (!box) return;
  const pill = box.parentElement?.querySelector('[data-bp-state]');
  const mark = (st, text) => {
    if (pill && pill.dataset.bpState !== st) {
      pill.dataset.bpState = st;
      pill.textContent = text;
    }
  };
  if (s.gone) mark('gone', '연결 끊김');
  else if (s.paused) mark('paused', '비밀번호 입력 중');
  else if (s.frame || (state.browser.embedded && s.url)) mark('live', '직접 조작');
  if (state.browser.embedded) {
    box.dataset.state = s.gone ? 'gone' : s.paused ? 'paused' : 'live';
    if (s.gone) box.replaceChildren(h('p', { class: 'sx-meta' }, '연결 끊김 · 브라우저가 닫혔어요'));
    return;
  }
  if (s.gone) {
    box.dataset.state = 'gone';
    box.replaceChildren(h('p', { class: 'sx-meta' }, '연결 끊김 · 브라우저가 닫혔어요'));
    return;
  }
  if (s.paused) {
    box.dataset.state = 'paused';
    box.replaceChildren(h('p', { class: 'sx-meta' }, '비밀번호 입력 중이라 화면을 잠시 가렸어요'));
    return;
  }
  if (!s.frame) return;
  let img = box.querySelector('img');
  if (!img) {
    img = h('img', { alt: '홈택스 화면', draggable: 'false' });
    const input = h('textarea', { class: 'run-screen-input', 'aria-label': '홈택스 화면에 입력', autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false', rows: 1 });
    box.replaceChildren(img, input);
    wireScreen(box, img, input);
  }
  box.dataset.state = 'live';
  img.src = s.frame;
}

function renderPanel() {
  const el = $('#panel');
  const p = state.panel;
  if (!p) return el.replaceChildren();
  if (p.kind === 'run') {
    const run = state.runs.get(p.id);
    const pane = run ? browserPane(run, state.screen?.runId === run.id ? (state.screen.url ?? '') : '', state.browser.shown, act) : null;
    const detail = run ? runPanel(run, act) : h('div');
    el.replaceChildren(...(pane ? [pane, runDock(run, detail, state.dockOpen, (o) => (state.dockOpen = o))] : [detail]));
    paintScreen();
  } else if (p.kind === 'g24') {
    el.replaceChildren(g24Panel(state.g24.get(p.id), act));
  } else if (p.kind === 'doc') {
    const doc = state.docs.find((d) => d.id === p.id);
    if (!doc) return el.replaceChildren();
    el.replaceChildren(docPanel(doc, state.today, act, doc.vault ? docReview(doc) : null));
  } else if (p.kind === 'cp') {
    const c = state.cps.find((x) => x.id === p.id);
    el.replaceChildren(c ? cpPanel(c) : h('div'));
  } else if (p.kind === 'cp-edit') {
    el.replaceChildren(cpEditPanel(p.id ? state.cps.find((x) => x.id === p.id) : null, p.id ? null : { name: p.name ?? '', ask: !!p.ask }));
  } else if (p.kind === 'board') {
    el.replaceChildren(boardPanel());
  } else if (p.kind === 'act') {
    const row = activityRows().find((r) => r.id === p.id);
    el.replaceChildren(row ? activityPanel(row) : h('div'));
  }
}

const waitingChip = () => {
  const r = [...state.runs.values()].find((x) => x.status === 'waiting');
  return h('button', { type: 'button', class: 'sx-btn sx-btn-quiet rs-waiting', onclick: () => go('chat') }, r ? `${runTitle(r)} 승인 대기 · 대화로 가기` : '승인 대기 · 대화로 가기');
};

const panelHead = (title, ...extra) => h('div', { class: 'sx-card-hd' }, h('div', { class: 'sx-card-title' }, title), ...extra, h('button', { type: 'button', class: 'panel-x', 'aria-label': '패널 닫기', onclick: act.closePanel }, icon('close')));

const railHead = (title, meta, ...right) =>
  h(
    'div',
    { class: 'rs-head' },
    PARENT[state.view] ? h('button', { type: 'button', class: 'rs-back', 'data-act': 'back', 'aria-label': `${PARENT_LABEL[PARENT[state.view]]}로 돌아가기`, onclick: () => go(PARENT[state.view]) }, icon('chevronLeft'), PARENT_LABEL[PARENT[state.view]]) : null,
    h('h1', { class: 'title-screen' }, title),
    meta ? h('span', { class: 'sx-meta' }, meta) : null,
    h('div', { class: 'rs-right' }, waitingChip(), ...right),
  );

const listTable = (cols, rows) =>
  h('div', { class: 'list-box' }, h('table', { class: 'list' }, h('thead', {}, h('tr', {}, cols.map(([t, cls]) => h('th', { class: cls ?? null }, t)))), h('tbody', {}, rows)));

const shortDate = (s) => (s && /^\d{4}-\d\d-\d\d$/.test(s) ? s.slice(5) : s);

const DOC_FILTERS = [
  ['all', '전체'],
  ['cert', '증명서'],
  ['tax', '세금계산서'],
  ['soon', '만료 임박'],
];

const ISSUED_SHOWN = 10;
const ISSUED_STATE = { issued: ['발급됨', ''], unsure: ['확인 필요', 'is-attention'] };
function issuedSection() {
  const all = (state.issued ?? []).filter((x) => x.kind === 'issued' || x.kind === 'unsure');
  const tried = (state.issued?.length ?? 0) - all.length;
  const triedLine = tried ? h('div', { class: 'issued-tried', 'data-issued-tried': String(tried) }, btn(`발급 안 된 시도 ${tried}건 · 활동 기록에서 보기`, () => go('activity'), 'sx-btn-quiet', { 'data-act': 'issued-tried' })) : null;
  if (!all.length) return triedLine;
  const rows = state.issuedAll ? all : all.slice(0, ISSUED_SHOWN);
  const done = all.filter((x) => x.kind === 'issued').length;
  const unsure = all.filter((x) => x.kind === 'unsure').length;
  return h(
    'div',
    { class: 'issued-sec', 'data-issued': '' },
    h('div', { class: 'issued-hd' }, h('h2', { class: 'issued-title' }, '발급한 세금계산서'), h('span', { class: 'sx-meta' }, [`발급 ${done}건`, unsure ? `확인 필요 ${unsure}건` : null].filter(Boolean).join(' · '))),
    listTable(
      [['날짜'], ['거래처'], ['금액', 'num'], ['승인번호'], ['메일'], ['']],
      rows.map((x) => {
        const [label, cls] = ISSUED_STATE[x.kind] ?? ISSUED_STATE.unsure;
        return h(
          'tr',
          { 'data-issued-row': x.runId, 'data-kind': x.kind, title: x.note || null },
          h('td', {}, x.day ?? '—', x.time ? h('span', { class: 'sx-meta doc-ago' }, x.time) : null),
          h('td', { class: x.who ? 'name' : 'name is-none' }, x.who ?? '—'),
          h('td', { class: x.total != null ? 'num' : 'num is-none' }, x.total != null ? `${num(x.total)}원` : '—'),
          x.kind === 'issued' ? h('td', { class: x.approvalNo ? 'sx-id' : 'is-none' }, x.approvalNo ?? '—') : h('td', { colspan: '2', class: 'issued-why' }, h('span', { class: `issued-state ${cls}` }, label), x.note ? h('span', { class: 'sx-meta issued-note' }, x.note) : null),
          x.kind === 'issued' ? h('td', { class: x.mail ? null : 'is-none' }, x.mail ? MAIL_TEXT[x.mail] : '—') : null,
          h('td', {}, x.documentId ? btn('PDF', () => act.openDoc(x.documentId), '', { 'data-act': 'issued-pdf' }) : null),
        );
      }),
    ),
    all.length > ISSUED_SHOWN
      ? h('div', { class: 'issued-more' }, btn(state.issuedAll ? '최근 10건만 보기' : `모두 보기 (${all.length}건)`, () => ((state.issuedAll = !state.issuedAll), render()), '', { 'data-act': 'issued-all' }))
      : null,
    triedLine,
  );
}

function docsView() {
  const f = state.docFilter;
  const n7 = (d) => {
    const n = dday(d.expiresOn, state.today);
    return n !== null && n <= 7;
  };
  const withIssued = f === 'all' || f === 'tax';
  const list = state.docs
    .filter((d) => f === 'all' || (f === 'tax' && d.kind === '세금계산서') || (f === 'cert' && d.kind !== '세금계산서') || (f === 'soon' && n7(d)))
    .filter((d) => !(withIssued && d.kind === '세금계산서' && d.source === '앱이 발급'))
    .map((d) => ({ d, n: dday(d.expiresOn, state.today) }))
    .sort((a, b) => Number(!!b.d.vault?.needsUser) - Number(!!a.d.vault?.needsUser) || Number(b.n !== null && b.n <= 7) - Number(a.n !== null && a.n <= 7) || (b.d.issuedOn ?? '').localeCompare(a.d.issuedOn ?? ''));
  const check = state.docs.filter((d) => d.vault?.needsUser).length;
  const soon = state.docs.filter(n7).length;
  const meta = [`${state.docs.length}개`, check ? `확인 필요 ${check}개` : null, soon ? `만료 임박 ${soon}개` : null].filter(Boolean).join(' · ');
  const fb = ([key, label]) => h('button', { type: 'button', class: f === key ? 'is-on' : null, 'aria-pressed': String(f === key), onclick: () => ((state.docFilter = key), render()) }, label);
  return h(
    'section',
    { class: 'rail-screen', 'data-view': 'docs' },
    !state.docs.length && !(state.issued ?? []).length ? railHead('문서함', '', btn('세무사 꾸러미', () => go('bundle'), 'sx-btn-quiet', { 'data-act': 'go-bundle' }), btn('활동 기록', () => go('activity'), 'sx-btn-quiet', { 'data-act': 'go-activity' })) :
    railHead('문서함', meta, btn('세무사 꾸러미', () => go('bundle'), 'sx-btn-quiet', { 'data-act': 'go-bundle' }), btn('활동 기록', () => go('activity'), 'sx-btn-quiet', { 'data-act': 'go-activity' }), btn(state.docBusy ? '읽는 중…' : 'PDF 가져오기', () => importDoc({ pick: true }), '', { 'data-act': 'doc-import', disabled: state.docBusy })),
    state.docs.length || (state.issued ?? []).length ? h('div', { class: 'filters', role: 'group', 'aria-label': '서류 거르기' }, DOC_FILTERS.map(fb)) : null,
    withIssued ? issuedSection() : null,
    list.length || !withIssued ? listTable(
      [['서류'], ['발급일'], ['용도'], ['출처']],
      list.map(({ d }) =>
        h(
          'tr',
          { class: state.panel?.id === d.id ? 'is-on' : null, 'data-doc-row': d.id, 'data-expiry-tag': d.vault && d.expiresOn ? expiryTag(d) : null, onclick: () => openPanel({ kind: 'doc', id: d.id }) },
          h('td', { class: 'name' }, d.name, state.docLocked.has(d.id) ? lockMark() : null, d.profile === 'personal' ? h('span', { class: 'sx-tag doc-tag' }, '개인') : null, d.vault?.needsUser ? h('span', { class: 'doc-flag' }, '확인 필요') : null),
          h('td', { class: d.issuedOn ? null : 'is-none' }, d.issuedOn ?? '—', d.issuedOn && agoText(d.issuedOn, state.today) ? h('span', { class: 'sx-meta doc-ago' }, agoText(d.issuedOn, state.today)) : null),
          h('td', { class: d.purpose ? null : 'is-none' }, d.purpose || '—'),
          h('td', { class: 'sx-meta' }, d.source),
        ),
      ),
    ) : null,
    list.length || (withIssued && (state.issued ?? []).length)
      ? null
      : state.docs.length || f !== 'all'
        ? emptyState('조건에 맞는 서류가 없어요.', null, f === 'all' ? null : btn('전체 보기', () => ((state.docFilter = 'all'), render()), '', { 'data-act': 'doc-filter-all' }))
        : loadState('docs', '서류 목록', () => void loadDocs()) ?? emptyState('아직 서류가 없어요.', '대화에서 "사업자등록증명 떼 줘"처럼 말하거나, 받아 둔 PDF를 가져오면 여기에 모여요.', btn(state.docBusy ? '읽는 중…' : 'PDF 가져오기', () => importDoc({ pick: true }), 'sx-btn-primary', { 'data-act': 'doc-import', disabled: state.docBusy })),
  );
}

const thisMonth = () => `${state.today.getFullYear()}-${String(state.today.getMonth() + 1).padStart(2, '0')}`;

function cpsView() {
  const month = thisMonth();
  const issued = state.cps.filter((c) => c.lastIssuedOn?.startsWith(month)).length;
  return h(
    'section',
    { class: 'rail-screen', 'data-view': 'cps' },
    state.cps.length ? railHead('거래처', `${state.cps.length}곳${issued ? ` · 이번 달 발급 ${issued}곳` : ''}`, btn('거래처 추가', () => openPanel({ kind: 'cp-edit', id: null }), '', { 'data-act': 'cp-add' })) : railHead('거래처', ''),
    state.onb?.step === 'counterparties'
      ? h('div', { class: 'sx-note', 'data-onb-band': 'cps' }, h('div', {}, '거래처를 다 넣으면 대화로 돌아가 [다 했어요]를 눌러 주세요.'), btn('대화로 돌아가기', () => go('chat'), 'sx-btn-primary', { 'data-act': 'onb-back' }))
      : null,
    state.cps.length ? listTable(
      [['상호'], ['사업자번호'], ['상태'], ['최근 발급'], ['이번 달']],
      state.cps.map((c) =>
        h(
          'tr',
          { class: state.panel?.id === c.id ? 'is-on' : null, 'data-cp-row': c.id, onclick: () => openPanel({ kind: 'cp', id: c.id }) },
          h('td', { class: 'name' }, c.name),
          h('td', { class: 'sx-id' }, fmtBiz(c.bizNo)),
          h('td', {}, c.status, c.checkedOn ? h('span', { class: 'sx-tag doc-tag' }, `${shortDate(c.checkedOn)} 확인`) : null),
          h('td', { class: c.lastIssuedOn ? null : 'is-none' }, c.lastIssuedOn || '—'),
          h('td', { class: c.lastIssuedOn?.startsWith(month) ? null : 'is-none' }, c.lastIssuedOn?.startsWith(month) ? '발급함' : '—'),
        ),
      ),
    ) : loadState('cps', '거래처 목록', () => void loadCps()) ?? emptyState('아직 거래처가 없어요.', '세금계산서를 보낼 곳의 사업자번호만 있으면 상호·대표자는 홈택스에서 채워요.', btn('거래처 추가', () => openPanel({ kind: 'cp-edit', id: null }), 'sx-btn-primary', { 'data-act': 'cp-add' })),
    state.cps.length ? h('p', { class: 'sx-meta rs-foot' }, '사업자번호는 발급할 때마다 홈택스에서 다시 확인해요.') : null,
  );
}

function cpPanel(c) {
  const history = state.docs.filter((d) => d.kind === '세금계산서' && d.name === `세금계산서 · ${c.name}`).sort((a, b) => (b.issuedOn ?? '').localeCompare(a.issuedOn ?? ''));
  return h(
    'div',
    { class: 'panel-in', 'data-panel-cp': c.id },
    panelHead(c.name, h('span', { class: 'sx-chip' }, c.status)),
    kv([
      ['사업자번호', fmtBiz(c.bizNo), { mono: true, copy: () => act.copy(fmtBiz(c.bizNo)) }],
      ['대표자', c.rep],
      ['받는 이메일', c.email],
      ['저장 품목', c.item],
      ['상태 확인', c.checkedOn || '—', c.checkedOn ? { tag: '홈택스' } : {}],
    ]),
    h('div', { class: 'sx-panel-sec' }, '세금계산서 발급 이력'),
    history.length
      ? h('div', { class: 'hist' }, history.map((d) => h('div', { class: 'hist-row' }, h('span', {}, d.issuedOn ?? '—'), h('span', { class: 'hist-what' }, d.docName), h('span', { class: 'sx-meta' }, d.source))))
      : h('div', { class: 'sx-meta' }, '아직 이 PC에서 발급한 적이 없어요.'),
    h(
      'div',
      { class: 'sx-actions' },
      btn('세금계산서 발급', () => fillComposer(`${c.name}에 세금계산서 `), 'sx-btn-primary'),
      btn('수정', () => openPanel({ kind: 'cp-edit', id: c.id }), '', { 'data-act': 'cp-edit' }),
    ),
    state.profile === 'business' ? bankUi.cpSection(c) : null,
    h('div', { class: 'sx-source' }, '거래처 장부 · 이 PC에만 있어요'),
  );
}

const CP_ERR = { bad_item_name: '품목 이름을 확인해 주세요', too_many_items: '저장 품목은 20개까지예요', invalid_biz_no: '사업자번호가 맞지 않아요(10자리, 검증 숫자)', duplicate_biz_no: '이미 있는 사업자번호예요', name_required: '상호를 넣어 주세요', invalid_email: '이메일 형식이 아니에요', unsupported: '이 모드에서는 바꿀 수 없어요', busy: '등록증을 읽는 중이에요', gesture_required: '버튼을 다시 눌러 주세요' };
const CP_ERR_FIELD = { invalid_biz_no: 'bizNo', duplicate_biz_no: 'bizNo', name_required: 'name', invalid_email: 'email', bad_item_name: 'item', too_many_items: 'item' };

function cpEditPanel(c, add = null) {
  const inputs = {
    name: textInput({ name: 'name', value: c?.name ?? add?.name, max: LIMITS.name, required: '상호를 넣어 주세요.', compact: true }),
    bizNo: bizNoInput({ name: 'bizNo', value: c?.bizNo, required: !c, disabled: !!c, compact: true }),
    rep: textInput({ name: 'rep', value: c?.rep, max: LIMITS.rep, compact: true }),
    email: emailInput({ name: 'email', value: c?.email, compact: true }),
    item: textInput({ name: 'item', value: c?.item, max: LIMITS.item, placeholder: '예: 컨설팅 용역', compact: true }),
  };
  const cancel = () => openPanel(c ? { kind: 'cp', id: c.id } : null);
  let saving = false;
  let reading = false;
  let certHold = null;
  const msg = h('p', { class: 'form-msg', role: 'status', 'data-cp-msg': '', hidden: true });
  const say = (text, bad) => {
    msg.textContent = text;
    msg.className = `form-msg${bad ? ' is-bad' : ''}`;
    msg.dataset.cpMsg = bad ? 'bad' : 'ok';
    msg.hidden = false;
  };
  const fillFromCert = async () => {
    if (reading) return;
    reading = true;
    try {
      const r = await call('counterparty.readCert', {});
      if (!r.found) {
        if (r.reason === 'unreadable') say('등록증을 읽지 못했어요. 번호로 입력해 주세요', true);
        return;
      }
      if (r.name) form.elements.name.value = r.name;
      if (r.bizNo) form.elements.bizNo.value = fmtBiz(r.bizNo);
      if (r.rep) form.elements.rep.value = r.rep;
      certHold = r.hold ?? null;
      const itemIn = form.elements.namedItem('item');
      const itemFilled = !!r.item && !!itemIn && !String(itemIn.value).trim();
      if (itemFilled) itemIn.value = r.item;
      for (const i of Object.values(inputs)) fieldError(i, null);
      say(!r.bizNo ? '등록증에서 읽었어요. 사업자번호는 읽지 못했으니 직접 넣어 주세요' : itemFilled ? '등록증에서 읽었어요. 저장 품목은 등록증의 종목이에요. 발급할 품목과 다르면 고친 뒤 추가해 주세요' : '등록증에서 읽었어요. 맞는지 보고 추가해 주세요', !r.bizNo);
    } catch (err) {
      say(human(err, CP_ERR), true);
    } finally {
      reading = false;
    }
  };
  const form = h(
    'form',
    {
      class: 'cp-form',
      novalidate: true,
      oninput: () => (msg.hidden = true),
      onkeydown: keys(() => form.requestSubmit(), cancel),
      onsubmit: async (e) => {
        e.preventDefault();
        if (saving || !checkFields(form)) return;
        saving = true;
        const f = new FormData(form);
        const no = f.get('bizNo');
        try {
          const r = await call('counterparty.save', { id: c?.id ?? null, name: f.get('name'), bizNo: no === null ? null : bizDigits(no), rep: f.get('rep'), email: f.get('email'), item: f.get('item'), certHold });
          state.cps = r.counterparties;
          const savedName = String(f.get('name') ?? '').trim();
          if (!c && add?.ask) {
            await go('chat');
            fillComposer(state.cps.find((x) => x.id === r.id)?.name ?? savedName);
            toast('거래처를 추가했어요. 보내면 이어서 발급할게요');
            return;
          }
          render();
          openPanel({ kind: 'cp', id: r.id });
          toast(c ? '저장했어요' : '거래처를 추가했어요');
        } catch (err) {
          const at = inputs[CP_ERR_FIELD[errText(err)]];
          if (at && !at.disabled) fieldError(at, human(err, CP_ERR));
          else say(human(err, CP_ERR), true);
        } finally {
          saving = false;
        }
      },
    },
    c ? null : h('div', { class: 'sx-actions' }, btn('등록증으로 채우기', fillFromCert, 'sx-btn-quiet', { 'data-act': 'cp-cert' })),
    field({ label: '상호', input: inputs.name }),
    field({ label: '사업자번호', input: inputs.bizNo, help: c ? '추가한 뒤에는 바꿀 수 없어요' : null }),
    field({ label: '대표자', input: inputs.rep }),
    field({ label: '받는 이메일', input: inputs.email }),
    field({ label: '저장 품목', input: inputs.item, help: '발급할 때 품목 후보로 채워요' }),
    msg,
    h('div', { class: 'sx-actions' }, h('button', { type: 'submit', class: 'sx-btn sx-btn-primary', 'data-act': 'cp-save' }, c ? '저장' : '추가'), btn('취소', cancel, 'sx-btn-quiet')),
  );
  return h('div', { class: 'panel-in', 'data-panel-cp-edit': c?.id ?? 'new' }, panelHead(c ? `${c.name} 수정` : '거래처 추가'), form, h('div', { class: 'sx-source' }, '이 PC 거래처 장부에만 저장해요'));
}

function bizCard() {
  const b = state.boot.profiles.business;
  return bizProfileCard({
    b,
    edit: state.bizEdit,
    authReopen: !!state.boot.authReopen,
    call,
    toast,
    rerender: render,
    onEdit: () => {
      state.bizEdit = bizEditStart(b);
      render();
    },
    onCancel: () => {
      state.bizEdit = null;
      render();
    },
    onSaved: (r) => {
      state.boot.profiles = r.profiles;
      state.boot.profileEdits = r.edits;
      state.bizEdit = null;
      render();
      renderTitlebar();
      renderToday();
      toast(r.changed.length ? '저장했어요' : '바뀐 것이 없어요');
    },
    reopenAuth: () => reopenSetup('auth'),
  });
}

function bizBody() {
  const col = bizView().querySelector('.rs-col');
  col.classList.add('set-body');
  col.querySelector('.rs-head')?.remove();
  col.prepend(h('div', { class: 'set-intro' }, h('h2', { class: 'sx-card-title' }, '내 사업장'), h('p', { class: 'sx-body-sm is-muted' }, '세금계산서의 공급자 정보예요. 홈택스 발급 화면에서 채워요.')));
  return col;
}

function bizView() {
  const p = state.boot.profiles;
  const personal = p.personal && !p.personal.placeholder ? p.personal : null;
  return h(
    'section',
    { class: 'rail-screen', 'data-view': 'biz' },
    h(
      'div',
      { class: 'rs-col' },
      railHead('내 사업장', null),
      bizCard(),
      personal
        ? h(
            'article',
            { class: 'sx-card', 'data-personal-card': '' },
            h('div', { class: 'sx-card-hd' }, h('div', { class: 'sx-card-title' }, `개인 · ${personal.name}`)),
            kv(
              [
                ['이름', personal.name],
                ['이메일', personal.email],
                ['로그인', personal.auth],
              ],
              true,
            ),
            h('div', { class: 'sx-source' }, '개인 납세증명서와 정부24 직접 발급에 써요'),
          )
        : null,
      h(
        'section',
        { class: 'rs-sec', 'aria-labelledby': 'biz-tasks' },
        h('h2', { class: 'sx-panel-sec', id: 'biz-tasks' }, '맡긴 업무'),
        h('div', { class: 'sx-quick' }, state.boot.quick.filter((q) => !q.soon).map((q) => h('button', { type: 'button', 'data-quick-cert': q.cert ?? null, onclick: () => (q.cert ? sendPrompt(q.text) : fillComposer(q.text)) }, q.label))),
        h('p', { class: 'sx-meta' }, '입력창 위 빠른 실행에 이 순서로 보여요.'),
      ),
    ),
  );
}

const PAST = {
  issued: { status: 'done', result: '완료', hometax: '전자세금계산서 1건 발급 · 발급목록에서 확인' },
  unsure: { status: 'attention', result: '확인 필요', hometax: '발급됐는지 확인하지 못함' },
  not_issued: { status: 'stopped', result: '발급 안 함', hometax: '발급하지 않음' },
  stopped_before_gate: { status: 'stopped', result: '승인 전에 멈춤', hometax: '발급하지 않음(승인 전에 앱이 꺼짐)' },
};

function activityRows() {
  const today = `${String(state.today.getMonth() + 1).padStart(2, '0')}-${String(state.today.getDate()).padStart(2, '0')}`;
  const rows = [];
  for (const r of [...state.runs.values()].reverse()) {
    if (r.status === 'draft') continue;
    rows.push({ id: r.id, run: r, at: `${today} ${r.result?.doneAt ?? r.createdAt}`, what: runTitle(r), profile: '사업자', portal: '홈택스', status: r.status, result: CHIP[r.status][0] });
  }
  for (const g of [...state.g24.values()].reverse()) {
    const result = { guide: '내 차례', pick: '내 차례', saved: '문서함에 넣음', stopped: '그만둠' }[g.stage];
    rows.push({ id: g.id, g24: g, at: `${today} ${g.startedAt}`, what: `${g.doc} · 정부24`, profile: '개인', portal: '정부24 · 직접', status: { guide: 'turn', pick: 'turn', saved: 'done', stopped: 'stopped' }[g.stage], result });
  }
  const LABEL = { name: '상호', bizNo: '사업자번호', rep: '대표자', bizType: '업태', bizItem: '종목', address: '주소', email: '이메일' };
  for (const [i, e] of [...(state.boot.profileEdits ?? []).entries()].reverse()) {
    const d = new Date(e.at);
    const at = `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    rows.push({ id: `edit-${i}`, edit: e, at, what: `내 사업장 수정 · ${e.fields.map((f) => LABEL[f] ?? f).join('·')}`, profile: '사업자', portal: '이 PC', status: 'done', result: '저장함' });
  }
  for (const p of state.boot.past ?? []) {
    if (state.runs.has(p.runId)) continue;
    rows.push({ id: `past-${p.runId}`, past: p, at: p.day ? `${shortDate(p.day)} ${p.time}` : '시각 모름', what: `세금계산서 · ${p.who ?? '거래처 정보 없음'}`, profile: '사업자', portal: '홈택스', status: PAST[p.kind].status, result: PAST[p.kind].result });
  }
  return rows;
}

function activityView() {
  const rows = activityRows();
  return h(
    'section',
    { class: 'rail-screen', 'data-view': 'activity' },
    railHead('활동 기록', '이 PC에만 남아요 · 비밀값은 남기지 않아요'),
    rows.length
      ? listTable(
          [['시각'], ['작업'], ['프로필'], ['포털'], ['결과'], ['AI']],
          rows.map((r) =>
            h(
              'tr',
              { class: state.panel?.id === r.id ? 'is-on' : null, 'data-act-row': r.id, onclick: () => openPanel({ kind: 'act', id: r.id }) },
              h('td', { class: 'num-l' }, r.at),
              h('td', { class: 'name' }, r.what),
              h('td', {}, r.profile),
              h('td', {}, r.portal),
              h('td', { class: r.status === 'attention' ? 'is-attention' : r.status === 'stopped' ? 'is-muted' : null }, r.result),
              modelCell(r.run?.sent ?? r.g24?.sent) ? h('td', {}, modelCell(r.run?.sent ?? r.g24?.sent)) : h('td', { class: 'is-muted' }, r.past ? '—' : '안 함'),
            ),
          ),
        )
      : emptyState('아직 기록이 없어요.', '홈택스·정부24에서 한 일이 시각·결과와 함께 여기에 남아요.'),
  );
}

function activityPanel(row) {
  const r = row.run;
  const where = r?.result
    ? whereRows(r)
    : row.g24
      ? [
          ['정부24', '앱은 요청을 보내지 않았어요 · 직접 발급'],
          ['보관', row.g24.stage === 'saved' ? '이 PC 문서함' : '넣지 않음'],
          modelRow(row.g24.sent),
          serverRow(row.g24.sent),
        ]
      : row.edit
        ? [
            ['저장', `이 PC 내 사업장 정보 · 고친 칸 ${row.edit.fields.length}개(값은 기록하지 않아요)`],
            ['AI', '쓰지 않음'],
            serverRow([]),
          ]
        : row.past
        ? [
            ['홈택스', PAST[row.past.kind].hometax],
            row.past.documentId ? ['보관', '이 PC 문서함'] : null,
          ]
        : [
            ['홈택스', r.status === 'stopped' ? '발급하지 않음' : r.status === 'attention' ? '확인 필요 · 위 안내를 봐 주세요' : '진행 중'],
            modelRow(r.sent),
            serverRow(r.sent),
          ];
  return h(
    'div',
    { class: 'panel-in', 'data-panel-act': row.id },
    panelHead(row.what, chip(row.status, row.past ? row.result : undefined)),
    kv([
      ['시각', row.at],
      ['프로필', row.profile === '사업자' ? `사업자 · ${state.boot.profiles.business.name}` : `개인 · ${state.boot.profiles.personal.name}`],
      ['포털', row.portal],
      r?.result ? ['승인번호', r.result.approvalNo, { mono: true }] : row.past?.approvalNo ? ['승인번호', row.past.approvalNo, { mono: true, copy: () => act.copy(row.past.approvalNo) }] : null,
      row.past?.total != null ? ['합계', `${num(row.past.total)}원 (공급가액 ${num(row.past.supply)} + 세액 ${num(row.past.tax)})`] : null,
    ]),
    noteGroup([r?.stoppedNote, row.past?.note], r?.status === 'attention' || row.past?.kind === 'unsure'),
    row.past?.kind === 'issued'
      ? row.past.documentId
        ? h('div', { class: 'sx-actions' }, btn('PDF 열기', () => act.openDoc(row.past.documentId), '', { 'data-act': 'past-pdf' }))
        : note(NO_FILE_TEXT)
      : null,
    h('div', { class: 'sx-panel-sec' }, '어디로 무엇이 갔나요'),
    kv(where, true),
    r ? [h('div', { class: 'sx-panel-sec' }, '실행 단계'), steps(runSteps(r))] : null,
  );
}

const SETTINGS_TABS = [
  ['biz', '내 사업장'],
  ['auth', '발급 인증'],
  ['devices', '기기 연결'],
  ['bank', '계좌 연결'],
  ['billing', '구독'],
];
const billing = createBilling({ call, rerender: () => render(), errText: (e) => errText(e) });
const devices = createDevices({
  call,
  rerender: () => state.view === 'settings' && state.setTab === 'devices' && renderKeepCode(),
  errText: (e) => errText(e),
  visible: () => state.view === 'settings' && state.setTab === 'devices',
  signedIn: () => state.account?.step === 'signed_in',
  onAccount: (v) => {
    state.account = v;
    state.login = null;
    render();
  },
  relogin: async () => {
    await signOut();
    if (state.account?.step !== 'signed_in' && !state.login) openLogin();
  },
});
function renderKeepCode() {
  const a = document.activeElement;
  const id = a?.dataset?.pclinkCode;
  render();
  if (id) $(`[data-pclink-code="${CSS.escape(id)}"]`)?.focus();
}
const bankAuto = createBankAuto({ call, rerender: () => render(), toast: (t) => toast(t), uploadFile: () => void go('bank'), openBank: () => void go('bank') });

async function loadCertMemory() {
  try {
    state.certMemory = (await call('certMemory.status', {})).remembered === true;
  } catch {
    state.certMemory = false;
  }
  try {
    state.certName = await call('certName.status', {});
  } catch {
    state.certName = null;
  }
  if (state.view === 'settings') render();
}
function certMemorySaveRow() {
  const input = secretInput({ label: '공동인증서 비밀번호', oninput: () => (state.certMemoryErr = null) });
  const save = h('button', { type: 'submit', class: 'sx-btn sx-btn-lg' }, '저장');
  const form = h('form', { class: 'cert-memory-form', autocomplete: 'off', novalidate: true, 'data-cert-memory-save': '' }, field({ label: '공동인증서 비밀번호', input, after: save, error: state.certMemoryErr }));
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const value = input.value;
    input.value = '';
    if (!value) return fieldError(input, '공동인증서 비밀번호를 넣어 주세요.');
    save.disabled = input.disabled = true;
    state.certMemoryErr = null;
    try {
      state.certMemory = (await call('certMemory.save', { value })).remembered === true;
      toast('인증서 비밀번호를 이 Mac 금고에 저장했어요. 다음 발급부터 앱이 넣어요.');
    } catch {
      state.certMemoryErr = '저장하지 못했어요. 다시 넣어 주세요.';
    }
    render();
  });
  return h(
    'div',
    { class: 'sx-card auth-row', 'data-cert-memory': '' },
    h('span', { class: 'opt-main' }, h('span', { class: 'auth-name' }, '인증서 비밀번호 저장'), h('span', { class: 'sx-meta' }, '이 Mac 금고에만 두고 발급할 때 앱이 넣어요. 홈택스가 틀렸다고 하면 지워요.'), form),
  );
}
async function forgetCertMemory() {
  try {
    state.certMemory = (await call('certMemory.forget', {})).remembered === true;
    toast('기억한 인증서 비밀번호를 지웠어요. 다음 발급 때 한 번 다시 넣어 주세요.');
  } catch {
    toast('다시 해 주세요');
  }
  render();
}

async function clearCertName() {
  try {
    state.certName = await call('certName.clear', {});
    toast('기억한 인증서를 지웠어요. 다음 발급 때 홈택스 인증서 창에서 한 번 골라 주세요.');
  } catch {
    toast('다시 해 주세요');
  }
  render();
}

function setTab(tab) {
  state.setTab = tab;
  render();
  if (tab === 'auth') void loadCertMemory();
  if (tab === 'devices') void refreshAccount().then(() => devices.load());
  if (tab === 'bank') void bankAuto.load();
  if (tab === 'billing') void billing.load();
}

async function refreshAccount() {
  try {
    state.account = await call('account.view', {});
  } catch {
    state.account = { step: 'unavailable', email: null, codeExpiresAt: null, error: null };
  }
  render();
  if (state.account?.step === 'signed_in') await loadDeletion();
}

async function loadDeletion() {
  try {
    const r = await call('account.deletion', {});
    state.deletion = { deleteAfter: r.deleteAfter ?? null, confirm: false };
  } catch {
    state.deletion = null;
  }
  if (state.view === 'settings') render();
}
async function deletionAct(method) {
  try {
    const r = await call(method, {});
    state.deletion = { deleteAfter: r.deleteAfter ?? null, confirm: false };
    toast(r.deleteAfter ? '탈퇴를 요청했어요. 7일 안에 취소할 수 있어요.' : '탈퇴를 취소했어요.');
  } catch (err) {
    toast(accountErrText(errText(err)));
  }
  render();
}
const ymd = (ms) => {
  const d = new Date(ms);
  return `${d.getFullYear()}년 ${d.getMonth() + 1}월 ${d.getDate()}일`;
};
function deletionRow() {
  const d = state.deletion;
  if (state.account?.step !== 'signed_in' || !d) return null;
  const meta = (t) => h('p', { class: 'sx-meta' }, t);
  if (d.deleteAfter)
    return h(
      'div',
      { class: 'sx-card', 'data-account-delete': 'pending' },
      h('div', { class: 'sx-card-hd' }, h('div', { class: 'sx-card-title' }, '탈퇴 예정')),
      meta(`${ymd(d.deleteAfter)}에 계정 정보가 지워져요. 구독은 해지돼 다음 결제가 없어요. 그 전에는 취소할 수 있어요.`),
      h('div', { class: 'sx-actions' }, btn('탈퇴 취소', () => deletionAct('account.deleteCancel'), 'sx-btn-primary', { 'data-act': 'account-delete-cancel' })),
    );
  if (d.confirm)
    return h(
      'div',
      { class: 'sx-card', 'data-account-delete': 'confirm' },
      h('div', { class: 'sx-card-hd' }, h('div', { class: 'sx-card-title' }, '정말 탈퇴할까요?')),
      meta('구독이 바로 해지되고, 7일 뒤 서버의 계정 정보(이메일·기기·결제 참조)가 지워져요. 7일 안에는 취소할 수 있어요.'),
      meta('이 Mac에 있는 사업장·거래처·발급 기록은 앱을 지우기 전까지 그대로 남아요.'),
      h('div', { class: 'sx-actions' }, btn('탈퇴하기', () => deletionAct('account.delete'), 'sx-btn-primary', { 'data-act': 'account-delete' }), btn('그만두기', () => ((state.deletion = { ...d, confirm: false }), render()), 'sx-btn-quiet', { 'data-act': 'account-delete-back' })),
    );
  return h('p', { class: 'onb-links', 'data-account-delete': 'none' }, btn('탈퇴', () => ((state.deletion = { ...d, confirm: true }), render()), 'sx-btn-quiet', { 'data-act': 'account-delete-open' }));
}

function openLogin() {
  state.login = { screen: 'email', draft: { email: state.account?.email ?? '', password: '', code: '', show: false }, busy: false };
  render();
}

function loginGate() {
  if (!state.boot?.loginRequired) return false;
  if (state.onb && state.onb.consents?.terms?.choice !== 'agreed') return false;
  return state.account?.step !== 'signed_in';
}

async function signOut() {
  try {
    state.account = await call('account.signOut', {});
    state.login = null;
    render();
  } catch (err) {
    toast(accountErrText(errText(err)));
  }
}

function pairRow() {
  return pairSection(state.pair, PAIR_ACT, state.pairBusy, Date.now(), pairModalOpen());
}
function pairModalOpen() {
  const step = state.pair?.step;
  if (step === 'awaiting_sas' || step === 'checking') state.pairSas = true;
  else if (step !== 'paired' && step !== 'failed') state.pairSas = false;
  return state.view === 'settings' && state.setTab === 'devices' && pairInModal(state.pair, state.pairSas);
}
async function pairCall(method, params = {}) {
  if (state.pairBusy) return;
  const prev = state.pair?.step;
  state.pairBusy = true;
  pairRender(prev);
  try {
    state.pair = await call(method, params);
    if (method === 'pair.submit' && state.pair?.error) {
      state.pairCode = '';
      state.pairShake = true;
    }
  } catch (err) {
    toast(pairErrText(errText(err)));
  } finally {
    state.pairBusy = false;
    pairRender(prev);
  }
}
const PAIR_ACT = {
  open: () => ((state.pairCode = ''), pairCall('pair.open')),
  retry: () => ((state.pairCode = ''), pairCall('pair.retry')),
  cancel: () => ((state.pairCode = ''), pairCall('pair.cancel')),
  submit: (code) => pairCall('pair.submit', { code: String(code).slice(0, 6) }),
  codeOf: () => state.pairCode,
  setCode: (v) => (state.pairCode = v),
};
function pairRender(prevStep) {
  if (state.view !== 'settings' || state.setTab !== 'devices') return;
  render();
  const step = state.pair?.step;
  if (prevStep && prevStep !== step && (step === 'idle' || !step)) $('[data-act=pair-open]')?.focus();
}
setInterval(() => {
  const t = document.querySelector('[data-pair-ttl]');
  if (t) t.textContent = pairTtlText(Number(t.dataset.pairTtl));
  const l = document.querySelector('[data-pair-left]');
  if (l) l.textContent = pairLeftText(Number(l.dataset.pairLeft));
}, 1000);

function closeLogin() {
  if (!state.login) return;
  if (loginGate()) return;
  state.login = null;
  render();
  $('[data-act=account-login]')?.focus();
}

const SERVER_CODE_ERR = new Set(['account.code_invalid', 'account.code_locked', 'account.code_expired']);

async function accountStep(method, params) {
  const l = state.login;
  if (!l || l.busy) return;
  l.busy = true;
  render();
  try {
    state.account = await call(method, params);
    if (method !== 'account.verify' && method !== 'account.finishReset') l.draft.code = '';
  } catch (err) {
    state.account = { ...(state.account ?? { step: 'signed_out', email: null, codeExpiresAt: null }), error: errText(err) };
  } finally {
    l.busy = false;
    if (method === 'account.password' || method === 'account.setPassword' || method === 'account.finishReset') l.draft.password = '';
    if (method === 'account.startReset' && state.account?.step === 'reset_code') l.screen = 'reset_code';
    if (method === 'account.finishReset' && SERVER_CODE_ERR.has(state.account?.error)) {
      l.screen = 'reset_code';
      l.draft.code = '';
    }
    if ((method === 'account.setPassword' || method === 'account.finishReset') && state.account?.error === 'account.password_contains_identity' && l.pwKind === 'service') state.account = { ...state.account, error: 'account.password_contains_service' };
    if (method === 'account.password' && state.account?.error === 'request.not_found') {
      l.screen = 'code_email';
      state.account = { ...state.account, error: null };
    }
    if (method === 'account.verify' && (SERVER_CODE_ERR.has(state.account?.error) || state.account?.step === 'set_password')) l.draft.code = '';
  }
  if (state.account?.step === 'signed_in' && method === 'account.finishReset') {
    l.screen = 'reset_done';
    l.draft.code = '';
  } else if (state.account?.step === 'signed_in') {
    const later = state.account.error === 'account.password_later';
    state.login = null;
    state.account = { ...state.account, error: null };
    toast(later ? accountErrText('account.password_later') : method === 'account.setPassword' ? '비밀번호를 만들었어요. 다음부터 비밀번호로 로그인해요' : '로그인했어요. 이 PC가 계정에 등록됐어요');
  }
  render();
}

function loginGo(screen) {
  const l = state.login;
  if (!l || l.busy) return;
  l.screen = screen;
  l.draft.password = '';
  l.draft.show = false;
  if (state.account) state.account = { ...state.account, error: null };
  render();
}

const loginCtx = () => ({
  view: state.account ?? { step: 'signed_out', email: null, codeExpiresAt: null, error: null },
  screen: state.login.screen,
  draft: state.login.draft,
  busy: state.login.busy,
  now: () => Date.now(),
  onClose: loginGate() && state.login.screen !== 'reset_done' ? null : closeLogin,
  gate: loginGate(),
  go: loginGo,
  fail: (code) => {
    state.account = { ...(state.account ?? { step: 'signed_out', email: null, codeExpiresAt: null }), error: code };
    render();
  },
  toggleShow: () => {
    state.login.draft.show = !state.login.draft.show;
    render();
    $('#modal .acct-password')?.focus();
  },
  linkAccept: () => accountStep('account.linkAccept', {}),
  linkCancel: () => accountStep('account.linkCancel', {}),
  sendCode: (email) => accountStep('account.sendCode', state.login.screen === 'signup' ? { email, signup: true } : { email }),
  setPassword: (password) => {
    state.login.pwKind = identityIn(password, state.account?.email ?? '');
    return accountStep('account.setPassword', { password });
  },
  skipPassword: () => accountStep('account.skipPassword', {}),
  startReset: (email) => accountStep('account.startReset', { email }),
  finishReset: (code, password) => {
    state.login.pwKind = identityIn(password, state.account?.email ?? '');
    return accountStep('account.finishReset', { code, password });
  },
  verify: (code) => accountStep('account.verify', { code }),
  password: (email, password) => accountStep('account.password', { email, password }),
  back: async () => {
    const s = state.login.screen;
    state.login.screen = s === 'reset_code' || s === 'reset_new' ? 'reset_email' : s === 'signup' ? 'signup' : 'code_email';
    await accountStep('account.back', {});
  },
});

setInterval(() => {
  const el = document.querySelector('[data-acct-left]');
  const at = state.account?.codeExpiresAt;
  if (!el || !at) return;
  const sec = Math.max(0, Math.round((at - Date.now()) / 1000));
  el.textContent = `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
}, 1000);
const AUTH_DESC = {
  '사업자 간편인증': '발급할 때마다 휴대폰에서 승인해요',
  '공동·금융인증서': '홈택스 로그인에 쓰는 그 인증서예요. 첫 발급 때 비밀번호를 한 번 넣으면 다음부터는 앱이 넣어요',
};

function authCard() {
  const auth = state.boot.profiles.business.auth;
  const desc = AUTH_DESC[auth];
  const canChange = state.boot.authReopen;
  return [
    h(
      'div',
      { class: 'sx-card auth-row', 'data-auth-card': '' },
      h('span', { class: 'opt-main' }, h('span', { class: 'auth-name' }, desc ? auth : '발급 인증을 아직 고르지 않았어요'), desc ? h('span', { class: 'sx-meta' }, desc) : null),
      canChange ? btn(desc ? '바꾸기' : '고르기', () => reopenSetup('auth'), '', { 'data-act': 'auth-reopen' }) : null,
    ),
    state.certName?.set
      ? h(
          'div',
          { class: 'sx-card auth-row', 'data-cert-name': '' },
          h('span', { class: 'opt-main' }, h('span', { class: 'auth-name' }, `홈택스 인증서 · ${state.certName.owner}`), h('span', { class: 'sx-meta' }, '홈택스 인증서 창에서 이 인증서를 자동으로 골라요.')),
          btn('지우기', clearCertName, '', { 'data-act': 'cert-name-clear' }),
        )
      : null,
    state.certMemory === true
      ? h(
          'div',
          { class: 'sx-card auth-row', 'data-cert-memory': '' },
          h('span', { class: 'opt-main' }, h('span', { class: 'auth-name' }, '인증서 비밀번호 기억함'), h('span', { class: 'sx-meta' }, '처음 넣은 비밀번호를 이 PC 금고에 두고 다음 발급부터 자동으로 넣어요.')),
          btn('지우기', forgetCertMemory, '', { 'data-act': 'cert-memory-forget' }),
        )
      : state.certMemory === false
        ? certMemorySaveRow()
        : null,
    canChange && desc ? h('p', { class: 'sx-meta', 'data-auth-note': '' }, '바꾸면 다음 발급부터 적용돼요. 진행 중인 작업은 원래 인증으로 끝내요.') : null,
  ];
}

const legalRow = () =>
  h('p', { class: 'onb-links', 'data-legal-row': '' }, btn('이용약관', () => openLegal('terms'), 'sx-btn-quiet', { 'data-legal': 'terms' }), btn('개인정보 처리방침', () => openLegal('privacy'), 'sx-btn-quiet', { 'data-legal': 'privacy' }));
function settingsView() {
  return h(
    'section',
    { class: 'rail-screen settings', 'data-view': 'settings' },
    h(
      'nav',
      { class: 'set-nav', 'aria-label': '설정 항목' },
      h('h1', { class: 'title-screen' }, '설정'),
      SETTINGS_TABS.map(([tab, label]) => {
        const on = tab === state.setTab;
        return h('button', { type: 'button', class: on ? 'is-on' : null, 'aria-current': on ? 'page' : null, 'data-set-tab': tab, onclick: () => setTab(tab) }, label);
      }),
    ),
    state.setTab === 'biz'
      ? bizBody()
      : state.setTab === 'billing'
      ? billing.view()
      : state.setTab === 'bank'
      ? bankAuto.view()
      : state.setTab === 'devices'
      ? h('div', { class: 'set-body' }, waitingChip(), h('div', { class: 'set-intro' }, h('h2', { class: 'sx-card-title' }, '기기 연결'), h('p', { class: 'sx-body-sm is-muted' }, '계정에 연결한 PC와 폰을 보고 끊어요. PC와 폰은 3대씩 연결할 수 있어요.')), devices.gone() ? null : accountCard(state.account, openLogin, pairRow, signOut), ...devices.view(), deletionRow(), legalRow())
      : h('div', { class: 'set-body' }, waitingChip(), h('div', { class: 'set-intro' }, h('h2', { class: 'sx-card-title' }, '발급 인증'), h('p', { class: 'sx-body-sm is-muted' }, '세금계산서를 발급할 때 쓰는 인증이에요.')), authCard()),
  );
}

const LATER = {
  card: ['사업용 카드 내역', 'D-04', '홈택스 사업용 카드 사용내역과 [최신화]가 여기에 들어와요.'],
  payroll: ['급여대장', 'D-06', '직원 목록과 이번 달 급여대장이 여기에 들어와요.'],
};
const laterView = (v) => () => {
  const [title, id, text] = LATER[v];
  return h('section', { class: 'rail-screen', 'data-view': v, 'data-screen': id }, h('div', { class: 'rs-col' }, railHead(title, '준비 중'), h('article', { class: 'sx-card later-card' }, h('p', { class: 'sx-body-sm is-muted' }, text))));
};
const bankUi = createBankScreen({ call, toast: (t) => toast(t), rerender: () => state.view === 'bank' && render(), errText: (e) => errText(e), counterparties: () => state.cps, openCounterparty: null, railHead: (...a) => railHead(...a) });
const packUi = createPackScreen({ call, toast: (t) => toast(t), rerender: () => state.view === 'bundle' && render(), errText: (e) => errText(e), today: () => localDate(state.today), railHead, listTable });
const VIEWS = { bank: () => bankUi.view(), docs: docsView, cps: cpsView, biz: bizView, bundle: () => packUi.view(), card: laterView('card'), payroll: laterView('payroll'), activity: activityView, settings: settingsView };

async function loadCps() {
  state.load.cps = 'loading';
  try {
    state.cps = await call('counterparties.list');
    state.load.cps = null;
  } catch (e) {
    state.load.cps = 'error';
    if (state.cps.length) toast(human(e));
  }
  if (state.view === 'cps' || state.view === 'bank') render();
}
async function loadDocs() {
  const rev = state.docsRev;
  state.load.docs = 'loading';
  try {
    const docs = await call('docs.list');
    state.load.docs = null;
    if (rev !== state.docsRev) return;
    state.docs = docs;
  } catch (e) {
    state.load.docs = 'error';
    if (state.docs.length && state.view === 'docs') toast(human(e));
  }
  if (state.view === 'docs') render();
}
const loadState = (k, what, retry) =>
  state.load[k] === 'loading'
    ? emptyState('불러오는 중이에요', null, null, { 'data-load': k, 'aria-busy': 'true' })
    : state.load[k] === 'error'
      ? emptyState(`${what}을 불러오지 못했어요`, '이 PC의 앱 엔진이 잠시 답하지 않았어요. 넣어 둔 내용은 그대로예요.', btn('다시 시도', retry, 'sx-btn-primary', { 'data-act': `${k}-retry` }), { 'data-load': `${k}-error`, role: 'alert' })
      : null;

async function go(v) {
  if (v === 'biz') {
    state.setTab = 'biz';
    v = 'settings';
    state.boot.profiles = await call('profiles.list').catch(() => state.boot.profiles);
  }
  if (state.view === v && v !== 'docs' && v !== 'settings') return;
  state.view = v;
  const own = { chat: ['run', 'g24', 'board'], docs: ['doc'], cps: ['cp', 'cp-edit'], activity: ['act'] }[v] ?? [];
  if (state.panel && !own.includes(state.panel.kind)) openPanel(null);
  if (v === 'cps' || v === 'bank') {
    render();
    await loadCps();
    if (v === 'bank') await bankUi.load();
  }
  if (v === 'settings' && state.setTab === 'auth') void loadCertMemory();
  if (v === 'bundle') void packUi.load();
  if (v === 'docs') {
    call('issued.list')
      .then((rows) => {
        state.issued = Array.isArray(rows) ? rows : [];
        if (state.view === 'docs') render();
      })
      .catch(() => {});
    void loadDocs();
  }
  if (v === 'chat') {
    const r = [...state.runs.values()].find((x) => ['turn', 'waiting', 'preparing', 'issuing'].includes(x.status));
    if (r) openPanel({ kind: 'run', id: r.id });
    else if (state.panel && state.panel.kind !== 'run' && state.panel.kind !== 'g24') openPanel(null);
  }
  render();
}

function render() {
  renderRail();
  const center = $('#center');
  if (state.view === 'chat') {
    if (center.firstChild !== chat.root) center.replaceChildren(chat.root);
    scrollToEnd();
  } else {
    const prev = center.firstElementChild;
    const keep = prev && prev.dataset?.view === state.view ? prev.scrollTop : 0;
    const el = VIEWS[state.view]();
    center.replaceChildren(el);
    if (keep) el.scrollTop = keep;
  }
  renderPanel();
  renderModal();
}

const lockMark = () => h('span', { class: 'doc-lock', role: 'img', 'aria-label': '열기 암호 있음', title: '열기 암호 있음', 'data-doc-lock': '' }, icon('lock'));

function passwordModal() {
  const imp = state.docImport;
  const input = h('input', { type: imp.show ? 'text' : 'password', class: 'doc-pw', autocomplete: 'off', spellcheck: 'false', 'aria-label': 'PDF 열기 암호' });
  input.value = imp.pw ?? '';
  input.addEventListener('input', () => (imp.pw = input.value));
  const submit = () => {
    if (state.docBusy) return;
    const password = imp.pw ?? '';
    imp.pw = '';
    importDoc({ pickId: imp.pickId, password });
  };
  input.addEventListener('keydown', (e) => e.key === 'Enter' && submit());
  const eye = h('button', { type: 'button', class: 'pw-eye', 'aria-label': imp.show ? '암호 가리기' : '암호 보기', 'aria-pressed': String(!!imp.show), onclick: () => ((imp.show = !imp.show), renderModal()) }, icon(imp.show ? 'eyeOff' : 'eye'));
  return h(
    'div',
    { class: 'modal-scrim' },
    h(
      'section',
      { class: 'modal', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'pw-title', 'data-doc-password': '' },
      h(
        'div',
        { class: 'modal-hd' },
        h('div', { class: 'modal-title' }, h('h2', { class: 'title-screen', id: 'pw-title' }, '열기 암호 넣기'), h('p', { class: 'sx-body-sm is-muted' }, '이 PDF에 열기 암호가 걸려 있어요. 암호는 이번에 열 때만 쓰고 저장하지 않아요.')),
        h('button', { type: 'button', class: 'panel-x', 'aria-label': '닫기', onclick: cancelPassword }, icon('close')),
      ),
      h('label', { class: 'modal-field' }, h('span', { class: 'sx-meta' }, 'PDF 열기 암호'), h('span', { class: 'pw-box' }, input, eye)),
      imp.wrong ? note('암호가 맞지 않아요. 다시 넣어 주세요.', true) : null,
      h('div', { class: 'modal-note' }, icon('lock'), h('span', {}, '이 PC 안에서만 열어요. 암호와 파일 내용은 모델과 우리 서버로 보내지 않아요.')),
      h('div', { class: 'modal-acts' }, btn('취소', cancelPassword, 'sx-btn-lg', { 'data-act': 'doc-password-cancel' }), btn('열기', submit, 'sx-btn-primary sx-btn-lg', { 'data-act': 'doc-password' })),
    ),
  );
}

function renderModal() {
  const root = $('#modal');
  if (loginGate() && !state.login) state.login = { screen: 'email', draft: { email: state.account?.email ?? '', password: '', code: '', show: false }, busy: false };
  const pw = state.view === 'docs' && !!state.docImport && !state.docBusy;
  const login = !pw && !!state.login;
  const pair = !pw && !login && pairModalOpen();
  const dev = !pw && !login && !pair && state.view === 'settings' && state.setTab === 'devices' ? devices.modal() : null;
  const open = pw || login || pair || !!dev;
  const a = document.activeElement;
  const focus = !root.firstChild || !a || a === document.body || root.contains(a);
  const shake = pair && !!state.pairShake;
  state.pairShake = false;
  root.replaceChildren(...(pw ? [passwordModal()] : login ? [loginScreen(loginCtx())] : pair ? [pairModal(state.pair, PAIR_ACT, state.pairBusy, Date.now(), shake)] : dev ? [dev] : []));
  $('#app').inert = open;
  if (dev) {
    if (focus) root.querySelector('[data-act=device-confirm-back], [data-act=px-confirm-back]')?.focus();
    return;
  }
  if (pair) {
    if (focus || shake) (root.querySelector('.sas-box:not(:disabled)') ? root.querySelectorAll('.sas-box')[Math.min(state.pairCode.length, 5)] : root.querySelector('.modal-acts .sx-btn-primary:not(:disabled)'))?.focus();
    return;
  }
  const i = open && focus ? root.querySelector(pw ? '.doc-pw' : '.acct-code, .acct-password, .acct-email, [data-act=account-reset-done]') : null;
  if (i) {
    i.focus();
    if (i.type !== 'email') i.setSelectionRange(i.value.length, i.value.length);
  }
}

function cancelPassword() {
  if (!state.docImport || state.docBusy) return;
  call('docs.importCancel', { pickId: state.docImport.pickId }).catch(() => {});
  state.docImport = null;
  render();
  $('[data-act=doc-import]')?.focus();
}

async function importDoc(input) {
  if (state.docBusy) return;
  const { g24: g24Id, ...params } = input;
  if (g24Id) state.g24Import = g24Id;
  else if (params.pick) state.g24Import = null;
  if (params.pick && state.docImport) cancelPassword();
  state.docBusy = true;
  render();
  try {
    const r = await call('docs.import', params);
    if (!r) return;
    if (r.status === 'needs_password' || r.status === 'wrong_password') {
      state.docImport = { pickId: r.pickId, wrong: r.status === 'wrong_password', pw: '' };
      if (state.view !== 'docs') toast('열기 암호가 필요해요. 문서함에서 넣어 주세요');
      return;
    }
    state.docImport = null;
    const d = r.doc;
    if (params.password) state.docLocked.add(d.id);
    state.docsRev++;
    state.docs = [d, ...state.docs.filter((x) => x.id !== d.id)];
    const g24 = state.g24Import ? state.g24.get(state.g24Import) : null;
    state.g24Import = null;
    if (g24 && g24.stage === 'pick') {
      g24.stage = 'saved';
      renderG24(g24);
    }
    const msg = r.document?.duplicate ? '이미 보관함에 있는 파일이에요' : d.vault?.needsUser ? '보관함에 넣었어요. 확인할 칸이 있어요' : '보관함에 넣었어요';
    if (state.view === 'docs') {
      toast(msg);
      openPanel({ kind: 'doc', id: d.id });
    } else toast(`${msg} · 문서함에서 볼 수 있어요`);
  } catch (e) {
    state.docImport = null;
    toast(docErr(e));
  } finally {
    state.docBusy = false;
    renderRail();
    renderToday();
    render();
  }
}

const DOC_CONFIRM_HOLD_MS = 700;

async function updateDoc(id, patch, seen) {
  if (state.docUpdating) return;
  state.docUpdating = true;
  try {
    const d = await call('docs.update', { id, patch, seen });
    state.docsRev++;
    state.docs = state.docs.map((x) => (x.id === d.id ? d : x));
    if (state.docDraft?.id === id) state.docDraft = null;
    toast(d.vault?.needsUser ? `저장했어요. ${d.vault.reasons.includes('expiry_recomputed') ? '다시 계산한 만료일을' : '남은 칸을'} 확인해 주세요` : '확인했어요');
  } catch (e) {
    const at = DOC_ERR_FIELD[errText(e)];
    if (at && state.docDraft?.id === id) state.docDraft.err = { field: at, text: docErr(e) };
    else toast(docErr(e));
    if (errText(e) === 'stale') {
      const rev = ++state.docsRev;
      await call('docs.list')
        .then((docs) => {
          if (rev === state.docsRev) state.docs = docs;
        })
        .catch(() => {});
      if (state.docDraft?.id === id) state.docDraft = null;
    }
  } finally {
    state.docUpdating = false;
    renderRail();
    renderToday();
    render();
  }
}

function docDraft(doc) {
  if (state.docDraft?.id !== doc.id) {
    const seen = { docType: doc.vault.docType, issuedOn: doc.issuedOn, expiresOn: doc.expiresOn };
    const noExpiry = doc.expiresOn === null && seen.docType !== 'national_tax_cert';
    state.docDraft = { id: doc.id, seen, createdAt: Date.now(), docType: seen.docType, issuedOn: doc.issuedOn ?? '', expiresOn: doc.expiresOn ?? '', noExpiry };
  }
  return state.docDraft;
}

function docReview(doc) {
  const v = doc.vault;
  const draft = docDraft(doc);
  const canClear = draft.docType !== 'national_tax_cert';
  const noExpiryOn = draft.noExpiry && canClear;
  const src = { text: '텍스트에서 읽음', ocr: '그림에서 읽음(OCR)', scan: '스캔 글자 층에서 읽음' }[v.textSource];
  const errFor = (f) => (draft.err?.field === f ? draft.err.text : null);
  const typeSel = selectInput(
    [['national_tax_cert', '납세증명서(국세)'], ['biz_registration_cert', '사업자등록증명'], ['other', '그 밖의 서류']],
    { value: draft.docType, compact: true, 'data-field': 'docType' },
  );
  typeSel.addEventListener('change', () => {
    draft.docType = typeSel.value;
    draft.err = null;
    if (draft.docType === 'national_tax_cert') draft.noExpiry = false;
    render();
  });
  const issued = dateInput({ value: draft.issuedOn, compact: true, 'data-field': 'issuedOn' });
  issued.addEventListener('input', () => ((draft.issuedOn = issued.value), (draft.err = null)));
  const expires = dateInput({ value: draft.expiresOn, compact: true, 'data-field': 'expiresOn', disabled: noExpiryOn });
  expires.addEventListener('input', () => ((draft.expiresOn = expires.value), (draft.err = null)));
  const noExpiry = canClear ? h('input', { type: 'checkbox', checked: noExpiryOn, 'data-field': 'noExpiry' }) : null;
  noExpiry?.addEventListener('change', () => {
    draft.noExpiry = noExpiry.checked;
    draft.err = null;
    render();
  });
  const hints = [
    v.suggested.issuedOn && v.suggested.issuedOn !== draft.issuedOn ? `발급일 후보 ${v.suggested.issuedOn}` : null,
    v.suggested.validUntil && v.suggested.validUntil !== draft.expiresOn ? `문서 유효기간 후보 ${v.suggested.validUntil}` : null,
  ].filter(Boolean);
  const held = () => Date.now() - draft.createdAt < DOC_CONFIRM_HOLD_MS;
  const save = () => {
    if (state.docUpdating || held()) return;
    if (issued.validity.badInput) return fieldError(issued, '날짜를 끝까지 넣어 주세요.');
    if (expires.validity.badInput) return fieldError(expires, '날짜를 끝까지 넣어 주세요.');
    if (!draft.issuedOn && doc.issuedOn) return fieldError(issued, '발급일을 넣어 주세요.');
    if (!noExpiryOn && !draft.expiresOn && doc.expiresOn) return fieldError(expires, canClear ? "만료일을 넣거나 '만료일 없음'을 골라 주세요." : '만료일을 넣어 주세요.');
    draft.err = null;
    const patch = {};
    if (draft.docType !== draft.seen.docType) patch.docType = draft.docType;
    if (draft.issuedOn && draft.issuedOn !== draft.seen.issuedOn) patch.issuedOn = draft.issuedOn;
    if (noExpiryOn) {
      if (draft.seen.expiresOn !== null) patch.expiresOn = null;
    } else if (draft.expiresOn && draft.expiresOn !== draft.seen.expiresOn) patch.expiresOn = draft.expiresOn;
    confirmBtn.disabled = true;
    updateDoc(doc.id, patch, draft.seen);
  };
  const confirmBtn = btn(v.needsUser || v.expirySource === 'rule' ? '확인' : '저장', save, 'sx-btn-primary', { 'data-act': 'doc-confirm', disabled: state.docUpdating || held() });
  if (held()) {
    const wait = DOC_CONFIRM_HOLD_MS - (Date.now() - draft.createdAt);
    setTimeout(() => {
      if (confirmBtn.isConnected && !state.docUpdating) confirmBtn.disabled = false;
    }, wait + 20);
  }
  return h(
    'div',
    { class: 'doc-review', 'data-doc-review': doc.id },
    kv([
      ['발급기관', v.issuer],
      ['발급번호', v.docNo, { mono: true }],
      ['읽은 곳', src],
    ]),
    v.needsUser ? note(v.reasons.map((r) => DOC_REASON[r]).filter(Boolean).join(' · ') || '값을 확인해 주세요', true, 'PDF를 열어 값을 맞춰 보고 확인을 눌러 주세요.') : null,
    !v.needsUser && v.subjectMismatch ? note('내 사업장과 사업자번호가 다른 서류예요(확인함).') : null,
    h(
      'div',
      { class: 'doc-form' },
      field({ label: '종류', input: typeSel, error: errFor('docType') }),
      field({ label: '발급일', input: issued, error: errFor('issuedOn') }),
      field({ label: '만료일', input: expires, error: errFor('expiresOn') }),
      noExpiry ? h('label', { class: 'doc-check' }, noExpiry, h('span', { class: 'sx-meta' }, '만료일 없음(제출처가 요구하지 않음)')) : null,
    ),
    hints.length
      ? h(
          'div',
          { class: 'sx-meta doc-hint', 'data-doc-hint': '' },
          `${hints.join(' · ')} (PDF에서 확인하세요) `,
          btn(
            '후보 넣기',
            () => {
              if (v.suggested.issuedOn) draft.issuedOn = v.suggested.issuedOn;
              if (v.suggested.validUntil) {
                draft.expiresOn = v.suggested.validUntil;
                draft.noExpiry = false;
              }
              render();
            },
            'sx-btn-quiet',
            { 'data-act': 'doc-use-suggested' },
          ),
        )
      : null,
    h(
      'div',
      { class: 'sx-actions' },
      confirmBtn,
      btn('PDF 열기', () => call('docs.open', { id: doc.id }).catch((e) => toast(docErr(e))), '', { 'data-act': 'doc-open' }),
    ),
  );
}

function addDoc(doc) {
  state.docsRev++;
  if (!state.docs.find((d) => d.id === doc.id)) state.docs.unshift(doc);
  renderRail();
  renderToday();
  if (state.view === 'docs') render();
}

let lastPointerDown = { t: 0, el: null };
document.addEventListener('pointerdown', (e) => (lastPointerDown = { t: performance.now(), el: e.target }), true);
const AGAIN_TEXT = '창을 앞으로 가져오는 클릭이었어요. 한 번 더 눌러 주세요.';
function onActivated(x, y) {
  const b = document.elementFromPoint(x, y)?.closest('button');
  const card = b?.closest('[data-run]');
  if (!b || !card || !['turn', 'waiting'].includes(card.dataset.status)) return;
  const at = performance.now();
  setTimeout(() => {
    if (lastPointerDown.t >= at && b.contains(lastPointerDown.el)) return;
    if (!b.isConnected || card.querySelector('[data-again]')) return;
    card.append(h('p', { class: 'sx-meta is-attention', 'data-again': '' }, AGAIN_TEXT));
  }, 400);
}

window.sax.onEvent((ev) => {
  if (ev.type === 'activated') return onActivated(ev.x, ev.y);
  if (ev.type === 'open' && ev.to === 'run' && typeof ev.id === 'string') return void boardGo({ to: 'run', id: ev.id });
  if (ev.type === 'say' && typeof ev.text === 'string') return void appendThread(h('div', { class: 'sx-app' }, ev.text.slice(0, 300)));
  if (ev.type === 'bankAuto') return bankAuto.onEvent(ev.event);
  if (ev.type === 'pair') {
    const prev = state.pair?.step;
    state.pair = ev.pair;
    if (state.pair?.step !== 'awaiting_sas' && state.pair?.step !== 'checking') state.pairCode = '';
    return void pairRender(prev);
  }
  if (ev.type === 'account') {
    state.account = ev.account;
    if (state.view === 'settings' || loginGate()) render();
    return;
  }
  if (ev.type === 'open-screen' && typeof ev.screen === 'string') return void openScreen(ev.screen);
  if (ev.type === 'chat-reaction') return void reactTo(state.lastMe, ev.reaction);
  if (ev.type === 'chat-progress') {
    const el = state.waitEl;
    if (el && Object.hasOwn(PROGRESS_TEXT, ev.phase)) {
      el.setAttribute('aria-label', PROGRESS_TEXT[ev.phase]);
      el.dataset.agentProgress = ev.phase;
      if (!el.isConnected) appendThread(el);
    }
    return;
  }
  if (ev.type === 'browser') {
    const wasLive = state.browser.available;
    state.browser = { shown: ev.shown === true, available: ev.available === true, embedded: ev.embedded === true, width: Number(ev.width) || 0 };
    document.body.classList.toggle('browser-embedded', state.browser.embedded);
    if (state.browser.embedded && state.browser.width > 0) document.documentElement.style.setProperty('--l-browser', `${state.browser.width}px`);
    document.body.classList.toggle('browser-live', state.browser.available);
    document.body.classList.toggle('browser-big', state.browser.available && state.browser.shown);
    renderTitlebar();
    if (wasLive !== state.browser.available) renderPanel();
    else {
      const size = document.querySelector('[data-act=browser-size]');
      const big = state.browser.shown;
      if (size && size.getAttribute('aria-pressed') !== String(big)) {
        size.setAttribute('aria-pressed', String(big));
        size.title = big ? '브라우저 작게' : '브라우저 크게';
        size.setAttribute('aria-label', size.title);
        size.replaceChildren(icon(big ? 'shrink' : 'expand'));
        size.onclick = () => act.browserSize(!big);
      }
    }
    if (ev.focus) focusScreen();
    return;
  }
  if (ev.type === 'secretAsk') return onSecretAsk(ev);
  if (ev.type === 'screen') {
    if (ev.ended) {
      if (state.screen?.runId === ev.runId) state.screen = null;
      return;
    }
    const was = state.screen?.runId === ev.runId ? state.screen : { runId: ev.runId, frame: null, paused: false };
    state.screen = { ...was, ...(ev.gone ? { gone: true } : {}), ...(ev.frame ? { frame: ev.frame, paused: false, gone: false } : {}), ...(typeof ev.paused === 'boolean' ? { paused: ev.paused } : {}), ...(typeof ev.url === 'string' && ev.url ? { url: ev.url } : {}) };
    const addr = document.getElementById('browser-addr');
    if (addr && state.screen.url && addr.title !== state.screen.url) {
      addr.title = state.screen.url;
      addr.replaceChildren(...browserUrlParts(state.screen.url).filter(Boolean));
      const tab = document.getElementById('browser-tab-title');
      if (tab) tab.textContent = browserTabTitle(state.screen.url);
      tab?.parentElement?.setAttribute('title', state.screen.url);
    }
    paintScreen();
    return;
  }
  if (ev.type === 'run') {
    const prev = state.runs.get(ev.run.id);
    putRun(ev.run);
    if (prev?.status !== 'waiting' && ev.run.status === 'waiting' && state.view === 'chat') openPanel({ kind: 'run', id: ev.run.id });
    const batchOpen = ev.run.batch && [...state.runs.values()].some((x) => x.batch?.id === ev.run.batch.id && (['preparing', 'turn', 'waiting', 'issuing'].includes(x.status) || (x.status === 'draft' && x.batch.approved && !x.batch.skipped && !x.batch.halted)));
    if (prev?.status !== 'done' && ev.run.status === 'done' && !batchOpen) appendThread(h('div', { class: 'sx-app' }, '다음 일을 말해 주세요.'));
  } else if (ev.type === 'bar') {
    state.barActive = ev.active;
    if (ev.active) setBarHeight(ev.height);
    document.body.classList.toggle('bar-active', ev.active);
    document.body.classList.toggle('bar-band', !!ev.band);
    autoGrow();
    if (state.view === 'chat') scrollToEnd();
    else render();
  } else if (ev.type === 'bar-layout') {
    document.body.classList.toggle('bar-band', !!ev.band);
    setBarHeight(ev.height);
  } else if (ev.type === 'doc') {
    addDoc(ev.doc);
  } else if (ev.type === 'board') {
    state.board = ev.board;
    renderToday();
  } else if (ev.type === 'past') {
    if (state.boot) state.boot.past = ev.past;
    if (state.view !== 'chat') render();
  } else if (ev.type === 'docs-reload') {
    const rev = ++state.docsRev;
    Promise.all([call('docs.list'), call('counterparties.list')])
      .then(([docs, cps]) => {
        if (rev !== state.docsRev) return;
        state.docs = docs;
        state.cps = cps;
        if (state.view !== 'chat') render();
        renderToday();
      })
      .catch(() => {});
  }
});

window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && $('#modal').firstChild) {
    if (state.login) closeLogin();
    else if ($('#modal [data-pair-modal]')) PAIR_ACT.cancel();
    else if ($('#modal [data-device-confirm]')) devices.close();
    else cancelPassword();
    return;
  }
  if (e.key === 'Escape' && state.menu) {
    toggleMenu(false);
    $('#titlebar .tb-co')?.focus();
    return;
  }
  if (e.key === 'Escape' && state.panel && document.activeElement?.tagName !== 'INPUT') openPanel(null);
});
document.addEventListener('mousedown', (e) => {
  if (state.menu && !e.target.closest('.tb-profile')) toggleMenu(false);
});
window.addEventListener('resize', () => {
  applyLayout();
  if (state.barActive) scrollToEnd();
});
new ResizeObserver(() => {
  const w = $('#center').clientWidth;
  const L = state.boot?.layout;
  if (L) document.documentElement.style.setProperty('--col-w', `${Math.min(L.chatMax, w - L.gutter * 2)}px`);
}).observe($('#center'));
const scrollTimers = new WeakMap();
document.addEventListener(
  'scroll',
  (e) => {
    const el = e.target === document ? document.documentElement : e.target;
    if (!(el instanceof Element)) return;
    el.classList.add('is-scrolling');
    clearTimeout(scrollTimers.get(el));
    scrollTimers.set(el, setTimeout(() => el.classList.remove('is-scrolling'), 800));
  },
  { capture: true, passive: true },
);
setInterval(() => {
  state.today = new Date();
  renderToday();
  renderRail();
}, 60_000);

function applyLayout() {}

function setBarHeight(px) {
  const v = Number.isInteger(px) && px > 0 && px <= 600 ? px : state.boot?.layout?.barHeight;
  if (v) document.documentElement.style.setProperty('--l-bar-h', `${v}px`);
}

async function boot() {
  state.boot = await call('shell.bootstrap');
  state.today = new Date();
  state.profile = state.boot.profile;
  state.docs = [...state.boot.docs];
  state.cps = state.boot.counterparties;
  state.board = state.boot.board ?? null;
  state.onb = state.boot.onboarding ?? null;
  const L = state.boot.layout;
  const root = document.documentElement.style;
  for (const [k, v] of Object.entries({ rail: L.rail, panel: L.panel, titlebar: L.titlebar, 'chat-max': L.chatMax, gutter: L.gutter, 'composer-reserve': L.composerReserve, gap: L.gap, 'bar-h': L.barHeight })) root.setProperty(`--l-${k}`, `${v}px`);
  document.body.dataset.platform = state.boot.platform;
  document.body.dataset.sample = String(state.boot.sample !== false);
  applyLayout();
  renderTitlebar();
  buildChat();
  if (state.boot.loginRequired) await refreshAccount();
  render();
  document.body.dataset.ready = '1';
}

void boot();
