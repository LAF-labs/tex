// 보안카드 등록(대표 지시 2026-11-14): 카드 사진·스크린숏을 끌어 놓거나 고르면 금고가 이 PC 안에서 글자를 읽어 칸 값을 저장한다.
// 렌더러는 사진 바이트를 main에 한 번 넘기고 바로 버린다. 돌아오는 것은 다시 물을 칸 번호와 저장한 칸 수뿐이다.
// 애매한 칸만 그 칸 4자리를 다시 묻는다. 따로 확인 단계는 없다.
import { btn, h } from './shell-views.js';

const ERR = {
  'card.ocr_unavailable': '이 PC에서는 사진 글자 인식을 쓸 수 없어요.',
  'card.ocr_failed': '사진을 읽지 못했어요. 다른 사진으로 다시 넣어 주세요.',
  'card.not_a_card': '보안카드 번호표를 찾지 못했어요. 번호가 다 보이게 찍은 사진을 넣어 주세요.',
  'card.image_too_large': '사진이 너무 커요(20MB까지).',
  'card.draft_expired': '시간이 지나 다시 읽어야 해요. 사진을 다시 넣어 주세요.',
  bad_image: '이미지 파일을 넣어 주세요.',
};
const errText = (e) => {
  const m = String(e?.message ?? '');
  return Object.entries(ERR).find(([k]) => m.includes(k))?.[1] ?? '금고에 등록하지 못했어요. 다시 해 주세요.';
};

/**
 * 등록 카드 하나. o.onStored(칸 수)는 저장이 끝났을 때. o.skip이 있으면 [나중에 등록] 버튼을 둔다.
 * 상태(읽는 중·다시 물을 칸)는 이 요소 안에서만 든다.
 */
export function cardRegister(o) {
  const st = { busy: false, ask: null, draftId: null, error: null };
  const root = h('div', { class: 'card-reg', 'data-card-reg': '' });
  const send = async (file) => {
    if (!file || st.busy) return;
    if (!/^image\//.test(file.type || '') && !/\.(png|jpe?g|heic|heif|webp|gif|bmp|tiff?)$/i.test(file.name || '')) {
      st.error = ERR.bad_image;
      return draw();
    }
    st.busy = true;
    st.error = null;
    draw();
    const image = new Uint8Array(await file.arrayBuffer());
    try {
      done(await o.call('card.scan', { image }));
    } catch (e) {
      st.error = errText(e);
    } finally {
      image.fill(0);
      st.busy = false;
      draw();
    }
  };
  const done = (r) => {
    if (r && Array.isArray(r.ask) && r.ask.length) {
      st.ask = r.ask;
      st.draftId = r.draftId;
      return;
    }
    st.ask = null;
    st.draftId = null;
    o.onStored?.(r?.stored ?? 0);
  };
  const askForm = () => {
    const inputs = st.ask.map((row) =>
      h('label', { class: 'card-ask-row' }, h('span', { class: 'card-ask-no' }, `${row}번`), h('input', { type: 'password', inputmode: 'numeric', maxlength: '4', pattern: '[0-9]{4}', class: 'sx-input card-ask-input', autocomplete: 'off', spellcheck: 'false', 'data-card-row': String(row), 'aria-label': `보안카드 ${row}번 4자리` })),
    );
    const save = h('button', { type: 'submit', class: 'sx-btn sx-btn-primary', 'data-card-ask-save': '' }, '저장');
    const form = h('form', { class: 'card-ask', autocomplete: 'off' }, h('p', { class: 'sx-body-sm' }, `사진에서 ${st.ask.length}칸을 확실히 읽지 못했어요. 그 칸의 4자리만 넣어 주세요.`), h('div', { class: 'card-ask-grid' }, ...inputs), h('div', { class: 'sx-actions' }, save));
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const cells = {};
      for (const i of form.querySelectorAll('[data-card-row]')) {
        if (!/^\d{4}$/.test(i.value)) {
          i.focus();
          st.error = '칸마다 숫자 4자리를 넣어 주세요.';
          return draw();
        }
        cells[i.getAttribute('data-card-row')] = i.value;
      }
      for (const i of form.querySelectorAll('[data-card-row]')) i.value = '';
      st.busy = true;
      st.error = null;
      draw();
      try {
        done(await o.call('card.answer', { draftId: st.draftId, cells }));
      } catch (err) {
        st.error = errText(err);
      } finally {
        st.busy = false;
        draw();
      }
    });
    return form;
  };
  const picker = h('input', { type: 'file', accept: 'image/*', hidden: '', 'data-card-file': '' });
  picker.addEventListener('change', () => {
    const f = picker.files?.[0];
    picker.value = '';
    void send(f);
  });
  const draw = () => {
    const drop = h(
      'div',
      { class: `card-drop${st.busy ? ' is-busy' : ''}`, 'data-card-drop': '' },
      h('b', {}, st.busy ? '카드를 읽고 있어요' : '보안카드 사진을 여기에 끌어 놓으세요'),
      h('span', { class: 'sx-meta' }, '사진이나 스크린숏 모두 돼요. 이 PC 안에서만 읽고 번호는 금고에만 둬요. 사진은 남기지 않아요.'),
      st.busy ? null : btn('사진 고르기', () => picker.click(), '', { 'data-card-pick': '' }),
    );
    for (const ev of ['dragenter', 'dragover']) drop.addEventListener(ev, (e) => (e.preventDefault(), drop.classList.add('is-over')));
    drop.addEventListener('dragleave', () => drop.classList.remove('is-over'));
    drop.addEventListener('drop', (e) => {
      e.preventDefault();
      drop.classList.remove('is-over');
      void send(e.dataTransfer?.files?.[0]);
    });
    root.replaceChildren(
      ...[
        st.ask ? askForm() : drop,
        picker,
        st.error ? h('p', { class: 'sx-body-sm is-attention', 'data-card-error': '' }, st.error) : null,
        o.skip && !st.busy ? h('div', { class: 'sx-actions' }, btn('나중에 등록', o.skip, 'sx-btn-quiet', { 'data-card-skip': '' })) : null,
      ].filter(Boolean),
    );
  };
  draw();
  return root;
}
