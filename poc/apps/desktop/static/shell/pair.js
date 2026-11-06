// 폰 연결 창(S-03): main(remote-pairing.ts)이 준 화면 값으로만 그린다. QR은 main이 만든 SVG data URL 이미지로 오고 <img src>로만 쓴다(QR 글자는 이 창에 없다, HTML 삽입 없음).
// 값은 모두 textContent로 넣는다. 6자리는 폰에서 보고 이 PC에 입력한다("일치" 버튼은 없다, D08 §4.2).
const root = document.getElementById('root');
const QR_PREFIX = 'data:image/svg+xml;base64,';
const ERR = {
  'pair.sas_wrong': '6자리가 맞지 않아요. 폰에 보이는 숫자를 다시 확인해 주세요',
  'pair.sas_shape': '6자리 숫자를 넣어 주세요',
  'pair.sas_locked': '여러 번 틀려서 이번 연결은 끝났어요. 다시 해 주세요',
  'pair.expired': '시간이 지났어요. 다시 해 주세요',
  'pair.handshake': '폰과 연결하지 못했어요. 다시 해 주세요',
  'policy.rate_limited': '연결 시도가 많아요. 잠시 뒤에 다시 해 주세요',
  'relay.room_used': '이 연결은 이미 쓰였어요. 다시 해 주세요',
  'account.device_limit': '이 계정에 연결할 수 있는 기기 수를 넘었어요',
  gesture_required: '버튼을 다시 눌러 주세요',
};
const errText = (c) => (c ? (ERR[c] ?? (c.startsWith('net.') ? '연결하지 못했어요. 인터넷 연결을 확인해 주세요' : '연결하지 못했어요. 다시 해 주세요')) : '');

function el(tag, attrs = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') e.className = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else e.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of kids.flat()) if (c != null && c !== false) e.append(c instanceof Node ? c : String(c));
  return e;
}

function qrImg(src) {
  if (typeof src !== 'string' || !src.startsWith(QR_PREFIX)) return null;
  const i = el('img', { class: 'qr', alt: '폰 연결 QR', draggable: 'false' });
  i.src = src;
  return i;
}

let busy = false;
const act = (f) => async () => {
  if (busy) return;
  busy = true;
  try {
    render(await f());
  } catch (e) {
    render({ ...last, error: String(e?.message ?? '').replace(/^.*Error: /, '') });
  } finally {
    busy = false;
  }
};
let last = null;

function render(v) {
  if (!v) return;
  last = v;
  const kids = [];
  if (v.step === 'idle' || v.step === 'opening') {
    kids.push(el('h1', {}, '폰 연결'), el('p', { class: 'muted' }, '연결을 준비하고 있어요…'));
  } else if (v.step === 'waiting_phone') {
    const left = v.expiresAt ? Math.max(0, Math.round((v.expiresAt - Date.now()) / 1000)) : null;
    kids.push(
      el('h1', {}, '폰 연결'),
      el('p', {}, '폰 앱에서 [PC 연결]을 누르고 이 QR을 찍어 주세요.'),
      qrImg(v.qr),
      el('p', { class: 'muted', 'data-pair-ttl': '' }, left !== null ? `${left}초 안에 찍어 주세요. 이 창은 화면 캡처에 찍히지 않아요.` : ''),
      el('div', { class: 'acts' }, el('button', { type: 'button', 'data-act': 'pair-cancel', onclick: act(() => window.pair.cancel().then((x) => (window.close(), x))) }, '취소')),
    );
  } else if (v.step === 'awaiting_sas' || v.step === 'checking') {
    const input = el('input', { id: 'sas', inputmode: 'numeric', maxlength: 6, autocomplete: 'off', 'aria-label': '폰에 보이는 6자리' });
    const submit = act(() => window.pair.submit(input.value.trim()));
    input.addEventListener('keydown', (e) => e.key === 'Enter' && submit());
    kids.push(
      el('h1', {}, '6자리 넣기'),
      el('p', {}, '폰 ', el('b', { 'data-pair-phone': '' }, v.phoneName ?? ''), '에 보이는 6자리를 이 PC에 넣어 주세요.'),
      el('p', { class: 'muted' }, '6자리는 이 PC 화면에만 넣어요. 다른 곳에 알려 주지 마세요.'),
      el('div', { class: 'sas' }, input, el('button', { type: 'button', class: 'primary', 'data-act': 'pair-submit', disabled: v.step === 'checking', onclick: submit }, v.step === 'checking' ? '연결하는 중…' : '확인')),
      v.error ? el('p', { class: 'err', 'data-pair-error': v.error }, errText(v.error), v.triesLeft ? ` (${v.triesLeft}번 남음)` : '') : null,
      el('div', { class: 'acts' }, el('button', { type: 'button', 'data-act': 'pair-cancel', onclick: act(() => window.pair.cancel().then((x) => (window.close(), x))) }, '취소')),
    );
    setTimeout(() => input.focus(), 0);
  } else if (v.step === 'paired') {
    kids.push(
      el('h1', {}, '연결했어요'),
      el('p', {}, '폰 ', el('b', { 'data-pair-phone': '' }, v.phoneName ?? ''), '을(를) 이 PC에 연결했어요. 폰에서 계정 이메일을 확인하고 저장하면 끝나요.'),
      el('div', { class: 'acts' }, el('button', { type: 'button', class: 'primary', 'data-act': 'pair-close', onclick: () => window.close() }, '닫기')),
    );
  } else {
    kids.push(
      el('h1', {}, '연결하지 못했어요'),
      el('p', { class: 'err', 'data-pair-error': v.error ?? '' }, errText(v.error)),
      el('div', { class: 'acts' }, el('button', { type: 'button', 'data-act': 'pair-close', onclick: () => window.close() }, '닫기'), el('button', { type: 'button', class: 'primary', 'data-act': 'pair-retry', onclick: act(() => window.pair.retry()) }, '다시 하기')),
    );
  }
  root.replaceChildren(...kids.filter(Boolean));
  document.body.dataset.pair = v.step;
}

window.pair.onView(render);
window.pair.view().then(render);
// 남은 시간 표시
setInterval(() => {
  const t = document.querySelector('[data-pair-ttl]');
  if (t && last?.expiresAt) t.textContent = `${Math.max(0, Math.round((last.expiresAt - Date.now()) / 1000))}초 안에 찍어 주세요. 이 창은 화면 캡처에 찍히지 않아요.`;
}, 1000);
