// 받을 돈(09 D-09) 화면: 못 받은 돈 · 받은 돈 · 확인할 입금 · 내 계좌. 거래처 상세의 계좌·입금자 이름 칸, 대화 답 카드.
// 값(거래처·금액·입금자명)은 main이 엔진 로컬 조회로 준 것을 그대로 그린다. 계산·판정은 하지 않는다(엔진 몫).
// 모든 고치기는 한 번 누르면 되고, 10초 동안 [되돌리기]가 뜬다(그 뒤에도 건 상세 기록에서 되돌린다, 09 §7.5).
import { btn, h, icon, kv, note, num } from './shell-views.js';

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
  'source.not_linked': '이 계좌는 자동 연결이 안 돼 있어요. 거래내역 파일을 올려 주세요.',
  'source.not_available': '자동 연결을 지금 쓸 수 없어요. 거래내역 파일을 올려 주세요.',
};
/** 원천 연결 상태(원천 이름은 쓰지 않는다) */
const LINK_LABEL = { file_only: '파일만', auto_connected: '자동 연결됨', auto_error: '자동 오류' };
const SOURCE_ERR = {
  'source.login_failed': '은행 로그인이 안 됐어요. 인증서를 확인해 주세요.',
  'source.cert_expired': '인증서 기간이 끝났어요. 새 인증서로 다시 연결해 주세요.',
  'source.needs_user': '은행에서 확인이 필요해요. 다시 연결해 주세요.',
  'source.rate_limited': '잠시 뒤에 다시 해 주세요.',
  'source.unsupported_bank': '이 은행은 아직 자동 조회를 못 해요. 파일을 올려 주세요.',
};
const sourceErrText = (code) => SOURCE_ERR[code] ?? '최신화하지 못했어요. 이미 넣은 거래내역은 그대로예요. 다시 해 주세요.';
const REFRESH_STEP = { requested: '요청함', waiting: '은행 응답 기다리는 중', running: '받는 중' };

function statusText(v) {
  if (v.status === 'received') return v.via === 'auto' ? '받음 · 자동' : v.offAccount ? `받음 · 직접(${METHOD_LABEL[v.offAccount]})` : '받음 · 직접';
  return { unpaid: '못 받음', unknown: '확인 못 함', partial: '일부 받음', waiting: '기다리는 중', excluded: '목록에서 뺌' }[v.status];
}
const dueText = (v) => (v.dueIn === null ? '기한 없음' : v.dueIn < 0 ? `${-v.dueIn}일 지남` : v.dueIn === 0 ? '오늘' : `D-${v.dueIn}`);

export function createBankScreen({ call, toast, rerender, errText, counterparties, openCounterparty }) {
  const s = {
    tab: 'unpaid',
    data: null,
    loading: false,
    sel: null, // 고른 건 id
    detail: null,
    form: null, // { kind: 'received'|'promise'|'exclude', ... }
    preview: null, // 거래내역 미리보기(main)
    cols: null, // 열 고르기(사람이 고친 것)
    previewAccount: null,
    adding: null, // 계좌 추가 입력 { bank, number, alias, consent }
    offer: null, // 별칭 제안 { name, counterpartyId, cpName }
    assign: null, // [거래처 지정] 연 입금 id
    undo: null, // { seq, text, until }
    busy: false,
    invoiceResult: null,
    refreshing: {}, // 계좌 id → 최신화 진행(엔진 RefreshJob)
  };
  const say = (e) => toast(ERR[errText(e)] ?? '처리하지 못했어요. 다시 해 주세요.');

  async function load() {
    s.loading = true;
    try {
      s.data = await call('bank.overview');
      for (const a of s.data?.accounts ?? []) if (a.refresh && !['done', 'failed'].includes(a.refresh.state) && !s.refreshing[a.id]) watchRefresh(a.id, a.refresh);
      if (s.sel) s.detail = await call('bank.receivable', { id: s.sel }).catch(() => null);
    } catch (e) {
      say(e);
    } finally {
      s.loading = false;
    }
  }
  const refresh = async () => {
    await load();
    rerender();
  };
  /** 고치기 하나: 부르고 → 되돌리기 띠(10초) → 다시 읽기 */
  async function act(method, params, text) {
    if (s.busy) return null;
    s.busy = true;
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
      return r;
    } catch (e) {
      say(e);
      return null;
    } finally {
      s.busy = false;
      await refresh();
    }
  }
  async function undoNow() {
    const u = s.undo;
    s.undo = null;
    if (!u) return;
    try {
      for (const seq of [...u.seqs].reverse()) await call('bank.undo', { seq });
      toast('되돌렸어요');
    } catch (e) {
      say(e);
    }
    await refresh();
  }

  // ---- 파일 올리기 ----

  async function pickStatement() {
    try {
      const p = await call('bank.pickStatement');
      if (!p) return;
      s.preview = p;
      s.cols = { ...p.mapping };
      s.previewAccount = p.suggestedAccountId ?? s.data?.accounts?.[0]?.id ?? null;
      s.tab = 'import';
    } catch (e) {
      say(e);
    }
    rerender();
  }
  async function repreview() {
    try {
      s.preview = await call('bank.previewStatement', { token: s.preview.token, columns: s.cols });
    } catch (e) {
      say(e);
      if (errText(e) === 'preview_expired') s.preview = null;
    }
    rerender();
  }
  async function commitStatement() {
    if (!s.previewAccount) return toast('어느 계좌의 거래내역인지 골라 주세요.');
    s.busy = true;
    try {
      const r = await call('bank.commitStatement', { token: s.preview.token, accountId: s.previewAccount, columns: s.cols });
      s.preview = null;
      s.tab = r.match.review || r.match.unknown ? 'review' : 'unpaid';
      toast(`새 줄 ${r.newCount}줄${r.duplicateCount ? ` · 이미 있던 줄 ${r.duplicateCount}줄` : ''} · 자동으로 붙임 ${r.match.auto}건 · 확인할 후보 ${r.match.review}건 · 누가 보낸지 모르는 입금 ${r.match.unknown}건`);
    } catch (e) {
      say(e);
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
      if (!r.ok) toast('발급 목록 칸(작성일자·승인번호·합계금액)을 찾지 못했어요. 홈택스 [내려받기] 파일인지 확인해 주세요.');
      else toast(`세금계산서 ${r.rows}건을 읽었어요 · 새 건 ${r.created} · 이미 있던 건 ${r.merged}${r.purchase ? ` · 매입 ${r.purchase}건은 아직 받지 않아요` : ''}`);
    } catch (e) {
      say(e);
    }
    await refresh();
  }

  // ---- 그리기 ----

  const tabBtn = (key, label, n) => h('button', { type: 'button', class: s.tab === key ? 'is-on' : null, 'aria-pressed': String(s.tab === key), 'data-bank-tab': key, onclick: () => ((s.tab = key), (s.sel = null), (s.detail = null), rerender()) }, label, n ? ` ${n}` : '');

  function head() {
    const sum = s.data?.summary;
    const basis = !sum ? '' : sum.latestDay ? `거래내역 ${md(sum.latestDay)}까지 반영` : '거래내역을 아직 올리지 않았어요';
    return h(
      'div',
      { class: 'rs-head' },
      h('h1', { class: 'title-screen' }, '받을 돈'),
      h('span', { class: 'sx-meta', 'data-bank-basis': '' }, basis, sum?.stale && sum?.latestDay ? ' · 오래됐어요' : ''),
      h(
        'div',
        { class: 'rs-right' },
        btn('거래내역 파일 올리기', pickStatement, 'sx-btn-primary', { 'data-act': 'bank-statement', disabled: !s.data?.accounts?.length }),
        btn('홈택스 발급목록 파일 올리기', pickInvoices, '', { 'data-act': 'bank-invoices' }),
      ),
    );
  }

  function undoBar() {
    if (!s.undo || Date.now() >= s.undo.until) return null;
    return h('div', { class: 'sx-note', 'data-bank-undo': '' }, h('div', {}, s.undo.text), btn('되돌리기', undoNow, '', { 'data-act': 'bank-undo' }));
  }

  function offerBar() {
    const o = s.offer;
    if (!o) return null;
    const close = () => ((s.offer = null), rerender());
    if (o.conflict) return h('div', { class: 'sx-note', 'data-bank-offer': '' }, h('div', {}, `'${o.name}'는 다른 거래처 입금자 이름이기도 해서 기억하지 않았어요.`), btn('닫기', close));
    return h(
      'div',
      { class: 'sx-note', 'data-bank-offer': '' },
      h('div', {}, `다음부터 '${o.name}' 입금은 ${o.cpName ?? '이 거래처'}로 볼까요?`),
      btn('기억하기', async () => {
        s.offer = null;
        await act('bank.addAlias', { counterpartyId: o.counterpartyId, name: o.name });
        toast('기억했어요');
      }, 'sx-btn-primary', { 'data-act': 'bank-alias-remember' }),
      btn('이번만', close, '', { 'data-act': 'bank-alias-once' }),
    );
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
    s.detail = s.sel ? await call('bank.receivable', { id: s.sel }).catch(() => null) : null;
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
    const formEl =
      form?.kind === 'received'
        ? h(
            'div',
            { class: 'bank-form', 'data-bank-form': 'received' },
            h('label', {}, h('span', { class: 'sx-meta' }, '방법'), h('select', { 'data-field': 'method', onchange: (e) => (form.method = e.target.value) }, ...['cash', 'other_account', 'offset', 'other', 'account'].map((m) => h('option', { value: m, selected: form.method === m }, METHOD_LABEL[m])))),
            h('label', {}, h('span', { class: 'sx-meta' }, '금액'), h('input', { type: 'number', 'data-field': 'amount', value: String(form.amount), oninput: (e) => (form.amount = Number(e.target.value)) })),
            h('label', {}, h('span', { class: 'sx-meta' }, '받은 날'), h('input', { type: 'date', 'data-field': 'on', value: form.on, oninput: (e) => (form.on = e.target.value) })),
            btn('받았음으로 표시', () => act('bank.markReceived', { receivableId: v.id, method: form.method, amount: form.amount, on: form.on }, '받았음으로 표시했어요').then(() => (s.form = null)), 'sx-btn-primary', { 'data-act': 'bank-mark-save' }),
            btn('취소', () => ((s.form = null), rerender())),
          )
        : form?.kind === 'promise'
          ? h('div', { class: 'bank-form' }, h('label', {}, h('span', { class: 'sx-meta' }, '약속일'), h('input', { type: 'date', value: form.on, oninput: (e) => (form.on = e.target.value) })), btn('기다리는 중으로', () => act('bank.setPromised', { receivableId: v.id, on: form.on }, '기다리는 중으로 바꿨어요').then(() => (s.form = null)), 'sx-btn-primary'), btn('취소', () => ((s.form = null), rerender())))
          : form?.kind === 'exclude'
            ? h(
                'div',
                { class: 'bank-form' },
                h('select', { onchange: (e) => (form.reason = e.target.value) }, ...['받지 않기로 함', '거래 취소', '기타'].map((r) => h('option', { value: r }, r))),
                btn('목록에서 빼기', () => act('bank.exclude', { receivableId: v.id, reason: form.reason }, '목록에서 뺐어요').then(() => (s.form = null)), 'sx-btn-primary'),
                btn('취소', () => ((s.form = null), rerender())),
                h('p', { class: 'sx-meta' }, '세무 처리(대손 등)는 앱이 판단하지 않아요. 세무사와 상의하세요.'),
              )
            : null;
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
        ['원천', v.sources.map((x) => (x === 'ledger' ? '앱 발급' : '홈택스 목록')).join(' · ')],
      ]),
      h('div', { class: 'sx-panel-sec' }, '붙은 입금'),
      allocs.length
        ? h('ul', { class: 'bank-allocs' }, ...allocs.map((a) => h('li', { 'data-bank-alloc': a.id }, a.txn ? `${md(a.txn.day)} ${won(a.amount)} · ${a.txn.payer ?? '이름 없음'} · ···${a.txn.accountLast4}` : `${METHOD_LABEL[a.method]} ${won(a.amount)}${a.receivedOn ? ` · ${md(a.receivedOn)}` : ''}`, a.decidedBy === 'auto' ? h('span', { class: 'sx-tag' }, '자동') : null, btn('떼기', () => act('bank.detach', { allocId: a.id }, '뗐어요'), '', { 'data-act': 'bank-detach' }))))
        : h('div', { class: 'sx-meta' }, '아직 붙은 입금이 없어요.'),
      open
        ? h(
            'div',
            { class: 'sx-actions' },
            btn('받았음 표시', () => ((s.form = { kind: 'received', method: 'cash', amount: v.remaining, on: today }), rerender()), 'sx-btn-primary', { 'data-act': 'bank-mark' }),
            v.remaining > 0 && v.remaining <= 1000 && v.received > 0 ? btn('차액은 수수료로 닫기', () => act('bank.closeFee', { receivableId: v.id }, '차액을 수수료로 닫았어요')) : null,
            btn('기다리는 중으로', () => ((s.form = { kind: 'promise', on: today }), rerender())),
            btn('목록에서 빼기', () => ((s.form = { kind: 'exclude', reason: '받지 않기로 함' }), rerender())),
          )
        : v.status === 'excluded'
          ? h('div', { class: 'sx-actions' }, btn('목록에 되살리기', () => act('bank.exclude', { receivableId: v.id, reason: null }, '되살렸어요')))
          : null,
      formEl,
      open && d.attachable.length
        ? h(
            'div',
            {},
            h('div', { class: 'sx-panel-sec' }, '입금 붙이기'),
            h('ul', { class: 'bank-attach' }, ...d.attachable.slice(0, 10).map((t) => h('li', { 'data-bank-attach': t.id }, `${md(t.day)} ${won(t.unallocated)} · ${t.payer ?? '이름 없음'}`, t.candidates.length ? h('span', { class: 'sx-tag' }, '후보') : null, btn('이 입금 붙이기', () => attach(t, v), '', { 'data-act': 'bank-attach' })))),
          )
        : null,
      h('div', { class: 'sx-panel-sec' }, '기록'),
      h('ul', { class: 'bank-events' }, ...d.events.map((e) => h('li', {}, `${e.at.slice(5, 16).replace('T', ' ')} · ${e.actor === 'auto' ? '자동' : '사장님'} · ${ACTION_LABEL[e.action] ?? e.action}`, e.undoOf === null && !e.undone && e.action !== 'undo' ? btn('되돌리기', () => act('bank.undo', { seq: e.seq }, '되돌렸어요'), '', { 'data-act': 'bank-event-undo' }) : null))),
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
        const assigning = s.assign === t.id;
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
                    h('div', {}, h('b', {}, `→ ${c.cpName ?? '거래처'} ${md(c.writtenOn)} ${won(c.total)}?`), ' ', h('span', { class: 'sx-tag' }, FIT_LABEL[c.fit])),
                    h('div', { class: 'sx-meta' }, c.reason),
                    h(
                      'div',
                      { class: 'sx-actions' },
                      btn('맞아요', () => accept(t, c), i === 0 ? 'sx-btn-primary' : '', { 'data-act': 'bank-accept' }),
                      c.fit === 'fee' ? btn('맞아요 · 차액은 수수료로 닫기', () => accept(t, c, true), '', { 'data-act': 'bank-accept-fee' }) : null,
                      c.receivableIds.length === 1 ? btn('아니에요', () => act('bank.reject', { txnId: t.id, receivableId: c.receivableIds[0] }, '이 건이 아니라고 했어요'), '', { 'data-act': 'bank-reject' }) : null,
                    ),
                  ),
                ),
              )
            : h('div', { class: 'sx-meta' }, '누가 보낸지 모르는 입금이에요.'),
          assigning
            ? h(
                'div',
                { class: 'bank-form', 'data-bank-assign': t.id },
                h('select', { 'data-field': 'cp' }, ...cps.map((c) => h('option', { value: c.id }, c.name))),
                t.payer ? h('label', {}, h('input', { type: 'checkbox', 'data-field': 'remember', checked: true }), ` 다음부터 '${t.payer}' 입금은 이 거래처로`) : null,
                btn('이 거래처 입금으로', async (e) => {
                  const box = e.target.closest('[data-bank-assign]');
                  const counterpartyId = box.querySelector('[data-field="cp"]').value;
                  const remember = !!box.querySelector('[data-field="remember"]')?.checked;
                  s.assign = null;
                  const r = await act('bank.assignTxn', { txnId: t.id, counterpartyId, remember }, '거래처를 정했어요');
                  if (r?.conflict) s.offer = { name: t.payer, conflict: true };
                  rerender();
                }, 'sx-btn-primary', { 'data-act': 'bank-assign-save' }),
                btn('취소', () => ((s.assign = null), rerender())),
              )
            : h(
                'div',
                { class: 'sx-actions' },
                cps.length ? btn('이 거래처 입금으로', () => ((s.assign = t.id), rerender()), '', { 'data-act': 'bank-assign' }) : null,
                btn('상관없는 입금', () => act('bank.ignoreTxn', { txnId: t.id, reason: 'unrelated' }, '상관없는 입금으로 뺐어요'), '', { 'data-act': 'bank-ignore' }),
              ),
        );
      }),
    );
  }

  /** [최신화]: 원천 → 넣기 → 맞추기. 진행을 1.5초마다 본다 */
  async function startRefresh(id) {
    if (s.refreshing[id]) return;
    try {
      const job = await call('bank.refresh', { accountId: id });
      watchRefresh(id, job);
    } catch (e) {
      say(e);
    }
  }
  function watchRefresh(id, job) {
    s.refreshing[id] = job;
    rerender();
    const tick = async () => {
      const j = await call('bank.refreshStatus', { accountId: id }).catch(() => null);
      if (!j || j.state === 'done' || j.state === 'failed') {
        delete s.refreshing[id];
        if (j?.state === 'done') toast(j.result?.newCount ? `새 거래 ${j.result.newCount}줄을 넣었어요${j.result.match?.auto ? ` · 자동으로 맞춘 입금 ${j.result.match.auto}건` : ''}` : '새 거래가 없어요');
        else if (j?.state === 'failed') toast(sourceErrText(j.code));
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
    const chip = h('span', { class: `bank-link bank-link-${x.linkState}`, 'data-bank-link': x.linkState, title: x.linkState === 'auto_error' ? sourceErrText(x.linkError) : '' }, LINK_LABEL[x.linkState] ?? '파일만');
    if (job) return h('td', {}, chip, h('span', { class: 'sx-meta', 'data-bank-refresh-state': job.state }, ` ${REFRESH_STEP[job.state] ?? '받는 중'}${job.jobs ? ` ${job.done ?? 0}/${job.jobs}` : ''}…`));
    return h('td', {}, chip, x.canRefresh ? btn('최신화', () => startRefresh(x.id), '', { 'data-act': 'bank-refresh' }) : null);
  }

  function accountsTab() {
    const list = s.data?.accounts ?? [];
    const a = s.adding;
    const consent = s.data?.consent;
    const form = !a
      ? btn('계좌 추가', () => ((s.adding = { bank: '국민', number: '', alias: '' }), rerender()), 'sx-btn-primary', { 'data-act': 'bank-account-add' })
      : !consent
        ? h(
            'article',
            { class: 'sx-card', 'data-bank-consent': '' },
            h('h2', { class: 'board-card-title' }, '계좌 거래내역을 이 PC에서만 맞춰요'),
            h('p', { class: 'sx-body-sm' }, '넣으신 거래내역과 계좌번호는 이 PC에 암호화해 저장해요. 우리 서버와 AI 모델로 보내지 않아요.'),
            h('p', { class: 'sx-body-sm' }, '거래내역에는 입금하신 분의 이름처럼 다른 사람의 정보도 들어 있어요. 사업 거래 확인에만 써 주세요.'),
            h('p', { class: 'sx-body-sm' }, '앱은 은행에 로그인하지 않아요(파일을 넣을 때). 돈을 보내거나 이체하지 않아요.'),
            h('p', { class: 'sx-body-sm' }, '언제든 받을 돈 > 내 계좌에서 계좌와 거래내역을 지울 수 있어요.'),
            h('div', { class: 'sx-actions' }, btn('동의하고 계좌 추가', async () => (await act('bank.consent', {})) && rerender(), 'sx-btn-primary', { 'data-act': 'bank-consent' }), btn('취소', () => ((s.adding = null), rerender()))),
          )
        : h(
            'div',
            { class: 'bank-form', 'data-bank-account-form': '' },
            h('select', { 'data-field': 'bank', onchange: (e) => (a.bank = e.target.value) }, ...BANKS.map((b) => h('option', { value: b, selected: a.bank === b }, b))),
            h('input', { type: 'text', inputmode: 'numeric', autocomplete: 'off', placeholder: '계좌번호', 'data-field': 'number', value: a.number, oninput: (e) => (a.number = e.target.value) }),
            h('input', { type: 'text', placeholder: '부르는 이름(예: 주거래 국민)', 'data-field': 'alias', value: a.alias, oninput: (e) => (a.alias = e.target.value) }),
            btn('저장', async () => {
              const r = await act('bank.addAccount', { bank: a.bank, number: a.number, alias: a.alias || undefined });
              if (r) {
                s.adding = null;
                toast(`${r.bank} ···${r.last4} 계좌를 등록했어요`);
              }
              rerender();
            }, 'sx-btn-primary', { 'data-act': 'bank-account-save' }),
            btn('취소', () => ((s.adding = null), rerender())),
          );
    return h(
      'div',
      {},
      list.length
        ? table(
            [['은행'], ['계좌'], ['이름'], ['거래내역'], ['연결'], ['']],
            list.map((x) =>
              h(
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
                  btn('보기', async (e) => {
                    const cell = e.target.closest('tr').querySelector('[data-bank-number]');
                    const r = await call('bank.revealAccount', { id: x.id }).catch(() => null);
                    if (!r?.number) return;
                    cell.textContent = r.number;
                    setTimeout(() => (cell.textContent = `···${x.last4}`), 3000);
                  }),
                  btn('지우기', async () => {
                    if (!window.confirm(`${x.bank} ···${x.last4} 계좌와 그 거래내역·맞춤을 지울까요? 그 입금으로 받음이 된 건은 못 받음으로 돌아가요.`)) return;
                    await act('bank.deleteAccount', { id: x.id });
                  }),
                ),
              ),
            ),
          )
        : h('div', { class: 'empty' }, '등록한 계좌가 없어요. 계좌를 추가하면 거래내역 파일을 올릴 수 있어요.'),
      h('div', { class: 'sx-actions' }, form),
      h('p', { class: 'sx-meta rs-foot' }, list.some((x) => x.linkState !== 'file_only') ? '자동 연결된 계좌는 [최신화]로 새 거래를 받아요. 다른 계좌는 은행에서 거래내역을 엑셀이나 CSV로 내려받아 올려 주세요. 계좌번호는 끝 4자리만 보여요.' : '은행 인터넷뱅킹·앱에서 거래내역을 엑셀이나 CSV로 내려받아 올려 주세요. 파일을 넣을 때 앱은 은행에 접속하지 않아요. 계좌번호는 끝 4자리만 보여요.'),
    );
  }

  function importTab() {
    const p = s.preview;
    if (!p) return h('div', { class: 'empty' }, '올린 파일이 없어요.');
    const accounts = s.data?.accounts ?? [];
    const roleSel = (i) => {
      const cur = Object.entries(s.cols).find(([r, v]) => r !== 'headerRow' && v === i)?.[0] ?? '';
      return h(
        'select',
        {
          'data-col': String(i),
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
      { class: 'sx-card', 'data-bank-preview': '' },
      h('h2', { class: 'board-card-title' }, p.ok ? `${p.bankHint ?? ''} 거래내역 · ${p.period.from ? `${md(p.period.from)}~${md(p.period.to)}` : ''} · 입금 ${p.totals.inCount}줄 · 출금 ${p.totals.outCount}줄` : '열을 알아보지 못했어요. 각 열이 무엇인지 골라 주세요.'),
      p.skipped ? h('p', { class: 'sx-meta' }, `날짜·금액을 읽지 못해 뺀 줄 ${p.skipped}줄`) : null,
      h('label', {}, h('span', { class: 'sx-meta' }, '어느 계좌인가요? '), h('select', { 'data-field': 'account', onchange: (e) => (s.previewAccount = e.target.value) }, ...accounts.map((a) => h('option', { value: a.id, selected: s.previewAccount === a.id }, `${a.bank} ···${a.last4}${a.alias ? ` ${a.alias}` : ''}`)))),
      p.accountLast4 && !accounts.some((a) => a.last4 === p.accountLast4) ? note(`파일의 계좌 끝자리(···${p.accountLast4})와 같은 등록 계좌가 없어요. 맞는 계좌인지 확인해 주세요.`, true) : null,
      h('div', { class: 'list-box' }, h('table', { class: 'list bank-cols' }, h('thead', {}, h('tr', {}, ...p.headers.map((hd, i) => h('th', {}, h('div', { class: 'sx-meta' }, hd || `${i + 1}열`), roleSel(i))))), h('tbody', {}, ...p.sample.map((r) => h('tr', {}, ...p.headers.map((_, i) => h('td', {}, r[i] ?? ''))))))),
      h('div', { class: 'sx-actions' }, btn(s.busy ? '넣는 중…' : '넣고 맞추기', commitStatement, 'sx-btn-primary', { 'data-act': 'bank-commit', disabled: !p.ok || s.busy }), btn('취소', async () => ((s.preview = null), (s.tab = 'unpaid'), await call('bank.cancelStatement').catch(() => {}), rerender()))),
      h('p', { class: 'sx-meta' }, '파일은 이 PC에서만 읽어요. 내용은 우리 서버와 AI 모델로 보내지 않아요. 고친 열은 다음에 같은 서식 파일에 그대로 써요.'),
    );
  }

  function view() {
    const d = s.data;
    const sum = d?.summary;
    const unpaid = d?.unpaid ?? [];
    return h(
      'section',
      { class: 'rail-screen', 'data-view': 'bank', 'data-screen': 'D-09' },
      head(),
      undoBar(),
      offerBar(),
      sum?.stale && sum?.hasAccounts && unpaid.length ? note(sum.latestDay ? `거래내역이 ${md(sum.latestDay)}까지만 있어요. 새 거래내역을 올리면 "못 받음"이 맞는지 다시 볼게요.` : '거래내역을 올리기 전이라 입금 여부를 확인하지 못했어요.', true) : null,
      !sum?.hasAccounts ? note('먼저 내 계좌를 등록해 주세요. 파일로 쓰면 은행 로그인 정보를 받지 않아요.', false) : null,
      h('div', { class: 'filters', role: 'group', 'aria-label': '받을 돈 탭' }, tabBtn('unpaid', '못 받은 돈', unpaid.length), tabBtn('received', '받은 돈', d?.received?.length), tabBtn('review', '확인할 입금', d?.review?.length), tabBtn('accounts', '내 계좌', d?.accounts?.length), s.preview ? tabBtn('import', '올린 파일') : null),
      s.loading && !d ? h('div', { class: 'empty' }, '읽는 중…') : null,
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
    const draw = (info) => {
      const accounts = info?.accounts ?? [];
      const aliases = info?.aliases ?? [];
      const terms = info?.terms;
      const termsSel = h('select', { 'data-field': 'terms' }, ...[['default', '기본값(작성일 + 30일)'], ['days:60', '작성일 + 60일'], ['days:15', '작성일 + 15일'], ['next_month_day:10', '다음 달 10일'], ['month_end', '다음 달 말일'], ['none', '기한 없음']].map(([v, l]) => h('option', { value: v, selected: (terms ? (terms.kind === 'days' ? `days:${terms.n}` : terms.kind === 'next_month_day' ? `next_month_day:${terms.d}` : terms.kind) : 'default') === v }, l)));
      termsSel.addEventListener('change', async () => {
        const [kind, n] = termsSel.value.split(':');
        await call('bank.setPayTerms', { counterpartyId: c.id, kind, n: n ? Number(n) : undefined }).catch(say);
        toast('결제 조건을 바꿨어요');
      });
      const num_ = h('input', { type: 'text', inputmode: 'numeric', placeholder: '계좌번호', autocomplete: 'off', 'data-field': 'cp-number' });
      const holder = h('input', { type: 'text', placeholder: '예금주', 'data-field': 'cp-holder' });
      const bankSel = h('select', {}, ...BANKS.map((b) => h('option', { value: b }, b)));
      const alias = h('input', { type: 'text', placeholder: '입금자 이름(예: 김철수)', 'data-field': 'cp-alias' });
      box.replaceChildren(
        h('div', { class: 'sx-panel-sec' }, '계좌 · 입금자 이름'),
        ...accounts.map((a) => h('div', { class: 'hist-row', 'data-bank-cp-account': a.id }, h('span', {}, `${a.bank ?? ''} ···${a.last4}`), h('span', { class: 'hist-what' }, a.holder ? `예금주 ${a.holder}` : ''), btn('지우기', async () => (await call('bank.deleteCpAccount', { id: a.id }).catch(say), reload())))),
        h('div', { class: 'bank-form' }, bankSel, num_, holder, btn('계좌 더하기', async () => {
          const r = await call('bank.addCpAccount', { counterpartyId: c.id, bank: bankSel.value, number: num_.value, holder: holder.value || undefined }).catch((e) => (say(e), null));
          if (r) toast(r.holderOffer ? `저장했어요. 예금주 '${r.holderOffer}' 이름으로 온 입금도 이 거래처로 봐요.` : '저장했어요. 이 PC에만 저장돼요.');
          reload();
        }, '', { 'data-act': 'bank-cp-account-add' })),
        h('p', { class: 'sx-meta' }, '거래처 계좌번호와 예금주는 입금을 알아보는 데만 써요. 이 PC에만 저장돼요.'),
        ...aliases.map((a) => h('div', { class: 'hist-row', 'data-bank-alias': a.id }, h('span', {}, a.nameRaw), h('span', { class: 'sx-meta' }, a.source === 'manual' ? '직접 입력' : a.source === 'learned' ? '확인에서 배움' : '계좌 예금주'), btn('지우기', async () => (await call('bank.deleteAlias', { id: a.id }).catch(say), reload())))),
        h('div', { class: 'bank-form' }, alias, btn('입금자 이름 더하기', async () => (await call('bank.addAlias', { counterpartyId: c.id, name: alias.value }).catch(say), reload()), '', { 'data-act': 'bank-cp-alias-add' })),
        h('label', { class: 'bank-form' }, h('span', { class: 'sx-meta' }, '받기로 한 날'), termsSel),
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
