// 정부24 직접 발급 안내(T-08) 목업 2장: ① 단계 안내 ② 저장 파일 고르기 → 문서함 보관.
// 정부24를 자동화하지 않는다(ADR-011, D17). 이 화면은 브라우저를 열지 않고 정부24에 어떤 요청도 보내지 않는다.
import { btn, chip, h, icon, kv, note, steps } from './shell-views.js';

const open = (g) => g.stage === 'guide' || g.stage === 'pick';

export function g24Card(g, act) {
  const card = h('section', { class: `sx-card${open(g) ? ' is-turn' : ''}`, 'data-g24': g.id });
  // 끝난 카드(보관함에 넣음·그만둠)는 패널을 열지 않는다.
  if (open(g))
    card.addEventListener('click', (e) => {
      if (!e.target.closest('button')) act.openG24(g.id);
    });
  const body = {
    guide: [
      h('p', { class: 'sx-body-sm' }, '정부24에서 직접 발급해 주세요. 저장한 파일은 제가 찾아서 문서함에 정리할게요.'),
      h('div', { class: 'sx-actions' }, btn('안내 보기', () => act.openG24(g.id), 'sx-btn-primary'), btn('그만두기', () => act.g24Stop(g.id), 'sx-btn-quiet'), h('span', { class: 'sx-meta' }, '정부24는 운영기관 허락을 확인하기 전까지 자동으로 발급하지 않아요')),
    ],
    pick: [
      h('p', { class: 'sx-body-sm' }, '저장한 파일을 골라 주세요. 고른 파일만 이 PC 안에서 읽어요.'),
      h('div', { class: 'sx-actions' }, btn('파일 고르기', () => act.openG24(g.id), 'sx-btn-primary'), btn('그만두기', () => act.g24Stop(g.id), 'sx-btn-quiet')),
    ],
    saved: [h('p', { class: 'sx-body-sm' }, '문서함에 넣었어요. 발급일과 출처(직접 발급)를 함께 적어 두었어요.')],
    stopped: [h('p', { class: 'sx-body-sm is-muted' }, '그만뒀어요. 문서함에는 아무것도 넣지 않았어요.')],
  }[g.stage];
  const st = { guide: 'turn', pick: 'turn', saved: 'done', stopped: 'stopped' }[g.stage];
  card.append(h('div', { class: 'sx-card-hd' }, h('div', { class: 'sx-card-title' }, `${g.doc} · 정부24`), chip(st)), ...body);
  return card;
}

const ADDRESS = '서울특별시 가나구 다라로 12, 3층';

export function g24Panel(g, act) {
  const head = (title) =>
    h(
      'div',
      { class: 'sx-card-hd' },
      h('div', { class: 'sx-card-title' }, title),
      chip(g.stage === 'saved' ? 'done' : g.stage === 'stopped' ? 'stopped' : 'turn'),
      h('button', { type: 'button', class: 'panel-x', 'aria-label': '패널 닫기', onclick: act.closePanel }, icon('close')),
    );
  if (g.stage === 'guide') {
    return h(
      'div',
      { class: 'panel-in', 'data-g24-panel': 'guide' },
      head('직접 발급 안내'),
      h('div', { class: 'sx-doc-kind' }, `${g.doc} · 정부24 · 직접 발급`),
      steps([
        { label: '정부24 열기', state: 'now', note: '기본 브라우저로 열어요. 금고 브라우저는 쓰지 않아요.' },
        { label: '로그인', state: 'todo', note: '간편인증이나 공동인증서로 직접 로그인해 주세요. 앱은 비밀번호를 받지 않아요.' },
        { label: `${g.doc} 교부 신청`, state: 'todo', note: '자주 찾는 서비스에서 고르면 돼요.' },
        { label: '입력', state: 'todo', note: '주소는 아래 값을 복사해 넣어요. 필요한 항목만 고르고 주민등록번호 뒷자리는 가려요.' },
        { label: '발급 → PDF로 저장', state: 'todo', note: '다운로드 폴더나 "PDF로 인쇄"로 저장하면 제가 찾아요.' },
      ]),
      h('div', { class: 'sx-panel-sec' }, '복사해서 넣을 값'),
      kv(
        [
          ['주소', ADDRESS, { copy: () => act.copy(ADDRESS) }],
          ['발급 형태', '필요한 항목만 · 뒷자리 가림'],
        ],
        true,
      ),
      note('로그인·본인확인·자동입력방지는 정부24 화면에서 직접 해 주세요. 그 칸의 값은 복사 버튼으로 만들지 않아요.'),
      h('div', { class: 'sx-actions' }, btn('출력·저장했어요', () => act.g24Saved(g.id), 'sx-btn-primary', { 'data-act': 'g24-saved' }), btn('정부24 열기', () => act.toast('목업: 브라우저를 열지 않아요'))),
      h('div', { class: 'sx-source' }, `작업 시작 ${g.startedAt} · 그 뒤에 생긴 PDF만 후보로 올려요`),
    );
  }
  if (g.stage === 'pick') {
    const opts = g.candidates.map((c) =>
      h(
        'button',
        { type: 'button', class: `sx-opt${g.picked === c.id ? ' is-on' : ''}`, 'data-candidate': c.id, 'aria-pressed': String(g.picked === c.id), onclick: () => act.g24Pick(g.id, c.id) },
        h('span', { class: 'sx-radio' }),
        h('span', { class: 'opt-main' }, h('span', {}, c.name), h('span', { class: 'sx-meta' }, `${c.size} · ${c.at} 생성`)),
      ),
    );
    return h(
      'div',
      { class: 'panel-in', 'data-g24-panel': 'pick' },
      head('저장한 파일 보관'),
      h('div', { class: 'sx-app-line' }, `작업을 시작한 ${g.startedAt} 뒤에 새로 생긴 PDF예요. 방금 발급한 파일을 골라 주세요.`),
      h('div', { class: 'opt-list' }, opts),
      h('div', { class: 'sx-meta' }, '고르기 전에는 파일을 열지 않아요. 이름·크기·만든 시각만 보여요.'),
      g.picked
        ? [
            h('div', { class: 'sx-panel-sec' }, '파일에서 읽은 값 · 이 PC 안에서'),
            kv([
              ['서류 종류', g.doc, { state: 'verified', tag: '파일과 일치' }],
              ['발급일', g.today, { state: 'verified', tag: '파일에서 읽음' }],
              ['성명', '김가나', { state: 'verified', tag: '개인 프로필과 일치' }],
              ['유효기간', '제출처 기준', { state: 'inferred', tag: '추정' }],
            ]),
            h('div', { class: 'sx-actions' }, btn('문서함에 넣기', () => act.g24Save(g.id), 'sx-btn-primary', { 'data-act': 'g24-save', disabled: g.saving }), btn('다른 파일 고르기', () => act.g24Pick(g.id, null), 'sx-btn-quiet')),
          ]
        : h('div', { class: 'sx-actions' }, btn('파일 직접 고르기', () => act.toast('목업: 파일 선택 창을 열지 않아요'), 'sx-btn-quiet')),
      h('div', { class: 'sx-source' }, '찾는 곳 · 다운로드 폴더, "PDF로 인쇄" 기본 폴더'),
    );
  }
  if (g.stage === 'stopped') return h('div', { class: 'panel-in' }, head(g.doc), h('p', { class: 'sx-body-sm is-muted' }, '그만뒀어요. 문서함에는 아무것도 넣지 않았어요.'));
  return h('div', { class: 'panel-in' }, head('저장한 파일 보관'), h('p', { class: 'sx-body-sm' }, '문서함에 넣었어요.'), h('div', { class: 'sx-actions' }, btn('문서함 보기', () => act.go('docs'))));
}
