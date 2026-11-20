// 계정 공유 기록의 장부 쪽(ADR-048 결정 5, D07 §10): 이 PC가 올릴 줄을 장부에서 모아 두고(share_out), 다른 기기에서 받은 줄을 둔다(share_in).
// - 봉인·서명·서버 호출은 main(share-sync.ts)이 한다. 엔진은 평문 줄만 다루고 네트워크를 쓰지 않는다. main 전용 메서드다(셸 렌더러로 가지 않는다).
// - 모으기(collect)는 여러 번 불러도 같은 줄을 두 번 만들지 않는다: 발급 기록은 승인번호마다 한 줄, 거래처·내 사업자는 값이 바뀌었을 때만 새 줄.
// - 받은 발급 기록은 화면과 경고에만 쓴다. 발급 여부 판단(중복 방지)은 원장·포털 기준선·발급 잠금이 한다(D03). 서버는 줄을 숨기거나 늦출 수 있다.
// - 받은 거래처는 이 PC의 거래처 목록에 반영한다(mergeParties). 발급 값은 그때도 승인 카드에서 사람이 본다.
// - Phase 1은 사업자 프로필이 하나라 줄에 공급자를 싣지 않는다(내 사업자 줄이 따로 간다).
// - 로그에는 개수만 남긴다. 줄의 내용·승인번호·사업자번호는 남기지 않는다.
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

/** @sax/remote SHARE_KINDS와 같다(엔진은 @sax/remote에 기대지 않는다. 모양 검사는 main의 sealShareRow·openShareRow가 한다). */
const KINDS = ['issue', 'party', 'self', 'money', 'task', 'task_result'] as const;
type Kind = (typeof KINDS)[number];
const ROW_ID = /^[A-Za-z0-9_-]{22}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const BIZ_NO = /^\d{10}$/;
const APPROVAL = /^\d{24}$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const REASON = /^[a-z][a-z0-9_.]{0,63}$/;
const WON_MAX = 999_999_999_999;
/** 받은 줄 본문 상한(가장 큰 봉인 칸 16 KiB의 평문보다 넉넉하게). */
const BODY_MAX_CHARS = 20_000;
/** 한 번에 내주는 줄 수 상한. */
export const SHARE_PENDING_MAX = 200;
/** 한 번에 받아 넣는 줄 수 상한(서버 한 쪽 = 200줄). */
export const SHARE_APPLY_MAX = 200;

const kstDay = (d: Date) => new Date(d.getTime() + 9 * 3_600_000).toISOString().slice(0, 10);
const won = (v: unknown): v is number => Number.isSafeInteger(v) && Math.abs(v as number) <= WON_MAX;
/** 글 칸: NFC로 맞추고 앞뒤 공백을 떼고 상한에서 자른다. 비면 null. */
const text = (v: unknown, max: number): string | null => {
  if (typeof v !== 'string') return null;
  const t = [...v.normalize('NFC').trim()].slice(0, max).join('').trim();
  return t ? t : null;
};
const newRowId = (): string => randomBytes(16).toString('base64url');
/** 키를 정렬한 JSON. 내가 만든 줄과 받은 줄(JCS로 온다)의 본문을 글자로 견줄 수 있게 두 표 모두 이 모양으로 둔다. */
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
/** 받은 거래처 줄을 이 PC 거래처 목록에 반영한 결과(개수만). kept = 이 PC 값이 더 새것이라 그대로 둠, skipped = 값이 규칙 밖이라 넣지 않음. */
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
/** 지움 줄은 상호가 달라도 같은 뜻이다(견줄 때 한 모양으로). */
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

  // ---- 모으기 ----

  /** 장부에서 아직 줄이 없는 발급 기록, 값이 바뀐 거래처·내 사업자를 올릴 줄로 만든다. 만든 줄 수를 돌려준다. */
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

  /**
   * 발급 기록: (1) 원장이 발급을 확인한 실행(committed = 앱이 발급, observed_manual = 사람이 포털에서 직접 낸 것을 앱이 확인),
   * (2) 받을 돈 장부의 매출 건(홈택스 발급 목록에서 들인 건). 승인번호(24자리)가 없으면 아직 올리지 않는다(다시 확인해 번호가 생기면 그때 올라간다).
   * 앱 발급 건의 작성일자는 발급한 날(KST)이다. 다른 기기가 이미 올린 승인번호는 다시 올리지 않는다.
   */
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

  /** 한 대상(거래처 한 곳, 내 사업자)에 대해 내가 마지막으로 만든 줄과, 받은 줄까지 합쳐 가장 늦은 줄. */
  private known(kind: 'party' | 'self', ref: string): { mine: KnownRow | null; latest: KnownRow | null } {
    const mine = this.db.prepare(`SELECT at, body_json AS body FROM share_out WHERE kind = ? AND ref = ? ORDER BY rowid DESC LIMIT 1`).get(kind, ref) as { at: number; body: string } | undefined;
    const got = this.db.prepare(`SELECT at, body_json AS body FROM share_in WHERE kind = ? AND ref = ? AND by_role = 'desktop' ORDER BY at DESC, dev DESC LIMIT 1`).get(kind, ref) as { at: number; body: string } | undefined;
    const m = mine ? { ...mine, mine: true } : null;
    const g = got ? { ...got, mine: false } : null;
    return { mine: m, latest: m && g ? (g.at > m.at ? g : m) : (m ?? g) };
  }

  /**
   * 새 줄을 만들 것인가: 지금 값이 내가 마지막으로 만든 줄과도, 계정의 가장 늦은 줄과도 다를 때만.
   * - 내 마지막 줄과 같으면 만들지 않는다(두 PC의 값이 다를 때 서로 번갈아 올리지 않게).
   * - 계정의 가장 늦은 줄과 같으면 만들지 않는다(받은 값을 그대로 다시 올리지 않게).
   */
  private changed(kind: 'party' | 'self', ref: string, body: string): boolean {
    const k = this.known(kind, ref);
    return k.mine?.body !== body && k.latest?.body !== body;
  }

  /**
   * 새 거래처·내 사업자 줄의 시각: 지금, 다만 내가 아는 그 대상의 가장 늦은 줄보다는 뒤.
   * 그 줄을 본 뒤에 고친 값이므로 시계가 느린 PC의 수정이 다른 PC의 앞선 줄에 묻히지 않는다.
   */
  private after(kind: 'party' | 'self', ref: string, at: Date): Date {
    const latest = this.known(kind, ref).latest;
    return latest && latest.at >= at.getTime() ? new Date(latest.at + 1) : at;
  }

  /** 이 PC 거래처 한 곳의 지금 값을 줄 본문 모양으로. 사업자번호·상호가 규칙 밖이면 null(올리지 않는다). */
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

  /**
   * 거래처마다 "이 PC가 계정과 마지막으로 맞춘 값"(share_party). 내가 줄을 만들 때와 받은 줄을 반영할 때 적는다.
   * 지금 값이 이것과 다르면 이 PC에서 고친 것이다(아직 올리지 않은 수정).
   */
  private base(ref: string): string | null {
    return (this.db.prepare('SELECT body_json FROM share_party WHERE ref = ?').pluck().get(ref) as string | undefined) ?? null;
  }

  private setBase(ref: string, body: string, at: Date): void {
    this.db
      .prepare('INSERT INTO share_party (ref, body_json, updated_at) VALUES (?, ?, ?) ON CONFLICT(ref) DO UPDATE SET body_json = excluded.body_json, updated_at = excluded.updated_at')
      .run(ref, body, at.toISOString());
  }

  /** 거래처: 사업자번호마다 지금 값(상호·대표·주소·메일·저장 품목). 지운 거래처는 계정과 맞춘 적이 있을 때만 "지움" 줄을 한 번 낸다. */
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
        // 계정의 값과 같다(따로 넣었는데 같은 값인 경우 포함): 맞춘 값으로 적어 둔다
        if (this.known('party', r.biz_no).latest?.body === c) this.setBase(r.biz_no, c, at);
        continue;
      }
      this.put('party', r.biz_no, this.after('party', r.biz_no, at), body as unknown as Record<string, unknown>);
      this.setBase(r.biz_no, c, at);
      n++;
    }
    // 이 PC에서 지운 거래처: 계정과 맞춘 적이 있고(내가 올렸거나 받아서 반영했거나), 계정의 가장 늦은 줄이 아직 "지움"이 아닐 때
    const seen = this.db.prepare('SELECT ref, body_json FROM share_party').all() as Array<{ ref: string; body_json: string }>;
    for (const b of seen) {
      if (here.has(b.ref) || partyState(b.body_json) === REMOVED) continue;
      if (this.localParty(b.ref)) continue; // 줄로 만들 수 없는 값(상호 없음 등)으로 남아 있다: 지운 것이 아니다
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

  /** 내 사업자: 사업자 프로필의 번호·상호·대표. 상호를 아직 모르면 올리지 않는다. */
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

  // ---- 올리기 ----

  pending(limit: unknown): { rows: ShareOutRow[] } {
    if (!Number.isSafeInteger(limit) || (limit as number) < 1 || (limit as number) > SHARE_PENDING_MAX) fail('share.bad_request');
    const rows = this.db.prepare(`SELECT row_id, kind, at, body_json, task_id FROM share_out WHERE state = 'pending' ORDER BY rowid LIMIT ?`).all(limit) as Array<{
      row_id: string; kind: Kind; at: number; body_json: string; task_id: string | null;
    }>;
    return { rows: rows.map((r) => ({ rowId: r.row_id, kind: r.kind, at: r.at, body: JSON.parse(r.body_json) as Record<string, unknown>, ...(r.task_id ? { taskId: r.task_id } : {}) })) };
  }

  /** 서버가 받았다. seq가 null이면 이미 올라가 있었다(순번은 다음에 받을 때 채워진다). 모르는 줄이면 아무것도 하지 않는다. */
  sent(rowId: unknown, seq: unknown): { ok: true } {
    if (typeof rowId !== 'string' || !ROW_ID.test(rowId) || !(seq === null || (Number.isSafeInteger(seq) && (seq as number) > 0))) fail('share.bad_request');
    this.db.prepare(`UPDATE share_out SET state = 'sent', seq = COALESCE(?, seq), updated_at = ? WHERE row_id = ? AND state != 'dropped'`).run(seq, this.now().toISOString(), rowId);
    return { ok: true };
  }

  /** 다시 올려도 안 되는 줄. 다시 내지 않는다(거래처·내 사업자는 같은 값으로 새 줄을 만들지도 않는다). */
  dropped(rowId: unknown, reason: unknown): { ok: true } {
    if (typeof rowId !== 'string' || !ROW_ID.test(rowId) || typeof reason !== 'string' || !REASON.test(reason)) fail('share.bad_request');
    this.db.prepare(`UPDATE share_out SET state = 'dropped', reason = ?, updated_at = ? WHERE row_id = ? AND state = 'pending'`).run(reason, this.now().toISOString(), rowId);
    return { ok: true };
  }

  /**
   * 계정 열쇠가 바뀌었다(ADR-050 개정 1): 앞 열쇠로 올린 줄은 서버에서 지워졌을 수 있으니 올린 줄을 모두 다시 올릴 줄로 돌린다.
   * 서버에 그대로 있는 줄은 올릴 때 "이미 있음"으로 끝난다. 버린 줄은 그대로 둔다.
   */
  resend(): { rows: number } {
    const n = this.db.prepare(`UPDATE share_out SET state = 'pending', seq = NULL, updated_at = ? WHERE state = 'sent'`).run(this.now().toISOString()).changes;
    return { rows: n };
  }

  // ---- 받기 ----

  cursor(): number {
    return (this.db.prepare('SELECT cursor FROM share_state WHERE id = 1').pluck().get() as number | undefined) ?? 0;
  }

  /**
   * main이 열어 서명까지 확인한 줄을 넣고 받은 자리를 옮긴다(한 트랜잭션). 같은 줄이 또 와도 한 번만 넣는다.
   * 내가 올린 줄이 돌아오면 넣지 않고 순번만 채운다. 돈 요약은 가장 늦은 한 장만 남긴다. 받은 자리는 내려가지 않는다.
   */
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

  /**
   * 받은 거래처 줄을 이 PC의 거래처 목록에 반영한다(apply의 트랜잭션 안). 거래처마다 계정의 가장 늦은 줄이 받은 줄일 때만 본다.
   * - 이 PC 값이 계정과 마지막으로 맞춘 값 그대로면(고친 적 없음) 받은 값으로 바꾼다. "지움"이면 지운다.
   * - 이 PC에서 고쳤고 아직 올리지 않았으면 이 PC 값을 둔다. 바로 뒤의 모으기가 그 값을 지금 시각의 줄로 올려서 다른 기기가 따라온다.
   * - 처음 만나는 거래처(맞춘 적 없음)인데 이 PC에도 있으면: 받은 값으로 바꾸되 받은 줄에 없는 대표·주소·메일은 이 PC 값을 남긴다.
   *   남긴 것이 있으면 모으기가 합친 값을 올린다. 처음 만났는데 "지움"이면 이 PC 것을 지우지 않는다(따로 넣은 거래처다).
   * - 새로 넣는 거래처는 이 PC에서 진위확인을 한 적이 없는 상태로 들어간다. 상호·대표가 바뀌면 진위확인 결과를 비운다(CounterpartyRepo.update).
   * - 값이 이 PC 규칙 밖이면(사업자번호 검증, 메일 모양) 넣지 않는다.
   */
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
        out.kept++; // 이 PC에서 고쳤다(또는 지웠다). 모으기가 올린다
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
          const keep = first ? local.body : null; // 처음 만난 거래처는 받은 줄에 없는 칸을 이 PC 값으로 남긴다
          repo.update(local.id, { name: got.name, repName: got.rep ?? keep?.rep ?? null, address: got.address ?? keep?.address ?? null, email: got.email ?? keep?.email ?? null });
          if (got.items && !(first && !got.items.length)) repo.setItems(local.id, got.items);
          out.updated++;
        }
      } catch {
        out.skipped++; // ValidationError: 사업자번호 검증·메일 모양·품목 규칙. 이 PC 값은 그대로다(트랜잭션 안에서 한 줄만 건너뛴다)
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

/** 받은 거래처 줄 본문(main이 모양·서명을 이미 확인했다). 여기서는 이 PC 장부에 넣을 값으로 다시 다듬는다. 못 쓰면 null. */
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

/** 저장 품목(@sax/db CounterpartyItem). 읽지 못하면 빈 목록. 모양이 다른 칸은 버린다. */
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

/** 받은 줄 하나의 겉모양(본문 검사는 main의 openShareRow가 이미 했다. 여기서는 장부에 넣을 수 있는 모양인지만 본다). */
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
