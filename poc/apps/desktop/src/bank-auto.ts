import type { NpkiCert } from './onboarding.ts';

export interface CodefNeeded {
  mode: 'codef';
  reqId: string;
  scope: 'business' | 'personal';
  field?: 'account';
}

export function parseCodefNeeded(d: unknown): CodefNeeded | null {
  const o = d as Record<string, unknown> | null;
  if (!o || typeof o !== 'object' || o.mode !== 'codef') return null;
  if (typeof o.reqId !== 'string' || !/^[0-9a-f]{32}$/.test(o.reqId)) return null;
  if (o.scope !== 'business' && o.scope !== 'personal') return null;
  return { mode: 'codef', reqId: o.reqId, scope: o.scope, ...(o.field === 'account' ? { field: 'account' as const } : {}) };
}

export const CODEF_WINDOW_TITLE = '금고 공동인증서 비밀번호(계좌 자동조회)';

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

export function codefPageHtml(req: CodefNeeded, ctx: { profileName: string; certLabel: string | null; bankName?: string | null }): string {
  return `<!doctype html><html lang="ko"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'self'; style-src 'self'">
<link rel="stylesheet" href="tokens.css"><link rel="stylesheet" href="bundle.css"><link rel="stylesheet" href="secret.css"><title>${esc(CODEF_WINDOW_TITLE)}</title></head>
<body data-req="${req.reqId}" data-scope="${req.scope}">
<p class="ctx">${esc(`계좌 자동조회 ${ctx.profileName}${ctx.certLabel ? `, ${ctx.certLabel}` : ''}`)}</p>
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

type BankAutoCert = Pick<NpkiCert, 'id' | 'owner' | 'usage' | 'expiresOn' | 'usable' | 'kind'> & { why?: string; issuance?: boolean };

interface BankAutoDeps {
  engine: (method: string, params: Record<string, unknown>) => Promise<unknown>;
  certs: () => Promise<NpkiCert[]>;
  preferredCertId?: () => string | null;
  log?: (name: string, data: Record<string, number | string>) => void;
}

export const CODEF_CONSENT_VERSION = 'codef-bank-auto-2026-11-12';

const safeCode = (c: unknown): string => (typeof c === 'string' && /^[a-z][a-z0-9_.:-]{0,47}$/.test(c) ? c : 'other');

const BANK_NAMES: Record<string, string> = { '0020': '우리은행', '0004': '국민은행', '0088': '신한은행', '0081': '하나은행', '0003': '기업은행', '0011': '농협은행' };

const BANKS = ['0020', '0004', '0088', '0081', '0003', '0011'] as const;

export function bankAutoHandlers(d: BankAutoDeps) {
  let chosen: BankAutoCert | null = null;
  let chosenBankCode = '0020';
  const eng = async (m: string, p: Record<string, unknown> = {}) => {
    try {
      const r = await d.engine(m, p);
      const f = r as { ok?: unknown; code?: unknown; cf?: unknown } | null;
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
    chosenLabel: (): string | null => (chosen ? `${chosen.owner}, ${chosen.usage}` : null),
    chosenBank: (): string | null => BANK_NAMES[chosenBankCode] ?? null,
    handlers: {
      'bankAuto.status': () => eng('codef.status'),
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
        const prefer = c.kind === 'corp' ? 'B' : c.kind === 'personal' ? 'P' : null;
        const withdraw = typeof p.withdrawAccount === 'string' ? p.withdrawAccount.replace(/\D/g, '') : '';
        return eng('codef.connect', { certId: c.id, bank, ...(p.clientType === 'P' || p.clientType === 'B' ? { clientType: p.clientType } : {}), ...(prefer ? { prefer } : {}), ...(/^\d{10,16}$/.test(withdraw) ? { withdrawAccount: withdraw } : {}) });
      },
      'bankAuto.choose': (p: { sessionId: string; key: string; alias?: string }) => eng('codef.choose', p),
      'bankAuto.sms': (p: { sessionId: string; code: string }) => eng('codef.sms', { sessionId: p.sessionId, code: p.code }),
      'bankAuto.refresh': () => eng('codef.refresh'),
      'bankAuto.cancel': () => eng('codef.cancel'),
      'bankAuto.disconnect': () => eng('codef.disconnect'),
    },
  };
}
