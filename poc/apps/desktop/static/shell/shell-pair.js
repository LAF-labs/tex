import { btn, h, icon } from './shell-views.js';

const QR_PREFIX = 'data:image/svg+xml;base64,';
const ERR = {
  'pair.sas_wrong': '6자리가 맞지 않아요. 폰에 보이는 숫자를 다시 확인해 주세요.',
  'pair.sas_shape': '6자리 숫자를 넣어 주세요.',
  'pair.sas_locked': '여러 번 틀려서 이번 연결은 멈췄어요. 새 QR로 다시 해 주세요.',
  'pair.handshake': '폰과 이어지지 않았어요. [다시 시도]로 새 QR을 띄워 주세요.',
  'policy.rate_limited': '연결 시도가 많았어요. 잠시 뒤에 다시 해 주세요.',
  'relay.room_used': '이 QR은 이미 쓰였어요. 새 QR로 다시 해 주세요.',
  'account.device_limit': '이 계정에는 폰을 3대까지 연결할 수 있어요. 아래 목록에서 안 쓰는 폰을 끊은 뒤 다시 해 주세요.',
  account_required: '먼저 로그인해 주세요.',
  pair_unavailable: '이 빌드에서는 아직 폰을 연결할 수 없어요.',
  gesture_required: '버튼을 한 번 더 눌러 주세요.',
};
export const pairErrText = (c) => (c ? (ERR[c] ?? (c.startsWith('net.') ? '인터넷에 연결되지 않았어요. 연결을 확인하고 다시 해 주세요.' : '잠깐 문제가 생겼어요. [다시 시도]를 눌러 주세요.')) : '');

export const pairLeft = (expiresAt, now = Date.now()) => {
  const s = Math.max(0, Math.round((expiresAt - now) / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};
export const pairTtlText = (expiresAt, now) => `${pairLeft(expiresAt, now)} 안에 찍어 주세요`;

export const pairOpen = (v) => !!v && v.step !== 'idle';

function qrImg(src) {
  if (typeof src !== 'string' || !src.startsWith(QR_PREFIX)) return null;
  const i = h('img', { class: 'pair-qr-img', alt: '폰으로 찍을 QR', draggable: 'false' });
  i.src = src;
  return i;
}

const STEPS = ['폰에서 택스오프를 열고', 'PC와 연결 화면에서', '이 QR을 찍어 주세요'];
const steps = () => h('ol', { class: 'pair-steps' }, ...STEPS.map((t, i) => h('li', {}, h('span', { class: 'pair-step-n', 'aria-hidden': 'true' }, String(i + 1)), h('span', {}, t))));

function qrTile(v, act, busy) {
  if (v.step === 'waiting_phone') return h('div', { class: 'pair-qr' }, qrImg(v.qr));
  if (v.step === 'opening') return h('div', { class: 'pair-qr is-empty', 'aria-hidden': 'true' }, h('span', { class: 'pair-spin' }));
  return h('div', { class: 'pair-qr is-empty is-expired' }, btn('새 QR', act.retry, 'sx-btn-primary', { 'data-act': 'pair-retry', disabled: busy }));
}

const mark = (kind) => h('span', { class: `pair-mk${kind ? ` is-${kind}` : ''}`, 'aria-hidden': 'true' }, icon(kind === 'done' ? 'check' : kind === 'attention' ? 'warn' : 'phone'));

export function pairSection(v, act, busy = false, now = Date.now(), inModal = false) {
  if (!pairOpen(v))
    return h(
      'div',
      { class: 'sx-actions', 'data-pair': 'idle' },
      btn('폰 연결', act.open, 'sx-btn-primary', { 'data-act': 'pair-open', disabled: busy }),
      h('span', { class: 'sx-meta' }, '이 자리에 QR이 떠요. 폰으로 찍으면 연결돼요.'),
    );
  const cancel = (label = '취소') => btn(label, act.cancel, 'sx-btn-quiet', { 'data-act': label === '닫기' ? 'pair-close' : 'pair-cancel', disabled: busy && label !== '닫기' });
  const panel = (attrs, ...kids) => h('section', { class: 'pair-panel', 'data-pair': v.step, 'aria-live': 'polite', 'aria-label': '폰 연결', ...attrs }, ...kids);

  if (v.step === 'opening' || v.step === 'waiting_phone' || (v.step === 'failed' && v.error === 'pair.expired'))
    return panel(
      { class: 'pair-panel is-qr' },
      qrTile(v, act, busy),
      h(
        'div',
        { class: 'pair-side' },
        h('p', { class: 'pair-title' }, v.step === 'failed' ? 'QR 시간이 지났어요' : v.step === 'opening' ? 'QR을 만들고 있어요' : '폰으로 QR을 찍어 주세요'),
        v.step === 'failed' ? h('p', { class: 'pair-text', 'data-pair-error': v.error }, 'QR은 2분 동안만 쓸 수 있어요. [새 QR]을 눌러 다시 찍어 주세요.') : steps(),
        v.step === 'waiting_phone' && v.expiresAt ? h('p', { class: 'sx-meta', 'data-pair-ttl': String(v.expiresAt) }, pairTtlText(v.expiresAt, now)) : null,
        h('div', { class: 'sx-actions' }, cancel()),
      ),
    );

  if (inModal) return h('div', { class: 'sx-actions', 'data-pair': v.step }, h('span', { class: 'sx-meta' }, '열린 창에서 폰 연결을 마무리해 주세요.'));

  if (v.step === 'paired')
    return panel(
      {},
      h('div', { class: 'pair-head' }, mark('done'), h('div', { class: 'pair-head-t' }, h('p', { class: 'pair-title', 'data-pair-done': '' }, '연결됐어요'), h('p', { class: 'sx-meta' }, h('span', { 'data-pair-phone': '' }, v.phoneName || '폰'), h('br'), '폰에서 계정 이메일을 확인하고 저장하면 끝나요.'))),
      h('div', { class: 'sx-actions' }, cancel('닫기')),
    );

  return panel(
    { class: 'pair-panel is-attention' },
    h('div', { class: 'pair-head' }, mark('attention'), h('div', { class: 'pair-head-t' }, h('p', { class: 'pair-title' }, '연결이 멈췄어요'), h('p', { class: 'pair-text', 'data-pair-error': v.error ?? '' }, pairErrText(v.error)))),
    h('div', { class: 'sx-actions' }, btn('다시 시도', act.retry, 'sx-btn-primary', { 'data-act': 'pair-retry', disabled: busy }), cancel('닫기')),
  );
}

export const SAS_LEN = 6;
export const sasDigits = (s) => String(s ?? '').replace(/\D/g, '').slice(0, SAS_LEN);
export const pairLeftText = (expiresAt, now) => `남은 시간 ${pairLeft(expiresAt, now)}`;

function sasBoxes(act, { disabled, wrong, shake, onFull }) {
  const boxes = [];
  const code = () => boxes.map((b) => b.value).join('');
  const put = (i, digits) => {
    let k = i;
    for (const d of digits) {
      if (k >= SAS_LEN) break;
      boxes[k++].value = d;
    }
    act.setCode(code());
    boxes[Math.min(k, SAS_LEN - 1)].focus();
    if (code().length === SAS_LEN) onFull(code());
  };
  const cur = act.codeOf();
  for (let i = 0; i < SAS_LEN; i++) {
    const b = h('input', {
      class: 'sas-box',
      inputmode: 'numeric',
      pattern: '[0-9]*',
      maxlength: SAS_LEN,
      autocomplete: i === 0 ? 'one-time-code' : 'off',
      spellcheck: 'false',
      'aria-label': `6자리 중 ${i + 1}번째`,
      'data-sas-i': String(i),
      disabled,
      'aria-invalid': wrong ? 'true' : null,
    });
    b.value = cur[i] ?? '';
    b.addEventListener('focus', () => b.select());
    b.addEventListener('input', () => {
      for (const x of boxes) x.removeAttribute('aria-invalid');
      b.parentElement?.classList.remove('is-wrong');
      const d = sasDigits(b.value);
      b.value = '';
      if (!d) return act.setCode(code());
      put(i, d);
    });
    b.addEventListener('paste', (e) => {
      const d = sasDigits(e.clipboardData?.getData('text'));
      e.preventDefault();
      if (!d) return;
      for (const x of boxes) x.value = '';
      put(d.length === SAS_LEN ? 0 : i, d);
    });
    b.addEventListener('keydown', (e) => {
      if (e.key === 'Backspace') {
        e.preventDefault();
        if (b.value) b.value = '';
        else if (i > 0) {
          boxes[i - 1].value = '';
          boxes[i - 1].focus();
        }
        act.setCode(code());
      } else if ((e.key === 'ArrowLeft' && i > 0) || (e.key === 'ArrowRight' && i < SAS_LEN - 1)) {
        e.preventDefault();
        boxes[e.key === 'ArrowLeft' ? i - 1 : i + 1].focus();
      } else if (e.key === 'Enter' && code().length === SAS_LEN) onFull(code());
    });
    boxes.push(b);
  }
  return h('div', { class: `sas-boxes${wrong ? ' is-wrong' : ''}${shake ? ' is-shake' : ''}`, role: 'group', 'aria-label': '폰에 보이는 6자리', id: 'pair-sas' }, ...boxes.slice(0, 3), h('span', { class: 'sas-gap', 'aria-hidden': 'true' }), ...boxes.slice(3));
}

export const pairInModal = (v, sasSeen) => !!v && (v.step === 'awaiting_sas' || v.step === 'checking' || v.step === 'paired' || (v.step === 'failed' && sasSeen));

function trapTab(root) {
  root.addEventListener('keydown', (e) => {
    if (e.key !== 'Tab') return;
    const f = [...root.querySelectorAll('button, input')].filter((x) => !x.disabled);
    if (!f.length) return;
    const first = f[0];
    const last = f[f.length - 1];
    const to = e.shiftKey ? (document.activeElement === first || !root.contains(document.activeElement) ? last : null) : document.activeElement === last || !root.contains(document.activeElement) ? first : null;
    if (!to) return;
    e.preventDefault();
    to.focus();
  });
  return root;
}

export function pairModal(v, act, busy = false, now = Date.now(), shake = false) {
  const name = v.phoneName || '폰';
  const phone = () => h('span', { 'data-pair-phone': '' }, name);
  const head = (kind, title, ...sub) =>
    h('div', { class: 'pair-m-hd' }, mark(kind), h('h2', { class: 'pair-m-title', id: 'pair-m-title', ...(kind === 'done' ? { 'data-pair-done': '' } : {}) }, title), sub.length ? h('p', { class: 'pair-m-sub' }, ...sub) : null);
  let body;
  if (v.step === 'awaiting_sas' || v.step === 'checking') {
    const checking = v.step === 'checking';
    const submit = (c) => !busy && !checking && sasDigits(c).length === SAS_LEN && act.submit(sasDigits(c));
    const wrong = (v.error === 'pair.sas_wrong' || v.error === 'pair.sas_shape') && !act.codeOf();
    const boxes = sasBoxes(act, { disabled: checking || busy, wrong, shake: wrong && shake, onFull: submit });
    const line = v.error
      ? h('p', { class: 'pair-m-line is-err', role: 'alert', 'data-pair-error': v.error }, v.error === 'pair.sas_wrong' ? `숫자가 달라요. 폰 화면을 다시 보고 넣어 주세요.${v.triesLeft ? ` ${v.triesLeft}번 더 넣을 수 있어요.` : ''}` : pairErrText(v.error))
      : h('p', { class: 'pair-m-line' }, checking ? '폰과 맞춰 보는 중이에요…' : '숫자를 다 넣으면 바로 확인해요.');
    body = [
      head(null, '폰에 보이는 6자리를 넣어 주세요', phone(), ' 화면에 뜬 숫자예요. 이 PC에만 넣으면 돼요.'),
      boxes,
      line,
      v.expiresAt ? h('p', { class: 'pair-m-ttl', 'data-pair-left': String(v.expiresAt) }, pairLeftText(v.expiresAt, now)) : null,
      h(
        'div',
        { class: 'modal-acts' },
        btn('취소', act.cancel, 'sx-btn-lg', { 'data-act': 'pair-cancel' }),
        btn(checking ? '확인하는 중…' : '연결', () => submit(act.codeOf()), 'sx-btn-primary sx-btn-lg', { 'data-act': 'pair-submit', disabled: busy || checking }),
      ),
    ];
  } else if (v.step === 'paired') {
    body = [head('done', '연결됐어요', phone(), h('br'), '폰에서 계정 이메일을 확인하고 저장하면 끝나요.'), h('div', { class: 'modal-acts' }, btn('닫기', act.cancel, 'sx-btn-primary sx-btn-lg', { 'data-act': 'pair-close' }))];
  } else {
    const expired = v.error === 'pair.expired';
    body = [
      head('attention', expired ? '시간이 지났어요' : '연결이 멈췄어요', h('span', { 'data-pair-error': v.error ?? '' }, expired ? '6자리는 QR을 띄운 뒤 2분 안에 넣어야 해요. 새 QR로 다시 해 주세요.' : pairErrText(v.error))),
      h('div', { class: 'modal-acts' }, btn('닫기', act.cancel, 'sx-btn-lg', { 'data-act': 'pair-close' }), btn('새 QR로 다시', act.retry, 'sx-btn-primary sx-btn-lg', { 'data-act': 'pair-retry', disabled: busy })),
    ];
  }
  return h('div', { class: 'modal-scrim is-blur' }, trapTab(h('section', { class: 'modal pair-modal', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'pair-m-title', 'data-pair-modal': v.step }, ...body)));
}
