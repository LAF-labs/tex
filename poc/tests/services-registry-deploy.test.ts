// 레지스트리 함수 배포(팀장 결정 2026-11-06): S3 호환 저장소 어댑터(SigV4), 함수 경로 한정·서명 의식 전 503·키 불일치 기동 거부,
// 타임스탬프 cron 자동 재서명(폐기 목록 24시간, status·정책 48시간, 로그 헤드)의 교차 시험(게시 관문 verify·엔진 accept).
// 키는 공개 시험 시드(tests/registry-samples.ts, 실제 키 아님)다. 저장소·CI에 운영 개인 키는 없다.
import assert from 'node:assert/strict';
import http from 'node:http';
import { describe, it } from 'node:test';
import {
  acceptPolicy,
  acceptRevoked,
  acceptStatus,
  type AcceptedPolicy,
  type AcceptedRevoked,
  type AcceptedStatus,
  type Policy,
  type RegistryStatus as EngineStatus,
  type RevokedKeys as EngineRevoked,
} from '@sax/engine/core';
import { Logger, listen } from '../services/shared/src/index.ts';
import {
  HEAD_MAX_AGE_MS,
  MemoryStore,
  RESIGN_TTL,
  S3Store,
  buildRegistryDeploy,
  objectMeta,
  registryCronFunction,
  registryFunction,
  registryFunctionPath,
  sigV4Authorization,
  verifyTreeHead,
  without,
  type Store,
  type TrustRoot,
} from '../services/registry/src/index.ts';
import { SAMPLE_NOW, buildSamples, sampleKeys } from './registry-samples.ts';
import { Clock, H, client } from './services-kit.ts';

const SAMPLES = buildSamples();
const K = sampleKeys();
const sampleDoc = <T>(p: string): T => JSON.parse(SAMPLES.get(p)!.toString('utf8')) as T;
const TRUST = sampleDoc<TrustRoot>('trust.json');
/** 샘플 타임스탬프 역할 키 시드(0x51, registry-samples.ts). 공개 시험 값 */
const TS_SEED = '51'.repeat(32);
const ADMIN = 'a'.repeat(40);
const CRON = 'c'.repeat(40);
const ISSUED = Date.parse('2026-11-05T00:00:00Z');
const FRESH = ['signatures', 'issuedAt', 'expiresAt', 'timestamp'];
const setAt = (c: Clock, t: number) => c.advance(t - c.now());

const env = (o: Record<string, string | undefined> = {}): NodeJS.ProcessEnv => ({
  REGISTRY__TRUST_ROOT_JSON: JSON.stringify(TRUST),
  REGISTRY__REGISTRY_LOG_SIGNING_KEY: TS_SEED,
  REGISTRY__REGISTRY_ADMIN_TOKEN: ADMIN,
  REGISTRY__REGISTRY_STORE: 'memory',
  CRON_SECRET: CRON,
  ...o,
});

async function serve(listener: http.RequestListener) {
  const server = http.createServer(listener);
  const req = client(await listen(server));
  return { req, close: () => server.close() };
}

/** 관문(조립 결과)에 샘플 폐기 목록·정책·status를 게시한다 */
async function deployed(store: Store = new MemoryStore()) {
  const clock = new Clock(SAMPLE_NOW);
  const logs: string[] = [];
  const b = await buildRegistryDeploy(
    { TRUST_ROOT_JSON: JSON.stringify(TRUST), REGISTRY_LOG_SIGNING_KEY: TS_SEED, REGISTRY_ADMIN_TOKEN: ADMIN, REGISTRY_STORE: 'memory' },
    { store, now: clock.now, logger: new Logger('registry', (l) => logs.push(l), clock.now) },
  );
  const s = await serve(b.listener);
  const put = (p: string, body: unknown) => s.req('PUT', p, { headers: { authorization: `Admin ${ADMIN}` }, body });
  return { clock, logs, b, store, ...s, put };
}

async function publishSamples(put: (p: string, body: unknown) => Promise<{ status: number; text: string }>) {
  for (const [p, f] of [
    ['/admin/v1/revoked-keys', 'registry/revoked_keys.json'],
    ['/admin/v1/policy', 'policy/current.json'],
    ['/admin/v1/status', 'registry/status.json'],
  ] as const) {
    const r = await put(p, sampleDoc(f));
    assert.equal(r.status, 200, `${p} ${r.text}`);
  }
}

const read = async <T>(store: Store, key: string): Promise<T> => JSON.parse((await store.get(key))!.toString('utf8')) as T;

describe('S3 호환 저장소 어댑터(SigV4, 공급사 중립: 표준 S3 API만)', () => {
  it('AWS 공개 시험 벡터(GET Object, Range 헤더)와 같은 서명', () => {
    const auth = sigV4Authorization({
      method: 'GET',
      path: '/test.txt',
      headers: { host: 'examplebucket.s3.amazonaws.com', range: 'bytes=0-9', 'x-amz-content-sha256': 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855', 'x-amz-date': '20130524T000000Z' },
      payloadHash: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
      region: 'us-east-1',
      accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
      secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
      amzDate: '20130524T000000Z',
    });
    assert.equal(
      auth,
      'AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41',
    );
  });

  it('경로 방식 URL·서명 헤더·메타데이터(Content-Type·Cache-Control)로 쓰고 읽는다. 404는 null, 그 밖의 실패는 상태 코드만', async () => {
    const objects = new Map<string, { body: Buffer; type: string; cache: string }>();
    const seen: { method: string; url: string; headers: Record<string, string> }[] = [];
    const fetchFn = (async (url: string, init: RequestInit) => {
      const headers = init.headers as Record<string, string>;
      seen.push({ method: init.method!, url, headers });
      assert.equal(init.redirect, 'error');
      const u = new URL(url);
      if (u.pathname.includes('boom')) return new Response('secret detail', { status: 500 });
      if (init.method === 'PUT') {
        objects.set(u.pathname, { body: Buffer.from(init.body as Uint8Array), type: headers['content-type']!, cache: headers['cache-control']! });
        return new Response(null, { status: 200 });
      }
      const o = objects.get(u.pathname);
      return o ? new Response(new Uint8Array(o.body), { status: 200 }) : new Response('<Error/>', { status: 404 });
    }) as unknown as typeof fetch;
    const s = new S3Store({ endpoint: 'https://ref.supabase.co/storage/v1/s3', region: 'ap-northeast-2', bucket: 'sax-registry', accessKeyId: 'ak-test', secretAccessKey: 'sk-test-value', fetchFn, now: () => Date.parse('2026-11-06T01:02:03Z') });
    assert.equal(await s.get('registry/status.json'), null);
    await s.put('registry/status.json', Buffer.from('{"a":1}'));
    await s.put('packages/hometax.invoice.issue@2.1.0.sxp', Buffer.from([1, 2, 3]));
    assert.deepEqual(await s.get('registry/status.json'), Buffer.from('{"a":1}'));
    assert.deepEqual(objects.get('/storage/v1/s3/sax-registry/registry/status.json'), { body: Buffer.from('{"a":1}'), type: 'application/json', cache: 'public, max-age=60' });
    // '@'는 엄격 인코딩
    assert.deepEqual(objects.get('/storage/v1/s3/sax-registry/packages/hometax.invoice.issue%402.1.0.sxp')?.cache, 'public, max-age=31536000, immutable');
    const put = seen.find((x) => x.method === 'PUT')!;
    assert.match(put.headers.authorization!, /^AWS4-HMAC-SHA256 Credential=ak-test\/20261106\/ap-northeast-2\/s3\/aws4_request, SignedHeaders=cache-control;content-type;host;x-amz-content-sha256;x-amz-date, Signature=[0-9a-f]{64}$/);
    assert.equal(put.headers['x-amz-date'], '20261106T010203Z');
    assert.equal(put.headers.host, undefined);
    for (const x of seen) assert.ok(!JSON.stringify(x).includes('sk-test-value'), '비밀 키는 요청에 나가지 않는다');
    await assert.rejects(s.get('registry/boom.json'), /^Error: store_s3_get_500$/);
    await assert.rejects(s.put('registry/boom.json', Buffer.from('x')), /^Error: store_s3_put_500$/);
    // 키 형식 밖(경로 탈출)은 보내기 전에 거부
    const before = seen.length;
    await assert.rejects(s.get('../x'));
    assert.equal(seen.length, before);
  });

  it('구성 확인: https만(시험 localhost만 http), 지역·버킷 형식, 접근 키 필수', () => {
    const base = { region: 'ap-northeast-2', bucket: 'sax-registry', accessKeyId: 'a', secretAccessKey: 'b' };
    assert.throws(() => new S3Store({ ...base, endpoint: 'http://ref.supabase.co/storage/v1/s3' }), /config_S3_ENDPOINT/);
    assert.throws(() => new S3Store({ ...base, endpoint: 'https://u:p@ref.supabase.co/s3' }), /config_S3_ENDPOINT/);
    assert.throws(() => new S3Store({ ...base, endpoint: 'not a url' }), /config_S3_ENDPOINT/);
    assert.throws(() => new S3Store({ ...base, endpoint: 'https://x.test', bucket: 'A_B' }), /config_S3_BUCKET/);
    assert.throws(() => new S3Store({ ...base, endpoint: 'https://x.test', region: '' }), /config_S3_REGION/);
    assert.throws(() => new S3Store({ ...base, endpoint: 'https://x.test', secretAccessKey: '' }), /config_S3_ACCESS_KEY/);
    assert.ok(new S3Store({ ...base, endpoint: 'http://127.0.0.1:9000' }));
    assert.deepEqual(objectMeta('releases/stable.yml'), { contentType: 'text/yaml; charset=utf-8', cacheControl: 'public, max-age=60' });
  });
});

describe('레지스트리 함수(api/registry·api/registry-cron)', () => {
  it('함수 경로는 로그 GET과 게시 PUT뿐이다(공개 정적 GET은 버킷 재작성)', () => {
    assert.ok(registryFunctionPath('GET', '/registry/log/head.json'));
    assert.ok(registryFunctionPath('PUT', '/admin/v1/status'));
    for (const [m, p] of [['GET', '/registry/status.json'], ['GET', '/admin/v1/status'], ['PUT', '/registry/log/head.json'], ['POST', '/admin/v1/status'], ['GET', '/policy/current.json']]) assert.equal(registryFunctionPath(m!, p!), false, `${m} ${p}`);
  });

  it('서명 의식 전(TRUST_ROOT_JSON 없음)이면 503 registry.unavailable, 함수 밖 경로는 404', async () => {
    const f = await serve(registryFunction(env({ REGISTRY__TRUST_ROOT_JSON: undefined })));
    const head = await f.req('GET', '/api/registry?__p=/registry/log/head.json');
    assert.equal(head.status, 503);
    assert.deepEqual(head.json, { error: 'registry.unavailable' });
    assert.equal((await f.req('PUT', '/api/registry?__p=/admin/v1/status', { headers: { authorization: `Admin ${ADMIN}` }, body: {} })).status, 503);
    assert.equal((await f.req('GET', '/api/registry?__p=/registry/status.json')).status, 404);
    assert.equal((await f.req('GET', '/api/registry')).status, 404);
    f.close();
  });

  it('타임스탬프 키 공개키가 TRUST_ROOT_JSON.keys.timestamp와 다르면(다른 역할 키여도) 기동 거부 → 503, 로그에는 설정 이름만', async () => {
    for (const seed of ['52'.repeat(32), 'zz']) {
      const logs: string[] = [];
      const f = await serve(registryFunction(env({ REGISTRY__REGISTRY_LOG_SIGNING_KEY: seed }), { logger: new Logger('registry', (l) => logs.push(l)) }));
      assert.equal((await f.req('GET', '/api/registry?__p=/registry/log/head.json')).status, 503);
      f.close();
      assert.ok(logs.some((l) => l.includes('registry.start_failed.config_REGISTRY_LOG_SIGNING_KEY')), logs.join('\n'));
      assert.ok(!logs.join('\n').includes(seed), '시드는 로그에 없다');
    }
    // 루트 키 시드(다른 역할)를 타임스탬프 키로 쓰면 거부
    const rootSeed = Buffer.from(K.root[0]!.priv.export({ format: 'der', type: 'pkcs8' })).subarray(-32).toString('hex');
    await assert.rejects(buildRegistryDeploy({ TRUST_ROOT_JSON: JSON.stringify(TRUST), REGISTRY_LOG_SIGNING_KEY: rootSeed, REGISTRY_ADMIN_TOKEN: ADMIN, REGISTRY_STORE: 'memory' }), /config_REGISTRY_LOG_SIGNING_KEY/);
    // 관리 토큰 32자 미만·저장소 없음도 기동 거부
    await assert.rejects(buildRegistryDeploy({ TRUST_ROOT_JSON: JSON.stringify(TRUST), REGISTRY_LOG_SIGNING_KEY: TS_SEED, REGISTRY_ADMIN_TOKEN: 'short', REGISTRY_STORE: 'memory' }), /config_REGISTRY_ADMIN_TOKEN/);
    await assert.rejects(buildRegistryDeploy({ TRUST_ROOT_JSON: JSON.stringify(TRUST), REGISTRY_LOG_SIGNING_KEY: TS_SEED, REGISTRY_ADMIN_TOKEN: ADMIN }), /config_S3_ENDPOINT/);
  });

  it('구성이 맞으면 로그 헤드 GET·게시 PUT이 레지스트리 라우터로 간다(REGISTRY__ 접두 env)', async () => {
    const f = await serve(registryFunction(env(), { now: () => SAMPLE_NOW }));
    const head = await f.req('GET', '/api/registry?__p=/registry/log/head.json');
    assert.equal(head.status, 200, head.text);
    assert.ok(verifyTreeHead(TRUST.keys.timestamp![K.ts.keyId]!, head.json));
    assert.equal((await f.req('PUT', '/api/registry?__p=/admin/v1/revoked-keys', { body: sampleDoc('registry/revoked_keys.json') })).status, 401);
    const ok = await f.req('PUT', '/api/registry?__p=/admin/v1/revoked-keys', { headers: { authorization: `Admin ${ADMIN}` }, body: sampleDoc('registry/revoked_keys.json') });
    assert.equal(ok.status, 200, ok.text);
    f.close();
  });

  it('재서명 cron: GET + Bearer CRON_SECRET(32자 이상)만, 의식 전 503, 구성되면 대상별 결과', async () => {
    const off = await serve(registryCronFunction(env({ REGISTRY__TRUST_ROOT_JSON: undefined })));
    assert.equal((await off.req('GET', '/api/registry-cron')).status, 401);
    assert.equal((await off.req('GET', '/api/registry-cron', { headers: { authorization: `Bearer ${CRON}` } })).status, 503);
    off.close();
    const weak = await serve(registryCronFunction(env({ CRON_SECRET: 'short' })));
    assert.equal((await weak.req('GET', '/api/registry-cron', { headers: { authorization: 'Bearer short' } })).status, 401);
    weak.close();
    const on = await serve(registryCronFunction(env()));
    assert.equal((await on.req('POST', '/api/registry-cron', { headers: { authorization: `Bearer ${CRON}` } })).status, 401);
    const r = await on.req('GET', '/api/registry-cron', { headers: { authorization: `Bearer ${CRON}` } });
    assert.equal(r.status, 200);
    // 빈 로그의 첫 헤드도 서명한다
    assert.deepEqual(r.json, { ok: true, revoked_keys: 'missing', status: 'missing', policy: 'missing', head: 'resigned' });
    on.close();
  });
});

describe('타임스탬프 자동 재서명(폐기 목록 24시간, status·정책 48시간, 로그 헤드)', () => {
  it('유효 기간이 절반 넘게 남으면 건너뛰고, 절반 아래면 신선도 필드만 새로 서명한다. 내용 서명·내용은 그대로', async () => {
    const e = await deployed();
    await publishSamples(e.put);
    const orig = { rv: await read<EngineRevoked>(e.store, 'registry/revoked_keys.json'), st: await read<EngineStatus>(e.store, 'registry/status.json'), pol: await read<Policy>(e.store, 'policy/current.json') };
    assert.deepEqual(await e.b.resign(), { revoked_keys: 'fresh', status: 'fresh', policy: 'fresh', head: 'fresh' });

    // 발행 13시간 뒤: 폐기 목록만 남은 기간 < 12시간
    setAt(e.clock, ISSUED + 13 * H);
    // 헤드는 재서명 게시의 로그 항목이 이미 새로 서명했다
    assert.deepEqual(await e.b.resign(), { revoked_keys: 'resigned', status: 'fresh', policy: 'fresh', head: 'fresh' });
    const rv = await read<EngineRevoked>(e.store, 'registry/revoked_keys.json');
    assert.deepEqual(without(rv, FRESH), without(orig.rv, FRESH));
    assert.deepEqual(rv.signatures, orig.rv.signatures);
    assert.equal(rv.issuedAt, '2026-11-05T13:00:00Z');
    assert.equal(Date.parse(rv.expiresAt) - Date.parse(rv.issuedAt), RESIGN_TTL.revoked_keys);
    assert.equal(rv.timestamp.keyId, K.ts.keyId);
    assert.notEqual(rv.timestamp.sig, orig.rv.timestamp.sig);

    // 발행 26시간 뒤: 셋 다
    setAt(e.clock, ISSUED + 26 * H);
    assert.deepEqual(await e.b.resign(), { revoked_keys: 'resigned', status: 'resigned', policy: 'resigned', head: 'fresh' });
    const st = await read<EngineStatus>(e.store, 'registry/status.json');
    const pol = await read<Policy>(e.store, 'policy/current.json');
    assert.deepEqual(without(st, FRESH), without(orig.st, FRESH));
    assert.deepEqual(without(pol, FRESH), without(orig.pol, FRESH));
    assert.equal(Date.parse(st.expiresAt) - Date.parse(st.issuedAt), RESIGN_TTL.status);
    assert.equal(Date.parse(pol.expiresAt) - Date.parse(pol.issuedAt), RESIGN_TTL.policy);
    // 정책 {ver}.json과 current.json은 같은 바이트
    assert.deepEqual(await e.store.get(`policy/${pol.version}.json`), await e.store.get('policy/current.json'));
    // 바로 다시 돌리면 할 일 없음
    assert.deepEqual(await e.b.resign(), { revoked_keys: 'fresh', status: 'fresh', policy: 'fresh', head: 'fresh' });
    e.close();
    e.b.close();
  });

  it('교차: 재서명본을 엔진이 받고(직전 수용본 대비 같은 monotonic·같은 내용), 원본을 가진 다른 관문도 PUT으로 받는다', async () => {
    const e = await deployed();
    await publishSamples(e.put);
    const roots = K.roots;
    const rv0 = acceptRevoked(sampleDoc('registry/revoked_keys.json'), { roots, current: null, now: SAMPLE_NOW });
    assert.ok(rv0.ok);
    const pol0 = acceptPolicy(sampleDoc('policy/current.json'), { roots, revoked: rv0.accepted.keyIds, current: null, hold: false, now: SAMPLE_NOW });
    assert.ok(pol0.ok);
    const st0 = acceptStatus(sampleDoc('registry/status.json'), { roots, revoked: rv0.accepted.keyIds, current: null, now: SAMPLE_NOW });
    assert.ok(st0.ok);

    const at = ISSUED + 26 * H;
    setAt(e.clock, at);
    await e.b.resign();
    const rv = await read<EngineRevoked>(e.store, 'registry/revoked_keys.json');
    const pol = await read<Policy>(e.store, 'policy/current.json');
    const st = await read<EngineStatus>(e.store, 'registry/status.json');
    // 원본은 이 시각에 만료(폐기 목록 24시간)이거나 곧 만료이고, 재서명본은 받는다
    assert.equal(acceptRevoked(sampleDoc('registry/revoked_keys.json'), { roots, current: rv0.accepted as AcceptedRevoked, now: at }).ok, false);
    const rv1 = acceptRevoked(rv, { roots, current: rv0.accepted as AcceptedRevoked, now: at });
    assert.ok(rv1.ok, rv1.ok ? '' : rv1.code);
    const pol1 = acceptPolicy(pol, { roots, revoked: rv1.accepted.keyIds, current: pol0.accepted as AcceptedPolicy, hold: true, now: at });
    assert.ok(pol1.ok, pol1.ok ? '' : pol1.code);
    const st1 = acceptStatus(st, { roots, revoked: rv1.accepted.keyIds, current: st0.accepted as AcceptedStatus, hold: true, now: at });
    assert.ok(st1.ok, st1.ok ? '' : st1.code);
    // 처음 설치하는 엔진도 받는다
    assert.ok(acceptStatus(st, { roots, revoked: rv1.accepted.keyIds, current: null, now: at }).ok);

    // 원본을 가진 다른 관문(같은 시각)이 재서명본을 받는다(verifyRevoked·verifyPolicy·verifyStatus 재발행 규칙)
    const g = await deployed();
    await publishSamples(g.put);
    setAt(g.clock, at);
    for (const [p, doc] of [['/admin/v1/revoked-keys', rv], ['/admin/v1/policy', pol], ['/admin/v1/status', st]] as const) {
      const r = await g.put(p, doc);
      assert.equal(r.status, 200, `${p} ${r.text}`);
    }
    e.close();
    e.b.close();
    g.close();
    g.b.close();
  });

  it('긴급 키로 서명된 status도 같은 내용이면 재서명한다(보수성 검사 대상 아님)', async () => {
    const e = await deployed();
    await publishSamples(e.put);
    assert.equal((await e.put('/admin/v1/status', sampleDoc('registry/status-emergency.json'))).status, 200);
    setAt(e.clock, ISSUED + 26 * H);
    assert.equal((await e.b.resign()).status, 'resigned');
    const st = await read<EngineStatus>(e.store, 'registry/status.json');
    assert.equal(st.monotonic, 11);
    assert.deepEqual(without(st, FRESH), without(sampleDoc('registry/status-emergency.json'), FRESH));
    e.close();
    e.b.close();
  });

  it('로그: 재서명 게시마다 항목(새 바이트의 다이제스트)이 공개 전에 남고, 헤드는 핀 고정 타임스탬프 키로 검증된다', async () => {
    const e = await deployed();
    await publishSamples(e.put);
    const h0 = await e.b.log.head();
    setAt(e.clock, ISSUED + 26 * H);
    await e.b.resign();
    const h1 = await e.b.log.head();
    // 폐기 목록 1 + status 1 + 정책 2({ver}·current)
    assert.equal(h1.treeSize, h0.treeSize + 4);
    assert.ok(verifyTreeHead(TRUST.keys.timestamp![K.ts.keyId]!, h1));
    assert.equal(h1.timestamp, ISSUED + 26 * H);
    const last = (await e.b.log.entry(h1.treeSize - 1))!;
    assert.equal(last.entry.path, 'policy/current.json');
    const { createHash } = await import('node:crypto');
    assert.equal(last.entry.sha256, createHash('sha256').update((await e.store.get('policy/current.json'))!).digest('hex'));
    // 항목이 늘지 않아도 헤드가 오래되면(30분) 같은 트리에 다시 서명한다
    e.clock.advance(HEAD_MAX_AGE_MS + 1);
    assert.equal((await e.b.resign()).head, 'resigned');
    const h2 = await e.b.log.head();
    assert.equal(h2.treeSize, h1.treeSize);
    assert.equal(h2.rootHash, h1.rootHash);
    assert.ok(verifyTreeHead(TRUST.keys.timestamp![K.ts.keyId]!, h2));
    e.close();
    e.b.close();
  });

  it('내용이 바뀌는 서명은 하지 않는다: 변조된 저장본·{ver} 불일치는 거부하고 저장본을 그대로 둔다', async () => {
    const e = await deployed();
    await publishSamples(e.put);
    // status 내용을 서명 없이 바꾼다(저장소 변조)
    const st = await read<EngineStatus>(e.store, 'registry/status.json');
    const tampered = Buffer.from(JSON.stringify({ ...st, portalModeCeiling: { hometax: 'auto', etax: 'auto' } }));
    await e.store.put('registry/status.json', tampered);
    // 정책 {ver}.json만 다른 monotonic
    const pol = await read<Policy & { monotonic: number }>(e.store, 'policy/current.json');
    const verKey = `policy/${pol.version}.json`;
    const verBytes = Buffer.from(JSON.stringify({ ...pol, monotonic: pol.monotonic - 1 }));
    await e.store.put(verKey, verBytes);
    setAt(e.clock, ISSUED + 26 * H);
    const r = await e.b.resign();
    assert.match(r.status, /^rejected:/);
    assert.equal(r.policy, 'rejected:registry.version_rollback');
    assert.equal(r.revoked_keys, 'resigned');
    assert.deepEqual(await e.store.get('registry/status.json'), tampered);
    assert.deepEqual(await e.store.get(verKey), verBytes);
    assert.ok(e.logs.some((l) => l.includes('registry.resign_rejected')));
    e.close();
    e.b.close();
  });

  it('로그를 쓴 사이 운영자 게시가 끼면(저장본이 바뀌면) 덮어쓰지 않고 이번 회차를 건너뛴다', async () => {
    const inner = new MemoryStore();
    let swap: Buffer | null = null;
    let reads = 0;
    const store: Store = {
      get: async (k) => {
        if (k === 'registry/revoked_keys.json' && swap && ++reads === 2) await inner.put(k, swap);
        return inner.get(k);
      },
      put: (k, b) => inner.put(k, b),
    };
    const e = await deployed(store);
    await publishSamples(e.put);
    swap = Buffer.from('{"operator":"published"}');
    setAt(e.clock, ISSUED + 13 * H);
    assert.equal((await e.b.resign()).revoked_keys, 'changed');
    assert.deepEqual(await inner.get('registry/revoked_keys.json'), swap);
    e.close();
    e.b.close();
  });
});
