// 설정 > 기기 연결의 계정 기기 목록과 새 PC 연결 요청(ADR-048 결정 1·3·6). 쓰던 PC 쪽 화면이다(새 PC 쪽은 shell-account.js 로그인 화면).
// - 목록: PC 묶음·폰 묶음(각 3대까지). 다른 기기는 [연결 끊기](확인 한 번), 이 PC는 [이 PC 연결 끊기](계정에 남은 마지막 PC면 안내만).
// - 새 PC 요청: [연결] → 새 PC 화면의 6자리를 넣고 [확인]. 6자리는 이 렌더러에 미리 오지 않는다(사람이 새 PC 화면을 보고 넣는다).
// - 이 PC가 다른 기기에서 끊겼거나 정지됐으면(account.device_suspended) 목록 대신 안내와 [다시 로그인].
// 문구는 폰 앱의 연결된 기기 화면(taxoff-mobile src/devices.ts)과 맞춘다. 값은 모두 textContent로 넣는다.
import { btn, h, icon } from './shell-views.js';

export const MAX_PER_ROLE = 3;
export const FULL_NOTE = '3대까지 연결할 수 있어요. 새 기기를 연결하려면 하나를 끊어 주세요.';
const LAST_PC = '계정에 남은 마지막 PC는 연결을 끊을 수 없어요.';
const DAY = 86_400_000;
/** 새 PC 요청을 다시 읽는 간격(새 PC의 응답·새 요청). 화면이 보일 때만 읽는다. */
const POLL_MS = 3_000;

const ERR = {
  'account.last_desktop': LAST_PC,
  'account.device_limit': 'PC는 3대까지 연결할 수 있어요. 하나를 끊은 뒤 다시 해 주세요.',
  'account.device_churn_limit': '최근에 PC를 여러 번 바꿨어요. 며칠 뒤에 다시 해 주세요.',
  'account.device_not_listed': '이 기기는 아직 연결을 마치지 않았어요. 잠시 뒤 다시 봐 주세요.',
  'account.link_not_found': '새 PC가 요청을 거뒀어요. 새 PC에서 다시 로그인하면 여기에 다시 떠요.',
  'account.link_state': '이 요청은 다른 PC에서 받고 있어요.',
  'account.link_mismatch': '새 PC의 정보가 맞지 않아 연결하지 않았어요. 새 PC에서 다시 로그인해 주세요.',
  'account.keys_unavailable': '금고가 열려 있지 않아요. 앱을 다시 켠 뒤 해 주세요.',
  'policy.rate_limited': '요청이 많아요. 잠시 뒤에 다시 해 주세요.',
  run_active: '발급이 진행 중이라 지금은 끊을 수 없어요. 끝난 뒤에 해 주세요.',
  gesture_required: '버튼을 다시 눌러 주세요.',
  account_required: '먼저 로그인해 주세요.',
  busy: '처리 중이에요. 잠시 뒤에 다시 해 주세요.',
};
export const devicesErrText = (code) => ERR[code] ?? (String(code).startsWith('net.') ? '연결하지 못했어요. 인터넷 연결을 확인해 주세요.' : '잠시 뒤에 다시 해 주세요.');

const kindName = (d) => (d.role === 'desktop' ? (d.platform === 'macos' ? 'Mac' : d.platform === 'windows' ? 'Windows PC' : 'PC') : d.platform === 'ios' ? 'iPhone' : d.platform === 'android' ? 'Android 폰' : '폰');

/** 상태 한 줄(폰 앱과 같은 말). */
export function deviceSub(d, now) {
  if (d.state === 'pending') return '연결하는 중';
  if (d.state === 'suspended') {
    if (d.deleteAfter === null) return '정지됨';
    const days = Math.ceil((d.deleteAfter - now) / DAY);
    return days <= 0 ? '정지됨 · 곧 끊겨요' : `정지됨 · ${days}일 뒤 끊겨요`;
  }
  return d.self ? '이 PC' : '쓰는 중';
}

/** ctx: { call, rerender, errText, toast, visible(), signedIn(), onAccount(view), relogin() } */
export function createDevices(ctx) {
  const s = {
    loading: false,
    list: null,
    err: null,
    msg: null,
    /** 확인 중인 줄: 기기 ID 또는 'self' */
    confirm: null,
    busy: false,
    reqs: [],
    /** 요청마다 넣는 중인 6자리와 그 줄의 안내({ text, bad }) */
    codes: {},
    notes: {},
  };
  let timer = null;
  const set = (p) => {
    Object.assign(s, p);
    ctx.rerender();
  };
  const code = (e) => ctx.errText(e);

  async function load() {
    if (!ctx.signedIn()) return;
    set({ loading: true, err: null });
    const [d, r] = await Promise.allSettled([ctx.call('devices.list', {}), ctx.call('pclink.list', {})]);
    if (d.status === 'fulfilled') s.list = d.value.devices;
    if (r.status === 'fulfilled') s.reqs = r.value.requests;
    set({ loading: false, err: d.status === 'rejected' ? code(d.reason) : null });
    watch();
  }

  /** 요청이 바뀌었을 때만 다시 그린다(6자리를 넣는 칸이 다시 만들어지지 않게). */
  async function poll() {
    if (!ctx.visible() || !ctx.signedIn() || s.busy || s.err) return;
    try {
      const r = await ctx.call('pclink.list', {});
      if (JSON.stringify(r.requests) === JSON.stringify(s.reqs)) return;
      const doneBefore = new Set(s.reqs.filter((x) => x.stage === 'done').map((x) => x.deviceId));
      s.reqs = r.requests;
      // 다른 PC가 받았거나 새 PC가 연결을 마쳤으면 목록도 다시 읽는다
      if (r.requests.some((x) => x.stage === 'done' && !doneBefore.has(x.deviceId))) s.list = (await ctx.call('devices.list', {})).devices;
      ctx.rerender();
    } catch {
      // 다음 차례에 다시 읽는다
    }
  }
  function watch() {
    if (timer) return;
    timer = setInterval(() => {
      if (!ctx.visible()) {
        clearInterval(timer);
        timer = null;
        return;
      }
      void poll();
    }, POLL_MS);
  }

  async function act(f) {
    if (s.busy) return;
    set({ busy: true, msg: null });
    try {
      await f();
    } finally {
      s.busy = false;
      ctx.rerender();
    }
  }

  const unlink = (d) =>
    act(async () => {
      try {
        s.list = (await ctx.call('devices.unlink', { deviceId: d.deviceId })).devices;
        s.confirm = null;
        s.msg = { text: `${d.name || kindName(d)} 연결을 끊었어요.`, bad: false };
      } catch (e) {
        s.confirm = null;
        s.msg = { text: devicesErrText(code(e)), bad: true };
      }
    });

  const leave = () =>
    act(async () => {
      try {
        ctx.onAccount(await ctx.call('devices.leave', {}));
        s.list = null;
        s.confirm = null;
      } catch (e) {
        s.confirm = null;
        s.msg = { text: devicesErrText(code(e)), bad: true };
      }
    });

  const note = (id, text, bad) => (s.notes = { ...s.notes, [id]: text ? { text, bad } : null });

  const begin = (r) =>
    act(async () => {
      note(r.deviceId, null);
      try {
        s.reqs = (await ctx.call('pclink.begin', { deviceId: r.deviceId })).requests;
        s.codes = { ...s.codes, [r.deviceId]: '' };
      } catch (e) {
        note(r.deviceId, devicesErrText(code(e)), true);
        s.reqs = (await ctx.call('pclink.list', {}).catch(() => ({ requests: s.reqs }))).requests;
      }
    });

  const reject = (r) =>
    act(async () => {
      try {
        s.reqs = (await ctx.call('pclink.reject', { deviceId: r.deviceId })).requests;
        s.msg = { text: `${r.name || kindName({ role: 'desktop', platform: r.platform })} 요청을 거절했어요.`, bad: false };
      } catch (e) {
        note(r.deviceId, devicesErrText(code(e)), true);
      }
    });

  const confirm = (r) =>
    act(async () => {
      const value = (s.codes[r.deviceId] ?? '').replace(/\D/g, '');
      if (value.length !== 6) return note(r.deviceId, '새 PC 화면의 6자리를 모두 넣어 주세요.', true);
      const before = r.triesLeft;
      try {
        const res = await ctx.call('pclink.confirm', { deviceId: r.deviceId, code: value });
        s.reqs = res.requests;
        s.codes = { ...s.codes, [r.deviceId]: '' };
        if (res.ok) {
          note(r.deviceId, null);
          s.list = (await ctx.call('devices.list', {}).catch(() => ({ devices: s.list }))).devices;
          return;
        }
        const now = res.requests.find((x) => x.deviceId === r.deviceId);
        if (now?.stage === 'code') note(r.deviceId, `숫자가 맞지 않아요. 새 PC 화면의 6자리를 다시 봐 주세요. ${now.triesLeft}번 더 넣을 수 있어요.`, true);
        // 요청이 목록에서 빠졌다: 횟수를 다 썼거나(마지막 기회였다) 10분이 지났다
        else s.msg = { text: before !== null && before <= 1 ? '3번 틀려서 이 요청을 지웠어요. 새 PC에서 다시 로그인하면 새 요청이 와요.' : '10분이 지나 이 요청이 끝났어요. 새 PC가 다시 요청하면 여기에 떠요.', bad: true };
      } catch (e) {
        note(r.deviceId, devicesErrText(code(e)), true);
        s.reqs = (await ctx.call('pclink.list', {}).catch(() => ({ requests: s.reqs }))).requests;
      }
    });

  // ── 그리기 ──

  const row = (attrs, name, sub, attention, ...acts) =>
    h(
      'div',
      { class: 'auth-row dev-row', ...attrs },
      h('span', { class: 'opt-main' }, h('span', { class: 'auth-name' }, name), h('span', { class: `sx-meta${attention ? ' is-attention' : ''}` }, sub)),
      ...acts,
    );

  function deviceRow(d, activePcs) {
    const name = d.name || kindName(d);
    const sub = deviceSub(d, Date.now());
    const attrs = { 'data-device': d.deviceId, 'data-device-state': d.state, ...(d.self ? { 'data-device-self': '' } : {}) };
    const key = d.self ? 'self' : d.deviceId;
    if (s.confirm === key) {
      const ask = d.self ? '이 PC 연결을 끊을까요? 로그아웃되고, 다시 쓰려면 다른 PC에서 승인해야 해요.' : `${name} 연결을 끊을까요? 그 기기는 바로 계정을 쓸 수 없어요.`;
      return h(
        'div',
        { class: 'dev-confirm', ...attrs, 'data-device-confirm': '' },
        h('p', { class: 'sx-body-sm' }, ask),
        h('div', { class: 'sx-actions' }, btn('끊기', () => (d.self ? leave() : unlink(d)), 'sx-btn-primary', { disabled: s.busy, 'data-act': d.self ? 'device-leave' : 'device-unlink' }), btn('그만두기', () => set({ confirm: null }), 'sx-btn-quiet', { 'data-act': 'device-confirm-back' })),
      );
    }
    let act = null;
    if (d.self) {
      act = activePcs > 1 ? btn('이 PC 연결 끊기', () => set({ confirm: 'self', msg: null }), 'sx-btn-quiet', { 'data-act': 'device-leave-open' }) : null;
    } else if (d.listed && d.state !== 'pending') {
      act = btn('연결 끊기', () => set({ confirm: d.deviceId, msg: null }), 'sx-btn-quiet', { 'data-act': 'device-unlink-open' });
    }
    return row(attrs, name, d.self && activePcs <= 1 ? `${sub} · ${LAST_PC}` : sub, d.state === 'suspended', act);
  }

  function group(title, list, activePcs, role) {
    const full = list.length >= MAX_PER_ROLE;
    return h(
      'article',
      { class: 'sx-card dev-group', 'data-device-group': role, ...(full ? { 'data-device-full': '' } : {}) },
      h('div', { class: 'sx-card-hd' }, h('h2', { class: 'sx-card-title' }, title), h('span', { class: 'sx-meta' }, `${list.length}대 · ${MAX_PER_ROLE}대까지`)),
      list.length ? h('div', { class: 'dev-rows' }, ...list.map((d) => deviceRow(d, activePcs))) : h('p', { class: 'sx-body-sm is-muted' }, role === 'mobile' ? '아직 연결한 폰이 없어요. 위의 [폰 연결]로 연결해요.' : '연결한 PC가 없어요.'),
      full ? h('p', { class: 'sx-meta', 'data-device-full-note': '' }, FULL_NOTE) : null,
    );
  }

  function codeInput(r) {
    const i = h('input', { class: 'doc-in dev-code', inputmode: 'numeric', maxlength: 6, autocomplete: 'off', spellcheck: 'false', placeholder: '000000', 'aria-label': '새 PC 화면의 6자리', 'data-pclink-code': r.deviceId });
    i.value = s.codes[r.deviceId] ?? '';
    i.addEventListener('input', () => {
      const v = i.value.replace(/\D/g, '').slice(0, 6);
      if (i.value !== v) i.value = v;
      s.codes[r.deviceId] = v;
      const ok = i.parentElement?.querySelector('[data-act=pclink-confirm]');
      if (ok) ok.disabled = s.busy || v.length !== 6;
    });
    i.addEventListener('keydown', (e) => e.key === 'Enter' && !s.busy && confirm(r));
    return i;
  }

  function requestRow(r) {
    const name = r.name || kindName({ role: 'desktop', platform: r.platform });
    const n = s.notes[r.deviceId];
    const noteEl = n ? h('p', { class: `sx-meta${n.bad ? ' is-attention' : ''}`, role: n.bad ? 'alert' : null, 'data-pclink-note': '' }, n.text) : null;
    const attrs = { 'data-pclink': r.deviceId, 'data-pclink-stage': r.stage };
    if (r.stage === 'new')
      return h('div', { class: 'dev-req', ...attrs }, row({}, name, '새 PC가 이 계정에 연결하려고 해요', false, btn('연결', () => begin(r), 'sx-btn-primary', { disabled: s.busy, 'data-act': 'pclink-begin' }), btn('거절', () => reject(r), 'sx-btn-quiet', { disabled: s.busy, 'data-act': 'pclink-reject' })), noteEl);
    if (r.stage === 'wait') return h('div', { class: 'dev-req', ...attrs }, row({}, name, '새 PC가 6자리를 띄우고 있어요', false, btn('거절', () => reject(r), 'sx-btn-quiet', { disabled: s.busy, 'data-act': 'pclink-reject' })), noteEl);
    if (r.stage === 'code') {
      const v = s.codes[r.deviceId] ?? '';
      return h(
        'div',
        { class: 'dev-req', ...attrs },
        row({}, name, '새 PC 화면에 보이는 6자리를 넣어 주세요', false),
        h('div', { class: 'dev-code-row' }, codeInput(r), btn('확인', () => confirm(r), 'sx-btn-primary', { disabled: s.busy || v.length !== 6, 'data-act': 'pclink-confirm' }), btn('거절', () => reject(r), 'sx-btn-quiet', { disabled: s.busy, 'data-act': 'pclink-reject' })),
        noteEl,
      );
    }
    if (r.stage === 'done')
      return h('div', { class: 'dev-req', ...attrs }, h('div', { class: 'auth-row dev-row' }, h('span', { class: 'dev-done-mk', 'aria-hidden': 'true' }, icon('check')), h('span', { class: 'opt-main' }, h('span', { class: 'auth-name', 'data-pclink-done': '' }, '연결됐어요'), h('span', { class: 'sx-meta' }, `${name} · 새 PC에서 [네, 떴어요]를 누르면 끝나요`))));
    return h('div', { class: 'dev-req', ...attrs }, row({}, name, '다른 PC에서 연결을 받고 있어요', false));
  }

  function requestsCard() {
    if (!s.reqs.length) return null;
    return h('article', { class: 'sx-card dev-group', 'data-pclink-card': '' }, h('div', { class: 'sx-card-hd' }, h('h2', { class: 'sx-card-title' }, '새 PC 연결 요청')), h('div', { class: 'dev-rows' }, ...s.reqs.map(requestRow)));
  }

  function goneCard() {
    return h(
      'article',
      { class: 'sx-card dev-group', 'data-device-gone': '' },
      h('div', { class: 'sx-card-hd' }, h('h2', { class: 'sx-card-title' }, '이 PC는 연결이 끊겼어요')),
      h('p', { class: 'sx-body-sm' }, '다른 기기에서 이 PC를 끊었거나 정지했어요. 정지라면 쓰던 다른 PC의 기기 연결 화면에서 풀 수 있어요.'),
      h('p', { class: 'sx-meta' }, '다시 쓰려면 로그인한 뒤 쓰던 PC에서 이 PC 연결을 승인해 주세요.'),
      h('div', { class: 'sx-actions' }, btn('다시 로그인', ctx.relogin, 'sx-btn-primary', { 'data-act': 'device-relogin' })),
    );
  }

  /** 설정 > 기기 연결의 계정 카드 아래에 놓을 것들. 로그인 전이면 없다. */
  function view() {
    if (!ctx.signedIn()) return [];
    if (s.err === 'account.device_suspended') return [goneCard()];
    const msg = s.msg ? h('p', { class: s.msg.bad ? 'sx-note is-attention' : 'sx-body-sm', role: s.msg.bad ? 'alert' : 'status', 'data-device-msg': '' }, s.msg.text) : null;
    if (!s.list)
      return [
        requestsCard(),
        h(
          'article',
          { class: 'sx-card', 'data-device-list': s.loading ? 'loading' : 'error' },
          h('p', { class: 'sx-body-sm is-muted' }, s.loading ? '기기 목록을 불러오는 중이에요' : `기기 목록을 불러오지 못했어요. ${devicesErrText(s.err)}`),
          s.loading ? null : h('div', { class: 'sx-actions' }, btn('다시 불러오기', () => void load(), 'sx-btn-quiet', { 'data-act': 'device-reload' })),
        ),
        msg,
      ];
    const pcs = s.list.filter((d) => d.role === 'desktop');
    const phones = s.list.filter((d) => d.role === 'mobile');
    const activePcs = pcs.filter((d) => d.state === 'active').length;
    // 이 PC가 맨 위, 나머지는 연결한 순서(main이 등록 순으로 준다)
    pcs.sort((a, b) => (a.self === b.self ? 0 : a.self ? -1 : 1));
    return [requestsCard(), msg, group('PC', pcs, activePcs, 'desktop'), group('폰', phones, activePcs, 'mobile')];
  }

  /** 이 PC가 다른 기기에서 끊겼다(목록 대신 안내, 계정 카드도 숨긴다) */
  const gone = () => ctx.signedIn() && s.err === 'account.device_suspended';
  return { load, view, gone, state: s };
}
