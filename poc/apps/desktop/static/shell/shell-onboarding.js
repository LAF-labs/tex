import { btn, fmtBiz, h, icon, kv, note, noteGroup, replyOptions, securityBox } from './shell-views.js';
import { bizDigits, bizNoInput, checkFields, emailInput, field, keys, LIMITS, textInput } from './fields.js';

const Q = {
  terms: '시작하기 전에 약관과 AI 모델 이용을 한 번 확인해 주세요.',
  welcome: '반가워요. 세금계산서 발급을 맡아 드릴게요. 먼저 사업자부터 확인할게요.',
  'biz-number': '상호와 사업자번호를 알려 주세요. 홈택스에 등록된 것과 같아야 해요.',
  'biz-confirm': '이렇게 등록할게요. 맞는지 봐 주세요.',
  auth: '홈택스 로그인과 서명에 쓸 인증서를 골라 주세요. 비밀번호는 첫 발급 때 한 번만 여쭤봐요.',
  model: '말씀을 알아듣는 데 AI 모델을 써요. 아래 내용을 보고 동의해 주세요.',
  telemetry: '앱을 고치는 데 쓸 사용 기록을 보내 주실래요? 안 보내도 다 쓸 수 있어요.',
  tasks: '어떤 일을 맡기고 싶으세요? 나중에 바꿀 수 있어요.',
  counterparties: '세금계산서를 자주 보내는 거래처가 있으면 지금 등록해 둘까요?',
  summary: '다 됐어요. 등록한 내용이에요.',
  first: '세금계산서 하나를 같이 발급해 볼까요? 입력창에 요청을 채워 드릴게요.',
};

const AUTH = [
  ['cert', '공동인증서', '홈택스 로그인에 쓰는 그 인증서예요. 비밀번호를 처음 한 번 넣으면 다음부터는 앱이 넣어요.'],
  ['fincert', '금융인증서', '발급할 때마다 6자리 인증서 비밀번호를 직접 넣어요.'],
  ['simple', '사업자 간편인증', '발급할 때마다 휴대폰(카카오뱅크/IBK/KB 앱)에서 승인해요.'],
];
const AUTH_LABEL = Object.fromEntries(AUTH.map(([k, l]) => [k, l]));

const scopeLines = (catalog) => [
  `지금 되는 일: ${catalog.filter((t) => t.now).map((t) => t.label).join(', ')}`,
  '정부24 서류는 직접 발급을 안내하고, 저장한 파일만 문서함에 정리해요',
  '신고와 세금 판단은 하지 않아요',
  '홈택스 화면이 달라지거나 값을 확실히 읽지 못하면 발급하지 않고 멈춰요',
];

let ui = { step: null, editing: false, showCerts: false, tasks: null, busy: false };
const uiFor = (step) => {
  if (ui.step !== step) ui = { step, editing: false, showCerts: false, tasks: null, busy: false };
  return ui;
};

export function showOnbError(step, text, code) {
  const u = uiFor(step);
  u.error = text;
  u.errorField = ERR_FIELD[code] ?? null;
}
const ERR_FIELD = { bad_biz_no: 'bizNo', biz_inactive: 'bizNo', name_required: 'name', bad_email: 'email' };
const errFor = (u, name) => (u.error && u.errorField === name ? u.error : null);

const p = (text, muted) => h('p', { class: `sx-body-sm${muted ? ' is-muted' : ''}` }, text);

export function onboardingView(o, act) {
  const items = [];
  let last = null;
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
  if (u.error && !el.querySelector('.sx-field-error:not([hidden])')) el.append(h('p', { class: 'form-msg is-bad', role: 'status', 'data-onb-error': '' }, u.error));
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
  const answer = (label, choice, extra) => ({ label, onPick: () => reply(choice, extra), attrs: { 'data-onb': choice } });
  const card = (title, ...kids) => h('section', { class: 'sx-card onb-card', 'data-onb-step': o.step }, h('div', { class: 'sx-card-hd' }, h('div', { class: 'sx-card-title' }, title)), ...kids);
  const notice = o.notice ? note(o.notice, true) : null;

  switch (o.step) {
    case 'terms':
    case 'model':
    case 'telemetry':
      return consentCard(o, reply, act);
    case 'welcome':
      return replyOptions([answer('사업자번호로 입력할게요', 'number'), answer('사업자등록증 올리기', 'upload'), answer('나중에 할게요', 'later')], { 'data-onb-step': o.step });
    case 'biz-number': {
      const name = textInput({ name: 'name', max: LIMITS.name, value: u.vals?.name });
      const input = bizNoInput({ name: 'bizNo', required: true, value: u.vals?.bizNo });
      const submit = (e) => {
        e.preventDefault();
        if (!checkFields(form)) return;
        u.vals = { name: name.value, bizNo: bizDigits(input.value) };
        reply('submit', { fields: { ...u.vals } });
      };
      const form = h(
        'form',
        { class: 'cp-form', novalidate: true, onkeydown: keys(() => form.requestSubmit(), () => reply('back')), onsubmit: submit },
        field({ label: '상호', input: name, help: '사업자등록증에 적힌 상호', error: errFor(u, 'name') }),
        field({ label: '사업자번호(10자리)', input, error: errFor(u, 'bizNo') }),
        row(h('button', { type: 'submit', class: 'sx-btn sx-btn-primary', 'data-onb': 'submit' }, '확인'), btn('뒤로', () => reply('back'), 'sx-btn-quiet', { 'data-onb': 'back' })),
      );
      return card('사업자번호로 등록', notice, p('대표자/주소 등은 나중에 내 사업장에서 채워도 돼요.', true), form);
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

function consentCard(o, reply, act) {
  const n = o.consent;
  const buttons = {
    terms: [btn('동의하고 시작', () => reply('agree'), 'sx-btn-primary', { 'data-onb': 'agree' })],
    model: [btn('동의하고 계속', () => reply('agree'), 'sx-btn-primary', { 'data-onb': 'agree' })],
    telemetry: [btn('끄고 계속', () => reply('off'), 'sx-btn-primary', { 'data-onb': 'off' }), btn('켜기', () => reply('on'), '', { 'data-onb': 'on' })],
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
    n.links?.length ? h('p', { class: 'onb-links' }, ...n.links.map((x) => btn(x.label, () => act.legal(x.doc), 'sx-btn-quiet', { 'data-legal': x.doc }))) : null,
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
    ['업태/종목', [b.bizType, b.bizItem].filter(Boolean).join(', ') || '—'],
    ['사업장 주소', b.address || '—'],
    ['사업자 이메일', b.email || '—'],
    ['상태', o.check?.label ?? '—', { tag: o.check?.source, state: active ? null : 'attention' }],
  ];
  const head = h('div', { class: 'sx-card-hd' }, h('div', { class: 'sx-card-title' }, '사업자 등록'));
  const privacy = p('등록증 파일은 이 PC 안에서만 읽어요', true);
  if (u.editing) {
    const cancel = () => ((u.editing = false), (u.fields = null), (u.error = null), act.rerender());
    const v = (name, value) => u.fields?.[name] ?? value ?? '';
    const text = (label, name, value) => field({ label, input: textInput({ name, value: v(name, value), max: LIMITS[name] }), error: errFor(u, name) });
    const form = h(
      'form',
      {
        class: 'cp-form',
        novalidate: true,
        onkeydown: keys(() => form.requestSubmit(), cancel),
        onsubmit: async (e) => {
          e.preventDefault();
          if (!checkFields(form)) return;
          const f = new FormData(form);
          const fields = Object.fromEntries(['name', 'bizNo', 'rep', 'bizType', 'bizItem', 'address', 'email'].map((k) => [k, String(f.get(k) ?? '')]));
          fields.bizNo = bizDigits(fields.bizNo);
          u.editing = false;
          u.fields = fields;
          if (!(await reply('edit', { fields }))) {
            u.editing = true;
            act.rerender();
          }
        },
      },
      text('상호', 'name', b.name),
      field({ label: '사업자번호', input: bizNoInput({ name: 'bizNo', required: true, value: v('bizNo', b.bizNo) }), error: errFor(u, 'bizNo') }),
      text('대표자', 'rep', b.rep),
      text('업태', 'bizType', b.bizType),
      text('종목', 'bizItem', b.bizItem),
      text('사업장 주소', 'address', b.address),
      field({ label: '사업자 이메일', input: emailInput({ name: 'email', value: v('email', b.email) }), error: errFor(u, 'email') }),
      h('div', { class: 'sx-actions' }, h('button', { type: 'submit', class: 'sx-btn sx-btn-primary', 'data-onb': 'save' }, '저장'), btn('취소', cancel, 'sx-btn-quiet', { 'data-onb': 'cancel-edit' })),
    );
    return h('section', { class: 'sx-card onb-card', 'data-onb-step': o.step }, head, form, privacy);
  }
  const unknown = o.check?.status === 'unknown';
  const named = !!(b.name ?? '').trim();
  const stop = !active && o.check ? (unknown ? '국세청 확인을 하지 못했어요. 번호가 맞는지 확인해 주세요.' : `${o.check.label} 상태라 등록을 멈췄어요. 번호가 맞는지 확인해 주세요.`) : null;
  return h(
    'section',
    { class: 'sx-card onb-card', 'data-onb-step': o.step },
    head,
    kv(rows, true),
    noteGroup([o.notice, stop]),
    privacy,
    p('계정마다 사업자 1곳만 등록하고, 바꾸면 90일 뒤에 다시 바꿀 수 있어요.', true),
    replyOptions(
      [
        active && named ? answer('맞아요', 'confirm') : null,
        unknown && named ? { ...answer('맞습니다', 'confirm_unverified'), attrs: { 'data-onb': 'confirm-unverified' } } : null,
        { label: '고칠게요', lock: false, onPick: () => ((u.editing = true), act.rerender()), attrs: { 'data-onb': 'edit' } },
        unknown ? answer('다시 조회해 주세요', 'recheck') : null,
        answer('나중에 할게요', 'later'),
      ].filter(Boolean),
    ),
  );
}

function authCard(o, u, reply, answer, act) {
  const today = new Date();
  const soon = (c) => (new Date(`${c.expiresOn}T00:00:00`) - today) / 86_400_000 <= 30;
  const usable = (c) => c.usable !== false;
  const WHY = { no_key: '이 PC에 개인키 파일이 없어 쓸 수 없어요', expired: '만료되어 쓸 수 없어요' };
  const twoLines = (name, meta, attention) => h('span', { class: 'opt-main' }, h('span', {}, name), h('span', { class: `sx-meta${attention ? ' is-attention' : ''}` }, meta));
  const certs = [...o.certs]
    .sort((a, b) => usable(b) - usable(a))
    .map((c) => ({
      label: twoLines(`${c.owner}, ${c.usage}`, usable(c) ? `만료 ${c.expiresOn}${soon(c) ? ', 30일 안에 만료돼요' : ''}` : `만료 ${c.expiresOn}, ${WHY[c.why] ?? '쓸 수 없어요'}`, !usable(c) || soon(c)),
      onPick: () => reply('cert', { certId: c.id }),
      attrs: { 'data-cert': c.id, disabled: !usable(c) },
    }));
  const others = u.showCerts ? AUTH.filter(([k]) => k !== 'cert').map(([k, label, line]) => answer(twoLines(label, line), k)) : [];
  const replies = replyOptions(
    [
      ...certs,
      ...others,
      { label: u.showCerts ? '다른 방법 접기' : '다른 방법으로 할게요', lock: false, onPick: () => ((u.showCerts = !u.showCerts), act.rerender()), attrs: { 'data-onb': 'other', 'aria-expanded': String(!!u.showCerts) } },
      answer('나중에 할게요', 'later'),
    ],
    { 'data-onb-certs': '' },
  );
  const noCert = o.certs.length
    ? null
    : h(
        'div',
        { class: 'sx-note is-attention', role: 'status', 'data-onb-nocert': '' },
        icon('warn'),
        h('div', { class: 'sx-note-body' }, h('b', { class: 'sx-note-title' }, '이 PC에서 공동인증서를 찾지 못했어요'), h('p', {}, '인증서를 이 PC로 옮긴 뒤 [다시 찾기]를 눌러 주세요. 인증서가 없으면 아래에서 다른 방법을 고를 수 있어요.'), h('div', { class: 'sx-actions' }, btn('다시 찾기', () => reply('rescan'), 'sx-btn-primary', { 'data-onb': 'rescan' }))),
      );
  const sec = h('div', { 'data-onb-security': '' });
  if (act.security)
    act.security
      .check()
      .then((st) => {
        if (st.state !== 'missing' && st.state !== 'stopped') return;
        if (noCert) noCert.hidden = true;
        sec.append(
          securityBox(st, act.security, () => {
            act.toast('보안 프로그램이 준비됐어요');
            if (noCert) noCert.hidden = false;
          }),
        );
      })
      .catch(() => {});
  return h(
    'section',
    { class: 'sx-card onb-card', 'data-onb-step': o.step },
    h('div', { class: 'sx-card-hd' }, h('div', { class: 'sx-card-title' }, '홈택스 인증서')),
    sec,
    noCert,
    replies,
  );
}

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
    ['사업자', b && !skipped.has('biz') ? `${b.name || '이름 미입력'}, ${fmtBiz(b.bizNo)}` : '나중에 등록'],
    ['발급 인증', o.auth ? AUTH_LABEL[o.auth] : '나중에 고르기'],
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
