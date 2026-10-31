// 정부24 직접 발급 안내(T-08) 목업 2장: ① 단계 안내 ② 저장 파일 고르기 → 문서함 보관.
// 정부24를 자동화하지 않는다(ADR-011, D17). 이 화면은 브라우저를 열지 않고 정부24에 어떤 요청도 보내지 않는다.
import { btn, chip, h, kv, note, steps } from './shell-views.js';

export function g24Card(g, act) {
  const done = g.stage === 'saved';
  const card = h('section', { class: `sx-card${done ? '' : ' is-turn'}`, 'data-g24': g.id });
  card.addEventListener('click', (e) => {
    if (!e.target.closest('button')) act.openG24(g.id);
  });
  const body = done
    ? [h('div', { class: 'sx-app-line' }, '문서함에 넣었어요. 발급일과 출처(직접 발급)를 함께 적어 두었어요.')]
    : g.stage === 'stopped'
      ? [h('div', { class: 'sx-app-line' }, '그만뒀어요.')]
      : [
          h('div', { class: 'sx-app-line' }, '정부24에서 직접 발급해 주세요. 저장한 파일은 제가 찾아서 문서함에 정리할게요.'),
          h('div', { class: 'sx-meta' }, '정부24는 운영기관 허락이 확인되기 전까지 자동으로 발급하지 않아요.'),
          h('div', { class: 'sx-actions' }, btn('안내 보기', () => act.openG24(g.id), 'sx-btn-primary'), btn('그만두기', () => act.g24Stop(g.id), 'sx-btn-quiet')),
        ];
  card.append(h('div', { class: 'sx-card-hd' }, h('div', { class: 'sx-card-title' }, '주민등록표 등본 · 정부24'), done ? chip('done') : g.stage === 'stopped' ? chip('stopped') : chip('turn')), ...body);
  return card;
}

const ADDRESS = '서울특별시 가나구 다라로 12, 3층';

export function g24Panel(g, act) {
  const head = (stage) =>
    h(
      'div',
      { class: 'sx-card-hd' },
      h('div', { class: 'sx-card-title' }, stage),
      h('span', { class: 'mock-badge' }, '목업'),
      g.stage === 'saved' ? chip('done') : chip('turn'),
      h('button', { type: 'button', class: 'panel-x', 'aria-label': '패널 닫기', onclick: act.closePanel }, '×'),
    );
  if (g.stage === 'guide') {
    const copy = (label, value) => h('span', { class: 'g24-copy' }, h('span', { class: 'sx-val' }, value), h('button', { type: 'button', class: 'sx-copy', onclick: () => act.copy(value), 'aria-label': `${label} 복사` }, '복사'));
    return h(
      'div',
      { class: 'panel-in', 'data-g24-panel': 'guide' },
      head('직접 발급 안내'),
      h('div', { class: 'sx-doc-kind' }, '정부24 · 후처리 모드'),
      steps([
        { label: '정부24 열기', state: 'now', note: '기본 브라우저로 한 번 열어요. 이 PC의 금고 브라우저는 쓰지 않아요.' },
        { label: '로그인', state: 'todo', note: '간편인증·공동인증서로 직접 로그인해 주세요. 앱은 비밀번호를 받지 않아요.' },
        { label: '주민등록표 등본(초본) 교부', state: 'todo', note: '자주 찾는 서비스에서 고르면 돼요.' },
        { label: '입력', state: 'todo', note: '주소는 아래 값을 복사해 넣어요. 주민등록번호 뒷자리는 가림을 권해요.' },
        { label: '발급 → PDF로 저장', state: 'todo', note: '다운로드 폴더나 "PDF로 인쇄"로 저장하면 제가 찾아요.' },
      ]),
      h('div', { class: 'sx-panel-sec' }, '복사해서 넣을 값'),
      kv([
        ['주소', copy('주소', ADDRESS), { start: true }],
        ['발급 형태', '전체 · 주민등록번호 뒷자리 가림', { start: true }],
      ]),
      note('로그인·본인확인·캡차는 정부24 화면에서 직접 해 주세요. 그 칸의 값은 복사 버튼으로 만들지 않아요.'),
      h('div', { class: 'sx-actions' }, btn('정부24 열기', () => act.toast('목업: 브라우저를 열지 않아요'), ''), btn('출력·저장했어요', () => act.g24Saved(g.id), 'sx-btn-primary', { 'data-act': 'g24-saved' })),
      h('div', { class: 'sx-source' }, `작업 시작 ${g.startedAt} · 그 뒤에 생긴 PDF만 후보로 올려요`),
    );
  }
  if (g.stage === 'pick') {
    const opts = g.candidates.map((c) =>
      h(
        'button',
        { type: 'button', class: `sx-opt${g.picked === c.id ? ' is-on' : ''}`, 'data-candidate': c.id, onclick: () => act.g24Pick(g.id, c.id) },
        h('span', { class: 'sx-radio' }),
        h('span', { class: 'opt-main' }, h('span', {}, c.name), h('span', { class: 'sx-meta' }, `${c.size} · ${c.at} 생성`)),
      ),
    );
    return h(
      'div',
      { class: 'panel-in', 'data-g24-panel': 'pick' },
      head('저장한 파일 보관'),
      h('div', { class: 'sx-app-line' }, '작업을 시작한 뒤 새로 생긴 PDF예요. 방금 발급한 파일을 골라 주세요.'),
      h('div', { class: 'opt-list' }, opts),
      h('div', { class: 'sx-meta' }, '고르기 전에는 파일을 열어 보지 않아요. 파일 이름·크기·만든 시각만 보여요.'),
      g.picked
        ? [
            h('div', { class: 'sx-panel-sec' }, '파일에서 읽은 값(이 PC 안에서)'),
            kv([
              ['서류 종류', '주민등록표 등본', { state: 'verified', tag: '파일과 일치' }],
              ['발급일', g.today, { state: 'verified', tag: '후보 1개' }],
              ['성명', '김가나', { state: 'verified', tag: '개인 프로필과 일치' }],
              ['유효기간', '제출처 기준', { state: 'inferred', tag: '추정' }],
            ]),
            h('div', { class: 'sx-actions' }, btn('문서함에 넣기', () => act.g24Save(g.id), 'sx-btn-primary', { 'data-act': 'g24-save' }), btn('다른 파일 고르기', () => act.g24Pick(g.id, null), 'sx-btn-quiet')),
          ]
        : h('div', { class: 'sx-actions' }, btn('파일 직접 고르기', () => act.toast('목업: 파일 선택 창을 열지 않아요'), 'sx-btn-quiet')),
      h('div', { class: 'sx-source' }, '감시 위치: 다운로드 · PDF로 인쇄 기본 폴더'),
    );
  }
  return h('div', { class: 'panel-in' }, head('저장한 파일 보관'), h('div', { class: 'sx-app-line' }, '문서함에 넣었어요.'), h('div', { class: 'sx-actions' }, btn('문서함 보기', () => act.go('docs'))));
}
