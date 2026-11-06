// 계정 로그인(A-01: 이메일 → 6자리 코드)과 설정 > 기기 연결의 계정 줄. main(remote-account.ts)이 단계를 정하고 여기서는 그리기만 한다.
// 렌더러가 받는 값은 단계·이메일·코드 만료 시각·오류 코드뿐이다(세션·토큰은 main에만). 값은 모두 textContent·value로 넣는다.
import { btn, h, icon, note } from './shell-views.js';

/** 오류 코드 → 문구. 모르는 코드는 일반 문구(코드를 화면에 보이지 않는다). */
const ERR = {
  'account.email_shape': '이메일 형식이 아니에요',
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
  gesture_required: '버튼을 다시 눌러 주세요',
  busy: '처리 중이에요. 잠시만 기다려 주세요',
};
export const accountErrText = (code) => (code ? (ERR[code] ?? (code.startsWith('net.') ? '연결하지 못했어요. 인터넷 연결을 확인해 주세요' : '잠시 뒤에 다시 해 주세요')) : null);

/** 설정 > 기기 연결의 계정 줄. */
export function accountCard(view, onLogin) {
  const v = view ?? { step: 'unavailable' };
  const body =
    v.step === 'unavailable'
      ? [h('p', { class: 'sx-body-sm is-muted' }, '이 빌드에서는 아직 계정에 연결할 수 없어요.')]
      : v.step === 'signed_in'
        ? [h('p', { class: 'sx-body-sm', 'data-account-email': '' }, v.email), h('p', { class: 'sx-meta' }, '이 PC가 계정에 등록됐어요. 폰 연결은 곧 여기서 할 수 있어요.')]
        : [h('p', { class: 'sx-body-sm is-muted' }, '폰을 연결하려면 먼저 이메일로 로그인해 주세요. 메일로 받은 6자리 코드로 들어가요.'), h('div', { class: 'sx-actions' }, btn('로그인', onLogin, 'sx-btn-primary', { 'data-act': 'account-login' }))];
  return h('div', { class: 'sx-card', 'data-account': v.step }, h('div', { class: 'sx-card-hd' }, h('div', { class: 'sx-card-title' }, '계정')), ...body);
}

/**
 * 로그인 창(A-01). ctx = { view, draft: { email, code }, busy, onClose, sendCode(email), verify(code), back() }.
 * 입력 중인 값은 draft에 둔다(다시 그려도 남는다. DOM 속성에는 넣지 않는다).
 */
export function loginModal(ctx) {
  const { view: v, draft } = ctx;
  const field = (label, cls, value, attrs, onEnter) => {
    const i = h('input', { class: `doc-in ${cls}`, autocomplete: 'off', spellcheck: 'false', 'aria-label': label, ...attrs });
    i.value = value ?? '';
    i.addEventListener('input', () => (draft[cls === 'acct-email' ? 'email' : 'code'] = i.value));
    i.addEventListener('keydown', (e) => e.key === 'Enter' && onEnter());
    return h('label', { class: 'modal-field' }, h('span', { class: 'sx-meta' }, label), i);
  };
  const err = accountErrText(v.error);
  const sendCode = () => !ctx.busy && ctx.sendCode((draft.email ?? '').trim());
  const verify = () => !ctx.busy && ctx.verify((draft.code ?? '').trim());
  let title = '로그인';
  let sub = '이메일로 6자리 코드를 보내 드려요. 비밀번호는 없어요.';
  let rows;
  if (v.step === 'code_sent') {
    title = '코드 넣기';
    sub = '';
    rows = [
      h('p', { class: 'sx-body-sm' }, h('b', { 'data-acct-to': '' }, v.email), '(으)로 보낸 6자리 코드를 넣어 주세요. 10분 안에 넣어야 해요.'),
      field('6자리 코드', 'acct-code', draft.code, { inputmode: 'numeric', maxlength: 6, autocomplete: 'one-time-code' }, verify),
      err ? note(err, true) : null,
      h(
        'div',
        { class: 'modal-acts' },
        btn('다른 이메일', ctx.back, 'sx-btn-quiet', { 'data-act': 'account-back' }),
        btn('코드 다시 받기', () => !ctx.busy && ctx.sendCode(v.email), 'sx-btn-lg', { 'data-act': 'account-resend' }),
        btn('확인', verify, 'sx-btn-primary sx-btn-lg', { 'data-act': 'account-verify', disabled: ctx.busy }),
      ),
    ];
  } else if (v.step === 'working') {
    rows = [h('p', { class: 'sx-body-sm', 'data-account-working': '' }, '이 PC를 계정에 등록하고 있어요…')];
  } else {
    rows = [
      field('이메일', 'acct-email', draft.email ?? v.email, { type: 'email', maxlength: 254, inputmode: 'email' }, sendCode),
      err ? note(err, true) : null,
      h('div', { class: 'modal-note' }, icon('lock'), h('span', {}, '이 PC의 금고가 기기 키를 만들고 계정에 등록해요. 키는 PC 밖으로 나가지 않아요.')),
      h('div', { class: 'modal-acts' }, btn('취소', ctx.onClose, 'sx-btn-lg', { 'data-act': 'account-cancel' }), btn('코드 받기', sendCode, 'sx-btn-primary sx-btn-lg', { 'data-act': 'account-send', disabled: ctx.busy })),
    ];
  }
  return h(
    'div',
    { class: 'modal-scrim' },
    h(
      'section',
      { class: 'modal', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'acct-title', 'data-account-login': v.step },
      h(
        'div',
        { class: 'modal-hd' },
        h('div', { class: 'modal-title' }, h('h2', { class: 'title-screen', id: 'acct-title' }, title), sub ? h('p', { class: 'sx-body-sm is-muted' }, sub) : null),
        h('button', { type: 'button', class: 'panel-x', 'aria-label': '닫기', onclick: ctx.onClose }, icon('close')),
      ),
      ...rows,
    ),
  );
}
