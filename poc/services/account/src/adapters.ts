// 외부 의존 어댑터: 결제(PG, 국내)와 메일 발송(국내 사업자, C-30). 실제 공급사 구현은 이 인터페이스 뒤에 하나씩 둔다(ADR-015).
// 실제 PG는 토스페이먼츠 자동결제(pg-toss.ts, PG_PROVIDER=toss). 실제 자격 증명은 저장소·CI에 두지 않는다.
import { hmacHex, randomToken, safeEqual } from '@sax/svc-shared';

/** 한 플랜(ADR-034 결정 3). 가격은 월 19,900원 부가세 포함(사용자 결정 2026-11-16, ADR-034의 9,900원을 바꿈). 세무사 요금은 다음 단계. */
export const PLAN = { id: 'standard', amountKrw: 19900, period: 'month' } as const;

/** `at` = PG가 이벤트를 만든 시각(ms, 서명 범위 안). 늦게 오거나 재전송된 이벤트를 거르는 순서 기준이다. */
export type PaymentEvent =
  | { type: 'subscription.activated'; pgCustomerRef: string; renewAt: number; at: number }
  | { type: 'subscription.renewed'; pgCustomerRef: string; renewAt: number; at: number }
  | { type: 'payment.failed'; pgCustomerRef: string; at: number }
  | { type: 'subscription.canceled'; pgCustomerRef: string; at: number };

/** 청구 결과. uncertain = 결제됐는지 모름(네트워크·5xx·처리 중·우리 설정 문제): 같은 주문번호로 다시 물어야 하고 카드 실패로 세지 않는다 */
export type ChargeResult = { ok: true; paymentKey?: string } | { ok: false; uncertain: boolean; code: string };

/** 빌링키 방식 PG(토스페이먼츠 자동결제). PG가 매달 스스로 청구하지 않아서 우리가 갱신일에 청구한다(정리 cron). */
export interface BillingKeyGateway {
  readonly kind: 'billing_key';
  readonly mode: 'test' | 'live';
  /** 카드 등록 창 HTML(PG SDK). customerKey = pgCustomerRef */
  cardPage(o: { customerKey: string; successUrl: string; failUrl: string; amountKrw: number; nonce: string; trialEndsAt?: number }): string;
  /** 카드 등록 창이 돌려준 authKey로 빌링키 발급. 실패하면 null */
  issueBillingKey(o: { authKey: string; customerKey: string }): Promise<{ billingKey: string } | null>;
  /** 한 번 청구. orderId는 멱등 키로도 쓴다(같은 주문번호 재시도는 두 번 결제되지 않는다) */
  charge(o: { billingKey: string; customerKey: string; orderId: string; amountKrw: number; orderName: string }): Promise<ChargeResult>;
  /** 결제 취소(청약철회 환불, 부분 가능). idempotencyKey가 같으면 두 번 환불되지 않는다 */
  refund(o: { paymentKey: string; amountKrw: number; reason: string; idempotencyKey: string }): Promise<{ ok: true } | { ok: false; uncertain: boolean; code: string }>;
}

export interface PaymentGateway {
  /** 빌링키 방식이면 있다(웹훅 대신 카드 등록 창·우리 청구). 없으면 웹훅 방식(모의 PG) */
  readonly billing?: BillingKeyGateway;
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
      if (!types.includes(e.type) || typeof e.pgCustomerRef !== 'string' || !Number.isSafeInteger(e.at)) return null;
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

/** 모의 빌링키 PG(시험용). 청구 결과를 차례로 정할 수 있다(기본 성공) */
export class MockBillingGateway implements PaymentGateway {
  readonly charges: Array<{ billingKey: string; customerKey: string; orderId: string; amountKrw: number }> = [];
  readonly refunds: Array<{ paymentKey: string; amountKrw: number; idempotencyKey: string }> = [];
  /** 다음 환불 결과들(비면 성공) */
  readonly nextRefund: Array<{ ok: true } | { ok: false; uncertain: boolean; code: string }> = [];
  readonly issued: string[] = [];
  /** 다음 청구 결과들(비면 성공) */
  readonly next: ChargeResult[] = [];
  readonly billing: BillingKeyGateway;
  readonly publicOrigin: string;
  constructor(publicOrigin = 'https://acct.test.invalid') {
    this.publicOrigin = publicOrigin;
    this.billing = {
      kind: 'billing_key',
      mode: 'test',
      cardPage: (o) => `<html data-customer="${o.customerKey}" data-success="${o.successUrl}" data-trial="${o.trialEndsAt ?? ''}"></html>`,
      issueBillingKey: async (o) => {
        if (o.authKey === 'bad') return null;
        const billingKey = `bk_${o.customerKey}_${this.issued.length}`;
        this.issued.push(billingKey);
        return { billingKey };
      },
      charge: async (o) => {
        this.charges.push({ billingKey: o.billingKey, customerKey: o.customerKey, orderId: o.orderId, amountKrw: o.amountKrw });
        return this.next.shift() ?? { ok: true, paymentKey: `pay_${o.orderId}` };
      },
      refund: async (o) => {
        this.refunds.push({ paymentKey: o.paymentKey, amountKrw: o.amountKrw, idempotencyKey: o.idempotencyKey });
        return this.nextRefund.shift() ?? { ok: true };
      },
    };
  }
  async createCheckout(o: { pgCustomerRef: string }): Promise<{ checkoutUrl: string }> {
    return { checkoutUrl: `${this.publicOrigin}/v1/billing/card?ref=${o.pgCustomerRef}` };
  }
  verifyWebhook(): PaymentEvent | null {
    return null;
  }
  async cancel(): Promise<void> {}
}

export type NoticeKind =
  | 'device_enrolled'
  | 'device_suspended'
  | 'device_auto_suspended'
  | 'device_delete_pending'
  /** 탈퇴 요청: 7일 뒤 삭제, 구독 해지됨, 유예 중 취소 가능 */
  | 'account_delete_pending'
  | 'device_revoked'
  | 'aik_pinned'
  | 'passkey_added'
  /** 비밀번호를 설정·바꿈(ADR-038) */
  | 'password_set'
  /** 재설정 완료: 다른 세션·갱신 토큰 모두 폐기(ADR-038 (e)) */
  | 'password_reset'
  /** "비밀번호가 여러 번 틀려 잠시 잠겼어요. 이메일 코드로 로그인할 수 있어요." 잠금 주기마다 1회(ADR-038 (d)) */
  | 'password_locked'
  /** 갱신 토큰 재사용 감지: 모든 기기에서 로그아웃됨(ADR-038 (f)) */
  | 'sessions_revoked'
  /** 구독 해지 접수: 다음 결제 없음, 낸 기간까지 사용 */
  | 'subscription_canceled'
  /** 청약철회 환불 접수 */
  | 'subscription_refunded'
  /** 갱신 결제 실패: 다음 날 다시 시도 */
  | 'payment_failed'
  /** 결제가 세 번 실패해 구독이 끝남 */
  | 'subscription_ended'
  /** 무료 체험이 곧 끝나 등록한 카드로 첫 결제가 됨(7일 전, 전환 전 고지) */
  | 'trial_converting';

export interface MailSender {
  sendLoginCode(to: string, code: string): Promise<void>;
  /** 비밀번호 재설정 코드(6자리, 10분). 로그인 코드와 다른 문구 */
  sendResetCode(to: string, code: string): Promise<void>;
  /** 계정 설정 재인증 코드(6자리, 10분). 로그인 세션 안에서 본인 확인만 하고 새 세션을 만들지 않는다(사용자 확정 2026-11-09) */
  sendReauthCode(to: string, code: string): Promise<void>;
  /** 알림 메일. 내용은 종류별 고정 문구이고 기기 이름 같은 값은 넣지 않는다. */
  sendNotice(to: string, kind: NoticeKind): Promise<void>;
}

/** 모의 메일. 받은 편지함을 메모리에만 둔다(표준 출력·로그에 쓰지 않는다). */
export class MockMailSender implements MailSender {
  readonly outbox: Array<{ to: string; kind: 'code' | 'reset_code' | 'reauth_code' | NoticeKind; code?: string }> = [];
  async sendLoginCode(to: string, code: string): Promise<void> {
    this.outbox.push({ to, kind: 'code', code });
  }
  async sendResetCode(to: string, code: string): Promise<void> {
    this.outbox.push({ to, kind: 'reset_code', code });
  }
  async sendReauthCode(to: string, code: string): Promise<void> {
    this.outbox.push({ to, kind: 'reauth_code', code });
  }
  lastReauthCode(to: string): string | undefined {
    return [...this.outbox].reverse().find((m) => m.to === to && m.kind === 'reauth_code')?.code;
  }
  lastResetCode(to: string): string | undefined {
    return [...this.outbox].reverse().find((m) => m.to === to && m.kind === 'reset_code')?.code;
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

/**
 * 릴레이의 1회용 페어링 룸 소비 확인(팀장 결정 2026-11-06, D08 §4.2 7단계). PC가 폰을 대신 등록할 때
 * 그 PC가 만든 룸에 폰이 실제로 붙었고(정원 2가 찼고) 아직 등록에 쓰이지 않았으면 'ok'를 주고 룸을 소비 처리한다(룸은 닫지 않는다).
 */
export interface PairingRooms {
  /** ok: 이번에 소비함, used: 그 PC 룸이 이미 등록에 쓰였음(409), unavailable: 없음·만료·미페어링·다른 PC·장애(404) */
  redeem(roomId: string, desktopDeviceId: string): Promise<'ok' | 'used' | 'unavailable'>;
}
