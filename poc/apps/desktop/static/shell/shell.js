// PoC-9 데모 셸 렌더러: 메인 대화(단일 세션) · 작업 패널 · 문서함 · 거래처 · 정부24 목업.
// 승인 바는 main이 대화 열 하단(입력창 위)에 따로 그린다. 렌더러는 그 자리를 비우기만 한다(ADR-021).
import { g24Card, g24Panel } from './shell-g24.js';
import { btn, dayLabel, dday, docCard, EXPIRY_TAG, fmtBiz, h, icon, kv, note, num, pastCard, runPanel, summaryCard, taskCard } from './shell-views.js';

const call = (m, p) => window.sax.call(m, p);
const localDate = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const ddayText = (n) => (n === null ? '—' : n < 0 ? '만료됨' : n === 0 ? 'D-day' : `D-${n}`);
const $ = (s) => document.querySelector(s);

const state = {
  boot: null,
  today: new Date(),
  view: 'chat',
  profile: 'business',
  runs: new Map(),
  g24: new Map(),
  docs: [],
  cps: [],
  panel: null, // { kind: 'run'|'g24'|'doc'|'cp', id }
  editing: null,
  vat: null,
  barActive: false,
  docFilter: 'all',
  docImport: null, // { pickId, wrong } 열기 암호를 묻는 중
  docBusy: false,
};

// ---- 공용 동작 ----

let toastTimer;
function toast(text) {
  const t = $('#toast');
  t.textContent = text;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), 2400);
}
const errText = (e) => String(e?.message || e).replace(/^Error invoking remote method 'sax': (Error: )?/, '');

// 보관함(문서함) 오류·확인 필요 이유. 엔진·docparse는 코드만 준다.
const DOC_ERR = {
  profile_required: '내 사업장을 먼저 등록해 주세요', not_pdf: 'PDF 파일이 아니에요', input_size: '파일이 비었거나 15MB를 넘어요', read_failed: '파일을 읽지 못했어요',
  invalid_pdf: 'PDF를 열 수 없어요(손상)', timeout: '읽는 데 너무 오래 걸려 멈췄어요', memory_limit: '파일이 너무 커서 멈췄어요', session_failed: '격리된 창을 준비하지 못했어요. 다시 해 주세요',
  pick_expired: '파일을 다시 골라 주세요', password_too_long: '암호가 너무 길어요', schema: '읽은 결과를 확인하지 못했어요',
  issued_in_future: '발급일이 오늘보다 뒤예요', expires_before_issued: '만료일이 발급일보다 앞이에요', expires_after_legal_max: '납세증명서 유효기간은 발급일부터 30일을 넘을 수 없어요',
  invalid_issued_on: '발급일 형식이 아니에요', invalid_expires_on: '만료일 형식이 아니에요', not_found: '보관함에 없는 서류예요',
};
const docErr = (e) => DOC_ERR[errText(e)] || errText(e);
const DOC_REASON = {
  doc_type_unknown: '서류 종류를 알아보지 못했어요',
  issued_on_not_found: '발급일을 찾지 못했어요', issued_on_ambiguous: '발급일 후보가 여러 개예요', issued_on_unparseable: '발급일을 읽지 못했어요',
  issued_on_out_of_range: '발급일이 오늘보다 뒤이거나 너무 일러요', issued_on_uncertain: '발급일 라벨을 못 찾아 위치로 짐작했어요', issued_on_missing: '발급일이 비어 있어요',
  valid_until_not_found: '유효기간을 찾지 못해 30일로 추정했어요', valid_until_ambiguous: '유효기간 후보가 여러 개예요', valid_until_unparseable: '유효기간을 읽지 못했어요',
  valid_until_out_of_range: '적힌 유효기간이 발급일부터 30일 밖이에요', expires_on_missing: '납세증명서 만료일이 비어 있어요', expiry_recomputed: '만료일을 다시 계산했어요',
  read_by_ocr: '글자 층이 없어 그림에서 읽었어요', scanned_text_layer: '스캔 파일에 덧입힌 글자로 읽었어요',
  subject_mismatch: '내 사업장과 사업자번호가 달라요', subject_unverified: '사업자번호를 읽지 못했어요',
};

const act = {
  toast,
  open: (id) => openPanel({ kind: 'run', id }),
  openG24: (id) => openPanel({ kind: 'g24', id }),
  closePanel: () => openPanel(null),
  importDoc: (extra) => importDoc(extra),
  updateDoc: (id, patch) => updateDoc(id, patch),
  copy: async (text) => {
    await call('clipboard.copy', { text });
    toast('복사했어요');
  },
  prepare: async (id) => {
    try {
      putRun(await call('run.prepare', { id }));
      openPanel({ kind: 'run', id });
    } catch (e) {
      toast(errText(e) === 'busy' ? '진행 중인 작업이 끝난 뒤에 시작할 수 있어요' : errText(e));
    }
  },
  vat: async (id, vat) => {
    try {
      putRun(await call('draft.update', { id, vat }));
    } catch (e) {
      toast(errText(e));
    }
  },
  editAmount: (id) => {
    state.editing = id;
    for (const r of state.runs.values()) renderRun(r);
  },
  saveAmount: async (id, text) => {
    try {
      // 금액 해석은 main이 요청 문장과 같은 규칙으로 한다("1억 2천만원"도 그대로 넣을 수 있다).
      putRun(await call('draft.update', { id, amountText: String(text) }));
      state.editing = null;
      renderRun(state.runs.get(id));
    } catch (e) {
      toast(errText(e) === 'bad_amount' ? '금액을 다시 확인해 주세요' : errText(e));
    }
  },
  stop: async (id) => {
    try {
      putRun(await call('run.stop', { id }));
    } catch (e) {
      toast(errText(e) === 'already_issuing' ? '이미 발급을 시작해서 멈출 수 없어요' : errText(e));
    }
  },
  again: (run) => {
    state.vat = run.vat; // 지난번 부가세 방식도 그대로
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
    if (g.stage !== 'guide') return; // 기다리는 동안 그만뒀으면 되살리지 않는다
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
      return toast(errText(e));
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

// ---- 틀: 제목줄·레일 ----

const RAIL = [
  ['chat', '대화', 'chat'],
  ['docs', '문서함', 'docs'],
  ['cps', '거래처', 'cps'],
  ['biz', '내 사업장', 'biz'],
  ['activity', '활동 기록', 'activity'],
];

function renderTitlebar() {
  const p = state.boot.profiles;
  const seg = (kind, label) => h('button', { type: 'button', class: `seg${state.profile === kind ? ' is-on' : ''}`, 'aria-pressed': String(state.profile === kind), 'data-profile': kind, onclick: () => setProfile(kind) }, label);
  $('#titlebar').replaceChildren(
    h('span', { class: 'co' }, '소버린 AX'),
    h('span', { class: 'mock-badge' }, 'PoC 데모 · 목업 데이터'),
    h('div', { class: 'segs', role: 'group', 'aria-label': '프로필' }, seg('business', `사업자 · ${p.business.name}`), seg('personal', `개인 · ${p.personal.name}`)),
    h('div', { class: 'sx-search', title: '검색은 이 데모에 없어요' }, h('span', {}, '검색'), h('span', { class: 'sx-kbd' }, 'Ctrl K')),
    h('span', { class: 'tb-icon', title: '금고 열림' }, icon('lock')),
    h('span', { class: 'tb-dot' }, '폰 연결 안 됨'),
  );
}

async function setProfile(kind) {
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
  const item = ([v, label, ic]) => h('button', { type: 'button', class: state.view === v ? 'is-on' : null, title: label, 'aria-label': label, 'data-view': v, onclick: () => go(v) }, icon(ic), v === 'docs' && soon ? h('b', {}, String(soon)) : null);
  $('#rail').replaceChildren(...RAIL.map(item), h('i'), item(['settings', '설정', 'settings']));
}

// ---- 대화 화면 ----

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
  chat.today = h('div', { class: 'col sx-today', role: 'status' });
  chat.quick = h('div', { class: 'sx-quick', id: 'quick' });
  chat.input = h('textarea', { rows: '1', placeholder: '세금계산서나 증명서를 말해 주세요', 'aria-label': '입력창', id: 'composer' });
  chat.input.addEventListener('input', () => {
    autoGrow();
    renderQuick();
  });
  chat.input.addEventListener('keydown', (e) => {
    // Enter는 보내기, Shift+Enter는 줄바꿈. 한글 조합 중 Enter는 보내지 않는다. 이 입력창의 Enter는 어떤 승인도 하지 않는다.
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      send();
    }
  });
  const sendBtn = h('button', { type: 'button', class: 'sx-send', 'aria-label': '보내기', onclick: send }, icon('send'));
  chat.root = h(
    'section',
    { class: 'chat', 'data-view': 'chat' },
    chat.today,
    chat.scroll,
    h('div', { class: 'quick-zone col' }, chat.quick),
    h('div', { class: 'bar-slot', 'aria-hidden': 'true' }),
    h('div', { class: 'composer-zone' }, h('div', { class: 'col sx-composer' }, h('div', { class: 'sx-input' }, chat.input, sendBtn))),
  );
  for (const item of state.boot.timeline) appendThread(timelineItem(item), false);
  renderQuick();
  renderToday();
}

function timelineItem(it) {
  switch (it.type) {
    case 'day':
      return h('div', { class: 'sx-day' }, dayLabel(it.date));
    case 'me':
      return h('div', { class: 'sx-me' }, it.text, it.time ? h('span', { class: 'sx-meta me-time' }, it.time) : null);
    case 'app':
      return h('div', { class: 'sx-app' }, it.text);
    case 'summary':
      return summaryCard(it);
    case 'past':
      return pastCard(it, act);
  }
  return h('div');
}

function appendThread(el, scroll = true) {
  chat.thread.append(el);
  if (scroll) scrollToEnd();
}
const scrollToEnd = () => requestAnimationFrame(() => (chat.scroll.scrollTop = chat.scroll.scrollHeight));

function autoGrow() {
  const el = chat.input;
  el.style.height = 'auto';
  // 승인 대기 중에는 예약 높이(3줄)까지만 늘어나고 넘치면 입력창 안에서 스크롤한다.
  const max = (state.barActive ? 3 : 6) * 24;
  el.style.height = `${Math.min(el.scrollHeight, max)}px`;
}

function renderQuick() {
  const text = chat.input.value;
  if (/계산서/.test(text)) {
    // T-01: 보내기 전 부가세 [별도] [포함]. 고르지 않으면 별도로 계산한다.
    const t = (mode, label) => h('button', { type: 'button', class: state.vat === mode ? 'is-on' : null, 'aria-pressed': String(state.vat === mode), 'data-vat': mode, onclick: () => ((state.vat = state.vat === mode ? null : mode), renderQuick()) }, label);
    chat.quick.replaceChildren(h('span', { class: 'sx-meta quick-label' }, '부가세'), t('separate', '별도'), t('included', '포함'), h('span', { class: 'sx-meta' }, state.vat ? '' : '고르지 않으면 별도로 계산해요'));
  } else if (!text.trim()) {
    state.vat = null;
    // "곧 지원" 칩은 흐리게 두고 누르면 알림만(08 §4 "할 수 있는 일만 약속한다").
    const chipBtn = (q) => (q.soon ? h('button', { type: 'button', class: 'is-soon', 'aria-disabled': 'true', title: '곧 지원', onclick: () => toast(`${q.label}은 곧 지원돼요. 이 데모에서는 아직 보여 드리지 않아요`) }, q.label, ' · 곧 지원') : h('button', { type: 'button', onclick: () => fillComposer(q.text) }, q.label));
    chat.quick.replaceChildren(...state.boot.quick.map(chipBtn));
  } else {
    chat.quick.replaceChildren();
  }
}

function fillComposer(text) {
  if (state.view !== 'chat') go('chat');
  chat.input.value = text;
  autoGrow();
  renderQuick();
  chat.input.focus();
  chat.input.setSelectionRange(text.length, text.length);
}

async function send() {
  const text = chat.input.value.trim();
  if (!text) return;
  const vat = state.vat;
  chat.input.value = '';
  state.vat = null;
  autoGrow();
  renderQuick();
  appendThread(h('div', { class: 'sx-me' }, text));
  let r;
  try {
    r = await call('request.send', { text, vat });
  } catch (e) {
    toast(errText(e));
    return;
  }
  if (r.kind === 'draft') {
    putRun(r.run);
    openPanel({ kind: 'run', id: r.run.id });
  } else if (r.kind === 'g24') {
    const id = `g24-${Date.now()}`;
    const now = new Date();
    const g = { id, doc: r.doc, stage: 'guide', startedMs: now.getTime(), startedAt: now.toTimeString().slice(0, 5), today: localDate(now), candidates: [], picked: null, saving: false };
    state.g24.set(id, g);
    appendThread(h('div', { class: 'sx-app' }, `${r.doc}은 정부24 서류라 직접 발급해 주셔야 해요. 단계와 넣을 값을 옆에 정리했어요.`));
    renderG24(g);
    openPanel({ kind: 'g24', id });
  } else {
    appendThread(h('div', { class: 'sx-app' }, r.text, r.chips?.length ? h('div', { class: 'sx-quick reply-chips' }, r.chips.map((c) => h('button', { type: 'button', onclick: () => fillComposer(c.text) }, c.label))) : null));
  }
}

function putRun(run) {
  state.runs.set(run.id, run);
  renderRun(run);
  if (state.panel?.kind === 'run' && state.panel.id === run.id) renderPanel();
  renderToday();
}

function renderRun(run) {
  const el = taskCard(run, { ...act, editing: state.editing });
  const old = chat.thread.querySelector(`[data-run="${run.id}"]`);
  if (old) old.replaceWith(el);
  else appendThread(el);
  if (chat.thread.lastElementChild === el || run.status === 'waiting') scrollToEnd();
}

function renderG24(g) {
  const el = g24Card(g, act);
  const old = chat.thread.querySelector(`[data-g24="${g.id}"]`);
  if (old) old.replaceWith(el);
  else appendThread(el);
  if (state.panel?.kind === 'g24' && state.panel.id === g.id) renderPanel();
  renderToday();
}

function renderToday() {
  if (!chat.today) return;
  const g24Open = [...state.g24.values()].filter((g) => g.stage === 'guide' || g.stage === 'pick');
  const running = [...state.runs.values()].filter((r) => ['preparing', 'turn', 'waiting', 'issuing'].includes(r.status)).length + g24Open.length;
  const turn = [...state.runs.values()].filter((r) => r.status === 'turn' || r.status === 'waiting').length + g24Open.length;
  const soon = state.docs.filter((d) => {
    const n = dday(d.expiresOn, state.today);
    return n !== null && n <= 7;
  }).length;
  const item = (label, n, cls, onclick) => h('button', { type: 'button', class: `today-item ${n ? cls : ''}`, onclick }, label, ' ', h('b', {}, String(n)));
  chat.today.replaceChildren(
    item('내 차례', turn, 'is-turn', () => {
      const r = [...state.runs.values()].find((x) => x.status === 'turn' || x.status === 'waiting');
      if (r) openPanel({ kind: 'run', id: r.id });
      else if (g24Open[0]) openPanel({ kind: 'g24', id: g24Open[0].id });
    }),
    item('진행 중', running, '', () => {}),
    item('만료 임박', soon, 'is-attention', () => {
      state.docFilter = 'soon';
      go('docs');
    }),
  );
}

// ---- 작업 패널 ----

function openPanel(p) {
  state.panel = p;
  $('#app').classList.toggle('panel-closed', !p);
  renderPanel();
}

function renderPanel() {
  const el = $('#panel');
  const p = state.panel;
  if (!p) return el.replaceChildren();
  if (p.kind === 'run') {
    const run = state.runs.get(p.id);
    el.replaceChildren(run ? runPanel(run, act) : h('div'));
  } else if (p.kind === 'g24') {
    el.replaceChildren(g24Panel(state.g24.get(p.id), act));
  } else if (p.kind === 'doc') {
    const doc = state.docs.find((d) => d.id === p.id);
    if (!doc) return el.replaceChildren();
    el.replaceChildren(h('div', { class: 'panel-in' }, panelHead('서류'), docCard(doc, state.today, act), doc.vault ? docReview(doc) : docPreview(doc)));
  } else if (p.kind === 'cp') {
    const c = state.cps.find((x) => x.id === p.id);
    el.replaceChildren(
      h(
        'div',
        { class: 'panel-in' },
        panelHead(c.name),
        kv([['사업자번호', fmtBiz(c.bizNo), { mono: true }], ['대표자', c.rep], ['상태', `${c.status} · ${c.checkedOn} 확인`], ['받는 이메일', c.email], ['저장 품목', c.item], ['최근 발급', c.lastIssuedOn || '—']]),
        h('div', { class: 'sx-actions' }, btn('세금계산서 발급', () => fillComposer(`${c.name}에 세금계산서 `), 'sx-btn-primary'), btn('상태 다시 확인', () => toast('목업: 데모에서는 국세청에 조회하지 않아요'))),
      ),
    );
  }
}

/** 레일 화면 머리의 "승인 대기" 줄. 바 바로 옆에 렌더러 버튼을 두지 않으려고 화면 위쪽에 둔다. */
const waitingChip = () => {
  const r = [...state.runs.values()].find((x) => x.status === 'waiting');
  return h('button', { type: 'button', class: 'sx-btn sx-btn-quiet rs-waiting', onclick: () => go('chat') }, r ? `세금계산서 · ${r.counterparty.name} 승인 대기 · 대화로 가기` : '승인 대기 · 대화로 가기');
};

const panelHead = (title) => h('div', { class: 'sx-card-hd' }, h('div', { class: 'sx-card-title' }, title), h('button', { type: 'button', class: 'panel-x', 'aria-label': '패널 닫기', onclick: act.closePanel }, icon('close')));

function docPreview(doc) {
  return h(
    'figure',
    { class: 'paper', 'aria-label': '미리보기(목업)' },
    h('div', { class: 'paper-title' }, doc.docName),
    h('div', { class: 'paper-line w80' }),
    h('div', { class: 'paper-line w60' }),
    h('div', { class: 'paper-line w90' }),
    h('div', { class: 'paper-line w40' }),
    h('figcaption', { class: 'sx-meta' }, '미리보기 자리예요(목업).'),
  );
}

// ---- 레일 화면 ----

function docsView() {
  const f = state.docFilter;
  const list = state.docs
    .filter((d) => f === 'all' || (f === 'tax' && d.kind === '세금계산서') || (f === 'cert' && d.kind !== '세금계산서') || (f === 'soon' && dday(d.expiresOn, state.today) !== null && dday(d.expiresOn, state.today) <= 7))
    .map((d) => ({ d, n: dday(d.expiresOn, state.today) }))
    // 확인 필요는 맨 위, 다음 만료 7일 이내, 나머지는 최근 발급순(발급일이 비면 맨 뒤).
    .sort((a, b) => Number(!!b.d.vault?.needsUser) - Number(!!a.d.vault?.needsUser) || Number(b.n !== null && b.n <= 7) - Number(a.n !== null && a.n <= 7) || (b.d.issuedOn ?? '').localeCompare(a.d.issuedOn ?? ''));
  const fb = (key, label) => h('button', { type: 'button', class: f === key ? 'is-on' : null, 'aria-pressed': String(f === key), onclick: () => ((state.docFilter = key), render()) }, label);
  return h(
    'section',
    { class: 'rail-screen', 'data-view': 'docs' },
    h(
      'div',
      { class: 'rs-head' },
      h('h1', { class: 'title-screen' }, '문서함'),
      h('div', { class: 'sx-quick' }, fb('all', '전체'), fb('tax', '세금계산서'), fb('cert', '증명서'), fb('soon', '만료 임박')),
      btn(state.docBusy ? '읽는 중…' : 'PDF 가져오기', () => importDoc({ pick: true }), 'sx-btn-quiet', { 'data-act': 'doc-import', disabled: state.docBusy }),
      waitingChip(),
    ),
    state.docImport ? passwordRow() : null,
    h(
      'table',
      { class: 'list' },
      h('thead', {}, h('tr', {}, ['표시 이름', '종류', '프로필', '발급일', '만료', '출처'].map((t, i) => h('th', { class: i === 3 || i === 4 ? 'num' : null }, t)))),
      h(
        'tbody',
        {},
        list.map(({ d, n }) =>
          h(
            'tr',
            { class: state.panel?.id === d.id ? 'is-on' : null, 'data-doc-row': d.id, onclick: () => openPanel({ kind: 'doc', id: d.id }) },
            h('td', { class: 'name' }, d.name, d.vault?.needsUser ? h('span', { class: 'doc-flag' }, '확인 필요') : null),
            h('td', {}, d.kind),
            h('td', {}, d.profile === 'business' ? '사업자' : '개인'),
            h('td', { class: 'num' }, d.issuedOn ?? '—'),
            h('td', { class: `num${n !== null && n <= 7 ? ' is-attention' : ''}` }, ddayText(n), d.vault && d.expiresOn ? h('span', { class: 'sx-tag doc-tag' }, EXPIRY_TAG[d.vault.expirySource] ?? '') : null),
            h('td', { class: 'sx-meta' }, d.source),
          ),
        ),
      ),
    ),
    list.length ? null : h('div', { class: 'empty' }, '조건에 맞는 서류가 없어요.'),
    h('div', { class: 'sx-source' }, '디스크의 파일명에는 거래처·승인번호를 넣지 않아요. 알아볼 수 있는 이름은 앱 안에만 있어요.'),
  );
}

function cpsView() {
  const month = `${state.today.getFullYear()}-${String(state.today.getMonth() + 1).padStart(2, '0')}`;
  return h(
    'section',
    { class: 'rail-screen', 'data-view': 'cps' },
    h('div', { class: 'rs-head' }, h('h1', { class: 'title-screen' }, '거래처'), h('span', { class: 'sx-meta' }, '거래처 추가는 이 데모에 없어요'), waitingChip()),
    h(
      'table',
      { class: 'list' },
      h('thead', {}, h('tr', {}, ['상호', '사업자번호', '상태', '최근 발급', '이번 달'].map((t, i) => h('th', { class: i === 3 ? 'num' : null }, t)))),
      h(
        'tbody',
        {},
        state.cps.map((c) =>
          h(
            'tr',
            { class: state.panel?.id === c.id ? 'is-on' : null, onclick: () => openPanel({ kind: 'cp', id: c.id }) },
            h('td', { class: 'name' }, c.name),
            h('td', { class: 'sx-id' }, fmtBiz(c.bizNo)),
            h('td', {}, `${c.status} · ${c.checkedOn} 확인`),
            h('td', { class: 'num' }, c.lastIssuedOn || '—'),
            h('td', {}, c.lastIssuedOn?.startsWith(month) ? '발급함' : '—'),
          ),
        ),
      ),
    ),
  );
}

const EMPTY = {
  biz: ['내 사업장', '사업자 정보, 인증수단, 개인 프로필, 맡긴 업무를 보여 줄 자리예요.'],
  activity: ['활동 기록', '작업별 기록과 모델 호출 여부·전송 바이트를 보여 줄 자리예요.'],
  settings: ['설정', '발급 인증 변경, 승인(Windows Hello), 보관 위치를 둘 자리예요.'],
};

function emptyView(v) {
  return h('section', { class: 'rail-screen', 'data-view': v }, h('div', { class: 'rs-head' }, h('h1', { class: 'title-screen' }, EMPTY[v][0]), waitingChip()), h('div', { class: 'empty' }, h('div', {}, EMPTY[v][1]), h('div', { class: 'sx-meta' }, '이 데모에는 없는 화면이에요.')));
}

async function go(v) {
  if (state.view === v && v !== 'docs') return;
  state.view = v;
  // 패널은 그 화면의 것만 남긴다(대화: 작업, 문서함: 서류, 거래처: 거래처).
  const own = { chat: ['run', 'g24'], docs: ['doc'], cps: ['cp'] }[v] ?? [];
  if (state.panel && !own.includes(state.panel.kind)) openPanel(null);
  if (v === 'cps') state.cps = await call('counterparties.list');
  // 문서함은 지금 목록으로 먼저 그리고, 보관함에서 다시 읽어 오면 다시 그린다(만료 D-n·확인 필요는 main·엔진이 정한다)
  if (v === 'docs')
    call('docs.list')
      .then((docs) => {
        state.docs = docs;
        if (state.view === 'docs') render();
      })
      .catch(() => {});
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
  } else center.replaceChildren(state.view === 'docs' ? docsView() : state.view === 'cps' ? cpsView() : emptyView(state.view));
  renderPanel();
}

// ---- 보관함 가져오기·확인(문서함) ----

/** 열기 암호 줄. 암호는 이 가져오기에만 쓰고 저장하지 않는다. */
function passwordRow() {
  const input = h('input', { type: 'password', class: 'doc-pw', autocomplete: 'off', spellcheck: 'false', placeholder: 'PDF 열기 암호(저장하지 않아요)', 'aria-label': 'PDF 열기 암호' });
  const submit = () => {
    const password = input.value;
    input.value = '';
    importDoc({ pickId: state.docImport.pickId, password });
  };
  input.addEventListener('keydown', (e) => e.key === 'Enter' && submit());
  return h(
    'div',
    { class: 'doc-pw-row', 'data-doc-password': '' },
    note(state.docImport.wrong ? '암호가 맞지 않아요. 다시 넣어 주세요.' : '열기 암호가 걸린 PDF예요.', state.docImport.wrong),
    input,
    btn('열기', submit, 'sx-btn-primary', { 'data-act': 'doc-password' }),
    btn('그만두기', () => {
      call('docs.importCancel', { pickId: state.docImport.pickId }).catch(() => {});
      state.docImport = null;
      render();
    }),
  );
}

async function importDoc(params) {
  if (state.docBusy) return;
  state.docBusy = true;
  render();
  try {
    const r = await call('docs.import', params);
    if (!r) return;
    if (r.status === 'needs_password' || r.status === 'wrong_password') {
      state.docImport = { pickId: r.pickId, wrong: r.status === 'wrong_password' };
      return;
    }
    state.docImport = null;
    const d = r.doc;
    state.docs = [d, ...state.docs.filter((x) => x.id !== d.id)];
    toast(r.document?.duplicate ? '이미 보관함에 있는 파일이에요' : d.vault?.needsUser ? '보관함에 넣었어요. 확인할 칸이 있어요' : '보관함에 넣었어요');
    state.view = 'docs';
    state.panel = { kind: 'doc', id: d.id };
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

async function updateDoc(id, patch) {
  try {
    const d = await call('docs.update', { id, patch });
    state.docs = state.docs.map((x) => (x.id === d.id ? d : x));
    toast(d.vault?.needsUser ? '저장했어요. 다시 계산한 값을 확인해 주세요' : '확인했어요');
    renderRail();
    renderToday();
    render();
  } catch (e) {
    toast(docErr(e));
  }
}

/** 보관함 서류의 읽은 값·확인 필요·확인(수정). 바뀐 칸만 보낸다. 후보는 칸에 넣지 않고 보여만 준다. */
function docReview(doc) {
  const v = doc.vault;
  const src = { text: '텍스트에서 읽음', ocr: '그림에서 읽음(OCR)', scan: '스캔 글자 층에서 읽음' }[v.textSource];
  const typeSel = h(
    'select',
    { class: 'doc-in', 'aria-label': '종류', 'data-field': 'docType' },
    [['national_tax_cert', '납세증명서(국세)'], ['biz_registration_cert', '사업자등록증명'], ['other', '그 밖의 서류']].map(([val, label]) => h('option', { value: val, selected: val === v.docType }, label)),
  );
  const issued = h('input', { type: 'date', class: 'doc-in', value: doc.issuedOn ?? '', 'aria-label': '발급일', 'data-field': 'issuedOn' });
  const expires = h('input', { type: 'date', class: 'doc-in', value: doc.expiresOn ?? '', 'aria-label': '만료일', 'data-field': 'expiresOn' });
  const hints = [v.suggested.issuedOn && !doc.issuedOn ? `발급일 후보 ${v.suggested.issuedOn}` : null, v.suggested.validUntil && !doc.expiresOn ? `유효기간 후보 ${v.suggested.validUntil}` : null].filter(Boolean);
  const save = () => {
    const patch = {};
    if (typeSel.value !== v.docType) patch.docType = typeSel.value;
    if ((issued.value || null) !== doc.issuedOn) patch.issuedOn = issued.value || null;
    if ((expires.value || null) !== doc.expiresOn) patch.expiresOn = expires.value || null;
    updateDoc(doc.id, patch);
  };
  return h(
    'div',
    { class: 'doc-review', 'data-doc-review': doc.id },
    kv([
      ['발급기관', v.issuer],
      ['발급번호', v.docNo, { mono: true }],
      ['읽은 곳', src],
    ]),
    v.needsUser ? note(v.reasons.map((r) => DOC_REASON[r] || r).join(' · ') || '값을 확인해 주세요', true, '값을 PDF와 맞춰 보고 확인을 눌러 주세요.') : null,
    !v.needsUser && v.subjectMismatch ? note('내 사업장과 사업자번호가 다른 서류예요(확인함).') : null,
    h('div', { class: 'doc-form' }, h('label', {}, h('span', { class: 'sx-meta' }, '종류'), typeSel), h('label', {}, h('span', { class: 'sx-meta' }, '발급일'), issued), h('label', {}, h('span', { class: 'sx-meta' }, '만료일'), expires)),
    hints.length
      ? h(
          'div',
          { class: 'sx-meta doc-hint' },
          `${hints.join(' · ')} (PDF에서 확인하세요) `,
          btn('후보 넣기', () => {
            if (!issued.value && v.suggested.issuedOn) issued.value = v.suggested.issuedOn;
            if (!expires.value && v.suggested.validUntil) expires.value = v.suggested.validUntil;
          }, 'sx-btn-quiet'),
        )
      : null,
    h('div', { class: 'sx-actions' }, btn(v.needsUser || v.expirySource === 'rule' ? '확인' : '저장', save, 'sx-btn-primary', { 'data-act': 'doc-confirm' })),
  );
}

function addDoc(doc) {
  if (!state.docs.find((d) => d.id === doc.id)) state.docs.unshift(doc);
  renderRail();
  renderToday();
  if (state.view === 'docs') render();
}

// ---- main 이벤트 ----

window.sax.onEvent((ev) => {
  if (ev.type === 'run') {
    const prev = state.runs.get(ev.run.id);
    putRun(ev.run);
    if (prev?.status !== 'waiting' && ev.run.status === 'waiting' && state.view === 'chat') openPanel({ kind: 'run', id: ev.run.id });
    if (prev?.status !== 'done' && ev.run.status === 'done') appendThread(h('div', { class: 'sx-app' }, '다음 일을 말해 주세요.'));
  } else if (ev.type === 'bar') {
    // 바 자리 비우기: 바 위치는 main이 정하고, 렌더러는 같은 상수로 그 자리를 비울 뿐이다.
    state.barActive = ev.active;
    document.body.classList.toggle('bar-active', ev.active);
    document.body.classList.toggle('bar-band', !!ev.band);
    autoGrow();
    if (state.view === 'chat') scrollToEnd();
    else render();
  } else if (ev.type === 'bar-layout') {
    document.body.classList.toggle('bar-band', !!ev.band);
  } else if (ev.type === 'doc') {
    addDoc(ev.doc);
  }
});

window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && state.panel && document.activeElement?.tagName !== 'INPUT') openPanel(null);
});
window.addEventListener('resize', () => {
  applyLayout();
  if (state.barActive) scrollToEnd();
});
// 대화 열 폭을 #center 폭(스크롤 막대 제외 전)으로 한 번 정해 스크롤 영역 안팎에 같은 폭을 쓴다. main의 바 폭 식과 같다.
new ResizeObserver(() => {
  const w = $('#center').clientWidth;
  const L = state.boot?.layout;
  if (L) document.documentElement.style.setProperty('--col-w', `${Math.min(L.chatMax, w - L.gutter * 2)}px`);
}).observe($('#center'));
// 자정을 넘겨도 D-day·오늘 요약이 맞게 1분마다 오늘을 다시 잡는다.
setInterval(() => {
  state.today = new Date();
  renderToday();
  renderRail();
}, 60_000);

// 바가 띠(레일 오른쪽~창 끝)인지는 main이 'bar'·'bar-layout' 이벤트로 알려 준다. 렌더러는 그대로 따라 패널 아래를 비운다.
function applyLayout() {}

async function boot() {
  state.boot = await call('shell.bootstrap');
  state.today = new Date();
  state.profile = state.boot.profile;
  state.docs = [...state.boot.docs];
  state.cps = state.boot.counterparties;
  const L = state.boot.layout;
  const root = document.documentElement.style;
  for (const [k, v] of Object.entries({ rail: L.rail, panel: L.panel, titlebar: L.titlebar, 'chat-max': L.chatMax, gutter: L.gutter, 'composer-reserve': L.composerReserve, gap: L.gap, 'bar-h': L.barHeight })) root.setProperty(`--l-${k}`, `${v}px`);
  document.body.dataset.platform = state.boot.platform;
  applyLayout();
  renderTitlebar();
  buildChat();
  render();
  document.body.dataset.ready = '1';
}

void boot();
