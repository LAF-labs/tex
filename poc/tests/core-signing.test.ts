// 서명 바이트 규약(design/schemas/SIGNING.md) 시험 벡터: 문서의 값과 엔진 함수가 바이트 단위로 같아야 한다.
import assert from 'node:assert/strict';
import { createPrivateKey, createPublicKey, sign } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { canonicalJson, contentBytes, ed25519PublicKey, schemaViolations, statusContentDigest, timestampBody, verifyEd25519, type RegistryStatus } from '@sax/engine/core';

const doc = fs.readFileSync(path.resolve(import.meta.dirname, '../../sovereign-ax/design/schemas/SIGNING.md'), 'utf8');
const field = (label: string) => {
  const m = new RegExp(`^- ${label}: \`([^\`]+)\`$`, 'm').exec(doc);
  assert.ok(m, label);
  return m[1]!;
};

const priv = createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), Buffer.alloc(32, 7)]), format: 'der', type: 'pkcs8' });
const pubRaw = createPublicKey(priv).export({ format: 'der', type: 'spki' }).subarray(12);
const status = {
  monotonic: 12, keyEpoch: 1, issuedAt: '2026-11-05T09:00:00+09:00', expiresAt: '2026-11-07T09:00:00+09:00',
  portalModeCeiling: { hometax: 'assisted' }, killPlaybooks: ['hometax.invoice.cancel'],
} as const;

describe('SIGNING.md 시험 벡터(§10.1)', () => {
  it('공개키', () => assert.ok(doc.includes(`공개키 \`${pubRaw.toString('hex')}\``)));
  const content = contentBytes(status);
  const cd = field('`contentDigest`');
  it('내용 서명 바이트 = JCS(status − signatures·issuedAt·expiresAt·timestamp), contentDigest', () => {
    assert.equal(content.toString('utf8'), field('내용 서명 바이트'));
    assert.equal(statusContentDigest({ ...status, signatures: [], timestamp: { keyId: 't', alg: 'ed25519', sig: '' } } as unknown as RegistryStatus), cd);
  });
  it('Ed25519 서명은 결정적이고 엔진 검증을 통과한다', () => {
    const pub = ed25519PublicKey(pubRaw);
    assert.equal(sign(null, content, priv).toString('base64url'), field('내용 서명'));
    assert.ok(verifyEd25519(pub, content, field('내용 서명')));
    const tb = timestampBody(cd, status);
    assert.equal(tb.toString('utf8'), field('타임스탬프 서명 바이트'));
    assert.equal(sign(null, tb, priv).toString('base64url'), field('타임스탬프 서명'));
    assert.ok(verifyEd25519(pub, tb, field('타임스탬프 서명')));
  });
  it('서명을 채운 벡터 문서는 status.schema.json에 맞는다', () => {
    const signed = { ...status, signatures: [{ keyId: 'pol-1', alg: 'ed25519', sig: field('내용 서명') }], timestamp: { keyId: 'ts-1', alg: 'ed25519', sig: field('타임스탬프 서명') } };
    assert.deepEqual(schemaViolations('status', signed), []);
  });
});

describe('SIGNING.md AIK 서명 입력(§8, §10.2)', () => {
  const obj = { device_id: 'dev-desktop-1', role: 'desktop', Sx: Buffer.alloc(32, 9).toString('base64'), Vx: Buffer.alloc(32, 10).toString('base64'), registered_at: 1762300800000, list_version: 1 };
  it('utf8(ctx) ‖ JCS(객체), 구분 바이트 없음, 표준 base64', () => {
    assert.equal(canonicalJson(obj), field('AIK 대상 JCS'));
    const input = Buffer.concat([Buffer.from('SAX-devlist-v1', 'utf8'), Buffer.from(canonicalJson(obj), 'utf8')]);
    const sig = sign(null, input, priv);
    assert.equal(sig.toString('base64'), field('AIK 서명'));
    assert.ok(verifyEd25519(ed25519PublicKey(pubRaw), input, sig.toString('base64url')));
  });
});
