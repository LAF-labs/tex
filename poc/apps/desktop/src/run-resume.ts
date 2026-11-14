// 이어 하기(끊김 없는 실행 4): 실행 중에 앱이 꺼지면 다음 기동에 같은 값으로 다시 시작한다. Electron 없이 시험한다.
// 남기는 것은 커밋 전 일뿐이다: 승인 전 실행(준비·사람 차례·승인 대기)과 묶음에서 차례를 기다리는 초안.
// 승인을 보냈거나 게이트 뒤 단계(발급 중·서명 차례)는 남기지 않는다. 그쪽은 엔진이 원장을 in_doubt로 올리고 화면이 발급목록 확인을 말한다.
import fs from 'node:fs';
import path from 'node:path';
import type { RunView, VatMode } from './shell-model.ts';

/** 이보다 오래된 이어 하기는 버린다(같은 날이어도 반나절 넘게 꺼져 있었으면 사람이 다시 말한다). */
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

/** 지금 실행 목록에서 다음 기동에 이어 할 커밋 전 일. bookEmail: 장부의 받는 이메일(같으면 파일에 쓰지 않는다). */
export function pendingWork(list: RunView[], bookEmail: (counterpartyId: string) => string | undefined): ResumeItem[] {
  const live = (r: RunView) =>
    !r.rehearsal &&
    !r.approvedPending &&
    (r.status === 'preparing' || r.status === 'waiting' || (r.status === 'turn' && r.handoff?.afterGate !== true));
  const queued = new Set(list.filter((r) => r.batch && (live(r) || r.batch.approved)).map((r) => r.batch!.id));
  return list
    .filter((r) => live(r) || (r.status === 'draft' && r.batch !== undefined && queued.has(r.batch.id)))
    .map((r) => ({
      from: r.id,
      counterpartyId: r.counterparty.id,
      amount: r.amount,
      vat: r.vatGuessed ? null : r.vat,
      item: r.itemGuessed ? null : r.item,
      ...(r.email.value !== (bookEmail(r.counterparty.id) ?? '') ? { email: r.email.value } : {}),
      ...(r.batch ? { batch: r.batch.id, index: r.batch.index } : {}),
    }));
}

/** 사용자 데이터 폴더의 run-resume.json. 쓰기는 동기(승인 직전 표시가 앱 종료보다 먼저 디스크에 닿게), 0600, 원자적 바꾸기. */
export class RunResumeFile {
  private readonly file: string;
  private last = '';
  constructor(dir: string) {
    this.file = path.join(dir, 'run-resume.json');
  }

  save(items: ResumeItem[], now: number): void {
    const body = items.length ? JSON.stringify({ v: 1, at: now, items }) : '';
    if (body === this.last) return;
    this.last = body;
    try {
      if (!body) return fs.rmSync(this.file, { force: true });
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      fs.writeFileSync(tmp, body, { mode: 0o600 });
      fs.renameSync(tmp, this.file);
    } catch {
      this.last = '';
    }
  }

  /** 기동 때 한 번: 읽고 지운다. 오래됐거나(RESUME_MAX_MS) 모양이 틀리면 빈 목록. */
  take(now: number): ResumeItem[] {
    let raw: unknown;
    try {
      raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch {
      return [];
    } finally {
      fs.rmSync(this.file, { force: true });
      this.last = '';
    }
    const f = raw as { v?: unknown; at?: unknown; items?: unknown } | null;
    if (f?.v !== 1 || typeof f.at !== 'number' || now - f.at > RESUME_MAX_MS || now < f.at || !Array.isArray(f.items)) return [];
    return f.items.filter(
      (x): x is ResumeItem =>
        !!x &&
        typeof x.from === 'string' &&
        typeof x.counterpartyId === 'string' &&
        Number.isSafeInteger(x.amount) &&
        x.amount > 0 &&
        (x.vat === null || x.vat === 'separate' || x.vat === 'included') &&
        (x.item === null || typeof x.item === 'string') &&
        (x.email === undefined || typeof x.email === 'string') &&
        (x.batch === undefined || typeof x.batch === 'string') &&
        (x.index === undefined || Number.isSafeInteger(x.index)),
    );
  }
}
