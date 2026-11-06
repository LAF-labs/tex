// YubiKey PIV 증명(attestation) 검사: 키가 장치 안에서 만들어졌고(가져온 키가 아님), PIN·터치 정책이 ALWAYS인지 본다.
// 사슬: 슬롯 증명서 ← 장치 f9 중간 인증서 ← (Yubico 중간 인증서들) ← Yubico 루트. 루트·중간 PEM은 진행자가 Yubico 공식 사이트에서 받아 지문을 대조한다.
// Yubico 확장(OID 1.3.6.1.4.1.41482.3.x): .3.3 펌웨어(3바이트), .3.7 일련번호(DER INTEGER), .3.8 정책(PIN 1바이트, 터치 1바이트).
import { X509Certificate } from 'node:crypto';
import { CeremonyError } from './content.ts';
import { rawEd25519FromSpki } from './device.ts';

export const YUBICO_OID = { firmware: '1.3.6.1.4.1.41482.3.3', serial: '1.3.6.1.4.1.41482.3.7', policy: '1.3.6.1.4.1.41482.3.8' } as const;
export const PIN_POLICY = { 1: 'never', 2: 'once', 3: 'always', 4: 'match_once', 5: 'match_always' } as const;
export const TOUCH_POLICY = { 1: 'never', 2: 'always', 3: 'cached' } as const;

export interface AttestationResult {
  publicKey: Buffer;
  serial: number | null;
  firmware: string | null;
  pinPolicy: string;
  touchPolicy: string;
}

// ---- 최소 DER(증명서 확장만 읽는다) ----
interface Tlv {
  tag: number;
  start: number;
  end: number;
}
function tlv(b: Buffer, at: number, limit: number): Tlv {
  if (at + 2 > limit) throw new CeremonyError('ceremony.attestation_invalid', 'der');
  const tag = b[at]!;
  let len = b[at + 1]!;
  let p = at + 2;
  if (len & 0x80) {
    const n = len & 0x7f;
    if (n < 1 || n > 3 || p + n > limit) throw new CeremonyError('ceremony.attestation_invalid', 'der');
    len = 0;
    for (let i = 0; i < n; i++) len = len * 256 + b[p + i]!;
    p += n;
  }
  if (p + len > limit) throw new CeremonyError('ceremony.attestation_invalid', 'der');
  return { tag, start: p, end: p + len };
}
function kids(b: Buffer, t: Tlv): Tlv[] {
  const out: Tlv[] = [];
  for (let p = t.start; p < t.end; ) {
    const c = tlv(b, p, t.end);
    out.push(c);
    p = c.end;
  }
  return out;
}
function oid(b: Buffer, t: Tlv): string {
  const arcs: number[] = [];
  let v = 0;
  for (let p = t.start; p < t.end; p++) {
    v = v * 128 + (b[p]! & 0x7f);
    if (b[p]! & 0x80) continue;
    if (!arcs.length) arcs.push(v < 80 ? Math.floor(v / 40) : 2, v < 80 ? v % 40 : v - 80);
    else arcs.push(v);
    v = 0;
  }
  return arcs.join('.');
}

/** 증명서 DER → 확장 OID → extnValue(OCTET STRING 안의 바이트). */
export function certExtensions(der: Buffer): Map<string, Buffer> {
  const cert = tlv(der, 0, der.length);
  const [tbs] = kids(der, cert);
  if (!tbs) throw new CeremonyError('ceremony.attestation_invalid', 'tbs');
  const out = new Map<string, Buffer>();
  for (const f of kids(der, tbs)) {
    if (f.tag !== 0xa3) continue;
    const [seq] = kids(der, f);
    for (const ext of kids(der, seq!)) {
      const parts = kids(der, ext);
      const id = parts[0];
      const val = parts[parts.length - 1];
      if (!id || id.tag !== 0x06 || !val || val.tag !== 0x04) continue;
      out.set(oid(der, id), der.subarray(val.start, val.end));
    }
  }
  return out;
}

const pem = (s: string, what: string): X509Certificate => {
  try {
    return new X509Certificate(s);
  } catch {
    throw new CeremonyError('ceremony.attestation_invalid', what);
  }
};

/**
 * 증명 검사. 통과하면 증명서의 공개키·일련번호·펌웨어·정책을 돌려준다.
 * - 슬롯 증명서는 f9가 서명했고, f9는 (주어진 중간 인증서를 거쳐) 주어진 루트 중 하나가 서명했다. 사슬 깊이 4 이하.
 * - 지금 시각이 각 인증서 유효 기간 안이다.
 * - 정책이 PIN always·터치 always다(requireAlways 기본 참).
 * - expectPublicKey가 있으면 증명서 공개키와 같다(장치에서 export한 공개키와 대조).
 */
export function verifyAttestation(o: { attestation: string; intermediate: string; roots: string[]; intermediates?: string[]; expectPublicKey?: Uint8Array; now?: Date; requireAlways?: boolean }): AttestationResult {
  const leaf = pem(o.attestation, 'attestation');
  const f9 = pem(o.intermediate, 'f9');
  const roots = o.roots.map((r, i) => pem(r, `root${i}`));
  const mids = (o.intermediates ?? []).map((r, i) => pem(r, `intermediate${i}`));
  if (!roots.length) throw new CeremonyError('ceremony.attestation_untrusted', '루트 없음');
  const now = o.now ?? new Date();
  const inDate = (c: X509Certificate) => now >= new Date(c.validFrom) && now <= new Date(c.validTo);
  if (!leaf.verify(f9.publicKey)) throw new CeremonyError('ceremony.attestation_untrusted', 'f9가 서명하지 않음');
  let cur = f9;
  const chain = [leaf, f9];
  for (let depth = 0; ; depth++) {
    if (depth > 3) throw new CeremonyError('ceremony.attestation_untrusted', '사슬이 너무 길다');
    const root = roots.find((r) => cur.verify(r.publicKey) && cur.checkIssued(r));
    if (root) {
      chain.push(root);
      break;
    }
    const mid = mids.find((m) => !chain.includes(m) && cur.verify(m.publicKey) && cur.checkIssued(m));
    if (!mid) throw new CeremonyError('ceremony.attestation_untrusted', '루트까지 잇지 못함');
    chain.push(mid);
    cur = mid;
  }
  for (const c of chain) if (!inDate(c)) throw new CeremonyError('ceremony.attestation_untrusted', '유효 기간 밖');

  const publicKey = rawEd25519FromSpki(leaf.publicKey.export({ format: 'der', type: 'spki' }));
  if (o.expectPublicKey && !publicKey.equals(Buffer.from(o.expectPublicKey))) throw new CeremonyError('ceremony.attestation_key_mismatch');
  const ext = certExtensions(Buffer.from(leaf.raw));
  const pol = ext.get(YUBICO_OID.policy);
  if (!pol || pol.length < 2) throw new CeremonyError('ceremony.attestation_invalid', '정책 확장 없음');
  const pinPolicy = PIN_POLICY[pol[0] as keyof typeof PIN_POLICY] ?? `unknown(${pol[0]})`;
  const touchPolicy = TOUCH_POLICY[pol[1] as keyof typeof TOUCH_POLICY] ?? `unknown(${pol[1]})`;
  if ((o.requireAlways ?? true) && (pinPolicy !== 'always' || touchPolicy !== 'always')) throw new CeremonyError('ceremony.policy_not_always', `pin=${pinPolicy} touch=${touchPolicy}`);
  const fw = ext.get(YUBICO_OID.firmware);
  const sn = ext.get(YUBICO_OID.serial);
  let serial: number | null = null;
  if (sn?.length) {
    const t = sn[0] === 0x02 ? tlv(sn, 0, sn.length) : { start: 0, end: sn.length };
    serial = 0;
    for (let i = t.start; i < t.end; i++) serial = serial * 256 + sn[i]!;
  }
  return { publicKey, serial, firmware: fw && fw.length >= 3 ? `${fw[0]}.${fw[1]}.${fw[2]}` : null, pinPolicy, touchPolicy };
}
