import { Egress } from '@sax/net';
import { egressRegistryFetch, HOMETAX_PORTAL, installedIrSource, memoryRegistryStore, PRODUCT_PACKAGE_IDS, PRODUCT_PACKAGES, REGISTRY_TRUST_PIN, RegistrySync } from '@sax/engine';
import { runPermit } from '@sax/engine/core';

if (!REGISTRY_TRUST_PIN) throw new Error('앱 핀(REGISTRY_TRUST_PIN)이 없다');
const sync = new RegistrySync({ trust: REGISTRY_TRUST_PIN, fetch: egressRegistryFetch(new Egress()), store: memoryRegistryStore(), packages: { ids: PRODUCT_PACKAGE_IDS } });
const report = await sync.sync();
const out = (k: string, v: unknown) => process.stdout.write(`${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}\n`);
out('sync', report);
out('revocation', sync.revocation());
out('status', sync.status());
const pol = sync.policy();
out('policy', { freshness: pol.freshness, monotonic: pol.monotonic, version: pol.policy?.version ?? null, hometax: pol.policy?.portalMode?.hometax ?? null, clamped: pol.clamped });
const inst = sync.loadInstalled(PRODUCT_PACKAGES.h01);
out('loadInstalled', inst.ok ? { ok: true, id: inst.pkg.files.manifest.id, version: inst.pkg.files.manifest.version, lookups: [...inst.lookups.values()].map((l) => `${l.files.manifest.id}@${l.files.manifest.version}`) } : inst);
const ir = installedIrSource(sync, { id: PRODUCT_PACKAGES.h01, portal: HOMETAX_PORTAL })();
out('irSource', ir.ok ? { ok: true, lookupPackages: [...(ir.ir.lookupPackages?.keys() ?? [])] } : ir);
out('permit', runPermit(sync.status(), 'hometax', PRODUCT_PACKAGES.h01));
