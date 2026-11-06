// NPKI signCert.der(공개 인증서) → 고정 4필드(D05 §6 (2), ADR-014 결정 1, D17 §3 certInfo).
// 입력은 LocalLow처럼 낮은 무결성 프로세스도 쓸 수 있는 위치에서 온 비신뢰 바이트다. 엄격한 DER만 받는다:
// 정해진 길이만(무한 길이 없음), 최소 길이 부호화, 경계 검사, 뒤에 남는 바이트 없음, 깊이·개수·길이 상한.
// 서명은 검증하지 않는다(표시용 메타데이터일 뿐, 신뢰 판단에 쓰지 않는다). 개인키(signPri.key)는 이 모듈과 무관하다.
import { SandboxError } from './limits.ts';

export interface CertInfo {
  /** RFC 4514 문자열(가장 구체적인 RDN부터: `CN=…,OU=…,O=yessign,C=kr`) */
  subject: string;
  issuer: string;
  /** ISO 8601 UTC(`2026-01-02T03:04:05Z`) */
  notBefore: string;
  notAfter: string;
}

/** signCert.der 상한(금고 NPKI_CERT_MAX_BYTES와 같다). 실제 인증서는 2KB 안팎이다. */
export const CERT_MAX_BYTES = 8192;
export const CERT_LIMITS = { maxRdns: 32, maxAttrsPerRdn: 8, maxValueChars: 256, maxNameChars: 1024 } as const;

const fail = (): never => {
  throw new SandboxError('cert_invalid');
};

interface Tlv {
  tag: number;
  /** 값 시작 */
  start: number;
  /** 값 끝(배타) */
  end: number;
}

/** b[at..limit) 안에서 TLV 하나. 높은 태그 번호(0x1f)·무한 길이·비최소 길이는 거부. */
function tlv(b: Uint8Array, at: number, limit: number): Tlv {
  if (at + 2 > limit) fail();
  const tag = b[at]!;
  if ((tag & 0x1f) === 0x1f) fail();
  let len = b[at + 1]!;
  let p = at + 2;
  if (len & 0x80) {
    const n = len & 0x7f;
    if (n === 0 || n > 2 || p + n > limit) fail(); // 0x80 = 무한 길이(BER). 8KB 안이라 2바이트면 충분하다
    len = 0;
    for (let i = 0; i < n; i++) len = (len << 8) | b[p + i]!;
    if (b[p] === 0 || len < 0x80) fail(); // 최소 부호화
    p += n;
  }
  if (p + len > limit) fail();
  return { tag, start: p, end: p + len };
}

function expect(b: Uint8Array, at: number, limit: number, tag: number): Tlv {
  const t = tlv(b, at, limit);
  if (t.tag !== tag) fail();
  return t;
}

/** 묶음(SEQUENCE·SET) 안의 원소들. */
function children(b: Uint8Array, outer: Tlv, max: number): Tlv[] {
  const out: Tlv[] = [];
  let p = outer.start;
  while (p < outer.end) {
    if (out.length >= max) fail();
    const t = tlv(b, p, outer.end);
    out.push(t);
    p = t.end;
  }
  return out;
}

const SEQ = 0x30;
const SET = 0x31;
const OID = 0x06;

export function readCertInfo(der: Uint8Array): CertInfo {
  if (der.length === 0 || der.length > CERT_MAX_BYTES) throw new SandboxError('input_size');
  const cert = expect(der, 0, der.length, SEQ);
  if (cert.end !== der.length) fail(); // 뒤에 덧붙은 바이트 없음
  const top = children(der, cert, 3);
  if (top.length !== 3 || top[0]!.tag !== SEQ || top[1]!.tag !== SEQ || top[2]!.tag !== 0x03) fail();
  const tbs = children(der, top[0]!, 16);
  let i = 0;
  if (tbs[0]?.tag === 0xa0) i++; // [0] EXPLICIT version
  // serialNumber INTEGER, signature AlgorithmIdentifier, issuer Name, validity, subject Name, subjectPublicKeyInfo
  if (tbs.length < i + 6) fail();
  if (tbs[i]!.tag !== 0x02 || tbs[i + 1]!.tag !== SEQ) fail();
  const issuer = name(der, tbs[i + 2]!);
  const validity = tbs[i + 3]!;
  if (validity.tag !== SEQ) fail();
  const v = children(der, validity, 2);
  if (v.length !== 2) fail();
  const notBefore = time(der, v[0]!);
  const notAfter = time(der, v[1]!);
  const subject = name(der, tbs[i + 4]!);
  if (tbs[i + 5]!.tag !== SEQ) fail();
  return { subject, issuer, notBefore, notAfter };
}

const SHORT: Record<string, string> = {
  '2.5.4.3': 'CN',
  '2.5.4.4': 'SN',
  '2.5.4.5': 'serialNumber',
  '2.5.4.6': 'C',
  '2.5.4.7': 'L',
  '2.5.4.8': 'ST',
  '2.5.4.9': 'STREET',
  '2.5.4.10': 'O',
  '2.5.4.11': 'OU',
  '2.5.4.12': 'title',
  '2.5.4.42': 'GN',
  '0.9.2342.19200300.100.1.25': 'DC',
  '0.9.2342.19200300.100.1.1': 'UID',
  '1.2.840.113549.1.9.1': 'emailAddress',
};

/** Name = SEQUENCE OF RDN(SET OF AttributeTypeAndValue). 출력은 RFC 4514 순서(뒤에서부터). */
function name(b: Uint8Array, t: Tlv): string {
  if (t.tag !== SEQ) fail();
  const rdns = children(b, t, CERT_LIMITS.maxRdns);
  const parts: string[] = [];
  for (const rdn of rdns) {
    if (rdn.tag !== SET) fail();
    const atvs = children(b, rdn, CERT_LIMITS.maxAttrsPerRdn);
    if (atvs.length === 0) fail();
    const one: string[] = [];
    for (const atv of atvs) {
      if (atv.tag !== SEQ) fail();
      const kv = children(b, atv, 2);
      if (kv.length !== 2 || kv[0]!.tag !== OID) fail();
      const oid = oidString(b, kv[0]!);
      one.push(`${SHORT[oid] ?? oid}=${escape(dirString(b, kv[1]!))}`);
    }
    parts.push(one.join('+'));
  }
  const s = parts.reverse().join(',');
  if (s.length > CERT_LIMITS.maxNameChars) fail();
  return s;
}

function oidString(b: Uint8Array, t: Tlv): string {
  if (t.end - t.start < 1 || t.end - t.start > 32) fail();
  const arcs: number[] = [];
  let v = 0;
  let first = true;
  for (let p = t.start; p < t.end; p++) {
    const c = b[p]!;
    if (v === 0 && c === 0x80) fail(); // 비최소 부호화
    v = v * 128 + (c & 0x7f);
    if (v > 0xffffffff) fail();
    if (c & 0x80) {
      if (p === t.end - 1) fail();
      continue;
    }
    if (first) {
      const a = v < 40 ? 0 : v < 80 ? 1 : 2;
      arcs.push(a, v - a * 40);
      first = false;
    } else arcs.push(v);
    v = 0;
  }
  return arcs.join('.');
}

const utf8 = new TextDecoder('utf-8', { fatal: true });
const utf16be = new TextDecoder('utf-16be', { fatal: true });

/** DirectoryString 계열 → 문자열. 알 수 없는 형식은 거부한다. */
function dirString(b: Uint8Array, t: Tlv): string {
  const raw = b.subarray(t.start, t.end);
  let s: string;
  try {
    switch (t.tag) {
      case 0x0c: // UTF8String
        s = utf8.decode(raw);
        break;
      case 0x13: // PrintableString
      case 0x16: // IA5String
      case 0x12: // NumericString
      case 0x1a: // VisibleString
        for (const c of raw) if (c > 0x7e) fail();
        s = String.fromCharCode(...raw);
        break;
      case 0x14: // TeletexString(T61): 실제로는 latin1로 쓰인다
        s = String.fromCharCode(...raw);
        break;
      case 0x1e: // BMPString
        if (raw.length % 2) fail();
        s = utf16be.decode(raw);
        break;
      case 0x1c: {
        // UniversalString(UTF-32BE)
        if (raw.length % 4) fail();
        const cps: number[] = [];
        for (let p = 0; p < raw.length; p += 4) cps.push(((raw[p]! << 24) | (raw[p + 1]! << 16) | (raw[p + 2]! << 8) | raw[p + 3]!) >>> 0);
        if (cps.some((c) => c > 0x10ffff || (c >= 0xd800 && c <= 0xdfff))) fail();
        s = String.fromCodePoint(...cps);
        break;
      }
      default:
        return fail();
    }
  } catch (e) {
    if (e instanceof SandboxError) throw e;
    return fail();
  }
  if (s.length > CERT_LIMITS.maxValueChars) fail();
  return s;
}

/**
 * RFC 4514 이스케이프 + 표시 위험 문자. 제어 문자·양방향 제어(U+202A~202E·2066~2069·200E·200F)·
 * 줄 구분(U+2028·2029)·BOM은 UTF-8 바이트 `\hh`로 바꿔 화면에서 글자 순서를 속이지 못하게 한다.
 */
function escape(v: string): string {
  let out = '';
  const chars = [...v];
  chars.forEach((ch, idx) => {
    const cp = ch.codePointAt(0)!;
    const risky = cp < 0x20 || cp === 0x7f || (cp >= 0x80 && cp < 0xa0) || (cp >= 0x202a && cp <= 0x202e) || (cp >= 0x2066 && cp <= 0x2069) || cp === 0x200e || cp === 0x200f || cp === 0x2028 || cp === 0x2029 || cp === 0xfeff;
    if (risky) {
      for (const byte of new TextEncoder().encode(ch)) out += '\\' + byte.toString(16).padStart(2, '0');
    } else if (',+"\\<>;'.includes(ch) || (idx === 0 && (ch === '#' || ch === ' ')) || (idx === chars.length - 1 && ch === ' ')) out += '\\' + ch;
    else out += ch;
  });
  return out;
}

/** UTCTime(YYMMDDHHMMSSZ) 또는 GeneralizedTime(YYYYMMDDHHMMSSZ) → ISO 8601 UTC. 초 생략·소수·지역 시각은 받지 않는다(RFC 5280 §4.1.2.5). */
function time(b: Uint8Array, t: Tlv): string {
  const s = String.fromCharCode(...b.subarray(t.start, t.end));
  let y: number;
  let rest: string;
  if (t.tag === 0x17) {
    if (!/^\d{12}Z$/.test(s)) fail();
    const yy = Number(s.slice(0, 2));
    y = yy >= 50 ? 1900 + yy : 2000 + yy;
    rest = s.slice(2);
  } else if (t.tag === 0x18) {
    if (!/^\d{14}Z$/.test(s)) fail();
    y = Number(s.slice(0, 4));
    rest = s.slice(4);
  } else return fail();
  const [mo, d, h, mi, se] = [0, 2, 4, 6, 8].map((k) => Number(rest.slice(k, k + 2))) as [number, number, number, number, number];
  const ms = Date.UTC(y, mo - 1, d, h, mi, se);
  const dt = new Date(ms);
  // 13월·2월 30일·25시 같은 값이 넘어가 다른 날짜가 되면 거부
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d || dt.getUTCHours() !== h || dt.getUTCMinutes() !== mi || dt.getUTCSeconds() !== se) fail();
  return `${String(y).padStart(4, '0')}-${rest.slice(0, 2)}-${rest.slice(2, 4)}T${rest.slice(4, 6)}:${rest.slice(6, 8)}:${rest.slice(8, 10)}Z`;
}
