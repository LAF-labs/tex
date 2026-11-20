import type { KeyObject } from 'node:crypto';
import { canonicalizable } from '@sax/engine/core';
import { Router, fail, fromB64, json, safeEqual, sha256hex, type Ctx, type Reply } from '@sax/svc-shared';
import type { LogKind, TransparencyLog } from './log.ts';
import { RESIGN_TTL, restamp, restampRelease } from './resign.ts';
import type { Store } from './store.ts';
import {
  CHANNELS,
  contentDigest,
  renderLatestYml,
  verifyIndex,
  verifyPackageBytes,
  verifyPolicy,
  verifyRelease,
  verifyRevoked,
  verifySxp,
  verifyStatus,
  type Channel,
  type RegistryIndex,
  type RegistryStatus,
  type ReleaseManifest,
  type RevokedKeys,
  type SignedPolicy,
  type TrustRoot,
  type Verdict,
} from './verify.ts';

export interface RegistryAppOpts {
  store: Store;
  trust: TrustRoot;
  adminToken: string;
  now: () => number;
  onEvent?: (e: string) => void;
  log?: TransparencyLog;
  stamper?: { keyId: string; key: KeyObject };
}

const POLL = 'public, max-age=60';
const IMMUTABLE = 'public, max-age=31536000, immutable';

const PACKAGE_FILE = /^([a-z0-9]+(?:\.[a-z0-9_-]+)+)@(\d+\.\d+\.\d+)\.sxp$/;
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
  const publish = async (kind: LogKind, key: string, bytes: Buffer) => {
    if (o.log) await o.log.append({ kind, path: key, sha256: sha256hex(bytes) });
    await store.put(key, bytes);
  };
  const putJson = (kind: LogKind, key: string, v: unknown) => publish(kind, key, Buffer.from(JSON.stringify(v)));
  const checked = <T>(fn: (v: Verdict) => T): T => {
    const v: Verdict = { events: [] };
    try {
      return fn(v);
    } finally {
      for (const e of v.events) o.onEvent?.(e);
    }
  };
  const stamped = <T extends { monotonic: number; issuedAt: string; expiresAt: string; timestamp: unknown }>(doc: T, ttl: number): T => {
    if (!doc || typeof doc !== 'object' || Array.isArray(doc)) fail('registry.schema_invalid');
    if (doc.timestamp !== undefined || !o.stamper) return doc;
    if (!Number.isSafeInteger(doc.monotonic) || !canonicalizable(doc)) fail('registry.schema_invalid');
    o.onEvent?.('registry.stamped_on_publish');
    return restamp(doc, ttl, o.now(), o.stamper);
  };
  let chain: Promise<unknown> = Promise.resolve();
  const serial = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = chain.then(fn, fn);
    chain = run.catch(() => undefined);
    return run;
  };

  const serve = async (ctx: Ctx, key: string, cache: string, type: string): Promise<Reply> => {
    const b = await store.get(key);
    if (!b) return json(404, { error: 'registry.not_found' });
    const etag = `"${sha256hex(b).slice(0, 32)}"`;
    const headers = { 'cache-control': cache, etag, 'content-type': type };
    if (ctx.headers['if-none-match'] === etag) return { status: 304, headers, raw: Buffer.alloc(0) };
    return { status: 200, headers, raw: b };
  };

  r.add('GET', '/registry/:channel/index.json', (ctx) => serve(ctx, `registry/${channelOf(ctx.params.channel!)}/index.json`, POLL, 'application/json'));
  r.add('GET', '/registry/status.json', (ctx) => serve(ctx, 'registry/status.json', POLL, 'application/json'));
  r.add('GET', '/registry/revoked_keys.json', (ctx) => serve(ctx, 'registry/revoked_keys.json', POLL, 'application/json'));
  r.add('GET', '/policy/:file', (ctx) => {
    const f = ctx.params.file!;
    if (f === 'current.json') return serve(ctx, 'policy/current.json', POLL, 'application/json');
    if (!POLICY_FILE.test(f)) fail('registry.not_found');
    return serve(ctx, `policy/${f}`, POLL, 'application/json');
  });
  r.add('GET', '/packages/:file', (ctx) => {
    if (!PACKAGE_FILE.test(ctx.params.file!)) fail('registry.not_found');
    return serve(ctx, `packages/${ctx.params.file!}`, IMMUTABLE, 'application/octet-stream');
  });
  r.add('GET', '/releases/:channel/latest.json', (ctx) => serve(ctx, `releases/${channelOf(ctx.params.channel!)}/latest.json`, POLL, 'application/json'));
  r.add('GET', '/releases/:channel/latest.yml', (ctx) => serve(ctx, `releases/${channelOf(ctx.params.channel!)}/latest.yml`, POLL, 'text/yaml; charset=utf-8'));
  r.add('GET', '/download/mac', async () => {
    const url = (await readJson<ReleaseManifest>('releases/beta/latest.json'))?.files[0]?.url ?? '';
    if (!/^https:\/\/[^/]+\/.+\.zip$/.test(url)) fail('registry.not_found');
    return { status: 302, headers: { location: url.replace(/\.zip$/, '.dmg'), 'cache-control': POLL }, raw: Buffer.alloc(0) };
  });
  r.add('GET', '/healthz', () => json(200, { ok: true }));

  const DEC = /^(0|[1-9][0-9]{0,14})$/;
  const query = (ctx: Ctx, want: Record<string, RegExp>): Record<string, string> => {
    const keys = [...ctx.query.keys()];
    const names = Object.keys(want);
    if (keys.length !== names.length || new Set(keys).size !== keys.length) fail('request.param_rejected');
    const out: Record<string, string> = {};
    for (const k of names) {
      const v = ctx.query.get(k);
      if (v === null || !want[k]!.test(v)) fail('request.param_rejected');
      out[k] = v!;
    }
    return out;
  };
  const logOf = (): TransparencyLog => o.log ?? fail('registry.not_found');
  const LOG_CACHE = 'public, max-age=60';
  const noQuery = (ctx: Ctx) => query(ctx, {});
  r.add('GET', '/registry/log/head.json', async (ctx) => {
    noQuery(ctx);
    return { status: 200, headers: { 'cache-control': LOG_CACHE }, body: await logOf().head() };
  });
  r.add('GET', '/registry/log/entries/:file', async (ctx) => {
    noQuery(ctx);
    const m = /^(0|[1-9][0-9]{0,14})\.json$/.exec(ctx.params.file!);
    if (!m) fail('registry.not_found');
    const e = await logOf().entry(Number(m![1]));
    if (!e) fail('registry.not_found');
    return { status: 200, headers: { 'cache-control': IMMUTABLE }, body: e };
  });
  r.add('GET', '/registry/log/proof/inclusion', async (ctx) => {
    const q = query(ctx, { leaf: /^[0-9a-f]{64}$/, size: DEC });
    const p = await logOf().inclusion(q.leaf!, Number(q.size));
    if (!p) fail('registry.not_found');
    return { status: 200, headers: { 'cache-control': IMMUTABLE }, body: p };
  });
  r.add('GET', '/registry/log/proof/consistency', async (ctx) => {
    const q = query(ctx, { from: DEC, to: DEC });
    const p = await logOf().consistency(Number(q.from), Number(q.to));
    if (!p) fail('registry.not_found');
    return { status: 200, headers: { 'cache-control': IMMUTABLE }, body: p };
  });

  r.add(
    'PUT',
    '/admin/v1/packages/:file',
    async (ctx) => {
      admin(ctx);
      return serial(async () => {
        const f = ctx.params.file!;
        const m = PACKAGE_FILE.exec(f);
        if (!m) fail('request.param_rejected');
        const data = fromB64((ctx.body as { data?: unknown } | undefined)?.data);
        if (!data || !data.length) fail('request.param_rejected');
        const cur = await store.get(`packages/${f}`);
        if (cur && !cur.equals(data!)) fail('registry.content_digest_mismatch');
        const revoked = await revokedSet();
        const info = checked((v) => verifySxp(data!, { id: m![1]!, version: m![2]! }, o.trust, revoked, o.now(), v));
        if (!cur) await publish('package', `packages/${f}`, data!);
        o.onEvent?.('package_staged');
        return json(201, { sxpDigest: sha256hex(data!), size: data!.length, kind: info.kind });
      });
    },
    { maxBodyBytes: 24 * 1024 * 1024 },
  );

  r.add(
    'PUT',
    '/admin/v1/index/:channel',
    async (ctx) => {
      admin(ctx);
      return serial(async () => {
        const channel = channelOf(ctx.params.channel!);
        const doc = stamped(ctx.body as RegistryIndex, RESIGN_TTL.index);
        const key = `registry/${channel}/index.json`;
        const revoked = await revokedSet();
        const stored = await readJson<RegistryIndex>(key);
        checked((v) => verifyIndex(doc, channel, o.trust, revoked, stored, o.now(), v));
        for (const e of doc.entries) {
          const b = await store.get(`packages/${e.id}@${e.version}.sxp`);
          if (!b) fail('registry.not_found');
          verifyPackageBytes(b!, e);
          const info = checked((v) => verifySxp(b!, e, o.trust, revoked, o.now(), v));
          if (info.kind !== e.kind || (e.portal !== undefined && e.portal !== info.portal)) fail('registry.schema_invalid');
        }
        await putJson('index', key, doc);
        o.onEvent?.('index_published');
        return json(200, { monotonic: doc.monotonic });
      });
    },
    { maxBodyBytes: 512 * 1024 },
  );

  r.add('PUT', '/admin/v1/policy', async (ctx) => {
    admin(ctx);
    return serial(async () => {
      const doc = stamped(ctx.body as SignedPolicy, RESIGN_TTL.policy);
      const [revoked, stored] = [await revokedSet(), await readJson<SignedPolicy>('policy/current.json')];
      const v = checked((x) => verifyPolicy(doc, o.trust, revoked, stored, o.now(), x));
      const prev = await readJson<SignedPolicy>(`policy/${doc.version}.json`);
      if (prev && (prev.monotonic !== doc.monotonic || contentDigest(prev) !== contentDigest(doc))) fail('registry.version_rollback');
      await putJson('policy', `policy/${doc.version}.json`, doc);
      await putJson('policy', 'policy/current.json', doc);
      o.onEvent?.(v.emergency ? 'policy_emergency' : 'policy_published');
      return json(200, { monotonic: doc.monotonic, emergency: v.emergency });
    });
  });

  r.add('PUT', '/admin/v1/status', async (ctx) => {
    admin(ctx);
    return serial(async () => {
      const doc = stamped(ctx.body as RegistryStatus, RESIGN_TTL.status);
      const [revoked, stored] = [await revokedSet(), await readJson<RegistryStatus>('registry/status.json')];
      const v = checked((x) => verifyStatus(doc, o.trust, revoked, stored, o.now(), x));
      await putJson('status', 'registry/status.json', doc);
      o.onEvent?.(v.emergency ? 'status_emergency' : 'status_published');
      return json(200, { monotonic: doc.monotonic, emergency: v.emergency });
    });
  });

  r.add('PUT', '/admin/v1/revoked-keys', async (ctx) => {
    admin(ctx);
    return serial(async () => {
      const doc = stamped(ctx.body as RevokedKeys, RESIGN_TTL.revoked_keys);
      const stored = await readJson<RevokedKeys>('registry/revoked_keys.json');
      checked((v) => verifyRevoked(doc, o.trust, stored, o.now(), v));
      await putJson('revoked_keys', 'registry/revoked_keys.json', doc);
      o.onEvent?.('revoked_published');
      return json(200, { monotonic: doc.monotonic });
    });
  });

  r.add('PUT', '/admin/v1/releases/:channel', async (ctx) => {
    admin(ctx);
    return serial(async () => {
      const channel = channelOf(ctx.params.channel!);
      const body = ctx.body as ReleaseManifest;
      if (!body || typeof body !== 'object' || Array.isArray(body)) fail('registry.schema_invalid');
      const stamp = body.timestamp === undefined && o.stamper !== undefined && canonicalizable(body);
      if (stamp) o.onEvent?.('registry.stamped_on_publish');
      const doc = stamp ? restampRelease(body, RESIGN_TTL.release, o.now(), o.stamper!) : body;
      const [revoked, stored] = [await revokedSet(), await readJson<ReleaseManifest>(`releases/${channel}/latest.json`)];
      checked((v) => verifyRelease(doc, channel, o.trust, revoked, stored, o.now(), v));
      await publish('release', `releases/${channel}/latest.yml`, Buffer.from(renderLatestYml(doc)));
      await putJson('release', `releases/${channel}/latest.json`, doc);
      o.onEvent?.('release_published');
      return json(200, { version: doc.version });
    });
  });

  return r;
}
