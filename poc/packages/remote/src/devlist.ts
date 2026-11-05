// D08 §4.1·§9.2: AIK 서명 기기 목록, 기기 인증서 Cert_X, 폐기 레코드, Kv 배포 서명.
//
// 해석(PR에 명시, 팀장 확인 요청): 목록이 바뀔 때마다 PC는 남은 모든 항목을 새 list_version으로 다시 서명한다.
// 그래서 검증기는 "모든 항목의 list_version == listVersion"을 요구한다. 서버가 옛 목록의 항목과 새 목록의 항목을
// 섞어 폐기를 숨기는 것을 막는다. 옛 목록 통째 재생은 "이미 본 listVersion보다 낮으면 거부"로 막는다.

// 서명 입력: utf8(ctx) ‖ utf8(JCS(객체)) — 클라우드 services/shared/CONTRACT.md §1(팀장 결정 2026-11-05). 서버가 같은 바이트로 검증한다.

import { b64, fromB64 } from './bytes.ts';
import { CTX } from './contexts.ts';
import { ed25519Verify } from './crypto.ts';
import type { DeviceListEntryJson, DeviceListJson, RevokedJson, Role } from './envelope.ts';
import { jcsBytes, parseJcs } from './jcs.ts';
import type { AikSigner, VdSigner } from './keys.ts';

export const MAX_DEVICES = 5;
export const MAX_REVOKED = 64;
export const CERT_DAYS = 90;
/** 계정 서비스가 받는 인증서 수명 상한(services/account API.md: 91일 초과 거부). */
export const CERT_MAX_DAYS = 91;
const DAY = 86_400_000;

const entryInput = (e: DeviceListEntryJson['entry']) =>
  jcsBytes({ device_id: e.device_id, role: e.role, Sx: e.Sx, Vx: e.Vx, registered_at: e.registered_at, list_version: e.list_version });
const revokeInput = (r: Omit<RevokedJson, 'aikSig'>) => jcsBytes({ device_id: r.device_id, revoked_at: r.revoked_at });

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
  // 서버가 준 신뢰할 수 없는 입력이다. 어떤 모양이 와도 던지지 않고 shape로 끝낸다.
  try {
    return checkDeviceList(list, aikPub, minVersion);
  } catch {
    return { ok: false, reason: 'shape' };
  }
}

const isEntry = (e: unknown): e is DeviceListEntryJson['entry'] => {
  const o = e as Record<string, unknown> | null;
  return !!o && typeof o === 'object' && typeof o.device_id === 'string' && (o.role === 'desktop' || o.role === 'mobile') && typeof o.Sx === 'string' &&
    typeof o.Vx === 'string' && Number.isSafeInteger(o.registered_at) && Number.isSafeInteger(o.list_version);
};
const canonicalKey = (s: string): Uint8Array | null => {
  const k = fromB64(s);
  return k.length === 32 && b64(k) === s ? k : null;
};

function checkDeviceList(list: DeviceListJson, aikPub: Uint8Array, minVersion: number): ListCheck {
  if (!list || !Number.isSafeInteger(list.listVersion) || !Array.isArray(list.entries) || !Array.isArray(list.revoked)) return { ok: false, reason: 'shape' };
  if (list.entries.length > MAX_DEVICES || list.revoked.length > MAX_REVOKED) return { ok: false, reason: 'shape' };
  if (list.listVersion < minVersion) return { ok: false, reason: 'rollback' };
  const ids = new Set<string>();
  const devices: DeviceInfo[] = [];
  for (const it of list.entries) {
    if (!it || typeof it !== 'object' || !isEntry(it.entry) || typeof it.aikSig !== 'string') return { ok: false, reason: 'shape' };
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
    const noisePub = canonicalKey(it.entry.Sx), signPub = canonicalKey(it.entry.Vx);
    if (!noisePub || !signPub) return { ok: false, reason: 'shape' };
    devices.push({ deviceId: it.entry.device_id, role: it.entry.role, noisePub, signPub, registeredAt: it.entry.registered_at });
  }
  const revokedIds = new Set<string>();
  for (const r of list.revoked) {
    if (!r || typeof r !== 'object' || typeof r.device_id !== 'string' || !Number.isSafeInteger(r.revoked_at) || typeof r.aikSig !== 'string') {
      return { ok: false, reason: 'shape' };
    }
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

/**
 * [PC] 페어링 7단계용 추가. 같은 기기 ID가 같은 역할·키로 이미 있으면(앞 시도가 목록을 올린 뒤 실패해 다시 페어링) 그 항목을
 * 처음 등록 시각 그대로 새 list_version으로 다시 서명한다. ID가 같은데 키가 다르거나 폐기된 ID면 거부한다.
 */
export async function upsertDevice(aik: AikSigner, prev: DeviceListJson, d: DeviceInfo): Promise<DeviceListJson> {
  if (prev.revoked.some((r) => r.device_id === d.deviceId)) throw new Error('devlist: device id revoked');
  const cur = prev.entries.find((x) => x.entry.device_id === d.deviceId);
  if (!cur) return addDevice(aik, prev, d);
  const e = cur.entry;
  if (e.role !== d.role || e.Sx !== b64(d.noisePub) || e.Vx !== b64(d.signPub)) throw new Error('devlist: device id already used');
  const v = prev.listVersion + 1;
  return { listVersion: v, entries: await signEntries(aik, prev.entries.map((x) => x.entry), v), revoked: prev.revoked };
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

// ---- 기기 인증서 Cert_X (§4.2 7단계) ----
// 형식은 계정 서비스 POST /v1/device-tokens의 `cert`와 같다: {cert:{device_id, role, Sx, Vx, Kx?, Px?, not_after}, aikSig}.
// pair.ok의 `cert` 필드에는 b64(JCS(SignedCert))를 싣는다(스키마 v1.4 $comment).

/** 서명되는 인증서 객체(공개키는 표준 base64). */
export interface CertJson {
  device_id: string;
  role: Role;
  Sx: string;
  Vx: string;
  /** 금고 비밀 봉인 수신 키(폰 Km). */
  Kx?: string;
  /** 하드웨어 승인 키(M7-7, 제안). Phase 1은 넣지 않는다. */
  Px?: string;
  not_after: number;
}

export interface SignedCert {
  cert: CertJson;
  aikSig: string;
}

/** 검증한 인증서(키는 바이트). */
export interface CertBody {
  device_id: string;
  role: Role;
  Sx: Uint8Array;
  Vx: Uint8Array;
  Kx?: Uint8Array;
  Px?: Uint8Array;
  not_after: number;
}

const CERT_KEYS = new Set(['device_id', 'role', 'Sx', 'Vx', 'Kx', 'Px', 'not_after']);
const UUID4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function certJson(c: CertBody): CertJson {
  const j: CertJson = { device_id: c.device_id, role: c.role, Sx: b64(c.Sx), Vx: b64(c.Vx), not_after: c.not_after };
  if (c.Kx) j.Kx = b64(c.Kx);
  if (c.Px) j.Px = b64(c.Px);
  return j;
}

export async function issueCert(aik: AikSigner, c: CertBody): Promise<SignedCert> {
  const cert = certJson(c);
  return { cert, aikSig: b64(await aik.sign(CTX.cert, jcsBytes(cert))) };
}

/** pair.ok 운반 형식. */
export const encodeCertField = (sc: SignedCert): string => b64(jcsBytes(sc));

/** pair.ok의 `cert` 필드를 읽는다(JCS 정규형만). 서명은 보지 않는다 — verifyCert를 쓴다. */
export function decodeCertField(field: string): SignedCert | null {
  try {
    const v = parseJcs(fromB64(field), 1024) as SignedCert | null;
    if (!v || typeof v !== 'object' || Object.keys(v).sort().join(',') !== 'aikSig,cert') return null;
    if (typeof v.aikSig !== 'string' || !v.cert || typeof v.cert !== 'object') return null;
    return v;
  } catch {
    return null;
  }
}

export function certNotAfter(now = Date.now()): number {
  return now + CERT_DAYS * DAY;
}

const key32 = (s: unknown): Uint8Array | null => {
  if (typeof s !== 'string') return null;
  try {
    const k = fromB64(s);
    return k.length === 32 && b64(k) === s ? k : null;
  } catch {
    return null;
  }
};

/** 인증서 검증: AIK 서명·만료·수명 상한·필드 형태. 입력은 SignedCert 또는 pair.ok `cert` 필드. */
export function verifyCert(input: SignedCert | string, aikPub: Uint8Array, now = Date.now()): CertBody | null {
  const sc = typeof input === 'string' ? decodeCertField(input) : input;
  if (!sc) return null;
  try {
    const c = sc.cert;
    if (Object.keys(c).some((k) => !CERT_KEYS.has(k))) return null;
    if (typeof c.device_id !== 'string' || !UUID4.test(c.device_id) || (c.role !== 'desktop' && c.role !== 'mobile')) return null;
    if (!Number.isSafeInteger(c.not_after) || c.not_after <= now || c.not_after > now + CERT_MAX_DAYS * DAY) return null;
    const Sx = key32(c.Sx), Vx = key32(c.Vx);
    const Kx = c.Kx === undefined ? undefined : key32(c.Kx);
    const Px = c.Px === undefined ? undefined : key32(c.Px);
    if (!Sx || !Vx || Kx === null || Px === null) return null;
    if (!ed25519Verify(aikPub, CTX.cert, jcsBytes(c), fromB64(sc.aikSig))) return null;
    const out: CertBody = { device_id: c.device_id, role: c.role, Sx, Vx, not_after: c.not_after };
    if (Kx) out.Kx = Kx;
    if (Px) out.Px = Px;
    return out;
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
