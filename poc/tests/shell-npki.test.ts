// 온보딩 O-03 공동인증서 목록(npki-certs.ts): 금고 npki.list(#93) → 샌드박스 certInfo(#95) → 표시 행. Electron 없이.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import type { CertInfo } from '@sax/docparse';
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

describe('공동인증서 목록: 금고 열거 → 샌드박스 해석 → 표시 행', () => {
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

  it('렌더러: 고를 수 없는 인증서는 disabled·이유 글자, 기본 선택은 고를 수 있는 첫 인증서. 글자는 textContent로만', () => {
    const src = fs.readFileSync(path.resolve(import.meta.dirname, '../apps/desktop/static/shell/shell-onboarding.js'), 'utf8');
    assert.match(src, /disabled: !usable\(c\)/);
    assert.match(src, /o\.certs\.find\(\(c\) => c\.usable !== false\)\?\.id/);
    assert.ok(src.includes("no_key: '이 PC에 개인키 파일이 없어 쓸 수 없어요'"));
    assert.ok(!src.includes('innerHTML'));
  });
});
