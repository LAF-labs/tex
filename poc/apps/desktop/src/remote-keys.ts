// 데스크톱 장기 키(@sax/remote DesktopKeys) ↔ 금고 crypto.*(D05 §5.1, D08 §6 C-19). 금고 트랙 몫(팀장 결정 2026-11-06 (가), remote-ports.ts VaultKeysFactory).
// - 개인키(Sd·Vd·AIK·Q_D·Kv)는 금고 안에만 있다. 여기는 금고 control 포트 rpc를 부르는 얇은 겉이다. DH 결과·평문을 보관하지 않는다.
// - 용도 문자열은 금고·@sax/remote 허용 목록 그대로(VD_PURPOSES·AIK_PURPOSES, SIGNING.md §8). 밖이면 금고에 보내기 전에 거부한다.
// - 결과 모양은 금고 NOTES §7: noiseDH → {shared}, signVd·signAik → {sig}, hpkeOpen → {pt}. 모양이 다르면 거부한다(fail-closed).
import { AIK_PURPOSES, CTX, VD_PURPOSES, type AikPurpose, type DesktopKeys, type HpkeOpenFn, type NoiseCtx, type VdPurpose } from '@sax/remote';
import { CRYPTO_MSG_MAX, type VaultPublicKeys } from '@sax/vault';
import type { VaultKeysFactory } from './remote-ports.ts';

/** 금고 control 포트 rpc(main의 VaultClient.rpc). remote-ports.ts VaultKeysFactory의 인자와 같다. */
export type VaultControl = Parameters<VaultKeysFactory>[0];

/** remote-ports.ts VaultKeysFactory. DesktopKeys에 큐 개봉(hpkeOpen)과 Q_D 공개키를 더해 돌려준다(drainQueue·makeQBundle용). */
export type VaultDesktopKeys = DesktopKeys & {
  hpkeOpen: HpkeOpenFn;
  /** 우편함 수신 키 Q_D 공개키(makeQBundle의 Qx) */
  qdPublic: Uint8Array;
};

const NOISE_CTX: readonly NoiseCtx[] = [CTX.pair, CTX.session];
const HPKE_INFO = CTX.env;

export class VaultKeysError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(code);
    this.code = code;
  }
}

const bytes32 = (v: unknown): Uint8Array => {
  if (!(v instanceof Uint8Array) || v.length !== 32) throw new VaultKeysError('vault.bad_result');
  return new Uint8Array(v);
};
const field = (r: unknown, k: 'shared' | 'sig' | 'pt'): Uint8Array => {
  const v = (r as Record<string, unknown> | null)?.[k];
  if (!(v instanceof Uint8Array)) throw new VaultKeysError('vault.bad_result');
  return v;
};
const msgOk = (m: unknown): Uint8Array => {
  if (!(m instanceof Uint8Array) || m.length > CRYPTO_MSG_MAX) throw new VaultKeysError('vault.bad_params');
  return m;
};

/**
 * 금고 공개키를 한 번 읽어 DesktopKeys를 만든다. 공개키는 이 객체에 고정된다(금고가 키를 바꾸면 새로 만든다).
 * 각 연산은 부를 때마다 금고에 간다(서명·DH 결과를 캐시하지 않는다).
 */
export async function vaultDesktopKeys(control: VaultControl): Promise<VaultDesktopKeys> {
  const pk = (await control('crypto.publicKeys')) as Partial<VaultPublicKeys> | null;
  if (!pk || typeof pk !== 'object') throw new VaultKeysError('vault.bad_result');
  const noisePub = bytes32(pk.noiseStatic);
  const vdPub = bytes32(pk.vd);
  const aikPub = bytes32(pk.aik);
  const kvPub = bytes32(pk.kv);
  const qdPub = bytes32(pk.qd);
  return {
    noise: {
      publicKey: noisePub,
      async dh(remotePub, ctx) {
        if (!NOISE_CTX.includes(ctx) || !(remotePub instanceof Uint8Array) || remotePub.length !== 32) throw new VaultKeysError('vault.bad_params');
        const shared = field(await control('crypto.noiseDH', { remotePub, ctx }), 'shared');
        if (shared.length !== 32) throw new VaultKeysError('vault.bad_result');
        return shared;
      },
    },
    vd: {
      publicKey: vdPub,
      async sign(purpose: VdPurpose, msg) {
        if (!VD_PURPOSES.includes(purpose)) throw new VaultKeysError('purpose_not_allowed');
        const sig = field(await control('crypto.signVd', { purpose, msg: msgOk(msg) }), 'sig');
        if (sig.length !== 64) throw new VaultKeysError('vault.bad_result');
        return sig;
      },
    },
    aik: {
      publicKey: aikPub,
      async sign(purpose: AikPurpose, msg) {
        if (!AIK_PURPOSES.includes(purpose)) throw new VaultKeysError('purpose_not_allowed');
        const sig = field(await control('crypto.signAik', { purpose, msg: msgOk(msg) }), 'sig');
        if (sig.length !== 64) throw new VaultKeysError('vault.bad_result');
        return sig;
      },
    },
    kvPublic: () => kvPub.slice(),
    qdPublic: qdPub,
    async hpkeOpen(r) {
      // @sax/remote는 info를 바이트로 넘긴다. 금고는 고정 문자열 하나만 받는다.
      if (!(r.info instanceof Uint8Array) || new TextDecoder().decode(r.info) !== HPKE_INFO) throw new VaultKeysError('vault.bad_params');
      return field(await control('crypto.hpkeOpen', { enc: r.enc, ct: msgOk(r.ct), info: HPKE_INFO, aad: r.aad }), 'pt');
    },
  };
}

// remote-ports.ts VaultKeysFactory에 맞는다(돌려주는 값이 DesktopKeys의 상위 형식).
vaultDesktopKeys satisfies VaultKeysFactory;
