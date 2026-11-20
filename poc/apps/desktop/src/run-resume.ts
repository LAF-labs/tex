import type { Vat } from '@sax/chat-core';
import type { RunView } from './shell-model.ts';

const RESUME_MAX_MS = 6 * 3_600_000;

export interface ResumeItem {
  from: string;
  counterpartyId: string;
  amount: number;
  vat: Vat | null;
  item: string | null;
  email?: string;
  batch?: string;
  index?: number;
}

interface ResumeApproved {
  from: string;
  name: string;
  total: number;
}

interface ResumeWork {
  items: ResumeItem[];
  approved: ResumeApproved[];
}

interface ResumePort {
  save(value: string | null): Promise<unknown>;
  take(): Promise<unknown>;
}

const live = (r: RunView) => r.status === 'preparing' || r.status === 'waiting' || (r.status === 'turn' && r.handoff?.afterGate !== true);
const pastApproval = (r: RunView) => r.approvedPending === true || r.status === 'issuing' || (r.status === 'turn' && r.handoff?.afterGate === true);

export function pendingWork(list: RunView[], queued: (r: RunView) => boolean, bookEmail: (counterpartyId: string) => string | undefined): ResumeWork {
  const items = list
    .filter((r) => !r.rehearsal && ((live(r) && !pastApproval(r)) || (r.status === 'draft' && queued(r))))
    .map((r) => ({
      from: r.id,
      counterpartyId: r.counterparty.id,
      amount: r.amount,
      vat: r.vatGuessed ? null : r.vat,
      item: r.itemGuessed ? null : r.item,
      ...(r.email.value !== (bookEmail(r.counterparty.id) ?? '') ? { email: r.email.value } : {}),
      ...(r.batch ? { batch: r.batch.id, index: r.batch.index } : {}),
    }));
  const approved = list.filter((r) => !r.rehearsal && pastApproval(r)).map((r) => ({ from: r.id, name: r.counterparty.name, total: r.total }));
  return { items, approved };
}

const itemOk = (x: unknown): x is ResumeItem => {
  const o = x as Partial<ResumeItem> | null;
  return (
    !!o &&
    typeof o.from === 'string' &&
    typeof o.counterpartyId === 'string' &&
    Number.isSafeInteger(o.amount) &&
    o.amount! > 0 &&
    (o.vat === null || o.vat === 'separate' || o.vat === 'included') &&
    (o.item === null || typeof o.item === 'string') &&
    (o.email === undefined || typeof o.email === 'string') &&
    (o.batch === undefined || typeof o.batch === 'string') &&
    (o.index === undefined || Number.isSafeInteger(o.index))
  );
};
const approvedOk = (x: unknown): x is ResumeApproved => {
  const o = x as Partial<ResumeApproved> | null;
  return !!o && typeof o.from === 'string' && typeof o.name === 'string' && Number.isSafeInteger(o.total);
};

export class RunResumeStore {
  private readonly port: ResumePort;
  private last = '';
  private chain: Promise<void> = Promise.resolve();
  constructor(port: ResumePort) {
    this.port = port;
  }

  save(work: ResumeWork, now: number): Promise<void> {
    const same = work.items.length || work.approved.length ? JSON.stringify(work) : '';
    if (same === this.last) return this.chain;
    this.last = same;
    const body = same ? JSON.stringify({ v: 2, at: now, ...work }) : '';
    this.chain = this.chain
      .then(() => this.port.save(body || null))
      .then(
        () => undefined,
        async () => {
          this.last = '';
          await this.port.save(null).catch(() => {});
        },
      );
    return this.chain;
  }

  async take(now: number): Promise<ResumeWork> {
    await this.chain;
    const raw = await this.port.take().catch(() => null);
    this.last = '';
    const empty = { items: [], approved: [] };
    if (typeof raw !== 'string') return empty;
    let f: { v?: unknown; at?: unknown; items?: unknown; approved?: unknown };
    try {
      f = JSON.parse(raw) as typeof f;
    } catch {
      return empty;
    }
    if (f?.v !== 2 || typeof f.at !== 'number' || now - f.at > RESUME_MAX_MS || now < f.at) return empty;
    return { items: Array.isArray(f.items) ? f.items.filter(itemOk) : [], approved: Array.isArray(f.approved) ? f.approved.filter(approvedOk) : [] };
  }
}
