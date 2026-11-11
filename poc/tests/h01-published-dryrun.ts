// 게시본 H-01(hometax.invoice.issue@2.1.1) 전체 스텝 건조 실행 하네스(2026-11-11 부장 지시). 실제 홈택스에 접속하지 않는다.
// - 스텝은 게시본 playbook.json 전부(s0~s35, s90~s93)를 그대로 쓴다. 바꾸는 것은 URL origin과 셀렉터 id 접두(hometax.invoice.* → fixture.invoice.*),
//   s30 실패 신호(가짜 페이지 문구), 그리고 시험이 고른 substitutions뿐이다(시간 상한 줄이기 등, 시나리오에 적는다). signFlow·expectConfirm·분기·onFail은 게시본 그대로.
// - 화면: 가짜 홈·로그인·서명 창을 이 파일의 바깥 서버가 그리고, 발급 폼·발급·목록은 가짜 H-01 페이지(startH01Fixture)를 같은 origin으로 중계한다.
//   로그인 화면 요소는 게시본 셀렉터(역할·이름)에 맞춰 그렸다: main "홈택스", link "홈", form "로그인", button "간편인증", dialog "전자서명", button "서명".
//   실제 홈택스에 그 요소가 있는지는 여기서 알 수 없다(실제에서만 확인 가능).
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { fixturePortal } from '@sax/engine';
import { FIXTURE_PORTAL, loadPackage, type LoadedPackage, type LoaderContext, type PackageFiles, type SelectorEntry, type Step } from '@sax/engine/core';
import { BUNDLE_ALLOWLIST } from '@sax/model';
import { startH01Fixture, type H01Fixture } from '../apps/desktop/src/h01-fixture.ts';
import { bundleOutcomes, h01, signPackage, testKeys } from './core-fixtures.ts';
import { fixtureId, h01FixtureFiles, h01FixtureLookupFiles } from './h01-fixture-package.ts';

export interface LoginFixture {
  origin: string;
  inner: H01Fixture;
  /** 사람이 간편인증(폰 승인)·공동인증서 암호 입력을 끝냈다. */
  completeLogin(): void;
  state: {
    loggedIn: boolean;
    /** 간편인증 요청을 받았다(사람이 폰에서 승인할 차례). */
    pending: boolean;
    /** 로그인 화면에 자동입력 방지 문자를 보인다. */
    captcha: boolean;
    /** 발급 클릭 뒤 서명 창을 띄우기까지(ms). 간편인증 PUSH 승인 흉내. */
    signDelayMs: number;
    /** 서명 창에서 [서명]을 누른 수. */
    signs: number;
  };
  close(): Promise<void>;
}

const page = (title: string, body: string) => `<!doctype html><html lang="ko"><head><meta charset="utf-8"><title>${title}</title></head><body>${body}</body></html>`;

function home(s: LoginFixture['state']): string {
  const top = `<nav><a href="/">홈</a>${s.loggedIn ? ' <a href="/logout">로그아웃</a>' : ''}</nav>`;
  if (s.loggedIn) return page('홈택스', `<main aria-label="홈택스">${top}<p>환영합니다.</p><a href="/invoice/issue">전자세금계산서 건별발급</a></main>`);
  const captcha = s.captcha
    ? `<img alt="자동입력 방지 문자" src="data:image/gif;base64,R0lGODlhAQABAAAAACw="><label for="cpt">자동입력 방지 문자 입력</label><input id="cpt" type="text"><button type="button" id="btnCpt">확인</button>`
    : '';
  return page('홈택스', `<main aria-label="홈택스">${top}
<form aria-label="로그인" onsubmit="return false"><button type="button" id="btnSimple">간편인증</button>${captcha}<p id="st"></p></form></main>
<script>
  document.getElementById('btnSimple').addEventListener('click', async () => {
    await fetch('/api/login/start', { method: 'POST' });
    document.getElementById('st').textContent = '인증 요청을 보냈습니다. 휴대폰에서 승인해 주세요.';
    const t = setInterval(async () => {
      const r = await fetch('/api/login/state').then((x) => x.json());
      if (r.loggedIn) { clearInterval(t); location.href = '/'; }
    }, 200);
  });
</script>`);
}

/** 발급 폼에 붙이는 확인 대화상자·전자서명 창(가짜). 발급하기 → confirm → (signDelayMs 뒤) dialog "전자서명" → [서명] → 폼 제출. */
const SIGN_SCRIPT = (delayMs: number) => `<script>
(() => {
  const f = document.getElementById('invoice-form');
  f.addEventListener('submit', (e) => {
    e.preventDefault();
    if (!confirm('전자세금계산서를 발급하시겠습니까?')) return;
    setTimeout(() => {
      const m = document.createElement('main');
      m.setAttribute('aria-label', '홈택스');
      m.innerHTML = '<div role="dialog" aria-label="전자서명"><p>전자서명</p><button type="button" id="btnSign">서명</button></div>';
      document.body.append(m);
      document.getElementById('btnSign').addEventListener('click', () => { fetch('/api/sign', { method: 'POST' }).finally(() => HTMLFormElement.prototype.submit.call(f)); });
    }, ${delayMs});
  });
})();
</script>`;

export async function startLoginFixture(o: { supplier?: { bizNo: string; name: string }; loggedIn?: boolean; captcha?: boolean } = {}): Promise<LoginFixture> {
  const inner = await startH01Fixture({ registry: { '2148651233': 'A상사' }, supplier: o.supplier ?? { bizNo: '1234567891', name: '가나다컴퍼니' } });
  const innerUrl = new URL(inner.origin);
  const state: LoginFixture['state'] = { loggedIn: o.loggedIn ?? false, pending: false, captcha: o.captcha ?? false, signDelayMs: 300, signs: 0 };
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    const html = (s: string) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      res.end(s);
    };
    const json = (v: unknown) => {
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify(v));
    };
    if (url.pathname === '/' && req.method === 'GET') return html(home(state));
    if (url.pathname === '/logout') {
      state.loggedIn = false;
      res.writeHead(302, { location: '/' });
      return res.end();
    }
    if (url.pathname === '/api/login/start') {
      state.pending = true;
      return json({ ok: true });
    }
    if (url.pathname === '/api/login/state') return json({ loggedIn: state.loggedIn });
    if (url.pathname === '/api/sign') {
      state.signs++;
      return json({ ok: true });
    }
    if (url.pathname === '/invoice/issue' && req.method === 'GET' && !state.loggedIn) {
      res.writeHead(302, { location: '/' });
      return res.end();
    }
    // 나머지는 가짜 H-01 페이지로 중계한다(발급 폼에는 서명 창 스크립트를 붙인다).
    const up = http.request({ hostname: innerUrl.hostname, port: innerUrl.port, path: req.url, method: req.method, headers: { ...req.headers, host: innerUrl.host } }, (r) => {
      const form = url.pathname === '/invoice/issue' && req.method === 'GET' && r.statusCode === 200;
      if (!form) {
        res.writeHead(r.statusCode ?? 502, r.headers);
        return void r.pipe(res);
      }
      let body = '';
      r.setEncoding('utf8');
      r.on('data', (c: string) => (body += c));
      r.on('end', () => html(body.replace('</body>', `${SIGN_SCRIPT(state.signDelayMs)}</body>`)));
    });
    req.pipe(up);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;
  return {
    origin: `http://127.0.0.1:${port}`,
    inner,
    state,
    completeLogin: () => {
      state.loggedIn = true;
      state.pending = false;
    },
    close: async () => {
      await new Promise<void>((r) => {
        server.closeAllConnections();
        server.close(() => r());
      });
      await inner.close();
    },
  };
}

const GOLDEN_ORIGIN = 'https://hometax.go.kr';
const rename = (id: string) => (id.startsWith('hometax.invoice.') ? `fixture.invoice.${id.slice('hometax.invoice.'.length)}` : id);

/** 게시본 스텝 → 가짜 페이지 스텝: URL origin과 셀렉터 id 접두만 바꾼다. */
function step(s: Step, origin: string): Step {
  const json = JSON.stringify(s)
    .replaceAll(`"${GOLDEN_ORIGIN}`, `"${origin}`)
    .replace(/"(hometax\.invoice\.[A-Za-z0-9_.]+)"/g, (_, id: string) => `"${fixtureId(id)}"`);
  return JSON.parse(json) as Step;
}

export type StepPatch = (s: Step & Record<string, unknown>) => void;

/** 게시본 전체 스텝 패키지 파일(서명 전). patches는 시나리오가 고른 바꿈(스텝 id → 함수). */
export function publishedDryRunFiles(origin: string, patches: Record<string, StepPatch> = {}): PackageFiles {
  const g = h01();
  const fx = h01FixtureFiles(origin);
  const steps = g.playbook.steps.map((s) => {
    const out = s.id === 's30' ? structuredClone(fx.playbook.steps.find((x) => x.id === 's30')!) : step(s, origin);
    patches[s.id]?.(out as Step & Record<string, unknown>);
    return out;
  });
  const entries: Record<string, SelectorEntry> = { ...fx.selectors.entries };
  for (const [id, e] of Object.entries(g.selectors.entries)) {
    if (id.startsWith('hometax.invoice.form.')) continue;
    const c = structuredClone(e);
    c.landmark = rename(c.landmark);
    entries[rename(id)] = c;
  }
  return {
    manifest: { ...fx.manifest, bundlesUsed: g.manifest.bundlesUsed },
    playbook: { ...fx.playbook, steps },
    selectors: { ...fx.selectors, portal: FIXTURE_PORTAL, entries },
    strings: { ...g.strings, 'invoice.emailNotConfirmed': fx.strings['invoice.emailNotConfirmed']! },
  };
}

export function loadPublishedDryRun(origin: string, patches: Record<string, StepPatch> = {}): { pkg: LoadedPackage; lookups: Map<string, LoadedPackage> } {
  const keys = testKeys();
  const two = keys.pkg.slice(0, 2);
  const ctx = (installedLookups: ReadonlyMap<string, LoadedPackage>): LoaderContext => ({
    roots: keys.roots, revoked: new Set(), bundleAllowlist: BUNDLE_ALLOWLIST, bundles: bundleOutcomes(), installedLookups,
    storedVersion: null, installedDigest: null, hold: false, policyFresh: true, now: Date.now(),
  });
  const lookups = new Map<string, LoadedPackage>();
  for (const [id, files] of h01FixtureLookupFiles(origin)) {
    const r = loadPackage(signPackage(files, two), ctx(new Map()));
    if (!r.ok) throw new Error(`조회 패키지 ${id}: ${r.code} ${JSON.stringify(r.violations)}`);
    lookups.set(id, r.pkg);
  }
  const files = publishedDryRunFiles(origin, patches);
  const r = loadPackage(signPackage(files, two, files.manifest.lookupsUsed.map((l) => lookups.get(l.id)?.manifestDigest ?? '0'.repeat(64))), ctx(lookups));
  if (!r.ok) throw new Error(`게시본 건조 실행 패키지: ${r.code} ${JSON.stringify(r.violations)}`);
  return { pkg: r.pkg, lookups };
}

export { fixturePortal };
