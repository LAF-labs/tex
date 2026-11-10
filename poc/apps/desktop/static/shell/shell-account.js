// 계정 로그인(A-01: 이메일 → 비밀번호, 또는 이메일 6자리 코드)과 설정 > 기기 연결의 계정 줄. main(remote-account.ts)이 단계를 정하고 여기서는 그리기만 한다.
// 렌더러가 받는 값은 단계·이메일·코드 만료 시각·오류 코드뿐이다(세션·토큰은 main에만). 값은 모두 textContent·value로 넣는다.
import { pwRules } from './password-rules.js';
import { btn, h, icon } from './shell-views.js';

/** 오류 코드 → 문구. 모르는 코드는 일반 문구(코드를 화면에 보이지 않는다). */
const ERR = {
  'account.email_shape': '이메일 형식이 아니에요',
  'account.credentials_invalid': '이메일 또는 비밀번호가 맞지 않아요',
  'account.password_empty': '비밀번호를 넣어 주세요',
  'account.code_shape': '6자리 숫자를 넣어 주세요',
  'account.code_invalid': '코드가 맞지 않아요. 메일의 6자리를 다시 확인해 주세요',
  'account.code_locked': '여러 번 틀려서 이 코드는 막혔어요. 코드를 다시 받아 주세요',
  'account.code_expired': '코드 시간이 지났어요. 코드를 다시 받아 주세요',
  'account.aik_already_pinned': '이 계정에는 이미 등록된 PC가 있어요. 두 번째 PC 연결은 곧 지원해요',
  'account.passkey_required': '이 계정은 패스키로 로그인해야 해요. 패스키 로그인은 곧 지원해요',
  'account.device_limit': '이 계정에 등록할 수 있는 PC 수를 넘었어요',
  'account.device_churn_limit': '최근에 PC를 여러 번 바꿨어요. 며칠 뒤에 다시 해 주세요',
  'account.keys_unavailable': '금고가 열려 있지 않아요. 앱을 다시 켠 뒤 해 주세요',
  'policy.rate_limited': '요청이 많아요. 잠시 뒤에 다시 해 주세요',
  // 비밀번호 만들기 거부(인계 명세 §3.2). 어느 목록에 걸렸는지는 말하지 않는다. too_short는 문구 없이 조건 1줄이 어긋남이다.
  'account.password_breached': '많이 쓰이거나 이미 알려진 비밀번호예요. 다른 비밀번호를 써 주세요',
  'account.password_contains_identity': '이메일 주소가 들어간 비밀번호는 쓸 수 없어요',
  'account.password_contains_service': '서비스 이름이 들어간 비밀번호는 쓸 수 없어요',
  'account.password_too_long': '128자까지 쓸 수 있어요',
  'account.password_later': '지금은 비밀번호를 만들지 못했어요. 설정 > 계정에서 만들 수 있어요',
  gesture_required: '버튼을 다시 눌러 주세요',
  pair_unavailable: '이 빌드에서는 아직 폰을 연결할 수 없어요',
  account_required: '먼저 로그인해 주세요',
  busy: '처리 중이에요. 잠시만 기다려 주세요',
};
export const accountErrText = (code) => (code ? (ERR[code] ?? (code.startsWith('net.') ? '연결하지 못했어요. 인터넷 연결을 확인해 주세요' : '잠시 뒤에 다시 해 주세요')) : null);

/** 설정 > 기기 연결의 계정 줄. 로그인하면 [폰 연결](main 소유 창 S-03을 연다). */
export function accountCard(view, onLogin, onPair) {
  const v = view ?? { step: 'unavailable' };
  const body =
    v.step === 'unavailable'
      ? [h('p', { class: 'sx-body-sm is-muted' }, '이 빌드에서는 아직 계정에 연결할 수 없어요.')]
      : v.step === 'signed_in'
        ? [
            h('p', { class: 'sx-body-sm', 'data-account-email': '' }, v.email),
            h('p', { class: 'sx-meta', 'data-account-phones': String(v.phones ?? 0) }, v.phones ? `이 PC가 계정에 등록됐어요. 연결된 폰 ${v.phones}대.` : '이 PC가 계정에 등록됐어요. 아직 연결된 폰이 없어요.'),
            h('div', { class: 'sx-actions' }, btn('폰 연결', onPair, 'sx-btn-primary', { 'data-act': 'pair-open' }), h('span', { class: 'sx-meta' }, '새 창에 QR이 떠요. 폰 앱으로 찍고 폰에 보이는 6자리를 PC에 넣어요.')),
          ]
        : [h('p', { class: 'sx-body-sm is-muted' }, '폰을 연결하려면 먼저 로그인해 주세요. 비밀번호나 메일로 받은 6자리 코드로 들어가요.'), h('div', { class: 'sx-actions' }, btn('로그인', onLogin, 'sx-btn-primary', { 'data-act': 'account-login' }))];
  return h('div', { class: 'sx-card', 'data-account': v.step }, h('div', { class: 'sx-card-hd' }, h('div', { class: 'sx-card-title' }, '계정')), ...body);
}

/** 렌더러 안 이메일 모양 미리 보기(판정은 main isEmailShape). */
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const back = (label, onClick) => h('button', { type: 'button', class: 'acct-back', 'data-act': 'account-back', onclick: onClick }, icon('chevronLeft'), label);
const mark = () => h('span', { class: 'acct-mark', 'aria-hidden': 'true' }, 'ax');
const head = (title, sub, subAttrs) => h('div', { class: 'acct-head' }, h('h1', { class: 'title-screen', id: 'acct-title' }, title), sub ? h('p', { class: 'sx-body-sm', ...(subAttrs ?? {}) }, sub) : null);
const links = (...bs) => h('div', { class: 'acct-links' }, ...bs.flatMap((b, i) => (i ? [h('span', { class: 'acct-dot', 'aria-hidden': 'true' }, '·'), b] : [b])));
const quiet = (label, onClick, act) => btn(label, onClick, 'sx-btn-quiet', { 'data-act': act });
const primary = (label, onClick, act, busy) => btn(label, onClick, 'sx-btn-primary sx-btn-lg', { 'data-act': act, disabled: busy });

/** 보기 토글(눈 / 빗금 눈). 기본은 가림. */
const eye = (draft, ctx) =>
  h('button', { type: 'button', class: 'acct-eye', 'aria-label': draft.show ? '가리기' : '보기', 'aria-pressed': String(!!draft.show), onclick: () => ctx.toggleShow() }, icon(draft.show ? 'eyeOff' : 'eye'));

const RULES = [
  ['len', '10자 이상'],
  ['common', '흔하거나 알려진 비밀번호가 아님'],
  ['identity', '이메일·서비스 이름이 들어가지 않음'],
];

/**
 * 새 비밀번호 칸 + 조건 3줄 + 경고 줄(인계 명세 §3.1·§3.2). 입력할 때마다 줄·경고·주 버튼만 고친다(칸은 다시 만들지 않는다).
 * 서버 거부 코드(serverErr)는 입력값이 비어 있을 때(보낸 뒤 비웠다) 경고 줄에 보인다. 반환: { nodes, ok() }.
 */
function newPasswordField(ctx, { email, serverErr, onEnter, submitBtn }) {
  const { draft } = ctx;
  const i = h('input', { class: 'acct-in acct-password', type: draft.show ? 'text' : 'password', maxlength: 512, autocomplete: 'new-password', spellcheck: 'false', 'aria-label': '새 비밀번호', 'aria-describedby': 'acct-rules' });
  i.value = draft.password ?? '';
  const rows = RULES.map(([key, label]) => h('li', { class: 'acct-rule is-wait', 'data-rule': key }, h('span', { class: 'acct-rule-mk', 'aria-hidden': 'true' }), h('span', { class: 'sx-meta' }, label)));
  const warn = h('p', { class: 'acct-err sx-body-sm', role: 'alert', 'data-acct-pw-warn': '' });
  const update = () => {
    const r = pwRules(draft.password ?? '', email);
    rows.forEach((row) => {
      const st = r[row.dataset.rule];
      row.className = `acct-rule is-${st}`;
      row.firstChild.replaceChildren(...(st === 'ok' ? [icon('check')] : st === 'bad' ? [icon('warn')] : []));
    });
    // 서버와 같은 순서(길이 → 이메일·서비스 이름 → 흔한 목록)로 하나만 보인다
    const live = r.tooLong ? 'account.password_too_long' : r.identity === 'bad' ? (r.identityKind === 'service' ? 'account.password_contains_service' : 'account.password_contains_identity') : r.common === 'bad' ? 'account.password_breached' : null;
    const code = live ?? (draft.password ? null : serverErr);
    warn.hidden = !code;
    warn.replaceChildren(...(code ? [icon('warn'), accountErrText(code)] : []));
    i.classList.toggle('is-bad', !!live || (!draft.password && !!serverErr));
    submitBtn.disabled = ctx.busy || !r.ok;
    return r.ok;
  };
  i.addEventListener('input', () => {
    draft.password = i.value;
    update();
  });
  i.addEventListener('keydown', (e) => e.key === 'Enter' && update() && onEnter());
  update();
  return { nodes: [h('div', { class: 'acct-pw' }, i, eye(draft, ctx)), h('ul', { class: 'acct-rules', id: 'acct-rules' }, ...rows), warn] };
}

/**
 * 코드 6자리: 칸 여섯 개는 보이기만 하고, 입력은 그 위를 덮는 숫자 칸 하나가 받는다(붙여 넣기·자동 채우기도 된다).
 * 6자리가 차거나 Enter면 onFull(code).
 */
function codeField(ctx, busy, onFull) {
  const { draft } = ctx;
  const code = (draft.code ?? '').replace(/\D/g, '').slice(0, 6);
  const cells = h('div', { class: 'acct-cells', 'aria-hidden': 'true' }, ...Array.from({ length: 6 }, (_, i) => h('span', { class: `acct-cell${i === Math.min(code.length, 5) ? ' is-at' : ''}` }, code[i] ?? '')));
  const i = h('input', { class: 'acct-code-in acct-code', inputmode: 'numeric', maxlength: 6, autocomplete: 'one-time-code', 'aria-label': '6자리 코드', 'aria-describedby': 'acct-to' });
  i.value = code;
  i.addEventListener('input', () => {
    draft.code = i.value.replace(/\D/g, '').slice(0, 6);
    if (i.value !== draft.code) i.value = draft.code;
    cells.querySelectorAll('.acct-cell').forEach((c, k) => {
      c.textContent = draft.code[k] ?? '';
      c.classList.toggle('is-at', k === Math.min(draft.code.length, 5));
    });
    if (draft.code.length === 6 && !busy) onFull(draft.code);
  });
  i.addEventListener('keydown', (e) => e.key === 'Enter' && !busy && onFull(draft.code ?? ''));
  return h('div', { class: 'acct-code-box' }, cells, i);
}

const codeFoot = (v, ctx, busy, resend) =>
  h('div', { class: 'acct-code-foot' }, v.codeExpiresAt ? h('span', { class: 'acct-left', 'data-acct-left': '' }, left(v.codeExpiresAt, ctx.now())) : null, quiet('다시 받기', () => !busy && resend(), 'account-resend'));

/** 남은 시간 m:ss(코드 만료). */
const left = (at, now) => {
  const s = Math.max(0, Math.round((at - now) / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

/**
 * 로그인(A-01, 캔버스 v60 M2Login·M2LoginCode·M2Signup 이메일 단계). 앱 위를 덮는 전체 화면이다.
 * ctx = { view, screen, draft: { email, password, code, show }, busy, now, go(screen), onClose, gate, sendCode(email), verify(code), password(email, pw), back() }.
 * - gate: 로그인이 먼저인 화면(닫기 없음, onClose null).
 * - screen(렌더러가 고른 화면): 'email' | 'password' | 'code_email' | 'signup'. 코드를 보낸 뒤(main step code_sent)는 코드 6자리 화면이다.
 * - 비밀번호가 틀림·없는 계정·잠금은 같은 안내다(서버가 같은 응답, ADR-038 (d)). 안내 안에 [이메일 코드로 로그인]을 둔다.
 * - 입력 중인 값은 draft에만 둔다(DOM 속성에 넣지 않는다). 비밀번호는 보낸 뒤 비운다.
 */
export function loginScreen(ctx) {
  const { view: v, draft } = ctx;
  const err = v.error;
  const busy = ctx.busy || v.step === 'working';
  const email = () => (draft.email ?? '').trim();
  const input = (key, label, attrs, onEnter, cls = '') => {
    const i = h('input', { class: `acct-in acct-${key} ${cls}`, autocomplete: 'off', spellcheck: 'false', 'aria-label': label, ...attrs });
    i.value = draft[key] ?? '';
    i.addEventListener('input', () => (draft[key] = i.value));
    i.addEventListener('keydown', (e) => e.key === 'Enter' && onEnter());
    return i;
  };
  const errNote = (code) => (code ? h('p', { class: 'acct-err sx-body-sm', role: 'alert' }, icon('warn'), accountErrText(code)) : null);
  // 재설정 코드를 보낸 뒤(main step reset_code)는 코드 칸, 6자리를 받아 두면 렌더러가 새 비밀번호 칸으로 넘긴다(서버 검증은 마지막 제출 때, 명세 §8 G6).
  const resetScreen = ctx.screen === 'reset_new' ? 'reset_new' : 'reset_code';
  let screen = v.step === 'code_sent' ? 'code' : v.step === 'working' ? 'working' : v.step === 'set_password' ? 'signup_pw' : v.step === 'reset_code' ? resetScreen : ctx.screen;
  let body;

  if (screen === 'reset_email') {
    // 비밀번호 찾기(인계 명세 §4 email). 계정이 없어도 같은 응답이라 늘 코드 단계로 간다.
    const send = () => !busy && ctx.startReset(email());
    body = [
      back('뒤로', () => ctx.go('password')),
      head('비밀번호 찾기', '가입한 이메일로 코드를 보내요'),
      h(
        'div',
        { class: 'acct-stack' },
        input('email', '이메일', { type: 'email', maxlength: 254, inputmode: 'email', autocomplete: 'username' }, send),
        errNote(err),
        primary('코드 받기', send, 'account-reset-send', busy),
        links(quiet('로그인으로', () => ctx.go('email'), 'account-to-login')),
      ),
    ];
  } else if (screen === 'reset_code') {
    body = [
      back('뒤로', ctx.back),
      head('코드 6자리', [h('b', { 'data-acct-to': '' }, v.email), '로 보냈어요'], { id: 'acct-to' }),
      h(
        'div',
        { class: 'acct-stack' },
        codeField(ctx, busy, (code) => (/^\d{6}$/.test(code) ? ctx.go('reset_new') : ctx.fail('account.code_shape'))),
        errNote(err),
        codeFoot(v, ctx, busy, () => ctx.startReset(v.email)),
      ),
    ];
  } else if (screen === 'reset_new') {
    // 새 비밀번호(§4 new). 코드 오류면 렌더러가 코드 칸으로 돌린다(새 비밀번호는 지운다). 정책 거부는 여기 남는다.
    const submit = () => !busy && ctx.finishReset(draft.code ?? '', draft.password ?? '');
    const change = primary('바꾸기', submit, 'account-reset-finish', true);
    const pwErr = err && err.startsWith('account.password_') ? err : null;
    const f = newPasswordField(ctx, { email: v.email, serverErr: pwErr, onEnter: submit, submitBtn: change });
    body = [
      back('뒤로', () => ctx.go('reset_code')),
      head('새 비밀번호', [h('b', { 'data-acct-to': '' }, v.email)]),
      h('div', { class: 'acct-stack' }, ...f.nodes, pwErr ? null : errNote(err), change),
    ];
  } else if (screen === 'reset_done') {
    // 바꿈 끝(§4 done): 서버가 다른 곳의 로그인을 모두 끝냈다. 금고·기기 연결은 그대로다.
    body = [
      h(
        'div',
        { class: 'acct-done' },
        h('span', { class: 'acct-done-mk', 'aria-hidden': 'true' }, icon('check')),
        h('h1', { class: 'title-screen', id: 'acct-title' }, '비밀번호를 바꿨어요'),
      ),
      h(
        'div',
        { class: 'acct-stack' },
        h('div', { class: 'acct-box' }, h('p', { class: 'sx-body-sm' }, icon('pc'), '다른 곳의 로그인은 모두 끝났어요'), h('p', { class: 'sx-body-sm' }, icon('lock'), '금고와 기기 연결은 그대로예요')),
        btn('계속', ctx.onClose, 'sx-btn-primary sx-btn-lg', { 'data-act': 'account-reset-done' }),
      ),
    ];
  } else if (screen === 'signup_pw') {
    // 계정 만들기 비밀번호 단계(인계 명세 §3 pw·shown·common·mine). 확인 칸은 없다(보기 토글로 확인, 제안 2).
    const submit = () => !busy && ctx.setPassword(draft.password ?? '');
    const make = primary('만들기', submit, 'account-set-password', true);
    const pwErr = err && err.startsWith('account.password_') ? err : null;
    const f = newPasswordField(ctx, { email: v.email, serverErr: pwErr, onEnter: submit, submitBtn: make });
    body = [
      mark(),
      head('비밀번호 만들기', '다음부터 메일을 열지 않고 로그인해요'),
      h('div', { class: 'acct-stack' }, ...f.nodes, pwErr ? null : errNote(err), make, links(quiet('나중에', () => !busy && ctx.skipPassword(), 'account-skip-password'))),
    ];
  } else if (screen === 'working') {
    body = [mark(), head('이 PC를 계정에 등록하고 있어요', '잠시만 기다려 주세요', { 'data-account-working': '' })];
  } else if (screen === 'email') {
    const next = () => {
      if (busy) return;
      if (!EMAIL_RE.test(email())) return ctx.fail('account.email_shape');
      ctx.go('password');
    };
    body = [
      ctx.onClose ? back('닫기', ctx.onClose) : null,
      mark(),
      // 로그인이 먼저인 화면(loginGate): 대화·온보딩 앞에서 막고 있다는 것을 한 줄로 알린다
      head('로그인', ctx.gate ? '앱을 쓰려면 먼저 로그인해 주세요. 이메일이 아이디예요' : '이메일이 아이디예요', ctx.gate ? { 'data-login-gate': '' } : undefined),
      h(
        'div',
        { class: 'acct-stack' },
        input('email', '이메일', { type: 'email', maxlength: 254, inputmode: 'email', autocomplete: 'username' }, next),
        errNote(err),
        primary('계속', next, 'account-next', busy),
        // [패스키로 로그인](권장)·"또는"은 데스크톱 패스키가 되는 빌드에서 보인다(인계 명세 §8 G7: 누르면 안 되는 버튼을 두지 않는다).
        links(quiet('계정 만들기', () => ctx.go('signup'), 'account-signup')),
      ),
    ];
  } else if (screen === 'password') {
    const wrong = err === 'account.credentials_invalid';
    const submit = () => !busy && ctx.password(email(), draft.password ?? '');
    const pw = input('password', '비밀번호', { type: draft.show ? 'text' : 'password', maxlength: 512, autocomplete: 'current-password' }, submit, wrong ? 'is-bad' : '');
    body = [
      mark(),
      head('비밀번호'),
      h(
        'div',
        { class: 'acct-stack' },
        h('span', { class: 'acct-chip' }, h('span', { 'data-acct-email': '' }, email()), quiet('바꾸기', () => ctx.go('email'), 'account-change-email')),
        h('div', { class: 'acct-pw' }, pw, eye(draft, ctx)),
        wrong
          ? h(
              'div',
              { class: 'acct-alert', role: 'alert', 'data-acct-wrong': '' },
              h('p', { class: 'acct-alert-hd sx-body-sm' }, icon('warn'), '이메일 또는 비밀번호가 맞지 않아요'),
              h('p', { class: 'acct-alert-sub sx-body-sm' }, '이메일 코드로는 바로 로그인할 수 있어요'),
              btn([icon('mail'), '이메일 코드로 로그인'], () => !busy && ctx.sendCode(email()), 'sx-btn-lg acct-btn', { 'data-act': 'account-code-from-wrong' }),
            )
          : errNote(err),
        primary('로그인', submit, 'account-password', busy),
        wrong ? links(quiet('비밀번호 찾기', () => ctx.go('reset_email'), 'account-reset')) : links(quiet('이메일 코드로 로그인', () => ctx.go('code_email'), 'account-code-login'), quiet('비밀번호 찾기', () => ctx.go('reset_email'), 'account-reset')),
      ),
    ];
  } else if (screen === 'code_email' || screen === 'signup') {
    const signup = screen === 'signup';
    const send = () => !busy && ctx.sendCode(email());
    body = [
      back('뒤로', () => ctx.go(signup ? 'email' : 'password')),
      head(signup ? '계정 만들기' : '이메일 코드로 로그인', signup ? '이메일이 아이디예요' : null),
      h(
        'div',
        { class: 'acct-stack' },
        input('email', '이메일', { type: 'email', maxlength: 254, inputmode: 'email', autocomplete: 'username' }, send),
        errNote(err),
        primary('코드 받기', send, 'account-send', busy),
        links(signup ? quiet('로그인', () => ctx.go('email'), 'account-to-login') : quiet('비밀번호로 로그인', () => ctx.go('password'), 'account-to-password')),
      ),
    ];
  } else {
    // 코드 6자리(로그인·계정 만들기)
    body = [
      back('뒤로', ctx.back),
      head('코드 6자리', [h('b', { 'data-acct-to': '' }, v.email), '로 보냈어요'], { id: 'acct-to' }),
      h(
        'div',
        { class: 'acct-stack' },
        codeField(ctx, busy, (code) => ctx.verify(code)),
        errNote(err),
        codeFoot(v, ctx, busy, () => ctx.sendCode(v.email)),
      ),
    ];
    screen = 'code';
  }
  return h(
    'section',
    { class: 'acct-screen', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'acct-title', 'data-account-login': v.step, 'data-acct-screen': screen },
    h('div', { class: 'acct-col' }, ...body),
  );
}
