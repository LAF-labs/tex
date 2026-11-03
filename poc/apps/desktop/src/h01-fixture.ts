// 가짜 H-01 페이지(127.0.0.1). 홈택스 대신 발급 폼·발급·발급목록·메일발송목록을 흉내 낸다. 실제 홈택스 화면·보안 모듈·서명은 흉내 내지 않는다.
// 요청률 정책 시험(D03 §7)용 차단 안내·추가 인증·자동입력방지 페이지와 HTTP 상태 손잡이도 있다(문구 가상).
// 셀렉터·URL은 PoC-3 전까지 이 페이지에 맞춘 값이다(engine h01/portal.ts의 fixture 사전). 모든 값은 가상이다.
import http from 'node:http';
import type { AddressInfo } from 'node:net';

export interface IssuedInvoice {
  approvalNo: string;
  supplierBizNo: string;
  counterpartBizNo: string;
  counterpartName: string;
  counterpartEmail: string;
  itemName: string;
  supplyAmount: string;
  taxAmount: string;
  issueDate: string;
}

export interface H01Knobs {
  /** 폼에 보이는 공급자(로그인한 사업자). 프로필과 다르면 s19c assert가 막아야 한다. */
  supplier: { bizNo: string; name: string };
  /** 이 값이 있으면 폼 스크립트가 해당 칸을 바꾼다(게이트 뒤 화면 값이 바뀌는 경우). */
  mutate: { field: string; value: string } | null;
  /** 발급목록 반영 지연(ms). */
  reflectDelayMs: number;
  /** 발급 요청을 받고도 목록에 남기지 않는다(verify unknown). */
  dropIssue: boolean;
  /** 발급을 거절하고 오류 문구를 보인다(명시적 실패 신호). */
  failIssue: boolean;
  /** 발급목록 조회 응답 지연(ms). 기준선 조회 중 [중지] 시험용. */
  lookupDelayMs: number;
  /** 받는 이메일 칸을 비우면 60ms 뒤 이 값으로 다시 채운다(포털이 거래처 등록 메일을 되살리는 경우). 폼을 열 때 정해진다. */
  refillEmail: string | null;
  /**
   * 차단 신호 시험(D03 §7). 'page': 발급 화면을 차단 안내 페이지(/notice/blocked)로 보낸다. 'dialog': 폼이 차단 문구 알림창을 띄운다.
   * 'lookup': 발급목록 조회를 차단 안내 페이지로 보낸다. 문구·URL은 가상이다(엔진 fixture 사전과 맞춘 값).
   */
  block: 'page' | 'dialog' | 'lookup' | null;
  /** 다음 N번 발급 화면을 추가 인증 페이지(/auth/extra)로 보낸다. */
  extraAuth: number;
  /** 다음 N번 발급 화면을 자동입력방지 페이지(/auth/captcha)로 보낸다. */
  captcha: number;
  /** 이 경로(pathname)에 이 HTTP 상태로 답한다(403·429 시험). */
  status: { path: string; code: number } | null;
  /** 폼이 네비게이션 없이(XHR로) 이 문구의 안내 레이어를 띄운다(WebSquare 레이어 알림 흉내). */
  notice: string | null;
}

export const FIXTURE_BLOCK_TEXT = '비정상적인 접근이 감지되어 이용이 제한되었습니다.';

export interface H01Fixture {
  origin: string;
  issued: IssuedInvoice[];
  /** 받은 발급 POST 수(목록 반영과 무관하게 "실제로 제출됐는가"). */
  posts: () => number;
  /** 받은 요청(favicon 제외). 차단 신호 뒤 요청이 없는지 본다. */
  requests: Array<{ at: number; method: string; path: string }>;
  knobs: H01Knobs;
  close(): Promise<void>;
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const page = (title: string, body: string) => `<!doctype html><html lang="ko"><head><meta charset="utf-8"><title>${esc(title)}</title></head><body>${body}</body></html>`;
const pad = (n: number, w = 2) => String(n).padStart(w, '0');
/** 작성일자는 PC 시간대가 아니라 한국 시간(KST) 날짜다(I-8, ADR-027 결정 1). */
export const today = (now = Date.now()) => new Date(now + 9 * 3_600_000).toISOString().slice(0, 10);

/** 가짜 사업자 조회 대장(공급받는자 확인 버튼). */
export type Registry = Record<string, string>;

function form(k: H01Knobs): string {
  // 합계는 공급가액 + 세액을 페이지가 계산해 보이는 별도 요소(readbackOf가 아닌 표시값)다.
  return page('전자세금계산서 건별발급', `
<form id="invoice-form" aria-label="전자세금계산서 건별발급" method="POST" action="/invoice/issue">
  <fieldset><legend>공급자</legend>
    <span>등록번호</span> <output id="supplierBizNo" aria-label="공급자 등록번호">${esc(k.supplier.bizNo)}</output>
    <span>상호</span> <output id="supplierName" aria-label="공급자 상호">${esc(k.supplier.name)}</output>
  </fieldset>
  <fieldset><legend>공급받는자</legend>
    <label for="dmnrBizNo">공급받는자 등록번호</label> <input id="dmnrBizNo" name="dmnrBizNo" inputmode="numeric">
    <button type="button" id="btnCpCheck">공급받는자 확인</button>
    <label for="dmnrName">공급받는자 상호</label> <input id="dmnrName" name="dmnrName" readonly>
    <label for="dmnrEmail">공급받는자 이메일</label> <input id="dmnrEmail" name="dmnrEmail" type="email" value="old@prefilled.example">
  </fieldset>
  <fieldset><legend>품목</legend>
    <label for="itemNm">품목</label> <input id="itemNm" name="itemNm">
    <span>품목 수</span> <output id="itemCnt" aria-label="품목 수">1</output>
    <label for="splAmt">공급가액</label> <input id="splAmt" name="splAmt" inputmode="numeric">
    <label for="taxAmt">세액</label> <input id="taxAmt" name="taxAmt" inputmode="numeric">
    <span>합계금액</span> <output id="totAmt" aria-label="합계금액">0</output>
  </fieldset>
  <label for="wrtDt">작성일자</label> <input id="wrtDt" name="wrtDt" value="${today()}">
  <label for="rmk">비고</label> <input id="rmk" name="rmk">
  <label for="rcpt">영수/청구</label> <select id="rcpt" name="rcpt"><option value="영수" selected>영수</option><option value="청구">청구</option></select>
  <input type="hidden" name="splrBizNo" value="${esc(k.supplier.bizNo)}">
  <button type="submit" id="btnIssue">발급하기</button>
</form>
<a id="lnkLookup" href="/invoice/list" target="_blank">발급목록조회</a>
<script>
  const $ = (id) => document.getElementById(id);
  const digits = (s) => s.replace(/\\D/g, '');
  const total = () => { $('totAmt').value = Number(digits($('splAmt').value) || 0) + Number(digits($('taxAmt').value) || 0); };
  const REFILL = ${JSON.stringify(k.refillEmail).replace(/</g, '\\u003c')};
  ${k.block === 'dialog' ? `setTimeout(() => alert(${JSON.stringify(FIXTURE_BLOCK_TEXT)}), 0);` : ''}
  $('dmnrEmail').addEventListener('input', () => {
    if (REFILL && !$('dmnrEmail').value) setTimeout(() => { $('dmnrEmail').value = REFILL; }, 60);
  });
  $('splAmt').addEventListener('input', total);
  $('taxAmt').addEventListener('input', total);
  $('btnCpCheck').addEventListener('click', async () => {
    const r = await fetch('/api/cp?bizNo=' + encodeURIComponent(digits($('dmnrBizNo').value))).then((x) => x.json());
    $('dmnrName').value = r.name || '';
  });
  // 시험 손잡이: 게이트 뒤 화면 값 바꾸기, 안내 레이어 띄우기
  setInterval(async () => {
    const k = await fetch('/api/knob').then((x) => x.json()).catch(() => null);
    const m = k && k.mutate;
    if (m && $(m.field) && $(m.field).value !== m.value) { $(m.field).value = m.value; total(); }
    if (k && k.notice && !$('layer-notice')) {
      const d = document.createElement('div');
      d.id = 'layer-notice';
      d.setAttribute('role', 'alert');
      d.textContent = k.notice;
      document.body.append(d);
    }
  }, 150);
</script>`);
}

function table(id: string, caption: string, rows: Array<Record<string, string>>): string {
  const body = rows
    .map((r) => `<tr data-row="1">${Object.entries(r).map(([k, v]) => `<td data-k="${esc(k)}">${esc(v)}</td>`).join('')}</tr>`)
    .join('');
  return page(caption, `<table id="${id}" aria-label="${esc(caption)}" data-count="${rows.length}"><tbody>${body}</tbody></table>`);
}

export async function startH01Fixture(opts: { registry: Registry; supplier: { bizNo: string; name: string } }): Promise<H01Fixture> {
  const issued: IssuedInvoice[] = [];
  let posts = 0;
  let seq = 123;
  const knobs: H01Knobs = { supplier: opts.supplier, mutate: null, reflectDelayMs: 0, dropIssue: false, failIssue: false, lookupDelayMs: 0, refillEmail: null, block: null, extraAuth: 0, captcha: 0, status: null, notice: null };
  const requests: H01Fixture['requests'] = [];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    if (url.pathname !== '/favicon.ico') requests.push({ at: Date.now(), method: req.method ?? '', path: url.pathname });
    let body = '';
    req.on('data', (c: Buffer) => (body += c.toString('utf8')));
    req.on('end', () => {
      const send = (type: string, s: string, status = 200) => {
        res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' });
        res.end(s);
      };
      const html = (s: string) => send('text/html; charset=utf-8', s);
      const json = (v: unknown) => send('application/json', JSON.stringify(v));
      const redirect = (to: string) => {
        res.writeHead(302, { location: to, 'cache-control': 'no-store' });
        res.end();
      };
      if (knobs.status?.path === url.pathname) return send('text/html; charset=utf-8', page('오류', '<p>요청을 처리할 수 없습니다.</p>'), knobs.status.code);
      if (url.pathname === '/notice/blocked') return html(page('이용 제한 안내', `<h1>이용 제한 안내</h1><p>${esc(FIXTURE_BLOCK_TEXT)}</p>`));
      if (url.pathname === '/auth/extra') return html(page('추가 인증', '<h1>추가 인증</h1><p>본인 확인을 위해 추가 인증이 필요합니다.</p>'));
      if (url.pathname === '/auth/captcha') return html(page('자동입력방지', '<h1>자동입력방지</h1><p>화면의 문자를 입력해 주세요.</p>'));
      if (url.pathname === '/invoice/issue' && req.method === 'GET') {
        if (knobs.block === 'page') return redirect('/notice/blocked');
        if (knobs.extraAuth > 0) {
          knobs.extraAuth--;
          return redirect('/auth/extra');
        }
        if (knobs.captcha > 0) {
          knobs.captcha--;
          return redirect('/auth/captcha');
        }
        return html(form(knobs));
      }
      if (url.pathname === '/invoice/issue' && req.method === 'POST') {
        posts++;
        const f = new URLSearchParams(body);
        if (knobs.failIssue) return html(page('발급 오류', `<p id="issue-error" role="alert">발급할 수 없습니다. 입력 값을 확인하세요.</p>`));
        const d = new Date();
        const approvalNo = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-41000012-${pad(seq++, 8)}`;
        const inv: IssuedInvoice = {
          approvalNo,
          supplierBizNo: f.get('splrBizNo') ?? '',
          counterpartBizNo: f.get('dmnrBizNo') ?? '',
          counterpartName: f.get('dmnrName') ?? '',
          counterpartEmail: f.get('dmnrEmail') ?? '',
          itemName: f.get('itemNm') ?? '',
          supplyAmount: (f.get('splAmt') ?? '').replace(/\D/g, ''),
          taxAmount: (f.get('taxAmt') ?? '').replace(/\D/g, ''),
          issueDate: f.get('wrtDt') ?? '',
        };
        if (!knobs.dropIssue) setTimeout(() => issued.push(inv), knobs.reflectDelayMs);
        return html(page('발급 완료', `<p id="issue-done" role="status">발급되었습니다.</p>`));
      }
      if (url.pathname === '/invoice/list') {
        if (knobs.block === 'lookup') return redirect('/notice/blocked');
        const bizNo = url.searchParams.get('bizNo') ?? '';
        const date = url.searchParams.get('date') ?? '';
        const rows = issued
          .filter((i) => i.counterpartBizNo === bizNo && i.issueDate === date)
          .map((i) => ({ approvalNo: i.approvalNo, counterpartBizNo: i.counterpartBizNo, issueDate: i.issueDate, supplyAmount: i.supplyAmount, taxAmount: i.taxAmount }));
        return void setTimeout(() => html(table('invoice-list', '발급목록', rows)), knobs.lookupDelayMs);
      }
      if (url.pathname === '/mail/list') {
        const no = url.searchParams.get('approvalNo') ?? '';
        const rows = issued.filter((i) => i.approvalNo === no && i.counterpartEmail).map((i) => ({ approvalNo: i.approvalNo, status: '전송완료' }));
        return html(table('mail-list', '메일발송목록', rows));
      }
      if (url.pathname === '/api/cp') return json({ name: opts.registry[url.searchParams.get('bizNo') ?? ''] ?? '' });
      if (url.pathname === '/api/knob') return json({ mutate: knobs.mutate, notice: knobs.notice });
      send('text/plain', 'not found', 404);
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;
  return {
    origin: `http://127.0.0.1:${port}`,
    issued,
    posts: () => posts,
    requests,
    knobs,
    close: () =>
      new Promise<void>((r) => {
        server.closeAllConnections();
        server.close(() => r());
      }),
  };
}
