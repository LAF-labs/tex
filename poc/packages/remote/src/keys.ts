// 장기 키 연산 인터페이스. 데스크톱의 Sd·Vd·AIK 연산은 금고(D05 §5.1 VaultCrypto)가 구현한다.
// 이 패키지는 인터페이스만 정의하고, 폰(소프트 키, 키 저장은 앱 몫)과 시험용 구현을 함께 둔다.

import { wipe } from './bytes.ts';
import type { AikPurpose, NoiseCtx, VdPurpose, VmPurpose } from './contexts.ts';
import { ed25519Public, ed25519SignRaw, signInput, x25519Dh, x25519Public } from './crypto.ts';

/** Noise 정적키. 데스크톱은 VaultCrypto.noiseStatic()/noiseDH()에 연결한다. */
export interface NoiseStatic {
  readonly publicKey: Uint8Array;
  /** 정적키 × 상대 공개키 DH. 결과 32B는 핸드셰이크 상태(MixKey)에 바로 쓰이고 보관하지 않는다. */
  dh(remotePub: Uint8Array, ctx: NoiseCtx): Promise<Uint8Array>;
}

/** 용도 문자열 허용 목록이 있는 서명기. 서명 입력 = purpose ‖ msg. */
export interface Signer<P extends string> {
  readonly publicKey: Uint8Array;
  sign(purpose: P, msg: Uint8Array): Promise<Uint8Array>;
}

export type AikSigner = Signer<AikPurpose>;
export type VdSigner = Signer<VdPurpose>;
export type VmSigner = Signer<VmPurpose>;

/** 데스크톱 쪽 금고 연산 묶음(D05 §5.1의 부분집합). */
export interface DesktopKeys {
  noise: NoiseStatic;
  vd: VdSigner;
  aik: AikSigner;
  /** Kv 공개키(금고 비밀 봉인 수신용, D05 §5). pair.ok에 Vd 서명과 함께 싣는다. */
  kvPublic(): Uint8Array;
}

/** 소프트 X25519 정적키. 폰의 Sm, 시험용 PC 키. 비밀키 바이트는 이 객체 밖으로 내보내지 않는다. */
export function softNoiseStatic(secretKey: Uint8Array): NoiseStatic & { destroy(): void } {
  const sk = secretKey.slice();
  const publicKey = x25519Public(sk);
  return {
    publicKey,
    dh: async (remotePub) => x25519Dh(sk, remotePub),
    destroy: () => wipe(sk),
  };
}

/** 소프트 Ed25519 서명기. 허용 목록 밖 용도는 거부한다(금고와 같은 규칙). */
export function softSigner<P extends string>(secretKey: Uint8Array, allowed: readonly P[]): Signer<P> & { destroy(): void } {
  const sk = secretKey.slice();
  const publicKey = ed25519Public(sk);
  return {
    publicKey,
    sign: async (purpose, msg) => {
      if (!allowed.includes(purpose)) throw new Error(`signer: purpose not allowed: ${purpose}`);
      return ed25519SignRaw(sk, signInput(purpose, msg));
    },
    destroy: () => wipe(sk),
  };
}
