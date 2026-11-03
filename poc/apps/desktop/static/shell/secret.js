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
document.getElementById('f').addEventListener('submit', (e) => {
  e.preventDefault();
  const el = document.getElementById('v');
  if (!port || !el.value) return;
  const bytes = new TextEncoder().encode(el.value);
  el.value = '';
  const params = { kind: ds.kind, scope: ds.scope, bytes };
  if (ds.row) params.row = Number(ds.row);
  port.postMessage({ t: 'rpc', id: 1, method: 'secret.provide', params });
  bytes.fill(0);
});
