// 외부 의존 어댑터: 결제(PG, 국내)와 메일 발송(국내 사업자, C-30). 실제 공급사 구현은 이 인터페이스 뒤에 하나씩 둔다(ADR-015).
// 이 저장소에는 모의 구현만 있다. 실제 자격 증명은 저장소·CI에 두지 않는다.
import { hmacHex, randomToken, safeEqual } from '@sax/svc-shared';

/** 9,900원 한 플랜(ADR-034 결정 3). 세무사 요금은 다음 단계. */
export const PLAN = { id: 'standard', amountKrw: 9900, period: 'month' } as const;

export type PaymentEvent =
  | { type: 'subscription.activated'; pgCustomerRef: string; renewAt: number }
  | { type: 'subscription.renewed'; pgCustomerRef: string; renewAt: number }
  | { type: 'payment.failed'; pgCustomerRef: string }
  | { type: 'subscription.canceled'; pgCustomerRef: string };

export interface PaymentGateway {
  /** 결제 창 URL. pgCustomerRef는 우리가 만든 불투명 참조이고 이메일·계정 ID를 PG에 보내지 않는다. */
  createCheckout(o: { pgCustomerRef: string; plan: typeof PLAN; returnUrl: string }): Promise<{ checkoutUrl: string }>;
  /** 웹훅 원문 서명 검증. 실패하면 null. */
  verifyWebhook(raw: Buffer, headers: Record<string, string | string[] | undefined>): PaymentEvent | null;
  cancel(pgCustomerRef: string): Promise<void>;
}

/** 모의 PG(샌드박스 대용). 웹훅 서명 = HMAC-SHA256(secret, raw) hex, 헤더 x-mock-pg-signature. */
export class MockPaymentGateway implements PaymentGateway {
  readonly secret: string;
  readonly canceled: string[] = [];
  readonly checkouts: Array<{ pgCustomerRef: string; amountKrw: number }> = [];
  constructor(secret: string = randomToken()) {
    this.secret = secret;
  }
  async createCheckout(o: { pgCustomerRef: string; plan: typeof PLAN; returnUrl: string }): Promise<{ checkoutUrl: string }> {
    this.checkouts.push({ pgCustomerRef: o.pgCustomerRef, amountKrw: o.plan.amountKrw });
    return { checkoutUrl: `https://pg.mock.invalid/checkout/${o.pgCustomerRef}` };
  }
  sign(raw: Buffer): string {
    return hmacHex(this.secret, raw);
  }
  verifyWebhook(raw: Buffer, headers: Record<string, string | string[] | undefined>): PaymentEvent | null {
    const sig = headers['x-mock-pg-signature'];
    if (typeof sig !== 'string' || !safeEqual(sig, this.sign(raw))) return null;
    try {
      const e = JSON.parse(raw.toString('utf8')) as PaymentEvent;
      const types = ['subscription.activated', 'subscription.renewed', 'payment.failed', 'subscription.canceled'];
      if (!types.includes(e.type) || typeof e.pgCustomerRef !== 'string') return null;
      if ((e.type === 'subscription.activated' || e.type === 'subscription.renewed') && !Number.isSafeInteger(e.renewAt)) return null;
      return e;
    } catch {
      return null;
    }
  }
  async cancel(pgCustomerRef: string): Promise<void> {
    this.canceled.push(pgCustomerRef);
  }
}

export type NoticeKind = 'device_enrolled' | 'device_suspended' | 'device_delete_pending' | 'device_revoked' | 'aik_pinned' | 'passkey_added';

export interface MailSender {
  sendLoginCode(to: string, code: string): Promise<void>;
  /** 알림 메일. 내용은 종류별 고정 문구이고 기기 이름 같은 값은 넣지 않는다. */
  sendNotice(to: string, kind: NoticeKind): Promise<void>;
}

/** 모의 메일. 받은 편지함을 메모리에만 둔다(표준 출력·로그에 쓰지 않는다). */
export class MockMailSender implements MailSender {
  readonly outbox: Array<{ to: string; kind: 'code' | NoticeKind; code?: string }> = [];
  async sendLoginCode(to: string, code: string): Promise<void> {
    this.outbox.push({ to, kind: 'code', code });
  }
  async sendNotice(to: string, kind: NoticeKind): Promise<void> {
    this.outbox.push({ to, kind });
  }
  lastCode(to: string): string | undefined {
    return [...this.outbox].reverse().find((m) => m.to === to && m.kind === 'code')?.code;
  }
}

/** 긴급 정지·폐기 알림을 받는 쪽(릴레이·푸시). 운영은 내부 HTTP, 시험은 in-process. */
export interface DeviceStopHook {
  stopped(deviceId: string): Promise<void>;
}
