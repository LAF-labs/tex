// S3 호환 정적 저장소(운영: Supabase Storage의 S3 엔드포인트, 팀장 결정 2026-11-06). 공급사 종속은 이 어댑터 하나다(ADR-015):
// 표준 S3 API(SigV4)만 쓰므로 다른 S3 호환 저장소로 바꿔도 env만 바뀐다. 키는 Storage 전용 S3 접근 키이고 DB 권한이 없다
// (Supabase 서비스 역할 키를 쓰지 않는다). 공개 읽기는 이 서버를 거치지 않고 Vercel 외부 재작성이 공개 버킷 URL로 보낸다.
// 값은 공개 산출물뿐이다(서명된 파일 그대로). 키(경로)는 store.ts의 고정 형식만 받는다.
import { createHash, createHmac } from 'node:crypto';
import { checkKey, type Store } from './store.ts';

export interface S3StoreOpts {
  /** 예 `https://<ref>.supabase.co/storage/v1/s3`(경로 방식). 시험만 http://localhost·127.0.0.1 */
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  fetchFn?: typeof fetch;
  now?: () => number;
  timeoutMs?: number;
}

/** 저장 객체 하나의 상한(인덱스 512KB, 패키지 16MB) */
const MAX_OBJECT = 24 * 1024 * 1024;
const EMPTY_SHA = createHash('sha256').digest('hex');

const sha256hex = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');
const hmac = (k: Buffer | string, s: string) => createHmac('sha256', k).update(s, 'utf8').digest();
/** RFC 3986 엄격 인코딩(SigV4 정규 URI: 비예약 문자 A-Z a-z 0-9 - . _ ~ 만 그대로) */
const enc = (s: string) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

/** 공개 파일의 Content-Type·Cache-Control(API.md 공개 GET 표). 공개 버킷이 이 메타데이터로 응답한다 */
export function objectMeta(key: string): { contentType: string; cacheControl: string } {
  if (key.startsWith('packages/')) return { contentType: 'application/octet-stream', cacheControl: 'public, max-age=31536000, immutable' };
  if (key.endsWith('.yml')) return { contentType: 'text/yaml; charset=utf-8', cacheControl: 'public, max-age=60' };
  return { contentType: 'application/json', cacheControl: 'public, max-age=60' };
}

/**
 * AWS Signature Version 4 Authorization 헤더(서비스 s3, 쿼리 없음). headers는 서명할 헤더 전부(host 포함, 이름 소문자).
 * 공개 시험 벡터(AWS 문서 GET Object 예)로 확인한다.
 */
export function sigV4Authorization(o: {
  method: string;
  /** 인코딩된 정규 경로(예 `/bucket/a%40b.json`) */
  path: string;
  headers: Record<string, string>;
  payloadHash: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  amzDate: string;
}): string {
  const names = Object.keys(o.headers).map((k) => k.toLowerCase()).sort();
  const lower = Object.fromEntries(Object.entries(o.headers).map(([k, v]) => [k.toLowerCase(), v]));
  const canonicalHeaders = names.map((n) => `${n}:${String(lower[n]).trim().replace(/\s+/g, ' ')}\n`).join('');
  const signedHeaders = names.join(';');
  const canonical = [o.method, o.path, '', canonicalHeaders, signedHeaders, o.payloadHash].join('\n');
  const date = o.amzDate.slice(0, 8);
  const scope = `${date}/${o.region}/s3/aws4_request`;
  const toSign = ['AWS4-HMAC-SHA256', o.amzDate, scope, sha256hex(canonical)].join('\n');
  const key = hmac(hmac(hmac(hmac(`AWS4${o.secretAccessKey}`, date), o.region), 's3'), 'aws4_request');
  return `AWS4-HMAC-SHA256 Credential=${o.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${createHmac('sha256', key).update(toSign, 'utf8').digest('hex')}`;
}

const amzDateOf = (ms: number) => new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');

export class S3Store implements Store {
  private readonly base: URL;
  private readonly o: S3StoreOpts;
  constructor(o: S3StoreOpts) {
    let u: URL;
    try {
      u = new URL(o.endpoint);
    } catch {
      throw new Error('config_S3_ENDPOINT');
    }
    const local = u.protocol === 'http:' && (u.hostname === 'localhost' || u.hostname === '127.0.0.1');
    if ((u.protocol !== 'https:' && !local) || u.search || u.hash || u.username || u.password) throw new Error('config_S3_ENDPOINT');
    if (!/^[a-z0-9-]{2,32}$/.test(o.region)) throw new Error('config_S3_REGION');
    if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(o.bucket)) throw new Error('config_S3_BUCKET');
    if (!o.accessKeyId || !o.secretAccessKey) throw new Error('config_S3_ACCESS_KEY');
    this.base = u;
    this.o = o;
  }

  private async send(method: 'GET' | 'PUT', key: string, body?: Buffer, extra: Record<string, string> = {}): Promise<Response> {
    const prefix = this.base.pathname.replace(/\/+$/, '');
    const path = `${prefix}/${enc(this.o.bucket)}/${checkKey(key).split('/').map(enc).join('/')}`;
    const payloadHash = body ? sha256hex(body) : EMPTY_SHA;
    const amzDate = amzDateOf((this.o.now ?? Date.now)());
    const headers: Record<string, string> = { host: this.base.host, 'x-amz-content-sha256': payloadHash, 'x-amz-date': amzDate, ...extra };
    const authorization = sigV4Authorization({ method, path, headers, payloadHash, region: this.o.region, accessKeyId: this.o.accessKeyId, secretAccessKey: this.o.secretAccessKey, amzDate });
    // host는 fetch가 URL에서 붙인다(같은 값을 서명했다)
    const send = Object.fromEntries(Object.entries(headers).filter(([k]) => k !== 'host'));
    return (this.o.fetchFn ?? fetch)(`${this.base.origin}${path}`, {
      method,
      headers: { ...send, authorization },
      body: body ? new Uint8Array(body) : undefined,
      redirect: 'error',
      signal: AbortSignal.timeout(this.o.timeoutMs ?? 15_000),
    });
  }

  async get(key: string): Promise<Buffer | null> {
    const r = await this.send('GET', key);
    if (r.status === 404) {
      await r.body?.cancel();
      return null;
    }
    if (r.status !== 200) {
      await r.body?.cancel();
      throw new Error(`store_s3_get_${r.status}`);
    }
    const len = Number(r.headers.get('content-length') ?? '0');
    if (len > MAX_OBJECT) {
      await r.body?.cancel();
      throw new Error('store_s3_too_large');
    }
    const b = Buffer.from(await r.arrayBuffer());
    if (b.length > MAX_OBJECT) throw new Error('store_s3_too_large');
    return b;
  }

  async put(key: string, bytes: Buffer): Promise<void> {
    if (bytes.length > MAX_OBJECT) throw new Error('store_s3_too_large');
    const m = objectMeta(key);
    const r = await this.send('PUT', key, bytes, { 'content-type': m.contentType, 'cache-control': m.cacheControl });
    await r.body?.cancel();
    if (r.status !== 200) throw new Error(`store_s3_put_${r.status}`);
  }
}

/** env(서비스 접두를 뗀 값) → S3 저장소. S3_ENDPOINT가 없으면 null */
export function s3StoreFromEnv(env: NodeJS.ProcessEnv): S3Store | null {
  if (!env.S3_ENDPOINT) return null;
  return new S3Store({ endpoint: env.S3_ENDPOINT, region: env.S3_REGION ?? '', bucket: env.S3_BUCKET ?? '', accessKeyId: env.S3_ACCESS_KEY_ID ?? '', secretAccessKey: env.S3_SECRET_ACCESS_KEY ?? '' });
}
