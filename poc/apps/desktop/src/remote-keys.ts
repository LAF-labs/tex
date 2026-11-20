import { AIK_PURPOSES, CTX, SHARE_MAX_EPOCH, VD_PURPOSES, type AikPurpose, type DesktopKeys, type HpkeOpenFn, type NoiseCtx, type VdPurpose } from '@sax/remote';
import { CRYPTO_MSG_MAX, SHARE_SIGN_MSG_MAX, type VaultPublicKeys } from '@sax/vault';
import type { PcLinkVault, ShareVault, VaultKeysFactory } from './remote-ports.ts';

export type VaultControl = Parameters<VaultKeysFactory>[0];

export type VaultDesktopKeys = DesktopKeys & {
  hpkeOpen: HpkeOpenFn;
  qdPublic: Uint8Array;
  link: PcLinkVault;
  share: ShareVault;
};

const NOISE_CTX: readonly NoiseCtx[] = [CTX.pair, CTX.session];
const HPKE_INFO = CTX.env;
const RK_INFO = CTX.pclinkRk;
const rkInfo = (info: Uint8Array): string | null => {
  const s = new TextDecoder().decode(info);
  return s === RK_INFO || s === CTX.rkEscrow ? s : null;
};

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
const field = (r: unknown, k: 'shared' | 'sig' | 'pt' | 'pub' | 'enc' | 'ct' | 'aik' | 'key' | 'signPub'): Uint8Array => {
  const v = (r as Record<string, unknown> | null)?.[k];
  if (!(v instanceof Uint8Array)) throw new VaultKeysError('vault.bad_result');
  return v;
};
const isLen = (v: unknown, n: number): v is Uint8Array => v instanceof Uint8Array && v.length === n;
const msgOk = (m: unknown): Uint8Array => {
  if (!(m instanceof Uint8Array) || m.length > CRYPTO_MSG_MAX) throw new VaultKeysError('vault.bad_params');
  return m;
};

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
      if (!(r.info instanceof Uint8Array) || new TextDecoder().decode(r.info) !== HPKE_INFO) throw new VaultKeysError('vault.bad_params');
      return field(await control('crypto.hpkeOpen', { enc: r.enc, ct: msgOk(r.ct), info: HPKE_INFO, aad: r.aad }), 'pt');
    },
    link: {
      async key() {
        return bytes32(field(await control('crypto.linkKey'), 'pub'));
      },
      async sealRk(recipient, info, aad) {
        const i = rkInfo(info);
        if (!i || !isLen(recipient, 32) || !isLen(aad, 32)) throw new VaultKeysError('vault.bad_params');
        const r = await control('crypto.rkSeal', { recipient, info: i, aad });
        const enc = bytes32(field(r, 'enc'));
        const ct = field(r, 'ct');
        if (ct.length !== 48) throw new VaultKeysError('vault.bad_result');
        return { enc, ct: new Uint8Array(ct) };
      },
      async importRk(g) {
        const i = rkInfo(g.info);
        if (!i || !isLen(g.enc, 32) || !isLen(g.ct, 48) || !isLen(g.aad, 32) || !isLen(g.aikPub, 32)) throw new VaultKeysError('vault.bad_params');
        const aik = bytes32(field(await control('crypto.rkImport', { enc: g.enc, ct: g.ct, info: i, aad: g.aad, aikPub: g.aikPub }), 'aik'));
        if (!aik.every((b, i) => b === g.aikPub[i])) throw new VaultKeysError('vault.bad_result');
        return aik;
      },
    },
    share: {
      async key(epoch) {
        if (!Number.isSafeInteger(epoch) || epoch < 0 || epoch > SHARE_MAX_EPOCH) throw new VaultKeysError('vault.bad_params');
        const r = await control('crypto.shareKey', { epoch });
        return { key: bytes32(field(r, 'key')), signPub: bytes32(field(r, 'signPub')) };
      },
      async sign(msg) {
        if (!(msg instanceof Uint8Array) || msg.length < 1 || msg.length > SHARE_SIGN_MSG_MAX) throw new VaultKeysError('vault.bad_params');
        const sig = field(await control('crypto.signShare', { msg }), 'sig');
        if (sig.length !== 64) throw new VaultKeysError('vault.bad_result');
        return sig;
      },
    },
  };
}

vaultDesktopKeys satisfies VaultKeysFactory;
