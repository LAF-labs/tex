// 레지스트리 HTTP. 공개 GET은 정적 파일(ETag 조건부), 게시 PUT은 운영자 토큰 + 서명 검증 관문.
// 게시 토큰은 호스팅 쓰기 권한일 뿐 서명 권한이 아니다: 2-of-3 서명이 없는 산출물은 토큰이 있어도 올라가지 않는다(ADR-013, D09 §8.2 역할 분리).
import { Router, fail, fromB64, json, safeEqual, sha256hex, type Ctx, type Reply } from '@sax/svc-shared';
import type { Store } from './store.ts';
import {
  CHANNELS,
  renderLatestYml,
  verifyIndex,
  verifyPackageBytes,
  verifyPolicy,
  verifyRelease,
  verifyRevoked,
  verifyStatus,
  type Channel,
  type RegistryIndex,
  type RegistryStatus,
  type ReleaseManifest,
  type RevokedKeys,
  type SignedPolicy,
  type TrustRoot,
} from './verify.ts';

export interface RegistryAppOpts {
  store: Store;
  trust: TrustRoot;
  adminToken: string;
  now: () => number;
  /** 게시 이벤트(카운트만) */
  onEvent?: (e: string) => void;
}

/** 조회 주기 파일(ADR-023): 15분 폴링 + ETag, max-age=60 */
const POLL = 'public, max-age=60';
const IMMUTABLE = 'public, max-age=31536000, immutable';

const PACKAGE_FILE = /^([a-z0-9_.-]{1,64})@(\d+\.\d+\.\d+)\.sxp$/;
const POLICY_FILE = /^(\d{4}\.\d{2}(?:\.\d+)?)\.json$/;

export function registryRouter(o: RegistryAppOpts): Router {
  const r = new Router();
  const { store } = o;

  const readJson = async <T>(key: string): Promise<T | null> => {
    const b = await store.get(key);
    return b ? (JSON.parse(b.toString('utf8')) as T) : null;
  };
  const revokedSet = async (): Promise<Set<string>> => new Set((await readJson<RevokedKeys>('registry/revoked_keys.json'))?.revoked.map((x) => x.keyId) ?? []);
  const admin = (ctx: Ctx) => {
    const m = /^Admin (.+)$/.exec(String(ctx.headers.authorization ?? ''));
    if (!m || !o.adminToken || !safeEqual(m[1]!, o.adminToken)) fail('registry.unauthorized');
  };
  const channelOf = (c: string): Channel => {
    if (!(CHANNELS as readonly string[]).includes(c)) fail('registry.not_found');
    return c as Channel;
  };
  const putJson = (key: string, v: unknown) => store.put(key, Buffer.from(JSON.stringify(v)));

  const serve = async (ctx: Ctx, key: string, cache: string, type: string): Promise<Reply> => {
    const b = await store.get(key);
    if (!b) return json(404, { error: 'registry.not_found' });
    const etag = `"${sha256hex(b).slice(0, 32)}"`;
    const headers = { 'cache-control': cache, etag, 'content-type': type };
    if (ctx.headers['if-none-match'] === etag) return { status: 304, headers, raw: Buffer.alloc(0) };
    return { status: 200, headers, raw: b };
  };

  // ---------- 공개 GET(정적 경로, D09 §8.1) ----------
  r.add('GET', '/registry/:channel/index.json', (ctx) => serve(ctx, `registry/${channelOf(ctx.params.channel!)}/index.json`, POLL, 'application/json'));
  r.add('GET', '/registry/status.json', (ctx) => serve(ctx, 'registry/status.json', POLL, 'application/json'));
  r.add('GET', '/registry/revoked_keys.json', (ctx) => serve(ctx, 'registry/revoked_keys.json', POLL, 'application/json'));
  r.add('GET', '/policy/:file', (ctx) => {
    const f = ctx.params.file!;
    if (f === 'current.json') return serve(ctx, 'policy/current.json', POLL, 'application/json');
    if (!POLICY_FILE.test(f)) fail('registry.not_found');
    return serve(ctx, `policy/${f}`, IMMUTABLE, 'application/json');
  });
  r.add('GET', '/packages/:file', (ctx) => {
    if (!PACKAGE_FILE.test(ctx.params.file!)) fail('registry.not_found');
    return serve(ctx, `packages/${ctx.params.file!}`, IMMUTABLE, 'application/octet-stream');
  });
  r.add('GET', '/releases/:channel/latest.json', (ctx) => serve(ctx, `releases/${channelOf(ctx.params.channel!)}/latest.json`, POLL, 'application/json'));
  r.add('GET', '/releases/:channel/latest.yml', (ctx) => serve(ctx, `releases/${channelOf(ctx.params.channel!)}/latest.yml`, POLL, 'text/yaml; charset=utf-8'));
  r.add('GET', '/healthz', () => json(200, { ok: true }));

  // ---------- 게시(운영자, 서명 검증 관문) ----------
  r.add(
    'PUT',
    '/admin/v1/packages/:file',
    async (ctx) => {
      admin(ctx);
      const f = ctx.params.file!;
      if (!PACKAGE_FILE.test(f)) fail('request.param_rejected');
      const data = fromB64((ctx.body as { data?: unknown } | undefined)?.data);
      if (!data || !data.length) fail('request.param_rejected');
      // 같은 이름은 다시 쓰지 않는다(불변 경로). 다른 바이트로 덮어쓰기 = 공급망 변조
      const cur = await store.get(`packages/${f}`);
      if (cur && !cur.equals(data!)) fail('registry.content_digest_mismatch');
      await store.put(`packages/${f}`, data!);
      o.onEvent?.('package_staged');
      return json(201, { packageDigest: sha256hex(data!), size: data!.length });
    },
    { maxBodyBytes: 24 * 1024 * 1024 },
  );

  r.add(
    'PUT',
    '/admin/v1/index/:channel',
    async (ctx) => {
      admin(ctx);
      const channel = channelOf(ctx.params.channel!);
      const doc = ctx.body as RegistryIndex;
      const key = `registry/${channel}/index.json`;
      verifyIndex(doc, channel, o.trust, await revokedSet(), await readJson<RegistryIndex>(key), o.now());
      // 인덱스가 가리키는 패키지는 먼저 올라와 있어야 하고 바이트가 다이제스트와 같아야 한다
      for (const e of doc.entries) {
        const b = await store.get(`packages/${e.id}@${e.version}.sxp`);
        if (!b) fail('registry.not_found');
        verifyPackageBytes(b!, e);
      }
      await putJson(key, doc);
      o.onEvent?.('index_published');
      return json(200, { monotonic: doc.monotonic });
    },
    { maxBodyBytes: 512 * 1024 },
  );

  r.add('PUT', '/admin/v1/policy', async (ctx) => {
    admin(ctx);
    const doc = ctx.body as SignedPolicy;
    const v = verifyPolicy(doc, o.trust, await revokedSet(), await readJson<SignedPolicy>('policy/current.json'), o.now());
    // {ver}.json과 current.json은 같은 내용(ADR-023). 같은 버전 파일이 이미 있으면 내용이 같을 때만(신선도 재발행)
    const prev = await readJson<SignedPolicy>(`policy/${doc.version}.json`);
    if (prev && prev.monotonic !== doc.monotonic) fail('registry.version_jump_rejected');
    await putJson(`policy/${doc.version}.json`, doc);
    await putJson('policy/current.json', doc);
    o.onEvent?.(v.emergency ? 'policy_emergency' : 'policy_published');
    return json(200, { monotonic: doc.monotonic, emergency: v.emergency });
  });

  r.add('PUT', '/admin/v1/status', async (ctx) => {
    admin(ctx);
    const doc = ctx.body as RegistryStatus;
    const v = verifyStatus(doc, o.trust, await revokedSet(), await readJson<RegistryStatus>('registry/status.json'), o.now());
    await putJson('registry/status.json', doc);
    o.onEvent?.(v.emergency ? 'status_emergency' : 'status_published');
    return json(200, { monotonic: doc.monotonic, emergency: v.emergency });
  });

  r.add('PUT', '/admin/v1/revoked-keys', async (ctx) => {
    admin(ctx);
    const doc = ctx.body as RevokedKeys;
    verifyRevoked(doc, o.trust, await readJson<RevokedKeys>('registry/revoked_keys.json'), o.now());
    await putJson('registry/revoked_keys.json', doc);
    o.onEvent?.('revoked_published');
    return json(200, { monotonic: doc.monotonic });
  });

  r.add('PUT', '/admin/v1/releases/:channel', async (ctx) => {
    admin(ctx);
    const channel = channelOf(ctx.params.channel!);
    const doc = ctx.body as ReleaseManifest;
    verifyRelease(doc, channel, o.trust, await revokedSet(), await readJson<ReleaseManifest>(`releases/${channel}/latest.json`), o.now());
    await putJson(`releases/${channel}/latest.json`, doc);
    await store.put(`releases/${channel}/latest.yml`, Buffer.from(renderLatestYml(doc)));
    o.onEvent?.('release_published');
    return json(200, { version: doc.version });
  });

  return r;
}
