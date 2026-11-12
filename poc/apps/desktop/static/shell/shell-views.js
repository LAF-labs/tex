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
  pencil: [16, 'M3 13l.7-2.8L10.9 3a1.4 1.4 0 0 1 2 2l-7.2 7.2z'],
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
  attention: ['확인 필요', 'is-attention'],
};
export const chip = (status) => h('span', { class: `sx-chip ${CHIP[status][1]}` }, CHIP[status][0]);

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
    list.map((s) => h('li', { class: s.state === 'todo' ? null : `is-${s.state}` }, h('span', {}, s.label, s.note ? h('small', {}, s.note) : null))),
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
    const xs = idx.map((i) => run.steps[i]).filter(Boolean);
    const pick = (st) => xs.find((s) => s.state === st);
    const att = pick('attention');
    const now = pick('now');
    if (att) return { label, state: 'attention', note: att.note };
    if (now) return { label, state: 'now', note: now.note };
    if (xs.length && xs.every((s) => s.state === 'done')) return { label, state: 'done', note: xs.map((s) => s.note).filter(Boolean)[0] };
    if (xs.some((s) => s.state === 'done') && ACTIVE.includes(run.status)) return { label, state: 'now' };
    return { label, state: 'todo' };
  });
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
export const DUP_TODAY_TEXT = '이미 오늘 같은 거래처·같은 금액으로 발급했어요. 한 번 더 발급하려는 게 맞는지 확인해 주세요.';

/** 발급 PDF가 이 PC에 없을 때(F-04): 결과 카드·실행 패널·문서함 패널이 같은 문구. */
export const NO_FILE_TEXT = '세금계산서 PDF는 홈택스 발급목록에서 확인할 수 있어요.';

/** 대화 속 작업 카드(TaskCard). 상태가 바뀌면 같은 카드가 바뀐다. 캔버스 M-01·T-02~T-07 카드 순서: 머리 → 금액 → 문장 → 안내 → 버튼 줄. */
export function taskCard(run, act) {
  const title = `세금계산서 · ${run.counterparty.name}`;
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
  card.append(hd, amount(run.total, run.supply, run.tax, vatText(run), !['turn', 'attention'].includes(st)));
  const now = nowStep(run);

  if (st === 'draft') {
    const noItem = !String(run.item ?? '').trim();
    // 품목·받는 이메일은 카드에서 보이고 그 자리에서 고친다(08 §2). 품목이 비면 [홈택스에서 준비]를 막는다(엔진 item_missing).
    card.append(
      h(
        'div',
        { class: 'sx-meta', 'data-draft-fields': '' },
        h('span', { 'data-draft-item': run.item ?? '' }, `품목 · ${noItem ? '비어 있음' : run.item}${!noItem && run.itemGuessed ? ' (저장 품목)' : ''}`),
        ' · ',
        h('span', { 'data-draft-email': run.email.value ?? '' }, `받는 이메일 · ${run.email.value || '없음(메일은 보내지 않아요)'}`),
      ),
    );
    if (act.editingFields === run.id) {
      const item = h('input', { class: 'doc-in', name: 'item', value: run.item ?? '', maxlength: 100, autocomplete: 'off', 'aria-label': '품목', placeholder: '예: 컨설팅 용역' });
      const email = h('input', { class: 'doc-in', name: 'email', type: 'email', value: run.email.value ?? '', maxlength: 320, autocomplete: 'off', 'aria-label': '받는 이메일' });
      const save = () => act.saveFields(run.id, item.value, email.value);
      for (const i of [item, email])
        i.addEventListener('keydown', (e) => {
          if (e.key === 'Enter' && !e.isComposing) save();
          if (e.key === 'Escape') act.editFields(null);
        });
      card.append(
        h('div', { class: 'cp-form', 'data-draft-edit': '' }, h('label', { class: 'cp-field' }, h('span', { class: 'sx-meta' }, '품목'), item), h('label', { class: 'cp-field' }, h('span', { class: 'sx-meta' }, '받는 이메일(비우면 메일을 보내지 않아요)'), email)),
        h('div', { class: 'sx-actions' }, btn('바꾸기', save, 'sx-btn-primary', { 'data-act': 'fields-save' }), btn('그만두기', () => act.editFields(null), 'sx-btn-quiet', { 'data-act': 'fields-cancel' })),
      );
      setTimeout(() => item.focus(), 0);
    } else if (act.editingCp === run.id) {
      // 거래처 바꾸기(F-14): 장부의 거래처에서 고른다. [취소] 뒤 다시 말하지 않아도 된다.
      const others = (act.counterparties ?? []).filter((c) => c.id !== run.counterparty.id);
      const sel = h('select', { class: 'doc-in', name: 'counterparty', 'aria-label': '거래처' }, ...others.map((c) => h('option', { value: c.id }, c.name)));
      card.append(
        others.length
          ? h('div', { class: 'sx-actions', 'data-draft-cp': '' }, h('span', { class: 'sx-meta' }, '거래처'), sel, btn('바꾸기', () => act.saveCp(run.id, sel.value), 'sx-btn-primary', { 'data-act': 'draft-cp-save' }), btn('그만두기', () => act.editCp(null), 'sx-btn-quiet', { 'data-act': 'draft-cp-cancel' }))
          : h('div', { class: 'sx-actions', 'data-draft-cp': '' }, h('span', { class: 'sx-meta' }, '장부에 다른 거래처가 없어요. 거래처 화면에서 추가할 수 있어요.'), btn('그만두기', () => act.editCp(null), 'sx-btn-quiet', { 'data-act': 'draft-cp-cancel' })),
      );
      setTimeout(() => sel.focus(), 0);
    } else if (act.editing === run.id) {
      const input = h('input', { class: 'sx-amount-edit', type: 'text', inputmode: 'numeric', value: num(run.amount), 'aria-label': '금액' });
      const save = () => act.saveAmount(run.id, input.value);
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.isComposing) save();
        if (e.key === 'Escape') act.editAmount(null);
      });
      card.append(h('div', { class: 'sx-actions' }, h('span', { class: 'sx-meta' }, run.vat === 'separate' ? '공급가액' : '합계'), input, btn('바꾸기', save, 'sx-btn-primary'), btn('그만두기', () => act.editAmount(null), 'sx-btn-quiet')));
      setTimeout(() => input.focus(), 0);
    } else {
      // 품목은 거래처 저장 품목에서 왔으면 추정, 부가세는 고르지 않았으면 기본값(추정)
      const guessed = [run.vatGuessed ? '부가세' : null, run.itemGuessed ? '품목' : null].filter(Boolean);
      card.append(
        run.dupToday ? h('div', { 'data-dup-today': '' }, note(DUP_TODAY_TEXT, true)) : null,
        noItem ? note('품목이 비어 있어요. [품목·이메일 고치기]로 넣은 뒤 준비해 주세요.', true) : null,
        h(
          'div',
          { class: 'sx-actions' },
          btn('홈택스에서 준비', () => act.prepare(run.id), 'sx-btn-primary', { 'data-act': 'prepare', disabled: noItem }),
          run.vat === 'separate' ? btn('부가세 포함하기', () => act.vat(run.id, 'included'), '', { 'data-act': 'vat' }) : btn('부가세 별도로 하기', () => act.vat(run.id, 'separate'), '', { 'data-act': 'vat' }),
          btn('금액 수정', () => act.editAmount(run.id)),
          btn('품목·이메일 고치기', () => act.editFields(run.id), noItem ? 'sx-btn-primary' : '', { 'data-act': 'fields-edit' }),
          btn('거래처 바꾸기', () => act.editCp(run.id), '', { 'data-act': 'draft-cp' }),
          btn('취소', () => act.stop(run.id), 'sx-btn-quiet', { 'data-act': 'cancel' }),
        ),
        h('div', { class: 'sx-meta' }, guessed.length ? `추정 값 ${guessed.length}개 · ${guessed.join(', ')} · 아직 아무것도 보내지 않았어요` : '아직 아무것도 보내지 않았어요'),
      );
    }
  } else if (st === 'preparing') {
    card.append(
      line('홈택스에서 준비하고 있어요. 승인하기 전에는 아무것도 발급하지 않아요.', true),
      h('div', { class: 'sx-actions' }, btn('중지', () => act.stop(run.id), 'sx-btn-quiet', { 'data-act': 'stop' }), now ? h('span', { class: 'sx-meta' }, now.note ? `${now.label} · ${now.note}` : now.label) : null),
    );
  } else if (verifying(run)) {
    // 발급 후 조회 중(08 §11 "발급 후 응답 끊김" 행). 이 상태에서는 어떤 버튼도 다시 발급하지 않는다.
    card.append(
      line('발급목록을 직접 조회해서 발급됐는지 확인하고 있어요. 확인되기 전에는 다시 발급하지 않아요.', true),
      run.verifyAttempt ? h('div', { class: 'sx-meta', 'data-verify-attempt': String(run.verifyAttempt) }, `조회 ${run.verifyAttempt}회째`) : null,
    );
  } else if (st === 'issuing') {
    card.append(line('발급하고 있어요. 홈택스 발급목록에서 확인할 때까지 다시 발급하지 않아요.', true), now ? h('div', { class: 'sx-meta' }, now.note ? `${now.label} · ${now.note}` : now.label) : null);
  } else if (st === 'turn' && run.handoff) {
    // 사람 차례(D03 HandedOff, #278 셸 계약): 실행은 끝나지 않았다. 버튼은 재개·확인·중지로만 가고 발급하지 않는다.
    // - 로그인: [이어서](재개) · [중지]
    // - 서명: 완료 창이 보이면 엔진이 스스로 넘어간다. [다 했어요]는 보조, [직접 발급함]은 없다(엔진 sign.turn_resume_only). [중지]는 발급목록 확인 뒤 끝난다.
    // - 그 밖: [다 했어요] · [직접 발급함] · [중지]
    const kind = run.handoff.kind ?? 'other';
    card.dataset.handoff = kind;
    card.append(
      note(run.turn.text, true, run.turn.note),
      h(
        'div',
        { class: 'sx-actions' },
        kind === 'login' ? btn('이어서', () => act.resume(run.id), 'sx-btn-primary', { 'data-act': 'resume' }) : btn('다 했어요', () => act.resume(run.id), kind === 'sign' ? '' : 'sx-btn-primary', { 'data-act': 'resume' }),
        kind === 'other' ? btn('직접 발급함', () => act.manualDone(run.id), '', { 'data-act': 'manual-done' }) : null,
        btn('중지', () => act.stop(run.id), 'sx-btn-quiet', { 'data-act': 'stop' }),
      ),
      kind === 'sign' ? h('div', { class: 'sx-meta', 'data-sign-wait': '' }, '서명을 마치면 앱이 발급목록을 확인해요. 그동안 다시 발급하지 않아요.') : null,
    );
  } else if (st === 'turn') {
    card.append(note(run.turn.text, false, run.turn.note, 'phone'));
    const signing = run.steps[4].state === 'done';
    card.append(h('div', { class: 'sx-actions' }, btn('다시 요청', () => act.toast('폰으로 다시 요청하기는 곧 지원해요')), signing ? null : btn('중지', () => act.stop(run.id), 'sx-btn-quiet', { 'data-act': 'stop' })));
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
  } else if (st === 'attention' && run.inDoubt) {
    // InDoubt 카드(08 §11): 발급됐는지 모른다. 다시 발급하는 버튼은 두지 않는다. 직접 확인할 곳만 연다.
    card.dataset.inDoubt = '1';
    card.append(
      note(run.stoppedNote || '발급됐는지 확인하지 못했어요.', true),
      line('확인되기 전에는 이 건을 다시 발급하지 않아요.', true),
      // 증언 상태 문구는 main이 고른 고정 문장(ATTEST_NOTE)이다. 확인 결과를 보내는 버튼은 카드에 없다(바 클릭으로만 받는다).
      run.attest?.note ? h('div', { class: 'sx-meta', 'data-attest': run.attest.state }, run.attest.note) : null,
      h('div', { class: 'sx-actions' }, btn('홈택스에서 직접 확인', () => act.open(run.id), 'sx-btn-primary', { 'data-act': 'check-list' })),
    );
  } else if (st === 'attention') {
    card.append(
      note(run.stoppedNote || '확인이 필요해요.', true),
      // 승인 전 핸드오프 끝: [다시 준비]·[홈택스에서 직접 발급]. 그 밖에 발급 전에 멈췄으면 [다시 준비](새 초안). Chrome 확장 멈춤은 아래 [다시 시도]가 맡는다.
      run.handoffEnd
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
  if (s.has('openrouter_demo')) return ['모델', 'OpenRouter(시연 예외) · 채팅 문장과 가상 거래처 이름만 보냄'];
  if (s.has('gateway.decide')) return ['모델', '게이트웨이를 거쳐 의도 판정 · 마스킹한 요청 문장만 보냄'];
  return ['모델', '쓰지 않음(요청 해석은 이 PC 안 규칙)'];
};
export const serverRow = (sent) => {
  const s = sentSet(sent);
  const parts = [s.has('gateway.run_tokens') ? '실행 토큰 요청(문장 없음)' : null, s.has('gateway.decide') ? '마스킹한 요청 문장(의도 판정)' : null, s.has('gateway.respond') ? '마스킹한 대화 문장(짧은 답)' : null].filter(Boolean);
  return ['우리 서버', parts.length ? `게이트웨이 · ${parts.join(', ')}` : '보낸 것 없음'];
};
/** 활동 기록 표의 모델 칸. */
export const modelCell = (sent) => {
  const s = sentSet(sent);
  return s.has('openrouter_demo') ? 'OpenRouter(시연)' : s.has('gateway.decide') ? '게이트웨이' : null;
};

/** "어디로 무엇이 갔나요"(활동 기록 행을 카드 안에서 펼친 것). */
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
  // 작업 패널의 [중지](T-04). 발급 전에만 있다. 승인은 여기에도 없다.
  // 사람 차례면 게이트 뒤(서명 차례)여도 [중지]를 받는다(#278): 서명 차례는 발급목록 확인 뒤 끝난다.
  const canStop = st === 'preparing' || st === 'waiting' || (st === 'turn' && (!!run.handoff || run.steps[4].state !== 'done'));
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
    canStop ? h('div', { class: 'sx-actions' }, btn('중지', () => act.stop(run.id), '', { 'data-act': 'panel-stop' })) : null,
    st === 'done' ? (run.result.noFile ? line(NO_FILE_TEXT, true) : h('div', { class: 'sx-actions' }, btn('PDF 열기', () => act.openRunDoc(run), 'sx-btn-primary'), btn('폴더 열기', () => act.openRunDoc(run, true)))) : null,
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

/** 대화 속 서류 카드(DocumentCard): D6 종류 → D2 서류 이름 → 세 칸. 도장은 사용자가 승인해 앱이 발급한 서류에만. */
export function docCard(doc, today) {
  return h(
    'section',
    { class: 'sx-card sx-doc', 'data-doc': doc.id },
    h('div', { class: 'sx-doc-kind' }, docKind(doc)),
    h('div', { class: 'sx-doc-name' }, doc.docName),
    doc.source === '앱이 발급' ? h('div', { class: 'sx-seal' }, '발급') : null,
    docCells(doc, today),
  );
}

/** 문서함 상세 패널(캔버스 D-01 오른쪽): 종류 줄(닫기) → 이름 + 도장 → 미리보기 → 세 칸 → 값 → 버튼 → 출처. 보관함 서류는 확인 구역(review)이 버튼 자리에 온다. */
export function docPanel(doc, today, act, review) {
  return h(
    'div',
    { class: 'panel-in', 'data-panel-doc': doc.id },
    h('div', { class: 'doc-kind-row' }, h('span', { class: 'sx-doc-kind' }, docKind(doc)), panelX(act)),
    h('div', { class: 'doc-head' }, h('div', { class: 'sx-doc-name' }, doc.docName), doc.source === '앱이 발급' ? h('span', { class: 'sx-seal', 'aria-label': '승인 도장' }, '발급') : null),
    review ? null : docPreview(),
    docCells(doc, today),
    review ?? [
      kv([
        ['표시 이름', doc.name],
        ['프로필', doc.profile === 'business' ? '사업자' : '개인'],
        ['보관', doc.noFile ? '홈택스 발급목록' : '이 PC 문서함'],
      ]),
      doc.noFile ? h('p', { class: 'sx-body-sm is-muted', 'data-doc-nofile': '' }, NO_FILE_TEXT) : null,
      h('div', { class: 'sx-actions' }, doc.noFile ? null : btn('열기', () => act.openDoc(doc.id), 'sx-btn-primary', { 'data-act': 'doc-open' }), btn('메일로 보내기', () => act.toast('메일로 보내기는 곧 지원해요')), doc.source === '앱이 발급' && !doc.noFile ? btn('다시 발급', () => act.reissue(doc)) : null),
      h('div', { class: 'sx-source' }, `${doc.source}${doc.issuedOn ? ` · ${doc.issuedOn}` : ''} · 파일명에는 거래처·승인번호를 넣지 않아요`),
    ],
  );
}

/** 미리보기 자리(목업): 캔버스의 축소 서류 한 장. */
function docPreview() {
  const bar = (cls) => h('div', { class: `pv-line ${cls}` });
  return h(
    'figure',
    { class: 'preview', 'aria-label': '미리보기 자리' },
    h(
      'div',
      { class: 'pv-page', 'aria-hidden': 'true' },
      bar('pv-title'),
      h('div', { class: 'pv-rule' }),
      h('div', { class: 'pv-grid' }, Array.from({ length: 8 }, () => bar(''))),
      h('div', { class: 'pv-rule' }),
      bar('w80'),
      bar('w70'),
      h('div', { class: 'pv-fill' }),
      h('div', { class: 'pv-stamp' }),
    ),
  );
}
