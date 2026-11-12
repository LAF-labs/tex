// 계좌 자동조회(CODEF 공동인증서 방식, 대표 결정 2026-11-12) main 쪽: 화면 요청 → 엔진 codef.*, 인증서 목록(금고 npki.list → 샌드박스 certInfo),
// 금고가 부르는 인증서 비밀번호 창(secret.needed{mode:'codef'}). main은 비밀번호·계좌번호·인증서 파일을 보지 않는다(창은 금고 직결 포트).
// Electron 없이 시험한다(창 생성·포트는 shell-app이 넘긴다).
import type { NpkiCert } from './onboarding.ts';

/** CODEF 비밀번호 창 결속(금고 protocol CodefBind와 같은 모양) */
export interface CodefNeeded {
  mode: 'codef';
  reqId: string;
  scope: 'business' | 'personal';
}

export function parseCodefNeeded(d: unknown): CodefNeeded | null {
  const o = d as Record<string, unknown> | null;
  if (!o || typeof o !== 'object' || o.mode !== 'codef') return null;
  if (typeof o.reqId !== 'string' || !/^[0-9a-f]{32}$/.test(o.reqId)) return null;
  if (o.scope !== 'business' && o.scope !== 'personal') return null;
  return { mode: 'codef', reqId: o.reqId, scope: o.scope };
}

export const CODEF_WINDOW_TITLE = '금고 · 공동인증서 비밀번호(계좌 자동조회)';

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/** 비밀번호 창 페이지(main이 만든다). reqId·scope는 금고 결속값 그대로. 문구는 동의 화면과 같은 사실만 */
export function codefPageHtml(req: CodefNeeded, ctx: { profileName: string; certLabel: string | null }): string {
  return `<!doctype html><html lang="ko"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'self'; style-src 'self'">
<link rel="stylesheet" href="tokens.css"><link rel="stylesheet" href="bundle.css"><link rel="stylesheet" href="secret.css"><title>${esc(CODEF_WINDOW_TITLE)}</title></head>
<body data-req="${req.reqId}" data-scope="${req.scope}">
<p class="ctx">${esc(`계좌 자동조회 · ${ctx.profileName}${ctx.certLabel ? ` · ${ctx.certLabel}` : ''}`)}</p>
<form id="f"><label for="v">공동인증서 비밀번호</label><input id="v" type="password" autocomplete="off" spellcheck="false" autofocus>
<label class="set-check"><input id="remember" type="checkbox"><span>이 PC에 기억(다음 [최신화]부터 묻지 않아요)</span></label>
<button>금고에 넘기기</button></form>
<p class="note">이 창의 입력은 금고로 바로 가요. 금고가 CODEF 공개키로 감싸 인증서와 함께 CODEF로 보내고, 조회가 끝나면 CODEF에서 지워요.</p>
<p class="note">앱은 대화창 안에서 비밀번호를 묻지 않아요.</p>
<p id="msg" role="status"></p><script src="codef-secret.js"></script></body></html>`;
}

/** 화면에 보이는 인증서 행(이름·용도·만료일만, 경로·주체 전체 없음) */
export type BankAutoCert = Pick<NpkiCert, 'id' | 'owner' | 'usage' | 'expiresOn' | 'usable'> & { why?: string; issuance?: boolean };

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

const BANKS = ['0020', '0004', '0088', '0081', '0003', '0011'] as const;

/** 셸 처리기(ipc SHELL_METHODS 'bankAuto.*'). 결과는 엔진의 {ok, …} 그대로(값 없음) */
export function bankAutoHandlers(d: BankAutoDeps) {
  /** 어느 인증서를 골랐는지(비밀번호 창 문구용, 이름·만료일만) */
  let chosen: BankAutoCert | null = null;
  const eng = (m: string, p: Record<string, unknown> = {}) => d.engine(m, p);
  /** 돈 맞추기 연결 상태(bank-mvp bank.setLink, main 전용). 아직 없는 엔진이면 조용히 넘긴다 */
  const setLink = async (st: { profileId?: unknown; accountId?: unknown }, state: 'file_only' | 'auto_connected' | 'auto_error', error?: string) => {
    if (typeof st.profileId !== 'string' || typeof st.accountId !== 'string') return;
    await eng('bank.setLink', { profileId: st.profileId, accountId: st.accountId, provider: 'codef', state, ...(error ? { error } : {}) }).catch(() => d.log?.('main.bank_auto_setlink_skipped', {}));
  };
  const ordered = async (): Promise<BankAutoCert[]> => {
    const pref = d.preferredCertId?.() ?? null;
    const list = (await d.certs()).map((c) => ({ ...c, ...(c.id === pref ? { issuance: true } : {}) }));
    return [...list.filter((c) => c.issuance), ...list.filter((c) => !c.issuance)];
  };
  return {
    chosenLabel: (): string | null => (chosen ? `${chosen.owner} · ${chosen.usage}` : null),
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
      'bankAuto.connect': async (p: { certId: string; bank?: string; clientType?: 'B' | 'P' }) => {
        const list = await d.certs();
        const c = list.find((x) => x.id === p.certId);
        if (!c || !c.usable) return { ok: false, code: 'cert_missing' };
        chosen = c;
        const bank = p.bank && (BANKS as readonly string[]).includes(p.bank) ? p.bank : '0020';
        return eng('codef.connect', { certId: c.id, bank, clientType: p.clientType === 'P' ? 'P' : 'B' });
      },
      'bankAuto.choose': async (p: { sessionId: string; key: string; alias?: string }) => {
        const r = (await eng('codef.choose', p)) as Record<string, unknown>;
        if (r?.ok) await setLink(r, 'auto_connected');
        return r;
      },
      'bankAuto.refresh': async (p: { ask?: boolean }) => {
        const r = (await eng('codef.refresh', p.ask ? { ask: true } : {})) as Record<string, unknown>;
        // 잠깐 막힌 것(too_soon·daily_limit·취소)은 연결 오류로 치지 않는다
        if (r && !r.ok && !['too_soon', 'daily_limit', 'cancelled', 'busy'].includes(String(r.code))) await setLink((await eng('codef.status')) as Record<string, unknown>, 'auto_error', `codef.${String(r.code)}`);
        else if (r?.ok) await setLink((await eng('codef.status')) as Record<string, unknown>, 'auto_connected');
        return r;
      },
      'bankAuto.cancel': () => eng('codef.cancel'),
      'bankAuto.disconnect': async () => {
        const st = (await eng('codef.status')) as Record<string, unknown>;
        const r = (await eng('codef.disconnect')) as Record<string, unknown>;
        if (r?.ok) await setLink(st, 'file_only');
        return r;
      },
    },
  };
}
