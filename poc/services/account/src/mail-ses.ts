// AWS SES v2 메일 어댑터(D09 §1 Phase 1 환경 "AWS SES 서울"). 공급사 종속 코드는 이 파일 한 곳이다(ADR-015).
// 켜는 조건: MAIL_PROVIDER=ses(기본은 mock). 운영 env·자격 증명은 저장소에 없다(deploy README "SES 켜기 — 사용자 단계").
//
// 송신 허용 목록(이 파일이 강제): POST https://email.<허용 리전>.amazonaws.com/v2/email/outbound-emails 하나뿐이다.
// 리디렉션은 따르지 않는다. 엔진의 packages/net Egress(PC 송신 관문)에는 넣지 않는다: 서버만 SES로 보내고, PC 허용 목록을 넓히지 않는다.
//
// 본문은 종류별 고정 문구다. 값으로 들어가는 것은 6자리 코드뿐이다(이메일 주소·계정·기기 이름·IP 없음). 수신 주소는 Destination에만 있다.
// 로그·이벤트·오류에는 주소·코드·응답 본문을 넣지 않는다(이벤트 이름만).
import { createHash, createHmac } from 'node:crypto';
import type { MailSender, NoticeKind } from './adapters.ts';

/** 허용 리전. Phase 1은 서울만(D09 §1, 국내 처리 원칙) */
export const SES_REGIONS = ['ap-northeast-2'] as const;
export type SesRegion = (typeof SES_REGIONS)[number];
export const SES_PATH = '/v2/email/outbound-emails';
const sesOrigin = (r: string) => `https://email.${r}.amazonaws.com`;

/** 송신 대상이 허용 목록(허용 리전의 SES v2 SendEmail 경로 하나)인가. 쿼리·조각·다른 경로·다른 호스트는 거부 */
export function sesEndpointAllowed(url: string): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  return (SES_REGIONS as readonly string[]).some((r) => u.origin === sesOrigin(r)) && u.pathname === SES_PATH && !u.search && !u.hash && url === u.origin + SES_PATH;
}

/** 메일 실패. code는 이벤트 이름에 쓰는 고정 값이고, 응답 본문(주소를 되풀이할 수 있다)은 담지 않는다 */
export class MailError extends Error {
  readonly code: 'mail.throttled' | 'mail.unavailable' | 'mail.auth_failed' | 'mail.config' | 'mail.rejected' | 'mail.not_allowed';
  /** 같은 메일을 나중에 다시 보내면 될 수 있는가(429·5xx·네트워크·시간 초과). 아니면 설정·거부라 다시 보내도 같다 */
  readonly retryable: boolean;
  constructor(code: MailError['code'], retryable: boolean) {
    super(code);
    this.code = code;
    this.retryable = retryable;
  }
}

// ---------- 서명(AWS Signature Version 4) ----------

const sha256Hex = (b: string | Buffer) => createHash('sha256').update(b).digest('hex');
const hmac = (k: Buffer | string, s: string) => createHmac('sha256', k).update(s, 'utf8').digest();

export interface SigV4Input {
  method: string;
  /** 이미 URI 인코딩된 경로 */
  path: string;
  /** 정규화된 쿼리 문자열(없으면 빈 문자열) */
  query?: string;
  /** 서명할 헤더(이름은 소문자, host·x-amz-date 포함) */
  headers: Record<string, string>;
  payloadSha256: string;
  /** YYYYMMDDTHHMMSSZ */
  amzDate: string;
  region: string;
  service: string;
  accessKeyId: string;
  secretAccessKey: string;
}

/** SigV4 Authorization 헤더 값. 헤더 값은 앞뒤 공백을 빼고 연속 공백을 하나로 접는다 */
export function sigv4(i: SigV4Input): string {
  const h = new Map(Object.entries(i.headers).map(([k, v]) => [k.toLowerCase(), String(v).trim().replace(/\s+/g, ' ')]));
  const names = [...h.keys()].sort();
  const canonHeaders = names.map((n) => `${n}:${h.get(n)}\n`).join('');
  const signed = names.join(';');
  const canonical = [i.method, i.path, i.query ?? '', canonHeaders, signed, i.payloadSha256].join('\n');
  const day = i.amzDate.slice(0, 8);
  const scope = `${day}/${i.region}/${i.service}/aws4_request`;
  const toSign = ['AWS4-HMAC-SHA256', i.amzDate, scope, sha256Hex(canonical)].join('\n');
  const kDate = hmac(`AWS4${i.secretAccessKey}`, day);
  const kSigning = hmac(hmac(hmac(kDate, i.region), i.service), 'aws4_request');
  const signature = createHmac('sha256', kSigning).update(toSign, 'utf8').digest('hex');
  return `AWS4-HMAC-SHA256 Credential=${i.accessKeyId}/${scope}, SignedHeaders=${signed}, Signature=${signature}`;
}

export const amzDate = (ms: number) => new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');

// ---------- 본문(고정 문구) ----------

export type MailKind = 'code' | 'reset_code' | NoticeKind;

const NOTICE_TEXT: Record<NoticeKind, { subject: string; body: string }> = {
  device_enrolled: { subject: '새 기기가 등록됐어요', body: '계정에 새 기기가 등록됐어요. 직접 한 일이 아니면 PC 앱에서 그 기기를 긴급 정지하세요.' },
  device_suspended: { subject: '기기를 긴급 정지했어요', body: '계정의 기기 하나를 긴급 정지했어요. 그 기기는 더 이상 연결되지 않아요.' },
  device_auto_suspended: { subject: '기기를 자동으로 정지했어요', body: '비정상적인 사용이 감지돼 기기 하나를 자동으로 정지했어요. PC 앱에서 기기 목록을 확인하세요.' },
  device_delete_pending: { subject: '기기 삭제를 요청했어요', body: '기기 삭제를 요청했어요. 7일 뒤에 삭제돼요. 직접 한 일이 아니면 PC 앱에서 취소하세요.' },
  device_revoked: { subject: '기기가 계정에서 빠졌어요', body: '기기 하나가 계정에서 폐기됐어요. 그 기기는 더 이상 연결되지 않아요.' },
  aik_pinned: { subject: 'PC가 계정에 연결됐어요', body: '이 계정에 PC 신원 키가 등록됐어요. 직접 한 일이 아니면 고객 지원에 알려 주세요.' },
  passkey_added: { subject: '새 패스키가 등록됐어요', body: '계정에 새 패스키가 등록됐어요. 직접 한 일이 아니면 PC 앱에서 확인하세요.' },
  password_set: { subject: '비밀번호를 설정했어요', body: '계정 비밀번호를 설정하거나 바꿨어요. 직접 한 일이 아니면 이메일 코드로 로그인해 비밀번호를 재설정하세요.' },
  password_reset: { subject: '비밀번호를 재설정했어요', body: '계정 비밀번호를 재설정했어요. 다른 곳의 로그인은 모두 끝났어요.' },
  password_locked: { subject: '비밀번호 로그인이 잠시 잠겼어요', body: '비밀번호가 여러 번 틀려 잠시 잠겼어요. 이메일 코드로 로그인할 수 있어요.' },
  sessions_revoked: { subject: '모든 기기에서 로그아웃했어요', body: '자동 로그인 정보가 다른 곳에서 다시 쓰여 모든 기기에서 로그아웃했어요. 다시 로그인하세요.' },
};

const PREFIX = '[소버린 AX] ';
const FOOTER = '\n\n이 메일은 보내기 전용이에요. 링크를 넣지 않아요. 메일에 있는 주소로 로그인하라는 요청은 따르지 마세요.';

/** 종류별 제목·본문. 값은 코드(6자리)뿐이다 */
export function mailContent(kind: MailKind, code?: string): { subject: string; text: string } {
  if (kind === 'code' || kind === 'reset_code') {
    if (!code || !/^\d{6}$/.test(code)) throw new MailError('mail.rejected', false);
    const what = kind === 'code' ? '로그인' : '비밀번호 재설정';
    // 코드는 본문에만(알림 미리보기·잠금 화면에 제목이 보인다)
    return { subject: `${PREFIX}${what} 코드`, text: `${what} 코드: ${code}\n10분 동안 쓸 수 있어요. 요청하지 않았다면 이 메일을 무시하세요.${FOOTER}` };
  }
  const t = NOTICE_TEXT[kind];
  if (!t) throw new MailError('mail.rejected', false);
  return { subject: PREFIX + t.subject, text: t.body + FOOTER };
}

// ---------- 송신 ----------

export interface SesOptions {
  region: SesRegion;
  /** 보내는 주소(SES에서 인증한 도메인) */
  from: string;
  accessKeyId: string;
  secretAccessKey: string;
  fetchFn?: typeof fetch;
  now?: () => number;
  timeoutMs?: number;
  /** 이벤트 이름만(`account.mail_ses.<결과>`) */
  onEvent?: (name: string) => void;
}

const ADDRESS = /^[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,253}\.[A-Za-z]{2,}$/;

/** SES 오류 종류 → 분류. 400 중 설정 문제(계정 정지·발송 중지·도메인 미인증)는 다시 보내도 같다 */
function classify(status: number, errorType: string): MailError {
  const t = errorType.split(':')[0]!.trim();
  if (status === 429 || t === 'TooManyRequestsException' || t === 'LimitExceededException') return new MailError('mail.throttled', true);
  if (status >= 500) return new MailError('mail.unavailable', true);
  if (status === 401 || status === 403) return new MailError('mail.auth_failed', false);
  if (['AccountSuspendedException', 'SendingPausedException', 'MailFromDomainNotVerifiedException', 'NotFoundException'].includes(t)) return new MailError('mail.config', false);
  return new MailError('mail.rejected', false);
}

export class SesMailSender implements MailSender {
  readonly #o: Required<Omit<SesOptions, 'onEvent'>> & { onEvent: (n: string) => void };
  readonly #endpoint: string;

  constructor(o: SesOptions) {
    if (!(SES_REGIONS as readonly string[]).includes(o.region)) throw new Error('config_SES_REGION');
    if (!ADDRESS.test(o.from)) throw new Error('config_SES_FROM_ADDRESS');
    if (!/^[A-Z0-9]{16,128}$/.test(o.accessKeyId)) throw new Error('config_SES_ACCESS_KEY_ID');
    if (!/^[A-Za-z0-9/+=]{20,128}$/.test(o.secretAccessKey)) throw new Error('config_SES_SECRET_ACCESS_KEY');
    // undefined로 넘긴 선택 값이 기본값을 덮지 않게 ??로 채운다
    this.#o = { ...o, fetchFn: o.fetchFn ?? fetch, now: o.now ?? Date.now, timeoutMs: o.timeoutMs ?? 10_000, onEvent: o.onEvent ?? (() => undefined) };
    this.#endpoint = sesOrigin(o.region) + SES_PATH;
  }

  /** 계정 서비스 env(접두 뺀 이름): SES_FROM_ADDRESS·SES_ACCESS_KEY_ID ⚿·SES_SECRET_ACCESS_KEY ⚿. 리전은 서울 고정 */
  static fromEnv(env: NodeJS.ProcessEnv, extra: Pick<SesOptions, 'fetchFn' | 'now' | 'onEvent'> = {}): SesMailSender {
    const need = (n: string) => env[n] || (() => { throw new Error(`config_${n}`); })();
    return new SesMailSender({ region: 'ap-northeast-2', from: need('SES_FROM_ADDRESS'), accessKeyId: need('SES_ACCESS_KEY_ID'), secretAccessKey: need('SES_SECRET_ACCESS_KEY'), ...extra });
  }

  /** 비밀이 직렬화·로그로 새지 않게 */
  toJSON(): unknown {
    return { provider: 'ses', region: this.#o.region };
  }

  async sendLoginCode(to: string, code: string): Promise<void> {
    await this.send(to, mailContent('code', code));
  }

  async sendResetCode(to: string, code: string): Promise<void> {
    await this.send(to, mailContent('reset_code', code));
  }

  async sendNotice(to: string, kind: NoticeKind): Promise<void> {
    await this.send(to, mailContent(kind));
  }

  private async send(to: string, c: { subject: string; text: string }): Promise<void> {
    if (!ADDRESS.test(to)) throw new MailError('mail.rejected', false);
    if (!sesEndpointAllowed(this.#endpoint)) throw new MailError('mail.not_allowed', false);
    const body = JSON.stringify({
      FromEmailAddress: this.#o.from,
      Destination: { ToAddresses: [to] },
      Content: { Simple: { Subject: { Data: c.subject, Charset: 'UTF-8' }, Body: { Text: { Data: c.text, Charset: 'UTF-8' } } } },
    });
    const host = new URL(this.#endpoint).host;
    const date = amzDate(this.#o.now());
    const payloadSha256 = sha256Hex(body);
    const headers: Record<string, string> = { 'content-type': 'application/json', host, 'x-amz-content-sha256': payloadSha256, 'x-amz-date': date };
    const authorization = sigv4({ method: 'POST', path: SES_PATH, headers, payloadSha256, amzDate: date, region: this.#o.region, service: 'ses', accessKeyId: this.#o.accessKeyId, secretAccessKey: this.#o.secretAccessKey });
    // host는 fetch가 URL로 붙인다(서명에는 넣었다)
    const sent = Object.fromEntries(Object.entries(headers).filter(([k]) => k !== 'host'));
    let res: Response;
    try {
      res = await this.#o.fetchFn(this.#endpoint, { method: 'POST', headers: { ...sent, authorization }, body, redirect: 'error', signal: AbortSignal.timeout(this.#o.timeoutMs) });
    } catch {
      this.#o.onEvent('account.mail_ses.unavailable');
      throw new MailError('mail.unavailable', true);
    }
    // 응답 본문은 읽어 버린다(연결 재사용). 내용은 오류에도 이벤트에도 넣지 않는다
    const text = await res.text().catch(() => '');
    if (res.ok) {
      // 2xx면 SES가 받았다. MessageId가 없어도 다시 보내지 않는다(중복 발송보다 낫다)
      let id: unknown;
      try {
        id = (JSON.parse(text) as { MessageId?: unknown }).MessageId;
      } catch {
        id = undefined;
      }
      this.#o.onEvent(typeof id === 'string' && id ? 'account.mail_ses.sent' : 'account.mail_ses.sent_no_id');
      return;
    }
    const err = classify(res.status, res.headers.get('x-amzn-errortype') ?? '');
    this.#o.onEvent(`account.mail_ses.${err.code.slice('mail.'.length)}`);
    throw err;
  }
}
