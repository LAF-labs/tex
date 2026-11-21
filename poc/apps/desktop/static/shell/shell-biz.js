import { btn, fmtBiz, h, kv, note } from './shell-views.js';
import { bizDigits, bizNoInput, checkFields, emailInput, field, keys, LIMITS, textInput } from './fields.js';
export const BIZ_NO_CHANGE_NOTE = '사업자번호를 바꾸면 홈택스에 로그인한 사업자와 달라질 수 있어요. 다르면 발급 때 멈추고 알려 드려요.';
export const BIZ_NAME_MISSING_NOTE = '상호가 비어 있어요. 다음 발급 때 홈택스 화면에서 채워요. 지금 넣으려면 [수정]을 눌러 주세요.';
export const BIZ_EDIT_ERR = {
  name_required: '상호를 입력해 주세요.',
  bad_biz_no: '사업자번호가 맞지 않아요. 10자리를 다시 확인해 주세요.',
  bad_email: '이메일 주소 모양이 맞지 않아요. 다시 확인해 주세요.',
  biz_inactive: '국세청 조회에서 휴업/폐업으로 나와요. 이 번호로는 저장할 수 없어요.',
  onboarding_open: '시작 설정을 먼저 마쳐 주세요.',
  gesture_required: '[저장]을 직접 눌러 주세요.',
  account_required: '먼저 로그인해 주세요.',
  busy: '처리 중이에요. 잠시 뒤에 다시 눌러 주세요.',
};
const FIELDS = [
  ['상호', 'name'],
  ['사업자번호', 'bizNo'],
  ['대표자', 'rep'],
  ['업태', 'bizType'],
  ['종목', 'bizItem'],
  ['주소', 'address'],
  ['이메일', 'email'],
];
const BIZ_TEXT_KEYS = ['name', 'rep', 'bizType', 'bizItem', 'address', 'email'];
const INPUT = {
  name: (o) => textInput({ ...o, max: LIMITS.name, required: '상호를 넣어 주세요.' }),
  bizNo: (o) => bizNoInput({ ...o, required: true }),
  email: (o) => emailInput(o),
};
const ERR_FIELD = { name_required: 'name', bad_biz_no: 'bizNo', biz_inactive: 'bizNo', bad_email: 'email' };
const errCode = (e) => String(e?.message ?? e).replace(/^Error invoking remote method 'sax': (Error: )?/, '');

export function bizEditStart(b) {
  return { values: { name: b.bizNo && !b.nameMissing ? b.name : '', bizNo: b.bizNo ?? '', rep: b.rep ?? '', bizType: b.bizType ?? '', bizItem: b.bizItem ?? '', address: b.address ?? '', email: b.email ?? '' }, origNo: b.bizNo ?? '', confirm: null, busy: false };
}

export function bizProfileCard(ctx) {
  return ctx.edit ? editCard(ctx) : viewCard(ctx);
}

function viewCard(ctx) {
  const { b } = ctx;
  const has = !!b.bizNo;
  const filled = BIZ_TEXT_KEYS.filter((k) => (k === 'name' ? has && !b.nameMissing : !!b[k]));
  const mixed = !!b.fromHometax?.length && filled.some((k) => !b.fromHometax.includes(k));
  const ht = (k) => (mixed && b.fromHometax.includes(k) ? { tag: '홈택스에서 가져옴' } : {});
  const empty = filled.length < BIZ_TEXT_KEYS.length;
  const source = !b.fromHometax?.length ? '이 PC에 저장한 정보예요' : empty ? '빈 칸은 발급할 때 홈택스 화면에서 채워요' : null;
  return h(
    'article',
    { class: 'sx-card', 'data-biz-card': 'view' },
    h('div', { class: 'sx-card-hd' }, h('div', { class: 'sx-card-title' }, `사업자 ${b.name}`), btn(has ? '수정' : '등록', ctx.onEdit, 'sx-btn-quiet', { 'data-act': 'biz-edit' })),
    kv(
      [
        ['상호', has && !b.nameMissing ? b.name : null, ht('name')],
        ['사업자번호', fmtBiz(b.bizNo), { mono: true }],
        ['대표자', b.rep || null, ht('rep')],
        ['업태', b.bizType || null, ht('bizType')],
        ['종목', b.bizItem || null, ht('bizItem')],
        ['주소', b.address || null, ht('address')],
        ['이메일', b.email || null, ht('email')],
        ['발급 인증', b.auth, ctx.authReopen ? { copy: ctx.reopenAuth, copyLabel: '바꾸기' } : {}],
      ],
      true,
    ),
    has && b.nameMissing ? note(BIZ_NAME_MISSING_NOTE, true) : null,
    source ? h('div', { class: 'sx-source' }, source) : null,
  );
}

function editCard(ctx) {
  const e = ctx.edit;
  const fieldErr = (name) => (e.msg?.field === name ? e.msg.text : null);
  const msgEl = e.msg && !e.msg.field ? h('p', { class: `form-msg${e.msg.bad ? ' is-bad' : ''}`, role: 'status', 'data-biz-msg': e.msg.bad ? 'bad' : 'ok' }, e.msg.text) : null;
  const noteEl = h('p', { class: 'sx-meta', 'data-bizno-note': '', hidden: !e.origNo || e.values.bizNo === e.origNo }, BIZ_NO_CHANGE_NOTE);
  const input = (label, name) =>
    field({
      label,
      error: fieldErr(name),
      input: (INPUT[name] ?? ((o) => textInput({ ...o, max: LIMITS[name] })))({
        name,
        value: e.values[name] ?? '',
        oninput: (ev) => {
          e.values[name] = name === 'bizNo' ? bizDigits(ev.target.value) : ev.target.value;
          if (e.msg) {
            e.msg = null;
            msgEl?.remove();
          }
          if (name === 'bizNo') {
            noteEl.hidden = !e.origNo || e.values.bizNo === e.origNo;
            if (e.confirm) {
              e.confirm = null;
              ctx.rerender();
            }
          }
        },
      }),
    });
  const say = (text, bad, at = null) => {
    e.msg = { text, bad, field: at };
    ctx.rerender();
  };
  const save = async (confirmUnverified) => {
    if (e.busy) return;
    e.busy = true;
    e.msg = null;
    try {
      const r = await ctx.call('profile.edit', { fields: { ...e.values }, ...(confirmUnverified ? { confirmUnverified: true } : {}) });
      if (!r.ok) {
        e.confirm = r.confirm;
        ctx.rerender();
        return;
      }
      ctx.onSaved(r);
    } catch (err) {
      const c = errCode(err);
      say(BIZ_EDIT_ERR[c] ?? '저장하지 못했어요. 다시 해 주세요.', true, ERR_FIELD[c]);
    } finally {
      e.busy = false;
    }
  };
  const readCert = async () => {
    if (e.busy) return;
    e.busy = true;
    try {
      const r = await ctx.call('profile.readCert', {});
      if (!r.found) {
        if (r.reason === 'unreadable') say('등록증을 읽지 못했어요. 칸에 직접 입력해 주세요.', true);
        return;
      }
      for (const [, k] of FIELDS) {
        const v = r.fields?.[k];
        if (typeof v === 'string' && v) e.values[k] = k === 'bizNo' ? bizDigits(v) : v;
      }
      e.confirm = null;
      say('등록증에서 읽었어요. 맞는지 보고 저장해 주세요.', false);
    } catch (err) {
      const c = errCode(err);
      say(BIZ_EDIT_ERR[c] ?? '등록증을 읽지 못했어요. 다시 해 주세요.', true);
    } finally {
      e.busy = false;
    }
  };
  const form = h(
    'form',
    {
      class: 'cp-form',
      novalidate: true,
      'data-biz-form': '',
      onkeydown: keys(() => form.requestSubmit(), ctx.onCancel),
      onsubmit: (ev) => {
        ev.preventDefault();
        if (checkFields(form)) void save(false);
      },
    },
    h('div', { class: 'sx-actions' }, btn('파일에서 읽기', readCert, 'sx-btn-quiet', { 'data-act': 'biz-cert' })),
    FIELDS.map(([label, name]) => input(label, name)),
    noteEl,
    msgEl,
    e.confirm
      ? h(
          'div',
          { 'data-biz-confirm': e.confirm.status },
          note('국세청에서 이 사업자번호를 조회하지 못했어요. 번호가 맞으면 [맞습니다]를 눌러 저장해 주세요.', true, e.confirm.label),
          h('div', { class: 'sx-actions' }, btn('맞습니다', () => save(true), 'sx-btn-primary', { 'data-act': 'biz-confirm-unverified' }), btn('다시 조회', () => save(false), 'sx-btn-quiet', { 'data-act': 'biz-recheck' })),
        )
      : h('div', { class: 'sx-actions' }, h('button', { type: 'submit', class: 'sx-btn sx-btn-primary', 'data-act': 'biz-save' }, '저장'), btn('취소', ctx.onCancel, 'sx-btn-quiet', { 'data-act': 'biz-cancel' })),
  );
  return h('article', { class: 'sx-card', 'data-biz-card': 'edit' }, h('div', { class: 'sx-card-hd' }, h('div', { class: 'sx-card-title' }, ctx.edit.origNo ? '사업자 정보 수정' : '사업자 정보 등록')), form, e.confirm ? h('div', { class: 'sx-actions' }, btn('취소', ctx.onCancel, 'sx-btn-quiet', { 'data-act': 'biz-cancel' })) : null);
}
