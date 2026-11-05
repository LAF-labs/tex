// 대화상자 정책(D03 §6, §5.3 expectConfirm·V-24). 리스너는 엔진이 항상 등록하고 Playwright 기본 동작에 기대지 않는다.
// - alert → accept. 문구는 판정 입력(차단 신호 사전 등)과 실행 메모리의 '홈택스 안내'로만 쓴다.
// - confirm·beforeunload → 무장된 커밋 구간 + 선언된 expectConfirm 패턴(앵커)과 일치할 때만 accept + commit.confirm_accepted{textHash}.
//   그 밖은 dismiss.
// - prompt → dismiss.
// 문구 자체는 저널·텔레메트리·모델에 넣지 않는다(⑦). 저널에는 종류와 (수락한 confirm의) 해시만 남긴다.
import { sha256Hex } from './canon.ts';
import { normalizeName } from './constants.ts';

export type DialogKind = 'alert' | 'confirm' | 'prompt' | 'beforeunload';

export interface DialogDecision {
  action: 'accept' | 'dismiss';
  /** 저널 이벤트. payload에는 종류·해시만 있다. */
  event: { type: 'dialog.alert_accepted' | 'dialog.dismissed' | 'commit.confirm_accepted'; payload: Record<string, string> };
  /** 실패·핸드오프 카드의 '홈택스 안내: …'(NFKC, 공백 접기, 200자). 실행 메모리에만 둔다. */
  notice: string;
}

/** 실행 메모리용 문구: NFKC, 제로폭 제거, 공백 접기, 200자. */
export function noticeText(message: string): string {
  return normalizeName(message).slice(0, 200);
}

/**
 * 대화상자 하나의 응답을 정한다. armedConfirm은 무장된 커밋 구간에서 그 submit의 expectConfirm 패턴일 때만 준다(그 밖은 null).
 * 패턴은 정규화한 전체 문구에 맞춘다(V-24가 앵커를 요구한다).
 */
export function decideDialog(kind: DialogKind, message: string, armedConfirm: RegExp | null): DialogDecision {
  const notice = noticeText(message);
  if (kind === 'alert') return { action: 'accept', event: { type: 'dialog.alert_accepted', payload: { kind } }, notice };
  if ((kind === 'confirm' || kind === 'beforeunload') && armedConfirm && armedConfirm.test(notice)) {
    return { action: 'accept', event: { type: 'commit.confirm_accepted', payload: { kind, textHash: sha256Hex(notice) } }, notice };
  }
  return { action: 'dismiss', event: { type: 'dialog.dismissed', payload: { kind } }, notice };
}
