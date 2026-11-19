// 폰 연결 칸(S-03): 설정 > 기기 연결의 계정 카드 안에서 [폰 연결]이 그 자리에서 펼쳐진다(QR).
// 폰이 QR을 찍은 뒤의 6자리 넣기 → 연결됐어요(또는 멈춤)는 메인 창 안 모달(pairModal, 따로 창 없음)이다.
// main(remote-pairing.ts)이 준 화면 값(PairView)으로만 그린다. QR은 main이 만든 SVG data URL 이미지로 오고 <img src>로만 쓴다(QR 글자는 렌더러에 없다).
// 값은 모두 textContent로 넣는다. 6자리는 폰에서 보고 이 PC에 넣는다("일치" 버튼은 없다, D08 §4.2).
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

/** 남은 시간 "1:43". */
export const pairLeft = (expiresAt, now = Date.now()) => {
  const s = Math.max(0, Math.round((expiresAt - now) / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};
export const pairTtlText = (expiresAt, now) => `${pairLeft(expiresAt, now)} 안에 찍어 주세요`;

/** 칸이 펼쳐진 단계(쉬는 자리가 아닌 것). */
export const pairOpen = (v) => !!v && v.step !== 'idle';

function qrImg(src) {
  if (typeof src !== 'string' || !src.startsWith(QR_PREFIX)) return null;
  const i = h('img', { class: 'pair-qr-img', alt: '폰으로 찍을 QR', draggable: 'false' });
  i.src = src;
  return i;
}

// 폰은 첫 실행이면 온보딩 마지막 단계(PC와 연결)가, 그 뒤에는 홈의 [PC와 연결]이 같은 QR 찍기 화면을 연다. 둘 다 맞게 화면 이름으로 쓴다.
const STEPS = ['폰에서 택스오프를 열고', 'PC와 연결 화면에서', '이 QR을 찍어 주세요'];
const steps = () => h('ol', { class: 'pair-steps' }, ...STEPS.map((t, i) => h('li', {}, h('span', { class: 'pair-step-n', 'aria-hidden': 'true' }, String(i + 1)), h('span', {}, t))));

/** 왼쪽 QR 자리: QR · 만드는 중 · 시간이 지남(그 자리에 [새 QR]). 자리 크기는 같아서 단계가 바뀌어도 칸이 흔들리지 않는다. */
function qrTile(v, act, busy) {
  if (v.step === 'waiting_phone') return h('div', { class: 'pair-qr' }, qrImg(v.qr));
  if (v.step === 'opening') return h('div', { class: 'pair-qr is-empty', 'aria-hidden': 'true' }, h('span', { class: 'pair-spin' }));
  return h('div', { class: 'pair-qr is-empty is-expired' }, btn('새 QR', act.retry, 'sx-btn-primary', { 'data-act': 'pair-retry', disabled: busy }));
}

const mark = (kind) => h('span', { class: `pair-mk${kind ? ` is-${kind}` : ''}`, 'aria-hidden': 'true' }, icon(kind === 'done' ? 'check' : kind === 'attention' ? 'warn' : 'phone'));

/**
 * 계정 카드 안의 폰 연결 자리. v가 없거나 쉬는 자리(idle)면 [폰 연결] 한 줄, 펼치면 그 자리에서 QR → 6자리 → 연결됐어요(또는 멈춤)로 바뀐다.
 * act = { open, submit(code), retry, cancel, codeOf(), setCode(v) }. 단추는 busy 동안 막는다.
 */
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

  // 6자리 단계부터 연결됐어요까지는 메인 창 안 모달(pairModal)이 맡는다. 뒤 카드에는 한 줄만 둔다.
  if (inModal) return h('div', { class: 'sx-actions', 'data-pair': v.step }, h('span', { class: 'sx-meta' }, '열린 창에서 폰 연결을 마무리해 주세요.'));

  if (v.step === 'paired')
    return panel(
      {},
      h('div', { class: 'pair-head' }, mark('done'), h('div', { class: 'pair-head-t' }, h('p', { class: 'pair-title', 'data-pair-done': '' }, '연결됐어요'), h('p', { class: 'sx-meta' }, h('span', { 'data-pair-phone': '' }, v.phoneName || '폰'), h('br'), '폰에서 계정 이메일을 확인하고 저장하면 끝나요.'))),
      h('div', { class: 'sx-actions' }, cancel('닫기')),
    );

  // 멈춤(시간 지남 밖): 왜 멈췄는지와 다음 행동 하나
  return panel(
    { class: 'pair-panel is-attention' },
    h('div', { class: 'pair-head' }, mark('attention'), h('div', { class: 'pair-head-t' }, h('p', { class: 'pair-title' }, '연결이 멈췄어요'), h('p', { class: 'pair-text', 'data-pair-error': v.error ?? '' }, pairErrText(v.error)))),
    h('div', { class: 'sx-actions' }, btn('다시 시도', act.retry, 'sx-btn-primary', { 'data-act': 'pair-retry', disabled: busy }), cancel('닫기')),
  );
}

/** 6자리 칸 수. */
export const SAS_LEN = 6;
/** 숫자만 남겨 6자리까지. */
export const sasDigits = (s) => String(s ?? '').replace(/\D/g, '').slice(0, SAS_LEN);
/** 남은 시간 한 줄 "남은 시간 1:43". */
export const pairLeftText = (expiresAt, now) => `남은 시간 ${pairLeft(expiresAt, now)}`;

/**
 * 6칸 입력. 칸마다 한 자리, 넣으면 다음 칸, 빈 칸에서 지우면 앞 칸, 붙여넣기는 6자리를 한 번에, 다 차면 onFull.
 * 값은 act.codeOf()/setCode()에 둔다(다시 그려도 남는다). DOM 속성에는 숫자를 넣지 않는다.
 */
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

/** 6자리 단계부터 끝(연결됐어요·멈춤)까지 모달로 그릴지. sasSeen = 이번 연결에서 6자리 단계에 들어왔는지(멈춤을 모달에 이어 보여 준다). */
export const pairInModal = (v, sasSeen) => !!v && (v.step === 'awaiting_sas' || v.step === 'checking' || v.step === 'paired' || (v.step === 'failed' && sasSeen));

/** 모달 안에서 Tab이 밖으로 나가지 않게 한다. */
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

/**
 * 폰 연결 모달(메인 창 안, 배경 흐림). 6자리 → 확인하는 중 → 연결됐어요, 또는 멈춤.
 * shake = 방금 틀렸다(한 번만 흔든다). Esc·[취소]는 act.cancel.
 */
export function pairModal(v, act, busy = false, now = Date.now(), shake = false) {
  const name = v.phoneName || '폰';
  const phone = () => h('span', { 'data-pair-phone': '' }, name);
  const head = (kind, title, ...sub) =>
    h('div', { class: 'pair-m-hd' }, mark(kind), h('h2', { class: 'pair-m-title', id: 'pair-m-title', ...(kind === 'done' ? { 'data-pair-done': '' } : {}) }, title), sub.length ? h('p', { class: 'pair-m-sub' }, ...sub) : null);
  let body;
  if (v.step === 'awaiting_sas' || v.step === 'checking') {
    const checking = v.step === 'checking';
    const submit = (c) => !busy && !checking && sasDigits(c).length === SAS_LEN && act.submit(sasDigits(c));
    // 틀리면 칸을 빨갛게(다시 넣기 시작하면 푼다), 흔들기는 결과를 받은 그때 한 번만
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
