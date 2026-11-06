// remote-*.test.ts 공용: 모의 키(금고 역할은 소프트 키로 흉내), 기기, 메모리 릴레이 위 페어링.
import {
  AIK_PURPOSES, DesktopPairing, signAcctClaim, MemoryRelay, MobilePairing, VD_PURPOSES, VM_PURPOSES, b64, ed25519Keygen, initialDeviceList, sha256Hash, softNoiseStatic,
  softSigner, toHex, uuid4, x25519Keygen, type DesktopKeys, type DeviceListJson, type PhoneKeys,
} from '@sax/remote';

export const RELAY = 'relay.sax.test';
/** 시험용 계정 서비스 키(acct_claim 서명). 실제 키는 클라우드 세션이 만든다. */
export const ACCOUNT_KEY = ed25519Keygen();
export const TEST_EMAIL = 'owner@example.test';

/** 계정 서비스가 이 PC의 AIK로 서명해 주는 계정 확인 주장(시험 대역). */
export function testAcctClaim(aikPub: Uint8Array, o: { sk?: Uint8Array; email?: string; iat?: number; exp?: number } = {}): string {
  const now = Math.floor(Date.now() / 1000);
  return signAcctClaim(o.sk ?? ACCOUNT_KEY.secretKey, { account_id: 'acc_test', email: o.email ?? TEST_EMAIL, aik_pub: b64(aikPub), iat: o.iat ?? now, exp: o.exp ?? now + 600 });
}
export const DAY = 86_400_000;

export interface MockDesktop {
  keys: DesktopKeys;
  deviceId: string;
  deviceList: DeviceListJson;
}

/** 금고 VaultCrypto 대역(모의 키). 실제 PC는 금고 트랙이 구현한다. */
export async function mockDesktop(registeredAt = Date.now() - 30 * DAY, aikSecret?: Uint8Array): Promise<MockDesktop> {
  const s = x25519Keygen();
  const vd = ed25519Keygen();
  const aik = aikSecret ?? ed25519Keygen().secretKey;
  const kv = x25519Keygen();
  const keys: DesktopKeys = {
    noise: softNoiseStatic(s.secretKey),
    vd: softSigner(vd.secretKey, VD_PURPOSES),
    aik: softSigner(aik, AIK_PURPOSES),
    kvPublic: () => kv.publicKey,
  };
  const deviceId = uuid4();
  const deviceList = await initialDeviceList(keys.aik, { deviceId, role: 'desktop', noisePub: keys.noise.publicKey, signPub: keys.vd.publicKey, registeredAt });
  return { keys, deviceId, deviceList };
}

export interface MockPhone {
  keys: PhoneKeys;
  vm: ReturnType<typeof softSigner>;
}

export function mockPhone(name = '사장님 폰'): MockPhone {
  const s = x25519Keygen();
  const vm = ed25519Keygen();
  const km = x25519Keygen();
  return {
    keys: { noise: softNoiseStatic(s.secretKey), vmPub: vm.publicKey, kmPub: km.publicKey, deviceId: uuid4(), name, platform: 'ios' },
    vm: softSigner(vm.secretKey, VM_PURPOSES),
  };
}

export interface PairWorld {
  relay: MemoryRelay;
  desk: MockDesktop;
  phone: MockPhone;
  pc: DesktopPairing;
  mob: MobilePairing;
  published: DeviceListJson[];
  enrolled: Enrolled[];
}

export interface Enrolled {
  deviceId: string;
  roomId: Uint8Array;
  /** 등록을 부른 때 폰 상태(pair.ok 전이어야 한다). */
  phoneState: string;
}

export async function pairWorld(o: {
  relay?: MemoryRelay; desk?: MockDesktop; phone?: MockPhone; enrollFails?: boolean; knownAik?: Uint8Array; seenListVersion?: number; now?: () => number;
  accountClaim?: (aikPub: Uint8Array) => string; accountKeys?: Uint8Array[]; desktopName?: string;
} = {}): Promise<PairWorld> {
  const relay = o.relay ?? new MemoryRelay();
  relay.tokenHash = (t) => toHex(sha256Hash(t));
  const desk = o.desk ?? (await mockDesktop());
  const phone = o.phone ?? mockPhone();
  const published: DeviceListJson[] = [];
  const enrolled: Enrolled[] = [];
  let mob: MobilePairing | null = null;
  const pc = new DesktopPairing({
    keys: desk.keys, deviceList: desk.deviceList, relayHost: RELAY, now: o.now,
    enrollPhone: async (p) => {
      if (o.enrollFails) throw new Error('relay.room_unavailable');
      enrolled.push({ deviceId: p.deviceId, roomId: p.roomId, phoneState: mob?.state ?? 'none' });
    },
    publishDeviceList: async (l) => {
      published.push(l);
    },
    registerMailbox: async (id, r, w) => relay.registerMailbox(id, toHex(sha256Hash(r)), toHex(sha256Hash(w))),
    accountClaim: async () => (o.accountClaim ?? testAcctClaim)(desk.keys.aik.publicKey),
    desktopName: o.desktopName,
  });
  mob = new MobilePairing({
    keys: phone.keys, knownAikPub: o.knownAik, seenListVersion: o.seenListVersion, relayAllowlist: [RELAY], now: o.now,
    accountKeys: o.accountKeys ?? [ACCOUNT_KEY.publicKey],
    pairOkTimeoutMs: 5000,
  });
  return { relay, desk, phone, pc, mob, published, enrolled };
}

/** 정상 페어링 한 번(사용자가 폰의 SAS를 PC에 입력). */
export async function pairOnce(w: PairWorld) {
  const { qr } = w.pc.offer();
  const pcLink = await w.relay.joinRoom(w.pc.roomId, 'desktop');
  const pcRun = w.pc.run(pcLink);
  if (!w.mob.scan(qr)) throw new Error(`scan failed: ${w.mob.failure}`);
  const phLink = await w.relay.joinRoom(w.mob.roomId, 'mobile');
  const phRun = w.mob.run(phLink);
  await pcRun;
  await until(() => w.mob.state === 'show_sas' || w.mob.state === 'failed');
  if (w.pc.state !== 'awaiting_sas') throw new Error(`pc state ${w.pc.state}`);
  const r = await w.pc.submitSas(w.mob.sas!);
  if (!r.ok) throw new Error('sas rejected');
  const m = await phRun;
  if (!m) throw new Error(`phone failed: ${w.mob.failure}`);
  return { pc: r.result, phone: m };
}

export async function until(f: () => boolean, ms = 3000): Promise<void> {
  const t0 = Date.now();
  while (!f()) {
    if (Date.now() - t0 > ms) throw new Error('until: timeout');
    await new Promise((r) => setTimeout(r, 2));
  }
}

export const fakeJpeg = (n: number, seed = 7): Uint8Array => {
  const b = new Uint8Array(n);
  let x = seed;
  for (let i = 0; i < n; i++) {
    x = (x * 1103515245 + 12345) >>> 0;
    b[i] = x >>> 24;
  }
  b[0] = 0xff;
  b[1] = 0xd8;
  return b;
};

export const k32 = () => b64(new Uint8Array(32).map((_, i) => i + 1));
