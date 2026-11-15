// 계좌 자동조회(CODEF 공동인증서 방식, 대표 결정 2026-11-12) 화면. 내 계좌 → [자동 연결] → 동의 한 화면 → 이 PC의 인증서(이름·용도·만료일만)
// → 비밀번호(금고 창, 이 화면은 비밀번호를 받지 않는다) → 보유계좌 고르기 → "연결됨" → [최신화]. 오류는 사람 말로, 언제나 [거래내역 파일 올리기] 길.
// [연결 해제] = CODEF 계정 삭제 + 이 PC에 기억한 비밀번호 삭제. 계좌번호는 끝 4자리만 받는다.
// 결과·오류는 토스트 대신 이 화면 안 글로 남긴다(대표 2026-11-13). 한 카드의 주요 단추는 하나, 나머지는 조용한 단추(v2.0). 화면 글에 CODEF 코드를 쓰지 않는다.
// 쓰는 곳(설정 > 계좌 연결, bank-mvp 내 계좌 화면)은 createBankAuto({...}).view()를 그린다.
import { btn, h, icon, note } from './shell-views.js';

export const BANKS = [
  ['0020', '우리은행'],
  ['0004', '국민은행'],
  ['0088', '신한은행'],
  ['0081', '하나은행'],
  ['0003', '기업은행'],
  ['0011', '농협은행'],
];
const bankName = (code) => (BANKS.find(([c]) => c === code) || [code, '은행'])[1];

/** 동의 카드 문구 판(main bank-auto.ts CODEF_CONSENT_VERSION과 같다) */
export const CONSENT_VERSION = 'codef-bank-auto-2026-11-12';

/** 동의 한 화면(09-bank-matching §4.5·§4.6·§9.4). 사장님이 동의하는 것은 우리 회사의 수집·이용과 위탁이다(CODEF 약관 동의가 아니다) */
export const CONSENT_LINES = [
  '자동 연결은 은행 조회 대행 회사 (주)헥토데이터(CODEF)를 통해 거래내역을 가져와요. 그래서 다른 기능과 달리 PC 밖으로 나가는 정보가 있어요.',
  '나가는 것: 고른 공동인증서 파일과 인증서 비밀번호, 계좌번호. 이 PC에서 CODEF로 바로 가요(비밀번호는 금고가 CODEF 공개키로 감싸요). 우리 서버는 거치지 않아요.',
  '가져오는 것: 이 계좌의 보유계좌 목록과 입출금 거래내역(날짜·금액·잔액·적요). 앱은 조회만 하고, 돈을 보내거나 이체하지 않아요.',
  '가져온 거래내역은 이 PC에만 암호화해 저장해요. AI 모델로는 아무것도 보내지 않아요.',
  '언제든 [연결 해제]로 그만둘 수 있고, 그러면 파일 올리기로 계속 쓸 수 있어요.',
];
/** 체크 세 개(둘은 필수 동의, 하나는 읽음 확인) */
export const CONSENT_CHECKS = [
  ['use', '(필수) 은행 자동 연결을 위한 개인정보 수집·이용 동의 — 우리 회사가 계좌번호·공동인증서·인증서 비밀번호·거래내역을 자동 조회와 받을 돈 맞추기에만 써요. 연결을 끊으면 지워요.'],
  ['entrust', '(필수) 개인정보 처리 위탁 안내 — 계좌 거래내역 조회를 (주)헥토데이터(CODEF)에 맡겨요. CODEF는 받은 정보를 암호화해 처리해요.'],
  ['keep', '(읽음) 인증서 보관 고지 — 공동인증서는 은행에서 조회 밖의 일도 할 수 있는 접근매체예요. CODEF에는 조회하는 동안만 등록하고 조회가 끝나면 바로 지워요. [이 PC에 기억]을 고르면 인증서 비밀번호가 이 PC 키체인에 남아요.'],
];

/** 실패 코드 → 사람 말(엔진 CodefFailure). 표에 없으면 일반 문장. 코드는 화면에 보이지 않는다 */
export function failText(code, bank) {
  const b = bankName(bank || '0020');
  return (
    {
      password_wrong: '인증서 비밀번호가 맞지 않아요. 다시 넣어 주세요. 여러 번 틀리면 인증서가 잠길 수 있어요.',
      password_locked: '인증서 비밀번호를 여러 번 틀려 은행에서 막혔어요. 은행 인터넷뱅킹에서 먼저 풀어 주세요.',
      cert_expired: '인증서가 만료됐거나 폐기됐어요. 갱신한 인증서로 다시 연결해 주세요.',
      cert_not_registered: `이 인증서가 ${b}에 등록되지 않았어요. ${b} 인터넷뱅킹에서 [인증센터 > 타기관 인증서 등록]을 한 번 해 주세요.`,
      cert_kind: '이 인증서는 이 업무에 쓸 수 없어요. 사업자 계좌면 [사업자], 개인 계좌면 [개인]을 골라 다시 해 주세요.',
      two_way_required: '은행이 추가 인증을 요구해요. 지금은 자동 연결로 할 수 없어요. 거래내역 파일을 올려 주세요.',
      bank_error: '은행이 조회를 거절했어요. 잠시 뒤 다시 하거나 거래내역 파일을 올려 주세요.',
      bank_busy: '은행 응답이 늦어요. 잠시 뒤 다시 해 주세요.',
      session_lost: '연결이 끊겼어요. 처음부터 다시 연결해 주세요.',
      no_account: '이 인증서로 조회되는 입출금 계좌가 없어요.',
      codef_off: '자동 연결을 아직 쓸 수 없어요. 거래내역 파일을 올려 주세요.',
      unavailable: '연결이 안 돼요. 인터넷과 로그인 상태를 확인하고 다시 해 주세요.',
      signed_out: '먼저 로그인해 주세요.',
      cancelled: '비밀번호 입력을 그만뒀어요.',
      cert_missing: '고른 인증서를 이 PC에서 찾지 못했어요. 인증서를 다시 골라 주세요.',
      bank_not_ready: '사업장 등록이 아직 끝나지 않아 계좌를 이을 곳이 없어요. 처음 설정을 마친 뒤 다시 해 주세요.',
      bank_consent_required: '받을 돈 화면에서 계좌 기록 동의를 먼저 해 주세요. 동의한 뒤 다시 [자동 연결]을 누르면 돼요.',
      busy: '이미 진행 중이에요. 잠시만 기다려 주세요.',
      account_password_required: '이 은행은 조회에 계좌 비밀번호가 필요해요. 지금은 자동 연결로 할 수 없어요. 거래내역 파일을 올려 주세요.',
      consent_stale: '안내 문구가 바뀌었어요. 화면을 닫고 다시 열어 주세요.',
      too_soon: '방금 가져왔어요. 15분쯤 뒤에 다시 [최신화]해 주세요.',
      daily_limit: '오늘 자동 조회 횟수를 다 썼어요. 내일 다시 하거나 거래내역 파일을 올려 주세요.',
      password_retry_limit: '오늘 이 인증서 비밀번호가 여러 번 틀렸어요. 인증서가 잠기지 않게 오늘은 멈췄어요. 비밀번호를 확인하고 내일 다시 해 주세요.',
    }[code] || '은행 조회가 되지 않았어요. 잠시 뒤 다시 하거나 거래내역 파일을 올려 주세요.'
  );
}

const PHASE_TEXT = {
  password: '금고 창에 공동인증서 비밀번호를 넣어 주세요.',
  connecting: '은행에 연결하는 중이에요.',
  accounts: '보유계좌를 불러오는 중이에요.',
  fetching: '거래내역을 가져오는 중이에요. 은행에 따라 1분쯤 걸려요.',
};

const won = (n) => (typeof n === 'number' ? `${n.toLocaleString('ko-KR')}원` : '');
const when = (iso) => (iso ? new Date(iso).toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '아직 없음');
/** 보이는 라벨 + 칸 */
const field = (label, input) => h('label', { class: 'cp-field' }, h('span', { class: 'sx-meta' }, label), input);
/** 고르기 카드(ChoiceCard): 점 + 이름 + 작은 글. 고른 것은 is-on */
const choice = (on, disabled, onclick, main, meta) =>
  h('button', { type: 'button', class: `sx-opt${on ? ' is-on' : ''}`, 'aria-pressed': String(on), disabled, onclick }, h('span', { class: 'sx-radio' }), h('span', { class: 'opt-main' }, main, h('span', { class: 'sx-meta' }, meta)));
/** Escape = 그만두기(한글 조합 중에는 무시) */
const esc = (fn) => (e) => {
  if (e.isComposing || e.keyCode === 229 || e.key !== 'Escape') return;
  e.preventDefault();
  fn();
};

/**
 * @param {{ call: (m: string, p?: object) => Promise<any>, rerender: () => void, toast: (t: string) => void, uploadFile?: () => void, openBank?: () => void }} ctx
 */
export function createBankAuto(ctx) {
  // certs: null = 불러오는 중. msg = 이 카드에 남기는 알림 한 줄(단계가 바뀌면 지운다)
  const s = { step: 'loading', status: null, checks: {}, certs: null, certId: null, bank: '0020', clientType: 'B', session: null, accounts: [], pick: null, phase: null, error: null, last: null, msg: null };
  const go = (patch) => {
    if ('step' in patch && patch.step !== s.step && !('msg' in patch)) s.msg = null;
    Object.assign(s, patch);
    ctx.rerender();
  };
  /** 연결된 상태면 연결 카드로 돌아가 알림 한 줄을 남긴다(오류 카드의 [다시 시도]에서 불려도) */
  const tell = (msg) => go({ step: s.status && s.status.connected ? 'connected' : s.step, msg });
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
  async function agree() {
    if (!CONSENT_CHECKS.every(([k]) => s.checks[k])) return;
    const r = await ask('bankAuto.consent', { version: CONSENT_VERSION });
    if (!r.ok) return fail(r);
    await toCerts();
  }
  async function toCerts() {
    go({ step: 'certs', certs: null, error: null });
    const r = await ask('bankAuto.certs');
    const certs = (r && r.certs) || [];
    // 홈택스 발급에 쓰는 인증서가 맨 앞에 오고, 쓸 수 있으면 미리 골라 둔다(09 §4.5)
    const pre = certs.find((c) => c.issuance && c.usable);
    go({ certs, certId: s.certId || (pre ? pre.id : null) });
  }
  async function connect() {
    if (!s.certId) return;
    go({ step: 'working', phase: 'password', error: null });
    const r = await ask('bankAuto.connect', { certId: s.certId, bank: s.bank, clientType: s.clientType });
    if (!r.ok) return fail(r);
    go({ step: 'accounts', session: r.sessionId, accounts: r.accounts, pick: (r.accounts.find((a) => a.usable) || {}).key || null, phase: null });
  }
  // 계좌를 고르면 엔진이 받을 돈 계좌로 잇고 첫 최신화를 시작한다(가져오기·맞추기 진행은 받을 돈 화면)
  async function choose() {
    if (!s.pick) return;
    go({ step: 'working', phase: 'connecting' });
    const r = await ask('bankAuto.choose', { sessionId: s.session, key: s.pick });
    if (!r.ok) return fail(r);
    await load();
    tell('연결됐어요. 거래내역을 받아 받을 돈과 맞추는 중이에요.');
  }
  async function refresh() {
    const r = await ask('bankAuto.refresh');
    if (!r.ok && r.code === 'too_soon' && r.retryAt) {
      const min = Math.max(1, Math.ceil((Date.parse(r.retryAt) - Date.now()) / 60_000));
      return tell(`방금 가져왔어요. ${min}분 뒤에 다시 가져올 수 있어요.`);
    }
    if (!r.ok && r.code === 'daily_limit') return tell('오늘은 다 가져왔어요. 내일 다시 가져올 수 있어요.');
    if (!r.ok) return fail(r);
    tell('최신화를 시작했어요. 받을 돈 화면에서 볼 수 있어요.');
  }
  async function cancel() {
    await ask('bankAuto.cancel');
    await load();
  }
  async function disconnect() {
    const r = await ask('bankAuto.disconnect');
    if (!r.ok) return fail(r);
    await load();
    tell(r.cleanupPending ? '연결을 끊었어요. 은행 조회 쪽에 남은 정보는 인터넷이 되면 지워요.' : '연결을 끊고, 은행 조회에 쓰던 로그인 정보와 기억한 비밀번호를 지웠어요.');
  }
  const upload = () => (ctx.uploadFile ? ctx.uploadFile() : tell('받을 돈 > 내 계좌에서 거래내역 파일을 올려 주세요.'));
  const fileLink = () => btn('거래내역 파일 올리기', upload, 'sx-btn-quiet', { 'data-bank-file': '' });
  const bankLink = () => (ctx.openBank ? btn('받을 돈 보기', ctx.openBank, 'sx-btn-quiet', { 'data-bank-open': '' }) : null);
  const msgLine = () => (s.msg ? h('div', { role: 'status' }, note(s.msg)) : null);

  function onEvent(ev) {
    if (!ev || s.step !== 'working') return;
    if (ev.phase && PHASE_TEXT[ev.phase]) go({ phase: ev.phase });
  }

  function view() {
    const title = h('div', { class: 'set-intro' }, h('h2', { class: 'sx-card-title' }, '계좌 자동조회'), h('p', { class: 'sx-body-sm is-muted' }, '은행 거래내역을 공동인증서로 자동으로 가져와 받을 돈과 맞춰요. 원하지 않으면 거래내역 파일을 올려도 돼요.'));
    const body = (() => {
      switch (s.step) {
        case 'loading':
          return h('div', { class: 'empty', 'data-bank-auto': 'loading' }, '불러오는 중…');
        case 'idle':
          s.checks = {};
          return h(
            'div',
            { class: 'sx-card', 'data-bank-auto': 'idle' },
            h('p', { class: 'sx-body-sm' }, '인증서를 고르고 비밀번호를 한 번 넣으면 연결돼요.'),
            msgLine(),
            h('div', { class: 'sx-actions' }, btn('자동 연결', () => go({ step: 'consent' }), 'sx-btn-primary', { 'data-bank-connect': '' }), fileLink()),
            s.status && s.status.cleanupPending ? h('p', { class: 'sx-meta' }, '지난 연결에서 은행 조회 쪽에 남은 정보가 있어요. 다음 연결 때 함께 지워요.') : null,
          );
        case 'consent':
          return h(
            'div',
            { class: 'sx-card', 'data-bank-auto': 'consent', onkeydown: esc(() => load()) },
            h('h3', { class: 'sx-card-title' }, '자동 연결 전에 확인해 주세요'),
            h('ul', { class: 'sx-body-sm' }, CONSENT_LINES.map((t) => h('li', {}, t))),
            CONSENT_CHECKS.map(([k, t]) => h('label', { class: 'auth-row' }, h('input', { type: 'checkbox', checked: !!s.checks[k], 'data-bank-check': k, onchange: (e) => go({ checks: { ...s.checks, [k]: e.target.checked } }) }), h('span', { class: 'opt-main sx-body-sm' }, t))),
            h('div', { class: 'sx-actions' }, btn('동의하고 인증서 고르기', agree, 'sx-btn-primary', { disabled: !CONSENT_CHECKS.every(([k]) => s.checks[k]), 'data-bank-consent': '' }), btn('파일로만 쓸게요', upload, 'sx-btn-quiet'), btn('그만두기', () => load(), 'sx-btn-quiet')),
          );
        case 'certs':
          return h(
            'div',
            { class: 'sx-card', 'data-bank-auto': 'certs', onkeydown: esc(() => load()) },
            h('h3', { class: 'sx-card-title' }, '이 PC의 공동인증서'),
            s.certs === null
              ? h('div', { class: 'empty' }, '불러오는 중…')
              : s.certs.length
                ? h(
                    'div',
                    { class: 'opt-list', role: 'group', 'aria-label': '공동인증서' },
                    s.certs.map((c) =>
                      choice(
                        s.certId === c.id,
                        !c.usable,
                        () => go({ certId: c.id }),
                        h('span', { class: 'auth-name' }, c.owner, c.issuance ? [' ', h('span', { class: 'sx-chip' }, '홈택스 발급에 쓰는 인증서')] : null),
                        `${c.usage} · ${c.expiresOn}까지${c.usable ? '' : c.why === 'expired' ? ' · 만료' : ' · 쓸 수 없음'}`,
                      ),
                    ),
                  )
                : h('div', { class: 'empty' }, '이 PC에서 공동인증서를 찾지 못했어요. 인증서를 이 PC로 옮기거나 거래내역 파일을 올려 주세요.'),
            h(
              'div',
              { class: 'cp-form' },
              field('은행', h('select', { class: 'doc-in', onchange: (e) => (s.bank = e.target.value) }, BANKS.map(([c, n]) => h('option', { value: c, selected: s.bank === c }, n)))),
              field('계좌 종류', h('select', { class: 'doc-in', onchange: (e) => (s.clientType = e.target.value) }, h('option', { value: 'B', selected: s.clientType === 'B' }, '사업자'), h('option', { value: 'P', selected: s.clientType === 'P' }, '개인'))),
            ),
            h('div', { class: 'sx-actions' }, btn('은행에 연결하기', connect, 'sx-btn-primary', { disabled: !s.certId, 'data-bank-next': '' }), btn('그만두기', () => load(), 'sx-btn-quiet'), fileLink()),
            h('p', { class: 'sx-meta' }, '누르면 금고 창이 인증서 비밀번호를 물어요. 이 화면은 비밀번호를 받지 않아요.'),
          );
        case 'working':
          return h('div', { class: 'sx-card', 'data-bank-auto': 'working' }, note(PHASE_TEXT[s.phase] || '처리하는 중이에요.'), s.phase === 'password' ? h('div', { class: 'sx-actions' }, btn('그만두기', cancel, 'sx-btn-quiet')) : null);
        case 'accounts':
          return h(
            'div',
            { class: 'sx-card', 'data-bank-auto': 'accounts', onkeydown: esc(cancel) },
            h('h3', { class: 'sx-card-title' }, `${bankName(s.bank)} 보유계좌`),
            s.accounts.length
              ? h(
                  'div',
                  { class: 'opt-list', role: 'group', 'aria-label': '보유계좌' },
                  s.accounts.map((a) => choice(s.pick === a.key, !a.usable, () => go({ pick: a.key }), h('span', { class: 'auth-name' }, `${a.name || '계좌'} ···${a.last4}`), a.usable ? won(a.balance) : '입출금 계좌가 아니라 거래내역을 가져올 수 없어요')),
                )
              : h('div', { class: 'empty' }, '이 인증서로 조회되는 입출금 계좌가 없어요.'),
            h('div', { class: 'sx-actions' }, btn('이 계좌 연결', choose, 'sx-btn-primary', { disabled: !s.pick, 'data-bank-choose': '' }), btn('그만두기', cancel, 'sx-btn-quiet')),
          );
        case 'connected': {
          const st = s.status || {};
          return h(
            'div',
            { class: 'sx-card', 'data-bank-auto': 'connected' },
            h('p', { class: 'sx-body-sm' }, h('span', { class: 'sx-chip is-done' }, '연결됨'), ` ${st.bankName || ''} ···${st.last4 || ''}${st.accountName ? ` · ${st.accountName}` : ''}`),
            h('p', { class: 'sx-meta' }, `마지막 조회: ${when(st.lastSyncAt)}${typeof st.callsLeft === 'number' ? ` · 오늘 남은 조회 ${st.callsLeft}회` : ''}`),
            msgLine(),
            h('div', { class: 'sx-actions' }, btn('최신화', refresh, 'sx-btn-primary', { 'data-bank-refresh': '' }), bankLink(), btn('연결 해제', disconnect, 'sx-btn-quiet', { 'data-bank-disconnect': '' }), fileLink()),
            h('p', { class: 'sx-meta' }, '[최신화]마다 금고 창에서 비밀번호를 물어요. 창에서 [이 PC에 기억]을 고르면 다음부터 묻지 않아요.'),
          );
        }
        case 'error': {
          // 오류 = 확인 필요 알림 한 줄 + [다시 시도]. 그 아래 조용한 단추로 닫기와 파일 길
          const e = s.error || {};
          const retry =
            e.code === 'bank_consent_required'
              ? bankLink()
              : btn('다시 시도', s.status && s.status.connected ? refresh : e.code === 'password_wrong' ? connect : toCerts, 'sx-btn-quiet', { 'data-bank-retry': '' });
          return [
            h('div', { class: 'sx-note is-attention', role: 'alert', 'data-bank-auto': 'error', 'data-code': e.code || '' }, icon('warn'), h('div', {}, failText(e.code, s.status?.bank || s.bank)), retry),
            h('div', { class: 'sx-actions' }, btn('닫기', () => load(), 'sx-btn-quiet'), fileLink()),
          ];
        }
        default:
          return null;
      }
    })();
    return h('div', { class: 'set-body', 'data-bank-auto-root': '' }, title, body);
  }

  return { view, load, onEvent, state: s };
}
