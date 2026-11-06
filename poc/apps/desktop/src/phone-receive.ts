// 폰 사진·현금 수신 배선(데스크톱 ③c, D08 §6, 팀장 결정 2026-11-06). @sax/remote ReceiveQueue(라이브 세션·큐 드레인 공용)를 엔진 main 전용 명령에 얇게 붙인다.
// - main은 DB를 열지 않는다. 중복·고아 방지는 엔진 PhoneIntake(@sax/bundle, #123)가 한다: 쓰기 전 msgId 검사 → 보관함 파일 → 한 트랜잭션.
// - 중복은 msgId(receipts.phone_msg_id)로만 본다. hasReceipt는 조립 전에 묻는 빠른 길이고, 늦게 온 같은 msgId도 phoneStore가 duplicate로 받아 넘긴다.
// - 현금: cash_sales에 msg_id 칸이 없어 hasCash는 늘 false다. 엔진이 늦은 enteredAt만 바꿔 같은 메시지 재수신은 멱등이다.
// - 사진은 신뢰하지 않는 입력이라 main이 열지 않는다(재판독은 docparse 샌드박스 몫). 로그는 결과만(msgId·금액·날짜 없음).
import { drainQueue, ReceiveQueue, type CashEntryBody, type DrainResult, type QueueReceiverOptions, type ReceiptOfferBody, type ReceiveLimits, type ReceiveSink } from '@sax/remote';

export type EngineRpc = (method: string, params: Record<string, unknown>) => Promise<unknown>;
export type PhoneLog = (name: string, data?: Record<string, string | number | boolean>) => void;

export interface PhoneReceiveOptions {
  /** 새 영수증이 보관함에 들어간 뒤(중복은 부르지 않는다). 문서함 다시 읽기 등 */
  onReceipt?: () => void;
  /** 현금 매출이 바뀐 뒤 */
  onCash?: () => void;
  log?: PhoneLog;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** 엔진에 넘길 offer 칸(조립 정보·sha256은 넘기지 않는다, 엔진은 받은 바이트로 다시 잰다). */
export function offerParams(o: ReceiptOfferBody): Record<string, unknown> {
  return {
    capturedAt: o.capturedAt,
    ...(o.width !== undefined ? { width: o.width } : {}),
    ...(o.height !== undefined ? { height: o.height } : {}),
    ocrEngine: o.ocrEngine,
    ownerConfirmed: o.ownerConfirmed,
    ...(o.candidates !== undefined ? { candidates: o.candidates } : {}),
  };
}

/** ReceiveSink → 엔진 rpc. 응답 모양이 틀리면 던진다(ReceiveQueue는 ack하지 않고, 폰이 다시 보낸다). */
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
        // 코드만(엔진 오류 문구에 값이 없지만 길이를 묶는다)
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
  /** 라이브 세션 루프에서 봉투마다 queue.handle(channel, env)를 부른다. */
  queue: ReceiveQueue;
  /** 릴레이 큐를 비운다(PC가 꺼져 있던 동안 쌓인 것). 받기는 같은 ReceiveQueue로 간다. */
  drain(o: Omit<QueueReceiverOptions, 'receive'>): Promise<DrainResult>;
}

/** 페어 하나당 하나. 라이브 세션과 큐 드레인이 같은 조립·중복 판정을 쓴다. */
export function phoneReceiver(rpc: EngineRpc, o: PhoneReceiveOptions & { limits?: ReceiveLimits; now?: () => number } = {}): PhoneReceiver {
  const queue = new ReceiveQueue(engineReceiveSink(rpc, o), o.limits, o.now);
  let draining: Promise<DrainResult> | null = null;
  return {
    queue,
    drain(d) {
      // 겹친 드레인은 같은 결과를 기다린다(같은 seq를 두 번 열지 않게)
      draining ??= drainQueue({ ...d, receive: queue }).finally(() => {
        draining = null;
      });
      return draining;
    },
  };
}
