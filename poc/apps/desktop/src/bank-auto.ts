// 계좌 자동조회(CODEF 공동인증서 방식, 대표 결정 2026-11-12) main 쪽: 화면 요청 → 엔진 codef.*, 인증서 목록(금고 npki.list → 샌드박스 certInfo),
// 금고가 부르는 인증서 비밀번호 창(secret.needed{mode:'codef'}). main은 비밀번호·계좌번호·인증서 파일을 보지 않는다(창은 금고 직결 포트).
// Electron 없이 시험한다(창 생성·포트는 shell-app이 넘긴다).
import type { NpkiCert } from './onboarding.ts';

/** CODEF 비밀번호 창 결속(금고 protocol CodefBind와 같은 모양) */
export interface CodefNeeded {
  mode: 'codef';
  reqId: string;
  scope: 'business' | 'personal';
  /** 'account' = 출금계좌 비밀번호 4자리(일부 은행 개인 뱅킹). 없으면 인증서 비밀번호 */
  field?: 'account';
}

export function parseCodefNeeded(d: unknown): CodefNeeded | null {
  const o = d as Record<string, unknown> | null;
  if (!o || typeof o !== 'object' || o.mode !== 'codef') return null;
  if (typeof o.reqId !== 'string' || !/^[0-9a-f]{32}$/.test(o.reqId)) return null;
  if (o.scope !== 'business' && o.scope !== 'personal') return null;
  return { mode: 'codef', reqId: o.reqId, scope: o.scope, ...(o.field === 'account' ? { field: 'account' as const } : {}) };
}

export const CODEF_WINDOW_TITLE = '금고 · 공동인증서 비밀번호(계좌 자동조회)';

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/** 비밀번호 창 페이지(main이 만든다). reqId·scope는 금고 결속값 그대로. 문구는 동의 화면과 같은 사실만 */
export function codefPageHtml(req: CodefNeeded, ctx: { profileName: string; certLabel: string | null; bankName?: string | null }): string {
  return `<!doctype html><html lang="ko"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'self'; style-src 'self'">
<link rel="stylesheet" href="tokens.css"><link rel="stylesheet" href="bundle.css"><link rel="stylesheet" href="secret.css"><title>${esc(CODEF_WINDOW_TITLE)}</title></head>
<body data-req="${req.reqId}" data-scope="${req.scope}">
<p class="ctx">${esc(`계좌 자동조회 · ${ctx.profileName}${ctx.certLabel ? ` · ${ctx.certLabel}` : ''}`)}</p>
${
    req.field === 'account'
      ? `<form id="f"><label for="v">${esc(ctx.bankName ?? '은행')} 출금계좌 비밀번호 4자리</label><input id="v" type="password" inputmode="numeric" maxlength="4" autocomplete="off" spellcheck="false" autofocus>
<label class="set-check"><input id="remember" type="checkbox"><span>이 PC에 기억(다음 [최신화]부터 묻지 않아요)</span></label>
<button>금고에 넘기기</button></form>
<p class="note">${esc(ctx.bankName ?? '은행')}이 이 인증서로 조회할 때 계좌 비밀번호를 함께 확인해요. 이 창의 입력은 금고로 바로 가고, 금고가 CODEF 공개키로 감싸 보내요.</p>`
      : `<form id="f"><label for="v">공동인증서 비밀번호</label><input id="v" type="password" autocomplete="off" spellcheck="false" autofocus>
<label class="set-check"><input id="remember" type="checkbox"><span>이 PC에 기억(다음 [최신화]부터 묻지 않아요)</span></label>
<button>금고에 넘기기</button></form>
<p class="note">이 창의 입력은 금고로 바로 가요. 금고가 CODEF 공개키로 감싸 인증서와 함께 CODEF로 보내고, 조회가 끝나면 CODEF에서 지워요.</p>`
  }
<p class="note">앱은 대화창 안에서 비밀번호를 묻지 않아요.</p>
<p id="msg" role="status"></p><script src="codef-secret.js"></script></body></html>`;
}

/** 화면에 보이는 인증서 행(이름·용도·만료일만, 경로·주체 전체 없음) */
export type BankAutoCert = Pick<NpkiCert, 'id' | 'owner' | 'usage' | 'expiresOn' | 'usable' | 'kind'> & { why?: string; issuance?: boolean };

export interface BankAutoDeps {
  /** 엔진 RPC(codef.*) */
  engine: (method: string, params: Record<string, unknown>) => Promise<unknown>;
  certs: () => Promise<NpkiCert[]>;
  /** 홈택스 발급에 쓰는 인증서(온보딩 O-03에서 고른 것). 목록 맨 앞에 보이고 미리 골라 둔다(09 §4.5) */
  preferredCertId?: () => string | null;
  log?: (name: string, data: Record<string, number | string>) => void;
}

/** 동의 카드 문구 판(shell-bank-auto.js CONSENT_VERSION과 같다). 문구를 바꾸면 올린다 */
export const CODEF_CONSENT_VERSION = 'codef-bank-auto-2026-11-12';

/** 로그에 넣어도 되는 짧은 코드만(그 밖은 'other') */
const safeCode = (c: unknown): string => (typeof c === 'string' && /^[a-z][a-z0-9_.:-]{0,47}$/.test(c) ? c : 'other');

const BANK_NAMES: Record<string, string> = { '0020': '우리은행', '0004': '국민은행', '0088': '신한은행', '0081': '하나은행', '0003': '기업은행', '0011': '농협은행' };

const BANKS = ['0020', '0004', '0088', '0081', '0003', '0011'] as const;

/** 셸 처리기(ipc SHELL_METHODS 'bankAuto.*'). 결과는 엔진의 {ok, …} 그대로(값 없음) */
export function bankAutoHandlers(d: BankAutoDeps) {
  /** 어느 인증서를 골랐는지(비밀번호 창 문구용, 이름·만료일만) */
  let chosen: BankAutoCert | null = null;
  let chosenBankCode = '0020';
  // 실패는 원인이 로그에 남아야 한다(working-notes 1.4): 화면은 던져진 오류를 '연결이 안 돼요' 하나로 뭉친다.
  // 엔진이 {ok:false, code}로 돌려준 실패와 던진 오류를 단계(메서드)와 코드로 남긴다. 값(계좌·비밀번호·인증서)은 엔진이 결과에 넣지 않는다.
  const eng = async (m: string, p: Record<string, unknown> = {}) => {
    try {
      const r = await d.engine(m, p);
      const f = r as { ok?: unknown; code?: unknown; cf?: unknown } | null;
      // 은행 코드(4자리 기관 코드, 값 아님)도 남긴다: 거래하지 않는 은행을 고른 채 연결했는지 가를 수 있게
      if (f && f.ok === false) d.log?.('main.bank_auto', { step: m, result: safeCode(f.code), ...(typeof f.cf === 'string' && /^CF-\d{5}$/.test(f.cf) ? { cf: f.cf } : {}), ...(typeof p.bank === 'string' && /^\d{4}$/.test(p.bank) ? { bank: p.bank } : {}) });
      return r;
    } catch (e) {
      d.log?.('main.bank_auto', { step: m, result: 'threw', why: safeCode((e as { code?: unknown } | null)?.code ?? (e as Error | null)?.message) });
      throw e;
    }
  };
  const ordered = async (): Promise<BankAutoCert[]> => {
    const pref = d.preferredCertId?.() ?? null;
    const list = (await d.certs()).map((c) => ({ ...c, ...(c.id === pref ? { issuance: true } : {}) }));
    return [...list.filter((c) => c.issuance), ...list.filter((c) => !c.issuance)];
  };
  return {
    chosenLabel: (): string | null => (chosen ? `${chosen.owner} · ${chosen.usage}` : null),
    chosenBank: (): string | null => BANK_NAMES[chosenBankCode] ?? null,
    handlers: {
      'bankAuto.status': () => eng('codef.status'),
      // 동의 카드(09 §4.6·§9.4): 우리 회사 개인정보 수집·이용 동의 + (주)헥토데이터(CODEF) 처리 위탁 안내 + 인증서 보관 고지. 기록은 PC DB에만
      'bankAuto.consent': async (p: { version: string }) => {
        if (p.version !== CODEF_CONSENT_VERSION) return { ok: false, code: 'consent_stale' };
        await eng('consent.record', { profileId: null, kind: 'delegation', noticeKey: 'codef.bank_auto', noticeVersion: CODEF_CONSENT_VERSION, choice: 'agreed', at: new Date().toISOString(), via: 'settings' });
        return { ok: true };
      },
      'bankAuto.certs': async () => {
        const list = await ordered();
        d.log?.('main.bank_auto_certs', { shown: list.length });
        return { certs: list.map((c) => ({ id: c.id, owner: c.owner, usage: c.usage, expiresOn: c.expiresOn, usable: c.usable, ...(c.why ? { why: c.why } : {}), ...(c.issuance ? { issuance: true } : {}) })) };
      },
      'bankAuto.connect': async (p: { certId: string; bank?: string; clientType?: 'B' | 'P'; withdrawAccount?: string }) => {
        const list = await d.certs();
        const c = list.find((x) => x.id === p.certId);
        if (!c || !c.usable) {
          d.log?.('main.bank_auto', { step: 'connect', result: 'cert_missing', certs: list.length });
          return { ok: false, code: 'cert_missing' };
        }
        chosen = c;
        const bank = p.bank && (BANKS as readonly string[]).includes(p.bank) ? p.bank : '0020';
        chosenBankCode = bank;
        // 계좌 종류를 고르지 않으면 엔진이 같은 인증서로 기업·개인 뱅킹을 차례로 해 본다
        // 순서는 고객 데이터로 정한다(대표 2026-11-19 "모든 고객을 상정해야지"): 법인·사업자용 인증서면 기업 뱅킹 먼저, 개인용이면 개인 먼저.
        // 사업장이 법인이면 엔진이 기업 뱅킹만 한다
        const prefer = c.kind === 'corp' ? 'B' : c.kind === 'personal' ? 'P' : null;
        // 은행이 출금계좌번호를 요구했을 때 사람이 넣은 그 은행 계좌번호(숫자만). 로그에는 남기지 않는다
        const withdraw = typeof p.withdrawAccount === 'string' ? p.withdrawAccount.replace(/\D/g, '') : '';
        return eng('codef.connect', { certId: c.id, bank, ...(p.clientType === 'P' || p.clientType === 'B' ? { clientType: p.clientType } : {}), ...(prefer ? { prefer } : {}), ...(/^\d{10,16}$/.test(withdraw) ? { withdrawAccount: withdraw } : {}) });
      },
      // 돈 맞추기 계좌 잇기·연결 상태·최신화는 엔진(CodefLink → BankService)이 한다
      'bankAuto.choose': (p: { sessionId: string; key: string; alias?: string }) => eng('codef.choose', p),
      // 은행이 보낸 SMS 인증번호(CODEF 추가 인증). main은 넘기기만 하고 저장·로그하지 않는다(로그는 단계·결과 코드만)
      'bankAuto.sms': (p: { sessionId: string; code: string }) => eng('codef.sms', { sessionId: p.sessionId, code: p.code }),
      'bankAuto.refresh': () => eng('codef.refresh'),
      'bankAuto.cancel': () => eng('codef.cancel'),
      'bankAuto.disconnect': () => eng('codef.disconnect'),
    },
  };
}
