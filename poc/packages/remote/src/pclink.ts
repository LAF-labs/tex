import { b64, concat, equal, fromB64, readU64be, utf8 } from './bytes.ts';
import { CTX } from './contexts.ts';
import { hkdfSha256, randomBytes, sha256Hash } from './crypto.ts';
import { addDevice, certNotAfter, issueCert, verifyCert, verifyDeviceList, type SignedCert } from './devlist.ts';
import type { DeviceListJson } from './envelope.ts';
import { jcsBytes } from './jcs.ts';
import type { AikSigner } from './keys.ts';

export const PCLINK_SAS_MAX_TRIES = 3;
/** 6자리 단계(challenge를 낸 뒤 승인까지)의 유효 시간. 신청 자체는 서버가 7일 둔다. */
export const PCLINK_STEP_MS = 10 * 60_000;

export interface PcLinkHello {
  v: 1;
  device_id: string;
  Sx: string;
  Vx: string;
  Hx: string;
  commit: string;
}
export interface PcLinkChallenge {
  v: 1;
  device_id: string;
  aik_pub: string;
  nonce: string;
}
export interface PcLinkReveal {
  v: 1;
  nonce: string;
}
export interface PcLinkGrant {
  v: 1;
  cert: SignedCert;
  deviceList: DeviceListJson;
  enc: string;
  ct: string;
}

const UUID4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const key32 = (s: unknown): Uint8Array | null => {
  if (typeof s !== 'string' || s.length > 64) return null;
  try {
    const k = fromB64(s);
    return k.length === 32 && b64(k) === s ? k : null;
  } catch {
    return null;
  }
};
const onlyKeys = (v: unknown, keys: readonly string[]): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v) && Object.keys(v).length === keys.length && keys.every((k) => k in v);

const helloKeys = (h: Pick<PcLinkHello, 'device_id' | 'Sx' | 'Vx' | 'Hx'>) => jcsBytes({ device_id: h.device_id, Sx: h.Sx, Vx: h.Vx, Hx: h.Hx });
const commitOf = (nonce: Uint8Array, h: Pick<PcLinkHello, 'device_id' | 'Sx' | 'Vx' | 'Hx'>) => sha256Hash(concat(utf8(CTX.pclinkCommit), nonce, helloKeys(h)));

/** 서버에서 온 hello의 모양(믿을 수 없는 입력). 맞지 않으면 null. */
export function parsePcLinkHello(v: unknown): PcLinkHello | null {
  if (!onlyKeys(v, ['v', 'device_id', 'Sx', 'Vx', 'Hx', 'commit']) || v.v !== 1) return null;
  if (typeof v.device_id !== 'string' || !UUID4.test(v.device_id)) return null;
  if (!key32(v.Sx) || !key32(v.Vx) || !key32(v.Hx) || !key32(v.commit)) return null;
  return { v: 1, device_id: v.device_id, Sx: v.Sx as string, Vx: v.Vx as string, Hx: v.Hx as string, commit: v.commit as string };
}
export function parsePcLinkChallenge(v: unknown): PcLinkChallenge | null {
  if (!onlyKeys(v, ['v', 'device_id', 'aik_pub', 'nonce']) || v.v !== 1) return null;
  if (typeof v.device_id !== 'string' || !UUID4.test(v.device_id) || !key32(v.aik_pub) || !key32(v.nonce)) return null;
  return { v: 1, device_id: v.device_id, aik_pub: v.aik_pub as string, nonce: v.nonce as string };
}
export function parsePcLinkReveal(v: unknown): PcLinkReveal | null {
  if (!onlyKeys(v, ['v', 'nonce']) || v.v !== 1 || !key32(v.nonce)) return null;
  return { v: 1, nonce: v.nonce as string };
}

/** [새 PC] m1. nonce는 challenge를 받을 때까지 내보내지 않는다. */
export function pcLinkHello(self: { deviceId: string; noisePub: Uint8Array; signPub: Uint8Array; linkPub: Uint8Array }): { hello: PcLinkHello; nonce: Uint8Array } {
  if (!UUID4.test(self.deviceId) || self.noisePub.length !== 32 || self.signPub.length !== 32 || self.linkPub.length !== 32) throw new Error('pclink: bad self');
  const nonce = randomBytes(32);
  const keys = { device_id: self.deviceId, Sx: b64(self.noisePub), Vx: b64(self.signPub), Hx: b64(self.linkPub) };
  return { hello: { v: 1, ...keys, commit: b64(commitOf(nonce, keys)) }, nonce };
}

/** [기존 PC] m2. hello(commit)를 받은 뒤에만 부른다(난수를 commit보다 먼저 내면 6자리를 고를 수 있게 된다). */
export function pcLinkChallenge(hello: PcLinkHello, self: { deviceId: string; aikPub: Uint8Array }): PcLinkChallenge {
  if (!parsePcLinkHello(hello)) throw new Error('pclink: bad hello');
  if (!UUID4.test(self.deviceId) || self.aikPub.length !== 32) throw new Error('pclink: bad self');
  return { v: 1, device_id: self.deviceId, aik_pub: b64(self.aikPub), nonce: b64(randomBytes(32)) };
}

/** 두 쪽이 같은 값을 본다는 것을 묶는 해시. 6자리와 RK 봉인의 aad에 쓴다. */
export function pcLinkTranscript(hello: PcLinkHello, challenge: PcLinkChallenge, nonceN: Uint8Array): Uint8Array {
  return sha256Hash(concat(utf8(CTX.pclink), jcsBytes({ hello, challenge, nonce_n: b64(nonceN) })));
}

/** 6자리(앞자리 0 유지). */
export function pcLinkSas(transcript: Uint8Array): string {
  const x = readU64be(hkdfSha256(transcript, CTX.pclinkSas, 8), 0);
  return (x % 1_000_000n).toString().padStart(6, '0');
}

/** [새 PC] challenge를 받은 뒤: 보일 6자리와 m3. 내 기기 ID로 승인하겠다는 challenge는 거부한다. */
export function pcLinkReveal(hello: PcLinkHello, challenge: unknown, nonce: Uint8Array): { reveal: PcLinkReveal; sas: string; transcript: Uint8Array } {
  const c = parsePcLinkChallenge(challenge);
  if (!c || c.device_id === hello.device_id) throw new Error('pclink: bad challenge');
  const transcript = pcLinkTranscript(hello, c, nonce);
  return { reveal: { v: 1, nonce: b64(nonce) }, sas: pcLinkSas(transcript), transcript };
}

export type PcLinkApproveState = 'awaiting_reveal' | 'awaiting_sas' | 'approved' | 'failed';

/**
 * [기존 PC] 승인 쪽 상태. challenge를 낸 뒤 reveal을 받아 commit을 확인하고, 사용자가 넣은 6자리를 3번까지 본다.
 * 맞으면 grant()가 목록·인증서·봉인문을 만든다. 실패하면 호출자가 신청을 버린다(서버에서 지운다).
 */
export class PcLinkApprover {
  readonly hello: PcLinkHello;
  readonly challenge: PcLinkChallenge;
  #transcript: Uint8Array | null = null;
  #tries = 0;
  #state: PcLinkApproveState = 'awaiting_reveal';
  #deadline: number;
  #now: () => number;

  constructor(hello: PcLinkHello, self: { deviceId: string; aikPub: Uint8Array }, now: () => number = Date.now) {
    this.hello = hello;
    this.challenge = pcLinkChallenge(hello, self);
    this.#now = now;
    this.#deadline = now() + PCLINK_STEP_MS;
  }

  get state(): PcLinkApproveState {
    return this.#state;
  }
  get triesLeft(): number {
    return PCLINK_SAS_MAX_TRIES - this.#tries;
  }

  reveal(m: unknown): boolean {
    if (this.#state !== 'awaiting_reveal') throw new Error('pclink: not awaiting reveal');
    const r = parsePcLinkReveal(m);
    const nonce = r ? fromB64(r.nonce) : null;
    if (!nonce || this.#now() > this.#deadline || !equal(commitOf(nonce, this.hello), fromB64(this.hello.commit))) {
      this.#state = 'failed';
      return false;
    }
    this.#transcript = pcLinkTranscript(this.hello, this.challenge, nonce);
    this.#state = 'awaiting_sas';
    return true;
  }

  confirm(code: string): boolean {
    if ((this.#state !== 'awaiting_sas' && this.#state !== 'approved') || !this.#transcript) throw new Error('pclink: not awaiting sas');
    if (this.#now() > this.#deadline) {
      this.#state = 'failed';
      return false;
    }
    const good = /^\d{6}$/.test(code) && equal(utf8(code), utf8(pcLinkSas(this.#transcript)));
    if (good) {
      this.#state = 'approved';
      return true;
    }
    this.#tries++;
    this.#state = this.#tries >= PCLINK_SAS_MAX_TRIES ? 'failed' : 'awaiting_sas';
    return false;
  }

  async listWithNew(aik: AikSigner, deviceList: DeviceListJson, now: number = this.#now()): Promise<DeviceListJson> {
    this.#needApproved(aik);
    return addDevice(aik, deviceList, { deviceId: this.hello.device_id, role: 'desktop', noisePub: fromB64(this.hello.Sx), signPub: fromB64(this.hello.Vx), registeredAt: now });
  }

  async grant(o: { aik: AikSigner; deviceList: DeviceListJson; sealRk: (recipient: Uint8Array, info: Uint8Array, aad: Uint8Array) => Promise<{ enc: Uint8Array; ct: Uint8Array }>; now?: number }): Promise<PcLinkGrant> {
    const transcript = this.#needApproved(o.aik);
    const h = this.hello;
    if (!o.deviceList.entries.some((e) => e.entry.device_id === h.device_id && e.entry.role === 'desktop' && e.entry.Sx === h.Sx && e.entry.Vx === h.Vx)) throw new Error('pclink: not listed');
    const cert = await issueCert(o.aik, { device_id: h.device_id, role: 'desktop', Sx: fromB64(h.Sx), Vx: fromB64(h.Vx), not_after: certNotAfter(o.now ?? this.#now()) });
    const sealed = await o.sealRk(fromB64(h.Hx), utf8(CTX.pclinkRk), transcript);
    return { v: 1, cert, deviceList: o.deviceList, enc: b64(sealed.enc), ct: b64(sealed.ct) };
  }

  #needApproved(aik: AikSigner): Uint8Array {
    if (this.#state !== 'approved' || !this.#transcript) throw new Error('pclink: not approved');
    if (!equal(aik.publicKey, fromB64(this.challenge.aik_pub))) throw new Error('pclink: aik changed');
    return this.#transcript;
  }
}

export type PcLinkGrantCheck =
  | { ok: true; cert: SignedCert; deviceList: DeviceListJson; aikPub: Uint8Array; enc: Uint8Array; ct: Uint8Array; info: Uint8Array; aad: Uint8Array }
  | { ok: false; reason: 'shape' | 'list' | 'not_listed' | 'cert' | 'approver' };

/**
 * [새 PC] m4를 본다: 목록과 인증서가 challenge의 AIK로 서명됐는지, 내 키가 목록·인증서에 그대로 있는지, 승인한 PC가 목록의 데스크톱인지.
 * 통과하면 금고에 넘길 값(enc·ct·info·aad·기대 AIK)을 돌려준다. RK를 여는 것과 "연 RK의 AIK = aikPub" 확인은 금고가 한다.
 */
export function checkPcLinkGrant(hello: PcLinkHello, challenge: PcLinkChallenge, transcript: Uint8Array, grant: unknown, now = Date.now()): PcLinkGrantCheck {
  if (!onlyKeys(grant, ['v', 'cert', 'deviceList', 'enc', 'ct']) || grant.v !== 1) return { ok: false, reason: 'shape' };
  const enc = key32(grant.enc);
  let ct: Uint8Array;
  try {
    if (typeof grant.ct !== 'string' || grant.ct.length > 256) return { ok: false, reason: 'shape' };
    ct = fromB64(grant.ct);
  } catch {
    return { ok: false, reason: 'shape' };
  }
  if (!enc || ct.length !== 48) return { ok: false, reason: 'shape' };
  const aikPub = fromB64(challenge.aik_pub);
  const l = verifyDeviceList(grant.deviceList as DeviceListJson, aikPub);
  if (!l.ok) return { ok: false, reason: 'list' };
  const me = l.devices.find((d) => d.deviceId === hello.device_id);
  if (!me || me.role !== 'desktop' || b64(me.noisePub) !== hello.Sx || b64(me.signPub) !== hello.Vx) return { ok: false, reason: 'not_listed' };
  if (!l.devices.some((d) => d.deviceId === challenge.device_id && d.role === 'desktop')) return { ok: false, reason: 'approver' };
  const c = verifyCert(grant.cert as SignedCert, aikPub, now);
  if (!c || c.device_id !== hello.device_id || c.role !== 'desktop' || b64(c.Sx) !== hello.Sx || b64(c.Vx) !== hello.Vx) return { ok: false, reason: 'cert' };
  return { ok: true, cert: grant.cert as SignedCert, deviceList: l.list, aikPub, enc, ct, info: utf8(CTX.pclinkRk), aad: transcript };
}
