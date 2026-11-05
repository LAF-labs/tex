// D08 §4.1·§9.2: AIK 서명 기기 목록, 기기 인증서 Cert_X, 폐기 레코드, Kv 배포 서명.
//
// 해석(PR에 명시, 팀장 확인 요청): 목록이 바뀔 때마다 PC는 남은 모든 항목을 새 list_version으로 다시 서명한다.
// 그래서 검증기는 "모든 항목의 list_version == listVersion"을 요구한다. 서버가 옛 목록의 항목과 새 목록의 항목을
// 섞어 폐기를 숨기는 것을 막는다. 옛 목록 통째 재생은 "이미 본 listVersion보다 낮으면 거부"로 막는다.

import { b64, fromB64 } from './bytes.ts';
import { decodeCbor, encodeCbor } from './cbor.ts';
import { CTX } from './contexts.ts';
import { ed25519Verify } from './crypto.ts';
import type { DeviceListEntryJson, DeviceListJson, RevokedJson, Role } from './envelope.ts';
import { toCborModel } from './envelope.ts';
import type { AikSigner, VdSigner } from './keys.ts';

export const MAX_DEVICES = 5;
export const MAX_REVOKED = 64;
export const CERT_DAYS = 90;
const DAY = 86_400_000;

const entryInput = (e: DeviceListEntryJson['entry']) => encodeCbor(toCborModel(e));
const revokeInput = (r: Omit<RevokedJson, 'aikSig'>) => encodeCbor({ device_id: r.device_id, revoked_at: r.revoked_at });

export interface DeviceInfo {
  deviceId: string;
  role: Role;
  /** Noise 정적 공개키 Sx */
  noisePub: Uint8Array;
  /** Ed25519 서명 공개키 Vx */
  signPub: Uint8Array;
  registeredAt: number;
}

export type ListCheck =
  | { ok: true; list: DeviceListJson; devices: DeviceInfo[]; revokedIds: Set<string> }
  | { ok: false; reason: 'signature' | 'version_mix' | 'rollback' | 'duplicate' | 'revoked_listed' | 'shape' };

/** 받은 기기 목록을 계정 AIK_pub로 검증한다. reason은 로컬 UI 전용(C/X-12). */
export function verifyDeviceList(list: DeviceListJson, aikPub: Uint8Array, minVersion = 0): ListCheck {
  if (!list || !Array.isArray(list.entries) || !Array.isArray(list.revoked)) return { ok: false, reason: 'shape' };
  if (list.entries.length > MAX_DEVICES || list.revoked.length > MAX_REVOKED) return { ok: false, reason: 'shape' };
  if (list.listVersion < minVersion) return { ok: false, reason: 'rollback' };
  const ids = new Set<string>();
  const devices: DeviceInfo[] = [];
  for (const it of list.entries) {
    let sig: Uint8Array;
    try {
      sig = fromB64(it.aikSig);
    } catch {
      return { ok: false, reason: 'signature' };
    }
    if (!ed25519Verify(aikPub, CTX.devlist, entryInput(it.entry), sig)) return { ok: false, reason: 'signature' };
    if (it.entry.list_version !== list.listVersion) return { ok: false, reason: 'version_mix' };
    if (ids.has(it.entry.device_id)) return { ok: false, reason: 'duplicate' };
    ids.add(it.entry.device_id);
    devices.push({
      deviceId: it.entry.device_id,
      role: it.entry.role,
      noisePub: fromB64(it.entry.Sx),
      signPub: fromB64(it.entry.Vx),
      registeredAt: it.entry.registered_at,
    });
  }
  const revokedIds = new Set<string>();
  for (const r of list.revoked) {
    let sig: Uint8Array;
    try {
      sig = fromB64(r.aikSig);
    } catch {
      return { ok: false, reason: 'signature' };
    }
    if (!ed25519Verify(aikPub, CTX.revoke, revokeInput(r), sig)) return { ok: false, reason: 'signature' };
    revokedIds.add(r.device_id);
  }
  for (const id of ids) if (revokedIds.has(id)) return { ok: false, reason: 'revoked_listed' };
  return { ok: true, list, devices, revokedIds };
}

async function signEntries(aik: AikSigner, entries: DeviceListEntryJson['entry'][], version: number): Promise<DeviceListEntryJson[]> {
  const out: DeviceListEntryJson[] = [];
  for (const e of entries) {
    const entry = { ...e, list_version: version };
    out.push({ entry, aikSig: b64(await aik.sign(CTX.devlist, entryInput(entry))) });
  }
  return out;
}

/** [PC] 첫 목록(데스크톱 자기 자신). */
export async function initialDeviceList(aik: AikSigner, self: DeviceInfo): Promise<DeviceListJson> {
  return {
    listVersion: 1,
    entries: await signEntries(aik, [toEntry(self, 1)], 1),
    revoked: [],
  };
}

function toEntry(d: DeviceInfo, v: number): DeviceListEntryJson['entry'] {
  return { device_id: d.deviceId, role: d.role, Sx: b64(d.noisePub), Vx: b64(d.signPub), registered_at: d.registeredAt, list_version: v };
}

/** [PC] 기기 추가(페어링 7단계). list_version + 1, 모든 항목 재서명. */
export async function addDevice(aik: AikSigner, prev: DeviceListJson, d: DeviceInfo): Promise<DeviceListJson> {
  if (prev.entries.length >= MAX_DEVICES) throw new Error('devlist: too many devices');
  if (prev.entries.some((x) => x.entry.device_id === d.deviceId) || prev.revoked.some((r) => r.device_id === d.deviceId)) {
    throw new Error('devlist: device id already used');
  }
  const v = prev.listVersion + 1;
  return { listVersion: v, entries: await signEntries(aik, [...prev.entries.map((x) => x.entry), toEntry(d, v)], v), revoked: prev.revoked };
}

/** [PC] 기기 해제(§9.2): AIK 서명 폐기 레코드 + list_version + 1. */
export async function revokeDevice(aik: AikSigner, prev: DeviceListJson, deviceId: string, now = Date.now()): Promise<DeviceListJson> {
  if (!prev.entries.some((x) => x.entry.device_id === deviceId)) throw new Error('devlist: unknown device');
  if (prev.revoked.length >= MAX_REVOKED) throw new Error('devlist: revoked list full');
  const v = prev.listVersion + 1;
  const rec = { device_id: deviceId, revoked_at: now };
  const revoked = [...prev.revoked, { ...rec, aikSig: b64(await aik.sign(CTX.revoke, revokeInput(rec))) }];
  const rest = prev.entries.filter((x) => x.entry.device_id !== deviceId).map((x) => x.entry);
  return { listVersion: v, entries: await signEntries(aik, rest, v), revoked };
}

// ---- 기기 인증서 Cert_M (§4.2 7단계) ----

export interface CertBody {
  device_id: string;
  role: Role;
  Sm: Uint8Array;
  Vm: Uint8Array;
  Km: Uint8Array;
  /** Px_pub(M7-7, 제안). Phase 1은 넣지 않는다. */
  Px?: Uint8Array;
  not_after: number;
}

function certBodyCbor(c: CertBody): Uint8Array {
  const m: Record<string, Uint8Array | string | number> = { device_id: c.device_id, role: c.role, Sm: c.Sm, Vm: c.Vm, Km: c.Km, not_after: c.not_after };
  if (c.Px) m.Px = c.Px;
  return encodeCbor(m);
}

export async function issueCert(aik: AikSigner, c: CertBody): Promise<string> {
  const body = certBodyCbor(c);
  const sig = await aik.sign(CTX.cert, body);
  return b64(encodeCbor([body, sig]));
}

export function certNotAfter(now = Date.now()): number {
  return now + CERT_DAYS * DAY;
}

/** 인증서 검증. 서명·만료·필드 형태를 본다. */
export function verifyCert(certB64: string, aikPub: Uint8Array, now = Date.now()): CertBody | null {
  try {
    const outer = decodeCbor(fromB64(certB64), { maxBytes: 512 });
    if (!Array.isArray(outer) || outer.length !== 2) return null;
    const [body, sig] = outer;
    if (!(body instanceof Uint8Array) || !(sig instanceof Uint8Array)) return null;
    if (!ed25519Verify(aikPub, CTX.cert, body, sig)) return null;
    const m = decodeCbor(body) as Record<string, unknown>;
    const k32 = (x: unknown) => x instanceof Uint8Array && x.length === 32;
    if (typeof m.device_id !== 'string' || (m.role !== 'desktop' && m.role !== 'mobile')) return null;
    if (!k32(m.Sm) || !k32(m.Vm) || !k32(m.Km) || typeof m.not_after !== 'number') return null;
    if (m.not_after <= now) return null;
    return m as unknown as CertBody;
  } catch {
    return null;
  }
}

// ---- Kv 배포(D05 §5, SAX-kv-v1) ----

export async function signKv(vd: VdSigner, kvPub: Uint8Array): Promise<string> {
  return b64(await vd.sign(CTX.kv, kvPub));
}
export function verifyKv(vdPub: Uint8Array, kvPub: Uint8Array, sigB64: string): boolean {
  try {
    return ed25519Verify(vdPub, CTX.kv, kvPub, fromB64(sigB64));
  } catch {
    return false;
  }
}
