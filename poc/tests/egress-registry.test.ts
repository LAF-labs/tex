// 레지스트리 egress 허용 목록(팀장 결정 2026-11-06, 데스크톱 #126 업데이터 전제, D09 §8·§8.3, ADR-028):
// origin은 tax.laf-co.com 하나, GET 경로는 릴리스 매니페스트·status·폐기 키·투명성 로그·stable 인덱스·`.sxp`(엔진 패키지 공급, PR-D2), 쿼리는 leaf·size / from·to만.
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';
import { Egress, EgressError, REGISTRY_CHANNELS, REGISTRY_MAX_BYTES, REGISTRY_ORIGIN, REGISTRY_PACKAGE_MAX_BYTES, registryTargetAllowed } from '../packages/net/src/index.ts';

const LEAF = 'ab'.repeat(32);

describe('레지스트리 허용 경로(registryTargetAllowed)', () => {
  it('origin은 게이트웨이와 같은 https://tax.laf-co.com 하나다', () => {
    assert.equal(REGISTRY_ORIGIN, 'https://tax.laf-co.com');
  });

  it('릴리스 매니페스트(stable·beta·hotfix)·status·폐기 키·로그 헤드·항목·포함 증명·일관성 증명을 연다', () => {
    const ok = [
      ...REGISTRY_CHANNELS.map((c) => `/releases/${c}/latest.json`),
      '/registry/status.json',
      '/registry/revoked_keys.json',
      '/registry/log/head.json',
      '/registry/log/entries/0.json',
      '/registry/log/entries/123456.json',
      `/registry/log/proof/inclusion?leaf=${LEAF}&size=7`,
      `/registry/log/proof/inclusion?size=7&leaf=${LEAF}`,
      '/registry/log/proof/consistency?from=3&to=7',
      // 엔진 패키지 공급(D09 §8 정적 호스팅): stable 인덱스, 불변 .sxp(id에 점 필수, 데이터 패키지 id의 -, 핫픽스 이름)
      '/registry/stable/index.json',
      '/packages/hometax.invoice.issue@2.1.0.sxp',
      '/packages/payroll.rate-tables@2026.11.1.sxp',
      '/packages/hometax.invoice.issue.hotfix@1.3.0.sxp',
    ];
    for (const t of ok) assert.ok(registryTargetAllowed(t), t);
  });

  it('쿼리 키는 정확히 leaf·size / from·to만: 추가·중복·빠짐·값 형식 틀림·쿼리 없는 경로의 쿼리는 거부', () => {
    const bad = [
      `/registry/log/proof/inclusion?leaf=${LEAF}`,
      `/registry/log/proof/inclusion?leaf=${LEAF}&size=7&x=1`,
      `/registry/log/proof/inclusion?leaf=${LEAF}&leaf=${LEAF}&size=7`,
      `/registry/log/proof/inclusion?leaf=${LEAF.toUpperCase()}&size=7`,
      `/registry/log/proof/inclusion?leaf=${LEAF.slice(2)}&size=7`,
      `/registry/log/proof/inclusion?leaf=${LEAF}&size=07`,
      `/registry/log/proof/inclusion?leaf=${LEAF}&size=-1`,
      `/registry/log/proof/inclusion?leaf=${LEAF}&size=`,
      '/registry/log/proof/inclusion',
      '/registry/log/proof/consistency?from=3',
      '/registry/log/proof/consistency?from=3&to=7&from=4',
      '/registry/log/proof/consistency?from=3&size=7',
      '/registry/log/proof/consistency?from=1e3&to=7',
      '/registry/log/proof/consistency?from=1234567890123456&to=7',
      '/registry/status.json?v=1',
      '/registry/status.json?',
      '/releases/stable/latest.json?cache=0',
      '/registry/log/head.json#x',
    ];
    for (const t of bad) assert.equal(registryTargetAllowed(t), false, t);
  });

  it('목록 밖 경로·다른 origin·정규화 우회·인코딩 변형은 거부', () => {
    const bad = [
      '/releases/nightly/latest.json',
      '/releases/stable/latest.yml',
      '/releases/stable/../beta/latest.json',
      '/releases/stable/%2e%2e/beta/latest.json',
      '/registry/%73tatus.json',
      '/registry//status.json',
      '//evil.example/registry/status.json',
      'https://evil.example/registry/status.json',
      'https://tax.laf-co.com/registry/status.json',
      'registry/status.json',
      '/registry/status.json/',
      '/registry/log/entries/01.json',
      '/registry/log/entries/-1.json',
      '/registry/log/entries/x.json',
      '/registry/index.json',
      '/packages/a@1.sxp',
      // 인덱스는 stable만, .sxp는 id 규칙·x.y.z·확장자 그대로
      '/registry/beta/index.json',
      '/registry/hotfix/index.json',
      '/registry/stable/index.json?x=1',
      '/packages/hometax@2.1.0.sxp',
      '/packages/Hometax.invoice@2.1.0.sxp',
      '/packages/hometax..invoice@2.1.0.sxp',
      '/packages/hometax.invoice.@2.1.0.sxp',
      '/packages/../registry/status.json',
      '/packages/hometax.invoice@2.1.sxp',
      '/packages/hometax.invoice@02.1.0.sxp',
      '/packages/hometax.invoice@2.1.0.sxp.json',
      '/packages/hometax.invoice@2.1.0.zip',
      '/packages/sub/hometax.invoice@2.1.0.sxp',
      '/packages/hometax.invoice%402.1.0.sxp',
      '/v1/decide',
      `/registry/log/proof/inclusion?le%61f=${LEAF}&size=7`,
      `/registry/log/proof/inclusion?leaf=${LEAF}&size=7+`,
      '/registry/status.json\\',
      '',
    ];
    for (const t of bad) assert.equal(registryTargetAllowed(t), false, JSON.stringify(t));
  });
});

describe('Egress.getRegistry(GET만, 고정 origin, 응답 상한, 리다이렉트 거부)', () => {
  let server: Server;
  let base: string;
  const seen: Array<{ method: string; url: string }> = [];
  before(async () => {
    server = createServer((req, res) => {
      seen.push({ method: req.method!, url: req.url! });
      if (req.url === '/registry/status.json') return void res.writeHead(200, { 'content-type': 'application/json' }).end('{"status":"ok"}');
      if (req.url === '/registry/log/head.json') return void res.writeHead(302, { location: 'https://evil.example/head.json' }).end();
      if (req.url === '/registry/revoked_keys.json') return void res.writeHead(200).end('x'.repeat(REGISTRY_MAX_BYTES + 1));
      if (req.url === '/releases/beta/latest.json') return void res.writeHead(200).end('not json');
      res.writeHead(404, { 'content-type': 'application/json' }).end('{"error":"request.not_found"}');
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  after(() => server.close());

  it('허용 경로는 GET으로 보내고 JSON을 그대로 돌려준다. 감사 기록은 경로·상태만', async () => {
    const e = new Egress({ testOrigins: { registry: base }, env: {} });
    assert.deepEqual(await e.getRegistry('/registry/status.json'), { status: 200, json: { status: 'ok' } });
    const r = await e.getRegistry(`/registry/log/proof/inclusion?leaf=${LEAF}&size=3`);
    assert.equal(r.status, 404);
    assert.deepEqual(seen.at(-1), { method: 'GET', url: `/registry/log/proof/inclusion?leaf=${LEAF}&size=3` });
    assert.deepEqual(e.audit, [
      { dest: 'registry', path: '/registry/status.json', status: 200 },
      { dest: 'registry', path: '/registry/log/proof/inclusion', status: 404 },
    ]);
  });

  it('목록 밖 대상은 나가지 않는다(path_not_allowed), TLS 변조 환경이면 egress_env_tampered', async () => {
    const before = seen.length;
    const e = new Egress({ testOrigins: { registry: base }, env: {} });
    await assert.rejects(e.getRegistry('/registry/status.json?x=1'), (err: EgressError) => err.code === 'path_not_allowed');
    await assert.rejects(e.getRegistry('https://evil.example/registry/status.json'), (err: EgressError) => err.code === 'path_not_allowed');
    const t = new Egress({ testOrigins: { registry: base }, env: { NODE_TLS_REJECT_UNAUTHORIZED: '0' } });
    await assert.rejects(t.getRegistry('/registry/status.json'), (err: EgressError) => err.code === 'egress_env_tampered');
    assert.equal(seen.length, before);
  });

  it('리다이렉트는 따라가지 않고, 1 MiB를 넘는 응답·JSON이 아닌 200은 bad_response', async () => {
    const e = new Egress({ testOrigins: { registry: base }, env: {} });
    await assert.rejects(e.getRegistry('/registry/log/head.json'), (err: EgressError) => err.code === 'network');
    await assert.rejects(e.getRegistry('/registry/revoked_keys.json'), (err: EgressError) => err.code === 'bad_response');
    await assert.rejects(e.getRegistry('/releases/beta/latest.json'), (err: EgressError) => err.code === 'bad_response');
  });
});

describe('Egress.getRegistryBytes(엔진 RegistrySync: 바이트 그대로, ETag, .sxp 16MB·문서 1MB 상한)', () => {
  let server: Server;
  let base: string;
  const seen: Array<{ url: string; inm?: string; accept?: string }> = [];
  const SXP = Buffer.from([0x53, 0x58, 0x50, 0x00, 0xff, 0x10]);
  before(async () => {
    server = createServer((req, res) => {
      const inm = req.headers['if-none-match'];
      seen.push({ url: req.url!, ...(typeof inm === 'string' ? { inm } : {}), ...(req.headers.accept ? { accept: req.headers.accept } : {}) });
      if (req.url === '/registry/stable/index.json') {
        if (inm === '"abc"') return void res.writeHead(304, { etag: '"abc"' }).end();
        return void res.writeHead(200, { etag: '"abc"', 'content-type': 'application/json' }).end('{"channel":"stable"}');
      }
      if (req.url === '/packages/hometax.invoice.issue@2.1.0.sxp') return void res.writeHead(200, { etag: 'bad\tetag' }).end(SXP);
      if (req.url === '/packages/big.pkg@1.0.0.sxp') return void res.writeHead(200).end(Buffer.alloc(REGISTRY_MAX_BYTES + 10));
      if (req.url === '/packages/huge.pkg@1.0.0.sxp') return void res.writeHead(200, { 'content-length': String(REGISTRY_PACKAGE_MAX_BYTES + 1) }).end();
      if (req.url === '/registry/revoked_keys.json') return void res.writeHead(200).end('x'.repeat(REGISTRY_MAX_BYTES + 1));
      if (req.url === '/registry/log/head.json') return void res.writeHead(302, { location: 'https://evil.example/head.json' }).end();
      res.writeHead(404).end('{"error":"request.not_found"}');
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  after(() => server.close());

  it('본문을 해석하지 않고 바이트로, ETag는 받아 두고 If-None-Match로 보내면 304(본문 없음)', async () => {
    const e = new Egress({ testOrigins: { registry: base }, env: {} });
    const a = await e.getRegistryBytes('/registry/stable/index.json');
    assert.equal(a.status, 200);
    assert.equal(Buffer.from(a.body!).toString('utf8'), '{"channel":"stable"}');
    assert.equal(a.etag, '"abc"');
    assert.deepEqual(await e.getRegistryBytes('/registry/stable/index.json', { etag: '"abc"' }), { status: 304, etag: '"abc"' });
    assert.equal(seen.at(-1)!.inm, '"abc"');
    const p = await e.getRegistryBytes('/packages/hometax.invoice.issue@2.1.0.sxp');
    assert.deepEqual(Buffer.from(p.body!), SXP);
    assert.equal(p.etag, undefined, '형식이 틀린 ETag는 버린다');
    assert.equal(seen.at(-1)!.accept, 'application/octet-stream');
    assert.deepEqual(await e.getRegistryBytes('/packages/none.pkg@1.0.0.sxp'), { status: 404 }, '200이 아닌 응답은 본문을 버린다');
    assert.deepEqual(e.audit.map((x) => x.status), [200, 304, 200, 404]);
  });

  it('형식이 틀린 ETag(헤더 주입)는 If-None-Match로 보내지 않는다', async () => {
    const e = new Egress({ testOrigins: { registry: base }, env: {} });
    for (const etag of ['abc', '"a\r\nx: y"', `"${'a'.repeat(200)}"`]) {
      await e.getRegistryBytes('/registry/stable/index.json', { etag });
      assert.equal(seen.at(-1)!.inm, undefined, etag);
    }
  });

  it('문서는 1 MiB, .sxp는 16 MiB가 상한(넘으면 bad_response), 목록 밖·리다이렉트는 나가지 않거나 따라가지 않는다', async () => {
    const e = new Egress({ testOrigins: { registry: base }, env: {} });
    await assert.rejects(e.getRegistryBytes('/registry/revoked_keys.json'), (err: EgressError) => err.code === 'bad_response');
    assert.equal((await e.getRegistryBytes('/packages/big.pkg@1.0.0.sxp')).body!.length, REGISTRY_MAX_BYTES + 10, '.sxp는 1 MiB를 넘어도 받는다');
    await assert.rejects(e.getRegistryBytes('/packages/huge.pkg@1.0.0.sxp'), (err: EgressError) => err.code === 'bad_response');
    await assert.rejects(e.getRegistryBytes('/registry/log/head.json'), (err: EgressError) => err.code === 'network');
    const n = seen.length;
    await assert.rejects(e.getRegistryBytes('/packages/../registry/status.json'), (err: EgressError) => err.code === 'path_not_allowed');
    await assert.rejects(e.getRegistryBytes('/registry/beta/index.json'), (err: EgressError) => err.code === 'path_not_allowed');
    const t = new Egress({ testOrigins: { registry: base }, env: { NODE_TLS_REJECT_UNAUTHORIZED: '0' } });
    await assert.rejects(t.getRegistryBytes('/registry/stable/index.json'), (err: EgressError) => err.code === 'egress_env_tampered');
    assert.equal(seen.length, n);
  });
});
