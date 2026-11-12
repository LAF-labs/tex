// PoC-9 데모 셸 렌더러: 메인 대화(단일 세션) · 작업 패널 · 문서함 · 거래처 · 정부24 목업.
// 승인 카드는 main이 대화 열 하단(입력창 위)에 따로 그린다. 렌더러는 main이 알린 높이만큼 그 자리를 비우기만 한다(ADR-021 결정 7).
import { g24Card, g24Panel } from './shell-g24.js';
import { onboardingView } from './shell-onboarding.js';
import { accountCard, accountErrText, loginScreen } from './shell-account.js';
import { bizEditStart, bizProfileCard } from './shell-biz.js';
import { identityIn } from './password-rules.js';
import { agoText, btn, CHIP, NO_FILE_TEXT, chip, dayLabel, dday, docCard, docPanel, expiryTag, fmtBiz, h, icon, kv, note, num, pastCard, runPanel, runSteps, steps, summaryCard, taskCard, modelRow, serverRow, modelCell, whereRows } from './shell-views.js';

const call = (m, p) => window.sax.call(m, p);
const localDate = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const $ = (s) => document.querySelector(s);

const state = {
  boot: null,
  today: new Date(),
  view: 'chat',
  profile: 'business',
  sending: false,
  runs: new Map(),
  g24: new Map(),
  docs: [],
  cps: [],
  panel: null, // { kind: 'run'|'g24'|'doc'|'cp'|'act', id }
  menu: false, // 제목줄 프로필 메뉴
  editing: null,
  editingFields: null, // 초안 카드의 품목·이메일 칸을 연 run id
  editingCp: null, // 초안 카드의 거래처 고르기를 연 run id
  vat: null,
  fill: [], // 에이전트가 되물을 때 입력창 위에 띄우는 채우기 칩 { label, text, cp }
  composing: false, // 입력창에서 타이핑·클릭을 시작했다(칩을 숨긴다). 보내면 풀린다
  barActive: false,
  board: null, // 이번 달 판(main이 계산, board.ts). 판에는 승인 버튼이 없다(ADR-021·033)
  boardOpen: true, // 판 펼침(접으면 한 줄 요약)
  boardExpanded: new Set(), // "n건 더 보기"로 펼친 카드 종류
  onb: null, // 온보딩(main OnbView). null이면 이미 등록을 마친 사용자
  docFilter: 'all',
  docImport: null, // { pickId, wrong, pw, show } 열기 암호를 묻는 중(문서함 위 모달)
  docLocked: new Set(), // 이번 실행에서 열기 암호로 가져온 서류 id(목록 자물쇠). 엔진은 암호 여부를 저장하지 않는다.
  docBusy: false,
  docDraft: null, // 문서 패널 확인 구역에서 입력 중인 값 { id, seen, createdAt, docType, issuedOn, expiresOn, noExpiry }
  docUpdating: false, // 확인·수정 요청을 기다리는 중(두 번 보내지 않게)
  docsRev: 0, // 가져오기·확인으로 목록을 바꿀 때마다 올린다(그 전에 보낸 docs.list 응답이 새 서류를 덮지 않게)
  setTab: 'auth', // 설정 화면에서 고른 항목: 'auth'(발급 인증) | 'devices'(기기 연결)
  account: null, // 계정 상태(main AccountView): 단계·이메일·코드 만료·오류 코드
  login: null, // 로그인 화면(A-01)이 열려 있으면 { screen, draft: { email, password, code, show }, busy }
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
/** 여러 화면이 같이 쓰는 오류 문장. 표에 없는 코드는 화면에 그대로 보이지 않는다(영어 코드 대신 일반 문장). */
const COMMON_ERR = {
  gesture_required: '버튼을 직접 눌러 주세요.',
  account_required: '먼저 로그인해 주세요.',
  busy: '처리 중이에요. 잠시 뒤에 다시 해 주세요.',
  throttled: '잠시 뒤 다시 눌러 주세요.',
  not_found: '찾지 못했어요. 화면을 다시 열어 주세요.',
  run_active: '발급이 진행 중이라 지금은 할 수 없어요. 끝난 뒤에 해 주세요.',
};
const GENERIC_ERR = '처리하지 못했어요. 잠시 뒤 다시 해 주세요.';
/** 오류 → 사람 말: 그 화면의 표 → 공통 표 → 일반 문장. */
const human = (e, table = {}) => {
  const c = errText(e);
  return table[c] || COMMON_ERR[c] || GENERIC_ERR;
};

// 보관함(문서함) 오류·확인 필요 이유. 엔진·docparse는 코드만 준다.
const DOC_ERR = {
  profile_required: '내 사업장을 먼저 등록해 주세요', not_pdf: 'PDF 파일이 아니에요', input_size: '파일이 비었거나 15MB를 넘어요', read_failed: '파일을 읽지 못했어요',
  invalid_pdf: 'PDF를 열 수 없어요(손상)', timeout: '읽는 데 너무 오래 걸려 멈췄어요', memory_limit: '파일이 너무 커서 멈췄어요', session_failed: '격리된 창을 준비하지 못했어요. 다시 해 주세요',
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
  openDoc: (id) => call('docs.open', { id }).catch((e) => toast(docErr(e))),
  revealDoc: (id) => call('docs.reveal', { id }).catch((e) => toast(docErr(e))),
  // 결과 카드·실행 패널의 [PDF 열기]·[폴더 열기]: 엔진이 보관한 이 실행의 PDF(runId) 줄을 연다. 없으면 홈택스 발급목록 안내(F-04).
  openRunDoc: (run, reveal = false) => runDoc(run).then((d) => (d ? (reveal ? act.revealDoc(d.id) : act.openDoc(d.id)) : toast(NO_FILE_TEXT))),
  supplier: () => state.boot.profiles.business.name,
  open: (id) => openPanel({ kind: 'run', id }),
  openG24: (id) => openPanel({ kind: 'g24', id }),
  closePanel: () => openPanel(null),
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
      toast(c === 'busy' ? '진행 중인 작업이 끝난 뒤에 시작할 수 있어요' : c === 'item_required' ? '품목이 비어 있어요. 카드에서 [품목·이메일 고치기]로 넣고 다시 준비해 주세요.' : c === 'bad_email' ? '받는 이메일 모양이 맞지 않아요. 카드에서 [품목·이메일 고치기]로 고치고 다시 준비해 주세요.' : c === 'chrome.not_installed' ? 'Chrome을 찾지 못했어요. Chrome을 설치한 뒤 다시 눌러 주세요.' : prepareRefusal(c) ?? human(e));
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
    state.editing = id;
    state.editingFields = null;
    state.editingCp = null;
    for (const r of state.runs.values()) renderRun(r);
  },
  // 초안 카드의 [품목·이메일 고치기]: 칸을 열고, [바꾸기]면 main이 검사해 카드 값을 바꾼다(다시 [홈택스에서 준비]로 확인)
  editFields: (id) => {
    state.editingFields = id;
    state.editing = null;
    state.editingCp = null;
    for (const r of state.runs.values()) renderRun(r);
  },
  // 초안 카드의 [거래처 바꾸기](F-14): 장부에서 고르면 main이 받는 이메일·추정 품목을 그 거래처 것으로 바꾼다.
  editCp: (id) => {
    state.editingCp = id;
    state.editing = null;
    state.editingFields = null;
    for (const r of state.runs.values()) renderRun(r);
  },
  saveCp: async (id, counterpartyId) => {
    try {
      putRun(await call('draft.update', { id, counterpartyId: String(counterpartyId) }));
      state.editingCp = null;
      renderRun(state.runs.get(id));
      toast('거래처를 바꿨어요');
    } catch (e) {
      toast(errText(e) === 'no_counterparty' ? '장부에 없는 거래처예요. 거래처 화면에서 확인해 주세요' : '바꾸지 못했어요. 다시 해 주세요');
    }
  },
  saveFields: async (id, item, email) => {
    try {
      putRun(await call('draft.update', { id, item: String(item), email: String(email) }));
      state.editingFields = null;
      renderRun(state.runs.get(id));
      toast('카드 값을 바꿨어요');
    } catch (e) {
      const c = errText(e);
      toast(c === 'item_required' ? '품목을 넣어 주세요. 예: 컨설팅 용역' : c === 'bad_email' ? '이메일 주소 모양이 맞지 않아요' : '바꾸지 못했어요. 다시 해 주세요');
    }
  },
  saveAmount: async (id, text) => {
    try {
      // 금액 해석은 main이 요청 문장과 같은 규칙으로 한다("1억 2천만원"도 그대로 넣을 수 있다).
      putRun(await call('draft.update', { id, amountText: String(text) }));
      state.editing = null;
      renderRun(state.runs.get(id));
    } catch (e) {
      toast(human(e, { bad_amount: '금액을 다시 확인해 주세요' }));
    }
  },
  // 핸드오프 [다 했어요]·[직접 발급함]: 재개·확인으로만 간다(발급하지 않는다). main이 실제 입력 뒤 3초 안에만 받는다.
  resume: (id) => handoffCall('run.resume', id),
  manualDone: (id) => handoffCall('run.manualDone', id),
  stop: async (id) => {
    try {
      putRun(await call('run.stop', { id }));
    } catch (e) {
      toast(human(e, { already_issuing: '이미 발급을 시작해서 멈출 수 없어요' }));
    }
  },
  // [다시 준비]: main이 같은 값의 새 초안을 만든다(발급 전에 멈춘 실행만). 시작은 새 카드의 [홈택스에서 준비]
  redraft: async (id) => {
    try {
      const d = await call('run.redraft', { id });
      putRun(d);
      openPanel({ kind: 'run', id: d.id });
    } catch (e) {
      toast(errText(e) === 'no_counterparty' ? '장부에 없는 거래처예요. 거래처 화면에서 확인해 주세요' : '다시 준비하지 못했어요. 같은 요청을 대화에 다시 말해 주세요');
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

// ---- 틀: 제목줄·레일 ----

const RAIL = [
  ['chat', '대화', 'chat'],
  ['docs', '문서함', 'docs'],
  ['cps', '거래처', 'cps'],
  ['biz', '내 사업장', 'biz'],
  ['bundle', '세무사 꾸러미', 'bundle'],
  // 급여대장(D-06)은 켠 사장님만 보인다(ADR-034 결정 8, 설정 payroll.enabled 기본 끔). 켜는 곳은 설정(M4-4).
  ['payroll', '급여대장', 'payroll', () => !!state.boot?.payrollEnabled],
  ['activity', '활동 기록', 'activity'],
];

/** 제목줄(캔버스 M-01): 프로필(상호 ▾, 사업자/개인 전환 메뉴) · 데모 표시. 창 단추는 Windows 창 틀이 그린다. */
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
    h(
      'div',
      { class: 'tb-profile' },
      h('button', { type: 'button', class: 'tb-co', 'aria-haspopup': 'menu', 'aria-expanded': String(state.menu), onclick: () => toggleMenu() }, cur.name, icon('chevron')),
      state.menu ? h('div', { class: 'menu', role: 'menu', 'aria-label': '프로필' }, h('div', { class: 'menu-label' }, '새 요청에 쓸 프로필'), item('business', `사업자 · ${p.business.name}`), p.personal && !p.personal.placeholder ? item('personal', `개인 · ${p.personal.name}`) : null) : null,
    ),
    // 견본 표시는 시연(fixture)에서만. 제품은 main이 sample: false를 보낸다. replaceChildren은 null을 글자로 넣으므로 펼쳐 넣는다.
    ...(state.boot?.sample === false ? [] : [h('span', { class: 'mock-badge' }, '견본 데이터 · PoC 데모')]),
    // 설치본 자기 점검 warn(미서명 빌드 등, main이 고른 고정 문구).
    ...(state.boot?.build ?? []).map((t) => h('span', { class: 'mock-badge', 'data-build-badge': '' }, t)),
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
  const item = ([v, label, ic]) => h('button', { type: 'button', class: state.view === v ? 'is-on' : null, title: label, 'aria-label': label, 'data-view': v, onclick: () => go(v) }, icon(ic), v === 'docs' && soon ? h('b', {}, String(soon)) : null);
  $('#rail').replaceChildren(...RAIL.filter((r) => !r[3] || r[3]()).map(item), h('i'), item(['settings', '설정', 'settings']));
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
  chat.today = h('section', { class: 'col sx-board', 'aria-label': '이번 달 판', 'data-board': '' });
  chat.handoff = h('div', { class: 'col sx-handoff', role: 'status', 'data-handoff-band': '', hidden: '' });
  chat.quick = h('div', { class: 'sx-quick', id: 'quick' });
  chat.input = h('textarea', { rows: '1', placeholder: '세금계산서나 증명서를 말해 주세요', 'aria-label': '입력창', id: 'composer' });
  chat.input.addEventListener('input', () => {
    state.composing = true;
    autoGrow();
    renderQuick();
  });
  // 입력창을 누르면 칩을 숨겨 쓰는 데 집중하게 한다. 비운 채 떠나면 다시 보인다.
  chat.input.addEventListener('pointerdown', () => ((state.composing = true), renderQuick()));
  chat.input.addEventListener('blur', () => {
    if (chat.input.value.trim()) return;
    state.composing = false;
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
  // 입력창 [+]: 문서함의 PDF 가져오기와 같은 동작(파일 끌어 놓기 자리).
  const attach = h('button', { type: 'button', class: 'sx-attach', 'aria-label': 'PDF 가져오기', title: 'PDF 가져오기', onclick: () => importDoc({ pick: true }) }, icon('plus'));
  chat.root = h(
    'section',
    { class: 'chat', 'data-view': 'chat' },
    chat.handoff,
    chat.today,
    chat.scroll,
    h('div', { class: 'quick-zone col' }, chat.quick),
    h('div', { class: 'bar-slot', 'aria-hidden': 'true' }),
    h('div', { class: 'composer-zone' }, h('div', { class: 'col sx-composer' }, h('div', { class: 'sx-input' }, attach, chat.input, sendBtn))),
  );
  // 온보딩 중이면 대화의 첫 부분이 온보딩이다(08 §4). 끝난 사용자는 지난 타임라인을 그린다.
  if (state.onb) {
    appendThread(h('div', { 'data-onboarding': '' }), false);
    renderOnboarding();
  } else for (const item of state.boot.timeline) appendThread(timelineItem(item), false);
  renderQuick();
  renderToday();
}

// ---- 온보딩(08 §4, M4-2) ----

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
const onbAct = {
  reply: async (step, choice, extra = {}) => {
    try {
      const r = await call('onboarding.reply', { step, choice, ...extra });
      state.onb = r.onboarding;
      if (r.profiles) state.boot.profiles = r.profiles;
      renderOnboarding();
      renderTitlebar();
      renderToday();
      if (r.fill) fillComposer(r.fill);
      // 약관에 동의하면 로그인 화면(loginGate)이 먼저다
      if (loginGate()) renderModal();
      return true;
    } catch (e) {
      toast(ONB_ERR[errText(e)] ?? '다시 해 주세요');
      return false;
    }
  },
  go: (v) => go(v),
  toast,
  rerender: () => renderOnboarding(),
};
/** 온보딩 영역을 지금 상태로 다시 그린다. 약관(④) 동의 전에는 입력창을 막는다(main도 onboarding_terms로 거부한다). */
function renderOnboarding() {
  const old = chat.thread?.querySelector('[data-onboarding]');
  if (!old || !state.onb) return;
  old.replaceWith(onboardingView(state.onb, onbAct));
  const locked = !state.onb.consents.terms;
  chat.input.disabled = locked;
  chat.input.placeholder = locked ? '약관에 동의하면 입력할 수 있어요' : '세금계산서나 증명서를 말해 주세요';
  renderQuick();
  scrollToEnd();
}
const onbActive = () => !!state.onb && state.onb.step !== 'done';

/**
 * 건너뛴 사업자(O-02)·인증(O-03)을 다시 연다([사업자 등록 마치기]·[발급 인증 고르기], 판의 "등록 할 일"). 그 단계만 대화로 묻는다.
 * 지난 온보딩 자리는 기록으로 남기고, 새 자리를 대화 끝에 둔다(다시 연 뒤의 답만 그린다, OnbView.redoFrom).
 */
async function reopenSetup(item) {
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

// 사람이 카드에서 할 일이 있는 동안에는 요청 칩을 숨긴다(카드 버튼에서 시선을 뺏지 않게, 캔버스 M-01).
const BUSY = ['draft', 'preparing', 'turn', 'waiting', 'issuing', 'attention'];
const cardWork = () => [...state.runs.values()].some((r) => BUSY.includes(r.status)) || [...state.g24.values()].some((g) => g.stage === 'guide' || g.stage === 'pick');

/** 많이 쓴 요청 2개. 데모는 빠른 실행 목록의 앞 둘이다(실제로는 활동 기록에서 센다). 누르면 바로 보낸다. */
function prompts() {
  return state.boot.quick
    .filter((q) => !q.soon)
    .slice(0, 2)
    .map((q) => {
      const t = q.text.trim();
      return /줘$/.test(t) ? t : `${t} 발급해 줘`;
    });
}

/** 거래처별 최근 발급 금액(이번 대화의 완료 실행 → 지난 기록 순). 없으면 null. */
function lastAmount(name) {
  const run = [...state.runs.values()].reverse().find((r) => r.status === 'done' && r.counterparty.name === name);
  if (run) return run.amount;
  const past = [...state.boot.timeline].reverse().find((t) => t.type === 'past' && t.who === name);
  return past ? past.supply : null;
}
const won = (n) => (n % 10000 === 0 ? `${n / 10000}만원` : `${num(n)}원`);

/** 되묻기 칩을 채우기 칩으로: 거래처를 물으면 최근 금액을 붙인다("A상사 300만원"). 누르면 입력창에만 채운다. */
function fillChips(chips) {
  return chips.map((c) => {
    const amt = lastAmount(c.label);
    return amt ? { label: `${c.label} ${won(amt)}`, text: `${c.text} ${won(amt)}`, cp: c.label } : { label: c.label, text: c.text, cp: c.label };
  });
}

function renderQuick() {
  // 온보딩 중에는 빠른 실행 칩을 두지 않는다(맡긴 업무를 고른 뒤에 생긴다, 08 §4 O-06). 카드의 칩만 누른다.
  if (onbActive()) return chat.quick.replaceChildren();
  const text = chat.input.value;
  if (/계산서/.test(text)) {
    // T-01: 보내기 전 부가세 [별도] [포함]. 고르지 않으면 별도로 계산한다.
    const t = (mode, label) => h('button', { type: 'button', class: state.vat === mode ? 'is-on' : null, 'aria-pressed': String(state.vat === mode), 'data-vat': mode, onclick: () => ((state.vat = state.vat === mode ? null : mode), renderQuick()) }, label);
    chat.quick.replaceChildren(h('span', { class: 'sx-meta quick-label' }, '부가세'), t('separate', '별도'), t('included', '포함'), h('span', { class: 'sx-meta' }, state.vat ? '' : '고르지 않으면 별도로 계산해요'));
  } else if (!text.trim()) {
    state.vat = null;
    if (state.composing) {
      chat.quick.replaceChildren();
    } else if (state.fill.length) {
      // 되묻기: 최근 보낸 곳. 점선·연필로 바로 보내는 칩과 구분한다.
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

/**
 * [홈택스에서 준비]를 main이 받지 않은 이유(F-07). 결속(버튼 클릭이 실제 입력으로 안 보였다)과 상한(연달아 멈춤·분당 3번)을 나눠 말하고,
 * 상한은 main이 붙인 남은 초(throttled.streak:42)를 보인다. 모르는 코드는 null(공통 문장).
 */
function prepareRefusal(c) {
  if (c === 'gesture_required') return '버튼 클릭을 확인하지 못했어요. [홈택스에서 준비]를 한 번 더 눌러 주세요.';
  const m = /^throttled\.(streak|rate):(\d{1,3})$/.exec(c);
  if (m) return m[1] === 'streak' ? `승인 전에 멈춘 실행이 3번 이어져 1분 쉬었다가 시작해요. ${m[2]}초 뒤에 다시 눌러 주세요.` : `[홈택스에서 준비]는 1분에 3번까지 시작해요. ${m[2]}초 뒤에 다시 눌러 주세요.`;
  return c === 'throttled' ? '조금 뒤에 다시 눌러 주세요.' : null;
}

/** 이 실행이 보관함에 남긴 발급 PDF 줄(#269 runId). 지금 목록에 없으면 한 번 다시 읽는다. */
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

/** 되묻기의 [거래처 추가](F-02·F-03): 거래처 화면의 추가 폼(이름 채움). 저장하면 대화로 돌아와 그 이름을 채운다. */
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
  // 앞 요청의 답을 기다리는 동안(시연 모델은 최대 4초) 새 요청은 입력창에 둔다(되묻기 순서가 꼬이지 않게).
  if (!text || state.sending) return;
  const vat = state.vat;
  chat.input.value = '';
  state.vat = null;
  state.fill = [];
  state.composing = false;
  autoGrow();
  renderQuick();
  appendThread(h('div', { class: 'sx-me' }, text));
  await ask(text, vat);
}

/**
 * 요청 하나를 main에 보내고 답을 그린다. 모델에 닿지 못하면(kind 'unavailable') 의도를 대신 고르지 않고
 * 연결 안 됨 문장과 [다시 시도]를 보인다(정규식 대체 없음, 사용자 결정 2026-11-10). [다시 시도]는 같은 문장·부가세로 다시 보낸다.
 */
async function ask(text, vat) {
  let r;
  state.sending = true;
  const waitEl = h('div', { class: 'sx-app sx-meta' }, '요청을 읽고 있어요…');
  const waitTimer = setTimeout(() => appendThread(waitEl), 300);
  try {
    r = await call('request.send', { text, vat });
  } catch (e) {
    toast(human(e));
    return;
  } finally {
    clearTimeout(waitTimer);
    waitEl.remove();
    state.sending = false;
  }
  if (r.kind === 'unavailable') {
    const box = h('div', { class: 'sx-app', 'data-intent-unavailable': '' }, h('p', {}, r.text));
    appendThread(box);
    // [다시 시도]는 다시 보내서 나아질 때만(연결 안 됨·잠시 뒤). 한도·비밀 값·긴 문장은 문장만.
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
  // 발급에 필요한 등록이 빠졌다(main이 카드를 만들기 전에 막았다): 무엇이 빠졌는지와 그 단계를 다시 여는 버튼
  if (r.kind === 'setup') {
    const box = h('div', { class: 'sx-app', 'data-setup-needed': r.missing.map((m) => m.id).join(' ') }, h('p', {}, r.text));
    box.append(h('div', { class: 'sx-actions' }, ...r.missing.map((m, i) => btn(m.label, () => reopenSetup(m.id), i ? '' : 'sx-btn-primary', { 'data-act': `setup-${m.id}` }))));
    appendThread(box);
    return;
  }
  // 대화 짧은 응대(main이 엔진 chat.respond로 받은 답): 글자는 텍스트 노드로만. 제안 작업 칩은 입력창을 채울 뿐이다(보내고 확인 카드를 거쳐야 시작).
  if (r.kind === 'chat') {
    const box = h('div', { class: 'sx-app', 'data-chat-reply': r.filtered ?? '' }, h('p', {}, r.text));
    if (r.suggest?.length) box.append(h('div', { class: 'sx-actions' }, ...r.suggest.map((c) => btn(c.label, () => fillComposer(c.text), '', { 'data-chat-suggest': c.playbook }))));
    appendThread(box);
    return;
  }
  // 세무 질문이 섞인 요청: 작업은 하고 고정 문구만 보인다(D04 §3). 문구는 main이 정한 고정 값이다.
  if (r.note) appendThread(h('div', { class: 'sx-app sx-meta', 'data-advice-note': '' }, r.note));
  if (r.kind === 'draft') {
    putRun(r.run);
    openPanel({ kind: 'run', id: r.run.id });
  } else if (r.kind === 'g24') {
    const id = `g24-${Date.now()}`;
    const now = new Date();
    const g = { id, doc: r.doc, stage: 'guide', startedMs: now.getTime(), startedAt: now.toTimeString().slice(0, 5), today: localDate(now), candidates: [], picked: null, saving: false, interp: r.via, sent: r.sent };
    state.g24.set(id, g);
    appendThread(h('div', { class: 'sx-app' }, `${r.doc}은 정부24 서류라 직접 발급해 주셔야 해요. 단계와 넣을 값을 옆에 정리했어요.`));
    renderG24(g);
    openPanel({ kind: 'g24', id });
  } else {
    const box = h('div', { class: 'sx-app' }, r.text);
    // 거래처가 없거나 장부에 없는 이름(F-02·F-03): [거래처 추가]는 거래처 화면의 추가 폼을 그 이름으로 연다. 추가하면 대화로 돌아와 그 이름을 입력창에 채운다(되묻기를 잇는다).
    if (r.addCp) box.append(h('div', { class: 'sx-actions' }, btn('거래처 추가', () => addCpFromAsk(r.addCp.name), 'sx-btn-primary', { 'data-act': 'ask-cp-add' })));
    appendThread(box);
    // 되물은 답 후보는 입력창 위 채우기 칩으로 둔다(캔버스 M-01 되묻기).
    state.fill = r.chips?.length ? fillChips(r.chips) : [];
    renderQuick();
  }
}

async function handoffCall(method, id) {
  try {
    putRun(await call(method, { id }));
  } catch (e) {
    const c = errText(e);
    // 엔진이 거절한 코드({ok:false, code})는 사람 말로(#278). 서명 차례의 [직접 발급함]은 화면에 없지만 오면 같은 문장.
    toast(
      c === 'gesture_required'
        ? '버튼을 직접 눌러 주세요.'
        : c === 'not_handed_off'
          ? '이미 이어서 진행하고 있어요'
          : c === 'sign.turn_resume_only'
            ? '서명 차례에는 [다 했어요]만 받아요. 홈택스 창에서 서명을 마쳐 주세요.'
            : c === 'refused' || /^[a-z_]+\.[a-z_.]+$/.test(c)
              ? '지금은 이어서 할 수 없어요. 홈택스 창을 확인한 뒤 다시 눌러 주세요.'
              : '엔진에 알리지 못했어요. 잠시 뒤 다시 눌러 주세요.',
    );
  }
}

/** 핸드오프 띠(D01 실행 뷰): 사람이 필요한 실행이 있으면 대화 열 위에 한 줄. 누르면 그 카드와 패널로 간다. 승인 버튼은 없다. */
function renderHandoff() {
  if (!chat.handoff) return;
  const r = [...state.runs.values()].find((x) => x.status === 'turn' && x.handoff);
  chat.handoff.hidden = !r;
  if (!r) return chat.handoff.replaceChildren();
  chat.handoff.replaceChildren(
    h('span', { class: 'sx-handoff-text' }, `지금 사람이 필요해요 · 세금계산서 · ${r.counterparty.name}`),
    h('button', { type: 'button', class: 'sx-btn sx-btn-quiet', 'data-act': 'handoff-go', onclick: () => {
      openPanel({ kind: 'run', id: r.id });
      chat.thread.querySelector(`[data-run="${r.id}"]`)?.scrollIntoView({ block: 'center' });
    } }, '카드로 가기'),
  );
}

function putRun(run) {
  state.runs.set(run.id, run);
  renderRun(run);
  renderHandoff();
  renderQuick();
  if (state.panel?.kind === 'run' && state.panel.id === run.id) renderPanel();
  renderToday();
}

function renderRun(run) {
  const el = taskCard(run, { ...act, editing: state.editing, editingFields: state.editingFields, editingCp: state.editingCp, counterparties: state.cps });
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
  renderQuick();
}

/**
 * 이번 달 판(08 M-02, ADR-033): main이 계산한 카드 4종(기한 순)을 그린다. 대화 열 맨 위에 두고 접을 수 있다.
 * 판 항목에는 승인 버튼이 없다. 누르면 그 작업 카드·서류·화면으로 옮기거나 입력창에 요청을 채울 뿐이다(보내기는 사람이 한다).
 */
function renderToday() {
  if (!chat.today) return;
  // 온보딩 중에는 판을 두지 않는다(대화가 한 번에 하나씩 묻는다). 끝나면 건너뛴 항목이 판의 할 일로 남는다(08 §4).
  chat.today.hidden = onbActive();
  if (onbActive()) return;
  const b = state.board;
  const items = b ? b.cards.flatMap((c) => c.items) : [];
  const setup = b?.setup ?? [];
  const setupRow = setup.length
    ? h('div', { class: 'board-setup', 'data-board-setup': '' }, h('span', { class: 'sx-meta' }, '등록 할 일'), ...setup.map((x) => h('button', { type: 'button', class: 'board-setup-item', 'data-setup': x.id, onclick: () => (x.id === 'biz' || x.id === 'auth' ? reopenSetup(x.id) : go(x.view)) }, x.label)))
    : null;
  const month = b ? `${Number(b.month.slice(5, 7))}월` : '이번 달';
  const counts = b
    ? [
        ['확인 필요', b.counts.attention, 'is-attention'],
        ['진행 중', b.counts.progress, ''],
        ['만료 임박', b.counts.expiringSoon, 'is-attention'],
      ].filter(([, n]) => n > 0)
    : [];
  const toggle = h('button', { type: 'button', class: 'board-toggle', 'aria-expanded': String(state.boardOpen), 'data-act': 'board-toggle', onclick: () => ((state.boardOpen = !state.boardOpen), renderToday()) }, state.boardOpen ? '접기' : '펼치기', h('span', { class: `board-chev${state.boardOpen ? ' is-open' : ''}` }, icon('chevron')));
  const head = h(
    'div',
    { class: 'board-hd' },
    h('h2', { class: 'board-title' }, `${month} 할 일`),
    h('span', { class: 'sx-meta' }, items.length ? `${items.length}건 · 기한 순` : '챙길 일이 없어요'),
    ...counts.map(([label, n, cls]) => h('span', { class: `board-count ${cls}`.trim() }, h('b', {}, String(n)), ' ', label)),
    items.length ? toggle : null,
  );
  chat.today.classList.toggle('is-closed', !state.boardOpen || !items.length);
  if (!state.boardOpen || !items.length) return chat.today.replaceChildren(head, ...(state.boardOpen && setupRow ? [setupRow] : []));
  chat.today.replaceChildren(head, ...(setupRow ? [setupRow] : []), h('div', { class: 'board-cards' }, ...b.cards.map(boardCard)));
}

/** 판 카드 하나(제목 + 항목 줄). 한 카드에 세 줄까지, 넘치면 "n건 더 보기"로 그 자리에서 펼친다(줄마다 갈 곳이 달라 다른 화면으로 보내지 않는다). */
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

/** 기한 글자: D-n · 오늘 · n일 지남. 7일 안이거나 지났으면 황토. */
function dueText(due) {
  const n = dday(due, state.today);
  if (n === null) return null;
  return { text: n === 0 ? '오늘' : n > 0 ? `D-${n}` : `${-n}일 지남`, soon: n <= 7 };
}

/** 판 항목의 갈 곳. 실행은 작업 패널로, 서류는 문서함 패널로, 요청은 입력창에 채우기만, 화면은 그 화면으로. */
async function boardGo(t) {
  if (t.to === 'run') {
    if (state.view !== 'chat') await go('chat');
    openPanel({ kind: 'run', id: t.id });
    document.querySelector(`[data-run="${CSS.escape(t.id)}"]`)?.scrollIntoView({ block: 'center' });
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

// ---- 작업 패널 ----

/**
 * InDoubt 실행 패널(직접 확인 안내)을 열고 닫을 때 main에 알린다. main은 증언 요청이 무장돼 있으면 그동안만 승인 바 자리에
 * 황토색 확인 바를 띄운다(ADR-021 결정 5). 렌더러는 띄울지 정하지 않고, 확인 결과도 보내지 않는다(바 클릭으로만 받는다).
 */
let incidentId = null;
function syncIncident(p) {
  const next = p?.kind === 'run' && state.runs.get(p.id)?.inDoubt ? p.id : null;
  if (next === incidentId) return;
  if (incidentId) void call('incident.close', { id: incidentId }).catch(() => {});
  incidentId = next;
  // 열기가 실패하면(실제 입력 없이 열린 패널 → gesture_required) 연 것으로 두지 않는다(F-16): 같은 카드를 다시 누르면 다시 연다
  if (next)
    void call('incident.open', { id: next }).catch(() => {
      if (incidentId === next) incidentId = null;
    });
}

function openPanel(p) {
  syncIncident(p);
  // 패널을 닫거나 다른 서류로 옮기면 확인 구역의 입력을 버린다(다시 열었을 때 버린 수정이 되살아나 보내지지 않게)
  if (!(p?.kind === 'doc' && p.id === state.docDraft?.id)) state.docDraft = null;
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
    el.replaceChildren(docPanel(doc, state.today, act, doc.vault ? docReview(doc) : null));
  } else if (p.kind === 'cp') {
    const c = state.cps.find((x) => x.id === p.id);
    el.replaceChildren(c ? cpPanel(c) : h('div'));
  } else if (p.kind === 'cp-edit') {
    el.replaceChildren(cpEditPanel(p.id ? state.cps.find((x) => x.id === p.id) : null, p.id ? null : { name: p.name ?? '', ask: !!p.ask }));
  } else if (p.kind === 'act') {
    const row = activityRows().find((r) => r.id === p.id);
    el.replaceChildren(row ? activityPanel(row) : h('div'));
  }
}

/** 레일 화면 머리의 "승인 대기" 줄. 바 바로 옆에 렌더러 버튼을 두지 않으려고 화면 위쪽에 둔다. */
const waitingChip = () => {
  const r = [...state.runs.values()].find((x) => x.status === 'waiting');
  return h('button', { type: 'button', class: 'sx-btn sx-btn-quiet rs-waiting', onclick: () => go('chat') }, r ? `세금계산서 · ${r.counterparty.name} 승인 대기 · 대화로 가기` : '승인 대기 · 대화로 가기');
};

const panelHead = (title, ...extra) => h('div', { class: 'sx-card-hd' }, h('div', { class: 'sx-card-title' }, title), ...extra, h('button', { type: 'button', class: 'panel-x', 'aria-label': '패널 닫기', onclick: act.closePanel }, icon('close')));

/** 레일 화면 머리(캔버스 D-01·D-02): 제목 · 건수 · 오른쪽 버튼, 승인 대기 중이면 대화로 가는 줄. */
const railHead = (title, meta, ...right) => h('div', { class: 'rs-head' }, h('h1', { class: 'title-screen' }, title), meta ? h('span', { class: 'sx-meta' }, meta) : null, h('div', { class: 'rs-right' }, waitingChip(), ...right));

/** 목록 표: 테두리 상자 안 표(좌우로 밀지 않고 좁으면 값을 줄바꿈). cols = [이름, 'num'이면 오른쪽 정렬]. */
const listTable = (cols, rows) =>
  h('div', { class: 'list-box' }, h('table', { class: 'list' }, h('thead', {}, h('tr', {}, cols.map(([t, cls]) => h('th', { class: cls ?? null }, t)))), h('tbody', {}, rows)));

const shortDate = (s) => (s && /^\d{4}-\d\d-\d\d$/.test(s) ? s.slice(5) : s);

// ---- 레일 화면 ----

const DOC_FILTERS = [
  ['all', '전체'],
  ['cert', '증명서'],
  ['tax', '세금계산서'],
  ['soon', '만료 임박'],
];

function docsView() {
  const f = state.docFilter;
  const n7 = (d) => {
    const n = dday(d.expiresOn, state.today);
    return n !== null && n <= 7;
  };
  const list = state.docs
    .filter((d) => f === 'all' || (f === 'tax' && d.kind === '세금계산서') || (f === 'cert' && d.kind !== '세금계산서') || (f === 'soon' && n7(d)))
    .map((d) => ({ d, n: dday(d.expiresOn, state.today) }))
    // 확인 필요는 맨 위, 다음 만료 7일 이내, 나머지는 최근 발급순(발급일이 비면 맨 뒤).
    .sort((a, b) => Number(!!b.d.vault?.needsUser) - Number(!!a.d.vault?.needsUser) || Number(b.n !== null && b.n <= 7) - Number(a.n !== null && a.n <= 7) || (b.d.issuedOn ?? '').localeCompare(a.d.issuedOn ?? ''));
  const check = state.docs.filter((d) => d.vault?.needsUser).length;
  const soon = state.docs.filter(n7).length;
  const meta = [`${state.docs.length}개`, check ? `확인 필요 ${check}개` : null, soon ? `만료 임박 ${soon}개` : null].filter(Boolean).join(' · ');
  const fb = ([key, label]) => h('button', { type: 'button', class: f === key ? 'is-on' : null, 'aria-pressed': String(f === key), onclick: () => ((state.docFilter = key), render()) }, label);
  return h(
    'section',
    { class: 'rail-screen', 'data-view': 'docs' },
    railHead('문서함', meta, btn(state.docBusy ? '읽는 중…' : 'PDF 가져오기', () => importDoc({ pick: true }), '', { 'data-act': 'doc-import', disabled: state.docBusy })),
    h('div', { class: 'filters', role: 'group', 'aria-label': '서류 거르기' }, DOC_FILTERS.map(fb)),
    listTable(
      [['서류'], ['발급일'], ['용도'], ['출처']],
      list.map(({ d }) =>
        h(
          'tr',
          // 만료일 확실성(문서·추정·확인함)은 상세 패널 유효 칸에 보인다. 행에는 속성으로만 둔다(시험이 읽는다).
          { class: state.panel?.id === d.id ? 'is-on' : null, 'data-doc-row': d.id, 'data-expiry-tag': d.vault && d.expiresOn ? expiryTag(d) : null, onclick: () => openPanel({ kind: 'doc', id: d.id }) },
          h('td', { class: 'name' }, d.name, state.docLocked.has(d.id) ? lockMark() : null, d.profile === 'personal' ? h('span', { class: 'sx-tag doc-tag' }, '개인') : null, d.vault?.needsUser ? h('span', { class: 'doc-flag' }, '확인 필요') : null),
          // 유효 열은 두지 않는다(캔버스 D-01). 만료 임박은 거르기·정렬과 상세 패널에 남는다.
          h('td', { class: d.issuedOn ? null : 'is-none' }, d.issuedOn ?? '—', d.issuedOn && agoText(d.issuedOn, state.today) ? h('span', { class: 'sx-meta doc-ago' }, agoText(d.issuedOn, state.today)) : null),
          h('td', { class: d.purpose ? null : 'is-none' }, d.purpose || '—'),
          h('td', { class: 'sx-meta' }, d.source),
        ),
      ),
    ),
    list.length ? null : h('div', { class: 'empty' }, '조건에 맞는 서류가 없어요.'),
    h('p', { class: 'sx-meta rs-foot' }, '확인할 서류와 만료 7일 이내 서류가 맨 위에 오고, 나머지는 최근 발급순이에요. 디스크의 파일명에는 거래처·승인번호를 넣지 않아요.'),
  );
}

const thisMonth = () => `${state.today.getFullYear()}-${String(state.today.getMonth() + 1).padStart(2, '0')}`;

function cpsView() {
  const month = thisMonth();
  const issued = state.cps.filter((c) => c.lastIssuedOn?.startsWith(month)).length;
  return h(
    'section',
    { class: 'rail-screen', 'data-view': 'cps' },
    railHead('거래처', `${state.cps.length}곳${issued ? ` · 이번 달 발급 ${issued}곳` : ''}`, btn('거래처 추가', () => openPanel({ kind: 'cp-edit', id: null }), '', { 'data-act': 'cp-add' })),
    // 온보딩 O-05에서 [거래처 화면에서 추가]로 왔다(F-12): 다 넣으면 대화로 돌아가 [다 했어요]를 누르게 띠 하나
    state.onb?.step === 'counterparties'
      ? h('div', { class: 'sx-note', 'data-onb-band': 'cps' }, h('div', {}, '거래처를 다 넣으면 대화로 돌아가 [다 했어요]를 눌러 주세요.'), btn('대화로 돌아가기', () => go('chat'), 'sx-btn-primary', { 'data-act': 'onb-back' }))
      : null,
    listTable(
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
    ),
    h('p', { class: 'sx-meta rs-foot' }, '휴·폐업 상태는 발급 직전에 국세청에서 다시 확인해요.'),
  );
}

/** 거래처 상세(캔버스 D-02 오른쪽): 값 → 발급 이력 → 버튼 → 출처. 실행은 대화로 넘긴다. */
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
      ['상태 확인', c.checkedOn || '—', c.checkedOn ? { tag: '국세청' } : {}],
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
      btn('상태 다시 확인', () => toast('국세청 상태 다시 확인은 곧 지원해요'), 'sx-btn-quiet'),
    ),
    h('div', { class: 'sx-source' }, '거래처 장부 · 이 PC에만 있어요'),
  );
}

const CP_ERR = { bad_item_name: '품목 이름을 확인해 주세요', too_many_items: '저장 품목은 20개까지예요', invalid_biz_no: '사업자번호가 맞지 않아요(10자리, 검증 숫자)', duplicate_biz_no: '이미 있는 사업자번호예요', name_required: '상호를 넣어 주세요', invalid_email: '이메일 형식이 아니에요', unsupported: '이 모드에서는 바꿀 수 없어요', busy: '등록증을 읽는 중이에요', gesture_required: '버튼을 다시 눌러 주세요' };

/** 거래처 추가·수정. 사업자번호는 추가할 때만 넣는다(수정은 상호·대표자·이메일·품목). [저장 품목]은 저장 품목 목록의 첫 품목이다(#144). */
/** add: 새 거래처 폼의 채움(name)과 되묻기에서 왔는지(ask: 저장하면 대화로 돌아가 이름을 채운다). */
function cpEditPanel(c, add = null) {
  const field = (label, name, value, attrs = {}) => h('label', { class: 'cp-field' }, h('span', { class: 'sx-meta' }, label), h('input', { class: 'doc-in', name, value: value ?? '', autocomplete: 'off', ...attrs }));
  const demoBook = state.boot.cpBook !== 'local';
  let saving = false;
  let reading = false;
  /** 이 폼에서 읽은 등록증의 표(main이 든 주소를 이 폼의 저장에만 붙인다). */
  let certHold = null;
  // [등록증으로 채우기](M4-3 O-05): main이 파일을 고르게 하고 후보만 돌려준다. 값은 입력 칸 value로만 넣는다(HTML로 그리지 않는다).
  const fillFromCert = async () => {
    if (reading) return;
    reading = true;
    try {
      const r = await call('counterparty.readCert', {});
      if (!r.found) {
        if (r.reason === 'unreadable') toast('등록증을 읽지 못했어요. 번호로 입력해 주세요');
        return;
      }
      if (r.name) form.elements.name.value = r.name;
      if (r.bizNo) form.elements.bizNo.value = fmtBiz(r.bizNo);
      if (r.rep) form.elements.rep.value = r.rep;
      certHold = r.hold ?? null;
      // 등록증 종목은 저장 품목 후보로만(F-15). 이미 적어 둔 품목은 덮지 않는다. (elements.item은 컬렉션의 item() 메서드라 namedItem으로)
      const itemIn = form.elements.namedItem('item');
      const itemFilled = !!r.item && !!itemIn && !String(itemIn.value).trim();
      if (itemFilled) itemIn.value = r.item;
      toast(!r.bizNo ? '등록증에서 읽었어요. 사업자번호는 읽지 못했으니 직접 넣어 주세요' : itemFilled ? '등록증에서 읽었어요. 저장 품목은 등록증의 종목이에요. 발급할 품목과 다르면 고친 뒤 추가해 주세요' : '등록증에서 읽었어요. 맞는지 보고 추가해 주세요');
    } catch (err) {
      toast(human(err, CP_ERR));
    } finally {
      reading = false;
    }
  };
  const form = h(
    'form',
    {
      class: 'cp-form',
      onsubmit: async (e) => {
        e.preventDefault();
        if (saving) return;
        saving = true;
        const f = new FormData(form);
        try {
          const r = await call('counterparty.save', { id: c?.id ?? null, name: f.get('name'), bizNo: f.get('bizNo'), rep: f.get('rep'), email: f.get('email'), item: f.get('item'), certHold });
          state.cps = r.counterparties;
          const savedName = String(f.get('name') ?? '').trim();
          if (!c && add?.ask) {
            // 되묻기에서 왔다: 대화로 돌아가 이 이름을 입력창에 채운다(보내면 되묻기를 잇는다)
            await go('chat');
            fillComposer(state.cps.find((x) => x.id === r.id)?.name ?? savedName);
            toast('거래처를 추가했어요. 보내면 이어서 발급할게요');
            return;
          }
          render();
          openPanel({ kind: 'cp', id: r.id });
          toast(c ? '저장했어요' : '거래처를 추가했어요');
        } catch (err) {
          toast(human(err, CP_ERR));
        } finally {
          saving = false;
        }
      },
    },
    c ? null : h('div', { class: 'sx-actions' }, btn('등록증으로 채우기', fillFromCert, 'sx-btn-quiet', { 'data-act': 'cp-cert' })),
    field('상호', 'name', c?.name ?? add?.name, { required: true, maxlength: 60 }),
    field('사업자번호', 'bizNo', c ? fmtBiz(c.bizNo) : '', { required: !c, disabled: !!c, inputmode: 'numeric', placeholder: '000-00-00000' }),
    field('대표자', 'rep', c?.rep, { maxlength: 30 }),
    field('받는 이메일', 'email', c?.email, { type: 'email', maxlength: 100 }),
    field('저장 품목', 'item', c?.item, { maxlength: 40, placeholder: '자주 쓰는 품목(발급 때 후보로 채워요)' }),
    h('div', { class: 'sx-actions' }, h('button', { type: 'submit', class: 'sx-btn sx-btn-primary', 'data-act': 'cp-save' }, c ? '저장' : '추가'), btn('취소', () => openPanel(c ? { kind: 'cp', id: c.id } : null), 'sx-btn-quiet')),
  );
  return h('div', { class: 'panel-in', 'data-panel-cp-edit': c?.id ?? 'new' }, panelHead(c ? `${c.name} 수정` : '거래처 추가'), form, h('div', { class: 'sx-source' }, demoBook ? '이 PC 거래처 장부(데모 DB)에만 저장해요' : '이 PC 거래처 장부에만 저장해요'));
}

const RUN_ACTIVE = ['preparing', 'turn', 'waiting', 'issuing'];
/** 내 사업장 사업자 카드(shell-biz.js): 보기 / [수정] 폼. 편집 중 값은 state.bizEdit에 둔다(다시 그려도 남는다). */
function bizCard() {
  const b = state.boot.profiles.business;
  return bizProfileCard({
    b,
    edit: state.bizEdit,
    runActive: [...state.runs.values()].some((r) => RUN_ACTIVE.includes(r.status)),
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
      // 제목줄(상호)·판·카드에 바로 반영
      render();
      renderTitlebar();
      renderToday();
      toast(r.changed.length ? '저장했어요' : '바뀐 것이 없어요');
    },
    reopenAuth: () => reopenSetup('auth'),
  });
}

/** 내 사업장(캔버스 D-03): 사업자 프로필(보기·[수정]) · 개인 프로필 · 맡긴 업무. */
function bizView() {
  const p = state.boot.profiles;
  const b = p.business;
  // 저장된 개인 프로필이 없으면(제품) 내용 없는 "개인 · 개인" 카드를 그리지 않는다
  const personal = p.personal && !p.personal.placeholder ? p.personal : null;
  const used = [b.bizNo ? b : null, personal].filter(Boolean).length;
  return h(
    'section',
    { class: 'rail-screen', 'data-view': 'biz' },
    h(
      'div',
      { class: 'rs-col' },
      railHead('내 사업장', `프로필 2개 중 ${used}개 사용`),
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
        h('div', { class: 'sx-quick' }, state.boot.quick.map((q) => h('button', { type: 'button', class: q.soon ? 'is-soon' : null, onclick: () => (q.soon ? toast(`${q.label}은 곧 지원돼요`) : fillComposer(q.text)) }, q.label, q.soon ? ' · 곧 지원' : ''))),
        h('p', { class: 'sx-meta' }, '입력창 위 빠른 실행에 이 순서로 보여요.'),
      ),
    ),
  );
}

/** 활동 기록 행: 이번 실행(세금계산서·정부24) + 타임라인의 지난 기록. 새것이 위. */
function activityRows() {
  const today = `${String(state.today.getMonth() + 1).padStart(2, '0')}-${String(state.today.getDate()).padStart(2, '0')}`;
  const rows = [];
  for (const r of [...state.runs.values()].reverse()) {
    if (r.status === 'draft') continue;
    rows.push({ id: r.id, run: r, at: `${today} ${r.result?.doneAt ?? r.createdAt}`, what: `세금계산서 · ${r.counterparty.name}`, profile: '사업자', portal: '홈택스', status: r.status, result: CHIP[r.status][0] });
  }
  for (const g of [...state.g24.values()].reverse()) {
    const result = { guide: '내 차례', pick: '내 차례', saved: '문서함에 넣음', stopped: '그만둠' }[g.stage];
    rows.push({ id: g.id, g24: g, at: `${today} ${g.startedAt}`, what: `${g.doc} · 정부24`, profile: '개인', portal: '정부24 · 직접', status: { guide: 'turn', pick: 'turn', saved: 'done', stopped: 'stopped' }[g.stage], result });
  }
  // 내 사업장 고친 기록(칸 이름만, 값 없음). 새것이 위.
  const LABEL = { name: '상호', bizNo: '사업자번호', rep: '대표자', bizType: '업태', bizItem: '종목', address: '주소', email: '이메일' };
  for (const [i, e] of [...(state.boot.profileEdits ?? []).entries()].reverse()) {
    const d = new Date(e.at);
    const at = `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    rows.push({ id: `edit-${i}`, edit: e, at, what: `내 사업장 수정 · ${e.fields.map((f) => LABEL[f] ?? f).join('·')}`, profile: '사업자', portal: '이 PC', status: 'done', result: '저장함' });
  }
  // 시연 씨앗이 있으면 지난 발급 이력(최근 순, 상태가 섞여 있다), 없으면 타임라인의 지난 카드
  if (state.boot.history)
    return [...rows, ...state.boot.history.map((it) => ({ id: `past-${it.id}`, past: it, at: `${shortDate(it.date)} ${it.time}`, what: `${it.title} · ${it.who}`, profile: '사업자', portal: '홈택스', status: it.status, result: CHIP[it.status][0] }))];
  let day = null;
  let time = '';
  const past = [];
  for (const it of state.boot.timeline) {
    if (it.type === 'day') day = it.date;
    else if (it.type === 'me') time = it.time ?? '';
    else if (it.type === 'past') past.push({ id: `past-${it.approvalNo}`, past: it, at: `${shortDate(day)} ${time}`.trim(), what: `${it.title} · ${it.who}`, profile: '사업자', portal: '홈택스', status: 'done', result: '완료' });
  }
  return [...rows, ...past.reverse()];
}

function activityView() {
  const rows = activityRows();
  return h(
    'section',
    { class: 'rail-screen', 'data-view': 'activity' },
    railHead('활동 기록', '이 PC에만 남아요 · 비밀값은 남기지 않아요'),
    rows.length
      ? listTable(
          [['시각'], ['작업'], ['프로필'], ['포털'], ['결과'], ['모델']],
          rows.map((r) =>
            h(
              'tr',
              { class: state.panel?.id === r.id ? 'is-on' : null, 'data-act-row': r.id, onclick: () => openPanel({ kind: 'act', id: r.id }) },
              h('td', { class: 'num-l' }, r.at),
              h('td', { class: 'name' }, r.what),
              h('td', {}, r.profile),
              h('td', {}, r.portal),
              h('td', { class: r.status === 'attention' ? 'is-attention' : r.status === 'stopped' ? 'is-muted' : null }, r.result),
              modelCell(r.run?.sent ?? r.g24?.sent) ? h('td', {}, modelCell(r.run?.sent ?? r.g24?.sent)) : h('td', { class: 'is-muted' }, '안 함'),
            ),
          ),
        )
      : h('div', { class: 'empty' }, '아직 기록이 없어요.'),
    h('p', { class: 'sx-meta rs-foot' }, '결과 카드의 "어디로 무엇이 갔나요"는 이 기록을 카드 안에서 펼친 것이에요.'),
  );
}

/** 활동 기록 상세(캔버스 S-01 오른쪽): 값 → 어디로 무엇이 갔나요 → 실행 단계. */
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
            // 상태조회(checkBizNo)는 제품에서 아직 보내지 않는다(조회 못 함 → [맞습니다]). 프록시가 붙으면 여기도 바꾼다.
            ['저장', `이 PC 내 사업장 정보 · 고친 칸 ${row.edit.fields.length}개(값은 기록하지 않아요)`],
            ['모델', '쓰지 않음'],
            serverRow([]),
          ]
        : row.past
        ? [
            ['홈택스', row.past.status === 'stopped' ? '발급하지 않음(승인 전에 중지)' : '전자세금계산서 1건 발급 · 발급목록에서 확인'],
            ['메일', row.past.status === 'stopped' ? '보내지 않음' : `${row.past.mail} · 홈택스가 보냄${row.past.status === 'attention' ? ', 메일발송목록에서 확인하지 못함' : ''}`],
            ['모델', '쓰지 않음'],
            ['우리 서버', '보낸 것 없음'],
          ]
        : [
            // 확인 필요는 안 됨·모름·됨(중복 위험)이 섞여 있다. 여기서 단정하지 않고 위 안내(stoppedNote)를 따른다.
            ['홈택스', r.status === 'stopped' ? '발급하지 않음' : r.status === 'attention' ? '확인 필요 · 위 안내를 봐 주세요' : '진행 중'],
            modelRow(r.sent),
            serverRow(r.sent),
          ];
  return h(
    'div',
    { class: 'panel-in', 'data-panel-act': row.id },
    panelHead(row.what, chip(row.status)),
    kv([
      ['시각', row.at],
      ['프로필', row.profile === '사업자' ? `사업자 · ${state.boot.profiles.business.name}` : `개인 · ${state.boot.profiles.personal.name}`],
      ['포털', row.portal],
      r?.result ? ['승인번호', r.result.approvalNo, { mono: true }] : row.past ? ['승인번호', row.past.approvalNo ?? '—', { mono: true }] : null,
      row.past ? ['합계', `${num(row.past.total)}원 (공급가액 ${num(row.past.supply)} + 세액 ${num(row.past.tax)})`] : null,
    ]),
    r?.stoppedNote ? note(r.stoppedNote, r.status === 'attention') : null,
    row.past?.status === 'attention' ? note('홈택스 메일발송목록에서 이 건의 메일을 확인하지 못했어요. 거래처에 받았는지 확인해 주세요.', true) : null,
    h('div', { class: 'sx-panel-sec' }, '어디로 무엇이 갔나요'),
    kv(where, true),
    r ? [h('div', { class: 'sx-panel-sec' }, '실행 단계'), steps(runSteps(r))] : null,
  );
}

const SETTINGS_TABS = [
  ['auth', '발급 인증'],
  ['devices', '기기 연결'],
];

function setTab(tab) {
  state.setTab = tab;
  render();
  if (tab === 'devices') refreshAccount();
}

// ---- 계정 로그인(A-01) ----

async function refreshAccount() {
  try {
    state.account = await call('account.view', {});
  } catch {
    state.account = { step: 'unavailable', email: null, codeExpiresAt: null, error: null };
  }
  render();
}

function openLogin() {
  state.login = { screen: 'email', draft: { email: state.account?.email ?? '', password: '', code: '', show: false }, busy: false };
  render();
}

/**
 * 로그인이 먼저다(사용자 결정 2026-11-10): 제품은 약관에 동의한 뒤 로그인(첫 PC 등록)해야 온보딩·대화로 간다.
 * 끝낸 프로필이 로그아웃 상태로 켜져도 대화 대신 이 화면이 먼저다. 닫을 수 없다(main도 그 전 요청을 account_required로 거절한다).
 */
function loginGate() {
  if (!state.boot?.loginRequired) return false;
  if (state.onb && state.onb.consents?.terms?.choice !== 'agreed') return false; // 약관이 먼저
  return state.account?.step !== 'signed_in';
}

/** 설정 > 계정 [로그아웃]: main이 신원·받아 둔 코드를 지우면 로그인 화면(게이트)이 다시 막는다. */
async function signOut() {
  try {
    state.account = await call('account.signOut', {});
    state.login = null;
    render();
  } catch (err) {
    toast(accountErrText(errText(err)));
  }
}

/** [폰 연결]: main이 따로 창을 연다(QR·6자리는 그 창에만 있다). */
async function openPair() {
  try {
    await call('pair.open', {});
  } catch (err) {
    toast(accountErrText(errText(err)));
  }
}

function closeLogin() {
  if (!state.login) return;
  // 로그인 화면이 막고 있는 동안은 닫지 않는다(비밀번호 바꿈 끝 화면의 [계속]은 로그인된 뒤라 닫힌다)
  if (loginGate()) return;
  state.login = null;
  render();
  $('[data-act=account-login]')?.focus();
}

/** 서버가 받은 코드를 거절한 오류(이때만 코드 칸을 비운다). */
const SERVER_CODE_ERR = new Set(['account.code_invalid', 'account.code_locked', 'account.code_expired']);

/** 로그인 화면의 요청 하나. 끝나면 main이 준 단계로 다시 그린다. 등록이 끝나면 화면을 닫는다. 비밀번호는 보낸 뒤 비운다. */
async function accountStep(method, params) {
  const l = state.login;
  if (!l || l.busy) return;
  l.busy = true;
  render();
  try {
    state.account = await call(method, params);
    // 재설정 바꾸기는 정책 거부면 받아 둔 코드로 다시 보낸다(코드 오류일 때만 아래에서 비운다)
    if (method !== 'account.verify' && method !== 'account.finishReset') l.draft.code = '';
  } catch (err) {
    state.account = { ...(state.account ?? { step: 'signed_out', email: null, codeExpiresAt: null }), error: errText(err) };
  } finally {
    l.busy = false;
    if (method === 'account.password' || method === 'account.setPassword' || method === 'account.finishReset') l.draft.password = '';
    // 비밀번호 찾기: 코드를 보냈으면 코드 칸부터. 코드 오류는 코드 칸으로 돌아가 칸을 비운다(새 비밀번호도 지웠다, 명세 §4).
    if (method === 'account.startReset' && state.account?.step === 'reset_code') l.screen = 'reset_code';
    if (method === 'account.finishReset' && SERVER_CODE_ERR.has(state.account?.error)) {
      l.screen = 'reset_code';
      l.draft.code = '';
    }
    // 서버는 이메일·서비스 이름을 한 코드로 준다. 어느 쪽인지는 보내기 전에 같은 규칙으로 가려 둔 종류로 고른다(비밀번호는 남기지 않는다).
    if ((method === 'account.setPassword' || method === 'account.finishReset') && state.account?.error === 'account.password_contains_identity' && l.pwKind === 'service') state.account = { ...state.account, error: 'account.password_contains_service' };
    // 서버에 비밀번호 기능이 꺼져 있으면(404) 이메일 코드 로그인으로 바로 넘긴다(인계 명세 §1)
    if (method === 'account.password' && state.account?.error === 'request.not_found') {
      l.screen = 'code_email';
      state.account = { ...state.account, error: null };
    }
    // 받은 코드는 만료까지 쓴다: 서버가 코드가 틀렸다·막혔다·지났다고 한 때만 칸을 비운다. 앱 쪽 거절(실제 입력 못 봄·모양)·연결 실패는 칸에 남긴다.
    if (method === 'account.verify' && (SERVER_CODE_ERR.has(state.account?.error) || state.account?.step === 'set_password')) l.draft.code = '';
  }
  if (state.account?.step === 'signed_in' && method === 'account.finishReset') {
    // 바꿈 끝 화면(§4 done)을 보이고 [계속]에서 닫는다
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

/** 화면 이동(렌더러 안). 앞 화면의 오류 문구는 지운다. */
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
  // 로그인 화면이 막고 있으면 [닫기]가 없다(바꿈 끝 화면의 [계속]은 로그인된 뒤라 닫힌다)
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
  // 계정 만들기 화면에서 보낸 코드면 signup(확인 뒤 비밀번호가 없으면 만들기 단계)
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
  // 코드 화면 [뒤로]: 코드를 버리고 코드 받기 화면으로(계정 만들기에서 왔으면 그대로)
  back: async () => {
    const s = state.login.screen;
    state.login.screen = s === 'reset_code' || s === 'reset_new' ? 'reset_email' : s === 'signup' ? 'signup' : 'code_email';
    await accountStep('account.back', {});
  },
});

// 코드 화면의 남은 시간(1초마다 글자만 바꾼다)
setInterval(() => {
  const el = document.querySelector('[data-acct-left]');
  const at = state.account?.codeExpiresAt;
  if (!el || !at) return;
  const sec = Math.max(0, Math.round((at - Date.now()) / 1000));
  el.textContent = `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
}, 1000);
// 프로필 인증 라벨(shell-model SIGN_LABEL)별 발급 때 사람이 하는 일(shell-runs SIGN_BY_AUTH와 같은 사실).
const AUTH_DESC = {
  '사업자 간편인증': '발급할 때마다 휴대폰에서 승인해요',
  '공동·금융인증서': '발급할 때마다 인증서 비밀번호를 직접 넣어요',
  보안카드: '발급할 때마다 보안카드 번호를 직접 넣어요',
};

/** 발급 인증(캔버스 S-02): 사업자 프로필의 인증 하나. 바꾸기는 내 사업장과 같은 온보딩 다시 열기. */
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
    // 진행 중 실행은 시작 때 인증 그대로 끝난다(#295 결정, 엔진 run.start 스냅숏).
    canChange && desc ? h('p', { class: 'sx-meta', 'data-auth-note': '' }, '바꾸면 다음 발급부터 적용돼요. 진행 중인 작업은 원래 인증으로 끝내요.') : null,
  ];
}

/** 설정(캔버스 S-02): 발급 인증 · 기기 연결. */
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
    state.setTab === 'devices'
      ? h('div', { class: 'set-body' }, waitingChip(), h('div', { class: 'set-intro' }, h('h2', { class: 'sx-card-title' }, '기기 연결'), h('p', { class: 'sx-body-sm is-muted' }, '계정에 이 PC를 등록하고 폰을 연결해요.')), accountCard(state.account, openLogin, openPair, signOut))
      : h('div', { class: 'set-body' }, waitingChip(), h('div', { class: 'set-intro' }, h('h2', { class: 'sx-card-title' }, '발급 인증'), h('p', { class: 'sx-body-sm is-muted' }, '세금계산서를 발급할 때 쓰는 인증이에요.')), authCard()),
  );
}

/** 2차 배분 화면의 자리(D-04 사업용 카드 · D-05 세무사 꾸러미 · D-06 급여대장). 라우팅만 있고 내용은 그 트랙이 붙인다. */
const LATER = {
  bundle: ['세무사 꾸러미', 'D-05', '이번 달 항목과 빠진 것, 미리보기·보내기가 여기에 들어와요.'],
  card: ['사업용 카드 내역', 'D-04', '홈택스 사업용 카드 사용내역과 [최신화]가 여기에 들어와요.'],
  payroll: ['급여대장', 'D-06', '직원 목록과 이번 달 급여대장이 여기에 들어와요.'],
};
const laterView = (v) => () => {
  const [title, id, text] = LATER[v];
  return h('section', { class: 'rail-screen', 'data-view': v, 'data-screen': id }, h('div', { class: 'rs-col' }, railHead(title, '준비 중'), h('article', { class: 'sx-card later-card' }, h('p', { class: 'sx-body-sm is-muted' }, text))));
};
const VIEWS = { docs: docsView, cps: cpsView, biz: bizView, bundle: laterView('bundle'), card: laterView('card'), payroll: laterView('payroll'), activity: activityView, settings: settingsView };

async function go(v) {
  if (state.view === v && v !== 'docs') return;
  state.view = v;
  // 패널은 그 화면의 것만 남긴다(대화: 작업, 문서함: 서류, 거래처: 거래처, 활동 기록: 기록).
  const own = { chat: ['run', 'g24'], docs: ['doc'], cps: ['cp', 'cp-edit'], activity: ['act'] }[v] ?? [];
  if (state.panel && !own.includes(state.panel.kind)) openPanel(null);
  if (v === 'cps') state.cps = await call('counterparties.list');
  // 문서함은 지금 목록으로 먼저 그리고, 보관함에서 다시 읽어 오면 다시 그린다(만료일·확인 필요는 엔진이 정하고, D-n은 렌더러가 오늘 날짜로 센다)
  if (v === 'docs') {
    const rev = state.docsRev;
    call('docs.list')
      .then((docs) => {
        if (rev !== state.docsRev) return;
        state.docs = docs;
        if (state.view === 'docs') render();
      })
      .catch(() => {});
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
  } else center.replaceChildren(VIEWS[state.view]());
  renderPanel();
  renderModal();
}

// ---- 보관함 가져오기·확인(문서함) ----

/** 목록 서류 이름 옆 자물쇠(캔버스 D-01): 열기 암호가 걸린 PDF. */
const lockMark = () => h('span', { class: 'doc-lock', role: 'img', 'aria-label': '열기 암호 있음', title: '열기 암호 있음', 'data-doc-lock': '' }, icon('lock'));

/**
 * 열기 암호 창(캔버스 D-01 · 암호 걸린 PDF 열기). 문서함에서 암호를 기다릴 때만 띄우고, 띄운 동안 앱 틀은 inert다.
 * 암호로 읽는 동안에는 창을 닫는다(앱은 그대로 쓰고, 가져오기 버튼이 "읽는 중…"으로 막혀 그만둔 뒤 결과가 보관되는 경쟁이 없다).
 * 암호는 이 가져오기에만 쓰고 저장하지 않는다. 다시 그려도 입력 중인 값은 state에 남는다(DOM 속성에는 넣지 않는다).
 */
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
  // 로그인 화면이 막아야 하면 연다(기동·약관 동의 직후·로그아웃 이벤트)
  if (loginGate() && !state.login) state.login = { screen: 'email', draft: { email: state.account?.email ?? '', password: '', code: '', show: false }, busy: false };
  const pw = state.view === 'docs' && !!state.docImport && !state.docBusy;
  const login = !pw && !!state.login;
  const open = pw || login;
  // 처음 띄울 때와 창 안에 있던 포커스는 새 입력 칸으로 옮긴다(다시 그릴 때마다 칸을 새로 만든다)
  const a = document.activeElement;
  const focus = !root.firstChild || !a || a === document.body || root.contains(a);
  root.replaceChildren(...(pw ? [passwordModal()] : login ? [loginScreen(loginCtx())] : []));
  $('#app').inert = open;
  const i = open && focus ? root.querySelector(pw ? '.doc-pw' : '.acct-code, .acct-password, .acct-email, [data-act=account-reset-done]') : null;
  if (i) {
    i.focus();
    // type=email은 선택 범위를 지원하지 않는다(던진다)
    if (i.type !== 'email') i.setSelectionRange(i.value.length, i.value.length);
  }
}

function cancelPassword() {
  if (!state.docImport || state.docBusy) return;
  call('docs.importCancel', { pickId: state.docImport.pickId }).catch(() => {});
  state.docImport = null;
  render();
  // 사용자가 창을 닫았다(Esc·취소·닫기): 포커스를 창을 연 가져오기 버튼으로 돌려준다(대화 화면에는 없다)
  $('[data-act=doc-import]')?.focus();
}

async function importDoc(params) {
  if (state.docBusy) return;
  // 암호를 묻던 파일을 두고 새 파일을 고르면, 묻던 파일은 그만둔다(main이 들고 있는 바이트를 버린다)
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
    const msg = r.document?.duplicate ? '이미 보관함에 있는 파일이에요' : d.vault?.needsUser ? '보관함에 넣었어요. 확인할 칸이 있어요' : '보관함에 넣었어요';
    // 읽는 동안 다른 화면으로 갔으면 끌고 오지 않는다(승인 대기 중인 작업 패널을 바꾸지 않게)
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

/**
 * 확인 구역을 (다시) 만든 뒤 이 시간 동안은 확인을 받지 않는다(버튼도 꺼 둔다). 저장·stale 뒤에 새 값으로 다시 그린 확인 버튼에
 * 두 번 누른 두 번째 클릭이 닿아, 보지 않은 값이 확인되지 않게.
 */
const DOC_CONFIRM_HOLD_MS = 700;

async function updateDoc(id, patch, seen) {
  if (state.docUpdating) return;
  state.docUpdating = true;
  try {
    const d = await call('docs.update', { id, patch, seen });
    state.docsRev++;
    state.docs = state.docs.map((x) => (x.id === d.id ? d : x));
    // 응답을 기다리는 동안 다른 서류로 옮겼으면 그 서류의 입력은 두고, 이 서류의 입력만 버린다(새 값으로 다시 만든다)
    if (state.docDraft?.id === id) state.docDraft = null;
    toast(d.vault?.needsUser ? `저장했어요. ${d.vault.reasons.includes('expiry_recomputed') ? '다시 계산한 만료일을' : '남은 칸을'} 확인해 주세요` : '확인했어요');
  } catch (e) {
    toast(docErr(e));
    // 다른 곳에서 바뀐 서류: 지금 값을 다시 읽어 보여 주고 입력은 버린다(본 값이 아닌 값으로 확인하지 않게)
    // 목록을 받은 뒤에 입력을 버린다(그 전에 다시 그리면 옛 값으로 입력을 다시 만들게 된다). 다시 읽는 동안은 docUpdating이라 확인을 받지 않는다.
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

/** 확인 구역의 입력 중인 값과 그때 보여 준 값(seen). 같은 서류를 보는 동안 다시 그려도 남고, 패널을 닫거나 다른 서류로 옮기면 버린다. */
function docDraft(doc) {
  if (state.docDraft?.id !== doc.id) {
    const seen = { docType: doc.vault.docType, issuedOn: doc.issuedOn, expiresOn: doc.expiresOn };
    // 만료일이 없는 사업자등록증명·그 밖의 서류는 '만료일 없음'이 켜진 채로 시작한다(보이는 것과 저장값이 같게)
    const noExpiry = doc.expiresOn === null && seen.docType !== 'national_tax_cert';
    state.docDraft = { id: doc.id, seen, createdAt: Date.now(), docType: seen.docType, issuedOn: doc.issuedOn ?? '', expiresOn: doc.expiresOn ?? '', noExpiry };
  }
  return state.docDraft;
}

/**
 * 보관함 서류의 읽은 값·확인 필요·확인(수정). 바뀐 칸만 보내고, 보여 준 값(seen)을 붙인다(엔진이 저장값과 다르면 거부).
 * 후보(정하지 못한 칸에서 엔진이 고른 가장 이른 날짜)는 칸 값과 다르면 보여 주고, '후보 넣기'로만 칸에 들어간다.
 * 저장값이 있는 날짜 칸을 비우거나 입력하다 만 채로는 저장하지 않는다(빈 칸이 '바꾸지 않음 = 확인'이 되지 않게).
 * 만료일을 지우려면 '만료일 없음'을 고른다(납세증명서 제외).
 */
function docReview(doc) {
  const v = doc.vault;
  const draft = docDraft(doc);
  const canClear = draft.docType !== 'national_tax_cert';
  const noExpiryOn = draft.noExpiry && canClear;
  const src = { text: '텍스트에서 읽음', ocr: '그림에서 읽음(OCR)', scan: '스캔 글자 층에서 읽음' }[v.textSource];
  const typeSel = h(
    'select',
    { class: 'doc-in', 'aria-label': '종류', 'data-field': 'docType' },
    [['national_tax_cert', '납세증명서(국세)'], ['biz_registration_cert', '사업자등록증명'], ['other', '그 밖의 서류']].map(([val, label]) => h('option', { value: val, selected: val === draft.docType }, label)),
  );
  typeSel.addEventListener('change', () => {
    draft.docType = typeSel.value;
    if (draft.docType === 'national_tax_cert') draft.noExpiry = false; // 납세증명서는 만료일을 없앨 수 없다
    render();
  });
  const issued = h('input', { type: 'date', class: 'doc-in', 'aria-label': '발급일', 'data-field': 'issuedOn' });
  issued.value = draft.issuedOn;
  issued.addEventListener('input', () => (draft.issuedOn = issued.value));
  const expires = h('input', { type: 'date', class: 'doc-in', 'aria-label': '만료일', 'data-field': 'expiresOn', disabled: noExpiryOn });
  expires.value = draft.expiresOn;
  expires.addEventListener('input', () => (draft.expiresOn = expires.value));
  // 사업자등록증명·그 밖의 서류는 법정 유효기간이 없어 사용자가 만료일을 없앨 수 있다(납세증명서는 엔진이 확인 필요로 남긴다)
  const noExpiry = canClear ? h('input', { type: 'checkbox', checked: noExpiryOn, 'data-field': 'noExpiry' }) : null;
  noExpiry?.addEventListener('change', () => {
    draft.noExpiry = noExpiry.checked;
    render();
  });
  const hints = [
    v.suggested.issuedOn && v.suggested.issuedOn !== draft.issuedOn ? `발급일 후보 ${v.suggested.issuedOn}` : null,
    v.suggested.validUntil && v.suggested.validUntil !== draft.expiresOn ? `문서 유효기간 후보 ${v.suggested.validUntil}` : null,
  ].filter(Boolean);
  const held = () => Date.now() - draft.createdAt < DOC_CONFIRM_HOLD_MS;
  const save = () => {
    if (state.docUpdating || held()) return;
    if (issued.validity.badInput || expires.validity.badInput) return toast('날짜를 끝까지 넣어 주세요');
    if (!draft.issuedOn && doc.issuedOn) return toast('발급일을 넣어 주세요');
    if (!noExpiryOn && !draft.expiresOn && doc.expiresOn) return toast(canClear ? "만료일을 넣거나 '만료일 없음'을 골라 주세요" : '만료일을 넣어 주세요');
    const patch = {};
    if (draft.docType !== draft.seen.docType) patch.docType = draft.docType;
    if (draft.issuedOn && draft.issuedOn !== draft.seen.issuedOn) patch.issuedOn = draft.issuedOn;
    if (noExpiryOn) {
      if (draft.seen.expiresOn !== null) patch.expiresOn = null;
    } else if (draft.expiresOn && draft.expiresOn !== draft.seen.expiresOn) patch.expiresOn = draft.expiresOn;
    confirmBtn.disabled = true; // 응답까지(다시 그리지 않으므로 직접 끈다)
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
    v.needsUser ? note(v.reasons.map((r) => DOC_REASON[r] || r).join(' · ') || '값을 확인해 주세요', true, 'PDF를 열어 값을 맞춰 보고 확인을 눌러 주세요.') : null,
    !v.needsUser && v.subjectMismatch ? note('내 사업장과 사업자번호가 다른 서류예요(확인함).') : null,
    h(
      'div',
      { class: 'doc-form' },
      h('label', {}, h('span', { class: 'sx-meta' }, '종류'), typeSel),
      h('label', {}, h('span', { class: 'sx-meta' }, '발급일'), issued),
      h('label', {}, h('span', { class: 'sx-meta' }, '만료일'), expires),
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

// ---- main 이벤트 ----

// 창을 앞으로 가져온 클릭(F-11): 내 차례 카드의 버튼 위에서 창이 활성화됐는데 그 버튼 클릭이 오지 않으면(macOS는 첫 클릭을 페이지에 주지 않는다)
// 그 카드에 "한 번 더 눌러 주세요"를 보인다. 버튼 규칙(실제 입력·결속)은 그대로다.
let lastPointerDown = { t: 0, el: null };
document.addEventListener('pointerdown', (e) => (lastPointerDown = { t: performance.now(), el: e.target }), true);
const AGAIN_TEXT = '창을 앞으로 가져오는 클릭이었어요. 한 번 더 눌러 주세요.';
function onActivated(x, y) {
  const b = document.elementFromPoint(x, y)?.closest('button');
  const card = b?.closest('[data-run]');
  if (!b || !card || !['turn', 'waiting'].includes(card.dataset.status)) return;
  const at = performance.now();
  setTimeout(() => {
    if (lastPointerDown.t >= at && b.contains(lastPointerDown.el)) return; // 클릭이 왔다
    if (!b.isConnected || card.querySelector('[data-again]')) return;
    card.append(h('p', { class: 'sx-meta is-attention', 'data-again': '' }, AGAIN_TEXT));
  }, 400);
}

window.sax.onEvent((ev) => {
  if (ev.type === 'activated') return onActivated(ev.x, ev.y);
  if (ev.type === 'account') {
    state.account = ev.account;
    if (state.view === 'settings' || loginGate()) render();
    return;
  }
  if (ev.type === 'run') {
    const prev = state.runs.get(ev.run.id);
    putRun(ev.run);
    if (prev?.status !== 'waiting' && ev.run.status === 'waiting' && state.view === 'chat') openPanel({ kind: 'run', id: ev.run.id });
    if (prev?.status !== 'done' && ev.run.status === 'done') appendThread(h('div', { class: 'sx-app' }, '다음 일을 말해 주세요.'));
  } else if (ev.type === 'bar') {
    // 승인 카드 자리 비우기: 카드 위치·높이는 main이 정하고(ADR-021 결정 7), 렌더러는 그 높이만큼 자리를 비울 뿐이다.
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
  } else if (ev.type === 'docs-reload') {
    // 시연 씨앗이 보관함에 견본 서류를 다 넣었다. 문서함·거래처(최근 발급)를 다시 읽는다.
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
// 프로필 메뉴 밖을 누르면 닫는다.
document.addEventListener('mousedown', (e) => {
  if (state.menu && !e.target.closest('.tb-profile')) toggleMenu(false);
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
// 스크롤바는 스크롤하는 동안과 멈춘 뒤 0.8초만 보인다(디자인 시스템 "간격과 배치", bundle.css "Scroll").
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
// 자정을 넘겨도 D-day·오늘 요약이 맞게 1분마다 오늘을 다시 잡는다.
setInterval(() => {
  state.today = new Date();
  renderToday();
  renderRail();
}, 60_000);

// 카드가 띠(레일 오른쪽~창 끝)인지와 높이는 main이 'bar'·'bar-layout' 이벤트로 알려 준다. 렌더러는 그대로 따라 자리를 비운다.
function applyLayout() {}

/** main이 알린 카드 높이(DIP). 숫자가 아니거나 범위 밖이면 기동 때 받은 기본 높이를 둔다. */
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
  // 시연(fixture)이 아니면 개발용 표시(약관 "F-06 초안 전 문구" 배지 등)를 숨긴다(shell.css body[data-sample=false])
  document.body.dataset.sample = String(state.boot.sample !== false);
  applyLayout();
  renderTitlebar();
  buildChat();
  // 로그인이 먼저다(제품): 계정 상태를 먼저 읽어 로그인 화면(loginGate)을 띄울지 정한다.
  if (state.boot.loginRequired) await refreshAccount();
  render();
  document.body.dataset.ready = '1';
}

void boot();
