// 레지스트리 HTTP. 공개 GET은 정적 파일(ETag 조건부), 게시 PUT은 운영자 토큰 + 서명 검증 관문(규칙 정본: design/schemas/SIGNING.md, 엔진 로더).
// 게시 토큰은 호스팅 쓰기 권한일 뿐 서명 권한이 아니다: 2-of-3 서명이 없는 산출물은 토큰이 있어도 올라가지 않는다(ADR-013, D09 §8.2 역할 분리).
import type { KeyObject } from 'node:crypto';
import { canonicalizable } from '@sax/engine/core';
import { Router, fail, fromB64, json, safeEqual, sha256hex, type Ctx, type Reply } from '@sax/svc-shared';
import type { LogKind, TransparencyLog } from './log.ts';
import { RESIGN_TTL, restamp } from './resign.ts';
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
  /** 게시 이벤트(카운트만) */
  onEvent?: (e: string) => void;
  /** 투명성 로그(D09 §8.3). 있으면 게시마다 공개 전에 항목을 먼저 쓰고 /registry/log/*를 연다. 운영 기동(main)은 반드시 둔다 */
  log?: TransparencyLog;
  /**
   * 첫 게시 도장(CEREMONY.md §5·§6 "타임스탬프는 서버가 붙인다"): 정책·status·폐기 목록·인덱스(ADR-043)를 `timestamp` 없이 올리면 이 타임스탬프 역할 키
   * (로그 헤드와 같은 온라인 키, logSigningKey가 핀과 대조한 것)로 issuedAt·expiresAt·timestamp를 붙인 뒤 같은 관문 검증을 한다.
   * 내용 서명(루트·정책·긴급 키)은 신선도 필드를 서명 바이트에서 빼므로 그대로다. 재서명 cron(resign.ts)과 같은 restamp·같은 유효 기간이다.
   */
  stamper?: { keyId: string; key: KeyObject };
}

/** 조회 주기 파일(ADR-023): 15분 폴링 + ETag, max-age=60 */
const POLL = 'public, max-age=60';
const IMMUTABLE = 'public, max-age=31536000, immutable';

/** {id}@{version}.sxp. id는 점 필수(핫픽스는 <appliesTo.id>.hotfix, 데이터 패키지는 `-` 허용). 종류별 id 규칙은 .sxp 안 스키마가 본다 */
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
  /** 공개: 투명성 로그 항목을 먼저 쓰고(실패하면 공개하지 않는다), 그다음 파일을 쓴다(D09 §8.3 "먼저 기록") */
  const publish = async (kind: LogKind, key: string, bytes: Buffer) => {
    if (o.log) await o.log.append({ kind, path: key, sha256: sha256hex(bytes) });
    await store.put(key, bytes);
  };
  const putJson = (kind: LogKind, key: string, v: unknown) => publish(kind, key, Buffer.from(JSON.stringify(v)));
  /** 검증을 돌리고, 통과하든 거부되든 그동안 생긴 이벤트(registry.key_revoked 등)를 남긴다 */
  const checked = <T>(fn: (v: Verdict) => T): T => {
    const v: Verdict = { events: [] };
    try {
      return fn(v);
    } finally {
      for (const e of v.events) o.onEvent?.(e);
    }
  };
  /** timestamp가 없는 문서는 서버가 도장을 찍는다(stamper가 있을 때만). 있으면 그대로 검증한다(손대지 않는다) */
  const stamped = <T extends { monotonic: number; issuedAt: string; expiresAt: string; timestamp: unknown }>(doc: T, ttl: number): T => {
    if (!doc || typeof doc !== 'object' || Array.isArray(doc)) fail('registry.schema_invalid');
    if (doc.timestamp !== undefined || !o.stamper) return doc;
    if (!Number.isSafeInteger(doc.monotonic) || !canonicalizable(doc)) fail('registry.schema_invalid');
    o.onEvent?.('registry.stamped_on_publish');
    return restamp(doc, ttl, o.now(), o.stamper);
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

  // ---------- 투명성 로그(RFC 9162, D09 §8.3) ----------
  // 쿼리는 경로마다 정해진 키만 정확히 한 번씩(클라이언트 egress 허용 목록과 같은 규칙)
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
        // 같은 바이트 재게시(멱등)는 로그에 다시 쓰지 않는다
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
        // 인덱스가 가리키는 패키지는 먼저 올라와 있어야 하고, 바이트가 sxpDigest·size와 같고, 안의 서명·종류·포털이 항목과 맞아야 한다
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
      // {ver}.json과 current.json은 같은 내용(ADR-023). 같은 버전 파일이 이미 있으면 monotonic·내용 다이제스트가 같을 때만(신선도 재발행).
      // current.json 쓰기가 실패해도 {ver}.json은 같은 내용으로만 다시 쓸 수 있으므로, 같은 문서로 재시도하면 끝난다.
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
      const doc = ctx.body as ReleaseManifest;
      const [revoked, stored] = [await revokedSet(), await readJson<ReleaseManifest>(`releases/${channel}/latest.json`)];
      checked((v) => verifyRelease(doc, channel, o.trust, revoked, stored, o.now(), v));
      // yml을 먼저 쓰고 json을 마지막에 쓴다: json이 "게시됨"의 기준이라, 중간에 실패하면 같은 버전으로 다시 올릴 수 있다
      await publish('release', `releases/${channel}/latest.yml`, Buffer.from(renderLatestYml(doc)));
      await putJson('release', `releases/${channel}/latest.json`, doc);
      o.onEvent?.('release_published');
      return json(200, { version: doc.version });
    });
  });

  return r;
}
