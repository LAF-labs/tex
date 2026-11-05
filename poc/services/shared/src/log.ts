// 내용 없는 구조화 로그(D09 §1.1 "로그·APM: 바디 수집 금지. 오류 경로 포함 로그 스키마 고정", §3 본문 무저장).
// 접근 로그는 아래 고정 필드만 갖는다. 경로는 실제 경로가 아니라 라우트 패턴이다(경로의 ID·우편함 ID·사업자번호가 남지 않게).
// 계정 식별자는 서비스가 허용한 경우에만 일 회전 HMAC(`aid`)으로 남긴다. 평문 IP·헤더·쿼리·본문 필드는 스키마에 없다.

export interface AccessLogEntry {
  /** 로그 시각(ISO, 초 단위로 자름) */
  t: string;
  svc: string;
  m: string;
  /** 라우트 패턴(예: /v1/devices/:id/suspend). 일치 없음은 '-' */
  route: string;
  status: number;
  /** 오류 코드(D16) 또는 '' */
  code: string;
  bytesIn: number;
  bytesOut: number;
  ms: number;
  /** 계정 식별자의 일 회전 HMAC. 진위확인 프록시·릴레이 같은 경로는 비운다. */
  aid?: string;
}

/** 운영 이벤트(보안 이벤트 카운트 등). 이름과 정수 값만. */
export interface EventLogEntry {
  t: string;
  svc: string;
  event: string;
  count: number;
}

export type LogEntry = AccessLogEntry | EventLogEntry;

const ACCESS_KEYS = new Set(['t', 'svc', 'm', 'route', 'status', 'code', 'bytesIn', 'bytesOut', 'ms', 'aid']);
const EVENT_KEYS = new Set(['t', 'svc', 'event', 'count']);
const SAFE_TOKEN = /^[A-Za-z0-9_.:/\-*]{0,96}$/;

export type LogSink = (line: string) => void;

/**
 * 로그를 쓰기 직전에 스키마를 다시 강제한다(타입을 우회한 호출에도 허용 필드 외는 버리고 문자열 값은 안전 문자만).
 * 잘못된 값은 '!'로 바꾼다(값을 그대로 남기지 않는다).
 */
export function sanitize(e: Record<string, unknown>): Record<string, unknown> {
  const allowed = 'event' in e ? EVENT_KEYS : ACCESS_KEYS;
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(e)) {
    if (!allowed.has(k)) continue;
    const v = e[k];
    if (typeof v === 'number') out[k] = Number.isFinite(v) ? Math.round(v) : 0;
    else if (typeof v === 'string') out[k] = k === 't' || SAFE_TOKEN.test(v) ? v : '!';
  }
  return out;
}

export class Logger {
  readonly svc: string;
  private readonly sink: LogSink;
  private readonly now: () => number;
  constructor(svc: string, sink: LogSink = (l) => process.stdout.write(l + '\n'), now: () => number = Date.now) {
    this.svc = svc;
    this.sink = sink;
    this.now = now;
  }
  private ts(): string {
    return new Date(Math.floor(this.now() / 1000) * 1000).toISOString();
  }
  access(e: Omit<AccessLogEntry, 't' | 'svc'>): void {
    this.sink(JSON.stringify(sanitize({ ...e, t: this.ts(), svc: this.svc })));
  }
  event(event: string, count = 1): void {
    this.sink(JSON.stringify(sanitize({ t: this.ts(), svc: this.svc, event, count })));
  }
}

/**
 * 로그 싱크 식별자 탐지기(D09 §3 검증 수단). 운영에서는 싱크 앞단에서, 시험에서는 모든 로그 줄에 돌린다.
 * 주민번호·사업자번호·카드·계좌·이메일·긴 base64/hex 토큰·IPv4를 찾으면 true.
 */
export function looksSensitive(line: string): boolean {
  return [
    // 숫자 식별자는 영숫자 경계에서만(32자 hex 해시 안의 숫자 연속은 식별자가 아니다)
    /(?<![0-9A-Za-z])\d{6}-?[1-8]\d{6}(?![0-9A-Za-z])/,
    /(?<![0-9A-Za-z])\d{3}-?\d{2}-?\d{5}(?![0-9A-Za-z])/,
    /(?<![0-9A-Za-z])\d{4}[- ]?\d{4}[- ]?\d{4}[- ]?\d{4}(?![0-9A-Za-z])/,
    /[^\s@"]+@[^\s@"]+\.[a-z]{2,}/i,
    /(?<![A-Za-z0-9_-])[A-Za-z0-9_-]{40,}(?![A-Za-z0-9_-])/,
    /(?<!\d)(?:\d{1,3}\.){3}\d{1,3}(?!\d)/,
  ].some((re) => re.test(line));
}
