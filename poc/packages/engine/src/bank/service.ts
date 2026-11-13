// 돈 맞추기 1단계(09): 내 계좌·거래내역 넣기·받을 돈 건(원장 + 홈택스 발급 목록)·맞추기·수동 체크·되돌리기·기록.
// main 전용 명령이다(계좌번호·입금자명·금액이 오간다, protocol BANK_*). 파일은 main이 docparse 샌드박스에서 읽어 다듬은 줄만 보낸다.
// 엔진은 원본 파일을 열지 않고 보관함에 그대로 둔다(대표 결정 ⑦, 지울 수 있음). 모델·네트워크를 쓰지 않는다.
// 거래내역 "원천"은 회차의 source(file | auto)다. 자동 연결 원천(source.ts TxnSource, 예: CODEF)은 registerSource로 꽂고 bank.refresh가 원천 → 넣기 → 맞추기를 한다.
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  BankRepo, CounterpartyRepo, DocumentRepo, isValidBizNo, normalizePayerName, normalizePayTerms, ProfileRepo, ValidationError,
  type Alloc, type AllocMethod, type BankTxn, type ColumnCipher, type Db, type PayTerms, type Receivable, type ReceivableEvent, type TxnInput,
} from '@sax/db';
import { SourceError, type SourceProgress, type SourceRow, type TxnSource } from './source.ts';
import { addDays, FEE_TOLERANCE, runMatch, type Candidate, type MatchCounterparty, type MatchReceivable, type MatchTxn } from './match.ts';

export class BankError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(code);
    this.code = code;
  }
}
const fail = (code: string): never => {
  throw new BankError(code);
};
type Params = Record<string, unknown>;

export const DEFAULT_TERMS: PayTerms = { kind: 'days', n: 30 };
/** 거래내역 기준일이 이보다 오래되면 "확인 못 함"(09 §8.3) */
export const STALE_DAYS = 7;
export const BANK_FILE_MAX = 15 * 1024 * 1024;
const ROWS_MAX = 20_000;
const METHODS: readonly AllocMethod[] = ['account', 'cash', 'other_account', 'offset', 'other'];
const ISO = /^\d{4}-\d{2}-\d{2}$/;

export const kstDay = (d: Date) => new Date(d.getTime() + 9 * 3_600_000).toISOString().slice(0, 10);
const lastDayOfMonth = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();

/** 받기로 한 날(09 §5.2). none이면 null */
export function dueDate(writtenOn: string, t: PayTerms): string | null {
  const [y, m] = writtenOn.split('-').map(Number) as [number, number];
  const ny = m === 12 ? y + 1 : y;
  const nm = m === 12 ? 1 : m + 1;
  switch (t.kind) {
    case 'days':
      return addDays(writtenOn, t.n);
    case 'next_month_day':
      return `${ny}-${String(nm).padStart(2, '0')}-${String(Math.min(t.d, lastDayOfMonth(ny, nm))).padStart(2, '0')}`;
    case 'month_end':
      return `${ny}-${String(nm).padStart(2, '0')}-${String(lastDayOfMonth(ny, nm))}`;
    case 'none':
      return null;
  }
}

/** 줄 열쇠: 일시·방향·금액·잔액·입금자 + 같은 값 순번(같은 파일을 다시 올려도 같은 열쇠) */
export function rowKeys(rows: Array<Pick<TxnInput, 'occurredAt' | 'direction' | 'amount' | 'balance' | 'payer'>>): string[] {
  const seen = new Map<string, number>();
  return rows.map((r) => {
    const base = [r.occurredAt, r.direction, r.amount, r.balance ?? '', r.payer ?? ''].join('|');
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    return createHash('sha256').update(`${base}|${n}`).digest('hex').slice(0, 32);
  });
}

/** unknown: 거래내역이 없거나 오래돼(STALE_DAYS) 입금을 확인하지 못한 건. 모르는 상태에서 "못 받음"이라고 하지 않는다(09 §7 원칙 6) */
export type ReceivableStatus = 'unpaid' | 'unknown' | 'partial' | 'waiting' | 'received' | 'excluded';

export interface ReceivableView {
  id: string;
  counterpartyId: string | null;
  cpName: string | null;
  cpBizNo: string | null;
  item: string | null;
  approvalTail: string | null;
  writtenOn: string;
  total: number;
  received: number;
  remaining: number;
  dueOn: string | null;
  promisedOn: string | null;
  /** 받기로 한 날 − 오늘(지나면 음수). 기한 없음이면 null */
  dueIn: number | null;
  overdue: boolean;
  status: ReceivableStatus;
  /** 받음일 때: auto | manual(사람이 붙였거나 표시) */
  via: 'auto' | 'manual' | null;
  /** 계좌 밖 결제 방법(받음·직접일 때) */
  offAccount: AllocMethod | null;
  sources: Array<'ledger' | 'hometax'>;
  excludedReason: string | null;
}

export interface TxnView {
  id: string;
  accountId: string;
  accountLast4: string;
  bank: string;
  day: string;
  occurredAt: string;
  direction: 'in' | 'out';
  amount: number;
  unallocated: number;
  payer: string | null;
  memo: string | null;
  ignoredReason: string | null;
  assignedCounterpartyId: string | null;
  candidates: Array<{ receivableIds: string[]; cpName: string | null; fit: Candidate['fit']; amounts: number[]; feeGap: number; reason: string; writtenOn: string; total: number }>;
}

export interface BankSummary {
  today: string;
  /** 거래내역 기준일(가장 늦은 거래일). 없으면 null */
  latestDay: string | null;
  stale: boolean;
  hasAccounts: boolean;
  unpaidCount: number;
  unpaidTotal: number;
  overdueCount: number;
  overdueTotal: number;
  oldestOverdue: { cpName: string | null; writtenOn: string; daysOver: number } | null;
  reviewCount: number;
  autoCount: number;
}

export interface BankServiceOptions {
  vaultDir: string;
  now?: () => Date;
}

/** 최신화 한 번의 진행(계좌마다 하나). 값(계좌번호·거래)은 담지 않는다 */
export interface RefreshJob {
  id: string;
  accountId: string;
  state: 'requested' | 'waiting' | 'running' | 'done' | 'failed';
  done?: number;
  jobs?: number;
  range: { from: string; to: string };
  startedAt: string;
  finishedAt: string | null;
  code: string | null;
  /** source.too_soon이면 다시 가져올 수 있는 시각(ISO) */
  retryAt?: string | null;
  result: { rows: number; newCount: number; duplicateCount: number; match: { auto: number; review: number; unknown: number } } | null;
}

/** 원천 행 → 넣기 줄. 입금자는 원천이 아는 칸, 없으면 적요 첫 칸. 나머지 적요는 메모로 */
export function sourceRowsToInput(provider: string, rows: SourceRow[]): Array<Record<string, unknown>> {
  return rows.flatMap((r) => {
    const m = /^(\d{4}-\d{2}-\d{2})(?:[ T](\d{2}:\d{2}(?::\d{2})?))?$/.exec(typeof r.occurredAt === 'string' ? r.occurredAt : '');
    if (!m) return [];
    const remarks = (Array.isArray(r.remarks) ? r.remarks : []).map((x) => (typeof x === 'string' ? x.trim() : '')).filter(Boolean);
    const payer = typeof r.payer === 'string' && r.payer.trim() ? r.payer.trim() : (remarks[0] ?? null);
    const rest = remarks.filter((x) => x !== payer);
    const memo = [...rest, typeof r.memo === 'string' ? r.memo.trim() : ''].filter(Boolean).join(' ') || null;
    const base = { day: m[1], occurredAt: m[2] ? `${m[1]} ${m[2]}` : m[1], balance: Number.isSafeInteger(r.balance) ? r.balance : null, payer, memo };
    const sid = typeof r.sourceId === 'string' && r.sourceId ? createHash('sha256').update(`${provider}|${r.sourceId}`).digest('hex').slice(0, 32) : null;
    const out: Array<Record<string, unknown>> = [];
    if (Number.isSafeInteger(r.deposit) && r.deposit > 0) out.push({ ...base, direction: 'in', amount: r.deposit, sourceKey: sid && `${sid}:in` });
    if (Number.isSafeInteger(r.withdrawal) && r.withdrawal > 0) out.push({ ...base, direction: 'out', amount: r.withdrawal, sourceKey: sid && `${sid}:out` });
    return out;
  });
}

export class BankService {
  private readonly db: Db;
  private readonly cipher: ColumnCipher;
  readonly repo: BankRepo;
  private readonly opts: BankServiceOptions;
  private chain: Promise<unknown> = Promise.resolve();
  private readonly sources = new Map<string, TxnSource>();
  private readonly jobs = new Map<string, RefreshJob & { abort: AbortController }>();

  constructor(db: Db, cipher: ColumnCipher, hmacKey: Uint8Array, opts: BankServiceOptions) {
    this.db = db;
    this.cipher = cipher;
    this.repo = new BankRepo(db, cipher, hmacKey);
    this.opts = opts;
  }

  /** 자동 연결 원천을 꽂는다(공급자 이름마다 하나). 계좌의 link_provider가 고른다 */
  registerSource(src: TxnSource): void {
    if (src.kind !== 'auto' || !/^[a-z0-9_-]{1,40}$/.test(src.provider)) throw new BankError('bad_provider');
    this.sources.set(src.provider, src);
  }

  private now(): Date {
    return this.opts.now?.() ?? new Date();
  }
  private at(): string {
    return this.now().toISOString();
  }
  private today(): string {
    return kstDay(this.now());
  }

  async handle(method: string, p: Params): Promise<unknown> {
    // 최신화는 원천 수집이 오래 걸릴 수 있어 줄 밖에서 시작만 하고 바로 돌아온다(넣기·맞추기는 다시 줄을 탄다)
    if (method === 'bank.refresh' || method === 'db.query.bank.refreshStatus') {
      try {
        return method === 'bank.refresh' ? this.refresh(p ?? {}) : this.refreshStatus(p ?? {});
      } catch (e) {
        if (e instanceof ValidationError) throw new BankError(e.code);
        throw e;
      }
    }
    try {
      return await this.serial(() => this.dispatch(method, p ?? {}));
    } catch (e) {
      if (e instanceof ValidationError) throw new BankError(e.code);
      throw e;
    }
  }

  /** 명령은 한 줄로 차례대로 돈다 */
  private serial<T>(fn: () => T | Promise<T>): Promise<T> {
    const run = this.chain.then(fn);
    this.chain = run.catch(() => {});
    return run;
  }

  private profile(v: unknown): string {
    return typeof v === 'string' && v && new ProfileRepo(this.db).get(v) ? v : fail('profile_not_found');
  }
  private str(v: unknown, code: string, max = 128): string {
    return typeof v === 'string' && v && v.length <= max ? v : fail(code);
  }

  private async dispatch(method: string, p: Params): Promise<unknown> {
    switch (method) {
      case 'db.query.bank.accounts':
        return this.accounts(this.profile(p.profileId));
      case 'db.query.bank.overview':
        return this.overview(this.profile(p.profileId));
      case 'db.query.bank.summary':
        return this.summary(this.profile(p.profileId));
      case 'db.query.bank.receivable':
        return this.detail(this.profile(p.profileId), this.str(p.id, 'not_found'));
      case 'db.query.bank.counterparty':
        return this.cpBanking(this.str(p.counterpartyId, 'not_found'));
      case 'db.query.bank.format':
        return this.format(this.str(p.signature, 'bad_signature', 400));
      case 'bank.consent':
        return this.consent(this.profile(p.profileId), p);
      case 'bank.addAccount':
        if (!this.consentOf(this.profile(p.profileId))) return fail('consent_required');
        return this.repo.addAccount({ profileId: this.profile(p.profileId), bank: p.bank, number: p.number, alias: p.alias, usage: p.usage }, this.at());
      case 'bank.updateAccount':
        return this.repo.updateAccount(this.ownAccount(p), { alias: p.alias, usage: p.usage, bank: p.bank });
      case 'bank.deleteAccount':
        return this.repo.deleteAccount(this.ownAccount(p));
      case 'bank.setLink':
        return this.setLink(p);
      case 'bank.revealAccount':
        return { number: this.repo.revealAccount(this.ownAccount(p)) };
      case 'bank.importTxns':
        return this.importTxns(p);
      case 'bank.importInvoices':
        return this.importInvoices(p);
      case 'bank.rematch':
        return this.rematch(this.profile(p.profileId));
      case 'bank.accept':
        return this.accept(p);
      case 'bank.attach':
        return this.attach(p);
      case 'bank.detach':
        return this.detach(p);
      case 'bank.reject':
        return this.reject(p);
      case 'bank.markReceived':
        return this.markReceived(p);
      case 'bank.closeFee':
        return this.closeFee(p);
      case 'bank.ignoreTxn':
        return this.ignoreTxn(p);
      case 'bank.assignTxn':
        return this.assignTxn(p);
      case 'bank.setPromised':
        return this.setPromised(p);
      case 'bank.exclude':
        return this.exclude(p);
      case 'bank.undo':
        return this.undo(p);
      case 'bank.addCpAccount':
        return this.addCpAccount(p);
      case 'bank.deleteCpAccount':
        return { deleted: this.repo.deleteCpAccount(this.str(p.id, 'not_found')) };
      case 'bank.revealCpAccount':
        return { number: this.repo.revealCpAccount(this.str(p.id, 'not_found')) };
      case 'bank.addAlias':
        return this.addAlias(p);
      case 'bank.deleteAlias':
        return { deleted: this.repo.deleteAlias(this.str(p.id, 'not_found')) };
      case 'bank.setPayTerms':
        return { terms: this.repo.setPayTerms(this.str(p.counterpartyId, 'not_found'), p.terms) };
      case 'bank.setDefaultTerms':
        return this.setDefaultTerms(this.profile(p.profileId), p.terms);
    }
    return fail('unknown_method');
  }

  private ownAccount(p: Params): string {
    const pid = this.profile(p.profileId);
    const a = this.repo.account(this.str(p.id ?? p.accountId, 'account_not_found'));
    return a && a.profileId === pid ? a.id : fail('account_not_found');
  }

  private ownReceivable(pid: string, id: unknown): Receivable {
    const r = typeof id === 'string' ? this.repo.receivable(id) : null;
    return r && r.profileId === pid ? r : fail('not_found');
  }

  private ownTxn(pid: string, id: unknown): BankTxn {
    const t = typeof id === 'string' ? this.repo.txn(id) : null;
    return t && t.profileId === pid ? t : fail('txn_not_found');
  }

  // ---- 설정 ----

  private settingKey(pid: string, k: string) {
    return `profile.${pid}.bank.${k}`;
  }
  private getSetting<T>(key: string): T | null {
    const v = this.db.prepare('SELECT value_json FROM settings WHERE key = ?').pluck().get(key) as string | undefined;
    if (v === undefined) return null;
    try {
      return JSON.parse(v) as T;
    } catch {
      return null;
    }
  }
  private putSetting(key: string, v: unknown): void {
    this.db.prepare('INSERT INTO settings (key, value_json) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json').run(key, JSON.stringify(v));
  }

  defaultTerms(pid: string): PayTerms {
    try {
      return normalizePayTerms(this.getSetting(this.settingKey(pid, 'defaultTerms'))) ?? DEFAULT_TERMS;
    } catch {
      return DEFAULT_TERMS;
    }
  }
  private setDefaultTerms(pid: string, terms: unknown) {
    const t = normalizePayTerms(terms) ?? DEFAULT_TERMS;
    this.putSetting(this.settingKey(pid, 'defaultTerms'), t);
    return { terms: t };
  }

  /** 기억한 서식(사람이 고른 열). 서식 열쇠 = 머리글 글자 */
  private format(signature: string) {
    const all = this.getSetting<Record<string, unknown>>('bank.formats') ?? {};
    return { mapping: all[createHash('sha256').update(signature).digest('hex').slice(0, 24)] ?? null };
  }
  private rememberFormat(signature: unknown, mapping: unknown): void {
    if (typeof signature !== 'string' || !signature || signature.length > 400 || typeof mapping !== 'object' || mapping === null) return;
    if (JSON.stringify(mapping).length > 2000) return;
    const all = this.getSetting<Record<string, unknown>>('bank.formats') ?? {};
    all[createHash('sha256').update(signature).digest('hex').slice(0, 24)] = mapping;
    const keys = Object.keys(all);
    for (const k of keys.slice(0, Math.max(0, keys.length - 50))) delete all[k];
    this.putSetting('bank.formats', all);
  }

  /** 계좌 추가 동의(09 §9.4 첫 문구). 동의 기록(문구 판·시각)은 이 PC에만 둔다. 동의 전에는 계좌를 저장하지 않는다 */
  consentOf(pid: string): { version: string; at: string } | null {
    return this.getSetting<{ version: string; at: string }>(this.settingKey(pid, 'consent'));
  }
  private consent(pid: string, p: Params) {
    const version = typeof p.version === 'string' && /^[\w.-]{1,20}$/.test(p.version) ? p.version : fail('bad_version');
    const v = { version, at: this.at() };
    this.putSetting(this.settingKey(pid, 'consent'), v);
    return v;
  }

  // ---- 원본 파일 보관 ----

  private async keepFile(pid: string, docType: 'bank_statement' | 'hometax_issue_list', file: unknown): Promise<string | null> {
    if (file === undefined || file === null) return null;
    const f = file as { bytes?: unknown; ext?: unknown; displayName?: unknown };
    if (!(f.bytes instanceof Uint8Array) || f.bytes.length === 0 || f.bytes.length > BANK_FILE_MAX) return fail('input_size');
    const ext = typeof f.ext === 'string' && /^(xlsx|xls|csv|html)$/.test(f.ext) ? f.ext : 'bin';
    const sha256 = createHash('sha256').update(f.bytes).digest('hex');
    const prev = this.db.prepare('SELECT id FROM documents WHERE profile_id = ? AND doc_type = ? AND sha256 = ? LIMIT 1').pluck().get(pid, docType, sha256) as string | undefined;
    if (prev) return prev;
    const dir = this.opts.vaultDir;
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    const name = `${docType === 'bank_statement' ? 'bank' : 'hometax_list'}_${this.today().replace(/-/g, '')}_${randomBytes(4).toString('hex')}.${ext}`;
    const dest = path.join(dir, name);
    const fh = await fs.open(dest, 'wx', 0o600);
    try {
      await fh.writeFile(f.bytes);
      await fh.sync();
    } finally {
      await fh.close();
    }
    const display = typeof f.displayName === 'string' ? f.displayName.split(/[\\/]/).pop()!.slice(0, 100) : null;
    try {
      const id = randomUUID();
      new DocumentRepo(this.db).insert({ id, profileId: pid, docType, displayName: display || (docType === 'bank_statement' ? '은행 거래내역' : '홈택스 발급 목록'), issuedAt: null, expiresAt: null, issuer: null, path: dest, bytes: f.bytes.length, sha256, meta: { v: 1, source: 'pc_file', format: ext }, runId: null }, this.at());
      return id;
    } catch (e) {
      await fs.unlink(dest).catch(() => {});
      throw e;
    }
  }

  // ---- 내 계좌 ----

  private accounts(pid: string) {
    const last = this.db.prepare('SELECT max(day) FROM bank_txns WHERE account_id = ?').pluck();
    const count = this.db.prepare('SELECT count(*) FROM bank_txns WHERE account_id = ?').pluck();
    const lastImport = this.db.prepare('SELECT created_at FROM bank_imports WHERE account_id = ? ORDER BY created_at DESC LIMIT 1').pluck();
    return this.repo.accounts(pid).map((a) => ({ ...a, canRefresh: a.linkState !== 'file_only' && !!a.linkProvider && this.sources.has(a.linkProvider), refresh: this.jobView(this.jobs.get(a.id)), lastDay: (last.get(a.id) as string | null) ?? null, txnCount: Number(count.get(a.id)), lastImportAt: (lastImport.get(a.id) as string | undefined) ?? null }));
  }

  // ---- 원천 연결·최신화 ----

  /** bank.setLink {profileId, accountId, state: file_only|auto_connected|auto_error, provider?, error?} — 자동 연결 세션이 연결·끊기 때 부른다 */
  private setLink(p: Params) {
    const id = this.ownAccount(p);
    const state = p.state === 'file_only' || p.state === 'auto_connected' || p.state === 'auto_error' ? p.state : fail('bad_link_state');
    if (state === 'file_only') this.jobs.get(id)?.abort.abort();
    return this.repo.setLink(id, { state, provider: typeof p.provider === 'string' ? p.provider : null, error: typeof p.error === 'string' ? p.error : null }, this.at());
  }

  private jobView(j: (RefreshJob & { abort: AbortController }) | undefined): RefreshJob | null {
    if (!j) return null;
    return { id: j.id, accountId: j.accountId, state: j.state, done: j.done, jobs: j.jobs, range: { ...j.range }, startedAt: j.startedAt, finishedAt: j.finishedAt, code: j.code, retryAt: j.retryAt ?? null, result: j.result };
  }

  /** db.query.bank.refreshStatus {profileId, accountId} → RefreshJob | null */
  private refreshStatus(p: Params): RefreshJob | null {
    return this.jobView(this.jobs.get(this.ownAccount(p)));
  }

  /**
   * bank.refresh {profileId, accountId, from?, to?} → RefreshJob(시작 상태). 원천 수집 → 넣기(source auto) → 맞추기.
   * 기간 기본: 마지막 거래일 하루 전(없으면 90일 전) ~ 오늘. 이미 도는 중이면 그 진행을 돌려준다.
   * 실패하면 이미 들인 줄은 그대로 두고 계좌 연결 상태만 자동 오류(코드)로 바꾼다.
   */
  private refresh(p: Params): RefreshJob {
    const pid = this.profile(p.profileId);
    const id = this.ownAccount(p);
    const running = this.jobs.get(id);
    if (running && running.state !== 'done' && running.state !== 'failed') return this.jobView(running)!;
    const acct = this.repo.account(id)!;
    if (acct.linkState === 'file_only' || !acct.linkProvider) return fail('source.not_linked');
    const src = this.sources.get(acct.linkProvider) ?? fail('source.not_available');
    const today = this.today();
    const last = this.db.prepare('SELECT max(day) FROM bank_txns WHERE account_id = ?').pluck().get(id) as string | null;
    const from = typeof p.from === 'string' && ISO.test(p.from) ? p.from : last ? addDays(last, -1) : addDays(today, -90);
    const to = typeof p.to === 'string' && ISO.test(p.to) && p.to <= today ? p.to : today;
    if (from > to) return fail('bad_range');
    const job: RefreshJob & { abort: AbortController } = {
      id: randomUUID(), accountId: id, state: 'requested', range: { from, to }, startedAt: this.at(), finishedAt: null, code: null, result: null, abort: new AbortController(),
    };
    this.jobs.set(id, job);
    const first = this.jobView(job)!;
    void this.runRefresh(pid, acct.id, src, job);
    return first;
  }

  private async runRefresh(pid: string, accountId: string, src: TxnSource, job: RefreshJob & { abort: AbortController }) {
    const finish = (state: 'done' | 'failed', code: string | null) => {
      job.state = state;
      job.code = code;
      job.finishedAt = this.at();
    };
    try {
      const a = this.repo.account(accountId);
      const number = a ? this.repo.revealAccount(accountId) : null;
      if (!a || !number) throw new SourceError('source.not_linked');
      const onProgress = (pr: SourceProgress) => {
        if (job.state === 'done' || job.state === 'failed') return;
        if (pr.state === 'requested' || pr.state === 'waiting' || pr.state === 'running') {
          job.state = pr.state;
          if ('done' in pr && pr.done !== undefined) job.done = pr.done;
          if (pr.jobs !== undefined) job.jobs = pr.jobs;
        }
      };
      const got = await src.fetch({ id: a.id, profileId: pid, bank: a.bank, number, last4: a.last4 }, job.range, { onProgress, signal: job.abort.signal });
      if (job.abort.signal.aborted) throw new SourceError('source.cancelled');
      const rows = sourceRowsToInput(src.provider, Array.isArray(got?.rows) ? got.rows : []);
      // 넣기·맞추기는 다른 명령과 같은 줄에서(계좌가 그새 지워졌으면 account_not_found)
      const result = await this.serial(() => this.importAuto(pid, accountId, src.provider, rows, got?.range ?? job.range));
      job.result = { rows: rows.length, ...(result as Omit<NonNullable<RefreshJob['result']>, 'rows'>) };
      finish('done', null);
    } catch (e) {
      const code = e instanceof SourceError ? e.code : e instanceof BankError ? e.code : 'source.failed';
      if (e instanceof SourceError && e.retryAt) job.retryAt = e.retryAt;
      finish('failed', /^[a-z0-9_.-]{1,80}$/i.test(code) ? code : 'source.failed');
    }
    // 연결 상태는 줄에서 바꾼다(그새 계좌가 지워졌거나 연결을 끊었으면 그대로 둔다)
    await this.serial(() => {
      const a = this.repo.account(accountId);
      // 방금 가져와서 이번엔 부르지 않은 것(too_soon)은 연결 상태를 그대로 둔다
      if (!a || a.linkState === 'file_only' || job.code === 'source.too_soon') return;
      this.repo.setLink(accountId, job.code ? { state: 'auto_error', provider: src.provider, error: job.code } : { state: 'auto_connected', provider: src.provider }, this.at());
    }).catch(() => {});
  }

  /** 줄 안에서: 자동 원천 행 넣기 + 맞추기 */
  private importAuto(pid: string, accountId: string, provider: string, raw: Array<Record<string, unknown>>, range: unknown) {
    if (!this.repo.account(accountId)) return fail('account_not_found');
    const rows = this.txnRows(raw);
    if (!rows.length) return { newCount: 0, duplicateCount: 0, match: { auto: 0, review: 0, unknown: 0 } };
    const { import: imp, newIds } = this.repo.importTxns({ profileId: pid, accountId, source: 'auto', provider, documentId: null, format: { range }, rows }, this.at());
    const r = this.afterImport(pid, imp, rows.length, newIds);
    return { newCount: r.newCount, duplicateCount: r.duplicateCount, match: r.match };
  }

  // ---- 거래내역 넣기 ----

  private txnRows(v: unknown): TxnInput[] {
    if (!Array.isArray(v) || v.length > ROWS_MAX) return fail('bad_rows');
    const rows = v.map((r): Omit<TxnInput, 'rowKey'> & { sourceKey: string | null } => {
      const o = r as Record<string, unknown>;
      const day = typeof o.day === 'string' && ISO.test(o.day) ? o.day : fail('bad_rows');
      const occurredAt = typeof o.occurredAt === 'string' && o.occurredAt.startsWith(day) && o.occurredAt.length <= 19 ? o.occurredAt : fail('bad_rows');
      const direction = o.direction === 'in' || o.direction === 'out' ? o.direction : fail('bad_rows');
      const amount = Number.isSafeInteger(o.amount) && (o.amount as number) > 0 ? (o.amount as number) : fail('bad_rows');
      const balance = o.balance === null || o.balance === undefined ? null : Number.isSafeInteger(o.balance) ? (o.balance as number) : fail('bad_rows');
      const text = (x: unknown) => (typeof x === 'string' && x.trim() ? x.trim().slice(0, 120) : null);
      const sourceKey = typeof o.sourceKey === 'string' && /^[0-9a-f]{32}:(in|out)$/.test(o.sourceKey) ? o.sourceKey : null;
      return { day, occurredAt, direction, amount, balance, payer: text(o.payer), memo: text(o.memo), counterAccount: typeof o.counterAccount === 'string' ? o.counterAccount.slice(0, 40) : null, sourceKey };
    });
    const keys = rowKeys(rows);
    // 원천 고유 id가 있으면 그것이 줄 열쇠다(같은 거래를 다시 받아도 한 줄)
    return rows.map(({ sourceKey, ...r }, i) => ({ ...r, rowKey: sourceKey ? createHash('sha256').update(`src|${sourceKey}`).digest('hex').slice(0, 32) : keys[i]! }));
  }

  /**
   * bank.importTxns {profileId, accountId, rows, source?, signature?, mapping?, file?:{bytes, ext, displayName}}
   * → {import, newCount, duplicateCount, match:{auto, review, unknown}}. 새 줄만 맞추기에 들어간다(이미 있던 줄은 그대로).
   */
  private async importTxns(p: Params) {
    const pid = this.profile(p.profileId);
    const accountId = this.ownAccount({ profileId: pid, id: p.accountId });
    const rows = this.txnRows(p.rows);
    if (!rows.length) return fail('no_rows');
    const documentId = await this.keepFile(pid, 'bank_statement', p.file);
    const { import: imp, newIds } = this.repo.importTxns({ profileId: pid, accountId, source: 'file', documentId, format: p.mapping, rows }, this.at());
    this.rememberFormat(p.signature, p.mapping);
    return this.afterImport(pid, imp, rows.length, newIds);
  }

  private afterImport(pid: string, imp: unknown, total: number, newIds: string[]) {
    const m = this.rematch(pid);
    const fresh = new Set(newIds);
    return {
      import: imp,
      newCount: newIds.length,
      duplicateCount: total - newIds.length,
      match: { auto: m.autoTxnIds.filter((t) => fresh.has(t)).length, review: m.review.filter((t) => fresh.has(t)).length, unknown: m.unknown.filter((t) => fresh.has(t)).length },
    };
  }

  /**
   * bank.importInvoices {profileId, rows: HometaxInvoiceRow[], file?} → {created, merged, purchase, skipped}.
   * 같은 승인번호는 한 건으로 합친다(원장 건과도). 공급받는자가 내 사업자번호인 줄은 매입이라 이번 단계에서 받지 않는다(purchase로 센다).
   * 공급받는자 사업자번호가 장부에 없으면 거래처를 만든다(source hometax). 개인(주민번호)·번호 없음이면 이름만 둔다.
   */
  private async importInvoices(p: Params) {
    const pid = this.profile(p.profileId);
    if (!Array.isArray(p.rows) || p.rows.length > 5000) return fail('bad_rows');
    const me = new ProfileRepo(this.db).get(pid)?.bizNo?.replace(/\D/g, '') ?? null;
    this.syncLedger(pid);
    const cps = new CounterpartyRepo(this.db);
    const out = { created: 0, merged: 0, purchase: 0, skipped: 0, newCounterparties: 0 };
    const documentId = p.rows.length ? await this.keepFile(pid, 'hometax_issue_list', p.file) : null;
    const at = this.at();
    this.db.transaction(() => {
      for (const raw of p.rows as Array<Record<string, unknown>>) {
        const approval = typeof raw.approvalNo === 'string' ? raw.approvalNo.replace(/\D/g, '') : '';
        const writtenOn = typeof raw.writtenOn === 'string' && ISO.test(raw.writtenOn) ? raw.writtenOn : null;
        const total = Number.isSafeInteger(raw.total) && (raw.total as number) > 0 ? (raw.total as number) : null;
        if (approval.length !== 24 || !writtenOn || !total) {
          out.skipped++;
          continue;
        }
        const buyer = typeof raw.buyerBizNo === 'string' ? raw.buyerBizNo.replace(/\D/g, '') : '';
        const supplier = typeof raw.supplierBizNo === 'string' ? raw.supplierBizNo.replace(/\D/g, '') : '';
        if (me && buyer === me && supplier !== me) {
          out.purchase++;
          continue;
        }
        const text = (x: unknown) => (typeof x === 'string' && x.trim() ? x.trim().slice(0, 120) : null);
        let cpId: string | null = null;
        if (buyer.length === 10 && isValidBizNo(buyer)) {
          const cur = cps.byBizNo(buyer);
          if (cur) cpId = cur.id;
          else if (text(raw.buyerName)) {
            cpId = cps.create({ bizNo: buyer, name: text(raw.buyerName)!, repName: text(raw.buyerRep), source: 'hometax' }).id;
            out.newCounterparties++;
          }
        }
        const num = (x: unknown) => (Number.isSafeInteger(x) ? (x as number) : null);
        const r = this.repo.upsertReceivable(pid, { approvalNo: approval, counterpartyId: cpId, cpBizNo: buyer || null, cpName: text(raw.buyerName), cpRep: text(raw.buyerRep), item: text(raw.item), writtenOn, supply: num(raw.supply), tax: num(raw.tax), total, from: 'hometax' }, at);
        if (r.created) out.created++;
        else out.merged++;
      }
    })();
    const m = this.rematch(pid);
    return { ...out, documentId, match: { auto: m.autoTxnIds.length, review: m.review.length, unknown: m.unknown.length } };
  }

  /**
   * 원장(H-01 committed)에서 받을 돈 건을 들인다. 실행 입력 요약(runs.inputs_json_enc: 거래처·공급가·세액)을 읽을 수 있는 실행만.
   * 승인번호(verify_ref)가 있으면 그것으로 홈택스 목록 건과 합친다. 작성일은 원장 무장 시각의 한국 날짜다.
   */
  syncLedger(pid: string): number {
    const rows = this.db
      .prepare(`SELECT l.run_id, l.verify_ref, l.armed_at, r.inputs_json_enc FROM irreversible_log l JOIN runs r ON r.id = l.run_id
        WHERE l.state IN ('committed','observed_manual') AND r.profile_id = ? AND l.run_id NOT IN (SELECT run_id FROM receivables WHERE run_id IS NOT NULL)`)
      .all(pid) as Array<{ run_id: string; verify_ref: string | null; armed_at: string; inputs_json_enc: Uint8Array | null }>;
    if (!rows.length) return 0;
    const cps = new CounterpartyRepo(this.db);
    let n = 0;
    const at = this.at();
    for (const r of rows) {
      if (!(r.inputs_json_enc instanceof Uint8Array) || !r.inputs_json_enc.length) continue;
      let inputs: { counterpartyId?: unknown; supply?: unknown; tax?: unknown; v?: unknown };
      try {
        inputs = JSON.parse(this.cipher.open(r.inputs_json_enc, `runs.inputs_json_enc|${r.run_id}`));
      } catch {
        continue;
      }
      if (inputs.v !== 1 || typeof inputs.counterpartyId !== 'string' || !Number.isSafeInteger(inputs.supply) || !Number.isSafeInteger(inputs.tax)) continue;
      const total = (inputs.supply as number) + (inputs.tax as number);
      if (total <= 0) continue;
      const cp = cps.get(inputs.counterpartyId);
      const approval = r.verify_ref ? r.verify_ref.replace(/\D/g, '') : '';
      this.repo.upsertReceivable(pid, {
        approvalNo: approval.length === 24 ? approval : null, runId: r.run_id, counterpartyId: cp?.id ?? null, cpBizNo: cp?.bizNo ?? null, cpName: cp?.name ?? null, cpRep: cp?.repName ?? null, item: null,
        writtenOn: kstDay(new Date(r.armed_at)), supply: inputs.supply as number, tax: inputs.tax as number, total, from: 'ledger',
      }, at);
      n++;
    }
    return n;
  }

  // ---- 맞추기 ----

  private cpKeyOf(r: Receivable): string {
    return r.counterpartyId ?? (r.cpBizNo ? `biz:${r.cpBizNo}` : `r:${r.id}`);
  }

  private remainingOf(pid: string): Map<string, number> {
    const paid = new Map<string, number>();
    for (const a of this.repo.liveAllocs(pid)) paid.set(a.receivableId, (paid.get(a.receivableId) ?? 0) + a.amount);
    return paid;
  }

  private dueOf(r: Receivable, termsCache: Map<string, PayTerms>, def: PayTerms): string | null {
    let t = def;
    if (r.counterpartyId) {
      if (!termsCache.has(r.counterpartyId)) termsCache.set(r.counterpartyId, this.repo.payTerms(r.counterpartyId) ?? def);
      t = termsCache.get(r.counterpartyId)!;
    }
    return dueDate(r.writtenOn, t);
  }

  private matchInput(pid: string) {
    const recvs = this.repo.receivables(pid);
    const paid = this.remainingOf(pid);
    const def = this.defaultTerms(pid);
    const terms = new Map<string, PayTerms>();
    const human = new Set(
      (this.db.prepare(`SELECT DISTINCT r.counterparty_id FROM receivable_allocs a JOIN receivables r ON r.id = a.receivable_id WHERE a.profile_id = ? AND a.removed_at IS NULL AND a.decided_by <> 'auto' AND a.txn_id IS NOT NULL AND r.counterparty_id IS NOT NULL`).pluck().all(pid) as string[]),
    );
    const cpMap = new Map<string, MatchCounterparty>();
    const cpRepo = new CounterpartyRepo(this.db);
    for (const r of recvs) {
      const key = this.cpKeyOf(r);
      if (cpMap.has(key)) continue;
      const cp = r.counterpartyId ? cpRepo.get(r.counterpartyId) : null;
      cpMap.set(key, {
        key, name: cp?.name ?? r.cpName, rep: cp?.repName ?? r.cpRep,
        aliases: r.counterpartyId ? this.repo.aliases(r.counterpartyId).map((a) => a.nameNorm) : [],
        holders: r.counterpartyId ? this.repo.cpAccounts(r.counterpartyId).map((a) => normalizePayerName(a.holder)).filter((h) => h.length >= 2) : [],
        accountHmacs: r.counterpartyId ? this.db.prepare('SELECT number_hmac FROM cp_bank_accounts WHERE counterparty_id = ?').pluck().all(r.counterpartyId) as string[] : [],
        humanConfirmed: !!r.counterpartyId && human.has(r.counterpartyId),
      });
    }
    const receivables: MatchReceivable[] = recvs
      .filter((r) => !r.excludedAt)
      .map((r) => ({ id: r.id, cpKey: this.cpKeyOf(r), writtenOn: r.writtenOn, dueOn: r.promisedOn ?? this.dueOf(r, terms, def), remaining: r.total - (paid.get(r.id) ?? 0) }));
    const used = new Map<string, number>();
    for (const a of this.repo.liveAllocs(pid)) if (a.txnId) used.set(a.txnId, (used.get(a.txnId) ?? 0) + a.amount);
    const txns: MatchTxn[] = this.repo
      .txns(pid, { direction: 'in' })
      .filter((t) => !t.ignoredAt)
      .map((t) => ({ id: t.id, day: t.day, amount: t.amount, unallocated: t.amount - (used.get(t.id) ?? 0), payer: t.payer, counterAccountHmac: t.counterAccountHmac, assignedCpKey: t.assignedCounterpartyId }));
    return { recvs, receivables, txns, cps: [...cpMap.values()], rejects: this.repo.rejects(pid) };
  }

  /** 다시 맞추기: 자동 확정을 적용하고(기록 남김) 후보·미지정 줄 id를 돌려준다. 사람이 한 것은 바꾸지 않는다 */
  rematch(pid: string): { autoTxnIds: string[]; review: string[]; unknown: string[]; candidates: Map<string, Candidate[]> } {
    this.syncLedger(pid);
    const input = this.matchInput(pid);
    const res = runMatch({ counterparties: input.cps, receivables: input.receivables, txns: input.txns, rejects: input.rejects, feeTolerance: FEE_TOLERANCE });
    const at = this.at();
    this.db.transaction(() => {
      for (const a of res.auto) {
        const alloc = this.repo.addAlloc({ profileId: pid, receivableId: a.receivableId, txnId: a.txnId, amount: a.amount, method: 'account', decidedBy: 'auto', reason: a.signal }, at);
        this.repo.addEvent(pid, { receivableId: a.receivableId, txnId: a.txnId, allocId: alloc.id, actor: 'auto', action: 'attach', reason: a.signal, undoOf: null }, at);
      }
    })();
    const review: string[] = [];
    const unknown: string[] = [];
    for (const [t, c] of res.candidates) (c.length ? review : unknown).push(t);
    return { autoTxnIds: res.auto.map((a) => a.txnId), review, unknown, candidates: res.candidates };
  }

  // ---- 보기 ----

  private views(pid: string): { list: ReceivableView[]; byId: Map<string, ReceivableView> } {
    this.syncLedger(pid);
    const today = this.today();
    const latestDay = this.repo.latestDay(pid);
    const stale = !latestDay || latestDay < addDays(today, -STALE_DAYS);
    const def = this.defaultTerms(pid);
    const terms = new Map<string, PayTerms>();
    const allocs = this.repo.liveAllocs(pid);
    const byRecv = new Map<string, Alloc[]>();
    for (const a of allocs) byRecv.set(a.receivableId, [...(byRecv.get(a.receivableId) ?? []), a]);
    const cps = new CounterpartyRepo(this.db);
    const list = this.repo.receivables(pid).map((r): ReceivableView => {
      const as = byRecv.get(r.id) ?? [];
      const received = as.reduce((s, a) => s + a.amount, 0);
      const remaining = Math.max(0, r.total - received);
      const due = this.dueOf(r, terms, def);
      const waiting = !!r.promisedOn && r.promisedOn >= today;
      const status: ReceivableStatus = r.excludedAt ? 'excluded' : remaining === 0 ? 'received' : waiting ? 'waiting' : received > 0 ? 'partial' : stale ? 'unknown' : 'unpaid';
      const eff = r.promisedOn ?? due;
      const dueIn = eff ? Math.round((Date.parse(`${eff}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000) : null;
      const off = as.find((a) => a.txnId === null && a.method !== 'fee');
      return {
        id: r.id, counterpartyId: r.counterpartyId, cpName: (r.counterpartyId ? cps.get(r.counterpartyId)?.name : null) ?? r.cpName, cpBizNo: r.cpBizNo, item: r.item,
        approvalTail: r.approvalNo ? r.approvalNo.slice(-8) : null, writtenOn: r.writtenOn, total: r.total, received, remaining, dueOn: due, promisedOn: r.promisedOn, dueIn,
        overdue: (status === 'unpaid' || status === 'partial') && dueIn !== null && dueIn < 0,
        status, via: status === 'received' ? (as.every((a) => a.decidedBy === 'auto' || a.method === 'fee') ? 'auto' : 'manual') : null,
        offAccount: off?.method ?? null, sources: [...(r.fromLedger ? ['ledger' as const] : []), ...(r.fromHometax ? ['hometax' as const] : [])], excludedReason: r.excludedReason,
      };
    });
    return { list, byId: new Map(list.map((v) => [v.id, v])) };
  }

  private txnView(t: BankTxn, unallocated: number, acct: Map<string, { last4: string; bank: string }>, cands: Candidate[], views: Map<string, ReceivableView>): TxnView {
    const a = acct.get(t.accountId);
    return {
      id: t.id, accountId: t.accountId, accountLast4: a?.last4 ?? '', bank: a?.bank ?? '', day: t.day, occurredAt: t.occurredAt, direction: t.direction, amount: t.amount, unallocated,
      payer: t.payer, memo: t.memo, ignoredReason: t.ignoredReason, assignedCounterpartyId: t.assignedCounterpartyId,
      candidates: cands.map((c) => {
        const v = views.get(c.receivableIds[0]!);
        return { receivableIds: c.receivableIds, cpName: v?.cpName ?? null, fit: c.fit, amounts: c.amounts, feeGap: c.feeGap, reason: c.reason, writtenOn: v?.writtenOn ?? '', total: c.receivableIds.reduce((s, id) => s + (views.get(id)?.total ?? 0), 0) };
      }),
    };
  }

  /** D-09 목록: 못 받은 돈·받은 돈·확인할 입금(후보·미지정)·전체 입금 */
  overview(pid: string) {
    const m = this.rematch(pid);
    const { list, byId } = this.views(pid);
    const acct = new Map(this.repo.accounts(pid).map((a) => [a.id, { last4: a.last4, bank: a.bank }]));
    const used = new Map<string, number>();
    for (const a of this.repo.liveAllocs(pid)) if (a.txnId) used.set(a.txnId, (used.get(a.txnId) ?? 0) + a.amount);
    const txns = this.repo.txns(pid, { direction: 'in' });
    const review: TxnView[] = [];
    const recent: TxnView[] = [];
    for (const t of [...txns].reverse()) {
      const un = t.amount - (used.get(t.id) ?? 0);
      const v = this.txnView(t, un, acct, m.candidates.get(t.id) ?? [], byId);
      if (!t.ignoredAt && un > 0) review.push(v);
      if (recent.length < 200) recent.push(v);
    }
    const unpaid = list.filter((v) => v.status === 'unpaid' || v.status === 'unknown' || v.status === 'partial' || v.status === 'waiting').sort((a, b) => (a.dueIn ?? 99999) - (b.dueIn ?? 99999) || (a.writtenOn < b.writtenOn ? -1 : 1));
    const received = list.filter((v) => v.status === 'received').sort((a, b) => (a.writtenOn < b.writtenOn ? 1 : -1));
    const excluded = list.filter((v) => v.status === 'excluded');
    return { consent: this.consentOf(pid), summary: this.summaryOf(pid, list, review), unpaid, received, excluded, review, recent, accounts: this.accounts(pid), defaultTerms: this.defaultTerms(pid) };
  }

  private summaryOf(pid: string, list: ReceivableView[], review: TxnView[]): BankSummary {
    const today = this.today();
    const latestDay = this.repo.latestDay(pid);
    const stale = !latestDay || latestDay < addDays(today, -STALE_DAYS);
    const open = list.filter((v) => v.status === 'unpaid' || v.status === 'unknown' || v.status === 'partial');
    const over = open.filter((v) => v.overdue).sort((a, b) => (a.dueIn ?? 0) - (b.dueIn ?? 0));
    const autoCount = this.db.prepare(`SELECT count(*) FROM receivable_allocs WHERE profile_id = ? AND removed_at IS NULL AND decided_by = 'auto'`).pluck().get(pid) as number;
    return {
      today, latestDay, stale, hasAccounts: this.repo.accounts(pid).length > 0,
      unpaidCount: open.length, unpaidTotal: open.reduce((s, v) => s + v.remaining, 0),
      overdueCount: over.length, overdueTotal: over.reduce((s, v) => s + v.remaining, 0),
      oldestOverdue: over[0] ? { cpName: over[0].cpName, writtenOn: over[0].writtenOn, daysOver: -(over[0].dueIn ?? 0) } : null,
      reviewCount: review.filter((t) => !t.ignoredReason).length, autoCount,
    };
  }

  /** 판 카드·대화용 요약(목록 없음) */
  summary(pid: string): BankSummary {
    return this.overview(pid).summary;
  }

  /** 건 상세: 붙은 입금·기록·붙일 수 있는 입금(창 안의 남은 입금) */
  private detail(pid: string, id: string) {
    const r = this.ownReceivable(pid, id);
    const m = this.rematch(pid);
    const { byId } = this.views(pid);
    const view = byId.get(r.id)!;
    const acct = new Map(this.repo.accounts(pid).map((a) => [a.id, { last4: a.last4, bank: a.bank }]));
    const allocs = this.repo.allocsOf(r.id).map((a) => {
      const t = a.txnId ? this.repo.txn(a.txnId) : null;
      return { ...a, txn: t ? { day: t.day, amount: t.amount, payer: t.payer, accountLast4: acct.get(t.accountId)?.last4 ?? '' } : null };
    });
    const used = new Map<string, number>();
    for (const a of this.repo.liveAllocs(pid)) if (a.txnId) used.set(a.txnId, (used.get(a.txnId) ?? 0) + a.amount);
    const from = addDays(r.writtenOn, -30);
    const to = addDays(r.promisedOn ?? view.dueOn ?? r.writtenOn, 90);
    const attachable = this.repo
      .txns(pid, { direction: 'in', from, to })
      .filter((t) => !t.ignoredAt && t.amount - (used.get(t.id) ?? 0) > 0)
      .map((t) => this.txnView(t, t.amount - (used.get(t.id) ?? 0), acct, (m.candidates.get(t.id) ?? []).filter((c) => c.receivableIds.includes(r.id)), byId))
      .sort((a, b) => b.candidates.length - a.candidates.length || (a.day < b.day ? 1 : -1))
      .slice(0, 50);
    const events = this.repo.events(r.id).map((e) => ({ ...e, undone: this.repo.undone(pid, e.seq) }));
    return { receivable: view, allocs, events, attachable };
  }

  private cpBanking(cpId: string) {
    if (!new CounterpartyRepo(this.db).get(cpId)) return fail('not_found');
    return { accounts: this.repo.cpAccounts(cpId), aliases: this.repo.aliases(cpId), terms: this.repo.payTerms(cpId) };
  }

  // ---- 사람이 하는 일(모두 기록·되돌리기) ----

  private event(pid: string, e: Omit<ReceivableEvent, 'seq' | 'at' | 'actor'> & { actor?: ReceivableEvent['actor'] }): number {
    return this.repo.addEvent(pid, { actor: 'user', ...e }, this.at());
  }

  private txnFree(pid: string, txnId: string): number {
    const t = this.repo.txn(txnId)!;
    return t.amount - this.repo.liveAllocs(pid, { txnId }).reduce((s, a) => s + a.amount, 0);
  }

  private recvFree(pid: string, r: Receivable): number {
    return r.total - this.repo.liveAllocs(pid, { receivableId: r.id }).reduce((s, a) => s + a.amount, 0);
  }

  /** 한 줄을 건(들)에 붙인다. 한 줄은 한 거래처의 건들에만(09 §6.4) */
  private allocate(pid: string, txn: BankTxn, recvs: Receivable[], amounts: number[] | null, decidedBy: 'candidate' | 'manual', reason: string | null): number[] {
    if (txn.direction !== 'in') return fail('not_incoming');
    const keys = new Set(recvs.map((r) => this.cpKeyOf(r)));
    if (keys.size !== 1) return fail('mixed_counterparties');
    const others = this.repo.liveAllocs(pid, { txnId: txn.id }).map((a) => this.repo.receivable(a.receivableId)!).filter(Boolean);
    if (others.some((o) => this.cpKeyOf(o) !== [...keys][0])) return fail('mixed_counterparties');
    let free = this.txnFree(pid, txn.id);
    const seqs: number[] = [];
    const at = this.at();
    this.db.transaction(() => {
      recvs.forEach((r, i) => {
        const want = Math.min(amounts?.[i] ?? Infinity, this.recvFree(pid, r), free);
        if (!(want > 0)) return fail('nothing_to_attach');
        const a = this.repo.addAlloc({ profileId: pid, receivableId: r.id, txnId: txn.id, amount: want, method: 'account', decidedBy, reason }, at);
        this.repo.removeReject(r.id, txn.id);
        free -= want;
        seqs.push(this.event(pid, { receivableId: r.id, txnId: txn.id, allocId: a.id, action: 'attach', reason, undoOf: null }));
      });
    })();
    return seqs;
  }

  /** 거래처가 장부에 없으면(홈택스 목록 건의 번호만 있는 경우) 만든다. 별칭·계좌를 붙일 자리 */
  private ensureCounterparty(r: Receivable): string | null {
    if (r.counterpartyId) return r.counterpartyId;
    if (!r.cpBizNo || !isValidBizNo(r.cpBizNo) || !r.cpName) return null;
    const cps = new CounterpartyRepo(this.db);
    const id = cps.byBizNo(r.cpBizNo)?.id ?? cps.create({ bizNo: r.cpBizNo, name: r.cpName, repName: r.cpRep, source: 'hometax' }).id;
    this.db.prepare('UPDATE receivables SET counterparty_id = ? WHERE profile_id = ? AND cp_biz_no = ? AND counterparty_id IS NULL').run(id, r.profileId, r.cpBizNo);
    return id;
  }

  /** 별칭 제안(09 §7.3): 이 입금자 이름이 이 거래처 별칭이 아니고, 다른 거래처 별칭도 아니면 제안 */
  private aliasOffer(txn: BankTxn, cpId: string | null): { name: string; counterpartyId: string; conflict: boolean } | null {
    if (!cpId || !txn.payer) return null;
    const norm = normalizePayerName(txn.payer);
    if (norm.length < 2) return null;
    const owners = this.repo.aliasOwners(norm);
    if (owners.includes(cpId)) return null;
    return { name: txn.payer, counterpartyId: cpId, conflict: owners.length > 0 };
  }

  /** bank.accept {profileId, txnId, receivableIds, closeFee?}: 후보 [맞아요] */
  private accept(p: Params) {
    const pid = this.profile(p.profileId);
    const txn = this.ownTxn(pid, p.txnId);
    if (!Array.isArray(p.receivableIds) || !p.receivableIds.length || p.receivableIds.length > 10) return fail('bad_request');
    const recvs = p.receivableIds.map((id) => this.ownReceivable(pid, id));
    const seqs = this.allocate(pid, txn, recvs, null, 'candidate', 'confirmed');
    if (p.closeFee === true && recvs.length === 1) {
      const gap = this.recvFree(pid, recvs[0]!);
      if (gap > 0 && gap <= FEE_TOLERANCE) seqs.push(...this.closeFeeNow(pid, recvs[0]!, gap));
    }
    const cpId = this.ensureCounterparty(recvs[0]!);
    return { seqs, aliasOffer: this.aliasOffer(txn, cpId) };
  }

  /** bank.attach {profileId, txnId, receivableId, amount?}: [입금 붙이기] */
  private attach(p: Params) {
    const pid = this.profile(p.profileId);
    const txn = this.ownTxn(pid, p.txnId);
    const r = this.ownReceivable(pid, p.receivableId);
    const amount = p.amount === undefined ? null : Number.isSafeInteger(p.amount) && (p.amount as number) > 0 ? (p.amount as number) : fail('bad_amount');
    const seqs = this.allocate(pid, txn, [r], amount === null ? null : [amount], 'manual', null);
    return { seqs, aliasOffer: this.aliasOffer(txn, this.ensureCounterparty(r)) };
  }

  /** bank.detach {profileId, allocId}: [떼기]. 뗀 (줄, 건) 짝은 다시 후보로 내지 않는다 */
  private detach(p: Params) {
    const pid = this.profile(p.profileId);
    const a = typeof p.allocId === 'string' ? this.repo.alloc(p.allocId) : null;
    if (!a || a.profileId !== pid || a.removedAt) return fail('not_found');
    const at = this.at();
    const seq = this.db.transaction(() => {
      this.repo.removeAlloc(a.id, 'user', at);
      if (a.txnId) this.repo.addReject(a.receivableId, a.txnId, at);
      return this.event(pid, { receivableId: a.receivableId, txnId: a.txnId, allocId: a.id, action: 'detach', reason: a.decidedBy === 'auto' ? 'auto_wrong' : null, undoOf: null });
    })();
    return { seq };
  }

  /** bank.reject {profileId, txnId, receivableId}: 후보 [아니에요] */
  private reject(p: Params) {
    const pid = this.profile(p.profileId);
    const txn = this.ownTxn(pid, p.txnId);
    const r = this.ownReceivable(pid, p.receivableId);
    this.repo.addReject(r.id, txn.id, this.at());
    return { seq: this.event(pid, { receivableId: r.id, txnId: txn.id, allocId: null, action: 'reject', reason: null, undoOf: null }) };
  }

  /** bank.markReceived {profileId, receivableId, amount?, on?, method, memo?}: [받았음 표시](계좌 밖 결제 포함) */
  private markReceived(p: Params) {
    const pid = this.profile(p.profileId);
    const r = this.ownReceivable(pid, p.receivableId);
    const method = METHODS.includes(p.method as AllocMethod) ? (p.method as AllocMethod) : fail('bad_method');
    const free = this.recvFree(pid, r);
    if (free <= 0) return fail('already_received');
    const amount = p.amount === undefined || p.amount === null ? free : Number.isSafeInteger(p.amount) && (p.amount as number) > 0 && (p.amount as number) <= free ? (p.amount as number) : fail('bad_amount');
    const on = p.on === undefined || p.on === null ? this.today() : typeof p.on === 'string' && ISO.test(p.on) ? p.on : fail('bad_date');
    const at = this.at();
    const seq = this.db.transaction(() => {
      const a = this.repo.addAlloc({ profileId: pid, receivableId: r.id, txnId: null, amount, method, decidedBy: 'manual', reason: 'marked', receivedOn: on, memo: p.memo }, at);
      return this.event(pid, { receivableId: r.id, txnId: null, allocId: a.id, action: 'mark_received', reason: method, undoOf: null });
    })();
    return { seq };
  }

  private closeFeeNow(pid: string, r: Receivable, gap: number): number[] {
    const a = this.repo.addAlloc({ profileId: pid, receivableId: r.id, txnId: null, amount: gap, method: 'fee', decidedBy: 'manual', reason: 'fee_gap', receivedOn: this.today() }, this.at());
    return [this.event(pid, { receivableId: r.id, txnId: null, allocId: a.id, action: 'close_fee', reason: String(gap), undoOf: null })];
  }

  /** bank.closeFee {profileId, receivableId}: [차액은 수수료로 닫기](허용치 안의 남은 돈만) */
  private closeFee(p: Params) {
    const pid = this.profile(p.profileId);
    const r = this.ownReceivable(pid, p.receivableId);
    const gap = this.recvFree(pid, r);
    if (gap <= 0 || gap > FEE_TOLERANCE) return fail('gap_out_of_range');
    return { seqs: this.closeFeeNow(pid, r, gap) };
  }

  /** bank.ignoreTxn {profileId, txnId, reason|null}: [상관없는 입금](이자·내 돈 옮김 등). null이면 되돌림 */
  private ignoreTxn(p: Params) {
    const pid = this.profile(p.profileId);
    const t = this.ownTxn(pid, p.txnId);
    const reason = p.reason === null ? null : typeof p.reason === 'string' && /^(unrelated|interest|own_transfer|card_sales|other)$/.test(p.reason) ? p.reason : fail('bad_reason');
    this.repo.setIgnored(t.id, reason, this.at());
    return { seq: this.event(pid, { receivableId: null, txnId: t.id, allocId: null, action: reason ? 'ignore' : 'unignore', reason: t.ignoredReason, undoOf: null }) };
  }

  /**
   * bank.assignTxn {profileId, txnId, counterpartyId, remember}: [이 거래처 입금으로].
   * remember면 입금자 이름을 그 거래처 별칭으로 기억한다(다른 거래처 별칭이면 기억하지 않고 conflict). 아니면 이 줄만 그 거래처로.
   * 결과로 그 줄의 새 후보(맞추기를 다시 돈 뒤)를 돌려준다.
   */
  private assignTxn(p: Params) {
    const pid = this.profile(p.profileId);
    const t = this.ownTxn(pid, p.txnId);
    const cpId = typeof p.counterpartyId === 'string' && new CounterpartyRepo(this.db).get(p.counterpartyId) ? p.counterpartyId : fail('not_found');
    let alias: { id: string } | null = null;
    let conflict = false;
    this.repo.assignTxn(t.id, cpId);
    if (p.remember === true && t.payer) {
      const norm = normalizePayerName(t.payer);
      const owners = this.repo.aliasOwners(norm).filter((o) => o !== cpId);
      if (owners.length) conflict = true;
      else if (norm.length >= 2) alias = this.repo.addAlias(cpId, t.payer, 'learned', this.at());
    }
    const seq = this.event(pid, { receivableId: null, txnId: t.id, allocId: alias?.id ?? null, action: alias ? 'alias_learned' : 'assign', reason: cpId, undoOf: null });
    const m = this.rematch(pid);
    const { byId } = this.views(pid);
    const acct = new Map(this.repo.accounts(pid).map((a) => [a.id, { last4: a.last4, bank: a.bank }]));
    const auto = m.autoTxnIds.includes(t.id);
    return { seq, conflict, aliasId: alias?.id ?? null, auto, txn: this.txnView(this.repo.txn(t.id)!, this.txnFree(pid, t.id), acct, m.candidates.get(t.id) ?? [], byId) };
  }

  /** bank.setPromised {profileId, receivableId, on|null}: [기다리는 중으로] */
  private setPromised(p: Params) {
    const pid = this.profile(p.profileId);
    const r = this.ownReceivable(pid, p.receivableId);
    const on = p.on === null ? null : typeof p.on === 'string' && ISO.test(p.on) ? p.on : fail('bad_date');
    this.repo.setPromised(r.id, on, this.at());
    return { seq: this.event(pid, { receivableId: r.id, txnId: null, allocId: null, action: 'promise', reason: r.promisedOn, undoOf: null }) };
  }

  /** bank.exclude {profileId, receivableId, reason|null}: [목록에서 빼기]. null이면 되살림 */
  private exclude(p: Params) {
    const pid = this.profile(p.profileId);
    const r = this.ownReceivable(pid, p.receivableId);
    const reason = p.reason === null ? null : typeof p.reason === 'string' && p.reason.trim() && p.reason.length <= 200 ? p.reason.trim() : fail('bad_reason');
    this.repo.setExcluded(r.id, reason, this.at());
    return { seq: this.event(pid, { receivableId: r.id, txnId: null, allocId: null, action: 'exclude', reason: r.excludedReason, undoOf: null }) };
  }

  /**
   * bank.undo {profileId, seq}: 기록 하나를 되돌린다(지우지 않고 반대 동작을 더한다, 09 §7.5). 이미 되돌린 것은 already_undone.
   * attach·mark_received·close_fee → 맞춤 떼기(뗀 짝 표시는 하지 않음), detach → 되살림, reject → 짝 표시 지움,
   * promise·exclude·ignore → 이전 값으로, alias_learned → 별칭 지움, assign → 지정 지움.
   */
  private undo(p: Params) {
    const pid = this.profile(p.profileId);
    const seq = Number.isSafeInteger(p.seq) ? (p.seq as number) : fail('not_found');
    const e = this.repo.event(pid, seq) ?? fail('not_found');
    if (e.undoOf !== null) return fail('cannot_undo');
    if (this.repo.undone(pid, seq)) return fail('already_undone');
    const at = this.at();
    const out = this.db.transaction(() => {
      switch (e.action) {
        case 'attach':
        case 'mark_received':
        case 'close_fee': {
          const a = e.allocId ? this.repo.alloc(e.allocId) : null;
          if (a && !a.removedAt) this.repo.removeAlloc(a.id, 'undo', at);
          break;
        }
        case 'detach': {
          const a = e.allocId ? this.repo.alloc(e.allocId) : null;
          if (!a || !a.removedAt) return fail('cannot_undo');
          if (a.txnId && this.txnFree(pid, a.txnId) < a.amount) return fail('txn_used_elsewhere');
          const r = this.repo.receivable(a.receivableId)!;
          if (this.recvFree(pid, r) < a.amount) return fail('receivable_settled');
          this.repo.restoreAlloc(a.id);
          if (a.txnId) this.repo.removeReject(a.receivableId, a.txnId);
          break;
        }
        case 'reject':
          if (e.receivableId && e.txnId) this.repo.removeReject(e.receivableId, e.txnId);
          break;
        case 'promise':
          this.repo.setPromised(e.receivableId!, e.reason, at);
          break;
        case 'exclude':
          this.repo.setExcluded(e.receivableId!, e.reason, at);
          break;
        case 'ignore':
        case 'unignore':
          if (e.txnId) this.repo.setIgnored(e.txnId, e.reason, at);
          break;
        case 'alias_learned':
          if (e.allocId) this.repo.deleteAlias(e.allocId);
          if (e.txnId) this.repo.assignTxn(e.txnId, null);
          break;
        case 'assign':
          if (e.txnId) this.repo.assignTxn(e.txnId, null);
          break;
        default:
          return fail('cannot_undo');
      }
      return this.repo.addEvent(pid, { receivableId: e.receivableId, txnId: e.txnId, allocId: e.allocId, actor: 'user', action: 'undo', reason: e.action, undoOf: seq }, at);
    })();
    return { seq: out };
  }

  private addCpAccount(p: Params) {
    const cpId = this.str(p.counterpartyId, 'not_found');
    const a = this.repo.addCpAccount({ counterpartyId: cpId, bank: p.bank, number: p.number, holder: p.holder, usage: p.usage, memo: p.memo }, this.at());
    // 예금주를 별칭 후보로 제안한다(자동으로 넣지 않는다, 09 §7.3). 예금주 자체는 S3 신호로 쓰인다.
    return { account: a, holderOffer: a.holder && !this.repo.aliasOwners(normalizePayerName(a.holder)).includes(cpId) ? a.holder : null };
  }

  private addAlias(p: Params) {
    const cpId = this.str(p.counterpartyId, 'not_found');
    const norm = normalizePayerName(typeof p.name === 'string' ? p.name : '');
    const others = this.repo.aliasOwners(norm).filter((o) => o !== cpId);
    if (others.length) return fail('alias_conflict');
    const source = p.source === 'holder' || p.source === 'learned' ? p.source : 'manual';
    return this.repo.addAlias(cpId, p.name, source, this.at());
  }

  dispose(): void {
    for (const j of this.jobs.values()) j.abort.abort();
    this.repo.dispose();
  }
}
