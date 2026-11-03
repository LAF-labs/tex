// 비밀 입력 창: 입력 즉시 바이트로 바꾸고 칸을 비운다(D05 §8 A-30). 값은 금고 포트로만 보낸다.
// kind·scope·row는 main이 페이지에 실은 값(금고 결속값과 같음)만 보낸다. 금고는 결속값과 다르면 받지 않는다.
const ds = document.body.dataset;
let port = null;
window.addEventListener('message', (ev) => {
  if (ev.data === 'vault-secret-port' && ev.ports[0]) {
    port = ev.ports[0];
    port.onmessage = ({ data }) => {
      document.getElementById('msg').textContent = data && data.error ? '금고가 받지 않았어요. 창을 닫고 다시 준비해 주세요.' : '금고에 넘겼어요.';
      setTimeout(() => window.close(), 400);
    };
  }
});
// 보안카드 칸만: 보기 버튼 하나, 켜면 30초 뒤 다시 가린다(디자인 시스템 SecretField). 값은 DOM 속성에 넣지 않는다.
const reveal = document.getElementById('reveal');
let revealTimer = 0;
function setShown(on) {
  if (!reveal) return;
  clearTimeout(revealTimer);
  document.getElementById('v').type = on ? 'text' : 'password';
  reveal.setAttribute('aria-pressed', String(on));
  reveal.querySelector('span').textContent = on ? '번호 가리기' : '번호 보기';
  document.getElementById('reveal-note').textContent = on ? '30초 뒤 다시 가려요' : '';
  if (on) revealTimer = setTimeout(() => setShown(false), 30_000);
}
reveal?.addEventListener('click', () => setShown(reveal.getAttribute('aria-pressed') !== 'true'));
document.getElementById('f').addEventListener('submit', (e) => {
  e.preventDefault();
  setShown(false);
  const el = document.getElementById('v');
  if (!port || !el.value) return;
  const bytes = new TextEncoder().encode(el.value);
  el.value = '';
  const params = { kind: ds.kind, scope: ds.scope, bytes };
  if (ds.row) params.row = Number(ds.row);
  port.postMessage({ t: 'rpc', id: 1, method: 'secret.provide', params });
  bytes.fill(0);
});
