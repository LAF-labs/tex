import fs from 'node:fs';
import path from 'node:path';
import { CERT_DOCS, captureList, certPackage, withH01Login } from './playbooks/hometax-certificate.ts';
import type { PackageFiles } from '@sax/engine/core';

const DIR = path.resolve(import.meta.dirname, '../packages/engine/playbooks');
export const jsonText = (o: unknown): string => JSON.stringify(o, null, 1);

export function certOutputs(): Map<string, string> {
  const out = new Map<string, string>();
  const put = (p: PackageFiles) => {
    const id = (p.manifest as { id: string }).id;
    out.set(`${id}/manifest.json`, jsonText(p.manifest));
    out.set(`${id}/playbook.json`, jsonText(p.playbook));
    out.set(`${id}/selectors.json`, jsonText(p.selectors));
    out.set(`${id}/strings.ko.json`, jsonText(p.strings));
  };
  for (const d of CERT_DOCS) put(certPackage(d));
  const read = (id: string, f: string) => JSON.parse(fs.readFileSync(path.join(DIR, id, f), 'utf8'));
  const h04 = 'hometax.cert.taxpayment';
  put(withH01Login({ manifest: read(h04, 'manifest.json'), playbook: read(h04, 'playbook.json'), selectors: read(h04, 'selectors.json'), strings: read(h04, 'strings.ko.json') } as PackageFiles));
  out.set('CAPTURE-hometax-cert.md', captureList());
  return out;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  for (const [rel, text] of certOutputs()) {
    const f = path.join(DIR, rel);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, text);
  }
  console.log(`written ${certOutputs().size} files under ${DIR}`);
}
