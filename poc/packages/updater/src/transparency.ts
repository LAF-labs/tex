// 투명성 로그 확인(ADR-028 결정 2, D09 §8.3, RFC 9162): latest.json 바이트가 서명 헤드 아래 로그에 실린 최신 릴리스 항목인가.
// 규칙 정본은 services/registry API.md "투명성 로그"와 src/log.ts 참조 검증기다(여기는 서비스에 기대지 않게 따로 둔다).
// 미러 헤드 교차 확인은 아직 서버에 없다(API.md 범위 밖). 그래서 verified = 핀 키 헤드 서명 + 항목 + 포함 증명이다.
import { createHash, createPublicKey, verify as edVerify } from 'node:crypto';
import { jcs } from './jcs.ts';
import type { Transparency } from './decide.ts';
import type { Channel } from './manifest.ts';
import type { TrustRoot } from './verify.ts';

/** 레지스트리 GET(대상 = 경로 + 쿼리). 200이면 JSON.parse한 값, 그 밖은 null. */
export interface LogReader {
  get(target: string): Promise<unknown | null>;
}

/** 확인을 마친 릴리스 항목. 캐시 키는 latest.json 바이트의 sha256 hex다. */
export interface LoggedRelease {
  leafIndex: number;
  leafHash: string;
}

const TREE_HEAD_CONTEXT = 'SAX-tree-head-v1';
const DEFAULT_MAX_SCAN = 256;
/** 2^53 트리의 포함 경로도 53개를 넘지 않는다 */
const MAX_PATH = 64;

interface Head {
  treeSize: number;
  rootHash: string;
  timestamp: number;
}
interface Entry {
  path: string;
  sha256: string;
}

const HEX64 = /^[0-9a-f]{64}$/;
const SPKI_ED25519 = Buffer.from('302a300506032b6570032100', 'hex');
const sha = (...parts: Uint8Array[]): Buffer => createHash('sha256').update(Buffer.concat(parts)).digest();
const node = (l: Uint8Array, r: Uint8Array): Buffer => sha(Buffer.from([1]), l, r);
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const exactKeys = (o: Record<string, unknown>, keys: readonly string[]) => jcs(Object.keys(o).sort()) === jcs([...keys].sort());
const safeInt = (v: unknown, min: number): v is number => Number.isSafeInteger(v) && (v as number) >= min;

function edOk(pubB64: string, msg: Buffer, sigB64u: string): boolean {
  const raw = Buffer.from(pubB64, 'base64');
  if (raw.length !== 32 || raw.toString('base64') !== pubB64) return false;
  const sig = Buffer.from(sigB64u, 'base64url');
  if (sig.length !== 64 || sig.toString('base64url') !== sigB64u) return false;
  try {
    return edVerify(null, msg, createPublicKey({ key: Buffer.concat([SPKI_ED25519, raw]), format: 'der', type: 'spki' }), sig);
  } catch {
    return false;
  }
}

function parseHead(v: unknown, trust: TrustRoot): Head | null {
  if (!isObj(v) || !exactKeys(v, ['rootHash', 'signature', 'timestamp', 'treeSize'])) return null;
  const { treeSize, rootHash, timestamp, signature: s } = v;
  if (!safeInt(treeSize, 1) || !safeInt(timestamp, 0) || typeof rootHash !== 'string' || !HEX64.test(rootHash)) return null;
  if (!isObj(s) || !exactKeys(s, ['alg', 'keyId', 'sig']) || s.alg !== 'ed25519' || typeof s.keyId !== 'string' || typeof s.sig !== 'string') return null;
  const pinned = trust.keys.timestamp ?? {};
  if (!Object.hasOwn(pinned, s.keyId)) return null;
  const msg = Buffer.from(TREE_HEAD_CONTEXT + jcs({ treeSize, rootHash, timestamp }), 'utf8');
  return edOk(pinned[s.keyId]!, msg, s.sig) ? { treeSize, rootHash, timestamp } : null;
}

/** entries/{n}.json. 잎 해시는 서버 값을 믿지 않고 항목에서 다시 계산해 맞춘다. */
function parseRecord(v: unknown, n: number): { entry: Entry; leafHash: string } | null {
  if (!isObj(v) || !exactKeys(v, ['entry', 'index', 'leafHash']) || v.index !== n || typeof v.leafHash !== 'string') return null;
  const e = v.entry;
  if (!isObj(e) || !exactKeys(e, ['kind', 'loggedAt', 'path', 'sha256', 'v']) || e.v !== 1) return null;
  if (typeof e.kind !== 'string' || typeof e.path !== 'string' || typeof e.sha256 !== 'string' || !HEX64.test(e.sha256) || !safeInt(e.loggedAt, 0)) return null;
  const leafHash = sha(Buffer.from([0]), Buffer.from(jcs(e), 'utf8')).toString('hex');
  return leafHash === v.leafHash ? { entry: { path: e.path, sha256: e.sha256 }, leafHash } : null;
}

/** RFC 9162 §2.1.3.2. 경로가 모자라거나 남으면 null(형식 오류), 다 쓰면 계산한 루트. */
function inclusionRoot(leafHash: Buffer, index: number, treeSize: number, path: readonly Buffer[]): Buffer | null {
  if (index < 0 || index >= treeSize) return null;
  let fn = index;
  let sn = treeSize - 1;
  let r = leafHash;
  for (const p of path) {
    if (sn === 0) return null;
    if (fn % 2 === 1 || fn === sn) {
      r = node(p, r);
      if (fn % 2 === 0) {
        while (fn % 2 === 0 && fn !== 0) {
          fn = Math.floor(fn / 2);
          sn = Math.floor(sn / 2);
        }
      }
    } else {
      r = node(r, p);
    }
    fn = Math.floor(fn / 2);
    sn = Math.floor(sn / 2);
  }
  return sn === 0 ? r : null;
}

function parseProof(v: unknown, leafIndex: number, treeSize: number): Buffer[] | null {
  if (!isObj(v) || !exactKeys(v, ['leafIndex', 'path', 'treeSize']) || v.leafIndex !== leafIndex || v.treeSize !== treeSize) return null;
  if (!Array.isArray(v.path) || v.path.length > MAX_PATH || !v.path.every((h) => typeof h === 'string' && HEX64.test(h))) return null;
  return v.path.map((h: string) => Buffer.from(h, 'hex'));
}

/**
 * latest.json 바이트가 로그에 실린 그 채널의 최신 릴리스 항목이고, 포함 증명이 핀 키로 서명된 헤드 루트에 닿는가. 던지지 않는다.
 * 같은 경로의 가장 새 항목이 다른 바이트면 unverified다(CDN 지연이나 옛 매니페스트 재생). 캐시가 있어도 그 뒤 항목은 다시 읽어 이 규칙을 지킨다.
 */
export async function checkReleaseLogged(o: {
  reader: LogReader;
  trust: TrustRoot;
  channel: Channel;
  bytes: Uint8Array;
  maxScan?: number;
  cache?: Map<string, LoggedRelease>;
}): Promise<Transparency> {
  try {
    const head = parseHead(await o.reader.get('/registry/log/head.json'), o.trust);
    if (!head) return 'unverified';
    const digest = sha(o.bytes).toString('hex');
    const path = `releases/${o.channel}/latest.json`;
    const hit = o.cache?.get(digest);
    const known = hit && hit.leafIndex < head.treeSize ? hit : undefined;
    const floor = Math.max(0, head.treeSize - (o.maxScan ?? DEFAULT_MAX_SCAN));
    let found: LoggedRelease | undefined;
    for (let n = head.treeSize - 1; n >= floor; n--) {
      if (known && n === known.leafIndex) {
        found = known;
        break;
      }
      const rec = parseRecord(await o.reader.get(`/registry/log/entries/${n}.json`), n);
      if (!rec) return 'unverified';
      if (rec.entry.path !== path) continue;
      if (rec.entry.sha256 !== digest) return 'unverified';
      found = { leafIndex: n, leafHash: rec.leafHash };
      break;
    }
    if (!found) return 'unverified';
    const proof = parseProof(await o.reader.get(`/registry/log/proof/inclusion?leaf=${found.leafHash}&size=${head.treeSize}`), found.leafIndex, head.treeSize);
    if (!proof) return 'unverified';
    const root = inclusionRoot(Buffer.from(found.leafHash, 'hex'), found.leafIndex, head.treeSize, proof);
    if (!root) return 'unverified';
    // 형식이 맞는 증명이 서명 헤드와 다른 루트를 낸다: 서버가 자기 헤드와 어긋난 트리를 보인다(보안 이벤트)
    if (root.toString('hex') !== head.rootHash) return 'head_mismatch';
    o.cache?.set(digest, found);
    return 'verified';
  } catch {
    return 'unverified';
  }
}
