// .sxp 컨테이너 v1(SIGNING.md §6): 정규형만 받는다.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { SXP_MAX_BYTES, decodeSxp, encodeSxp, hotfixIndexName } from '@sax/engine/core';

const raw = { manifest: Buffer.from('{"id":"a.b"}'), playbook: Buffer.from('{}'), selectors: Buffer.from('{"x":1}'), strings: Buffer.from('{"s":"가"}') };
const code = (b: Buffer | string) => {
  const r = decodeSxp(Buffer.from(b));
  return r.ok ? 'ok' : r.code;
};

describe('.sxp v1', () => {
  it('패키지·핫픽스 왕복(원시 바이트 그대로)', () => {
    const r = decodeSxp(encodeSxp({ kind: 'package', raw }));
    assert.ok(r.ok && r.sxp.kind === 'package');
    for (const k of ['manifest', 'playbook', 'selectors', 'strings'] as const) assert.ok(Buffer.from(r.sxp.raw[k]).equals(raw[k]), k);
    const h = decodeSxp(encodeSxp({ kind: 'hotfix', bytes: Buffer.from('{"monotonic":3}') }));
    assert.ok(h.ok && h.sxp.kind === 'hotfix' && h.sxp.hotfix.monotonic === 3);
  });
  it('바이트는 JCS 정규형이다(키 순서·공백)', () => {
    const b = encodeSxp({ kind: 'package', raw }).toString('utf8');
    assert.ok(b.startsWith('{"format":"sxp/1","kind":"package","manifest":"'));
    const o = JSON.parse(b) as Record<string, string>;
    assert.equal(code(JSON.stringify(o, null, 1)), 'sxp.not_canonical');
    assert.equal(code(JSON.stringify({ kind: o.kind, format: o.format, manifest: o.manifest, playbook: o.playbook, selectors: o.selectors, strings: o.strings })), 'sxp.not_canonical');
  });
  it('모르는 형식·키 누락·여분 키·kind 섞임·base64 오류·크기 초과는 거부', () => {
    const o = JSON.parse(encodeSxp({ kind: 'package', raw }).toString('utf8')) as Record<string, string>;
    const j = (x: Record<string, unknown>) => JSON.stringify(Object.fromEntries(Object.entries(x).sort(([a], [b]) => (a < b ? -1 : 1))));
    assert.equal(code(j({ ...o, format: 'sxp/2' })), 'sxp.unknown_format');
    const noStrings: Record<string, string> = { ...o };
    delete noStrings.strings;
    assert.equal(code(j(noStrings)), 'sxp.malformed');
    assert.equal(code(j({ ...o, extra: 'x' })), 'sxp.malformed');
    assert.equal(code(j({ ...o, hotfix: o.manifest })), 'sxp.malformed');
    assert.equal(code(j({ ...o, playbook: 'e30' })), 'sxp.malformed', '패딩 없는 base64');
    assert.equal(code(j({ ...o, playbook: 'e3-=' })), 'sxp.malformed', 'base64url 문자');
    assert.equal(code('not json'), 'sxp.malformed');
    assert.equal(code(encodeSxp({ kind: 'hotfix', bytes: Buffer.from('{"reason":"\\ud800"}') })), 'sxp.malformed', '안쪽 핫픽스가 JCS 불가');
    assert.equal(code(Buffer.alloc(SXP_MAX_BYTES + 1, 0x20)), 'sxp.too_large');
  });
  it('핫픽스 인덱스 이름: <appliesTo.id>.hotfix @ <keyEpoch>.<monotonic>.0', () =>
    assert.deepEqual(hotfixIndexName({ appliesTo: { id: 'hometax.invoice.issue', version: '2.1.0', packageDigest: 'a'.repeat(64) }, keyEpoch: 1, monotonic: 3 }), { id: 'hometax.invoice.issue.hotfix', version: '1.3.0' }));
});
