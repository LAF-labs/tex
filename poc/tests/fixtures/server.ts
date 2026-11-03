// 금고 테스트용 로컬 포털 흉내(127.0.0.1). 실제 포털·보안 모듈 동작은 흉내 내지 않는다.
import http from 'node:http';
import type { AddressInfo } from 'node:net';

const page = (title: string, body: string) => `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head><body>${body}</body></html>`;

export interface Fixture {
  origin: string;
  /** 서버가 받은 요청 바디(누출 확인 대상이 아니라 "실제로 제출되었는가" 확인용). */
  bodies: string[];
  /** 서버가 받은 Cookie 요청 헤더(쿠키 정리 시험이 헛돌지 않는지 확인용). */
  cookies: string[];
  /** /session이 내려 주는 세션 쿠키 값(엔진 수신 원문에서 0건이어야 한다, N-51). */
  cookieValue: string;
  close(): Promise<void>;
}

export async function startFixture(): Promise<Fixture> {
  const bodies: string[] = [];
  const cookies: string[] = [];
  const cookieValue = `SAXTEST-${Math.random().toString(36).slice(2, 12)}`;
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    let body = '';
    req.on('data', (c: Buffer) => (body += c.toString('utf8')));
    req.on('end', () => {
      if (body) bodies.push(body);
      if (req.headers.cookie) cookies.push(req.headers.cookie);
      const html = (s: string) => {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(s);
      };
      switch (url.pathname) {
        case '/login':
          return html(page('login', `
<form id="f" method="POST" action="/submit">
  <input id="user" name="user" autocomplete="username">
  <input id="pw" name="pw" type="password" autocomplete="current-password">
  <input id="note" name="note">
  <button id="go" type="submit">로그인</button>
</form>
<iframe id="child" src="/child"></iframe>
<script>
  const w = new Worker('/worker.js');
  document.getElementById('pw').addEventListener('change', (e) => w.postMessage(e.target.value));
</script>`));
        case '/child':
          return html(page('child', `<form method="POST" action="/child-submit"><input id="cpw" type="password" name="cpw"><button id="cgo">ok</button></form>`));
        case '/worker.js':
          res.writeHead(200, { 'content-type': 'text/javascript' });
          return res.end(`onmessage = (e) => fetch('/worker-post', { method: 'POST', body: 'w=' + e.data });`);
        case '/spa':
          // SPA 로그인: 문서 커밋 없이 fetch로 제출하고 화면만 바꾼다(교착 시험, E-01).
          return html(page('spa', `
<input id="pw" type="password">
<button id="go" onclick="fetch('/api/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({pw:document.getElementById('pw').value})}).then(()=>{document.body.insertAdjacentHTML('beforeend','<p id=ok>welcome</p>')})">로그인</button>`));
        case '/redirect':
          // 서버 리디렉션(302): 허용 밖 host를 거쳐 허용 host로 가는 경로 시험용
          res.writeHead(302, { location: url.searchParams.get('to') ?? '/login' });
          return res.end();
        case '/bounce':
          // 클라이언트 리디렉션: 허용 밖 문서가 커밋된 뒤 스크립트로 허용 host로 보낸다
          return html(page('bounce', `<script>setTimeout(() => location.replace(${JSON.stringify(url.searchParams.get('to') ?? '/login')}), 300)</script>`));
        case '/slow': {
          // 응답을 늦춰 "이동은 시작됐지만 아직 커밋 전" 상태를 만든다(fail-closed 시험).
          const ms = Math.min(Number(url.searchParams.get('ms') ?? '3000'), 10_000);
          setTimeout(() => html(page('slow', '<p id="slow">slow</p>')), ms);
          return;
        }
        case '/session':
          // 로그인 응답 흉내: 세션 쿠키를 내려 준다
          res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'set-cookie': `SAXTEST=${cookieValue}; Path=/; HttpOnly`, authorization: 'Bearer SAXTEST-auth' });
          return res.end(page('session', '<p>ok</p>'));
        case '/popup':
          return html(page('popup', `<button id="open" onclick="window.open('/login')">open</button>`));
        case '/away':
          return html(page('away', `<a id="out" href="${url.searchParams.get('to') ?? 'about:blank'}">out</a>`));
        case '/submit':
        case '/child-submit':
        case '/api/login':
        case '/worker-post':
          return html(page('done', '<p id="done">done</p>'));
        default:
          res.writeHead(404);
          res.end();
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;
  return {
    origin: `http://127.0.0.1:${port}`,
    bodies,
    cookies,
    cookieValue,
    close: () => new Promise((r) => {
      server.closeAllConnections();
      server.close(() => r());
    }),
  };
}
