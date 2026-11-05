// 레지스트리 HTTP. 공개 GET은 정적 파일(ETag 조건부), 게시 PUT은 운영자 토큰 + 서명 검증 관문(규칙 정본: design/schemas/SIGNING.md, 엔진 로더).
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
  /** 게시 이벤트(카운트만) */
  onEvent?: (e: string) => void;
}

/** 조회 주기 파일(ADR-023): 15분 폴링 + ETag, max-age=60 */
const POLL = 'public, max-age=60';
const IMMUTABLE = 'public, max-age=31536000, immutable';

/** {id}@{version}.sxp. id는 manifest 패턴(점 필수, 핫픽스는 <appliesTo.id>.hotfix) */
const PACKAGE_FILE = /^([a-z0-9]+(?:\.[a-z0-9_]+)+)@(\d+\.\d+\.\d+)\.sxp$/;
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
  /** 검증을 돌리고, 통과하든 거부되든 그동안 생긴 이벤트(registry.key_revoked 등)를 남긴다 */
  const checked = <T>(fn: (v: Verdict) => T): T => {
    const v: Verdict = { events: [] };
    try {
      return fn(v);
    } finally {
      for (const e of v.events) o.onEvent?.(e);
    }
  };
  // 게시는 인스턴스 안에서 하나씩(읽기 → 검증 → 쓰기 사이에 다른 게시가 끼어 단조 값·덮어쓰기 검사를 비켜 가지 않게)
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

  // ---------- 공개 GET(정적 경로, D09 §8.1) ----------
  r.add('GET', '/registry/:channel/index.json', (ctx) => serve(ctx, `registry/${channelOf(ctx.params.channel!)}/index.json`, POLL, 'application/json'));
  r.add('GET', '/registry/status.json', (ctx) => serve(ctx, 'registry/status.json', POLL, 'application/json'));
  r.add('GET', '/registry/revoked_keys.json', (ctx) => serve(ctx, 'registry/revoked_keys.json', POLL, 'application/json'));
  r.add('GET', '/policy/:file', (ctx) => {
    const f = ctx.params.file!;
    if (f === 'current.json') return serve(ctx, 'policy/current.json', POLL, 'application/json');
    if (!POLICY_FILE.test(f)) fail('registry.not_found');
    // {ver}.json도 신선도 재발행(같은 내용, 새 issuedAt·서명)으로 바뀌므로 불변 캐시가 아니다
    return serve(ctx, `policy/${f}`, POLL, 'application/json');
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
      return serial(async () => {
        const f = ctx.params.file!;
        const m = PACKAGE_FILE.exec(f);
        if (!m) fail('request.param_rejected');
        const data = fromB64((ctx.body as { data?: unknown } | undefined)?.data);
        if (!data || !data.length) fail('request.param_rejected');
        // 같은 이름은 다시 쓰지 않는다(불변 경로). 다른 바이트로 덮어쓰기 = 공급망 변조
        const cur = await store.get(`packages/${f}`);
        if (cur && !cur.equals(data!)) fail('registry.content_digest_mismatch');
        // .sxp 안의 manifest·hotfix 서명(패키지 키 2-of-3)·스키마·내용 다이제스트까지 본다(엔진이 받지 않을 패키지는 올리지 않는다)
        const revoked = await revokedSet();
        const info = checked((v) => verifySxp(data!, { id: m![1]!, version: m![2]! }, o.trust, revoked, o.now(), v));
        await store.put(`packages/${f}`, data!);
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
        const doc = ctx.body as RegistryIndex;
        const key = `registry/${channel}/index.json`;
        const revoked = await revokedSet();
        const stored = await readJson<RegistryIndex>(key);
        checked((v) => verifyIndex(doc, channel, o.trust, revoked, stored, o.now(), v));
        // 인덱스가 가리키는 패키지는 먼저 올라와 있어야 하고, 바이트가 sxpDigest·size와 같고, 안의 서명·종류·포털이 항목과 맞아야 한다
        for (const e of doc.entries) {
          const b = await store.get(`packages/${e.id}@${e.version}.sxp`);
          if (!b) fail('registry.not_found');
          verifyPackageBytes(b!, e);
          if (e.kind === 'data') continue; // 데이터 패키지 컨테이너는 SIGNING.md 범위 밖(올리는 단계에서 이미 거부된다)
          const info = checked((v) => verifySxp(b!, e, o.trust, revoked, o.now(), v));
          if (info.kind !== e.kind || (e.portal !== undefined && e.portal !== info.portal)) fail('registry.schema_invalid');
        }
        await putJson(key, doc);
        o.onEvent?.('index_published');
        return json(200, { monotonic: doc.monotonic });
      });
    },
    { maxBodyBytes: 512 * 1024 },
  );

  r.add('PUT', '/admin/v1/policy', async (ctx) => {
    admin(ctx);
    return serial(async () => {
      const doc = ctx.body as SignedPolicy;
      const [revoked, stored] = [await revokedSet(), await readJson<SignedPolicy>('policy/current.json')];
      const v = checked((x) => verifyPolicy(doc, o.trust, revoked, stored, o.now(), x));
      // {ver}.json과 current.json은 같은 내용(ADR-023). 같은 버전 파일이 이미 있으면 내용이 같을 때만(신선도 재발행)
      const prev = await readJson<SignedPolicy>(`policy/${doc.version}.json`);
      if (prev && prev.monotonic !== doc.monotonic) fail('registry.version_rollback');
      await putJson(`policy/${doc.version}.json`, doc);
      await putJson('policy/current.json', doc);
      o.onEvent?.(v.emergency ? 'policy_emergency' : 'policy_published');
      return json(200, { monotonic: doc.monotonic, emergency: v.emergency });
    });
  });

  r.add('PUT', '/admin/v1/status', async (ctx) => {
    admin(ctx);
    return serial(async () => {
      const doc = ctx.body as RegistryStatus;
      const [revoked, stored] = [await revokedSet(), await readJson<RegistryStatus>('registry/status.json')];
      const v = checked((x) => verifyStatus(doc, o.trust, revoked, stored, o.now(), x));
      await putJson('registry/status.json', doc);
      o.onEvent?.(v.emergency ? 'status_emergency' : 'status_published');
      return json(200, { monotonic: doc.monotonic, emergency: v.emergency });
    });
  });

  r.add('PUT', '/admin/v1/revoked-keys', async (ctx) => {
    admin(ctx);
    return serial(async () => {
      const doc = ctx.body as RevokedKeys;
      const stored = await readJson<RevokedKeys>('registry/revoked_keys.json');
      checked((v) => verifyRevoked(doc, o.trust, stored, o.now(), v));
      await putJson('registry/revoked_keys.json', doc);
      o.onEvent?.('revoked_published');
      return json(200, { monotonic: doc.monotonic });
    });
  });

  r.add('PUT', '/admin/v1/releases/:channel', async (ctx) => {
    admin(ctx);
    return serial(async () => {
      const channel = channelOf(ctx.params.channel!);
      const doc = ctx.body as ReleaseManifest;
      const [revoked, stored] = [await revokedSet(), await readJson<ReleaseManifest>(`releases/${channel}/latest.json`)];
      checked((v) => verifyRelease(doc, channel, o.trust, revoked, stored, o.now(), v));
      // yml을 먼저 쓰고 json을 마지막에 쓴다: json이 "게시됨"의 기준이라, 중간에 실패하면 같은 버전으로 다시 올릴 수 있다
      await store.put(`releases/${channel}/latest.yml`, Buffer.from(renderLatestYml(doc)));
      await putJson(`releases/${channel}/latest.json`, doc);
      o.onEvent?.('release_published');
      return json(200, { version: doc.version });
    });
  });

  return r;
}
