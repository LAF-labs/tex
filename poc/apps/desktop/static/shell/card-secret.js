// 보안카드 등록 창(부장 판정 2026-11-14): 사진과 애매한 칸 4자리는 이 창에서 금고 포트로만 보낸다. 셸 렌더러·main은 내용을 보지 않는다.
// 금고가 사진을 읽고 애매한 칸 번호만 돌려주면 그 칸만 묻는다. 칸 값은 바이트로 바꾸자마자 칸을 비운다.
const MAX = 20 * 1024 * 1024;
const ERR = {
  'card.ocr_unavailable': '이 PC에서는 사진 글자 인식을 쓸 수 없어요.',
  'card.ocr_failed': '사진을 읽지 못했어요. 다른 사진으로 다시 넣어 주세요.',
  'card.not_a_card': '보안카드 번호표를 찾지 못했어요. 번호가 다 보이게 찍은 사진을 넣어 주세요.',
  'card.image_too_large': '사진이 너무 커요. 20MB 아래 사진을 넣어 주세요.',
  'card.draft_expired': '시간이 지나 다시 읽어야 해요. 사진을 다시 넣어 주세요.',
  denied: '이 창으로는 더 받을 수 없어요. 창을 닫고 다시 열어 주세요.',
};
const $ = (id) => document.getElementById(id);
const msg = (t) => ($('msg').textContent = t);
let port = null;
let seq = 0;
let busy = false;
let draftId = null;
const waiting = new Map();
window.addEventListener('message', (ev) => {
  if (ev.data !== 'vault-secret-port' || !ev.ports[0]) return;
  port = ev.ports[0];
  port.onmessage = ({ data }) => {
    const w = waiting.get(data && data.id);
    if (!w) return;
    waiting.delete(data.id);
    w(data);
  };
});
const rpc = (params) =>
  new Promise((resolve) => {
    const id = ++seq;
    waiting.set(id, resolve);
    port.postMessage({ t: 'rpc', id, method: 'secret.store', params });
  });
const errText = (e) => Object.entries(ERR).find(([k]) => String(e).includes(k))?.[1] ?? '금고에 등록하지 못했어요. 다시 해 주세요.';
function after(reply) {
  busy = false;
  if (reply.error) {
    // 사유 코드(값 없음)는 창 안에만 남긴다
    $('msg').dataset.code = String(reply.error).slice(0, 40);
    msg(errText(reply.error));
    return;
  }
  const r = reply.result || {};
  if (r.pending) {
    draftId = r.pending.draftId;
    $('drop').hidden = true;
    $('ask').hidden = false;
    $('ask-q').textContent = `사진에서 ${r.pending.ask.length}칸을 확실히 읽지 못했어요. 그 칸의 4자리만 넣어 주세요.`;
    $('cells').replaceChildren(
      ...r.pending.ask.map((row) => {
        const l = document.createElement('label');
        l.className = 'cell';
        const s = document.createElement('span');
        s.textContent = `${row}번`;
        const i = document.createElement('input');
        Object.assign(i, { type: 'password', inputMode: 'numeric', maxLength: 4, autocomplete: 'off', spellcheck: false });
        i.dataset.row = String(row);
        l.append(s, i);
        return l;
      }),
    );
    $('cells').querySelector('input')?.focus();
    msg('');
    return;
  }
  const n = r.consent && typeof r.consent.items === 'number' ? r.consent.items : 0;
  $('drop').hidden = true;
  $('ask').hidden = true;
  msg(`보안카드 ${n}칸을 이 PC 금고에 등록했어요.`);
  setTimeout(() => window.close(), 1_200);
}
async function sendFile(file) {
  if (!file || busy || !port) return;
  if (file.size > MAX) return msg(ERR['card.image_too_large']);
  busy = true;
  msg('카드를 읽고 있어요');
  let image = null;
  try {
    image = new Uint8Array(await file.arrayBuffer());
    const reply = await rpc({ image, entries: [] });
    after(reply);
  } catch {
    busy = false;
    msg('사진을 열지 못했어요. 다른 사진으로 다시 넣어 주세요.');
  } finally {
    image?.fill(0);
  }
}
$('pick').addEventListener('click', () => $('file').click());
$('file').addEventListener('change', () => {
  const f = $('file').files?.[0];
  $('file').value = '';
  void sendFile(f);
});
const drop = $('drop');
for (const ev of ['dragenter', 'dragover']) drop.addEventListener(ev, (e) => (e.preventDefault(), drop.classList.add('is-over')));
drop.addEventListener('dragleave', () => drop.classList.remove('is-over'));
drop.addEventListener('drop', (e) => {
  e.preventDefault();
  drop.classList.remove('is-over');
  void sendFile(e.dataTransfer?.files?.[0]);
});
// 창 아무 데나 떨어뜨려도 페이지가 그 파일로 바뀌지 않게
for (const ev of ['dragover', 'drop']) window.addEventListener(ev, (e) => e.preventDefault());
$('ask').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (busy || !port || !draftId) return;
  const inputs = [...$('cells').querySelectorAll('input')];
  const bad = inputs.find((i) => !/^\d{4}$/.test(i.value));
  if (bad) {
    bad.focus();
    return msg('칸마다 숫자 4자리를 넣어 주세요.');
  }
  const enc = new TextEncoder();
  const entries = inputs.map((i) => ({ row: Number(i.dataset.row), bytes: enc.encode(i.value) }));
  for (const i of inputs) i.value = '';
  busy = true;
  msg('금고에 넘기고 있어요');
  const reply = await rpc({ draftId, entries });
  for (const x of entries) x.bytes.fill(0);
  after(reply);
});
