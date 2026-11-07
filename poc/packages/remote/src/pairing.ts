// D08 §4 페어링: QR + Noise_XXpsk0(개시자 폰, psk=ps) + 6자리 SAS(폰이 표시, 사용자가 PC에 입력) + AIK 서명 기기 목록.
// 양쪽 상태 머신. 화면(S-03 PC, P-06 폰)은 상태와 이벤트만 본다. 실패 이유는 로컬 UI 전용(C/X-12).

import { b64, concat, equal, fromB64, readU64be, u64be, utf8 } from './bytes.ts';
import { decodeCbor, encodeCbor } from './cbor.ts';
import { Channel } from './channel.ts';
import { CTX } from './contexts.ts';
import { hkdfSha256, randomBytes } from './crypto.ts';
import { certNotAfter, decodeCertField, encodeCertField, issueCert, signKv, verifyCert, verifyDeviceList, verifyKv, upsertDevice, type CertBody, type SignedCert } from './devlist.ts';
import type { DeviceListJson, PairOkBody } from './envelope.ts';
import { encodeHs, KIND, parseFrame, Transport } from './frame.ts';
import type { DesktopKeys, NoiseStatic } from './keys.ts';
import { Handshake } from './noise.ts';
import { decodeQr, encodeQr, QR_TTL_SEC, type PairIntent } from './qr.ts';
import { hasControl, verifyAcctClaim, type AcctClaim } from './acctclaim.ts';
import { attachQueue, nextFrame, type Link } from './relay.ts';
import { ulid } from './ulid.ts';

export const SAS_MAX_TRIES = 3;
/** pairing.newDesktopWarnHours = 24 (앱 내장, 정책으로 완화 불가) */
export const NEW_DESKTOP_WARN_MS = 24 * 3_600_000;
export const HS_TIMEOUT_MS = 30_000;
/** 서류 열람 범위 기본값(D07 remote_devices.doc_scope_json, ADR-029). */
export const DEFAULT_DOC_SCOPE = { slots: ['business'] as ('business' | 'personal')[], docTypes: '*' as const };

export function pairPrologue(roomId: Uint8Array, relayHost: string, exp: number): Uint8Array {
  const host = utf8(relayHost);
  return concat(utf8(CTX.pair), roomId, Uint8Array.of(host.length), host, u64be(exp));
}

/** SAS = HKDF(h, "SAX-SAS-v1") mod 10^6, 6자리(앞자리 0 유지). */
export function deriveSas(h: Uint8Array): string {
  const x = readU64be(hkdfSha256(h, CTX.sas, 8), 0);
  return (x % 1_000_000n).toString().padStart(6, '0');
}

/** 폰이 msg3에 싣는 자기 정보. 푸시 토큰은 넣지 않는다(§4.2 4단계). */
export interface PhoneHello {
  deviceId: string;
  name: string;
  platform: 'ios' | 'android';
  Vm: Uint8Array;
  Km: Uint8Array;
}

function encodePhoneHello(p: PhoneHello): Uint8Array {
  return encodeCbor({ deviceId: p.deviceId, name: p.name.slice(0, 40), platform: p.platform, Vm: p.Vm, Km: p.Km });
}
function decodePhoneHello(b: Uint8Array): PhoneHello | null {
  try {
    const m = decodeCbor(b, { maxBytes: 512 }) as Record<string, unknown>;
    const k32 = (x: unknown): x is Uint8Array => x instanceof Uint8Array && x.length === 32;
    if (typeof m.deviceId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(m.deviceId)) return null;
    if (typeof m.name !== 'string' || m.name.length > 40) return null;
    if (m.platform !== 'ios' && m.platform !== 'android') return null;
    if (!k32(m.Vm) || !k32(m.Km)) return null;
    return { deviceId: m.deviceId, name: m.name, platform: m.platform, Vm: m.Vm, Km: m.Km };
  } catch {
    return null;
  }
}

// ============================ PC(응답자) ============================

export type DesktopPairState = 'idle' | 'waiting_phone' | 'awaiting_sas' | 'paired' | 'failed';

export interface DesktopPairingOptions {
  keys: DesktopKeys;
  /** 지금 기기 목록(AIK 서명). */
  deviceList: DeviceListJson;
  relayHost: string;
  intent?: PairIntent;
  now?: () => number;
  /**
   * §4.2 7단계(팀장 결정 2026-11-06): 폰에는 계정 로그인이 없으므로 PC가 데스크톱 기기 토큰으로 폰을 계정에 대신 등록한다
   * (`POST /v1/devices/enroll` + 이 룸 id). 릴레이는 룸이 열려 있는 동안만 받으므로 `pair.ok` 전에 부른다.
   * 서버는 같은 키 재등록을 200으로 받는다(#122, 룸 미소비): 목록을 올리기 전에 실패한 시도의 재시도도 그대로 부르면 된다.
   * 던지면 페어링을 멈춘다. 이 PC의 기기 목록에 이미 같은 키로 있는 폰(다시 연결)은 부르지 않는다(D08 §4.2 7단계).
   */
  enrollPhone: (p: { deviceId: string; platform: 'ios' | 'android'; name: string; Sm: Uint8Array; Vm: Uint8Array; roomId: Uint8Array }) => Promise<void>;
  /**
   * 계정 서비스가 서명한 계정 확인 주장(acctclaim.ts 운반 형식 그대로). pair.ok에 싣는다(설계 #120, 팀장 결정 2026-11-06).
   * 폰은 이것 없이는 저장하지 않는다.
   */
  accountClaim: () => Promise<string>;
  /** PC가 폰에 알릴 이름(서명 없음, 폰은 참고 표시만). */
  desktopName?: string;
  /** 새 기기 목록을 서버에 올린다(7단계). */
  publishDeviceList: (list: DeviceListJson) => Promise<void>;
  /** 우편함 등록(서버는 토큰 해시만 저장). */
  registerMailbox: (mbxId: Uint8Array, tokRead: Uint8Array, tokWrite: Uint8Array) => Promise<void>;
  mbxEpoch?: number;
}

export interface DesktopPairResult {
  pairId: string;
  phone: PhoneHello & { Sm: Uint8Array; registeredAt: number; certNotAfter: number };
  deviceList: DeviceListJson;
  mbxId: Uint8Array;
  tokRead: Uint8Array;
  tokWrite: Uint8Array;
  mbxEpoch: number;
  docScope: typeof DEFAULT_DOC_SCOPE;
  /** pair.ok를 보낸 채널. kek.grant(8단계, 별도 Hello)를 보낼 수 있고, 끝나면 닫는다. */
  channel: Channel;
}

export class DesktopPairing {
  state: DesktopPairState = 'idle';
  readonly roomId = randomBytes(16);
  #ps = randomBytes(32);
  #o: DesktopPairingOptions;
  #exp = 0;
  #hs: Handshake | null = null;
  #link: Link | null = null;
  #phone: (PhoneHello & { Sm: Uint8Array }) | null = null;
  #sas: string | null = null;
  #tries = 0;
  #now: () => number;
  #onState: ((s: DesktopPairState) => void)[] = [];

  constructor(o: DesktopPairingOptions) {
    this.#o = o;
    this.#now = o.now ?? Date.now;
  }

  onState(cb: (s: DesktopPairState) => void): void {
    this.#onState.push(cb);
  }
  #set(s: DesktopPairState) {
    this.state = s;
    for (const cb of this.#onState) cb(s);
  }

  /** 1~2단계: QR 텍스트(창은 화면 캡처 차단, 데스크톱 트랙 몫). 룸 발급 후 부른다. */
  offer(): { qr: string; exp: number } {
    if (this.state !== 'idle') throw new Error('pairing: already started');
    this.#exp = Math.floor(this.#now() / 1000) + QR_TTL_SEC;
    const qr = encodeQr({ intent: this.#o.intent ?? 'pair', relayHost: this.#o.relayHost, roomId: this.roomId, desktopStatic: this.#o.keys.noise.publicKey, psk: this.#ps, exp: this.#exp });
    this.#set('waiting_phone');
    return { qr, exp: this.#exp };
  }

  get expired(): boolean {
    return this.#now() / 1000 > this.#exp;
  }

  /** 룸 링크에서 폰의 msg1·msg3를 받는다. 성공하면 awaiting_sas. */
  async run(link: Link): Promise<void> {
    if (this.state !== 'waiting_phone') throw new Error('pairing: not waiting');
    this.#link = link;
    attachQueue(link);
    try {
      const hs = new Handshake({
        pattern: 'XX', psks: [0], initiator: false, ctx: CTX.pair, s: this.#o.keys.noise, psk: [this.#ps],
        prologue: pairPrologue(this.roomId, this.#o.relayHost, this.#exp),
      });
      this.#hs = hs;
      const m1 = await this.#readHs();
      if (!m1 || this.expired) return this.#fail();
      await hs.readMessage(m1);
      link.send(encodeHs(await hs.writeMessage(encodeCbor({ name: 'PC' }))));
      const m3 = await this.#readHs();
      if (!m3 || this.expired) return this.#fail();
      const hello = decodePhoneHello(await hs.readMessage(m3));
      const Sm = hs.remoteStatic;
      if (!hello || !Sm) return this.#fail();
      this.#phone = { ...hello, Sm };
      this.#sas = deriveSas(hs.handshakeHash);
      this.#set('awaiting_sas');
    } catch {
      this.#fail();
    }
  }

  async #readHs(): Promise<Uint8Array | null> {
    const f = await nextFrame(this.#link!, HS_TIMEOUT_MS);
    const p = f ? parseFrame(f) : null;
    return p && p.kind === KIND.HS ? p.body : null;
  }

  #fail(): void {
    this.#ps.fill(0);
    this.#link?.close();
    this.#set('failed');
  }

  /** 사람 이름(메시지 3의 기기 이름). SAS 입력 창에 보인다. */
  get phoneName(): string | null {
    return this.#phone?.name ?? null;
  }

  /**
   * 6단계: 사용자가 폰의 6자리를 PC에 입력한다("일치" 버튼 금지). 3회 실패·TTL 경과 시 룸 폐기.
   * 맞으면 7단계(Cert_M·기기 목록 서명·업로드·pair.ok)까지 하고 결과를 돌려준다.
   */
  async submitSas(code: string): Promise<{ ok: true; result: DesktopPairResult } | { ok: false; triesLeft: number }> {
    if (this.state !== 'awaiting_sas' || !this.#hs || !this.#phone || !this.#sas) throw new Error('pairing: not awaiting sas');
    if (this.expired) {
      this.#fail();
      return { ok: false, triesLeft: 0 };
    }
    const good = /^\d{6}$/.test(code) && equal(utf8(code), utf8(this.#sas));
    if (!good) {
      this.#tries++;
      const left = SAS_MAX_TRIES - this.#tries;
      if (left <= 0) this.#fail();
      return { ok: false, triesLeft: Math.max(0, left) };
    }
    const phone = this.#phone;
    try {
      // 순서(D08 §4.2 7단계): SAS 일치 → 대리 등록 → Cert_M·목록 서명·업로드 → 우편함 → pair.ok. 룸은 한쪽이 나가면 폐기되므로
      // 등록은 pair.ok 전, 룸이 열려 있을 때 한다.
      const known = this.#o.deviceList.entries.some(
        (e) => e.entry.device_id === phone.deviceId && e.entry.role === 'mobile' && e.entry.Sx === b64(phone.Sm) && e.entry.Vx === b64(phone.Vm),
      ) && !this.#o.deviceList.revoked.some((r) => r.device_id === phone.deviceId);
      if (!known) await this.#o.enrollPhone({ deviceId: phone.deviceId, platform: phone.platform, name: phone.name, Sm: phone.Sm, Vm: phone.Vm, roomId: this.roomId });
      const now = this.#now();
      const notAfter = certNotAfter(now);
      const certBody: CertBody = { device_id: phone.deviceId, role: 'mobile', Sx: phone.Sm, Vx: phone.Vm, Kx: phone.Km, not_after: notAfter };
      const cert = encodeCertField(await issueCert(this.#o.keys.aik, certBody));
      // 앞 시도가 목록을 올린 뒤 실패했으면 같은 폰을 다시 서명한다(재시도 가능, 키가 다르면 거부).
      const list = await upsertDevice(this.#o.keys.aik, this.#o.deviceList, { deviceId: phone.deviceId, role: 'mobile', noisePub: phone.Sm, signPub: phone.Vm, registeredAt: now });
      await this.#o.publishDeviceList(list);
      // 우편함 ID·토큰은 CSPRNG 32B. 핸드셰이크 해시 h에서 파생하지 않는다(C-16).
      const mbxId = randomBytes(32), tokRead = randomBytes(32), tokWrite = randomBytes(32);
      await this.#o.registerMailbox(mbxId, tokRead, tokWrite);
      const kvPub = this.#o.keys.kvPublic();
      const mbxEpoch = this.#o.mbxEpoch ?? 0;
      const acctClaim = await this.#o.accountClaim();
      const body: PairOkBody = {
        cert, aikPub: b64(this.#o.keys.aik.publicKey), kvPub: b64(kvPub), kvSig: await signKv(this.#o.keys.vd, kvPub), deviceList: list,
        mbxId: b64(mbxId), tokRead: b64(tokRead), tokWrite: b64(tokWrite), mbxEpoch, acctClaim,
        ...(this.#o.desktopName ? { desktopName: this.#o.desktopName.slice(0, 40) } : {}),
      };
      const pairId = ulid(now);
      const channel = new Channel(this.#link!, new Transport(this.#hs.split()), { pairId, me: 'desktop', now: this.#now });
      channel.send('pair.ok', body, { ttl: 120 });
      this.#ps.fill(0);
      this.#set('paired');
      return {
        ok: true,
        result: { pairId, phone: { ...phone, registeredAt: now, certNotAfter: notAfter }, deviceList: list, mbxId, tokRead, tokWrite, mbxEpoch, docScope: { ...DEFAULT_DOC_SCOPE, slots: [...DEFAULT_DOC_SCOPE.slots] }, channel },
      };
    } catch {
      this.#fail();
      return { ok: false, triesLeft: 0 };
    }
  }

  cancel(): void {
    if (this.state !== 'paired') this.#fail();
  }
}

/** remote_devices.doc_scope_json 값. 개인 프로필이 없으면 personal은 고를 수 없다(8단계). */
export function docScopeJson(scope: { business: boolean; personal: boolean }, hasPersonalProfile: boolean): string {
  const slots: string[] = [];
  if (scope.business) slots.push('business');
  if (scope.personal && hasPersonalProfile) slots.push('personal');
  return JSON.stringify({ slots, docTypes: '*' });
}

// ============================ 폰(개시자) ============================

export type MobilePairState = 'idle' | 'scanned' | 'handshaking' | 'show_sas' | 'paired' | 'failed';
export type MobilePairFailure =
  | 'qr_invalid' | 'qr_expired' | 'relay_not_allowed' | 'devlist_invalid' | 'desktop_unknown' | 'handshake' | 'pair_ok_invalid' | 'aik_mismatch'
  | 'acct_claim_invalid' | 'timeout';

export interface PhoneKeys {
  noise: NoiseStatic;
  vmPub: Uint8Array;
  kmPub: Uint8Array;
  deviceId: string;
  name: string;
  platform: 'ios' | 'android';
}

export interface MobilePairingOptions {
  keys: PhoneKeys;
  /**
   * 이 폰이 앞서 페어링하며 고정한 계정 AIK_pub(다시 연결이면 저장값, 처음이면 없음). 있으면 PAIR_OK의 AIK_pub와 같아야 한다.
   * 폰에는 계정 로그인이 없어 서버에서 AIK_pub·기기 목록을 받지 않는다(팀장 결정 2026-11-06, D08 §4.2 3단계).
   */
  knownAikPub?: Uint8Array;
  /** 앱에 고정한 계정 서비스 공개키(acct_claim 검증, 회전 대비 여러 개). 비어 있으면 페어링은 늘 실패한다. */
  accountKeys: readonly Uint8Array[];
  /** 이 폰이 본 가장 높은 listVersion(재페어링이면 저장값). */
  seenListVersion?: number;
  relayAllowlist: readonly string[];
  now?: () => number;
  /** pair.ok 대기(사용자가 PC에 6자리를 입력할 시간 포함). */
  pairOkTimeoutMs?: number;
}

/**
 * 저장 전 확인 화면(설계 #120, 팀장 결정 2026-11-06). account는 계정 서비스 서명을 검증한 주장이다(이메일 전체를 보인다).
 * desktopName은 PC가 스스로 알린 이름이라 "PC가 알려 준 이름"으로 참고 표시만 한다.
 */
export interface PairIdentity {
  account: AcctClaim;
  desktopName: string | null;
}

const readDesktopName = (v: unknown): string | null => {
  const t = typeof v === 'string' ? v.trim() : '';
  return t.length >= 1 && t.length <= 40 && !hasControl(t) ? t : null;
};

export interface MobilePairResult {
  pairId: string;
  /** AIK 서명 기기 인증서. 계정 서비스 POST /v1/device-tokens의 `cert`로 그대로 보낸다. */
  cert: SignedCert;
  aikPub: Uint8Array;
  desktopStatic: Uint8Array;
  desktopVd: Uint8Array;
  desktopDeviceId: string;
  kvPub: Uint8Array;
  deviceList: DeviceListJson;
  mbxId: string;
  tokRead: string;
  tokWrite: string;
  mbxEpoch: number;
  relayHost: string;
  certNotAfter: number;
  /** 저장 전 확인 화면(검증된 계정 주장·PC가 알린 이름). */
  identity: PairIdentity;
  channel: Channel;
}

export class MobilePairing {
  state: MobilePairState = 'idle';
  failure: MobilePairFailure | null = null;
  /** 3단계 검사(7단계 PAIR_OK에서): 이 PC가 24시간 안에 등록되었으면 저장 전에 전면 경고를 띄운다. */
  newDesktopWarning = false;
  sas: string | null = null;
  #o: MobilePairingOptions;
  #now: () => number;
  #qr: ReturnType<typeof decodeQr> = null;
  #desktop: { deviceId: string; Vd: Uint8Array } | null = null;
  #account: AcctClaim | null = null;
  #onState: ((s: MobilePairState) => void)[] = [];

  constructor(o: MobilePairingOptions) {
    this.#o = o;
    this.#now = o.now ?? Date.now;
  }
  onState(cb: (s: MobilePairState) => void): void {
    this.#onState.push(cb);
  }
  #set(s: MobilePairState) {
    this.state = s;
    for (const cb of this.#onState) cb(s);
  }
  #fail(f: MobilePairFailure): false {
    this.failure = f;
    this.#set('failed');
    return false;
  }

  /**
   * 3단계: 앱 안 스캐너가 읽은 텍스트를 검사한다(만료·릴레이 허용 목록). 기기 목록 검사(AIK 서명·Sd가 데스크톱 항목에 있음·24시간)는
   * PAIR_OK의 AIK 서명 목록으로 한다(팀장 결정 2026-11-06, D08 §4.2 3단계).
   */
  scan(text: string): boolean {
    if (this.state !== 'idle' && this.state !== 'scanned' && this.state !== 'failed') throw new Error('pairing: busy');
    // 다시 스캔하면 지난 시도의 실패·SAS·QR을 지운다.
    this.failure = null;
    this.sas = null;
    this.newDesktopWarning = false;
    this.#qr = null;
    this.#desktop = null;
    this.#account = null;
    const q = decodeQr(text);
    if (!q || q.intent !== 'pair') return this.#fail('qr_invalid');
    if (this.#now() / 1000 > q.exp) return this.#fail('qr_expired');
    if (!this.#o.relayAllowlist.includes(q.relayHost)) return this.#fail('relay_not_allowed');
    this.#qr = q;
    this.#set('scanned');
    return true;
  }

  get roomId(): Uint8Array {
    if (!this.#qr) throw new Error('pairing: not scanned');
    return this.#qr.roomId;
  }

  /** QR이 고른 릴레이(허용 목록 검사를 통과한 값). */
  get relayHost(): string {
    if (!this.#qr) throw new Error('pairing: not scanned');
    return this.#qr.relayHost;
  }

  /** 4~7단계. show_sas 상태에서 SAS를 보여 주고, 사용자가 PC에 입력하면 pair.ok를 받아 끝난다. */
  async run(link: Link): Promise<MobilePairResult | null> {
    if (this.state !== 'scanned' || !this.#qr) throw new Error('pairing: not scanned');
    const q = this.#qr;
    const k = this.#o.keys;
    attachQueue(link);
    this.#set('handshaking');
    try {
      const hs = new Handshake({
        pattern: 'XX', psks: [0], initiator: true, ctx: CTX.pair, s: k.noise, psk: [q.psk],
        rs: q.desktopStatic, // msg2에서 rs == Sd 확인
        prologue: pairPrologue(q.roomId, q.relayHost, q.exp),
      });
      q.psk.fill(0);
      link.send(encodeHs(await hs.writeMessage()));
      const f2 = await nextFrame(link, HS_TIMEOUT_MS);
      const p2 = f2 ? parseFrame(f2) : null;
      if (!p2 || p2.kind !== KIND.HS) return this.#fail('timeout') || null;
      await hs.readMessage(p2.body);
      link.send(encodeHs(await hs.writeMessage(encodePhoneHello({ deviceId: k.deviceId, name: k.name, platform: k.platform, Vm: k.vmPub, Km: k.kmPub }))));
      this.sas = deriveSas(hs.handshakeHash);
      // pairId는 PC가 pair.ok에서 정한다. 채널은 첫 유효 봉투의 pairId로 고정된다.
      const channel = new Channel(link, new Transport(hs.split()), { me: 'mobile', now: this.#now });
      this.#set('show_sas');
      return await this.#awaitPairOk(link, channel, q.relayHost);
    } catch {
      link.close();
      return this.#fail('handshake') || null;
    }
  }

  async #awaitPairOk(link: Link, channel: Channel, relayHost: string): Promise<MobilePairResult | null> {
    const env = await channel.recv(this.#o.pairOkTimeoutMs ?? 180_000);
    if (!env) {
      link.close();
      return this.#fail('timeout') || null;
    }
    if (env.type !== 'pair.ok') {
      link.close();
      return this.#fail('pair_ok_invalid') || null;
    }
    const b = env.body as PairOkBody;
    const r = this.#checkPairOk(b);
    if (r !== true) {
      link.close();
      return this.#fail(r) || null;
    }
    this.#set('paired');
    const aikPub = fromB64Strict(b.aikPub);
    const cert = verifyCert(b.cert, aikPub, this.#now())!;
    return {
      pairId: env.pairId, cert: decodeCertField(b.cert)!, aikPub, desktopStatic: this.#qr!.desktopStatic, desktopVd: this.#desktop!.Vd,
      desktopDeviceId: this.#desktop!.deviceId, kvPub: fromB64Strict(b.kvPub), deviceList: b.deviceList, mbxId: b.mbxId, tokRead: b.tokRead,
      tokWrite: b.tokWrite, mbxEpoch: b.mbxEpoch, relayHost, certNotAfter: cert.not_after, identity: { account: this.#account!, desktopName: readDesktopName(b.desktopName) }, channel,
    };
  }

  #checkPairOk(b: PairOkBody): true | MobilePairFailure {
    const k = this.#o.keys;
    let aik: Uint8Array;
    try {
      aik = fromB64Strict(b.aikPub);
    } catch {
      return 'pair_ok_invalid';
    }
    if (aik.length !== 32) return 'pair_ok_invalid';
    // 다시 연결이면 앞서 고정한 AIK_pub와 같을 때만 진행(C-01). 처음 페어링은 QR·SAS로 고른 이 PC의 AIK를 믿는다(TOFU, §1 E-12).
    if (this.#o.knownAikPub && !equal(aik, this.#o.knownAikPub)) return 'aik_mismatch';
    // 계정 서비스 서명 주장: 고정 키로 서명, exp 미경과, aik_pub == PAIR_OK.aikPub. 하나라도 어긋나면 저장하지 않는다(설계 #120).
    const ac = verifyAcctClaim(b.acctClaim, { accountKeys: this.#o.accountKeys, aikPub: aik, now: this.#now() });
    if (!ac.ok) return 'acct_claim_invalid';
    this.#account = ac.claim;
    const cert = verifyCert(b.cert, aik, this.#now());
    if (!cert || cert.device_id !== k.deviceId || cert.role !== 'mobile' || !equal(cert.Sx, k.noise.publicKey) || !equal(cert.Vx, k.vmPub) || !cert.Kx || !equal(cert.Kx, k.kmPub) || cert.Px) return 'pair_ok_invalid';
    // 3단계 검사를 여기서: 목록의 모든 항목이 AIK 서명, 이미 본 listVersion 이상, QR의 Sd가 role=desktop 항목에 있음.
    const chk = verifyDeviceList(b.deviceList, aik, this.#o.seenListVersion ?? 0);
    if (!chk.ok) return 'devlist_invalid';
    const me = chk.devices.find((d) => d.deviceId === k.deviceId);
    if (!me || me.role !== 'mobile' || !equal(me.noisePub, k.noise.publicKey) || !equal(me.signPub, k.vmPub)) return 'pair_ok_invalid';
    const desk = chk.devices.find((d) => d.role === 'desktop' && equal(d.noisePub, this.#qr!.desktopStatic));
    if (!desk) return 'desktop_unknown';
    if (!verifyKv(desk.signPub, fromB64Strict(b.kvPub), b.kvSig)) return 'pair_ok_invalid';
    this.#desktop = { deviceId: desk.deviceId, Vd: desk.signPub };
    this.newDesktopWarning = this.#now() - desk.registeredAt < NEW_DESKTOP_WARN_MS;
    return true;
  }
}

const fromB64Strict = (s: string) => fromB64(s);
