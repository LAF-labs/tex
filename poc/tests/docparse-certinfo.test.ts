// docparse certInfo(D17 §3, ADR-014 결정 1, D05 §6 (2)): NPKI signCert.der → {subject, issuer, notBefore, notAfter}.
// 합성 DER(시험 안 DER 작성기)로 만든다. 서명된 합성 인증서는 node X509Certificate로 따로 읽어 대조한다.
// 비신뢰 입력이라 BER·비최소 길이·뒤 덧붙임·잘림·깊이·알 수 없는 문자열 형식·잘못된 날짜·표시 위험 문자를 본다.
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign, X509Certificate } from 'node:crypto';
import { describe, it } from 'node:test';
import { validateSandboxOutput } from '@sax/docparse';
import { CERT_LIMITS, CERT_MAX_BYTES, readCertInfo, SANDBOX_ERRORS, SandboxError } from '@sax/docparse/sandbox';

// ── 최소 DER 작성기 ──
const len = (n: number) => (n < 0x80 ? [n] : n < 0x100 ? [0x81, n] : [0x82, n >> 8, n & 0xff]);
const T = (tag: number, ...body: Uint8Array[]) => {
  const v = Buffer.concat(body);
  return new Uint8Array(Buffer.concat([Buffer.from([tag, ...len(v.length)]), v]));
};
const seq = (...b: Uint8Array[]) => T(0x30, ...b);
const set = (...b: Uint8Array[]) => T(0x31, ...b);
function oid(s: string): Uint8Array {
  const a = s.split('.').map(Number);
  const out = [a[0]! * 40 + a[1]!];
  for (const x of a.slice(2)) {
    const enc = [x & 0x7f];
    for (let v = x >>> 7; v > 0; v >>>= 7) enc.unshift((v & 0x7f) | 0x80);
    out.push(...enc);
  }
  return T(0x06, Buffer.from(out));
}
const utf8s = (s: string) => T(0x0c, Buffer.from(s, 'utf8'));
const printable = (s: string) => T(0x13, Buffer.from(s, 'latin1'));
const bmp = (s: string) => T(0x1e, Buffer.from(s, 'utf16le').swap16());
const utc = (s: string) => T(0x17, Buffer.from(s, 'latin1'));
const gen = (s: string) => T(0x18, Buffer.from(s, 'latin1'));
const atv = (o: string, v: Uint8Array) => set(seq(oid(o), v));
const OIDS = { C: '2.5.4.6', O: '2.5.4.10', OU: '2.5.4.11', CN: '2.5.4.3', serial: '2.5.4.5', email: '1.2.840.113549.1.9.1' };

/** NPKI 모양 이름: c=kr, o=yessign, ou=개인, ou=XX은행, ou=RA센터, cn=TEST홍길동()… (DER 순서는 C부터) */
const npkiSubject = () =>
  seq(atv(OIDS.C, printable('kr')), atv(OIDS.O, printable('yessign')), atv(OIDS.OU, utf8s('개인')), atv(OIDS.OU, utf8s('XX은행')), atv(OIDS.OU, utf8s('RA센터')), atv(OIDS.CN, utf8s('TEST홍길동()0001234567890123')));
const npkiIssuer = () => seq(atv(OIDS.C, printable('kr')), atv(OIDS.O, printable('yessign')), atv(OIDS.OU, printable('AccreditedCA')), atv(OIDS.CN, printable('TEST-yessignCA Class 2')));

const ED25519 = seq(oid('1.3.101.112'));
const keys = generateKeyPairSync('ed25519');
const spki = new Uint8Array(keys.publicKey.export({ format: 'der', type: 'spki' }));

interface CertParts {
  version?: Uint8Array | null;
  serial?: Uint8Array;
  issuer?: Uint8Array;
  validity?: Uint8Array;
  subject?: Uint8Array;
  spki?: Uint8Array;
  extra?: Uint8Array[];
}
function tbs(p: CertParts = {}): Uint8Array {
  const parts = [
    ...(p.version === null ? [] : [p.version ?? T(0xa0, T(0x02, Buffer.from([2])))]),
    p.serial ?? T(0x02, Buffer.from([0x01, 0x23, 0x45])),
    ED25519,
    p.issuer ?? npkiIssuer(),
    p.validity ?? seq(utc('260102030405Z'), utc('270102235959Z')),
    p.subject ?? npkiSubject(),
    p.spki ?? spki,
    ...(p.extra ?? []),
  ];
  return seq(...parts);
}
/** 서명까지 한 실제 모양 인증서(node가 읽을 수 있다). */
function certDer(p: CertParts = {}): Uint8Array {
  const t = tbs(p);
  const sig = sign(null, t, keys.privateKey);
  return seq(t, ED25519, T(0x03, Buffer.from([0]), sig));
}
const code = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    assert.ok(e instanceof SandboxError, `SandboxError가 아님: ${(e as Error)?.constructor?.name}`);
    return (e as SandboxError).code;
  }
  return 'ok';
};

describe('docparse certInfo: 합성 NPKI 인증서', () => {
  it('주체·발급자는 RFC 4514(구체적인 것부터), 기간은 ISO 8601 UTC, 스키마 통과', () => {
    const der = certDer();
    const r = readCertInfo(der);
    assert.deepEqual(r, {
      subject: 'CN=TEST홍길동()0001234567890123,OU=RA센터,OU=XX은행,OU=개인,O=yessign,C=kr',
      issuer: 'CN=TEST-yessignCA Class 2,OU=AccreditedCA,O=yessign,C=kr',
      notBefore: '2026-01-02T03:04:05Z',
      notAfter: '2027-01-02T23:59:59Z',
    });
    assert.deepEqual(validateSandboxOutput('certInfo', r), r);
    // node(OpenSSL)가 따로 읽은 값과 같다
    const x = new X509Certificate(Buffer.from(der));
    const nodeName = (s: string) => s.split('\n').reverse().join(',');
    assert.equal(r.subject, nodeName(x.subject));
    assert.equal(r.issuer, nodeName(x.issuer));
    assert.equal(new Date(r.notBefore).getTime(), new Date(x.validFrom).getTime());
    assert.equal(new Date(r.notAfter).getTime(), new Date(x.validTo).getTime());
  });

  it('version 없음(v1)·확장 있음·GeneralizedTime(2050년 이후)·BMPString·여러 값 RDN', () => {
    const subject = seq(atv(OIDS.C, printable('kr')), set(seq(oid(OIDS.CN), bmp('TEST김사장')), seq(oid(OIDS.serial), printable('1234'))), atv(OIDS.email, T(0x16, Buffer.from('test@example.com'))));
    const r = readCertInfo(certDer({ version: null, subject, validity: seq(utc('491231235959Z'), gen('20510101000000Z')), extra: [T(0xa3, seq())] }));
    assert.equal(r.subject, 'emailAddress=test@example.com,CN=TEST김사장+serialNumber=1234,C=kr', 'DER 순서의 역순');
    assert.equal(r.notBefore, '2049-12-31T23:59:59Z', 'UTCTime 49 → 2049');
    assert.equal(r.notAfter, '2051-01-01T00:00:00Z');
    assert.equal(readCertInfo(certDer({ validity: seq(utc('500101000000Z'), utc('991231000000Z')) })).notBefore, '1950-01-01T00:00:00Z', 'UTCTime 50 → 1950');
  });

  it('RFC 4514 특수 문자와 화면을 속이는 문자(양방향 제어·제어 문자·줄 구분)는 이스케이프한다', () => {
    const cn = (v: Uint8Array) => readCertInfo(certDer({ subject: seq(atv(OIDS.CN, v)) })).subject;
    assert.equal(cn(utf8s('a,b+c"d\\e<f>g;h')), 'CN=a\\,b\\+c\\"d\\\\e\\<f\\>g\\;h');
    assert.equal(cn(utf8s('#lead')), 'CN=\\#lead');
    assert.equal(cn(utf8s(' pad ')), 'CN=\\ pad\\ ');
    assert.equal(cn(utf8s('TEST‮gnp.exe')), 'CN=TEST\\e2\\80\\aegnp.exe', 'RLO');
    assert.equal(cn(utf8s('a\nb\u0000c d﻿')), 'CN=a\\0ab\\00c\\e2\\80\\a8d\\ef\\bb\\bf');
    assert.equal(cn(utf8s('a=b')), 'CN=a=b');
    // 알 수 없는 속성은 점 표기 OID
    assert.equal(readCertInfo(certDer({ subject: seq(atv('1.2.410.200004.10.1.1', utf8s('x'))) })).subject, '1.2.410.200004.10.1.1=x');
  });
});

describe('docparse certInfo: 거부(비신뢰 입력)', () => {
  const good = certDer();

  it('크기: 0바이트·8KB 초과는 input_size', () => {
    assert.equal(code(() => readCertInfo(new Uint8Array(0))), 'input_size');
    assert.equal(code(() => readCertInfo(new Uint8Array(CERT_MAX_BYTES + 1))), 'input_size');
  });

  it('잘림·뒤 덧붙임·무한 길이(BER)·비최소 길이·높은 태그 번호는 cert_invalid', () => {
    for (let n = 1; n < good.length; n += Math.max(1, Math.floor(good.length / 64))) assert.equal(code(() => readCertInfo(good.subarray(0, n))), 'cert_invalid', `잘림 ${n}`);
    assert.equal(code(() => readCertInfo(new Uint8Array([...good, 0]))), 'cert_invalid', '덧붙임');
    const body = good.subarray(4); // 0x30 0x82 hi lo
    assert.equal(code(() => readCertInfo(new Uint8Array([0x30, 0x80, ...body, 0, 0]))), 'cert_invalid', '무한 길이');
    assert.equal(code(() => readCertInfo(new Uint8Array([0x30, 0x83, 0x00, good[2]!, good[3]!, ...body]))), 'cert_invalid', '길이 앞 0');
    const short = seq(T(0x02, Buffer.from([1])));
    assert.equal(code(() => readCertInfo(new Uint8Array([0x30, 0x81, short.length - 2, ...short.subarray(2)]))), 'cert_invalid', '0x81 + 128 미만');
    assert.equal(code(() => readCertInfo(new Uint8Array([0x1f, 0x81, 0x00, 0x00]))), 'cert_invalid', '높은 태그');
    assert.equal(code(() => readCertInfo(Buffer.from('-----BEGIN CERTIFICATE-----\nMII...'))), 'cert_invalid', 'PEM');
  });

  it('구조: 최상위 원소 수·태그, 기간 원소 수, 이름 태그·빈 RDN, OID 아닌 속성', () => {
    const wrap = (t: Uint8Array) => seq(t, ED25519, T(0x03, Buffer.from([0])));
    assert.equal(code(() => readCertInfo(seq(tbs(), ED25519))), 'cert_invalid');
    assert.equal(code(() => readCertInfo(wrap(tbs({ validity: seq(utc('260102030405Z')) })))), 'cert_invalid');
    assert.equal(code(() => readCertInfo(wrap(tbs({ subject: set() })))), 'cert_invalid');
    assert.equal(code(() => readCertInfo(wrap(tbs({ subject: seq(set()) })))), 'cert_invalid');
    assert.equal(code(() => readCertInfo(wrap(tbs({ subject: seq(set(seq(printable('x'), printable('y')))) })))), 'cert_invalid');
    assert.equal(code(() => readCertInfo(wrap(tbs({ spki: T(0x02, Buffer.from([1])) })))), 'cert_invalid');
    assert.equal(code(() => readCertInfo(wrap(seq(T(0x02, Buffer.from([1])))))), 'cert_invalid', 'tbs 원소 부족');
  });

  it('문자열 형식: PrintableString 8비트·잘못된 UTF-8·홀수 BMP·서로게이트·알 수 없는 형식은 cert_invalid', () => {
    const cn = (v: Uint8Array) => code(() => readCertInfo(certDer({ subject: seq(atv(OIDS.CN, v)) })));
    assert.equal(cn(T(0x13, Buffer.from([0x41, 0xc3]))), 'cert_invalid');
    assert.equal(cn(T(0x0c, Buffer.from([0xc3, 0x28]))), 'cert_invalid');
    assert.equal(cn(T(0x0c, Buffer.from([0xed, 0xa0, 0x80]))), 'cert_invalid', 'UTF-8 서로게이트');
    assert.equal(cn(T(0x1e, Buffer.from([0x00, 0x41, 0x00]))), 'cert_invalid');
    assert.equal(cn(T(0x1e, Buffer.from([0xd8, 0x00]))), 'cert_invalid', '짝 없는 서로게이트');
    assert.equal(cn(T(0x04, Buffer.from('x'))), 'cert_invalid', 'OCTET STRING');
    assert.equal(cn(T(0x1c, Buffer.from([0x00, 0x11, 0x00, 0x00]))), 'cert_invalid', 'UniversalString 범위 밖');
    assert.equal(code(() => readCertInfo(certDer({ subject: seq(atv(OIDS.CN, T(0x1c, Buffer.from([0, 0, 0xd5, 0x5c])))) }))), 'ok', 'UniversalString 한글');
    assert.equal(readCertInfo(certDer({ subject: seq(atv(OIDS.CN, T(0x14, Buffer.from([0x41, 0xe9])))) })).subject, 'CN=Aé', 'Teletex latin1');
  });

  it('날짜: 형식(초 생략·지역 시각·소수)·없는 날짜·다른 태그는 cert_invalid', () => {
    const v = (a: Uint8Array) => code(() => readCertInfo(certDer({ validity: seq(a, utc('270102235959Z')) })));
    for (const bad of ['2601020304Z', '260102030405+0900', '260102030405.5Z', '261301000000Z', '260230000000Z', '260102250000Z', '260102036000Z']) assert.equal(v(utc(bad)), 'cert_invalid', bad);
    assert.equal(v(gen('2026010203040Z')), 'cert_invalid');
    assert.equal(v(printable('260102030405Z')), 'cert_invalid');
    assert.equal(v(utc('240229000000Z')), 'ok', '윤년');
  });

  it('상한: RDN 32개·RDN당 값 8개·값 256자·이름 1024자', () => {
    const many = (n: number) => seq(...Array.from({ length: n }, (_, i) => atv(OIDS.OU, printable(`u${i}`))));
    assert.equal(code(() => readCertInfo(certDer({ subject: many(CERT_LIMITS.maxRdns) }))), 'ok');
    assert.equal(code(() => readCertInfo(certDer({ subject: many(CERT_LIMITS.maxRdns + 1) }))), 'cert_invalid');
    const multi = (n: number) => seq(set(...Array.from({ length: n }, (_, i) => seq(oid(OIDS.OU), printable(`v${i}`)))));
    assert.equal(code(() => readCertInfo(certDer({ subject: multi(CERT_LIMITS.maxAttrsPerRdn) }))), 'ok');
    assert.equal(code(() => readCertInfo(certDer({ subject: multi(CERT_LIMITS.maxAttrsPerRdn + 1) }))), 'cert_invalid');
    assert.equal(code(() => readCertInfo(certDer({ subject: seq(atv(OIDS.CN, utf8s('가'.repeat(CERT_LIMITS.maxValueChars)))) }))), 'ok');
    assert.equal(code(() => readCertInfo(certDer({ subject: seq(atv(OIDS.CN, utf8s('가'.repeat(CERT_LIMITS.maxValueChars + 1)))) }))), 'cert_invalid');
    const wide = seq(...Array.from({ length: 6 }, () => atv(OIDS.OU, printable('x'.repeat(200)))));
    assert.equal(code(() => readCertInfo(certDer({ subject: wide }))), 'cert_invalid', '이름 1024자 초과');
  });

  it('무작위 변이 2000회: SandboxError(input_size·cert_invalid) 아니면 스키마 통과, 다른 예외 없음', () => {
    let s = 20261106;
    const rnd = (n: number) => ((s = (s * 1103515245 + 12345) >>> 0) % n);
    const counts = { ok: 0, cert_invalid: 0, input_size: 0 };
    for (let k = 0; k < 2000; k++) {
      const b = new Uint8Array(good);
      for (let j = 0, m = 1 + rnd(4); j < m; j++) b[rnd(b.length)] = rnd(256);
      const c = code(() => {
        const r = readCertInfo(b);
        assert.deepEqual(validateSandboxOutput('certInfo', r), r, `변이 ${k} 스키마`);
      });
      assert.ok(c in counts, `변이 ${k}: ${c}`);
      counts[c as keyof typeof counts]++;
    }
    assert.ok(counts.cert_invalid > 0 && counts.ok > 0, JSON.stringify(counts));
  });

  it('스키마: 필드 추가·빠짐·형식 오류는 버린다, cert_invalid는 오류 목록에 있다', () => {
    const r = readCertInfo(good);
    assert.equal(validateSandboxOutput('certInfo', { ...r, extra: 1 }), null);
    assert.equal(validateSandboxOutput('certInfo', { subject: r.subject, issuer: r.issuer, notBefore: r.notBefore }), null);
    assert.equal(validateSandboxOutput('certInfo', { ...r, notAfter: '2027-01-02' }), null);
    assert.equal(validateSandboxOutput('certInfo', { ...r, subject: 'x'.repeat(1025) }), null);
    assert.ok((SANDBOX_ERRORS as readonly string[]).includes('cert_invalid'));
    assert.deepEqual(validateSandboxOutput('error', { error: 'cert_invalid' }), { error: 'cert_invalid' });
  });
});
