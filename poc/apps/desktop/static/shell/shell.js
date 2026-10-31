// PoC-9 데모 셸 렌더러: 메인 대화(단일 세션) · 작업 패널 · 문서함 · 거래처 · 정부24 목업.
// 승인 바는 main이 대화 열 하단(입력창 위)에 따로 그린다. 렌더러는 그 자리를 비우기만 한다(ADR-021).
import { g24Card, g24Panel } from './shell-g24.js';
import { btn, dayLabel, dday, docCard, fmtBiz, h, icon, num, pastCard, runPanel, summaryCard, taskCard } from './shell-views.js';

const call = (m, p) => window.sax.call(m, p);
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

const act = {
  toast,
  open: (id) => openPanel({ kind: 'run', id }),
  openG24: (id) => openPanel({ kind: 'g24', id }),
  closePanel: () => openPanel(null),
  copy: async (text) => {
    await call('clipboard.copy', { text });
    toast('복사했어요');
  },
  prepare: async (id) => {
    const run = await call('run.prepare', { id });
    putRun(run);
    openPanel({ kind: 'run', id });
  },
  vat: async (id, vat) => putRun(await call('draft.update', { id, vat })),
  editAmount: (id) => {
    state.editing = id;
    for (const r of state.runs.values()) renderRun(r);
  },
  saveAmount: async (id, text) => {
    const n = Number(String(text).replace(/[^\d]/g, ''));
    try {
      state.editing = null;
      putRun(await call('draft.update', { id, amount: n }));
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
  again: (run) => fillComposer(`${run.counterparty.name}에 ${num(run.amount)}원 세금계산서 끊고 메일 보내 줘`),
  reissue: (doc) => {
    go('chat');
    fillComposer(doc.kind === '세금계산서' ? `${doc.name.split(' · ')[1] || ''}에 세금계산서 ` : `${doc.docName} 떼 줘`);
  },
  go: (v) => go(v),
  g24Saved: async (id) => {
    const g = state.g24.get(id);
    g.stage = 'pick';
    g.candidates = await call('g24.candidates');
    renderG24(g);
  },
  g24Pick: (id, cid) => {
    const g = state.g24.get(id);
    g.picked = cid;
    renderG24(g);
  },
  g24Save: async (id) => {
    const g = state.g24.get(id);
    const doc = await call('g24.save', { id: g.picked });
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
    h('div', { class: 'sx-search', title: '명령 팔레트는 Phase 1' }, h('span', {}, '검색'), h('span', { class: 'sx-kbd' }, 'Ctrl K')),
    h('span', { class: 'tb-icon', title: '금고 열림' }, icon('lock')),
    h('span', { class: 'tb-dot', title: '폰 연결은 후속' }, '폰 연결 안 됨'),
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
      return h('div', { class: 'sx-me' }, it.text, it.time ? h('span', { class: 'sx-origin' }, it.time) : null);
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
    chat.quick.replaceChildren(...state.boot.quick.map((q) => h('button', { type: 'button', onclick: () => fillComposer(q.text) }, q.label)));
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
  const r = await call('request.send', { text, vat });
  if (r.kind === 'draft') {
    putRun(r.run);
    openPanel({ kind: 'run', id: r.run.id });
  } else if (r.kind === 'g24') {
    const id = `g24-${Date.now()}`;
    const now = new Date();
    const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    const g = { id, stage: 'guide', startedAt: now.toTimeString().slice(0, 5), today, candidates: [], picked: null };
    state.g24.set(id, g);
    appendThread(h('div', { class: 'sx-app' }, '주민등록표 등본은 정부24 서류라 직접 발급해 주셔야 해요. 단계와 넣을 값을 옆에 정리했어요.'));
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
}

function renderToday() {
  if (!chat.today) return;
  const running = [...state.runs.values()].filter((r) => ['preparing', 'turn', 'waiting', 'issuing'].includes(r.status)).length;
  const turn = [...state.runs.values()].filter((r) => r.status === 'turn' || r.status === 'waiting').length;
  const soon = state.docs.filter((d) => {
    const n = dday(d.expiresOn, state.today);
    return n !== null && n <= 7;
  }).length;
  const item = (label, n, cls, onclick) => h('button', { type: 'button', class: `today-item ${n ? cls : ''}`, onclick }, label, ' ', h('b', {}, String(n)));
  chat.today.replaceChildren(
    item('내 차례', turn, 'is-turn', () => {
      const r = [...state.runs.values()].find((x) => x.status === 'turn' || x.status === 'waiting');
      if (r) openPanel({ kind: 'run', id: r.id });
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
    el.replaceChildren(h('div', { class: 'panel-in' }, panelHead('서류'), docCard(doc, state.today, act), docPreview(doc)));
  } else if (p.kind === 'cp') {
    const c = state.cps.find((x) => x.id === p.id);
    el.replaceChildren(
      h(
        'div',
        { class: 'panel-in' },
        panelHead(c.name),
        h('dl', { class: 'sx-kv' }, ...[['사업자번호', fmtBiz(c.bizNo)], ['대표자', c.rep], ['상태', `${c.status} · ${c.checkedOn} 확인`], ['받는 이메일', c.email], ['저장 품목', c.item], ['최근 발급', c.lastIssuedOn || '—']].flatMap(([k, v]) => [h('dt', {}, k), h('dd', {}, h('span', { class: 'sx-val' }, v))])),
        h('div', { class: 'sx-actions' }, btn('세금계산서 발급', () => fillComposer(`${c.name}에 세금계산서 `), 'sx-btn-primary'), btn('지난번과 같게', () => toast('목업: 지난 발급 내용은 PoC-6 원장과 연결해요')), btn('상태 다시 확인', () => toast('목업: 진위확인(H-05)은 PoC-5 화면에 있어요'))),
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
    h('figcaption', { class: 'sx-meta' }, '미리보기 자리(목업). PDF 렌더링은 docparse 샌드박스로 붙여요.'),
  );
}

// ---- 레일 화면 ----

function docsView() {
  const f = state.docFilter;
  const list = state.docs
    .filter((d) => f === 'all' || (f === 'tax' && d.kind === '세금계산서') || (f === 'cert' && d.kind !== '세금계산서') || (f === 'soon' && dday(d.expiresOn, state.today) !== null && dday(d.expiresOn, state.today) <= 7))
    .map((d) => ({ d, n: dday(d.expiresOn, state.today) }))
    // 만료 7일 이내는 맨 위, 나머지는 최근 발급순.
    .sort((a, b) => Number(b.n !== null && b.n <= 7) - Number(a.n !== null && a.n <= 7) || b.d.issuedOn.localeCompare(a.d.issuedOn));
  const fb = (key, label) => h('button', { type: 'button', class: f === key ? 'is-on' : null, 'aria-pressed': String(f === key), onclick: () => ((state.docFilter = key), render()) }, label);
  return h(
    'section',
    { class: 'rail-screen', 'data-view': 'docs' },
    h('div', { class: 'rs-head' }, h('h1', { class: 'title-screen' }, '문서함'), h('div', { class: 'sx-quick' }, fb('all', '전체'), fb('tax', '세금계산서'), fb('cert', '증명서'), fb('soon', '만료 임박')), waitingChip()),
    h(
      'table',
      { class: 'list' },
      h('thead', {}, h('tr', {}, ['표시 이름', '종류', '프로필', '발급일', '만료', '출처'].map((t) => h('th', {}, t)))),
      h(
        'tbody',
        {},
        list.map(({ d, n }) =>
          h(
            'tr',
            { class: state.panel?.id === d.id ? 'is-on' : null, 'data-doc-row': d.id, onclick: () => openPanel({ kind: 'doc', id: d.id }) },
            h('td', { class: 'name' }, d.name),
            h('td', {}, d.kind),
            h('td', {}, d.profile === 'business' ? '사업자' : '개인'),
            h('td', { class: 'num' }, d.issuedOn),
            h('td', { class: `num${n !== null && n <= 7 ? ' is-attention' : ''}` }, n === null ? '—' : `D-${n}`),
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
    h('div', { class: 'rs-head' }, h('h1', { class: 'title-screen' }, '거래처'), h('span', { class: 'sx-meta' }, '등록증 끌어 놓기·번호 입력은 PoC-5 화면에 있어요'), waitingChip()),
    h(
      'table',
      { class: 'list' },
      h('thead', {}, h('tr', {}, ['상호', '사업자번호', '상태', '최근 발급', '이번 달'].map((t) => h('th', {}, t)))),
      h(
        'tbody',
        {},
        state.cps.map((c) =>
          h(
            'tr',
            { class: state.panel?.id === c.id ? 'is-on' : null, onclick: () => openPanel({ kind: 'cp', id: c.id }) },
            h('td', { class: 'name' }, c.name),
            h('td', { class: 'sx-id' }, fmtBiz(c.bizNo)),
            h('td', {}, `${c.status} · ${c.checkedOn.slice(5)}`),
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
  return h('section', { class: 'rail-screen', 'data-view': v }, h('div', { class: 'rs-head' }, h('h1', { class: 'title-screen' }, EMPTY[v][0]), waitingChip()), h('div', { class: 'empty' }, h('div', {}, EMPTY[v][1]), h('div', { class: 'sx-meta' }, 'PoC-9 데모 범위 밖이에요.')));
}

function go(v) {
  if (state.view === v && v !== 'docs') return;
  state.view = v;
  if (v !== 'chat' && (state.panel?.kind === 'run' || state.panel?.kind === 'g24')) openPanel(null);
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
    autoGrow();
    if (state.view === 'chat') scrollToEnd();
    else render();
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

function applyLayout() {
  // main이 준 상수로 바 자리를 비운다. 대화 열이 좁으면 바가 레일 오른쪽부터 창 끝까지 넓어지므로 패널 아래도 비운다.
  const L = state.boot.layout;
  const region = window.innerWidth - L.rail - L.panel;
  document.body.classList.toggle('bar-band', Math.min(L.chatMax, region - L.gutter * 2) < L.barMinWidth);
}

async function boot() {
  state.boot = await call('shell.bootstrap');
  state.today = new Date(state.boot.today);
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
