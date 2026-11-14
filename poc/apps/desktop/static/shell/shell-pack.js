// 세무사 꾸러미(D-05) 화면과 대화 꾸러미 카드. 값은 main(accountant-pack.ts)이 만든 요약을 그대로 그린다(글자는 텍스트 노드로만).
// 화면을 열면 고른 달 꾸러미를 바로 만든다(로컬 폴더·zip). [Finder에서 보기]·[보내기](macOS 공유 시트)는 사용자가 누른다.
import { btn, h, kv, note, num } from './shell-views.js';

const won = (n) => `${num(n)}원`;
const md = (d) => (d ? `${Number(d.slice(5, 7))}월 ${Number(d.slice(8, 10))}일` : '날짜 모름');
const GAP_LABEL = { unsure: '발급됐는지 확인 필요', no_pdf: 'PDF 없음', mail_unconfirmed: '메일 확인 못 함', not_issued: '발급 안 된 시도', no_bank: '계좌 연결 전이라 받을 돈이 빠졌어요' };
const MAIL_TEXT = { sent: '보냄', unconfirmed: '확인 못 함' };
const ERR = { pack_missing: '꾸러미를 다시 만들었어요. 한 번 더 눌러 주세요.', gesture_required: '버튼을 직접 눌러 주세요.' };

/** today(): KST YYYY-MM-DD. 지난달·이번 달 */
function months(today) {
  const y = Number(today.slice(0, 4));
  const m = Number(today.slice(5, 7));
  const last = m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`;
  return [
    ['last', last, `지난달 (${Number(last.slice(5))}월)`],
    ['this', today.slice(0, 7), `이번 달 (${m}월)`],
  ];
}

/** 빠진 것: 종류별로 묶어 한 줄씩(건이 많으면 거래처는 앞 몇 곳만) */
function gapLines(gaps) {
  const by = new Map();
  for (const g of gaps) by.set(g.kind, [...(by.get(g.kind) ?? []), g]);
  return [...by].map(([kind, list]) => {
    const who = list.filter((g) => g.who).map((g) => `${g.who} ${md(g.day)}`);
    const shown = who.slice(0, 3).join(', ') + (who.length > 3 ? ` 외 ${who.length - 3}건` : '');
    return { kind, text: kind === 'no_bank' ? GAP_LABEL[kind] : `${GAP_LABEL[kind]} ${list.length}건`, who: shown };
  });
}

export function createPackScreen({ call, toast, rerender, errText, today, railHead, listTable }) {
  const s = { month: null, data: null, busy: false, failed: false };

  async function make(month) {
    s.month = month;
    s.busy = true;
    s.failed = false;
    rerender();
    try {
      const r = await call('pack.make', { month });
      if (s.month === month) s.data = r;
    } catch {
      if (s.month === month) {
        s.failed = true;
        s.data = null;
      }
    } finally {
      if (s.month === month) s.busy = false;
      rerender();
    }
  }

  /** 꾸러미 화면을 연다(month 없으면 지난달). 대화 카드의 [꾸러미 열기]도 여기로 온다. */
  const load = (month) => make(month ?? s.month ?? months(today())[0][1]);

  async function fileAct(method, month) {
    try {
      const r = await call(method, { month });
      if (method === 'pack.share' && r?.via === 'folder') toast('파일을 보여 드렸어요. 메일에 붙여 보내 주세요.');
    } catch (e) {
      const c = errText(e);
      if (c === 'pack_missing') await make(month);
      toast(ERR[c] ?? '열지 못했어요. 다시 눌러 주세요.');
    }
  }
  const actions = (d) =>
    h(
      'div',
      { class: 'sx-actions' },
      btn('보내기', () => fileAct('pack.share', d.month), 'sx-btn-primary', { 'data-act': 'pack-share' }),
      btn('Finder에서 보기', () => fileAct('pack.reveal', d.month), '', { 'data-act': 'pack-reveal' }),
    );

  const summaryKv = (d) =>
    kv([
      ['세금계산서', `${d.totals.count}건`],
      ['공급가액', won(d.totals.supply)],
      ['세액', won(d.totals.tax)],
      ['합계', won(d.totals.total), { total: true }],
      ['증명서', `${d.certs.length}건`],
      ['받을 돈', d.receivables ? `${d.receivables.count}건 · ${won(d.receivables.total)}` : '계좌 연결 전'],
    ]);

  function gapsBox(d) {
    if (!d.gaps.length) return note('빠진 것이 없어요.', false, null, 'check');
    return h(
      'div',
      { class: 'pack-gaps', 'data-pack-gaps': String(d.gaps.length) },
      ...gapLines(d.gaps).map((g) => note(g.text, g.kind === 'unsure' || g.kind === 'no_pdf', g.who || null, 'info')),
    );
  }

  function view() {
    const opts = months(today());
    if (!s.month) s.month = opts[0][1];
    const d = s.data?.month === s.month ? s.data : null;
    const tab = ([key, month, label]) =>
      h('button', { type: 'button', class: s.month === month ? 'is-on' : null, 'aria-pressed': String(s.month === month), 'data-pack-month': key, onclick: () => s.month !== month && make(month) }, label);
    const meta = d ? `${d.label} · 세금계산서 ${d.totals.count}건` : s.busy ? '만드는 중…' : null;
    return h(
      'section',
      { class: 'rail-screen', 'data-view': 'bundle', 'data-screen': 'D-05', 'data-pack': d ? d.month : '' },
      h(
        'div',
        { class: 'rs-col' },
        railHead('세무사 꾸러미', meta),
        h('div', { class: 'filters', role: 'group', 'aria-label': '기간' }, opts.map(tab)),
        s.failed ? note('꾸러미를 만들지 못했어요.', true, null, 'info') : null,
        s.failed ? h('div', { class: 'sx-actions' }, btn('다시 만들기', () => make(s.month), 'sx-btn-primary', { 'data-act': 'pack-retry' })) : null,
        !d && !s.failed ? h('p', { class: 'sx-meta' }, '꾸러미를 만들고 있어요…') : null,
        d ? packBody(d) : null,
      ),
    );
  }

  function packBody(d) {
    return [
      h(
        'article',
        { class: 'sx-card pack-card', 'data-pack-summary': '' },
        h('div', { class: 'sx-card-hd' }, h('div', { class: 'sx-card-title' }, `${d.label} 꾸러미`), h('span', { class: 'sx-meta' }, d.zipName)),
        summaryKv(d),
        actions(d),
        h('p', { class: 'sx-meta' }, '[보내기]를 누르면 메일·메시지로 보낼 수 있어요. 파일은 이 PC에만 있어요.'),
      ),
      h('div', { class: 'rs-sec' }, h('h2', { class: 'sx-card-title' }, '빠진 것'), gapsBox(d)),
      h(
        'div',
        { class: 'rs-sec', 'data-pack-invoices': String(d.invoices.length) },
        h('h2', { class: 'sx-card-title' }, '발급한 세금계산서'),
        d.invoices.length
          ? listTable(
              [['작성일'], ['거래처'], ['공급가액', 'num'], ['세액', 'num'], ['승인번호'], ['메일'], ['PDF']],
              d.invoices.map((v) =>
                h(
                  'tr',
                  { 'data-pack-row': v.runId },
                  h('td', {}, md(v.day)),
                  h('td', { class: 'name' }, v.who ?? '—'),
                  h('td', { class: 'num' }, v.supply == null ? '—' : num(v.supply)),
                  h('td', { class: 'num' }, v.tax == null ? '—' : num(v.tax)),
                  h('td', { class: v.approvalNo ? 'sx-id' : 'is-none' }, v.approvalNo ?? '—'),
                  h('td', { class: v.mail === 'sent' ? null : 'is-attention' }, MAIL_TEXT[v.mail] ?? '기록 없음'),
                  h('td', { class: v.pdf ? null : 'is-attention' }, v.pdf ? '있음' : '없음'),
                ),
              ),
            )
          : h('p', { class: 'sx-meta' }, `${d.label}에 발급한 세금계산서가 없어요.`),
      ),
      h(
        'div',
        { class: 'rs-sec', 'data-pack-certs': String(d.certs.length) },
        h('h2', { class: 'sx-card-title' }, '증명서'),
        d.certs.length
          ? h('ul', { class: 'pack-files' }, ...d.certs.map((c) => h('li', {}, `${c.name} · ${md(c.issuedOn)}`, c.file ? null : h('span', { class: 'sx-meta' }, ' (PDF 없음)'))))
          : h('p', { class: 'sx-meta' }, `${d.label}에 뗀 증명서가 없어요.`),
      ),
      d.receivables
        ? h(
            'div',
            { class: 'rs-sec', 'data-pack-recv': String(d.receivables.count) },
            h('h2', { class: 'sx-card-title' }, '받을 돈 (만든 날 기준)'),
            d.receivables.count
              ? h('ul', { class: 'pack-files' }, ...d.receivables.rows.slice(0, 10).map((r) => h('li', {}, `${r.who} · ${md(r.writtenOn)} · ${r.remaining == null ? '금액 모름' : won(r.remaining)}`)))
              : h('p', { class: 'sx-meta' }, '못 받은 돈이 없어요.'),
          )
        : null,
      h(
        'details',
        { class: 'rs-sec pack-list' },
        h('summary', { class: 'sx-meta' }, `꾸러미에 든 파일 ${d.files.length}개`),
        h('ul', { class: 'pack-files sx-meta' }, ...d.files.map((f) => h('li', {}, f))),
      ),
    ];
  }

  /** 대화 답 카드: 요약·빠진 것 수·[꾸러미 열기]·[보내기]. 같은 달 화면으로 간다. */
  function chatCard(d, openScreen) {
    s.data = d;
    s.month = d.month;
    return h(
      'article',
      { class: 'sx-card pack-card', 'data-pack-chat': d.month },
      h('div', { class: 'sx-card-hd' }, h('div', { class: 'sx-card-title' }, `${d.label} 세무사 꾸러미`), h('span', { class: 'sx-meta' }, d.gaps.length ? `빠진 것 ${d.gaps.length}건` : '빠진 것 없음')),
      summaryKv(d),
      h(
        'div',
        { class: 'sx-actions' },
        btn('꾸러미 열기', () => openScreen(d.month), 'sx-btn-primary', { 'data-act': 'pack-open' }),
        btn('보내기', () => fileAct('pack.share', d.month), '', { 'data-act': 'pack-share' }),
      ),
    );
  }

  return { view, load, chatCard, select: (month) => (s.month = month) };
}
