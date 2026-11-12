// CODEF 원천을 돈 맞추기 원천 인터페이스(bank/source.ts TxnSource, bank-mvp 확정 2026-11-12)에 꽂는 어댑터.
// 엔진 entry에서 `bank.registerSource(codefTxnSource(link))`로 꽂는다. 로그인 정보(인증서·connectedId)는 원천이 금고·CodefLink에서 갖는다.
// CODEF 응답에 거래 고유 id가 없어 sourceId는 null이다(파일과 같은 내용 줄 열쇠로 중복을 거른다).
import { SourceError, type SourceFetchResult, type SourceProgress, type SourceRow, type TxnSource } from '../bank/source.ts';
import { CodefError, type CodefFailure } from './codes.ts';
import type { CodefTxn } from './client.ts';
import type { CodefLink } from './link.ts';

/** CODEF 실패 갈래 → 원천 코드(화면 문구는 bank 화면이 이 코드로 고른다) */
export const CODEF_SOURCE_CODES: Record<CodefFailure, string> = {
  password_wrong: 'source.login_failed',
  password_locked: 'source.login_locked',
  password_retry_limit: 'source.login_locked',
  cert_expired: 'source.cert_expired',
  cert_not_registered: 'source.cert_not_registered',
  cert_kind: 'source.cert_kind',
  cert_missing: 'source.cert_missing',
  two_way_required: 'source.needs_user',
  account_password_required: 'source.needs_user',
  cancelled: 'source.cancelled',
  bank_error: 'source.bank_error',
  bank_busy: 'source.bank_busy',
  session_lost: 'source.not_linked',
  no_account: 'source.not_linked',
  bank_not_ready: 'source.not_linked',
  bank_consent_required: 'source.not_linked',
  daily_limit: 'source.rate_limited',
  too_soon: 'source.rate_limited',
  codef_off: 'source.unavailable',
  unavailable: 'source.unavailable',
  signed_out: 'source.unavailable',
  bad_response: 'source.rejected',
  rejected: 'source.rejected',
  busy: 'source.busy',
};

const clean = (s: string): string | null => {
  // eslint-disable-next-line no-control-regex -- 은행 원문의 제어 문자를 지운다
  const t = s.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  return t || null;
};

/** CODEF 거래 → 원천 행. 비고 칸은 resAccountDesc1~4 순서 그대로, 비고1(보낸분/받는분)은 payer로도 */
export function codefSourceRows(txns: CodefTxn[]): SourceRow[] {
  const out: SourceRow[] = [];
  for (const t of txns) {
    const m = /^(\d{4})(\d{2})(\d{2})$/.exec(t.date);
    const tm = /^(\d{2})(\d{2})(\d{2})?$/.exec(t.time || '000000');
    if (!m || !tm) continue;
    const remarks = [clean(t.desc1), clean(t.desc2), clean(t.desc3), clean(t.desc4)];
    out.push({
      sourceId: null,
      occurredAt: `${m[1]}-${m[2]}-${m[3]} ${tm[1]}:${tm[2]}:${tm[3] ?? '00'}`,
      deposit: t.in > 0 ? t.in : 0,
      withdrawal: t.out > 0 ? t.out : 0,
      balance: t.balance,
      remarks,
      memo: null,
      payer: remarks[0],
    });
  }
  return out;
}

export function codefTxnSource(link: CodefLink): TxnSource {
  return {
    kind: 'auto',
    provider: 'codef',
    async fetch(account, range, opts): Promise<SourceFetchResult> {
      const prog = (p: SourceProgress) => opts.onProgress?.(p);
      if (opts.signal?.aborted) throw new SourceError('source.cancelled');
      prog({ state: 'requested' });
      try {
        const r = await link.fetchForSource(account, range, (phase) => prog(phase === 'password' ? { state: 'waiting' } : { state: 'running' }));
        const rows = codefSourceRows(r.txns);
        prog({ state: 'done', rows: rows.length });
        return { rows, range: { from: r.from, to: r.to } };
      } catch (e) {
        const code = e instanceof CodefError ? CODEF_SOURCE_CODES[e.code] : 'source.unavailable';
        prog({ state: 'failed', code });
        throw new SourceError(code);
      }
    },
  };
}
