import { randomUUID } from 'node:crypto';
import type { Db } from './open.ts';
import { ValidationError } from './repo.ts';

type Row = Record<string, unknown>;
const nowIso = () => new Date().toISOString();
const DAY = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
const PERIOD = /^(\d{4}-((0[1-9]|1[0-2])|Q[1-4])|once)$/;
const need = (ok: boolean, code: string): void => {
  if (!ok) throw new ValidationError(code);
};
const isInt = (v: unknown, min = Number.MIN_SAFE_INTEGER): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= min;
const validDay = (d: string): boolean => DAY.test(d) && new Date(`${d}T00:00:00Z`).toISOString().slice(0, 10) === d;

export type BundleTier = 1 | 2 | 3;
export type BundleCadence = 'monthly' | 'quarterly' | 'once';
export type BundleItemSource = 'builtin' | 'industry' | 'user' | 'pasted_request';
export type BundleEntryStatus = 'missing' | 'partial' | 'ready' | 'not_applicable';

export interface BundleItem {
  id: string;
  profileId: string;
  tier: BundleTier;
  kind: string;
  name: string;
  cadence: BundleCadence;
  enabled: boolean;
  source: BundleItemSource;
  createdAt: string;
}

export interface BundleEntry {
  itemId: string;
  period: string;
  status: BundleEntryStatus;
  docIds: string[];
  note: string | null;
  updatedAt: string;
}

const toItem = (r: Row): BundleItem => ({
  id: String(r.id),
  profileId: String(r.profile_id),
  tier: Number(r.tier) as BundleTier,
  kind: String(r.kind),
  name: String(r.name),
  cadence: r.cadence as BundleCadence,
  enabled: r.enabled === 1,
  source: r.source as BundleItemSource,
  createdAt: String(r.created_at),
});

const toEntry = (r: Row): BundleEntry => ({
  itemId: String(r.item_id),
  period: String(r.period),
  status: r.status as BundleEntryStatus,
  docIds: JSON.parse(String(r.doc_ids_json)) as string[],
  note: (r.note as string) ?? null,
  updatedAt: String(r.updated_at),
});

const cardSlipKey = (profileId: string): string => `profile.${profileId}.bundle.cardSlipEnoughFrom`;
const includeRrnKey = (profileId: string): string => `profile.${profileId}.bundle.includeRrn`;

export class BundleRepo {
  private readonly db: Db;
  constructor(db: Db) {
    this.db = db;
  }

  includeRrn(profileId: string): boolean {
    const v = this.db.prepare('SELECT value_json FROM settings WHERE key = ?').pluck().get(includeRrnKey(profileId)) as string | undefined;
    return v !== undefined && JSON.parse(v) === true;
  }

  setIncludeRrn(profileId: string, on: boolean): void {
    this.db
      .prepare('INSERT INTO settings (key, value_json) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json')
      .run(includeRrnKey(profileId), JSON.stringify(on === true));
  }

  cardSlipEnoughFrom(profileId: string): string | null {
    const v = this.db.prepare('SELECT value_json FROM settings WHERE key = ?').pluck().get(cardSlipKey(profileId)) as string | undefined;
    return v === undefined ? null : (JSON.parse(v) as string);
  }

  setCardSlipEnough(profileId: string, fromMonth: string | null): void {
    if (fromMonth === null) {
      this.db.prepare('DELETE FROM settings WHERE key = ?').run(cardSlipKey(profileId));
      return;
    }
    need(/^\d{4}-(0[1-9]|1[0-2])$/.test(fromMonth), 'invalid_month');
    this.db
      .prepare('INSERT INTO settings (key, value_json) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json')
      .run(cardSlipKey(profileId), JSON.stringify(fromMonth));
  }

  items(profileId: string, opts: { enabledOnly?: boolean } = {}): BundleItem[] {
    return this.db
      .prepare(`SELECT * FROM bundle_items WHERE profile_id = ? ${opts.enabledOnly ? 'AND enabled = 1' : ''} ORDER BY tier, created_at, rowid`)
      .all(profileId)
      .map((r) => toItem(r as Row));
  }

  item(id: string): BundleItem | null {
    const r = this.db.prepare('SELECT * FROM bundle_items WHERE id = ?').get(id);
    return r ? toItem(r as Row) : null;
  }

  addItem(i: Omit<BundleItem, 'id' | 'createdAt' | 'enabled'> & { id?: string; enabled?: boolean }, at: string = nowIso()): BundleItem {
    need([1, 2, 3].includes(i.tier), 'invalid_tier');
    need(!!i.kind.trim(), 'kind_required');
    need(!!i.name.trim() && i.name.length <= 100, 'invalid_name');
    need(['monthly', 'quarterly', 'once'].includes(i.cadence), 'invalid_cadence');
    need(['builtin', 'industry', 'user', 'pasted_request'].includes(i.source), 'invalid_source');
    const id = i.id ?? randomUUID();
    this.db
      .prepare('INSERT INTO bundle_items (id, profile_id, tier, kind, name, cadence, enabled, source, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, i.profileId, i.tier, i.kind, i.name.trim(), i.cadence, i.enabled === false ? 0 : 1, i.source, at);
    return this.item(id)!;
  }

  setEnabled(id: string, enabled: boolean): void {
    need(this.db.prepare('UPDATE bundle_items SET enabled = ? WHERE id = ?').run(enabled ? 1 : 0, id).changes > 0, 'not_found');
  }

  rename(id: string, name: string, cadence?: BundleCadence): void {
    need(!!name.trim() && name.length <= 100, 'invalid_name');
    const cur = this.item(id);
    need(!!cur, 'not_found');
    need(cur!.tier === 3, 'builtin_item_fixed');
    this.db.prepare('UPDATE bundle_items SET name = ?, cadence = ? WHERE id = ?').run(name.trim(), cadence ?? cur!.cadence, id);
  }

  removeItem(id: string): 'deleted' | 'disabled' {
    const cur = this.item(id);
    need(!!cur, 'not_found');
    need(cur!.tier === 3, 'builtin_item_fixed');
    const used = this.db.prepare('SELECT 1 FROM bundle_entries WHERE item_id = ? LIMIT 1').get(id);
    if (used) {
      this.setEnabled(id, false);
      return 'disabled';
    }
    this.db.prepare('DELETE FROM bundle_items WHERE id = ?').run(id);
    return 'deleted';
  }

  entry(itemId: string, period: string): BundleEntry | null {
    const r = this.db.prepare('SELECT * FROM bundle_entries WHERE item_id = ? AND period = ?').get(itemId, period);
    return r ? toEntry(r as Row) : null;
  }

  entries(profileId: string, periods: string[]): BundleEntry[] {
    if (!periods.length) return [];
    return this.db
      .prepare(`SELECT e.* FROM bundle_entries e JOIN bundle_items i ON i.id = e.item_id WHERE i.profile_id = ? AND e.period IN (${periods.map(() => '?').join(',')}) ORDER BY e.item_id, e.period`)
      .all(profileId, ...periods)
      .map((r) => toEntry(r as Row));
  }

  setEntry(e: Omit<BundleEntry, 'updatedAt' | 'note' | 'docIds'> & { docIds?: string[]; note?: string | null }, at: string = nowIso()): BundleEntry {
    need(PERIOD.test(e.period), 'invalid_period');
    need(['missing', 'partial', 'ready', 'not_applicable'].includes(e.status), 'invalid_status');
    need(!!this.item(e.itemId), 'not_found');
    const cur = this.entry(e.itemId, e.period);
    const docIds = e.docIds ?? cur?.docIds ?? [];
    need(Array.isArray(docIds) && docIds.every((d) => typeof d === 'string' && d.length > 0), 'invalid_doc_ids');
    for (const d of docIds) need(this.db.prepare('SELECT 1 FROM documents WHERE id = ?').get(d) !== undefined, 'doc_not_found');
    const note = e.note === undefined ? (cur?.note ?? null) : e.note;
    this.db
      .prepare(`INSERT INTO bundle_entries (item_id, period, status, doc_ids_json, note, updated_at) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(item_id, period) DO UPDATE SET status=excluded.status, doc_ids_json=excluded.doc_ids_json, note=excluded.note, updated_at=excluded.updated_at`)
      .run(e.itemId, e.period, e.status, JSON.stringify([...new Set(docIds)]), note, at);
    return this.entry(e.itemId, e.period)!;
  }

  clearEntry(itemId: string, period: string): boolean {
    need(PERIOD.test(period), 'invalid_period');
    return this.db.prepare('DELETE FROM bundle_entries WHERE item_id = ? AND period = ?').run(itemId, period).changes > 0;
  }
}

export interface BundleExport {
  id: string;
  profileId: string;
  period: string;
  sha256: string;
  path: string;
  createdAt: string;
  sendVia: 'mail_client' | 'folder' | null;
  sentTo: string | null;
  sentMarkedAt: string | null;
  sentNote: string | null;
  zipPath: string | null;
  zipSha256: string | null;
  rrnIncluded: boolean;
}

const toExport = (r: Row): BundleExport => ({
  id: String(r.id),
  profileId: String(r.profile_id),
  period: String(r.period),
  sha256: String(r.sha256),
  path: String(r.path),
  createdAt: String(r.created_at),
  sendVia: (r.send_via as BundleExport['sendVia']) ?? null,
  sentTo: (r.sent_to as string) ?? null,
  sentMarkedAt: (r.sent_marked_at as string) ?? null,
  sentNote: (r.sent_note as string) ?? null,
  zipPath: (r.zip_path as string) ?? null,
  zipSha256: (r.zip_sha256 as string) ?? null,
  rrnIncluded: r.rrn_included === 1,
});

/** "어디로 무엇이 갔는지"(D07 bundle_exports). 파일 해시·시각·경로. 실제 발송 여부는 메일 프로그램이 안다 */
export class BundleExportRepo {
  private readonly db: Db;
  constructor(db: Db) {
    this.db = db;
  }

  record(
    e: { profileId: string; period: string; sha256: string; path: string; zip?: { path: string; sha256: string } | null; rrnIncluded?: boolean },
    at: string = nowIso(),
  ): BundleExport {
    const hex = /^[0-9a-f]{64}$/;
    need(hex.test(e.sha256), 'invalid_sha256');
    need(!!e.path, 'path_required');
    if (e.zip) need(hex.test(e.zip.sha256) && !!e.zip.path, 'invalid_zip');
    const id = randomUUID();
    this.db
      .prepare('INSERT INTO bundle_exports (id, profile_id, period, sha256, path, created_at, zip_path, zip_sha256, rrn_included) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, e.profileId, e.period, e.sha256, e.path, at, e.zip?.path ?? null, e.zip?.sha256 ?? null, e.rrnIncluded ? 1 : 0);
    return this.get(id)!;
  }

  get(id: string): BundleExport | null {
    const r = this.db.prepare('SELECT * FROM bundle_exports WHERE id = ?').get(id);
    return r ? toExport(r as Row) : null;
  }

  list(profileId: string, period?: string): BundleExport[] {
    const rows = period
      ? this.db.prepare('SELECT * FROM bundle_exports WHERE profile_id = ? AND period = ? ORDER BY created_at DESC').all(profileId, period)
      : this.db.prepare('SELECT * FROM bundle_exports WHERE profile_id = ? ORDER BY created_at DESC').all(profileId);
    return rows.map((r) => toExport(r as Row));
  }

  markOpened(id: string, via: 'mail_client' | 'folder', sentTo: string | null): void {
    need(this.db.prepare('UPDATE bundle_exports SET send_via = ?, sent_to = ? WHERE id = ?').run(via, sentTo, id).changes > 0, 'not_found');
  }

  markSent(id: string, note: string | null = null, at: string = nowIso()): void {
    need(this.db.prepare('UPDATE bundle_exports SET sent_marked_at = ?, sent_note = ? WHERE id = ?').run(at, note, id).changes > 0, 'not_found');
  }
}

export interface CardTxnInput {
  usedOn: string;
  merchant: string | null;
  merchantBizNo: string | null;
  cardLast4: string | null;
  approvalNo: string | null;
  amount: number;
  supplyAmount: number | null;
  vatAmount: number | null;
  canceled: boolean;
}

export interface CardTxn extends CardTxnInput {
  id: string;
  profileId: string;
  fetchRunId: string;
  seq: number;
}

export interface CardFetch {
  runId: string;
  profileId: string;
  rangeFrom: string;
  rangeTo: string;
  rowCount: number;
  completedAt: string;
}

export interface CardMemo {
  id: string;
  profileId: string;
  matchKey: string;
  txnId: string | null;
  memo: string;
  updatedAt: string;
}

const toTxn = (r: Row): CardTxn => ({
  id: String(r.id),
  profileId: String(r.profile_id),
  fetchRunId: String(r.fetch_run_id),
  seq: Number(r.seq),
  usedOn: String(r.used_on),
  merchant: (r.merchant as string) ?? null,
  merchantBizNo: (r.merchant_biz_no as string) ?? null,
  cardLast4: (r.card_last4 as string) ?? null,
  approvalNo: (r.approval_no as string) ?? null,
  amount: Number(r.amount),
  supplyAmount: r.supply_amount == null ? null : Number(r.supply_amount),
  vatAmount: r.vat_amount == null ? null : Number(r.vat_amount),
  canceled: r.canceled === 1,
});

const toMemo = (r: Row): CardMemo => ({
  id: String(r.id),
  profileId: String(r.profile_id),
  matchKey: String(r.match_key),
  txnId: (r.txn_id as string) ?? null,
  memo: String(r.memo),
  updatedAt: String(r.updated_at),
});

/**
 * 메모 매칭 키(D07 card_txn_memos.match_key). 날짜·승인번호·취소 여부·금액, 승인번호가 없으면 날짜·가게 사업자번호·금액·카드·취소 여부.
 * 같은 값이 여러 건이면 seq 순서의 순번 '#n'(1부터)을 붙인다. 승인과 그 취소는 취소 여부로 갈린다.
 * 승인번호에도 날짜를 붙인다: 승인번호는 달이 바뀌면 다시 나올 수 있어, 날짜가 없으면 다른 달의 같은 승인번호·금액 행이
 * 같은 키(UNIQUE)를 써서 메모를 빼앗거나 덮어쓴다. 같은 거래의 사용일은 조회마다 같다.
 */
export function cardMatchKeys(rows: readonly CardTxnInput[]): string[] {
  const base = rows.map((t) =>
    t.approvalNo
      ? `a|${t.usedOn}|${t.approvalNo}|${t.canceled ? 1 : 0}|${t.amount}`
      : `d|${t.usedOn}|${t.merchantBizNo ?? ''}|${t.amount}|${t.cardLast4 ?? ''}|${t.canceled ? 1 : 0}`,
  );
  const seen = new Map<string, number>();
  return base.map((k) => {
    const nth = (seen.get(k) ?? 0) + 1;
    seen.set(k, nth);
    return `${k}#${nth}`;
  });
}

function checkTxn(t: CardTxnInput): void {
  need(validDay(t.usedOn), 'invalid_used_on');
  need(isInt(t.amount), 'invalid_amount');
  need(t.supplyAmount === null || isInt(t.supplyAmount), 'invalid_supply_amount');
  need(t.vatAmount === null || isInt(t.vatAmount), 'invalid_vat_amount');
  need(t.cardLast4 === null || /^\d{4}$/.test(t.cardLast4), 'invalid_card_last4');
  need(t.merchantBizNo === null || /^\d{10}$/.test(t.merchantBizNo), 'invalid_merchant_biz_no');
}

export class CardRepo {
  private readonly db: Db;
  constructor(db: Db) {
    this.db = db;
  }

  replaceRange(f: Omit<CardFetch, 'rowCount'>, rows: readonly CardTxnInput[]): { inserted: number; unmatchedMemos: number } {
    need(validDay(f.rangeFrom) && validDay(f.rangeTo) && f.rangeFrom <= f.rangeTo, 'invalid_range');
    for (const t of rows) {
      checkTxn(t);
      need(t.usedOn >= f.rangeFrom && t.usedOn <= f.rangeTo, 'txn_outside_range');
    }
    const keys = cardMatchKeys(rows);
    return this.db.transaction(() => {
      this.db
        .prepare('INSERT INTO card_fetches (run_id, profile_id, range_from, range_to, row_count, completed_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run(f.runId, f.profileId, f.rangeFrom, f.rangeTo, rows.length, f.completedAt);
      const lost = this.db
        .prepare('SELECT m.id FROM card_txn_memos m JOIN card_txns t ON t.id = m.txn_id WHERE m.profile_id = ? AND t.used_on >= ? AND t.used_on <= ?')
        .pluck()
        .all(f.profileId, f.rangeFrom, f.rangeTo) as string[];
      this.db.prepare('DELETE FROM card_txns WHERE profile_id = ? AND used_on >= ? AND used_on <= ?').run(f.profileId, f.rangeFrom, f.rangeTo);
      const ins = this.db.prepare(`INSERT INTO card_txns (id, profile_id, fetch_run_id, seq, used_on, merchant, merchant_biz_no, card_last4, approval_no, amount, supply_amount, vat_amount, canceled)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
      const link = this.db.prepare('UPDATE card_txn_memos SET txn_id = ? WHERE profile_id = ? AND match_key = ? AND txn_id IS NULL');
      rows.forEach((t, i) => {
        const id = randomUUID();
        ins.run(id, f.profileId, f.runId, i + 1, t.usedOn, t.merchant, t.merchantBizNo, t.cardLast4, t.approvalNo, t.amount, t.supplyAmount, t.vatAmount, t.canceled ? 1 : 0);
        link.run(id, f.profileId, keys[i]);
      });
      const still = this.db.prepare('SELECT txn_id IS NULL FROM card_txn_memos WHERE id = ?').pluck();
      return { inserted: rows.length, unmatchedMemos: lost.filter((id) => still.get(id) === 1).length };
    })();
  }

  lastFetch(profileId: string): CardFetch | null {
    const r = this.db.prepare('SELECT * FROM card_fetches WHERE profile_id = ? ORDER BY completed_at DESC LIMIT 1').get(profileId) as Row | undefined;
    return r
      ? { runId: String(r.run_id), profileId: String(r.profile_id), rangeFrom: String(r.range_from), rangeTo: String(r.range_to), rowCount: Number(r.row_count), completedAt: String(r.completed_at) }
      : null;
  }

  fetchesOverlapping(profileId: string, from: string, to: string): CardFetch[] {
    return (this.db.prepare('SELECT * FROM card_fetches WHERE profile_id = ? AND range_from <= ? AND range_to >= ? ORDER BY completed_at').all(profileId, to, from) as Row[]).map((r) => ({
      runId: String(r.run_id),
      profileId: String(r.profile_id),
      rangeFrom: String(r.range_from),
      rangeTo: String(r.range_to),
      rowCount: Number(r.row_count),
      completedAt: String(r.completed_at),
    }));
  }

  txns(profileId: string, from: string, to: string): CardTxn[] {
    return this.db
      .prepare('SELECT * FROM card_txns WHERE profile_id = ? AND used_on >= ? AND used_on <= ? ORDER BY used_on, fetch_run_id, seq')
      .all(profileId, from, to)
      .map((r) => toTxn(r as Row));
  }

  setMemo(txnId: string, memo: string, at: string = nowIso()): CardMemo {
    const t = this.db.prepare('SELECT * FROM card_txns WHERE id = ?').get(txnId) as Row | undefined;
    need(!!t, 'not_found');
    const txn = toTxn(t!);
    const siblings = this.db.prepare('SELECT * FROM card_txns WHERE fetch_run_id = ? ORDER BY seq').all(txn.fetchRunId).map((r) => toTxn(r as Row));
    const key = cardMatchKeys(siblings)[siblings.findIndex((s) => s.id === txnId)]!;
    if (!memo.trim()) {
      this.db.prepare('DELETE FROM card_txn_memos WHERE profile_id = ? AND match_key = ?').run(txn.profileId, key);
      return { id: '', profileId: txn.profileId, matchKey: key, txnId, memo: '', updatedAt: at };
    }
    need(memo.length <= 500, 'memo_too_long');
    this.db
      .prepare(`INSERT INTO card_txn_memos (id, profile_id, match_key, txn_id, memo, updated_at) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(profile_id, match_key) DO UPDATE SET txn_id=excluded.txn_id, memo=excluded.memo, updated_at=excluded.updated_at`)
      .run(randomUUID(), txn.profileId, key, txnId, memo, at);
    return toMemo(this.db.prepare('SELECT * FROM card_txn_memos WHERE profile_id = ? AND match_key = ?').get(txn.profileId, key) as Row);
  }

  txn(profileId: string, txnId: string): CardTxn | null {
    const r = this.db.prepare('SELECT * FROM card_txns WHERE id = ? AND profile_id = ?').get(txnId, profileId) as Row | undefined;
    return r ? toTxn(r) : null;
  }

  memo(profileId: string, memoId: string): CardMemo | null {
    const r = this.db.prepare('SELECT * FROM card_txn_memos WHERE id = ? AND profile_id = ?').get(memoId, profileId) as Row | undefined;
    return r ? toMemo(r) : null;
  }

  reattachMemo(profileId: string, memoId: string, txnId: string, at: string = nowIso()): CardMemo {
    return this.db.transaction(() => {
      const m = this.memo(profileId, memoId);
      need(!!m, 'not_found');
      need(m!.txnId === null, 'memo_not_detached');
      const t = this.txn(profileId, txnId);
      need(!!t, 'not_found');
      const siblings = this.db.prepare('SELECT * FROM card_txns WHERE fetch_run_id = ? ORDER BY seq').all(t!.fetchRunId).map((r) => toTxn(r as Row));
      const key = cardMatchKeys(siblings)[siblings.findIndex((x) => x.id === txnId)]!;
      const taken = this.db.prepare('SELECT 1 FROM card_txn_memos WHERE profile_id = ? AND (match_key = ? OR txn_id = ?) AND id <> ?').get(profileId, key, txnId, memoId);
      need(!taken, 'memo_exists');
      this.db.prepare('UPDATE card_txn_memos SET match_key = ?, txn_id = ?, updated_at = ? WHERE id = ?').run(key, txnId, at, memoId);
      return this.memo(profileId, memoId)!;
    })();
  }

  deleteMemo(profileId: string, memoId: string): boolean {
    return this.db.prepare('DELETE FROM card_txn_memos WHERE id = ? AND profile_id = ?').run(memoId, profileId).changes > 0;
  }

  memos(profileId: string): CardMemo[] {
    return this.db.prepare('SELECT * FROM card_txn_memos WHERE profile_id = ? ORDER BY updated_at').all(profileId).map((r) => toMemo(r as Row));
  }
}

export interface Receipt {
  docId: string;
  source: 'pc_file' | 'phone_capture';
  phoneMsgId: string | null;
  issuedOn: string | null;
  merchant: string | null;
  merchantBizNo: string | null;
  amount: number | null;
  phoneOcr: unknown;
  ocr: unknown;
  confirmedAt: string | null;
}

const toReceipt = (r: Row): Receipt => ({
  docId: String(r.doc_id),
  source: r.source as Receipt['source'],
  phoneMsgId: (r.phone_msg_id as string) ?? null,
  issuedOn: (r.issued_on as string) ?? null,
  merchant: (r.merchant as string) ?? null,
  merchantBizNo: (r.merchant_biz_no as string) ?? null,
  amount: r.amount == null ? null : Number(r.amount),
  phoneOcr: r.phone_ocr_json ? (JSON.parse(String(r.phone_ocr_json)) as unknown) : null,
  ocr: r.ocr_json ? (JSON.parse(String(r.ocr_json)) as unknown) : null,
  confirmedAt: (r.confirmed_at as string) ?? null,
});

export class ReceiptRepo {
  private readonly db: Db;
  constructor(db: Db) {
    this.db = db;
  }

  add(r: { docId: string; source: Receipt['source']; phoneMsgId?: string | null; phoneOcr?: unknown; ocr?: unknown }): boolean {
    const doc = this.db.prepare('SELECT doc_type FROM documents WHERE id = ?').get(r.docId) as { doc_type: string } | undefined;
    need(!!doc, 'doc_not_found');
    need(doc!.doc_type === 'paper_receipt', 'not_paper_receipt');
    need(r.source === 'phone_capture' ? !!r.phoneMsgId : r.phoneMsgId == null, 'invalid_phone_msg_id');
    const res = this.db
      .prepare('INSERT OR IGNORE INTO receipts (doc_id, source, phone_msg_id, phone_ocr_json, ocr_json) VALUES (?, ?, ?, ?, ?)')
      .run(r.docId, r.source, r.phoneMsgId ?? null, r.phoneOcr == null ? null : JSON.stringify(r.phoneOcr), r.ocr == null ? null : JSON.stringify(r.ocr));
    return res.changes > 0;
  }

  get(docId: string): Receipt | null {
    const r = this.db.prepare('SELECT * FROM receipts WHERE doc_id = ?').get(docId);
    return r ? toReceipt(r as Row) : null;
  }

  setOcr(docId: string, ocr: unknown): void {
    need(this.db.prepare('UPDATE receipts SET ocr_json = ? WHERE doc_id = ?').run(JSON.stringify(ocr), docId).changes > 0, 'not_found');
  }

  confirm(docId: string, v: { issuedOn: string; merchant: string | null; merchantBizNo: string | null; amount: number }, at: string = nowIso()): Receipt {
    need(validDay(v.issuedOn), 'invalid_issued_on');
    need(isInt(v.amount), 'invalid_amount');
    need(v.merchantBizNo === null || /^\d{10}$/.test(v.merchantBizNo), 'invalid_merchant_biz_no');
    need(
      this.db
        .prepare('UPDATE receipts SET issued_on=?, merchant=?, merchant_biz_no=?, amount=?, confirmed_at=? WHERE doc_id=?')
        .run(v.issuedOn, v.merchant, v.merchantBizNo, v.amount, at, docId).changes > 0,
      'not_found',
    );
    return this.get(docId)!;
  }

  list(profileId: string, from: string, to: string): Receipt[] {
    return this.db
      .prepare(`SELECT r.* FROM receipts r JOIN documents d ON d.id = r.doc_id WHERE d.profile_id = ?
          AND COALESCE(r.issued_on, substr(d.created_at, 1, 10)) >= ? AND COALESCE(r.issued_on, substr(d.created_at, 1, 10)) <= ? ORDER BY COALESCE(r.issued_on, d.created_at)`)
      .all(profileId, from, to)
      .map((r) => toReceipt(r as Row));
  }
}

export interface CashSale {
  profileId: string;
  day: string;
  amount: number;
  enteredAt: string;
  source: 'pc' | 'phone';
}

export class CashSalesRepo {
  private readonly db: Db;
  constructor(db: Db) {
    this.db = db;
  }

  put(s: Omit<CashSale, 'enteredAt'>, at: string = nowIso()): { replaced: CashSale | null } {
    need(validDay(s.day), 'invalid_day');
    need(isInt(s.amount, 0), 'invalid_amount');
    need(s.source === 'pc' || s.source === 'phone', 'invalid_source');
    return this.db.transaction(() => {
      const prev = this.get(s.profileId, s.day);
      this.db
        .prepare(`INSERT INTO cash_sales (profile_id, day, amount, entered_at, source) VALUES (?, ?, ?, ?, ?)
          ON CONFLICT(profile_id, day) DO UPDATE SET amount=excluded.amount, entered_at=excluded.entered_at, source=excluded.source`)
        .run(s.profileId, s.day, s.amount, at, s.source);
      return { replaced: prev };
    })();
  }

  get(profileId: string, day: string): CashSale | null {
    const r = this.db.prepare('SELECT * FROM cash_sales WHERE profile_id = ? AND day = ?').get(profileId, day) as Row | undefined;
    return r ? { profileId: String(r.profile_id), day: String(r.day), amount: Number(r.amount), enteredAt: String(r.entered_at), source: r.source as CashSale['source'] } : null;
  }

  range(profileId: string, from: string, to: string): CashSale[] {
    return (this.db.prepare('SELECT * FROM cash_sales WHERE profile_id = ? AND day >= ? AND day <= ? ORDER BY day').all(profileId, from, to) as Row[]).map((r) => ({
      profileId: String(r.profile_id),
      day: String(r.day),
      amount: Number(r.amount),
      enteredAt: String(r.entered_at),
      source: r.source as CashSale['source'],
    }));
  }

  remove(profileId: string, day: string): boolean {
    return this.db.prepare('DELETE FROM cash_sales WHERE profile_id = ? AND day = ?').run(profileId, day).changes > 0;
  }
}
