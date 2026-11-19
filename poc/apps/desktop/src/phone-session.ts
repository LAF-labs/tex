// 라이브 세션 위의 PC 쪽 v1.8·v1.10 기능(phone-link PhoneSessionHook): 폰 사본 보내기, 폰 발급 명령 받기, 폰 승인(ADR-052).
// - 사본은 폰이 hello에 copy.v1을 알렸을 때만, 세션을 열 때 한 번 보낸다. 한 프레임에 맞게 거래처를 줄인다(fitPhoneCopy).
// - cmd.run은 폰이 issue.v1을 알렸을 때만 받는다. 다른 봉투는 사진·현금 수신기로 넘긴다(false).
// - 폰 승인(px.enroll·gate.response·gate.refresh)은 폰이 approve.v1을 알렸을 때만 받는다. 알리지 않은 폰의 것은 버린다.
// - 로그는 단계·결과만.
import { CAP, fitPhoneCopy, type Channel, type CmdRunBody, type Envelope, type GateRefreshBody, type GateResponseBody, type PhoneCopyBody, type PxAckBody, type PxEnrollBody } from '@sax/remote';
import type { PhoneSessionHook } from './phone-link.ts';
import type { PhoneGate } from './phone-gate.ts';
import type { CmdResumeBody, PhoneIssue } from './phone-issue.ts';

/** PC가 hello에 알리는 v1.8 기능 */
export const SESSION_CAPS: readonly string[] = Object.freeze([CAP.issue, CAP.copy]);
/** 폰 승인을 배선한 PC가 더 알리는 기능(v1.10) */
export const APPROVE_CAPS: readonly string[] = Object.freeze([CAP.approve]);

export interface PhoneSessionOptions {
  issue: PhoneIssue;
  copy: (pairId: string) => Promise<PhoneCopyBody>;
  /** 폰 승인(ADR-052). 없으면 px.enroll·gate.*를 받지 않는다(hello에도 approve.v1을 알리지 않는다). */
  approve?: {
    gate: PhoneGate;
    enroll: (pairId: string, body: PxEnrollBody) => Promise<PxAckBody>;
  };
  log?: (name: string, data?: Record<string, string | number | boolean>) => void;
}

export function phoneSession(o: PhoneSessionOptions): PhoneSessionHook {
  const caps = new WeakMap<Channel, ReadonlySet<string>>();
  const log = o.log ?? (() => {});
  const approves = (ch: Channel) => !!o.approve && !!caps.get(ch)?.has(CAP.approve);
  return {
    async open(pairId, ch, peerCaps) {
      const have = new Set(peerCaps);
      caps.set(ch, have);
      // 승인 요청을 받을 곳을 먼저 붙인다(발급 명령의 지금 상태보다 먼저: cmd.ack accepted·pc_only가 이것을 본다)
      if (approves(ch)) o.approve!.gate.attach(pairId, ch);
      if (have.has(CAP.issue)) o.issue.attach(pairId, ch);
      if (!have.has(CAP.copy)) return;
      const body = await o.copy(pairId);
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
      if (env.type === 'px.enroll' || env.type === 'gate.response' || env.type === 'gate.refresh') {
        // approve.v1을 알리지 않은 폰의 승인 봉투는 버린다
        if (!approves(ch)) return true;
        const a = o.approve!;
        if (env.type === 'px.enroll') {
          const ack = await a.enroll(pairId, env.body as PxEnrollBody);
          if (!ch.closed) ch.send('px.ack', ack);
        } else if (env.type === 'gate.response') await a.gate.answer(pairId, env.body as GateResponseBody);
        else a.gate.refresh(pairId, env.body as GateRefreshBody);
        return true;
      }
      // 폰 [인증서로 다시 시도]: cmd.resume{runId}. 그 폰이 맡긴 건이 공동인증서 로그인 실패 차례일 때만 받는다(아니면 버린다).
      if (env.type === 'cmd.resume') {
        if (caps.get(ch)?.has(CAP.issue)) await o.issue.resume(pairId, ch, env.body as CmdResumeBody);
        return true;
      }
      if (env.type !== 'cmd.run') return false;
      // issue.v1을 알리지 않은 폰의 cmd.run은 다른 길(현재 없음)로 보내지 않고 버린다
      if (!caps.get(ch)?.has(CAP.issue)) return true;
      await o.issue.handle(pairId, ch, env.body as CmdRunBody);
      return true;
    },
    close(pairId, ch) {
      o.issue.detach(pairId, ch);
      o.approve?.gate.detach(pairId, ch);
      caps.delete(ch);
    },
  };
}
