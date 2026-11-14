// 보안카드 등록(대표 지시 2026-11-14, 부장 판정 2026-11-14): 사진과 칸 값은 이 렌더러를 지나지 않는다.
// [등록 창 열기]를 누르면 main이 금고 직결 등록 창(card-secret.js)을 연다. 창이 닫히면 저장한 칸 수만 돌아온다.
import { btn, h } from './shell-views.js';

/**
 * 등록 카드 하나. o.onStored(답)는 저장이 끝났을 때(답: { stored, onboarding?, profiles? }). o.onboarding이면 main이 저장 뒤 인증을 정한다.
 * o.skip이 있으면 [나중에 등록] 버튼을 둔다.
 */
export function cardRegister(o) {
  const st = { busy: false, note: null };
  const root = h('div', { class: 'card-reg', 'data-card-reg': '' });
  const open = async () => {
    if (st.busy) return;
    st.busy = true;
    st.note = null;
    draw();
    try {
      const r = await o.call('card.register', { onboarding: o.onboarding === true });
      if (r?.stored > 0) o.onStored?.(r);
      else st.note = r?.busy ? '등록 창이 이미 열려 있어요.' : '등록하지 않고 창을 닫았어요. 다시 열 수 있어요.';
    } catch {
      st.note = '등록 창을 열지 못했어요. 다시 눌러 주세요.';
    } finally {
      st.busy = false;
      draw();
    }
  };
  const draw = () => {
    root.replaceChildren(
      ...[
        h(
          'div',
          { class: 'card-drop', 'data-card-drop': '' },
          h('b', {}, st.busy ? '금고 등록 창에서 카드 사진을 넣어 주세요' : '보안카드 사진으로 등록해요'),
          h('span', { class: 'sx-meta' }, '따로 뜨는 금고 창에 사진이나 스크린숏을 넣으면 이 PC 안에서만 읽고 번호는 금고에만 둬요. 사진은 남기지 않아요.'),
          st.busy ? null : btn('등록 창 열기', open, 'sx-btn-primary', { 'data-card-open': '' }),
        ),
        st.note ? h('p', { class: 'sx-body-sm is-muted', 'data-card-note': '' }, st.note) : null,
        o.skip && !st.busy ? h('div', { class: 'sx-actions' }, btn('나중에 등록', o.skip, 'sx-btn-quiet', { 'data-card-skip': '' })) : null,
      ].filter(Boolean),
    );
  };
  draw();
  return root;
}
