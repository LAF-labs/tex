// 거래처 장부 쓰기(M4-3 거래처 OCR 입력, 08 O-05·§168, 02 §59). 렌더러 폼 → 엔진 counterparty.create/update. 엔진 명령은 여기서 고정한다.
// - [등록증으로 채우기]: 사용자가 고른 등록증 → bizcert-read.ts(docparse 샌드박스 → 엔진 bizcert.parse) → 폼 후보(상호·번호·대표자).
//   결과는 후보다. 사용자가 폼에서 보고 고친 뒤 [추가]를 눌러야 저장한다.
// - 주소는 렌더러로 보내지 않고 main이 들고 있다가, 같은 번호로 새 거래처를 저장할 때 source 'ocr'과 함께 넣는다(30분 안, 한 번만).
//   렌더러가 주소·출처를 정하지 못한다. 번호를 고쳐 저장하면 등록증과 다른 거래처라 손으로 넣은 것('manual')으로 본다.
// - 글자·필드 값은 로그에 남기지 않는다(bizcert-read가 형식·결과 코드만 남긴다).
import type { Counterparty as DbCounterparty } from '@sax/db';
import type { BizFields } from './onboarding.ts';

/** 폼 칸 상한(렌더러 cpEditPanel의 maxlength와 같다). */
export const CP_FIELD_MAX = { name: 60, bizNo: 20, rep: 30, email: 100, item: 40 } as const;
/** 읽은 등록증 주소를 들고 있는 시간. */
export const CP_CERT_HOLD_MS = 30 * 60_000;

/** 등록증 읽기 결과: 후보, 'unreadable'(골랐지만 못 읽음), null(고르지 않음). */
export type CpCertRead = BizFields | 'unreadable' | null;
export type CpCertReply = { found: true; name: string; bizNo: string; rep: string } | { found: false; reason: 'cancelled' | 'unreadable' };

type Rpc = (method: string, params?: Record<string, unknown>) => Promise<unknown>;

const text = (v: unknown, n: number) => String(v ?? '').trim().slice(0, n);

export class CounterpartyBook {
  private hold: { bizNo: string; address: string; at: number } | null = null;
  private reading = false;
  private readonly rpc: Rpc;
  private readonly read: () => Promise<CpCertRead>;
  private readonly now: () => number;
  constructor(rpc: Rpc, read: () => Promise<CpCertRead>, now: () => number = Date.now) {
    this.rpc = rpc;
    this.read = read;
    this.now = now;
  }

  /** 등록증 고르기·읽기. 한 번에 하나(파일 대화상자가 겹치지 않게). 못 읽으면 들고 있던 주소도 버린다. */
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
      this.hold = { bizNo: f.bizNo, address: f.address, at: this.now() };
      return { found: true, name: f.name.slice(0, CP_FIELD_MAX.name), bizNo: f.bizNo, rep: f.rep.slice(0, CP_FIELD_MAX.rep) };
    } finally {
      this.reading = false;
    }
  }

  /** 추가(id 없음)·수정(id). 사업자번호는 추가할 때만 받는다. */
  async save(p: Record<string, unknown>): Promise<DbCounterparty> {
    const v = { name: text(p.name, CP_FIELD_MAX.name), repName: text(p.rep, CP_FIELD_MAX.rep) || null, email: text(p.email, CP_FIELD_MAX.email) || null };
    const id = typeof p.id === 'string' && p.id ? p.id : null;
    if (id) return (await this.rpc('counterparty.update', { id, patch: v })) as DbCounterparty;
    const bizNo = text(p.bizNo, CP_FIELD_MAX.bizNo).replace(/\D/g, '');
    const h = this.hold && this.hold.bizNo === bizNo && this.now() - this.hold.at <= CP_CERT_HOLD_MS ? this.hold : null;
    const saved = (await this.rpc('counterparty.create', { ...v, bizNo, source: h ? 'ocr' : 'manual', ...(h?.address ? { address: h.address } : {}) })) as DbCounterparty;
    if (h) this.hold = null;
    return saved;
  }
}
