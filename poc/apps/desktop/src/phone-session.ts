// 라이브 세션 위의 PC 쪽 v1.8 기능(phone-link PhoneSessionHook): 폰 사본 보내기와 폰 발급 명령 받기.
// - 사본은 폰이 hello에 copy.v1을 알렸을 때만, 세션을 열 때 한 번 보낸다. 한 프레임에 맞게 거래처를 줄인다(fitPhoneCopy).
// - cmd.run은 폰이 issue.v1을 알렸을 때만 받는다. 다른 봉투는 사진·현금 수신기로 넘긴다(false).
// - 로그는 단계·결과만.
import { CAP, fitPhoneCopy, type Channel, type CmdRunBody, type Envelope, type PhoneCopyBody } from '@sax/remote';
import type { PhoneSessionHook } from './phone-link.ts';
import type { PhoneIssue } from './phone-issue.ts';

/** PC가 hello에 알리는 v1.8 기능 */
export const SESSION_CAPS: readonly string[] = Object.freeze([CAP.issue, CAP.copy]);

export interface PhoneSessionOptions {
  issue: PhoneIssue;
  copy: () => Promise<PhoneCopyBody>;
  log?: (name: string, data?: Record<string, string | number | boolean>) => void;
}

export function phoneSession(o: PhoneSessionOptions): PhoneSessionHook {
  const caps = new WeakMap<Channel, ReadonlySet<string>>();
  const log = o.log ?? (() => {});
  return {
    async open(pairId, ch, peerCaps) {
      const have = new Set(peerCaps);
      caps.set(ch, have);
      if (have.has(CAP.issue)) o.issue.attach(pairId, ch);
      if (!have.has(CAP.copy)) return;
      const body = await o.copy();
      const fit = fitPhoneCopy(body, { pairId, from: 'desktop', seq: 0xffffffff });
      if (!fit) {
        log('main.phone_copy', { result: 'too_large' });
        return;
      }
      if (ch.closed) return;
      ch.send('phone.copy', fit.body);
      log('main.phone_copy', { result: 'sent', counterparties: fit.body.counterparties.length, dropped: fit.dropped, money: !!fit.body.money });
    },
    async handle(pairId, ch, env: Envelope) {
      if (env.type !== 'cmd.run') return false;
      // issue.v1을 알리지 않은 폰의 cmd.run은 다른 길(현재 없음)로 보내지 않고 버린다
      if (!caps.get(ch)?.has(CAP.issue)) return true;
      await o.issue.handle(pairId, ch, env.body as CmdRunBody);
      return true;
    },
    close(pairId, ch) {
      o.issue.detach(pairId, ch);
      caps.delete(ch);
    },
  };
}
