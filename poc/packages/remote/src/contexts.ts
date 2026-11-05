// D08 §2.1 서명·MAC 용도 컨텍스트. 정본은 D08 §2.1이고 금고 허용 목록(D05 §5.1)과 같아야 한다.

export const CTX = {
  approve: 'SAX-approve-v1',
  consent: 'SAX-consent-v1',
  env: 'SAX-env-v1',
  qbundle: 'SAX-qbundle-v1',
  rotate: 'SAX-rotate-v1',
  ckpt: 'SAX-ckpt-v1',
  devlist: 'SAX-devlist-v1',
  revoke: 'SAX-revoke-v1',
  cert: 'SAX-cert-v1',
  aikRotate: 'SAX-aik-rotate-v1',
  kek: 'SAX-kek-v1',
  acctOp: 'SAX-acct-op-v1',
  docrec: 'SAX-docrec-v1',
  dpop: 'SAX-dpop-v1',
  kv: 'SAX-kv-v1',
  sas: 'SAX-SAS-v1',
  pair: 'SAX-pair-v1',
  session: 'SAX-session-v1',
} as const;

/** AIK 용도(D05 §5.1 AikPurpose). */
export type AikPurpose = typeof CTX.devlist | typeof CTX.revoke | typeof CTX.cert | typeof CTX.aikRotate | typeof CTX.kek | typeof CTX.acctOp;
export const AIK_PURPOSES: readonly AikPurpose[] = [CTX.devlist, CTX.revoke, CTX.cert, CTX.aikRotate, CTX.kek, CTX.acctOp];

/** 데스크톱 Vd 용도(D05 §5.1 vdPurposes). */
export type VdPurpose = typeof CTX.qbundle | typeof CTX.ckpt | typeof CTX.docrec | typeof CTX.consent | typeof CTX.dpop | typeof CTX.rotate | typeof CTX.kv;
export const VD_PURPOSES: readonly VdPurpose[] = [CTX.qbundle, CTX.ckpt, CTX.docrec, CTX.consent, CTX.dpop, CTX.rotate, CTX.kv];

/** 폰 Vm 용도. 비가역 승인(SAX-approve-v1 with Px)은 M7-7(제안)이라 Phase 1 폰에 없다. */
export type VmPurpose = typeof CTX.env | typeof CTX.qbundle | typeof CTX.rotate | typeof CTX.dpop;
export const VM_PURPOSES: readonly VmPurpose[] = [CTX.env, CTX.qbundle, CTX.rotate, CTX.dpop];

export type NoiseCtx = typeof CTX.pair | typeof CTX.session;
