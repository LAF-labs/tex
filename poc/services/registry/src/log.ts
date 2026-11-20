import { createHash, sign as edSign, verify as edVerify, type KeyObject } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { ed25519Private, ed25519Public, ed25519RawPublic, fromB64, jcs, key32, migrate, type Sql } from '@sax/svc-shared';
import type { TrustRoot } from './verify.ts';

export const LOG_MIGRATIONS_DIR = fileURLToPath(new URL('../migrations/', import.meta.url));
export const TREE_HEAD_CONTEXT = 'SAX-tree-head-v1';

export type LogKind = 'package' | 'index' | 'policy' | 'status' | 'revoked_keys' | 'release';

export interface LogEntry {
  v: 1;
  kind: LogKind;
  path: string;
  sha256: string;
  loggedAt: number;
}

export interface TreeHead {
  treeSize: number;
  rootHash: string;
  timestamp: number;
}

export interface SignedTreeHead extends TreeHead {
  signature: { keyId: string; alg: 'ed25519'; sig: string };
}

const sha = (...parts: Uint8Array[]) => createHash('sha256').update(Buffer.concat(parts)).digest();
export const leafHashOf = (data: Uint8Array): Buffer => sha(Buffer.from([0]), data);
const node = (l: Uint8Array, r: Uint8Array): Buffer => sha(Buffer.from([1]), l, r);
const split = (n: number) => {
  let k = 1;
  while (k * 2 < n) k *= 2;
  return k;
};

/** RFC 9162 §2.1.1 MTH, 잎 해시 목록에서. */
export function rootOf(leaves: readonly Buffer[]): Buffer {
  if (leaves.length === 0) return sha();
  if (leaves.length === 1) return leaves[0]!;
  const k = split(leaves.length);
  return node(rootOf(leaves.slice(0, k)), rootOf(leaves.slice(k)));
}

/** RFC 9162 §2.1.3.1 PATH(m, D[n]) */
export function inclusionPath(m: number, leaves: readonly Buffer[]): Buffer[] {
  if (leaves.length <= 1) return [];
  const k = split(leaves.length);
  if (m < k) return [...inclusionPath(m, leaves.slice(0, k)), rootOf(leaves.slice(k))];
  return [...inclusionPath(m - k, leaves.slice(k)), rootOf(leaves.slice(0, k))];
}

/** RFC 9162 §2.1.4.1 PROOF(m, D[n]), 0 < m ≤ n */
export function consistencyPath(m: number, leaves: readonly Buffer[]): Buffer[] {
  const sub = (mm: number, ls: readonly Buffer[], b: boolean): Buffer[] => {
    if (mm === ls.length) return b ? [] : [rootOf(ls)];
    const k = split(ls.length);
    if (mm <= k) return [...sub(mm, ls.slice(0, k), b), rootOf(ls.slice(k))];
    return [...sub(mm - k, ls.slice(k), false), rootOf(ls.slice(0, k))];
  };
  return m === leaves.length ? [] : sub(m, leaves, true);
}

/** RFC 9162 §2.1.3.2 포함 증명 검증(클라이언트 규칙의 참조 구현). */
export function verifyInclusion(leafHash: Uint8Array, index: number, treeSize: number, path: readonly Uint8Array[], rootHash: Uint8Array): boolean {
  if (!Number.isSafeInteger(index) || !Number.isSafeInteger(treeSize) || index < 0 || index >= treeSize) return false;
  let fn = index;
  let sn = treeSize - 1;
  let r: Buffer = Buffer.from(leafHash);
  for (const p of path) {
    if (sn === 0) return false;
    if (fn % 2 === 1 || fn === sn) {
      r = node(p, r);
      if (fn % 2 === 0) {
        while (fn % 2 === 0 && fn !== 0) {
          fn >>= 1;
          sn >>= 1;
        }
      }
    } else {
      r = node(r, p);
    }
    fn >>= 1;
    sn >>= 1;
  }
  return sn === 0 && r.equals(Buffer.from(rootHash));
}

export const treeHeadInput = (h: TreeHead): Buffer => Buffer.from(TREE_HEAD_CONTEXT + jcs({ treeSize: h.treeSize, rootHash: h.rootHash, timestamp: h.timestamp }), 'utf8');

/** 헤드 서명 검증(핀 고정된 타임스탬프 공개키). 형식이 틀려도 예외 없이 false. */
export function verifyTreeHead(pubB64: string, h: unknown): h is SignedTreeHead {
  try {
    const x = h as SignedTreeHead;
    if (!x || !Number.isSafeInteger(x.treeSize) || x.treeSize < 0 || !Number.isSafeInteger(x.timestamp) || !/^[0-9a-f]{64}$/.test(x.rootHash)) return false;
    if (jcs(Object.keys(x).sort()) !== jcs(['rootHash', 'signature', 'timestamp', 'treeSize'])) return false;
    if (x.signature?.alg !== 'ed25519' || typeof x.signature.sig !== 'string') return false;
    const pub = fromB64(pubB64, 32);
    const sig = Buffer.from(x.signature.sig, 'base64url');
    if (!pub || sig.length !== 64) return false;
    return edVerify(null, treeHeadInput(x), ed25519Public(pub), sig);
  } catch {
    return false;
  }
}

/**
 * 헤드 서명 키 구성 확인: 시드(hex 64자)의 공개키가 핀 고정된 타임스탬프 역할 키와 같아야 하고(D09 §8.2),
 * 다른 역할(루트·패키지·정책·긴급·릴리스) 공개키와 같으면 안 된다. 맞으면 그 keyId와 개인 키를 돌려준다.
 */
export function logSigningKey(seedHex: string | undefined, trust: TrustRoot): { keyId: string; key: KeyObject } {
  const key = ed25519Private(key32(seedHex, 'REGISTRY_LOG_SIGNING_KEY'));
  const pub = ed25519RawPublic(key).toString('base64');
  for (const [role, ks] of Object.entries(trust.keys)) {
    if (role === 'timestamp') continue;
    if (Object.values(ks ?? {}).includes(pub)) throw new Error('config_REGISTRY_LOG_SIGNING_KEY');
  }
  const hit = Object.entries(trust.keys.timestamp ?? {}).find(([, v]) => v === pub);
  if (!hit) throw new Error('config_REGISTRY_LOG_SIGNING_KEY');
  return { keyId: hit[0], key };
}

export interface LogEntryRecord {
  index: number;
  entry: LogEntry;
  leafHash: string;
}

/** 투명성 로그(SQL 저장). 같은 DB를 여러 인스턴스가 써도 append는 메타 행 잠금으로 하나씩이다. */
export class TransparencyLog {
  private readonly db: Sql;
  private readonly signer: { keyId: string; key: KeyObject };
  private readonly now: () => number;
  constructor(o: { db: Sql; signer: { keyId: string; key: KeyObject }; now: () => number }) {
    this.db = o.db;
    this.signer = o.signer;
    this.now = o.now;
  }

  static async open(o: { db: Sql; signer: { keyId: string; key: KeyObject }; now: () => number; migrate?: boolean }): Promise<TransparencyLog> {
    if (o.migrate !== false) await migrate(o.db, 'registry', LOG_MIGRATIONS_DIR);
    return new TransparencyLog(o);
  }

  private signHead(treeSize: number, root: Buffer): SignedTreeHead {
    const h: TreeHead = { treeSize, rootHash: root.toString('hex'), timestamp: this.now() };
    return { ...h, signature: { keyId: this.signer.keyId, alg: 'ed25519', sig: edSign(null, treeHeadInput(h), this.signer.key).toString('base64url') } };
  }

  private async leavesIn(q: Sql, size: number): Promise<Buffer[]> {
    const rows = await q.all<{ leaf_hash: string }>('SELECT leaf_hash FROM log_entries WHERE idx < $1 ORDER BY idx', [size]);
    return rows.map((r) => Buffer.from(r.leaf_hash, 'hex'));
  }

  async append(e: Omit<LogEntry, 'v' | 'loggedAt'>): Promise<{ index: number; head: SignedTreeHead }> {
    return this.db.tx(async (q) => {
      const meta = await q.one<{ tree_size: number }>(`SELECT tree_size FROM log_meta WHERE id = 1${q.forUpdate}`);
      const index = Number(meta?.tree_size ?? 0);
      const entry: LogEntry = { v: 1, kind: e.kind, path: e.path, sha256: e.sha256, loggedAt: this.now() };
      const text = jcs(entry);
      const leaf = leafHashOf(Buffer.from(text, 'utf8'));
      await q.run('INSERT INTO log_entries (idx, entry, leaf_hash) VALUES ($1, $2, $3)', [index, text, leaf.toString('hex')]);
      const head = this.signHead(index + 1, rootOf(await this.leavesIn(q, index + 1)));
      await q.run('UPDATE log_meta SET tree_size = $1, head = $2 WHERE id = 1', [index + 1, jcs(head)]);
      return { index, head };
    });
  }

  async refreshHead(maxAgeMs: number): Promise<boolean> {
    return this.db.tx(async (q) => {
      const m = await q.one<{ tree_size: number; head: string | null }>(`SELECT tree_size, head FROM log_meta WHERE id = 1${q.forUpdate}`);
      const size = Number(m?.tree_size ?? 0);
      const cur = m?.head ? (JSON.parse(m.head) as SignedTreeHead) : null;
      if (cur && cur.treeSize === size && this.now() - cur.timestamp < maxAgeMs) return false;
      const head = this.signHead(size, rootOf(await this.leavesIn(q, size)));
      await q.run('UPDATE log_meta SET head = $1 WHERE id = 1 AND tree_size = $2', [jcs(head), size]);
      return true;
    });
  }

  async head(): Promise<SignedTreeHead> {
    const m = await this.db.one<{ tree_size: number; head: string | null }>('SELECT tree_size, head FROM log_meta WHERE id = 1');
    if (m?.head) return JSON.parse(m.head) as SignedTreeHead;
    return this.db.tx(async (q) => {
      const cur = await q.one<{ tree_size: number; head: string | null }>(`SELECT tree_size, head FROM log_meta WHERE id = 1${q.forUpdate}`);
      if (cur?.head) return JSON.parse(cur.head) as SignedTreeHead;
      const head = this.signHead(0, rootOf([]));
      await q.run('UPDATE log_meta SET head = $1 WHERE id = 1 AND tree_size = 0', [jcs(head)]);
      return head;
    });
  }

  async entry(index: number): Promise<LogEntryRecord | null> {
    const r = await this.db.one<{ idx: number; entry: string; leaf_hash: string }>('SELECT idx, entry, leaf_hash FROM log_entries WHERE idx = $1', [index]);
    return r ? { index: Number(r.idx), entry: JSON.parse(r.entry) as LogEntry, leafHash: r.leaf_hash } : null;
  }

  async inclusion(leafHex: string, size: number): Promise<{ leafIndex: number; treeSize: number; path: string[] } | null> {
    const cur = (await this.head()).treeSize;
    if (size < 1 || size > cur) return null;
    const hit = await this.db.one<{ idx: number }>('SELECT MIN(idx) AS idx FROM log_entries WHERE leaf_hash = $1 AND idx < $2', [leafHex, size]);
    if (hit?.idx === null || hit?.idx === undefined) return null;
    const leaves = await this.leavesIn(this.db, size);
    return { leafIndex: Number(hit.idx), treeSize: size, path: inclusionPath(Number(hit.idx), leaves).map((b) => b.toString('hex')) };
  }

  async consistency(from: number, to: number): Promise<{ from: number; to: number; proof: string[] } | null> {
    const cur = (await this.head()).treeSize;
    if (from < 1 || from > to || to > cur) return null;
    const leaves = await this.leavesIn(this.db, to);
    return { from, to, proof: consistencyPath(from, leaves).map((b) => b.toString('hex')) };
  }
}
