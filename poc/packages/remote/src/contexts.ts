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
  acctClaim: 'SAX-acct-claim-v1',
  pclinkCommit: 'SAX-pclink-commit-v1',
  pclink: 'SAX-pclink-v1',
  pclinkSas: 'SAX-pclink-sas-v1',
  pclinkRk: 'SAX-pclink-rk-v1',
  rkEscrow: 'SAX-rk-escrow-v1',
  rkEscrowStore: 'SAX-rk-escrow-store-v1',
  rkEscrowClaim: 'SAX-rk-escrow-claim-v1',
  share: 'SAX-share-v1',
  pxEnroll: 'SAX-px-enroll-v1',
} as const;

/** AIK 용도(D05 §5.1 AikPurpose). */
export type AikPurpose = typeof CTX.devlist | typeof CTX.revoke | typeof CTX.cert | typeof CTX.aikRotate | typeof CTX.kek | typeof CTX.acctOp;
export const AIK_PURPOSES: readonly AikPurpose[] = [CTX.devlist, CTX.revoke, CTX.cert, CTX.aikRotate, CTX.kek, CTX.acctOp];

/** 데스크톱 Vd 용도(D05 §5.1 vdPurposes). */
export type VdPurpose = typeof CTX.qbundle | typeof CTX.ckpt | typeof CTX.docrec | typeof CTX.consent | typeof CTX.dpop | typeof CTX.rotate | typeof CTX.kv;
export const VD_PURPOSES: readonly VdPurpose[] = [CTX.qbundle, CTX.ckpt, CTX.docrec, CTX.consent, CTX.dpop, CTX.rotate, CTX.kv];

/** 폰 Vm 용도. 비가역 승인(SAX-approve-v1)은 Vm이 아니라 하드웨어 키 Px로만 서명한다(ADR-052). Vm은 그 키의 등록 알림만 서명한다. */
export type VmPurpose = typeof CTX.env | typeof CTX.qbundle | typeof CTX.rotate | typeof CTX.dpop | typeof CTX.share | typeof CTX.pxEnroll;
export const VM_PURPOSES: readonly VmPurpose[] = [CTX.env, CTX.qbundle, CTX.rotate, CTX.dpop, CTX.share, CTX.pxEnroll];

export type NoiseCtx = typeof CTX.pair | typeof CTX.session;
