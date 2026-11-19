// 폰 연결 칸(S-03): 설정 > 기기 연결의 계정 카드 안에서 [폰 연결]이 그 자리에서 펼쳐진다(따로 창·팝업 없음).
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

const STEPS = ['폰에서 택스오프를 열고', '[PC와 연결]을 눌러', '이 QR을 찍어 주세요'];
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
export function pairSection(v, act, busy = false, now = Date.now()) {
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

  if (v.step === 'awaiting_sas' || v.step === 'checking') {
    const code = act.codeOf();
    const checking = v.step === 'checking';
    const input = h('input', { class: 'doc-in dev-code', id: 'pair-sas', inputmode: 'numeric', maxlength: 6, autocomplete: 'off', spellcheck: 'false', placeholder: '000000', 'aria-label': '폰에 보이는 6자리', disabled: checking, 'aria-invalid': v.error ? 'true' : null });
    input.value = code;
    const ok = btn(checking ? '확인하는 중…' : '연결', () => act.submit(input.value), 'sx-btn-primary', { 'data-act': 'pair-submit', disabled: busy || checking || code.length !== 6 });
    input.addEventListener('input', () => {
      const d = input.value.replace(/\D/g, '').slice(0, 6);
      if (input.value !== d) input.value = d;
      act.setCode(d);
      ok.disabled = busy || d.length !== 6;
    });
    input.addEventListener('keydown', (e) => e.key === 'Enter' && input.value.length === 6 && !ok.disabled && act.submit(input.value));
    const name = v.phoneName || '폰';
    return panel(
      {},
      h('div', { class: 'pair-head' }, mark(), h('div', { class: 'pair-head-t' }, h('p', { class: 'pair-title' }, '폰에 보이는 6자리를 넣어 주세요'), h('p', { class: 'sx-meta' }, h('span', { 'data-pair-phone': '' }, name), '에서 QR을 찍었어요. 6자리는 이 PC에만 넣어요.'))),
      h('div', { class: 'dev-code-row' }, input, ok, cancel()),
      v.error ? h('p', { class: 'pair-err', role: 'alert', 'data-pair-error': v.error }, pairErrText(v.error), v.error === 'pair.sas_wrong' && v.triesLeft ? ` ${v.triesLeft}번 더 넣을 수 있어요.` : '') : null,
    );
  }

  if (v.step === 'paired')
    return panel(
      {},
      h('div', { class: 'pair-head' }, mark('done'), h('div', { class: 'pair-head-t' }, h('p', { class: 'pair-title', 'data-pair-done': '' }, '연결됐어요'), h('p', { class: 'sx-meta' }, h('span', { 'data-pair-phone': '' }, v.phoneName || '폰'), ' · 폰에서 계정 이메일을 확인하고 저장하면 끝나요.'))),
      h('div', { class: 'sx-actions' }, cancel('닫기')),
    );

  // 멈춤(시간 지남 밖): 왜 멈췄는지와 다음 행동 하나
  return panel(
    { class: 'pair-panel is-attention' },
    h('div', { class: 'pair-head' }, mark('attention'), h('div', { class: 'pair-head-t' }, h('p', { class: 'pair-title' }, '연결이 멈췄어요'), h('p', { class: 'pair-text', 'data-pair-error': v.error ?? '' }, pairErrText(v.error)))),
    h('div', { class: 'sx-actions' }, btn('다시 시도', act.retry, 'sx-btn-primary', { 'data-act': 'pair-retry', disabled: busy }), cancel('닫기')),
  );
}
