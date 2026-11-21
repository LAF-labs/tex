import type { BillingKeyGateway, ChargeResult, PaymentEvent, PaymentGateway, PLAN } from './adapters.ts';

export const TOSS_API = 'https://api.tosspayments.com';
export const TOSS_SDK = 'https://js.tosspayments.com/v2/standard';
const ISSUE_PATH = '/v1/billing/authorizations/issue';
const chargePath = (billingKey: string) => `/v1/billing/${encodeURIComponent(billingKey)}`;
const cancelPath = (paymentKey: string) => `/v1/payments/${encodeURIComponent(paymentKey)}/cancel`;

/** 송신 대상이 허용 목록(빌링키 발급·청구·결제 취소 세 경로)인가 */
export function tossEndpointAllowed(url: string): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.origin !== TOSS_API || u.search || u.hash) return false;
  return u.pathname === ISSUE_PATH || /^\/v1\/billing\/[A-Za-z0-9%_=-]{1,200}$/.test(u.pathname) || /^\/v1\/payments\/[A-Za-z0-9%_=-]{1,200}\/cancel$/.test(u.pathname);
}

const UNCERTAIN_CODES = new Set(['IDEMPOTENT_REQUEST_PROCESSING', 'FAILED_INTERNAL_SYSTEM_PROCESSING', 'PROVIDER_ERROR', 'FAILED_PAYMENT_INTERNAL_SYSTEM_PROCESSING', 'UNKNOWN_PAYMENT_ERROR']);
const CONFIG_CODES = new Set(['UNAUTHORIZED_KEY', 'INVALID_API_KEY', 'NOT_SUPPORTED_METHOD', 'INVALID_BILLING_AUTH', 'FORBIDDEN_REQUEST', 'NOT_REGISTERED_BUSINESS']);

export interface TossConfig {
  clientKey: string;
  secretKey: string;
  publicOrigin: string;
  fetchFn?: typeof fetch;
  timeoutMs?: number;
  onEvent?: (name: string) => void;
}

const KEY_RE = /^(test|live)_(ck|sk|gck|gsk)_[A-Za-z0-9]{10,80}$/;

export class TossPaymentGateway implements PaymentGateway {
  readonly billing: BillingKeyGateway;
  readonly mode: 'test' | 'live';
  private readonly c: Required<Omit<TossConfig, 'onEvent'>> & Pick<TossConfig, 'onEvent'>;

  static fromEnv(env: NodeJS.ProcessEnv, publicOrigin: string, o: { fetchFn?: typeof fetch; onEvent?: (n: string) => void } = {}): TossPaymentGateway {
    return new TossPaymentGateway({ clientKey: env.TOSS_CLIENT_KEY ?? '', secretKey: env.TOSS_SECRET_KEY ?? '', publicOrigin, ...o });
  }

  constructor(c: TossConfig) {
    const ck = KEY_RE.exec(c.clientKey);
    const sk = KEY_RE.exec(c.secretKey);
    if (!ck || !/ck$/.test(ck[2]!)) throw new Error('config_TOSS_CLIENT_KEY');
    if (!sk || !/sk$/.test(sk[2]!)) throw new Error('config_TOSS_SECRET_KEY');
    if (ck[2] !== 'ck' || sk[2] !== 'sk') throw new Error('config_TOSS_KEY_KIND');
    if (ck[1] !== sk[1]) throw new Error('config_TOSS_KEY_MODE');
    this.mode = ck[1] as 'test' | 'live';
    this.c = { fetchFn: fetch, timeoutMs: 15_000, ...c };
    this.billing = {
      kind: 'billing_key',
      mode: this.mode,
      cardPage: (o) => cardPageHtml(this.c.clientKey, o),
      issueBillingKey: (o) => this.issue(o),
      charge: (o) => this.chargeOnce(o),
      refund: (o) => this.cancelPayment(o),
    };
  }

  async createCheckout(o: { pgCustomerRef: string; plan: typeof PLAN; returnUrl: string }): Promise<{ checkoutUrl: string }> {
    return { checkoutUrl: `${this.c.publicOrigin}/v1/billing/card?ref=${encodeURIComponent(o.pgCustomerRef)}` };
  }

  verifyWebhook(): PaymentEvent | null {
    return null;
  }

  async cancel(): Promise<void> {}

  private auth(): string {
    return `Basic ${Buffer.from(`${this.c.secretKey}:`).toString('base64')}`;
  }

  private async post(path: string, body: object, idempotencyKey?: string): Promise<{ status: number; json: Record<string, unknown> } | null> {
    const url = TOSS_API + path;
    if (!tossEndpointAllowed(url)) throw new Error('pg.not_allowed');
    const headers: Record<string, string> = { authorization: this.auth(), 'content-type': 'application/json' };
    if (idempotencyKey) headers['idempotency-key'] = idempotencyKey;
    try {
      const res = await this.c.fetchFn(url, { method: 'POST', headers, body: JSON.stringify(body), redirect: 'manual', signal: AbortSignal.timeout(this.c.timeoutMs) });
      const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      return { status: res.status, json: json && typeof json === 'object' ? json : {} };
    } catch {
      return null;
    }
  }

  private async issue(o: { authKey: string; customerKey: string }): Promise<{ billingKey: string } | null> {
    const r = await this.post(ISSUE_PATH, { authKey: o.authKey, customerKey: o.customerKey });
    if (r?.status === 200 && typeof r.json.billingKey === 'string' && r.json.customerKey === o.customerKey) return { billingKey: r.json.billingKey };
    this.c.onEvent?.(`account.pg_issue_failed.${r ? code(r.json) : 'network'}`);
    return null;
  }

  private async chargeOnce(o: { billingKey: string; customerKey: string; orderId: string; amountKrw: number; orderName: string }): Promise<ChargeResult> {
    const r = await this.post(chargePath(o.billingKey), { customerKey: o.customerKey, amount: o.amountKrw, orderId: o.orderId, orderName: o.orderName }, o.orderId);
    if (!r) return { ok: false, uncertain: true, code: 'network' };
    if (r.status === 200 && r.json.status === 'DONE' && r.json.orderId === o.orderId && r.json.totalAmount === o.amountKrw) return typeof r.json.paymentKey === 'string' ? { ok: true, paymentKey: r.json.paymentKey } : { ok: true };
    const c = code(r.json);
    if (c === 'ALREADY_PROCESSED_PAYMENT') return { ok: true };
    if (r.status >= 500 || r.status === 409 || UNCERTAIN_CODES.has(c)) return { ok: false, uncertain: true, code: c };
    if (CONFIG_CODES.has(c) || r.status === 401) return { ok: false, uncertain: true, code: `config.${c}` };
    return { ok: false, uncertain: false, code: c };
  }

  private async cancelPayment(o: { paymentKey: string; amountKrw: number; reason: string; idempotencyKey: string }): Promise<{ ok: true } | { ok: false; uncertain: boolean; code: string }> {
    const r = await this.post(cancelPath(o.paymentKey), { cancelReason: o.reason, cancelAmount: o.amountKrw }, o.idempotencyKey);
    if (!r) return { ok: false, uncertain: true, code: 'network' };
    if (r.status === 200 && (r.json.status === 'CANCELED' || r.json.status === 'PARTIAL_CANCELED')) return { ok: true };
    const c = code(r.json);
    if (c === 'ALREADY_CANCELED_PAYMENT') return { ok: true };
    if (r.status >= 500 || r.status === 409 || UNCERTAIN_CODES.has(c)) return { ok: false, uncertain: true, code: c };
    return { ok: false, uncertain: false, code: c };
  }
}

function code(j: Record<string, unknown>): string {
  return typeof j.code === 'string' && /^[A-Z_]{1,64}$/.test(j.code) ? j.code : 'unknown';
}

const kstDate = (ms: number) => {
  const k = new Date(ms + 9 * 3600_000);
  return `${k.getUTCFullYear()}년 ${k.getUTCMonth() + 1}월 ${k.getUTCDate()}일`;
};

const esc = (s: string) => s.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);

function cardPageHtml(clientKey: string, o: { customerKey: string; successUrl: string; failUrl: string; amountKrw: number; nonce: string; trialEndsAt?: number }): string {
  const data = JSON.stringify({ clientKey, customerKey: o.customerKey, successUrl: o.successUrl, failUrl: o.failUrl }).replace(/</g, '\\u003c');
  const won = `${o.amountKrw.toLocaleString('ko-KR')}원`;
  const trial = o.trialEndsAt ? kstDate(o.trialEndsAt) : null;
  return `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>구독 결제</title><style nonce="${esc(o.nonce)}">${PAGE_CSS}</style></head><body><main>
<h1>월 ${won} 구독</h1>
${trial ? `<p>지금은 무료 체험 중이라 <strong>오늘은 결제되지 않아요</strong>. 카드를 등록하면 체험이 끝나는 ${trial}에 첫 결제가 되고, 그다음부터 매월 같은 날 자동으로 결제돼요. 그 전에 해지하면 아무 결제도 없어요.</p>` : '<p>카드를 등록하면 오늘 첫 달 요금이 결제되고, 다음 달부터 매월 같은 날 자동으로 결제돼요.</p>'}
<dl>
<dt>결제 금액</dt><dd>매월 ${won} (부가세 포함)</dd>
<dt>결제일</dt><dd>${trial ? `${trial}(체험이 끝나는 날)` : '오늘'}, 그다음부터 매월 같은 날 자동 갱신(그달에 같은 날이 없으면 말일)${trial ? '. 첫 결제 7일 전에 메일로 다시 알려드려요' : ''}</dd>
<dt>해지</dt><dd>앱의 구독 화면에서 언제든 바로 해지할 수 있어요. 해지하면 다음 결제가 없고, 이미 낸 기간이 끝날 때까지 쓸 수 있어요.</dd>
<dt>청약철회/환불</dt><dd>${trial ? '체험 중 해지하면 결제가 없어요. ' : ''}결제 후 7일 안에 철회할 수 있어요. 쓰지 않았으면 전액, 썼으면 쓴 날만큼 빼고 돌려드려요.</dd>
<dt>결제 실패</dt><dd>다음 날 다시 결제를 시도하고, 세 번 실패하면 구독이 끝나 유료 기능이 멈춰요.</dd>
</dl>
<label class="agree"><input id="agree" type="checkbox"> 위 내용과 <a href="${TERMS_URL}" target="_blank" rel="noopener">이용약관</a>, <a href="${PRIVACY_URL}" target="_blank" rel="noopener">개인정보처리방침</a>을 확인했고 매월 자동 결제에 동의해요</label>
<button id="go" type="button" disabled>${trial ? `카드 등록하기(오늘 결제 없음)` : `${won} 결제하고 구독 시작`}</button>
<p class="muted" id="msg"></p>
<footer>${SELLER_INFO}, 결제 대행: 토스페이먼츠</footer></main>
<script src="${TOSS_SDK}"></script>
<script nonce="${esc(o.nonce)}">
const d = ${data};
const btn = document.getElementById('go');
const agree = document.getElementById('agree');
const msg = document.getElementById('msg');
agree.addEventListener('change', () => { btn.disabled = !agree.checked; });
btn.addEventListener('click', async () => {
  if (!agree.checked) return;
  btn.disabled = true; msg.textContent = '';
  try {
    const p = TossPayments(d.clientKey).payment({ customerKey: d.customerKey });
    await p.requestBillingAuth({ method: 'CARD', successUrl: d.successUrl, failUrl: d.failUrl });
  } catch (e) {
    msg.textContent = '카드 등록 창을 열지 못했어요. 다시 눌러 주세요.';
    btn.disabled = false;
  }
});
</script></body></html>`;
}

/** 약관·처리방침 전문(약관 판 terms-2026-11-30). 결제 성공 때 이 판을 동의 이력에 남긴다 */
export const TERMS_URL = 'https://tax.laf-co.com/terms';
export const PRIVACY_URL = 'https://tax.laf-co.com/privacy';
export const TERMS_VERSION = 'terms-2026-11-30';
/** 판매자 표시(전자상거래법 §10). TODO(사용자): 대표자·사업자등록번호·통신판매업 신고번호·주소·전화번호를 받아 채운다 */
export const SELLER_INFO = 'LAF, contact@laf-co.com';

export const PAGE_CSS =
  'body{margin:0;font-family:-apple-system,BlinkMacSystemFont,"Apple SD Gothic Neo","Pretendard",sans-serif;background:#f7f7f8;color:#191f28}' +
  'main{max-width:420px;margin:12vh auto;padding:0 16px}h1{font-size:22px;margin:0 0 12px}p{line-height:1.6;color:#4e5968}' +
  'button,a.btn{display:block;width:100%;box-sizing:border-box;margin-top:24px;padding:14px;border:0;border-radius:10px;background:#3182f6;color:#fff;font-size:16px;font-weight:600;text-align:center;text-decoration:none;cursor:pointer}' +
  'button:disabled{opacity:.5}.muted{font-size:14px;color:#8b95a1}' +
  'dl{margin:20px 0;font-size:14px}dt{font-weight:600;margin-top:10px}dd{margin:2px 0 0;color:#4e5968;line-height:1.5}' +
  '.agree{display:flex;gap:8px;align-items:flex-start;font-size:14px;line-height:1.5;margin-top:16px}.agree input{margin-top:4px}a{color:#3182f6}' +
  'footer{margin-top:32px;font-size:12px;color:#8b95a1}@media(prefers-color-scheme:dark){body{background:#17171c;color:#f2f4f6}p{color:#b0b8c1}}';

/** 결과 페이지(고정 문구). 돌아갈 주소는 설정 값(BILLING_RETURN_URL)만 쓴다 */
export function resultPageHtml(o: { title: string; body: string; returnUrl: string; nonce: string }): string {
  return `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(o.title)}</title><style nonce="${esc(o.nonce)}">${PAGE_CSS}</style></head><body><main>
<h1>${esc(o.title)}</h1><p>${esc(o.body)}</p><a class="btn" href="${esc(o.returnUrl)}">앱으로 돌아가기</a></main></body></html>`;
}

/** 결제 창 응답 헤더. 토스 SDK·결제 창만 허용 */
export function pageHeaders(nonce: string): Record<string, string> {
  return {
    'content-type': 'text/html; charset=utf-8',
    'content-security-policy': `default-src 'none'; script-src 'nonce-${nonce}' https://*.tosspayments.com https://*.toss.im; style-src 'nonce-${nonce}' https://*.tosspayments.com https://*.toss.im; font-src https://*.toss.im https://*.tosspayments.com; connect-src https://*.tosspayments.com https://*.toss.im; frame-src https://*.tosspayments.com https://*.toss.im; img-src https: data:; base-uri 'none'; frame-ancestors 'none'`,
  };
}
