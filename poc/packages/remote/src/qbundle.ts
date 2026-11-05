// 우편함 번들(D08 §7): PC가 큐 수신 키 Q_D를 7일마다 갈고 `{Qx, valid_from, valid_to, seq}`를 Vd로 서명(SAX-qbundle-v1)해
// 릴레이 번들 슬롯(PUT /v1/mailboxes/:id/bundle, ≤ 2KB)에 둔다. 폰은 Vd(AIK 서명 기기 목록·pair.ok)로 확인하고,
// seq 최고값보다 낮은 번들과 valid_to가 지난 번들로는 봉인하지 않는다.
// 형식: 슬롯 값 = b64(JCS({bundle:{Qx, seq, valid_from, valid_to}, sig})), 서명 입력 = purpose ‖ JCS(bundle)(기기 키 규칙).

import { b64, fromB64 } from './bytes.ts';
import { CTX } from './contexts.ts';
import { ed25519Verify } from './crypto.ts';
import { jcsBytes, parseJcs } from './jcs.ts';
import type { Signer } from './keys.ts';

export const QBUNDLE_DAYS = 7;
const DAY = 86_400_000;
const SKEW_MS = 5 * 60_000;
export const QBUNDLE_MAX_BYTES = 2048;

export interface QBundle {
  Qx: Uint8Array;
  validFrom: number;
  validTo: number;
  seq: number;
}

interface BundleJson {
  Qx: string;
  seq: number;
  valid_from: number;
  valid_to: number;
}

const toJson = (q: QBundle): BundleJson => ({ Qx: b64(q.Qx), seq: q.seq, valid_from: q.validFrom, valid_to: q.validTo });

/** PC: 번들 슬롯 값을 만든다(Vd 서명, 금고 crypto.signVd). */
export async function makeQBundle(vd: Pick<Signer<typeof CTX.qbundle>, 'sign'>, q: QBundle): Promise<string> {
  if (q.Qx.length !== 32 || !Number.isSafeInteger(q.seq) || q.seq < 0 || !(q.validTo > q.validFrom)) throw new Error('qbundle: bad fields');
  const bundle = toJson(q);
  const sig = await vd.sign(CTX.qbundle, jcsBytes(bundle));
  const out = b64(jcsBytes({ bundle, sig: b64(sig) }));
  if (out.length > QBUNDLE_MAX_BYTES) throw new Error('qbundle: too large');
  return out;
}

/** 새 Q_D의 유효 기간(지금부터 7일). */
export const qbundleWindow = (now = Date.now()) => ({ validFrom: now, validTo: now + QBUNDLE_DAYS * DAY });

const isInt = (x: unknown): x is number => typeof x === 'number' && Number.isSafeInteger(x) && x >= 0;

/** 폰: 슬롯 값을 확인한다. 서명·형식·기간·seq 역행 중 하나라도 틀리면 null. */
export function verifyQBundle(field: string, vd: Uint8Array, o: { now?: number; minSeq?: number } = {}): QBundle | null {
  const now = o.now ?? Date.now();
  if (typeof field !== 'string' || field.length > QBUNDLE_MAX_BYTES) return null;
  try {
    const outer = parseJcs(fromB64(field), QBUNDLE_MAX_BYTES) as { bundle?: unknown; sig?: unknown } | null;
    if (!outer || typeof outer !== 'object' || Object.keys(outer).sort().join() !== 'bundle,sig' || typeof outer.sig !== 'string') return null;
    const b = outer.bundle as Partial<BundleJson> | null;
    if (!b || typeof b !== 'object' || Object.keys(b).sort().join() !== 'Qx,seq,valid_from,valid_to') return null;
    if (typeof b.Qx !== 'string' || !isInt(b.seq) || !isInt(b.valid_from) || !isInt(b.valid_to)) return null;
    const Qx = fromB64(b.Qx);
    if (Qx.length !== 32 || b64(Qx) !== b.Qx) return null;
    const sig = fromB64(outer.sig);
    if (sig.length !== 64 || !ed25519Verify(vd, CTX.qbundle, jcsBytes(b), sig)) return null;
    if (b.valid_to <= b.valid_from || b.valid_to - b.valid_from > (QBUNDLE_DAYS + 1) * DAY) return null;
    if (b.valid_from > now + SKEW_MS || b.valid_to <= now) return null;
    if (b.seq < (o.minSeq ?? 0)) return null;
    return { Qx, validFrom: b.valid_from, validTo: b.valid_to, seq: b.seq };
  } catch {
    return null;
  }
}
