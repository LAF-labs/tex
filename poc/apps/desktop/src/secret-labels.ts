// 금고가 부르는 비밀 입력 창(ADR-025 결정 10, N-44·N-11 PoC 부분). 창 개시 판정·라벨·페이지는 main 내장 표에서만 고른다.
// 렌더러는 창을 열 수 없고 라벨 문자열을 넘기지 못한다. Electron 없이 시험한다(창 생성은 secret-window.ts).

export type SecretKind = 'cert_password' | 'portal_password' | 'security_card';
export type SecretScope = 'business' | 'personal';

/** @sax/vault의 SecretInputBind(I-1)와 같은 모양. main → 금고 secretInput 포트에 붙인다. */
export interface SecretInputBind {
  runId: string;
  kind: SecretKind;
  scope: SecretScope;
  row?: number;
}

/** 금고의 secret.needed(I-2) 데이터. */
export interface SecretNeeded extends SecretInputBind {
  targetId: string;
}

export const SECRET_LABELS: Record<SecretKind, string> = {
  cert_password: '공동인증서 비밀번호',
  portal_password: '홈택스 비밀번호',
  security_card: '보안카드 번호',
};

/** 창 아래 고정 문구(위장 창과 구별하는 단서는 OS 제목줄이다). */
export const SECRET_FIXED_NOTE = '앱은 대화창 안에서 비밀번호·카드 번호를 묻지 않아요.';

const isKind = (k: unknown): k is SecretKind => typeof k === 'string' && Object.hasOwn(SECRET_LABELS, k);

/** OS 제목줄 문구. 표에 없는 종류는 던진다. */
export function secretTitle(kind: string): string {
  if (!isKind(kind)) throw new Error('unknown_secret_kind');
  return `금고 · ${SECRET_LABELS[kind]}`;
}

/** secret.needed 데이터 모양 검사. 하나라도 어긋나면 null(창을 열지 않는다). */
export function parseSecretNeeded(d: unknown): SecretNeeded | null {
  if (!d || typeof d !== 'object') return null;
  const o = d as Record<string, unknown>;
  if (typeof o.runId !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(o.runId)) return null;
  if (typeof o.targetId !== 'string' || !o.targetId || o.targetId.length > 128) return null;
  if (!isKind(o.kind)) return null;
  if (o.scope !== 'business' && o.scope !== 'personal') return null;
  if (o.row !== undefined && !(Number.isInteger(o.row) && (o.row as number) >= 1 && (o.row as number) <= 35)) return null;
  return { runId: o.runId, targetId: o.targetId, kind: o.kind, scope: o.scope, ...(o.row !== undefined ? { row: o.row as number } : {}) };
}

/**
 * 비밀 창은 동시에 하나, 활성 실행의 요청만 연다. 창이 열려 있을 때 온 요청(다음 보안카드 칸 등)은 마지막 하나를 들고
 * 있다가 창이 닫히면 넘긴다(창은 금고가 받은 뒤 잠시 있다 닫힌다).
 */
export class SecretWindowCoordinator {
  private current: SecretNeeded | null = null;
  private next: SecretNeeded | null = null;
  private readonly isActiveRun: (runId: string) => boolean;

  constructor(isActiveRun: (runId: string) => boolean) {
    this.isActiveRun = isActiveRun;
  }

  /** 열어도 되면 그 요청(이때부터 열린 것으로 친다), 아니면 null. */
  request(data: unknown): SecretNeeded | null {
    const r = parseSecretNeeded(data);
    if (!r || !this.isActiveRun(r.runId)) return null;
    if (this.current) {
      this.next = r;
      return null;
    }
    this.current = r;
    return r;
  }

  get open(): SecretNeeded | null {
    return this.current;
  }

  /** 창이 닫혔다. 그동안 들고 있던 요청이 있으면 돌려준다(다시 request로 연다). */
  closed(): SecretNeeded | null {
    this.current = null;
    const n = this.next;
    this.next = null;
    return n;
  }
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/** 보기 버튼 아이콘: 눈(가림)·빗금 눈(보임). 어느 쪽을 보일지는 secret.css가 aria-pressed로 고른다. */
const EYE_PATH = '<path d="M1.5 8s2.5-4.5 6.5-4.5S14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8z"></path><circle cx="8" cy="8" r="2"></circle>';
const EYE = `<svg class="eye" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">${EYE_PATH}</svg><svg class="eye-off" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">${EYE_PATH}<path d="M2.5 2.5l11 11"></path></svg>`;

/** 비밀 창 페이지(main이 만든다). 값은 이스케이프한 텍스트로만. kind·scope·row는 금고 결속값과 같은 값만 싣는다. */
export function secretPageHtml(req: SecretInputBind, profileName: string): string {
  const label = SECRET_LABELS[req.kind];
  const field = req.kind === 'security_card' && req.row ? `${label} ${req.row}번` : label;
  // 보안카드 번호는 SecretField 규칙대로 기본으로 가리고, 보기 버튼 하나로 보이게 한다(secret.js가 30초 뒤 다시 가린다).
  const head = req.kind === 'security_card' ? `<div class="sx-secret-hd"><label for="v">${esc(field)}</label><span id="reveal-note" class="sx-meta"></span><button type="button" id="reveal" class="sx-reveal" aria-pressed="false">${EYE}<span>번호 보기</span></button></div>` : `<label for="v">${esc(field)}</label>`;
  return `<!doctype html><html lang="ko"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'self'; style-src 'self'">
<link rel="stylesheet" href="tokens.css"><link rel="stylesheet" href="bundle.css"><link rel="stylesheet" href="secret.css"><title>${esc(secretTitle(req.kind))}</title></head>
<body data-kind="${req.kind}" data-scope="${req.scope}"${req.row ? ` data-row="${req.row}"` : ''}>
<p class="ctx">${esc(`세금계산서 발급 · 홈택스 · ${profileName}`)}</p>
<form id="f">${head}<input id="v" type="password" autocomplete="off" spellcheck="false" autofocus><button>금고에 넘기기</button></form>
<p class="note">이 창의 입력은 금고로 바로 가요. 저장하지 않고 이번 실행에서 한 번만 써요.</p>
<p class="note">${esc(SECRET_FIXED_NOTE)}</p>
<p id="msg" role="status"></p><script src="secret.js"></script></body></html>`;
}
