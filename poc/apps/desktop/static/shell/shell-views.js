// 셸 렌더러 공용: DOM 도우미와 디자인 시스템 컴포넌트(TaskCard·KeyValue·StepList·Amount·DocumentCard).
// 값은 모두 텍스트 노드로 넣는다(innerHTML 없음). 카드에는 승인 버튼이 없다(ADR-021).

export function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of kids.flat(Infinity)) if (c != null && c !== false) el.append(c instanceof Node ? c : String(c));
  return el;
}

const SVG = 'http://www.w3.org/2000/svg';
const ICONS = {
  chat: ['M4 5h16v11H9l-5 4z'],
  docs: ['M3 6.5h6l2 2h10V19H3z'],
  cps: ['M4 20V5h10v15', 'M14 9h6v11', 'M7 8.5h3M7 12h3M7 15.5h3M16.5 13h1M16.5 16h1', 'M2.5 20h19'],
  biz: ['M4 10v10h16V10', 'M3 10l1.6-5h14.8L21 10z', 'M9.5 20v-5.5h5V20'],
  activity: ['M12 3.5a8.5 8.5 0 1 1 0 17a8.5 8.5 0 0 1 0-17z', 'M12 7.5V12l3 2'],
  settings: ['M4 7h9M17 7h3M4 17h3M11 17h9', 'M15 5v4M9 15v4'],
  lock: ['M6 11h12v9H6z', 'M8.5 11V8a3.5 3.5 0 0 1 7 0v3'],
  info: ['M12 3.5a8.5 8.5 0 1 1 0 17a8.5 8.5 0 0 1 0-17z', 'M12 11v5M12 8v.5'],
  close: ['M6 6l12 12M18 6L6 18'],
  send: ['M12 19V6M6.5 11.5L12 6l5.5 5.5'],
};
export function icon(name) {
  const s = document.createElementNS(SVG, 'svg');
  s.setAttribute('viewBox', '0 0 24 24');
  s.setAttribute('fill', 'none');
  s.setAttribute('stroke', 'currentColor');
  s.setAttribute('stroke-width', '1.5');
  s.setAttribute('stroke-linecap', 'round');
  s.setAttribute('stroke-linejoin', 'round');
  s.setAttribute('aria-hidden', 'true');
  for (const d of ICONS[name]) {
    const p = document.createElementNS(SVG, 'path');
    p.setAttribute('d', d);
    s.append(p);
  }
  return s;
}

// ---- 표기 형식(data-hierarchy) ----
export const num = (n) => Number(n).toLocaleString('en-US');
export const won = (n) => `${num(n)}원`;
export const fmtBiz = (d) => (d && d.length === 10 ? `${d.slice(0, 3)}-${d.slice(3, 5)}-${d.slice(5)}` : d || '—');
const WD = ['일', '월', '화', '수', '목', '금', '토'];
const parse = (s) => {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d);
};
export const dayLabel = (s) => {
  const d = parse(s);
  return `${d.getMonth() + 1}월 ${d.getDate()}일 ${WD[d.getDay()]}요일`;
};
export function dday(s, today) {
  if (!s) return null;
  const t = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  return Math.round((parse(s) - t) / 86400000);
}

// ---- 컴포넌트 ----

const CHIP = {
  draft: ['작성 중', ''],
  preparing: ['준비 중', ''],
  turn: ['내 차례', 'is-turn'],
  waiting: ['승인 대기', 'is-waiting'],
  issuing: ['발급 중', ''],
  checking: ['확인 중', ''],
  done: ['완료', 'is-done'],
  stopped: ['중지됨', 'is-stopped'],
  attention: ['확인 필요', 'is-attention'],
};
export const chip = (status) => h('span', { class: `sx-chip ${CHIP[status][1]}` }, CHIP[status][0]);

export function amount(total, supply, tax, note) {
  return h(
    'div',
    { class: 'sx-amount' },
    h('div', { class: 'sx-amount-total' }, num(total), h('span', { class: 'sx-unit' }, '원')),
    h('div', { class: 'sx-amount-split' }, `공급가 ${num(supply)} + 세액 ${num(tax)}`, note ? h('span', { class: 'sx-tag' }, ` · ${note}`) : null),
  );
}

/** KeyValue: 행 = [라벨, 값, {state: inferred|verified|mismatch, tag, flag, total, mono, start}]. flag는 확실성과 별개인 표시(처음 거래 등). */
export function kv(rows) {
  return h(
    'dl',
    { class: 'sx-kv' },
    rows.map(([label, value, o = {}]) => [
      h('dt', {}, label),
      h(
        'dd',
        { class: [o.state ? `is-${o.state}` : '', o.total ? 'is-total' : '', o.start ? 'is-start' : ''].join(' ').trim() || null },
        h('span', { class: `sx-val${o.mono ? ' sx-id' : ''}` }, value ?? '—'),
        o.tag ? h('span', { class: 'sx-tag' }, o.tag) : null,
        o.flag ? h('span', { class: 'sx-flag' }, o.flag) : null,
      ),
    ]),
  );
}

export function steps(list) {
  return h(
    'ol',
    { class: 'sx-steps' },
    list.map((s) => h('li', { class: s.state === 'todo' ? null : `is-${s.state}` }, h('span', {}, s.label, s.note ? h('small', {}, s.note) : null))),
  );
}

export function note(text, attention, extra) {
  return h('div', { class: `sx-note${attention ? ' is-attention' : ''}` }, icon('info'), h('div', {}, text, extra ? h('div', { class: 'sx-meta' }, extra) : null));
}

export const btn = (label, onclick, kind = '', attrs = {}) => h('button', { type: 'button', class: `sx-btn ${kind}`.trim(), onclick, ...attrs }, label);

/** 대화 속 작업 카드(TaskCard). 상태가 바뀌면 같은 카드가 바뀐다. */
export function taskCard(run, act) {
  const title = `세금계산서 · ${run.counterparty.name}`;
  const st = run.status;
  const card = h('section', { class: `sx-card${st === 'turn' || st === 'waiting' ? ' is-turn' : ''}`, 'data-run': run.id, 'data-status': st });
  card.addEventListener('click', (e) => {
    if (!e.target.closest('button, input')) act.open(run.id);
  });
  const hd = h('div', { class: 'sx-card-hd' }, h('div', { class: 'sx-card-title' }, title), chip(st));
  const vatNote = run.vat === 'separate' ? (run.vatGuessed ? '부가세 별도로 계산했어요' : '부가세 별도') : '부가세 포함';
  card.append(hd, amount(run.total, run.supply, run.tax, st === 'draft' ? vatNote : st === 'waiting' || st === 'done' ? '✓ 홈택스 확정' : null));
  const now = run.steps.find((s) => s.state === 'now');

  if (st === 'draft') {
    const guessed = (run.vatGuessed ? 1 : 0) + 1; // 품목은 거래처 저장 품목(추정)
    if (act.editing === run.id) {
      const input = h('input', { class: 'sx-amount-edit', type: 'text', inputmode: 'numeric', value: num(run.amount), 'aria-label': '금액' });
      const save = () => act.saveAmount(run.id, input.value);
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.isComposing) save();
        if (e.key === 'Escape') act.editAmount(null);
      });
      card.append(h('div', { class: 'sx-actions' }, h('span', { class: 'sx-meta' }, run.vat === 'separate' ? '공급가액' : '합계'), input, btn('바꾸기', save, 'sx-btn-primary'), btn('그만두기', () => act.editAmount(null), 'sx-btn-quiet')));
      setTimeout(() => input.focus(), 0);
    } else {
      card.append(
        h(
          'div',
          { class: 'sx-actions' },
          btn('홈택스에서 준비', () => act.prepare(run.id), 'sx-btn-primary', { 'data-act': 'prepare' }),
          run.vat === 'separate' ? btn('부가세 포함하기', () => act.vat(run.id, 'included'), '', { 'data-act': 'vat' }) : btn('부가세 별도로 하기', () => act.vat(run.id, 'separate'), '', { 'data-act': 'vat' }),
          btn('금액 수정', () => act.editAmount(run.id)),
          btn('취소', () => act.stop(run.id), 'sx-btn-quiet', { 'data-act': 'cancel' }),
          h('span', { class: 'sx-meta' }, `추정 값 ${guessed}개`),
        ),
      );
    }
  } else if (st === 'preparing' || st === 'issuing') {
    if (now?.note) card.append(h('div', { class: 'sx-meta' }, `${now.label} · ${now.note}`));
    if (st === 'preparing') card.append(h('div', { class: 'sx-actions' }, btn('작업 보기', () => act.open(run.id), 'sx-btn-quiet'), btn('중지', () => act.stop(run.id), '', { 'data-act': 'stop' })));
  } else if (st === 'turn') {
    card.append(note(run.turn.text, false, run.turn.note));
    const signing = run.steps[4].state === 'done';
    card.append(h('div', { class: 'sx-actions' }, btn('다시 요청', () => act.toast('목업: 폰으로 다시 요청한 것으로 칠게요'), ''), signing ? null : btn('중지', () => act.stop(run.id), '', { 'data-act': 'stop' })));
  } else if (st === 'waiting') {
    card.append(
      h('div', { class: 'sx-app-line' }, '홈택스 화면에서 되읽은 값이에요. 초안과 같아요.'),
      note('아래 [승인하고 발급]에서 값을 한 번 더 확인하고 눌러 주세요'),
      h('div', { class: 'sx-actions' }, btn('중지', () => act.stop(run.id), '', { 'data-act': 'stop' })),
    );
  } else if (st === 'done') {
    const r = run.result;
    card.append(
      h('div', { class: 'sx-app-line' }, `발급했어요. ${run.counterparty.name} 메일로 보낸 것도 확인했어요.`),
      h('div', { class: 'sx-idrow' }, h('span', { class: 'sx-meta' }, '승인번호'), h('span', { class: 'sx-id', 'data-approval-no': '' }, r.approvalNo), h('button', { type: 'button', class: 'sx-copy', onclick: () => act.copy(r.approvalNo) }, '복사')),
      h('div', { class: 'sx-actions' }, btn('PDF 열기', () => act.toast('목업: 파일을 열지 않아요')), btn('폴더 열기', () => act.toast('목업: 폴더를 열지 않아요')), btn('지난번과 같게', () => act.again(run))),
      whereItWent(run),
    );
  } else if (st === 'stopped') {
    card.append(h('div', { class: 'sx-app-line' }, run.stoppedNote || '중지했어요.'));
  }
  return card;
}

/** 결과 카드의 "어디로 무엇이 갔는지"(활동 기록 행을 카드 안에서 펼친 것, 기본 접힘). */
function whereItWent(run) {
  const d = h('details', { class: 'sx-where' });
  d.append(
    h('summary', {}, '어디로 무엇이 갔는지'),
    kv([
      ['홈택스', '전자세금계산서 1건 발급 · 발급목록에서 확인', { start: true }],
      ['메일', `${run.result.mailTo} · 홈택스 자동 발송, 메일발송목록에서 확인`],
      ['보관', '이 PC 문서함 · 파일명에는 거래처·승인번호를 넣지 않아요'],
      ['모델', '쓰지 않음(데모의 요청 해석은 이 PC 안 규칙)'],
      ['우리 서버', '보낸 것 없음'],
    ]),
  );
  return d;
}

/** 작업 패널: D2 제목 + 상태 → D1 → KeyValue → StepList → D6 출처. */
export function runPanel(run, act) {
  const st = run.status;
  const confirmed = run.confirmed;
  const tag = confirmed ? { state: 'verified', tag: '홈택스 확정' } : {};
  const rows = [
    ['공급받는자', run.counterparty.name, { ...tag, flag: run.counterparty.first ? '처음 거래' : null }],
    ['사업자번호', fmtBiz(run.counterparty.bizNo), { ...tag, mono: true }],
    ['받는 이메일', run.email.value, { ...tag, flag: run.email.first ? '처음 보내는 주소' : null }],
    ['품목', run.item, confirmed ? tag : { state: 'inferred', tag: '추정' }],
    ['작성일자', run.writeDate, tag],
    ['공급가액', won(run.supply), tag],
    ['세액', won(run.tax), confirmed ? tag : run.vatGuessed ? { state: 'inferred', tag: '추정' } : {}],
    ['합계', won(run.total), { ...tag, total: true }],
  ];
  return h(
    'div',
    { class: 'panel-in', 'data-panel-run': run.id },
    h('div', { class: 'sx-card-hd' }, h('div', { class: 'sx-card-title' }, `세금계산서 · ${run.counterparty.name}`), chip(st), h('button', { type: 'button', class: 'panel-x', 'aria-label': '패널 닫기', onclick: act.closePanel }, icon('close'))),
    amount(run.total, run.supply, run.tax),
    h('div', { class: 'sx-panel-sec' }, confirmed ? '홈택스에서 되읽은 값' : '확인 값'),
    kv(rows),
    h('div', { class: 'auth-line' }, h('span', { class: 'sx-meta' }, '발급 인증'), h('span', {}, run.auth), h('span', { class: 'sx-meta' }, '· 설정에서 변경')),
    st === 'draft' ? null : [h('div', { class: 'sx-panel-sec' }, '진행'), steps(run.steps)],
    // 작업 패널의 [중지](T-04). 발급 전에만 있다. 승인은 여기에도 없다.
    st === 'preparing' || st === 'waiting' || (st === 'turn' && run.steps[4].state !== 'done') ? h('div', { class: 'sx-actions' }, btn('중지', () => act.stop(run.id), '', { 'data-act': 'panel-stop' })) : null,
    h('div', { class: 'sx-source' }, confirmed ? `홈택스에서 되읽음 · ${run.createdAt} 요청` : `요청 문장과 거래처 장부에서 채움 · ${run.createdAt}`),
  );
}

/** 지난 결과(타임라인 위쪽 기록). */
export function pastCard(p, act) {
  return h(
    'section',
    { class: 'sx-card' },
    h('div', { class: 'sx-card-hd' }, h('div', { class: 'sx-card-title' }, `${p.title} · ${p.who}`), chip('done')),
    amount(p.total, p.supply, p.tax),
    h('div', { class: 'sx-idrow' }, h('span', { class: 'sx-meta' }, '승인번호'), h('span', { class: 'sx-id' }, p.approvalNo), h('button', { type: 'button', class: 'sx-copy', onclick: () => act.copy(p.approvalNo) }, '복사')),
    h('div', { class: 'sx-meta' }, `${p.mail}로 보낸 것도 확인했어요`),
  );
}

export function summaryCard(s) {
  return h('section', { class: 'sx-card' }, h('div', { class: 'sx-card-hd' }, h('div', { class: 'sx-card-title' }, '등록 내용'), h('span', { class: 'sx-meta' }, '온보딩 요약')), kv(s.rows.map(([k, v]) => [k, v, { start: true }])));
}

/** 만료일 출처 표시(데이터 위계 '값의 확실성'): 문서에서 읽음 / 추정(규칙표) / 확인함. 확인 필요인 값은 출처와 상관없이 추정이다. */
const EXPIRY_TAG = { document: '문서', rule: '추정', user: '확인함' };
export const expiryTag = (doc) => (doc.vault.needsUser ? '추정' : (EXPIRY_TAG[doc.vault.expirySource] ?? ''));

/** 서류 카드(DocumentCard): D6 종류 → D2 서류 이름 → 세 칸 → 버튼. 보관함 서류는 유효 칸에 확실성(추정·확인함)을 붙인다. */
export function docCard(doc, today, act, compact) {
  const d = dday(doc.expiresOn, today);
  const v = doc.vault;
  const inferred = v && doc.expiresOn && (v.expirySource === 'rule' || v.needsUser);
  return h(
    'section',
    { class: 'sx-card sx-doc', 'data-doc': doc.id },
    h('div', { class: 'sx-doc-kind' }, `${doc.kind} · ${doc.source}`),
    h('div', { class: 'sx-doc-name' }, doc.docName),
    // 도장은 사용자가 승인해 앱이 발급한 서류에만(DocumentCard). 직접 발급·직접 추가 서류에는 없다.
    doc.source === '앱이 발급' ? h('div', { class: 'sx-seal' }, '발급') : null,
    h(
      'div',
      { class: 'sx-cells' },
      h('div', {}, h('span', { class: 'label sx-meta' }, '발급일'), h('span', { class: 'value' }, doc.issuedOn ? h('span', { class: 'doc-date' }, doc.issuedOn) : '—')),
      h('div', {}, h('span', { class: 'label sx-meta' }, '용도'), h('span', { class: 'value' }, doc.purpose || '—')),
      h(
        'div',
        { class: inferred ? 'is-inferred' : v?.expirySource === 'user' ? 'is-verified' : null },
        h('span', { class: 'label sx-meta' }, '유효'),
        h('span', { class: `value sx-val${d !== null && d <= 7 ? ' is-attention' : ''}` }, d === null ? '—' : [h('span', { class: 'doc-date' }, doc.expiresOn), ` · ${d < 0 ? '만료됨' : d === 0 ? 'D-day' : `D-${d}`}`]),
        v && doc.expiresOn ? h('span', { class: 'sx-tag' }, expiryTag(doc)) : null,
      ),
    ),
    compact
      ? null
      : doc.vault
        ? null // 보관함 서류의 확인·수정은 아래 확인 구역(docReview)에서
        : h('div', { class: 'sx-actions' }, btn('메일로 보내기', () => act.toast('목업: 메일을 보내지 않아요')), btn('폴더 열기', () => act.toast('목업: 폴더를 열지 않아요')), doc.source === '앱이 발급' ? btn('다시 발급', () => act.reissue(doc)) : null),
  );
}
