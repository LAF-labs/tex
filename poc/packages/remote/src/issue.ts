import { encodeEnvelope, makeEnvelope, type CmdRunBody, type EnvelopeCtx, type PhoneCopyBody } from './envelope.ts';
import { MAX_INNER } from './frame.ts';

export const ISSUE_PLAYBOOK = 'hometax.invoice.issue';

export interface PhoneIssueRequest {
  counterpartyRef: string;
  supply: number;
  tax: number;
  item: string;
  day: string;
}

const REF = /^[A-Za-z0-9_-]{1,40}$/;
const DAY = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
const MAX_WON = 100_000_000_000;

/** 입력이 맞지 않으면 이유 코드(로컬 UI용). */
export function checkIssueRequest(r: PhoneIssueRequest): 'ref' | 'supply' | 'tax' | 'item' | 'day' | null {
  if (!REF.test(r.counterpartyRef)) return 'ref';
  if (!Number.isSafeInteger(r.supply) || r.supply <= 0 || r.supply > MAX_WON) return 'supply';
  if (!Number.isSafeInteger(r.tax) || r.tax < 0 || r.tax > MAX_WON) return 'tax';
  const item = r.item.trim();
  if (item.length < 1 || item.length > 60) return 'item';
  if (!DAY.test(r.day)) return 'day';
  return null;
}

/** hometax.invoice.issue 입력(플레이북 inputs: counterpart·amounts·items·issueDay). email은 넣지 않는다. */
export function issueInputs(r: PhoneIssueRequest): Record<string, unknown> {
  const bad = checkIssueRequest(r);
  if (bad) throw new Error(`issue: bad ${bad}`);
  const item = r.item.trim();
  return {
    counterpart: { counterpartyRef: r.counterpartyRef },
    amounts: { supply: r.supply, tax: r.tax },
    items: [{ name: item, supply: r.supply, tax: r.tax }],
    issueDay: r.day,
  };
}

export function issueCmd(cmdId: string, r: PhoneIssueRequest): CmdRunBody {
  return { cmdId, playbookId: ISSUE_PLAYBOOK, inputs: issueInputs(r) };
}

/**
 * phone.copy가 한 프레임(MAX_INNER)에 들어가도록 거래처 목록을 뒤(오래 안 쓴 쪽)에서부터 줄인다.
 * 줄인 개수를 함께 돌려준다. 거래처를 모두 빼도 안 들어가면 null.
 */
export function fitPhoneCopy(body: PhoneCopyBody, ctx: EnvelopeCtx): { body: PhoneCopyBody; dropped: number } | null {
  const size = (b: PhoneCopyBody): number => {
    try {
      return encodeEnvelope(makeEnvelope('phone.copy', b, ctx)).length;
    } catch (e) {
      if (e instanceof Error && e.message.includes('too large')) return MAX_INNER + 1;
      throw e;
    }
  };
  const all = body.counterparties.slice(0, 100);
  let lo = 0;
  let hi = all.length;
  if (size({ ...body, counterparties: all }) <= MAX_INNER) return { body: { ...body, counterparties: all }, dropped: body.counterparties.length - all.length };
  if (size({ ...body, counterparties: [] }) > MAX_INNER) return null;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (size({ ...body, counterparties: all.slice(0, mid) }) <= MAX_INNER) lo = mid;
    else hi = mid - 1;
  }
  return { body: { ...body, counterparties: all.slice(0, lo) }, dropped: body.counterparties.length - lo };
}
