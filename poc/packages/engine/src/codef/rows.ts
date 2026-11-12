// CODEF 거래 → 돈 맞추기 입출금 줄(09 §9.1, bank-mvp TxnInput 모양). 판정·맞추기는 하지 않는다.
// 줄 열쇠(rowKey): CODEF는 거래 고유 번호를 주지 않는다. 계좌 안에서 (일시·방향·금액·거래 후 잔액·적요들)과 같은 값 순번으로 만든다.
// 같은 날짜를 겹쳐 다시 가져와도 같은 줄은 같은 열쇠가 되어 한 번만 들어간다(저장소 UNIQUE(account, row_key)).
// 적요 칸 해석(추정, 실제 응답으로 확인 필요): desc1 보낸분/받는분, desc2 거래구분·메모, desc3 적요(은행에 따라 기재내용), desc4 거래점.
import { createHash } from 'node:crypto';
import type { CodefTxn } from './client.ts';

export interface AutoTxnRow {
  rowKey: string;
  /** 'YYYY-MM-DD HH:MM:SS' */
  occurredAt: string;
  day: string;
  direction: 'in' | 'out';
  amount: number;
  balance: number | null;
  payer: string | null;
  memo: string | null;
  counterAccount: string | null;
}

// eslint-disable-next-line no-control-regex -- 은행 원문의 제어 문자를 지운다
const clean = (s: string): string => s.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();

/** 한 번에 받은 거래 묶음 → 줄. 모양이 틀린 줄(날짜·금액)은 건너뛰고 개수만 센다 */
export function codefRows(txns: CodefTxn[]): { rows: AutoTxnRow[]; skipped: number } {
  const rows: AutoTxnRow[] = [];
  let skipped = 0;
  const seen = new Map<string, number>();
  const ordered = txns
    .map((t, i) => ({ t, i }))
    .sort((a, b) => (a.t.date + a.t.time).localeCompare(b.t.date + b.t.time) || a.i - b.i);
  for (const { t } of ordered) {
    const m = /^(\d{4})(\d{2})(\d{2})$/.exec(t.date);
    const tm = /^(\d{2})(\d{2})(\d{2})?$/.exec(t.time || '000000');
    const inAmt = t.in > 0 ? t.in : 0;
    const outAmt = t.out > 0 ? t.out : 0;
    if (!m || !tm || (inAmt > 0) === (outAmt > 0)) {
      skipped++;
      continue;
    }
    const day = `${m[1]}-${m[2]}-${m[3]}`;
    const occurredAt = `${day} ${tm[1]}:${tm[2]}:${tm[3] ?? '00'}`;
    const direction = inAmt > 0 ? 'in' : 'out';
    const amount = inAmt || outAmt;
    const d1 = clean(t.desc1);
    const d2 = clean(t.desc2);
    const d3 = clean(t.desc3);
    const payer = d1 || d3 || null;
    const memo = [d2, d1 ? d3 : ''].filter(Boolean).join(' ') || null;
    const base = [occurredAt, direction, amount, t.balance ?? '', d1, d2, d3].join('\u001f');
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    const rowKey = `codef:${createHash('sha256').update(`${base}\u001f${n}`).digest('hex').slice(0, 32)}`;
    rows.push({ rowKey, occurredAt, day, direction, amount, balance: t.balance, payer, memo, counterAccount: t.counterAccount || null });
  }
  return { rows, skipped };
}
