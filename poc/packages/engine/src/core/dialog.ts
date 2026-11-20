import { sha256Hex } from './canon.ts';
import { normalizeName } from './constants.ts';

export type DialogKind = 'alert' | 'confirm' | 'prompt' | 'beforeunload';

export interface DialogDecision {
  action: 'accept' | 'dismiss';
  event: { type: 'dialog.alert_accepted' | 'dialog.dismissed' | 'commit.confirm_accepted'; payload: Record<string, string> };
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
