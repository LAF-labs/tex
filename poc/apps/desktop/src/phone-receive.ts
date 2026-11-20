import { checkPaperInvoice, drainQueue, ReceiveQueue, type CashEntryBody, type DrainResult, type QueueReceiverOptions, type ReceiptOfferBody, type ReceiveLimits, type ReceiveSink } from '@sax/remote';

export type EngineRpc = (method: string, params: Record<string, unknown>) => Promise<unknown>;
type PhoneLog = (name: string, data?: Record<string, string | number | boolean>) => void;

interface PhoneReceiveOptions {
  onReceipt?: () => void;
  onCash?: () => void;
  log?: PhoneLog;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

export function offerParams(o: ReceiptOfferBody): Record<string, unknown> {
  return {
    capturedAt: o.capturedAt,
    ...(o.width !== undefined ? { width: o.width } : {}),
    ...(o.height !== undefined ? { height: o.height } : {}),
    ocrEngine: o.ocrEngine,
    ownerConfirmed: o.ownerConfirmed,
    ...(o.candidates !== undefined ? { candidates: o.candidates } : {}),
    ...(o.paperInvoice !== undefined ? { paperInvoice: o.paperInvoice, paperIssues: paperIssues(o.paperInvoice) } : {}),
  };
}

function paperIssues(p: unknown): string[] {
  try {
    return checkPaperInvoice(p as Parameters<typeof checkPaperInvoice>[0]);
  } catch {
    return ['shape'];
  }
}

export function engineReceiveSink(rpc: EngineRpc, o: PhoneReceiveOptions = {}): ReceiveSink {
  const log = o.log ?? (() => {});
  return {
    async hasReceipt(msgId: string): Promise<boolean> {
      const r = await rpc('receipt.phoneHas', { msgId });
      if (!isObj(r) || typeof r.has !== 'boolean') throw new Error('phone.bad_response');
      return r.has;
    },
    async storeReceipt(r: { msgId: string; offer: ReceiptOfferBody; jpeg: Uint8Array; pairId: string }): Promise<void> {
      let res: unknown;
      try {
        res = await rpc('receipt.phoneStore', { msgId: r.msgId, pairId: r.pairId, jpeg: r.jpeg, offer: offerParams(r.offer) });
      } catch (e) {
        log('main.phone_receipt', { result: 'failed', code: String((e as { code?: unknown }).code ?? (e as Error).message ?? 'failed').slice(0, 40) });
        throw e;
      }
      if (!isObj(res) || typeof res.docId !== 'string' || typeof res.duplicate !== 'boolean') throw new Error('phone.bad_response');
      log('main.phone_receipt', { result: res.duplicate ? 'duplicate' : 'stored' });
      if (!res.duplicate) o.onReceipt?.();
    },
    async hasCash(): Promise<boolean> {
      return false;
    },
    async storeCash(c: { entry: CashEntryBody; pairId: string }): Promise<void> {
      const res = await rpc('cash.phonePut', { msgId: c.entry.msgId, day: c.entry.day, amount: c.entry.amount, enteredAt: c.entry.enteredAt });
      if (!isObj(res) || typeof res.applied !== 'boolean') throw new Error('phone.bad_response');
      log('main.phone_cash', { applied: res.applied });
      if (res.applied) o.onCash?.();
    },
  };
}

export interface PhoneReceiver {
  queue: ReceiveQueue;
  drain(o: Omit<QueueReceiverOptions, 'receive'>): Promise<DrainResult>;
}

export function phoneReceiver(rpc: EngineRpc, o: PhoneReceiveOptions & { limits?: ReceiveLimits; now?: () => number } = {}): PhoneReceiver {
  const queue = new ReceiveQueue(engineReceiveSink(rpc, o), o.limits, o.now);
  let draining: Promise<DrainResult> | null = null;
  return {
    queue,
    drain(d) {
      draining ??= drainQueue({ ...d, receive: queue }).finally(() => {
        draining = null;
      });
      return draining;
    },
  };
}
