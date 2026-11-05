// 패스키(WebAuthn Level 2) 검증. 등록은 attestation "none"만 받는다(기기 증명이 아니라 로그인 수단이므로).
// 서명 알고리즘: ES256(-7), EdDSA(-8). 사용자 확인(UV)을 요구한다. 서버는 공개키·서명 카운터만 저장한다.
import { createPublicKey, verify as cryptoVerify, type KeyObject } from 'node:crypto';
import { fromB64u, safeEqual, sha256 } from '@sax/svc-shared';
import { decodeCbor } from './cbor.ts';

export interface RpConfig {
  rpId: string;
  /** 허용 origin(정확히 일치). 예: https://account.example */
  origins: readonly string[];
}

export class WebAuthnError extends Error {}

const bad = (m: string): never => {
  throw new WebAuthnError(m);
};

interface ClientData {
  type: string;
  challenge: string;
  origin: string;
  crossOrigin?: boolean;
}

function parseClientData(b64: string, type: string, challenge: string, rp: RpConfig): Buffer {
  const raw = fromB64u(b64);
  if (raw.length > 4096) bad('client_data_size');
  let cd: ClientData;
  try {
    cd = JSON.parse(raw.toString('utf8')) as ClientData;
  } catch {
    return bad('client_data_json');
  }
  if (cd.type !== type) bad('type');
  if (typeof cd.challenge !== 'string' || !safeEqual(cd.challenge, challenge)) bad('challenge');
  if (!rp.origins.includes(cd.origin)) bad('origin');
  if (cd.crossOrigin === true) bad('cross_origin');
  return raw;
}

interface AuthData {
  rpIdHash: Buffer;
  flags: number;
  signCount: number;
  credentialId?: Buffer;
  coseKey?: Map<unknown, unknown>;
}

const FLAG_UP = 0x01;
const FLAG_UV = 0x04;
const FLAG_AT = 0x40;
const FLAG_ED = 0x80;

function parseAuthData(a: Buffer, rp: RpConfig): AuthData {
  if (a.length < 37) bad('auth_data_len');
  const rpIdHash = a.subarray(0, 32);
  if (!safeEqual(rpIdHash, sha256(rp.rpId))) bad('rp_id');
  const flags = a.readUInt8(32);
  if (!(flags & FLAG_UP)) bad('user_presence');
  if (!(flags & FLAG_UV)) bad('user_verification');
  if (flags & FLAG_ED) bad('extensions');
  const signCount = a.readUInt32BE(33);
  const out: AuthData = { rpIdHash, flags, signCount };
  if (flags & FLAG_AT) {
    if (a.length < 55) bad('attested_len');
    const idLen = a.readUInt16BE(53);
    if (idLen < 16 || idLen > 1023 || a.length < 55 + idLen) bad('cred_id_len');
    out.credentialId = Buffer.from(a.subarray(55, 55 + idLen));
    const { value, rest } = decodeCbor(a.subarray(55 + idLen));
    if (rest.length) bad('trailing');
    if (!(value instanceof Map)) bad('cose');
    out.coseKey = value as Map<unknown, unknown>;
  }
  return out;
}

/** COSE 키 → SPKI DER(base64). EC2/P-256/ES256 또는 OKP/Ed25519/EdDSA만. */
function coseToKey(m: Map<unknown, unknown>): { key: KeyObject; alg: number } {
  const kty = m.get(1);
  const alg = m.get(3);
  if (kty === 2 && alg === -7 && m.get(-1) === 1) {
    const x = m.get(-2);
    const y = m.get(-3);
    if (!Buffer.isBuffer(x) || !Buffer.isBuffer(y) || x.length !== 32 || y.length !== 32) bad('ec2_coords');
    return { key: createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: (x as Buffer).toString('base64url'), y: (y as Buffer).toString('base64url') }, format: 'jwk' }), alg: -7 };
  }
  if (kty === 1 && alg === -8 && m.get(-1) === 6) {
    const x = m.get(-2);
    if (!Buffer.isBuffer(x) || x.length !== 32) bad('okp_x');
    return { key: createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: (x as Buffer).toString('base64url') }, format: 'jwk' }), alg: -8 };
  }
  return bad('cose_alg');
}

export interface RegistrationInput {
  clientDataJSON: string;
  attestationObject: string;
}

export interface VerifiedCredential {
  credentialId: string;
  publicKeySpki: string;
  alg: number;
  signCount: number;
}

export function verifyRegistration(inp: RegistrationInput, challenge: string, rp: RpConfig): VerifiedCredential {
  parseClientData(inp.clientDataJSON, 'webauthn.create', challenge, rp);
  const att = fromB64u(inp.attestationObject);
  if (att.length > 8192) bad('attestation_size');
  const { value, rest } = decodeCbor(att);
  if (rest.length || !(value instanceof Map)) bad('attestation_cbor');
  const m = value as Map<unknown, unknown>;
  if (m.get('fmt') !== 'none') bad('fmt');
  const stmt = m.get('attStmt');
  if (!(stmt instanceof Map) || stmt.size !== 0) bad('att_stmt');
  const authData = m.get('authData');
  if (!Buffer.isBuffer(authData)) bad('auth_data');
  const ad = parseAuthData(authData as Buffer, rp);
  if (!ad.credentialId || !ad.coseKey) bad('no_credential');
  const { key, alg } = coseToKey(ad.coseKey!);
  return { credentialId: ad.credentialId!.toString('base64url'), publicKeySpki: key.export({ format: 'der', type: 'spki' }).toString('base64'), alg, signCount: ad.signCount };
}

export interface AssertionInput {
  credentialId: string;
  clientDataJSON: string;
  authenticatorData: string;
  signature: string;
}

/** 검증 통과 시 새 서명 카운터. 카운터가 줄거나 같으면(둘 다 0인 경우 제외) 복제 의심으로 거부. */
export function verifyAssertion(inp: AssertionInput, challenge: string, rp: RpConfig, stored: { publicKeySpki: string; alg: number; signCount: number }): number {
  const cd = parseClientData(inp.clientDataJSON, 'webauthn.get', challenge, rp);
  const authData = fromB64u(inp.authenticatorData);
  if (authData.length > 1024) bad('auth_data_size');
  const ad = parseAuthData(authData, rp);
  if (ad.flags & FLAG_AT) bad('unexpected_attested');
  const key = createPublicKey({ key: Buffer.from(stored.publicKeySpki, 'base64'), format: 'der', type: 'spki' });
  const msg = Buffer.concat([authData, sha256(cd)]);
  const sig = fromB64u(inp.signature);
  let ok: boolean;
  try {
    ok = stored.alg === -8 ? cryptoVerify(null, msg, key, sig) : cryptoVerify('sha256', msg, key, sig);
  } catch {
    ok = false;
  }
  if (!ok) bad('signature');
  if ((ad.signCount !== 0 || stored.signCount !== 0) && ad.signCount <= stored.signCount) bad('sign_count');
  return ad.signCount;
}
