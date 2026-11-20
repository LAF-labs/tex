import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseTrustRoot } from '../main.ts';
import type { Channel, RevokedKeys, TrustRoot } from '../verify.ts';
import { CeremonyError } from '../ceremony/content.ts';
import { assemble, httpRegistry, prepare, push, verifyPublished, type PublishFs, type RegistryClient, type Work } from './pipeline.ts';
import { dryRun, rehearsalPackageSigner } from './rehearsal.ts';

export interface PublishCliDeps {
  fs: PublishFs;
  out(line: string): void;
  now(): number;
  registry(origin: string): RegistryClient;
  secret(prompt: string): Promise<string>;
  env: NodeJS.ProcessEnv;
  settle?: { sleep?: (ms: number) => Promise<void>; settleMs?: number };
}

export const nodeFs: PublishFs = {
  read: (p) => fs.readFileSync(p),
  exists: (p) => fs.existsSync(p),
  write: (p, d) => fs.writeFileSync(p, d, { flag: 'wx', mode: 0o644 }),
  mkdir: (p) => fs.mkdirSync(p, { recursive: true }),
  list: (d) => fs.readdirSync(d),
};

async function readHidden(prompt: string): Promise<string> {
  const stdin = process.stdin;
  if (!stdin.isTTY) throw new CeremonyError('ceremony.no_tty', '토큰은 터미널에서만 받는다');
  process.stderr.write(prompt);
  stdin.setRawMode(true);
  stdin.resume();
  let s = '';
  try {
    return await new Promise<string>((resolve, reject) => {
      const on = (b: Buffer) => {
        for (const ch of b.toString('utf8')) {
          if (ch === '\r' || ch === '\n') {
            stdin.off('data', on);
            process.stderr.write('\n');
            return resolve(s);
          }
          if (ch === '\u0003') {
            stdin.off('data', on);
            return reject(new CeremonyError('ceremony.cancelled'));
          }
          if (ch === '\u007f' || ch === '\b') s = [...s].slice(0, -1).join('');
          else s += ch;
        }
      };
      stdin.on('data', on);
    });
  } finally {
    stdin.setRawMode(false);
    stdin.pause();
  }
}

const defaultDeps: PublishCliDeps = {
  fs: nodeFs,
  out: (l) => process.stdout.write(`${l}\n`),
  now: () => Date.now(),
  registry: (o) => httpRegistry(o),
  secret: readHidden,
  env: process.env,
};

function parse(argv: readonly string[]): { flags: Map<string, string[]>; pos: string[] } {
  const flags = new Map<string, string[]>();
  const pos: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith('--')) {
      const k = a.slice(2);
      const v = argv[i + 1];
      if (v === undefined || v.startsWith('--')) throw new CeremonyError('ceremony.usage', `--${k} 값 없음`);
      flags.set(k, [...(flags.get(k) ?? []), v]);
      i++;
    } else pos.push(a);
  }
  return { flags, pos };
}

const CEILINGS = ['postprocess', 'assisted', 'auto'];

export async function main(argv: readonly string[], deps: PublishCliDeps = defaultDeps): Promise<number> {
  const [cmd, ...rest] = argv;
  const { flags, pos } = parse(rest);
  const one = (k: string, required = true): string => {
    const v = flags.get(k);
    if (!v?.length) {
      if (required) throw new CeremonyError('ceremony.usage', `--${k}`);
      return '';
    }
    if (v.length > 1) throw new CeremonyError('ceremony.usage', `--${k} 두 번`);
    return v[0]!;
  };
  const readJson = <T>(p: string): T => {
    try {
      return JSON.parse(deps.fs.read(p).toString('utf8')) as T;
    } catch {
      throw new CeremonyError('ceremony.file_invalid', p);
    }
  };
  const trustOf = (): { trust: TrustRoot; trustPath: string; trustBytes: Buffer } => {
    const trustPath = one('trust');
    const trustBytes = deps.fs.read(trustPath);
    let trust: TrustRoot;
    try {
      trust = parseTrustRoot(trustBytes.toString('utf8'));
    } catch {
      throw new CeremonyError('ceremony.file_invalid', `${trustPath}(TRUST_ROOT_JSON 모양)`);
    }
    return { trust, trustPath, trustBytes };
  };
  const work = (): Work => ({ dir: one('work'), fs: deps.fs });
  const planInputs = () => {
    const ceilings = flags.get('ceiling') ?? [];
    const kills = flags.get('kill') ?? [];
    const statusFile = one('status', false);
    let status: { portalModeCeiling: Record<string, string>; killPlaybooks: string[] } | undefined;
    if (statusFile) status = readJson(statusFile);
    if (ceilings.length || kills.length) {
      if (status) throw new CeremonyError('ceremony.usage', '--status와 --ceiling·--kill은 함께 쓰지 않는다');
      const portalModeCeiling: Record<string, string> = {};
      for (const c of ceilings) {
        const m = /^([a-z0-9_]+)=([a-z]+)$/.exec(c);
        if (!m || !CEILINGS.includes(m[2]!) || portalModeCeiling[m[1]!]) throw new CeremonyError('ceremony.usage', `--ceiling ${c}(포털=postprocess|assisted|auto)`);
        portalModeCeiling[m[1]!] = m[2]!;
      }
      status = { portalModeCeiling, killPlaybooks: [...new Set(kills)].sort() };
    }
    const revokedFile = one('revoked', false);
    const revoked = revokedFile ? readJson<RevokedKeys>(revokedFile) : undefined;
    const policyFile = one('policy', false);
    const policy = policyFile ? readJson<Record<string, unknown>>(policyFile) : undefined;
    if (policy !== undefined && (!policy || typeof policy !== 'object' || Array.isArray(policy))) throw new CeremonyError('ceremony.file_invalid', policyFile);
    const rollout = one('rollout', false);
    const minApp = one('min-app-version', false);
    return { status, revoked, policy, channel: (one('channel', false) || 'stable') as Channel, rolloutPercent: rollout ? Number(rollout) : 100, ...(minApp ? { minAppVersion: minApp } : {}) };
  };

  switch (cmd) {
    case 'dry-run': {
      const t = trustOf();
      await dryRun({ ...t, ...planInputs(), work: work(), src: deps.fs, sources: pos, registry: deps.registry(one('registry')), now: deps.now(), out: deps.out });
      return 0;
    }
    case 'prepare': {
      const t = trustOf();
      const r = rehearsalPackageSigner(t.trust);
      await prepare({ ...t, ...planInputs(), work: work(), src: deps.fs, sources: pos, registry: deps.registry(one('registry')), now: deps.now(), rehearsalSign: r.sign, rehearsalTrust: r.trust, out: deps.out });
      return 0;
    }
    case 'assemble':
    case 'verify':
    case 'push': {
      const t = trustOf();
      const w = work();
      const plan = readJson<{ registry?: string }>(path.join(w.dir, 'plan.json'));
      const registry = deps.registry(String(plan.registry ?? ''));
      if (cmd === 'assemble') {
        await assemble({ ...t, work: w, registry, now: deps.now(), out: deps.out });
        return 0;
      }
      if (cmd === 'verify') {
        await verifyPublished({ ...t, work: w, registry, now: deps.now(), out: deps.out, ...deps.settle });
        return 0;
      }
      const envName = one('token-env', false);
      const token = envName ? (deps.env[envName] ?? '') : await deps.secret(`운영자 토큰(${registry.origin}, 보이지 않음): `);
      await push({ ...t, work: w, registry, token, now: deps.now(), out: deps.out, ...deps.settle });
      return 0;
    }
  }
  deps.out('명령: dry-run | prepare | assemble | push | verify (PUBLISH-H01.md)');
  return 64;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (e: unknown) => {
      process.stderr.write(`${e instanceof CeremonyError ? e.message : `publish.failed ${(e as { code?: string })?.code ?? ''}`}\n`);
      process.exit(1);
    },
  );
}
