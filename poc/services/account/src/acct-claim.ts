import type { KeyObject } from 'node:crypto';
import { ed25519Private, ed25519RawPublic, fromB64, jcs, key32, signCtx, verifyCtx } from '@sax/svc-shared';

export const ACCT_CLAIM_TTL_MS = 10 * 60_000;

export interface AcctClaim {
  account_id: string;
  email: string;
  aik_pub: string;
  iat: number;
  exp: number;
}

/** 응답·PAIR_OK에 싣는 형태. sig는 표준 base64 64B */
export interface SignedAcctClaim {
  claim: AcctClaim;
  sig: string;
}

export class AcctClaimSigner {
  private readonly key: KeyObject;
  readonly publicKey: string;
  constructor(key: KeyObject) {
    this.key = key;
    this.publicKey = ed25519RawPublic(key).toString('base64');
  }
  static fromSeedHex(hex: string | undefined): AcctClaimSigner {
    return new AcctClaimSigner(ed25519Private(key32(hex, 'ACCT_CLAIM_SIGNING_KEY')));
  }
  sign(c: Pick<AcctClaim, 'account_id' | 'email' | 'aik_pub'>, now: number): SignedAcctClaim {
    const claim: AcctClaim = { account_id: c.account_id, email: c.email, aik_pub: c.aik_pub, iat: now, exp: now + ACCT_CLAIM_TTL_MS };
    return { claim, sig: signCtx('SAX-acct-claim-v1', claim, this.key).toString('base64') };
  }
}

/** 공개키(고정용) = 시드(hex 64자)의 Ed25519 공개키, 표준 base64 */
export const acctClaimPublicKey = (seedHex: string): string => AcctClaimSigner.fromSeedHex(seedHex).publicKey;

const FIELDS = ['account_id', 'aik_pub', 'email', 'exp', 'iat'];

/**
 * 검증(폰 쪽 규칙의 참조 구현, 시험용). 필드가 정확히 다섯이고, 서명이 맞고, 만료 전이고(iat는 시계 차이 60초까지), 수명이 10분 이하이고,
 * 기대한 AIK(PAIR_OK의 AIK_pub)와 같아야 true. 형식이 틀려도 예외 없이 false.
 */
export function verifyAcctClaim(pubB64: string, s: unknown, now: number, expectAikPub?: string): s is SignedAcctClaim {
  if (!s || typeof s !== 'object') return false;
  const { claim, sig } = s as Partial<SignedAcctClaim>;
  if (!claim || typeof claim !== 'object' || typeof sig !== 'string') return false;
  if (jcs(Object.keys(claim).sort()) !== jcs(FIELDS)) return false;
  const c = claim;
  if (typeof c.account_id !== 'string' || typeof c.email !== 'string' || typeof c.aik_pub !== 'string') return false;
  if (!Number.isSafeInteger(c.iat) || !Number.isSafeInteger(c.exp) || c.exp <= now || c.iat > now + 60_000 || c.exp - c.iat > ACCT_CLAIM_TTL_MS) return false;
  if (expectAikPub !== undefined && c.aik_pub !== expectAikPub) return false;
  const pub = fromB64(pubB64, 32);
  const raw = fromB64(sig, 64);
  if (!pub || !raw) return false;
  return verifyCtx('SAX-acct-claim-v1', c, pub, raw);
}
