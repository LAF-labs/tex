import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { FileEventLog, prepareLayout } from '@sax/platform';
import { MemoryKeyStore, RELAY_DENIED_METHODS, RELAY_DOMAIN_METHOD_ALLOWLIST, Vault } from '@sax/vault';
import type { EnginePortal } from '@sax/engine/protocol';
import type { EngineHost, InlineVault } from './engine-host.ts';
import { startH01Fixture, type H01Fixture } from './h01-fixture.ts';

export const DEMO_PROFILE = { kind: 'business', displayName: '가나다컴퍼니', bizNo: '1234567891', repName: '김가나', email: 'office@ganada.example', signMethod: 'simple_auth' } as const;
export const DEMO_COUNTERPARTIES = [
  { bizNo: '2148651233', name: 'A상사', repName: '이에이', email: 'tax@asangsa.example', item: '경영 컨설팅' },
  { bizNo: '3051288767', name: 'B상사', repName: '박비', email: 'account@bsangsa.example', item: '시스템 유지보수' },
  { bizNo: '4182577343', name: 'C테크', repName: '최다라', email: 'billing@ctech.example', item: '교육 용역' },
] as const;

export interface FixtureMode {
  root: string;
  vault: InlineVault;
  portal: EnginePortal;
  fixture: H01Fixture;
  itemHints: Record<string, string>;
  seed(host: EngineHost): Promise<void>;
  close(): Promise<void>;
}

export async function startFixtureMode(opts: { headful?: boolean } = {}): Promise<FixtureMode> {
  const root = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'sax-shell-fixture-'));
  const { paths } = await prepareLayout(root);
  const vault = new Vault({
    paths,
    log: new FileEventLog(paths.logs, 'vault'),
    keyStore: new MemoryKeyStore(),
    policy: {
      allowedHosts: ['127.0.0.1'],
      secretHosts: { cert_password: ['127.0.0.1'], portal_password: ['127.0.0.1'] },
      domainMethods: RELAY_DOMAIN_METHOD_ALLOWLIST,
      deniedMethods: RELAY_DENIED_METHODS,
      keyDelayMs: 5,
      typistInput: 'insertText',
    },
    testChromeArgs: opts.headful ? ['--use-mock-keychain'] : ['--headless=new', '--use-mock-keychain'],
  });
  const fixture = await startH01Fixture({
    registry: Object.fromEntries(DEMO_COUNTERPARTIES.map((c) => [c.bizNo, c.name])),
    supplier: { bizNo: DEMO_PROFILE.bizNo, name: DEMO_PROFILE.displayName },
  });
  return {
    root,
    vault,
    portal: { kind: 'fixture', origin: fixture.origin },
    fixture,
    itemHints: Object.fromEntries(DEMO_COUNTERPARTIES.map((c) => [c.bizNo, c.item])),
    async seed(host) {
      if (!((await host.rpc('db.query.profiles.list')) as unknown[]).length) await host.rpc('profile.upsert', { ...DEMO_PROFILE });
      const have = new Set(((await host.rpc('db.query.counterparties.list')) as Array<{ bizNo: string }>).map((c) => c.bizNo));
      for (const c of DEMO_COUNTERPARTIES) if (!have.has(c.bizNo)) await host.rpc('counterparty.create', { bizNo: c.bizNo, name: c.name, repName: c.repName, email: c.email });
    },
    async close() {
      await vault.shutdown().catch(() => {});
      await fixture.close();
      await fs.rm(root, { recursive: true, force: true });
    },
  };
}
