import { randomUUID } from 'node:crypto';
import { COUNTERPARTY_ITEMS_MAX, isValidBizNo, type Counterparty as DbCounterparty, type CounterpartyItem } from '@sax/db';
import type { BizFields } from './onboarding.ts';

export const CP_FIELD_MAX = { name: 100, bizNo: 20, rep: 100, email: 254, item: 100 } as const;
export const CP_CERT_HOLD_MS = 30 * 60_000;

export type CpCertRead = BizFields | 'unreadable' | null;
type CpCertReply = { found: true; name: string; bizNo: string; rep: string; hold: string; item: string } | { found: false; reason: 'cancelled' | 'unreadable' };

type Rpc = (method: string, params?: Record<string, unknown>) => Promise<unknown>;

const text = (v: unknown, n: number) => String(v ?? '').trim().slice(0, n);
export const certItem = (s: string): string =>
  String(s ?? '')
    .split(/[,，、/·\n]/)[0]!
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, CP_FIELD_MAX.item)
    .trim();

export class CounterpartyBook {
  private hold: { id: string; bizNo: string; address: string; at: number } | null = null;
  private reading = false;
  private readonly rpc: Rpc;
  private readonly read: () => Promise<CpCertRead>;
  private readonly now: () => number;
  constructor(rpc: Rpc, read: () => Promise<CpCertRead>, now: () => number = Date.now) {
    this.rpc = rpc;
    this.read = read;
    this.now = now;
  }

  async readCert(): Promise<CpCertReply> {
    if (this.reading) throw new Error('busy');
    this.reading = true;
    try {
      const f = await this.read();
      if (f === null) return { found: false, reason: 'cancelled' };
      if (f === 'unreadable') {
        this.hold = null;
        return { found: false, reason: 'unreadable' };
      }
      this.hold = { id: randomUUID(), bizNo: f.bizNo, address: f.address, at: this.now() };
      return { found: true, name: f.name.slice(0, CP_FIELD_MAX.name), bizNo: isValidBizNo(f.bizNo) ? f.bizNo : '', rep: f.rep.slice(0, CP_FIELD_MAX.rep), hold: this.hold.id, item: certItem(f.bizItem) };
    } finally {
      this.reading = false;
    }
  }

  async save(p: Record<string, unknown>): Promise<DbCounterparty> {
    const v = { name: text(p.name, CP_FIELD_MAX.name), repName: text(p.rep, CP_FIELD_MAX.rep) || null, email: text(p.email, CP_FIELD_MAX.email) || null };
    const id = typeof p.id === 'string' && p.id ? p.id : null;
    if (id) return (await this.rpc('counterparty.update', { id, patch: v })) as DbCounterparty;
    const bizNo = text(p.bizNo, CP_FIELD_MAX.bizNo).replace(/\D/g, '');
    const live = this.hold && this.now() - this.hold.at <= CP_CERT_HOLD_MS ? this.hold : null;
    const h = live && (live.bizNo === bizNo || (!isValidBizNo(live.bizNo) && typeof p.certHold === 'string' && p.certHold === live.id)) ? live : null;
    const saved = (await this.rpc('counterparty.create', { ...v, bizNo, source: h ? 'ocr' : 'manual', ...(h?.address ? { address: h.address } : {}) })) as DbCounterparty;
    if (h) this.hold = null;
    return saved;
  }

  async items(id: string): Promise<CounterpartyItem[]> {
    try {
      const r = await this.rpc('counterparty.getItems', { id });
      return Array.isArray(r) ? (r as CounterpartyItem[]) : [];
    } catch {
      return [];
    }
  }

  async setFirstItem(id: string, raw: unknown): Promise<void> {
    if (raw === null || raw === undefined) return;
    const name = text(raw, CP_FIELD_MAX.item);
    const cur = await this.items(id);
    const same = cur.find((i) => i.name === name);
    const rest = cur.slice(1).filter((i) => i.name !== name);
    const next = (name ? [same ?? { name, unitPrice: null, unit: null }, ...rest] : rest).slice(0, COUNTERPARTY_ITEMS_MAX);
    if (JSON.stringify(next) === JSON.stringify(cur)) return;
    await this.rpc('counterparty.setItems', { id, items: next });
  }
}
