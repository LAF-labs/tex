import { CAP, fitPhoneCopy, type Channel, type CmdRunBody, type Envelope, type GateRefreshBody, type GateResponseBody, type PhoneCopyBody, type PxAckBody, type PxEnrollBody } from '@sax/remote';
import type { PhoneSessionHook } from './phone-link.ts';
import type { GateSink, PhoneGate } from './phone-gate.ts';
import type { CmdResumeBody, PhoneIssue, PhoneSink } from './phone-issue.ts';

export const SESSION_CAPS: readonly string[] = Object.freeze([CAP.issue, CAP.copy, CAP.sync]);
export const APPROVE_CAPS: readonly string[] = Object.freeze([CAP.approve]);

interface PhoneSessionOptions {
  issue: PhoneIssue;
  copy: (pairId: string) => Promise<PhoneCopyBody>;
  approve?: {
    gate: PhoneGate;
    enroll: (pairId: string, body: PxEnrollBody) => Promise<PxAckBody>;
  };
  log?: (name: string, data?: Record<string, string | number | boolean>) => void;
}

type Sink = PhoneSink & GateSink;

export function sinkFor(ch: Channel, peerCaps: ReadonlySet<string>): Sink {
  if (peerCaps.has(CAP.sync)) return ch as unknown as Sink;
  return {
    send(type: string, body: object): unknown {
      if (type === 'gate.resolved') return undefined;
      if (type === 'run.event' && 'rev' in body) {
        const rest = { ...(body as { rev?: number }) };
        delete rest.rev;
        return ch.send(type, rest as never);
      }
      return ch.send(type as never, body as never);
    },
  } as Sink;
}

export function phoneSession(o: PhoneSessionOptions): PhoneSessionHook {
  const caps = new WeakMap<Channel, ReadonlySet<string>>();
  const sinks = new WeakMap<Channel, Sink>();
  const log = o.log ?? (() => {});
  const approves = (ch: Channel) => !!o.approve && !!caps.get(ch)?.has(CAP.approve);
  return {
    async open(pairId, ch, peerCaps) {
      const have = new Set(peerCaps);
      caps.set(ch, have);
      const sink = sinkFor(ch, have);
      sinks.set(ch, sink);
      if (approves(ch)) o.approve!.gate.attach(pairId, sink);
      if (have.has(CAP.issue)) o.issue.attach(pairId, sink);
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
        if (!approves(ch)) return true;
        const a = o.approve!;
        if (env.type === 'px.enroll') {
          const ack = await a.enroll(pairId, env.body as PxEnrollBody);
          if (!ch.closed) ch.send('px.ack', ack);
        } else if (env.type === 'gate.response') await a.gate.answer(pairId, env.body as GateResponseBody);
        else a.gate.refresh(pairId, env.body as GateRefreshBody);
        return true;
      }
      if (env.type === 'cmd.resume') {
        if (caps.get(ch)?.has(CAP.issue)) await o.issue.resume(pairId, ch, env.body as CmdResumeBody);
        return true;
      }
      if (env.type === 'human.response') {
        if (caps.get(ch)?.has(CAP.issue)) await o.issue.human(pairId, ch, env.body as { runId?: unknown; reqId?: unknown; value?: unknown });
        return true;
      }
      if (env.type !== 'cmd.run') return false;
      if (!caps.get(ch)?.has(CAP.issue)) return true;
      await o.issue.handle(pairId, sinks.get(ch) ?? ch, env.body as CmdRunBody);
      return true;
    },
    close(pairId, ch) {
      const sink = sinks.get(ch);
      if (sink) {
        o.issue.detach(pairId, sink);
        o.approve?.gate.detach(pairId, sink);
      }
      caps.delete(ch);
      sinks.delete(ch);
    },
  };
}
