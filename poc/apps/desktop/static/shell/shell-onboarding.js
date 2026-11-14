// 온보딩 대화(08 §4 O-01~O-06)와 동의 화면 4종(F-06 자리표시). 상태는 main(onboarding.ts)이 갖고, 렌더러는 그리고 답을 보낼 뿐이다.
// - 비밀(홈택스 비밀번호·보안카드)은 여기서 받지 않는다. 보안카드는 금고 직결 등록 창이 받는다(shell-card.js → main → card-secret.js).
// - 동의는 화면마다 한 번씩 누른다. 묶음 동의 버튼은 없다.
import { btn, fmtBiz, h, icon, kv, note, replyOptions, securityBox } from './shell-views.js';
import { cardRegister } from './shell-card.js';

const Q = {
  terms: '시작하기 전에 약관과 AI 모델 이용을 확인해 주세요.',
  welcome: '세금계산서 발급을 대신 해 드려요. 먼저 사업자를 등록할게요.',
  'biz-number': '상호와 사업자번호를 알려 주세요.',
  'biz-confirm': '등록 내용을 확인해 주세요.',
  auth: '홈택스에 로그인하고 세금계산서에 서명할 공동인증서를 골라 주세요. 비밀번호는 첫 발급 때 금고 창에서 한 번만 받아요.',
  delegation: '보안카드를 쓰려면 먼저 이 PC 금고에 등록해야 해요.',
  model: '대화는 AI 모델로 해석해요. 아래 내용을 확인하고 동의해 주세요.',
  telemetry: '앱을 고치는 데 쓸 사용 기록을 보내 주시겠어요? 안 보내도 돼요.',
  tasks: '어떤 일을 맡기고 싶으세요?',
  counterparties: '세금계산서를 보낼 거래처를 등록할까요?',
  summary: '등록을 마쳤어요. 내용을 확인해 주세요.',
  first: '세금계산서 1건을 같이 발급해 볼까요? 입력창에 요청을 채워 드릴게요.',
};

/** O-03 수단마다 발급할 때 사람이 하는 일 한 줄(H-01 2.2.0 서명 단계, shell-runs.ts SIGN_BY_AUTH). */
const AUTH = [
  ['cert', '공동인증서', '홈택스 로그인에 쓰는 그 인증서예요. 비밀번호를 처음 한 번 넣으면 다음부터는 앱이 넣어요.'],
  ['card', '보안카드', '카드 사진을 한 번 넣으면 발급할 때 앱이 번호를 넣어요.'],
  ['fincert', '금융인증서', '발급할 때마다 6자리 인증서 비밀번호를 직접 넣어요.'],
  ['simple', '사업자 간편인증', '발급할 때마다 휴대폰(카카오뱅크·IBK·KB 앱)에서 승인해요.'],
];
const AUTH_LABEL = Object.fromEntries(AUTH.map(([k, l]) => [k, l]));

/** O-06 축소 범위·운영 수준 고지(F-06 자리표시). "지금 되는 일"은 O-04 업무 표(now)에서 만들어 두 화면이 어긋나지 않게 한다. */
const scopeLines = (catalog) => [
  `지금 되는 일: ${catalog.filter((t) => t.now).map((t) => t.label).join(', ')}`,
  '정부24 서류는 직접 발급을 안내하고, 저장한 파일만 문서함에 정리해요',
  '신고와 세금 판단은 하지 않아요',
  '홈택스 화면이 달라지거나 값을 확실히 읽지 못하면 발급하지 않고 멈춰요',
];

// 단계 안의 화면 상태(고치는 중·다른 방법 펼침·고른 업무). 단계가 바뀌면 비운다.
let ui = { step: null, editing: false, showCerts: false, tasks: null, busy: false };
const uiFor = (step) => {
  if (ui.step !== step) ui = { step, editing: false, showCerts: false, tasks: null, busy: false };
  return ui;
};

/** 답이 거부됐을 때(번호 틀림·휴폐업 등)의 문구를 토스트 대신 그 단계 카드 안 빨간 글로 둔다(대표 2026-11-13). 부른 쪽이 다시 그린다. */
export function showOnbError(step, text) {
  uiFor(step).error = text;
}

const p = (text, muted) => h('p', { class: `sx-body-sm${muted ? ' is-muted' : ''}` }, text);
/** 입력 폼의 키: Enter는 저장(폼 제출), Escape는 취소. 한글 조합 중 키는 조합을 끝낼 뿐이라 무시한다. */
const formKeys = (cancel) => (e) => {
  if (e.isComposing) return;
  if (e.key === 'Enter' && e.target.tagName === 'INPUT') {
    e.preventDefault();
    e.currentTarget.requestSubmit();
  }
  if (e.key === 'Escape') {
    e.preventDefault();
    cancel();
  }
};

/**
 * 온보딩 영역 전체. o: main의 OnbView, act: { reply(step, choice, extra), go(view), toast(text), rerender() }.
 * 지나간 답은 "나" 말풍선으로, 지금 단계는 카드로 그린다.
 */
export function onboardingView(o, act) {
  const items = [];
  let last = null;
  // 건너뛴 단계를 다시 연 것이면(redoFrom) 그 뒤 답만 그린다(지난 답은 위의 기록 자리에 남아 있다)
  for (const l of o.redoFrom != null ? o.log.slice(o.redoFrom) : o.log) {
    if (l.step !== last) items.push(h('div', { class: 'sx-app' }, Q[l.step] ?? ''));
    last = l.step;
    items.push(h('div', { class: 'sx-me' }, l.text));
  }
  if (o.step !== 'done') {
    if (o.step !== last) items.push(h('div', { class: 'sx-app' }, Q[o.step] ?? ''));
    items.push(stepCard(o, act));
  }
  return h('section', { class: 'onb', 'data-onboarding': o.step }, ...items);
}

function stepCard(o, act) {
  const el = stepBody(o, act);
  const u = uiFor(o.step);
  if (u.error) el.append(h('p', { class: 'form-msg is-bad', role: 'status', 'data-onb-error': '' }, u.error));
  return el;
}

function stepBody(o, act) {
  const u = uiFor(o.step);
  const reply = async (choice, extra = {}) => {
    if (u.busy) return false;
    u.busy = true;
    u.error = null;
    try {
      return await act.reply(o.step, choice, extra);
    } finally {
      u.busy = false;
    }
  };
  const row = (...kids) => h('div', { class: 'sx-actions' }, ...kids);
  // 앱이 묻는 말의 답은 답 후보 줄이다(v2.0). 줄의 글자가 곧 내 말풍선이 된다(main이 같은 말을 기록한다).
  const answer = (label, choice, extra) => ({ label, onPick: () => reply(choice, extra), attrs: { 'data-onb': choice } });
  const card = (title, ...kids) => h('section', { class: 'sx-card onb-card', 'data-onb-step': o.step }, h('div', { class: 'sx-card-hd' }, h('div', { class: 'sx-card-title' }, title)), ...kids);
  const notice = o.notice ? note(o.notice, true) : null;

  switch (o.step) {
    case 'terms':
    case 'model':
    case 'telemetry':
    case 'delegation':
      return consentCard(o, reply);
    case 'welcome':
      return replyOptions([answer('사업자번호로 입력할게요', 'number'), answer('사업자등록증 올리기', 'upload'), answer('나중에 할게요', 'later')], { 'data-onb-step': o.step });
    case 'biz-number': {
      // 거부 글을 보이려 다시 그려도 넣던 값이 남게 u.vals에 둔다
      const name = h('input', { class: 'doc-in', name: 'name', autocomplete: 'off', placeholder: '사업자등록증의 상호', maxlength: 100, 'aria-label': '상호', value: u.vals?.name ?? '' });
      const input = h('input', { class: 'doc-in', name: 'bizNo', inputmode: 'numeric', autocomplete: 'off', placeholder: '000-00-00000', maxlength: 14, 'aria-label': '사업자번호', value: u.vals?.bizNo ?? '' });
      const form = h(
        'form',
        { class: 'cp-form', onkeydown: formKeys(() => reply('back')), onsubmit: (e) => (e.preventDefault(), (u.vals = { name: name.value, bizNo: input.value }), reply('submit', { fields: { ...u.vals } })) },
        h('label', { class: 'cp-field' }, h('span', { class: 'sx-meta' }, '상호'), name),
        h('label', { class: 'cp-field' }, h('span', { class: 'sx-meta' }, '사업자번호(10자리)'), input),
        row(h('button', { type: 'submit', class: 'sx-btn sx-btn-primary', 'data-onb': 'submit' }, '확인'), btn('뒤로', () => reply('back'), 'sx-btn-quiet', { 'data-onb': 'back' })),
      );
      return card('사업자번호로 등록', notice, p('대표자·주소 등은 나중에 내 사업장에서 채워도 돼요.', true), form);
    }
    case 'biz-confirm':
      return bizCard(o, u, reply, answer, act);
    case 'auth':
      return authCard(o, u, reply, answer, act);
    case 'tasks':
      return tasksCard(o, u, reply, act);
    case 'counterparties':
      return card(
        '거래처 등록',
        p('받는 이메일과 품목을 저장해 두면 발급할 때 다시 묻지 않아요.'),
        replyOptions([{ label: '거래처를 추가할게요', lock: false, onPick: () => act.go('cps'), attrs: { 'data-onb': 'go-cps' } }, answer('다 했어요', 'done'), answer('나중에 할게요', 'later')]),
      );
    case 'summary':
      return summaryCard(o, answer);
    case 'first':
      return replyOptions([answer('지금 해 볼게요', 'try'), answer('나중에 할게요', 'later')], { 'data-onb-step': o.step });
  }
  return h('div');
}

/** 동의 화면 하나(①~④). 화면마다 명시 클릭. 거절·다른 길 버튼은 동의 버튼과 같은 무게로 둔다(D05 §9 동등 노출). */
function consentCard(o, reply) {
  const n = o.consent;
  const buttons = {
    terms: [btn('동의하고 시작', () => reply('agree'), 'sx-btn-primary', { 'data-onb': 'agree' })],
    // ②는 약관처럼 필수다(사용자 결정 2026-11-10: 오프라인 해석은 없다). 거절 버튼이 없다.
    model: [btn('동의하고 계속', () => reply('agree'), 'sx-btn-primary', { 'data-onb': 'agree' })],
    // 기본 꺼짐: [끄고 계속]을 먼저 둔다
    telemetry: [btn('끄고 계속', () => reply('off'), 'sx-btn-primary', { 'data-onb': 'off' }), btn('켜기', () => reply('on'), '', { 'data-onb': 'on' })],
    delegation: [btn('동의하고 금고 창 열기', () => reply('agree'), 'sx-btn-primary', { 'data-onb': 'agree' }), btn('다른 인증으로 바꾸기', () => reply('switch'), '', { 'data-onb': 'switch' })],
  }[o.step];
  const table =
    (o.step === 'model' || o.step === 'terms') && o.config
      ? h(
          'table',
          { class: 'onb-table', 'data-processors': o.config.processorsVersion },
          h('thead', {}, h('tr', {}, h('th', {}, '처리하는 곳'), h('th', {}, '하는 일'), h('th', {}, '나라'), h('th', {}, '보관'))),
          h('tbody', {}, ...o.config.processors.map((x) => h('tr', {}, h('td', {}, x.name), h('td', {}, x.role), h('td', {}, x.country), h('td', {}, x.retention)))),
        )
      : null;
  return h(
    'section',
    { class: 'sx-card onb-card onb-consent', 'data-onb-step': o.step, 'data-consent': n.key, 'data-consent-version': n.version },
    h('div', { class: 'sx-card-hd' }, h('div', { class: 'sx-card-title' }, n.title)),
    o.notice ? note(o.notice, true) : null,
    h('ul', { class: 'onb-lines' }, ...n.lines.map((l) => h('li', {}, l))),
    table,
    h('div', { class: 'sx-actions' }, ...buttons),
  );
}

function bizCard(o, u, reply, answer, act) {
  const b = o.biz ?? {};
  const active = o.check?.status === 'active';
  const rows = [
    ['상호', b.name || '—'],
    ['사업자번호', fmtBiz(b.bizNo), { mono: true }],
    ['대표자', b.rep || '—'],
    ['업태·종목', [b.bizType, b.bizItem].filter(Boolean).join(' · ') || '—'],
    ['사업장 주소', b.address || '—'],
    ['사업자 이메일', b.email || '—'],
    ['상태', o.check?.label ?? '—', { tag: o.check?.source, state: active ? null : 'attention' }],
  ];
  const head = h('div', { class: 'sx-card-hd' }, h('div', { class: 'sx-card-title' }, '사업자 등록'));
  const privacy = p('등록증 파일은 이 PC 안에서만 읽어요', true);
  if (u.editing) {
    const cancel = () => ((u.editing = false), (u.fields = null), (u.error = null), act.rerender());
    // 거부되어 다시 그릴 때는 고치던 값(u.fields)을 그대로 둔다
    const field = (label, name, value, attrs = {}) => h('label', { class: 'cp-field' }, h('span', { class: 'sx-meta' }, label), h('input', { class: 'doc-in', name, value: u.fields?.[name] ?? value ?? '', autocomplete: 'off', ...attrs }));
    const form = h(
      'form',
      {
        class: 'cp-form',
        onkeydown: formKeys(cancel),
        onsubmit: async (e) => {
          e.preventDefault();
          const f = new FormData(form);
          const fields = Object.fromEntries(['name', 'bizNo', 'rep', 'bizType', 'bizItem', 'address', 'email'].map((k) => [k, String(f.get(k) ?? '')]));
          // 저장한 내용으로 다시 그릴 때 읽기 모양이 되게 먼저 내린다. 거부되면(번호 틀림 등) 고치던 칸으로 돌아간다.
          u.editing = false;
          u.fields = fields;
          if (!(await reply('edit', { fields }))) {
            u.editing = true;
            act.rerender();
          }
        },
      },
      field('상호', 'name', b.name, { maxlength: 100 }),
      field('사업자번호', 'bizNo', fmtBiz(b.bizNo), { inputmode: 'numeric', maxlength: 14 }),
      field('대표자', 'rep', b.rep, { maxlength: 100 }),
      field('업태', 'bizType', b.bizType, { maxlength: 100 }),
      field('종목', 'bizItem', b.bizItem, { maxlength: 100 }),
      field('사업장 주소', 'address', b.address, { maxlength: 200 }),
      field('사업자 이메일', 'email', b.email, { type: 'email', maxlength: 320 }),
      h('div', { class: 'sx-actions' }, h('button', { type: 'submit', class: 'sx-btn sx-btn-primary', 'data-onb': 'save' }, '저장'), btn('취소', cancel, 'sx-btn-quiet', { 'data-onb': 'cancel-edit' })),
    );
    return h('section', { class: 'sx-card onb-card', 'data-onb-step': o.step }, head, form, privacy);
  }
  const unknown = o.check?.status === 'unknown';
  const named = !!(b.name ?? '').trim();
  // 확인하지 못했다는 사실을 그대로 보인다(팀장 결정 2026-11-10). [맞습니다]를 눌러야 확정된다.
  const stop = !active && o.check ? note(unknown ? '국세청 확인을 하지 못했습니다. 번호가 맞는지 확인해 주세요.' : `${o.check.label} 상태라 등록을 멈췄어요. 번호가 맞는지 확인해 주세요.`, true) : null;
  return h(
    'section',
    { class: 'sx-card onb-card', 'data-onb-step': o.step },
    head,
    kv(rows, true),
    o.notice ? note(o.notice, true) : null,
    stop,
    privacy,
    p('계정마다 사업자 1곳만 등록하고, 바꾸면 90일 뒤에 다시 바꿀 수 있어요.', true),
    replyOptions(
      [
        // 상호가 비었으면 확정 줄이 없고 [고칠게요]가 맨 위다(main도 name_required로 거부한다)
        active && named ? answer('맞아요', 'confirm') : null,
        unknown && named ? { ...answer('맞습니다', 'confirm_unverified'), attrs: { 'data-onb': 'confirm-unverified' } } : null,
        // 그 자리에서 폼을 연다(굳지 않는다)
        { label: '고칠게요', lock: false, onPick: () => ((u.editing = true), act.rerender()), attrs: { 'data-onb': 'edit' } },
        unknown ? answer('다시 조회해 주세요', 'recheck') : null,
        answer('나중에 할게요', 'later'),
      ].filter(Boolean),
    ),
  );
}

/**
 * [홈택스 인증서](B4): 이 PC에서 찾은 공동인증서를 답 후보 줄로 보인다. 줄을 누르면 그 인증서로 정한다(이름은 main이 프로필에 둔다, 비밀번호는 첫 발급 때 금고 창).
 * 따로 확정 단추를 두지 않는다. 잘못 골라도 설정 > 발급 인증에서 바꾼다.
 * 보안 프로그램(MagicLine4NX)이 없거나 꺼져 있으면 같은 화면 위에 설치·켜기를 보인다. 다른 인증(보안카드·금융인증서·간편인증)은 [다른 방법]에 접어 둔다. 간편인증은 맨 뒤다(대표 지시 2026-11-14).
 */
function authCard(o, u, reply, answer, act) {
  const today = new Date();
  const soon = (c) => (new Date(`${c.expiresOn}T00:00:00`) - today) / 86_400_000 <= 30;
  const usable = (c) => c.usable !== false;
  const WHY = { no_key: '이 PC에 개인키 파일이 없어 쓸 수 없어요', expired: '만료되어 쓸 수 없어요' };
  const twoLines = (name, meta, attention) => h('span', { class: 'opt-main' }, h('span', {}, name), h('span', { class: `sx-meta${attention ? ' is-attention' : ''}` }, meta));
  // 고를 수 있는 인증서가 위다(맨 위 줄이 가장 그럴듯한 답). 고를 수 없는 것은 이유와 함께 흐리게 남긴다.
  const certs = [...o.certs]
    .sort((a, b) => usable(b) - usable(a))
    .map((c) => ({
      label: twoLines(`${c.owner} · ${c.usage}`, usable(c) ? `만료 ${c.expiresOn}${soon(c) ? ' · 30일 안에 만료돼요' : ''}` : `만료 ${c.expiresOn} · ${WHY[c.why] ?? '쓸 수 없어요'}`, !usable(c) || soon(c)),
      onPick: () => reply('cert', { certId: c.id }),
      attrs: { 'data-cert': c.id, disabled: !usable(c) },
    }));
  const others = u.showCerts
    ? AUTH.filter(([k]) => k !== 'cert').map(([k, label, line]) =>
        // 보안카드는 그 자리에서 카드 사진을 받는다(굳지 않고, 다시 누르면 접는다)
        k === 'card' ? { label: twoLines(label, line), lock: false, onPick: () => ((u.cardReg = !u.cardReg), act.rerender()), attrs: { 'data-onb': k, 'aria-expanded': String(!!u.cardReg) } } : answer(twoLines(label, line), k),
      )
    : [];
  const replies = replyOptions(
    [
      ...certs,
      ...others,
      { label: u.showCerts ? '다른 방법 접기' : '다른 방법으로 할게요', lock: false, onPick: () => ((u.showCerts = !u.showCerts), act.rerender()), attrs: { 'data-onb': 'other', 'aria-expanded': String(!!u.showCerts) } },
      answer('나중에 할게요', 'later'),
    ],
    { 'data-onb-certs': '' },
  );
  // 보안카드: 저장되면 main이 인증을 보안카드로 정하고 온보딩 화면을 돌려준다(렌더러가 다시 답하지 않는다, 따로 확인 없음)
  if (u.showCerts && u.cardReg)
    replies.querySelector('[data-onb=card]').after(
      (u.cardEl ??= cardRegister({
        call: act.call,
        onboarding: true,
        onStored: (r) => {
          act.toast(`보안카드 ${r.stored}칸을 이 PC 금고에 등록했어요`);
          act.applied(r);
        },
        skip: () => reply('card'),
      })),
    );
  // 보안 프로그램 점검(비동기): 자리를 먼저 두고 결과가 오면 채운다
  const sec = h('div', { 'data-onb-security': '' });
  if (act.security)
    act.security
      .check()
      .then((st) => {
        if (st.state === 'missing' || st.state === 'stopped') sec.append(securityBox(st, act.security, () => act.toast('보안 프로그램이 준비됐어요')));
      })
      .catch(() => {});
  return h(
    'section',
    { class: 'sx-card onb-card', 'data-onb-step': o.step },
    h('div', { class: 'sx-card-hd' }, h('div', { class: 'sx-card-title' }, '홈택스 인증서')),
    sec,
    o.certs.length ? null : note('이 PC에서 공동인증서를 찾지 못했어요. 인증서를 이 PC로 옮긴 뒤 다시 열거나, 다른 방법으로 발급할 수 있어요.', true),
    replies,
  );
}

/**
 * 고를 수 있는 일은 지금 되는 일(now)뿐이다. 그 일을 미리 골라 둔다(마칠 때 기본값과 같다).
 * 여러 개를 고르는 질문이라 줄이 굳지 않는다: 답 후보 줄과 같은 모양에 켜고 끄는 체크를 두고, [다음] 하나로 보낸다.
 */
function tasksCard(o, u, reply, act) {
  const now = o.tasksCatalog.filter((t) => t.now);
  u.tasks ??= Object.fromEntries(now.map((t) => [t.id, true]));
  const rows = now.map((t) => h('button', { type: 'button', class: 'sx-reply', 'aria-pressed': String(!!u.tasks[t.id]), 'data-task': t.id, onclick: () => ((u.tasks[t.id] = !u.tasks[t.id]), act.rerender()) }, h('span', {}, t.label), u.tasks[t.id] ? icon('check') : null));
  const any = Object.values(u.tasks).some(Boolean);
  return h(
    'section',
    { class: 'sx-card onb-card', 'data-onb-step': o.step },
    h('div', { class: 'sx-card-hd' }, h('div', { class: 'sx-card-title' }, '맡길 업무')),
    h('div', { class: 'sx-replies', role: 'group', 'aria-label': '맡길 업무' }, ...rows),
    h('div', { class: 'sx-actions' }, btn('다음', () => reply('submit', { tasks: { ...u.tasks } }), 'sx-btn-primary', { 'data-onb': 'submit', disabled: !any }), btn('나중에', () => reply('later'), 'sx-btn-quiet', { 'data-onb': 'later' })),
  );
}

function summaryCard(o, answer) {
  const b = o.biz;
  const skipped = new Set(o.skipped);
  const tasks = o.tasksCatalog.filter((t) => o.tasks.includes(t.id)).map((t) => t.label);
  const rows = [
    ['사업자', b && !skipped.has('biz') ? `${b.name || '이름 미입력'} · ${fmtBiz(b.bizNo)}` : '나중에 등록'],
    ['발급 인증', o.auth ? `${AUTH_LABEL[o.auth]}${o.registered ? ' · 금고에 등록함' : ''}` : '나중에 고르기'],
    ['맡긴 업무', tasks.length ? tasks.join(', ') : '나중에 고르기'],
    ['서류 보관', '이 PC 앱 폴더 안 보관함(기본)'],
  ];
  return h(
    'section',
    { class: 'sx-card onb-card', 'data-onb-step': o.step },
    h('div', { class: 'sx-card-hd' }, h('div', { class: 'sx-card-title' }, '등록 내용')),
    kv(rows, true),
    h(
      'div',
      { class: 'onb-scope', 'data-onb-scope': '' },
      h('div', { class: 'onb-sub' }, '이 앱이 하는 일과 하지 않는 일'),
      h('ul', { class: 'onb-lines' }, ...scopeLines(o.tasksCatalog).map((l) => h('li', {}, l))),
    ),
    skipped.size ? p('건너뛴 항목은 이번 달 할 일에 남겨 둘게요.', true) : null,
    replyOptions([answer('확인했어요', 'ok')]),
  );
}
