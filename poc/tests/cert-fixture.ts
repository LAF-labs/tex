// 가짜 홈택스 민원증명 페이지(127.0.0.1, 시험 전용). H-03 사업자등록증명·H-04 납세증명서·H-08 부가가치세 과세표준증명·H-09 표준재무제표증명 양식과
// 민원신청 처리결과 조회(hometax.cert.issued_list)를 흉내 낸다. 실제 홈택스 화면·보안 모듈·전자서명은 흉내 내지 않는다. 모든 값은 가상이다.
// - 칸 id·접근성 이름은 제품 패키지(packages/engine/playbooks/hometax.cert.*)의 셀렉터와 같게 둔다(2026-11-10 캡처 값). 그래서 fixture 변형 패키지는
//   origin·id 접두만 바꾸고 셀렉터는 그대로 쓴다(tests/cert-fixture-package.ts).
// - 실제 화면처럼 select의 value는 코드(선택지 이름과 다르다)이고, 발급유형·주민번호 공개 여부는 라디오 묶음이다.
// - 처리결과 조회는 카드 목록(li 안 dt·dd 쌍)과 「총 N건」 건수 문구다. 조회 단추를 눌러야 그린다.
import http from 'node:http';
import type { AddressInfo } from 'node:net';

/** 메뉴 코드(tm3lIdx) → 서류. H-09 코드는 캡처에 없어 가짜 값이다(제품 패키지는 메뉴 클릭으로 들어간다). */
export const CERT_MENU = {
  '4315010800': 'H-03',
  '4315010300': 'H-04',
  '4315010500': 'H-08',
  '4315019900': 'H-09',
} as const;
type Doc = (typeof CERT_MENU)[keyof typeof CERT_MENU];
const LOOKUP_MENU = '4315050000';

/** 서류 이름(양식의 민원명 칸·처리결과의 민원명). */
export const CERT_DOC_NAME: Readonly<Record<Doc, string>> = {
  'H-03': '사업자등록증명',
  'H-04': '납세증명서',
  'H-08': '부가가치세 과세표준증명',
  'H-09': '표준재무제표증명',
};
const FORM_TITLE: Readonly<Record<Doc, string>> = {
  'H-03': '사업자등록증명 발급 신청',
  'H-04': '납세증명서(국세완납증명) 신청',
  'H-08': '부가가치세 과세표준증명원 접수',
  'H-09': '표준재무제표증명',
};

export interface CertRecord {
  doc: Doc;
  docName: string;
  receiptNo: string;
  /** 접수 때 고른 값(시험 단언용, 가상 값). */
  values: Record<string, string>;
}

export interface CertKnobs {
  /** 양식 대신 「개인사업자는 이용할 수 없습니다」 알림을 띄운다(H-04 사업자 인증서 로그인). */
  personal: boolean;
  /** 접수를 거절하고 오류 문구를 보인다(명시적 실패 신호). */
  failIssue: boolean;
  /** 처리결과 조회 화면이 열리지 않는다(조회 실패: verify unknown → in_doubt). */
  lookupDown: boolean;
  /** 양식의 신청인(로그인한 사업자). */
  supplier: { bizNo: string; name: string };
}

export interface CertFixture {
  origin: string;
  records: CertRecord[];
  /** 받은 접수 POST 수. */
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
/** select: value는 코드, 이름은 선택지. 첫 선택지는 「선택」(값 없음). */
const select = (id: string | null, label: string, name: string, options: readonly string[], extra = '') =>
  `<label${id ? ` for="${id}"` : ''}>${esc(label)}</label><select ${id ? `id="${id}" ` : ''}name="${name}" aria-label="${esc(label)}" ${extra}><option value="">선택</option>${options.map((o, i) => `<option value="${String(i + 1).padStart(2, '0')}">${esc(o)}</option>`).join('')}</select>`;
/** 라디오 묶음(role radiogroup). 처음 고른 것이 checked다. */
const radios = (id: string, label: string, name: string, options: readonly string[], checked: string) =>
  `<div id="${id}" role="radiogroup" aria-label="${esc(label)}">${options.map((o, i) => `<input type="radio" id="${id}_input_${i}" name="${name}" value="${i}"${o === checked ? ' checked' : ''}><label for="${id}_input_${i}">${esc(o)}</label>`).join('')}</div>`;
const shown = (label: string, value: string, id?: string) => `<label>${esc(label)} <input type="text" readonly ${id ? `id="${id}" ` : ''}aria-label="${esc(label)}" value="${esc(value)}"></label>`;
const page = (body: string) => `<!doctype html><html lang="ko"><head><meta charset="utf-8"><title>국세청 홈택스</title></head><body><div id="mf_wrap"><a id="mf_wfHeader_hdGroup001" href="/">국세청 홈택스</a><main aria-label="홈택스"><a href="/">홈</a>${body}</main></div></body></html>`;

const ALERT = '<div role="dialog" aria-label="알림" class="w2window w2popup_window msg">레이어 팝업 레이어팝업시작 알림 해당 화면은 개인사업자는 이용할 수 없습니다. 레이어팝업끝</div>';

function certForm(doc: Doc, k: CertKnobs): string {
  if (k.personal) return page(ALERT);
  const title = FORM_TITLE[doc];
  const docName = CERT_DOC_NAME[doc];
  if (doc === 'H-04') {
    // 납세증명서 양식: 제품 패키지가 역할·이름만 쓴다(캡처 전)
    return page(`<form aria-label="${esc(title)}" method="post" action="/cert/issue"><input type="hidden" name="doc" value="H-04">
      ${shown('사업자등록번호', fmtBiz(k.supplier.bizNo))}${shown('민원명', docName)}${shown('상호', k.supplier.name)}
      ${select(null, '사용용도', 'purpose', H04_PURPOSES)}${select(null, '제출처', 'submitTo', H04_SUBMIT_TO)}
      <label>주민등록번호 공개여부 <select name="rrn" aria-label="주민등록번호 공개여부"><option value="N">공개안함</option><option value="Y">공개</option></select></label>
      <label>발급부수 <input type="number" name="copies" aria-label="발급부수" value="1"></label>
      <button type="submit">신청하기</button></form>`);
  }
  const extra: string[] = [];
  if (doc === 'H-08') {
    extra.push(
      select('mf_txppWframe_sbx_txnrmStrtYear', '과세기간', 'startYear', YEARS),
      select('mf_txppWframe_sbx_strtHt', '과세기간 시작년도 분기', 'startHalf', ['1기', '2기']),
      select('mf_txppWframe_sbx_txnrmEndYear', '과세기간 종료년도', 'endYear', YEARS),
      select('mf_txppWframe_sbx_endHt', '과세기간 종료년도 분기', 'endHalf', ['1기', '2기']),
      select('mf_txppWframe_sbx_bmanOfbDt', '발급희망개업일자', 'openDate', ['2020-03-02']),
    );
  }
  if (doc === 'H-09') extra.push(select(null, '귀속연도', 'fiscalYear', ['2025', '2024', '2023']));
  const submit = doc === 'H-03' ? '<button type="submit" id="mf_txppWframe_btn_wrtCmpl">작성완료</button>' : doc === 'H-08' ? '<button type="submit" id="mf_txppWframe_btn_apln">신청하기</button>' : '<button type="submit">신청하기</button>';
  // 수량은 수령방법을 고른 뒤에 켜진다(캡처)
  return page(`<form id="mf_txppWframe" aria-label="${esc(title)}" method="post" action="/cert/issue"><input type="hidden" name="doc" value="${doc}">
    ${shown('민원명', docName)}${shown('사업자등록번호', fmtBiz(k.supplier.bizNo))}${shown('상호', k.supplier.name)}
    ${radios('mf_txppWframe_rad_englCvaAplnYn', '발급유형', 'lang', ['한글', '영문증명'], '한글')}
    ${select('mf_txppWframe_sbx_cvaDcumUseUsgCd', '사용용도', 'purpose', PURPOSES)}
    ${select('mf_txppWframe_sbx_cvaDcumSbmsOrgnClCd', '제출처', 'submitTo', SUBMIT_TO)}
    ${radios('mf_txppWframe_pfm_UTECAAA0Z002_rad_cvaAplnRecptResNoOpYn', '주민등록번호 공개여부', 'rrn', ['공개', '비공개'], '')}
    ${select('mf_txppWframe_pfm_UTECAAA0Z002_sbx_cvaAplnRecptMthd', '수령방법', 'receive', ['인터넷발급(프린터출력)', '우편'], 'onchange="document.getElementById(\'mf_txppWframe_pfm_UTECAAA0Z002_sbx_cvaAplnRecptIsnHopeQty\').disabled = !this.value"')}
    ${select('mf_txppWframe_pfm_UTECAAA0Z002_sbx_cvaAplnRecptIsnHopeQty', '발급희망수량', 'copies', ['1매', '2매'], 'disabled')}
    ${extra.join('')}${submit}</form>`);
}

function home(): string {
  return page(`<nav><span role="link" tabindex="0">증명·등록·신청</span> <span role="link" tabindex="0">민원증명(발급)</span>
    <a href="/websquare/websquare.html?w2xPath=/ui/pp/index_pp.xml&tmIdx=43&tm2lIdx=4315010000&tm3lIdx=4315019900">${CERT_DOC_NAME['H-09']}</a></nav>`);
}

function lookupPage(records: readonly CertRecord[]): string {
  const data = JSON.stringify(records.map((r) => ({ n: r.docName, no: r.receiptNo }))).replace(/</g, '\\u003c');
  return page(`<form id="mf_txppWframe" aria-label="민원신청 처리결과 조회" onsubmit="return false">
    <label>민원명 <input type="search" id="mf_txppWframe_ibx_cvaKndNm" aria-label="민원명"></label>
    <button type="button">1주일</button><button type="button" id="mf_txppWframe_btn_search">조회</button>
    <div role="status" aria-label="조회 건수" id="cnt">총 0건</div>
    <ul id="mf_txppWframe_gen_cvaInf" aria-label="처리결과"></ul></form>
    <script>
    const DATA = ${data};
    document.getElementById('mf_txppWframe_btn_search').addEventListener('click', () => {
      const key = document.getElementById('mf_txppWframe_ibx_cvaKndNm').value.trim();
      const hit = DATA.filter((r) => r.n.includes(key));
      const ul = document.getElementById('mf_txppWframe_gen_cvaInf');
      ul.innerHTML = '';
      for (const r of hit) {
        const li = document.createElement('li');
        const dl = document.createElement('dl');
        for (const [k, v] of [['민원명', r.n], ['접수번호', r.no], ['처리상태', '처리완료'], ['접수방법', '인터넷'], ['접수일시', '2026-11-11']]) {
          const dt = document.createElement('dt'); dt.textContent = k;
          const dd = document.createElement('dd'); dd.textContent = v;
          dl.append(dt, dd);
        }
        li.append(dl);
        ul.append(li);
      }
      document.getElementById('cnt').textContent = '총 ' + hit.length + '건';
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
      // 메뉴 코드가 없으면 홈택스 메인(실화면과 같은 주소 /websquare/websquare.html?w2xPath=/ui/pp/index_pp.xml)
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
        // H-04는 결과 영역의 [출력] → 증명서 화면(패키지 s31·s32). 나머지는 접수 완료 안내만.
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
