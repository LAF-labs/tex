// 이어 하기(끊김 없는 실행 4): 실행 중에 앱이 꺼지면 다음 기동에 같은 값으로 다시 시작한다. Electron 없이 시험한다.
// 다시 시작하는 것은 커밋 전 일뿐이다: 승인 전 실행(준비·사람 차례·승인 대기)과 묶음 승인으로 차례를 기다리는 초안.
// 승인을 보낸 뒤(거부 우선 창·발급 중·게이트 뒤 사람 차례)는 다시 시작하지 않고 상호·합계만 남겨 다음 기동에 안내 한 줄을 낸다.
// 저장은 엔진의 암호화 DB(settings, resume.save·resume.take, main 전용)다. 평문 파일을 쓰지 않는다.
import type { RunView, VatMode } from './shell-model.ts';

/** 이보다 오래된 이어 하기는 버린다(반나절 넘게 꺼져 있었으면 사람이 다시 말한다). */
export const RESUME_MAX_MS = 6 * 3_600_000;

export interface ResumeItem {
  /** 앞 실행 id(카드 "이어서 해요"·로그에만). */
  from: string;
  counterpartyId: string;
  amount: number;
  /** 고르지 않았던 부가세·저장 품목에서 온 품목은 null(다시 추정한다). */
  vat: VatMode | null;
  item: string | null;
  /** 카드에서 고친 받는 이메일(장부 값과 다를 때만). */
  email?: string;
  batch?: string;
  index?: number;
}

/** 승인을 보낸 뒤 꺼진 건(다시 시작하지 않는다). 다음 기동에 안내 한 줄만. */
export interface ResumeApproved {
  from: string;
  name: string;
  total: number;
}

export interface ResumeWork {
  items: ResumeItem[];
  approved: ResumeApproved[];
}

/** 엔진 resume.save(값 또는 null)·resume.take(읽고 지움). */
export interface ResumePort {
  save(value: string | null): Promise<unknown>;
  take(): Promise<unknown>;
}

const live = (r: RunView) => r.status === 'preparing' || r.status === 'waiting' || (r.status === 'turn' && r.handoff?.afterGate !== true);
const pastApproval = (r: RunView) => r.approvedPending === true || r.status === 'issuing' || (r.status === 'turn' && r.handoff?.afterGate === true);

/**
 * 지금 실행 목록에서 다음 기동에 이어 할 일. queued: 묶음 승인으로 차례를 기다리는 초안인가(ShellRuns가 판단, 멈춘 묶음·건너뛴 초안은 아니다).
 * bookEmail: 장부의 받는 이메일(같으면 남기지 않는다).
 */
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

/** 엔진 DB의 이어 하기 한 값. 쓰기는 순서대로 하나씩, 실패하면 지운다(옛 값이 남지 않게). */
export class RunResumeStore {
  private readonly port: ResumePort;
  private last = '';
  private chain: Promise<void> = Promise.resolve();
  constructor(port: ResumePort) {
    this.port = port;
  }

  /** 바뀌었을 때만 쓴다. 돌려준 약속은 이 값이 DB에 닿은 때(실패하면 지운 뒤) 풀린다. */
  save(work: ResumeWork, now: number): Promise<void> {
    const body = work.items.length || work.approved.length ? JSON.stringify({ v: 2, at: now, ...work }) : '';
    if (body === this.last) return this.chain;
    this.last = body;
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

  /** 기동 때 한 번: 읽고 지운다. 오래됐거나 모양이 틀리면 빈 값. */
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
