import { randomBytes } from 'node:crypto';
import { CounterpartyRepo, nameMissing, normalizeCounterpartyItems, ProfileRepo, type ColumnCipher, type Db } from '@sax/db';

export class ShareError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(code);
    this.code = code;
  }
}
const fail = (code: string): never => {
  throw new ShareError(code);
};

type Params = Record<string, unknown>;

const KINDS = ['issue', 'party', 'self', 'money', 'task', 'task_result'] as const;
type Kind = (typeof KINDS)[number];
const ROW_ID = /^[A-Za-z0-9_-]{22}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const BIZ_NO = /^\d{10}$/;
const APPROVAL = /^\d{24}$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const REASON = /^[a-z][a-z0-9_.]{0,63}$/;
const WON_MAX = 999_999_999_999;
const BODY_MAX_CHARS = 20_000;
/** 한 번에 내주는 줄 수 상한. */
export const SHARE_PENDING_MAX = 200;
/** 한 번에 받아 넣는 줄 수 상한(서버 한 쪽 = 200줄). */
export const SHARE_APPLY_MAX = 200;

const kstDay = (d: Date) => new Date(d.getTime() + 9 * 3_600_000).toISOString().slice(0, 10);
const won = (v: unknown): v is number => Number.isSafeInteger(v) && Math.abs(v as number) <= WON_MAX;
const text = (v: unknown, max: number): string | null => {
  if (typeof v !== 'string') return null;
  const t = [...v.normalize('NFC').trim()].slice(0, max).join('').trim();
  return t ? t : null;
};
const newRowId = (): string => randomBytes(16).toString('base64url');
const canon = (v: unknown): string =>
  JSON.stringify(v, (_k, x: unknown) =>
    x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.entries(x as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) : x,
  );

export interface ShareOutRow {
  rowId: string;
  kind: Kind;
  at: number;
  body: Record<string, unknown>;
  taskId?: string;
}
export interface ShareCollected {
  issue: number;
  party: number;
  self: number;
}
interface SharePartiesApplied {
  added: number;
  updated: number;
  removed: number;
  kept: number;
  skipped: number;
}
export interface ShareStatus {
  cursor: number;
  out: { pending: number; sent: number; dropped: number };
  in: Record<Kind, number>;
}

interface ShareServiceOptions {
  now?: () => Date;
}

interface KnownRow {
  at: number;
  body: string;
  mine: boolean;
}

type PartyItem = { name: string; unitPrice: number | null; unit: string | null };
interface PartyBody {
  bizNo: string;
  name: string;
  rep?: string;
  address?: string;
  email?: string;
  items?: PartyItem[];
  removed?: true;
}
const REMOVED = 'removed';
const partyState = (body: string): string => {
  try {
    return (JSON.parse(body) as { removed?: unknown }).removed === true ? REMOVED : body;
  } catch {
    return body;
  }
};

export class ShareService {
  private readonly db: Db;
  private readonly cipher: ColumnCipher;
  private readonly opts: ShareServiceOptions;

  constructor(db: Db, cipher: ColumnCipher, opts: ShareServiceOptions = {}) {
    this.db = db;
    this.cipher = cipher;
    this.opts = opts;
  }

  private now(): Date {
    return this.opts.now?.() ?? new Date();
  }

  handle(method: string, p: Params | undefined): unknown {
    const q = p ?? {};
    switch (method) {
      case 'share.collect':
        return this.collect();
      case 'db.query.share.pending':
        return this.pending(q.limit === undefined ? 50 : q.limit);
      case 'share.sent':
        return this.sent(q.rowId, q.seq ?? null);
      case 'share.dropped':
        return this.dropped(q.rowId, q.reason);
      case 'share.resend':
        return this.resend();
      case 'db.query.share.cursor':
        return { cursor: this.cursor() };
      case 'share.apply':
        return this.apply(q.rows, q.cursor);
      case 'db.query.share.status':
        return this.status();
      default:
        return fail('share.unknown_method');
    }
  }

  collect(): ShareCollected {
    const at = this.now();
    return this.db.transaction(() => ({ issue: this.collectIssues(at), party: this.collectParties(at), self: this.collectSelf(at) }))();
  }

  private put(kind: Kind, ref: string, at: Date, body: Record<string, unknown>): void {
    const iso = at.toISOString();
    this.db
      .prepare(`INSERT INTO share_out (row_id, kind, ref, at, body_json, state, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)`)
      .run(newRowId(), kind, ref, at.getTime(), canon(body), iso, iso);
  }

  private hasIssue(approvalNo: string): boolean {
    return (
      !!this.db.prepare(`SELECT 1 FROM share_out WHERE kind = 'issue' AND ref = ? LIMIT 1`).get(approvalNo) ||
      !!this.db.prepare(`SELECT 1 FROM share_in WHERE kind = 'issue' AND ref = ? LIMIT 1`).get(approvalNo)
    );
  }

  private collectIssues(at: Date): number {
    let n = 0;
    const led = this.db
      .prepare(`SELECT l.run_id, l.state, l.verify_ref, l.armed_at, r.inputs_json_enc FROM irreversible_log l JOIN runs r ON r.id = l.run_id
        WHERE l.state IN ('committed','observed_manual') AND l.verify_ref IS NOT NULL ORDER BY l.armed_at`)
      .all() as Array<{ run_id: string; state: string; verify_ref: string; armed_at: string; inputs_json_enc: Uint8Array | null }>;
    for (const r of led) {
      const approvalNo = r.verify_ref.replace(/\D/g, '');
      if (!APPROVAL.test(approvalNo) || this.hasIssue(approvalNo)) continue;
      if (!(r.inputs_json_enc instanceof Uint8Array) || !r.inputs_json_enc.length) continue;
      let inputs: { v?: unknown; counterpartyId?: unknown; supply?: unknown; tax?: unknown };
      try {
        inputs = JSON.parse(this.cipher.open(r.inputs_json_enc, `runs.inputs_json_enc|${r.run_id}`));
      } catch {
        continue;
      }
      if (inputs.v !== 1 || typeof inputs.counterpartyId !== 'string' || !won(inputs.supply) || !won(inputs.tax)) continue;
      const cp = this.db.prepare('SELECT biz_no, name FROM counterparties WHERE id = ?').get(inputs.counterpartyId) as { biz_no: string; name: string } | undefined;
      const buyerName = text(cp?.name, 100);
      const armed = new Date(r.armed_at);
      if (!cp || !BIZ_NO.test(cp.biz_no) || !buyerName || Number.isNaN(armed.getTime())) continue;
      this.put('issue', approvalNo, at, {
        doc: 'tax_invoice', approvalNo, writtenOn: kstDay(armed), buyerBizNo: cp.biz_no, buyerName, supply: inputs.supply, tax: inputs.tax, how: r.state === 'committed' ? 'app' : 'manual',
      });
      n++;
    }
    const recv = this.db
      .prepare(`SELECT approval_no, cp_biz_no, cp_name, item, written_on, supply, tax, from_ledger FROM receivables
        WHERE kind = 'sale' AND approval_no IS NOT NULL AND cp_biz_no IS NOT NULL AND supply IS NOT NULL AND tax IS NOT NULL ORDER BY written_on, created_at`)
      .all() as Array<{ approval_no: string; cp_biz_no: string; cp_name: string | null; item: string | null; written_on: string; supply: number; tax: number; from_ledger: number }>;
    for (const r of recv) {
      const buyerName = text(r.cp_name, 100);
      if (!APPROVAL.test(r.approval_no) || !BIZ_NO.test(r.cp_biz_no) || !buyerName || !DAY.test(r.written_on) || !won(r.supply) || !won(r.tax) || this.hasIssue(r.approval_no)) continue;
      const item = text(r.item, 100);
      this.put('issue', r.approval_no, at, {
        doc: 'tax_invoice', approvalNo: r.approval_no, writtenOn: r.written_on, buyerBizNo: r.cp_biz_no, buyerName, supply: r.supply, tax: r.tax, ...(item ? { item } : {}), how: r.from_ledger ? 'app' : 'manual',
      });
      n++;
    }
    return n;
  }

  private known(kind: 'party' | 'self', ref: string): { mine: KnownRow | null; latest: KnownRow | null } {
    const mine = this.db.prepare(`SELECT at, body_json AS body FROM share_out WHERE kind = ? AND ref = ? ORDER BY rowid DESC LIMIT 1`).get(kind, ref) as { at: number; body: string } | undefined;
    const got = this.db.prepare(`SELECT at, body_json AS body FROM share_in WHERE kind = ? AND ref = ? AND by_role = 'desktop' ORDER BY at DESC, dev DESC LIMIT 1`).get(kind, ref) as { at: number; body: string } | undefined;
    const m = mine ? { ...mine, mine: true } : null;
    const g = got ? { ...got, mine: false } : null;
    return { mine: m, latest: m && g ? (g.at > m.at ? g : m) : (m ?? g) };
  }

  private changed(kind: 'party' | 'self', ref: string, body: string): boolean {
    const k = this.known(kind, ref);
    return k.mine?.body !== body && k.latest?.body !== body;
  }

  private after(kind: 'party' | 'self', ref: string, at: Date): Date {
    const latest = this.known(kind, ref).latest;
    return latest && latest.at >= at.getTime() ? new Date(latest.at + 1) : at;
  }

  private partyOf(r: { biz_no: string; name: string; rep_name: string | null; address: string | null; email: string | null; saved_items_json: string | null }): PartyBody | null {
    const name = text(r.name, 100);
    if (!BIZ_NO.test(r.biz_no) || !name) return null;
    const rep = text(r.rep_name, 50);
    const address = text(r.address, 200);
    const email = text(r.email, 254);
    return { bizNo: r.biz_no, name, ...(rep ? { rep } : {}), ...(address ? { address } : {}), ...(email ? { email } : {}), items: partyItems(r.saved_items_json) };
  }

  private localParty(bizNo: string): { id: string; body: PartyBody | null } | null {
    const r = this.db.prepare('SELECT id, biz_no, name, rep_name, address, email, saved_items_json FROM counterparties WHERE biz_no = ?').get(bizNo) as
      | { id: string; biz_no: string; name: string; rep_name: string | null; address: string | null; email: string | null; saved_items_json: string | null }
      | undefined;
    return r ? { id: r.id, body: this.partyOf(r) } : null;
  }

  private base(ref: string): string | null {
    return (this.db.prepare('SELECT body_json FROM share_party WHERE ref = ?').pluck().get(ref) as string | undefined) ?? null;
  }

  private setBase(ref: string, body: string, at: Date): void {
    this.db
      .prepare('INSERT INTO share_party (ref, body_json, updated_at) VALUES (?, ?, ?) ON CONFLICT(ref) DO UPDATE SET body_json = excluded.body_json, updated_at = excluded.updated_at')
      .run(ref, body, at.toISOString());
  }

  private collectParties(at: Date): number {
    let n = 0;
    const rows = this.db.prepare('SELECT biz_no, name, rep_name, address, email, saved_items_json FROM counterparties ORDER BY rowid').all() as Array<{
      biz_no: string; name: string; rep_name: string | null; address: string | null; email: string | null; saved_items_json: string | null;
    }>;
    const here = new Set<string>();
    for (const r of rows) {
      const body = this.partyOf(r);
      if (!body) continue;
      here.add(r.biz_no);
      const c = canon(body);
      if (!this.changed('party', r.biz_no, c)) {
        if (this.known('party', r.biz_no).latest?.body === c) this.setBase(r.biz_no, c, at);
        continue;
      }
      this.put('party', r.biz_no, this.after('party', r.biz_no, at), body as unknown as Record<string, unknown>);
      this.setBase(r.biz_no, c, at);
      n++;
    }
    const seen = this.db.prepare('SELECT ref, body_json FROM share_party').all() as Array<{ ref: string; body_json: string }>;
    for (const b of seen) {
      if (here.has(b.ref) || partyState(b.body_json) === REMOVED) continue;
      if (this.localParty(b.ref)) continue;
      let prev: { name?: unknown };
      try {
        prev = JSON.parse(b.body_json) as { name?: unknown };
      } catch {
        continue;
      }
      if (typeof prev.name !== 'string') continue;
      const body = { bizNo: b.ref, name: prev.name, removed: true };
      const latest = this.known('party', b.ref).latest;
      if (!latest || partyState(latest.body) !== REMOVED) {
        this.put('party', b.ref, this.after('party', b.ref, at), body);
        n++;
      }
      this.setBase(b.ref, canon(body), at);
    }
    return n;
  }

  private collectSelf(at: Date): number {
    const p = new ProfileRepo(this.db).byKind('business');
    if (!p || !p.bizNo || !BIZ_NO.test(p.bizNo) || nameMissing(p)) return 0;
    const name = text(p.displayName, 100);
    if (!name) return 0;
    const rep = text(p.repName, 50);
    const body = { bizNo: p.bizNo, name, ...(rep ? { rep } : {}) };
    if (!this.changed('self', '', canon(body))) return 0;
    this.put('self', '', this.after('self', '', at), body);
    return 1;
  }

  pending(limit: unknown): { rows: ShareOutRow[] } {
    if (!Number.isSafeInteger(limit) || (limit as number) < 1 || (limit as number) > SHARE_PENDING_MAX) fail('share.bad_request');
    const rows = this.db.prepare(`SELECT row_id, kind, at, body_json, task_id FROM share_out WHERE state = 'pending' ORDER BY rowid LIMIT ?`).all(limit) as Array<{
      row_id: string; kind: Kind; at: number; body_json: string; task_id: string | null;
    }>;
    return { rows: rows.map((r) => ({ rowId: r.row_id, kind: r.kind, at: r.at, body: JSON.parse(r.body_json) as Record<string, unknown>, ...(r.task_id ? { taskId: r.task_id } : {}) })) };
  }

  sent(rowId: unknown, seq: unknown): { ok: true } {
    if (typeof rowId !== 'string' || !ROW_ID.test(rowId) || !(seq === null || (Number.isSafeInteger(seq) && (seq as number) > 0))) fail('share.bad_request');
    this.db.prepare(`UPDATE share_out SET state = 'sent', seq = COALESCE(?, seq), updated_at = ? WHERE row_id = ? AND state != 'dropped'`).run(seq, this.now().toISOString(), rowId);
    return { ok: true };
  }

  dropped(rowId: unknown, reason: unknown): { ok: true } {
    if (typeof rowId !== 'string' || !ROW_ID.test(rowId) || typeof reason !== 'string' || !REASON.test(reason)) fail('share.bad_request');
    this.db.prepare(`UPDATE share_out SET state = 'dropped', reason = ?, updated_at = ? WHERE row_id = ? AND state = 'pending'`).run(reason, this.now().toISOString(), rowId);
    return { ok: true };
  }

  resend(): { rows: number } {
    const n = this.db.prepare(`UPDATE share_out SET state = 'pending', seq = NULL, updated_at = ? WHERE state = 'sent'`).run(this.now().toISOString()).changes;
    return { rows: n };
  }

  cursor(): number {
    return (this.db.prepare('SELECT cursor FROM share_state WHERE id = 1').pluck().get() as number | undefined) ?? 0;
  }

  apply(rows: unknown, cursor: unknown): { applied: number; cursor: number; parties: SharePartiesApplied } {
    if (!Array.isArray(rows) || rows.length > SHARE_APPLY_MAX || !Number.isSafeInteger(cursor) || (cursor as number) < 0) fail('share.bad_request');
    const list = (rows as unknown[]).map(inRow);
    const iso = this.now().toISOString();
    let applied = 0;
    let parties: SharePartiesApplied = { added: 0, updated: 0, removed: 0, kept: 0, skipped: 0 };
    this.db.transaction(() => {
      const mine = this.db.prepare(`UPDATE share_out SET state = 'sent', seq = ?, updated_at = ? WHERE row_id = ? AND (state = 'pending' OR seq IS NULL)`);
      const isMine = this.db.prepare('SELECT 1 FROM share_out WHERE row_id = ?');
      const ins = this.db.prepare(`INSERT OR IGNORE INTO share_in (row_id, seq, kind, ref, at, dev, by_role, epoch, body_json, received_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
      let money = false;
      const partyRefs = new Set<string>();
      for (const r of list) {
        if (isMine.get(r.rowId)) {
          mine.run(r.seq, iso, r.rowId);
          continue;
        }
        if (!ins.run(r.rowId, r.seq, r.kind, r.ref, r.at, r.dev, r.by, r.epoch, r.body, iso).changes) continue;
        applied++;
        money ||= r.kind === 'money';
        if (r.kind === 'party' && r.by === 'desktop') partyRefs.add(r.ref);
      }
      if (money) {
        this.db.prepare(`DELETE FROM share_in WHERE kind = 'money' AND row_id != (SELECT row_id FROM share_in WHERE kind = 'money' ORDER BY at DESC, dev DESC LIMIT 1)`).run();
      }
      parties = this.mergeParties(partyRefs);
      this.db.prepare('UPDATE share_state SET cursor = MAX(cursor, ?) WHERE id = 1').run(cursor);
    })();
    return { applied, cursor: this.cursor(), parties };
  }

  private mergeParties(refs: ReadonlySet<string>): SharePartiesApplied {
    const out: SharePartiesApplied = { added: 0, updated: 0, removed: 0, kept: 0, skipped: 0 };
    if (!refs.size) return out;
    const repo = new CounterpartyRepo(this.db);
    const at = this.now();
    for (const ref of refs) {
      if (!BIZ_NO.test(ref)) continue;
      const latest = this.known('party', ref).latest;
      if (!latest || latest.mine) continue;
      const got = inParty(latest.body, ref);
      if (!got) {
        out.skipped++;
        continue;
      }
      const local = this.localParty(ref);
      const localState = local ? (local.body ? canon(local.body) : null) : REMOVED;
      const gotState = got.removed ? REMOVED : canon(got);
      const base = this.base(ref);
      if (localState === gotState) {
        this.setBase(ref, canon(got), at);
        continue;
      }
      const first = base === null;
      if (!first && localState !== partyState(base)) {
        out.kept++;
        continue;
      }
      if (got.removed) {
        if (first) {
          out.kept++;
          continue;
        }
        if (local) repo.delete(local.id);
        this.setBase(ref, canon(got), at);
        out.removed++;
        continue;
      }
      try {
        if (!local) {
          const made = repo.create({ bizNo: got.bizNo, name: got.name, repName: got.rep ?? null, address: got.address ?? null, email: got.email ?? null, source: 'manual' });
          if (got.items) repo.setItems(made.id, got.items);
          out.added++;
        } else {
          const keep = first ? local.body : null;
          repo.update(local.id, { name: got.name, repName: got.rep ?? keep?.rep ?? null, address: got.address ?? keep?.address ?? null, email: got.email ?? keep?.email ?? null });
          if (got.items && !(first && !got.items.length)) repo.setItems(local.id, got.items);
          out.updated++;
        }
      } catch {
        out.skipped++;
        continue;
      }
      const now = this.localParty(ref)?.body;
      if (now) this.setBase(ref, canon(now), at);
    }
    return out;
  }

  status(): ShareStatus {
    const out = { pending: 0, sent: 0, dropped: 0 };
    for (const r of this.db.prepare('SELECT state, COUNT(*) AS n FROM share_out GROUP BY state').all() as Array<{ state: keyof typeof out; n: number }>) out[r.state] = r.n;
    const got = Object.fromEntries(KINDS.map((k) => [k, 0])) as Record<Kind, number>;
    for (const r of this.db.prepare('SELECT kind, COUNT(*) AS n FROM share_in GROUP BY kind').all() as Array<{ kind: Kind; n: number }>) if (r.kind in got) got[r.kind] = r.n;
    return { cursor: this.cursor(), out, in: got };
  }
}

function inParty(body: string, ref: string): PartyBody | null {
  let b: Record<string, unknown> | null;
  try {
    b = JSON.parse(body) as Record<string, unknown> | null;
  } catch {
    return null;
  }
  if (!b || typeof b !== 'object' || Array.isArray(b) || b.bizNo !== ref) return null;
  const name = text(b.name, 100);
  if (!name) return null;
  if (b.removed === true) return { bizNo: ref, name, removed: true };
  const rep = text(b.rep, 50);
  const address = text(b.address, 200);
  const email = text(b.email, 254);
  let items: PartyItem[] | undefined;
  if (b.items !== undefined) {
    try {
      items = normalizeCounterpartyItems(b.items);
    } catch {
      return null;
    }
  }
  return { bizNo: ref, name, ...(rep ? { rep } : {}), ...(address ? { address } : {}), ...(email ? { email } : {}), ...(items ? { items } : {}) };
}

function partyItems(json: string | null): Array<{ name: string; unitPrice: number | null; unit: string | null }> {
  if (!json) return [];
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return [];
  }
  if (!Array.isArray(raw)) return [];
  const out: Array<{ name: string; unitPrice: number | null; unit: string | null }> = [];
  for (const it of raw.slice(0, 20)) {
    if (!it || typeof it !== 'object') continue;
    const r = it as Record<string, unknown>;
    const name = text(r.name, 100);
    if (!name) continue;
    out.push({ name, unitPrice: won(r.unitPrice) && r.unitPrice >= 0 ? r.unitPrice : null, unit: text(r.unit, 20) });
  }
  return out;
}

interface InRow {
  rowId: string;
  seq: number;
  kind: Kind;
  ref: string;
  at: number;
  dev: string;
  by: 'desktop' | 'mobile';
  epoch: number;
  body: string;
}

function inRow(v: unknown): InRow {
  const o = (v && typeof v === 'object' ? v : {}) as { seq?: unknown; row?: unknown };
  const c = (o.row && typeof o.row === 'object' ? o.row : {}) as Record<string, unknown>;
  const body = c.body;
  if (
    !Number.isSafeInteger(o.seq) || (o.seq as number) <= 0 || c.v !== 1 || typeof c.row_id !== 'string' || !ROW_ID.test(c.row_id) ||
    !(KINDS as readonly unknown[]).includes(c.kind) || !Number.isSafeInteger(c.epoch) || (c.epoch as number) < 0 || !Number.isSafeInteger(c.at) || (c.at as number) <= 0 ||
    typeof c.dev !== 'string' || !UUID.test(c.dev) || (c.by !== 'desktop' && c.by !== 'mobile') || !body || typeof body !== 'object' || Array.isArray(body)
  ) return fail('share.bad_request');
  const json = canon(body);
  if (json.length > BODY_MAX_CHARS) return fail('share.bad_request');
  const b = body as Record<string, unknown>;
  const kind = c.kind as Kind;
  const ref = kind === 'issue' ? b.approvalNo : kind === 'party' ? b.bizNo : kind === 'task_result' ? b.taskRow : '';
  if (typeof ref !== 'string' || ref.length > 64) return fail('share.bad_request');
  return { rowId: c.row_id as string, seq: o.seq as number, kind, ref, at: c.at as number, dev: c.dev as string, by: c.by as 'desktop' | 'mobile', epoch: c.epoch as number, body: json };
}
