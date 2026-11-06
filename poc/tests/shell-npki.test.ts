// 온보딩 O-03 공동인증서 목록(npki-certs.ts): 금고 npki.list(#93) → 샌드박스 certInfo(#95) → 표시 행. Electron 없이.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import fsp from 'node:fs/promises';
import os from 'node:os';
import { DocparseError, readCertInfo, validateSandboxOutput, type CertInfo } from '@sax/docparse';
import { scanNpki } from '@sax/vault';
import { certOwner, listNpkiCerts, NPKI_SHOW_MAX, rdnValue } from '../apps/desktop/src/npki-certs.ts';
import { MockOnboardingPorts } from '../apps/desktop/src/onboarding-mock.ts';
import { OnboardingFlow } from '../apps/desktop/src/onboarding.ts';

const TODAY = '2026-11-06';
const der = (n: number) => new Uint8Array([0x30, 0x03, n, 0, 0]);
const entry = (n: number, o: Record<string, unknown> = {}) => ({
  id: n.toString(16).padStart(16, '0'),
  root: 'locallow',
  ca: 'yessign',
  dir: `C:\\Users\\kim\\AppData\\LocalLow\\NPKI\\yessign\\USER\\cn=비밀경로${n}`,
  certFile: `C:\\Users\\kim\\AppData\\LocalLow\\NPKI\\yessign\\USER\\cn=비밀경로${n}\\signCert.der`,
  certDer: der(n),
  hasKey: true,
  ...o,
});
const info = (cn: string, notAfter = '2027-03-01T14:59:59Z', issuerO = 'yessign'): CertInfo => ({
  subject: `CN=${cn},OU=XYZ,OU=personal4IB,O=yessign,C=kr`,
  issuer: `CN=yessignCA Class 2,OU=AccreditedCA,O=${issuerO},C=kr`,
  notBefore: '2026-03-01T15:00:00Z',
  notAfter,
});

// 합성 DER(서명 검증은 하지 않으므로 빈 서명 비트열). ocr-e2e.ts의 작성기와 같다.
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
const atv = (o: string, v: Uint8Array) => set(seq(oid(o), v));
const ED25519 = seq(oid('1.3.101.112'));
function syntheticCert(cn: string, notAfter: string): Uint8Array {
  const name = (c: string) => seq(atv('2.5.4.6', T(0x13, Buffer.from('kr'))), atv('2.5.4.10', T(0x13, Buffer.from('yessign'))), atv('2.5.4.3', T(0x0c, Buffer.from(c, 'utf8'))));
  const tbs = seq(T(0xa0, T(0x02, Buffer.from([2]))), T(0x02, Buffer.from([0x01])), ED25519, name('TEST-yessignCA Class 2'), seq(T(0x17, Buffer.from('260102030405Z')), T(0x17, Buffer.from(notAfter))), name(cn), seq(ED25519, T(0x03, Buffer.from([0]), Buffer.alloc(32, 7))));
  return seq(tbs, ED25519, T(0x03, Buffer.from([0]), Buffer.alloc(64)));
}

describe('공동인증서 목록: 금고 열거 → 샌드박스 해석 → 표시 행', () => {
  it('계약: 금고 scanNpki 실제 결과 모양이 그대로 들어온다(임시 NPKI 폴더, 해석기는 샌드박스와 같은 x509 모듈)', async () => {
    const root = await fsp.mkdtemp(path.join(await fsp.realpath(os.tmpdir()), 'sax-npki-'));
    try {
      const put = async (cn: string, notAfter: string, key: boolean) => {
        const dir = path.join(root, 'NPKI', 'yessign', 'USER', `cn=${cn}`);
        await fsp.mkdir(dir, { recursive: true });
        await fsp.writeFile(path.join(dir, 'signCert.der'), syntheticCert(cn, notAfter));
        if (key) await fsp.writeFile(path.join(dir, 'signPri.key'), Buffer.alloc(16));
      };
      await put('TEST홍길동()0001234567890123', '271231145959Z', true);
      await put('TEST김가나()0009', '271231145959Z', false);
      const listed = await scanNpki({ roots: [{ kind: 'home', dir: path.join(root, 'NPKI') }] });
      assert.equal(listed.certs.length, 2);
      const rows = await listNpkiCerts(async (m) => (m === 'npki.list' ? listed : null), async (d) => readCertInfo(d), { today: TODAY });
      const byOwner = Object.fromEntries(rows.map((r) => [r.owner, r]));
      assert.deepEqual(Object.keys(byOwner).sort(), ['TEST김가나', 'TEST홍길동']);
      assert.equal(byOwner['TEST홍길동']!.usable, true);
      assert.equal(byOwner['TEST홍길동']!.usage, 'yessign');
      assert.equal(byOwner['TEST홍길동']!.expiresOn, '2027-12-31');
      assert.deepEqual([byOwner['TEST김가나']!.usable, byOwner['TEST김가나']!.why], [false, 'no_key']);
      assert.ok(!JSON.stringify(rows).includes(root), '경로는 행에 없다');
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  it('RFC 4514 값 꺼내기: 이스케이프된 쉼표·16진 바이트, 없는 속성은 빈 문자열', () => {
    assert.equal(rdnValue('CN=가나다\\, 주식회사()0012,O=yessign,C=kr', 'CN'), '가나다, 주식회사()0012');
    assert.equal(rdnValue('CN=\\EA\\B0\\80나,O=x', 'CN'), '가나');
    assert.equal(rdnValue('O=yessign+OU=A,C=kr', 'OU'), 'A');
    assert.equal(rdnValue('O=yessign', 'CN'), '');
    assert.equal(certOwner('CN=홍길동()0012345678901234,OU=XYZ,O=yessign,C=kr'), '홍길동', 'CN 뒤의 식별 번호는 보이지 않는다');
  });

  it('행에는 id·소유자 이름·발급자·만료일만. 경로·주체 전체·DER는 없다. 로그에는 개수만', async () => {
    const logs: Array<[string, Record<string, number>]> = [];
    const control = async (m: string) => (m === 'npki.list' ? { certs: [entry(1), entry(2, { hasKey: false }), entry(3)], skipped: { symlink: 1 } } : null);
    const infos: Record<number, CertInfo> = { 1: info('가나다컴퍼니()0012345678901234'), 2: info('김가나()0099'), 3: info('옛인증서()01', '2026-10-01T14:59:59Z', '') };
    const rows = await listNpkiCerts(control, async (d) => infos[d[2]!]!, { today: TODAY, log: (n, d) => void logs.push([n, d]) });
    assert.deepEqual(rows, [
      { id: '0000000000000001', owner: '가나다컴퍼니', usage: 'yessign', expiresOn: '2027-03-01', usable: true },
      { id: '0000000000000002', owner: '김가나', usage: 'yessign', expiresOn: '2027-03-01', usable: false, why: 'no_key' },
      { id: '0000000000000003', owner: '옛인증서', usage: 'yessign', expiresOn: '2026-10-01', usable: false, why: 'expired' },
    ]);
    const text = JSON.stringify(rows) + JSON.stringify(logs);
    for (const leak of ['비밀경로', 'AppData', 'OU=', 'personal4IB', '0012345678901234']) assert.ok(!text.includes(leak), leak);
    assert.deepEqual(logs, [['main.npki_shown', { listed: 3, shown: 3, unusable: 2, invalid: 0 }]]);
  });

  it('모양이 틀린 항목·해석 실패·같은 id는 버리고 센다. 금고 응답이 틀리면 빈 목록', async () => {
    const logs: Array<Record<string, number>> = [];
    const bad = [
      entry(1),
      entry(1),
      entry(2, { id: '../../etc' }),
      entry(3, { certDer: 'AAAA' }),
      entry(4, { certDer: new Uint8Array(8193) }),
      entry(5, { hasKey: 'yes' }),
      entry(6),
    ];
    const rows = await listNpkiCerts(async () => ({ certs: bad, skipped: {} }), async (d) => {
      if (d[2] === 6) throw new Error('cert_invalid');
      return info('가나다()1');
    }, { today: TODAY, log: (_n, d) => void logs.push(d) });
    assert.deepEqual(rows.map((r) => r.id), ['0000000000000001']);
    assert.deepEqual(logs, [{ listed: 7, shown: 1, unusable: 0, invalid: 6 }]);
    assert.deepEqual(await listNpkiCerts(async () => ({ nope: 1 }), async () => info('x()1'), { today: TODAY }), []);
    assert.deepEqual(await listNpkiCerts(async () => null, async () => info('x()1'), { today: TODAY }), []);
    const many = Array.from({ length: NPKI_SHOW_MAX + 5 }, (_, i) => entry(i + 1));
    assert.equal((await listNpkiCerts(async () => ({ certs: many, skipped: {} }), async () => info('a()1'), { today: TODAY })).length, NPKI_SHOW_MAX);
  });

  it('CN이 비었거나 만료일 모양이 틀린 해석은 버린다', async () => {
    const rows = await listNpkiCerts(async () => ({ certs: [entry(1), entry(2)], skipped: {} }), async (d) => (d[2] === 1 ? { ...info('x()1'), subject: 'O=yessign,C=kr' } : { ...info('y()1'), notAfter: 'soon' }), { today: TODAY });
    assert.deepEqual(rows, []);
  });

  it('상태 기계: 고를 수 없는 인증서로 답하면 bad_cert, 옛 이어 하기 값(usable 칸 없음)은 고를 수 있다', async () => {
    const ports = new MockOnboardingPorts({ saveProfile: async () => {} });
    ports.findCerts = async () => [
      { id: 'a', owner: '가', usage: 'yessign', expiresOn: '2027-01-01', usable: false, why: 'no_key' as const },
      { id: 'b', owner: '나', usage: 'yessign', expiresOn: '2027-01-01' },
    ];
    const flow = new OnboardingFlow(ports, null, () => new Date('2026-11-06T01:00:00Z'));
    await flow.answer({ step: 'terms', choice: 'agree' });
    await flow.answer({ step: 'welcome', choice: 'later' });
    assert.equal(flow.state.step, 'auth');
    assert.equal(await flow.answer({ step: 'auth', choice: 'cert', certId: 'a' }).then(() => 'ok', (e: Error) => e.message), 'bad_cert');
    await flow.answer({ step: 'auth', choice: 'cert', certId: 'b' });
    assert.equal(flow.state.certId, 'b');
  });

  it('스키마 실패: main은 샌드박스 출력을 validateSandboxOutput(certInfo)로만 받고, 틀린 모양은 schema로 버린다(목록에서 빠지고 개수만 센다)', async () => {
    const src = fs.readFileSync(path.resolve(import.meta.dirname, '../apps/desktop/src/docparse.ts'), 'utf8');
    const fn = src.slice(src.indexOf('export async function certInfoInSandbox'), src.indexOf('/** @sax/docparse parse()가 부르는 샌드박스 host'));
    // 크기 경계는 샌드박스 전에(0·8193 input_size), 실행은 기존 runJob, 검증은 기존 validateSandboxOutput. main에서 DER를 읽지 않는다.
    assert.match(fn, /der\.length === 0 \|\| der\.length > CERT_MAX_BYTES\) throw new DocparseError\('input_size'\)/);
    assert.match(fn, /await runJob\(\{ kind: 'certInfo', bytes: der\.slice\(\) \}/);
    assert.match(fn, /const v = validateSandboxOutput\('certInfo', out\);\s*if \(!v\) throw new DocparseError\('schema'\);/);
    assert.ok(!/readCertInfo|@sax\/docparse\/sandbox/.test(src), 'main 쪽 docparse.ts는 x509 파서를 import하지 않는다');
    for (const f of ['shell-app.ts', 'npki-certs.ts']) assert.ok(!/readCertInfo|@sax\/docparse\/sandbox/.test(fs.readFileSync(path.resolve(import.meta.dirname, `../apps/desktop/src/${f}`), 'utf8')), f);
    const mjs = fs.readFileSync(path.resolve(import.meta.dirname, '../apps/desktop/static/docparse/docparse.mjs'), 'utf8');
    assert.match(mjs, /kind === 'certInfo' \? readCertInfo\(data\.bytes\)/);
    assert.match(mjs, /data\?\.kind === 'certInfo' \? 'cert_invalid'/);
    // 틀린 모양(덧붙인 칸·빠진 칸·날짜 모양·긴 주체)은 스키마가 거부한다.
    const ok = info('가()1');
    for (const bad of [{ ...ok, extra: 1 }, { subject: ok.subject, issuer: ok.issuer, notBefore: ok.notBefore }, { ...ok, notAfter: '2027-01-02' }, { ...ok, subject: 'x'.repeat(1025) }]) assert.equal(validateSandboxOutput('certInfo', bad), null);
    const logs: Array<Record<string, number>> = [];
    const rows = await listNpkiCerts(async () => ({ certs: [entry(1), entry(2)], skipped: {} }), async (d) => {
      if (d[2] === 1) throw new DocparseError('schema');
      return info('나()1');
    }, { today: TODAY, log: (_n, d) => void logs.push(d) });
    assert.deepEqual(rows.map((r) => r.owner), ['나']);
    assert.equal(logs[0]?.invalid, 1);
  });

  it('렌더러: 고를 수 없는 인증서는 disabled·이유 글자, 기본 선택은 고를 수 있는 첫 인증서. 글자는 textContent로만', () => {
    const src = fs.readFileSync(path.resolve(import.meta.dirname, '../apps/desktop/static/shell/shell-onboarding.js'), 'utf8');
    assert.match(src, /disabled: !usable\(c\)/);
    assert.match(src, /o\.certs\.find\(\(c\) => c\.usable !== false\)\?\.id/);
    assert.ok(src.includes("no_key: '이 PC에 개인키 파일이 없어 쓸 수 없어요'"));
    assert.ok(!src.includes('innerHTML'));
  });
});
