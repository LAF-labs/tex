// 게시 리허설(--dry-run)과 시험용 임시 서명. 운영 키는 여기 없다: 키는 실행마다 메모리에서 만들고 버린다(디스크·출력에 남지 않는다).
// dry-run은 두 가지를 한다(서명·게시 없음).
//   1. 실제 레지스트리를 읽기만 해서 prepare(실제 핀): 무엇을 올릴지, 실제 서명 때 화면에 나올 manifest 확인 코드, 엔진 로더 연습.
//   2. 같은 소스로 처음부터 끝까지: 임시 핀(실제 핀과 같은 keyId·keyEpoch)의 로컬 레지스트리(메모리, 실제 레지스트리의 지금 문서로 채움)에
//      prepare → 임시 키 서명 → assemble → 서명 → push(관문 PUT·되읽기·로그 증명). 운영 레지스트리에는 PUT을 보내지 않는다.
import { createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, sign as edSign, type KeyObject } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { canonicalWithout, type Manifest } from '@sax/engine/core';
import { Logger } from '@sax/svc-shared';
import { buildRegistryDeploy } from '../deploy.ts';
import { MemoryStore } from '../store.ts';
import type { RevokedKeys, Role, TrustRoot } from '../verify.ts';
import { signWithBackend } from '../ceremony/collect.ts';
import { CeremonyError, confirmCode, prepare as prepareDoc, type DocKind } from '../ceremony/content.ts';
import type { KeyStoreBackend } from '../ceremony/device.ts';
import { assemble, httpRegistry, prepare, push, W, type Plan, type PrepareOpts, type PublishFs, type PublishRecord, type RegistryClient, type Work } from './pipeline.ts';

const PKCS8_ED25519 = Buffer.from('302e020100300506032b657004220420', 'hex');
const raw32 = (k: KeyObject) => Buffer.from(k.export({ format: 'der', type: 'spki' }).subarray(12));

/**
 * 메모리 서명기(시험·리허설 전용). ceremony sign이 부르는 백엔드 모양이라 사용자 명령과 같은 경로로 서명한다.
 * 운영 서명은 macOS 키체인 도우미(MacKeychainBackend)만 한다.
 */
export class MemorySigner implements KeyStoreBackend {
  private readonly keys = new Map<string, KeyObject>();
  constructor(seeds: ReadonlyMap<string, Buffer> = new Map()) {
    for (const [id, s] of seeds) this.keys.set(id, createPrivateKey({ key: Buffer.concat([PKCS8_ED25519, s]), format: 'der', type: 'pkcs8' }));
  }
  /** 새 임시 키(시드는 밖으로 내보내지 않는다) */
  add(keyId: string): Buffer {
    const { privateKey } = generateKeyPairSync('ed25519');
    this.keys.set(keyId, privateKey);
    return raw32(createPublicKey(privateKey));
  }
  describe(): string {
    return '메모리 임시 키(리허설·시험)';
  }
  private key(keyId: string): KeyObject {
    return this.keys.get(keyId) ?? (() => { throw new CeremonyError('ceremony.key_missing', keyId); })();
  }
  publicKey(keyId: string): Promise<Buffer> {
    return Promise.resolve(raw32(createPublicKey(this.key(keyId))));
  }
  sign(keyId: string, message: Buffer): Promise<Buffer> {
    return Promise.resolve(edSign(null, message, this.key(keyId)));
  }
  signSync(keyId: string, message: Buffer): Buffer {
    return edSign(null, message, this.key(keyId));
  }
  generate(keyId: string): Promise<Buffer> {
    return Promise.resolve(this.add(keyId));
  }
  list(): Promise<string[]> {
    return Promise.resolve([...this.keys.keys()].sort());
  }
  exportSeeds(): Promise<never> {
    return Promise.reject(new CeremonyError('ceremony.usage', '메모리 서명기는 내보내지 않는다'));
  }
  importSeed(): Promise<never> {
    return Promise.reject(new CeremonyError('ceremony.usage', '메모리 서명기는 들여오지 않는다'));
  }
}

/** 실제 핀과 같은 keyEpoch·keyId의 임시 핀. 타임스탬프 키는 시드를 돌려준다(로컬 레지스트리 로그 키로 쓴다) */
export function ephemeralTrust(like: TrustRoot): { trust: TrustRoot; signer: MemorySigner; timestampSeedHex: string } {
  const signer = new MemorySigner();
  const keys = {} as TrustRoot['keys'];
  const tsSeed = randomBytes(32);
  for (const [role, ids] of Object.entries(like.keys) as Array<[Role, Record<string, string>]>) {
    keys[role] = {};
    for (const id of Object.keys(ids)) {
      // 타임스탬프 키는 로컬 레지스트리의 온라인 키(REGISTRY_LOG_SIGNING_KEY)로 넘긴다. 서명기에는 넣지 않는다
      if (role === 'timestamp') keys[role][id] = raw32(createPublicKey(createPrivateKey({ key: Buffer.concat([PKCS8_ED25519, tsSeed]), format: 'der', type: 'pkcs8' }))).toString('base64');
      else keys[role][id] = signer.add(id).toString('base64');
    }
  }
  const hex = tsSeed.toString('hex');
  tsSeed.fill(0);
  return { trust: { keyEpoch: like.keyEpoch, keys }, signer, timestampSeedHex: hex };
}

/** 엔진 로더 연습용: 임시 package 키 2개로 manifest에 서명한다(prepare가 실제 서명 전에 loadPackage를 돌리려고) */
export function rehearsalPackageSigner(like: TrustRoot): { sign: (m: Manifest) => Manifest; trust: TrustRoot } {
  const e = ephemeralTrust(like);
  const ids = Object.keys(e.trust.keys.package).sort().slice(0, 2);
  return {
    trust: e.trust,
    sign: (m) => {
      const out = structuredClone(m);
      const bytes = canonicalWithout(out, ['signatures']);
      out.signatures = ids.map((keyId) => ({ keyId, alg: 'ed25519' as const, sig: e.signer.signSync(keyId, bytes).toString('base64url') }));
      return out;
    },
  };
}

/** 계획 폴더의 서명 대상을 모두 서명기로 서명한다(사용자 ceremony sign과 같은 함수: 확인 코드 검사·공개키 대조·서명 재검증) */
export async function signPending(w: Work, signer: KeyStoreBackend, trust: TrustRoot, stage: 'prepare' | 'assemble'): Promise<number> {
  const plan = JSON.parse(w.fs.read(path.join(w.dir, W.plan)).toString('utf8')) as Plan;
  const jobs: Array<{ kind: DocKind; doc: string; name: string; keys: string[] }> = [];
  if (stage === 'prepare') {
    for (const p of plan.packages) if (!p.published) jobs.push({ kind: 'manifest', doc: W.manifest(p.name), name: p.name, keys: ['package-1', 'package-2'] });
    for (const d of plan.docs) if (!d.signed) jobs.push({ kind: d.kind, doc: d.file, name: d.kind, keys: d.kind === 'revoked_keys' ? ['root-1', 'root-2'] : ['policy-1', 'policy-2'] });
  } else if (plan.packages.length) jobs.push({ kind: 'index', doc: W.index, name: 'index', keys: ['package-1', 'package-2'] });
  let n = 0;
  for (const j of jobs) {
    const doc = JSON.parse(w.fs.read(path.join(w.dir, j.doc)).toString('utf8')) as unknown;
    const p = prepareDoc(j.kind, doc);
    for (const keyId of j.keys) {
      const role = keyId.split('-')[0] as Role;
      const rec = await signWithBackend(signer, { kind: j.kind, part: 'content', bytes: p.bytes, role, keyId, confirm: confirmCode(p.sha256), expectedPublicKey: trust.keys[role]?.[keyId] });
      const out = path.join(w.dir, W.sig(j.name, keyId));
      w.fs.mkdir(path.dirname(out));
      w.fs.write(out, `${JSON.stringify(rec, null, 2)}\n`);
      n++;
    }
  }
  return n;
}

/** 로컬 레지스트리(메모리 저장 + 메모리 SQLite 로그, 임시 핀). 실제 레지스트리의 지금 문서로 채울 수 있다 */
export async function localRegistry(trust: TrustRoot, timestampSeedHex: string, seed: ReadonlyMap<string, Buffer> = new Map()): Promise<{ origin: string; token: string; store: MemoryStore; close: () => Promise<void> }> {
  const store = new MemoryStore();
  for (const [k, b] of seed) await store.put(k, b);
  const token = randomBytes(24).toString('hex');
  const built = await buildRegistryDeploy(
    { TRUST_ROOT_JSON: JSON.stringify(trust), REGISTRY_LOG_SIGNING_KEY: timestampSeedHex, REGISTRY_ADMIN_TOKEN: token, REGISTRY_STORE: 'memory' },
    { store, logger: new Logger('registry-rehearsal', () => undefined) },
  );
  const server = http.createServer((req, res) => void built.listener(req, res));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const a = server.address() as AddressInfo;
  return {
    origin: `http://127.0.0.1:${a.port}`,
    token,
    store,
    close: async () => {
      await new Promise<void>((r) => server.close(() => r()));
      await built.close();
    },
  };
}

export interface DryRunOpts {
  work: Work;
  src: PublishFs;
  sources: string[];
  /** 실제 레지스트리(읽기만) */
  registry: RegistryClient;
  trust: TrustRoot;
  trustPath: string;
  trustBytes: Buffer;
  channel: PrepareOpts['channel'];
  rolloutPercent: number;
  status?: PrepareOpts['status'];
  revoked?: RevokedKeys;
  policy?: PrepareOpts['policy'];
  now: number;
  fetchFn?: typeof fetch;
  out: (line: string) => void;
}

export interface DryRunReport {
  plan: Plan;
  rehearsal: PublishRecord;
}

/** --dry-run: 실제 레지스트리는 GET만, 서명은 임시 키, 게시는 로컬 레지스트리에만 */
export async function dryRun(o: DryRunOpts): Promise<DryRunReport> {
  const fsys = o.work.fs;
  const real = rehearsalPackageSigner(o.trust);
  o.out(`dry-run 1/2: 실제 레지스트리 ${o.registry.origin}를 읽어 계획(서명·게시 없음)`);
  const plan = await prepare({ ...o, work: { dir: path.join(o.work.dir, 'plan'), fs: fsys }, rehearsalSign: real.sign, rehearsalTrust: real.trust });

  // 2. 로컬 레지스트리를 실제 레지스트리의 지금 문서로 채운다(같은 monotonic에서 시작). 실제 키로 서명된 기존 패키지는 임시 핀으로 검증할 수 없어 인덱스에 잇지 않는다.
  const seed = new Map<string, Buffer>();
  for (const k of ['registry/revoked_keys.json', 'registry/status.json', `registry/${o.channel}/index.json`, 'policy/current.json']) {
    const b = await o.registry.get(`/${k}`);
    if (b) seed.set(k, b);
  }
  // 정책 {ver}.json도 같이(관문은 같은 버전 파일이 있으면 같은 내용만 받는다)
  const cur = seed.get('policy/current.json');
  const ver = cur ? (JSON.parse(cur.toString('utf8')) as { version?: unknown }).version : undefined;
  if (typeof ver === 'string' && /^\d{4}\.\d{2}(\.\d+)?$/.test(ver)) {
    const b = await o.registry.get(`/policy/${ver}.json`);
    if (b) seed.set(`policy/${ver}.json`, b);
  }
  const eph = ephemeralTrust(o.trust);
  const local = await localRegistry(eph.trust, eph.timestampSeedHex, seed);
  try {
    o.out(`dry-run 2/2: 임시 핀의 로컬 레지스트리 ${local.origin}에 처음부터 끝까지(실제 레지스트리에는 PUT 0건)`);
    const client = httpRegistry(local.origin, o.fetchFn ?? fetch);
    const w: Work = { dir: path.join(o.work.dir, 'rehearsal'), fs: fsys };
    const trustBytes = Buffer.from(JSON.stringify(eph.trust));
    const trustPath = path.join(w.dir, 'trust.json');
    fsys.mkdir(w.dir);
    fsys.write(trustPath, trustBytes);
    // 폐기 목록은 실제 루트 서명을 지우고 임시 루트 키로 같은 내용에 다시 서명한다(모양·규칙만 본다)
    const revoked = o.revoked ? ({ ...structuredClone(o.revoked), signatures: [] } as RevokedKeys) : undefined;
    const quiet = () => undefined;
    const rs = rehearsalPackageSigner(eph.trust);
    await prepare({ ...o, work: w, registry: client, trust: eph.trust, trustPath, trustBytes, revoked, rehearsalSign: rs.sign, rehearsalTrust: rs.trust, out: quiet });
    const a = await signPending(w, eph.signer, eph.trust, 'prepare');
    await assemble({ work: w, registry: client, trust: eph.trust, trustPath, trustBytes, now: o.now, carry: false, out: quiet });
    const b = await signPending(w, eph.signer, eph.trust, 'assemble');
    const rehearsal = await push({ work: w, registry: client, trust: eph.trust, trustBytes, token: local.token, now: o.now, out: quiet });
    o.out(`리허설: 임시 키 서명 ${a + b}번, 게시 ${rehearsal.published.length}건(${rehearsal.published.map((p) => p.path).join(', ')}), 되읽기·로그 포함 증명 통과`);
    o.out('dry-run 끝: 실제 서명·게시는 PUBLISH-H01.md의 사용자 단계로 한다');
    return { plan, rehearsal };
  } finally {
    await local.close();
  }
}

