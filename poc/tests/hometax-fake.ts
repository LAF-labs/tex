// 가짜 홈택스(H-01 실화면 흉내, 2026-11-11 부장 캡처 기준). 시험 전용(ADR-039): 실제 홈택스에 접속하지 않고, 값은 전부 가짜다.
// 근거: ~/sax-capture/hometax-20261111/notes.md·issue-1000/log.md(레포 밖, 읽기만). 캡처에 없는 동작은 "가정"으로 표시했다(PR 본문 가정 목록).
//
// 흉내 내는 것(실화면과 같게):
// - 주소 꼴: /websquare/websquare.html?w2xPath=/ui/pp/index_pp.xml&tmIdx=46&tm2lIdx=…&tm3lIdx=<메뉴> → 건별발급은 &menuCd=UTEETBAA01로 바뀜.
//   로그인 화면 &menuCd=index3, 로그인 뒤 메인 &menuCd=index4.
// - 화면은 로드 뒤 renderDelayMs(실화면 약 5~8초)가 지나야 그려진다. 그 전에는 #mf_wrap이 비어 있다.
// - id: mf_wfHeader_*, mf_txppWframe_* 그대로. 버튼은 input type=button(value가 이름).
// - 등록번호 [확인] → 조회 요청 3개 → 네이티브 alert("정상적인 사업자번호입니다.")(비정상 문구 변형은 registry 값). 정상이면 번호가 ###-##-#####로 바뀌고
//   공급받는자 칸이 편집 가능해진다(그 전에는 readonly).
// - 공급가액은 blur 뒤에야 쉼표·세액·합계가 계산된다.
// - [발급미리보기] → 같은 문서 안 창 #…isnPreviewPopup(값은 span 글) → [발급하기] → 확인 창 #…UTEETZZA89 → [확인(인증 화면 이동)] →
//   인증유형 창 #…UTEETZZA08(li 3개, 안의 button id는 매번 바뀌는 wq_uuid_NNNN) → 공동∙금융 인증: C04 요청 뒤 화면 전체를 덮는 iframe#dscert
//   (sandbox라 페이지에서 안을 못 읽는다) → 인증서 [확인] → C05 → C08 → 완료 창 #…isnCmplPopup(승인번호 8-8-8). iframe은 src를 둔 채 0x0으로 접힌다.
// - 요청은 다른 호스트(teetOrigin, 실제 teet.hometax.go.kr의 대역)로 wqAction.do?actionId=…&screenId=… XHR(POST, 가정)을 실제 순서대로 낸다.
// - 발급 목록조회(tm3lIdx=4609050100): [조회](~trigger50)를 눌러야 그리드(td data-col_id)에 행이 나온다. 메일 내역(4601030100): [조회](~trigger45).
//
// 시험 손잡이(knobs): 비정상 사업자번호 문구, 미리보기 값 바꿔치기, 인증서 창 동작(사람이 [확인]/[취소]), C05 무응답, 목록 반영 지연, 메일 발송중.
import http from 'node:http';
import type { AddressInfo } from 'node:net';

export interface FakeInvoice {
  etan: string;
  wrtDt: string;
  dmnrTxprDscmNo: string;
  tnmNm: string;
  rprsFnm: string;
  lsatNm: string;
  totaAmtStr: string;
  sumSplCftStr: string;
  sumTxamtStr: string;
  dmnrEmail: string;
  /** 목록에 보이기 시작하는 시각(ms). */
  visibleAt: number;
}

export interface FakeRequest {
  seq: number;
  at: number;
  host: string;
  method: string;
  path: string;
  actionId: string | null;
  screenId: string | null;
}

export interface FakeKnobs {
  /** 화면을 그리기까지(ms). 실화면 약 5~8초. */
  renderDelayMs: number;
  /** teet 응답 지연(ms). */
  xhrDelayMs: number;
  /** 등록번호 → [확인] 뒤 alert 문구. 없으면 "등록되어 있지 않은 사업자등록번호입니다."(가정). */
  registry: Record<string, string>;
  /** 미리보기 창의 공급받는자 등록번호를 다른 값으로 보인다(값 대조 실패 갈래). */
  tamperPreview: boolean;
  /** C05(발급 요청)에 응답하지 않는다(서명 뒤 응답 없음 갈래). 발급은 되지 않는다. */
  hangC05: boolean;
  /** 발급한 건이 목록에 보이기까지(ms). */
  listLagMs: number;
  /** 메일 발송 상태: done = 발송완료/성공, sending = 발송중/(빈칸). */
  mail: 'done' | 'sending';
  /** 칸 앞에 표 머리 글을 `<label for>`로 붙인다(접근성 이름이 title이 아니라 label 글이 된다. 2026-11-13 s12 사람 차례 가설). */
  fieldLabels: boolean;
  /** 인증서 창(dscert)의 가짜 인증서 비밀번호(시험 값). 금고가 이 값을 넣고 [확인]하면 로그인·서명이 된다. */
  certPassword: string;
  /** 인증서 목록(소유자명 Cn·용도). 0번 행이 처음에 골라져 있다(jqx DataTable selectRow 0). */
  certs: Array<{ cn: string; policy: string }>;
}

export interface HometaxFake {
  origin: string;
  teetOrigin: string;
  knobs: FakeKnobs;
  state: {
    loggedIn: boolean;
    /** 지금 단계(서버가 본 마지막 요청 기준). cert = C04 뒤 인증서 창 차례. */
    stage: 'idle' | 'cert' | 'signed' | 'issued' | 'cancelled';
    invoices: FakeInvoice[];
    /** 마지막으로 내준 화면과 그 시각. */
    lastScreen: { screen: string; at: number } | null;
    /** 인증서 창 차례가 시작된 시각(C04). */
    certAt: number;
    /** 인증서 창 [확인] 기록. typed = 창의 비밀번호 칸 값이 맞아 통과(금고 입력), human = 시험 손잡이(사람 흉내). */
    certUses: Array<{ mode: 'login' | 'sign'; how: 'typed' | 'human'; cn: string }>;
    /** 틀린 비밀번호로 [확인]한 횟수. */
    wrongPw: number;
  };
  /** 사람: 로그인을 마쳤다(로그인 화면이 메인으로 넘어간다). */
  login(): void;
  /** 사람: 인증서 창에서 비밀번호를 넣고 [확인] / [취소]. 인증서 창이 뜬 뒤에 먹는다. */
  cert(action: 'confirm' | 'cancel'): void;
  /** teet로 간 요청(순서대로). */
  requests(): FakeRequest[];
  close(): Promise<void>;
}

const W2 = '/websquare/websquare.html';
const pad = (n: number, w = 2) => String(n).padStart(w, '0');
/** KST 오늘(YYYY-MM-DD). */
export function kstToday(now = Date.now()): string {
  const d = new Date(now + 9 * 3600_000);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

type Screen = 'main' | 'login' | 'issue' | 'list' | 'mail';

/** 주소 → 화면. 로그인이 필요한 화면을 로그아웃 상태로 열면 로그인 화면(가정: 실화면 미확인). */
function screenOf(q: URLSearchParams, loggedIn: boolean): Screen {
  const menu = q.get('menuCd');
  const m3 = q.get('tm3lIdx');
  let s: Screen = 'main';
  if (menu === 'index3') s = 'login';
  else if (menu === 'UTEETBAA01' || m3 === '4601010100') s = 'issue';
  else if (menu === 'UTEETBDA01' || m3 === '4609050100') s = 'list';
  else if (menu === 'UTEETBAB16' || m3 === '4601030100') s = 'mail';
  if (!loggedIn && s !== 'main' && s !== 'login') return 'login';
  return s;
}

const SUPPLIER = { bizNo: '1234567891', name: '가나다컴퍼니', rep: '김대표', addr: '서울특별시 가짜구 가짜로 1', bizType: '서비스', item: '소프트웨어', emailId: 'tax', emailDomain: 'ganada.example' };

function page(cfg: Record<string, unknown>): string {
  return `<!doctype html><html lang="ko"><head><meta charset="utf-8"><title>국세청 홈택스</title>
<style>
body{font-family:sans-serif;margin:0}.w2window{position:absolute;top:40px;left:40px;background:#fff;border:1px solid #333;padding:8px;z-index:1000;min-width:500px}
#dscertContainer{display:none}.proc{display:none;position:fixed;top:45%;left:45%}
</style></head><body>
<div id="mf_wrap"></div>
<div id="mf_mf_wq_uuid_281_wq_processMsgComp" class="proc">처리중입니다</div>
<div id="dscertContainer"><iframe id="dscert" src="about:blank" title="" style="width:0;height:0;border:0"></iframe></div>
<div id="csContainer"><iframe id="startCs" src="about:blank" style="width:0;height:0;border:0"></iframe></div>
<iframe id="mf_txppIframe" src="about:blank" style="width:0;height:0;border:0"></iframe>
<script>const C = ${JSON.stringify(cfg)};</script>
<script>${CLIENT}</script></body></html>`;
}

// ---- 브라우저 쪽 스크립트(한 파일에 화면 넷) ----
const CLIENT = String.raw`
(() => {
  const P = 'mf_txppWframe_';
  const $ = (id) => document.getElementById(id);
  const wrap = $('mf_wrap');
  const proc = $('mf_mf_wq_uuid_281_wq_processMsgComp');
  let busy = 0;
  const uuid = () => 'wq_uuid_' + (1000 + Math.floor(Math.random() * 9000));
  function call(path, body) {
    busy++; proc.style.display = 'block';
    return new Promise((res) => {
      const x = new XMLHttpRequest();
      x.open('POST', C.teet + path);
      x.setRequestHeader('content-type', 'application/json; charset=UTF-8');
      x.onload = () => { busy--; if (!busy) proc.style.display = 'none'; try { res(JSON.parse(x.responseText)); } catch { res({}); } };
      x.onerror = () => { busy--; if (!busy) proc.style.display = 'none'; res({ error: true }); };
      x.send(JSON.stringify(body || {}));
    });
  }
  const perm = (screenId) => call('/permission.do?screenId=' + screenId, {});
  const act = (actionId, screenId, body, popup) => call('/wqAction.do?actionId=' + actionId + '&screenId=' + screenId + '&popupYn=' + (popup ? 'true' : 'false') + '&realScreenId=', body);
  const comma = (n) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const digits = (s) => String(s || '').replace(/[^0-9]/g, '');
  const bizFmt = (d) => d.length === 10 ? d.slice(0, 3) + '-' + d.slice(3, 5) + '-' + d.slice(5) : d;
  const menuUrl = (extra) => location.pathname + '?w2xPath=/ui/pp/index_pp.xml' + extra;

  function openCertWin(mode) {
    const box = $('dscertContainer');
    const f = $('dscert');
    box.style.cssText = 'display:block;position:fixed;z-index:100010;top:0;left:0;width:100%;height:100%';
    f.setAttribute('sandbox', 'allow-scripts allow-forms');
    f.style.cssText = 'width:100%;height:100%;border:0;background:#fff';
    f.src = '/MagicLine4XML/ML4Web/Child.html?lgUrl=' + location.host + '&mode=' + mode + '&random=' + Math.random().toString(36).slice(2);
  }
  function header() {
    return '<header id="mf_wfHeader_hdGroup000"><a id="mf_wfHeader_hdGroup001" title="국세청 홈택스" href="' + menuUrl('') + '">국세청 홈택스 HomeTax</a> ' +
      '<a id="mf_wfHeader_group1502" href="#">회원정보조회</a> ' +
      '<a id="mf_wfHeader_group1503" href="' + (C.loggedIn ? '#' : menuUrl('&menuCd=index3')) + '" title="' + (C.loggedIn ? '로그아웃' : '로그인') + '">' + (C.loggedIn ? '로그아웃' : '로그인') + '</a></header>';
  }

  const screens = {
    main() {
      if (C.loggedIn && !/menuCd=index4/.test(location.search)) history.replaceState(null, '', menuUrl('&menuCd=index4'));
      document.title = '국세청 홈택스 - 메인';
      wrap.innerHTML = header() + '<div id="mf_txppWframe"><p>국세청 홈택스에 오신 것을 환영합니다.</p></div>';
    },
    login() {
      if (!/menuCd=index3/.test(location.search)) history.replaceState(null, '', menuUrl('&menuCd=index3'));
      document.title = '국세청 홈택스 - 로그인';
      const tab = (id, t) => '<a id="' + P + id + '" role="button" href="#">' + t + '</a> ';
      wrap.innerHTML = header() + '<div id="mf_txppWframe"><div>' + tab('anchor13', '공동·금융 인증') + tab('anchor1412', '사업자용 간편인증 (민간인증서)') + tab('anchor14', '개인용 간편인증 (민간인증서)') +
        tab('anchor15', '아이디 로그인') + tab('anchor17', '생체(얼굴·지문) 인증') + tab('anchor19', '비회원 로그인') + '</div>' +
        '<p>공동·금융인증서로 로그인하려면 해당 인증서가 홈택스에 사전등록되어 있어야 합니다</p>' +
        '<a id="' + P + 'anchor22" role="button" href="#" title="공동·금융인증서 새창열림">공동·금융인증서</a> <a id="' + P + 'anchor50" role="button" href="#">사업자용 간편인증(민간인증서)</a></div>';
      // [공동·금융인증서] → 인증서 창(dscert, 로그인 모드). 비밀번호가 맞으면 서버가 로그인 상태가 되고 메인으로 넘어간다.
      // 사람이 다른 길로 로그인을 마쳐도(시험: fx.login()) 메인으로 넘어간다. 공동인증서 로그인 실화면은 캡처 전이라 창 모양은 발급 서명 창과 같다고 둔다(가정).
      $(P + 'anchor22').onclick = (e) => { e.preventDefault(); openCertWin('login'); };
      window.addEventListener('message', (e) => {
        if (e.source !== $('dscert').contentWindow || !e.data || e.data.ml4 !== 'login') return;
        $('dscert').style.cssText = 'width:0;height:0;border:0'; $('dscertContainer').style.cssText = 'display:none';
      });
      const t = setInterval(() => fetch('/_fx/state').then((r) => r.json()).then((s) => { if (s.loggedIn) { clearInterval(t); location.href = menuUrl('&menuCd=index4'); } }), 200);
    },
    issue() { issueScreen(); },
    list() { listScreen(); },
    mail() { mailScreen(); },
  };

  // ---------------- 건별발급 UTEETBAA01 ----------------
  function issueScreen() {
    history.replaceState(null, '', menuUrl('&menuCd=UTEETBAA01'));
    document.title = '국세청 홈택스 - 계산서ㆍ영수증ㆍ카드 > 전자(세금)계산서 발급 > 전자(세금)계산서 건별발급';
    // 실화면 접근성 이름이 빈 칸(reports/raw/poc-3-mac-landmarks.json invoice.issue): title·값 글을 붙이지 않는다.
    const NONAME = new Set(['edtDmnrBsnoTop', 'btnDmnrBsnoCnfrTop', 'edtSplrTnmNmTop', 'edtSplrEmlIdTop', 'edtDmnrTnmNmTop', 'genEtxivLsatTop_0_edtLsatNmTop', 'genEtxivLsatTop_0_edtLsatSplCftTop', 'genEtxivLsatTop_0_edtLsatTxamtTop', 'edtRmrkCntnTop']);
    const ttl = (id, title) => (NONAME.has(id) ? '' : ' title="' + title + '"');
    const ro = (id, title) => '<input type="text" id="' + P + id + '"' + ttl(id, title) + ' readonly>';
    const LBL = { edtDmnrBsnoTop: '등록번호', genEtxivLsatTop_0_edtLsatNmTop: '품목' };
    const tx = (id, title, v) => (C.fieldLabels && LBL[id] ? '<label for="' + P + id + '">' + LBL[id] + '</label>' : '') + '<input type="text" id="' + P + id + '"' + ttl(id, title) + (v ? ' value="' + v + '"' : '') + '>';
    const btn = (id, v) => '<input type="button" id="' + P + id + '" value="' + (NONAME.has(id) ? '' : v) + '">';
    let rows = '';
    for (let n = 0; n < 4; n++) {
      const g = 'genEtxivLsatTop_' + n + '_';
      rows += '<tr>' + '<td>' + ro(g + 'edtLsatSplMmTop', (n + 1) + '행 월') + '</td><td>' + tx(g + 'edtLsatSplDdTop', (n + 1) + '행 일') + '</td><td>' + tx(g + 'edtLsatNmTop', (n + 1) + '행 품목') +
        '</td><td>' + tx(g + 'edtLsatRszeNmTop', (n + 1) + '행 규격') + '</td><td>' + tx(g + 'edtLsatQtyTop', (n + 1) + '행 수량') + '</td><td>' + tx(g + 'edtLsatUtprcTop', (n + 1) + '행 단가') +
        '</td><td>' + tx(g + 'edtLsatSplCftTop', (n + 1) + '행 공급가액') + '</td><td>' + ro(g + 'edtLsatTxamtTop', (n + 1) + '행 세액') + '</td><td>' + tx(g + 'edtLsatRmrkCntnTop', (n + 1) + '행 비고') + '</td></tr>';
    }
    wrap.innerHTML = header() + '<div id="mf_txppWframe"><h2 id="' + P + 'lblTtl">전자세금계산서</h2>' +
      '<div><a id="' + P + 'tabControl1_tab_tabs1_tabHTML">세금계산서(영세율포함)</a> <a id="' + P + 'tabControl1_tab_tabs2_tabHTML">계산서(면세)</a></div>' +
      '<table id="' + P + 'grpSplr1000Top"><caption>전자계산서 공급자 정보</caption><tr><td>등록번호 <span id="' + P + 'edtSplrTxprNoDispTop"></span> 종사업장 <span id="' + P + 'edtSplrMpbNoTop"></span></td></tr>' +
      '<tr><td>' + ro('edtSplrTnmNmTop', '상호입력') + ro('edtSplrRprsFnmTop', '성명') + ro('edtSplrPfbAdrTop', '사업장') + ro('edtSplrBcNmTop', '업태') + ro('edtSplrItmNmTop', '종목') +
      tx('edtSplrEmlIdTop', '이메일 아이디') + '@' + tx('edtSplrEmlDmanTop', '이메일 도메인') + '</td></tr></table>' +
      '<table id="' + P + 'grpDmnr1000Top"><caption>전자세금계산서 공급받는자 정보</caption><tr><td>' + tx('edtDmnrBsnoTop', '사업자등록번호') + btn('btnDmnrBsnoCnfrTop', '확인') + btn('btnDmnrClplcInqrTop', '거래처 조회') +
      '</td></tr><tr><td>' + ro('edtDmnrTnmNmTop', '상호') + ro('edtDmnrRprsFnmTop', '성명') + ro('edtDmnrPfbAdrTop', '사업장') + ro('edtDmnrBcNmTop', '업태') + ro('edtDmnrItmNmTop', '종목') +
      ro('edtDmnrMchrgEmlIdTop', '주담당 이메일 아이디') + '@' + ro('edtDmnrMchrgEmlDmanTop', '주담당 이메일 도메인') + '<select id="' + P + 'cmbDmnrMchrgEmlDmanCtlTop" title="이메일 도메인 선택"><option>직접입력</option></select>' +
      ro('edtDmnrSchrgEmlIdTop', '부담당 이메일 아이디') + '@' + ro('edtDmnrSchrgEmlDmanTop', '부담당 이메일 도메인') + '</td></tr></table>' +
      '<table id="' + P + 'group2342"><caption>전자세금계산서 날짜, 비고</caption><tr><td><input type="text" id="' + P + 'calWrtDtTop_input" title="날짜 입력" value="' + C.today + '"> ' + tx('edtRmrkCntnTop', '비고') + '</td></tr></table>' +
      '<div>합계금액 <span id="' + P + 'edtTotaAmtTop"></span> 공급가액 <span id="' + P + 'edtSumSplCftTop"></span> 세액 <span id="' + P + 'edtSumTxamtTop"></span></div>' +
      '<table id="' + P + 'grpLsat2002Top"><caption>계산서 품목 리스트</caption>' + rows + '</table>' +
      '<div><input type="radio" name="rec" id="' + P + 'rdoRecApeClCdTop_input_0" checked title="청구"> 청구 <input type="radio" name="rec" id="' + P + 'rdoRecApeClCdTop_input_1" title="영수"> 영수</div>' +
      '<div>' + btn('btnInit', '초기화') + btn('btnIsnPreview', '발급미리보기') + btn('btnIsnRsrv', '발급보류') + btn('btnIsn', '발급하기') + '</div></div>';
    const v = (id) => $(P + id);
    const mm = C.today.slice(5, 7);
    for (let n = 0; n < 4; n++) v('genEtxivLsatTop_' + n + '_edtLsatSplMmTop').value = mm;
    perm('UTEETBAA99'); perm('UTEETBAA01');
    // 폼 초기 조회(공급자 정보). 실화면은 진입 약 4초 뒤.
    setTimeout(async () => {
      const r = await act('ATEETBAA002R03', 'UTEETBAA01', {});
      await act('ATEETBAA005R01', 'UTEETBAA01', {});
      const s = r.supplier;
      v('edtSplrTxprNoDispTop').textContent = bizFmt(s.bizNo);
      v('edtSplrTnmNmTop').value = s.name; v('edtSplrRprsFnmTop').value = s.rep; v('edtSplrPfbAdrTop').value = s.addr; v('edtSplrBcNmTop').value = s.bizType; v('edtSplrItmNmTop').value = s.item;
      v('edtSplrEmlIdTop').value = s.emailId; v('edtSplrEmlDmanTop').value = s.emailDomain;
    }, C.formInitMs);

    // 등록번호 [확인]: 조회 3개 → 네이티브 alert. 정상이면 번호 형식 바꾸고 공급받는자 칸 편집 가능.
    v('btnDmnrBsnoCnfrTop').addEventListener('click', async () => {
      const d = digits(v('edtDmnrBsnoTop').value);
      await act('ATTABZAA001R05', 'UTEETBAA01', { bsno: d });
      await act('ATTABZAA001R01', 'UTEETBAA01', { bsno: d });
      const r = await act('ATEETBAE001R06', 'UTEETBAA01', { bsno: d });
      alert(r.msg);
      if (r.ok) {
        v('edtDmnrBsnoTop').value = bizFmt(d);
        for (const id of ['edtDmnrTnmNmTop', 'edtDmnrRprsFnmTop', 'edtDmnrPfbAdrTop', 'edtDmnrBcNmTop', 'edtDmnrItmNmTop', 'edtDmnrMchrgEmlIdTop', 'edtDmnrMchrgEmlDmanTop', 'edtDmnrSchrgEmlIdTop', 'edtDmnrSchrgEmlDmanTop']) v(id).readOnly = false;
      }
    });
    // 공급가액: 칸을 떠나야(blur) 쉼표·세액·합계를 계산한다.
    for (let n = 0; n < 4; n++) {
      const c = v('genEtxivLsatTop_' + n + '_edtLsatSplCftTop');
      c.addEventListener('blur', () => {
        const a = Number(digits(c.value) || 0);
        if (!digits(c.value)) return;
        c.value = comma(a);
        v('genEtxivLsatTop_' + n + '_edtLsatTxamtTop').value = comma(Math.floor(a / 10));
        let sp = 0; let tx = 0;
        for (let k = 0; k < 4; k++) { sp += Number(digits(v('genEtxivLsatTop_' + k + '_edtLsatSplCftTop').value) || 0); tx += Number(digits(v('genEtxivLsatTop_' + k + '_edtLsatTxamtTop').value) || 0); }
        v('edtSumSplCftTop').textContent = comma(sp); v('edtSumTxamtTop').textContent = comma(tx); v('edtTotaAmtTop').textContent = comma(sp + tx);
        setTimeout(() => v('genEtxivLsatTop_' + n + '_edtLsatTxamtTop').focus(), 0);
      });
    }
    const form = () => {
      const lines = [];
      for (let n = 0; n < 4; n++) {
        const g = 'genEtxivLsatTop_' + n + '_';
        if (!v(g + 'edtLsatNmTop').value) continue;
        lines.push({ mm: v(g + 'edtLsatSplMmTop').value, dd: v(g + 'edtLsatSplDdTop').value, nm: v(g + 'edtLsatNmTop').value, spl: v(g + 'edtLsatSplCftTop').value, tx: v(g + 'edtLsatTxamtTop').value });
      }
      const em = (a, b) => (v(a).value && v(b).value ? v(a).value + '@' + v(b).value : '');
      return {
        splrNo: v('edtSplrTxprNoDispTop').textContent, splrNm: v('edtSplrTnmNmTop').value, splrRep: v('edtSplrRprsFnmTop').value, splrAdr: v('edtSplrPfbAdrTop').value, splrBc: v('edtSplrBcNmTop').value, splrItm: v('edtSplrItmNmTop').value,
        splrEml: em('edtSplrEmlIdTop', 'edtSplrEmlDmanTop'),
        dmnrNo: v('edtDmnrBsnoTop').value, dmnrNm: v('edtDmnrTnmNmTop').value, dmnrRep: v('edtDmnrRprsFnmTop').value, dmnrAdr: v('edtDmnrPfbAdrTop').value, dmnrBc: v('edtDmnrBcNmTop').value, dmnrItm: v('edtDmnrItmNmTop').value,
        dmnrEml: em('edtDmnrMchrgEmlIdTop', 'edtDmnrMchrgEmlDmanTop'),
        wrtDt: v('calWrtDtTop_input').value, tota: v('edtTotaAmtTop').textContent, spl: v('edtSumSplCftTop').textContent, tx: v('edtSumTxamtTop').textContent,
        rec: v('rdoRecApeClCdTop_input_1').checked ? '영수' : '청구', lines,
      };
    };
    let doc = null;

    // [발급미리보기] → 같은 문서 안 창(값은 span 글). 이 단계까지 커밋 요청 없음.
    v('btnIsnPreview').addEventListener('click', async () => {
      await perm('UTEETBAA09');
      doc = form();
      const shown = C.tamperPreview ? { ...doc, dmnrNo: bizFmt('9' + digits(doc.dmnrNo).slice(1)) } : doc;
      const Q = P + 'isnPreviewPopup_wframe_';
      const sp = (id, t) => '<span id="' + Q + id + '">' + (t || '') + '</span>';
      let ls = '';
      shown.lines.forEach((l, n) => { const g = 'genLsat2000Top_' + n + '_edtLsat'; ls += '<tr><td>' + sp(g + 'SplMonTop', l.mm) + '</td><td>' + sp(g + 'SplDtTop', l.dd) + '</td><td>' + sp(g + 'NmTop', l.nm) + '</td><td>' + sp(g + 'SplCftTop', l.spl) + '</td><td>' + sp(g + 'TxamtTop', l.tx) + '</td></tr>'; });
      const w = document.createElement('div');
      w.id = P + 'isnPreviewPopup'; w.className = 'w2window w2popup_window';
      w.innerHTML = '<div id="' + P + 'isnPreviewPopup_header"><h3>발급미리보기(팝업)</h3><a id="' + P + 'isnPreviewPopup_close" href="#">창닫기</a></div><div id="' + P + 'isnPreviewPopup_wframe">' +
        '<table><tr><td>공급자 ' + sp('edtSplrTxprNoTop', shown.splrNo) + sp('edtSplrTnmNmTop', shown.splrNm) + sp('edtSplrRprsFnmTop', shown.splrRep) + sp('edtSplrPfbAdrTop', shown.splrAdr) + sp('edtSplrBcNmTop', shown.splrBc) + sp('edtSplrItmNmTop', shown.splrItm) + sp('edtSplrEmlAdrTop', shown.splrEml) + '</td></tr>' +
        '<tr><td>공급받는자 ' + sp('edtDmnrTxprNoTop', shown.dmnrNo) + sp('edtDmnrTnmNmTop', shown.dmnrNm) + sp('edtDmnrRprsFnmTop', shown.dmnrRep) + sp('edtDmnrPfbAdrTop', shown.dmnrAdr) + sp('edtDmnrBcNmTop', shown.dmnrBc) + sp('edtDmnrItmNmTop', shown.dmnrItm) + sp('edtDmnrEmlAdr1Top', shown.dmnrEml) + '</td></tr>' +
        '<tr><td>작성일자 ' + sp('edtWrtDtTop', shown.wrtDt) + ' 합계 ' + sp('edtTotaAmtTop', shown.tota) + ' 공급가액 ' + sp('edtSumSplCftTop', shown.spl) + ' 세액 ' + sp('edtSumTxamtTop', shown.tx) + ' ' + sp('edtRecApeClCdTop', shown.rec) + '</td></tr></table>' +
        '<table>' + ls + '</table>' +
        '<input type="button" id="' + Q + 'btnCancelView" value="취소"> <input type="button" id="' + Q + 'btnProcessView" value="발급하기"> <input type="button" id="' + Q + 'trigger1" value="닫기"></div>';
      document.body.append(w);
      const close = () => w.remove();
      $(Q + 'btnCancelView').onclick = close; $(Q + 'trigger1').onclick = close; $(P + 'isnPreviewPopup_close').onclick = close;
      $(Q + 'btnProcessView').onclick = async () => {
        close();
        await act('ATEETBAA002R04', 'UTEETBAA01', {});
        await act('ATCETBBA001R09', 'UTEETBAA01', {});
        await perm('UTEETZZA89');
        await act('ATEETBAA007R01', 'UTEETZZA89', {}, true);
        confirmWindow();
      };
    });

    function confirmWindow() {
      const Q = P + 'UTEETZZA89_wframe_';
      const w = document.createElement('div');
      w.id = P + 'UTEETZZA89'; w.className = 'w2window w2popup_window';
      const tb = (id, t) => '<span id="' + Q + id + '">' + t + '</span>';
      w.innerHTML = '<h3>전자세금계산서 발급</h3><div id="' + P + 'UTEETZZA89_wframe"><p>전자세금계산서를 발급하시겠습니까?<br>발급한 전자세금계산서는 삭제가 불가능합니다.</p>' +
        '<table><tr><td>' + tb('textbox1005', doc.dmnrNo) + tb('textbox1006', doc.dmnrNm) + tb('textbox2006', doc.dmnrRep) + tb('textbox1008', doc.wrtDt) + tb('textbox1010', doc.tota) + tb('textbox1012', doc.spl) + tb('textbox1014', doc.tx) + '</td></tr></table>' +
        '<input type="button" id="' + Q + 'btnClose" value="취소"> <input type="button" id="' + Q + 'trigger20" value="확인(인증 화면 이동)"> <input type="button" id="' + Q + 'trigger15" value="닫기"> <input type="button" id="' + Q + 'btnBefMate2" value="내려받기"></div>';
      document.body.append(w);
      $(Q + 'btnClose').onclick = () => w.remove(); $(Q + 'trigger15').onclick = () => w.remove();
      $(Q + 'trigger20').onclick = async () => { w.remove(); await perm('UTEETZZA08'); authWindow(); };
    }

    function authWindow() {
      const Q = P + 'UTEETZZA08_wframe_';
      const w = document.createElement('div');
      w.id = P + 'UTEETZZA08'; w.className = 'w2window w2popup_window';
      const li = (id, t) => '<li id="' + Q + id + '"><button type="button" id="' + uuid() + '">' + t + '</button></li>';
      w.innerHTML = '<h3>전자세금계산서 발급 인증유형 선택</h3><div id="' + P + 'UTEETZZA08_wframe"><p>발급가능 공동인증서 : 사업자범용·전자(세금)계산서용 공동인증서</p><ul>' +
        li('group596123', '공동∙금융 인증') + li('group5321197', '보안카드 인증') + li('group111', '사업자 간편인증') + '</ul><input type="button" id="' + Q + 'btnClose_type02" value="닫기"></div>';
      document.body.append(w);
      $(Q + 'btnClose_type02').onclick = () => w.remove();
      $(Q + 'group596123').querySelector('button').onclick = async () => {
        w.remove();
        await act('ATEETBAA002C04', 'UTEETBAA01', { dmnrNo: digits(doc.dmnrNo) });
        openCert();
      };
      // 보안카드·사업자 간편인증 갈래는 캡처 전이다(가정): C04 뒤 아무 창도 띄우지 않는다.
      for (const g of ['group5321197', 'group111']) $(Q + g).querySelector('button').onclick = async () => { w.remove(); await act('ATEETBAA002C04', 'UTEETBAA01', {}); };
    }

    function openCert() {
      const box = $('dscertContainer');
      const f = $('dscert');
      box.style.cssText = 'display:block;position:fixed;z-index:100010;top:0;left:0;width:100%;height:100%';
      f.setAttribute('sandbox', 'allow-scripts allow-forms');
      f.style.cssText = 'width:100%;height:100%;border:0;background:#fff';
      f.src = '/MagicLine4XML/ML4Web/Child.html?lgUrl=' + location.host + '&mode=sign&random=' + Math.random().toString(36).slice(2);
    }
    function foldCert(keepSrc) {
      const f = $('dscert');
      f.style.cssText = 'width:0;height:0;border:0';
      $('dscertContainer').style.cssText = 'display:block;position:fixed;top:0;left:0;width:0;height:0';
      if (!keepSrc) f.src = 'about:blank';
    }
    window.addEventListener('message', async (e) => {
      if (e.source !== $('dscert').contentWindow || !e.data || typeof e.data.ml4 !== 'string') return;
      if (e.data.ml4 === 'cancel') return foldCert(false);
      if (e.data.ml4 !== 'signed') return;
      foldCert(true);
      const r = await act('ATEETBAA002C05', 'UTEETBAA01', { ...doc, dmnrNo: digits(doc.dmnrNo), sig: e.data.sig });
      if (!r.etan) return;
      await act('ATEETBAA002C08', 'UTEETBAA01', { etan: r.etan });
      await perm('UTEETZZA87');
      await act('ATEETBAA007R01', 'UTEETZZA87', {}, true);
      const Q = P + 'isnCmplPopup_wframe_';
      const w = document.createElement('div');
      w.id = P + 'isnCmplPopup'; w.className = 'w2window w2popup_window';
      w.innerHTML = '<h3>발급 완료 팝업</h3><div id="' + P + 'isnCmplPopup_wframe"><p id="' + Q + 'txtMsg1">발급된 전자세금계산서 승인번호 : ' + r.etan + '</p>' +
        '<p id="' + Q + 'txtMsg4">발급한 전자세금계산서가 ' + (doc.splrEml || '') + ', ' + (doc.dmnrEml || '') + '로 발송되었습니다.</p>' +
        '<input type="button" id="' + Q + 'trigger201" value="목록조회"> <input type="button" id="' + Q + 'btnClose" value="상세(팝업)"> <input type="button" id="' + Q + 'btnClose1" value="상세(화면)"> <input type="button" id="' + Q + 'trigger20" value="계속발급"> <input type="button" id="' + Q + 'trigger15" value="닫기"></div>';
      document.body.append(w);
    });
  }

  // ---------------- 그리드(목록·메일) ----------------
  function grid(id, cols) {
    return '<div id="' + P + id + '" class="w2grid"><table id="' + P + id + '_head_table"><thead><tr>' + cols.map((c) => '<th>' + c[1] + '</th>').join('') + '</tr></thead></table>' +
      '<table id="' + P + id + '_body_table"><tbody></tbody></table></div>';
  }
  function fillGrid(id, cols, rows) {
    $(P + id + '_body_table').tBodies[0].innerHTML = rows.map((r, i) => '<tr>' + cols.map((c, j) => '<td id="' + P + id + '_cell_' + i + '_' + j + '" data-col_id="' + c[0] + '">' + (r[c[0]] ?? '') + '</td>').join('') + '</tr>').join('');
  }
  const LIST_COLS = [['chk', '선택'], ['wrtDt', '작성일자'], ['isnDtm', '발급일자'], ['tmsnDt', '전송일자'], ['dmnrTxprDscmNo', '공급받는자등록번호'], ['splrTxprDscmNo', '공급자등록번호'], ['mpbNo', '종사업장 번호'],
    ['tnmNm', '상호'], ['rprsFnm', '대표자명'], ['lsatNm', '품목명'], ['totaAmtStr', '합계금액'], ['sumSplCftStr', '공급가액'], ['sumTxamtStr', '세액'], ['etan', '승인번호'], ['etxivKndCd', '전자세금계산서 종류']];
  function listScreen() {
    document.title = '국세청 홈택스 - 계산서ㆍ영수증ㆍ카드 > 전자(세금)계산서 조회 > 발급 목록조회';
    perm('UTEETBDA01');
    const btn = (id, val) => '<input type="button" id="' + P + id + '" value="' + val + '">';
    wrap.innerHTML = header() + '<div id="mf_txppWframe"><h2 id="' + P + 'textbox918">전자세금계산서 목록조회</h2>' +
      '<input type="text" id="' + P + 'inqrDtStrt_input" title="조회 시작일" value="' + C.today + '"> ~ <input type="text" id="' + P + 'inqrDtEnd_input" title="조회 종료일" value="' + C.today + '"> ' +
      btn('btnChk11', '1주일') + btn('btnChk1', '1개월') + btn('btnChk3', '3개월') + ' <input type="text" id="' + P + 'txprDscmNoA" title="공급받는자 등록번호"> ' + btn('trigger50', '조회') +
      ' <select id="' + P + 'selectbox90" title="조회건수"><option>10</option><option>20</option><option>30</option><option>50</option></select>' + grid('resultGrid', LIST_COLS) + '<table id="' + P + 'group1521"><tr><td>총 합계금액</td></tr></table></div>';
    const back = (days) => { const d = new Date(Date.parse(C.today + 'T00:00:00Z') - days * 86400000); return d.toISOString().slice(0, 10); };
    $(P + 'btnChk11').onclick = () => { $(P + 'inqrDtStrt_input').value = back(7); };
    $(P + 'btnChk1').onclick = () => { $(P + 'inqrDtStrt_input').value = back(30); };
    $(P + 'trigger50').onclick = async () => {
      const r = await act('ATEETBDA001R01', 'UTEETBDA01', { from: $(P + 'inqrDtStrt_input').value, to: $(P + 'inqrDtEnd_input').value, dmnr: digits($(P + 'txprDscmNoA').value) });
      fillGrid('resultGrid', LIST_COLS, (r.rows || []).slice(0, Number($(P + 'selectbox90').value)));
    };
  }
  const MAIL_COLS = [['chk', '전체선택'], ['fmtEmlRgtDt', '최초발송일'], ['rcvnNm', '수신자구분'], ['emlAdrEncCntn', '메일주소'], ['emlTtl', '수신인(메일제목)'], ['rprsNm', '대표자명'], ['fmtEtan', '승인번호'],
    ['etxivEmlFrwStatNm', '발송구분'], ['etxivEmlFrwRsltNm', '발송결과'], ['fmtEtxivEmlArvlDtm', '도착일시'], ['fmtEtxivEmlCnfrDtm', '확인일시'], ['emlSn', '일련번호']];
  function mailScreen() {
    document.title = '국세청 홈택스 - 계산서ㆍ영수증ㆍ카드 > 전자(세금)계산서 발급 > (발송‧수신)내역조회 및 재발송';
    perm('UTEETBAB16');
    const btn = (id, val) => '<input type="button" id="' + P + id + '" value="' + val + '">';
    wrap.innerHTML = header() + '<div id="mf_txppWframe"><h2 id="' + P + 'textbox922">(발송‧수신)내역조회 및 재발송</h2>' +
      '<input type="text" id="' + P + 'edtEtan" title="승인번호"> ' + btn('btnChk11', '1주일') + btn('btnChk1', '1개월') + btn('trigger45', '조회') + btn('btnReSend', '재발송하기') + grid('grdResult', MAIL_COLS) + '</div>';
    $(P + 'trigger45').onclick = async () => {
      const r = await act('ATEETBAF001R01', 'UTEETBAB16', { etan: $(P + 'edtEtan').value });
      await act('ATEETBAF001R03', 'UTEETBAB16', {});
      fillGrid('grdResult', MAIL_COLS, (r.rows || []).slice(0, 10));
    };
  }

  setTimeout(() => screens[C.screen](), C.renderDelayMs);
})();
`;

// 인증서 창(MagicLine4 ML4Web 흉내, 2026-11-13 공개 정적 파일 UI/ML4Web_Main.html·ML4Web_Draw.js·MLjquidatatable.js에서 읽은 id·구조).
// 부모가 sandbox로 열어 페이지 스크립트가 안을 못 읽는다(실화면도 못 읽는다). 엔진·금고는 CDP 프레임으로 본다.
// - 저장 위치 a#stg_web·a#stg_hdd, 목록 div#dataTable 안 tr#row{N}dataTable(role=row, 0번 행이 골라진 채 시작), td role=gridcell 4열
// - 비밀번호 input#input_cert_pw(title "인증서 비밀번호 입력"), [확인] button#btn_confirm_iframe, [취소] button#btn_cancel, 경고 #popup_alert·#alert_msg·button#btn_alert_confirm
// - [확인]: 칸 값이 가짜 비밀번호와 같으면 통과(서버에 기록), 다르면 경고. 사람 흉내(fx.cert())는 칸 값과 상관없이 통과.
const CHILD = (main: string, certs: Array<{ cn: string; policy: string }>) => `<!doctype html><html lang="ko"><head><meta charset="utf-8"><title>인증서 선택창</title>
<style>tr.sel{background:#cde}#popup_alert{display:none}</style></head><body>
<div id="form1"><div id="selectCertContainer"><div id="ML_window"><div id="ML_container">
<div id="ML_dp_01" class="ML_sub_tit">인증서 저장위치</div>
<div class="MLstrSlide" id="MLstrSlide"><div class="ML_storage_area"><ul>
<li class="ML_storage_browser"><a href="#" id="stg_web" class="stg_01" title="브라우저"><span>브라우저</span></a></li>
<li class="ML_storage_hdd"><a href="#" id="stg_hdd" class="stg_01" title="하드디스크/이동식"><span>하드디스크/이동식</span></a></li>
</ul></div></div>
<div id="ML_dp_02" class="ML_sub_tit">사용할 인증서 선택</div>
<div id="ML_certlist_area" class="ML_cert_list_area"><div id="dataTable"><table><thead><tr role="row"><th role="columnheader">구분</th><th role="columnheader">사용자</th><th role="columnheader">만료일</th><th role="columnheader">발급자</th></tr></thead><tbody>
${certs.map((c, n) => `<tr data-key="${n}" role="row" id="row${n}dataTable"${n === 0 ? ' class="sel" aria-selected="true"' : ' aria-selected="false"'}><td role="gridcell">${c.cn}</td><td role="gridcell">${c.policy}</td><td role="gridcell">가짜인증</td><td role="gridcell">2027-01-01</td></tr>`).join('')}
</tbody></table></div></div>
<div id="ML_dp_04" class="ML_sub_tit">인증서 비밀번호 입력</div>
<div id="ML_status_area" class="ML_status_area"><input type="password" id="input_cert_pw" name="input_cert_pw" class="passwd_input" title="인증서 비밀번호 입력" placeholder="비밀번호를 입력하시오." autocomplete="off" value=""></div>
<button type="button" id="btn_confirm_iframe">확인</button> <button type="button" id="btn_cancel">취소</button> <button type="button" id="btn_viewCert">인증서 보기</button>
</div></div></div></div>
<div id="popup_alert" class="ML_container_dialog"><div id="alert_msg" class="ML_pw_dialog_txt"></div><button type="button" id="btn_alert_confirm">확인</button></div>
<script>
const MAIN = ${JSON.stringify(main)};
const mode = new URLSearchParams(location.search).get('mode') || 'sign';
const $ = (id) => document.getElementById(id);
let sel = 0;
document.querySelectorAll('#dataTable tbody tr').forEach((tr) => tr.onclick = () => {
  document.querySelectorAll('#dataTable tbody tr').forEach((x) => { x.classList.remove('sel'); x.setAttribute('aria-selected', 'false'); });
  tr.classList.add('sel'); tr.setAttribute('aria-selected', 'true'); sel = Number(tr.dataset.key);
});
const finish = (how) => fetch(MAIN + '/_fx/certuse?mode=' + mode + '&how=' + how + '&sel=' + sel).then((r) => r.json()).then((r) => {
  if (mode === 'login') parent.postMessage({ ml4: 'login' }, '*');
  else parent.postMessage({ ml4: 'signed', sig: 'FAKE-SIG' }, '*');
});
$('btn_confirm_iframe').onclick = () => fetch(MAIN + '/_fx/certpw?pw=' + encodeURIComponent($('input_cert_pw').value)).then((r) => r.json()).then((r) => {
  if (r.ok) return finish('typed');
  $('alert_msg').textContent = '인증서 암호가 올바르지 않습니다.'; $('popup_alert').style.display = 'block'; $('input_cert_pw').value = '';
});
$('btn_alert_confirm').onclick = () => { $('popup_alert').style.display = 'none'; };
$('btn_cancel').onclick = () => parent.postMessage({ ml4: 'cancel' }, '*');
const t = setInterval(() => fetch(MAIN + '/_fx/cert').then((r) => r.json()).then((s) => {
  if (s.action === 'confirm') { clearInterval(t); finish('human'); }
  if (s.action === 'cancel') { clearInterval(t); parent.postMessage({ ml4: 'cancel' }, '*'); }
}).catch(() => {}), 150);
</script></body></html>`;

/** 가짜 홈택스 두 호스트(화면·teet)를 띄운다. */
export async function startHometaxFake(o: Partial<FakeKnobs> & { loggedIn?: boolean; supplier?: Partial<typeof SUPPLIER> } = {}): Promise<HometaxFake> {
  const knobs: FakeKnobs = {
    renderDelayMs: 1500, xhrDelayMs: 120, registry: { '2148651233': '정상적인 사업자번호입니다.' }, tamperPreview: false, hangC05: false, listLagMs: 0, mail: 'done', fieldLabels: false,
    certPassword: 'fake-cert-pw-0000', certs: [{ cn: '가나다컴퍼니()0001234567891', policy: '사업자범용' }],
    ...o,
  };
  const supplier = { ...SUPPLIER, ...o.supplier };
  const state: HometaxFake['state'] = { loggedIn: o.loggedIn ?? false, stage: 'idle', invoices: [], lastScreen: null, certAt: 0, certUses: [], wrongPw: 0 };
  const reqs: FakeRequest[] = [];
  let certAction: 'confirm' | 'cancel' | null = null;
  let seq = 0;
  const hung = new Set<http.ServerResponse>();
  const servers: http.Server[] = [];

  const listen = async (h: http.RequestListener) => {
    const s = http.createServer(h);
    servers.push(s);
    await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
    return `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
  };
  const send = (res: http.ServerResponse, code: number, type: string, body: string, extra: Record<string, string> = {}) => {
    res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store', ...extra });
    res.end(body);
  };
  const json = (res: http.ServerResponse, v: unknown) => send(res, 200, 'application/json; charset=utf-8', JSON.stringify(v), { 'access-control-allow-origin': '*' });
  const readBody = (req: http.IncomingMessage) => new Promise<Record<string, unknown>>((r) => {
    let b = '';
    req.setEncoding('utf8');
    req.on('data', (c: string) => (b += c));
    req.on('end', () => {
      try {
        r(JSON.parse(b || '{}') as Record<string, unknown>);
      } catch {
        r({});
      }
    });
  });

  let teetOrigin = '';
  const origin = await listen((req, res) => {
    const u = new URL(req.url ?? '/', 'http://x');
    if (u.pathname === W2 && req.method === 'GET') {
      const screen = screenOf(u.searchParams, state.loggedIn);
      state.lastScreen = { screen, at: Date.now() };
      return send(res, 200, 'text/html; charset=utf-8', page({ screen, teet: teetOrigin, renderDelayMs: knobs.renderDelayMs, formInitMs: Math.min(800, knobs.renderDelayMs), today: kstToday(), loggedIn: state.loggedIn, tamperPreview: knobs.tamperPreview, fieldLabels: knobs.fieldLabels }));
    }
    if (u.pathname === '/MagicLine4XML/ML4Web/Child.html') return send(res, 200, 'text/html; charset=utf-8', CHILD(origin, knobs.certs));
    if (u.pathname === '/_fx/certpw') {
      // 비밀번호 대조만(값은 기록하지 않는다).
      const ok = u.searchParams.get('pw') === knobs.certPassword;
      if (!ok) state.wrongPw++;
      return json(res, { ok });
    }
    if (u.pathname === '/_fx/certuse') {
      const mode = u.searchParams.get('mode') === 'login' ? 'login' : 'sign';
      const cn = knobs.certs[Number(u.searchParams.get('sel') ?? 0)]?.cn ?? '';
      state.certUses.push({ mode, how: u.searchParams.get('how') === 'typed' ? 'typed' : 'human', cn });
      if (mode === 'login') state.loggedIn = true;
      return json(res, { ok: true });
    }
    if (u.pathname === '/_fx/state') return json(res, { loggedIn: state.loggedIn });
    if (u.pathname === '/_fx/cert') {
      const a = state.stage === 'cert' ? certAction : null;
      if (a) certAction = null;
      return json(res, { action: a });
    }
    if (u.pathname === '/' || u.pathname === '') {
      res.writeHead(302, { location: `${W2}?w2xPath=/ui/pp/index_pp.xml` });
      return res.end();
    }
    send(res, 404, 'text/plain', 'not found');
  });

  const act = async (actionId: string, body: Record<string, unknown>): Promise<unknown> => {
    const today = kstToday();
    switch (actionId) {
      case 'ATEETBAA002R03':
        return { supplier };
      case 'ATEETBAE001R06': {
        const d = String(body.bsno ?? '');
        const msg = knobs.registry[d] ?? '등록되어 있지 않은 사업자등록번호입니다.';
        return { ok: msg === '정상적인 사업자번호입니다.', msg };
      }
      case 'ATEETBAA002C04':
        state.stage = 'cert';
        state.certAt = Date.now();
        return { ok: true };
      case 'ATEETBAA002C05': {
        state.stage = 'signed';
        if (knobs.hangC05) return HANG;
        const ymd = today.replaceAll('-', '');
        const etan = `${ymd}-10${String(Math.floor(Math.random() * 1e6)).padStart(6, '0')}-${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`;
        const line = (body.lines as Array<{ nm: string }> | undefined)?.[0];
        state.invoices.push({
          etan, wrtDt: String(body.wrtDt ?? today), dmnrTxprDscmNo: fmtBiz(String(body.dmnrNo ?? '')), tnmNm: String(body.dmnrNm ?? ''), rprsFnm: String(body.dmnrRep ?? ''), lsatNm: line?.nm ?? '',
          totaAmtStr: String(body.tota ?? ''), sumSplCftStr: String(body.spl ?? ''), sumTxamtStr: String(body.tx ?? ''), dmnrEmail: String(body.dmnrEml ?? ''), visibleAt: Date.now() + knobs.listLagMs,
        });
        state.stage = 'issued';
        return { etan };
      }
      case 'ATEETBDA001R01': {
        const from = String(body.from ?? today);
        const to = String(body.to ?? today);
        const now = Date.now();
        const rows = state.invoices.filter((i) => i.visibleAt <= now && i.wrtDt >= from && i.wrtDt <= to && (!body.dmnr || i.dmnrTxprDscmNo.replaceAll('-', '') === body.dmnr)).reverse()
          .map((i) => ({ ...i, isnDtm: today, tmsnDt: today, splrTxprDscmNo: fmtBiz(supplier.bizNo), mpbNo: '', etxivKndCd: '일반' }));
        return { rows };
      }
      case 'ATEETBAF001R01': {
        const rows = state.invoices.filter((i) => i.visibleAt <= Date.now()).reverse().flatMap((i) => (['공급자', '공급받는자'] as const).map((who, k) => ({
          fmtEmlRgtDt: today, rcvnNm: who, emlAdrEncCntn: who === '공급자' ? `${supplier.emailId}@${supplier.emailDomain}` : i.dmnrEmail, emlTtl: `${i.tnmNm} (${supplier.name}->${i.tnmNm})`, rprsNm: i.rprsFnm,
          fmtEtan: i.etan, etxivEmlFrwStatNm: knobs.mail === 'done' ? '발송완료' : '발송중', etxivEmlFrwRsltNm: knobs.mail === 'done' ? '성공' : '', fmtEtxivEmlArvlDtm: knobs.mail === 'done' ? today : '', fmtEtxivEmlCnfrDtm: '', emlSn: String(k + 1),
        })));
        return { rows: body.etan ? rows.filter((r) => r.fmtEtan === body.etan) : rows };
      }
      default:
        return { ok: true };
    }
  };
  const HANG = Symbol('hang');

  teetOrigin = await listen(async (req, res) => {
    const u = new URL(req.url ?? '/', 'http://x');
    if (req.method === 'OPTIONS') return send(res, 204, 'text/plain', '', { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'content-type', 'access-control-allow-methods': 'POST' });
    const actionId = u.searchParams.get('actionId');
    reqs.push({ seq: ++seq, at: Date.now(), host: req.headers.host ?? '', method: req.method ?? '', path: u.pathname, actionId, screenId: u.searchParams.get('screenId') });
    const body = await readBody(req);
    await new Promise((r) => setTimeout(r, knobs.xhrDelayMs));
    if (u.pathname === '/permission.do') return json(res, { ok: true });
    if (u.pathname === '/wqAction.do' && actionId) {
      const out = await act(actionId, body);
      if (out === HANG) {
        hung.add(res);
        return;
      }
      return json(res, out);
    }
    send(res, 404, 'text/plain', 'not found', { 'access-control-allow-origin': '*' });
  });

  return {
    origin, teetOrigin, knobs, state,
    login: () => void (state.loggedIn = true),
    cert: (a) => {
      if (state.stage === 'cert') certAction = a;
    },
    requests: () => reqs.map((r) => ({ ...r })),
    close: async () => {
      for (const r of hung) r.destroy();
      await Promise.all(servers.map((s) => new Promise<void>((r) => {
        s.closeAllConnections();
        s.close(() => r());
      })));
    },
  };
}

function fmtBiz(d: string): string {
  const x = d.replace(/[^0-9]/g, '');
  return x.length === 10 ? `${x.slice(0, 3)}-${x.slice(3, 5)}-${x.slice(5)}` : x;
}
