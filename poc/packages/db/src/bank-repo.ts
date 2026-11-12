// 돈 맞추기 저장소(09 §9.1, 스키마 v9). 내 계좌·거래처 계좌·입금자 별칭·입출금 줄·받을 돈 건·맞춤(배분)·기록.
// - 계좌번호는 컬럼 키로 감싼 칸(number_enc, AAD = "<table>.number_enc:<id>") + 찾기용 HMAC(number_hmac) + 끝 4자리만 평문.
//   HMAC 키는 DB 키에서 HKDF로 파생한다(엔진 entry, info "SAX-bank-hmac-v1"). 원장 cp_biz_no_hmac와 같은 방식이다.
// - 입금자명·적요·예금주는 DB 기본 암호화(SQLCipher)만. 화면·대화로 원문을 보내는 것은 엔진 서비스가 정한다.
// - 입출금 줄은 (계좌, 줄 열쇠)로 한 번만 들어간다(INSERT OR IGNORE). 줄 열쇠는 엔진이 만든다(계좌·일시·방향·금액·잔액·같은 값 순번).
// - 맞춤은 지우지 않는다: 떼기·되돌리기는 removed_at을 채운다. 기록(receivable_events)은 더하기만 한다.
import { createHash, createHmac, randomUUID } from 'node:crypto';
import type { ColumnCipher } from './column.ts';
import type { Db } from './open.ts';
import { ValidationError } from './repo.ts';

export type BankUsage = 'in' | 'out' | 'both';
/** 거래내역 원천: 파일 | 자동 연결(공급자는 bank_imports.provider) */
export type BankImportSource = 'file' | 'auto';
/** 계좌의 원천 연결 상태: 파일만 / 자동 연결됨 / 자동 오류 */
export type BankLinkState = 'file_only' | 'auto_connected' | 'auto_error';
export type AllocMethod = 'account' | 'cash' | 'other_account' | 'offset' | 'other' | 'fee';
export type AllocDecider = 'auto' | 'candidate' | 'manual';
export type AliasSource = 'manual' | 'learned' | 'holder';
export type EventActor = 'auto' | 'user' | 'rematch';

/** 결제 조건(거래처별, 없으면 사업장 기본). days: 작성일 + n일, next_month_day: 다음 달 d일, month_end: 다음 달 말일, none: 기한 없음 */
export type PayTerms = { kind: 'days'; n: number } | { kind: 'next_month_day'; d: number } | { kind: 'month_end' } | { kind: 'none' };

export interface BankAccount {
  id: string;
  profileId: string;
  bank: string;
  last4: string;
  alias: string | null;
  usage: BankUsage;
  linkState: BankLinkState;
  linkProvider: string | null;
  linkError: string | null;
  linkCheckedAt: string | null;
  createdAt: string;
}

export interface CpBankAccount {
  id: string;
  counterpartyId: string;
  bank: string | null;
  last4: string;
  holder: string | null;
  usage: BankUsage;
  memo: string | null;
  createdAt: string;
}

export interface PayerAlias {
  id: string;
  counterpartyId: string;
  nameNorm: string;
  nameRaw: string;
  source: AliasSource;
  createdAt: string;
}

export interface BankTxn {
  id: string;
  profileId: string;
  accountId: string;
  importId: string;
  rowKey: string;
  occurredAt: string;
  day: string;
  direction: 'in' | 'out';
  amount: number;
  balance: number | null;
  payer: string | null;
  memo: string | null;
  counterAccountHmac: string | null;
  counterAccountLast4: string | null;
  ignoredAt: string | null;
  ignoredReason: string | null;
  /** 사람이 [거래처 지정]으로 이 줄만 정한 거래처(별칭으로 기억하지 않은 경우) */
  assignedCounterpartyId: string | null;
}

export interface TxnInput {
  rowKey: string;
  occurredAt: string;
  day: string;
  direction: 'in' | 'out';
  amount: number;
  balance: number | null;
  payer: string | null;
  memo: string | null;
  /** 상대 계좌번호(파일에 있으면). 저장은 HMAC·끝 4자리만 */
  counterAccount?: string | null;
}

export interface BankImport {
  id: string;
  profileId: string;
  accountId: string;
  source: BankImportSource;
  provider: string | null;
  rangeFrom: string | null;
  rangeTo: string | null;
  rowCount: number;
  newCount: number;
  documentId: string | null;
  createdAt: string;
}

export interface Receivable {
  id: string;
  profileId: string;
  kind: 'sale' | 'purchase';
  approvalNo: string | null;
  runId: string | null;
  counterpartyId: string | null;
  cpBizNo: string | null;
  cpName: string | null;
  cpRep: string | null;
  item: string | null;
  writtenOn: string;
  supply: number | null;
  tax: number | null;
  total: number;
  fromLedger: boolean;
  fromHometax: boolean;
  promisedOn: string | null;
  excludedReason: string | null;
  excludedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ReceivableInput {
  approvalNo: string | null;
  runId?: string | null;
  counterpartyId: string | null;
  cpBizNo: string | null;
  cpName: string | null;
  cpRep: string | null;
  item: string | null;
  writtenOn: string;
  supply: number | null;
  tax: number | null;
  total: number;
  from: 'ledger' | 'hometax';
}

export interface Alloc {
  id: string;
  profileId: string;
  receivableId: string;
  txnId: string | null;
  amount: number;
  method: AllocMethod;
  decidedBy: AllocDecider;
  reason: string | null;
  receivedOn: string | null;
  memo: string | null;
  createdAt: string;
  removedAt: string | null;
  removedBy: string | null;
}

export interface ReceivableEvent {
  seq: number;
  receivableId: string | null;
  txnId: string | null;
  allocId: string | null;
  at: string;
  actor: EventActor;
  action: string;
  reason: string | null;
  undoOf: number | null;
}

const BANK_MAX = 40;
const ALIAS_MAX = 60;
const MEMO_MAX = 200;
export const AMOUNT_MAX = 999_999_999_999;

/** 계좌번호: 숫자만 6~20자리(하이픈·공백은 지운다). */
export function normalizeAccountNumber(raw: unknown): string {
  if (typeof raw !== 'string') throw new ValidationError('bad_account_number');
  const d = raw.replace(/[\s-]/g, '');
  if (!/^\d{6,20}$/.test(d)) throw new ValidationError('bad_account_number');
  return d;
}

const LEGAL_FORMS = /주식회사|유한회사|합자회사|합명회사|사단법인|재단법인|\(주\)|\(유\)|\(합\)|\(사\)|\(재\)|㈜|㈲/g;
// 은행 표기 앞뒤 낱말(09 §6.1). 실제 표기는 PoC 고객 파일로 더한다.
const BANK_WORDS = /^(cms|펌뱅킹|인터넷|모바일|타행|스마트|폰뱅킹|오픈뱅킹)+|(cms|펌뱅킹|인터넷|모바일|타행|스마트|폰뱅킹)+$/;

/**
 * 이름 다듬기(09 §6.1): NFKC(전각→반각), 법인 표기·공백·점·괄호·하이픈 제거, 영문 소문자, 앞뒤 은행 표기 낱말 제거.
 * 다듬은 뒤 빈 글이면 ''(신호로 쓰지 않는다).
 */
export function normalizePayerName(raw: string | null | undefined): string {
  if (!raw) return '';
  let s = raw.normalize('NFKC').toLowerCase();
  s = s.replace(LEGAL_FORMS, '');
  s = s.replace(/[\s.·,()[\]{}<>_\-/\\'"`~!@#$%^&*+=:;?|]/g, '');
  s = s.replace(BANK_WORDS, '');
  return s;
}

const last4 = (d: string) => d.slice(-4);
/** 원천과 상관없는 같은 줄 열쇠(거래일·방향·금액·잔액) */
const contentKey = (r: Pick<TxnInput, 'day' | 'direction' | 'amount' | 'balance'>) => createHash('sha256').update([r.day, r.direction, r.amount, r.balance ?? ''].join('|')).digest('hex').slice(0, 32);
const optText = (v: unknown, max: number, code: string): string | null => {
  if (v === undefined || v === null) return null;
  if (typeof v !== 'string' || v.length > max) throw new ValidationError(code);
  const t = v.trim();
  return t || null;
};
const usageOf = (v: unknown): BankUsage => {
  if (v === undefined || v === null) return 'both';
  if (v === 'in' || v === 'out' || v === 'both') return v;
  throw new ValidationError('bad_usage');
};

type Row = Record<string, unknown>;
const s = (v: unknown) => (v === null || v === undefined ? null : String(v));
const n = (v: unknown) => (v === null || v === undefined ? null : Number(v));

const toAccount = (r: Row): BankAccount => ({
  id: String(r.id), profileId: String(r.profile_id), bank: String(r.bank), last4: String(r.last4), alias: s(r.alias), usage: r.usage as BankUsage,
  linkState: r.link_state as BankLinkState, linkProvider: s(r.link_provider), linkError: s(r.link_error), linkCheckedAt: s(r.link_checked_at), createdAt: String(r.created_at),
});
const toCpAccount = (r: Row): CpBankAccount => ({ id: String(r.id), counterpartyId: String(r.counterparty_id), bank: s(r.bank), last4: String(r.last4), holder: s(r.holder), usage: r.usage as BankUsage, memo: s(r.memo), createdAt: String(r.created_at) });
const toAlias = (r: Row): PayerAlias => ({ id: String(r.id), counterpartyId: String(r.counterparty_id), nameNorm: String(r.name_norm), nameRaw: String(r.name_raw), source: r.source as AliasSource, createdAt: String(r.created_at) });
const toTxn = (r: Row): BankTxn => ({
  id: String(r.id), profileId: String(r.profile_id), accountId: String(r.account_id), importId: String(r.import_id), rowKey: String(r.row_key),
  occurredAt: String(r.occurred_at), day: String(r.day), direction: r.direction as 'in' | 'out', amount: Number(r.amount), balance: n(r.balance),
  payer: s(r.payer), memo: s(r.memo), counterAccountHmac: s(r.counter_account_hmac), counterAccountLast4: s(r.counter_account_last4),
  ignoredAt: s(r.ignored_at), ignoredReason: s(r.ignored_reason), assignedCounterpartyId: s(r.assigned_counterparty_id),
});
const toImport = (r: Row): BankImport => ({ id: String(r.id), profileId: String(r.profile_id), accountId: String(r.account_id), source: r.source as BankImportSource, provider: s(r.provider), rangeFrom: s(r.range_from), rangeTo: s(r.range_to), rowCount: Number(r.row_count), newCount: Number(r.new_count), documentId: s(r.document_id), createdAt: String(r.created_at) });
const toReceivable = (r: Row): Receivable => ({
  id: String(r.id), profileId: String(r.profile_id), kind: r.kind as 'sale' | 'purchase', approvalNo: s(r.approval_no), runId: s(r.run_id),
  counterpartyId: s(r.counterparty_id), cpBizNo: s(r.cp_biz_no), cpName: s(r.cp_name), cpRep: s(r.cp_rep), item: s(r.item),
  writtenOn: String(r.written_on), supply: n(r.supply), tax: n(r.tax), total: Number(r.total), fromLedger: r.from_ledger === 1, fromHometax: r.from_hometax === 1,
  promisedOn: s(r.promised_on), excludedReason: s(r.excluded_reason), excludedAt: s(r.excluded_at), createdAt: String(r.created_at), updatedAt: String(r.updated_at),
});
const toAlloc = (r: Row): Alloc => ({
  id: String(r.id), profileId: String(r.profile_id), receivableId: String(r.receivable_id), txnId: s(r.txn_id), amount: Number(r.amount), method: r.method as AllocMethod,
  decidedBy: r.decided_by as AllocDecider, reason: s(r.reason), receivedOn: s(r.received_on), memo: s(r.memo), createdAt: String(r.created_at), removedAt: s(r.removed_at), removedBy: s(r.removed_by),
});
const toEvent = (r: Row): ReceivableEvent => ({ seq: Number(r.seq), receivableId: s(r.receivable_id), txnId: s(r.txn_id), allocId: s(r.alloc_id), at: String(r.at), actor: r.actor as EventActor, action: String(r.action), reason: s(r.reason), undoOf: n(r.undo_of) });

/** 결제 조건 검사(저장 전). 잘못된 값은 bad_pay_terms */
export function normalizePayTerms(v: unknown): PayTerms | null {
  if (v === null || v === undefined) return null;
  const o = v as Record<string, unknown>;
  if (typeof o !== 'object') throw new ValidationError('bad_pay_terms');
  if (o.kind === 'days' && Number.isInteger(o.n) && (o.n as number) >= 0 && (o.n as number) <= 365) return { kind: 'days', n: o.n as number };
  if (o.kind === 'next_month_day' && Number.isInteger(o.d) && (o.d as number) >= 1 && (o.d as number) <= 31) return { kind: 'next_month_day', d: o.d as number };
  if (o.kind === 'month_end') return { kind: 'month_end' };
  if (o.kind === 'none') return { kind: 'none' };
  throw new ValidationError('bad_pay_terms');
}

export class BankRepo {
  private readonly db: Db;
  private readonly cipher: ColumnCipher;
  private readonly hmacKey: Buffer;

  constructor(db: Db, cipher: ColumnCipher, hmacKey: Uint8Array) {
    if (hmacKey.length !== 32) throw new Error('bank hmac key must be 32 bytes');
    this.db = db;
    this.cipher = cipher;
    this.hmacKey = Buffer.from(hmacKey);
  }

  /** 계좌번호 HMAC(숫자만 다듬은 값). 같은 번호면 같은 값 */
  accountHmac(digits: string): string {
    return createHmac('sha256', this.hmacKey).update(`acct:${digits}`).digest('hex');
  }

  // ---- 내 계좌 ----

  addAccount(input: { profileId: string; bank: unknown; number: unknown; alias?: unknown; usage?: unknown }, at: string): BankAccount {
    const bank = optText(input.bank, BANK_MAX, 'bad_bank');
    if (!bank) throw new ValidationError('bad_bank');
    const digits = normalizeAccountNumber(input.number);
    const hmac = this.accountHmac(digits);
    if (this.db.prepare('SELECT 1 FROM bank_accounts WHERE profile_id = ? AND number_hmac = ?').get(input.profileId, hmac)) throw new ValidationError('duplicate_account');
    const id = randomUUID();
    this.db
      .prepare('INSERT INTO bank_accounts (id, profile_id, bank, number_enc, number_hmac, last4, alias, usage, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, input.profileId, bank, this.cipher.seal(digits, `bank_accounts.number_enc:${id}`), hmac, last4(digits), optText(input.alias, ALIAS_MAX, 'bad_alias'), usageOf(input.usage), at);
    return this.account(id)!;
  }

  account(id: string): BankAccount | null {
    const r = this.db.prepare('SELECT * FROM bank_accounts WHERE id = ?').get(id) as Row | undefined;
    return r ? toAccount(r) : null;
  }

  accounts(profileId: string): BankAccount[] {
    return (this.db.prepare('SELECT * FROM bank_accounts WHERE profile_id = ? ORDER BY created_at, rowid').all(profileId) as Row[]).map(toAccount);
  }

  /** 계좌번호 전체([보기]). 없으면 null */
  revealAccount(id: string): string | null {
    const r = this.db.prepare('SELECT number_enc FROM bank_accounts WHERE id = ?').get(id) as { number_enc: Uint8Array } | undefined;
    return r ? this.cipher.open(r.number_enc, `bank_accounts.number_enc:${id}`) : null;
  }

  updateAccount(id: string, patch: { alias?: unknown; usage?: unknown; bank?: unknown }): BankAccount {
    const cur = this.account(id);
    if (!cur) throw new ValidationError('not_found');
    const alias = patch.alias === undefined ? cur.alias : optText(patch.alias, ALIAS_MAX, 'bad_alias');
    const usage = patch.usage === undefined ? cur.usage : usageOf(patch.usage);
    const bank = patch.bank === undefined ? cur.bank : optText(patch.bank, BANK_MAX, 'bad_bank');
    if (!bank) throw new ValidationError('bad_bank');
    this.db.prepare('UPDATE bank_accounts SET alias = ?, usage = ?, bank = ? WHERE id = ?').run(alias, usage, bank, id);
    return this.account(id)!;
  }

  /** 원천 연결 상태(자동 연결 세션이 연결·끊기·오류 때 쓴다). error는 짧은 코드만 */
  setLink(id: string, link: { state: BankLinkState; provider?: string | null; error?: string | null }, at: string): BankAccount {
    if (!['file_only', 'auto_connected', 'auto_error'].includes(link.state)) throw new ValidationError('bad_link_state');
    const provider = link.state === 'file_only' ? null : optText(link.provider ?? this.account(id)?.linkProvider ?? null, 40, 'bad_provider');
    if (link.state !== 'file_only' && !provider) throw new ValidationError('bad_provider');
    const error = link.state === 'auto_error' ? (optText(link.error ?? 'source.failed', 80, 'bad_error') ?? 'source.failed') : null;
    if (this.db.prepare('UPDATE bank_accounts SET link_state = ?, link_provider = ?, link_error = ?, link_checked_at = ? WHERE id = ?').run(link.state, provider, error, at, id).changes === 0) throw new ValidationError('not_found');
    return this.account(id)!;
  }

  /** 계좌와 그 입출금 줄·회차·맞춤을 함께 지운다(CASCADE). 지운 맞춤 수를 돌려준다 */
  deleteAccount(id: string): { removedAllocs: number } {
    return this.db.transaction(() => {
      const removed = this.db.prepare('SELECT count(*) FROM receivable_allocs a JOIN bank_txns t ON t.id = a.txn_id WHERE t.account_id = ? AND a.removed_at IS NULL').pluck().get(id) as number;
      if (this.db.prepare('DELETE FROM bank_accounts WHERE id = ?').run(id).changes === 0) throw new ValidationError('not_found');
      return { removedAllocs: removed };
    })();
  }

  // ---- 거래처 계좌·별칭 ----

  addCpAccount(input: { counterpartyId: string; bank?: unknown; number: unknown; holder?: unknown; usage?: unknown; memo?: unknown }, at: string): CpBankAccount {
    if (!this.db.prepare('SELECT 1 FROM counterparties WHERE id = ?').get(input.counterpartyId)) throw new ValidationError('not_found');
    const digits = normalizeAccountNumber(input.number);
    const hmac = this.accountHmac(digits);
    if (this.db.prepare('SELECT 1 FROM cp_bank_accounts WHERE counterparty_id = ? AND number_hmac = ?').get(input.counterpartyId, hmac)) throw new ValidationError('duplicate_account');
    const id = randomUUID();
    this.db
      .prepare('INSERT INTO cp_bank_accounts (id, counterparty_id, bank, number_enc, number_hmac, last4, holder, usage, memo, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, input.counterpartyId, optText(input.bank, BANK_MAX, 'bad_bank'), this.cipher.seal(digits, `cp_bank_accounts.number_enc:${id}`), hmac, last4(digits), optText(input.holder, ALIAS_MAX, 'bad_holder'), usageOf(input.usage), optText(input.memo, MEMO_MAX, 'bad_memo'), at);
    return this.cpAccount(id)!;
  }

  cpAccount(id: string): CpBankAccount | null {
    const r = this.db.prepare('SELECT * FROM cp_bank_accounts WHERE id = ?').get(id) as Row | undefined;
    return r ? toCpAccount(r) : null;
  }

  cpAccounts(counterpartyId?: string): CpBankAccount[] {
    const rows = counterpartyId === undefined ? this.db.prepare('SELECT * FROM cp_bank_accounts ORDER BY created_at, rowid').all() : this.db.prepare('SELECT * FROM cp_bank_accounts WHERE counterparty_id = ? ORDER BY created_at, rowid').all(counterpartyId);
    return (rows as Row[]).map(toCpAccount);
  }

  /** 같은 번호(HMAC)로 등록한 거래처 계좌들 */
  cpAccountsByHmac(hmac: string): CpBankAccount[] {
    return (this.db.prepare('SELECT * FROM cp_bank_accounts WHERE number_hmac = ?').all(hmac) as Row[]).map(toCpAccount);
  }

  revealCpAccount(id: string): string | null {
    const r = this.db.prepare('SELECT number_enc FROM cp_bank_accounts WHERE id = ?').get(id) as { number_enc: Uint8Array } | undefined;
    return r ? this.cipher.open(r.number_enc, `cp_bank_accounts.number_enc:${id}`) : null;
  }

  deleteCpAccount(id: string): boolean {
    return this.db.prepare('DELETE FROM cp_bank_accounts WHERE id = ?').run(id).changes > 0;
  }

  /** 별칭 더하기. 다듬은 이름이 비거나 2글자 미만이면 bad_alias. 같은 거래처에 이미 있으면 그것을 돌려준다 */
  addAlias(counterpartyId: string, raw: unknown, source: AliasSource, at: string): PayerAlias {
    const name = optText(raw, ALIAS_MAX, 'bad_alias');
    const norm = normalizePayerName(name);
    if (!name || norm.length < 2) throw new ValidationError('bad_alias');
    if (!this.db.prepare('SELECT 1 FROM counterparties WHERE id = ?').get(counterpartyId)) throw new ValidationError('not_found');
    const prev = this.db.prepare('SELECT * FROM cp_payer_aliases WHERE counterparty_id = ? AND name_norm = ?').get(counterpartyId, norm) as Row | undefined;
    if (prev) return toAlias(prev);
    const id = randomUUID();
    this.db.prepare('INSERT INTO cp_payer_aliases (id, counterparty_id, name_norm, name_raw, source, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(id, counterpartyId, norm, name, source, at);
    return toAlias(this.db.prepare('SELECT * FROM cp_payer_aliases WHERE id = ?').get(id) as Row);
  }

  aliases(counterpartyId?: string): PayerAlias[] {
    const rows = counterpartyId === undefined ? this.db.prepare('SELECT * FROM cp_payer_aliases ORDER BY created_at, rowid').all() : this.db.prepare('SELECT * FROM cp_payer_aliases WHERE counterparty_id = ? ORDER BY created_at, rowid').all(counterpartyId);
    return (rows as Row[]).map(toAlias);
  }

  /** 다듬은 이름이 같은 별칭을 가진 거래처 id들 */
  aliasOwners(norm: string): string[] {
    return this.db.prepare('SELECT DISTINCT counterparty_id FROM cp_payer_aliases WHERE name_norm = ?').pluck().all(norm) as string[];
  }

  deleteAlias(id: string): boolean {
    return this.db.prepare('DELETE FROM cp_payer_aliases WHERE id = ?').run(id).changes > 0;
  }

  payTerms(counterpartyId: string): PayTerms | null {
    const v = this.db.prepare('SELECT pay_terms_json FROM counterparties WHERE id = ?').pluck().get(counterpartyId) as string | null | undefined;
    if (!v) return null;
    try {
      return normalizePayTerms(JSON.parse(v));
    } catch {
      return null;
    }
  }

  setPayTerms(counterpartyId: string, terms: unknown): PayTerms | null {
    const t = normalizePayTerms(terms);
    if (this.db.prepare('UPDATE counterparties SET pay_terms_json = ? WHERE id = ?').run(t ? JSON.stringify(t) : null, counterpartyId).changes === 0) throw new ValidationError('not_found');
    return t;
  }

  // ---- 가져온 회차·입출금 줄 ----

  /** 회차 하나와 줄들을 한 트랜잭션으로. 이미 있는 줄 열쇠는 건너뛴다. 새로 들어간 줄 id를 돌려준다 */
  /**
   * 다른 원천이 이미 들인 같은 줄은 건너뛴다: 내용 열쇠(거래일·방향·금액·잔액)가 같은 줄이 다른 원천 회차에 이 묶음 안 순번보다 많이 있으면 같은 줄로 본다.
   * (파일로 넣은 뒤 자동 연결로 같은 기간을 받아도, 그 반대여도 두 번 들어가지 않는다.) 같은 원천 안의 중복은 줄 열쇠가 막는다.
   */
  importTxns(input: { profileId: string; accountId: string; source: BankImportSource; provider?: string | null; documentId: string | null; format: unknown; rows: TxnInput[] }, at: string): { import: BankImport; newIds: string[]; crossSkipped: number } {
    return this.db.transaction(() => {
      const acct = this.account(input.accountId);
      if (!acct || acct.profileId !== input.profileId) throw new ValidationError('account_not_found');
      const id = randomUUID();
      const days = input.rows.map((r) => r.day).sort();
      this.db
        .prepare('INSERT INTO bank_imports (id, profile_id, account_id, source, provider, range_from, range_to, row_count, new_count, document_id, format_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)')
        .run(id, input.profileId, input.accountId, input.source, input.source === 'auto' ? (input.provider ?? null) : null, days[0] ?? null, days[days.length - 1] ?? null, input.rows.length, input.documentId, input.format === undefined ? null : JSON.stringify(input.format), at);
      const ins = this.db.prepare(`INSERT OR IGNORE INTO bank_txns (id, profile_id, account_id, import_id, row_key, content_key, occurred_at, day, direction, amount, balance, payer, memo, counter_account_hmac, counter_account_last4)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
      const others = this.db.prepare('SELECT count(*) FROM bank_txns t JOIN bank_imports i ON i.id = t.import_id WHERE t.account_id = ? AND t.content_key = ? AND i.source <> ?').pluck();
      const nth = new Map<string, number>();
      const newIds: string[] = [];
      let crossSkipped = 0;
      for (const r of input.rows) {
        if (!Number.isSafeInteger(r.amount) || r.amount <= 0 || r.amount > AMOUNT_MAX) throw new ValidationError('bad_amount');
        let ch: string | null = null;
        let cl: string | null = null;
        if (r.counterAccount) {
          try {
            const d = normalizeAccountNumber(r.counterAccount);
            ch = this.accountHmac(d);
            cl = last4(d);
          } catch {
            // 번호가 아니면(이름 등) 버린다
          }
        }
        const ck = contentKey(r);
        const n = nth.get(ck) ?? 0;
        nth.set(ck, n + 1);
        if ((others.get(input.accountId, ck, input.source) as number) > n) {
          crossSkipped++;
          continue;
        }
        const tid = randomUUID();
        if (ins.run(tid, input.profileId, input.accountId, id, r.rowKey, ck, r.occurredAt, r.day, r.direction, r.amount, r.balance, r.payer, r.memo, ch, cl).changes > 0) newIds.push(tid);
      }
      this.db.prepare('UPDATE bank_imports SET new_count = ? WHERE id = ?').run(newIds.length, id);
      return { import: toImport(this.db.prepare('SELECT * FROM bank_imports WHERE id = ?').get(id) as Row), newIds, crossSkipped };
    })();
  }

  imports(profileId: string, accountId?: string): BankImport[] {
    const rows = accountId ? this.db.prepare('SELECT * FROM bank_imports WHERE profile_id = ? AND account_id = ? ORDER BY created_at DESC, rowid DESC').all(profileId, accountId) : this.db.prepare('SELECT * FROM bank_imports WHERE profile_id = ? ORDER BY created_at DESC, rowid DESC').all(profileId);
    return (rows as Row[]).map(toImport);
  }

  txn(id: string): BankTxn | null {
    const r = this.db.prepare('SELECT * FROM bank_txns WHERE id = ?').get(id) as Row | undefined;
    return r ? toTxn(r) : null;
  }

  txns(profileId: string, q: { direction?: 'in' | 'out'; from?: string; to?: string } = {}): BankTxn[] {
    const where = ['profile_id = ?'];
    const args: unknown[] = [profileId];
    if (q.direction) {
      where.push('direction = ?');
      args.push(q.direction);
    }
    if (q.from) {
      where.push('day >= ?');
      args.push(q.from);
    }
    if (q.to) {
      where.push('day <= ?');
      args.push(q.to);
    }
    return (this.db.prepare(`SELECT * FROM bank_txns WHERE ${where.join(' AND ')} ORDER BY day, occurred_at, rowid`).all(...args) as Row[]).map(toTxn);
  }

  /** 계좌별 가장 늦은 거래일(거래내역 기준일) */
  latestDay(profileId: string): string | null {
    return (this.db.prepare('SELECT max(day) FROM bank_txns WHERE profile_id = ?').pluck().get(profileId) as string | null) ?? null;
  }

  setIgnored(txnId: string, reason: string | null, at: string): void {
    if (this.db.prepare('UPDATE bank_txns SET ignored_at = ?, ignored_reason = ? WHERE id = ?').run(reason ? at : null, reason, txnId).changes === 0) throw new ValidationError('not_found');
  }

  assignTxn(txnId: string, counterpartyId: string | null): void {
    if (this.db.prepare('UPDATE bank_txns SET assigned_counterparty_id = ? WHERE id = ?').run(counterpartyId, txnId).changes === 0) throw new ValidationError('not_found');
  }

  // ---- 받을 돈 건 ----

  receivable(id: string): Receivable | null {
    const r = this.db.prepare('SELECT * FROM receivables WHERE id = ?').get(id) as Row | undefined;
    return r ? toReceivable(r) : null;
  }

  receivables(profileId: string): Receivable[] {
    return (this.db.prepare(`SELECT * FROM receivables WHERE profile_id = ? AND kind = 'sale' ORDER BY written_on, rowid`).all(profileId) as Row[]).map(toReceivable);
  }

  byApproval(profileId: string, approvalNo: string): Receivable | null {
    const r = this.db.prepare('SELECT * FROM receivables WHERE profile_id = ? AND approval_no = ?').get(profileId, approvalNo) as Row | undefined;
    return r ? toReceivable(r) : null;
  }

  byRun(runId: string): Receivable | null {
    const r = this.db.prepare('SELECT * FROM receivables WHERE run_id = ?').get(runId) as Row | undefined;
    return r ? toReceivable(r) : null;
  }

  /**
   * 건 넣기·합치기. 같은 승인번호(또는 같은 실행)가 있으면 빈 칸만 채우고 원천 표시를 더한다(금액·작성일은 원장 것을 앞세운다).
   * 돌려주는 created: 새로 만든 건이면 true.
   */
  upsertReceivable(profileId: string, input: ReceivableInput, at: string): { receivable: Receivable; created: boolean } {
    if (!Number.isSafeInteger(input.total) || input.total <= 0 || input.total > AMOUNT_MAX) throw new ValidationError('bad_amount');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(input.writtenOn)) throw new ValidationError('bad_date');
    return this.db.transaction(() => {
      const prev = (input.approvalNo ? this.byApproval(profileId, input.approvalNo) : null) ?? (input.runId ? this.byRun(input.runId) : null);
      if (prev) {
        const ledger = input.from === 'ledger';
        const keepLedger = prev.fromLedger && !ledger;
        const pick = <T>(a: T | null, b: T | null) => (keepLedger ? (a ?? b) : (b ?? a));
        this.db
          .prepare(`UPDATE receivables SET approval_no = coalesce(approval_no, ?), run_id = coalesce(run_id, ?), counterparty_id = coalesce(counterparty_id, ?), cp_biz_no = coalesce(cp_biz_no, ?),
            cp_name = coalesce(cp_name, ?), cp_rep = coalesce(cp_rep, ?), item = coalesce(item, ?), written_on = ?, supply = ?, tax = ?, total = ?,
            from_ledger = max(from_ledger, ?), from_hometax = max(from_hometax, ?), updated_at = ? WHERE id = ?`)
          .run(input.approvalNo, input.runId ?? null, input.counterpartyId, input.cpBizNo, input.cpName, input.cpRep, input.item,
            keepLedger ? prev.writtenOn : input.writtenOn, pick(prev.supply, input.supply), pick(prev.tax, input.tax), keepLedger ? prev.total : input.total,
            ledger ? 1 : 0, ledger ? 0 : 1, at, prev.id);
        return { receivable: this.receivable(prev.id)!, created: false };
      }
      const id = randomUUID();
      this.db
        .prepare(`INSERT INTO receivables (id, profile_id, kind, approval_no, run_id, counterparty_id, cp_biz_no, cp_name, cp_rep, item, written_on, supply, tax, total, from_ledger, from_hometax, created_at, updated_at)
          VALUES (?, ?, 'sale', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(id, profileId, input.approvalNo, input.runId ?? null, input.counterpartyId, input.cpBizNo, input.cpName, input.cpRep, input.item, input.writtenOn, input.supply, input.tax, input.total,
          input.from === 'ledger' ? 1 : 0, input.from === 'hometax' ? 1 : 0, at, at);
      return { receivable: this.receivable(id)!, created: true };
    })();
  }

  setPromised(id: string, on: string | null, at: string): void {
    if (on !== null && !/^\d{4}-\d{2}-\d{2}$/.test(on)) throw new ValidationError('bad_date');
    if (this.db.prepare('UPDATE receivables SET promised_on = ?, updated_at = ? WHERE id = ?').run(on, at, id).changes === 0) throw new ValidationError('not_found');
  }

  setExcluded(id: string, reason: string | null, at: string): void {
    const r = optText(reason, MEMO_MAX, 'bad_reason');
    if (this.db.prepare('UPDATE receivables SET excluded_reason = ?, excluded_at = ?, updated_at = ? WHERE id = ?').run(r, r ? at : null, at, id).changes === 0) throw new ValidationError('not_found');
  }

  setReceivableCounterparty(id: string, counterpartyId: string, at: string): void {
    this.db.prepare('UPDATE receivables SET counterparty_id = ?, updated_at = ? WHERE id = ?').run(counterpartyId, at, id);
  }

  // ---- 맞춤(배분)·뗀 짝·기록 ----

  addAlloc(input: { profileId: string; receivableId: string; txnId: string | null; amount: number; method: AllocMethod; decidedBy: AllocDecider; reason?: string | null; receivedOn?: string | null; memo?: unknown }, at: string): Alloc {
    if (!Number.isSafeInteger(input.amount) || input.amount <= 0 || input.amount > AMOUNT_MAX) throw new ValidationError('bad_amount');
    const id = randomUUID();
    this.db
      .prepare('INSERT INTO receivable_allocs (id, profile_id, receivable_id, txn_id, amount, method, decided_by, reason, received_on, memo, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, input.profileId, input.receivableId, input.txnId, input.amount, input.method, input.decidedBy, input.reason ?? null, input.receivedOn ?? null, optText(input.memo, MEMO_MAX, 'bad_memo'), at);
    return this.alloc(id)!;
  }

  alloc(id: string): Alloc | null {
    const r = this.db.prepare('SELECT * FROM receivable_allocs WHERE id = ?').get(id) as Row | undefined;
    return r ? toAlloc(r) : null;
  }

  /** 살아 있는 맞춤(떼지 않은 것). receivableId·txnId 중 하나로 좁힌다 */
  liveAllocs(profileId: string, q: { receivableId?: string; txnId?: string } = {}): Alloc[] {
    if (q.receivableId) return (this.db.prepare('SELECT * FROM receivable_allocs WHERE receivable_id = ? AND removed_at IS NULL ORDER BY created_at, rowid').all(q.receivableId) as Row[]).map(toAlloc);
    if (q.txnId) return (this.db.prepare('SELECT * FROM receivable_allocs WHERE txn_id = ? AND removed_at IS NULL ORDER BY created_at, rowid').all(q.txnId) as Row[]).map(toAlloc);
    return (this.db.prepare('SELECT * FROM receivable_allocs WHERE profile_id = ? AND removed_at IS NULL ORDER BY created_at, rowid').all(profileId) as Row[]).map(toAlloc);
  }

  /** 떼지 않은 것까지 모두(건 상세 기록용) */
  allocsOf(receivableId: string): Alloc[] {
    return (this.db.prepare('SELECT * FROM receivable_allocs WHERE receivable_id = ? ORDER BY created_at, rowid').all(receivableId) as Row[]).map(toAlloc);
  }

  removeAlloc(id: string, by: 'user' | 'undo', at: string): Alloc {
    if (this.db.prepare('UPDATE receivable_allocs SET removed_at = ?, removed_by = ? WHERE id = ? AND removed_at IS NULL').run(at, by, id).changes === 0) throw new ValidationError('not_found');
    return this.alloc(id)!;
  }

  /** 떼었던 맞춤을 되살린다(되돌리기) */
  restoreAlloc(id: string): Alloc {
    if (this.db.prepare('UPDATE receivable_allocs SET removed_at = NULL, removed_by = NULL WHERE id = ? AND removed_at IS NOT NULL').run(id).changes === 0) throw new ValidationError('not_found');
    return this.alloc(id)!;
  }

  addReject(receivableId: string, txnId: string, at: string): void {
    this.db.prepare('INSERT OR IGNORE INTO match_rejects (receivable_id, txn_id, at) VALUES (?, ?, ?)').run(receivableId, txnId, at);
  }

  removeReject(receivableId: string, txnId: string): void {
    this.db.prepare('DELETE FROM match_rejects WHERE receivable_id = ? AND txn_id = ?').run(receivableId, txnId);
  }

  rejects(profileId: string): Set<string> {
    const rows = this.db.prepare('SELECT m.receivable_id, m.txn_id FROM match_rejects m JOIN receivables r ON r.id = m.receivable_id WHERE r.profile_id = ?').all(profileId) as Array<{ receivable_id: string; txn_id: string }>;
    return new Set(rows.map((r) => `${r.receivable_id}|${r.txn_id}`));
  }

  addEvent(profileId: string, e: Omit<ReceivableEvent, 'seq' | 'at'>, at: string): number {
    return Number(
      this.db
        .prepare('INSERT INTO receivable_events (profile_id, receivable_id, txn_id, alloc_id, at, actor, action, reason, undo_of) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(profileId, e.receivableId, e.txnId, e.allocId, at, e.actor, e.action, e.reason, e.undoOf).lastInsertRowid,
    );
  }

  event(profileId: string, seq: number): ReceivableEvent | null {
    const r = this.db.prepare('SELECT * FROM receivable_events WHERE profile_id = ? AND seq = ?').get(profileId, seq) as Row | undefined;
    return r ? toEvent(r) : null;
  }

  events(receivableId: string): ReceivableEvent[] {
    return (this.db.prepare('SELECT * FROM receivable_events WHERE receivable_id = ? ORDER BY seq').all(receivableId) as Row[]).map(toEvent);
  }

  /** 이 사건을 되돌린 사건이 이미 있는가 */
  undone(profileId: string, seq: number): boolean {
    return this.db.prepare('SELECT 1 FROM receivable_events WHERE profile_id = ? AND undo_of = ?').get(profileId, seq) !== undefined;
  }

  dispose(): void {
    this.hmacKey.fill(0);
  }
}
