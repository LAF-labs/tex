// 계정 확인 주장(acct_claim, 팀장 결정 2026-11-06, 설계 #120): 계정 서비스가 서명하고 PC가 PAIR_OK에 실어 보낸다.
// 서명 입력 = utf8("SAX-acct-claim-v1") ‖ JCS({account_id, email, aik_pub, iat, exp}). iat·exp는 UTC 밀리초 정수이고
// exp = iat + 600000(10분)이다(schemas/SIGNING.md §8, D08 §4.2 7단계).
// 폰은 앱에 고정한 계정 서비스 공개키로 검증하고, exp가 지나지 않았는지, aik_pub가 PAIR_OK.aikPub와 같은지 본다.
// 하나라도 실패하면 저장하지 않고 중단한다. 운반 형식은 cert와 같다: b64(JCS({claim, sig})).
import { b64, equal, fromB64 } from './bytes.ts';
import { CTX } from './contexts.ts';
import { ed25519SignRaw, ed25519Verify, signInput } from './crypto.ts';
import { jcsBytes, parseJcs } from './jcs.ts';

export interface AcctClaim {
  account_id: string;
  email: string;
  /** 계정 AIK_pub(base64, 32B). */
  aik_pub: string;
  iat: number;
  exp: number;
}

export interface SignedAcctClaim {
  claim: AcctClaim;
  /** 계정 서비스 Ed25519 서명(base64, 64B). */
  sig: string;
}

const CLAIM_KEYS = ['account_id', 'aik_pub', 'email', 'exp', 'iat'].join(',');
/** 유효 기간 상한(exp - iat, 밀리초). 정본은 exp = iat + 600000. */
export const ACCT_CLAIM_TTL_MS = 600_000;
/** 받는 쪽 시계 어긋남 허용(iat가 미래인 정도, 밀리초). */
const SKEW_MS = 300_000;

/** 제어 문자·줄 구분자·양방향 재정렬 문자(화면을 속이는 데 쓰인다)가 있으면 참. */
export function hasControl(t: string): boolean {
  for (const ch of t) {
    const c = ch.codePointAt(0)!;
    if (c < 0x20 || (c >= 0x7f && c <= 0x9f) || c === 0x2028 || c === 0x2029 || (c >= 0x202a && c <= 0x202e) || (c >= 0x2066 && c <= 0x2069)) return true;
  }
  return false;
}

export const isEmailShape = (e: string): boolean => e.length <= 254 && /^[^\s@]{1,64}@[^\s@]+\.[^\s@]+$/.test(e) && !hasControl(e);

/** 계정 서비스(또는 시험·개발 대역)가 서명한다. sk는 Ed25519 비밀키 32B. */
export function signAcctClaim(sk: Uint8Array, claim: AcctClaim): string {
  const sig = ed25519SignRaw(sk, signInput(CTX.acctClaim, jcsBytes(claim)));
  return b64(jcsBytes({ claim, sig: b64(sig) }));
}

export type AcctClaimFailure = 'shape' | 'signature' | 'expired' | 'aik_mismatch';

/**
 * PAIR_OK.acctClaim 검사. accountKeys는 앱에 고정한 계정 서비스 공개키(회전 대비 여러 개). 비어 있으면 늘 실패한다.
 * 성공하면 검증된 주장을 돌려준다(화면에 이메일 전체를 보인다).
 */
export function verifyAcctClaim(
  field: unknown,
  o: { accountKeys: readonly Uint8Array[]; aikPub: Uint8Array; now?: number },
): { ok: true; claim: AcctClaim } | { ok: false; reason: AcctClaimFailure } {
  // 시각은 모두 UTC 밀리초. 초 단위 값이 오면 exp가 지금(밀리초)보다 한참 작아 만료로 거절된다.
  const now = o.now ?? Date.now();
  let sc: SignedAcctClaim;
  try {
    if (typeof field !== 'string' || field.length > 1400) return { ok: false, reason: 'shape' };
    const v = parseJcs(fromB64(field), 1024) as SignedAcctClaim | null;
    if (!v || typeof v !== 'object' || Object.keys(v).sort().join(',') !== 'claim,sig') return { ok: false, reason: 'shape' };
    const c = v.claim;
    if (!c || typeof c !== 'object' || Object.keys(c).sort().join(',') !== CLAIM_KEYS) return { ok: false, reason: 'shape' };
    if (typeof c.account_id !== 'string' || c.account_id.length < 1 || c.account_id.length > 64 || hasControl(c.account_id)) return { ok: false, reason: 'shape' };
    if (typeof c.email !== 'string' || !isEmailShape(c.email)) return { ok: false, reason: 'shape' };
    if (typeof c.aik_pub !== 'string' || fromB64(c.aik_pub).length !== 32) return { ok: false, reason: 'shape' };
    if (!Number.isSafeInteger(c.iat) || !Number.isSafeInteger(c.exp) || c.exp <= c.iat || c.exp - c.iat > ACCT_CLAIM_TTL_MS) return { ok: false, reason: 'shape' };
    if (typeof v.sig !== 'string' || fromB64(v.sig).length !== 64) return { ok: false, reason: 'shape' };
    sc = v;
  } catch {
    return { ok: false, reason: 'shape' };
  }
  const msg = jcsBytes(sc.claim);
  const sig = fromB64(sc.sig);
  if (!o.accountKeys.some((k) => ed25519Verify(k, CTX.acctClaim, msg, sig))) return { ok: false, reason: 'signature' };
  if (sc.claim.exp <= now || sc.claim.iat > now + SKEW_MS) return { ok: false, reason: 'expired' };
  if (!equal(fromB64(sc.claim.aik_pub), o.aikPub)) return { ok: false, reason: 'aik_mismatch' };
  return { ok: true, claim: sc.claim };
}
