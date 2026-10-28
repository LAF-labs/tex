// 입력 즉시 바이트로 바꾸고 칸을 비운다(D05 §8 A-30). 값은 금고 포트로만 보낸다.
const params = new URLSearchParams(location.hash.slice(1));
const kind = params.get('kind') || 'cert_password';
const scope = params.get('scope') || 'business';
document.getElementById('kind').textContent = `종류: ${kind} · 범위: ${scope}`;
let port = null;
window.addEventListener('message', (ev) => {
  if (ev.data === 'vault-secret-port' && ev.ports[0]) {
    port = ev.ports[0];
    port.onmessage = ({ data }) => {
      document.getElementById('msg').textContent = data && data.error ? '실패' : '금고에 넘겼습니다.';
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
  port.postMessage({ t: 'rpc', id: 1, method: 'secret.provide', params: { kind, scope, bytes } });
  bytes.fill(0);
});
