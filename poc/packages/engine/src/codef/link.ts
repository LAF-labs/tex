import type { CodefClient, CodefAccount, CodefTwoWay, CodefTxn } from './client.ts';
import { CODEF_BANKS, CodefError, isCodefBank, type CodefBankCode, type CodefClientType, type CodefFailure } from './codes.ts';

/** 금고 codef.seal 결과(vault protocol CodefSealResult와 같은 모양) */
export type SealResult =
  | { ok: true; derFile: string; keyFile: string; password: string; remembered: boolean }
  | { ok: false; reason: string };

export interface CodefSealPort {
  seal(p: { certId: string; publicKey: string; mode: 'ask' | 'auto'; field?: 'account' }): Promise<SealResult>;
  cancel(): Promise<void>;
  forget(certId: string): Promise<void>;
}

/**
 * 돈 맞추기(bank/service.ts BankService) 쪽. 엔진 entry가 같은 프로세스의 BankService로 만든다(codef/index.ts bankServicePort).
 * 거래를 넣고 맞추는 일은 돈 맞추기가 한다(bank.refresh → 원천 codefTxnSource → 넣기 → 맞추기). 여기는 계좌를 잇고 최신화를 시작만 한다.
 */
export interface CodefBankPort {
  ready(): 'bank_not_ready' | 'bank_consent_required' | null;
  corporate?(): boolean;
  withdrawAccount?(bank: CodefBankCode): string | null;
  link(a: { bank: string; number: string; alias: string | null }): Promise<{ accountId: string; profileId: string }>;
  refresh(a: { profileId: string; accountId: string }): Promise<void>;
  unlink(a: { profileId: string; accountId: string }): Promise<void>;
}

export interface LinkState {
  v: 1;
  certId: string;
  bank: CodefBankCode;
  clientType: CodefClientType;
  accountId: string;
  profileId: string;
  last4: string;
  accountName: string;
  connectedAt: string;
  lastSyncAt: string | null;
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

const CODEF_DAILY_CALLS = 90;
const CODEF_REFRESH_COOLDOWN_MS = 15 * 60_000;
const CODEF_PW_FAIL_MAX = 3;

type CodefPhase = 'password' | 'connecting' | 'accounts' | 'sms' | 'fetching' | 'done' | 'error' | 'next_banking' | 'banking_failed' | 'order';
export interface CodefEvent {
  phase: CodefPhase;
  code?: CodefFailure;
  cf?: string;
  param?: string;
  clientType?: CodefClientType;
  order?: string;
  hint?: string;
  deferred?: boolean;
}

interface CodefLinkOptions {
  client: CodefClient;
  seal: CodefSealPort;
  store: CodefLinkStore;
  bank: () => CodefBankPort | null;
  onEvent?: (e: CodefEvent) => void;
  now?: () => Date;
  pendingTtlMs?: number;
  dailyCalls?: number;
}

interface AccountChoice {
  key: string;
  last4: string;
  name: string;
  balance: number | null;
  usable: boolean;
}

type Held =
  | { kind: 'choosing'; id: string; connectedId: string; certId: string; bank: CodefBankCode; clientType: CodefClientType; accounts: CodefAccount[]; timer: ReturnType<typeof setTimeout> }
  | { kind: 'sms'; id: string; connectedId: string; certId: string; bank: CodefBankCode; clientType: CodefClientType; twoWay: CodefTwoWay; tries: number; timer: ReturnType<typeof setTimeout> }
  | { kind: 'warm'; accountId: string; connectedId: string; bank: CodefBankCode; clientType: CodefClientType; timer: ReturnType<typeof setTimeout> };

const CERT_ID_RE = /^[0-9a-f]{16}$/;

interface ConnectResult {
  sessionId: string;
  bankName: string;
  accounts: AccountChoice[];
  step?: 'sms';
}

/**
 * 해 볼 뱅킹 순서. 법인 사업장은 기업 뱅킹만(법인 계좌는 개인 뱅킹에 없다).
 * 개인사업자는 인증서 종류로: 법인·사업자용이면 기업 먼저, 개인용·모름이면 개인 먼저(1인 사업자는 개인 뱅킹으로 사업자 계좌를 보는 경우가 많다).
 */
export function bankingOrder(o: { explicit?: unknown; corporate: boolean; prefer?: unknown }): CodefClientType[] {
  if (o.explicit === 'P' || o.explicit === 'B') return [o.explicit];
  if (o.corporate) return ['B'];
  return o.prefer === 'B' ? ['B', 'P'] : ['P', 'B'];
}

const SMS_TRIES = 3;

const TRY_OTHER: ReadonlySet<CodefFailure> = new Set(['identity_required', 'withdraw_account_required', 'banking_kind', 'not_enrolled', 'cert_not_registered', 'cert_kind', 'rejected']);
const STOP_NOW: ReadonlySet<CodefFailure> = new Set(['password_wrong', 'password_locked', 'cancelled', 'busy']);
const RANK: readonly CodefFailure[] = ['withdraw_account_required', 'identity_required', 'not_enrolled', 'banking_kind', 'cert_not_registered', 'cert_kind'];
function worst(f: { e: CodefError; clientType: CodefClientType }[]): CodefError {
  for (const c of RANK) {
    const hit = f.find((x) => x.e.code === c);
    if (!hit) continue;
    const other = f.find((x) => x.clientType !== hit.clientType && RANK.includes(x.e.code));
    if (other) hit.e.also = { clientType: other.clientType, code: other.e.code };
    return hit.e.withClientType(hit.clientType);
  }
  const last = f[f.length - 1]!;
  return last.e.withClientType(last.clientType);
}

const ymd = (d: Date): string => d.toISOString().slice(0, 10);
const compact = (s: string): string => s.replace(/-/g, '');

export class CodefLink {
  private readonly o: CodefLinkOptions;
  private busy = false;
  private pending: Held | null = null;
  private seq = 0;

  constructor(o: CodefLinkOptions) {
    this.o = o;
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
      cleanupPending,
      callsLeft,
    };
  }

  private async exclusive<T>(fn: () => Promise<T>): Promise<T> {
    if (this.busy) throw new CodefError('busy');
    this.busy = true;
    try {
      return await fn();
    } catch (e) {
      const err = e instanceof CodefError ? e : new CodefError('unavailable');
      this.emit({ phase: 'error', code: err.code, ...(err.cf ? { cf: err.cf } : {}), ...(err.param ? { param: err.param } : {}), ...(err.hint ? { hint: err.hint } : {}) });
      throw err;
    } finally {
      this.busy = false;
    }
  }

  private async register(certId: string, bank: CodefBankCode, types: readonly CodefClientType[], mode: 'ask' | 'auto', withdraw: string | null = null): Promise<{ connectedId: string; clientType: CodefClientType }> {
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
    const failures: { e: CodefError; clientType: CodefClientType }[] = [];
    const deferred: CodefClientType[] = [];
    const login = { derFile: s.derFile, keyFile: s.keyFile, password: s.password };
    const fail = (e: unknown, clientType: CodefClientType, last: boolean): void => {
      if (e instanceof CodefError && TRY_OTHER.has(e.code) && !last) {
        failures.push({ e, clientType });
        this.emit({ phase: 'next_banking', clientType, code: e.code, ...(e.cf ? { cf: e.cf } : {}), ...(e.param ? { param: e.param } : {}), ...(e.hint ? { hint: e.hint } : {}) });
        return;
      }
      if (e instanceof CodefError) {
        failures.push({ e, clientType });
        this.emit({ phase: 'banking_failed', clientType, code: e.code, ...(e.cf ? { cf: e.cf } : {}), ...(e.param ? { param: e.param } : {}), ...(e.hint ? { hint: e.hint } : {}) });
      }
      throw failures.length ? worst(failures) : e;
    };
    const done = (id: string, clientType: CodefClientType) => {
      this.save({ orphans: [...this.o.store.get().orphans, { connectedId: id, bank, clientType }] });
      const b = this.budget();
      if (b.pwFails[certId]) {
        delete b.pwFails[certId];
        this.save({ budget: b });
      }
      return { connectedId: id, clientType };
    };
    try {
      for (const [i, clientType] of types.entries()) {
        try {
          return done(await this.o.client.createAccount(bank, clientType, login), clientType);
        } catch (e0) {
          if (e0 instanceof CodefError && e0.cf === 'CF-12401' && /withdrawaccount/i.test(`${e0.param ?? ''} ${e0.hint ?? ''}`)) {
            deferred.push(clientType);
            if (i < types.length - 1) {
              this.emit({ phase: 'next_banking', clientType, code: 'withdraw_account_required', cf: e0.cf, deferred: true });
              continue;
            }
            break;
          }
          if (deferred.length && e0 instanceof CodefError && !STOP_NOW.has(e0.code)) {
            failures.push({ e: e0, clientType });
            this.emit({ phase: 'next_banking', clientType, code: e0.code, ...(e0.cf ? { cf: e0.cf } : {}), ...(e0.param ? { param: e0.param } : {}), ...(e0.hint ? { hint: e0.hint } : {}) });
            continue;
          }
          fail(e0, clientType, i === types.length - 1);
        }
      }
      for (const [i, clientType] of deferred.entries()) {
        try {
          if (!withdraw) throw new CodefError('withdraw_account_required', 'CF-12401');
          return done(await this.withWithdraw(certId, bank, clientType, login, withdraw, mode, publicKey), clientType);
        } catch (e) {
          fail(e, clientType, i === deferred.length - 1);
        }
      }
      throw new CodefError('rejected');
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

  private async withWithdraw(certId: string, bank: CodefBankCode, clientType: CodefClientType, login: { derFile: string; keyFile: string; password: string }, withdraw: string, mode: 'ask' | 'auto', publicKey: string): Promise<string> {
    const needs = (e: unknown, re: RegExp) => e instanceof CodefError && e.cf === 'CF-12401' && re.test(`${e.param ?? ''} ${e.hint ?? ''}`);
    try {
      return await this.o.client.createAccount(bank, clientType, login, withdraw);
    } catch (e1) {
      if (needs(e1, /withdrawaccountpass/i)) {
        this.emit({ phase: 'password' });
        const a = await this.o.seal.seal({ certId, publicKey, mode, field: 'account' });
        if (!a.ok) throw new CodefError(a.reason === 'cancelled' || a.reason === 'timeout' ? 'cancelled' : 'unavailable');
        this.emit({ phase: 'connecting' });
        try {
          return await this.o.client.createAccount(bank, clientType, login, withdraw, a.password);
        } catch (e2) {
          if (needs(e2, /withdrawaccount/i)) throw new CodefError('withdraw_account_required', 'CF-12401', null, 'retried');
          throw e2;
        }
      }
      if (needs(e1, /withdrawaccount/i)) throw new CodefError('withdraw_account_required', 'CF-12401', null, 'retried');
      throw e1;
    }
  }

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

  sweep(): Promise<{ cleanupPending: number }> {
    return this.exclusive(async () => {
      await this.releaseOrphans();
      return { cleanupPending: this.stale().length };
    });
  }

  private expire(connectedId: string): ReturnType<typeof setTimeout> {
    const t = setTimeout(() => {
      if (this.pending?.connectedId === connectedId) void this.releaseHeld(this.dropPending());
    }, this.o.pendingTtlMs ?? 10 * 60_000);
    t.unref?.();
    return t;
  }

  private hold(h: Held): void {
    this.pending = h;
  }

  private releaseHeld(h: Held | null): Promise<void> {
    return h ? this.release([{ connectedId: h.connectedId, bank: h.bank, clientType: h.clientType }]).catch(() => undefined) : Promise.resolve();
  }

  private dropPending(): Held | null {
    const p = this.pending;
    if (p) clearTimeout(p.timer);
    this.pending = null;
    return p;
  }

  connect(p: { certId?: unknown; bank?: unknown; clientType?: unknown; prefer?: unknown; withdrawAccount?: unknown }): Promise<ConnectResult> {
    const certId = String(p.certId ?? '');
    const bank = (p.bank ?? '0020') as CodefBankCode;
    if (!CERT_ID_RE.test(certId) || !isCodefBank(bank)) return Promise.reject(new Error('bad_params'));
    return this.exclusive(async () => {
      const port = this.o.bank();
      const notReady = port ? port.ready() : 'bank_not_ready';
      if (notReady) throw new CodefError(notReady);
      const types = bankingOrder({ explicit: p.clientType, corporate: port?.corporate?.() ?? false, prefer: p.prefer });
      this.emit({ phase: 'order', order: types.join('') });
      await this.releaseHeld(this.dropPending());
      await this.releaseOrphans();
      const typed = typeof p.withdrawAccount === 'string' ? p.withdrawAccount.replace(/\D/g, '') : '';
      const withdraw = /^\d{10,16}$/.test(typed) ? typed : (port?.withdrawAccount?.(bank) ?? null);
      const { connectedId, clientType } = await this.register(certId, bank, types, 'ask', withdraw);
      return this.listAccounts({ connectedId, certId, bank, clientType });
    });
  }

  private async listAccounts(a: { connectedId: string; certId: string; bank: CodefBankCode; clientType: CodefClientType }, answer?: { twoWay: CodefTwoWay; smsAuthNo: string }, tries = 0): Promise<ConnectResult> {
    const { connectedId, certId, bank, clientType } = a;
    let got: Awaited<ReturnType<CodefClient['accounts']>>;
    try {
      this.emit({ phase: 'accounts' });
      got = await this.o.client.accounts(connectedId, bank, clientType, answer);
    } catch (e) {
      await this.release([{ connectedId, bank, clientType }]);
      throw e;
    }
    const id = `cs${Date.now().toString(36)}${(++this.seq).toString(36)}`;
    if (!Array.isArray(got)) {
      this.hold({ kind: 'sms', id, connectedId, certId, bank, clientType, twoWay: got.twoWay, tries, timer: this.expire(connectedId) });
      this.emit({ phase: 'sms' });
      return { sessionId: id, bankName: CODEF_BANKS[bank], step: 'sms', accounts: [] };
    }
    if (!got.length) {
      await this.release([{ connectedId, bank, clientType }]);
      throw new CodefError('no_account');
    }
    this.hold({ kind: 'choosing', id, connectedId, certId, bank, clientType, accounts: got, timer: this.expire(connectedId) });
    this.emit({ phase: 'done' });
    return {
      sessionId: id,
      bankName: CODEF_BANKS[bank],
      accounts: got.map((x, i) => ({ key: `a${i}`, last4: x.number.slice(-4), name: x.name, balance: x.balance, usable: x.depositKind === '' || x.depositKind === '11' })),
    };
  }

  sms(p: { sessionId?: unknown; code?: unknown }): Promise<ConnectResult> {
    const code = String(p.code ?? '').replace(/\s/g, '');
    return this.exclusive(async () => {
      const h = this.pending;
      if (!h || h.kind !== 'sms' || h.id !== p.sessionId) throw new CodefError('session_lost');
      if (!/^\d{4,8}$/.test(code)) throw new CodefError('sms_wrong');
      if (h.tries >= SMS_TRIES) {
        await this.releaseHeld(this.dropPending());
        throw new CodefError('sms_wrong');
      }
      clearTimeout(h.timer);
      this.pending = null;
      return this.listAccounts(h, { twoWay: h.twoWay, smsAuthNo: code }, h.tries + 1);
    });
  }

  async choose(p: { sessionId?: unknown; key?: unknown; alias?: unknown }): Promise<{ last4: string; accountId: string; profileId: string }> {
    const linked = await this.exclusive(async () => {
      const pend = this.pending;
      if (!pend || pend.kind !== 'choosing' || pend.id !== p.sessionId) throw new CodefError('session_lost');
      const idx = /^a(\d{1,3})$/.exec(String(p.key ?? ''));
      const acct = idx ? pend.accounts[Number(idx[1])] : undefined;
      if (!acct) throw new Error('bad_params');
      this.dropPending();
      try {
        const bank = this.o.bank();
        if (!bank) throw new CodefError('bank_not_ready');
        const alias = typeof p.alias === 'string' && p.alias.trim() ? p.alias.trim().slice(0, 40) : acct.name || null;
        const { accountId, profileId } = await bank.link({ bank: CODEF_BANKS[pend.bank], number: acct.number, alias });
        const link: LinkState = {
          v: 1, certId: pend.certId, bank: pend.bank, clientType: pend.clientType, accountId, profileId, last4: acct.number.slice(-4), accountName: acct.name,
          connectedAt: new Date(this.nowMs()).toISOString(), lastSyncAt: null,
        };
        this.save({ link });
        this.hold({ kind: 'warm', accountId, connectedId: pend.connectedId, bank: pend.bank, clientType: pend.clientType, timer: this.expire(pend.connectedId) });
        return { bank, link };
      } catch (e) {
        await this.releaseHeld(pend);
        throw e;
      }
    });
    await linked.bank.refresh({ profileId: linked.link.profileId, accountId: linked.link.accountId }).catch(() => this.releaseHeld(this.pending?.kind === 'warm' ? this.dropPending() : null));
    return { last4: linked.link.last4, accountId: linked.link.accountId, profileId: linked.link.profileId };
  }

  async refresh(): Promise<{ started: true }> {
    const { link } = this.o.store.get();
    if (!link) throw new CodefError('session_lost');
    const last = link.lastSyncAt ? Date.parse(link.lastSyncAt) : NaN;
    if (Number.isFinite(last) && this.nowMs() - last < CODEF_REFRESH_COOLDOWN_MS) throw new CodefError('too_soon', null, new Date(last + CODEF_REFRESH_COOLDOWN_MS).toISOString());
    if (this.budget().calls >= (this.o.dailyCalls ?? CODEF_DAILY_CALLS)) throw new CodefError('daily_limit');
    const bank = this.o.bank();
    if (!bank) throw new CodefError('bank_not_ready');
    await bank.refresh({ profileId: link.profileId, accountId: link.accountId });
    return { started: true };
  }

  fetchForSource(account: { id: string; number: string }, range: { from: string; to: string }, onPhase?: (p: CodefPhase) => void): Promise<{ txns: CodefTxn[]; from: string; to: string }> {
    return this.exclusive(async () => {
      const { link } = this.o.store.get();
      if (!link || link.accountId !== account.id) throw new CodefError('session_lost');
      const last = link.lastSyncAt ? Date.parse(link.lastSyncAt) : NaN;
      if (Number.isFinite(last) && this.nowMs() - last < CODEF_REFRESH_COOLDOWN_MS) throw new CodefError('too_soon', null, new Date(last + CODEF_REFRESH_COOLDOWN_MS).toISOString());
      await this.releaseOrphans();
      const warm = this.pending?.kind === 'warm' && this.pending.accountId === account.id ? this.dropPending() : null;
      let connectedId: string;
      if (warm) connectedId = warm.connectedId;
      else {
        if (this.budget().calls >= (this.o.dailyCalls ?? CODEF_DAILY_CALLS)) throw new CodefError('daily_limit');
        onPhase?.('password');
        connectedId = (await this.register(link.certId, link.bank, [link.clientType], 'auto', account.number.replace(/\D/g, '') || null)).connectedId;
      }
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

  async cancel(): Promise<Record<string, never>> {
    await this.o.seal.cancel().catch(() => undefined);
    await this.releaseHeld(this.dropPending());
    return {};
  }

  disconnect(): Promise<{ disconnected: boolean; cleanupPending: number }> {
    return this.exclusive(async () => {
      this.dropPending();
      const { link, orphans } = this.o.store.get();
      await this.release(orphans);
      if (link) await this.o.seal.forget(link.certId).catch(() => undefined);
      if (link) await this.o.bank()?.unlink({ profileId: link.profileId, accountId: link.accountId }).catch(() => undefined);
      const left = this.o.store.get().orphans;
      this.save({ link: null });
      this.emit({ phase: 'done' });
      return { disconnected: !!link, cleanupPending: left.length };
    });
  }
}
