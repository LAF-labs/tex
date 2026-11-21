import { btn, h, kv } from './shell-views.js';

const ERR = {
  account_required: '먼저 설정 > 기기 연결에서 로그인해 주세요.',
  'account.subscription_required': '무료 체험이 끝났어요. 구독하면 AI 기능을 다시 쓸 수 있어요.',
  'account.refund_unavailable': '청약철회 기간(결제 후 7일)이 지났거나 환불할 결제가 없어요.',
  'account.refund_failed': '환불을 처리하지 못했어요. 잠시 뒤 다시 해 주세요. 계속 안 되면 contact@laf-co.com으로 알려 주세요.',
  'account.billing_unavailable': '지금은 구독을 받을 수 없어요. 잠시 뒤 다시 해 주세요.',
  gesture_required: '버튼을 다시 눌러 주세요.',
  'policy.rate_limited': '요청이 많아요. 잠시 뒤에 다시 해 주세요.',
};
export const billingErrText = (code) => ERR[code] ?? (String(code).startsWith('net.') ? '연결하지 못했어요. 인터넷 연결을 확인해 주세요.' : '잠시 뒤에 다시 해 주세요.');

const won = (n) => `${Number(n).toLocaleString('ko-KR')}원`;
const day = (ms) => {
  const d = new Date(ms + 9 * 3600_000);
  return `${d.getUTCFullYear()}년 ${d.getUTCMonth() + 1}월 ${d.getUTCDate()}일`;
};

export function createBilling(ctx) {
  const s = { loading: false, view: null, err: null, msg: null, confirm: null, busy: false };
  const set = (p) => {
    Object.assign(s, p);
    ctx.rerender();
  };
  const code = (e) => ctx.errText(e);

  async function load() {
    set({ loading: true, err: null });
    try {
      set({ view: await ctx.call('billing.view', {}), loading: false });
    } catch (e) {
      set({ loading: false, err: code(e) });
    }
  }
  async function act(method, done) {
    if (s.busy) return;
    set({ busy: true, err: null, msg: null });
    try {
      const r = await ctx.call(method, {});
      set({ busy: false, confirm: null, msg: done(r), view: r && r.entitlement ? r : s.view });
    } catch (e) {
      set({ busy: false, confirm: null, err: code(e) });
    }
  }
  const subscribe = () => act('billing.subscribe', () => '브라우저에서 결제 창을 열었어요. 카드를 등록한 뒤 [새로 보기]를 눌러 주세요.');
  const cancel = () => act('billing.cancel', (r) => (r?.subscription?.renewAt && r.entitlement?.state === 'paid' ? `해지했어요. ${day(r.subscription.renewAt)}까지 쓸 수 있고 더 결제되지 않아요. 확인 메일을 보냈어요.` : '해지했어요. 더 결제되지 않아요. 확인 메일을 보냈어요.'));
  const refund = () => act('billing.refund', (r) => `${won(r.refundedKrw)}을 환불 요청했어요. 카드사에 따라 3~7일 걸려요. 접수 메일을 보냈어요.`);

  function status(v) {
    const e = v.entitlement;
    const sub = v.subscription;
    const rows = [];
    const live = sub && (sub.status === 'active' || sub.status === 'past_due');
    if (live && e.state === 'trial') rows.push(['상태', '무료 체험 중, 카드 등록됨'], ['첫 결제', `${sub.renewAt ? day(sub.renewAt) : '체험이 끝나는 날'}, ${won(sub.amountKrw)}`]);
    else if (e.state === 'trial') rows.push(['상태', '무료 체험 중'], ['체험 끝', e.until ? `${day(e.until)} (이후 AI 기능은 구독해야 써요)` : '-']);
    else if (sub?.status === 'past_due') rows.push(['상태', '결제 실패'], ['안내', '카드 결제가 안 됐어요. 다시 시도하고, 계속 안 되면 다른 카드로 다시 등록해 주세요.']);
    else if (sub?.status === 'active') rows.push(['상태', '구독 중'], ['다음 결제', `${sub.renewAt ? day(sub.renewAt) : '-'}, ${won(sub.amountKrw)}`]);
    else if (sub?.status === 'canceled' && e.state === 'paid') rows.push(['상태', '해지함'], ['쓸 수 있는 날', `${e.until ? day(e.until) : '-'}까지, 더 결제되지 않아요`]);
    else rows.push(['상태', '구독 안 함'], ['안내', '무료 체험이 끝났어요. 구독하면 AI 기능을 다시 써요.']);
    return h('div', { 'data-billing-status': sub?.status ?? e.state }, kv(rows));
  }

  function actions(v) {
    const sub = v.subscription;
    const live = sub && (sub.status === 'active' || sub.status === 'past_due');
    const out = [];
    if (s.confirm === 'cancel')
      return h('div', { class: 'sx-actions', 'data-billing-confirm': 'cancel' }, h('p', { class: 'sx-body-sm' }, v.entitlement.state === 'trial' ? '해지하면 결제되지 않아요. 체험 끝날 때까지는 그대로 써요.' : '해지하면 다음 결제가 없어요. 이미 낸 기간까지는 그대로 써요.'), btn('해지하기', cancel, 'sx-btn-primary', { disabled: s.busy }), btn('그대로 둘게요', () => set({ confirm: null }), 'sx-btn-quiet'));
    if (s.confirm === 'refund' && sub?.refund)
      return h('div', { class: 'sx-actions', 'data-billing-confirm': 'refund' }, h('p', { class: 'sx-body-sm' }, `청약철회하면 구독이 바로 끝나고 ${won(sub.refund.amountKrw)}을 돌려받아요(쓴 날만큼 빼요).`), btn('환불받고 끝내기', refund, 'sx-btn-primary', { disabled: s.busy }), btn('그대로 둘게요', () => set({ confirm: null }), 'sx-btn-quiet'));
    if (!live) out.push(btn(sub?.status === 'canceled' && v.entitlement.state === 'paid' ? '다시 구독하기' : '구독하기', subscribe, 'sx-btn-primary', { disabled: s.busy, 'data-billing': 'subscribe' }));
    if (sub?.status === 'past_due') out.push(btn('다른 카드로 등록', subscribe, 'sx-btn-primary', { disabled: s.busy, 'data-billing': 'subscribe' }));
    if (live) out.push(btn('해지', () => set({ confirm: 'cancel', msg: null }), 'sx-btn-quiet', { 'data-billing': 'cancel' }));
    if (sub?.refund) out.push(btn(`청약철회(${day(sub.refund.refundableUntil)}까지)`, () => set({ confirm: 'refund', msg: null }), 'sx-btn-quiet', { 'data-billing': 'refund' }));
    out.push(btn('새로 보기', () => void load(), 'sx-btn-quiet', { 'data-billing': 'reload' }));
    return h('div', { class: 'sx-actions' }, out);
  }

  function view() {
    const intro = h('div', { class: 'set-intro' }, h('h2', { class: 'sx-card-title' }, '구독'), h('p', { class: 'sx-body-sm is-muted' }, '월 19,900원(부가세 포함). 가입하고 1달은 무료 체험이에요. 체험 중에는 하루 사용량에 한도가 있고 매일 새벽 4시에 다시 채워져요.'));
    const v = s.view;
    const body = !v
      ? h('article', { class: 'sx-card', 'data-billing': s.loading ? 'loading' : 'empty' }, h('p', { class: 'sx-body-sm is-muted' }, s.loading ? '불러오는 중이에요' : '구독 상태를 불러오지 못했어요.'), s.loading ? null : btn('다시 시도', () => void load(), 'sx-btn-quiet'))
      : h('article', { class: 'sx-card', 'data-billing': 'card' }, status(v), actions(v));
    return h(
      'div',
      { class: 'set-body', 'data-billing-root': '' },
      intro,
      body,
      s.msg ? h('p', { class: 'sx-body-sm', role: 'status', 'data-billing-msg': '' }, s.msg) : null,
      s.err ? h('p', { class: 'sx-note is-attention', role: 'alert', 'data-billing-err': s.err }, billingErrText(s.err)) : null,
    );
  }
  return { load, view };
}
