// 계좌 자동조회(CODEF 공동인증서 방식, 대표 결정 2026-11-12) 화면. 내 계좌 → [자동 연결] → 동의 한 화면 → 이 PC의 인증서(이름·용도·만료일만)
// → 비밀번호(금고 창, 이 화면은 비밀번호를 받지 않는다) → 보유계좌 고르기 → "연결됨" → [최신화]. 오류는 사람 말로, 언제나 [거래내역 파일 올리기] 길.
// [연결 해제] = CODEF 계정 삭제 + 이 PC에 기억한 비밀번호 삭제. 계좌번호는 끝 4자리만 받는다.
// 쓰는 곳(설정 > 계좌 연결, bank-mvp 내 계좌 화면)은 createBankAuto({...}).view()를 그린다.
import { btn, h, note } from './shell-views.js';

export const BANKS = [
  ['0020', '우리은행'],
  ['0004', '국민은행'],
  ['0088', '신한은행'],
  ['0081', '하나은행'],
  ['0003', '기업은행'],
  ['0011', '농협은행'],
];
const bankName = (code) => (BANKS.find(([c]) => c === code) || [code, '은행'])[1];

/** 동의 한 화면(그대로 보이는 사실). 09-bank-matching §4.5·§4.6 */
export const CONSENT_LINES = [
  '고른 공동인증서 파일과 인증서 비밀번호가 CODEF(헥토데이터)로 가요. 비밀번호는 금고가 CODEF 공개키로 감싸서 보내요.',
  'CODEF가 은행에 로그인해 이 계좌의 보유계좌·입출금 거래내역(날짜·금액·잔액·적요)만 가져와요. 이체·출금은 하지 않아요.',
  '조회가 끝나면 CODEF에 등록한 로그인 정보를 바로 지워요. 가져온 거래내역은 이 PC에만 저장되고 우리 서버를 거치지 않아요.',
  '언제든 [연결 해제]로 끊을 수 있어요. 끊으면 CODEF 쪽 로그인 정보와 이 PC에 기억한 비밀번호를 지워요.',
];

/** 실패 코드 → 사람 말(엔진 CodefFailure). 표에 없으면 일반 문장 */
export function failText(code, bank) {
  const b = bankName(bank || '0020');
  return (
    {
      password_wrong: '인증서 비밀번호가 맞지 않아요. 다시 넣어 주세요. 여러 번 틀리면 인증서가 잠길 수 있어요.',
      password_locked: '인증서 비밀번호를 여러 번 틀려 은행에서 막혔어요. 은행 인터넷뱅킹에서 먼저 풀어 주세요.',
      cert_expired: '인증서가 만료됐거나 폐기됐어요. 갱신한 인증서로 다시 연결해 주세요.',
      cert_not_registered: `이 인증서가 ${b}에 등록되지 않았어요 — ${b} 인터넷뱅킹에서 [인증센터 > 타기관 인증서 등록]을 한 번 해 주세요.`,
      cert_kind: '이 인증서는 이 업무에 쓸 수 없어요. 사업자 계좌면 [사업자], 개인 계좌면 [개인]을 골라 다시 해 주세요.',
      two_way_required: '은행이 추가 인증을 요구해요. 지금은 자동 연결로 할 수 없어요. 거래내역 파일을 올려 주세요.',
      bank_error: '은행이 조회를 거절했어요. 잠시 뒤 다시 하거나 거래내역 파일을 올려 주세요.',
      bank_busy: '은행 응답이 늦어요. 잠시 뒤 다시 해 주세요.',
      session_lost: '연결이 끊겼어요. 처음부터 다시 연결해 주세요.',
      no_account: '이 인증서로 조회되는 입출금 계좌가 없어요.',
      codef_off: '자동 연결이 아직 준비되지 않았어요(서버 설정 전). 거래내역 파일을 올려 주세요.',
      unavailable: '연결 안 됨. 인터넷과 로그인 상태를 확인하고 다시 해 주세요.',
      signed_out: '먼저 로그인해 주세요.',
      cancelled: '비밀번호 입력을 취소했어요.',
      cert_missing: '고른 인증서를 이 PC에서 찾지 못했어요. 인증서를 다시 골라 주세요.',
      bank_not_ready: '계좌는 확인했지만 거래내역을 넣을 곳(내 계좌)이 아직 준비되지 않았어요.',
      busy: '이미 진행 중이에요. 잠시만 기다려 주세요.',
    }[code] || 'CODEF가 요청을 받지 않았어요. 잠시 뒤 다시 하거나 거래내역 파일을 올려 주세요.'
  );
}

const PHASE_TEXT = {
  password: '금고 창에 공동인증서 비밀번호를 넣어 주세요.',
  connecting: 'CODEF로 은행에 연결하는 중이에요.',
  accounts: '보유계좌를 불러오는 중이에요.',
  fetching: '거래내역을 가져오는 중이에요. 은행에 따라 1분쯤 걸려요.',
  saving: '가져온 거래를 정리하는 중이에요.',
};

const won = (n) => (typeof n === 'number' ? `${n.toLocaleString('ko-KR')}원` : '');
const when = (iso) => (iso ? new Date(iso).toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '아직 없음');

/**
 * @param {{ call: (m: string, p?: object) => Promise<any>, rerender: () => void, toast: (t: string) => void, uploadFile?: () => void }} ctx
 */
export function createBankAuto(ctx) {
  const s = { step: 'loading', status: null, certs: [], certId: null, bank: '0020', clientType: 'B', session: null, accounts: [], pick: null, phase: null, error: null, last: null };
  const go = (patch) => (Object.assign(s, patch), ctx.rerender());
  const fail = (r) => go({ step: 'error', error: r, phase: null });
  const ask = async (m, p) => {
    try {
      return await ctx.call(m, p || {});
    } catch (e) {
      return { ok: false, code: /gesture_required/.test(String(e)) ? 'busy' : /account|login/.test(String(e)) ? 'signed_out' : 'unavailable' };
    }
  };

  async function load() {
    const r = await ask('bankAuto.status');
    go({ status: r.ok ? r : null, step: r.ok && r.connected ? 'connected' : 'idle' });
  }
  async function toCerts() {
    go({ step: 'certs', certs: [], error: null });
    const r = await ask('bankAuto.certs');
    go({ certs: (r && r.certs) || [] });
  }
  async function connect() {
    if (!s.certId) return;
    go({ step: 'working', phase: 'password', error: null });
    const r = await ask('bankAuto.connect', { certId: s.certId, bank: s.bank, clientType: s.clientType });
    if (!r.ok) return fail(r);
    go({ step: 'accounts', session: r.sessionId, accounts: r.accounts, pick: (r.accounts.find((a) => a.usable) || {}).key || null, phase: null });
  }
  async function choose() {
    if (!s.pick) return;
    go({ step: 'working', phase: 'fetching' });
    const r = await ask('bankAuto.choose', { sessionId: s.session, key: s.pick });
    if (!r.ok) return fail(r);
    s.last = r;
    await load();
    ctx.toast(`연결됐어요. 거래 ${r.newCount}건을 새로 가져왔어요.`);
  }
  async function refresh(again) {
    go({ step: 'working', phase: 'password', error: null });
    const r = await ask('bankAuto.refresh', again ? { ask: true } : {});
    if (!r.ok) return fail(r);
    s.last = r;
    await load();
    ctx.toast(r.newCount ? `새 거래 ${r.newCount}건을 가져왔어요.` : '새 거래가 없어요.');
  }
  async function cancel() {
    await ask('bankAuto.cancel');
    await load();
  }
  async function disconnect() {
    const r = await ask('bankAuto.disconnect');
    if (!r.ok) return fail(r);
    await load();
    ctx.toast(r.cleanupPending ? '연결을 끊었어요. CODEF 쪽 정리는 인터넷이 되면 다시 해요.' : '연결을 끊고 CODEF 로그인 정보와 기억한 비밀번호를 지웠어요.');
  }
  const upload = () => (ctx.uploadFile ? ctx.uploadFile() : ctx.toast('내 계좌 화면에서 거래내역 파일을 올려 주세요.'));
  const fileLink = () => btn('거래내역 파일 올리기', upload, 'is-quiet', { 'data-bank-file': '' });

  function onEvent(ev) {
    if (!ev || s.step !== 'working') return;
    if (ev.phase && PHASE_TEXT[ev.phase]) go({ phase: ev.phase });
  }

  function view() {
    const title = h('div', { class: 'set-intro' }, h('h2', { class: 'sx-card-title' }, '계좌 자동조회'), h('p', { class: 'sx-body-sm is-muted' }, '은행 거래내역을 공동인증서로 자동으로 가져와 받을 돈과 맞춰요. 원하지 않으면 거래내역 파일을 올려도 돼요.'));
    const body = (() => {
      switch (s.step) {
        case 'loading':
          return h('p', { class: 'sx-meta' }, '불러오는 중…');
        case 'idle':
          return h(
            'div',
            { class: 'sx-card', 'data-bank-auto': 'idle' },
            h('p', { class: 'sx-body-sm' }, '인증서를 고르고 비밀번호를 한 번 넣으면 연결돼요.'),
            h('div', { class: 'sx-actions' }, btn('자동 연결', () => go({ step: 'consent' }), 'is-primary', { 'data-bank-connect': '' }), fileLink()),
            s.status && s.status.cleanupPending ? h('p', { class: 'sx-meta' }, 'CODEF 쪽 정리가 남아 있어요. 다음 연결 때 함께 지워요.') : null,
          );
        case 'consent':
          return h(
            'div',
            { class: 'sx-card', 'data-bank-auto': 'consent' },
            h('h3', { class: 'sx-card-title' }, '자동 연결 전에 확인해 주세요'),
            h('ul', { class: 'sx-body-sm' }, CONSENT_LINES.map((t) => h('li', {}, t))),
            h('p', { class: 'sx-meta' }, '자동 조회는 CODEF(헥토데이터)에 처리를 맡겨요. 맡기고 싶지 않으면 거래내역 파일을 올려 주세요.'),
            h('div', { class: 'sx-actions' }, btn('동의하고 인증서 고르기', toCerts, 'is-primary', { 'data-bank-consent': '' }), btn('취소', () => load(), 'is-quiet'), fileLink()),
          );
        case 'certs':
          return h(
            'div',
            { class: 'sx-card', 'data-bank-auto': 'certs' },
            h('h3', { class: 'sx-card-title' }, '이 PC의 공동인증서'),
            s.certs.length
              ? h(
                  'div',
                  { class: 'auth-list' },
                  s.certs.map((c) =>
                    h(
                      'label',
                      { class: 'auth-row' },
                      h('input', { type: 'radio', name: 'bank-cert', value: c.id, disabled: !c.usable, checked: s.certId === c.id, onchange: () => go({ certId: c.id }) }),
                      h('span', { class: 'opt-main' }, h('span', { class: 'auth-name' }, c.owner), h('span', { class: 'sx-meta' }, `${c.usage} · ${c.expiresOn}까지${c.usable ? '' : c.why === 'expired' ? ' · 만료' : ' · 쓸 수 없음'}`)),
                    ),
                  ),
                )
              : h('p', { class: 'sx-meta' }, '이 PC에서 공동인증서를 찾지 못했어요. 인증서를 이 PC로 옮기거나 거래내역 파일을 올려 주세요.'),
            h(
              'div',
              { class: 'sx-actions' },
              h('select', { 'aria-label': '은행', onchange: (e) => (s.bank = e.target.value) }, BANKS.map(([c, n]) => h('option', { value: c, selected: s.bank === c }, n))),
              h('select', { 'aria-label': '계좌 종류', onchange: (e) => (s.clientType = e.target.value) }, h('option', { value: 'B', selected: s.clientType === 'B' }, '사업자'), h('option', { value: 'P', selected: s.clientType === 'P' }, '개인')),
            ),
            h('div', { class: 'sx-actions' }, btn('다음 (비밀번호는 금고 창에서)', connect, 'is-primary', { disabled: !s.certId, 'data-bank-next': '' }), btn('취소', () => load(), 'is-quiet'), fileLink()),
          );
        case 'working':
          return h('div', { class: 'sx-card', 'data-bank-auto': 'working' }, note(PHASE_TEXT[s.phase] || '처리하는 중이에요.'), h('div', { class: 'sx-actions' }, s.phase === 'password' ? btn('취소', cancel, 'is-quiet') : null));
        case 'accounts':
          return h(
            'div',
            { class: 'sx-card', 'data-bank-auto': 'accounts' },
            h('h3', { class: 'sx-card-title' }, `${bankName(s.bank)} 보유계좌`),
            h(
              'div',
              { class: 'auth-list' },
              s.accounts.map((a) =>
                h(
                  'label',
                  { class: 'auth-row' },
                  h('input', { type: 'radio', name: 'bank-acct', value: a.key, disabled: !a.usable, checked: s.pick === a.key, onchange: () => go({ pick: a.key }) }),
                  h('span', { class: 'opt-main' }, h('span', { class: 'auth-name' }, `${a.name || '계좌'} ···${a.last4}`), h('span', { class: 'sx-meta' }, a.usable ? won(a.balance) : '입출금 계좌가 아니라 거래내역을 가져올 수 없어요')),
                ),
              ),
            ),
            h('div', { class: 'sx-actions' }, btn('이 계좌 연결', choose, 'is-primary', { disabled: !s.pick, 'data-bank-choose': '' }), btn('취소', cancel, 'is-quiet')),
          );
        case 'connected': {
          const st = s.status || {};
          return h(
            'div',
            { class: 'sx-card', 'data-bank-auto': 'connected' },
            h('p', { class: 'sx-body-sm' }, h('span', { class: 'sx-chip is-done' }, '연결됨'), ` ${st.bankName || ''} ···${st.last4 || ''}${st.accountName ? ` · ${st.accountName}` : ''}`),
            h('p', { class: 'sx-meta' }, `마지막 조회: ${when(st.lastSyncAt)}${st.lastSyncAt ? ` · 새 거래 ${st.lastNew ?? 0}건` : ''}`),
            h('div', { class: 'sx-actions' }, btn('최신화', () => refresh(false), 'is-primary', { 'data-bank-refresh': '' }), btn('연결 해제', disconnect, 'is-quiet', { 'data-bank-disconnect': '' }), fileLink()),
            h('p', { class: 'sx-meta' }, '[최신화]마다 금고 창에서 비밀번호를 물어요. 창에서 [이 PC에 기억]을 고르면 다음부터 묻지 않아요.'),
          );
        }
        case 'error': {
          const e = s.error || {};
          const retryPw = e.code === 'password_wrong';
          return h(
            'div',
            { class: 'sx-card', 'data-bank-auto': 'error', 'data-code': e.code || '' },
            note(failText(e.code, s.status?.bank || s.bank), true, e.cf ? `CODEF 코드 ${e.cf}` : null, 'warn'),
            h(
              'div',
              { class: 'sx-actions' },
              s.status && s.status.connected ? btn('다시 하기', () => refresh(retryPw), 'is-primary') : btn('다시 하기', retryPw ? connect : toCerts, 'is-primary'),
              btn('닫기', () => load(), 'is-quiet'),
              fileLink(),
            ),
          );
        }
        default:
          return null;
      }
    })();
    return h('div', { class: 'set-body', 'data-bank-auto-root': '' }, title, body);
  }

  return { view, load, onEvent, state: s };
}
