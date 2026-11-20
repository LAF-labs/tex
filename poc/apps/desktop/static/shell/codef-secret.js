const ds = document.body.dataset;
let port = null;
window.addEventListener('message', (ev) => {
  if (ev.data === 'vault-secret-port' && ev.ports[0]) {
    port = ev.ports[0];
    port.onmessage = ({ data }) => {
      document.getElementById('msg').textContent = data && data.error ? '금고가 받지 않았어요. 창을 닫고 다시 해 주세요.' : '금고에 넘겼어요. CODEF로 조회하는 중이에요.';
      setTimeout(() => window.close(), 500);
    };
  }
});
document.getElementById('f').addEventListener('submit', (e) => {
  e.preventDefault();
  const el = document.getElementById('v');
  if (!port || !el.value) return;
  const bytes = new TextEncoder().encode(el.value);
  el.value = '';
  port.postMessage({ t: 'rpc', id: 1, method: 'secret.provide', params: { scope: ds.scope, remember: document.getElementById('remember').checked, bytes } });
  bytes.fill(0);
});
