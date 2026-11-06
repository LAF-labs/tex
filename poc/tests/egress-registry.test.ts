// 레지스트리 egress 허용 목록(팀장 결정 2026-11-06, 데스크톱 #126 업데이터 전제, D09 §8·§8.3, ADR-028):
// origin은 tax.laf-co.com 하나, GET 경로는 릴리스 매니페스트·status·폐기 키·투명성 로그 네 개, 쿼리는 leaf·size / from·to만.
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';
import { Egress, EgressError, REGISTRY_CHANNELS, REGISTRY_MAX_BYTES, REGISTRY_ORIGIN, registryTargetAllowed } from '../packages/net/src/index.ts';

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
