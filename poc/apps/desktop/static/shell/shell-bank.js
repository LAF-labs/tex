// 받을 돈(09 D-09) 화면: 못 받은 돈 · 받은 돈 · 확인할 입금 · 내 계좌. 거래처 상세의 계좌·입금자 이름 칸, 대화 답 카드.
// 값(거래처·금액·입금자명)은 main이 엔진 로컬 조회로 준 것을 그대로 그린다. 계산·판정은 하지 않는다(엔진 몫).
// 모든 고치기는 한 번 누르면 되고, 10초 동안 [되돌리기]가 뜬다(그 뒤에도 건 상세 기록에서 되돌린다, 09 §7.5).
// 결과·오류는 토스트 대신 이 화면 안 글로 남긴다(대표 2026-11-13). 한 덩어리에 주요 단추는 하나, 줄마다 붙는 단추는 조용한 단추다(v2.0).
import { btn, h, icon, kv, note, num } from './shell-views.js';
import { accountInput, amountInput, amountOf, checkFields, dateInput, field, keys, LIMITS, selectInput, textInput } from './fields.js';

const won = (n) => `${num(n)}원`;
const md = (iso) => (iso ? `${Number(iso.slice(5, 7))}월 ${Number(iso.slice(8, 10))}일` : '—');
const BANKS = ['국민', '신한', '우리', '하나', '농협', '기업', '카카오뱅크', '토스뱅크', '케이뱅크', '새마을금고', '우체국', '수협', '부산', '아이엠뱅크', '경남', '광주', '전북', '제주', 'SC제일', '씨티', '신협', '기타'];
const ROLE_LABEL = { date: '거래일(시)', time: '시간', in: '입금', out: '출금', amount: '금액(한 칸)', kind: '입출 구분', balance: '잔액', payer: '입금자·보낸분', memo: '적요', counter_account: '상대 계좌' };
const METHOD_LABEL = { account: '계좌', cash: '현금', other_account: '다른 계좌', offset: '상계', other: '기타', fee: '수수료' };
const FIT_LABEL = { exact: '금액 같음', fee: '수수료 차감', sum: '여러 건 합', partial: '일부', over: '더 많음' };
const ACTION_LABEL = { attach: '입금 붙임', detach: '뗌', reject: '아니라고 함', mark_received: '받았음 표시', close_fee: '차액 수수료로 닫음', promise: '기다리는 중으로', exclude: '목록에서 뺌', undo: '되돌림' };
const ERR = {
  consent_required: '먼저 안내를 읽고 동의해 주세요.',
  duplicate_account: '이미 등록한 계좌예요.',
  bad_account_number: '계좌번호를 숫자로 6~20자리 넣어 주세요.',
  bad_bank: '은행을 골라 주세요.',
  preview_expired: '미리보기가 끝났어요. 파일을 다시 올려 주세요.',
  no_rows: '읽은 줄이 없어요. 열을 확인해 주세요.',
  unsupported_format: '엑셀(xlsx·xls)이나 CSV 파일을 올려 주세요.',
  password_required: '암호가 걸린 파일이에요. 은행에서 암호 없이 다시 내려받아 주세요.',
  profile_not_found: '내 사업장을 먼저 등록해 주세요.',
  already_undone: '이미 되돌렸어요.',
  mixed_counterparties: '한 입금은 한 거래처 건에만 붙일 수 있어요.',
  alias_conflict: '다른 거래처가 이미 쓰는 입금자 이름이에요.',
  txn_used_elsewhere: '그 입금이 이미 다른 건에 붙어 있어 되돌릴 수 없어요.',
  receivable_settled: '그 건은 이미 다 받아서 되돌릴 수 없어요.',
  nothing_to_attach: '붙일 금액이 없어요.',
  account_not_found: '계좌를 골라 주세요.',
  bad_amount: '받은 금액을 확인해 주세요. 남은 돈보다 많을 수 없어요.',
  bad_date: '날짜를 다시 골라 주세요.',
  bad_alias: '이름을 두 글자 이상 넣어 주세요.',
  bad_holder: '예금주 이름을 확인해 주세요.',
  'source.not_linked': '이 계좌는 자동 연결이 안 돼 있어요. 거래내역 파일을 올려 주세요.',
  'source.not_available': '자동 연결을 지금 쓸 수 없어요. 거래내역 파일을 올려 주세요.',
};
/** 원천 연결 상태(원천 이름은 쓰지 않는다) */
const LINK_LABEL = { file_only: '파일만', auto_connected: '자동 연결됨', auto_error: '자동 연결 안 됨' };
const SOURCE_ERR = {
  'source.login_failed': '은행 로그인이 안 됐어요. 인증서를 확인해 주세요.',
  'source.cert_expired': '인증서 기간이 끝났어요. 새 인증서로 다시 연결해 주세요.',
  'source.needs_user': '은행에서 확인이 필요해요. 다시 연결해 주세요.',
  'source.rate_limited': '잠시 뒤에 다시 해 주세요.',
  'source.unsupported_bank': '이 은행은 아직 자동 조회를 못 해요. 파일을 올려 주세요.',
};
const sourceErrText = (code) => SOURCE_ERR[code] ?? '최신화하지 못했어요. 이미 넣은 거래내역은 그대로예요. 다시 해 주세요.';
/** 원천의 하루 상한(오류 아님) */
const DAILY_TEXT = '오늘은 다 가져왔어요. 내일 다시 가져올 수 있어요.';
/** 방금 가져와서 이번엔 은행에 묻지 않았다(오류 아님). retryAt까지 남은 분 */
const soonText = (retryAt) => {
  const min = Math.max(1, Math.ceil((Date.parse(retryAt) - Date.now()) / 60_000));
  return Number.isFinite(min) ? `방금 가져왔어요. ${min}분 뒤에 다시 가져올 수 있어요.` : '방금 가져왔어요. 잠시 뒤에 다시 가져올 수 있어요.';
};
const REFRESH_STEP = { requested: '요청함', waiting: '은행 응답 기다리는 중', running: '받는 중' };

function statusText(v) {
  if (v.status === 'received') return v.via === 'auto' ? '받음 · 자동' : v.offAccount ? `받음 · 직접(${METHOD_LABEL[v.offAccount] ?? '기타'})` : '받음 · 직접';
  return { unpaid: '못 받음', unknown: '확인 못 함', partial: '일부 받음', waiting: '기다리는 중', excluded: '목록에서 뺌' }[v.status];
}
const dueText = (v) => (v.dueIn === null ? '기한 없음' : v.dueIn < 0 ? `${-v.dueIn}일 지남` : v.dueIn === 0 ? '오늘' : `D-${v.dueIn}`);

/** main이 거절한 까닭이 칸 하나의 것이면 그 칸(data-field) 아래에 쓴다. 나머지는 폼 끝 한 줄. */
const ERR_FIELD = { bad_amount: 'amount', bad_date: 'on', bad_account_number: 'number', duplicate_account: 'number', bad_bank: 'bank', bad_alias: 'alias', bad_holder: 'holder' };
/** 화면 안 알림 한 줄(되돌리기 띠와 같은 모양): 아이콘 · 글(+ 작은 글) · 단추 0~2개. bad = 확인 필요 */
const bar = (text, { bad = false, extra = null, action = null, ic = null, attrs = {} } = {}) =>
  h('div', { class: `sx-note${bad ? ' is-attention' : ''}`, role: bad ? 'alert' : 'status', ...attrs }, icon(ic ?? (bad ? 'warn' : 'info')), h('div', {}, text, extra ? h('div', { class: 'sx-meta' }, extra) : null), action);

export function createBankScreen({ call, toast, rerender: draw, errText, counterparties, openCounterparty, railHead }) {
  const s = {
    tab: 'unpaid',
    data: null,
    loading: false,
    sel: null, // 고른 건 id
    detail: null,
    form: null, // { kind: 'received'|'promise'|'exclude', ... }
    formErr: null, // { where: 'form'|'account'|'import', text } 폼 안에 보이는 까닭
    notice: null, // { text, extra?, bad?, load?, retry?: [단추 글, 할 일] } 화면 위 알림 한 줄
    preview: null, // 거래내역 미리보기(main)
    cols: null, // 열 고르기(사람이 고친 것)
    previewAccount: null,
    adding: null, // 계좌 추가 입력 { bank, number, alias }
    confirmDel: null, // [지우기]를 한 번 누른 계좌 id(그 줄이 확인 줄로 바뀐다)
    offer: null, // 별칭 제안 { name, counterpartyId, cpName }
    assign: null, // [이 거래처 입금으로] 연 입금 { id, cp, remember }
    undo: null, // { seq, text, until }
    busy: false,
    invoiceResult: null,
    refreshing: {}, // 계좌 id → 최신화 진행(엔진 RefreshJob)
  };
  /** 거래처 상세(cpSection)는 받을 돈 화면 밖이라 토스트로 알린다 */
  const say = (e) => toast(ERR[errText(e)] ?? '처리하지 못했어요. 다시 해 주세요.');
  const errMsg = (e) => ERR[errText(e)] ?? '처리하지 못했어요. 다시 해 주세요.';
  const tell = (text, o = {}) => (s.notice = { text, ...o });
  /** 실패는 그 폼 안(where)의 그 칸 아래, 칸을 모르면 폼 끝 한 줄, 폼이 없으면 화면 위 알림 한 줄로 */
  const fail = (e, where) => (where ? (s.formErr = { where, text: errMsg(e), field: ERR_FIELD[errText(e)] ?? null }) : tell(errMsg(e), { bad: true }));
  const formMsg = (where) => (s.formErr?.where === where && !s.formErr.field ? h('p', { class: 'form-msg is-bad', role: 'alert' }, s.formErr.text) : null);
  /** 그 폼 그 칸의 까닭(field의 error) */
  const errAt = (where, f) => (s.formErr?.where === where && s.formErr.field === f ? s.formErr.text : null);

  /** 다시 그리면 DOM을 새로 만든다. 입력 중이던 칸(data-field)의 포커스와 커서를 지킨다([최신화] 진행이 1.5초마다 다시 그려도 칸에서 튕기지 않게) */
  const rerender = () => {
    const a = document.activeElement;
    const f = a?.closest?.('[data-view="bank"]') ? a.dataset.field : null;
    const at = f && typeof a.selectionStart === 'number' ? [a.selectionStart, a.selectionEnd] : null;
    draw();
    if (!f) return;
    const b = document.querySelector(`[data-view="bank"] [data-field="${f}"]`);
    if (!b || b === a) return;
    b.focus();
    if (at) {
      try {
        b.setSelectionRange(...at);
      } catch {
        // 커서를 못 두는 칸(날짜 등)은 포커스만
      }
    }
  };
  const focusLater = (sel) => setTimeout(() => document.querySelector(`[data-view="bank"] ${sel}`)?.focus(), 0);

  async function load() {
    s.loading = true;
    try {
      s.data = await call('bank.overview');
      if (s.notice?.load) s.notice = null;
      for (const a of s.data?.accounts ?? []) if (a.refresh && !['done', 'failed'].includes(a.refresh.state) && !s.refreshing[a.id]) watchRefresh(a.id, a.refresh);
      if (s.sel) s.detail = await call('bank.receivable', { id: s.sel }).catch(() => null);
    } catch (e) {
      tell(ERR[errText(e)] ?? '받을 돈을 불러오지 못했어요.', { bad: true, load: true, retry: ['다시 시도', refresh] });
    } finally {
      s.loading = false;
    }
  }
  const refresh = async () => {
    await load();
    rerender();
  };
  /** 고치기 하나: 부르고 → 되돌리기 띠(10초) → 다시 읽기. 성공하면 main 응답(없으면 true), 실패하면 null. where = 실패 까닭을 보일 폼 */
  async function act(method, params, text, where) {
    if (s.busy) return null;
    s.busy = true;
    if (s.notice?.bad) s.notice = null;
    s.formErr = null;
    let out = null;
    try {
      const r = await call(method, params);
      const seq = r?.seq ?? r?.seqs?.[0];
      if (seq !== undefined && text) {
        s.undo = { seq, seqs: r.seqs ?? [seq], text, until: Date.now() + 10_000 };
        setTimeout(() => {
          if (s.undo && Date.now() >= s.undo.until) {
            s.undo = null;
            rerender();
          }
        }, 10_200);
      }
      out = r ?? true;
    } catch (e) {
      fail(e, where);
    } finally {
      s.busy = false;
    }
    await refresh();
    return out;
  }
  async function undoNow() {
    const u = s.undo;
    s.undo = null;
    if (!u) return;
    try {
      for (const seq of [...u.seqs].reverse()) await call('bank.undo', { seq });
      toast('되돌렸어요');
    } catch (e) {
      fail(e);
    }
    await refresh();
  }

  // ---- 파일 올리기 ----

  /** 미리보기가 끝났으면 올린 파일을 버리고 다시 올리게 한다 */
  const lostPreview = () => {
    s.preview = null;
    s.tab = 'unpaid';
    tell(ERR.preview_expired, { bad: true, retry: ['파일 다시 올리기', pickStatement] });
  };
  async function pickStatement() {
    try {
      const p = await call('bank.pickStatement');
      if (!p) return;
      s.preview = p;
      s.cols = { ...p.mapping };
      s.previewAccount = p.suggestedAccountId ?? s.data?.accounts?.[0]?.id ?? null;
      s.tab = 'import';
      s.formErr = null;
      if (s.notice?.bad) s.notice = null;
    } catch (e) {
      fail(e);
    }
    rerender();
  }
  async function repreview() {
    try {
      s.preview = await call('bank.previewStatement', { token: s.preview.token, columns: s.cols });
      s.formErr = null;
    } catch (e) {
      if (errText(e) === 'preview_expired') lostPreview();
      else fail(e, 'import');
    }
    rerender();
  }
  async function commitStatement() {
    if (!s.previewAccount) {
      s.formErr = { where: 'import', text: '어느 계좌의 거래내역인지 골라 주세요.' };
      return rerender();
    }
    s.busy = true;
    s.formErr = null;
    rerender();
    try {
      const r = await call('bank.commitStatement', { token: s.preview.token, accountId: s.previewAccount, columns: s.cols });
      s.preview = null;
      s.tab = r.match.review || r.match.unknown ? 'review' : 'unpaid';
      // 넣은 결과는 화면에 남는 요약 한 줄(토스트로 사라지지 않게)
      tell('거래내역을 넣었어요.', { extra: [`새 줄 ${r.newCount}줄`, r.duplicateCount ? `이미 있던 줄 ${r.duplicateCount}줄` : null, `자동으로 붙임 ${r.match.auto}건`, `확인할 후보 ${r.match.review}건`, `누가 보낸지 모르는 입금 ${r.match.unknown}건`].filter(Boolean).join(' · ') });
    } catch (e) {
      if (errText(e) === 'preview_expired') lostPreview();
      else fail(e, 'import');
    } finally {
      s.busy = false;
    }
    await refresh();
  }
  async function pickInvoices() {
    try {
      const r = await call('bank.pickInvoices');
      if (!r) return;
      s.invoiceResult = r;
      if (!r.ok) tell('발급 목록 칸(작성일자·승인번호·합계금액)을 찾지 못했어요. 홈택스 [내려받기] 파일인지 확인해 주세요.', { bad: true });
      else tell(`세금계산서 ${r.rows}건을 읽었어요.`, { extra: [`새 건 ${r.created}건`, `이미 있던 건 ${r.merged}건`, r.purchase ? `매입 ${r.purchase}건은 아직 받지 않아요` : null].filter(Boolean).join(' · ') });
    } catch (e) {
      fail(e);
    }
    await refresh();
  }

  // ---- 그리기 ----

  const tabBtn = (key, label, n) => h('button', { type: 'button', class: s.tab === key ? 'is-on' : null, 'aria-pressed': String(s.tab === key), 'data-bank-tab': key, onclick: () => ((s.tab = key), (s.sel = null), (s.detail = null), (s.form = null), (s.formErr = null), (s.confirmDel = null), rerender()) }, label, n ? ` ${n}` : '');

  /** 머리: 제목 · 기준일 · 오른쪽 단추. railHead를 받으면 그것을 쓴다(승인 대기 칩이 같이 붙는다) */
  function head() {
    const sum = s.data?.summary;
    const basis = !sum ? '' : `${sum.latestDay ? `거래내역 ${md(sum.latestDay)}까지 반영` : '거래내역을 아직 올리지 않았어요'}${sum.stale && sum.latestDay ? ' · 오래됐어요' : ''}`;
    const right = [btn('거래내역 파일 올리기', pickStatement, 'sx-btn-primary', { 'data-act': 'bank-statement', disabled: !s.data?.accounts?.length }), btn('홈택스 발급목록 파일 올리기', pickInvoices, 'sx-btn-quiet', { 'data-act': 'bank-invoices' })];
    if (railHead) return railHead('받을 돈', basis, ...right);
    return h('div', { class: 'rs-head' }, h('h1', { class: 'title-screen' }, '받을 돈'), basis ? h('span', { class: 'sx-meta', 'data-bank-basis': '' }, basis) : null, h('div', { class: 'rs-right' }, ...right));
  }

  function noticeBar() {
    const n = s.notice;
    if (!n) return null;
    const [label, fn] = n.retry ?? ['닫기', null];
    const onclick = async () => {
      s.notice = null;
      if (fn) await fn();
      else rerender();
    };
    return bar(n.text, { bad: n.bad, extra: n.extra, ic: n.ic, action: btn(label, onclick, 'sx-btn-quiet', { 'data-act': fn ? 'bank-retry' : 'bank-notice-close' }), attrs: { 'data-bank-notice': n.bad ? 'bad' : 'info' } });
  }

  function undoBar() {
    if (!s.undo || Date.now() >= s.undo.until) return null;
    return bar(s.undo.text, { ic: 'check', action: btn('되돌리기', undoNow, 'sx-btn-quiet', { 'data-act': 'bank-undo' }), attrs: { 'data-bank-undo': '' } });
  }

  function offerBar() {
    const o = s.offer;
    if (!o) return null;
    const close = () => ((s.offer = null), rerender());
    if (o.conflict) return bar(`'${o.name}'는 다른 거래처 입금자 이름이기도 해서 기억하지 않았어요.`, { action: btn('닫기', close, 'sx-btn-quiet'), attrs: { 'data-bank-offer': '' } });
    return bar(`다음부터 '${o.name}' 입금은 ${o.cpName ?? '이 거래처'}로 볼까요?`, {
      attrs: { 'data-bank-offer': '' },
      action: [
        btn('기억하기', async () => {
          s.offer = null;
          if (await act('bank.addAlias', { counterpartyId: o.counterpartyId, name: o.name, learned: true })) toast('기억했어요');
        }, 'sx-btn-primary', { 'data-act': 'bank-alias-remember' }),
        btn('이번만', close, 'sx-btn-quiet', { 'data-act': 'bank-alias-once' }),
      ],
    });
  }

  const table = (cols, rows) => h('div', { class: 'list-box' }, h('table', { class: 'list' }, h('thead', {}, h('tr', {}, cols.map(([t, cls]) => h('th', { class: cls ?? null }, t)))), h('tbody', {}, rows)));

  function recvList(list, empty) {
    if (!list.length) return h('div', { class: 'empty' }, empty);
    return table(
      [['거래처'], ['작성일'], ['합계', 'num'], ['받은 돈', 'num'], ['남은 돈', 'num'], ['받기로 한 날'], ['상태']],
      list.map((v) =>
        h(
          'tr',
          { class: s.sel === v.id ? 'is-on' : null, 'data-bank-row': v.id, 'data-bank-status': v.status, onclick: () => select(v.id) },
          h('td', { class: 'name' }, v.cpName ?? '거래처 미상'),
          h('td', {}, v.writtenOn),
          h('td', { class: 'num' }, num(v.total)),
          h('td', { class: 'num' }, num(v.received)),
          h('td', { class: 'num' }, num(v.remaining)),
          h('td', { class: v.overdue ? 'is-attention' : null }, v.status === 'received' ? '—' : dueText(v)),
          h('td', {}, h('span', { class: `sx-chip${v.overdue ? ' is-attention' : v.status === 'received' ? ' is-done' : ''}` }, statusText(v))),
        ),
      ),
    );
  }

  async function select(id) {
    s.sel = s.sel === id ? null : id;
    s.form = null;
    s.formErr = null;
    s.detail = null;
    if (s.sel) s.detail = await call('bank.receivable', { id: s.sel }).catch(() => (tell('이 건을 열지 못했어요.', { bad: true, retry: ['다시 시도', () => ((s.sel = null), select(id))] }), null));
    rerender();
  }

  function detailCard() {
    const d = s.detail;
    if (!d) return null;
    const v = d.receivable;
    const open = v.status !== 'received' && v.status !== 'excluded';
    const allocs = d.allocs.filter((a) => !a.removedAt);
    const form = s.form;
    const today = new Date().toISOString().slice(0, 10);
    const close = () => ((s.form = null), (s.formErr = null), rerender());
    /** 폼을 열면 그 폼만 보인다(한 번에 한 가지). sel = 처음 포커스할 칸 */
    const openForm = (f, sel) => {
      s.form = f;
      s.formErr = null;
      rerender();
      focusLater(`[data-bank-form] ${sel}`);
    };
    /** 폼 저장: 성공하면 닫고, 실패하면 폼 안에 까닭을 남긴다 */
    const done = (run) => async () => {
      if (await run()) {
        s.form = null;
        rerender();
      }
    };
    const formActs = (label, submit, attrs = {}) => h('div', { class: 'sx-actions' }, btn(label, submit, 'sx-btn-primary', attrs), btn('그만두기', close, 'sx-btn-quiet'));
    let formEl = null;
    if (form?.kind === 'received') {
      // 칸 검사(금액 0·빈 값, 덜 넣은 날짜)를 먼저 하고, 맞으면 main에 보낸다
      const submit = done(() => checkFields(formEl) && act('bank.markReceived', { receivableId: v.id, method: form.method, amount: form.amount, on: form.on }, '받았음으로 표시했어요', 'form'));
      formEl = h(
        'div',
        { class: 'cp-form', 'data-bank-form': 'received', onkeydown: keys(submit, close) },
        field({ label: '받은 방법', input: selectInput(['cash', 'other_account', 'offset', 'other', 'account'].map((m) => [m, METHOD_LABEL[m]]), { value: form.method, compact: true, 'data-field': 'method', onchange: (e) => (form.method = e.target.value) }) }),
        field({ label: '받은 금액(원)', error: errAt('form', 'amount'), input: amountInput({ value: form.amount, compact: true, 'data-field': 'amount', oninput: (e) => (form.amount = amountOf(e.target)) }) }),
        field({ label: '받은 날', error: errAt('form', 'on'), input: dateInput({ value: form.on, required: true, compact: true, 'data-field': 'on', oninput: (e) => (form.on = e.target.value) }) }),
        formMsg('form'),
        formActs('받았음으로 표시', submit, { 'data-act': 'bank-mark-save' }),
      );
    } else if (form?.kind === 'promise') {
      const submit = done(() => checkFields(formEl) && act('bank.setPromised', { receivableId: v.id, on: form.on }, '기다리는 중으로 바꿨어요', 'form'));
      formEl = h(
        'div',
        { class: 'cp-form', 'data-bank-form': 'promise', onkeydown: keys(submit, close) },
        field({ label: '받기로 약속한 날', error: errAt('form', 'on'), input: dateInput({ value: form.on, required: true, compact: true, 'data-field': 'promise-on', oninput: (e) => (form.on = e.target.value) }) }),
        formMsg('form'),
        formActs('기다리는 중으로', submit),
      );
    } else if (form?.kind === 'exclude') {
      const submit = done(() => act('bank.exclude', { receivableId: v.id, reason: form.reason }, '목록에서 뺐어요', 'form'));
      formEl = h(
        'div',
        { class: 'cp-form', 'data-bank-form': 'exclude', onkeydown: keys(submit, close) },
        field({ label: '빼는 까닭', input: selectInput(['받지 않기로 함', '거래 취소', '기타'].map((r) => [r, r]), { value: form.reason, compact: true, 'data-field': 'reason', onchange: (e) => (form.reason = e.target.value) }) }),
        formMsg('form'),
        formActs('목록에서 빼기', submit),
        h('p', { class: 'sx-meta' }, '세무 처리(대손 등)는 앱이 판단하지 않아요. 세무사와 상의하세요.'),
      );
    }
    return h(
      'article',
      { class: 'sx-card bank-detail', 'data-bank-detail': v.id },
      h('div', { class: 'board-card-hd' }, h('span', { class: 'board-card-title' }, v.cpName ?? '거래처 미상'), h('span', { class: 'sx-chip' }, statusText(v))),
      kv([
        ['작성일', v.writtenOn],
        ['승인번호', v.approvalTail ? `…${v.approvalTail}` : '—', { mono: true }],
        ['품목', v.item],
        ['합계', won(v.total)],
        ['받은 돈', won(v.received)],
        ['남은 돈', won(v.remaining)],
        ['받기로 한 날', v.promisedOn ? `${v.promisedOn}(약속)` : (v.dueOn ?? '기한 없음')],
        ['출처', v.sources.map((x) => (x === 'ledger' ? '앱 발급' : '홈택스 목록')).join(' · ')],
      ]),
      h('div', { class: 'sx-panel-sec' }, '붙은 입금'),
      allocs.length
        ? h('ul', { class: 'bank-allocs' }, ...allocs.map((a) => h('li', { 'data-bank-alloc': a.id }, a.txn ? `${md(a.txn.day)} ${won(a.amount)} · ${a.txn.payer ?? '이름 없음'} · ···${a.txn.accountLast4}` : `${METHOD_LABEL[a.method] ?? '직접'} ${won(a.amount)}${a.receivedOn ? ` · ${md(a.receivedOn)}` : ''}`, a.decidedBy === 'auto' ? h('span', { class: 'sx-tag' }, '자동') : null, btn('떼기', () => act('bank.detach', { allocId: a.id }, '뗐어요'), 'sx-btn-quiet', { 'data-act': 'bank-detach' }))))
        : h('div', { class: 'sx-meta' }, '아직 붙은 입금이 없어요.'),
      // 주요 단추는 [받았음 표시] 하나. 같은 건의 상태를 바꾸는 나머지는 둘째 줄 조용한 단추. 폼을 열면 단추 줄 대신 폼만 보인다.
      open && !form
        ? [
            h('div', { class: 'sx-actions' }, btn('받았음 표시', () => openForm({ kind: 'received', method: 'cash', amount: v.remaining, on: today }, '[data-field="amount"]'), 'sx-btn-primary', { 'data-act': 'bank-mark' })),
            h(
              'div',
              { class: 'sx-actions' },
              v.remaining > 0 && v.remaining <= 1000 && v.received > 0 ? btn('차액은 수수료로 닫기', () => act('bank.closeFee', { receivableId: v.id }, '차액을 수수료로 닫았어요'), 'sx-btn-quiet') : null,
              btn('기다리는 중으로', () => openForm({ kind: 'promise', on: today }, '[data-field="promise-on"]'), 'sx-btn-quiet'),
              btn('목록에서 빼기', () => openForm({ kind: 'exclude', reason: '받지 않기로 함' }, '[data-field="reason"]'), 'sx-btn-quiet'),
            ),
          ]
        : v.status === 'excluded'
          ? h('div', { class: 'sx-actions' }, btn('목록에 되살리기', () => act('bank.exclude', { receivableId: v.id, reason: null }, '되살렸어요')))
          : null,
      formEl,
      open && d.attachable.length
        ? h(
            'div',
            {},
            h('div', { class: 'sx-panel-sec' }, '입금 붙이기'),
            h('ul', { class: 'bank-attach' }, ...d.attachable.slice(0, 10).map((t) => h('li', { 'data-bank-attach': t.id }, `${md(t.day)} ${won(t.unallocated)} · ${t.payer ?? '이름 없음'}`, t.candidates.length ? h('span', { class: 'sx-tag' }, '후보') : null, btn('이 입금 붙이기', () => attach(t, v), 'sx-btn-quiet', { 'data-act': 'bank-attach' })))),
          )
        : null,
      h('div', { class: 'sx-panel-sec' }, '기록'),
      h('ul', { class: 'bank-events' }, ...d.events.map((e) => h('li', {}, `${e.at.slice(5, 16).replace('T', ' ')} · ${e.actor === 'auto' ? '자동' : '사장님'} · ${ACTION_LABEL[e.action] ?? '고침'}`, e.undoOf === null && !e.undone && e.action !== 'undo' ? btn('되돌리기', () => act('bank.undo', { seq: e.seq }, '되돌렸어요'), 'sx-btn-quiet', { 'data-act': 'bank-event-undo' }) : null))),
    );
  }

  async function attach(t, v) {
    const r = await act('bank.attach', { txnId: t.id, receivableId: v.id }, '입금을 붙였어요');
    if (r?.aliasOffer) s.offer = { ...r.aliasOffer, cpName: v.cpName };
    rerender();
  }

  async function accept(t, c, closeFee = false) {
    const r = await act('bank.accept', { txnId: t.id, ids: c.receivableIds.join(','), closeFee }, `${c.cpName ?? '거래처'} 건에 붙였어요`);
    if (r?.aliasOffer) s.offer = { ...r.aliasOffer, cpName: c.cpName };
    rerender();
  }

  function reviewList() {
    const list = s.data?.review ?? [];
    if (!list.length) return h('div', { class: 'empty' }, '확인할 입금이 없어요.');
    return h(
      'div',
      { class: 'bank-review' },
      ...list.map((t) => {
        const cps = counterparties();
        const g = s.assign?.id === t.id ? s.assign : null;
        const cancel = () => ((s.assign = null), rerender());
        const save = async () => {
          const { cp: counterpartyId, remember } = g;
          s.assign = null;
          const r = await act('bank.assignTxn', { txnId: t.id, counterpartyId, remember: !!t.payer && remember }, '거래처를 정했어요');
          if (r?.conflict) s.offer = { name: t.payer, conflict: true };
          rerender();
        };
        return h(
          'article',
          { class: 'sx-card', 'data-bank-txn': t.id },
          h('div', { class: 'board-card-hd' }, h('span', { class: 'board-card-title' }, `${md(t.day)} · ${won(t.unallocated)}`), h('span', { class: 'sx-meta' }, `${t.payer ?? '이름 없음'} · ${t.bank} ···${t.accountLast4}${t.memo ? ` · ${t.memo}` : ''}`)),
          t.candidates.length
            ? h(
                'ul',
                { class: 'bank-cands' },
                ...t.candidates.map((c, i) =>
                  h(
                    'li',
                    { 'data-bank-cand': c.receivableIds.join(',') },
                    h('div', {}, h('b', {}, `→ ${c.cpName ?? '거래처'} ${md(c.writtenOn)} ${won(c.total)}?`), FIT_LABEL[c.fit] ? [' ', h('span', { class: 'sx-tag' }, FIT_LABEL[c.fit])] : null),
                    h('div', { class: 'sx-meta' }, c.reason),
                    // 카드의 주요 단추는 첫 후보의 [맞아요] 하나
                    h(
                      'div',
                      { class: 'sx-actions' },
                      btn('맞아요', () => accept(t, c), i === 0 ? 'sx-btn-primary' : '', { 'data-act': 'bank-accept' }),
                      c.fit === 'fee' ? btn('맞아요 · 차액은 수수료로 닫기', () => accept(t, c, true), 'sx-btn-quiet', { 'data-act': 'bank-accept-fee' }) : null,
                      c.receivableIds.length === 1 ? btn('아니에요', () => act('bank.reject', { txnId: t.id, receivableId: c.receivableIds[0] }, '이 건이 아니라고 했어요'), 'sx-btn-quiet', { 'data-act': 'bank-reject' }) : null,
                    ),
                  ),
                ),
              )
            : h('div', { class: 'sx-meta' }, '누가 보낸지 모르는 입금이에요.'),
          g
            ? h(
                'div',
                { class: 'cp-form', 'data-bank-assign': t.id, onkeydown: keys(null, cancel) },
                field({ label: '거래처', input: selectInput(cps.map((c) => [c.id, c.name]), { value: g.cp, compact: true, 'data-field': 'cp', onchange: (e) => (g.cp = e.target.value) }) }),
                t.payer ? h('label', { class: 'auth-row' }, h('input', { type: 'checkbox', 'data-field': 'remember', checked: g.remember, onchange: (e) => (g.remember = e.target.checked) }), h('span', { class: 'sx-body-sm' }, `다음부터 '${t.payer}' 입금은 이 거래처로`)) : null,
                h('div', { class: 'sx-actions' }, btn('이 거래처 입금으로', save, 'sx-btn-primary', { 'data-act': 'bank-assign-save' }), btn('그만두기', cancel, 'sx-btn-quiet')),
              )
            : h(
                'div',
                { class: 'sx-actions' },
                cps.length
                  ? btn('이 거래처 입금으로', () => {
                      s.assign = { id: t.id, cp: cps[0].id, remember: true };
                      rerender();
                      focusLater(`[data-bank-assign="${CSS.escape(t.id)}"] [data-field="cp"]`);
                    }, t.candidates.length ? 'sx-btn-quiet' : '', { 'data-act': 'bank-assign' })
                  : null,
                btn('상관없는 입금', () => act('bank.ignoreTxn', { txnId: t.id, reason: 'unrelated' }, '상관없는 입금으로 뺐어요'), 'sx-btn-quiet', { 'data-act': 'bank-ignore' }),
              ),
        );
      }),
    );
  }

  /** [최신화]: 원천 → 넣기 → 맞추기. 진행을 1.5초마다 본다. 결과는 화면 위 알림 한 줄 */
  async function startRefresh(id) {
    if (s.refreshing[id]) return;
    try {
      const job = await call('bank.refresh', { accountId: id });
      watchRefresh(id, job);
    } catch (e) {
      fail(e);
      rerender();
    }
  }
  function watchRefresh(id, job) {
    s.refreshing[id] = job;
    rerender();
    const tick = async () => {
      const j = await call('bank.refreshStatus', { accountId: id }).catch(() => null);
      if (!j || j.state === 'done' || j.state === 'failed') {
        delete s.refreshing[id];
        if (j?.state === 'done') tell(j.result?.newCount ? `새 거래 ${j.result.newCount}줄을 넣었어요.` : '새 거래가 없어요.', { extra: j.result?.match?.auto ? `자동으로 맞춘 입금 ${j.result.match.auto}건` : null });
        else if (j?.state === 'failed') {
          if (j.code === 'source.too_soon') tell(soonText(j.retryAt));
          else if (j.code === 'source.daily_limit') tell(DAILY_TEXT);
          else tell(sourceErrText(j.code), { bad: true, retry: ['다시 시도', () => startRefresh(id)] });
        }
        await refresh();
        return;
      }
      s.refreshing[id] = j;
      rerender();
      setTimeout(tick, 1500);
    };
    setTimeout(tick, 1500);
  }
  function linkCell(x) {
    const job = s.refreshing[x.id];
    const chip = h('span', { class: `bank-link bank-link-${x.linkState}`, 'data-bank-link': x.linkState, title: x.linkState === 'auto_error' ? sourceErrText(x.linkError) : null }, LINK_LABEL[x.linkState] ?? '파일만');
    if (job) return h('td', {}, chip, h('span', { class: 'sx-meta', 'data-bank-refresh-state': job.state }, ` ${REFRESH_STEP[job.state] ?? '받는 중'}${job.jobs ? ` ${job.done ?? 0}/${job.jobs}` : ''}…`));
    return h('td', {}, chip, x.canRefresh ? btn('최신화', () => startRefresh(x.id), 'sx-btn-quiet', { 'data-act': 'bank-refresh' }) : null);
  }

  /** [계좌 추가]: 눌렀을 때만 폼(처음이면 동의 카드)을 연다 */
  const openAdd = () => {
    s.adding = { bank: '국민', number: '', alias: '' };
    s.formErr = null;
    rerender();
    focusLater('[data-bank-account-form] [data-field="number"]');
  };

  function accountsTab() {
    const list = s.data?.accounts ?? [];
    const a = s.adding;
    const consent = s.data?.consent;
    const cancel = () => ((s.adding = null), (s.formErr = null), rerender());
    const save = async () => {
      if (!checkFields(form)) return;
      const r = await act('bank.addAccount', { bank: a.bank, number: a.number, alias: a.alias || undefined }, undefined, 'account');
      if (r) {
        s.adding = null;
        tell(r.bank ? `${r.bank} ···${r.last4} 계좌를 등록했어요.` : '계좌를 등록했어요.', { ic: 'check', extra: '이제 [거래내역 파일 올리기]로 은행 거래내역을 넣을 수 있어요.' });
      }
      rerender();
    };
    const form = !a
      ? null
      : !consent
        ? h(
            'article',
            { class: 'sx-card', 'data-bank-consent': '', onkeydown: keys(null, cancel) },
            h('h2', { class: 'board-card-title' }, '계좌 거래내역을 이 PC에서만 맞춰요'),
            h('p', { class: 'sx-body-sm' }, '넣으신 거래내역과 계좌번호는 이 PC에 암호화해 저장해요. 우리 서버와 AI 모델로 보내지 않아요.'),
            h('p', { class: 'sx-body-sm' }, '거래내역에는 입금하신 분의 이름처럼 다른 사람의 정보도 들어 있어요. 사업 거래 확인에만 써 주세요.'),
            h('p', { class: 'sx-body-sm' }, '앱은 은행에 로그인하지 않아요(파일을 넣을 때). 돈을 보내거나 이체하지 않아요.'),
            h('p', { class: 'sx-body-sm' }, '언제든 받을 돈 > 내 계좌에서 계좌와 거래내역을 지울 수 있어요.'),
            formMsg('account'),
            h(
              'div',
              { class: 'sx-actions' },
              btn('동의하고 계좌 추가', async () => {
                if (!(await act('bank.consent', {}, undefined, 'account'))) return;
                rerender();
                focusLater('[data-bank-account-form] [data-field="number"]');
              }, 'sx-btn-primary', { 'data-act': 'bank-consent' }),
              btn('그만두기', cancel, 'sx-btn-quiet'),
            ),
          )
        : h(
            'div',
            { class: 'cp-form', 'data-bank-account-form': '', onkeydown: keys(save, cancel) },
            field({ label: '은행', error: errAt('account', 'bank'), input: selectInput(BANKS.map((b) => [b, b]), { value: a.bank, 'data-field': 'bank', onchange: (e) => (a.bank = e.target.value) }) }),
            field({ label: '계좌번호', error: errAt('account', 'number'), input: accountInput({ value: a.number, 'data-field': 'number', oninput: (e) => (a.number = e.target.value) }) }),
            field({ label: '부르는 이름(선택)', error: errAt('account', 'alias'), input: textInput({ value: a.alias, max: LIMITS.accountAlias, spellcheck: 'false', placeholder: '예: 주거래 국민', 'data-field': 'alias', oninput: (e) => (a.alias = e.target.value) }) }),
            formMsg('account'),
            h('div', { class: 'sx-actions' }, btn('저장', save, 'sx-btn-primary', { 'data-act': 'bank-account-save' }), btn('그만두기', cancel, 'sx-btn-quiet')),
          );
    const addBtn = (kind) => btn('계좌 추가', openAdd, kind, { 'data-act': 'bank-account-add' });
    /** [지우기]를 한 번 누르면 그 줄이 확인 줄로 바뀐다(창 confirm은 셸 창에서 막혀 있다) */
    const confirmRow = (x) => {
      const no = () => ((s.confirmDel = null), rerender());
      const yes = async () => {
        s.confirmDel = null;
        if (await act('bank.deleteAccount', { id: x.id })) {
          tell(`${x.bank} ···${x.last4} 계좌와 그 거래내역을 지웠어요.`, { ic: 'check' });
          rerender();
        }
      };
      return h(
        'tr',
        { class: 'is-on', 'data-bank-account': x.id, 'data-bank-account-confirm': '', onkeydown: keys(null, no) },
        h(
          'td',
          { colspan: 6 },
          h('div', { class: 'sx-actions' }, h('span', {}, `${x.bank} ···${x.last4} 계좌와 그 거래내역·맞춤을 지울까요?`), btn('지우기', yes, 'sx-btn-primary', { 'data-act': 'bank-account-delete-yes' }), btn('그만두기', no, 'sx-btn-quiet', { 'data-act': 'bank-account-delete-no' })),
          h('div', { class: 'sx-meta' }, '그 입금으로 받음이 된 건은 못 받음으로 돌아가요.'),
        ),
      );
    };
    const row = (x) =>
      s.confirmDel === x.id
        ? confirmRow(x)
        : h(
            'tr',
            { 'data-bank-account': x.id },
            h('td', {}, x.bank),
            h('td', { class: 'sx-id', 'data-bank-number': x.id }, `···${x.last4}`),
            h('td', {}, x.alias ?? '—'),
            h('td', {}, x.lastDay ? `${x.txnCount}줄 · ${md(x.lastDay)}까지` : '아직 없음'),
            linkCell(x),
            h(
              'td',
              {},
              h(
                'div',
                { class: 'sx-actions' },
                btn('보기', async (e) => {
                  const cell = e.target.closest('tr').querySelector('[data-bank-number]');
                  const r = await call('bank.revealAccount', { id: x.id }).catch(() => null);
                  if (!r?.number) return;
                  cell.textContent = r.number;
                  setTimeout(() => (cell.textContent = `···${x.last4}`), 3000);
                }, 'sx-btn-quiet'),
                btn('지우기', () => {
                  s.confirmDel = x.id;
                  rerender();
                  focusLater('[data-act="bank-account-delete-no"]');
                }, 'sx-btn-quiet', { 'data-act': 'bank-account-delete' }),
              ),
            ),
          );
    return h(
      'div',
      {},
      list.length ? table([['은행'], ['계좌'], ['이름'], ['거래내역'], ['연결'], ['']], list.map(row)) : a ? null : h('div', { class: 'empty' }, h('div', {}, '등록한 계좌가 없어요. 계좌를 추가하면 거래내역 파일을 올릴 수 있어요.'), h('div', {}, addBtn('sx-btn-primary'))),
      form ?? (list.length ? h('div', { class: 'sx-actions' }, addBtn('')) : null),
      h('p', { class: 'sx-meta rs-foot' }, list.some((x) => x.linkState !== 'file_only') ? '자동 연결된 계좌는 [최신화]로 새 거래를 받아요. 다른 계좌는 은행에서 거래내역을 엑셀이나 CSV로 내려받아 올려 주세요. 계좌번호는 끝 4자리만 보여요.' : '은행 인터넷뱅킹·앱에서 거래내역을 엑셀이나 CSV로 내려받아 올려 주세요. 파일을 넣을 때 앱은 은행에 접속하지 않아요. 계좌번호는 끝 4자리만 보여요.'),
    );
  }

  function importTab() {
    const p = s.preview;
    if (!p) return h('div', { class: 'empty' }, '올린 파일이 없어요.');
    const accounts = s.data?.accounts ?? [];
    const cancel = async () => {
      s.preview = null;
      s.tab = 'unpaid';
      s.formErr = null;
      await call('bank.cancelStatement').catch(() => {});
      rerender();
    };
    const roleSel = (i, name) => {
      const cur = Object.entries(s.cols).find(([r, v]) => r !== 'headerRow' && v === i)?.[0] ?? '';
      return h(
        'select',
        {
          class: 'doc-in',
          'data-col': String(i),
          'aria-label': `${name} 열은 무엇인가요`,
          onchange: async (e) => {
            for (const [r, v] of Object.entries(s.cols)) if (v === i && r !== 'headerRow') delete s.cols[r];
            if (e.target.value) s.cols[e.target.value] = i;
            await repreview();
          },
        },
        h('option', { value: '' }, '쓰지 않음'),
        ...Object.entries(ROLE_LABEL).map(([r, label]) => h('option', { value: r, selected: cur === r }, label)),
      );
    };
    return h(
      'article',
      { class: 'sx-card', 'data-bank-preview': '', onkeydown: keys(null, cancel) },
      h('h2', { class: 'board-card-title' }, p.ok ? `${p.bankHint ?? ''} 거래내역 · ${p.period.from ? `${md(p.period.from)}~${md(p.period.to)}` : ''} · 입금 ${p.totals.inCount}줄 · 출금 ${p.totals.outCount}줄` : '열을 알아보지 못했어요. 각 열이 무엇인지 골라 주세요.'),
      p.skipped ? h('p', { class: 'sx-meta' }, `날짜·금액을 읽지 못해 뺀 줄 ${p.skipped}줄`) : null,
      field({ label: '어느 계좌의 거래내역인가요?', input: selectInput(accounts.map((a) => [a.id, `${a.bank} ···${a.last4}${a.alias ? ` ${a.alias}` : ''}`]), { value: s.previewAccount, compact: true, 'data-field': 'account', onchange: (e) => (s.previewAccount = e.target.value) }) }),
      p.accountLast4 && !accounts.some((a) => a.last4 === p.accountLast4) ? note(`파일의 계좌 끝자리(···${p.accountLast4})와 같은 등록 계좌가 없어요. 맞는 계좌인지 확인해 주세요.`, true) : null,
      h(
        'div',
        { class: 'list-box' },
        h(
          'table',
          { class: 'list bank-cols' },
          h('thead', {}, h('tr', {}, ...p.headers.map((hd, i) => h('th', {}, h('label', {}, h('div', { class: 'sx-meta' }, hd || `${i + 1}열`), roleSel(i, hd || `${i + 1}열`)))))),
          h('tbody', {}, ...p.sample.map((r) => h('tr', {}, ...p.headers.map((_, i) => h('td', {}, r[i] ?? ''))))),
        ),
      ),
      formMsg('import'),
      h('div', { class: 'sx-actions' }, btn(s.busy ? '넣는 중…' : '넣고 맞추기', commitStatement, 'sx-btn-primary', { 'data-act': 'bank-commit', disabled: !p.ok || s.busy }), btn('그만두기', cancel, 'sx-btn-quiet')),
      h('p', { class: 'sx-meta' }, '파일은 이 PC에서만 읽어요. 내용은 우리 서버와 AI 모델로 보내지 않아요. 고친 열은 다음에 같은 서식 파일에 그대로 써요.'),
    );
  }

  function view() {
    const d = s.data;
    const sum = d?.summary;
    const unpaid = d?.unpaid ?? [];
    const toAccounts = () => {
      s.tab = 'accounts';
      s.sel = null;
      s.detail = null;
      openAdd();
    };
    return h(
      'section',
      { class: 'rail-screen', 'data-view': 'bank', 'data-screen': 'D-09' },
      head(),
      noticeBar(),
      undoBar(),
      offerBar(),
      sum?.stale && sum?.hasAccounts && unpaid.length ? note(sum.latestDay ? `거래내역이 ${md(sum.latestDay)}까지만 있어요. 새 거래내역을 올리면 "못 받음"이 맞는지 다시 볼게요.` : '거래내역을 올리기 전이라 입금 여부를 확인하지 못했어요.', true) : null,
      // 계좌가 없으면 할 일은 하나(계좌 등록). 내 계좌 탭에서는 빈 상태가 같은 말을 하므로 그리지 않는다.
      sum && !sum.hasAccounts && s.tab !== 'accounts' ? bar('먼저 내 계좌를 등록해 주세요. 파일로 쓰면 은행 로그인 정보를 받지 않아요.', { action: btn('계좌 등록하기', toAccounts, 'sx-btn-quiet', { 'data-act': 'bank-go-accounts' }) }) : null,
      d || s.preview ? h('div', { class: 'filters', role: 'group', 'aria-label': '받을 돈 탭' }, tabBtn('unpaid', '못 받은 돈', unpaid.length), tabBtn('received', '받은 돈', d?.received?.length), tabBtn('review', '확인할 입금', d?.review?.length), tabBtn('accounts', '내 계좌', d?.accounts?.length), s.preview ? tabBtn('import', '올린 파일') : null) : null,
      !d && !s.notice?.load ? h('div', { class: 'empty' }, '불러오는 중…') : null,
      d && s.tab === 'unpaid' ? [sum.overdueCount ? h('p', { class: 'sx-body-sm', 'data-bank-overdue': '' }, `기한 지난 받을 돈 ${sum.overdueCount}건 · ${won(sum.overdueTotal)}`) : null, recvList(unpaid, '못 받은 돈이 없어요.'), detailCard()] : null,
      d && s.tab === 'received' ? [recvList(d.received, '아직 받은 돈이 없어요.'), detailCard()] : null,
      d && s.tab === 'review' ? reviewList() : null,
      d && s.tab === 'accounts' ? accountsTab() : null,
      s.tab === 'import' ? importTab() : null,
      h('p', { class: 'sx-meta rs-foot' }, '받기로 한 날은 기본 작성일 + 30일이에요. 거래처마다 거래처 화면에서 바꿀 수 있어요. 맞추기는 이 PC 안에서 정해진 규칙으로만 해요.'),
    );
  }

  // ---- 거래처 상세: 계좌·입금자 이름·결제 조건 ----

  const cpCache = new Map();
  function cpSection(c) {
    const box = h('div', { class: 'bank-cp', 'data-bank-cp': c.id }, h('div', { class: 'sx-panel-sec' }, '계좌 · 입금자 이름'));
    // 상세 패널은 보는 자리다. 더하는 폼은 [계좌 더하기]·[입금자 이름 더하기]를 눌렀을 때만 연다(빈 폼을 늘 펼쳐 두지 않는다, v2.0).
    let adding = null; // 'account' | 'alias' | null
    // 거절되어 다시 그려도 넣던 값이 남게 둔다(저장하거나 닫으면 비운다). formErr: { text, field }
    let vals = {};
    let formErr = null;
    const draw = (info) => {
      const accounts = info?.accounts ?? [];
      const aliases = info?.aliases ?? [];
      const terms = info?.terms;
      const termsKey = terms ? (terms.kind === 'days' ? `days:${terms.n}` : terms.kind === 'next_month_day' ? `next_month_day:${terms.d}` : terms.kind) : 'default';
      const termsSel = selectInput(
        [['default', '기본값(작성일 + 30일)'], ['days:60', '작성일 + 60일'], ['days:15', '작성일 + 15일'], ['next_month_day:10', '다음 달 10일'], ['month_end', '다음 달 말일'], ['none', '기한 없음']],
        { value: termsKey, compact: true, 'data-field': 'terms', 'aria-label': '받기로 한 날' },
      );
      termsSel.addEventListener('change', async () => {
        const [kind, n] = termsSel.value.split(':');
        await call('bank.setPayTerms', { counterpartyId: c.id, kind, n: n ? Number(n) : undefined }).catch(say);
        toast('결제 조건을 바꿨어요');
      });
      const close = () => ((adding = null), (formErr = null), (vals = {}), draw(cpCache.get(c.id)));
      const errAt = (f) => (formErr?.field === f ? formErr.text : null);
      const fail = (e, fallback) => {
        const code = errText(e);
        formErr = { text: ERR[code] ?? fallback, field: ERR_FIELD[code] ?? null };
      };
      const formLine = () => (formErr && !formErr.field ? h('p', { class: 'form-msg is-bad', role: 'alert' }, formErr.text) : null);
      const saved = () => ((adding = null), (formErr = null), (vals = {}), reload());
      let form = null;
      if (adding === 'account') {
        const bankSel = selectInput(BANKS.map((b) => [b, b]), { value: vals.bank, name: 'bank', compact: true, 'data-field': 'cp-bank', onchange: (e) => (vals.bank = e.target.value) });
        const num_ = accountInput({ value: vals.number, name: 'account', compact: true, 'data-field': 'cp-number', oninput: (e) => (vals.number = e.target.value) });
        const holder = textInput({ value: vals.holder, max: LIMITS.holder, name: 'holder', compact: true, 'data-field': 'cp-holder', oninput: (e) => (vals.holder = e.target.value) });
        const submit = async () => {
          if (!checkFields([num_, holder])) return;
          const r = await call('bank.addCpAccount', { counterpartyId: c.id, bank: bankSel.value, number: num_.value, holder: holder.value || undefined }).catch((e) => (fail(e, '저장하지 못했어요. 계좌번호를 확인해 주세요.'), null));
          if (!r) return draw(cpCache.get(c.id));
          toast(r.holderOffer ? `저장했어요. 예금주 '${r.holderOffer}' 이름으로 온 입금도 이 거래처로 봐요.` : '저장했어요. 이 PC에만 저장돼요.');
          saved();
        };
        form = h(
          'div',
          { class: 'cp-form', 'data-bank-cp-form': 'account', onkeydown: keys(submit, close) },
          field({ label: '은행', input: bankSel, error: errAt('bank') }),
          field({ label: '계좌번호', input: num_, error: errAt('number') }),
          field({ label: '예금주(선택)', input: holder, error: errAt('holder') }),
          formLine(),
          h('div', { class: 'sx-actions' }, btn('저장', submit, 'sx-btn-primary', { 'data-act': 'bank-cp-account-add' }), btn('그만두기', close, 'sx-btn-quiet')),
          h('p', { class: 'sx-meta' }, '거래처 계좌번호와 예금주는 입금을 알아보는 데만 써요. 이 PC에만 저장돼요.'),
        );
        setTimeout(() => (errAt('holder') ? holder : num_).focus(), 0);
      } else if (adding === 'alias') {
        const alias = textInput({ value: vals.alias, max: LIMITS.payer, required: '입금자 이름을 넣어 주세요.', name: 'alias', compact: true, 'data-field': 'cp-alias', oninput: (e) => (vals.alias = e.target.value) });
        const submit = async () => {
          if (!checkFields([alias])) return;
          const ok = await call('bank.addAlias', { counterpartyId: c.id, name: alias.value }).then(() => true, (e) => (fail(e, '저장하지 못했어요. 이름을 확인해 주세요.'), false));
          if (!ok) return draw(cpCache.get(c.id));
          saved();
        };
        form = h(
          'div',
          { class: 'cp-form', 'data-bank-cp-form': 'alias', onkeydown: keys(submit, close) },
          field({ label: '통장에 찍히는 입금자 이름', input: alias, error: errAt('alias') }),
          formLine(),
          h('div', { class: 'sx-actions' }, btn('저장', submit, 'sx-btn-primary', { 'data-act': 'bank-cp-alias-add' }), btn('그만두기', close, 'sx-btn-quiet')),
        );
        setTimeout(() => alias.focus(), 0);
      }
      const open = (k) => () => ((adding = k), (formErr = null), (vals = {}), draw(cpCache.get(c.id)));
      box.replaceChildren(
        h('div', { class: 'sx-panel-sec' }, '계좌 · 입금자 이름'),
        ...accounts.map((a) => h('div', { class: 'hist-row', 'data-bank-cp-account': a.id }, h('span', {}, `${a.bank ?? ''} ···${a.last4}`), h('span', { class: 'hist-what' }, a.holder ? `예금주 ${a.holder}` : ''), btn('지우기', async () => (await call('bank.deleteCpAccount', { id: a.id }).catch(say), reload()), 'sx-btn-quiet'))),
        ...aliases.map((a) => h('div', { class: 'hist-row', 'data-bank-alias': a.id }, h('span', {}, a.nameRaw), h('span', { class: 'hist-what sx-meta' }, a.source === 'manual' ? '직접 입력' : a.source === 'learned' ? '확인에서 배움' : '계좌 예금주'), btn('지우기', async () => (await call('bank.deleteAlias', { id: a.id }).catch(say), reload()), 'sx-btn-quiet'))),
        !accounts.length && !aliases.length && !form ? h('p', { class: 'sx-meta' }, '등록한 계좌와 입금자 이름이 없어요.') : null,
        form ?? h('div', { class: 'sx-actions' }, btn('계좌 더하기', open('account'), '', { 'data-act': 'bank-cp-account-open' }), btn('입금자 이름 더하기', open('alias'), '', { 'data-act': 'bank-cp-alias-open' })),
        h('div', { class: 'sx-panel-sec' }, '받기로 한 날'),
        termsSel,
      );
    };
    const reload = async () => {
      const info = await call('bank.cpBanking', { counterpartyId: c.id }).catch(() => null);
      cpCache.set(c.id, info);
      draw(info);
    };
    draw(cpCache.get(c.id));
    void reload();
    return box;
  }

  return { load, view, cpSection, openCounterparty, state: s, icon };
}
