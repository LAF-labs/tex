// 내 사업장(캔버스 D-03) 사업자 프로필 카드: 보기 → [수정] → 칸 편집 → [저장]/[취소] (사용자 요구 2026-11-10, main profile-edit.ts).
// - 칸 검사·번호 상태조회·저장은 main이 한다(profile.edit). 여기서는 값을 입력 칸 value로만 다루고 HTML로 그리지 않는다.
// - 번호를 조회하지 못하면 main이 confirm을 돌려준다: [맞습니다]면 confirmUnverified로 다시 보낸다(온보딩 O-02와 같다).
// - [파일에서 읽기]는 온보딩과 같은 등록증 읽기(profile.readCert)다. 읽은 값은 칸에 채울 뿐, 저장은 [저장]으로 같은 검사를 거친다.
// - 발급 인증 바꾸기는 온보딩 O-03을 다시 연다(onboarding.reopen auth, 부르는 쪽 ctx.reopenAuth).
import { btn, fmtBiz, h, kv, note } from './shell-views.js';
import { bizDigits, bizNoInput, checkFields, emailInput, field, keys, LIMITS, textInput } from './fields.js';
/** main profile-edit.ts BIZ_NO_CHANGE_NOTE와 같은 문장. */
export const BIZ_NO_CHANGE_NOTE = '사업자번호를 바꾸면 홈택스에 로그인한 사업자와 달라질 수 있어요. 다르면 발급 때 멈추고 알려 드려요.';
export const BIZ_NAME_MISSING_NOTE = '상호가 비어 있어요. 다음 발급 때 홈택스 화면에서 채워요. 지금 넣으려면 [수정]을 눌러 주세요.';
export const BIZ_EDIT_ERR = {
  name_required: '상호를 입력해 주세요.',
  bad_biz_no: '사업자번호가 맞지 않아요. 10자리를 다시 확인해 주세요.',
  bad_email: '이메일 주소 모양이 맞지 않아요. 다시 확인해 주세요.',
  biz_inactive: '국세청 조회에서 휴업·폐업으로 나와요. 이 번호로는 저장할 수 없어요.',
  onboarding_open: '시작 설정을 먼저 마쳐 주세요.',
  gesture_required: '[저장]을 직접 눌러 주세요.',
  account_required: '먼저 로그인해 주세요.',
  busy: '처리 중이에요. 잠시 뒤에 다시 눌러 주세요.',
};
/** 칸 이름 → 보이는 라벨. 칸 종류·상한은 fields.js(LIMITS, main onboarding.ts BIZ_FIELD_MAX 이하)가 정한다. */
const FIELDS = [
  ['상호', 'name'],
  ['사업자번호', 'bizNo'],
  ['대표자', 'rep'],
  ['업태', 'bizType'],
  ['종목', 'bizItem'],
  ['주소', 'address'],
  ['이메일', 'email'],
];
const INPUT = {
  name: (o) => textInput({ ...o, max: LIMITS.name, required: '상호를 넣어 주세요.' }),
  bizNo: (o) => bizNoInput({ ...o, required: true }),
  email: (o) => emailInput(o),
};
/** main이 거절한 까닭이 칸 하나의 것이면 그 칸 아래에 쓴다. */
const ERR_FIELD = { name_required: 'name', bad_biz_no: 'bizNo', biz_inactive: 'bizNo', bad_email: 'email' };
/** IPC 오류의 코드(ipcRenderer.invoke가 붙이는 앞말을 뗀다, shell.js errText와 같다). */
const errCode = (e) => String(e?.message ?? e).replace(/^Error invoking remote method 'sax': (Error: )?/, '');

/** 편집 시작 값(지금 프로필). 번호는 숫자 10자리로 두고 칸이 000-00-00000 모양으로 보인다. */
export function bizEditStart(b) {
  return { values: { name: b.bizNo && !b.nameMissing ? b.name : '', bizNo: b.bizNo ?? '', rep: b.rep ?? '', bizType: b.bizType ?? '', bizItem: b.bizItem ?? '', address: b.address ?? '', email: b.email ?? '' }, origNo: b.bizNo ?? '', confirm: null, busy: false };
}

/**
 * ctx: { b, edit, authReopen, call, rerender, onEdit, onCancel, onSaved(r), reopenAuth, onRegister }
 * edit가 있으면 폼, 없으면 보기 카드.
 */
export function bizProfileCard(ctx) {
  return ctx.edit ? editCard(ctx) : viewCard(ctx);
}

function viewCard(ctx) {
  const { b } = ctx;
  const has = !!b.bizNo;
  const ht = (k) => (b.fromHometax?.includes(k) ? { tag: '홈택스에서 가져옴' } : {});
  return h(
    'article',
    { class: 'sx-card', 'data-biz-card': 'view' },
    h('div', { class: 'sx-card-hd' }, h('div', { class: 'sx-card-title' }, `사업자 · ${b.name}`), btn(has ? '수정' : '등록', ctx.onEdit, 'sx-btn-quiet', { 'data-act': 'biz-edit' })),
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
    h('div', { class: 'sx-source' }, b.fromHometax?.length ? '빈 칸은 발급할 때 홈택스 화면에서 채워요 · [수정]으로 고칠 수 있어요' : '이 PC의 내 사업장 정보 · [수정]으로 고칠 수 있어요'),
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
          // 번호는 숫자 10자리로 둔다(main이 받는 모양). 칸에는 000-00-00000으로 보인다.
          e.values[name] = name === 'bizNo' ? bizDigits(ev.target.value) : ev.target.value;
          // 칸을 고치면 지난 결과 글은 내린다(다시 그리지 않아 입력 칸 초점이 그대로다)
          if (e.msg) {
            e.msg = null;
            msgEl?.remove();
          }
          if (name === 'bizNo') {
            noteEl.hidden = !e.origNo || e.values.bizNo === e.origNo;
            // 번호를 고치면 지난 "조회하지 못함" 확인은 쓰지 않는다
            if (e.confirm) {
              e.confirm = null;
              ctx.rerender();
            }
          }
        },
      }),
    });
  // 저장·등록증 읽기 결과는 토스트 대신 폼 안 한 줄 글(대표 2026-11-13). 칸 하나의 틀림은 그 칸 아래(확인 필요 색).
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
