// 계좌 자동조회 원천(CODEF 공동인증서 방식, 대표 결정 2026-11-12). 사장님이 할 일은 "인증서 고르기 + 비밀번호 한 번".
//
// connectedId 정책(PR 본문 근거): CODEF는 계정 등록(connectedId) 때 받은 인증서·비밀번호를 자기 서버에 보관하고, 은행 조회 API는 connectedId가 필수다
// (일회성 조회는 빠른조회 상품뿐). 그래서 **조회할 때마다 만들고 → 조회 → 바로 지운다**(임시 connectedId). CODEF에 인증서가 남는 시간은 한 번의 조회 동안뿐이다.
// - 연결: 금고 창 비밀번호 → 계정 등록 → 보유계좌 → (사장님이 계좌 고름) → 첫 조회 → 계정 삭제. 고르지 않고 10분이 지나거나 취소하면 지운다.
// - [최신화]: 금고(기억해 둔 비밀번호가 있으면 그것, 없으면 창) → 계정 등록 → 거래내역 → 계정 삭제.
// - 만든 connectedId는 쓰기 전에 PC DB(orphans)에 먼저 적고, 지우면 뺀다. 지우기가 실패하거나 그 사이 앱이 꺼지면 적힌 채로 남아
//   다음 실행의 sweep·연결·조회·[연결 해제] 때 다시 지운다.
// - [연결 해제]: 남은 connectedId 삭제 + 기억해 둔 비밀번호 삭제 + 연결 상태 삭제. 가져온 거래 줄은 사장님 데이터라 그대로 둔다.
//   그날 비밀번호 틀림 상한(하루 3회·은행 잠김)은 풀지 않는다(해제→재연결로 더 보내지 않게).
// 화면·로그·이벤트에는 계좌번호 끝 4자리·이름·건수만 간다(전체 번호·비밀번호·인증서·토큰·connectedId 없음).
import type { CodefClient, CodefAccount, CodefTxn } from './client.ts';
import { CODEF_BANKS, CodefError, isCodefBank, type CodefBankCode, type CodefClientType, type CodefFailure } from './codes.ts';
import { codefRows, type AutoTxnRow } from './rows.ts';

/** 금고 codef.seal 결과(vault protocol CodefSealResult와 같은 모양) */
export type SealResult =
  | { ok: true; derFile: string; keyFile: string; password: string; remembered: boolean }
  | { ok: false; reason: string };

export interface CodefSealPort {
  seal(p: { certId: string; publicKey: string; mode: 'ask' | 'auto' }): Promise<SealResult>;
  cancel(): Promise<void>;
  forget(certId: string): Promise<void>;
}

/**
 * 거래내역 원천을 받는 쪽(bank-mvp 돈 맞추기 저장소 어댑터 한 겹). 원천 칸은 'api'.
 * - ensureAccount: 이 계좌번호의 내 계좌를 찾거나 만든다(번호는 저장소가 암호화·HMAC으로 둔다)
 * - accountNumber: [최신화] 때 조회할 번호(저장소가 풀어 준다)
 * - importRows: 줄 열쇠로 한 번만 넣고 새로 들어간 수를 돌려준다
 */
export interface BankTxnSink {
  ensureAccount(a: { bank: string; number: string; alias: string | null }): Promise<{ accountId: string; profileId?: string }>;
  accountNumber(accountId: string): Promise<string | null>;
  importRows(a: { accountId: string; source: 'api'; range: { from: string; to: string }; rows: AutoTxnRow[] }): Promise<{ rowCount: number; newCount: number }>;
}

export interface LinkState {
  v: 1;
  certId: string;
  bank: CodefBankCode;
  clientType: CodefClientType;
  accountId: string;
  /** 돈 맞추기 저장소의 프로필 id(bank.setLink·bank.refresh에 쓴다). 저장소가 알려 주지 않으면 null */
  profileId?: string | null;
  last4: string;
  accountName: string;
  connectedAt: string;
  lastSyncAt: string | null;
  /** 마지막으로 받은 마지막 날(YYYY-MM-DD). 다음 조회는 이 날 3일 전부터 겹쳐 받는다 */
  lastDay: string | null;
  lastNew: number;
}

/** 지우지 못한 connectedId(다음에 다시 지운다). PC DB에만 */
export interface Orphan {
  connectedId: string;
  bank: CodefBankCode;
  clientType: CodefClientType;
}

/** 하루 호출 수(KST 날짜)와 인증서별 비밀번호 틀림 수. 데모는 하루 100회라 PC가 아낀다 */
export interface CodefBudget {
  day: string;
  calls: number;
  pwFails: Record<string, number>;
}

export interface CodefStoreValue {
  link: LinkState | null;
  orphans: Orphan[];
  budget?: CodefBudget;
}

export interface CodefLinkStore {
  get(): CodefStoreValue;
  set(v: CodefStoreValue): void;
}

/** 하루 CODEF 호출 상한(데모 하루 100회, 여유 10). 계정 삭제는 막지 않는다(인증서를 CODEF에 남기지 않게) */
export const CODEF_DAILY_CALLS = 90;
/** [최신화] 사이 최소 간격(같은 기간 반복 조회 막기) */
export const CODEF_REFRESH_COOLDOWN_MS = 15 * 60_000;
/** 같은 인증서 비밀번호가 하루 이만큼 틀리면 그날은 더 보내지 않는다(호출 아낌 + 은행 잠금 전) */
export const CODEF_PW_FAIL_MAX = 3;

export type CodefPhase = 'password' | 'connecting' | 'accounts' | 'fetching' | 'saving' | 'done' | 'error';
export interface CodefEvent {
  phase: CodefPhase;
  code?: CodefFailure;
  cf?: string;
  newCount?: number;
}

export interface CodefLinkOptions {
  client: CodefClient;
  seal: CodefSealPort;
  store: CodefLinkStore;
  /** bank-mvp 저장소가 붙기 전에는 null(choose·refresh가 bank_not_ready) */
  sink: () => BankTxnSink | null;
  onEvent?: (e: CodefEvent) => void;
  now?: () => Date;
  /** 고르기를 기다리는 시간(지나면 connectedId를 지운다) */
  pendingTtlMs?: number;
  /** 하루 호출 상한(기본 CODEF_DAILY_CALLS) */
  dailyCalls?: number;
}

/** 화면에 보이는 보유계좌(번호는 끝 4자리만) */
export interface AccountChoice {
  key: string;
  last4: string;
  name: string;
  balance: number | null;
  /** 수시입출(11)만 거래내역을 가져올 수 있다 */
  usable: boolean;
}

interface Pending {
  id: string;
  connectedId: string;
  certId: string;
  bank: CodefBankCode;
  clientType: CodefClientType;
  accounts: CodefAccount[];
  timer: ReturnType<typeof setTimeout>;
}

const CERT_ID_RE = /^[0-9a-f]{16}$/;
/** 첫 조회 기간(일). 우리은행은 최근 12개월까지 된다 */
export const FIRST_RANGE_DAYS = 90;
const OVERLAP_DAYS = 3;

const ymd = (d: Date): string => d.toISOString().slice(0, 10);
const compact = (s: string): string => s.replace(/-/g, '');
const addDays = (day: string, n: number): string => ymd(new Date(Date.parse(`${day}T00:00:00Z`) + n * 86_400_000));

export class CodefLink {
  private readonly o: CodefLinkOptions;
  private busy = false;
  private pending: Pending | null = null;
  private seq = 0;

  constructor(o: CodefLinkOptions) {
    this.o = o;
    // 모든 CODEF 호출을 하루 상한으로 센다. 삭제는 세기만 하고 막지 않는다
    o.client.setBudget((path) => {
      const b = this.budget();
      if (path !== '/v1/account/delete' && b.calls >= (o.dailyCalls ?? CODEF_DAILY_CALLS)) throw new CodefError('daily_limit');
      this.save({ budget: { ...b, calls: b.calls + 1 } });
    });
  }

  private save(patch: Partial<CodefStoreValue>): void {
    this.o.store.set({ ...this.o.store.get(), ...patch });
  }

  private budget(): CodefBudget {
    const b = this.o.store.get().budget;
    const day = this.today();
    return b && b.day === day ? { day, calls: b.calls, pwFails: { ...b.pwFails } } : { day, calls: 0, pwFails: {} };
  }

  private emit(e: CodefEvent): void {
    this.o.onEvent?.(e);
  }

  private nowMs(): number {
    return (this.o.now?.() ?? new Date()).getTime();
  }

  private today(): string {
    // 한국 날짜(UTC+9)
    return ymd(new Date(this.nowMs() + 9 * 3600_000));
  }

  status(): Record<string, unknown> {
    const { link } = this.o.store.get();
    const callsLeft = Math.max(0, (this.o.dailyCalls ?? CODEF_DAILY_CALLS) - this.budget().calls);
    const cleanupPending = this.stale().length;
    if (!link) return { connected: false, cleanupPending, callsLeft };
    return {
      connected: true,
      bank: link.bank,
      bankName: CODEF_BANKS[link.bank],
      last4: link.last4,
      accountName: link.accountName,
      accountId: link.accountId,
      profileId: link.profileId ?? null,
      certId: link.certId,
      connectedAt: link.connectedAt,
      lastSyncAt: link.lastSyncAt,
      lastNew: link.lastNew,
      cleanupPending,
      callsLeft,
    };
  }

  /** 한 번에 하나만. 실패는 error 이벤트 뒤에 던진다 */
  private async exclusive<T>(fn: () => Promise<T>): Promise<T> {
    if (this.busy) throw new CodefError('busy');
    this.busy = true;
    try {
      return await fn();
    } catch (e) {
      const err = e instanceof CodefError ? e : new CodefError('unavailable');
      this.emit({ phase: 'error', code: err.code, ...(err.cf ? { cf: err.cf } : {}) });
      throw err;
    } finally {
      this.busy = false;
    }
  }

  /** 금고 창으로 비밀번호를 받아 감싼 로그인 → 계정 등록. 비밀번호가 틀렸으면 기억해 둔 것을 지운다 */
  private async register(certId: string, bank: CodefBankCode, clientType: CodefClientType, mode: 'ask' | 'auto'): Promise<string> {
    if ((this.budget().pwFails[certId] ?? 0) >= CODEF_PW_FAIL_MAX) throw new CodefError('password_retry_limit');
    const publicKey = await this.o.client.publicKey();
    this.emit({ phase: 'password' });
    const s = await this.o.seal.seal({ certId, publicKey, mode });
    if (!s.ok) {
      if (s.reason === 'cancelled' || s.reason === 'timeout') throw new CodefError('cancelled');
      if (s.reason === 'not_found' || s.reason === 'no_key') throw new CodefError('cert_missing');
      if (s.reason === 'busy') throw new CodefError('busy');
      throw new CodefError('unavailable');
    }
    this.emit({ phase: 'connecting' });
    try {
      const id = await this.o.client.createAccount(bank, clientType, { derFile: s.derFile, keyFile: s.keyFile, password: s.password });
      // 쓰기 전에 PC DB에 먼저 적는다. 지우면 빠지고, 앱이 그 사이 꺼지면 다음 실행의 sweep이 지운다
      this.save({ orphans: [...this.o.store.get().orphans, { connectedId: id, bank, clientType }] });
      const b = this.budget();
      if (b.pwFails[certId]) {
        delete b.pwFails[certId];
        this.save({ budget: b });
      }
      return id;
    } catch (e) {
      if (e instanceof CodefError && (e.code === 'password_wrong' || e.code === 'password_locked')) {
        if (s.remembered) await this.o.seal.forget(certId).catch(() => undefined);
        const b = this.budget();
        b.pwFails[certId] = e.code === 'password_locked' ? CODEF_PW_FAIL_MAX : (b.pwFails[certId] ?? 0) + 1;
        this.save({ budget: b });
      }
      throw e;
    }
  }

  /** 지우기(실패하면 적어 두고 다음에). 남은 것도 함께 다시 지운다 */
  private async release(items: Orphan[]): Promise<void> {
    if (!items.length) return;
    const left: Orphan[] = [];
    for (const it of items) {
      try {
        await this.o.client.deleteAccount(it.connectedId, it.bank, it.clientType);
      } catch {
        left.push(it);
      }
    }
    const cur = this.o.store.get();
    const keep = cur.orphans.filter((x) => !items.some((y) => y.connectedId === x.connectedId));
    this.save({ orphans: [...keep, ...left] });
  }

  private stale(): Orphan[] {
    return this.o.store.get().orphans.filter((x) => x.connectedId !== this.pending?.connectedId);
  }

  private async releaseOrphans(): Promise<void> {
    const stale = this.stale();
    if (stale.length) await this.release(stale).catch(() => undefined);
  }

  /** 앱이 켜질 때: 지난 실행이 남긴 connectedId를 지운다(실패하면 적힌 채로 다음에) */
  sweep(): Promise<{ cleanupPending: number }> {
    return this.exclusive(async () => {
      await this.releaseOrphans();
      return { cleanupPending: this.stale().length };
    });
  }

  private dropPending(): Pending | null {
    const p = this.pending;
    if (p) clearTimeout(p.timer);
    this.pending = null;
    return p;
  }

  /** [자동 연결] → 동의 → 인증서 → 비밀번호(금고 창) → 보유계좌. 비밀번호는 매번 창에서 묻는다(기억은 창의 선택) */
  connect(p: { certId?: unknown; bank?: unknown; clientType?: unknown }): Promise<{ sessionId: string; bankName: string; accounts: AccountChoice[] }> {
    const certId = String(p.certId ?? '');
    const bank = (p.bank ?? '0020') as CodefBankCode;
    const clientType: CodefClientType = p.clientType === 'P' ? 'P' : 'B';
    if (!CERT_ID_RE.test(certId) || !isCodefBank(bank)) return Promise.reject(new Error('bad_params'));
    return this.exclusive(async () => {
      this.dropPending();
      await this.releaseOrphans();
      const connectedId = await this.register(certId, bank, clientType, 'ask');
      let accounts: CodefAccount[];
      try {
        this.emit({ phase: 'accounts' });
        accounts = await this.o.client.accounts(connectedId, bank, clientType);
      } catch (e) {
        await this.release([{ connectedId, bank, clientType }]);
        throw e;
      }
      if (!accounts.length) {
        await this.release([{ connectedId, bank, clientType }]);
        throw new CodefError('no_account');
      }
      const id = `cs${Date.now().toString(36)}${(++this.seq).toString(36)}`;
      const timer = setTimeout(() => {
        const q = this.pending?.id === id ? this.dropPending() : null;
        if (q) void this.release([{ connectedId: q.connectedId, bank: q.bank, clientType: q.clientType }]).catch(() => undefined);
      }, this.o.pendingTtlMs ?? 10 * 60_000);
      timer.unref?.();
      this.pending = { id, connectedId, certId, bank, clientType, accounts, timer };
      this.emit({ phase: 'done' });
      return {
        sessionId: id,
        bankName: CODEF_BANKS[bank],
        accounts: accounts.map((a, i) => ({ key: `a${i}`, last4: a.number.slice(-4), name: a.name, balance: a.balance, usable: a.depositKind === '' || a.depositKind === '11' })),
      };
    });
  }

  /** 보유계좌에서 하나 고르기 → 내 계좌로 넣고 첫 조회 → connectedId 삭제 → "연결됨" */
  choose(p: { sessionId?: unknown; key?: unknown; alias?: unknown }): Promise<{ last4: string; accountId: string; profileId: string | null; rowCount: number; newCount: number; from: string; to: string }> {
    return this.exclusive(async () => {
      const pend = this.pending;
      if (!pend || pend.id !== p.sessionId) throw new CodefError('session_lost');
      const idx = /^a(\d{1,3})$/.exec(String(p.key ?? ''));
      const acct = idx ? pend.accounts[Number(idx[1])] : undefined;
      if (!acct) throw new Error('bad_params');
      this.dropPending();
      const orphan: Orphan = { connectedId: pend.connectedId, bank: pend.bank, clientType: pend.clientType };
      try {
        const sink = this.o.sink();
        if (!sink) throw new CodefError('bank_not_ready');
        const alias = typeof p.alias === 'string' && p.alias.trim() ? p.alias.trim().slice(0, 40) : acct.name || null;
        const { accountId, profileId } = await sink.ensureAccount({ bank: CODEF_BANKS[pend.bank], number: acct.number, alias });
        const link: LinkState = {
          v: 1, certId: pend.certId, bank: pend.bank, clientType: pend.clientType, accountId, profileId: profileId ?? null, last4: acct.number.slice(-4), accountName: acct.name,
          connectedAt: new Date(this.nowMs()).toISOString(), lastSyncAt: null, lastDay: null, lastNew: 0,
        };
        this.save({ link });
        const r = await this.fetchInto(sink, link, pend.connectedId, acct.number);
        return { last4: link.last4, accountId, profileId: profileId ?? null, ...r };
      } finally {
        await this.release([orphan]);
      }
    });
  }

  /** [최신화]: 기억해 둔 비밀번호가 있으면 창 없이, 없으면 금고 창 → 등록 → 거래내역 → 삭제 */
  refresh(p: { ask?: unknown } = {}): Promise<{ rowCount: number; newCount: number; from: string; to: string }> {
    return this.exclusive(async () => {
      const { link } = this.o.store.get();
      if (!link) throw new CodefError('session_lost');
      // 같은 기간을 짧은 간격으로 다시 조회하지 않는다(데모 하루 100회). 비밀번호를 다시 넣는 [다시 하기](ask)는 막지 않는다
      const last = link.lastSyncAt ? Date.parse(link.lastSyncAt) : NaN;
      if (p.ask !== true && Number.isFinite(last) && this.nowMs() - last < CODEF_REFRESH_COOLDOWN_MS) throw new CodefError('too_soon');
      const sink = this.o.sink();
      if (!sink) throw new CodefError('bank_not_ready');
      const number = await sink.accountNumber(link.accountId);
      if (!number) throw new CodefError('no_account');
      await this.releaseOrphans();
      const connectedId = await this.register(link.certId, link.bank, link.clientType, p.ask === true ? 'ask' : 'auto');
      try {
        return await this.fetchInto(sink, link, connectedId, number);
      } finally {
        await this.release([{ connectedId, bank: link.bank, clientType: link.clientType }]);
      }
    });
  }

  private async fetchInto(sink: BankTxnSink, link: LinkState, connectedId: string, number: string): Promise<{ rowCount: number; newCount: number; from: string; to: string }> {
    const to = this.today();
    const from = link.lastDay ? addDays(link.lastDay, -OVERLAP_DAYS) : addDays(to, -FIRST_RANGE_DAYS);
    this.emit({ phase: 'fetching' });
    const page = await this.o.client.transactions(connectedId, link.bank, link.clientType, number, compact(from), compact(to));
    const { rows } = codefRows(page.txns);
    this.emit({ phase: 'saving' });
    const range = { from: page.startDate.replace(/^(\d{4})(\d{2})(\d{2})$/, '$1-$2-$3'), to: page.endDate.replace(/^(\d{4})(\d{2})(\d{2})$/, '$1-$2-$3') };
    const r = await sink.importRows({ accountId: link.accountId, source: 'api', range, rows });
    const lastDay = rows.reduce<string | null>((m, x) => (m === null || x.day > m ? x.day : m), link.lastDay);
    const cur = this.o.store.get();
    if (cur.link) this.save({ link: { ...cur.link, lastSyncAt: new Date(this.nowMs()).toISOString(), lastDay: lastDay && lastDay < to ? lastDay : addDays(to, -1), lastNew: r.newCount } });
    this.emit({ phase: 'done', newCount: r.newCount });
    return { rowCount: r.rowCount, newCount: r.newCount, from: range.from, to: range.to };
  }

  /**
   * 돈 맞추기 원천(bank/source.ts TxnSource)용: 연결한 계좌 하나의 (기간) 거래를 가져와 CODEF 원문 그대로 돌려준다(저장은 부르는 쪽).
   * [최신화]와 같은 규칙(15분 간격·하루 상한·비밀번호 상한·조회마다 connectedId 삭제)을 따른다.
   */
  fetchForSource(account: { id: string; number: string }, range: { from: string; to: string }, onPhase?: (p: CodefPhase) => void): Promise<{ txns: CodefTxn[]; from: string; to: string }> {
    return this.exclusive(async () => {
      const { link } = this.o.store.get();
      if (!link || link.accountId !== account.id) throw new CodefError('session_lost');
      const last = link.lastSyncAt ? Date.parse(link.lastSyncAt) : NaN;
      if (Number.isFinite(last) && this.nowMs() - last < CODEF_REFRESH_COOLDOWN_MS) throw new CodefError('too_soon');
      await this.releaseOrphans();
      onPhase?.('password');
      const connectedId = await this.register(link.certId, link.bank, link.clientType, 'auto');
      try {
        onPhase?.('fetching');
        const page = await this.o.client.transactions(connectedId, link.bank, link.clientType, account.number.replace(/\D/g, ''), compact(range.from), compact(range.to));
        const ymdOf = (d: string) => d.replace(/^(\d{4})(\d{2})(\d{2})$/, '$1-$2-$3');
        const cur = this.o.store.get();
        if (cur.link) this.save({ link: { ...cur.link, lastSyncAt: new Date(this.nowMs()).toISOString() } });
        this.emit({ phase: 'done' });
        return { txns: page.txns, from: ymdOf(page.startDate), to: ymdOf(page.endDate) };
      } finally {
        await this.release([{ connectedId, bank: link.bank, clientType: link.clientType }]);
      }
    });
  }

  /** [취소]: 기다리던 금고 창을 닫고, 고르기 전 connectedId를 지운다 */
  async cancel(): Promise<Record<string, never>> {
    await this.o.seal.cancel().catch(() => undefined);
    const p = this.dropPending();
    if (p) await this.release([{ connectedId: p.connectedId, bank: p.bank, clientType: p.clientType }]).catch(() => undefined);
    return {};
  }

  /** [연결 해제] = 남은 CODEF 계정 삭제 + 기억해 둔 비밀번호 삭제 + 연결 상태 삭제 */
  disconnect(): Promise<{ disconnected: boolean; cleanupPending: number }> {
    return this.exclusive(async () => {
      this.dropPending();
      const { link, orphans } = this.o.store.get();
      await this.release(orphans);
      if (link) await this.o.seal.forget(link.certId).catch(() => undefined);
      const left = this.o.store.get().orphans;
      this.save({ link: null });
      this.emit({ phase: 'done' });
      return { disconnected: !!link, cleanupPending: left.length };
    });
  }
}
