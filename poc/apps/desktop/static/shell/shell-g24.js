import { btn, chip, h, icon, kv } from './shell-views.js';

const LINE = '정부24에서 직접 발급해 주세요. 받은 PDF를 문서함에 넣으면 보관해 드려요.';
const SAMPLE_ADDRESS = '서울특별시 가나구 다라로 12, 3층';
const sample = () => document.body.dataset.sample === 'true';
const importPdf = (act, id) => act.importDoc({ pick: true, g24: id });

const open = (g) => g.stage === 'guide' || g.stage === 'pick';
const p = (text, muted) => h('p', { class: `sx-body-sm${muted ? ' is-muted' : ''}` }, text);
const row = (...kids) => h('div', { class: 'sx-actions' }, ...kids);

export function g24Card(g, act) {
  const card = h('section', { class: `sx-card${open(g) ? ' is-turn' : ''}`, 'data-g24': g.id });
  if (open(g))
    card.addEventListener('click', (e) => {
      if (!e.target.closest('button')) act.openG24(g.id);
    });
  const stop = () => btn('그만두기', () => act.g24Stop(g.id), 'sx-btn-quiet');
  const body = {
    guide: [p('정부24에서 직접 발급해 주세요.'), row(btn('안내 보기', () => act.openG24(g.id), 'sx-btn-primary'), stop())],
    pick: [p('받은 PDF를 문서함에 넣어 주세요.'), row(btn('파일 고르기', () => act.openG24(g.id), 'sx-btn-primary'), stop())],
    saved: [p('문서함에 넣었어요.')],
    stopped: [p('그만뒀어요. 문서함에는 아무것도 넣지 않았어요.', true)],
  }[g.stage];
  const st = { guide: 'turn', pick: 'turn', saved: 'done', stopped: 'stopped' }[g.stage];
  card.append(h('div', { class: 'sx-card-hd' }, h('div', { class: 'sx-card-title' }, `${g.doc} · 정부24`), chip(st)), ...body);
  return card;
}

export function g24Panel(g, act) {
  const head = h(
    'div',
    { class: 'sx-card-hd' },
    h('div', { class: 'sx-card-title' }, `${g.doc} · 정부24`),
    chip(g.stage === 'saved' ? 'done' : g.stage === 'stopped' ? 'stopped' : 'turn'),
    h('button', { type: 'button', class: 'panel-x', 'aria-label': '패널 닫기', onclick: act.closePanel }, icon('close')),
  );
  const panel = (stage, ...kids) => h('div', { class: 'panel-in', 'data-g24-panel': stage }, head, ...kids);
  if (g.stage === 'guide')
    return panel(
      'guide',
      p(LINE),
      sample() ? kv([['주소', SAMPLE_ADDRESS, { copy: () => act.copy(SAMPLE_ADDRESS) }]], true) : null,
      row(btn('출력·저장했어요', () => act.g24Saved(g.id), 'sx-btn-primary', { 'data-act': 'g24-saved' })),
    );
  if (g.stage === 'pick') {
    if (!g.candidates.length) return panel('pick', p(LINE), row(btn('PDF 가져오기', () => importPdf(act, g.id), 'sx-btn-primary', { 'data-act': 'g24-import' })));
    const opts = g.candidates.map((c) =>
      h(
        'button',
        { type: 'button', class: `sx-opt${g.picked === c.id ? ' is-on' : ''}`, 'data-candidate': c.id, 'aria-pressed': String(g.picked === c.id), onclick: () => act.g24Pick(g.id, c.id) },
        h('span', { class: 'sx-radio' }),
        h('span', { class: 'opt-main' }, h('span', {}, c.name), h('span', { class: 'sx-meta' }, `${c.size} · ${c.at} 생성`)),
      ),
    );
    return panel(
      'pick',
      h('div', { class: 'sx-app-line' }, `${g.startedAt} 뒤에 새로 생긴 PDF예요. 받은 파일을 골라 주세요.`),
      h('div', { class: 'opt-list' }, opts),
      g.picked && sample()
        ? kv([
            ['서류 종류', g.doc, { state: 'verified', tag: '파일과 일치' }],
            ['발급일', g.today, { state: 'verified', tag: '파일에서 읽음' }],
            ['성명', '김가나', { state: 'verified', tag: '개인 프로필과 일치' }],
          ])
        : null,
      g.picked ? row(btn('문서함에 넣기', () => act.g24Save(g.id), 'sx-btn-primary', { 'data-act': 'g24-save', disabled: g.saving })) : null,
    );
  }
  if (g.stage === 'stopped') return panel('stopped', p('그만뒀어요. 문서함에는 아무것도 넣지 않았어요.', true));
  return panel('saved', p('문서함에 넣었어요.'), row(btn('문서함 보기', () => act.go('docs'))));
}
