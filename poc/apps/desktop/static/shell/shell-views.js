// 셸 렌더러 공용: DOM 도우미와 디자인 시스템 컴포넌트(TaskCard·KeyValue·StepList·Amount·DocumentCard).
// 값은 모두 텍스트 노드로 넣는다(innerHTML 없음). 카드에는 승인 버튼이 없다(ADR-021).
// 모양은 화면 디자인 캔버스(소버린 AX 화면 디자인)를 따른다.

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
// [viewBox 한 변, 경로…]. 레일 아이콘은 캔버스와 같은 20 그리드 1.5px 선이다.
const ICONS = {
  chat: [20, 'M3.5 5.5a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v6a2 2 0 0 1-2 2H9l-3.5 3v-3a2 2 0 0 1-2-2z'],
  docs: [20, 'M3 6.5V15a1.5 1.5 0 0 0 1.5 1.5h11A1.5 1.5 0 0 0 17 15V8a1.5 1.5 0 0 0-1.5-1.5H10L8.5 4.5h-4A1.5 1.5 0 0 0 3 6z'],
  cps: [20, 'M10.25 7a2.75 2.75 0 1 1-5.5 0a2.75 2.75 0 1 1 5.5 0z', 'M2.5 16c.6-2.6 2.6-4 5-4s4.4 1.4 5 4', 'M13 4.6a2.6 2.6 0 0 1 0 5', 'M14.5 12.2c1.6.5 2.6 1.8 3 3.8'],
  biz: [20, 'M3.5 16.5V5.5l6.5-2.5 6.5 2.5v11', 'M2.5 16.5h15', 'M8 16.5v-4h4v4'],
  bundle: [20, 'M3.5 7h13v8.5a1.5 1.5 0 0 1-1.5 1.5H5a1.5 1.5 0 0 1-1.5-1.5z', 'M2.5 4h15v3h-15z', 'M8 10.5h4'],
  activity: [20, 'M6 5h10M6 10h10M6 15h10M3 5h.5M3 10h.5M3 15h.5'],
  settings: [20, 'M12.5 10a2.5 2.5 0 1 1-5 0a2.5 2.5 0 1 1 5 0z', 'M10 2.5v2M10 15.5v2M2.5 10h2M15.5 10h2M4.7 4.7l1.4 1.4M13.9 13.9l1.4 1.4M4.7 15.3l1.4-1.4M13.9 6.1l1.4-1.4'],
  pc: [16, 'M2 3.5h12v7.5H2z', 'M6 13.5h4M8 11v2.5'],
  lock: [16, 'M4.5 7h7A1.5 1.5 0 0 1 13 8.5v4a1.5 1.5 0 0 1-1.5 1.5h-7A1.5 1.5 0 0 1 3 12.5v-4A1.5 1.5 0 0 1 4.5 7z', 'M5.5 7V5a2.5 2.5 0 0 1 5 0'],
  phone: [16, 'M6 1.5h4A1.5 1.5 0 0 1 11.5 3v10a1.5 1.5 0 0 1-1.5 1.5H6A1.5 1.5 0 0 1 4.5 13V3A1.5 1.5 0 0 1 6 1.5z', 'M7 12h2'],
  chevron: [10, 'M2 3.5 5 6.5 8 3.5'],
  chevronLeft: [16, 'M10 3 5 8l5 5'],
  warn: [16, 'M8 2.5 14 13H2z', 'M8 6.5v3M8 11.2v.1'],
  key: [16, 'M8.5 10.5a3 3 0 1 1-6 0a3 3 0 1 1 6 0z', 'M7.7 8.3 13.5 2.5M11.5 4.5l1.5 1.5'],
  mail: [16, 'M2.5 3.5h11a1 1 0 0 1 1 1v7a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1v-7a1 1 0 0 1 1-1z', 'M2 4l6 5 6-5'],
  plus: [16, 'M8 3v10M3 8h10'],
  check: [16, 'M3.5 8.5 6.5 11.5 12.5 4.5'],
  info: [16, 'M14 8A6 6 0 1 1 2 8a6 6 0 0 1 12 0z', 'M8 7.5v3.5M8 5v.5'],
  close: [16, 'M4 4l8 8M12 4l-8 8'],
  eye: [16, 'M1.5 8s2.5-4.5 6.5-4.5S14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8z', 'M10 8a2 2 0 1 1-4 0a2 2 0 1 1 4 0z'],
  eyeOff: [16, 'M1.5 8s2.5-4.5 6.5-4.5S14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8z', 'M10 8a2 2 0 1 1-4 0a2 2 0 1 1 4 0z', 'M2.5 2.5l11 11'],
  send: [14, 'M7 11.5v-9M3 6.5l4-4 4 4'],
  money: [20, 'M2.5 5.5h15v9h-15z', 'M12.5 10a2.5 2.5 0 1 1-5 0a2.5 2.5 0 1 1 5 0z', 'M5 8v4M15 8v4'],
  pencil: [16, 'M3 13l.7-2.8L10.9 3a1.4 1.4 0 0 1 2 2l-7.2 7.2z'],
  globe: [16, 'M14 8A6 6 0 1 1 2 8a6 6 0 0 1 12 0z', 'M2 8h12', 'M8 2c1.7 1.6 2.5 3.6 2.5 6S9.7 12.4 8 14C6.3 12.4 5.5 10.4 5.5 8S6.3 3.6 8 2z'],
  expand: [16, 'M9.5 2.5h4v4M13.5 2.5 9 7M6.5 13.5h-4v-4M2.5 13.5 7 9'],
  shrink: [16, 'M13 7H9V3M9 7l4.5-4.5M3 9h4v4M7 9l-4.5 4.5'],
};
export function icon(name) {
  const [box, ...paths] = ICONS[name];
  const s = document.createElementNS(SVG, 'svg');
  s.setAttribute('viewBox', `0 0 ${box} ${box}`);
  s.setAttribute('fill', 'none');
  s.setAttribute('stroke', 'currentColor');
  s.setAttribute('stroke-width', '1.5');
  s.setAttribute('stroke-linecap', 'round');
  s.setAttribute('stroke-linejoin', 'round');
  s.setAttribute('aria-hidden', 'true');
  for (const d of paths) {
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
export const ddayText = (n) => (n === null ? '—' : n < 0 ? '만료됨' : n === 0 ? 'D-day' : `D-${n}`);
/** 발급일 뒤에 붙는 "(n일 전)". 오늘이면 "(오늘)", 날짜가 없거나 미래면 붙이지 않는다. */
export function agoText(s, today) {
  const n = dday(s, today);
  return n === null || n > 0 ? '' : n === 0 ? '(오늘)' : `(${-n}일 전)`;
}

// ---- 컴포넌트 ----

export const CHIP = {
  draft: ['작성 중', ''],
  preparing: ['준비 중', ''],
  turn: ['내 차례', 'is-turn'],
  waiting: ['승인 대기', 'is-waiting'],
  issuing: ['발급 중', ''],
  checking: ['확인 중', ''],
  done: ['완료', 'is-done'],
  stopped: ['중지됨', 'is-stopped'],
  discarded: ['취소함', 'is-stopped'],
  attention: ['확인 필요', 'is-attention'],
};
/** 상태 칩. label을 주면 색은 상태대로, 글자는 label(지난 실행처럼 표와 같은 말을 써야 할 때). */
export const chip = (status, label) => h('span', { class: `sx-chip ${CHIP[status][1]}` }, label ?? CHIP[status][0]);

/** 발급 뒤 발급목록을 조회하는 중(발급 · 조회로 확정 묶음의 '발급목록 확인' 단계가 지금). 칩은 '확인 중'이다(08 §11). */
export const verifying = (run) => run.status === 'issuing' && run.steps[6]?.state === 'now';
/** 화면에 보이는 상태 칩. 실행 상태에 '확인 중'(조회 중)을 더한 것. */
export const shownStatus = (run) => (verifying(run) ? 'checking' : run.status);

/** D1 합계 + 분해 한 줄. note는 분해 줄 끝에 " · note"로 붙는다. split이 false면 합계만. */
export function amount(total, supply, tax, note, split = true) {
  return h(
    'div',
    { class: 'sx-amount' },
    h('div', { class: 'sx-amount-total' }, num(total), h('span', { class: 'sx-unit' }, '원')),
    split ? h('div', { class: 'sx-amount-split' }, `공급가 ${num(supply)} + 세액 ${num(tax)}${note ? ` · ${note}` : ''}`) : null,
  );
}

/** KeyValue: 행 = [라벨, 값, {state: inferred|verified|mismatch|empty, tag, flag, total, mono, start, copy}]. flag는 확실성과 별개인 표시(처음 거래 등). copy는 값 옆 [복사]. */
export function kv(rows, start = false) {
  return h(
    'dl',
    { class: `sx-kv${start ? ' is-start' : ''}` },
    rows.filter(Boolean).map(([label, value, o = {}]) => [
      h('dt', {}, label),
      h(
        'dd',
        { class: [o.state ? `is-${o.state}` : '', o.total ? 'is-total' : '', o.start ? 'is-start' : ''].join(' ').trim() || null },
        h('span', { class: `sx-val${o.mono ? ' sx-id' : ''}` }, value ?? '—'),
        o.tag ? h('span', { class: 'sx-tag' }, o.tag) : null,
        o.flag ? h('span', { class: 'sx-flag' }, o.flag) : null,
        o.copy ? h('button', { type: 'button', class: 'sx-copy', onclick: o.copy, 'aria-label': `${label} ${o.copyLabel ?? '복사'}` }, o.copyLabel ?? '복사') : null,
      ),
    ]),
  );
}

export function steps(list) {
  return h(
    'ol',
    { class: 'sx-steps' },
    list.map((s) =>
      h(
        'li',
        { class: s.state === 'todo' ? null : `is-${s.state}` },
        h(
          'span',
          {},
          s.label,
          s.note ? h('small', {}, s.note) : null,
          // 포털 대화상자 확인 결과(사업자번호 [확인] 등): 팝업 대신 이 단계 아래 한 줄 글. 기대와 다르면 빨간 글.
          ...(s.checks ?? []).map((c) => h('small', { class: `sx-step-check ${c.ok ? 'is-ok' : 'is-bad'}`, 'data-portal-check': c.ok ? 'ok' : 'bad' }, c.text)),
        ),
      ),
    ),
  );
}

/**
 * 실행 단계 표시: 엔진 단계 8개(shell-runs STEPS)를 캔버스의 6단계로 묶어 보인다. 상태 판정은 엔진 단계 그대로이고 보이는 묶음만 다르다.
 * 묶음 상태: 하나라도 확인 필요면 확인 필요, 하나라도 지금이면 지금, 모두 끝났으면 끝, 일부만 끝났고 작업이 진행 중이면 지금.
 */
const STEP_GROUPS = [
  ['홈택스 로그인', [0]],
  ['건별발급 화면 열기', [1]],
  ['항목 입력과 되읽기', [2, 3]],
  ['승인하고 발급', [4]],
  ['발급 · 조회로 확정', [5, 6]],
  ['메일 전송 확인', [7]],
];
const ACTIVE = ['preparing', 'turn', 'waiting', 'issuing'];
export function runSteps(run) {
  const groups = STEP_GROUPS.map(([label, idx]) => {
    const g = group(label, idx);
    const checks = (run.portalChecks ?? []).filter((c) => idx.includes(c.step));
    return checks.length ? { ...g, checks } : g;
  });
  function group(label, idx) {
    const xs = idx.map((i) => run.steps[i]).filter(Boolean);
    const pick = (st) => xs.find((s) => s.state === st);
    const att = pick('attention');
    const now = pick('now');
    if (att) return { label, state: 'attention', note: att.note };
    if (now) return { label, state: 'now', note: now.note };
    if (xs.length && xs.every((s) => s.state === 'done')) return { label, state: 'done', note: xs.map((s) => s.note).filter(Boolean)[0] };
    if (xs.some((s) => s.state === 'done') && ACTIVE.includes(run.status)) return { label, state: 'now' };
    return { label, state: 'todo' };
  }
  // 단계 사이에서 멈춘 확인 필요(진행 중 단계가 없던 때)는 끝나지 않은 첫 묶음에 표시한다. 안 하면 멈춘 곳이 안 보인다.
  if (run.status === 'attention' && !groups.some((g) => g.state === 'attention')) {
    const at = groups.find((g) => g.state !== 'done');
    if (at) at.state = 'attention';
  }
  return groups;
}

export function note(text, attention, extra, ic = 'info') {
  return h('div', { class: `sx-note${attention ? ' is-attention' : ''}` }, icon(ic), h('div', {}, text, extra ? h('div', { class: 'sx-meta' }, extra) : null));
}

/** 시험·스타일용 data 속성을 붙여 돌려준다. */
const tagged = (el, key, value) => ((el.dataset[key] = value), el);

export const btn = (label, onclick, kind = '', attrs = {}) => h('button', { type: 'button', class: `sx-btn ${kind}`.trim(), onclick, ...attrs }, label);

const vatText = (run) => (run.vat === 'separate' ? (run.status === 'draft' && run.vatGuessed ? '부가세 별도로 계산했어요' : '부가세 별도') : '부가세 포함');
const nowStep = (run) => runSteps(run).find((s) => s.state === 'now' || s.state === 'attention');
const line = (text, muted) => h('p', { class: `sx-body-sm${muted ? ' is-muted' : ''}` }, text);

/** 초안 카드의 오늘 중복 한 줄(F-10). 승인 카드에서도 엔진 원장으로 다시 경고한다. */
/** [홈택스에서 준비] 전 Chrome 사전 점검에서 Chrome이 없을 때(초안 카드). 엔진까지 가지 않았으므로 "보내지 않았어요". */
export const NO_CHROME_TEXT = 'Chrome이 설치돼 있어야 홈택스에서 준비할 수 있어요. Chrome을 설치한 뒤 [홈택스에서 준비]를 다시 눌러 주세요. 아직 아무것도 보내지 않았어요.';
/** Chrome 설치 안내(U6, 판의 할 일·첫 발급 요청). 주소는 글자로만 둔다(앱이 외부 링크를 열지 않는다). */
export const CHROME_GUIDE_TEXT = '홈택스 작업은 이 PC의 Chrome 창에서 해요. 다른 브라우저에서 google.com/chrome 을 열어 Chrome을 설치한 뒤 [다시 확인]을 눌러 주세요.';
export const DUP_TODAY_TEXT = '이미 오늘 같은 거래처·같은 금액으로 발급했어요. 한 번 더 발급하려는 게 맞는지 확인해 주세요.';

/**
 * 답 후보(Muse식, v2.0): 앱 말 아래 전폭 줄. 사장님은 가장 그럴듯한 답을 누르거나 그냥 입력창에 말한다.
 * opts = [{ label, onPick, act?, attrs?, lock? }]. lock(기본 true)이면 고른 줄은 체크로 굳고 나머지는 흐려진다(보낸 답은 되돌리지 않는다).
 * 폼을 여는 줄처럼 다시 누를 수 있어야 하면 lock: false.
 */
export function replyOptions(opts, attrs = {}) {
  const box = h('div', { class: 'sx-replies', role: 'group', ...attrs });
  const rows = opts.map((o) =>
    h(
      'button',
      {
        type: 'button',
        class: 'sx-reply',
        'data-act': o.act ?? null,
        ...(o.attrs ?? {}),
        onclick: (e) => {
          const row = e.currentTarget;
          if (box.dataset.picked) return;
          if (o.lock !== false) {
            box.dataset.picked = '1';
            for (const r of rows) r.disabled = r !== row;
            row.classList.add('is-picked');
            row.append(icon('check'));
          }
          o.onPick(e);
        },
      },
      h('span', {}, o.label),
    ),
  );
  box.append(...rows);
  return box;
}

/** 발급 PDF가 이 PC에 없을 때(F-04): 결과 카드·실행 패널·문서함 패널이 같은 문구. */
export const NO_FILE_TEXT = '세금계산서 PDF는 홈택스 발급목록에서 확인할 수 있어요.';

/** [홈택스 창 보기]: 사람이 할 일이 홈택스 창에 있을 때(로그인·서명·사람 차례). 실행 Chrome 창을 앞으로 올리기만 한다. 다른 주요 단추가 없으면 이것이 주요 단추다. */
const showBrowserBtn = (run, act, primary = false) => btn('홈택스 창 보기', () => act.showBrowser(run.id), primary ? 'sx-btn-primary' : '', { 'data-act': 'show-browser' });

/** 지금 단계 한 줄: 묶음 이름 · 메모. 할 일 줄이 같은 말을 하면 이름만(withNote false). */
const stepLine = (now, withNote = true) => (now ? (withNote && now.note ? `${now.label} · ${now.note}` : now.label) : '');

/** 할 일 한 줄(사람 차례·확인 필요): 본문 한 줄 + 보조 줄. 카드 안에 안내 상자를 또 두지 않는다(v2.0). */
const todoLine = (text, ...meta) => h('div', { class: 'sx-todo' }, h('p', {}, text), meta.filter(Boolean).map((m) => (m instanceof Node ? m : h('p', { class: 'sx-meta' }, m))));

/**
 * 실행 중 카드를 접는다(v2.0, 구조 감사 H3: 같은 실행이 카드·패널·띠 세 곳에 보이던 것).
 * 머리 한 줄 = 제목 · 지금 단계 · 상태 칩, 끝에 조용한 [중지](있을 때). 사람 차례·확인 필요일 때만 그 아래 할 일 한 줄과 주요 단추 하나를 붙인다.
 * 금액·단계 목록·값 목록은 패널에만 있다(카드를 누르면 act.open). taskCard가 먼저 붙인 머리·금액 줄은 여기서 바꾼다(승인 대기 접힘과 같은 방식).
 */
function fold(card, run, step, stop = null) {
  // 확인 필요는 안내 상자 대신 카드의 황토 안쪽 선으로 보인다(내 차례의 파랑 선과 같은 규칙).
  card.classList.toggle('is-attention', run.status === 'attention');
  card.replaceChildren(
    h('div', { class: 'sx-card-hd sx-run-hd' }, h('div', { class: 'sx-card-title' }, `세금계산서 · ${run.counterparty.name}`), h('span', { class: 'sx-card-now' }, step), chip(shownStatus(run)), stop),
  );
}
const stopBtn = (run, act) => btn('중지', () => act.stop(run.id), 'sx-btn-quiet', { 'data-act': 'stop' });

/** 대화 속 작업 카드(TaskCard). 상태가 바뀌면 같은 카드가 바뀐다. 캔버스 M-01·T-02~T-07 카드 순서: 머리 → 금액 → 문장 → 안내 → 버튼 줄. 실행 중에는 fold로 머리 한 줄로 접는다. */
export function taskCard(run, act) {
  const title = `세금계산서 · ${run.counterparty.name}`;
  // 대화에서 발급 전에 버린 초안(draft_discard): 무엇이었는지만 남기고 버튼은 없다.
  if (run.discarded)
    return h(
      'section',
      { class: 'sx-card is-discarded', 'data-run': run.id, 'data-status': 'discarded' },
      h('div', { class: 'sx-card-hd' }, h('div', { class: 'sx-card-title' }, title), chip('discarded')),
      h('p', { class: 'sx-meta' }, '발급 전에 취소한 카드예요. 홈택스에는 아무것도 보내지 않았어요.'),
    );
  const st = run.status;
  const card = h('section', { class: `sx-card${st === 'turn' || st === 'waiting' ? ' is-turn' : ''}`, 'data-run': run.id, 'data-status': st });
  // DOM append(null)은 "null" 글자를 넣는다(카드에 "null"이 보였다). 카드의 조건부 줄은 h()처럼 null·false를 건너뛴다.
  const domAppend = card.append.bind(card);
  card.append = (...kids) => domAppend(...kids.flat().filter((k) => k != null && k !== false));
  card.addEventListener('click', (e) => {
    if (!e.target.closest('button, input, select, dl, .sx-where')) act.open(run.id);
  });
  const hd = h('div', { class: 'sx-card-hd' }, h('div', { class: 'sx-card-title' }, title), chip(shownStatus(run)));
  // 내 차례·확인 필요는 합계만(사람이 할 일이 먼저 보이게), 나머지는 분해까지.
  // 작성 중에는 부가세가 아래 두 칸 전환에 있으므로 금액 줄에 다시 쓰지 않는다.
  card.append(hd, st === 'draft' ? null : amount(run.total, run.supply, run.tax, vatText(run), !['turn', 'attention'].includes(st)));
  const now = nowStep(run);

  if (st === 'draft') {
    const noItem = !String(run.item ?? '').trim();
    // v2.0 작성 카드: 값은 글자로 보이고, 누르면 그 자리에서 고친다(단추 네 개로 폼을 여는 대신). 부가세는 두 칸 전환.
    // 대화로 "부가세 포함으로", "품목은 유지보수"라고 말해도 같은 값을 바꾼다. 품목이 비면 [홈택스에서 준비]를 막는다(엔진 item_missing).
    const err = act.draftErr?.id === run.id ? h('p', { class: 'form-msg is-bad', role: 'alert', 'data-draft-err': '' }, act.draftErr.msg) : null;
    const keys = (save, cancel) => (e) => {
      if (e.isComposing) return;
      if (e.key === 'Enter') {
        e.preventDefault();
        save();
      }
      if (e.key === 'Escape') cancel();
    };
    const editRow = (label, ...kids) => [h('dt', {}, label), h('dd', { class: 'is-editing' }, ...kids)];
    const valBtn = (label, text, onclick, o = {}) =>
      h('button', { type: 'button', class: `sx-val-btn${o.cls ? ` ${o.cls}` : ''}`, 'data-act': o.act, 'aria-label': `${label}: ${text}. 눌러서 고치기`, onclick }, text);
    let rows;
    if (act.editingCp === run.id) {
      // 거래처(F-14): 장부의 거래처에서 고른다. [취소] 뒤 다시 말하지 않아도 된다.
      const others = (act.counterparties ?? []).filter((c) => c.id !== run.counterparty.id);
      const sel = h('select', { class: 'doc-in', name: 'counterparty', 'aria-label': '거래처' }, ...others.map((c) => h('option', { value: c.id }, c.name)));
      sel.addEventListener('keydown', keys(() => act.saveCp(run.id, sel.value), () => act.editCp(null)));
      rows = editRow(
        '거래처',
        others.length
          ? [h('div', { class: 'sx-actions', 'data-draft-cp': '' }, sel, btn('바꾸기', () => act.saveCp(run.id, sel.value), 'sx-btn-primary', { 'data-act': 'draft-cp-save' }), btn('그만두기', () => act.editCp(null), 'sx-btn-quiet', { 'data-act': 'draft-cp-cancel' }))]
          : [h('div', { class: 'sx-actions', 'data-draft-cp': '' }, h('span', { class: 'sx-meta' }, '장부에 다른 거래처가 없어요. 거래처 화면에서 추가할 수 있어요.'), btn('그만두기', () => act.editCp(null), 'sx-btn-quiet', { 'data-act': 'draft-cp-cancel' }))],
      );
      setTimeout(() => sel.focus(), 0);
    } else if (act.editing === run.id) {
      const input = h('input', { class: 'sx-amount-edit', type: 'text', inputmode: 'numeric', autocomplete: 'off', value: num(run.amount), 'aria-label': run.vat === 'separate' ? '공급가액' : '합계' });
      const save = () => act.saveAmount(run.id, input.value);
      input.addEventListener('keydown', keys(save, () => act.editAmount(null)));
      rows = editRow(run.vat === 'separate' ? '공급가액' : '합계', h('div', { class: 'sx-actions' }, input, btn('바꾸기', save, 'sx-btn-primary'), btn('그만두기', () => act.editAmount(null), 'sx-btn-quiet')));
      setTimeout(() => (input.focus(), input.select()), 0);
    } else if (act.editingFields === run.id) {
      const item = h('input', { class: 'doc-in', name: 'item', value: run.item ?? '', maxlength: 100, autocomplete: 'off', 'aria-label': '품목', placeholder: '예: 컨설팅 용역' });
      const email = h('input', { class: 'doc-in', name: 'email', type: 'email', inputmode: 'email', value: run.email.value ?? '', maxlength: 320, autocomplete: 'off', spellcheck: 'false', 'aria-label': '받는 이메일', placeholder: '비우면 메일을 보내지 않아요' });
      const save = () => act.saveFields(run.id, item.value, email.value);
      for (const i of [item, email]) i.addEventListener('keydown', keys(save, () => act.editFields(null)));
      rows = [
        ...editRow('품목', item),
        ...editRow('받는 이메일', email),
        h('dt', {}, ''),
        h('dd', { class: 'is-editing', 'data-draft-edit': '' }, h('div', { class: 'sx-actions' }, btn('바꾸기', save, 'sx-btn-primary', { 'data-act': 'fields-save' }), btn('그만두기', () => act.editFields(null), 'sx-btn-quiet', { 'data-act': 'fields-cancel' }))),
      ];
      setTimeout(() => (act.editingFocus === 'email' ? email : item).focus(), 0);
    } else {
      // 부가세: 별도 | 포함 두 칸. 고른 칸은 채움, 다른 칸을 누르면 바로 바뀐다.
      const vatSeg = h(
        'div',
        { class: 'sx-seg', role: 'group', 'aria-label': '부가세' },
        ...[['separate', '별도', 'included'], ['included', '포함', 'separate']].map(([v, label]) =>
          h('button', { type: 'button', class: run.vat === v ? 'is-on' : null, 'aria-pressed': String(run.vat === v), 'data-act': run.vat === v ? null : 'vat', onclick: run.vat === v ? null : () => act.vat(run.id, v) }, label),
        ),
      );
      rows = [
        h('dt', {}, '거래처'),
        h('dd', {}, valBtn('거래처', run.counterparty.name, () => act.editCp(run.id), { act: 'draft-cp' })),
        h('dt', {}, '부가세'),
        h('dd', {}, vatSeg, run.vatGuessed ? h('span', { class: 'sx-tag' }, '기본값') : null),
        h('dt', {}, '품목'),
        h('dd', { 'data-draft-item': run.item ?? '' }, valBtn('품목', `${noItem ? '비어 있음' : run.item}`, () => act.editFields(run.id, 'item'), { act: 'fields-edit', cls: noItem ? 'is-missing' : run.itemGuessed ? 'is-guessed' : '' }), !noItem && run.itemGuessed ? h('span', { class: 'sx-tag' }, '저장 품목') : null),
        h('dt', {}, '받는 이메일'),
        h('dd', { 'data-draft-email': run.email.value ?? '' }, valBtn('받는 이메일', run.email.value || '없음 · 메일은 보내지 않아요', () => act.editFields(run.id, 'email'), { act: 'email-edit', cls: run.email.value ? '' : 'is-none' })),
      ];
    }
    const editing = act.editingCp === run.id || act.editing === run.id || act.editingFields === run.id;
    // 금액 줄: 합계(굵게)를 누르면 금액을 고친다. 공급가·세액은 그 옆 보조 글자.
    card.append(
      h(
        'div',
        { class: 'sx-amount', 'data-draft-amount': '' },
        valBtn('금액', `${num(run.total)}원`, () => act.editAmount(run.id), { act: 'amount-edit', cls: 'is-total' }),
        h('span', { class: 'sx-amount-split' }, `공급가 ${num(run.supply)} + 세액 ${num(run.tax)}`),
      ),
    );
    card.append(
      run.noChrome ? h('div', { 'data-no-chrome': '' }, note(NO_CHROME_TEXT, true)) : null,
      run.dupToday ? h('div', { 'data-dup-today': '' }, note(DUP_TODAY_TEXT, true)) : null,
      h('dl', { class: 'sx-kv sx-draft', 'data-draft-fields': '' }, ...rows),
      err,
      editing
        ? null
        : h(
            'div',
            { class: 'sx-actions' },
            btn('홈택스에서 준비', () => act.prepare(run.id), 'sx-btn-primary', { 'data-act': 'prepare', disabled: noItem }),
            btn('취소', () => act.stop(run.id), 'sx-btn-quiet', { 'data-act': 'cancel' }),
          ),
      editing ? null : h('div', { class: 'sx-meta' }, noItem ? '품목을 넣으면 준비할 수 있어요.' : '값을 누르면 고칠 수 있어요 · 아직 아무것도 보내지 않았어요'),
    );
  } else if (st === 'preparing') {
    // v2.0(H3): 머리 한 줄(지금 단계) + 조용한 [중지]. "승인 전에는 발급하지 않아요"는 패널에 있다.
    // 로그인 단계: 엔진은 로그인 화면을 열고 최대 10분 기다린다(그 뒤에야 로그인 차례 카드). 사람 몫이라 할 일 한 줄과 [홈택스 창 보기]를 바로 보인다.
    const login = run.steps[0].state === 'now' && run.steps[0].note;
    if (login) card.dataset.loginNow = '';
    fold(card, run, stepLine(now, !login), stopBtn(run, act));
    if (login) card.append(todoLine(run.steps[0].note), h('div', { class: 'sx-actions' }, showBrowserBtn(run, act, true)));
  } else if (verifying(run)) {
    // 발급 후 조회 중(08 §11 "발급 후 응답 끊김" 행). 이 상태에서는 어떤 버튼도 다시 발급하지 않는다. 머리 한 줄만, 설명은 패널에 있다.
    fold(card, run, h('span', { 'data-verify-attempt': run.verifyAttempt ? String(run.verifyAttempt) : null }, run.verifyAttempt ? `발급목록에서 확인하는 중 · 조회 ${run.verifyAttempt}회째` : '발급목록에서 확인하는 중'));
  } else if (st === 'issuing' && run.steps[5].state === 'now' && run.steps[5].note) {
    // 승인 뒤 서명 단계: 사람 몫(인증서 비밀번호·간편인증 승인)을 바로 보인다. 엔진의 서명 차례(handoff)는 끝 표지를 기다린 뒤에야 온다.
    card.dataset.signNow = '';
    fold(card, run, stepLine(now, false));
    card.append(todoLine(`${run.steps[5].note}. 끝나면 자동으로 이어집니다`, '홈택스 발급목록에서 확인할 때까지 다시 발급하지 않아요.'), h('div', { class: 'sx-actions' }, showBrowserBtn(run, act, true)));
  } else if (st === 'issuing') {
    fold(card, run, stepLine(now));
  } else if (st === 'turn' && run.handoff) {
    // 사람 차례(D03 HandedOff, #278 셸 계약): 실행은 끝나지 않았다. 버튼은 재개·확인·중지로만 가고 발급하지 않는다.
    // 할 일 한 줄 + 주요 단추 하나, [중지]는 머리 줄 끝의 조용한 단추(v2.0).
    // - 로그인: [이어서](주요, 재개) · [홈택스 창 보기]
    // - 서명: 완료 창이 보이면 엔진이 스스로 넘어간다. [홈택스 창 보기]가 주요, [다 했어요]는 보조, [직접 발급함]은 없다(엔진 sign.turn_resume_only). [중지]는 발급목록 확인 뒤 끝난다.
    // - 그 밖: [다 했어요](주요) · [직접 발급함] · [홈택스 창 보기]
    const kind = run.handoff.kind ?? 'other';
    card.dataset.handoff = kind;
    fold(card, run, stepLine(now, false), btn('중지', () => act.stop(run.id), 'sx-btn-quiet', { 'data-act': 'stop' }));
    card.append(
      todoLine(run.turn.text, run.turn.note, kind === 'sign' ? h('p', { class: 'sx-meta', 'data-sign-wait': '' }, '서명을 마치면 앱이 발급목록을 확인해요. 그동안 다시 발급하지 않아요.') : null),
      h(
        'div',
        { class: 'sx-actions' },
        kind === 'sign' ? showBrowserBtn(run, act, true) : null,
        kind === 'login' ? btn('이어서', () => act.resume(run.id), 'sx-btn-primary', { 'data-act': 'resume' }) : btn('다 했어요', () => act.resume(run.id), kind === 'sign' ? '' : 'sx-btn-primary', { 'data-act': 'resume' }),
        kind === 'other' ? btn('직접 발급함', () => act.manualDone(run.id), '', { 'data-act': 'manual-done' }) : null,
        kind === 'sign' ? null : showBrowserBtn(run, act),
      ),
    );
  } else if (st === 'turn') {
    // 폰 간편인증 차례: 할 일은 폰에 있어 카드에 주요 단추가 없다.
    // 폰으로 다시 요청하기는 아직 없다: 누르면 '곧 지원'만 뜨던 [다시 요청]을 지웠다(v2.0). 서명 차례에는 [중지]도 없다.
    const signing = run.steps[4].state === 'done';
    fold(card, run, stepLine(now, false), signing ? null : stopBtn(run, act));
    card.append(todoLine(run.turn.text, run.turn.note));
  } else if (st === 'waiting') {
    // ADR-021 결정 7: 작성 카드는 "작성 완료" 한 줄로 접는다. 되읽은 값 전체·중복 경고·[중지]는 대화 열 아래 main 승인 카드에 있다.
    // 승인 뒤 2초(거부 우선 창)에는 승인 카드가 내려가므로 여기에 [중지]를 둔다.
    card.replaceChildren();
    card.classList.add('is-folded');
    card.append(
      ...[
        // 디자인 시스템 ApprovalCard: 체크 + "작성 완료" + 서류·거래처·합계 한 줄(초안의 값). 안내 문장은 두지 않는다(값이 바로 아래 카드에 있다).
        h('div', { class: 'sx-card-hd', 'data-folded': '' }, h('div', { class: 'sx-card-title sx-folded' }, icon('check'), '작성 완료'), h('span', { class: 'sx-meta sx-folded-line' }, `세금계산서 · ${run.counterparty.name} · ${won(run.total)}`), chip(shownStatus(run))),
        run.regate ? tagged(note(run.regate.note, true), 'regate', run.regate.reason) : null,
        run.approvedPending ? h('div', { class: 'sx-actions' }, note('승인했어요. 2초 안에 [중지]하면 발급하지 않아요'), btn('중지', () => act.stop(run.id), 'sx-btn-quiet', { 'data-act': 'stop' })) : null,
      ].filter(Boolean),
    );
  } else if (st === 'done') {
    const r = run.result;
    const mail = r.mailConfirmed ? `${run.counterparty.name} 메일로 보낸 것도 확인했어요.` : r.mailTo ? '메일 발송은 홈택스 메일발송목록에서 확인해 주세요.' : '받는 이메일이 없어 메일은 보내지 않았어요.';
    const where = whereItWent(run);
    where.hidden = true;
    const toggle = btn('어디로 무엇이 갔나요', () => {
      where.hidden = !where.hidden;
      toggle.setAttribute('aria-expanded', String(!where.hidden));
    }, 'sx-btn-quiet', { 'aria-expanded': 'false' });
    card.append(
      line(`발급했어요. ${mail}`),
      h('dl', { class: 'sx-kv is-start' }, h('dt', {}, '승인번호'), h('dd', {}, h('span', { class: 'sx-id', 'data-approval-no': '' }, r.approvalNo), h('button', { type: 'button', class: 'sx-copy', onclick: () => act.copy(r.approvalNo) }, '복사'))),
      r.noFile ? line(NO_FILE_TEXT, true) : null,
      h('div', { class: 'sx-actions' }, r.noFile ? null : btn('PDF 열기', () => act.openRunDoc(run), 'sx-btn-primary', { 'data-act': 'result-open' }), btn('지난번과 같게', () => act.again(run)), toggle),
      where,
    );
  } else if (st === 'stopped') {
    card.append(line(run.stoppedNote || '중지했어요.', true));
    // 브라우저가 닫혀 멈춘 제출 전 실행: 같은 값으로 바로 다시 시작
    if (run.browserClosed) card.append(h('div', { class: 'sx-actions' }, btn('다시 시작', () => act.restart(run.id), 'sx-btn-primary', { 'data-act': 'restart' })));
  } else if (st === 'attention' && run.inDoubt) {
    // InDoubt 카드(08 §11): 발급됐는지 모른다. 다시 발급하는 버튼은 두지 않는다. 직접 확인할 곳(패널의 찾을 값)만 연다.
    card.dataset.inDoubt = '1';
    fold(card, run, stepLine(now, false));
    card.append(
      todoLine(
        run.stoppedNote || '발급됐는지 확인하지 못했어요.',
        '확인되기 전에는 이 건을 다시 발급하지 않아요.',
        // 증언 상태 문구는 main이 고른 고정 문장(ATTEST_NOTE)이다. 확인 결과를 보내는 버튼은 카드에 없다(바 클릭으로만 받는다).
        run.attest?.note ? h('p', { class: 'sx-meta', 'data-attest': run.attest.state }, run.attest.note) : null,
      ),
      h('div', { class: 'sx-actions' }, btn('홈택스에서 직접 확인', () => act.open(run.id), 'sx-btn-primary', { 'data-act': 'check-list' })),
    );
  } else if (st === 'attention') {
    fold(card, run, stepLine(now, false));
    card.append(
      todoLine(run.stoppedNote || '확인이 필요해요.'),
      // 승인 전 핸드오프 끝: [다시 준비]·[홈택스에서 직접 발급]. 그 밖에 발급 전에 멈췄으면 [다시 준비](새 초안). Chrome 확장 멈춤은 아래 [다시 시도]가 맡는다.
      // 홈택스 점검(portal.maintenance): 끝 시각을 알면 main이 자동으로 다시 시작한다(버튼 없음). 모르면 [다시 시작]. 다시 시작했으면 버튼 없음.
      run.maintenance
        ? run.maintenance.restartedAs
          ? line('같은 내용으로 다시 시작했어요. 아래 새 카드에서 이어져요.', true)
          : run.maintenance.until
            ? h('div', { class: 'sx-meta', 'data-maintenance': 'auto' }, `${run.maintenance.until} 지나면 자동으로 다시 시작해요`)
            : h('div', { class: 'sx-actions', 'data-maintenance': 'manual' }, btn('다시 시작', () => act.restart(run.id), 'sx-btn-primary', { 'data-act': 'maintenance-restart' }))
        : run.handoffEnd
        ? h('div', { class: 'sx-actions' }, btn('다시 준비', () => act.redraft(run.id), 'sx-btn-primary', { 'data-act': 'handoff-again' }), btn('홈택스에서 직접 발급', () => act.open(run.id), '', { 'data-act': 'handoff-manual' }))
        : run.redo && !run.retry
          ? h('div', { class: 'sx-actions' }, btn('다시 준비', () => act.redraft(run.id), 'sx-btn-primary', { 'data-act': 'redo' }))
          : null,
    );
  }
  // 포털 안내 문구·금고 알림(텍스트 노드로만).
  for (const t of run.notices || []) card.append(note(t, true));
  // 금고가 Chrome 확장을 보고 멈춘 실행이 발급 없이 끝났으면 [다시 시도]: 같은 요청을 입력창에 채우기만 한다(보내기·준비는 사용자가, [지난번과 같게]와 같은 길).
  if (run.retry && !run.result && !run.inDoubt && (st === 'stopped' || st === 'attention')) {
    card.append(h('div', { class: 'sx-actions' }, btn('다시 시도', () => act.again(run), 'sx-btn-primary', { 'data-act': 'retry' })));
  }
  return card;
}

/**
 * 활동 기록의 모델·우리 서버 줄(팀장 결정 2026-11-07). 해석 결과(via)가 아니라 main이 관찰한 실제 송신(run.sent)으로만 만든다.
 * - openrouter_demo: 시연 모델을 불렀다(성공 여부와 무관). gateway.*: main이 그 경로의 게이트웨이 헤더를 내줬다.
 * 모르는 값은 버린다. 아무것도 없으면 "쓰지 않음"·"보낸 것 없음".
 */
const sentSet = (sent) => new Set(Array.isArray(sent) ? sent.filter((x) => typeof x === 'string') : []);
export const modelRow = (sent) => {
  const s = sentSet(sent);
  if (s.has('openrouter_demo')) return ['AI', '시연용 외부 AI · 채팅 문장과 가상 거래처 이름만 보냄'];
  if (s.has('gateway.decide')) return ['AI', '요청 이해에 씀 · 이름·번호를 가린 요청 문장만 보냄'];
  return ['AI', '쓰지 않음(요청은 이 PC 안에서 이해함)'];
};
export const serverRow = (sent) => {
  const s = sentSet(sent);
  const parts = [s.has('gateway.run_tokens') ? '실행 허가 받기(문장 없음)' : null, s.has('gateway.decide') ? '이름·번호를 가린 요청 문장' : null, s.has('gateway.respond') ? '이름·번호를 가린 대화 문장(짧은 답)' : null].filter(Boolean);
  return ['우리 서버', parts.length ? parts.join(', ') : '보낸 것 없음'];
};
/** 활동 기록 표의 모델 칸. */
export const modelCell = (sent) => {
  const s = sentSet(sent);
  return s.has('openrouter_demo') ? '시연용 AI' : s.has('gateway.decide') ? '우리 서버' : null;
};

/** "어디로 무엇이 갔나요"(활동 기록 행을 카드 안에서 펼친 것). */
/**
 * 여러 건 묶음 카드(한 카드, [승인] 한 번, main ShellRuns batch). 건마다 한 줄(순번 · 거래처 · 합계 · 상태 · 승인번호).
 * 진행 중인 건과 사람이 볼 건(확인 필요·다시 시작)은 그 줄 자리에 실행 카드로, 승인 전 다음 초안은 목록 아래 작성 카드로 둔다.
 */
export function batchCard(runs, act) {
  const live = (r) => ['preparing', 'turn', 'waiting', 'issuing'].includes(r.status);
  const done = runs.filter((r) => r.status === 'done').length;
  const total = runs.reduce((n, r) => n + (r.discarded ? 0 : Number(r.total) || 0), 0);
  const focus = runs.find(live) ?? runs.find((r) => r.status === 'draft' && !r.discarded) ?? null;
  const approved = runs.some((r) => r.batch?.approved);
  const halted = runs.some((r) => r.batch?.halted);
  const ended = !focus;
  const extra = runs.filter((r) => r !== focus && !r.discarded && (r.status === 'attention' || (r.status === 'stopped' && (r.redo || r.browserClosed))));
  // 진행 중인 건과 사람이 볼 건은 목록의 제 줄 자리에 실행 카드로 둔다(같은 건을 줄과 카드로 두 번 그리지 않는다, v2.0 H3).
  // 승인 전 지금 건(초안)은 지금처럼 목록 아래 작성 카드다.
  const inRow = new Set([...(focus && live(focus) ? [focus] : []), ...extra]);
  const rows = runs.map((r) =>
    inRow.has(r)
      ? h('li', { class: 'is-card', 'data-batch-row': r.id, 'data-status': shownStatus(r) }, taskCard(r, act))
      : h(
          'li',
          { 'data-batch-row': r.id, 'data-status': r.discarded ? 'discarded' : shownStatus(r), onclick: () => act.open(r.id) },
          h('span', { class: 'sx-batch-name' }, `${(r.batch?.index ?? 0) + 1}. ${r.counterparty.name}`),
          h('span', { class: 'sx-batch-amt' }, `${num(r.total)}원`),
          r.discarded ? chip('discarded') : chip(shownStatus(r)),
          r.result?.approvalNo ? h('span', { class: 'sx-batch-no' }, `승인번호 ${r.result.approvalNo}`) : null,
        ),
  );
  const lead = ended
    ? `${runs.length}건 중 ${done}건 발급했어요.`
    : halted
      ? `${runs.length}건 중 ${done}건 발급하고 묶음을 멈췄어요. 남은 건은 [홈택스에서 준비]를 누르면 승인 카드에서 한 건씩 승인해요.`
      : approved
      ? '한 번 승인으로 차례로 발급하고 있어요. 홈택스 값이 승인 때와 다르면 그 건만 다시 물어요.'
      : `모두 합계 ${num(total)}원. 첫 승인 카드에서 한 번 승인하면 나머지는 차례로 발급해요.`;
  return h(
    'article',
    { class: 'sx-card sx-batch', 'data-batch': runs[0].batch.id, 'data-done': done },
    h('div', { class: 'sx-card-hd' }, h('div', { class: 'sx-card-title' }, `세금계산서 ${runs.length}건 · 차례로 발급`), h('span', { class: `sx-chip${ended ? ' is-done' : ''}` }, `${done}/${runs.length} 발급`)),
    h('p', { class: 'sx-meta' }, lead),
    h('ol', { class: 'sx-batch-list' }, rows),
    focus && !inRow.has(focus) ? taskCard(focus, act) : null,
  );
}

export function whereRows(run) {
  return [
    ['홈택스', '전자세금계산서 1건 발급 · 발급목록에서 확인'],
    ['메일', run.result.mailTo ? `${run.result.mailTo} · 홈택스가 보냄, ${run.result.mailConfirmed ? '메일발송목록에서 확인' : '메일발송목록에서 확인하지 못함'}` : '보내지 않음'],
    ['보관', '이 PC 문서함 · 파일명에는 거래처·승인번호를 넣지 않아요'],
    modelRow(run.sent),
    serverRow(run.sent),
  ];
}
function whereItWent(run) {
  return h('div', { class: 'sx-where' }, kv(whereRows(run), true));
}

const panelX = (act) => h('button', { type: 'button', class: 'panel-x', 'aria-label': '패널 닫기', onclick: act.closePanel }, icon('close'));

/** 작업 패널(캔버스 M-01 오른쪽): D2 제목 + 상태 → D1 → KeyValue(발급 인증 포함) → D6 출처 → 실행 단계 → 버튼. 승인 버튼은 없다. */
export function runPanel(run, act) {
  const st = run.status;
  const confirmed = run.confirmed;
  const tag = confirmed ? { state: 'verified', tag: '홈택스 확정' } : {};
  const r = run.result;
  const guessed = [run.vatGuessed ? '부가세' : null, run.itemGuessed ? '품목' : null].filter(Boolean);
  const rows = [
    st === 'done' && r ? ['승인번호', r.approvalNo, { mono: true }] : null,
    ['공급자', act.supplier()],
    ['공급받는자', run.counterparty.name, { ...tag, flag: run.counterparty.first ? '처음 거래' : null }],
    ['사업자번호', fmtBiz(run.counterparty.bizNo), { ...tag, mono: true }],
    st === 'draft' ? ['부가세', run.vat === 'separate' ? '별도' : '포함', run.vatGuessed ? { state: 'inferred', tag: '기본값' } : {}] : null,
    ['공급가', won(run.supply), tag],
    ['세액', won(run.tax), confirmed ? tag : run.vatGuessed ? { state: 'inferred', tag: '추정' } : {}],
    ['품목', run.item || null, confirmed ? tag : run.itemGuessed ? { state: 'inferred', tag: '저장 품목' } : {}],
    ['작성일자', run.writeDate, tag],
    ['받는 이메일', run.email.value, { ...(st === 'done' && r?.mailConfirmed ? { state: 'verified', tag: '전송 확인' } : tag), flag: run.email.first ? '처음 보내는 주소' : null }],
    ['발급 인증', run.auth, { tag: '설정에서 변경' }],
  ];
  const source =
    st === 'done' && r
      ? `홈택스 발급목록에서 확인 · ${r.doneAt}`
      : confirmed
        ? `홈택스에서 다시 읽음 · ${run.createdAt} 요청`
        : st === 'draft'
          ? `초안 · ${guessed.length ? `추정 값 ${guessed.length}개 · ` : ''}아직 아무것도 보내지 않았어요`
          : `요청 문장과 거래처 장부에서 채움 · ${run.createdAt}`;
  // 작업 패널의 [중지](T-04). 발급 전에만 있다. 승인은 여기에도 없다. 무게는 카드와 같은 조용한 단추다(v2.0).
  // 사람 차례면 게이트 뒤(서명 차례)여도 [중지]를 받는다(#278): 서명 차례는 발급목록 확인 뒤 끝난다.
  const canStop = st === 'preparing' || st === 'waiting' || (st === 'turn' && (!!run.handoff || run.steps[4].state !== 'done'));
  // 카드는 머리 한 줄로 접혔다(H3). 카드에서 뺀 안심 문장은 실행 단계 아래에 둔다.
  const promise = st === 'preparing' ? '승인하기 전에는 아무것도 발급하지 않아요.' : st === 'issuing' ? '홈택스 발급목록에서 확인할 때까지 다시 발급하지 않아요.' : null;
  return h(
    'div',
    { class: 'panel-in', 'data-panel-run': run.id },
    h('div', { class: 'sx-card-hd' }, h('div', { class: 'sx-card-title' }, `세금계산서 · ${run.counterparty.name}`), chip(shownStatus(run)), panelX(act)),
    amount(run.total, run.supply, run.tax, vatText(run)),
    st === 'attention' && run.inDoubt ? checkListGuide(run, act) : null,
    kv(rows),
    h('div', { class: 'sx-source' }, source),
    h('div', { class: 'sx-panel-sec' }, '실행 단계'),
    steps(runSteps(run)),
    promise ? line(promise, true) : null,
    canStop ? h('div', { class: 'sx-actions' }, btn('중지', () => act.stop(run.id), 'sx-btn-quiet', { 'data-act': 'panel-stop' })) : null,
    st === 'done' ? (run.result.noFile ? line(NO_FILE_TEXT, true) : h('div', { class: 'sx-actions' }, btn('PDF 열기', () => act.openRunDoc(run), 'sx-btn-primary'), btn('폴더 열기', () => act.openRunDoc(run, true)))) : null,
  );
}

/** 실행 중 홈택스 화면을 보이는 상태(B3). */
export const BROWSER_STATUSES = ['preparing', 'turn', 'waiting', 'issuing'];
// 금고가 보내는 주소는 "호스트/경로"(scheme·쿼리 없음, vault pageAddress). 홈택스 허용 목록은 https만 쓰고 시험 페이지만 http다.
const parseUrl = (url) => {
  const i = url.indexOf('/');
  const host = i < 0 ? url : url.slice(0, i);
  const rest = i < 0 ? '' : url.slice(i);
  return { secure: !!host && !/^(127\.0\.0\.1|localhost)(:|$)/.test(host), host, rest: rest === '/' ? '' : rest };
};
/** 탭 제목: 홈택스는 이름으로, 시험 페이지는 시험이라고. */
export function browserTabTitle(url) {
  const { host } = parseUrl(url ?? '');
  if (/(^|\.)hometax\.go\.kr$/.test(host)) return '국세청 홈택스';
  if (/^(127\.0\.0\.1|localhost)(:|$)/.test(host)) return '홈택스(시험 페이지)';
  return host || '홈택스';
}
/** 주소창 내용(읽기 전용): 자물쇠 · 호스트 · 나머지 경로. */
export function browserUrlParts(url) {
  const u = parseUrl(url ?? '');
  if (!u.host) return [h('span', { class: 'bp-host' }, '홈택스')];
  return [u.secure ? icon('lock') : null, h('span', { class: 'bp-host' }, u.host), u.rest ? h('span', { class: 'bp-path' }, u.rest) : null];
}
/**
 * 앱 안 브라우저(Claude 데스크톱 브라우저 창 모양, 대표 2026-11-13): 탭 줄 · 주소창 · 가장자리까지 채운 화면.
 * 화면은 금고 중계 그림이고 직접 눌러·쳐서 조작한다(shell.js wireScreen). 내용은 paintScreen이 채운다.
 */
export function browserPane(run, url, big, act) {
  if (!BROWSER_STATUSES.includes(run.status)) return null;
  return h(
    'section',
    { class: 'bp', 'data-browser-pane': run.id, 'aria-label': '앱 안 브라우저' },
    act.browserDrag ? h('div', { class: 'bp-resize', role: 'separator', 'aria-orientation': 'vertical', 'aria-label': '브라우저 폭 조절', title: '끌어서 폭 조절', onpointerdown: act.browserDrag }) : null,
    h(
      'div',
      { class: 'bp-chrome' },
      h(
        'div',
        { class: 'bp-tabs' },
        h('div', { class: 'bp-tab', title: url || '' }, h('span', { class: 'bp-fav' }, icon('globe')), h('span', { class: 'bp-tab-title', id: 'browser-tab-title' }, browserTabTitle(url))),
        h('button', { type: 'button', class: 'bp-icon', 'data-act': 'browser-size', 'aria-pressed': String(big), title: big ? '브라우저 작게' : '브라우저 크게', 'aria-label': big ? '브라우저 작게' : '브라우저 크게', onclick: () => act.browserSize(!big) }, icon(big ? 'shrink' : 'expand')),
      ),
      h(
        'div',
        { class: 'bp-bar' },
        h('div', { class: 'bp-url', id: 'browser-addr', role: 'status', 'aria-label': '홈택스 주소(읽기 전용)', title: url || '' }, ...browserUrlParts(url)),
        h('span', { class: 'bp-state', 'data-bp-state': 'loading', title: '이 화면을 직접 눌러 조작할 수 있어요. 인증서 비밀번호는 앱 금고 창에서 받아요.' }, '불러오는 중'),
      ),
    ),
    h('div', { class: 'run-screen', 'data-run-screen': run.id }, h('p', { class: 'sx-meta' }, '홈택스 화면을 불러오는 중이에요')),
  );
}

/**
 * InDoubt 패널의 "홈택스에서 직접 확인" 안내. 찾을 건의 값(작성일자·공급받는자·사업자번호·합계)과 복사만 둔다.
 * "발급목록에 없음" 확인은 여기서 받지 않는다. 승인 카드 자리의 황토색 증언 카드(main)에서만 받는다(ADR-021 결정 5·7).
 */
function checkListGuide(run, act) {
  const c = (v) => () => act.copy(v);
  return h(
    'div',
    { class: 'sx-check', 'data-check-list': run.id },
    h('div', { class: 'sx-panel-sec' }, '홈택스에서 직접 확인'),
    note('홈택스 발급목록에서 아래 건을 찾아 주세요. 목록에 있으면 발급된 것이니 다시 발급하지 마세요.', true),
    kv([
      ['작성일자', run.writeDate, { copy: c(run.writeDate) }],
      ['공급받는자', run.counterparty.name, { copy: c(run.counterparty.name) }],
      ['사업자번호', fmtBiz(run.counterparty.bizNo), { mono: true, copy: c(fmtBiz(run.counterparty.bizNo)) }],
      ['합계', won(run.total), { copy: c(String(run.total)) }],
    ]),
    h('div', { class: 'sx-meta' }, '목록에 없다는 확인은 대화 아래에 뜨는 황토색 확인 카드로만 받아요. 확인한 뒤 다시 발급하려면 새로 승인해야 해요.'),
    run.attest?.note ? note(run.attest.note, run.attest.state !== 'sent') : null,
  );
}

/** 지난 결과(타임라인 위쪽 기록). */
export function pastCard(p, act) {
  return h(
    'section',
    { class: 'sx-card' },
    h('div', { class: 'sx-card-hd' }, h('div', { class: 'sx-card-title' }, `${p.title} · ${p.who}`), chip('done')),
    amount(p.total, p.supply, p.tax),
    h('dl', { class: 'sx-kv is-start' }, h('dt', {}, '승인번호'), h('dd', {}, h('span', { class: 'sx-id' }, p.approvalNo), h('button', { type: 'button', class: 'sx-copy', onclick: () => act.copy(p.approvalNo) }, '복사'))),
    h('div', { class: 'sx-meta' }, `${p.mail}로 보낸 것도 확인했어요`),
  );
}

export function summaryCard(s) {
  return h('section', { class: 'sx-card' }, h('div', { class: 'sx-card-hd' }, h('div', { class: 'sx-card-title' }, '등록 내용'), h('span', { class: 'sx-meta' }, '온보딩 요약')), kv(s.rows, true));
}

/** 만료일 출처 표시(데이터 위계 '값의 확실성'): 문서에서 읽음 / 추정(규칙표) / 확인함. 확인 필요인 값은 출처와 상관없이 추정이다. */
const EXPIRY_TAG = { document: '문서', rule: '추정', user: '확인함' };
export const expiryTag = (doc) => (doc.vault.needsUser ? '추정' : (EXPIRY_TAG[doc.vault.expirySource] ?? ''));

/** 종류 · 출처 한 줄(직접 추가 서류는 둘이 같아 한 번만). */
const docKind = (doc) => (doc.kind === doc.source ? doc.kind : `${doc.kind} · ${doc.source}`);

/** 서류 세 칸(발급일 · 용도 · 유효). 보관함 서류는 유효 칸에 확실성(추정·확인함)을 붙인다. */
function docCells(doc, today) {
  const d = dday(doc.expiresOn, today);
  const v = doc.vault;
  const inferred = v && doc.expiresOn && (v.expirySource === 'rule' || v.needsUser);
  return h(
    'div',
    { class: 'sx-cells' },
    h('div', {}, h('span', { class: 'label sx-meta' }, '발급일'), h('span', { class: 'value' }, doc.issuedOn ? h('span', { class: 'doc-date' }, doc.issuedOn) : '—')),
    h('div', {}, h('span', { class: 'label sx-meta' }, '용도'), h('span', { class: `value${doc.purpose ? '' : ' is-none'}` }, doc.purpose || '—')),
    h(
      'div',
      { class: inferred ? 'is-inferred' : v?.expirySource === 'user' ? 'is-verified' : null },
      h('span', { class: 'label sx-meta' }, '유효'),
      // 캔버스처럼 칸 값은 D-n 하나, 만료일과 확실성은 그 아래 작은 글자로(날짜가 칸 중간에서 끊기지 않게).
      h('span', { class: `value sx-val${d !== null && d <= 7 ? ' is-attention' : ''}${d === null ? ' is-none' : ''}` }, ddayText(d)),
      doc.expiresOn ? h('span', { class: 'sx-tag' }, h('span', { class: 'doc-date' }, doc.expiresOn), v ? ` · ${expiryTag(doc)}` : '') : null,
    ),
  );
}

/** 대화 속 서류 카드(DocumentCard): 종류 → 서류 이름 → 세 칸(v2.0: 도장 없음). */
export function docCard(doc, today) {
  return h(
    'section',
    { class: 'sx-card sx-doc', 'data-doc': doc.id },
    h('div', { class: 'sx-doc-kind' }, docKind(doc)),
    h('div', { class: 'sx-doc-name' }, doc.docName),
    docCells(doc, today),
  );
}

/** 문서함 상세 패널: 종류 줄(닫기) → 이름 → 세 칸 → 값 → 버튼 → 출처(v2.0: 도장·가짜 미리보기 없음). 보관함 서류는 확인 구역(review)이 버튼 자리에 온다. */
export function docPanel(doc, today, act, review) {
  return h(
    'div',
    { class: 'panel-in', 'data-panel-doc': doc.id },
    h('div', { class: 'doc-kind-row' }, h('span', { class: 'sx-doc-kind' }, docKind(doc)), panelX(act)),
    h('div', { class: 'doc-head' }, h('div', { class: 'sx-doc-name' }, doc.docName)),
    docCells(doc, today),
    review ?? [
      kv([
        ['표시 이름', doc.name],
        ['프로필', doc.profile === 'business' ? '사업자' : '개인'],
        ['보관', doc.noFile ? '홈택스 발급목록' : '이 PC 문서함'],
      ]),
      doc.noFile ? h('p', { class: 'sx-body-sm is-muted', 'data-doc-nofile': '' }, NO_FILE_TEXT) : null,
      h('div', { class: 'sx-actions' }, doc.noFile ? null : btn('열기', () => act.openDoc(doc.id), 'sx-btn-primary', { 'data-act': 'doc-open' }), doc.source === '앱이 발급' && !doc.noFile ? btn('다시 발급', () => act.reissue(doc)) : null),
      h('div', { class: 'sx-source' }, `${doc.source}${doc.issuedOn ? ` · ${doc.issuedOn}` : ''} · 파일명에는 거래처·승인번호를 넣지 않아요`),
    ],
  );
}

/**
 * 홈택스 공동인증서 프로그램(MagicLine4NX) 안내 한 화면(B4). st: main security.check 결과, ops: { install, start, check }(각각 main 호출 → 새 상태).
 * 없음이면 [설치 파일 받기](홈택스 공식 파일을 기본 브라우저로), 꺼짐이면 [켜기], 둘 다 [다시 확인]. 괜찮아지면 onOk를 부르고 사라진다.
 */
export function securityBox(st, ops, onOk) {
  const box = h('div', { class: 'sx-note is-attention onb-security', 'data-security': st.state });
  const draw = (s) => {
    box.dataset.security = s.state;
    box.replaceChildren();
    if (s.state !== 'missing' && s.state !== 'stopped') {
      box.remove();
      onOk?.(s);
      return;
    }
    const missing = s.state === 'missing';
    const run = (fn) => async () => {
      try {
        const r = await fn();
        if (r && r.state) draw(r);
      } catch {
        /* 버튼만 다시 누르게 둔다 */
      }
    };
    box.append(
      icon('info'),
      h(
        'div',
        {},
        h('b', {}, missing ? '홈택스 공동인증서 프로그램이 이 PC에 없어요' : '홈택스 공동인증서 프로그램이 꺼져 있어요'),
        h('p', { class: 'sx-body-sm' }, missing ? `홈택스에서 공동인증서로 로그인·서명하려면 ${s.name}이 있어야 해요. 홈택스 공식 설치 파일을 받아 설치한 뒤 [다시 확인]을 눌러 주세요.` : `${s.name}을 켜야 홈택스가 이 PC의 인증서를 읽어요.`),
        missing && s.installUrl ? h('div', { class: 'sx-meta' }, s.installUrl) : null,
        h(
          'div',
          { class: 'sx-actions' },
          missing && s.installUrl ? btn('설치 파일 받기', run(async () => (await ops.install(), null)), 'sx-btn-primary', { 'data-act': 'security-install' }) : null,
          !missing && s.canStart ? btn('켜기', run(ops.start), 'sx-btn-primary', { 'data-act': 'security-start' }) : null,
          btn('다시 확인', run(ops.check), '', { 'data-act': 'security-check' }),
        ),
      ),
    );
  };
  draw(st);
  return box;
}
