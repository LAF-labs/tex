import fs from 'node:fs';
import { BUNDLE_ALLOWLIST } from './allowlist.ts';
import { validateBundle, type BvViolation } from './validate.ts';
import { wireIdOf, type BundleDef, type LoadedBundle } from './types.ts';

const BUNDLES_DIR = new URL('../../bundles/', import.meta.url);
const PREFIX_DIR = new URL('prefixes/', BUNDLES_DIR);
const COMMON_PREFIX = '_common.ko.txt';

export class BundleCatalogError extends Error {
  readonly violations: Array<BvViolation & { bundle: string }>;
  constructor(violations: Array<BvViolation & { bundle: string }>) {
    super(`bundle validation failed: ${violations.map((v) => `${v.bundle} ${v.rule} ${v.message}`).join('; ')}`);
    this.violations = violations;
  }
}

/** 고정 접두 = 공통 머리말 + 번들별 라벨 정의. 사용자 정보는 넣지 않는다(전 사용자 공유, D04 §2.1). */
export function assemblePrefix(def: BundleDef, dir: URL = PREFIX_DIR): string {
  if (!def.prefix) return '';
  const common = fs.readFileSync(new URL(COMMON_PREFIX, dir), 'utf8').trim();
  const own = fs.readFileSync(new URL(`${def.prefix.stringsKey}.ko.txt`, dir), 'utf8').trim();
  return `${common}\n\n${own}`;
}

export function readBundleDefs(dir: URL = BUNDLES_DIR): BundleDef[] {
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => JSON.parse(fs.readFileSync(new URL(f, dir), 'utf8')) as BundleDef);
}

export class BundleCatalog {
  private readonly byWireId: Map<string, LoadedBundle>;

  private constructor(items: LoadedBundle[]) {
    this.byWireId = new Map(items.map((b) => [b.wireId, b]));
  }

  static load(opts: { dir?: URL; prefixDir?: URL; allow?: ReadonlyArray<{ id: string; digest: string }> } = {}): BundleCatalog {
    const allow = opts.allow ?? BUNDLE_ALLOWLIST;
    const items: LoadedBundle[] = [];
    const violations: Array<BvViolation & { bundle: string }> = [];
    for (const def of readBundleDefs(opts.dir)) {
      const prefixText = assemblePrefix(def, opts.prefixDir);
      for (const v of validateBundle(def, prefixText, allow)) violations.push({ ...v, bundle: wireIdOf(def) });
      items.push({ def, wireId: wireIdOf(def), digest: def.digest, prefixText });
    }
    if (violations.length) throw new BundleCatalogError(violations);
    return new BundleCatalog(items);
  }

  get(wireId: string): LoadedBundle | undefined {
    return this.byWireId.get(wireId);
  }

  list(): LoadedBundle[] {
    return [...this.byWireId.values()];
  }

  allowEntries(): Array<{ id: string; digest: string; maxInputBytes: number }> {
    return this.list().map((b) => ({ id: b.wireId, digest: b.digest, maxInputBytes: b.def.maxInputBytes }));
  }
}
