// 온보딩 대화(08 §4 O-01~O-06)와 동의 화면 4종(F-06 자리표시). 상태는 main(onboarding.ts)이 갖고, 렌더러는 그리고 답을 보낼 뿐이다.
// - 비밀(홈택스 비밀번호·보안카드)은 여기서 받지 않는다. ①에 동의하면 main이 금고 등록 창(T-06)을 연다.
// - 동의는 화면마다 한 번씩 누른다. 묶음 동의 버튼은 없다.
import { btn, fmtBiz, h, kv, note } from './shell-views.js';

const Q = {
  terms: '시작하기 전에 약관과 처리방침을 확인해 주세요.',
  welcome: '세금계산서 발급과 홈택스 증명서 발급을 대신 해 드려요. 먼저 사업자를 등록할게요.',
  'biz-number': '사업자번호를 알려 주세요.',
  'biz-confirm': '등록 내용을 확인해 주세요.',
  auth: '세금계산서를 발급할 때 어떤 인증을 쓰세요? 한 번 고르면 모든 발급에 쓰고, 설정에서만 바꿔요.',
  delegation: '보안카드를 쓰려면 먼저 이 PC 금고에 등록해야 해요.',
  model: '대화는 AI 모델로 해석해요. 아래 내용을 확인하고 동의해 주세요.',
  telemetry: '앱을 고치는 데 쓸 사용 기록을 보내 주시겠어요? 안 보내도 돼요.',
  tasks: '어떤 일을 맡기고 싶으세요? 여러 개 골라도 돼요.',
  counterparties: '세금계산서를 보낼 거래처를 등록할까요?',
  summary: '등록을 마쳤어요. 내용을 확인해 주세요.',
  first: '사업자등록증명을 한 번 떼 볼까요? 돈이 오가지 않아 연습하기 좋아요.',
};

/** O-03 수단마다 앱이 맡는 정도 한 줄(08 §4). */
const AUTH = [
  ['card', '보안카드', '한 번 등록하면 발급 때마다 앱이 알아서 입력해요.'],
  ['simple', '사업자 간편인증', '카카오뱅크·IBK·KB 앱에서 발급할 때마다 승인해요.'],
  ['cert', '공동인증서', '비밀번호는 매번 직접 입력해요. 이 PC에서 찾은 인증서에서 골라요.'],
  ['fincert', '금융인증서', '6자리 비밀번호를 매번 직접 입력해요.'],
];
const AUTH_LABEL = Object.fromEntries(AUTH.map(([k, l]) => [k, l]));

/** O-06 축소 범위·운영 수준 고지(F-06 자리표시). */
const SCOPE_LINES = [
  '지금 되는 일: 세금계산서 발급·메일 전송, 사업자등록증명, 납세증명서',
  '정부24 서류는 직접 발급을 안내하고, 저장한 파일만 문서함에 정리해요',
  '신고와 세금 판단은 하지 않아요. 신고에 필요한 증명서는 뗄 수 있어요',
  '홈택스 화면이 달라지거나 값을 확실히 읽지 못하면 발급하지 않고 멈춰요',
];

// 단계 안의 화면 상태(고치는 중·고른 인증서·고른 업무). 단계가 바뀌면 비운다.
let ui = { step: null, editing: false, certId: null, showCerts: false, tasks: {}, busy: false };
const uiFor = (step) => {
  if (ui.step !== step) ui = { step, editing: false, certId: null, showCerts: false, tasks: {}, busy: false };
  return ui;
};

const p = (text, muted) => h('p', { class: `sx-body-sm${muted ? ' is-muted' : ''}` }, text);
const draftTag = (n) => (n?.draft ? h('span', { class: 'sx-meta onb-draft', 'data-draft': n.key }, n.draft) : null);

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
  const u = uiFor(o.step);
  const reply = async (choice, extra = {}) => {
    if (u.busy) return false;
    u.busy = true;
    try {
      return await act.reply(o.step, choice, extra);
    } finally {
      u.busy = false;
    }
  };
  const row = (...kids) => h('div', { class: 'sx-actions' }, ...kids);
  const card = (title, ...kids) => h('section', { class: 'sx-card onb-card', 'data-onb-step': o.step }, h('div', { class: 'sx-card-hd' }, h('div', { class: 'sx-card-title' }, title)), ...kids);
  const notice = o.notice ? note(o.notice, true) : null;

  switch (o.step) {
    case 'terms':
    case 'model':
    case 'telemetry':
    case 'delegation':
      return consentCard(o, reply);
    case 'welcome':
      return h(
        'div',
        { class: 'sx-quick onb-chips', 'data-onb-step': o.step },
        h('button', { type: 'button', 'data-onb': 'upload', onclick: () => reply('upload') }, '사업자등록증 올리기'),
        h('button', { type: 'button', 'data-onb': 'number', onclick: () => reply('number') }, '사업자번호로 입력'),
        h('button', { type: 'button', class: 'is-soon', 'data-onb': 'later', onclick: () => reply('later') }, '나중에'),
      );
    case 'biz-number': {
      const input = h('input', { class: 'doc-in', name: 'bizNo', inputmode: 'numeric', autocomplete: 'off', placeholder: '000-00-00000', maxlength: 14, 'aria-label': '사업자번호' });
      const form = h(
        'form',
        { class: 'cp-form', onsubmit: (e) => (e.preventDefault(), reply('submit', { fields: { bizNo: input.value } })) },
        h('label', { class: 'cp-field' }, h('span', { class: 'sx-meta' }, '사업자번호(10자리)'), input),
        row(h('button', { type: 'submit', class: 'sx-btn sx-btn-primary', 'data-onb': 'submit' }, '확인'), btn('뒤로', () => reply('back'), 'sx-btn-quiet', { 'data-onb': 'back' })),
      );
      return card('사업자번호로 등록', notice, p('번호만 국세청 진위확인에 보내요. 나머지는 첫 홈택스 로그인 때 채워요.', true), form);
    }
    case 'biz-confirm':
      return bizCard(o, u, reply, act);
    case 'auth':
      return authCard(o, u, reply, act);
    case 'tasks':
      return tasksCard(o, u, reply, act);
    case 'counterparties':
      return card(
        '거래처 등록',
        p('거래처마다 받는 이메일과 자주 쓰는 품목을 저장해 두면 발급할 때 다시 묻지 않아요. 부가세 별도·포함은 요청할 때 정해요.'),
        p('등록증 여러 장 끌어 놓기는 곧 돼요. 지금은 번호로 추가해요.', true),
        row(btn('거래처 화면에서 추가', () => act.go('cps'), '', { 'data-onb': 'go-cps' }), btn('다 했어요', () => reply('done'), 'sx-btn-primary', { 'data-onb': 'done' }), btn('나중에', () => reply('later'), 'sx-btn-quiet', { 'data-onb': 'later' })),
      );
    case 'summary':
      return summaryCard(o, reply, act);
    case 'first':
      return h(
        'div',
        { class: 'sx-quick onb-chips', 'data-onb-step': o.step },
        h('button', { type: 'button', 'data-onb': 'try', onclick: () => reply('try') }, '지금 해 보기'),
        h('button', { type: 'button', 'data-onb': 'invoice', onclick: () => reply('invoice') }, '세금계산서 1건 발급'),
        h('button', { type: 'button', class: 'is-soon', 'data-onb': 'later', onclick: () => reply('later') }, '나중에'),
      );
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
    o.step === 'model' && o.config
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
    h('div', { class: 'sx-card-hd' }, h('div', { class: 'sx-card-title' }, n.title), draftTag(n)),
    o.notice ? note(o.notice, true) : null,
    h('ul', { class: 'onb-lines' }, ...n.lines.map((l) => h('li', {}, l))),
    table,
    h('div', { class: 'sx-actions' }, ...buttons),
    o.step === 'terms' ? h('div', { class: 'sx-meta' }, '약관 전문과 처리방침 전문은 F-06이 확정되면 여기서 열어 볼 수 있어요.') : null,
  );
}

function bizCard(o, u, reply, act) {
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
  const head = h('div', { class: 'sx-card-hd' }, h('div', { class: 'sx-card-title' }, '사업자 등록'), h('span', { class: 'sx-meta' }, 'O-02'));
  const privacy = p('등록증 파일은 이 PC 안에서만 읽어요 · 사업자번호만 국세청 진위확인에 보내요(기본: 우리 서버 경유, 설정에서 내 키)', true);
  if (u.editing) {
    const field = (label, name, value, attrs = {}) => h('label', { class: 'cp-field' }, h('span', { class: 'sx-meta' }, label), h('input', { class: 'doc-in', name, value: value ?? '', autocomplete: 'off', ...attrs }));
    const form = h(
      'form',
      {
        class: 'cp-form',
        onsubmit: async (e) => {
          e.preventDefault();
          const f = new FormData(form);
          const fields = Object.fromEntries(['name', 'bizNo', 'rep', 'bizType', 'bizItem', 'address', 'email'].map((k) => [k, String(f.get(k) ?? '')]));
          // 저장한 내용으로 다시 그릴 때 읽기 모양이 되게 먼저 내린다. 거부되면(번호 틀림 등) 고치던 칸으로 돌아간다.
          u.editing = false;
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
      h('div', { class: 'sx-actions' }, h('button', { type: 'submit', class: 'sx-btn sx-btn-primary', 'data-onb': 'save' }, '저장'), btn('취소', () => ((u.editing = false), act.rerender()), 'sx-btn-quiet', { 'data-onb': 'cancel-edit' })),
    );
    return h('section', { class: 'sx-card onb-card', 'data-onb-step': o.step }, head, form, privacy);
  }
  const unknown = o.check?.status === 'unknown';
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
    h(
      'div',
      { class: 'sx-actions' },
      active ? btn('맞아요', () => reply('confirm'), 'sx-btn-primary', { 'data-onb': 'confirm' }) : null,
      unknown ? btn('맞습니다', () => reply('confirm_unverified'), 'sx-btn-primary', { 'data-onb': 'confirm-unverified' }) : null,
      unknown ? btn('다시 조회', () => reply('recheck'), '', { 'data-onb': 'recheck' }) : null,
      btn('고칠게요', () => ((u.editing = true), act.rerender()), active || unknown ? '' : 'sx-btn-primary', { 'data-onb': 'edit' }),
      btn('나중에', () => reply('later'), 'sx-btn-quiet', { 'data-onb': 'later' }),
    ),
  );
}

function authCard(o, u, reply, act) {
  const today = new Date();
  const soon = (c) => (new Date(`${c.expiresOn}T00:00:00`) - today) / 86_400_000 <= 30;
  const opts = AUTH.map(([k, label, line]) =>
    h(
      'button',
      { type: 'button', class: `sx-opt onb-auth${k === 'cert' && u.showCerts ? ' is-on' : ''}`, 'data-onb': k, 'aria-pressed': String(k === 'cert' && u.showCerts), onclick: () => (k === 'cert' ? ((u.certId = u.certId ?? o.certs.find((c) => c.usable !== false)?.id ?? null), (u.showCerts = true), act.rerender()) : reply(k)) },
      h('span', { class: 'sx-radio' }),
      h('span', { class: 'onb-auth-main' }, h('b', {}, label), h('span', { class: 'sx-meta' }, line)),
    ),
  );
  const usable = (c) => c.usable !== false;
  const WHY = { no_key: '이 PC에 개인키 파일이 없어 쓸 수 없어요', expired: '만료되어 쓸 수 없어요' };
  const certs =
    u.showCerts &&
    h(
      'div',
      { class: 'onb-certs', 'data-onb-certs': '' },
      o.certs.length
        ? [
            ...o.certs.map((c) =>
              h(
                'button',
                { type: 'button', class: `sx-opt${u.certId === c.id ? ' is-on' : ''}`, 'data-cert': c.id, 'aria-pressed': String(u.certId === c.id), disabled: !usable(c), onclick: () => ((u.certId = c.id), act.rerender()) },
                h('span', { class: 'sx-radio' }),
                h(
                  'span',
                  { class: 'onb-auth-main' },
                  h('b', {}, `${c.owner} · ${c.usage}`),
                  h('span', { class: `sx-meta${!usable(c) || soon(c) ? ' is-attention' : ''}` }, usable(c) ? `만료 ${c.expiresOn}${soon(c) ? ' · 30일 안에 만료돼요' : ''}` : `만료 ${c.expiresOn} · ${WHY[c.why] ?? '쓸 수 없어요'}`),
                ),
              ),
            ),
            h('div', { class: 'sx-actions' }, btn('이 인증서로', () => reply('cert', { certId: u.certId }), 'sx-btn-primary', { 'data-onb': 'cert-pick', disabled: !u.certId })),
          ]
        : p('이 PC에서 공동인증서를 찾지 못했어요. 다른 수단을 고르거나 인증서를 옮긴 뒤 다시 해 주세요.', true),
    );
  const explain = o.explain
    ? note('보안카드는 한 번 등록하면 앱이 입력해요. 간편인증은 매번 폰 앱에서 승인해요. 공동·금융인증서는 비밀번호를 매번 직접 넣어요.', false, o.certs.length ? `이 PC에서 공동인증서 ${o.certs.length}개를 찾았어요. 공동인증서를 쓰면 따로 등록할 것이 없어요.` : null)
    : null;
  return h(
    'section',
    { class: 'sx-card onb-card', 'data-onb-step': o.step },
    h('div', { class: 'sx-card-hd' }, h('div', { class: 'sx-card-title' }, '발급 인증'), h('span', { class: 'sx-meta' }, 'O-03')),
    explain,
    h('div', { class: 'onb-opts' }, ...opts),
    certs || null,
    h('div', { class: 'sx-actions' }, btn('잘 모르겠어요', () => reply('unsure'), '', { 'data-onb': 'unsure', disabled: o.explain }), btn('나중에', () => reply('later'), 'sx-btn-quiet', { 'data-onb': 'later' })),
  );
}

function tasksCard(o, u, reply, act) {
  const chips = o.tasksCatalog.map((t) =>
    t.now
      ? h('button', { type: 'button', class: u.tasks[t.id] ? 'is-on' : '', 'aria-pressed': String(!!u.tasks[t.id]), 'data-task': t.id, onclick: () => ((u.tasks[t.id] = !u.tasks[t.id]), act.rerender()) }, t.label)
      : h('button', { type: 'button', class: 'is-soon', 'data-task': t.id, 'data-soon': '', onclick: () => act.toast('지원되면 알려 드릴게요') }, t.label),
  );
  const any = Object.values(u.tasks).some(Boolean);
  return h(
    'section',
    { class: 'sx-card onb-card', 'data-onb-step': o.step },
    h('div', { class: 'sx-card-hd' }, h('div', { class: 'sx-card-title' }, '맡길 업무'), h('span', { class: 'sx-meta' }, 'O-04')),
    h('div', { class: 'sx-quick onb-tasks' }, ...chips),
    p('회색은 곧 되는 일이에요. 신고와 세금 판단은 하지 않아요.', true),
    h('div', { class: 'sx-actions' }, btn('다음', () => reply('submit', { tasks: { ...u.tasks } }), 'sx-btn-primary', { 'data-onb': 'submit', disabled: !any }), btn('나중에', () => reply('later'), 'sx-btn-quiet', { 'data-onb': 'later' })),
  );
}

function summaryCard(o, reply, act) {
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
    h('div', { class: 'sx-card-hd' }, h('div', { class: 'sx-card-title' }, '등록 내용'), h('span', { class: 'sx-meta' }, 'O-06')),
    kv(rows, true),
    h(
      'div',
      { class: 'onb-scope', 'data-onb-scope': '' },
      h('div', { class: 'sx-card-hd' }, h('div', { class: 'onb-sub' }, '이 앱이 하는 일과 하지 않는 일'), h('span', { class: 'sx-meta onb-draft' }, 'F-06 초안 전 문구')),
      h('ul', { class: 'onb-lines' }, ...SCOPE_LINES.map((l) => h('li', {}, l))),
    ),
    skipped.size ? p('건너뛴 항목은 이번 달 할 일에 남겨 둘게요.', true) : null,
    h('div', { class: 'sx-actions' }, btn('확인했어요', () => reply('ok'), 'sx-btn-primary', { 'data-onb': 'ok' }), btn('보관 위치 바꾸기', () => act.toast('보관 위치는 설정에서 바꿔요(준비 중)'), 'sx-btn-quiet', { 'data-onb': 'storage' })),
  );
}
