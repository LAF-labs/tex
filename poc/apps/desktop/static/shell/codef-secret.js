// 계좌 자동조회 인증서 비밀번호 창: 입력 즉시 바이트로 바꾸고 칸을 비운다(D05 §8 A-30). 값은 금고 포트로만 보낸다.
// scope는 main이 페이지에 실은 값(금고 결속값과 같음)만. [이 PC에 기억]은 사장님이 고른 때만 true.
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
