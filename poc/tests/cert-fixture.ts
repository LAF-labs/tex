import http from 'node:http';
import type { AddressInfo } from 'node:net';

export const CERT_MENU = {
  '4315010800': 'H-03',
  '4315010300': 'H-04',
  '4315010500': 'H-08',
  '4315011800': 'H-09',
} as const;
type Doc = (typeof CERT_MENU)[keyof typeof CERT_MENU];
const LOOKUP_MENU = '4315050000';

export const CERT_DOC_NAME: Readonly<Record<Doc, string>> = {
  'H-03': '사업자등록증명',
  'H-04': '납세증명서',
  'H-08': '부가가치세 과세표준증명',
  'H-09': '표준재무제표증명(개인/법인)',
};
const FORM_TITLE: Readonly<Record<Doc, string>> = {
  'H-03': '사업자등록증명 발급 신청',
  'H-04': '납세증명서(국세완납증명) 신청',
  'H-08': '부가가치세 과세표준증명원 접수',
  'H-09': '표준재무제표증명(개인/법인) 신청',
};

export interface CertRecord {
  doc: Doc;
  docName: string;
  receiptNo: string;
  values: Record<string, string>;
}

export interface CertKnobs {
  personal: boolean;
  failIssue: boolean;
  lookupDown: boolean;
  supplier: { bizNo: string; name: string };
}

export interface CertFixture {
  origin: string;
  records: CertRecord[];
  posts: () => number;
  knobs: CertKnobs;
  close(): Promise<void>;
}

const PURPOSES = ['입찰, 계약용', '수금용', '관공서제출용', '대출용', '여권또는비자신청용', '건강보험·국민연금공단제출용', '금융기관제출용', '신용카드발급용', '기타'];
const SUBMIT_TO = ['금융기관', '관공서', '조합/협회', '거래처', '학교', '외교부/재외공관/재외동포청', '기타'];
const H04_PURPOSES = ['대금수령', '관공서 제출', '금융기관 제출', '입찰 참가', '해외이주', '기타'];
const H04_SUBMIT_TO = ['관공서', '금융기관', '공공기관', '기타'];
const YEARS = ['2026', '2025', '2024', '2023'];

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const fmtBiz = (b: string) => `${b.slice(0, 3)}-${b.slice(3, 5)}-${b.slice(5)}`;
const select = (id: string | null, label: string, name: string, options: readonly string[], extra = '') =>
  `<label${id ? ` for="${id}"` : ''}>${esc(label)}</label><select ${id ? `id="${id}" ` : ''}name="${name}" aria-label="${esc(label)}" ${extra}><option value="">선택</option>${options.map((o, i) => `<option value="${String(i + 1).padStart(2, '0')}">${esc(o)}</option>`).join('')}</select>`;
const radios = (id: string, label: string, name: string, options: readonly string[], checked: string) =>
  `<label for="${id}_input_0">${esc(label)}</label><div id="${id}" title="${esc(label)}">${options.map((o, i) => `<input type="radio" id="${id}_input_${i}" name="${name}" value="${i}" title="${esc(o)}"${o === checked ? ' checked' : ''}><label for="${id}_input_${i}">${esc(o)}</label>`).join('')}</div>`;
const disp = (id: string, value: string) => `<p id="${id}">${esc(value)}</p>`;
const shown = (label: string, value: string, id?: string) => `<label>${esc(label)} <input type="text" readonly ${id ? `id="${id}" ` : ''}aria-label="${esc(label)}" value="${esc(value)}"></label>`;
const page = (body: string, crumb = '') => `<!doctype html><html lang="ko"><head><meta charset="utf-8"><title>국세청 홈택스</title></head><body><div id="mf_wrap"><a id="mf_wfHeader_hdGroup001" href="/">국세청 홈택스</a>${crumb ? `<strong id="mf_wfHeader_spn_third">${esc(crumb)}</strong>` : ''}<main aria-label="홈택스"><a href="/">홈</a>${body}</main></div></body></html>`;

const ALERT = '<div role="dialog" aria-label="알림" class="w2window w2popup_window msg">레이어 팝업 레이어팝업시작 알림 해당 화면은 개인사업자는 이용할 수 없습니다. 레이어팝업끝</div>';

function certForm(doc: Doc, k: CertKnobs): string {
  if (k.personal) return page(ALERT);
  const title = FORM_TITLE[doc];
  const docName = CERT_DOC_NAME[doc];
  if (doc === 'H-04') {
    return page(`<div id="mf_txppWframe"><h2>${esc(title)}</h2><form aria-label="${esc(title)}" method="post" action="/cert/issue"><input type="hidden" name="doc" value="H-04">
      ${shown('사업자등록번호', fmtBiz(k.supplier.bizNo))}${shown('민원명', docName)}${shown('상호', k.supplier.name)}
      ${select(null, '사용용도', 'purpose', H04_PURPOSES)}${select(null, '제출처', 'submitTo', H04_SUBMIT_TO)}
      <label>주민등록번호 공개여부 <select name="rrn" aria-label="주민등록번호 공개여부"><option value="N">공개안함</option><option value="Y">공개</option></select></label>
      <label>발급부수 <input type="number" name="copies" aria-label="발급부수" value="1"></label>
      <button type="submit">신청하기</button></form></div>`);
  }
  const extra: string[] = [];
  if (doc === 'H-08') {
    extra.push(
      select('mf_txppWframe_sbx_txnrmStrtYear', '과세기간 시작년도', 'startYear', YEARS),
      select('mf_txppWframe_sbx_strtHt', '과세기간 시작년도 분기', 'startHalf', ['1기', '2기']),
      select('mf_txppWframe_sbx_txnrmEndYear', '과세기간 종료년도', 'endYear', YEARS),
      select('mf_txppWframe_sbx_endHt', '과세기간 종료년도 분기', 'endHalf', ['1기', '2기']),
      select('mf_txppWframe_sbx_bmanOfbDt', '발급희망개업일자', 'openDate', ['2020-03-02']),
    );
  }
  if (doc === 'H-09') {
    extra.push(
      `<label for="mf_txppWframe_ibx_txyr">과세년도</label><input type="text" id="mf_txppWframe_ibx_txyr" name="fiscalYear" aria-label="과세년도" placeholder="YYYY">`,
      `<select id="mf_txppWframe_selectbox1" name="openDate" title="개업일자" hidden><option value="">-선택-</option></select>`,
    );
  }
  const layer = '<div id="mf_txppWframe_UTECAAA0A016" class="w2window w2popup_window" hidden><p>' + esc(CERT_DOC_NAME[doc]) + '작성이 완료되었어요. 신청하시겠습니까?</p>'
    + '<button type="button" id="mf_txppWframe_UTECAAA0A016_wframe_btn_cncl" onclick="this.parentElement.hidden = true">취소</button>'
    + '<button type="submit" id="mf_txppWframe_UTECAAA0A016_wframe_btn_sbms">신청하기</button></div>';
  const submit = doc === 'H-03' || doc === 'H-09'
    ? '<button type="button" id="mf_txppWframe_btn_wrtCmpl" onclick="document.getElementById(\'mf_txppWframe_UTECAAA0A016\').hidden = false">작성완료</button>' + layer
    : doc === 'H-08' ? '<button type="submit" id="mf_txppWframe_btn_apln">신청하기</button>' : '<button type="submit">신청하기</button>';
  return page(`<div id="mf_txppWframe"><h2>${esc(title)}</h2><form aria-label="${esc(title)}" method="post" action="/cert/issue"><input type="hidden" name="doc" value="${doc}">
    ${disp('mf_txppWframe_pfm_UTECAAA0Z001_tbx_cvaAplnBscBsno', fmtBiz(k.supplier.bizNo))}${disp('mf_txppWframe_pfm_UTECAAA0Z001_tbx_cvaAplnBscTnm', k.supplier.name)}
    ${radios('mf_txppWframe_rad_englCvaAplnYn', '발급유형', 'lang', ['한글증명', '영문증명'], '한글증명')}
    ${select('mf_txppWframe_sbx_cvaDcumUseUsgCd', '사용용도', 'purpose', PURPOSES)}
    ${select('mf_txppWframe_sbx_cvaDcumSbmsOrgnClCd', '제출처', 'submitTo', SUBMIT_TO)}
    ${radios('mf_txppWframe_pfm_UTECAAA0Z002_rad_cvaAplnRecptResNoOpYn', '주민등록번호 공개여부', 'rrn', ['공개', '비공개'], '')}
    ${select('mf_txppWframe_pfm_UTECAAA0Z002_sbx_cvaAplnRecptMthd', '수령방법', 'receive', ['인터넷발급(프린터출력)', '우편'], 'onchange="document.getElementById(\'mf_txppWframe_pfm_UTECAAA0Z002_sbx_cvaAplnRecptIsnHopeQty\').disabled = !this.value"')}
    ${select('mf_txppWframe_pfm_UTECAAA0Z002_sbx_cvaAplnRecptIsnHopeQty', '발급희망수량', 'copies', ['1매', '2매'], 'disabled')}
    ${extra.join('')}${submit}</form></div>`, docName);
}

function home(): string {
  return page(`<nav><span role="link" tabindex="0">증명·등록·신청</span> <span role="link" tabindex="0">민원증명(발급)</span>
    <a href="/websquare/websquare.html?w2xPath=/ui/pp/index_pp.xml&tmIdx=43&tm2lIdx=4315010000&tm3lIdx=4315011800">${CERT_DOC_NAME['H-09']}</a></nav>`);
}

function lookupPage(records: readonly CertRecord[]): string {
  const data = JSON.stringify(records.map((r) => ({ n: r.docName, no: r.receiptNo }))).replace(/</g, '\\u003c');
  return page(`<div id="mf_txppWframe"><h2>민원신청 처리결과 조회</h2>
    <label for="mf_txppWframe_ibx_cvaKndNm">민원명</label> <input type="text" id="mf_txppWframe_ibx_cvaKndNm" title="민원명">
    <input type="button" id="wq_uuid_835_btn_useWeek1" value="1주일" title="선택됨"><input type="button" id="wq_uuid_835_btn_useMonth1" value="1개월">
    <input type="button" id="mf_txppWframe_btn_search" value="조회">
    <p><span>총</span> <strong id="mf_txppWframe_tbx_totalCnt">0</strong><span>건</span><span>의 검색 결과가 있습니다.</span></p>
    <div id="mf_txppWframe_gen_cvaInf"></div></div>
    <script>
    const DATA = ${data};
    document.getElementById('mf_txppWframe_btn_search').addEventListener('click', () => {
      const key = document.getElementById('mf_txppWframe_ibx_cvaKndNm').value.trim();
      const hit = DATA.filter((r) => r.n.includes(key));
      const gen = document.getElementById('mf_txppWframe_gen_cvaInf');
      gen.innerHTML = '';
      hit.forEach((r, i) => {
        const id = (k) => 'mf_txppWframe_gen_cvaInf_' + i + '_' + k;
        const card = document.createElement('div');
        card.id = 'mf_txppWframe_gen_cvaInf_' + i;
        const cell = (tag, k, v) => { const e = document.createElement(tag); e.id = id(k); e.textContent = v; card.append(e); };
        cell('span', 'spa_rowNum', String(i + 1));
        cell('strong', 'tbx_cvaKndNm', r.n);
        cell('a', 'tbx_rcatNo', r.no);
        cell('span', 'btn_cvaTrtStatCdNm', '처리완료');
        const m = document.createElement('span'); m.textContent = '접수방법 :'; card.append(m);
        cell('span', 'tbx_rcatMthd', '인터넷');
        cell('span', 'tbx_rcatDtm', '2026-11-11 18:48:25');
        gen.append(card);
      });
      document.getElementById('mf_txppWframe_tbx_totalCnt').textContent = String(hit.length);
    });
    </script>`);
}

export async function startCertFixture(o: { supplier: { bizNo: string; name: string } }): Promise<CertFixture> {
  const records: CertRecord[] = [];
  let posts = 0;
  let seq = 0;
  const knobs: CertKnobs = { personal: false, failIssue: false, lookupDown: false, supplier: o.supplier };
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const send = (code: number, html: string) => {
      res.writeHead(code, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      res.end(html);
    };
    if (req.method === 'GET' && url.pathname === '/') return send(200, home());
    if (req.method === 'GET' && url.pathname === '/websquare/websquare.html') {
      const code = url.searchParams.get('tm3lIdx') ?? '';
      if (!code) return send(200, home());
      if (code === LOOKUP_MENU) return knobs.lookupDown ? send(503, page('<p>잠시 후 다시 이용해 주세요.</p>')) : send(200, lookupPage(records));
      const doc = (CERT_MENU as Record<string, Doc | undefined>)[code];
      return doc ? send(200, certForm(doc, knobs)) : send(404, page('<p>없는 화면</p>'));
    }
    if (req.method === 'GET' && url.pathname === '/cert/doc') return send(200, page('<div role="document" aria-label="납세증명서">납세증명서(가상)</div>'));
    if (req.method === 'POST' && url.pathname === '/cert/issue') {
      let body = '';
      req.on('data', (c: Buffer) => (body += c.toString('utf8')));
      req.on('end', () => {
        posts++;
        const f = new URLSearchParams(body);
        const doc = f.get('doc') as Doc | null;
        if (!doc || !(doc in CERT_DOC_NAME)) return send(400, page('<p>잘못된 요청</p>'));
        if (knobs.failIssue) return send(200, page('<div id="errorDialog" role="alert">발급에 실패했습니다. 잠시 후 다시 신청해 주세요.</div>'));
        const receiptNo = `2026-${String(++seq).padStart(6, '0')}`;
        records.push({ doc, docName: CERT_DOC_NAME[doc], receiptNo, values: Object.fromEntries([...f].filter(([k]) => k !== 'doc')) });
        if (doc === 'H-04') return send(200, page(`<section aria-label="민원신청 결과"><p>신청이 접수되었습니다.</p><button type="button" onclick="location.href='/cert/doc'">출력</button></section>`));
        return send(200, page('<p>신청이 접수되었습니다.</p>'));
      });
      return;
    }
    send(404, page('<p>없는 화면</p>'));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;
  return {
    origin: `http://127.0.0.1:${port}`,
    records,
    posts: () => posts,
    knobs,
    close: () => new Promise<void>((r) => {
      server.close(() => r());
      server.closeAllConnections();
    }),
  };
}
