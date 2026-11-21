import { normalizePayerName } from '@sax/db';

export type Strength = 3 | 2 | 1;
export type NameSignal = 'cp_account' | 'alias' | 'holder' | 'assigned' | 'name' | 'rep' | 'prefix';
export type AmountFit = 'exact' | 'fee' | 'sum' | 'partial' | 'over';

const STRENGTH: Record<NameSignal, Strength> = { cp_account: 3, alias: 3, holder: 3, assigned: 3, name: 2, rep: 2, prefix: 1 };

export interface MatchCounterparty {
  key: string;
  name: string | null;
  rep: string | null;
  aliases: string[];
  holders: string[];
  accountHmacs: string[];
  humanConfirmed: boolean;
}

export interface MatchReceivable {
  id: string;
  cpKey: string;
  writtenOn: string;
  dueOn: string | null;
  remaining: number;
}

export interface MatchTxn {
  id: string;
  day: string;
  amount: number;
  unallocated: number;
  payer: string | null;
  counterAccountHmac: string | null;
  assignedCpKey: string | null;
}

export interface Candidate {
  receivableIds: string[];
  cpKey: string;
  fit: AmountFit;
  signal: NameSignal | null;
  strength: Strength | 0;
  amounts: number[];
  feeGap: number;
  reason: string;
}

export interface MatchInput {
  counterparties: MatchCounterparty[];
  receivables: MatchReceivable[];
  txns: MatchTxn[];
  rejects: Set<string>;
  feeTolerance?: number;
  side?: Side;
}

export interface AutoMatch {
  txnId: string;
  receivableId: string;
  amount: number;
  signal: NameSignal;
}

export interface MatchResult {
  auto: AutoMatch[];
  candidates: Map<string, Candidate[]>;
}

export const FEE_TOLERANCE = 1000;
const SUM_MAX_RECEIVABLES = 10;

export const addDays = (iso: string, d: number) => new Date(Date.parse(`${iso}T00:00:00Z`) + d * 86_400_000).toISOString().slice(0, 10);

function inWindow(r: MatchReceivable, day: string): boolean {
  return day >= addDays(r.writtenOn, -30) && day <= addDays(r.dueOn ?? r.writtenOn, 90);
}

const won = (n: number) => `${n.toLocaleString('ko-KR')}원`;

export type Side = 'in' | 'out';

const SIGNAL_TEXT_OUT: Record<NameSignal, string> = {
  cp_account: '등록한 거래처 계좌로 보낸 돈이에요',
  alias: '기억해 둔 받는 분 이름이에요',
  holder: '받는 분이 거래처 계좌 예금주예요',
  assigned: '이 거래처 출금으로 정하셨어요',
  name: '받는 분 이름이 상호와 같아요',
  rep: '받는 분 이름이 대표자 이름과 같아요',
  prefix: '받는 분 이름이 상호 앞부분과 같아요(잘린 이름일 수 있어요)',
};

const SIGNAL_TEXT: Record<NameSignal, string> = {
  cp_account: '등록한 거래처 계좌에서 온 돈이에요',
  alias: '기억해 둔 입금자 이름이에요',
  holder: '거래처 계좌 예금주 이름이에요',
  assigned: '이 거래처 입금으로 정하셨어요',
  name: '입금자 이름이 상호와 같아요',
  rep: '입금자 이름이 대표자 이름과 같아요',
  prefix: '입금자 이름이 상호 앞부분과 같아요(잘린 이름일 수 있어요)',
};

interface CpIndex {
  cp: MatchCounterparty;
  nameNorm: string;
  repNorm: string;
  aliasSet: Set<string>;
  holderSet: Set<string>;
  acctSet: Set<string>;
}

function indexCps(list: MatchCounterparty[]): Map<string, CpIndex> {
  const m = new Map<string, CpIndex>();
  for (const cp of list)
    m.set(cp.key, { cp, nameNorm: normalizePayerName(cp.name), repNorm: normalizePayerName(cp.rep), aliasSet: new Set(cp.aliases), holderSet: new Set(cp.holders), acctSet: new Set(cp.accountHmacs) });
  return m;
}

/** 줄 하나에 대해 거래처별 가장 센 이름 신호 */
export function nameSignals(txn: MatchTxn, cps: Map<string, CpIndex>): Map<string, NameSignal> {
  const p = normalizePayerName(txn.payer);
  const out = new Map<string, NameSignal>();
  const put = (key: string, s: NameSignal) => {
    const cur = out.get(key);
    if (!cur || STRENGTH[s] > STRENGTH[cur]) out.set(key, s);
  };
  if (txn.assignedCpKey && cps.has(txn.assignedCpKey)) put(txn.assignedCpKey, 'assigned');
  for (const [key, c] of cps) {
    if (txn.counterAccountHmac && c.acctSet.has(txn.counterAccountHmac)) put(key, 'cp_account');
    if (!p || p.length < 2) continue;
    if (c.aliasSet.has(p)) put(key, 'alias');
    if (c.holderSet.has(p)) put(key, 'holder');
    if (c.nameNorm && c.nameNorm === p) put(key, 'name');
    if (c.repNorm && c.repNorm === p) put(key, 'rep');
    if (p.length >= 3) {
      const prefixOf = (x: string) => x.length > p.length && x.startsWith(p);
      if (prefixOf(c.nameNorm) || [...c.aliasSet].some(prefixOf) || [...c.holderSet].some(prefixOf)) put(key, 'prefix');
    }
  }
  return out;
}

function sumRuns(list: MatchReceivable[], amount: number): MatchReceivable[][] {
  if (list.length < 2 || list.length > SUM_MAX_RECEIVABLES) return [];
  const out: MatchReceivable[][] = [];
  for (let i = 0; i < list.length; i++) {
    let s = 0;
    for (let j = i; j < list.length; j++) {
      s += list[j]!.remaining;
      if (s > amount) break;
      if (s === amount && j > i) out.push(list.slice(i, j + 1));
    }
  }
  return out;
}

const FIT_RANK: Record<AmountFit, number> = { exact: 5, fee: 4, sum: 3, partial: 2, over: 1 };

/** 줄 하나의 후보(사람이 뗀 짝 제외). 앞이 가장 그럴듯함 */
export function candidatesFor(txn: MatchTxn, receivables: MatchReceivable[], cps: Map<string, CpIndex>, rejects: Set<string>, tol = FEE_TOLERANCE, side: Side = 'in'): Candidate[] {
  const amt = txn.unallocated;
  const isOut = side === 'out';
  const texts = isOut ? SIGNAL_TEXT_OUT : SIGNAL_TEXT;
  const who = isOut ? '받는 분' : '입금자';
  if (amt <= 0) return [];
  const sig = nameSignals(txn, cps);
  const open = receivables.filter((r) => r.remaining > 0 && inWindow(r, txn.day) && !rejects.has(`${r.id}|${txn.id}`));
  const byCp = new Map<string, MatchReceivable[]>();
  for (const r of open) byCp.set(r.cpKey, [...(byCp.get(r.cpKey) ?? []), r]);
  const out: Candidate[] = [];
  const exactAll = open.filter((r) => r.remaining === amt);
  for (const [key, list] of byCp) {
    const s = sig.get(key) ?? null;
    const st: Strength | 0 = s ? STRENGTH[s] : 0;
    const exact = list.filter((r) => r.remaining === amt);
    const why = s ? texts[s] : null;
    for (const r of exact) {
      if (st >= 1) out.push({ receivableIds: [r.id], cpKey: key, fit: 'exact', signal: s, strength: st, amounts: [amt], feeGap: 0, reason: `금액이 같고 ${why}` });
      else if (exactAll.length === 1) out.push({ receivableIds: [r.id], cpKey: key, fit: 'exact', signal: null, strength: 0, amounts: [amt], feeGap: 0, reason: txn.payer ? `금액은 같고 ${who} '${txn.payer}'는 처음 보는 이름이에요` : `금액은 같고 ${who} 이름이 없어요` });
      else out.push({ receivableIds: [r.id], cpKey: key, fit: 'exact', signal: null, strength: 0, amounts: [amt], feeGap: 0, reason: '금액이 같은 건이 여러 개예요. 작성일이 이른 건부터 보여 드려요' });
    }
    if (exact.length || st < 2) continue;
    for (const r of list) {
      const gap = r.remaining - amt;
      if (gap > 0 && gap <= tol) out.push({ receivableIds: [r.id], cpKey: key, fit: 'fee', signal: s, strength: st, amounts: [amt], feeGap: gap, reason: `수수료 ${won(gap)}을 빼고 받은 것 같아요. ${why}` });
      else if (gap > tol) out.push({ receivableIds: [r.id], cpKey: key, fit: 'partial', signal: s, strength: st, amounts: [amt], feeGap: 0, reason: `일부 ${isOut ? '냄' : '받음'} ${won(amt)}, 남은 ${won(gap)}, ${why}` });
      else if (gap < 0) out.push({ receivableIds: [r.id], cpKey: key, fit: 'over', signal: s, strength: st, amounts: [r.remaining], feeGap: 0, reason: `남은 돈보다 ${won(-gap)} 많아요(${isOut ? '여러 건을 한 번에 냈거나 미리 낸 돈일 수 있어요' : '여러 건을 한 번에 보냈거나 먼저 보낸 돈일 수 있어요'}), ${why}` });
    }
    for (const run of sumRuns([...list].sort((a, b) => (a.writtenOn < b.writtenOn ? -1 : a.writtenOn > b.writtenOn ? 1 : 0)), amt))
      out.push({ receivableIds: run.map((r) => r.id), cpKey: key, fit: 'sum', signal: s, strength: st, amounts: run.map((r) => r.remaining), feeGap: 0, reason: `${run.length}건을 한 번에 ${isOut ? '낸' : '보낸'} 것 같아요. ${why}` });
  }
  const first = (c: Candidate) => open.find((r) => r.id === c.receivableIds[0])!.writtenOn;
  out.sort((a, b) => b.strength - a.strength || FIT_RANK[b.fit] - FIT_RANK[a.fit] || (first(a) < first(b) ? -1 : first(a) > first(b) ? 1 : 0) || (a.receivableIds[0]! < b.receivableIds[0]! ? -1 : 1));
  return out.slice(0, 3);
}

/** 자동 확정할 수 있으면 그 후보(§6.3 1~6) */
export function autoOf(txn: MatchTxn, all: Candidate[], cps: Map<string, CpIndex>): Candidate | null {
  const exact = all.filter((c) => c.fit === 'exact');
  if (exact.length !== 1) return null;
  const c = exact[0]!;
  if (c.strength !== 3 || !c.signal) return null;
  const strongCps = [...nameSignals(txn, cps)].filter(([, s]) => STRENGTH[s] === 3).map(([k]) => k);
  if (strongCps.length !== 1 || strongCps[0] !== c.cpKey) return null;
  if (!cps.get(c.cpKey)?.cp.humanConfirmed) return null;
  return c;
}

/**
 * 맞추기 한 번. 줄을 거래일 순서로 보며 자동 확정을 먼저 적용하고(남은 돈을 줄인다), 그 상태에서 남은 줄의 후보를 낸다.
 * 이미 사람이 붙이거나 표시한 것은 입력에서 빠져 있다(unallocated·remaining에 반영).
 */
export function runMatch(input: MatchInput): MatchResult {
  const cps = indexCps(input.counterparties);
  const side = input.side ?? 'in';
  const tol = side === 'out' ? 0 : (input.feeTolerance ?? FEE_TOLERANCE);
  const recv = input.receivables.map((r) => ({ ...r }));
  const txns = [...input.txns].sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : a.id < b.id ? -1 : 1)).map((t) => ({ ...t }));
  const auto: AutoMatch[] = [];
  for (const t of txns) {
    if (t.unallocated <= 0) continue;
    const cands = candidatesFor(t, recv, cps, input.rejects, tol, side);
    const a = autoOf(t, cands, cps);
    if (!a) continue;
    const r = recv.find((x) => x.id === a.receivableIds[0])!;
    auto.push({ txnId: t.id, receivableId: r.id, amount: t.unallocated, signal: a.signal! });
    r.remaining -= t.unallocated;
    t.unallocated = 0;
  }
  const candidates = new Map<string, Candidate[]>();
  for (const t of txns) if (t.unallocated > 0) candidates.set(t.id, candidatesFor(t, recv, cps, input.rejects, tol, side));
  return { auto, candidates };
}
